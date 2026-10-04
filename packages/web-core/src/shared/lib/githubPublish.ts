// Form logic for "Create on GitHub too" when initializing or registering a
// local repo. Kept free of React and of the API client so it can be unit
// tested on its own.

// Local shims mirroring the structs added by #774 in
// crates/server/src/routes/{github,repo}.rs and
// crates/services/src/services/repo.rs. Replaced by the generated types when
// infra runs `pnpm run generate-types`.
export type RepoVisibility = 'public' | 'private';
export type GithubOwnerKind = 'user' | 'organization';

export interface GithubOwner {
  login: string;
  kind: GithubOwnerKind;
}

/** Body of `POST /api/repos/{repo_id}/github`. */
export interface PublishRepoToGithubRequest {
  owner: string;
  name: string;
  visibility: RepoVisibility;
}

/** Response of `POST /api/repos/{repo_id}/github`. */
export interface PublishRepoToGithubResponse {
  url: string;
  owner: string;
  name: string;
  branch: string;
}

/**
 * GitHub calls the option needs, bound to the machine the repo lives on
 * (the local backend, or the host selected in Settings).
 */
export interface GithubPublishClient {
  /** Distinguishes the react-query cache per machine. */
  queryScopeKey: readonly unknown[];
  getStatus: () => Promise<{ authenticated: boolean; username: string | null }>;
  listOwners: () => Promise<GithubOwner[]>;
  publish: (
    repoId: string,
    request: PublishRepoToGithubRequest
  ) => Promise<PublishRepoToGithubResponse>;
}

export interface GithubPublishFormState {
  enabled: boolean;
  owner: string;
  /** Empty means "use the name suggested from the local folder". */
  name: string;
  visibility: RepoVisibility;
}

export const DEFAULT_GITHUB_VISIBILITY: RepoVisibility = 'private';

export function initialGithubPublishState(): GithubPublishFormState {
  return {
    enabled: false,
    owner: '',
    name: '',
    visibility: DEFAULT_GITHUB_VISIBILITY,
  };
}

/** Keeps `current` while available; otherwise the user, else the first. */
export function pickDefaultOwner(
  owners: GithubOwner[],
  current: string
): string {
  if (current && owners.some((o) => o.login === current)) return current;
  const user = owners.find((o) => o.kind === 'user');
  return user?.login ?? owners[0]?.login ?? '';
}

const GITHUB_REPO_NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;

export function isValidGithubRepoName(name: string): boolean {
  return GITHUB_REPO_NAME_RE.test(name) && name !== '.' && name !== '..';
}

/** Last segment of a path (or a folder name) turned into a valid name. */
export function suggestGithubRepoName(source: string): string {
  const segment =
    source
      .trim()
      .split(/[\\/]+/)
      .filter(Boolean)
      .pop() ?? '';
  return segment
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100);
}

export function resolveGithubRepoName(
  state: GithubPublishFormState,
  fallbackSource: string
): string {
  return state.name.trim() || suggestGithubRepoName(fallbackSource);
}

export interface GithubPublishContext {
  /** `undefined` while the session status is loading. */
  authenticated: boolean | undefined;
  /** `undefined` while the owners are loading or failed to load. */
  owners: GithubOwner[] | undefined;
  /** Folder name or path the default repository name comes from. */
  fallbackName: string;
}

export type GithubPublishBlocker =
  | 'session_unknown'
  | 'no_session'
  | 'no_owner'
  | 'invalid_name';

/** Why the confirm button must stay disabled, or `null` when it can go. */
export function getGithubPublishBlocker(
  state: GithubPublishFormState,
  ctx: GithubPublishContext
): GithubPublishBlocker | null {
  if (!state.enabled) return null;
  if (ctx.authenticated === undefined) return 'session_unknown';
  if (!ctx.authenticated) return 'no_session';
  if (!state.owner || !ctx.owners?.some((o) => o.login === state.owner)) {
    return 'no_owner';
  }
  if (!isValidGithubRepoName(resolveGithubRepoName(state, ctx.fallbackName))) {
    return 'invalid_name';
  }
  return null;
}

export function canConfirmGithubPublish(
  state: GithubPublishFormState,
  ctx: GithubPublishContext
): boolean {
  return getGithubPublishBlocker(state, ctx) === null;
}

export function toPublishRequest(
  state: GithubPublishFormState,
  fallbackSource: string
): PublishRepoToGithubRequest {
  return {
    owner: state.owner,
    name: resolveGithubRepoName(state, fallbackSource),
    visibility: state.visibility,
  };
}

export type GithubPublishErrorKind =
  | 'no_session'
  | 'name_taken'
  | 'origin_exists'
  | 'forbidden'
  | 'owner_unavailable'
  | 'invalid_name'
  | 'no_commits'
  | 'incomplete'
  | 'other';

/**
 * Maps an error from `POST /api/repos/{id}/github` or `GET
 * /api/github/owners` to a kind the UI can explain. Matches the messages of
 * `RepoServiceError` in crates/server/src/error.rs.
 */
export function classifyGithubPublishError(
  error: unknown
): GithubPublishErrorKind {
  if (!(error instanceof Error)) return 'other';
  const status = (error as { status?: number }).status;
  const message = error.message.toLowerCase();

  if (status === 401 || message.includes('no github session')) {
    return 'no_session';
  }
  if (message.includes('was created on github')) return 'incomplete';
  if (message.includes('already exists on github')) return 'name_taken';
  if (message.includes('already has an origin remote')) {
    return 'origin_exists';
  }
  if (message.includes('is not available for this session')) {
    return 'owner_unavailable';
  }
  if (message.includes('invalid github repository name')) {
    return 'invalid_name';
  }
  if (message.includes('has no commits')) return 'no_commits';
  if (status === 403 || message.includes('not allowed to create')) {
    return 'forbidden';
  }
  return 'other';
}
