import { useState, type CSSProperties, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  ArchiveIcon,
  ArrowCounterClockwiseIcon,
  ArrowsInSimpleIcon,
  ArrowsOutSimpleIcon,
  CaretDownIcon,
  CaretRightIcon,
  MagnifyingGlassIcon,
  MinusIcon,
  PlusIcon,
  PushPinIcon,
  PushPinSlashIcon,
  SpinnerIcon,
  TrashIcon,
} from '@phosphor-icons/react';
import type { MissionSummary } from 'shared/types';
import { ConfirmDialog } from '@vibe/ui/components/ConfirmDialog';
import { cn } from '@/shared/lib/utils';
import { sessionsApi } from '@/shared/lib/api';
import { getModifierKey } from '@/shared/lib/platform';
import { useAppNavigation } from '@/shared/hooks/useAppNavigation';
import { useDirectorStore, type PickerFilter } from '../model/useDirectorStore';
import {
  isArchived,
  isWaitingForUser,
  missionLabel,
  useArchiveMission,
  useDeleteMission,
  useFocusedMission,
  useMission,
  useMissionList,
  useMissionWorkspace,
  useNewMission,
  useSendToDirector,
} from '../model/useMissions';
import { DirectorChat } from './DirectorChat';
import { FlukeFocusDialog, MissionPicker } from './FlukeFocusDialog';
import { FlukeMark } from './FlukeMark';
import { FlukeWelcome } from './FlukeWelcome';
import { FlukeOrbParts, MissionRing, useStatusLine } from './MissionRing';
import { QuickReplies } from './QuickReplies';
import { ProposalMessage } from './MissionProgress';

/**
 * Fluke without tabs (design/mockups/fluke-v2/fluke-jarvis): one focused
 * mission at a time, switched from the panel's title or with Ctrl/Cmd+K.
 * `floating` and `pinned` share the panel (header, strip, conversation);
 * `page` is the /fluke route, which lists every mission, archived included.
 */
export type FlukeMode = 'floating' | 'pinned' | 'page';

// Leaving /fluke from its header keeps the view the user picked there; any
// other exit restores the one from before the page (see FlukePage).
let keepViewOnLeave = false;
export function consumeKeepViewOnLeave() {
  const keep = keepViewOnLeave;
  keepViewOnLeave = false;
  return keep;
}

export function FlukeHeader({
  mode,
  summary,
  context = '',
  pickerOpen = false,
  onTitleClick,
}: {
  mode: FlukeMode;
  summary: MissionSummary | undefined;
  context?: string;
  /** In the panel the title drops the mission list. */
  pickerOpen?: boolean;
  onTitleClick?: () => void;
}) {
  const { t } = useTranslation('common');
  const setView = useDirectorStore((s) => s.setView);
  const setPinned = useDirectorStore((s) => s.setPinned);
  const appNavigation = useAppNavigation();
  const statusLine = useStatusLine();
  const page = mode === 'page';
  const title =
    summary && !summary.is_guard
      ? missionLabel(summary, t('director.newMission'))
      : t('director.name');

  const leavePage = (pinned: boolean) => {
    keepViewOnLeave = true;
    useDirectorStore.setState({ view: 'panel', pinned });
    if (window.history.length > 1) window.history.back();
    else appNavigation.goToWorkspaces();
  };

  return (
    <header
      className={cn(
        'fluke-scan flex shrink-0 items-center border-b border-md-outline-variant',
        page ? 'gap-3.5 px-5 py-4' : 'gap-2.5 py-2.5 pl-3 pr-2'
      )}
    >
      <span
        className="fluke-orb shrink-0"
        data-state={summary?.agent_running ? 'working' : 'idle'}
        style={{ '--orb-size': page ? '48px' : '32px' } as CSSProperties}
      >
        <FlukeOrbParts markSize={page ? 15 : 12} />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        {page ? (
          <h1 className="m-0 truncate text-lg font-semibold text-high">
            {title}
          </h1>
        ) : (
          <button
            type="button"
            onClick={onTitleClick}
            aria-expanded={pickerOpen}
            title={t('director.focus.change')}
            className="flex min-w-0 items-center gap-1.5 self-start text-left text-sm font-semibold text-high hover:text-brand-on-surface focus:outline-none focus-visible:ring-1 focus-visible:ring-brand"
          >
            <span className="truncate">{title}</span>
            <CaretDownIcon
              weight="bold"
              className={cn(
                'size-3 shrink-0 text-brand-on-surface transition-transform',
                pickerOpen && 'rotate-180'
              )}
            />
          </button>
        )}
        <span className="flex min-w-0 items-center gap-2 font-mono text-[10px] uppercase leading-none tracking-[0.12em] text-brand-on-surface">
          <span className="truncate">
            {[summary && statusLine(summary), page && context]
              .filter(Boolean)
              .join(' · ')}
          </span>
          <button
            type="button"
            onClick={onTitleClick ?? (() => void FlukeFocusDialog.show())}
            title={t('director.focus.change')}
            className="shrink-0 rounded border border-md-outline-variant bg-md-surface-container-low px-1 py-0.5 text-[9.5px] normal-case tracking-normal text-low hover:text-high"
          >
            {getModifierKey()} K
          </button>
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        {mode === 'floating' && (
          <>
            <HeaderButton
              label={t('director.pin')}
              onClick={() => setPinned(true)}
            >
              <PushPinIcon />
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
          </>
        )}
        {mode === 'pinned' && (
          <>
            <HeaderButton
              label={t('director.unpin')}
              onClick={() => setPinned(false)}
            >
              <PushPinSlashIcon />
            </HeaderButton>
            <HeaderButton
              label={t('director.expand')}
              onClick={() => appNavigation.goToFluke()}
            >
              <ArrowsOutSimpleIcon />
            </HeaderButton>
          </>
        )}
        {page && (
          <>
            <HeaderButton
              label={t('director.pin')}
              onClick={() => leavePage(true)}
            >
              <PushPinIcon />
            </HeaderButton>
            <HeaderButton
              label={t('director.backToPanel')}
              onClick={() => leavePage(false)}
            >
              <ArrowsInSimpleIcon />
            </HeaderButton>
          </>
        )}
      </div>
    </header>
  );
}

function HeaderButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="rounded-md p-1.5 text-low transition-colors hover:bg-secondary/60 hover:text-high focus:outline-none focus-visible:ring-1 focus-visible:ring-brand [&>svg]:size-icon-xs"
    >
      {children}
    </button>
  );
}

/** One segment per issue of the plan, lit as they close. */
function ProgressSegments({ m }: { m: MissionSummary }) {
  if (m.issues_total === 0) return null;
  return (
    <div aria-hidden className="flex h-[3px] shrink-0 gap-[3px] px-3">
      {Array.from({ length: m.issues_total }, (_, i) => (
        <span
          key={i}
          className={cn(
            'flex-1 rounded-full',
            i < m.issues_closed
              ? 'bg-brand-on-surface shadow-[0_0_6px_hsl(var(--brand-on-surface))]'
              : 'bg-md-outline-variant'
          )}
        />
      ))}
    </div>
  );
}

/**
 * Floating and pinned Fluke: the focused mission's header (its title drops
 * the mission list), a strip with what needs attention, and the focused
 * conversation. Archived missions only show on /fluke.
 */
export function FlukePanel({ mode }: { mode: 'floating' | 'pinned' }) {
  const { t } = useTranslation('common');
  const { summary, isLoading } = useFocusedMission();
  const picker = useDirectorStore((s) => s.picker);
  const setPicker = useDirectorStore((s) => s.setPicker);
  const focus = useDirectorStore((s) => s.focus);
  const { repoId, create } = useNewMission();
  return (
    <>
      <FlukeHeader
        mode={mode}
        summary={summary}
        pickerOpen={picker !== null}
        onTitleClick={() => setPicker(picker ? null : 'all')}
      />
      {summary && <ProgressSegments m={summary} />}
      <MissionStrip focusedId={summary?.mission.id ?? null} />
      <div className="relative flex min-h-0 flex-1 flex-col">
        {summary && <ResolveCard m={summary} />}
        <div className="min-h-0 flex-1 overflow-hidden">
          {summary ? (
            <MissionConversation missionId={summary.mission.id} mode={mode} />
          ) : (
            <NoMissions loading={isLoading} />
          )}
        </div>
        {picker && (
          <div
            className="absolute inset-0 z-10 flex flex-col"
            onKeyDown={(e) => e.key === 'Escape' && setPicker(null)}
          >
            <button
              type="button"
              tabIndex={-1}
              aria-label={t('close')}
              onClick={() => setPicker(null)}
              className="absolute inset-0 cursor-default bg-black/50"
            />
            <div className="relative mx-2 flex max-h-full min-h-0 flex-col overflow-hidden rounded-b-xl border border-t-0 border-brand/40 shadow-overlay">
              <MissionPicker
                filter={picker}
                onPick={focus}
                onNew={() => {
                  setPicker(null);
                  if (repoId) create.mutate(repoId);
                }}
              />
            </div>
          </div>
        )}
      </div>
    </>
  );
}

/**
 * Under the header: missions waiting on the user, other missions Fluke is
 * working on, and the total. Each opens the mission list on its group.
 */
function MissionStrip({ focusedId }: { focusedId: string | null }) {
  const { t } = useTranslation('common');
  const { data: missions = [] } = useMissionList();
  const picker = useDirectorStore((s) => s.picker);
  const setPicker = useDirectorStore((s) => s.setPicker);
  const open = missions.filter((m) => !isArchived(m));
  const waiting = open.filter((m) => !m.is_guard && isWaitingForUser(m));
  const working = open.filter(
    (m) => !m.is_guard && m.agent_running && m.mission.id !== focusedId
  );
  if (open.length === 0) return null;
  const toggle = (filter: PickerFilter) =>
    setPicker(picker === filter ? null : filter);

  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-md-outline-variant px-3 py-2">
      {waiting.length > 0 && (
        <StripChip
          missions={waiting}
          label={t('director.waiting', { count: waiting.length })}
          active={picker === 'waiting'}
          onClick={() => toggle('waiting')}
          className="border-warning/40 bg-warning/10 text-high"
        />
      )}
      {working.length > 0 && (
        <StripChip
          missions={working}
          label={t('director.strip.working', { count: working.length })}
          active={picker === 'working'}
          onClick={() => toggle('working')}
          className="border-md-outline-variant bg-md-surface-container-low text-brand-on-surface"
        />
      )}
      <span className="flex-1" />
      <button
        type="button"
        aria-pressed={picker === 'all'}
        onClick={() => toggle('all')}
        className={cn(
          'shrink-0 rounded-md px-2 py-1 font-mono text-[11px]',
          picker === 'all'
            ? 'bg-brand/15 text-high ring-1 ring-inset ring-brand/50'
            : 'text-low hover:text-high'
        )}
      >
        {t('director.strip.total', { count: open.length })}
      </button>
    </div>
  );
}

function StripChip({
  missions,
  label,
  active,
  onClick,
  className,
}: {
  missions: MissionSummary[];
  label: string;
  active: boolean;
  onClick: () => void;
  className: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'flex min-w-0 items-center gap-2 rounded-full border py-0.5 pl-0.5 pr-2.5 text-xs',
        active && 'ring-1 ring-brand/60',
        className
      )}
    >
      <span className="flex shrink-0">
        {missions.slice(0, 3).map((m, i) => (
          <span
            key={m.mission.id}
            className={cn(
              'rounded-full shadow-[0_0_0_2px_hsl(var(--md-surface-container-lowest))]',
              i > 0 && '-ml-1.5'
            )}
          >
            <MissionRing m={m} size={20} />
          </span>
        ))}
      </span>
      <span className="truncate">{label}</span>
    </button>
  );
}

/** The focused mission's brief waits for approval: review it on /fluke. */
function ResolveCard({ m }: { m: MissionSummary }) {
  const { t } = useTranslation('common');
  const appNavigation = useAppNavigation();
  if (m.mission.status !== 'brief_ready') return null;
  return (
    <div className="flex flex-col gap-2 px-3 pt-3">
      <span className="font-mono text-[10px] uppercase leading-none tracking-[0.14em] text-warning">
        {t('director.resolve.title')}
      </span>
      <div className="flex items-center gap-2.5 rounded-lg border border-warning/40 bg-warning/10 px-2.5 py-2">
        <span className="size-1.5 shrink-0 rounded-full bg-warning" />
        <span className="flex-1 text-xs text-high">
          {t('director.resolve.briefReady')}
        </span>
        <button
          type="button"
          onClick={() => appNavigation.goToFluke()}
          className="rounded-md bg-brand px-2.5 py-1 text-xs font-medium text-on-brand hover:bg-brand-hover"
        >
          {t('director.notice.review')}
        </button>
      </div>
    </div>
  );
}

/**
 * Delete from the missions list: confirm, then delete the mission. Blocked
 * while Fluke is answering in it; issues already created are kept and the
 * dialog says so. On error the mission stays.
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

function NewMissionButton() {
  const { t } = useTranslation('common');
  const { repoId, create } = useNewMission();
  return (
    <button
      type="button"
      disabled={!repoId || create.isPending}
      onClick={() => repoId && create.mutate(repoId)}
      aria-label={t('director.newMission')}
      title={t('director.newMission')}
      className="flex shrink-0 items-center justify-center rounded-md p-1 text-low hover:bg-secondary/60 hover:text-high disabled:opacity-40"
    >
      {create.isPending ? (
        <SpinnerIcon className="size-icon-xs animate-spin" />
      ) : (
        <PlusIcon className="size-icon-xs" />
      )}
    </button>
  );
}

/**
 * Missions of the /fluke page, in the shell sidebar: the ones waiting on the
 * user, the ones in progress, Fluke's general conversation, and the archived
 * ones (only here) in a collapsed section.
 */
export function FlukeMissionsSidebar({
  selectedId,
}: {
  selectedId: string | null;
}) {
  const { t } = useTranslation('common');
  const { data: missions = [], isLoading } = useMissionList();
  const open = missions.filter((m) => !m.is_guard && !isArchived(m));
  const waiting = open.filter(isWaitingForUser);
  const active = open.filter((m) => !isWaitingForUser(m));
  const guard = missions.find((m) => m.is_guard);
  const archived = missions.filter((m) => !m.is_guard && isArchived(m));
  const row = (m: MissionSummary) => (
    <MissionRow
      key={m.mission.id}
      m={m}
      selected={m.mission.id === selectedId}
    />
  );

  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-md-surface-container-low">
      <div className="flex items-center gap-2 px-3.5 pb-1.5 pt-3">
        <span className="flex-1 font-mono text-[11px] font-medium uppercase tracking-[0.16em] text-brand-on-surface">
          {t('director.missions')}
        </span>
        <NewMissionButton />
      </div>
      <button
        type="button"
        onClick={() => void FlukeFocusDialog.show()}
        className="mx-3 flex items-center gap-2 rounded-lg border border-md-outline-variant bg-primary px-2.5 py-1.5 text-xs text-low hover:text-normal"
      >
        <MagnifyingGlassIcon className="size-icon-xs" />
        <span className="flex-1 text-left">{t('director.focus.change')}</span>
        <kbd className="font-mono text-[10px]">{getModifierKey()} K</kbd>
      </button>
      {missions.length === 0 ? (
        <NoMissions loading={isLoading} />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
          {waiting.length > 0 && (
            <ListGroup
              title={t('director.focus.waiting')}
              className="text-warning"
            >
              {waiting.map(row)}
            </ListGroup>
          )}
          {active.length > 0 && (
            <ListGroup
              title={t('director.focus.active')}
              className="text-brand-on-surface"
            >
              {active.map(row)}
            </ListGroup>
          )}
          {guard && (
            <ListGroup title={t('director.focus.always')} className="text-low">
              {row(guard)}
            </ListGroup>
          )}
        </div>
      )}
      {archived.length > 0 && (
        <ArchivedDrawer count={archived.length}>
          {archived.map(row)}
        </ArchivedDrawer>
      )}
    </div>
  );
}

/**
 * Archived missions, docked at the bottom of the /fluke list and dimmed:
 * there when needed, out of the way otherwise. Collapsed by default.
 */
function ArchivedDrawer({
  count,
  children,
}: {
  count: number;
  children: ReactNode;
}) {
  const { t } = useTranslation('common');
  const [open, setOpen] = useState(false);
  return (
    <div className="flex max-h-[45%] shrink-0 flex-col border-t border-md-outline-variant">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 px-4 py-2.5 font-mono text-[10px] uppercase tracking-[0.14em] text-low/70 hover:text-low"
      >
        <CaretRightIcon
          weight="bold"
          className={cn('size-2.5 transition-transform', open && 'rotate-90')}
        />
        {t('director.archive.archived')} · {count}
      </button>
      {open && (
        <div className="min-h-0 overflow-y-auto px-2 pb-2">{children}</div>
      )}
    </div>
  );
}

function ListGroup({
  title,
  className,
  children,
}: {
  title: string;
  className: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <span
        className={cn(
          'px-2.5 pb-1.5 pt-3.5 font-mono text-[10px] font-medium uppercase leading-none tracking-[0.14em]',
          className
        )}
      >
        {title}
      </span>
      {children}
    </div>
  );
}

/** A mission of the /fluke list, with hover archive/restore and delete. */
function MissionRow({ m, selected }: { m: MissionSummary; selected: boolean }) {
  const { t } = useTranslation('common');
  const focus = useDirectorStore((s) => s.focus);
  const archive = useArchiveMission();
  const confirmDelete = useConfirmDeleteMission();
  const statusLine = useStatusLine();
  const archivedMission = isArchived(m);
  const actionLabel = t(
    archivedMission ? 'director.archive.restore' : 'director.archive.action'
  );
  return (
    <div
      className={cn(
        'group relative flex items-center rounded-lg',
        selected
          ? 'bg-brand/15 text-high before:absolute before:-left-1.5 before:bottom-2 before:top-2 before:w-[3px] before:rounded-full before:bg-brand-on-surface before:shadow-[0_0_8px_hsl(var(--brand-on-surface))]'
          : 'text-normal hover:bg-secondary',
        archivedMission && !m.is_guard && !selected && 'opacity-60'
      )}
    >
      <button
        type="button"
        onClick={() => focus(m.mission.id)}
        aria-current={selected || undefined}
        title={m.repo_name ?? undefined}
        className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left focus:outline-none focus-visible:ring-1 focus-visible:ring-brand"
      >
        <MissionRing m={m} size={26} selected={selected} />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-sm">
            {m.is_guard
              ? t('director.focus.general')
              : missionLabel(m, t('director.newMission'))}
          </span>
          <span className="truncate font-mono text-[10.5px] text-low">
            {statusLine(m)}
          </span>
        </span>
        {isWaitingForUser(m) && (
          <span className="size-1.5 shrink-0 rounded-full bg-warning shadow-[0_0_8px_hsl(var(--warning))] group-hover:hidden" />
        )}
      </button>
      {!m.is_guard && (
        <>
          {/* Archive is one click: restoring is as easy (no confirm). */}
          <button
            type="button"
            onClick={() =>
              archive.mutate({ id: m.mission.id, archived: !archivedMission })
            }
            aria-label={actionLabel}
            title={actionLabel}
            className="mr-1 hidden shrink-0 rounded p-1 text-low hover:text-high focus-visible:flex group-hover:flex"
          >
            {archivedMission ? (
              <ArrowCounterClockwiseIcon className="size-icon-2xs" />
            ) : (
              <ArchiveIcon className="size-icon-2xs" />
            )}
          </button>
          <button
            type="button"
            onClick={() => void confirmDelete(m)}
            aria-label={t('director.delete.action')}
            title={t('director.delete.action')}
            className="mr-1.5 hidden shrink-0 rounded p-1 text-low hover:text-high focus-visible:flex group-hover:flex"
          >
            <TrashIcon className="size-icon-2xs" />
          </button>
        </>
      )}
    </div>
  );
}

/** No mission yet: invite to start one (or say a repo is needed first). */
export function NoMissions({ loading }: { loading: boolean }) {
  const { t } = useTranslation('common');
  const { repoId, create } = useNewMission();
  if (loading)
    return (
      <Centered>
        <SpinnerIcon className="size-icon-base animate-spin text-low" />
      </Centered>
    );
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

/** Chat of one mission, with the Director's open questions as chips. */
export function MissionConversation({
  missionId,
  mode,
}: {
  missionId: string;
  mode: FlukeMode;
}) {
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
  const summary = missions.find((m) => m.mission.id === missionId);
  const running = summary?.agent_running ?? false;

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
      emptyState={
        <FlukeWelcome
          m={summary}
          page={mode === 'page'}
          // The floating panel is too short for them.
          suggestions={mode !== 'floating'}
          disabled={running || send.isPending}
          onSend={(text) => send.mutate(text)}
        />
      }
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

function Centered({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      {children}
    </div>
  );
}
