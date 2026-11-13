import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export const dataRoot = join(homedir(), '.fluke-next');

function git(cwd: string, args: string[], index?: string): Promise<string> {
  return new Promise((resolveResult, reject) => {
    execFile(
      'git',
      args,
      {
        cwd,
        windowsHide: true,
        maxBuffer: 32 * 1024 * 1024,
        env: index ? { ...process.env, GIT_INDEX_FILE: index } : process.env,
      },
      (error, stdout, stderr) => {
        if (error) reject(new Error(stderr.trim() || error.message));
        else resolveResult(stdout.trimEnd());
      }
    );
  });
}

export function runDirectory(cwd: string, runId: string): string {
  if (!/^[a-zA-Z0-9-]+$/.test(runId)) throw new Error('Run ID inválido.');
  const project = createHash('sha256').update(resolve(cwd)).digest('hex').slice(0, 16);
  return join(dataRoot, 'runs', project, runId);
}

async function snapshot(cwd: string, directory: string): Promise<string> {
  const index = join(directory, 'snapshot.index');
  try {
    await git(cwd, ['read-tree', 'HEAD'], index);
    await git(cwd, ['add', '--all'], index);
    return await git(cwd, ['write-tree'], index);
  } finally {
    await rm(index, { force: true });
  }
}

export async function prepareWorkspace(cwd: string, runId: string): Promise<string> {
  const root = await git(cwd, ['rev-parse', '--show-toplevel']);
  const directory = runDirectory(cwd, runId);
  await mkdir(directory, { recursive: true });
  const tree = await snapshot(root, directory);
  // A detached snapshot includes non-ignored local files without changing HEAD/index.
  const base = await git(root, [
    '-c', 'user.name=Fluke', '-c', 'user.email=fluke@localhost',
    'commit-tree', tree, '-p', 'HEAD', '-m', `Fluke snapshot ${runId}`,
  ]);
  const worktree = join(directory, 'worktree');
  await git(root, ['worktree', 'add', '--detach', worktree, base]);
  await writeFile(join(directory, 'workspace.json'), JSON.stringify({ root, base }));
  return worktree;
}

export async function exportPatch(cwd: string, runId: string): Promise<string> {
  const directory = runDirectory(cwd, runId);
  const { base } = JSON.parse(await readFile(join(directory, 'workspace.json'), 'utf8'));
  if (typeof base !== 'string' || !/^[0-9a-f]{40,64}$/.test(base)) {
    throw new Error('Snapshot inválido.');
  }
  const worktree = join(directory, 'worktree');
  const tree = await snapshot(worktree, directory);
  const patch = await git(worktree, ['diff', '--binary', base, tree]);
  const path = join(directory, 'changes.patch');
  await writeFile(path, patch ? `${patch}\n` : '');
  return path;
}

export async function applyTaskPatch(cwd: string, runId: string): Promise<void> {
  const patch = await exportPatch(cwd, runId);
  const { root } = JSON.parse(await readFile(join(dirname(patch), 'workspace.json'), 'utf8'));
  const currentRoot = await git(cwd, ['rev-parse', '--show-toplevel']);
  if (resolve(root) !== resolve(currentRoot)) throw new Error('Proyecto distinto.');
  if (!(await readFile(patch, 'utf8')).trim()) return;
  await git(root, ['apply', '--check', '--binary', patch]);
  await git(root, ['apply', '--binary', patch]);
}
