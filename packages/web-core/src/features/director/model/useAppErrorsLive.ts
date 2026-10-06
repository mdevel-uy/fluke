import { useEffect } from 'react';
import { makeLocalApiRequest } from '@/shared/lib/localApiTransport';
import { getCurrentHostId, useHostId } from '@/shared/providers/HostIdProvider';
import { type AppErrorNotice, useDirectorStore } from './useDirectorStore';

/** Poll finite snapshots: relay signing and WebRTC buffer whole responses,
 * so an infinite SSE body would never reach their receiver. */
export function useAppErrorsLive() {
  const hostId = useHostId();
  useEffect(() => {
    useDirectorStore.setState({
      appErrors: [],
      ignoredErrors: [],
      errorSession: null,
    });
    const controller = new AbortController();
    let retry: ReturnType<typeof setTimeout> | undefined;
    const dismissalRetry = setInterval(() => {
      const { appErrors, ignoredErrors } = useDirectorStore.getState();
      for (const error of appErrors) {
        if (ignoredErrors.includes(error.fingerprint))
          void sendIgnore(error.fingerprint, hostId, controller.signal);
      }
    }, 2_000);
    const poll = async () => {
      try {
        await loadAppErrorsSnapshot(hostId, controller.signal);
      } catch {
        // Transport failures are never reported by the reporter itself.
        // The next finite snapshot catches up from the session store.
      }
      if (!controller.signal.aborted)
        retry = setTimeout(() => void poll(), 1_000);
    };
    void poll();
    return () => {
      clearTimeout(retry);
      clearInterval(dismissalRetry);
      controller.abort();
    };
  }, [hostId]);
}

export async function loadAppErrorsSnapshot(
  hostId: string | null,
  signal: AbortSignal
) {
  const request = new AbortController();
  const abort = () => request.abort();
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) request.abort();
  const timeout = setTimeout(abort, 4_000);
  try {
    const response = await makeLocalApiRequest('/api/app-errors', {
      headers: { Accept: 'application/json' },
      hostScope: 'explicit',
      hostId,
      signal: request.signal,
      cache: 'no-store',
    });
    if (!response.ok) throw new Error('No error snapshot');
    const snapshot = (await response.json()) as {
      session_id: string;
      errors: AppErrorNotice[];
    };
    if (
      typeof snapshot?.session_id !== 'string' ||
      !Array.isArray(snapshot.errors) ||
      !snapshot.errors.every(
        (error) =>
          typeof error?.fingerprint === 'string' &&
          /^fp-[0-9a-f]{12}$/.test(error.fingerprint) &&
          typeof error.message === 'string' &&
          Number.isSafeInteger(error.count) &&
          error.count > 0
      )
    )
      throw new Error('Invalid error snapshot');
    if (!request.signal.aborted)
      useDirectorStore
        .getState()
        .setAppErrors(snapshot.session_id, snapshot.errors.slice(0, 50));
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener('abort', abort);
  }
}

async function sendIgnore(
  fingerprint: string,
  hostId: string | null,
  signal?: AbortSignal
) {
  try {
    await makeLocalApiRequest(
      `/api/app-errors/${encodeURIComponent(fingerprint)}/ignore`,
      { method: 'POST', signal, hostScope: 'explicit', hostId }
    );
  } catch {
    // The local dismissal hides it immediately; the live hook retries delivery.
  }
}

export function ignoreAppError(fingerprint: string) {
  useDirectorStore.getState().ignoreAppError(fingerprint);
  void sendIgnore(fingerprint, getCurrentHostId());
}
