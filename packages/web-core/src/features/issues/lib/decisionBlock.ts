// Structured contract of a `pm:decision` issue: the analyst appends a
// `<!-- fluke:decision {...} -->` block to the `## Decisión pendiente del PM`
// section, next to the human-readable markdown. The UI reads it from here and
// falls back to the markdown when this returns null.

export interface DecisionOption {
  key: string;
  label: string;
}

export interface DecisionCondition {
  question: string;
  is: string;
}

export interface DecisionQuestion {
  id: string;
  text: string;
  options: DecisionOption[];
  recommended: string | null;
  why: string | null;
  when: DecisionCondition | null;
}

export interface DecisionBlock {
  questions: DecisionQuestion[];
}

const BLOCK_RE = /<!--\s*fluke:decision\b([\s\S]*?)-->/;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const isString = (v: unknown): v is string => typeof v === 'string';

function parseOption(raw: unknown): DecisionOption | null {
  if (!isObject(raw) || !isString(raw.key) || !isString(raw.label)) return null;
  return { key: raw.key, label: raw.label };
}

function parseQuestion(raw: unknown): DecisionQuestion | null {
  if (!isObject(raw) || !isString(raw.id) || !isString(raw.text)) return null;
  if (!Array.isArray(raw.options)) return null;
  const options = raw.options.map(parseOption);
  if (options.length === 0 || options.some((o) => o === null)) return null;
  const valid = options as DecisionOption[];
  const recommended =
    isString(raw.recommended) && valid.some((o) => o.key === raw.recommended)
      ? raw.recommended
      : null;
  const when =
    isObject(raw.when) && isString(raw.when.question) && isString(raw.when.is)
      ? { question: raw.when.question, is: raw.when.is }
      : null;
  return {
    id: raw.id,
    text: raw.text,
    options: valid,
    recommended,
    why: isString(raw.why) ? raw.why : null,
    when,
  };
}

/** Reads the first `fluke:decision` block of an issue body. Never throws:
 * a missing block, broken JSON or a malformed question yields null. */
export function parseDecisionBlock(
  body: string | null | undefined
): DecisionBlock | null {
  const match = body ? BLOCK_RE.exec(body) : null;
  if (!match) return null;
  let data: unknown;
  try {
    data = JSON.parse(match[1]);
  } catch {
    return null;
  }
  if (!isObject(data) || !Array.isArray(data.questions)) return null;
  const questions = data.questions.map(parseQuestion);
  if (questions.length === 0 || questions.some((q) => q === null)) return null;
  return { questions: questions as DecisionQuestion[] };
}
