#!/usr/bin/env node
'use strict';
// Capture sequentially through the existing hidden-desktop runner; --plan launches nothing.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const ROOT = path.resolve(__dirname, '..');
const THEMES = [
  ['dark', 'Default Dark Modern'],
  ['light', 'Default Light Modern'],
  ['high-contrast', 'Default High Contrast'],
];

function plan(argv) {
  const args = argv.filter((arg) => arg !== '--plan');
  if (args.length < 1 || args.length > 2 || args.some((arg) => arg.startsWith('--'))) {
    throw new Error('usage: node tools/theme-screenshots.js <out-dir> [video-file] [--plan]');
  }
  const out = path.resolve(args[0]);
  const file = path.resolve(args[1] || path.join(ROOT, 'test/media/cases/long_20s.mp4'));
  return THEMES.map(([name, theme]) => ({
    theme,
    args: [path.join(ROOT, 'test/vscode/screenshot.js'), path.join(out, `${name}.png`), file, '--theme', theme],
  }));
}

function main(argv) {
  const shots = plan(argv);
  if (argv.includes('--plan')) {
    console.log(JSON.stringify(shots, null, 2));
    return;
  }
  if (process.platform !== 'win32') throw new Error('Hidden-desktop screenshots require Windows.');
  if (!fs.statSync(shots[0].args[2]).isFile()) throw new Error('Video input must be a file.');
  // The queue serializes this pack with the documented single-screenshot command.
  const result = spawnSync(process.execPath,
    [path.join(ROOT, 'test/benchq.js'), process.execPath, __filename, '--capture', ...argv],
    { stdio: 'inherit', windowsHide: true, cwd: ROOT });
  if (result.error) throw result.error;
  process.exitCode = result.status === null ? 1 : result.status;
}

if (require.main === module) {
  try {
    const argv = process.argv.slice(2);
    if (argv[0] === '--capture') {
      for (const shot of plan(argv.slice(1))) {
        console.log(`Capturing ${shot.theme}`);
        const result = spawnSync(process.execPath, shot.args, { stdio: 'inherit', windowsHide: true, cwd: ROOT });
        if (result.error) throw result.error;
        if (result.status !== 0) { process.exitCode = result.status === null ? 1 : result.status; break; }
      }
    } else main(argv);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}

module.exports = { plan };
