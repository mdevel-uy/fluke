import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { reportAppError } from '@/shared/lib/appErrorReporter';
import { setLocalApiTransport } from '@/shared/lib/localApiTransport';
import {
  useDirectorStore,
  type AppErrorNotice,
} from '../model/useDirectorStore';
import {
  ignoreAppError,
  loadAppErrorsSnapshot,
  useLocalAppErrorsStore,
} from '../model/useAppErrorsLive';
import {
  AppErrorBubbles,
  AppErrorNotifications,
  CrashAppErrorBubbles,
} from './AppErrorBubbles';

const runtime = vi.hoisted(() => ({
  hostId: 'remote-host' as string | null,
  cleanups: [] as (() => void)[],
}));
vi.mock('@/shared/providers/HostIdProvider', () => ({
  useHostId: () => runtime.hostId,
  getCurrentHostId: () => runtime.hostId,
}));
// Render the current subscribed snapshot without introducing a DOM dependency.
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) =>
    snapshot(),
  useEffect: (effect: () => void | (() => void)) => {
    const cleanup = effect();
    if (cleanup) runtime.cleanups.push(cleanup);
  },
}));
vi.mock('react-dom', () => ({ createPortal: (children: unknown) => children }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

afterEach(() => {
  runtime.cleanups.splice(0).forEach((cleanup) => cleanup());
  runtime.hostId = 'remote-host';
  setLocalApiTransport(null);
  for (const store of [useDirectorStore, useLocalAppErrorsStore]) {
    store.setState({ appErrors: [], ignoredErrors: [], errorSession: null });
  }
  vi.unstubAllGlobals();
});

describe('local UI notices alongside a remote host', () => {
  it('reports, displays both owners, and ignores only the owning backend, including after a crash', async () => {
    vi.stubGlobal('document', { body: {} });
    const fingerprint = 'fp-0123456789ab';
    const remoteError: AppErrorNotice = {
      fingerprint,
      message: 'Remote database failed',
      source: 'backend',
      location: 'db.rs:1',
      count: 1,
      first_seen: 1,
      last_seen: 1,
    };
    let localError: AppErrorNotice | undefined;
    let failLocalPoll = false;
    const request = vi.fn(async (path: string, options?: RequestInit) => {
      if (path === '/api/app-errors/report') {
        const body = JSON.parse(options!.body as string);
        localError = {
          ...remoteError,
          message: body.message,
          source: body.source,
        };
        return new Response(null, { status: 204 });
      }
      if (path.endsWith('/ignore')) return new Response(null, { status: 204 });
      const local = path === '/api/app-errors';
      if (local && failLocalPoll) return new Response(null, { status: 503 });
      return Response.json({
        session_id: local ? 'local-session' : 'remote-session',
        errors: local ? (localError ? [localError] : []) : [remoteError],
      });
    });
    setLocalApiTransport({
      request,
      openWebSocket: () => {
        throw new Error('Unexpected socket');
      },
    });
    const signal = new AbortController().signal;
    await reportAppError('UI handler failed on remote page');
    renderToStaticMarkup(createElement(AppErrorNotifications));
    await vi.waitFor(() => {
      expect(useLocalAppErrorsStore.getState().appErrors).toHaveLength(1);
      expect(useDirectorStore.getState().appErrors).toHaveLength(1);
    });
    const render = () => renderToStaticMarkup(createElement(AppErrorBubbles));
    expect(render()).toContain('UI handler failed on remote page');
    expect(render()).toContain('Remote database failed');
    expect(request).toHaveBeenCalledWith(
      '/api/app-errors/report',
      expect.objectContaining({ hostScope: 'none' })
    );

    failLocalPoll = true;
    await expect(
      loadAppErrorsSnapshot(null, signal, 'local')
    ).rejects.toThrow();
    expect(render()).toContain('Remote database failed');
    expect(render()).toContain('UI handler failed on remote page');
    failLocalPoll = false;

    // The host provider unmounts at a crash. The fallback retains local notices
    // and restarts the same local subscription, independent of that provider.
    runtime.cleanups.splice(0).forEach((cleanup) => cleanup());
    runtime.hostId = null;
    const fallback = () =>
      renderToStaticMarkup(createElement(CrashAppErrorBubbles));
    expect(fallback()).toContain('UI handler failed on remote page');
    expect(fallback()).not.toContain('Remote database failed');
    ignoreAppError(fingerprint, 'local');
    expect(request).toHaveBeenLastCalledWith(
      `/api/app-errors/${fingerprint}/ignore`,
      expect.objectContaining({ hostId: null })
    );
    expect(fallback()).not.toContain('UI handler failed on remote page');
    await loadAppErrorsSnapshot(null, signal, 'local');
    expect(fallback()).not.toContain('UI handler failed on remote page');

    runtime.hostId = 'remote-host';
    expect(render()).toContain('Remote database failed');
    ignoreAppError(fingerprint);
    expect(request).toHaveBeenLastCalledWith(
      `/api/host/remote-host/app-errors/${fingerprint}/ignore`,
      expect.objectContaining({ hostId: 'remote-host' })
    );
    expect(render()).not.toContain('Remote database failed');
  });
});
