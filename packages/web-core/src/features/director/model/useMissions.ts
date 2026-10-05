import { useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BaseCodingAgent,
  type MissionDetail,
  type MissionSummary,
  type UpdateMissionRequest,
} from 'shared/types';
import { missionsApi, repoApi, sessionsApi } from '@/shared/lib/api';
import { useRepos } from '@/shared/hooks/useRepos';
import { useCurrentAppDestination } from '@/shared/hooks/useCurrentAppDestination';
import { useSelectedRepoStore } from '@/shared/stores/useSelectedRepoStore';
import { useDirectorStore } from './useDirectorStore';

export const missionKeys = {
  all: ['missions'] as const,
  list: () => ['missions', 'list'] as const,
  detail: (id: string) => ['missions', 'detail', id] as const,
  workspace: (id: string) => ['missions', 'workspace', id] as const,
};

// No polling (J6.1): useFlukeEventsLive refreshes these when something
// happens in the app.
export function useMissionList() {
  return useQuery({
    queryKey: missionKeys.list(),
    queryFn: () => missionsApi.list(),
  });
}

export function useMission(id: string | null) {
  return useQuery({
    queryKey: missionKeys.detail(id ?? ''),
    queryFn: () => missionsApi.get(id!),
    enabled: !!id,
  });
}

export function useMissionWorkspace(id: string | null) {
  return useQuery({
    queryKey: missionKeys.workspace(id ?? ''),
    queryFn: () => missionsApi.getWorkspace(id!),
    enabled: !!id,
    staleTime: 60_000,
  });
}

function useStoreDetail() {
  const queryClient = useQueryClient();
  return (detail: MissionDetail) => {
    queryClient.setQueryData(missionKeys.detail(detail.mission.id), detail);
    void queryClient.invalidateQueries({ queryKey: missionKeys.list() });
  };
}

export function useCreateMission() {
  const store = useStoreDetail();
  const openMission = useDirectorStore((s) => s.openMission);
  return useMutation({
    mutationFn: (repoId: string) => missionsApi.create(repoId),
    onSuccess: (detail) => {
      store(detail);
      openMission(detail.mission.id);
    },
  });
}

/**
 * Archive (close) or restore a mission. Nothing is deleted: an archived
 * mission keeps its brief, issues and conversation.
 */
export function useArchiveMission() {
  const store = useStoreDetail();
  const unfocus = useDirectorStore((s) => s.unfocus);
  return useMutation({
    mutationFn: ({ id, archived }: { id: string; archived: boolean }) =>
      missionsApi.update(id, { close: archived }),
    onSuccess: (detail, { archived }) => {
      store(detail);
      if (archived) unfocus(detail.mission.id);
    },
  });
}

/**
 * Delete a mission for good. The focus drops and the mission leaves the list
 * only once the server confirms; on error both stay as they were.
 */
export function useDeleteMission() {
  const queryClient = useQueryClient();
  const unfocus = useDirectorStore((s) => s.unfocus);
  return useMutation({
    mutationFn: (id: string) => missionsApi.delete(id),
    onSuccess: (_, id) => {
      unfocus(id);
      queryClient.setQueryData<MissionSummary[]>(missionKeys.list(), (list) =>
        list?.filter((m) => m.mission.id !== id)
      );
      queryClient.removeQueries({ queryKey: missionKeys.detail(id) });
      void queryClient.invalidateQueries({ queryKey: missionKeys.list() });
    },
  });
}

export function useUpdateMission(id: string) {
  const store = useStoreDetail();
  return useMutation({
    mutationFn: (data: Partial<UpdateMissionRequest>) =>
      missionsApi.update(id, data),
    onSuccess: store,
  });
}

export function useApproveBrief(id: string) {
  const store = useStoreDetail();
  return useMutation({
    mutationFn: (analystWorkerId?: string) =>
      missionsApi.approve(id, analystWorkerId),
    onSuccess: store,
  });
}

/**
 * Whether the mission's repo has a GitHub remote. The Analyst opens issues
 * and PRs with `gh`, so any other provider counts as `missing`. The query key
 * is shared with the other remote views, so invalidating
 * `['repo-remotes', repoId]` (e.g. after connecting a remote) re-evaluates
 * this without a reload; a different `repoId` is simply a different query.
 */
export type GithubRemoteState =
  | 'no_repo'
  | 'loading'
  | 'github'
  | 'missing'
  | 'error';

export function useRepoGithubRemote(
  repoId: string | null | undefined
): GithubRemoteState {
  const { data, isPending, isError } = useQuery({
    queryKey: ['repo-remotes', repoId ?? ''],
    queryFn: () => repoApi.listRemotes(repoId!),
    enabled: !!repoId,
    staleTime: 30_000,
  });
  if (!repoId) return 'no_repo';
  if (isError) return 'error';
  if (isPending || !data) return 'loading';
  return data.some((r) => isGithubUrl(r.url)) ? 'github' : 'missing';
}

/** Same rules as `detect_provider_from_url` in `crates/git-host`. */
function isGithubUrl(url: string): boolean {
  const u = url.toLowerCase();
  if (u.includes('github.com')) return true;
  if (
    u.includes('dev.azure.com') ||
    u.includes('.visualstudio.com') ||
    u.includes('/_git/')
  ) {
    return false;
  }
  return u.includes('github.');
}

/** Sends a user message to the mission's Director session. */
export function useSendToDirector(mission: MissionDetail['mission'] | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (prompt: string) =>
      sessionsApi.followUp(mission!.session_id, {
        prompt,
        // The server fixes the Director's executor and model.
        executor_config: { executor: BaseCodingAgent.CLAUDE_CODE },
        retry_process_id: null,
        force_when_dirty: null,
        perform_git_reset: null,
      }),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: missionKeys.all }),
  });
}

/**
 * Talks to Fluke about some issues from outside its panel: reuses the open
 * mission those issues came from (#702), otherwise starts a new one, opens
 * its tab and sends the prompt.
 */
export function useTalkToFluke() {
  const createMission = useCreateMission();
  const openMission = useDirectorStore((s) => s.openMission);
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      repoId,
      issueNumbers,
      prompt,
    }: {
      repoId: string;
      issueNumbers: number[];
      prompt: string;
    }) => {
      const own = (await missionsApi.list()).find(
        (m) =>
          m.mission.status !== 'closed' &&
          m.mission.repo_id === repoId &&
          m.issue_numbers.some((n) => issueNumbers.includes(n))
      )?.mission;
      if (own) openMission(own.id);
      const sessionId =
        own?.session_id ??
        (await createMission.mutateAsync(repoId)).mission.session_id;
      await sessionsApi.followUp(sessionId, {
        prompt,
        executor_config: { executor: BaseCodingAgent.CLAUDE_CODE },
        retry_process_id: null,
        force_when_dirty: null,
        perform_git_reset: null,
      });
    },
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: missionKeys.all }),
  });
}

/** The mission needs the user: the brief is ready (G1) or questions wait. */
export function isWaitingForUser(m: MissionSummary): boolean {
  if (m.agent_running) return false;
  return (
    m.mission.status === 'brief_ready' ||
    (m.mission.status !== 'closed' && m.mission.pending_questions.length > 0)
  );
}

export const isArchived = (m: MissionSummary) => m.mission.status === 'closed';

export function missionLabel(m: MissionSummary, fallback: string): string {
  return m.mission.title || m.repo_name || fallback;
}

/** Repo a new mission starts in: the selected one, else the first. */
export function useNewMission() {
  const { repos } = useRepos();
  const selectedRepoId = useSelectedRepoStore((s) => s.selectedRepoId);
  const repoId = repos.find((r) => r.id === selectedRepoId)?.id ?? repos[0]?.id;
  return { repoId, create: useCreateMission() };
}

/**
 * The mission Fluke's views show: the focused one, else Fluke's general
 * conversation (the guard), else the first mission still open.
 */
export function useFocusedMission() {
  const focusId = useDirectorStore((s) => s.focusId);
  const { data: missions = [], isLoading } = useMissionList();
  const summary =
    missions.find((m) => m.mission.id === focusId) ??
    missions.find((m) => m.is_guard) ??
    missions.find((m) => !isArchived(m));
  return { summary, missions, isLoading };
}

const SECTION_KEYS: Record<string, string> = {
  dashboard: 'appBar.dashboard',
  workspaces: 'appBar.workspaces',
  workspace: 'appBar.workspaces',
  'workspace-vscode': 'appBar.workspaces',
  sprint: 'appBar.sprint',
  issues: 'appBar.issues',
  workers: 'appBar.workers',
  'ci-pipelines': 'appBar.ciPipelines',
  'source-control': 'appBar.sourceControl',
};

/** "TallerMecanico › Kanban": where the user is in the app. */
export function useDirectorUiContext(): string {
  const { t } = useTranslation('common');
  const destination = useCurrentAppDestination();
  const { repos } = useRepos();
  const selectedRepoId = useSelectedRepoStore((s) => s.selectedRepoId);
  const repo = repos.find((r) => r.id === selectedRepoId) ?? repos[0];
  return useMemo(() => {
    const kind = destination?.kind ?? '';
    const section = SECTION_KEYS[kind]
      ? t(SECTION_KEYS[kind], { defaultValue: kind })
      : kind;
    const parts = [repo?.display_name || repo?.name, section].filter(Boolean);
    if (destination && 'workspaceId' in destination) {
      parts.push(`workspace ${destination.workspaceId}`);
    }
    return parts.join(' › ');
  }, [t, destination, repo]);
}

/** Keeps the active mission's `ui_context` in sync with where the user is. */
export function useSyncUiContext(missionId: string | null, context: string) {
  const update = useUpdateMission(missionId ?? '');
  const { mutate } = update;
  useEffect(() => {
    if (!missionId || !context) return;
    const timer = setTimeout(() => mutate({ ui_context: context }), 500);
    return () => clearTimeout(timer);
  }, [missionId, context, mutate]);
}
