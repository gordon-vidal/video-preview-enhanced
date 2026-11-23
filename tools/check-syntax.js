'use strict';

const { spawnSync } = require('node:child_process');
const { readdirSync } = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const excluded = path.join(root, 'media', 'libav-vpe');

function check(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory() && file !== excluded) check(file);
    if (entry.isFile() && entry.name.endsWith('.js')) {
      const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
      if (result.error) throw result.error;
      if (result.status !== 0) process.exitCode = 1;
    }
  }
}

check(path.join(root, 'src'));
check(path.join(root, 'media'));
if (!process.exitCode) console.log('Source syntax OK');
