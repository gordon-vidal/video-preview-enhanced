'use strict';
// node test/host/remember_pos_test.js: resume positions are stored on pause, seek and
// close, not on every once-a-second report (review 1 #18).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { load } = require('./mock_vscode');

(async () => {
  const file = path.join(os.tmpdir(), `vpe_pos_${process.pid}.mkv`);
  fs.writeFileSync(file, Buffer.alloc(1000));
  try {
    const h = load();
    const s = h.open(file);
    const writes = () => h.context.stateWrites || 0;
    const stored = () => (h.context.globalState.get('videoPreviewEnhanced.positions') || {})[file];
    const pos = (t) => s.send({ type: 'pos', t, d: 600 });
    await pos(0);
    const w0 = writes();
    for (let t = 1; t <= 20; t++) await pos(t); // playing: 20 reports
    assert.strictEqual(writes(), w0, 'no writes while playing (< 30 s)');
    await pos(20); // paused
    assert.strictEqual(writes(), w0 + 1, 'written on pause');
    assert.strictEqual(stored().t, 20);
    for (let k = 0; k < 10; k++) await pos(20);
    assert.strictEqual(writes(), w0 + 1, 'not rewritten while paused');
    await pos(300); // seek while paused
    assert.strictEqual(stored().t, 300, 'written on seek');
    await pos(301); await pos(302);
    const w1 = writes();
    s.panel.dispose();
    assert.strictEqual(writes(), w1 + 1, 'written on close');
    assert.strictEqual(stored().t, 302);
    console.log('remember pos: ok');
  } finally {
    fs.unlinkSync(file);
  }
})().catch((e) => { console.error(e); process.exit(1); });
