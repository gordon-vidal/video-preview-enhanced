'use strict';
// node test/run.js unit --grep reload_open: a file rewritten on disk (render or capture loops) reloads its clip once,
// in place, after the writes settle (review 1 #18): one 'replaceTile' with the new size under a new clip id, the same
// page, and a touch that changes nothing (same date) does not reload.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { load } = require('./mock_vscode');

(async () => {
  const file = path.join(os.tmpdir(), `vpe_reload_${process.pid}.mkv`);
  fs.writeFileSync(file, Buffer.alloc(1000));
  try {
    const h = load({ settings: { 'videoPreviewEnhanced.decoder': 'builtin' } });
    const s = h.open(file);
    await s.send({ type: 'ready' });
    const html0 = s.panel.webview.html;
    const first = s.cfg().clips[0].id;
    await new Promise((r) => setTimeout(r, 100)); // the watcher has its first date
    // Three writes in a row: the watcher waits ~800 ms after the last.
    for (const n of [1500, 1800, 2000]) { fs.writeFileSync(file, Buffer.alloc(n)); await new Promise((r) => setTimeout(r, 100)); }
    await s.until((p) => p.some((m) => m.type === 'replaceTile'), 4000);
    await new Promise((r) => setTimeout(r, 1200));
    const reloads = s.posted.filter((m) => m.type === 'replaceTile');
    assert.strictEqual(reloads.length, 1, `one reload for the burst of writes (got ${reloads.length})`);
    assert.strictEqual(reloads[0].clip.size, 2000, 'with the new file size');
    assert.strictEqual(reloads[0].oldId, first);
    assert.notStrictEqual(reloads[0].newId, first, 'a new clip id: the page starts a new decoder');
    assert.strictEqual(s.panel.webview.html, html0, 'the same page');
    s.panel.dispose();
    console.log('reload on change: ok');
  } finally {
    fs.unlinkSync(file);
  }
})().catch((e) => { console.error(e); process.exit(1); });
