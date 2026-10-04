import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { makeLocalApiRequest } from '@/shared/lib/localApiTransport';
import { missionKeys } from './useMissions';

const RECONNECT_MS = 2_000;
const REFRESH_DEBOUNCE_MS = 150;

/**
 * Fluke's views update when something happens, not on a timer (J6.1): the
 * server pushes every domain event (`/api/fluke-events/stream`) and each
 * one refreshes the missions. Goes through the app's API transport, so it
 * works wherever the API does; reconnects on its own and catches up then.
 */
export function useFlukeEventsLive() {
  const queryClient = useQueryClient();

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();

    const refresh = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        void queryClient.invalidateQueries({ queryKey: missionKeys.all });
      }, REFRESH_DEBOUNCE_MS);
    };

    const listen = async () => {
      while (!stopped) {
        try {
          const response = await makeLocalApiRequest(
            '/api/fluke-events/stream',
            {
              headers: { Accept: 'text/event-stream' },
              signal: controller.signal,
            }
          );
          if (!response.ok || !response.body) throw new Error('no stream');
          // Connected (or back): whatever happened meanwhile is in the API.
          refresh();
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const events = buffer.split('\n\n');
            buffer = events.pop() ?? '';
            if (events.some((e) => e.includes('event: fluke'))) refresh();
          }
        } catch {
          // Aborted on unmount, or the server restarted: retry below.
        }
        if (!stopped) {
          await new Promise((r) => setTimeout(r, RECONNECT_MS));
        }
      }
    };
    void listen();

    return () => {
      stopped = true;
      clearTimeout(timer);
      controller.abort();
    };
  }, [queryClient]);
}
