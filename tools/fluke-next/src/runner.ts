import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

export interface WorkerOptions {
  entry: string;
  cwd: string;
  prompt: string;
  provider?: string;
  model?: string;
  mode: 'research' | 'code';
  signal?: AbortSignal;
  sessionDir: string;
  onEvent?: (event: unknown) => void;
  timeoutMs?: number;
}

export interface WorkerResult {
  success: boolean;
  output: string;
  cleanupConfirmed: boolean;
  error?: string;
}

const MAX_RECORD_BYTES = 8 * 1024 * 1024;
const MAX_REPORT_CHARS = 128 * 1024;
const MAX_STDERR_CHARS = 4096;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** One owned Pi process. RPC acceptance and agent_end are not completion. */
export async function runWorker(options: WorkerOptions): Promise<WorkerResult> {
  if (options.signal?.aborted) {
    return {
      success: false,
      output: '',
      cleanupConfirmed: true,
      error: 'Worker cancelled before start.',
    };
  }
  const timeoutMs = options.timeoutMs ?? 30 * 60_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
    return {
      success: false,
      output: '',
      cleanupConfirmed: true,
      error: 'Invalid worker timeout.',
    };
  }
  const args = [
    options.entry,
    '--mode',
    'rpc',
    '--no-extensions',
    '--no-skills',
    '--no-prompt-templates',
    '--no-mcp',
    '--exclude-tools',
    'mcp__*',
    '--session-dir',
    options.sessionDir,
    '--tools',
    options.mode === 'research' ? 'read' : 'read,bash,edit,write',
  ];
  if (options.provider) args.push('--provider', options.provider);
  if (options.model) args.push('--model', options.model);

  return new Promise((resolve) => {
    let child: ChildProcessWithoutNullStreams;
    let buffer = '';
    let stderr = '';
    let output = '';
    let assistantFailure: string | undefined;
    let failure: string | undefined;
    let settled = false;
    let accepted = false;
    let stopping = false;
    let finished = false;
    let exited = false;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const schedule = (callback: () => void, ms: number) => {
      const timer = setTimeout(callback, ms);
      timers.push(timer);
      return timer;
    };
    const finish = (result: WorkerResult) => {
      if (finished) return;
      finished = true;
      timers.forEach(clearTimeout);
      options.signal?.removeEventListener('abort', onAbort);
      resolve(result);
    };
    const signalProcess = (signal: NodeJS.Signals) => {
      if (exited) return;
      try {
        if (process.platform !== 'win32' && child.pid) {
          process.kill(-child.pid, signal);
        } else {
          // shortcut: Windows confirms the Pi child, not every shell descendant.
          // Use Job Objects before claiming full process-tree cancellation.
          child.kill(signal);
        }
      } catch {
        // Only the exit/close events confirm process termination.
      }
    };
    const stop = (error?: string) => {
      if (finished) return;
      if (error) failure ??= error;
      if (stopping) return;
      stopping = true;
      timers.forEach(clearTimeout);
      if (child.stdin.writable && !child.stdin.destroyed) {
        if (error) child.stdin.write('{"id":"abort","type":"abort"}\n');
        // Pi treats stdin EOF as an orderly shutdown request.
        child.stdin.end();
      }
      schedule(() => signalProcess('SIGTERM'), 1000);
      schedule(() => signalProcess('SIGKILL'), 2000);
      schedule(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        child.stdin.destroy();
        child.unref();
        finish({
          success: false,
          output,
          cleanupConfirmed: false,
          error: 'Worker cleanup unconfirmed; do not reuse its workspace yet.',
        });
      }, 5000);
    };
    const onAbort = () => stop('Worker cancelled.');
    const readAssistant = (message: unknown) => {
      if (!record(message) || message.role !== 'assistant') return;
      output = '';
      assistantFailure = undefined;
      if (message.stopReason === 'error' || message.stopReason === 'aborted') {
        assistantFailure = `Assistant ended with ${message.stopReason}.`;
        return;
      }
      if (message.stopReason === 'toolUse') {
        assistantFailure = 'Assistant ended with an unfinished tool request.';
      }
      if (Array.isArray(message.content)) {
        for (const part of message.content) {
          if (record(part) && part.type === 'text' && typeof part.text === 'string') {
            output += `${output ? '\n' : ''}${part.text}`;
            if (output.length > MAX_REPORT_CHARS) {
              output = output.slice(0, MAX_REPORT_CHARS);
              assistantFailure = 'Worker report exceeded the output limit.';
              break;
            }
          }
        }
      }
    };
    const receive = (value: unknown) => {
      if (finished) return;
      if (!record(value) || typeof value.type !== 'string') {
        stop('Invalid worker RPC record.');
        return;
      }
      if (value.type === 'response') {
        if (value.id !== 'prompt') return;
        if (value.success !== true) {
          stop('Pi rejected the worker prompt. Check its provider configuration.');
          return;
        }
        const disposition = record(value.data) ? value.data.disposition : undefined;
        if (disposition !== 'started') {
          stop(`Worker prompt did not start a run (${String(disposition)}).`);
          return;
        }
        accepted = true;
        clearTimeout(startupTimer);
        return;
      }
      if (stopping) return;
      try {
        options.onEvent?.(value);
      } catch {
        stop('Worker event consumer failed.');
        return;
      }
      if (value.type === 'message_end') readAssistant(value.message);
      if (value.type === 'agent_end' && Array.isArray(value.messages)) {
        const assistant = value.messages.findLast(
          (message) => record(message) && message.role === 'assistant'
        );
        readAssistant(assistant);
      }
      if (value.type === 'agent_settled') {
        settled = true;
        stop(assistantFailure ?? (!output.trim() ? 'Worker returned no final report.' : undefined));
      } else if (value.type === 'extension_ui_request') {
        // No extension can ask the hidden worker to wait for human input.
        stop('Worker unexpectedly requested an interactive extension UI.');
      }
    };

    try {
      child = spawn(process.execPath, args, {
        cwd: options.cwd,
        windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
      });
    } catch {
      finish({
        success: false,
        output: '',
        cleanupConfirmed: true,
        error: 'Could not spawn Pi worker.',
      });
      return;
    }
    const startupTimer = schedule(() => stop('Pi worker startup timed out.'), Math.min(timeoutMs, 30_000));
    schedule(() => stop('Worker exceeded its time limit.'), timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (finished) return;
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);
        if (Buffer.byteLength(line, 'utf8') > MAX_RECORD_BYTES) {
          stop('Worker RPC record exceeded the size limit.');
          return;
        }
        if (!line.trim()) continue;
        try {
          receive(JSON.parse(line));
        } catch {
          stop('Malformed JSON from worker RPC.');
        }
      }
      if (Buffer.byteLength(buffer, 'utf8') > MAX_RECORD_BYTES) {
        stop('Unterminated worker RPC record exceeded the size limit.');
      }
    });
    child.stderr.on('data', (chunk: string) => {
      // Keep diagnostic memory bounded; raw provider output may contain secrets.
      stderr = (stderr + chunk).slice(-MAX_STDERR_CHARS);
    });
    child.stdout.on('error', () => stop('Worker RPC output stream failed.'));
    child.stderr.on('error', () => stop('Worker diagnostic stream failed.'));
    child.stdin.on('error', () => {
      if (!stopping) stop('Worker RPC input stream failed.');
    });
    child.once('error', () => {
      if (child.pid === undefined) {
        finish({
          success: false,
          output: '',
          cleanupConfirmed: true,
          error: 'Could not start Pi worker.',
        });
      } else stop('Pi worker process failed.');
    });
    child.once('exit', () => {
      exited = true;
      // stdout may still contain agent_settled when exit fires. Drain to close.
      if (!stopping) {
        schedule(() => stop('Pi exited without closing its RPC streams.'), 1000);
      }
    });
    child.once('close', (code, signal) => {
      const error = failure ??
        (!settled ? 'Pi exited before agent_settled.' : undefined) ??
        (!accepted ? 'Pi never acknowledged the worker prompt.' : undefined) ??
        (code !== 0 ? `Pi exited with ${signal ?? `code ${code}`}.` : undefined);
      finish({
        success: !error,
        output,
        cleanupConfirmed: true,
        ...(error ? { error: `${error}${stderr ? ' Worker stderr was withheld to protect credentials.' : ''}` } : {}),
      });
    });
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
    else {
      child.stdin.write(`${JSON.stringify({ id: 'prompt', type: 'prompt', message: options.prompt })}\n`);
    }
  });
}
