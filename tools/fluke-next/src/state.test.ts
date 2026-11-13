import assert from 'node:assert/strict';
import test from 'node:test';
import {
  acceptTask,
  approve,
  initialState,
  readyTasks,
  recoverState,
  saveBrief,
  savePlan,
  settleTask,
  startTask,
  validateState,
  type Brief,
  type TaskSpec,
} from './state.ts';

const brief: Brief = {
  objective: 'Build a local project workspace',
  scope: ['Brief and task execution'],
  outOfScope: ['Publishing'],
  acceptance: ['A task result needs human acceptance'],
  constraints: ['Preserve failed run output'],
  unknowns: [],
};

function spec(id: string, dependsOn: string[] = []): TaskSpec {
  return {
    id,
    title: `Task ${id}`,
    instructions: 'Implement the assigned requirement.',
    acceptance: ['Return evidence for the assigned requirement'],
    dependsOn,
    mode: 'code',
  };
}

function planned() {
  return savePlan(saveBrief(initialState(), brief), [
    spec('first'),
    spec('second', ['first']),
  ]);
}

test('execution requires approval of the exact plan revision', () => {
  const state = planned();
  assert.deepEqual(readyTasks(state), []);
  assert.throws(() => startTask(state, 'first', 'run-1'), /not ready/);
  const approved = approve(state);
  assert.equal(approved.approvedRevision, approved.revision);
  const changed = savePlan(approved, [spec('replacement')]);
  assert.equal(changed.approvedRevision, null);
  assert.equal(changed.revision, approved.revision + 1);
  assert.throws(() => startTask(changed, 'replacement', 'run-2'), /not ready/);
  assert.throws(
    () => validateState({ ...changed, approvedRevision: approved.revision }),
    /revision/
  );
});

test('a successful worker result does not unlock dependent tasks', () => {
  const running = startTask(approve(planned()), 'first', 'run-1', '/workspace');
  const review = settleTask(running, 'first', 'run-1', {
    output: 'Implemented; check evidence attached.',
    success: true,
  });
  assert.equal(review.tasks[0].status, 'review');
  assert.deepEqual(readyTasks(review), []);
  assert.throws(() => startTask(review, 'second', 'run-2'), /not ready/);
  const accepted = acceptTask(review, 'first');
  assert.deepEqual(readyTasks(accepted).map((task) => task.id), ['second']);
  assert.equal(accepted.revision, running.revision);
  assert.equal(accepted.tasks[0].worktree, '/workspace');
});

test('stale and duplicate completions cannot settle another run', () => {
  const running = startTask(approve(planned()), 'first', 'run-1');
  const result = { output: 'Temporary provider failure', success: false };
  assert.throws(() => settleTask(running, 'first', 'wrong', result), /active/);
  const failed = settleTask(running, 'first', 'run-1', result);
  assert.equal(failed.tasks[0].output, result.output);
  assert.throws(() => settleTask(failed, 'first', 'run-1', result), /active/);
  assert.throws(() => acceptTask(failed, 'first'), /awaiting review/);
  assert.throws(() => startTask(failed, 'first', 'run-1'), /new run id/);
  const retry = startTask(failed, 'first', 'run-2');
  assert.equal(retry.tasks[0].output, undefined);
  assert.throws(() => settleTask(retry, 'first', 'run-1', result), /active/);
});

test('recovery makes interrupted work explicit without completing it', () => {
  const running = startTask(approve(planned()), 'first', 'run-1', '/workspace');
  const recovered = recoverState(running);
  assert.equal(recovered.tasks[0].status, 'interrupted');
  assert.equal(recovered.tasks[0].runId, 'run-1');
  assert.equal(recovered.tasks[0].worktree, '/workspace');
  assert.equal(running.tasks[0].status, 'running');
  assert.deepEqual(readyTasks(recovered).map((task) => task.id), ['first']);
  const retry = startTask(recovered, 'first', 'run-2');
  assert.equal(retry.tasks[0].status, 'running');
});

test('plans reject duplicate ids, unknown dependencies and cycles', () => {
  const state = saveBrief(initialState(), brief);
  assert.throws(() => savePlan(state, [spec('a'), spec('a')]), /unique/);
  assert.throws(() => savePlan(state, [spec('a', ['missing'])]), /Unknown/);
  assert.throws(() => savePlan(state, [spec('a', ['a'])]), /cycle/);
  assert.throws(
    () => savePlan(state, [spec('a', ['b']), spec('b', ['a'])]),
    /cycle/
  );
  assert.throws(
    () => savePlan(state, [{ ...spec('a'), acceptance: [] }]),
    /nonempty/
  );
  assert.throws(() => savePlan(initialState(), [spec('a')]), /brief/);
  assert.throws(
    () => saveBrief(initialState(), { ...brief, acceptance: [] }),
    /nonempty/
  );
  assert.throws(() => approve(state), /nonempty plan/);
});

test('running work blocks edits; a new brief invalidates the plan', () => {
  const state = approve(planned());
  const running = startTask(state, 'first', 'run-1');
  assert.throws(() => saveBrief(running, brief), /Stop running/);
  assert.throws(() => savePlan(running, [spec('new')]), /Stop running/);
  const changed = saveBrief(state, { ...brief, objective: 'A different goal' });
  assert.deepEqual(changed.tasks, []);
  assert.equal(changed.approvedRevision, null);
});

test('validation rejects corrupt state and returns detached data', () => {
  const state = approve(planned());
  assert.throws(() => validateState({ ...state, version: 2 }), /version/);
  assert.throws(() => validateState({ ...state, revision: -1 }), /revision/);
  assert.throws(() => validateState({ ...state, brief: null }), /brief/);
  assert.throws(
    () =>
      validateState({
        ...state,
        tasks: [{ ...state.tasks[0], status: 'running' }],
      }),
    /run id/
  );
  assert.throws(
    () =>
      validateState({
        ...state,
        tasks: [
          state.tasks[0],
          {
            ...state.tasks[1],
            status: 'done',
            runId: 'run-2',
            output: 'Claimed done',
          },
        ],
      }),
    /unfinished dependencies/
  );
  const copy = validateState(state);
  copy.tasks[0].acceptance.push('New criterion');
  copy.brief!.scope.push('New scope');
  assert.equal(state.tasks[0].acceptance.length, 1);
  assert.equal(state.brief!.scope.length, 1);
});
