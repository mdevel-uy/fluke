import path from 'node:path';
import { directory, targets, releaseVersion, run } from './release.mjs';

const [output, requestedVersion] = process.argv.slice(2);
if (!output) throw new Error('Usage: node build-all.mjs <binaries-dir> [version]');
const version = releaseVersion(requestedVersion);
for (const [goos, goarch] of targets) {
  run(process.execPath, [path.join(directory, 'build.mjs'), goos, goarch, output, version]);
}
