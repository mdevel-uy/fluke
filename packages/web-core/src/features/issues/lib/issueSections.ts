// Reads the `## Heading` sections the analyst writes in an issue body
// (## Brief, ## Contexto verificado en el código, ## Decisión pendiente del
// PM). Used by the decision drawer to show the issue without the full body.

const HEADING_RE = /^##\s+(.+?)\s*$/;

/** Body of the first `## <heading>` section whose title starts with one of
 * `titles` (case-insensitive), without the heading line. Null if absent. */
export function issueSection(
  body: string | null | undefined,
  titles: string[]
): string | null {
  if (!body) return null;
  const wanted = titles.map((t) => t.toLowerCase());
  const lines = body.split(/\r?\n/);
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = HEADING_RE.exec(lines[i]);
    if (!m) continue;
    if (start >= 0) {
      return lines.slice(start, i).join('\n').trim() || null;
    }
    const title = m[1].toLowerCase();
    if (wanted.some((w) => title.startsWith(w))) start = i + 1;
  }
  return start >= 0 ? lines.slice(start).join('\n').trim() || null : null;
}

/** First paragraph of a markdown text (up to the first blank line). */
export function firstParagraph(text: string | null): string | null {
  if (!text) return null;
  const para = text.split(/\r?\n\s*\r?\n/)[0]?.trim();
  return para || null;
}

/** Removes `<!-- fluke:... -->` blocks so they don't show as text. */
export function stripFlukeBlocks(text: string): string {
  return text.replace(/<!--\s*fluke:[\s\S]*?-->/g, '').trim();
}
