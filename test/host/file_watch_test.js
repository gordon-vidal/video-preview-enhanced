'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const { watchFile } = require('../../src/file-watch');

const dir = path.resolve('output');
const file = path.join(dir, 'clip.mp4');

for (const cause of ['absolute event', 'missing folder', 'error']) {
  const watcher = new EventEmitter();
  let callback;
  let closes = 0;
  let changes = 0;
  const errors = [];
  watcher.close = () => { closes++; };
  const subscription = watchFile(file, () => { changes++; }, (e) => errors.push(e), {
    watch(folder, onEvent) {
      assert.equal(folder, dir);
      callback = onEvent;
      return watcher;
    },
    statSync: () => undefined,
  });
  callback('change', 'other.mp4');
  callback('change', 'CLIP.mp4');
  assert.equal(changes, 1);
  if (cause === 'absolute event') {
    const eventName = process.platform === 'win32' ? path.toNamespacedPath(dir) : dir;
    for (let i = 0; i < 100; i++) callback('change', eventName);
  }
  if (cause === 'missing folder') callback('rename', null);
  const err = new Error('watch failed');
  if (cause === 'error') watcher.emit('error', err);
  assert.deepEqual(errors, cause === 'error' ? [err] : []);
  assert.equal(closes, 1, cause);
  callback('change', 'clip.mp4');
  subscription.close();
  assert.equal(changes, 1, 'ignore events after closing');
  assert.equal(closes, 1, 'disposal is idempotent');
}
console.log('file watch checks passed');
