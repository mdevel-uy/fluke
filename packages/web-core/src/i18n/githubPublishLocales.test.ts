import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Textos nuevos del bloque «Crear tambien en GitHub» (issue #775): viven en
// el namespace `common` bajo `githubPublish`, existen en en y es, y no llevan
// emojis en ningun idioma.
const LOCALES_DIR = fileURLToPath(new URL('./locales', import.meta.url));

const REQUIRED_KEYS = [
  'checkbox',
  'owner.label',
  'visibility.label',
  'visibility.public',
  'visibility.private',
  'owners.loading',
  'noSession.message',
  'noSession.openSettings',
  'failure.registeredLocally',
  'failure.retry',
];

type Json = { [key: string]: Json | string };

function githubPublishBlock(locale: string): Json | undefined {
  const raw = readFileSync(`${LOCALES_DIR}/${locale}/common.json`, 'utf8');
  return (JSON.parse(raw) as Record<string, Json>).githubPublish;
}

function lookup(block: Json | undefined, path: string): string | undefined {
  let cur: Json | string | undefined = block;
  for (const part of path.split('.')) {
    if (typeof cur !== 'object' || cur === null) return undefined;
    cur = cur[part];
  }
  return typeof cur === 'string' ? cur : undefined;
}

function strings(block: Json): string[] {
  return Object.values(block).flatMap((v) =>
    typeof v === 'string' ? [v] : strings(v)
  );
}

describe('i18n de githubPublish', () => {
  for (const locale of ['en', 'es']) {
    it(`${locale}: tiene todas las claves con texto no vacio`, () => {
      const block = githubPublishBlock(locale);
      expect(block).toBeDefined();
      for (const key of REQUIRED_KEYS) {
        const value = lookup(block, key);
        expect(value, `${locale}: githubPublish.${key}`).toBeTruthy();
      }
    });
  }

  it('es: el checkbox dice «Crear también en GitHub»', () => {
    expect(lookup(githubPublishBlock('es'), 'checkbox')).toBe(
      'Crear también en GitHub'
    );
  });

  it('ningun locale lleva emojis en githubPublish', () => {
    const present = readdirSync(LOCALES_DIR).filter((l) =>
      Boolean(githubPublishBlock(l))
    );
    // Sin locales con el bloque, el test no probaria nada.
    expect(present).toContain('en');
    for (const locale of present) {
      for (const text of strings(githubPublishBlock(locale) as Json)) {
        expect(text, `${locale}: ${text}`).not.toMatch(/\p{Extended_Pictographic}/u);
      }
    }
  });
});
