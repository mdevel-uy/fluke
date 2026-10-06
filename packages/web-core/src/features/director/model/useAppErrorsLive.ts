import { useEffect } from 'react';
import { makeLocalApiRequest } from '@/shared/lib/localApiTransport';
import { getCurrentHostId, useHostId } from '@/shared/providers/HostIdProvider';
import { type AppErrorNotice, useDirectorStore } from './useDirectorStore';

/** Summary snapshots, replayed on every reconnect; never report transport
 * failures here (that would recursively report failures of the reporter). */
export function useAppErrorsLive() {
  const hostId = useHostId();
  useEffect(() => {
    useDirectorStore.setState({
      appErrors: [],
      ignoredErrors: [],
      errorSession: null,
    });
    const controller = new AbortController();
    let stopped = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const dismissalRetry = setInterval(() => {
      const { appErrors, ignoredErrors } = useDirectorStore.getState();
      for (const error of appErrors) {
        if (ignoredErrors.includes(error.fingerprint))
          void sendIgnore(error.fingerprint, hostId, controller.signal);
      }
    }, 2_000);
    const listen = async () => {
      try {
        const response = await makeLocalApiRequest('/api/app-errors/stream', {
          headers: { Accept: 'text/event-stream' },
          hostScope: 'explicit',
          hostId,
          signal: controller.signal,
        });
        if (!response.ok || !response.body) throw new Error('No error stream');
        const reader = response.body.getReader();
        try {
          const decoder = new TextDecoder();
          let buffer = '';
          while (!stopped) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder
              .decode(value, { stream: true })
              .replace(/\r\n/g, '\n');
            const frames = buffer.split('\n\n');
            buffer = frames.pop() ?? '';
            for (const frame of frames) {
              if (!frame.includes('event: app-errors')) continue;
              const data = frame
                .split('\n')
                .filter((line) => line.startsWith('data:'))
                .map((line) => line.slice(5).trimStart())
                .join('\n');
              const snapshot = JSON.parse(data) as {
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
                continue;
              if (stopped) break;
              useDirectorStore
                .getState()
                .setAppErrors(
                  snapshot.session_id,
                  snapshot.errors.slice(0, 50)
                );
            }
          }
        } finally {
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
      } catch {
        // Reconnect catches up from the backend's bounded session store.
      }
      if (!stopped) retry = setTimeout(() => void listen(), 2_000);
    };
    void listen();
    return () => {
      stopped = true;
      clearTimeout(retry);
      clearInterval(dismissalRetry);
      controller.abort();
    };
  }, [hostId]);
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
