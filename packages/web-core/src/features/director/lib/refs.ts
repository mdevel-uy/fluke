/**
 * Fluke's chat: "PR 815", "PR #815" and "#796" in a reply become links to
 * the repo on GitHub (styled as chips). `repoSlug` is "owner/name"; without
 * one the text is left as is. Skips refs already inside a link or code.
 */
export function linkRefs(content: string, repoSlug: string | null): string {
  if (!repoSlug?.includes('/')) return content;
  const base = `https://github.com/${repoSlug}`;
  // Code spans and existing links are kept apart and put back untouched.
  return content
    .split(/(`[^`]*`|\[[^\]]*\]\([^)]*\))/)
    .map((part, i) =>
      i % 2 === 1
        ? part
        : part
            .replace(
              /\bPR\s?#?(\d+)\b/g,
              (_, n: string) => `[PR ${n}](${base}/pull/${n})`
            )
            .replace(
              /(^|[\s(])#(\d+)\b/g,
              (_, lead: string, n: string) =>
                `${lead}[#${n}](${base}/issues/${n})`
            )
    )
    .join('');
}
