import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useHostId } from '@/shared/providers/HostIdProvider';
import { useWorkspaces } from '@/shared/hooks/useWorkspaces';
import { useWorkers } from '@/features/workers/model/useWorkers';
import { useAllWorkerTasks } from '@/features/sprint/model/useWorkers';
import {
  useWorkerTaskIndex,
  withWorkerTaskInfo,
} from '@/features/workers/model/workerTaskInfo';
import type { SidebarWorkspace } from '@/shared/hooks/useWorkspaces';
import { useDesktopAlertsEnabled } from '@/shared/stores/useUiPreferencesStore';
import { showSystemNotification } from '@web/app/notifications/showSystemNotification';

type SnapshotEntry = {
  latestProcessStatus?: SidebarWorkspace['latestProcessStatus'];
  hasTaskInReview: boolean;
};

const MAX_NOTIFICATIONS_PER_TICK = 3;

function buildDeeplinkPath(hostId: string | null, workspaceId: string): string {
  return hostId
    ? `/hosts/${hostId}/workspaces/${workspaceId}`
    : `/workspaces/${workspaceId}`;
}

function workspaceLabel(ws: SidebarWorkspace): string {
  return ws.taskTitle || ws.workerName || ws.name || ws.branch;
}

/**
 * Observes local workspace state transitions and fires desktop notifications
 * for the events defined in issue #532:
 *  - `latestProcessStatus` -> `completed`     ("Task finished")
 *  - `latestProcessStatus` -> `failed`/`killed` ("Task failed")
 *  - `hasTaskInReview` false -> true          ("Awaiting approval")
 *
 * The initial snapshot (and any reconnection snapshot) is treated as the
 * baseline: nothing fires until we see a *change* from it. This matches the
 * `initializedRef` pattern used by `AppSystemNotifications`, and prevents a
 * reconnection burst from spamming the user.
 */
export function LocalTaskNotifications() {
  const { t } = useTranslation('common');
  const hostId = useHostId();
  const [desktopAlertsEnabled] = useDesktopAlertsEnabled();

  const { workspaces, isLoading, isConnected } = useWorkspaces();
  const { data: workers } = useWorkers();
  const { tasks: workerTasks, isLoading: tasksLoading } = useAllWorkerTasks(
    workers ?? []
  );
  const workerTaskIndex = useWorkerTaskIndex(workers, workerTasks);

  const previousSnapshotRef = useRef<Map<string, SnapshotEntry> | null>(null);
  const wasConnectedRef = useRef(false);

  useEffect(() => {
    if (!desktopAlertsEnabled) {
      previousSnapshotRef.current = null;
      wasConnectedRef.current = isConnected;
      return;
    }
    if (isLoading || tasksLoading) {
      return;
    }

    const enriched = withWorkerTaskInfo(workspaces, workerTaskIndex);
    const nextSnapshot = new Map<string, SnapshotEntry>();
    for (const ws of enriched) {
      // Archived workspaces are past-tense: don't notify on transitions in
      // them (e.g. a delayed status update after archival should stay quiet).
      if (ws.isArchived) continue;
      nextSnapshot.set(ws.id, {
        latestProcessStatus: ws.latestProcessStatus,
        hasTaskInReview: !!ws.hasTaskInReview,
      });
    }

    const previous = previousSnapshotRef.current;
    // First tick after opt-in *or* after a WS reconnection: adopt the current
    // state as the baseline without notifying — this is the sad-path guard
    // called out in the issue (reconnection may replay dozens of updates).
    const reconnected = !wasConnectedRef.current && isConnected;
    if (!previous || reconnected) {
      previousSnapshotRef.current = nextSnapshot;
      wasConnectedRef.current = isConnected;
      return;
    }

    let fired = 0;
    for (const ws of enriched) {
      if (fired >= MAX_NOTIFICATIONS_PER_TICK) break;
      if (ws.isArchived) continue;

      const prev = previous.get(ws.id);
      if (!prev) {
        // Brand-new workspace this tick — don't retroactively notify on its
        // initial status; it becomes part of the baseline.
        continue;
      }

      const deeplinkPath = buildDeeplinkPath(hostId, ws.id);
      const label = workspaceLabel(ws);

      const status = ws.latestProcessStatus;
      const statusChanged = status !== prev.latestProcessStatus;
      if (statusChanged && status === 'completed') {
        void showSystemNotification({
          id: `local-task-completed-${ws.id}`,
          title: t('desktopAlerts.taskCompleted.title'),
          body: t('desktopAlerts.taskCompleted.body', { name: label }),
          deeplinkPath,
        });
        fired += 1;
      } else if (
        statusChanged &&
        (status === 'failed' || status === 'killed')
      ) {
        void showSystemNotification({
          id: `local-task-failed-${ws.id}`,
          title: t('desktopAlerts.taskFailed.title'),
          body: t('desktopAlerts.taskFailed.body', { name: label }),
          deeplinkPath,
        });
        fired += 1;
      }

      if (
        !!ws.hasTaskInReview &&
        !prev.hasTaskInReview &&
        fired < MAX_NOTIFICATIONS_PER_TICK
      ) {
        void showSystemNotification({
          id: `local-task-in-review-${ws.id}`,
          title: t('desktopAlerts.awaitingApproval.title'),
          body: t('desktopAlerts.awaitingApproval.body', { name: label }),
          deeplinkPath,
        });
        fired += 1;
      }
    }

    previousSnapshotRef.current = nextSnapshot;
    wasConnectedRef.current = isConnected;
  }, [
    desktopAlertsEnabled,
    hostId,
    isConnected,
    isLoading,
    tasksLoading,
    workspaces,
    workerTaskIndex,
    t,
  ]);

  return null;
}
