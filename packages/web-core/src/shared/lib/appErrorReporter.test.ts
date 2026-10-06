import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeLocalApiRequest } from './localApiTransport';
import { initAppErrorReporter, reportAppError } from './appErrorReporter';

vi.mock('./localApiTransport', () => ({ makeLocalApiRequest: vi.fn() }));

describe('app error reporter', () => {
  beforeEach(() => {
    vi.mocked(makeLocalApiRequest).mockReset();
    vi.mocked(makeLocalApiRequest).mockResolvedValue({ ok: true } as Response);
  });

  it('sends the contract and application frame with React context', async () => {
    const error = new Error('Render failed');
    error.stack =
      'Error: Render failed\n at http://localhost:3000/src/App.tsx:12:3';
    await reportAppError(error, { componentStack: '\n at App' });
    expect(makeLocalApiRequest).toHaveBeenCalledWith(
      '/api/app-errors/report',
      expect.objectContaining({ method: 'POST', hostScope: 'none' })
    );
    expect(
      JSON.parse(
        vi.mocked(makeLocalApiRequest).mock.calls[0][1]!.body as string
      )
    ).toEqual({
      source: 'frontend',
      message: 'Render failed',
      stack: error.stack,
      location: 'at http://localhost:3000/src/App.tsx:12:3',
      component_stack: '\n at App',
    });
  });

  it('drops empty and known noise but keeps informative script errors', async () => {
    for (const error of [
      '',
      'Script error.',
      'ResizeObserver loop completed with undelivered notifications.',
      'ResizeObserver loop limit exceeded',
    ]) {
      await reportAppError(error);
    }
    expect(makeLocalApiRequest).not.toHaveBeenCalled();
    await reportAppError('Script error.', { stack: 'at /src/app.ts:1:1' });
    expect(makeLocalApiRequest).toHaveBeenCalledOnce();
  });

  it('throttles repeats while allowing distinct errors and later counts', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(10_000);
    try {
      await reportAppError('Loop');
      await reportAppError('Loop');
      await reportAppError('Other');
      expect(makeLocalApiRequest).toHaveBeenCalledTimes(2);
      now.mockReturnValue(11_000);
      await reportAppError('Loop');
      expect(makeLocalApiRequest).toHaveBeenCalledTimes(3);
    } finally {
      now.mockRestore();
    }
  });

  it('swallows both synchronous and asynchronous transport failures', async () => {
    vi.mocked(makeLocalApiRequest).mockRejectedValueOnce(new Error('Offline'));
    await expect(reportAppError('Offline report')).resolves.toBeUndefined();
    vi.mocked(makeLocalApiRequest).mockImplementationOnce(() => {
      throw new Error('Transport');
    });
    await expect(reportAppError('Broken transport')).resolves.toBeUndefined();
  });

  it('installs once and captures global errors and rejection reasons', async () => {
    vi.stubGlobal('window', {
      addEventListener: () => {
        throw new Error('Listener setup failed');
      },
      removeEventListener: () => {
        throw new Error('Listener cleanup failed');
      },
    });
    expect(() => initAppErrorReporter()).not.toThrow();
    const listeners = new Map<string, (event: unknown) => void>();
    const addEventListener = vi.fn(
      (name: string, handler: (event: unknown) => void) =>
        listeners.set(name, handler)
    );
    vi.stubGlobal('window', { addEventListener });
    try {
      initAppErrorReporter();
      initAppErrorReporter();
      expect(addEventListener).toHaveBeenCalledTimes(2);
      listeners.get('error')!({
        message: 'Timer failed',
        filename: '/src/timer.ts',
        lineno: 1,
        colno: 2,
      });
      listeners.get('unhandledrejection')!({ reason: 'Promise failed' });
      await Promise.resolve();
      expect(makeLocalApiRequest).toHaveBeenCalledTimes(2);
      const payloads = vi
        .mocked(makeLocalApiRequest)
        .mock.calls.map(([, options]) => JSON.parse(options!.body as string));
      expect(payloads[0]).toMatchObject({
        message: 'Timer failed',
        location: '/src/timer.ts:1:2',
        stack: null,
        component_stack: null,
      });
      expect(payloads[1]).toMatchObject({
        message: 'Promise failed',
        location: null,
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
