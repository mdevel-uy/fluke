import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

export const directory = path.dirname(fileURLToPath(import.meta.url));
export const consoleDirectory = path.dirname(directory);
export const repository = path.resolve(consoleDirectory, '../..');
export const targets = [
  ['linux', 'amd64', 'linux', 'x64'],
  ['linux', 'arm64', 'linux', 'arm64'],
  ['darwin', 'amd64', 'darwin', 'x64'],
  ['darwin', 'arm64', 'darwin', 'arm64'],
  ['windows', 'amd64', 'win32', 'x64'],
  ['windows', 'arm64', 'win32', 'arm64'],
];

export function releaseVersion(value) {
  const version = value || JSON.parse(fs.readFileSync(path.join(directory, 'npm/package.json'))).version;
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(alpha|beta|rc)\.(0|[1-9]\d*))?$/.test(version)) {
    throw new Error('Expected X.Y.Z or X.Y.Z-beta.N (also alpha/rc).');
  }
  return version;
}

export function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status ?? result.signal})`);
  return result;
}
