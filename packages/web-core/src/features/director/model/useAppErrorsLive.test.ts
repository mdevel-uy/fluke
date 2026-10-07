import { afterEach, describe, expect, it, vi } from 'vitest';
import { setLocalApiTransport } from '@/shared/lib/localApiTransport';
import { loadAppErrorsSnapshot } from './useAppErrorsLive';
import { useDirectorStore } from './useDirectorStore';

afterEach(() => {
  setLocalApiTransport(null);
  useDirectorStore.setState({
    appErrors: [],
    ignoredErrors: [],
    errorSession: null,
  });
});

describe('finite app error snapshots', () => {
  it.each([null, 'relay-host'])(
    'delivers initial errors and updates for host %s',
    async (hostId) => {
      let count = 1;
      const request = vi.fn(async () => {
        const response = Response.json({
          session_id: 'session-a',
          errors: [
            {
              fingerprint: 'fp-0123456789ab',
              message: 'Database unavailable',
              source: 'api',
              location: '/sessions 500',
              count,
              first_seen: 1,
              last_seen: count,
            },
          ],
        });
        if (!hostId) return response;
        // Relay signing and WebRTC serialize the complete body before returning
        // a response. This must end for both the first delivery and each update.
        const body = await response.arrayBuffer();
        return new Response(body, { headers: response.headers });
      });
      setLocalApiTransport({
        request,
        openWebSocket: () => {
          throw new Error('Unexpected WebSocket');
        },
      });
      const controller = new AbortController();
      await loadAppErrorsSnapshot(hostId, controller.signal);
      expect(useDirectorStore.getState().appErrors[0].count).toBe(1);
      count = 120;
      await loadAppErrorsSnapshot(hostId, controller.signal);
      expect(useDirectorStore.getState().appErrors[0].count).toBe(120);
      expect(request).toHaveBeenLastCalledWith(
        hostId ? '/api/host/relay-host/app-errors' : '/api/app-errors',
        expect.objectContaining({
          hostScope: 'explicit',
          hostId,
          headers: { Accept: 'application/json' },
        })
      );
    }
  );

  it('keeps the last notices after a failed poll and ignores an aborted response', async () => {
    const controller = new AbortController();
    useDirectorStore.setState({ errorSession: 'session-before' });
    setLocalApiTransport({
      request: async () => new Response(null, { status: 503 }),
      openWebSocket: () => {
        throw new Error('Unexpected WebSocket');
      },
    });
    await expect(
      loadAppErrorsSnapshot(null, controller.signal)
    ).rejects.toThrow('No error snapshot');
    expect(useDirectorStore.getState().errorSession).toBe('session-before');
    setLocalApiTransport({
      request: async () => {
        controller.abort();
        return Response.json({ session_id: 'stale-session', errors: [] });
      },
      openWebSocket: () => {
        throw new Error('Unexpected WebSocket');
      },
    });
    await loadAppErrorsSnapshot(null, controller.signal);
    expect(useDirectorStore.getState().errorSession).toBe('session-before');
  });
});
