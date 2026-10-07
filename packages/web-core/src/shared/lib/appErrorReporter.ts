import { makeLocalApiRequest } from './localApiTransport';

type ErrorDetails = {
  stack?: string | null;
  location?: string | null;
  componentStack?: string | null;
};

// Bound memory as well as traffic during an error loop. The backend owns the
// session fingerprint and count; throttled occurrences are not counted.
const lastReports = new Map<string, number>();
let installed = false;

export async function reportAppError(
  error: unknown,
  details: ErrorDetails = {}
) {
  try {
    const message = (
      error instanceof Error ? error.message : String(error)
    ).trim();
    const stack =
      details.stack ?? (error instanceof Error ? error.stack : null);
    if (
      !message ||
      (message === 'Script error.' && !stack) ||
      /^ResizeObserver loop (completed with undelivered notifications\.?|limit exceeded)$/.test(
        message
      )
    )
      return;

    // Use the same application frame for global and boundary reports.
    const location =
      stack
        ?.split('\n')
        .find((line) => line.includes('/src/') || line.includes('/assets/'))
        ?.trim() ??
      details.location ??
      null;
    // Conservative character limits also fit the backend's UTF-8 byte limits.
    const payload = {
      source: 'frontend',
      message: message.slice(0, 1024),
      stack: stack?.slice(0, 2048) || null,
      location: location?.slice(0, 1024) || null,
      component_stack: details.componentStack?.slice(0, 2048) || null,
    };
    const key = JSON.stringify([payload.message, payload.location]);
    const now = Date.now();
    const previous = lastReports.get(key);
    if (previous !== undefined && now - previous < 1_000) return;
    lastReports.delete(key);
    lastReports.set(key, now);
    if (lastReports.size > 100)
      lastReports.delete(lastReports.keys().next().value!);
    await makeLocalApiRequest('/api/app-errors/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      // UI crashes belong to this installation, even on a remote-host route.
      hostScope: 'none',
      signal: AbortSignal.timeout(4_000),
    });
  } catch {
    // Reporting must never break startup or recursively report transport errors.
  }
}

export function initAppErrorReporter() {
  if (installed) return;
  const onError = (event: ErrorEvent) => {
    if (!event.message) return; // Resource loading events have no JS error.
    void reportAppError(event.error ?? event.message, {
      location: event.filename
        ? `${event.filename}:${event.lineno}:${event.colno}`
        : null,
    });
  };
  const onRejection = (event: PromiseRejectionEvent) => {
    void reportAppError(event.reason);
  };
  try {
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);
    installed = true;
  } catch {
    try {
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onRejection);
    } catch {
      // Even a partially initialized listener must not prevent startup.
    }
  }
}
