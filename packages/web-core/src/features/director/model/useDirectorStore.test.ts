import { beforeEach, describe, expect, it } from 'vitest';
import { type AppErrorNotice, useDirectorStore } from './useDirectorStore';

const notice: AppErrorNotice = {
  fingerprint: 'fp-0123456789ab',
  message: 'Database unavailable',
  source: 'backend',
  location: 'server file.rs:12',
  count: 1,
  first_seen: 1,
  last_seen: 1,
};

describe('app error notices', () => {
  beforeEach(() =>
    useDirectorStore.setState({
      appErrors: [],
      ignoredErrors: [],
      errorSession: null,
    })
  );

  it('updates counts and keeps dismissed errors hidden across reconnects', () => {
    const store = useDirectorStore.getState();
    store.setAppErrors('session-a', [notice]);
    store.ignoreAppError(notice.fingerprint);
    store.setAppErrors('session-a', [{ ...notice, count: 4 }]);
    expect(useDirectorStore.getState().appErrors[0].count).toBe(4);
    expect(useDirectorStore.getState().ignoredErrors).toContain(
      notice.fingerprint
    );
    store.setAppErrors('session-b', [notice]);
    expect(useDirectorStore.getState().ignoredErrors).toEqual([]);
  });
});
