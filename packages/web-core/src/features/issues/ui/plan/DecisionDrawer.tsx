import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { create, useModal } from '@ebay/nice-modal-react';
import { defineModal } from '@/shared/lib/modals';
import { cn } from '@/shared/lib/utils';
import { MarkdownPreview } from '@/shared/components/MarkdownPreview';
import { useTheme, getResolvedTheme } from '@/shared/hooks/useTheme';
import type { RepoIssue } from '@/features/issues/types';
import {
  parseDecisionBlock,
  type DecisionQuestion,
} from '@/features/issues/lib/decisionBlock';
import {
  firstParagraph,
  issueSection,
  stripFlukeBlocks,
} from '@/features/issues/lib/issueSections';
import {
  useCloseIssue,
  useRemoveIssueLabel,
} from '@/features/issues/model/useRepoIssues';
import { usePublishPmDecision } from '@/features/issues/model/usePublishPmDecision';
import { PM_DECISION_LABEL } from '@/features/issues/lib/milestonePlan';

/**
 * Side drawer to take a PM decision from the Plan view (#665). Contract:
 * design/mockups/fluke-v2/issues-plan.html, "Decidir ahora" on a card.
 *
 * Questions come from the issue's `fluke:decision` block (#661). Without a
 * block the drawer shows the "## Decisión pendiente del PM" section as text
 * and asks for a single free answer.
 */

export interface DecisionContext {
  wave: number | null;
  milestone: string | null;
  /** Issues of later waves of the same milestone. */
  unblocks: number[];
}

export interface DecisionDrawerProps extends DecisionContext {
  issue: RepoIssue;
  repoId: string;
  /** `owner/repo`, for the "Ver en GitHub" link. */
  repoName: string;
}

export type DecisionDrawerResult =
  | 'decided'
  | 'returned'
  | 'closed'
  | 'canceled';

const OTHER = '__other__';

type Answers = Record<string, string>;

const visibleQuestions = (qs: DecisionQuestion[], answers: Answers) =>
  qs.filter((q) => !q.when || answers[q.when.question] === q.when.is);

function DiamondIcon() {
  return <i className="inline-block size-2 rotate-45 bg-warning" aria-hidden />;
}

const DecisionDrawerImpl = create<DecisionDrawerProps>(
  ({ issue, repoId, repoName, wave, milestone, unblocks }) => {
    const modal = useModal();
    const { t } = useTranslation('common');
    const { theme } = useTheme();
    const resolvedTheme = getResolvedTheme(theme);
    const removeLabel = useRemoveIssueLabel(repoId);
    const closeIssue = useCloseIssue(repoId);
    const { run, submitting, error } = usePublishPmDecision(
      repoId,
      issue.number
    );

    const block = useMemo(() => parseDecisionBlock(issue.body), [issue.body]);
    const asunto = useMemo(
      () => firstParagraph(issueSection(issue.body, ['Brief'])),
      [issue.body]
    );
    const verified = useMemo(
      () => issueSection(issue.body, ['Contexto verificado']),
      [issue.body]
    );
    const pendingText = useMemo(() => {
      const raw = issueSection(issue.body, ['Decisión pendiente']);
      return raw ? stripFlukeBlocks(raw) : null;
    }, [issue.body]);

    const [answers, setAnswers] = useState<Answers>({});
    const [other, setOther] = useState<Answers>({});
    const [freeAnswer, setFreeAnswer] = useState('');
    const [note, setNote] = useState('');
    const [confirmClose, setConfirmClose] = useState(false);
    const [returnHint, setReturnHint] = useState(false);
    const [open, setOpen] = useState(false);
    const closeRef = useRef<HTMLButtonElement>(null);
    const returnFocus = useRef<Element | null>(null);

    useEffect(() => {
      returnFocus.current = document.activeElement;
      const id = requestAnimationFrame(() => {
        setOpen(true);
        closeRef.current?.focus();
      });
      return () => cancelAnimationFrame(id);
    }, []);

    const finish = (result: DecisionDrawerResult) => {
      setOpen(false);
      modal.resolve(result);
      window.setTimeout(() => {
        modal.hide();
        modal.remove();
        (returnFocus.current as HTMLElement | null)?.focus?.();
      }, 200);
    };

    useEffect(() => {
      const onKey = (e: KeyboardEvent) => {
        if (e.key === 'Escape') finish('canceled');
      };
      document.addEventListener('keydown', onKey);
      return () => document.removeEventListener('keydown', onKey);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const questions = block ? visibleQuestions(block.questions, answers) : [];
    const ready = block
      ? questions.every(
          (q) =>
            answers[q.id] &&
            (answers[q.id] !== OTHER || (other[q.id] ?? '').trim())
        )
      : !!freeAnswer.trim();

    const answerLines = block
      ? questions.map((q, i) => {
          const a = answers[q.id];
          const text = !a
            ? '…'
            : a === OTHER
              ? (other[q.id] ?? '').trim() || '…'
              : `(${a}) ${q.options.find((o) => o.key === a)?.label ?? ''}`;
          return `${i + 1}. ${text}`;
        })
      : [freeAnswer.trim() || '…'];
    const preview = [
      `**${t('issues.plan.decision.commentTitle')}**`,
      '',
      ...answerLines,
      ...(note.trim() ? ['', note.trim()] : []),
    ].join('\n');

    const applyRecommendations = () => {
      if (!block) return;
      const next: Answers = {};
      for (const q of block.questions) {
        if (q.recommended) next[q.id] = q.recommended;
      }
      setAnswers(next);
    };

    const decide = async () => {
      if (!ready) return;
      const ok = await run(preview, () =>
        removeLabel.mutateAsync({
          issueNumber: issue.number,
          labelName: PM_DECISION_LABEL,
        })
      );
      if (ok) finish('decided');
    };

    const returnToAnalyst = async () => {
      if (!note.trim()) {
        setReturnHint(true);
        return;
      }
      const body = [
        `**${t('issues.plan.decision.returnedTitle')}**`,
        '',
        note.trim(),
      ].join('\n');
      if (await run(body)) finish('returned');
    };

    const closeWithoutDoing = async () => {
      const body = [
        `**${t('issues.plan.decision.closedTitle')}**`,
        ...(note.trim() ? ['', note.trim()] : []),
      ].join('\n');
      if (await run(body, () => closeIssue.mutateAsync(issue.number)))
        finish('closed');
    };

    const githubUrl = repoName.includes('/')
      ? `https://github.com/${repoName}/issues/${issue.number}`
      : null;

    return createPortal(
      <>
        <div
          className={cn(
            'fixed inset-0 z-[90] bg-black/55 transition-opacity duration-200 motion-reduce:transition-none',
            open ? 'opacity-100' : 'opacity-0'
          )}
          onClick={() => finish('canceled')}
        />
        <aside
          role="dialog"
          aria-modal="true"
          aria-labelledby="decision-drawer-title"
          className={cn(
            'fixed bottom-0 right-0 top-0 z-[91] grid w-full max-w-[560px] grid-rows-[auto_1fr_auto] border-l border-md-outline-variant bg-md-surface-container-low shadow-overlay transition-transform duration-200 ease-out motion-reduce:transition-none',
            open ? 'translate-x-0' : 'translate-x-full'
          )}
        >
          <div className="relative grid gap-1.5 border-b border-md-outline-variant bg-md-surface-container px-5 pb-3.5 pt-4">
            <div className="inline-flex items-center gap-2 font-mono text-[11px] font-medium uppercase tracking-[0.08em] text-warning">
              <DiamondIcon />
              {wave != null
                ? t('issues.plan.decision.eyebrowWave', { n: wave })
                : t('issues.plan.decision.eyebrow')}
            </div>
            <button
              ref={closeRef}
              type="button"
              onClick={() => finish('canceled')}
              aria-label={t('buttons.close')}
              className="absolute right-3 top-3 grid size-8 place-items-center rounded-md text-[22px] text-normal hover:bg-md-on-surface/10 hover:text-high focus-visible:outline focus-visible:outline-2 focus-visible:outline-md-primary"
            >
              ×
            </button>
            <h2
              id="decision-drawer-title"
              className="m-0 pr-8 text-[17px] font-semibold leading-snug text-high [text-wrap:balance]"
            >
              <span className="font-mono text-[15px] font-medium text-normal">
                #{issue.number}
              </span>{' '}
              {issue.title}
            </h2>
            <div className="text-xs text-normal">
              {[
                milestone,
                unblocks.length
                  ? t('issues.plan.decision.unblocks', {
                      list: unblocks.map((n) => `#${n}`).join(', '),
                    })
                  : null,
              ]
                .filter(Boolean)
                .join(' · ')}
              {githubUrl && (
                <>
                  {milestone || unblocks.length ? ' · ' : ''}
                  <a
                    href={githubUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-md-primary hover:underline"
                  >
                    {t('issues.plan.decision.viewOnGithub')}
                  </a>
                </>
              )}
            </div>
          </div>

          <div className="grid content-start gap-[22px] overflow-y-auto px-5 pb-6 pt-[18px]">
            {(asunto || verified) && (
              <section>
                <SectionTitle>{t('issues.plan.decision.issue')}</SectionTitle>
                {asunto && (
                  <MarkdownPreview
                    content={asunto}
                    theme={resolvedTheme}
                    className="mb-2 max-w-[65ch] text-sm"
                  />
                )}
                {verified && (
                  <details className="text-[13px] text-normal">
                    <summary className="cursor-pointer text-high">
                      {t('issues.plan.decision.verified')}
                    </summary>
                    <MarkdownPreview
                      content={verified}
                      theme={resolvedTheme}
                      className="mt-2 text-[13px]"
                    />
                  </details>
                )}
              </section>
            )}

            <section>
              <SectionTitle>{t('issues.plan.decision.toDecide')}</SectionTitle>
              {block ? (
                questions.map((q, idx) => (
                  <Question
                    key={q.id}
                    n={idx + 1}
                    question={q}
                    value={answers[q.id]}
                    otherText={other[q.id] ?? ''}
                    onPick={(v) => setAnswers((a) => ({ ...a, [q.id]: v }))}
                    onOther={(v) => setOther((o) => ({ ...o, [q.id]: v }))}
                  />
                ))
              ) : (
                <div className="grid gap-2.5">
                  {pendingText && (
                    <MarkdownPreview
                      content={pendingText}
                      theme={resolvedTheme}
                      className="text-sm"
                    />
                  )}
                  <label
                    htmlFor={`decision-free-${issue.number}`}
                    className="text-[13px] text-high"
                  >
                    {t('issues.plan.decision.answer')}
                  </label>
                  <textarea
                    id={`decision-free-${issue.number}`}
                    rows={3}
                    value={freeAnswer}
                    onChange={(e) => setFreeAnswer(e.target.value)}
                    className={TEXTAREA}
                  />
                </div>
              )}
            </section>

            <section>
              <SectionTitle>
                {t('issues.plan.decision.note')}{' '}
                <span className="normal-case tracking-normal text-low">
                  {t('issues.plan.decision.optional')}
                </span>
              </SectionTitle>
              <textarea
                id={`decision-note-${issue.number}`}
                rows={2}
                value={note}
                onChange={(e) => {
                  setNote(e.target.value);
                  setReturnHint(false);
                }}
                placeholder={t('issues.plan.decision.notePlaceholder')}
                className={TEXTAREA}
              />
              {returnHint && (
                <p className="mt-1.5 text-xs text-warning">
                  {t('issues.plan.decision.returnNeedsNote')}
                </p>
              )}
              <details className="mt-2.5 text-[13px] text-normal">
                <summary className="cursor-pointer text-high">
                  {t('issues.plan.decision.preview', { n: issue.number })}
                </summary>
                <pre className="mt-2 whitespace-pre-wrap rounded-md border border-md-outline-variant bg-md-surface-container-lowest p-2.5 font-mono text-xs leading-relaxed text-high">
                  {preview}
                </pre>
                <p className="mt-1.5 text-xs">
                  {t('issues.plan.decision.previewHint')}
                </p>
              </details>
            </section>

            {error && (
              <p className="rounded-md border border-md-error/50 bg-md-error/10 px-3 py-2 text-[13px] text-md-error">
                {error.step === 'comment'
                  ? error.message
                  : t('issues.plan.decision.followUpFailed', {
                      error: error.message,
                    })}
              </p>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2.5 border-t border-md-outline-variant bg-md-surface-container px-5 py-3">
            {confirmClose ? (
              <>
                <span className="text-[13px] text-high">
                  {t('issues.plan.decision.confirmClose', { n: issue.number })}
                </span>
                <span className="flex-1" />
                <button
                  type="button"
                  onClick={() => setConfirmClose(false)}
                  className={SECONDARY}
                >
                  {t('buttons.cancel')}
                </button>
                <button
                  type="button"
                  disabled={submitting}
                  onClick={() => void closeWithoutDoing()}
                  className="inline-flex h-8 items-center rounded-md bg-md-error px-3 text-[13px] font-semibold text-md-on-error disabled:opacity-40"
                >
                  {t('issues.plan.decision.closeIssue')}
                </button>
              </>
            ) : (
              <>
                {block && (
                  <button
                    type="button"
                    onClick={applyRecommendations}
                    className={SECONDARY}
                  >
                    {t('issues.plan.decision.useRecommendations')}
                  </button>
                )}
                <span className="flex-1" />
                <div className="flex gap-3">
                  <button
                    type="button"
                    disabled={submitting}
                    onClick={() => void returnToAnalyst()}
                    className={LINK}
                  >
                    {t('issues.plan.decision.returnToAnalyst')}
                  </button>
                  <button
                    type="button"
                    disabled={submitting}
                    onClick={() => setConfirmClose(true)}
                    className={LINK}
                  >
                    {t('issues.plan.decision.closeWithoutDoing')}
                  </button>
                </div>
                <button
                  type="button"
                  disabled={!ready || submitting}
                  onClick={() => void decide()}
                  className="inline-flex h-8 items-center rounded-md bg-md-primary px-3 text-[13px] font-medium text-md-on-primary disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {t('issues.plan.decision.decide')}
                </button>
              </>
            )}
          </div>
        </aside>
      </>,
      document.body
    );
  }
);

const TEXTAREA =
  'w-full resize-y rounded-md border border-md-outline-variant bg-md-surface-container-lowest px-2.5 py-2 text-[13px] text-high focus:border-transparent focus:outline focus:outline-2 focus:outline-md-primary';
const SECONDARY =
  'inline-flex h-8 items-center rounded-md border border-md-outline-variant bg-md-surface-container-high px-3 text-[13px] text-high hover:border-md-on-surface-variant';
const LINK =
  'py-1 text-xs text-normal underline underline-offset-[3px] hover:text-high disabled:opacity-40';

function SectionTitle({ children }: { children: ReactNode }) {
  return (
    <h3 className="mb-2 font-mono text-[11px] font-medium uppercase tracking-[0.08em] text-normal">
      {children}
    </h3>
  );
}

function Question({
  n,
  question,
  value,
  otherText,
  onPick,
  onOther,
}: {
  n: number;
  question: DecisionQuestion;
  value: string | undefined;
  otherText: string;
  onPick: (v: string) => void;
  onOther: (v: string) => void;
}) {
  const { t } = useTranslation('common');
  const name = `decision-q-${question.id}`;
  const options = [
    ...question.options.map((o) => ({ key: o.key, label: o.label })),
    { key: OTHER, label: t('issues.plan.decision.otherAnswer') },
  ];
  return (
    <fieldset className="m-0 mb-[18px] grid min-w-0 gap-1.5 border-0 p-0">
      <legend className="mb-2 flex gap-2.5 p-0 text-sm font-medium leading-snug text-high">
        <span className="grid size-[22px] flex-none place-items-center rounded-full border border-md-outline-variant bg-md-surface-container-high font-mono text-[11px] text-normal">
          {n}
        </span>
        {question.text}
      </legend>
      {options.map((o) => {
        const selected = value === o.key;
        return (
          <label
            key={o.key}
            className={cn(
              'grid cursor-pointer grid-cols-[22px_1fr_auto] items-center gap-2.5 rounded-md border border-md-outline-variant bg-md-surface-container-high px-3 py-[9px] text-[13px] text-high hover:border-md-on-surface-variant',
              'has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-md-primary',
              selected && 'border-warning bg-warning/10'
            )}
          >
            <input
              type="radio"
              name={name}
              value={o.key}
              checked={selected}
              onChange={() => onPick(o.key)}
              className="pointer-events-none absolute opacity-0"
            />
            <span
              className={cn(
                'grid size-[22px] place-items-center rounded border border-md-outline-variant font-mono text-[11px] text-normal',
                selected && 'border-warning bg-warning text-warning-foreground'
              )}
            >
              {o.key === OTHER ? '…' : o.key}
            </span>
            <span className="min-w-0">{o.label}</span>
            {question.recommended === o.key && (
              <span className="whitespace-nowrap rounded border border-success/45 px-1.5 py-px font-mono text-[10px] font-medium text-success">
                {t('issues.plan.decision.recommended')}
              </span>
            )}
          </label>
        );
      })}
      {value === OTHER && (
        <textarea
          id={`${name}-other`}
          rows={2}
          value={otherText}
          onChange={(e) => onOther(e.target.value)}
          placeholder={t('issues.plan.decision.otherPlaceholder')}
          className={TEXTAREA}
        />
      )}
      {question.recommended && question.why && (
        <p className="m-0 mt-1 border-l-2 border-md-outline-variant pl-3 text-xs leading-relaxed text-normal">
          <b className="font-medium text-high">
            {t('issues.plan.decision.why', { key: question.recommended })}
          </b>{' '}
          {question.why}
        </p>
      )}
    </fieldset>
  );
}

export const DecisionDrawer = defineModal<
  DecisionDrawerProps,
  DecisionDrawerResult
>(DecisionDrawerImpl);
