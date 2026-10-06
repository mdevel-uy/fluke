import { invoke } from '@tauri-apps/api/core';
import { isTauriApp } from '@/shared/lib/platform';
import { isDesktopNotificationSupported } from '@/shared/lib/desktopNotifications';
import { useUiPreferencesStore } from '@/shared/stores/useUiPreferencesStore';
import { router } from '@web/app/router';

interface NotificationPayload {
  id: string;
  title: string;
  body: string;
  deeplinkPath?: string;
}

function showWebNotification(payload: NotificationPayload): void {
  if (!isDesktopNotificationSupported()) return;
  if (Notification.permission !== 'granted') return;
  // Respect the user's opt-in even if permission is still granted — revoking
  // via the toggle should stop new alerts without waiting on the browser.
  if (!useUiPreferencesStore.getState().desktopAlertsEnabled) return;

  try {
    const notification = new Notification(payload.title, {
      body: payload.body,
      tag: payload.id,
      // The backend plays the sound when the user is needed.
      silent: true,
    });
    notification.onclick = () => {
      try {
        window.focus();
      } catch {
        // window.focus() can throw in sandboxed contexts; ignore.
      }
      if (payload.deeplinkPath) {
        router.navigate({ to: payload.deeplinkPath as '/' });
      }
      notification.close();
    };
  } catch {
    // Notification construction can fail (permission revoked mid-session,
    // quota exceeded, etc.). Degrade silently — the app must never crash on
    // a best-effort alert.
  }
}

export async function showSystemNotification(
  notification: NotificationPayload
): Promise<void> {
  if (isTauriApp()) {
    try {
      await invoke('show_system_notification', {
        title: notification.title,
        body: notification.body,
        deeplinkPath: notification.deeplinkPath,
      });
    } catch (error) {
      console.error(
        `Failed to show system notification for group ${notification.id}:`,
        error
      );
    }
    return;
  }

  showWebNotification(notification);
}
