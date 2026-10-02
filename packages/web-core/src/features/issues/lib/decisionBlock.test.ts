import { describe, it, expect } from 'vitest';
import { parseDecisionBlock } from './decisionBlock';

function body(json: string) {
  return `## Decisión pendiente del PM\n\n1. ¿Algo?\n   a) Sí\n\n<!-- fluke:decision\n${json}\n-->\n`;
}

const VALID = JSON.stringify({
  questions: [
    {
      id: 'q1',
      text: '¿Cobramos por usuario?',
      options: [
        { key: 'a', label: 'Sí' },
        { key: 'b', label: 'No' },
      ],
      recommended: 'a',
      why: 'Escala con el uso',
      when: null,
    },
    {
      id: 'q2',
      text: '¿Precio por usuario?',
      options: [{ key: 'a', label: '$10' }],
      recommended: 'a',
      why: 'Mercado',
      when: { question: 'q1', is: 'a' },
    },
  ],
});

describe('parseDecisionBlock', () => {
  it('parses a valid block, including the conditional question', () => {
    expect(parseDecisionBlock(body(VALID))).toEqual({
      questions: [
        {
          id: 'q1',
          text: '¿Cobramos por usuario?',
          options: [
            { key: 'a', label: 'Sí' },
            { key: 'b', label: 'No' },
          ],
          recommended: 'a',
          why: 'Escala con el uso',
          when: null,
        },
        {
          id: 'q2',
          text: '¿Precio por usuario?',
          options: [{ key: 'a', label: '$10' }],
          recommended: 'a',
          why: 'Mercado',
          when: { question: 'q1', is: 'a' },
        },
      ],
    });
  });

  it('defaults missing optional fields to null', () => {
    const block = parseDecisionBlock(
      body(
        '{"questions":[{"id":"q1","text":"t","options":[{"key":"a","label":"A"}]}]}'
      )
    );
    expect(block?.questions[0]).toMatchObject({
      recommended: null,
      why: null,
      when: null,
    });
  });

  it.each([
    ['no body', ''],
    ['no block', '## Decisión pendiente del PM\n\n1. ¿Algo?'],
    ['invalid JSON', body('{"questions": [')],
    ['missing questions', body('{}')],
    ['empty questions', body('{"questions":[]}')],
    ['malformed question', body('{"questions":[{"id":"q1"}]}')],
    [
      'question without options',
      body('{"questions":[{"id":"q1","text":"t","options":[]}]}'),
    ],
  ])('returns null for %s', (_, input) => {
    expect(() => parseDecisionBlock(input)).not.toThrow();
    expect(parseDecisionBlock(input)).toBeNull();
  });

  it('drops a recommendation that matches no option', () => {
    const block = parseDecisionBlock(
      body(
        '{"questions":[{"id":"q1","text":"t","options":[{"key":"a","label":"A"}],"recommended":"z","why":"w"}]}'
      )
    );
    expect(block?.questions[0].recommended).toBeNull();
    expect(block?.questions[0].why).toBe('w');
  });

  it('uses the first block when there are two', () => {
    const first =
      '{"questions":[{"id":"first","text":"t","options":[{"key":"a","label":"A"}]}]}';
    const block = parseDecisionBlock(body(first) + body(VALID));
    expect(block?.questions.map((q) => q.id)).toEqual(['first']);
  });
});
