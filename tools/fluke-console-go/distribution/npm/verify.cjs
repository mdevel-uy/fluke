'use strict';

const fs = require('node:fs');
const { binaryPath } = require('./cli.cjs');
const manifest = require('./package.json');

for (const platform of manifest.os) {
  for (const arch of manifest.cpu) {
    const file = binaryPath(platform, arch);
    if (!fs.statSync(file).isFile() || fs.statSync(file).size === 0) {
      throw new Error(`Missing or empty release binary: ${file}`);
    }
  }
}
for (const file of ['README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md']) {
  if (!fs.statSync(require('node:path').join(__dirname, file)).isFile()) {
    throw new Error(`Missing release document: ${file}`);
  }
}
