import assert from 'node:assert/strict';
import test from 'node:test';
import { initialUsage, recordUsage, summarizeUsage } from './usage.ts';

const parent = { runId: 'run-1', source: 'parent' as const };
const worker = { ...parent, taskId: 'task-1', source: 'worker' as const };

function response(overrides: Record<string, unknown> = {}) {
  return {
    type: 'message_end',
    message: {
      role: 'assistant',
      provider: 'openai',
      model: 'example-model',
      responseId: 'response-1',
      timestamp: 1_000,
      content: [{ type: 'text', text: 'Done' }],
      stopReason: 'stop',
      usage: {
        input: 10,
        output: 4,
        cacheRead: 2,
        cacheWrite: 1,
        totalTokens: 17,
        cost: {
          input: 0.01,
          output: 0.02,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0.03,
        },
      },
      ...overrides,
    },
  };
}

test('aggregates parent and workers, while replay never double counts', () => {
  const empty = initialUsage();
  const first = recordUsage(empty, response(), parent);
  const duplicate = recordUsage(first, response(), parent);
  const ledger = recordUsage(
    duplicate,
    response({ provider: 'anthropic', responseModel: 'effective-model' }),
    worker
  );
  const summary = summarizeUsage(ledger);
  assert.equal(empty.entries.length, 0);
  assert.equal(first.entries.length, 1);
  assert.equal(duplicate.entries.length, 1);
  assert.deepEqual(summary.totals, {
    messages: 2,
    input: 20,
    output: 8,
    cacheRead: 4,
    cacheWrite: 2,
    totalTokens: 34,
    estimatedUsd: 0.06,
    messagesWithoutEstimate: 0,
  });
  assert.equal(summary.byProvider.length, 2);
  assert.equal(summary.byModel[1].model, 'effective-model');
  assert.equal(summary.byTask[1].taskId, 'task-1');
  assert.deepEqual(summary.billing, { status: 'unknown' });
  assert.deepEqual(summary.quota, { status: 'unknown' });
  assert.deepEqual(JSON.parse(JSON.stringify(ledger)), ledger);
});

test('ignores deltas, user/tool messages and malformed envelopes', () => {
  const ledger = initialUsage();
  for (const event of [
    null,
    [],
    { type: 'message_update', message: response().message },
    response({ role: 'toolResult' }),
    response({ role: 'user' }),
    response({ provider: undefined }),
  ]) {
    assert.equal(recordUsage(ledger, event, parent), ledger);
  }
  assert.equal(summarizeUsage(ledger).totals.estimatedUsd, null);
});

test('unknown and malformed usage remain unknown instead of free', () => {
  let ledger = recordUsage(initialUsage(), response(), parent);
  ledger = recordUsage(
    ledger,
    response({ responseId: 'missing', usage: undefined }),
    worker
  );
  const summary = summarizeUsage(ledger);
  assert.equal(summary.totals.estimatedUsd, null);
  assert.equal(summary.totals.input, null);
  assert.equal(summary.totals.messagesWithoutEstimate, 1);
  assert.equal(summary.byTask[0].totals.estimatedUsd, 0.03);

  const invalid = recordUsage(
    initialUsage(),
    response({ usage: { input: -2, output: Infinity, cost: { total: NaN } } }),
    parent
  );
  assert.equal(summarizeUsage(invalid).totals.input, null);
  assert.equal(summarizeUsage(invalid).totals.output, null);
  assert.equal(summarizeUsage(invalid).totals.estimatedUsd, null);
});

test('a reported nominal zero is preserved without claiming zero billing', () => {
  const event = response();
  event.message.usage.cost.total = 0;
  const summary = summarizeUsage(recordUsage(initialUsage(), event, parent));
  assert.equal(summary.totals.estimatedUsd, 0);
  assert.equal(summary.billing.status, 'unknown');
});

test('fallback identity survives serialization and separates later attempts', () => {
  const event = response({ responseId: undefined });
  const first = recordUsage(initialUsage(), event, worker);
  const restored = JSON.parse(JSON.stringify(first));
  const replayed = recordUsage(
    restored,
    JSON.parse(JSON.stringify(event)),
    worker
  );
  assert.equal(replayed.entries.length, 1);
  const later = recordUsage(
    replayed,
    response({ responseId: undefined, timestamp: 2_000 }),
    worker
  );
  assert.equal(later.entries.length, 2);
  assert.equal(summarizeUsage(later).totals.estimatedUsd, 0.06);
});

test('corrected final snapshots replace numbers and account for failed attempts', () => {
  const first = recordUsage(initialUsage(), response(), parent);
  const corrected = response();
  corrected.message.usage.input = 20;
  corrected.message.usage.cost.total = 0.05;
  const updated = recordUsage(first, corrected, parent);
  assert.equal(updated.entries.length, 1);
  assert.equal(summarizeUsage(updated).totals.estimatedUsd, 0.05);
  assert.equal(first.entries[0].estimatedUsd, 0.03);

  const failed = recordUsage(
    updated,
    response({ responseId: 'failed-attempt', stopReason: 'error' }),
    parent
  );
  assert.equal(failed.entries.length, 2);
  assert.equal(summarizeUsage(failed).totals.estimatedUsd, 0.08);
});

test('unsafe content without an ID is ignored instead of crashing ingestion', () => {
  const cyclic: unknown[] = [];
  cyclic.push(cyclic);
  const empty = initialUsage();
  assert.equal(
    recordUsage(
      empty,
      response({ responseId: undefined, content: cyclic }),
      parent
    ),
    empty
  );
});
