'use strict';
const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');
const { plan } = require('../../tools/theme-screenshots');
const root = path.resolve(__dirname, '../..');
const script = path.join(root, 'tools/theme-screenshots.js');
const shots = plan(['shots with spaces', 'clip with spaces.mp4']);
assert.deepStrictEqual(shots.map((shot) => shot.theme), [
  'Default Dark Modern', 'Default Light Modern', 'Default High Contrast',
]);
assert.deepStrictEqual(shots.map((shot) => path.basename(shot.args[1])), [
  'dark.png', 'light.png', 'high-contrast.png',
]);
for (const shot of shots) {
  assert.strictEqual(shot.args[0], path.join(root, 'test/vscode/screenshot.js'));
  assert.strictEqual(shot.args[2], path.resolve('clip with spaces.mp4'));
  assert.deepStrictEqual(shot.args.slice(3), ['--theme', shot.theme]);
}
assert.strictEqual(plan(['shots'])[0].args[2], path.join(root, 'test/media/cases/long_20s.mp4'));
for (const args of [[], ['out', 'file', 'extra'], ['--unknown'], ['out', '--unknown']]) {
  assert.throws(() => plan(args), /usage:/);
}
const result = spawnSync(process.execPath, [script, '--plan', 'shots'], { encoding: 'utf8', windowsHide: true });
assert.strictEqual(result.status, 0, result.stderr);
assert.deepStrictEqual(JSON.parse(result.stdout), plan(['shots']));
console.log('theme screenshots: parsing, themes and launch-free CLI plan passed');
