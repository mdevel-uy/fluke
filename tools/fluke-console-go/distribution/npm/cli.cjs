#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { spawnSync } = require('node:child_process');
const os = require('node:os');

function binaryPath(platform = process.platform, arch = process.arch) {
  if (!['linux', 'darwin', 'win32'].includes(platform) || !['x64', 'arm64'].includes(arch)) {
    throw new Error(`Fluke does not support ${platform}/${arch}. Supported: Windows, Linux and macOS on x64 and arm64.`);
  }
  return path.join(__dirname, 'bin', `${platform}-${arch}`, platform === 'win32' ? 'fluke.exe' : 'fluke');
}

function main(args = process.argv.slice(2)) {
  let executable;
  try {
    executable = binaryPath();
  } catch (error) {
    console.error(error.message);
    return 1;
  }
  const result = spawnSync(executable, args, { stdio: 'inherit' });
  if (result.error) {
    console.error(`Could not start Fluke: ${result.error.message}. Reinstall ${require('./package.json').name}.`);
    return 1;
  }
  if (result.signal) return 128 + (os.constants.signals[result.signal] || 1);
  return result.status ?? 1;
}

module.exports = { binaryPath, main };
if (require.main === module) process.exitCode = main();
