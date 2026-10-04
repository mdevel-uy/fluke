import { describe, it, expect } from 'vitest';
import {
  DEFAULT_GITHUB_VISIBILITY,
  canConfirmGithubPublish,
  classifyGithubPublishError,
  getGithubPublishBlocker,
  initialGithubPublishState,
  isValidGithubRepoName,
  pickDefaultOwner,
  resolveGithubRepoName,
  suggestGithubRepoName,
  toPublishRequest,
  type GithubOwner,
  type GithubPublishContext,
} from './githubPublish';

const owners: GithubOwner[] = [
  { login: 'octocat', kind: 'user' },
  { login: 'acme', kind: 'organization' },
];

const signedIn: GithubPublishContext = {
  authenticated: true,
  owners,
  fallbackName: 'my-project',
};

describe('initialGithubPublishState', () => {
  it('starts unchecked, private and without owner or name', () => {
    expect(initialGithubPublishState()).toEqual({
      enabled: false,
      owner: '',
      name: '',
      visibility: 'private',
    });
    expect(DEFAULT_GITHUB_VISIBILITY).toBe('private');
  });
});

describe('pickDefaultOwner', () => {
  it('prefers the user account', () => {
    expect(pickDefaultOwner([...owners].reverse(), '')).toBe('octocat');
  });
  it('keeps the current choice while it is still available', () => {
    expect(pickDefaultOwner(owners, 'acme')).toBe('acme');
    expect(pickDefaultOwner(owners, 'gone')).toBe('octocat');
  });
  it('falls back to the first owner, or empty when there are none', () => {
    expect(
      pickDefaultOwner([{ login: 'acme', kind: 'organization' }], '')
    ).toBe('acme');
    expect(pickDefaultOwner([], '')).toBe('');
  });
});

describe('repository name', () => {
  it('validates like GitHub does', () => {
    expect(isValidGithubRepoName('my-project')).toBe(true);
    expect(isValidGithubRepoName('a.b_c-1')).toBe(true);
    expect(isValidGithubRepoName('')).toBe(false);
    expect(isValidGithubRepoName('.')).toBe(false);
    expect(isValidGithubRepoName('..')).toBe(false);
    expect(isValidGithubRepoName('has space')).toBe(false);
    expect(isValidGithubRepoName('x'.repeat(101))).toBe(false);
  });
  it('suggests a name from the folder or path', () => {
    expect(suggestGithubRepoName('/home/me/My Project')).toBe('My-Project');
    expect(suggestGithubRepoName('C:\\dev\\api_v2\\')).toBe('api_v2');
    expect(suggestGithubRepoName('  ')).toBe('');
  });
  it('uses the typed name, else the suggestion', () => {
    const state = { ...initialGithubPublishState(), enabled: true };
    expect(resolveGithubRepoName(state, '/a/b/folder')).toBe('folder');
    expect(resolveGithubRepoName({ ...state, name: ' other ' }, 'x')).toBe(
      'other'
    );
  });
});

describe('confirm readiness', () => {
  const enabled = {
    ...initialGithubPublishState(),
    enabled: true,
    owner: 'octocat',
  };

  it('never blocks when the option is off', () => {
    const off = initialGithubPublishState();
    expect(
      getGithubPublishBlocker(off, { ...signedIn, authenticated: false })
    ).toBeNull();
    expect(
      canConfirmGithubPublish(off, { ...signedIn, owners: undefined })
    ).toBe(true);
  });
  it('blocks while the session is unknown or missing', () => {
    expect(
      getGithubPublishBlocker(enabled, {
        ...signedIn,
        authenticated: undefined,
      })
    ).toBe('session_unknown');
    expect(
      getGithubPublishBlocker(enabled, { ...signedIn, authenticated: false })
    ).toBe('no_session');
  });
  it('blocks without a selected, available owner', () => {
    expect(getGithubPublishBlocker({ ...enabled, owner: '' }, signedIn)).toBe(
      'no_owner'
    );
    expect(
      getGithubPublishBlocker(enabled, { ...signedIn, owners: undefined })
    ).toBe('no_owner');
    expect(
      getGithubPublishBlocker({ ...enabled, owner: 'gone' }, signedIn)
    ).toBe('no_owner');
  });
  it('blocks with an invalid name', () => {
    expect(
      getGithubPublishBlocker({ ...enabled, name: 'bad name' }, signedIn)
    ).toBe('invalid_name');
    expect(
      getGithubPublishBlocker(enabled, { ...signedIn, fallbackName: '' })
    ).toBe('invalid_name');
  });
  it('allows confirming when everything is set', () => {
    expect(canConfirmGithubPublish(enabled, signedIn)).toBe(true);
  });
});

describe('toPublishRequest', () => {
  it('maps the form to the API body', () => {
    expect(
      toPublishRequest(
        {
          enabled: true,
          owner: 'acme',
          name: '',
          visibility: 'public',
        },
        '/repos/tool'
      )
    ).toEqual({ owner: 'acme', name: 'tool', visibility: 'public' });
  });
});

describe('classifyGithubPublishError', () => {
  const err = (status: number, message: string) =>
    Object.assign(new Error(message), { status });

  it('maps the backend errors to distinguishable kinds', () => {
    expect(
      classifyGithubPublishError(
        err(400, 'No GitHub session: log in to GitHub in Settings > GitHub')
      )
    ).toBe('no_session');
    expect(classifyGithubPublishError(err(401, 'Unauthorized'))).toBe(
      'no_session'
    );
    expect(
      classifyGithubPublishError(
        err(409, 'A repository named a/b already exists on GitHub.')
      )
    ).toBe('name_taken');
    expect(
      classifyGithubPublishError(
        err(409, 'The local repository already has an origin remote (x).')
      )
    ).toBe('origin_exists');
    expect(
      classifyGithubPublishError(
        err(403, 'Your GitHub session is not allowed to create repositories')
      )
    ).toBe('forbidden');
    expect(
      classifyGithubPublishError(
        err(400, "GitHub owner 'x' is not available for this session")
      )
    ).toBe('owner_unavailable');
    expect(
      classifyGithubPublishError(
        err(400, "Invalid GitHub repository name 'a b'")
      )
    ).toBe('invalid_name');
    expect(
      classifyGithubPublishError(
        err(400, 'The local repository has no commits yet')
      )
    ).toBe('no_commits');
    expect(
      classifyGithubPublishError(
        err(502, 'The repository was created on GitHub (u) but publishing')
      )
    ).toBe('incomplete');
  });
  it('falls back to other for anything else', () => {
    expect(classifyGithubPublishError(err(502, 'GitHub request failed'))).toBe(
      'other'
    );
    expect(classifyGithubPublishError('boom')).toBe('other');
  });
});
