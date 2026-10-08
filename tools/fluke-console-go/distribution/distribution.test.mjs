import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { directory, releaseVersion, targets } from './release.mjs';

const require = createRequire(import.meta.url);
const { binaryPath } = require('./npm/cli.cjs');

test('launcher maps all release targets and rejects unsupported systems', () => {
  for (const [, , platform, arch] of targets) {
    assert.equal(binaryPath(platform, arch), path.join(directory, 'npm', 'bin', `${platform}-${arch}`, platform === 'win32' ? 'fluke.exe' : 'fluke'));
  }
  assert.throws(() => binaryPath('freebsd', 'x64'), /does not support/);
  assert.throws(() => binaryPath('linux', 'ia32'), /does not support/);
});

test('release versions cannot inject flags, paths or workflow output', () => {
  for (const version of ['0.1.0-beta.1', '1.2.3', '2.0.0-rc.0']) assert.equal(releaseVersion(version), version);
  for (const version of ['01.2.3', '../1.0.0', '1.0.0\nextra=1', '-X main.version=bad', '1.0.0-beta.01']) {
    assert.throws(() => releaseVersion(version), /Expected/);
  }
});

test('npm launcher preserves arguments and child exit status', t => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'fluke-launcher-'));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  fs.copyFileSync(path.join(directory, 'npm/cli.cjs'), path.join(fixture, 'cli.cjs'));
  fs.copyFileSync(path.join(directory, 'npm/package.json'), path.join(fixture, 'package.json'));
  const binary = path.join(fixture, 'bin', `${process.platform}-${process.arch}`, process.platform === 'win32' ? 'fluke.exe' : 'fluke');
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  if (process.platform === 'win32') fs.copyFileSync(process.execPath, binary);
  else fs.symlinkSync(process.execPath, binary);
  const args = ['path with spaces', 'comillas " y $()', 'español 🐋', '--repo'];
  const result = spawnSync(process.execPath, [path.join(fixture, 'cli.cjs'), '-e', 'require("node:fs").writeSync(1, JSON.stringify(process.argv.slice(1))); process.exit(7)', ...args], { encoding: 'utf8' });
  assert.equal(result.status, 7, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), args);
  fs.unlinkSync(binary);
  const missing = spawnSync(process.execPath, [path.join(fixture, 'cli.cjs')], { encoding: 'utf8' });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /Could not start Fluke/);
});

test('prepack prevents publishing an incomplete platform matrix', () => {
  const result = spawnSync(process.execPath, [path.join(directory, 'npm/verify.cjs')], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ENOENT|Missing/);
});
