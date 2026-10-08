import fs from 'node:fs';
import path from 'node:path';
import { consoleDirectory, targets, releaseVersion, run } from './release.mjs';

const [os, arch, output, requestedVersion] = process.argv.slice(2);
if (!targets.some(([goos, goarch]) => goos === os && goarch === arch) || !output) {
  throw new Error('Usage: node build.mjs <linux|darwin|windows> <amd64|arm64> <output-dir> [version]');
}
const version = releaseVersion(requestedVersion);
fs.mkdirSync(output, { recursive: true });
const file = path.resolve(output, `fluke-console-${os}-${arch}${os === 'windows' ? '.exe' : ''}`);
run(process.env.FLUKE_GO || 'go', [
  'build', '-mod=readonly', '-trimpath', '-ldflags', `-s -w -X main.version=${version}`, '-o', file, '.',
], { cwd: consoleDirectory, env: { ...process.env, CGO_ENABLED: '0', GOOS: os, GOARCH: arch } });
console.log(file);
