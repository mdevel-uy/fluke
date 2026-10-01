import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { XIcon } from '@phosphor-icons/react';
import type { MissionSummary } from 'shared/types';
import { cn } from '@/shared/lib/utils';
import { isMac } from '@/shared/lib/platform';
import { ShellAsidePortal } from '@/shared/components/ui-new/shell/ShellAside';
import { useUiPreferencesStore } from '@/shared/stores/useUiPreferencesStore';
import { MISSIONS_TAB, useDirectorStore } from '../model/useDirectorStore';
import {
  isWaitingForUser,
  useDirectorUiContext,
  useMission,
  useMissionList,
  useSyncUiContext,
} from '../model/useMissions';
import { BriefView } from './BriefView';
import {
  DirectorBody,
  DirectorHeader,
  MissionConversation,
  MissionTabs,
  missionLabel,
} from './DirectorPanel';
import { FlukeMark } from './FlukeMark';

/**
 * The Director ("Fluke" in the UI), mounted once in the app shell: a floating
 * bubble that opens a panel, anchors as a column in the right aside, or
 * expands to a full-screen view with the live brief. Its state lives in
 * `useDirectorStore`, so it survives navigation and repo changes.
 */
export function DirectorRoot() {
  const view = useDirectorStore((s) => s.view);
  const pinned = useDirectorStore((s) => s.pinned);
  const activeTab = useDirectorStore((s) => s.activeTab);
  const context = useDirectorUiContext();
  const missionId = activeTab === MISSIONS_TAB ? null : activeTab;
  useSyncUiContext(missionId, context);

  // Ctrl/Cmd+Shift+I, as in VS Code's chat. Capture phase so xterm or the
  // editor can't swallow it first (same as Ctrl+J for the terminal).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const modifier = isMac() ? event.metaKey : event.ctrlKey;
      if (!modifier || !event.shiftKey || event.altKey) return;
      if (event.key.toLowerCase() !== 'i') return;
      event.preventDefault();
      event.stopPropagation();
      useDirectorStore.getState().toggle();
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

  if (view === 'expanded') {
    return createPortal(
      <DirectorExpanded context={context} missionId={missionId} />,
      document.body
    );
  }
  if (view === 'panel' && pinned) {
    return (
      <ShellAsidePortal>
        <div className="flex h-full min-h-0 flex-col bg-primary">
          <DirectorHeader context={context} />
          <MissionTabs />
          <div className="min-h-0 flex-1 overflow-hidden">
            <DirectorBody />
          </div>
        </div>
      </ShellAsidePortal>
    );
  }
  return createPortal(
    view === 'panel' ? (
      <aside
        role="complementary"
        aria-label="Fluke"
        className="fixed bottom-[34px] right-4 z-[80] flex h-[min(640px,calc(100vh-120px))] w-[380px] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-lg border border-md-outline-variant bg-primary shadow-overlay"
      >
        <DirectorHeader context={context} />
        <MissionTabs />
        <div className="min-h-0 flex-1 overflow-hidden">
          <DirectorBody />
        </div>
      </aside>
    ) : (
      <DirectorBubble />
    ),
    document.body
  );
}

function DirectorExpanded({
  context,
  missionId,
}: {
  context: string;
  missionId: string | null;
}) {
  const { t } = useTranslation('common');
  const { data: detail } = useMission(missionId);
  return (
    <div className="fixed inset-0 z-[80] flex flex-col bg-primary">
      <DirectorHeader context={context} />
      <MissionTabs />
      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1 overflow-hidden border-r border-md-outline-variant">
          {missionId ? (
            <MissionConversation missionId={missionId} />
          ) : (
            <DirectorBody />
          )}
        </div>
        <div className="w-[420px] shrink-0 overflow-y-auto">
          {detail ? (
            <BriefView detail={detail} />
          ) : (
            <p className="p-base text-xs text-low">
              {t('director.brief.pickMission')}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

const noticeKey = (m: MissionSummary) =>
  `${m.mission.id}:${m.mission.status}:${m.mission.pending_questions.length}`;

/**
 * Collapsed Director. Rest: the app's mark. Working: a pill with the mission
 * and its progress. Notice: amber counter plus a short card with actions.
 */
function DirectorBubble() {
  const { t } = useTranslation('common');
  const { data: missions = [] } = useMissionList();
  const toggle = useDirectorStore((s) => s.toggle);
  const openMission = useDirectorStore((s) => s.openMission);
  const setView = useDirectorStore((s) => s.setView);
  const dismissed = useDirectorStore((s) => s.dismissed);
  const dismiss = useDirectorStore((s) => s.dismiss);

  const waiting = missions.filter(isWaitingForUser);
  const notice = waiting.find((m) => !dismissed.includes(noticeKey(m)));
  const working = missions.find(
    (m) =>
      m.agent_running ||
      (['planning', 'executing'].includes(m.mission.status) &&
        m.issues_total > 0)
  );
  const label = t('director.open');

  return (
    <div className="fixed bottom-[34px] right-4 z-[80] flex flex-col items-end gap-2">
      {notice && (
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
              if (notice.mission.status === 'brief_ready') setView('expanded');
            }}
            className="self-end rounded-md bg-brand px-2 py-1 text-xs font-medium text-on-brand hover:bg-brand-hover"
          >
            {notice.mission.status === 'brief_ready'
              ? t('director.notice.review')
              : t('director.notice.answer')}
          </button>
        </div>
      )}
      {working && !notice ? (
        <button
          type="button"
          onClick={() => openMission(working.mission.id)}
          aria-label={label}
          title={label}
          className="flex max-w-[320px] flex-col gap-1 rounded-full border border-md-outline-variant bg-primary px-3 py-1.5 text-left shadow-overlay"
        >
          <span className="flex items-center gap-2 text-xs text-normal">
            <span className="text-brand-on-surface">
              <FlukeMark size={12} />
            </span>
            <span className="truncate">
              {[
                missionLabel(working, t('director.newMission')),
                working.agent_running
                  ? t('director.thinking')
                  : t(`director.status.${working.mission.status}`),
                working.issues_total > 0 &&
                  t('director.progress', {
                    done: working.issues_closed,
                    total: working.issues_total,
                  }),
              ]
                .filter(Boolean)
                .join(' · ')}
            </span>
          </span>
          {working.issues_total > 0 && (
            <span className="flex gap-0.5">
              {Array.from({ length: working.issues_total }, (_, i) => (
                <span
                  key={i}
                  className={cn(
                    'h-1 flex-1 rounded-full',
                    i < working.issues_closed ? 'bg-brand' : 'bg-secondary'
                  )}
                />
              ))}
            </span>
          )}
        </button>
      ) : (
        <button
          type="button"
          onClick={toggle}
          aria-label={label}
          title={`${label} (Ctrl Shift I)`}
          className="relative flex size-11 items-center justify-center rounded-full bg-brand text-on-brand shadow-overlay hover:bg-brand-hover"
        >
          <FlukeMark size={18} />
          {waiting.length > 0 && (
            <span className="absolute -right-1 -top-1 flex size-5 items-center justify-center rounded-full bg-warning text-[10px] font-semibold text-warning-foreground">
              {waiting.length}
            </span>
          )}
        </button>
      )}
    </div>
  );
}
