// fluke v2 (#682): a worker is a profile, and each running task is an
// ephemeral instance of it. Instances have no name of their own; they are
// shown as `profile·xxx`, with the first characters of their workspace id.

export function instanceLabel(
  profileName: string,
  workspaceId: string | null | undefined
): string {
  const profile = profileName.trim().toLowerCase().replace(/\s+/g, '-');
  return workspaceId ? `${profile}·${workspaceId.slice(0, 3)}` : profile;
}
