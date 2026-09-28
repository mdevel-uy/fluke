import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Background,
  BackgroundVariant,
  Handle,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  Crosshair,
  Loader2,
  Pause,
  Play,
  SkipBack,
  Square,
  Undo2,
  X,
} from 'lucide-react';
import type {
  PlanSnapshot,
  PlanStep,
  PlanStepRevision,
  StepProposal,
} from 'shared/types';
import { cn } from '@/shared/lib/utils';
import { planApi } from '@/shared/lib/api';
import { useWorkspaceContext } from '@/shared/hooks/useWorkspaceContext';
import { usePlanStream } from '../model/usePlanStream';
import { effectiveDeps, layoutSteps } from '../model/layout';
import {
  deriveRunState,
  type RunLabel,
  type RunState,
} from '../model/runState';

// Borde de "hormigas en marcha" alrededor del nodo donde está el agente.
const ANTS_CSS = `
@keyframes plan-ants { to { stroke-dashoffset: -24; } }
.plan-ants rect { fill: none; stroke-width: 2; stroke-dasharray: 7 5; animation: plan-ants .9s linear infinite; }
.plan-ants.still rect { animation: none; }
@media (prefers-reduced-motion: reduce) { .plan-ants rect { animation: none; } }
`;

type Here = 'active' | 'stopped' | 'pausing' | 'queued' | null;

type StepNodeData = {
  step: PlanStep;
  here: Here;
  revision: PlanStepRevision | null;
  selected: boolean;
  onCut: (n: number, cut: boolean) => void;
  vertical: boolean;
};

const SQLITE_UTC = (s: string) => new Date(s.replace(' ', 'T') + 'Z');

function Elapsed({ since }: { since: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const sec = Math.max(
    0,
    Math.floor((now - SQLITE_UTC(since).getTime()) / 1000)
  );
  return (
    <span className="font-ibm-plex-mono tabular-nums">
      {String(Math.floor(sec / 60)).padStart(2, '0')}:
      {String(sec % 60).padStart(2, '0')}
    </span>
  );
}

function Pill({
  tone,
  children,
  live,
}: {
  tone: 'run' | 'ok' | 'warn' | 'err' | 'mute';
  children: React.ReactNode;
  live?: boolean;
}) {
  const cls = {
    run: 'bg-brand/15 text-brand',
    ok: 'bg-success/15 text-success',
    warn: 'bg-warning/15 text-warning',
    err: 'bg-error/15 text-error',
    mute: 'bg-secondary text-low',
  }[tone];
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 whitespace-nowrap rounded-full px-1.5 py-px text-[10px] font-semibold',
        cls
      )}
    >
      {live && (
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" />
      )}
      {children}
    </span>
  );
}

function StepNode({ data }: NodeProps<Node<StepNodeData>>) {
  const { t } = useTranslation('common');
  const { step, here, revision, selected, onCut, vertical } = data;
  const antsColor =
    here === 'stopped'
      ? 'hsl(var(--md-error))'
      : here === 'queued'
        ? 'hsl(var(--md-outline))'
        : here === 'pausing'
          ? 'hsl(var(--md-tertiary))'
          : 'hsl(var(--brand))';
  const tag =
    here === 'active'
      ? t('plan.here.active')
      : here === 'stopped'
        ? t('plan.here.stopped')
        : here === 'pausing'
          ? t('plan.here.pausing')
          : here === 'queued'
            ? t('plan.here.queued')
            : null;
  const stateTone = {
    pending: 'mute',
    active: 'run',
    done: 'ok',
    cut: 'err',
  } as const;
  const pill = revision ? (
    revision.status === 'requested' ? (
      <Pill tone="warn" live>
        {t('plan.revising')}
      </Pill>
    ) : (
      <Pill tone="warn">{t('plan.proposed', { v: step.version + 1 })}</Pill>
    )
  ) : step.version > 1 ? (
    <Pill tone="run">{t('plan.version', { v: step.version })}</Pill>
  ) : (
    <Pill
      tone={stateTone[step.state as keyof typeof stateTone] ?? 'mute'}
      live={step.state === 'active' && here === 'active'}
    >
      {t(`plan.state.${step.state}`)}
    </Pill>
  );

  return (
    <div
      className={cn(
        'relative w-[230px] cursor-pointer rounded-[10px] border-[1.5px] bg-panel px-3 py-2.5 shadow-sm',
        step.state === 'done' && 'border-success',
        step.state === 'active' &&
          (here === 'stopped'
            ? 'border-error ring-4 ring-error/15'
            : 'border-brand ring-4 ring-brand/15'),
        step.state === 'pending' && 'border-dashed border-md-outline',
        step.state === 'cut' &&
          'border-dashed border-md-outline-variant opacity-45',
        selected && 'outline outline-2 outline-offset-4 outline-brand'
      )}
    >
      <Handle
        type="target"
        position={vertical ? Position.Top : Position.Left}
        className="!h-1.5 !w-1.5 !border-0 !bg-transparent"
      />
      <Handle
        type="source"
        position={vertical ? Position.Bottom : Position.Right}
        className="!h-1.5 !w-1.5 !border-0 !bg-transparent"
      />
      {here && (
        <svg
          className={cn(
            'plan-ants pointer-events-none absolute -left-[7px] -top-[7px] h-[calc(100%+14px)] w-[calc(100%+14px)] overflow-visible',
            (here === 'stopped' || here === 'queued') && 'still'
          )}
          aria-hidden
        >
          <rect
            x={0}
            y={0}
            width="100%"
            height="100%"
            rx={13}
            stroke={antsColor}
          />
        </svg>
      )}
      {tag && (
        <div
          className={cn(
            'absolute -top-7 left-0 whitespace-nowrap rounded-full px-2 py-0.5 text-[10.5px] font-semibold text-white shadow',
            here === 'stopped'
              ? 'bg-error'
              : here === 'queued'
                ? 'bg-md-outline'
                : here === 'pausing'
                  ? 'bg-warning'
                  : 'bg-brand'
          )}
        >
          {tag}
        </div>
      )}
      <div className="flex items-center justify-between gap-2 text-[10.5px] font-semibold uppercase tracking-wider text-low">
        <span>{t('plan.step', { n: step.n })}</span>
        {pill}
      </div>
      <div
        className={cn(
          'mt-1 text-[13px] font-semibold leading-snug text-high',
          step.state === 'cut' && 'line-through'
        )}
      >
        {step.title}
      </div>
      <div className="mt-1 flex items-center justify-between gap-2 text-[11px] text-low">
        <span className="truncate">
          {step.files.length > 0
            ? t('plan.files', { count: step.files.length })
            : ''}
        </span>
        {step.state === 'active' && step.started_at && here !== 'stopped' && (
          <Elapsed since={step.started_at} />
        )}
      </div>
      {(step.state === 'pending' || step.state === 'cut') && (
        <button
          type="button"
          className="nodrag absolute bottom-1.5 right-1.5 flex h-5 w-5 items-center justify-center rounded border border-md-outline-variant bg-panel text-low hover:text-high"
          title={step.state === 'cut' ? t('plan.restore') : t('plan.cut')}
          aria-label={step.state === 'cut' ? t('plan.restore') : t('plan.cut')}
          onClick={(e) => {
            e.stopPropagation();
            onCut(step.n, step.state !== 'cut');
          }}
        >
          {step.state === 'cut' ? (
            <Undo2 className="h-3 w-3" />
          ) : (
            <X className="h-3 w-3" />
          )}
        </button>
      )}
    </div>
  );
}

const nodeTypes = { step: StepNode };

// ---------------------------------------------------------------------------

const RUN_TONE: Record<RunLabel, string> = {
  running: 'text-brand',
  pausing: 'text-warning',
  paused: 'text-low',
  halted: 'text-error',
  idle: 'text-low',
  finished: 'text-success',
};

function Transport({
  workspaceId,
  run,
  pauseRequested,
  onError,
}: {
  workspaceId: string;
  run: RunState;
  pauseRequested: boolean;
  onError: (msg: string | null) => void;
}) {
  const { t } = useTranslation('common');
  const [busy, setBusy] = useState(false);
  const [confirmBack, setConfirmBack] = useState(false);
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    onError(null);
    try {
      await fn();
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const btn =
    'flex h-8 w-8 items-center justify-center rounded-full text-normal transition-colors hover:bg-secondary disabled:cursor-default disabled:opacity-30 disabled:hover:bg-transparent';
  const target = run.backTarget;

  return (
    <>
      <div
        role="toolbar"
        aria-label={t('plan.toolbar')}
        className="nodrag nopan flex items-center gap-0.5 rounded-full border border-md-outline-variant bg-panel p-1 shadow-lg"
      >
        <span
          className={cn(
            'flex items-center gap-1.5 whitespace-nowrap px-2.5 text-xs font-medium',
            RUN_TONE[run.label]
          )}
        >
          <span
            className={cn(
              'h-2 w-2 rounded-full bg-current',
              run.label === 'running' && 'animate-pulse'
            )}
          />
          {t(`plan.run.${run.label}`)}
        </span>
        <span className="mx-1 h-5 w-px bg-md-outline-variant" />
        <button
          type="button"
          className={cn(btn, confirmBack && 'bg-error/15 text-error')}
          disabled={busy || !target}
          title={
            target
              ? t('plan.btn.back', { n: target.n })
              : t('plan.btn.backNone')
          }
          aria-label={t('plan.btn.backNone')}
          aria-expanded={confirmBack}
          onClick={() => setConfirmBack((v) => !v)}
        >
          <SkipBack className="h-4 w-4" />
        </button>
        <button
          type="button"
          className={cn(btn, 'text-error')}
          disabled={busy || !run.canStop}
          title={t('plan.btn.stop')}
          aria-label={t('plan.btn.stop')}
          onClick={() => act(() => planApi.stop(workspaceId))}
        >
          <Square className="h-3.5 w-3.5 fill-current" />
        </button>
        <button
          type="button"
          className={cn(btn, pauseRequested && 'bg-warning/15 text-warning')}
          disabled={busy || !run.canPauseAfter}
          aria-pressed={pauseRequested}
          title={t('plan.btn.pauseAfter')}
          aria-label={t('plan.btn.pauseAfter')}
          onClick={() => act(() => planApi.pause(workspaceId, !pauseRequested))}
        >
          <Pause className="h-4 w-4" />
        </button>
        <button
          type="button"
          className={cn(
            btn,
            run.canPlay && 'bg-success text-white hover:bg-success/90'
          )}
          disabled={busy || !run.canPlay}
          title={t('plan.btn.play')}
          aria-label={t('plan.btn.play')}
          onClick={() => act(() => planApi.play(workspaceId))}
        >
          {busy ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Play className="h-4 w-4 fill-current" />
          )}
        </button>
      </div>
      {confirmBack && target && (
        <div
          role="dialog"
          aria-label={t('plan.revert.title', { n: target.n })}
          className="nodrag nopan w-[min(340px,80vw)] rounded-[10px] border border-error bg-panel p-3.5 text-[12.5px] text-normal shadow-lg"
        >
          <div className="text-sm font-semibold text-high">
            {t('plan.revert.title', { n: target.n })}
          </div>
          <div className="mt-0.5 text-low">{target.title}</div>
          <ul className="mt-2 flex list-disc flex-col gap-1 pl-4">
            {run.canStop && <li>{t('plan.revert.stop')}</li>}
            <li>{t('plan.revert.discard')}</li>
            <li>{t('plan.revert.after')}</li>
          </ul>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              className="rounded-md bg-error px-3 py-1 text-xs font-semibold text-white"
              disabled={busy}
              onClick={() =>
                act(async () => {
                  await planApi.revert(workspaceId, target.n);
                  setConfirmBack(false);
                })
              }
            >
              {t('plan.revert.confirm')}
            </button>
            <button
              type="button"
              className="rounded-md border border-md-outline-variant px-3 py-1 text-xs"
              onClick={() => setConfirmBack(false)}
            >
              {t('plan.cancel')}
            </button>
          </div>
        </div>
      )}
    </>
  );
}

function Hud({ plan, run }: { plan: PlanSnapshot; run: RunState }) {
  const { t } = useTranslation('common');
  const { fitView } = useReactFlow();
  const hereStep = run.here
    ? plan.steps.find((s) => s.n === run.here?.n)
    : undefined;
  const where = !hereStep
    ? t('plan.hud.none')
    : run.here?.kind === 'queued'
      ? t('plan.hud.queued', { n: hereStep.n })
      : t('plan.hud.active', {
          n: hereStep.n,
          total: run.total,
          title: hereStep.title,
        });
  const pct = run.total ? Math.round((run.done / run.total) * 100) : 0;
  return (
    <div className="nodrag nopan w-[250px] rounded-[10px] border border-md-outline-variant bg-panel p-3 text-xs shadow-lg">
      <div className="text-normal">{where}</div>
      <div className="mt-2 h-1 overflow-hidden rounded bg-secondary">
        <div className="h-full bg-brand" style={{ width: `${pct}%` }} />
      </div>
      <div className="mt-2 flex items-center justify-between text-low">
        <span className="tabular-nums">
          {t('plan.hud.progress', { done: run.done, total: run.total })}
        </span>
        {hereStep && (
          <button
            type="button"
            className="flex items-center gap-1 rounded border border-md-outline-variant px-2 py-0.5 text-normal hover:bg-secondary"
            onClick={() =>
              fitView({
                nodes: [{ id: `step-${hereStep.n}` }],
                duration: 400,
                maxZoom: 1.1,
                padding: 0.6,
              })
            }
          >
            <Crosshair className="h-3 w-3" />
            {t('plan.hud.focus')}
          </button>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function FileList({ files, before }: { files: string[]; before?: string[] }) {
  const removed = before ? before.filter((f) => !files.includes(f)) : [];
  return (
    <ul className="flex flex-col gap-0.5 font-ibm-plex-mono text-[11px]">
      {files.map((f) => (
        <li
          key={f}
          className={cn(
            'break-all',
            before && !before.includes(f) ? 'text-success' : 'text-normal'
          )}
        >
          {before && !before.includes(f) ? '+ ' : ''}
          {f}
        </li>
      ))}
      {removed.map((f) => (
        <li key={f} className="break-all text-low line-through">
          − {f}
        </li>
      ))}
    </ul>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-low">
      {children}
    </div>
  );
}

function RequestBox({
  label,
  button,
  onSend,
}: {
  label: string;
  button: string;
  onSend: (text: string) => Promise<void>;
}) {
  const { t } = useTranslation('common');
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const send = async () => {
    const text = draft.trim();
    if (!text || busy) return;
    setBusy(true);
    try {
      await onSend(text);
      setDraft('');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col gap-1.5">
      <Label>{label}</Label>
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            void send();
          }
        }}
        placeholder={t('plan.panel.placeholder')}
        className="min-h-[64px] w-full resize-y rounded-md border border-md-outline-variant bg-secondary px-2 py-1.5 text-[12.5px] text-high outline-none focus:border-brand"
      />
      <div className="flex items-center justify-between gap-2 text-[11px] text-low">
        <span>{t('plan.panel.hint')}</span>
        <button
          type="button"
          disabled={!draft.trim() || busy}
          onClick={() => void send()}
          className="shrink-0 rounded-md bg-brand px-3 py-1 text-xs font-semibold text-white disabled:opacity-40"
        >
          {button}
        </button>
      </div>
    </div>
  );
}

function ProposalView({
  step,
  rev,
  proposal,
  workspaceId,
  onError,
}: {
  step: PlanStep;
  rev: PlanStepRevision;
  proposal: StepProposal;
  workspaceId: string;
  onError: (msg: string | null) => void;
}) {
  const { t } = useTranslation('common');
  const [asking, setAsking] = useState(false);
  const act = async (fn: () => Promise<unknown>) => {
    onError(null);
    try {
      await fn();
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <div className="flex flex-col gap-2.5 rounded-lg border border-warning bg-warning/10 p-3">
      <div className="flex items-center justify-between text-[12.5px] font-semibold text-high">
        <span>{t('plan.rev.proposal', { v: step.version + 1 })}</span>
        <Pill tone="warn">{t('plan.rev.round', { round: rev.round })}</Pill>
      </div>
      <div className="italic text-normal">
        {t('plan.rev.asked', { request: rev.request })}
      </div>
      {proposal.changes.length > 0 && (
        <div>
          <Label>{t('plan.rev.changes')}</Label>
          <ul className="list-disc pl-4 text-normal">
            {proposal.changes.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </div>
      )}
      <div>
        <Label>{t('plan.panel.willDo')}</Label>
        {proposal.summary !== step.summary && (
          <p className="text-low line-through">{step.summary}</p>
        )}
        <p className="text-high">{proposal.summary}</p>
      </div>
      <div>
        <Label>{t('plan.panel.files')}</Label>
        <FileList files={proposal.files} before={step.files} />
      </div>
      {proposal.verify && proposal.verify !== step.verify && (
        <div>
          <Label>{t('plan.panel.verify')}</Label>
          <div className="rounded border border-md-outline-variant bg-secondary px-2 py-1 font-ibm-plex-mono text-[11px]">
            {proposal.verify}
          </div>
        </div>
      )}
      {proposal.impact && (
        <div>
          <Label>{t('plan.rev.impact')}</Label>
          <p className="text-normal">{proposal.impact}</p>
        </div>
      )}
      {asking ? (
        <RequestBox
          label={t('plan.rev.iterateLabel')}
          button={t('plan.rev.iterateSend')}
          onSend={async (text) => {
            await act(() => planApi.requestRevision(workspaceId, step.n, text));
            setAsking(false);
          }}
        />
      ) : (
        <div className="flex flex-wrap gap-1.5">
          <button
            type="button"
            className="rounded-md bg-brand px-3 py-1 text-xs font-semibold text-white"
            onClick={() => act(() => planApi.acceptRevision(rev.id))}
          >
            {t('plan.rev.accept', { v: step.version + 1 })}
          </button>
          <button
            type="button"
            className="rounded-md border border-md-outline-variant bg-panel px-3 py-1 text-xs"
            onClick={() => setAsking(true)}
          >
            {t('plan.rev.iterate')}
          </button>
          <button
            type="button"
            className="rounded-md border border-md-outline-variant bg-panel px-3 py-1 text-xs"
            onClick={() => act(() => planApi.discardRevision(rev.id))}
          >
            {t('plan.rev.discard')}
          </button>
        </div>
      )}
    </div>
  );
}

function StepPanel({
  plan,
  step,
  workspaceId,
  onClose,
}: {
  plan: PlanSnapshot;
  step: PlanStep;
  workspaceId: string;
  onClose: () => void;
}) {
  const { t } = useTranslation('common');
  const [error, setError] = useState<string | null>(null);
  const revs = plan.revisions.filter((r) => r.n === step.n);
  const open = [...revs]
    .reverse()
    .find((r) => r.status === 'requested' || r.status === 'proposed');
  const lastFailed = [...revs].reverse().find((r) => r.status !== 'discarded');
  const history = revs.filter((r) =>
    ['accepted', 'delivered', 'acked'].includes(r.status)
  );
  const sendRevision = async (text: string) => {
    setError(null);
    try {
      await planApi.requestRevision(workspaceId, step.n, text);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div
      className="nodrag nopan nowheel flex w-[min(360px,80vw)] flex-col gap-3 rounded-[10px] border border-border-strong bg-panel p-3.5 text-[12.5px] text-normal shadow-xl"
      onKeyDown={(e) => e.stopPropagation()}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="text-sm font-semibold leading-snug text-high">
          {t('plan.step', { n: step.n })} · {step.title}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Pill tone={step.version > 1 ? 'run' : 'mute'}>
            {t('plan.version', { v: step.version })}
          </Pill>
          <button
            type="button"
            className="rounded p-0.5 text-low hover:text-high"
            aria-label={t('plan.panel.close')}
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      {open?.status === 'requested' ? (
        <div className="flex flex-col gap-1.5 rounded-lg border border-dashed border-warning bg-warning/10 p-3">
          <div className="flex items-center justify-between text-[12.5px] font-semibold text-high">
            <span>{t('plan.rev.preparing', { v: step.version + 1 })}</span>
            <Loader2 className="h-3.5 w-3.5 animate-spin text-warning" />
          </div>
          <div className="italic text-normal">"{open.request}"</div>
          <div className="text-[11px] text-low">
            {t('plan.rev.preparingHint')}
          </div>
        </div>
      ) : open?.status === 'proposed' && open.proposal ? (
        <ProposalView
          step={step}
          rev={open}
          proposal={open.proposal}
          workspaceId={workspaceId}
          onError={setError}
        />
      ) : (
        <>
          {lastFailed?.status === 'failed' && (
            <div className="rounded-md border border-error/40 bg-error/10 px-2.5 py-2 text-error">
              {t('plan.rev.failed', { error: lastFailed.error ?? '' })}
            </div>
          )}
          <div>
            <Label>
              {step.state === 'done'
                ? t('plan.panel.did')
                : t('plan.panel.willDo')}
            </Label>
            <p className="whitespace-pre-wrap text-high">{step.summary}</p>
          </div>
          {step.files.length > 0 && (
            <div>
              <Label>{t('plan.panel.files')}</Label>
              <FileList files={step.files} />
            </div>
          )}
          {step.verify && (
            <div>
              <Label>{t('plan.panel.verify')}</Label>
              <div className="rounded border border-md-outline-variant bg-secondary px-2 py-1 font-ibm-plex-mono text-[11px]">
                {step.verify}
              </div>
            </div>
          )}
        </>
      )}

      {history.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <Label>{t('plan.history.title')}</Label>
          {[...history].reverse().map((r) => (
            <div key={r.id} className="border-l-2 border-brand pl-2">
              <div className="text-normal">"{r.request}"</div>
              <div
                className={cn(
                  'text-[11px]',
                  r.status === 'acked'
                    ? 'font-semibold text-success'
                    : 'text-low'
                )}
              >
                {r.target_n !== null && r.target_n !== r.n
                  ? t('plan.history.correction', { n: r.target_n })
                  : t(`plan.history.${r.status}`)}
              </div>
            </div>
          ))}
        </div>
      )}

      {!open && step.state !== 'cut' && (
        <RequestBox
          label={t('plan.panel.modify')}
          button={t('plan.panel.send')}
          onSend={sendRevision}
        />
      )}
      {error && <div className="text-[11.5px] text-error">{error}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------

function PlanCanvas({
  plan,
  workspaceId,
  agentRunning,
}: {
  plan: PlanSnapshot;
  workspaceId: string;
  agentRunning: boolean;
}) {
  const { t } = useTranslation('common');
  const { fitView } = useReactFlow();
  const [selectedN, setSelectedN] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  // En grupos angostos (al lado del chat) el plan se lee de arriba abajo.
  const boxRef = useRef<HTMLDivElement>(null);
  const [vertical, setVertical] = useState(false);
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) =>
      setVertical(entry.contentRect.width < 760)
    );
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const run = useMemo(
    () => deriveRunState(plan, agentRunning),
    [plan, agentRunning]
  );

  const onCut = useCallback(
    (n: number, cut: boolean) => {
      planApi.cut(workspaceId, n, cut).catch((e) => setError(String(e)));
    },
    [workspaceId]
  );

  const { nodes, edges } = useMemo(() => {
    const pos = layoutSteps(plan.steps, vertical);
    const deps = effectiveDeps(plan.steps);
    const openRev = (n: number) =>
      [...plan.revisions]
        .reverse()
        .find(
          (r) =>
            r.n === n && (r.status === 'requested' || r.status === 'proposed')
        ) ?? null;
    const hereOf = (s: PlanStep): Here => {
      if (run.here?.n !== s.n) return null;
      if (run.here.kind === 'queued') return 'queued';
      if (run.label === 'halted') return 'stopped';
      if (run.label === 'pausing') return 'pausing';
      return 'active';
    };
    const byN = new Map(plan.steps.map((s) => [s.n, s]));
    const nodes: Node<StepNodeData>[] = plan.steps.map((s) => ({
      id: `step-${s.n}`,
      type: 'step',
      position: pos.get(s.n) ?? { x: 0, y: 0 },
      data: {
        step: s,
        here: hereOf(s),
        revision: openRev(s.n),
        selected: selectedN === s.n,
        onCut,
        vertical,
      },
    }));
    const edges: Edge[] = [];
    deps.forEach((from, to) => {
      from.forEach((f) => {
        const src = byN.get(f);
        const dst = byN.get(to);
        const live =
          dst?.state === 'active' && src?.state === 'done' && agentRunning;
        edges.push({
          id: `e-${f}-${to}`,
          source: `step-${f}`,
          target: `step-${to}`,
          type: 'smoothstep',
          animated: live,
          style: {
            stroke:
              src?.state === 'done'
                ? live
                  ? 'hsl(var(--brand))'
                  : 'hsl(var(--_success))'
                : 'hsl(var(--outline-strong))',
            strokeDasharray:
              dst?.state === 'cut' || src?.state === 'cut' ? '4 4' : undefined,
            strokeWidth: 1.6,
          },
        });
      });
    });
    return { nodes, edges };
  }, [plan, run, selectedN, onCut, agentRunning, vertical]);

  // Reencuadrar cuando cambia la forma del plan.
  const shape = plan.steps.map((s) => s.n).join(',');
  useEffect(() => {
    const id = requestAnimationFrame(() =>
      fitView({ padding: 0.2, maxZoom: 1 })
    );
    return () => cancelAnimationFrame(id);
  }, [shape, vertical, fitView]);

  const selected = plan.steps.find((s) => s.n === selectedN) ?? null;

  return (
    <div ref={boxRef} className="relative h-full w-full">
      <style>{ANTS_CSS}</style>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        deleteKeyCode={null}
        onNodeClick={(_, node) =>
          setSelectedN((node.data as StepNodeData).step.n)
        }
        onPaneClick={() => setSelectedN(null)}
        fitView
        fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
        minZoom={0.3}
        maxZoom={1.6}
        className="bg-primary"
        proOptions={{ hideAttribution: true }}
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={20}
          size={1}
          className="!bg-primary"
        />
      </ReactFlow>
      <div
        className={cn('absolute left-3 z-10', vertical ? 'bottom-3' : 'top-3')}
      >
        <Hud plan={plan} run={run} />
      </div>
      <div className="absolute bottom-3 right-3 top-3 z-10 flex flex-col items-end gap-2.5 overflow-hidden">
        <Transport
          workspaceId={workspaceId}
          run={run}
          pauseRequested={plan.pause_requested}
          onError={setError}
        />
        {error && (
          <div className="max-w-[340px] rounded-md border border-error/40 bg-panel px-2.5 py-1.5 text-[11.5px] text-error shadow">
            {t('plan.error', { message: error })}
          </div>
        )}
        {selected && (
          <div className="min-h-0 overflow-y-auto rounded-[10px]">
            <StepPanel
              key={selected.n}
              plan={plan}
              step={selected}
              workspaceId={workspaceId}
              onClose={() => setSelectedN(null)}
            />
          </div>
        )}
      </div>
    </div>
  );
}

/** Pestaña "Plan" del workspace: el plan del agente como grafo en vivo. */
export function PlanPanel({ workspaceId }: { workspaceId: string }) {
  const { t } = useTranslation('common');
  const { plan, isLoading } = usePlanStream(workspaceId);
  const { activeWorkspaces, archivedWorkspaces } = useWorkspaceContext();
  const agentRunning = !!(
    activeWorkspaces.find((w) => w.id === workspaceId) ??
    archivedWorkspaces.find((w) => w.id === workspaceId)
  )?.isRunning;

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-sm text-low">
        <Loader2 className="h-4 w-4 animate-spin" />
        {t('plan.loading')}
      </div>
    );
  }
  if (!plan || plan.steps.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <div className="max-w-md text-center">
          <div className="text-sm font-semibold text-high">
            {t('plan.empty.title')}
          </div>
          <p className="mt-1.5 text-sm text-low">{t('plan.empty.body')}</p>
        </div>
      </div>
    );
  }
  return (
    <ReactFlowProvider>
      <PlanCanvas
        plan={plan}
        workspaceId={workspaceId}
        agentRunning={agentRunning}
      />
    </ReactFlowProvider>
  );
}
