#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
let entry;
try {
  entry = join(
    dirname(require.resolve('@earendil-works/pi-coding-agent/rpc-entry')),
    'cli.js'
  );
} catch {
  console.error('Faltan las dependencias de tools/fluke-next. Ver README.md.');
  process.exit(1);
}
const extension = fileURLToPath(new URL('../src/extension.ts', import.meta.url));
// Keep the parent in its coordinator role; workers receive their own tool set.
const child = spawn(
  process.execPath,
  [
    entry,
    ...process.argv.slice(2),
    '--no-extensions',
    '--no-skills',
    '--no-prompt-templates',
    '--no-mcp',
    '--tools',
    'read',
    '-e',
    extension,
  ],
  { stdio: 'inherit', windowsHide: true }
);
child.on('error', (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on('exit', (code) => {
  process.exitCode = code ?? 1;
});
