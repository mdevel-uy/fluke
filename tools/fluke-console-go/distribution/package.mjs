import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { directory, consoleDirectory, repository, targets, releaseVersion, run } from './release.mjs';

const [input, destination, requestedVersion] = process.argv.slice(2);
if (!input || !destination) throw new Error('Usage: node package.mjs <binaries-dir> <new-output-dir> [version]');
const version = releaseVersion(requestedVersion);
const output = path.resolve(destination);
// A fresh destination prevents mixing binaries or packages from different releases.
fs.mkdirSync(output);
const npmDirectory = path.join(output, 'npm');
fs.cpSync(path.join(directory, 'npm'), npmDirectory, { recursive: true });
const manifestPath = path.join(npmDirectory, 'package.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath));
manifest.version = version;
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
fs.copyFileSync(path.join(repository, 'LICENSE'), path.join(npmDirectory, 'LICENSE'));
fs.copyFileSync(path.join(consoleDirectory, 'THIRD_PARTY_NOTICES.md'), path.join(npmDirectory, 'THIRD_PARTY_NOTICES.md'));
fs.chmodSync(path.join(npmDirectory, 'cli.cjs'), 0o755);

for (const [goos, goarch, platform, arch] of targets) {
  const filename = goos === 'windows' ? 'fluke.exe' : 'fluke';
  const source = path.resolve(input, `fluke-console-${goos}-${goarch}${goos === 'windows' ? '.exe' : ''}`);
  if (!fs.statSync(source).isFile() || fs.statSync(source).size === 0) throw new Error(`Invalid binary: ${source}`);
  const binaryDirectory = path.join(npmDirectory, 'bin', `${platform}-${arch}`);
  fs.mkdirSync(binaryDirectory, { recursive: true });
  fs.copyFileSync(source, path.join(binaryDirectory, filename));
  fs.chmodSync(path.join(binaryDirectory, filename), 0o755);
  const archiveDirectory = path.join(output, `${goos}-${goarch}`);
  fs.mkdirSync(archiveDirectory);
  fs.copyFileSync(source, path.join(archiveDirectory, filename));
  fs.chmodSync(path.join(archiveDirectory, filename), 0o755);
  for (const document of ['README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md']) {
    fs.copyFileSync(path.join(npmDirectory, document), path.join(archiveDirectory, document));
  }
  run('tar', ['-czf', path.join(output, `fluke_${version}_${goos}_${goarch}.tar.gz`), '-C', archiveDirectory, '.']);
  fs.rmSync(archiveDirectory, { recursive: true });
}
run('node', [path.join(npmDirectory, 'verify.cjs')]);
run('npm', ['pack', '--pack-destination', output], { cwd: npmDirectory });
const checksums = fs.readdirSync(output).filter(name => name.endsWith('.tgz') || name.endsWith('.tar.gz')).sort().map(name => {
  const hash = crypto.createHash('sha256').update(fs.readFileSync(path.join(output, name))).digest('hex');
  return `${hash}  ${name}`;
});
fs.writeFileSync(path.join(output, 'checksums.txt'), `${checksums.join('\n')}\n`);
console.log(`Release ${version} prepared in ${output}`);
