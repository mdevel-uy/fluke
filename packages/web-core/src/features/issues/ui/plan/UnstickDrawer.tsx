import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { create, useModal } from '@ebay/nice-modal-react';
import { useQueryClient } from '@tanstack/react-query';
import { BaseCodingAgent } from 'shared/types';
import { defineModal } from '@/shared/lib/modals';
import { cn } from '@/shared/lib/utils';
import { issuePhasesApi, planApi, sessionsApi } from '@/shared/lib/api';
import type { RepoIssue } from '@/features/issues/types';
import { useIssuePlan } from '@/features/issues/model/useIssuePlan';
import { useCloseIssue } from '@/features/issues/model/useRepoIssues';
import { blockerAge, blockerPhaseKind } from '@/features/issues/lib/blocker';
import { instanceLabel } from '@/features/workers/model/instance';
import { useCreateMission } from '@/features/director/model/useMissions';

/**
 * "Destrabar" drawer (#696): what happened to a stuck issue, the agent's
 * question with its options, and the other ways out. Contract:
 * design/mockups/fluke-v2/pantallas.html, Destrabar on #658.
 */

export interface UnstickDrawerProps {
  issue: RepoIssue;
  repoId: string;
}

export type UnstickDrawerResult =
  | 'canceled'
  | 'answered'
  | 'retried'
  | 'backToTests'
  | 'canceledIssue'
  | 'fluke'
  /** The caller opens that tab of the issue page on the stuck phase. */
  | { open: 'sessions' | 'code'; phase: string | null };

interface AgentQuestion {
  question: string;
  options: { key: string; text: string }[];
  recommended?: string | null;
  why?: string | null;
}

const OTHER = '__other__';

function parseQuestion(raw: string | null): AgentQuestion | null {
  if (!raw) return null;
  try {
    const q = JSON.parse(raw) as AgentQuestion;
    return typeof q.question === 'string' && Array.isArray(q.options)
      ? q
      : null;
  } catch {
    return null;
  }
}

const UnstickDrawerImpl = create<UnstickDrawerProps>(({ issue, repoId }) => {
  const modal = useModal();
  const { t } = useTranslation('common');
  const queryClient = useQueryClient();
  const { data: plan } = useIssuePlan(repoId, issue.number);
  const closeIssue = useCloseIssue(repoId);
  const createMission = useCreateMission();
  const blocker = plan?.blocker ?? null;
  const question = useMemo(
    () => parseQuestion(blocker?.question ?? null),
    [blocker?.question]
  );

  const [pick, setPick] = useState<string | null>(null);
  const [other, setOther] = useState('');
  const [note, setNote] = useState('');
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
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

  const finish = (result: UnstickDrawerResult) => {
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

  /** Runs an exit, refreshes what shows the blocker and closes on success. */
  const run = async (
    fn: () => Promise<unknown>,
    result: UnstickDrawerResult
  ) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      queryClient.invalidateQueries({ queryKey: ['issue-plan', repoId] });
      queryClient.invalidateQueries({ queryKey: ['issue-blockers', repoId] });
      queryClient.invalidateQueries({ queryKey: ['workers'] });
      finish(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  const phaseKind = blocker ? blockerPhaseKind(blocker) : null;
  const phaseName = phaseKind ? t(`issues.plan.phases.kind.${phaseKind}`) : '';
  const age = blocker ? blockerAge(blocker.since) : null;
  const phase = plan?.phases.find(
    (p) => `${p.kind}-${p.round}` === blocker?.phase
  );
  const tried = (plan?.phases ?? []).filter(
    (p) =>
      blocker?.kind === 'review_cap' &&
      p.kind === 'review' &&
      (p.state === 'changes' || p.state === 'stuck')
  );
  const workspaceId = blocker?.workspace_id ?? null;
  const ready = !!question && (pick === OTHER ? !!other.trim() : pick !== null);

  const answer = () => {
    if (!question || !workspaceId || !pick) return;
    const chosen = question.options.find((o) => o.key === pick);
    const extra = note.trim();
    const text =
      pick === OTHER
        ? other.trim()
        : extra
          ? `${chosen?.key}: ${chosen?.text}`
          : pick;
    run(
      () =>
        planApi.answer(
          workspaceId,
          JSON.parse(blocker!.question!),
          extra ? `${text}\n${extra}` : text
        ),
      'answered'
    );
  };

  const talkToFluke = () =>
    run(async () => {
      const detail = await createMission.mutateAsync(repoId);
      await sessionsApi.followUp(detail.mission.session_id, {
        prompt: t('issues.plan.unstick.flukeMessage', {
          n: issue.number,
          title: issue.title,
          phase: phaseName,
          message: blocker?.message ?? '',
        }),
        executor_config: { executor: BaseCodingAgent.CLAUDE_CODE },
        retry_process_id: null,
        force_when_dirty: null,
        perform_git_reset: null,
      });
    }, 'fluke');

  const unstick = (action: string, result: UnstickDrawerResult) =>
    run(
      () =>
        issuePhasesApi.unstick(repoId, issue.number, {
          action,
          note: note.trim() || undefined,
        }),
      result
    );

  const cancelIssue = () =>
    run(async () => {
      await issuePhasesApi.unstick(repoId, issue.number, { action: 'cancel' });
      await closeIssue.mutateAsync(issue.number);
    }, 'canceledIssue');

  const alternatives: {
    key: string;
    show: boolean;
    warn?: boolean;
    onClick: () => void;
  }[] = [
    { key: 'fluke', show: true, onClick: talkToFluke },
    {
      key: 'session',
      show: !!workspaceId,
      onClick: () =>
        finish({ open: 'sessions', phase: blocker?.phase ?? null }),
    },
    {
      key: 'code',
      show: !!workspaceId,
      onClick: () => finish({ open: 'code', phase: blocker?.phase ?? null }),
    },
    {
      key: 'retry',
      show: blocker?.kind === 'failed' || blocker?.kind === 'credential',
      onClick: () => unstick('retry', 'retried'),
    },
    {
      key: 'back',
      show: plan?.template === 'tdd',
      onClick: () => unstick('back_to_tests', 'backToTests'),
    },
    {
      key: 'cancel',
      show: true,
      warn: true,
      onClick: () => setConfirmCancel(true),
    },
  ];

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
        aria-labelledby="unstick-drawer-title"
        className={cn(
          'fixed bottom-0 right-0 top-0 z-[91] grid w-full max-w-[580px] grid-rows-[auto_1fr_auto] border-l border-md-outline-variant bg-md-surface-container-low shadow-overlay transition-transform duration-200 ease-out motion-reduce:transition-none',
          open ? 'translate-x-0' : 'translate-x-full'
        )}
      >
        <div className="relative grid gap-1.5 border-b border-md-outline-variant bg-md-surface-container px-5 pb-3.5 pt-4">
          <div className="font-mono text-[11px] font-medium uppercase tracking-[0.08em] text-md-error">
            {age
              ? t('issues.plan.unstick.eyebrow', { phase: phaseName, age })
              : t('issues.plan.unstick.eyebrowNoAge', { phase: phaseName })}
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
            id="unstick-drawer-title"
            className="m-0 pr-8 text-[17px] font-semibold leading-snug text-high [text-wrap:balance]"
          >
            <span className="font-mono text-[15px] font-medium text-normal">
              #{issue.number}
            </span>{' '}
            {issue.title}
          </h2>
          {phase?.profile && workspaceId && (
            <div className="flex flex-wrap items-center gap-1.5 text-xs text-normal">
              <code className="font-mono">
                {instanceLabel(phase.profile, workspaceId)}
              </code>
              {blocker?.kind === 'question' && (
                <span>· {t('issues.plan.unstick.instanceAlive')}</span>
              )}
            </div>
          )}
        </div>

        <div className="grid content-start gap-[22px] overflow-y-auto px-5 pb-6 pt-[18px]">
          {!blocker ? (
            <p className="m-0 text-[13px] text-normal">
              {plan ? t('issues.plan.unstick.notStuck') : t('issues.loading')}
            </p>
          ) : (
            <>
              <section>
                <SectionTitle>
                  {t('issues.plan.unstick.whatHappened')}
                </SectionTitle>
                <div className="grid grid-cols-[auto_1fr] items-start gap-2.5">
                  <span className="grid size-6 place-items-center rounded-md bg-md-primary text-[11px] font-semibold text-md-on-primary">
                    F
                  </span>
                  <p className="m-0 max-w-[62ch] whitespace-pre-wrap text-sm leading-relaxed text-high">
                    {question
                      ? `${t(`issues.plan.stuck.kinds.${blocker.kind}.title`)}.`
                      : blocker.message}
                  </p>
                </div>
              </section>

              {tried.length > 0 && (
                <section>
                  <SectionTitle>{t('issues.plan.unstick.tried')}</SectionTitle>
                  <ol className="m-0 grid gap-1.5 pl-[18px] text-[13px] text-normal">
                    {tried.map((p) => (
                      <li key={`${p.kind}-${p.round}`}>
                        <b className="font-mono text-xs font-medium text-high">
                          {p.profile && p.workspace_id
                            ? instanceLabel(p.profile, p.workspace_id)
                            : t('issues.plan.phases.kind.review')}
                        </b>{' '}
                        {t('issues.plan.unstick.triedRound', { n: p.round })}
                      </li>
                    ))}
                  </ol>
                </section>
              )}

              {question && workspaceId && (
                <section>
                  <SectionTitle>
                    {t('issues.plan.unstick.question')}
                  </SectionTitle>
                  <fieldset className="m-0 mb-3 grid min-w-0 gap-1.5 border-0 p-0">
                    <legend className="mb-2 p-0 text-sm font-medium text-high">
                      {question.question}
                    </legend>
                    {[
                      ...question.options,
                      {
                        key: OTHER,
                        text: t('issues.plan.unstick.otherAnswer'),
                      },
                    ].map((o) => {
                      const selected = pick === o.key;
                      return (
                        <label
                          key={o.key}
                          className={cn(
                            'grid cursor-pointer grid-cols-[22px_1fr_auto] items-center gap-2.5 rounded-md border border-md-outline-variant bg-md-surface-container-high px-3 py-[9px] text-[13px] text-high hover:border-md-on-surface-variant',
                            'has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-md-primary',
                            selected && 'border-md-primary bg-md-primary/10'
                          )}
                        >
                          <input
                            type="radio"
                            name="unstick-q"
                            value={o.key}
                            checked={selected}
                            onChange={() => setPick(o.key)}
                            className="pointer-events-none absolute opacity-0"
                          />
                          <span
                            className={cn(
                              'grid size-[22px] place-items-center rounded border border-md-outline-variant font-mono text-[11px] text-normal',
                              selected &&
                                'border-md-primary bg-md-primary text-md-on-primary'
                            )}
                          >
                            {o.key === OTHER ? '…' : o.key}
                          </span>
                          <span className="min-w-0">{o.text}</span>
                          {question.recommended === o.key && (
                            <span className="whitespace-nowrap rounded border border-success/45 px-1.5 py-px font-mono text-[10px] font-medium text-success">
                              {t('issues.plan.unstick.recommended')}
                            </span>
                          )}
                        </label>
                      );
                    })}
                    {pick === OTHER && (
                      <textarea
                        rows={2}
                        value={other}
                        onChange={(e) => setOther(e.target.value)}
                        placeholder={t('issues.plan.unstick.otherPlaceholder')}
                        className={TEXTAREA}
                      />
                    )}
                    {question.recommended && question.why && (
                      <p className="m-0 mt-1 border-l-2 border-md-outline-variant pl-3 text-xs leading-relaxed text-normal">
                        <b className="font-medium text-high">
                          {t('issues.plan.unstick.why', {
                            key: question.recommended,
                          })}
                        </b>{' '}
                        {question.why}
                      </p>
                    )}
                  </fieldset>
                </section>
              )}

              {(question || plan?.template === 'tdd') && (
                <section>
                  <label
                    htmlFor="unstick-note"
                    className="mb-1.5 block text-[13px] text-high"
                  >
                    {t('issues.plan.unstick.note')}{' '}
                    <span className="text-xs text-low">
                      {t('issues.plan.unstick.optional')}
                    </span>
                  </label>
                  <textarea
                    id="unstick-note"
                    rows={2}
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    placeholder={t('issues.plan.unstick.notePlaceholder')}
                    className={TEXTAREA}
                  />
                </section>
              )}

              <section>
                <SectionTitle>
                  {t('issues.plan.unstick.alternatives')}
                </SectionTitle>
                {confirmCancel ? (
                  <div className="grid gap-2 rounded-md border border-md-error/50 bg-md-error/10 px-3 py-2.5 text-[13px] text-high">
                    {t('issues.plan.unstick.confirmCancel', {
                      n: issue.number,
                    })}
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        disabled={busy}
                        onClick={cancelIssue}
                        className="inline-flex h-8 items-center rounded-md bg-md-error px-3 text-[13px] font-semibold text-md-on-error disabled:opacity-40"
                      >
                        {t('issues.plan.unstick.alt.cancel.title')}
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmCancel(false)}
                        className="inline-flex h-8 items-center rounded-md border border-md-outline-variant bg-md-surface-container-high px-3 text-[13px] text-high"
                      >
                        {t('issues.plan.unstick.keep')}
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="grid grid-cols-[repeat(auto-fill,minmax(230px,1fr))] gap-2">
                    {alternatives
                      .filter((a) => a.show)
                      .map((a) => (
                        <button
                          key={a.key}
                          type="button"
                          disabled={busy}
                          onClick={a.onClick}
                          className="grid gap-0.5 rounded-lg border border-md-outline-variant bg-md-surface-container-high px-3 py-[9px] text-left hover:border-md-on-surface-variant focus-visible:outline focus-visible:outline-2 focus-visible:outline-md-primary disabled:opacity-50"
                        >
                          <b
                            className={cn(
                              'text-[13px] font-medium text-high',
                              a.warn && 'text-md-error'
                            )}
                          >
                            {t(`issues.plan.unstick.alt.${a.key}.title`)}
                          </b>
                          <span className="text-xs text-normal">
                            {t(`issues.plan.unstick.alt.${a.key}.hint`)}
                          </span>
                        </button>
                      ))}
                  </div>
                )}
              </section>

              {error && (
                <p className="m-0 rounded-md border border-md-error/50 bg-md-error/10 px-3 py-2 text-[13px] text-md-error">
                  {error}
                </p>
              )}
            </>
          )}
        </div>

        {question && workspaceId && (
          <div className="flex flex-wrap items-center gap-2.5 border-t border-md-outline-variant bg-md-surface-container px-5 py-3">
            <span className="text-xs text-normal">
              {t('issues.plan.unstick.footHint')}
            </span>
            <span className="flex-1" />
            <button
              type="button"
              disabled={!ready || busy}
              onClick={answer}
              className="inline-flex h-8 items-center rounded-md border border-md-primary bg-md-primary px-3 text-[13px] font-medium text-md-on-primary hover:opacity-90 disabled:opacity-50"
            >
              {t('issues.plan.unstick.answer')}
            </button>
          </div>
        )}
      </aside>
    </>,
    document.body
  );
});

const TEXTAREA =
  'w-full resize-y rounded-md border border-md-outline-variant bg-md-surface-container-lowest px-2.5 py-2 text-[13px] text-high focus:border-transparent focus:outline focus:outline-2 focus:outline-md-primary';

function SectionTitle({ children }: { children: ReactNode }) {
  return (
    <h3 className="mb-2 font-mono text-[11px] font-medium uppercase tracking-[0.08em] text-normal">
      {children}
    </h3>
  );
}

export const UnstickDrawer = defineModal<
  UnstickDrawerProps,
  UnstickDrawerResult
>(UnstickDrawerImpl);
