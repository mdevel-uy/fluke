import {
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  ArchiveIcon,
  ArrowCounterClockwiseIcon,
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
import { ConfirmDialog } from '@vibe/ui/components/ConfirmDialog';
import { cn } from '@/shared/lib/utils';
import { sessionsApi } from '@/shared/lib/api';
import { useRepos } from '@/shared/hooks/useRepos';
import { SidebarSection } from '@/shared/components/ui-new/shell/SidebarPrimitives';
import { useAppNavigation } from '@/shared/hooks/useAppNavigation';
import { useSelectedRepoStore } from '@/shared/stores/useSelectedRepoStore';
import { MISSIONS_TAB, useDirectorStore } from '../model/useDirectorStore';
import {
  isWaitingForUser,
  useArchiveMission,
  useCreateMission,
  useDeleteMission,
  useMission,
  useMissionList,
  useMissionWorkspace,
  useSendToDirector,
} from '../model/useMissions';
import { layoutTabs } from '../lib/tabLayout';
import { DirectorChat } from './DirectorChat';
import { FlukeMark } from './FlukeMark';
import { MissionTabsMenu, type MissionTabEntry } from './MissionTabsMenu';
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

/**
 * "Missions" tab, the open mission tabs that fit, an overflow menu with every
 * open tab, and "new mission" pinned to the right (spec #648). Nothing in
 * the bar scrolls; the active tab is always among the visible ones.
 */
export function MissionTabs() {
  const { t } = useTranslation('common');
  const activeTab = useDirectorStore((s) => s.activeTab);
  const openIds = useDirectorStore((s) => s.openMissionIds);
  const setActiveTab = useDirectorStore((s) => s.setActiveTab);
  const { data: missions = [] } = useMissionList();
  const byId = new Map(missions.map((m) => [m.mission.id, m]));
  const confirmDelete = useConfirmDeleteMission();
  const [zoneRef, zoneWidth] = useMeasuredWidth<HTMLDivElement>();

  const entries: MissionTabEntry[] = openIds.flatMap((id) => {
    const m = byId.get(id);
    if (!m) return [];
    return [
      {
        id,
        label: missionLabel(m, t('director.newMission')),
        attention: isWaitingForUser(m),
        running: m.agent_running,
        closable: !m.is_guard,
      },
    ];
  });
  const entryById = new Map(entries.map((e) => [e.id, e]));
  const { visible, hidden } = layoutTabs(
    entries.map((e) => e.id),
    activeTab,
    zoneWidth
  );
  const deleteLabel = (name: string) =>
    t('director.delete.actionNamed', { name });
  const remove = (id: string) => {
    const m = byId.get(id);
    if (m && !m.is_guard) void confirmDelete(m);
  };

  return (
    <div className="flex h-8 shrink-0 items-stretch gap-0.5 overflow-hidden border-b border-md-outline-variant px-2">
      <Tab
        active={activeTab === MISSIONS_TAB}
        onClick={() => setActiveTab(MISSIONS_TAB)}
        label={t('director.missions')}
      />
      {/* Measured zone: strip + overflow button. Its width doesn't depend
          on whether the button is shown, so the layout can't oscillate. */}
      <div ref={zoneRef} className="flex min-w-0 flex-1 gap-0.5">
        <div className="flex min-w-0 flex-1 gap-0.5 overflow-hidden">
          {visible.map((id) => {
            const e = entryById.get(id)!;
            return (
              <Tab
                key={id}
                mission
                squeezed={visible.length === 1}
                active={activeTab === id}
                onClick={() => setActiveTab(id)}
                onClose={e.closable ? () => remove(id) : undefined}
                closeLabel={deleteLabel(e.label)}
                label={e.label}
                attention={e.attention}
              />
            );
          })}
        </div>
        {hidden.length > 0 && (
          <MissionTabsMenu
            entries={entries}
            hiddenIds={hidden}
            activeId={activeTab}
            onSelect={setActiveTab}
            onDelete={remove}
            deleteLabel={deleteLabel}
          />
        )}
      </div>
      <NewMissionButton
        className="flex size-6 shrink-0 items-center justify-center self-center"
      />
    </div>
  );
}

/** Width of an element, kept up to date with a ResizeObserver. */
function useMeasuredWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  // Layout effect: measure before the first paint, so the bar doesn't
  // flash with a single tab.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.getBoundingClientRect().width);
    const observer = new ResizeObserver(([entry]) =>
      setWidth(entry.contentRect.width)
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

/**
 * The tab's X (#647): confirm, then delete the mission. Blocked while Fluke
 * is answering in it; issues already created are kept and the dialog says
 * so. On error the tab and the mission stay.
 */
function useConfirmDeleteMission() {
  const { t } = useTranslation('common');
  const remove = useDeleteMission();
  return async (m: MissionSummary) => {
    if (m.agent_running) {
      await ConfirmDialog.show({
        title: t('director.delete.busyTitle'),
        message: t('director.delete.busy'),
        confirmText: t('ok'),
        showCancelButton: false,
        variant: 'info',
      });
      return;
    }
    const issues = m.issue_numbers.map((n) => `#${n}`).join(', ');
    const result = await ConfirmDialog.show({
      title: t('director.delete.title', {
        name: missionLabel(m, t('director.newMission')),
      }),
      message: issues
        ? t('director.delete.messageWithIssues', { issues })
        : t('director.delete.message'),
      confirmText: t('director.delete.confirm'),
      variant: 'destructive',
    });
    if (result !== 'confirmed') return;
    try {
      await remove.mutateAsync(m.mission.id);
    } catch (error) {
      await ConfirmDialog.show({
        title: t('error'),
        message: t('director.delete.error', {
          message: error instanceof Error ? error.message : String(error),
        }),
        confirmText: t('ok'),
        showCancelButton: false,
      });
    }
  };
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
      {/* The header fills the column and lays out its children below. */}
      <CollapsibleSectionHeader
        title={t('director.missions')}
        collapsible={false}
        headerExtra={<NewMissionButton />}
      >
        <MissionsList selectedId={selectedId} />
      </CollapsibleSectionHeader>
    </div>
  );
}

/**
 * `mission`: a mission tab, which shares the strip with the others (equal
 * widths between 96px and 160px); otherwise the fixed "Missions" tab.
 * `squeezed`: the only visible mission tab, allowed below the minimum.
 */
function Tab({
  active,
  label,
  onClick,
  onClose,
  closeLabel,
  attention = false,
  mission = false,
  squeezed = false,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
  onClose?: () => void;
  closeLabel?: string;
  attention?: boolean;
  mission?: boolean;
  squeezed?: boolean;
}) {
  return (
    <div
      className={cn(
        'group flex items-center gap-1 border-b-2 px-2 text-xs',
        mission
          ? cn(
              'max-w-[160px] flex-[1_1_0]',
              squeezed ? 'min-w-0' : 'min-w-[96px]'
            )
          : 'shrink-0',
        active
          ? 'border-brand text-high'
          : 'border-transparent text-low hover:text-normal'
      )}
    >
      {/* min-w-0: the label shrinks first, so the X never gets clipped. */}
      <button
        type="button"
        onClick={onClick}
        className="min-w-0 flex-1 truncate text-left"
        title={label}
      >
        {label}
      </button>
      {attention && (
        <span className="size-1.5 shrink-0 rounded-full bg-warning" />
      )}
      {onClose && (
        // Its slot is always reserved; without hover (touch) the active
        // tab's X stays visible.
        <button
          type="button"
          onClick={onClose}
          className={cn(
            'flex size-4 shrink-0 items-center justify-center rounded-sm opacity-0 hover:bg-secondary/60 hover:text-high focus:outline-none focus-visible:ring-1 focus-visible:ring-brand group-focus-within:opacity-100 group-hover:opacity-100',
            active && '[@media(hover:none)]:opacity-100'
          )}
          aria-label={closeLabel}
          title={closeLabel}
        >
          <XIcon className="size-icon-2xs" />
        </button>
      )}
    </div>
  );
}

const isArchived = (m: MissionSummary) => m.mission.status === 'closed';

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
  const open = missions.filter((m) => !isArchived(m));
  const archived = missions.filter(isArchived);
  return (
    <div className="min-h-0 flex-1 overflow-y-auto pb-3">
      <SidebarSection
        persistKey="fluke-missions-open"
        title={t('director.archive.open')}
        count={open.length}
      >
        {open.map((m) => (
          <MissionRow
            key={m.mission.id}
            m={m}
            selected={m.mission.id === selectedId}
          />
        ))}
      </SidebarSection>
      {archived.length > 0 && (
        <SidebarSection
          persistKey="fluke-missions-archived"
          title={t('director.archive.archived')}
          count={archived.length}
          defaultOpen={false}
        >
          {archived.map((m) => (
            <MissionRow
              key={m.mission.id}
              m={m}
              selected={m.mission.id === selectedId}
            />
          ))}
        </SidebarSection>
      )}
    </div>
  );
}

/** SidebarRow look plus a hover archive/restore action (a SidebarRow is a button, so it can't nest one). */
function MissionRow({ m, selected }: { m: MissionSummary; selected: boolean }) {
  const { t } = useTranslation('common');
  const openMission = useDirectorStore((s) => s.openMission);
  const archive = useArchiveMission();
  const archivedMission = isArchived(m);
  const actionLabel = t(
    archivedMission ? 'director.archive.restore' : 'director.archive.action'
  );
  return (
    <div
      className={cn(
        'group relative mx-1.5 flex h-[22px] items-center rounded-[4px] text-sm',
        selected
          ? 'bg-sel text-high before:absolute before:left-0 before:top-0.5 before:bottom-0.5 before:w-[2px] before:rounded-full before:bg-brand-on-surface'
          : 'text-normal hover:bg-secondary'
      )}
    >
      <button
        type="button"
        onClick={() => openMission(m.mission.id)}
        aria-current={selected || undefined}
        title={[m.repo_name, t(`director.status.${m.mission.status}`)]
          .filter(Boolean)
          .join(' · ')}
        className="flex h-full min-w-0 flex-1 items-center gap-2 pl-4 pr-1 text-left focus:outline-none focus-visible:ring-1 focus-visible:ring-brand"
      >
        <span className="min-w-0 flex-1 truncate">
          {missionLabel(m, t('director.newMission'))}
        </span>
        {isWaitingForUser(m) && (
          <span className="size-1.5 shrink-0 rounded-full bg-warning" />
        )}
        {m.agent_running && (
          <SpinnerIcon className="size-icon-2xs shrink-0 animate-spin text-low" />
        )}
        {m.issues_total > 0 && (
          <span className="shrink-0 text-xs text-low group-hover:hidden">
            {m.issues_closed}/{m.issues_total}
          </span>
        )}
      </button>
      {/* Archive is one click: restoring is as easy (no confirm). */}
      <button
        type="button"
        onClick={() =>
          archive.mutate({ id: m.mission.id, archived: !archivedMission })
        }
        aria-label={actionLabel}
        title={actionLabel}
        className="mr-1 hidden shrink-0 rounded p-0.5 text-low hover:text-high focus-visible:flex group-hover:flex"
      >
        {archivedMission ? (
          <ArrowCounterClockwiseIcon className="size-icon-2xs" />
        ) : (
          <ArchiveIcon className="size-icon-2xs" />
        )}
      </button>
    </div>
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
