import { describe, it, expect } from 'vitest';
import {
  firstParagraph,
  issueSection,
  stripFlukeBlocks,
} from './issueSections';

const BODY = `## Brief

Primer párrafo del brief.

Segundo párrafo.

## Contexto verificado en el código

- dato 1
- dato 2

## Decisión pendiente del PM
1. ¿Pregunta?
<!-- fluke:decision {"questions":[]} -->`;

describe('issueSections', () => {
  it('reads a section up to the next heading', () => {
    expect(issueSection(BODY, ['contexto verificado'])).toBe(
      '- dato 1\n- dato 2'
    );
  });

  it('reads the last section to the end of the body', () => {
    expect(issueSection(BODY, ['Decisión pendiente'])).toContain('¿Pregunta?');
  });

  it('returns null for a missing section or empty body', () => {
    expect(issueSection(BODY, ['Territorio'])).toBeNull();
    expect(issueSection(null, ['Brief'])).toBeNull();
  });

  it('takes the first paragraph', () => {
    expect(firstParagraph(issueSection(BODY, ['Brief']))).toBe(
      'Primer párrafo del brief.'
    );
  });

  it('strips fluke blocks', () => {
    expect(stripFlukeBlocks('a\n<!-- fluke:decision {"x":1} -->')).toBe('a');
  });
});
