export type Brief = {
  objective: string;
  scope: string[];
  outOfScope: string[];
  acceptance: string[];
  constraints: string[];
  unknowns: string[];
};

export type TaskSpec = {
  id: string;
  title: string;
  instructions: string;
  acceptance: string[];
  dependsOn: string[];
  mode: 'research' | 'code';
  provider?: string;
  model?: string;
};

export type Task = TaskSpec & {
  status: 'pending' | 'running' | 'review' | 'done' | 'failed' | 'interrupted';
  runId?: string;
  output?: string;
  worktree?: string;
};

export type State = {
  version: 1;
  // Revision tracks the brief and plan, not execution progress.
  revision: number;
  approvedRevision: number | null;
  brief: Brief | null;
  tasks: Task[];
};

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Expected an object.');
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${field} must be a nonempty string.`);
  }
  return value;
}

function strings(value: unknown, field: string, required = false): string[] {
  if (!Array.isArray(value) || (required && value.length === 0)) {
    const kind = required ? 'a nonempty' : 'an';
    throw new Error(`${field} must be ${kind} array.`);
  }
  return value.map((item) => text(item, field));
}

function parseBrief(value: unknown): Brief {
  const brief = record(value);
  return {
    objective: text(brief.objective, 'objective'),
    scope: strings(brief.scope, 'scope'),
    outOfScope: strings(brief.outOfScope, 'outOfScope'),
    acceptance: strings(brief.acceptance, 'acceptance', true),
    constraints: strings(brief.constraints, 'constraints'),
    unknowns: strings(brief.unknowns, 'unknowns'),
  };
}

function parseSpec(value: unknown): TaskSpec {
  const task = record(value);
  if (task.mode !== 'research' && task.mode !== 'code') {
    throw new Error('Task mode must be research or code.');
  }
  return {
    id: text(task.id, 'task id'),
    title: text(task.title, 'task title'),
    instructions: text(task.instructions, 'task instructions'),
    acceptance: strings(task.acceptance, 'task acceptance', true),
    dependsOn: strings(task.dependsOn, 'dependencies'),
    mode: task.mode,
    ...(task.provider === undefined
      ? {}
      : { provider: text(task.provider, 'provider') }),
    ...(task.model === undefined ? {} : { model: text(task.model, 'model') }),
  };
}

function validateGraph(tasks: TaskSpec[]): void {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  if (byId.size !== tasks.length) throw new Error('Task ids must be unique.');
  const visiting = new Set<string>();
  const visited = new Set<string>();
  function visit(id: string): void {
    if (visiting.has(id)) throw new Error('Task dependencies contain a cycle.');
    if (visited.has(id)) return;
    const task = byId.get(id);
    if (!task) throw new Error(`Unknown dependency: ${id}.`);
    visiting.add(id);
    task.dependsOn.forEach(visit);
    visiting.delete(id);
    visited.add(id);
  }
  tasks.forEach((task) => visit(task.id));
}

export function initialState(): State {
  return {
    version: 1,
    revision: 0,
    approvedRevision: null,
    brief: null,
    tasks: [],
  };
}

export function validateState(value: unknown): State {
  const raw = record(value);
  if (
    raw.version !== 1 ||
    !Number.isSafeInteger(raw.revision) ||
    (raw.revision as number) < 0 ||
    (raw.approvedRevision !== null && raw.approvedRevision !== raw.revision) ||
    !Array.isArray(raw.tasks)
  ) {
    throw new Error('Invalid Fluke state version or revision.');
  }
  const brief = raw.brief === null ? null : parseBrief(raw.brief);
  const tasks: Task[] = raw.tasks.map((value) => {
    const task = record(value);
    const statuses: Task['status'][] = [
      'pending',
      'running',
      'review',
      'done',
      'failed',
      'interrupted',
    ];
    if (!statuses.includes(task.status as Task['status'])) {
      throw new Error('Invalid task status.');
    }
    if (task.status !== 'pending') text(task.runId, 'run id');
    if (task.output !== undefined && typeof task.output !== 'string') {
      throw new Error('Task output must be a string.');
    }
    if (
      ['review', 'done', 'failed'].includes(task.status as string) &&
      typeof task.output !== 'string'
    ) {
      throw new Error('A settled task must have output.');
    }
    return {
      ...parseSpec(task),
      status: task.status as Task['status'],
      ...(task.runId === undefined
        ? {}
        : { runId: text(task.runId, 'run id') }),
      ...(task.output === undefined ? {} : { output: task.output as string }),
      ...(task.worktree === undefined
        ? {}
        : { worktree: text(task.worktree, 'worktree') }),
    };
  });
  validateGraph(tasks);
  if (tasks.length && !brief) throw new Error('A plan requires a brief.');
  if (raw.approvedRevision !== null && (!brief || !tasks.length)) {
    throw new Error('Approval requires a brief and a nonempty plan.');
  }
  for (const task of tasks) {
    if (['running', 'review', 'done'].includes(task.status)) {
      if (raw.approvedRevision !== raw.revision) {
        throw new Error('Executed tasks require the approved revision.');
      }
      if (
        task.dependsOn.some(
          (id) =>
            tasks.find((dependency) => dependency.id === id)?.status !== 'done'
        )
      ) {
        throw new Error(`Task ${task.id} has unfinished dependencies.`);
      }
    }
  }
  return {
    version: 1,
    revision: raw.revision as number,
    approvedRevision: raw.approvedRevision as number | null,
    brief,
    tasks,
  };
}

function editable(state: State): State {
  const next = validateState(state);
  if (next.tasks.some((task) => task.status === 'running')) {
    throw new Error('Stop running tasks before changing the brief or plan.');
  }
  if (next.revision === Number.MAX_SAFE_INTEGER) {
    throw new Error('Plan revision limit reached.');
  }
  return next;
}

export function saveBrief(state: State, brief: Brief): State {
  const next = editable(state);
  return {
    ...next,
    revision: next.revision + 1,
    approvedRevision: null,
    brief: parseBrief(brief),
    tasks: [],
  };
}

export function savePlan(state: State, tasks: TaskSpec[]): State {
  const next = editable(state);
  if (!next.brief) throw new Error('A plan requires a brief.');
  if (!Array.isArray(tasks) || !tasks.length) {
    throw new Error('A plan requires at least one task.');
  }
  const planned: Task[] = tasks.map((task) => ({
    ...parseSpec(task),
    status: 'pending',
  }));
  validateGraph(planned);
  return {
    ...next,
    revision: next.revision + 1,
    approvedRevision: null,
    tasks: planned,
  };
}

export function approve(state: State): State {
  const next = validateState(state);
  if (!next.brief || !next.tasks.length) {
    throw new Error('Approval requires a brief and a nonempty plan.');
  }
  return { ...next, approvedRevision: next.revision };
}

export function readyTasks(state: State): Task[] {
  const next = validateState(state);
  if (next.approvedRevision !== next.revision) return [];
  const done = new Set(
    next.tasks.filter((task) => task.status === 'done').map((task) => task.id)
  );
  return next.tasks.filter(
    (task) =>
      ['pending', 'failed', 'interrupted'].includes(task.status) &&
      task.dependsOn.every((id) => done.has(id))
  );
}

function taskById(state: State, id: string): Task {
  const task = state.tasks.find((task) => task.id === id);
  if (!task) throw new Error(`Unknown task: ${id}.`);
  return task;
}

export function startTask(
  state: State,
  id: string,
  runId: string,
  worktree?: string
): State {
  const next = validateState(state);
  const task = taskById(next, id);
  if (!readyTasks(next).some((candidate) => candidate.id === id)) {
    throw new Error(`Task ${id} is not ready to run.`);
  }
  text(runId, 'run id');
  if (runId === task.runId) throw new Error('A retry requires a new run id.');
  if (worktree !== undefined) text(worktree, 'worktree');
  return {
    ...next,
    tasks: next.tasks.map((candidate) =>
      candidate.id === id
        ? {
            ...parseSpec(candidate),
            status: 'running',
            runId,
            ...(worktree === undefined ? {} : { worktree }),
          }
        : candidate
    ),
  };
}

export function settleTask(
  state: State,
  id: string,
  runId: string,
  result: { output: string; success: boolean }
): State {
  const next = validateState(state);
  const task = taskById(next, id);
  if (task.status !== 'running' || task.runId !== runId) {
    throw new Error('Result does not match the active task run.');
  }
  if (
    typeof result.output !== 'string' ||
    typeof result.success !== 'boolean'
  ) {
    throw new Error('Invalid task result.');
  }
  return {
    ...next,
    tasks: next.tasks.map((candidate) =>
      candidate.id === id
        ? {
            ...candidate,
            status: result.success ? 'review' : 'failed',
            output: result.output,
          }
        : candidate
    ),
  };
}

export function acceptTask(state: State, id: string): State {
  const next = validateState(state);
  if (taskById(next, id).status !== 'review') {
    throw new Error('Only a task awaiting review can be accepted.');
  }
  return {
    ...next,
    tasks: next.tasks.map((task) =>
      task.id === id ? { ...task, status: 'done' } : task
    ),
  };
}

export function recoverState(state: State): State {
  const next = validateState(state);
  return {
    ...next,
    tasks: next.tasks.map((task) =>
      task.status === 'running' ? { ...task, status: 'interrupted' } : task
    ),
  };
}
