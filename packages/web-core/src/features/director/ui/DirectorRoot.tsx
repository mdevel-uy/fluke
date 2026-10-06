import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import {
  Group,
  Panel,
  Separator,
  useDefaultLayout,
} from 'react-resizable-panels';
import { useTranslation } from 'react-i18next';
import { XIcon } from '@phosphor-icons/react';
import type { MissionSummary } from 'shared/types';
import { isMac } from '@/shared/lib/platform';
import { ShellAsidePortal } from '@/shared/components/ui-new/shell/ShellAside';
import { ShellSidebarPortal } from '@/shared/components/ui-new/shell/ShellSidebar';
import { useUiPreferencesStore } from '@/shared/stores/useUiPreferencesStore';
import { useAppNavigation } from '@/shared/hooks/useAppNavigation';
import { useCurrentAppDestination } from '@/shared/hooks/useCurrentAppDestination';
import { isFlukeDestination } from '@/shared/lib/routes/appNavigation';
import { useDirectorStore } from '../model/useDirectorStore';
import {
  isWaitingForUser,
  missionLabel,
  useDirectorUiContext,
  useFocusedMission,
  useMission,
  useMissionList,
  useNewMission,
  useSyncUiContext,
} from '../model/useMissions';
import { BriefView } from './BriefView';
import { MissionStepper, ProposalPanel } from './MissionProgress';
import {
  consumeKeepViewOnLeave,
  FlukeHeader,
  FlukeMissionsSidebar,
  FlukePanel,
  MissionConversation,
  NoMissions,
} from './DirectorPanel';
import { FlukeFocusDialog } from './FlukeFocusDialog';
import { FlukeOrbParts } from './MissionRing';
import { useFlukeEventsLive } from '../model/useFlukeEventsLive';

/**
 * The Director ("Fluke" in the UI), mounted once in the app shell: a floating
 * bubble that opens a panel or anchors as a column in the right aside; the
 * full view is the /fluke page (`FlukePage`). Its state lives in
 * `useDirectorStore`, so it survives navigation and repo changes.
 */
export function DirectorRoot() {
  // Mounted once in the shell: Fluke's views follow the app's events.
  useFlukeEventsLive();
  const view = useDirectorStore((s) => s.view);
  const pinned = useDirectorStore((s) => s.pinned);
  const context = useDirectorUiContext();
  const { summary } = useFocusedMission();
  useSyncUiContext(summary?.mission.id ?? null, context);

  // On /fluke the page is the assistant: no second copy floating or docked.
  const onFlukePage = isFlukeDestination(useCurrentAppDestination());
  // With the panel open, Ctrl/Cmd+K drops its mission list; elsewhere it
  // opens the picker centered.
  const panelShownRef = useRef(false);
  useEffect(() => {
    panelShownRef.current = view === 'panel' && !onFlukePage;
  }, [view, onFlukePage]);
  // Ctrl/Cmd+Shift+N: a new mission in the selected repo, opened in Fluke.
  const { repoId, create } = useNewMission();
  const newMissionRef = useRef(() => {});
  useEffect(() => {
    newMissionRef.current = () => {
      if (repoId && !create.isPending) create.mutate(repoId);
    };
  }, [repoId, create]);

  // Ctrl/Cmd+Shift+I, as in VS Code's chat, toggles Fluke; Ctrl/Cmd+K picks
  // its focus; Ctrl/Cmd+Shift+N starts a new mission. Capture phase so xterm or the editor can't swallow them first
  // (same as Ctrl+J for the terminal).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const modifier = isMac() ? event.metaKey : event.ctrlKey;
      if (!modifier || event.altKey) return;
      const key = event.key.toLowerCase();
      if (!event.shiftKey && key === 'k') {
        event.preventDefault();
        event.stopPropagation();
        if (panelShownRef.current) {
          const { picker, setPicker } = useDirectorStore.getState();
          setPicker(picker ? null : 'all');
        } else void FlukeFocusDialog.show();
        return;
      }
      if (!event.shiftKey || (key !== 'i' && key !== 'n')) return;
      event.preventDefault();
      event.stopPropagation();
      if (key === 'n') newMissionRef.current();
      else useDirectorStore.getState().toggle();
    };
    window.addEventListener('keydown', onKeyDown, { capture: true });
    return () =>
      window.removeEventListener('keydown', onKeyDown, { capture: true });
  }, []);

  // Anchoring uses the existing right-panel toggle: show it when pinning.
  const showRightSidebar = useUiPreferencesStore(
    (s) => s.setRightSidebarVisible
  );
  useEffect(() => {
    if (pinned && view === 'panel') showRightSidebar(true);
  }, [pinned, view, showRightSidebar]);
  // Hiding the aside while pinned must not hide Fluke with it (issue #637):
  // it floats until the aside is shown again, then docks back.
  const isRightSidebarVisible = useUiPreferencesStore(
    (s) => s.isRightSidebarVisible
  );

  if (onFlukePage) return null;
  if (view === 'panel' && pinned && isRightSidebarVisible) {
    return (
      <ShellAsidePortal className="order-last">
        <div className="flex h-full min-h-0 flex-col border-l border-brand/30 bg-primary shadow-[-12px_0_30px_hsl(var(--brand)/0.08)]">
          <FlukePanel mode="pinned" />
        </div>
      </ShellAsidePortal>
    );
  }
  return createPortal(
    <>
      {view === 'panel' && (
        <aside
          role="complementary"
          aria-label="Fluke"
          className="fixed bottom-[106px] right-7 z-[80] flex h-[min(680px,calc(100vh-192px))] w-[420px] max-w-[calc(100vw-3.5rem)] flex-col overflow-hidden rounded-[14px] border border-md-outline-variant bg-primary shadow-overlay ring-1 ring-brand/15"
        >
          <FlukePanel mode="floating" />
        </aside>
      )}
      <DirectorBubble />
    </>,
    document.body
  );
}

/**
 * The /fluke page: Fluke's own place in the app (rail item and the panel's
 * expand button), with the conversation and the live brief side by side.
 */
export function FlukePage() {
  const { t } = useTranslation('common');
  const { summary, isLoading } = useFocusedMission();
  const missionId = summary?.mission.id ?? null;
  const context = useDirectorUiContext();
  const { data: detail } = useMission(missionId);
  const { defaultLayout, onLayoutChange } = useDefaultLayout({
    storage: localStorage,
    debounceSaveMs: 150,
    id: 'fluke-page',
  });

  // Creating a mission or Ctrl+K opens the floating panel (openMission); here
  // that must not leak: leaving the page restores the previous view, unless
  // the header's pin / back-to-panel buttons picked one.
  useEffect(() => {
    const { view, setView } = useDirectorStore.getState();
    return () => {
      if (!consumeKeepViewOnLeave()) setView(view);
    };
  }, []);

  return (
    <div className="flex h-full min-h-0 flex-col bg-primary">
      <ShellSidebarPortal>
        <FlukeMissionsSidebar selectedId={missionId} />
      </ShellSidebarPortal>
      <FlukeHeader mode="page" summary={summary} context={context} />
      {/* Chat | brief, resizable; the split is remembered across visits. */}
      <Group
        orientation="horizontal"
        className="min-h-0 flex-1"
        defaultLayout={defaultLayout}
        onLayoutChange={onLayoutChange}
      >
        <Panel id="fluke-chat" minSize="360px" className="min-w-0">
          {missionId ? (
            <MissionConversation missionId={missionId} mode="page" />
          ) : (
            <NoMissions loading={isLoading} />
          )}
        </Panel>
        <Separator
          id="fluke-separator"
          className="w-1 border-l border-md-outline-variant bg-transparent transition-colors hover:bg-brand/50 cursor-col-resize"
        />
        <Panel
          id="fluke-brief"
          defaultSize="420px"
          minSize="280px"
          maxSize="70%"
          className="overflow-y-auto"
        >
          {detail?.is_guard ? (
            <p className="p-base text-xs text-low">
              {t('director.guard.noBrief')}
            </p>
          ) : detail ? (
            <div className="grid gap-3 p-base">
              <MissionStepper detail={detail} />
              <ProposalPanel detail={detail} />
              <BriefView detail={detail} />
            </div>
          ) : (
            <p className="p-base text-xs text-low">
              {t('director.brief.pickMission')}
            </p>
          )}
        </Panel>
      </Group>
    </div>
  );
}

const noticeKey = (m: MissionSummary) =>
  `${m.mission.id}:${m.mission.status}:${m.mission.pending_questions.length}`;

/**
 * Director toggle: the app's mark, with an amber counter of missions
 * waiting on the user and, when collapsed, a short card with actions.
 */
function DirectorBubble() {
  const { t } = useTranslation('common');
  const { data: missions = [] } = useMissionList();
  const toggle = useDirectorStore((s) => s.toggle);
  const panelOpen = useDirectorStore((s) => s.view === 'panel');
  const openMission = useDirectorStore((s) => s.openMission);
  const setView = useDirectorStore((s) => s.setView);
  const dismissed = useDirectorStore((s) => s.dismissed);
  const dismiss = useDirectorStore((s) => s.dismiss);
  const appNavigation = useAppNavigation();

  const waiting = missions.filter(isWaitingForUser);
  const notice = waiting.find((m) => !dismissed.includes(noticeKey(m)));
  const working = missions.some((m) => m.agent_running);
  const label = t(panelOpen ? 'director.minimize' : 'director.open');

  return (
    <div className="fixed bottom-[42px] right-7 z-[80] flex flex-col items-end gap-2">
      {!panelOpen && notice && (
        <div className="flex w-[280px] flex-col gap-2 rounded-lg border border-md-outline-variant bg-primary p-3 shadow-overlay">
          <div className="flex items-start gap-2">
            <p className="flex-1 text-xs text-normal">
              {notice.mission.status === 'brief_ready'
                ? t('director.notice.briefReady', {
                    title: missionLabel(notice, ''),
                  })
                : t('director.notice.questions', {
                    title: missionLabel(notice, ''),
                  })}
            </p>
            <button
              type="button"
              onClick={() => dismiss(noticeKey(notice))}
              aria-label={t('director.dismiss')}
              className="text-low hover:text-high"
            >
              <XIcon className="size-icon-2xs" />
            </button>
          </div>
          <button
            type="button"
            onClick={() => {
              openMission(notice.mission.id);
              // The brief needs room: review it on Fluke's page.
              if (notice.mission.status === 'brief_ready') {
                setView('bubble');
                appNavigation.goToFluke();
              }
            }}
            className="self-end rounded-md bg-brand px-2 py-1 text-xs font-medium text-on-brand hover:bg-brand-hover"
          >
            {notice.mission.status === 'brief_ready'
              ? t('director.notice.review')
              : t('director.notice.answer')}
          </button>
        </div>
      )}
      <button
        type="button"
        onClick={toggle}
        aria-label={label}
        aria-expanded={panelOpen}
        title={`${label} (Ctrl Shift I)`}
        data-state={waiting.length > 0 ? 'alert' : working ? 'working' : 'idle'}
        className="fluke-orb focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
      >
        <FlukeOrbParts markSize={18} />
        {waiting.length > 0 && (
          <span className="absolute -right-1 -top-1 z-[2] flex h-5 min-w-5 items-center justify-center rounded-full bg-warning px-1 font-mono tabular-nums text-[10px] font-semibold text-black/85 shadow-[0_0_0_2px_hsl(var(--md-background))]">
            {waiting.length}
          </span>
        )}
      </button>
    </div>
  );
}
