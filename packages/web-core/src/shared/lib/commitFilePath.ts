// Virtual editor paths for read-only commit snapshots. The embedded editor
// keys its buffers by path; live worktree files use absolute filesystem
// paths, commit snapshots use this `git:` scheme so the loader can route
// them to the commit-file endpoint (and block saving).

export interface CommitFileRef {
  repoId: string;
  oid: string;
  /** Repo-relative path inside the commit tree. */
  path: string;
}

const FILE_PREFIX = 'git:';
const DIFF_PREFIX = 'gitdiff:';

function parseWithPrefix(path: string, prefix: string): CommitFileRef | null {
  if (!path.startsWith(prefix)) return null;
  const rest = path.slice(prefix.length);
  const firstColon = rest.indexOf(':');
  const secondColon = rest.indexOf(':', firstColon + 1);
  if (firstColon === -1 || secondColon === -1) return null;
  return {
    repoId: rest.slice(0, firstColon),
    oid: rest.slice(firstColon + 1, secondColon),
    path: rest.slice(secondColon + 1),
  };
}

export function makeCommitFilePath(ref: CommitFileRef): string {
  return `${FILE_PREFIX}${ref.repoId}:${ref.oid}:${ref.path}`;
}

export function isCommitFilePath(path: string): boolean {
  return path.startsWith(FILE_PREFIX);
}

export function parseCommitFilePath(path: string): CommitFileRef | null {
  return parseWithPrefix(path, FILE_PREFIX);
}

/** Diff tabs: the unified patch of one file in a commit. */
export function makeCommitDiffPath(ref: CommitFileRef): string {
  return `${DIFF_PREFIX}${ref.repoId}:${ref.oid}:${ref.path}`;
}

export function isCommitDiffPath(path: string): boolean {
  return path.startsWith(DIFF_PREFIX);
}

export function parseCommitDiffPath(path: string): CommitFileRef | null {
  return parseWithPrefix(path, DIFF_PREFIX);
}

/** Any read-only commit-scoped buffer (snapshot or diff). */
export function isCommitScopedPath(path: string): boolean {
  return isCommitFilePath(path) || isCommitDiffPath(path);
}

/** Ref of any commit-scoped buffer, whatever the scheme. */
export function parseCommitScopedPath(path: string): CommitFileRef | null {
  return parseCommitFilePath(path) ?? parseCommitDiffPath(path);
}
