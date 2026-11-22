'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { otherInstalledVersions } = require('../../src/old-installs');

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vpe-installs-'));
  const id = 'publisher.preview';
  const extensions = path.join(root, 'vscode-addons');
  const installed = path.join(extensions, `${id}-1.2.3`);
  const worktree = path.join(root, 'worktrees', 't3-123abc-456def');
  try {
    for (const dir of [installed, worktree,
      path.join(root, 'worktrees', 't3-123456-abcdef'),
      path.join(extensions, `${id}-1.2.0-win32-x64`),
      path.join(extensions, `${id}-1.2.2`),
      path.join(extensions, `${id}-123456-abcdef`),
      path.join(extensions, 'someone.preview-1.2.1'),
    ]) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(extensions, `${id}-1.2.1`), '');
    assert.deepStrictEqual(await otherInstalledVersions(installed, id), [`${id}-1.2.0-win32-x64`, `${id}-1.2.2`]);
    assert.deepStrictEqual(await otherInstalledVersions(worktree, id), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log('old installs: ok');
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
