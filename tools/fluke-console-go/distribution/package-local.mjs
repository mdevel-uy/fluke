// Private, current-machine package for testing before the full release is ready.
import fs from 'node:fs';
import path from 'node:path';
import { directory, consoleDirectory, repository, targets, releaseVersion, run } from './release.mjs';

const [input, destination] = process.argv.slice(2);
if (!input || !destination) throw new Error('Usage: node package-local.mjs <binaries-dir> <new-output-dir>');
const target = targets.find(([, , platform, arch]) => platform === process.platform && arch === process.arch);
if (!target) throw new Error(`Unsupported local target: ${process.platform}/${process.arch}`);
const [goos, goarch, platform, arch] = target;
const version = releaseVersion();
const output = path.resolve(destination);
fs.mkdirSync(output);
const stage = path.join(output, 'npm');
fs.cpSync(path.join(directory, 'npm'), stage, { recursive: true });
const manifest = JSON.parse(fs.readFileSync(path.join(stage, 'package.json')));
Object.assign(manifest, { private: true, os: [platform], cpu: [arch], version });
fs.writeFileSync(path.join(stage, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
fs.chmodSync(path.join(stage, 'cli.cjs'), 0o755);
for (const [source, name] of [
  [path.join(repository, 'LICENSE'), 'LICENSE'],
  [path.join(consoleDirectory, 'THIRD_PARTY_NOTICES.md'), 'THIRD_PARTY_NOTICES.md'],
]) fs.copyFileSync(source, path.join(stage, name));
const filename = platform === 'win32' ? 'fluke.exe' : 'fluke';
const binaryDirectory = path.join(stage, 'bin', `${platform}-${arch}`);
fs.mkdirSync(binaryDirectory, { recursive: true });
fs.copyFileSync(path.resolve(input, `fluke-console-${goos}-${goarch}${platform === 'win32' ? '.exe' : ''}`), path.join(binaryDirectory, filename));
fs.chmodSync(path.join(binaryDirectory, filename), 0o755);
fs.writeFileSync(path.join(stage, 'README.md'), `# Fluke local test\n\nPrivate test package for ${platform}/${arch}. Not a public cross-platform release.\n\nRun fluke --lang es or fluke --version.\n`);
run('npm', ['pack', '--offline', '--pack-destination', output], { cwd: stage });
