import type { PlanSnapshot, PlanStep } from 'shared/types';

export type RunLabel =
  | 'running'
  | 'pausing'
  | 'paused'
  | 'halted'
  | 'idle'
  | 'finished';

export interface RunState {
  label: RunLabel;
  /** Paso donde está el agente: en curso, o el que sigue si está frenado. */
  here: { n: number; kind: 'active' | 'queued' } | null;
  /** A dónde vuelve |<: el paso en curso, o el último terminado. */
  backTarget: PlanStep | null;
  canStop: boolean;
  canPauseAfter: boolean;
  canPlay: boolean;
  done: number;
  total: number;
}

export function deriveRunState(
  plan: PlanSnapshot,
  agentRunning: boolean
): RunState {
  const steps = [...plan.steps].sort((a, b) => a.n - b.n);
  const live = steps.filter((s) => s.state !== 'cut');
  const active = steps.find((s) => s.state === 'active') ?? null;
  const nextPending = steps.find((s) => s.state === 'pending') ?? null;
  const done = live.filter((s) => s.state === 'done').length;
  const allDone = live.length > 0 && done === live.length;

  let label: RunLabel;
  if (plan.status === 'halted') label = 'halted';
  else if (plan.status === 'paused') label = 'paused';
  else if (agentRunning) label = plan.pause_requested ? 'pausing' : 'running';
  else label = allDone ? 'finished' : 'idle';

  const here = active
    ? { n: active.n, kind: 'active' as const }
    : nextPending && label !== 'running' && label !== 'pausing'
      ? { n: nextPending.n, kind: 'queued' as const }
      : null;

  const lastDone = [...steps]
    .reverse()
    .find((s) => s.state === 'done' && s.has_checkpoint);
  const backTarget = active?.has_checkpoint ? active : (lastDone ?? null);

  return {
    label,
    here,
    backTarget,
    canStop: agentRunning,
    canPauseAfter: agentRunning,
    canPlay: !agentRunning && (!allDone || plan.status !== 'running'),
    done,
    total: live.length,
  };
}
