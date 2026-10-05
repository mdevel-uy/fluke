import { describe, expect, it } from 'vitest';
import { linkRefs } from './refs';

const base = 'https://github.com/acme/app';

describe('linkRefs', () => {
  it('links PRs and issues', () => {
    expect(linkRefs('El PR 815 y el #796.', 'acme/app')).toBe(
      `El [PR 815](${base}/pull/815) y el [#796](${base}/issues/796).`
    );
    expect(linkRefs('PR #12', 'acme/app')).toBe(`[PR 12](${base}/pull/12)`);
  });

  it('leaves code, links and unknown repos alone', () => {
    const text = 'Ver `PR 1` y [#2](https://x) y #3';
    expect(linkRefs(text, 'acme/app')).toBe(
      `Ver \`PR 1\` y [#2](https://x) y [#3](${base}/issues/3)`
    );
    expect(linkRefs('PR 815', null)).toBe('PR 815');
    expect(linkRefs('PR 815', 'app')).toBe('PR 815');
  });
});
