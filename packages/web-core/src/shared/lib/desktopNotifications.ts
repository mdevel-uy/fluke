// Helpers around the browser Notification API. Kept in web-core so both the
// local shell (which fires the alerts) and the settings section (which asks
// for permission on toggle-on) can share the same feature-detection.
//
// Secure-context requirement: `Notification` throws in insecure contexts on
// some browsers (Chrome will show `permission === 'denied'` and refuse to
// prompt; Safari throws). We check `window.isSecureContext` up front so both
// the toggle UI and the fire path degrade the same way.

export function isDesktopNotificationSupported(): boolean {
  if (typeof window === 'undefined') return false;
  if (!('Notification' in window)) return false;
  if (window.isSecureContext === false) return false;
  return true;
}

export function getDesktopNotificationPermission(): NotificationPermission | null {
  if (!isDesktopNotificationSupported()) return null;
  return Notification.permission;
}

export async function requestDesktopNotificationPermission(): Promise<NotificationPermission | null> {
  if (!isDesktopNotificationSupported()) return null;
  if (Notification.permission === 'granted') return 'granted';
  if (Notification.permission === 'denied') return 'denied';
  try {
    return await Notification.requestPermission();
  } catch {
    return null;
  }
}
