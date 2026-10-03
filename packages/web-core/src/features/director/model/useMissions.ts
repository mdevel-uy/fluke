import { useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BaseCodingAgent,
  type MissionDetail,
  type MissionSummary,
  type UpdateMissionRequest,
} from 'shared/types';
import { missionsApi, sessionsApi } from '@/shared/lib/api';
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

// ponytail: polling; switch to a msg_store stream if the latency shows.
export function useMissionList() {
  return useQuery({
    queryKey: missionKeys.list(),
    queryFn: () => missionsApi.list(),
    refetchInterval: 4_000,
  });
}

export function useMission(id: string | null) {
  return useQuery({
    queryKey: missionKeys.detail(id ?? ''),
    queryFn: () => missionsApi.get(id!),
    enabled: !!id,
    refetchInterval: 2_000,
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

/** Archive = close: the mission leaves the list but nothing is deleted. */
export function useArchiveMission() {
  const store = useStoreDetail();
  const closeTab = useDirectorStore((s) => s.closeMissionTab);
  return useMutation({
    mutationFn: (id: string) => missionsApi.update(id, { close: true }),
    onSuccess: (detail) => {
      store(detail);
      closeTab(detail.mission.id);
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

/** The mission needs the user: the brief is ready (G1) or questions wait. */
export function isWaitingForUser(m: MissionSummary): boolean {
  if (m.agent_running) return false;
  return (
    m.mission.status === 'brief_ready' ||
    (m.mission.status !== 'closed' && m.mission.pending_questions.length > 0)
  );
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
