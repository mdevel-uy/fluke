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

const PREFIX = 'git:';

export function makeCommitFilePath(ref: CommitFileRef): string {
  return `${PREFIX}${ref.repoId}:${ref.oid}:${ref.path}`;
}

export function isCommitFilePath(path: string): boolean {
  return path.startsWith(PREFIX);
}

export function parseCommitFilePath(path: string): CommitFileRef | null {
  if (!isCommitFilePath(path)) return null;
  const rest = path.slice(PREFIX.length);
  const firstColon = rest.indexOf(':');
  const secondColon = rest.indexOf(':', firstColon + 1);
  if (firstColon === -1 || secondColon === -1) return null;
  return {
    repoId: rest.slice(0, firstColon),
    oid: rest.slice(firstColon + 1, secondColon),
    path: rest.slice(secondColon + 1),
  };
}
