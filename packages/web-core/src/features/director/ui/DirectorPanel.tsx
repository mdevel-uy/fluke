import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  ArrowsOutSimpleIcon,
  MinusIcon,
  PlusIcon,
  PushPinIcon,
  PushPinSlashIcon,
  SpinnerIcon,
  XIcon,
} from '@phosphor-icons/react';
import type { MissionSummary } from 'shared/types';
import { CollapsibleSectionHeader } from '@vibe/ui/components/CollapsibleSectionHeader';
import { cn } from '@/shared/lib/utils';
import { sessionsApi } from '@/shared/lib/api';
import { useRepos } from '@/shared/hooks/useRepos';
import { useAppNavigation } from '@/shared/hooks/useAppNavigation';
import { useSelectedRepoStore } from '@/shared/stores/useSelectedRepoStore';
import { MISSIONS_TAB, useDirectorStore } from '../model/useDirectorStore';
import {
  isWaitingForUser,
  useCreateMission,
  useMission,
  useMissionList,
  useMissionWorkspace,
  useSendToDirector,
} from '../model/useMissions';
import { DirectorChat } from './DirectorChat';
import { FlukeMark } from './FlukeMark';
import { QuickReplies } from './QuickReplies';
import { ProposalMessage } from './MissionProgress';

/** `page`: the /fluke route, which has no window controls of its own. */
export function DirectorHeader({
  context,
  page = false,
}: {
  context: string;
  page?: boolean;
}) {
  const { t } = useTranslation('common');
  const pinned = useDirectorStore((s) => s.pinned);
  const setView = useDirectorStore((s) => s.setView);
  const setPinned = useDirectorStore((s) => s.setPinned);
  const appNavigation = useAppNavigation();

  return (
    <div className="flex h-10 shrink-0 items-center gap-2 border-b border-md-outline-variant px-3">
      <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-brand text-on-brand">
        <FlukeMark size={12} />
      </span>
      <span className="shrink-0 text-sm font-medium text-high">
        {t('director.name')}
      </span>
      {context && !page && (
        <span
          className="min-w-0 truncate rounded-full bg-secondary px-2 py-0.5 text-xs text-low"
          title={context}
        >
          {context}
        </span>
      )}
      {!page && (
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          <HeaderButton
            label={t(pinned ? 'director.unpin' : 'director.pin')}
            onClick={() => setPinned(!pinned)}
          >
            {pinned ? <PushPinSlashIcon /> : <PushPinIcon />}
          </HeaderButton>
          <HeaderButton
            label={t('director.expand')}
            onClick={() => appNavigation.goToFluke()}
          >
            <ArrowsOutSimpleIcon />
          </HeaderButton>
          <HeaderButton
            label={t('director.minimize')}
            onClick={() => setView('bubble')}
          >
            <MinusIcon />
          </HeaderButton>
        </div>
      )}
    </div>
  );
}

function HeaderButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="rounded-md p-1 text-low transition-colors hover:bg-secondary/60 hover:text-high focus:outline-none focus-visible:ring-1 focus-visible:ring-brand [&>svg]:size-icon-xs"
    >
      {children}
    </button>
  );
}

/** "Missions" tab plus one tab per open mission, and "new mission". */
export function MissionTabs() {
  const { t } = useTranslation('common');
  const activeTab = useDirectorStore((s) => s.activeTab);
  const openIds = useDirectorStore((s) => s.openMissionIds);
  const setActiveTab = useDirectorStore((s) => s.setActiveTab);
  const closeTab = useDirectorStore((s) => s.closeMissionTab);
  const { data: missions = [] } = useMissionList();
  const byId = new Map(missions.map((m) => [m.mission.id, m]));

  return (
    <div className="flex h-8 shrink-0 items-stretch gap-0.5 overflow-x-auto border-b border-md-outline-variant px-2">
      <Tab
        active={activeTab === MISSIONS_TAB}
        onClick={() => setActiveTab(MISSIONS_TAB)}
        label={t('director.missions')}
      />
      {openIds
        .filter((id) => byId.has(id))
        .map((id) => (
          <Tab
            key={id}
            active={activeTab === id}
            onClick={() => setActiveTab(id)}
            onClose={() => closeTab(id)}
            label={missionLabel(byId.get(id)!, t('director.newMission'))}
            attention={isWaitingForUser(byId.get(id)!)}
          />
        ))}
      <NewMissionButton className="ml-1 self-center" />
    </div>
  );
}

function NewMissionButton({ className }: { className?: string }) {
  const { t } = useTranslation('common');
  const { repoId, create } = useNewMission();
  return (
    <button
      type="button"
      disabled={!repoId || create.isPending}
      onClick={() => repoId && create.mutate(repoId)}
      aria-label={t('director.newMission')}
      title={t('director.newMission')}
      className={cn(
        'rounded-md p-1 text-low hover:bg-secondary/60 hover:text-high disabled:opacity-40',
        className
      )}
    >
      {create.isPending ? (
        <SpinnerIcon className="size-icon-xs animate-spin" />
      ) : (
        <PlusIcon className="size-icon-xs" />
      )}
    </button>
  );
}

/** Missions of the /fluke page, in the shell sidebar instead of a tab. */
export function FlukeMissionsSidebar({
  selectedId,
}: {
  selectedId: string | null;
}) {
  const { t } = useTranslation('common');
  return (
    <div className="flex h-full w-full min-h-0 flex-col bg-md-surface-container-low">
      <CollapsibleSectionHeader
        title={t('director.missions')}
        collapsible={false}
        headerExtra={<NewMissionButton />}
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <MissionsList selectedId={selectedId} />
      </div>
    </div>
  );
}

function Tab({
  active,
  label,
  onClick,
  onClose,
  attention = false,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
  onClose?: () => void;
  attention?: boolean;
}) {
  return (
    <div
      className={cn(
        'group flex max-w-[140px] shrink-0 items-center gap-1 border-b-2 px-2 text-xs',
        active
          ? 'border-brand text-high'
          : 'border-transparent text-low hover:text-normal'
      )}
    >
      <button type="button" onClick={onClick} className="truncate">
        {label}
      </button>
      {attention && (
        <span className="size-1.5 shrink-0 rounded-full bg-warning" />
      )}
      {onClose && (
        <button
          type="button"
          onClick={onClose}
          className="opacity-0 group-hover:opacity-100"
          aria-label="close"
        >
          <XIcon className="size-icon-2xs" />
        </button>
      )}
    </div>
  );
}

export function missionLabel(m: MissionSummary, fallback: string): string {
  return m.mission.title || m.repo_name || fallback;
}

function useNewMission() {
  const { repos } = useRepos();
  const selectedRepoId = useSelectedRepoStore((s) => s.selectedRepoId);
  const repoId = repos.find((r) => r.id === selectedRepoId)?.id ?? repos[0]?.id;
  return { repoId, create: useCreateMission() };
}

/** Body of the panel for the active tab. */
export function DirectorBody() {
  const activeTab = useDirectorStore((s) => s.activeTab);
  return activeTab === MISSIONS_TAB ? (
    <MissionsList />
  ) : (
    <MissionConversation missionId={activeTab} />
  );
}

/** Every mission of every repo (the Director is global). */
function MissionsList({ selectedId = null }: { selectedId?: string | null }) {
  const { t } = useTranslation('common');
  const { data: missions = [], isLoading } = useMissionList();
  const openMission = useDirectorStore((s) => s.openMission);
  const { repoId, create } = useNewMission();

  if (isLoading)
    return (
      <Centered>
        <SpinnerIcon className="size-icon-base animate-spin text-low" />
      </Centered>
    );
  if (missions.length === 0) {
    return (
      <Centered>
        <span className="flex size-10 items-center justify-center rounded-full bg-brand text-on-brand">
          <FlukeMark size={18} />
        </span>
        <p className="text-sm font-medium text-high">
          {t('director.empty.title')}
        </p>
        <p className="max-w-[260px] text-xs text-low">
          {repoId ? t('director.empty.description') : t('director.noRepo')}
        </p>
        {repoId && (
          <button
            type="button"
            onClick={() => create.mutate(repoId)}
            disabled={create.isPending}
            className="mt-1 rounded-md border border-md-outline-variant px-3 py-1.5 text-xs font-medium text-high hover:bg-secondary/60"
          >
            {t('director.newMission')}
          </button>
        )}
        {create.error && (
          <p className="text-xs text-danger">{create.error.message}</p>
        )}
      </Centered>
    );
  }
  return (
    <ul className="flex flex-col overflow-y-auto">
      {missions.map((m) => (
        <li key={m.mission.id}>
          <button
            type="button"
            onClick={() => openMission(m.mission.id)}
            aria-current={m.mission.id === selectedId || undefined}
            className={cn(
              'flex w-full items-center gap-2 border-b border-md-outline-variant px-3 py-2 text-left hover:bg-secondary/60',
              m.mission.id === selectedId && 'bg-secondary'
            )}
          >
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-sm text-high">
                {missionLabel(m, t('director.newMission'))}
              </span>
              <span className="truncate text-xs text-low">
                {[m.repo_name, t(`director.status.${m.mission.status}`)]
                  .filter(Boolean)
                  .join(' · ')}
                {m.issues_total > 0 &&
                  ` · ${t('director.progress', { done: m.issues_closed, total: m.issues_total })}`}
              </span>
            </span>
            {isWaitingForUser(m) && (
              <span className="size-2 shrink-0 rounded-full bg-warning" />
            )}
            {m.agent_running && (
              <SpinnerIcon className="size-icon-xs shrink-0 animate-spin text-low" />
            )}
          </button>
        </li>
      ))}
    </ul>
  );
}

/** Chat of one mission, with the Director's open questions as chips. */
export function MissionConversation({ missionId }: { missionId: string }) {
  const { t } = useTranslation('common');
  const { data: detail, error } = useMission(missionId);
  const { data: workspaceContext } = useMissionWorkspace(missionId);
  const sessionId = detail?.mission.session_id;
  const { data: session } = useQuery({
    queryKey: ['session', sessionId],
    queryFn: () => sessionsApi.getById(sessionId!),
    enabled: !!sessionId,
    staleTime: 60_000,
  });
  const send = useSendToDirector(detail?.mission ?? null);
  const { data: missions = [] } = useMissionList();
  const running =
    missions.find((m) => m.mission.id === missionId)?.agent_running ?? false;

  if (error) {
    return (
      <Centered>
        <p className="text-xs text-danger">{error.message}</p>
      </Centered>
    );
  }
  if (!detail || !workspaceContext || !session) {
    return (
      <Centered>
        <SpinnerIcon className="size-icon-base animate-spin text-low" />
        <p className="text-xs text-low">{t('director.loading')}</p>
      </Centered>
    );
  }
  return (
    <DirectorChat
      workspaceContext={workspaceContext}
      selectedSession={session}
      aboveComposer={
        <>
          <ProposalMessage detail={detail} />
          <QuickReplies
            key={detail.mission.pending_questions
              .map((q) => q.question)
              .join('|')}
            questions={detail.mission.pending_questions}
            disabled={running || send.isPending}
            onSend={(text) => send.mutate(text)}
          />
        </>
      }
    />
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      {children}
    </div>
  );
}
