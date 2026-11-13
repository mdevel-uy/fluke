import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runWorker, type WorkerOptions } from './runner.ts';

// A protocol fixture, not a provider: these cases make no model/API calls.
const fixture = String.raw`
const send = (value) => process.stdout.write(JSON.stringify(value) + '\n');
const assistant = (text, stopReason = 'stop') => ({
  role: 'assistant', stopReason, content: [{ type: 'text', text }],
  usage: { totalTokens: 10, cost: { total: 0.001 } },
});
let buffer = '';
let keepAlive;
process.stdin.setEncoding('utf8');
process.stdin.on('end', () => { clearInterval(keepAlive); });
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    const command = JSON.parse(line);
    if (command.type !== 'prompt') continue;
    if (command.message === 'handled') {
      send({type:'response',id:command.id,success:true,data:{disposition:'handled'}});
      continue;
    }
    send({type:'response',id:command.id,success:true,data:{disposition:'started'}});
    if (command.message === 'malformed') {
      process.stdout.write('not json\n'); continue;
    }
    if (command.message === 'early-exit') { process.exit(0); }
    if (command.message === 'wait') { keepAlive = setInterval(() => {}, 1000); continue; }
    if (command.message === 'retry') {
      send({type:'agent_end',messages:[assistant('', 'error')]});
      send({type:'auto_retry_start',attempt:1});
    }
    const message = assistant(
      command.message === 'args' ? JSON.stringify(process.argv.slice(2)) : 'Final report\u2028kept',
      command.message === 'error' ? 'error' : command.message === 'aborted' ? 'aborted' : 'stop'
    );
    send({type:'message_end',message});
    send({type:'agent_end',messages:[message]});
    if (command.message === 'end-only') continue;
    send({type:'agent_settled'});
  }
});
`;

async function withWorker(
  run: (options: WorkerOptions) => Promise<void>
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'fluke-worker-fixture-'));
  const entry = join(directory, 'fixture with spaces.mjs');
  await writeFile(entry, fixture);
  try {
    await run({
      entry,
      cwd: directory,
      prompt: 'normal',
      mode: 'research',
      sessionDir: join(directory, 'sessions'),
      timeoutMs: 5000,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('waits for settled and process close; preserves Unicode and usage events', async () => {
  await withWorker(async (options) => {
    const events: unknown[] = [];
    const result = await runWorker({ ...options, onEvent: (event) => events.push(event) });
    assert.equal(result.success, true);
    assert.equal(result.cleanupConfirmed, true);
    assert.equal(result.output, 'Final report\u2028kept');
    assert.ok(events.some((event) => (event as { type: string }).type === 'message_end'));
  });
});

test('research has explicit tools and disables ambient MCP/resources', async () => {
  await withWorker(async (options) => {
    const result = await runWorker({ ...options, prompt: 'args' });
    assert.equal(result.success, true);
    const args = JSON.parse(result.output) as string[];
    assert.equal(args[args.indexOf('--tools') + 1], 'read');
    for (const flag of ['--no-mcp', '--no-extensions', '--no-skills', '--no-prompt-templates']) {
      assert.ok(args.includes(flag));
    }
    assert.ok(!args.includes('args'), 'prompt is transported only through stdin');
  });
});

test('code mode passes explicit provider/model and coding tools', async () => {
  await withWorker(async (options) => {
    const result = await runWorker({ ...options, prompt: 'args', mode: 'code', provider: 'provider', model: 'model' });
    const args = JSON.parse(result.output) as string[];
    assert.equal(args[args.indexOf('--tools') + 1], 'read,bash,edit,write');
    assert.equal(args[args.indexOf('--provider') + 1], 'provider');
    assert.equal(args[args.indexOf('--model') + 1], 'model');
  });
});

test('a retry after agent_end can still produce a successful final report', async () => {
  await withWorker(async (options) => {
    const result = await runWorker({ ...options, prompt: 'retry' });
    assert.equal(result.success, true);
  });
});

for (const scenario of ['handled', 'malformed', 'early-exit', 'error', 'aborted']) {
  test(`fails explicitly for ${scenario}`, async () => {
    await withWorker(async (options) => {
      const result = await runWorker({ ...options, prompt: scenario });
      assert.equal(result.success, false);
      assert.ok(result.error);
    });
  });
}

test('agent_end alone is not successful completion', async () => {
  await withWorker(async (options) => {
    const result = await runWorker({ ...options, prompt: 'end-only', timeoutMs: 1500 });
    assert.equal(result.success, false);
    assert.match(result.error ?? '', /time/i);
  });
});

test('cancellation closes a live worker', async () => {
  await withWorker(async (options) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 300);
    try {
      const result = await runWorker({ ...options, prompt: 'wait', signal: controller.signal });
      assert.equal(result.success, false);
      assert.match(result.error ?? '', /cancelled/);
    } finally {
      clearTimeout(timer);
    }
  });
});

test('an already aborted signal creates no worker', async () => {
  const result = await runWorker({
    entry: 'does-not-exist', cwd: 'does-not-exist', prompt: 'unused',
    mode: 'research', sessionDir: 'unused', signal: AbortSignal.abort(),
  });
  assert.equal(result.success, false);
  assert.match(result.error ?? '', /before start/);
});
