'use strict';
// node test/host/reload_open_test.js: a file change while open() is still running
// (slow stat/probe/AVI scan) must not send the new page a second 'libav' (review 1 #18).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { load } = require('./mock_vscode');

(async () => {
  const file = path.join(os.tmpdir(), `vpe_reload_${process.pid}.mkv`);
  fs.writeFileSync(file, Buffer.alloc(1000));
  const origStat = fs.promises.stat;
  let slow = true;
  fs.promises.stat = async (p, ...a) => {
    if (p === file && slow) { slow = false; await new Promise((r) => setTimeout(r, 2000)); }
    return origStat(p, ...a);
  };
  try {
    const h = load({ settings: { 'videoPreviewEnhanced.decoder': 'builtin' } });
    const s = h.open(file);
    await s.shown;
    const html0 = s.panel.webview.html;
    const first = s.send({ type: 'ready' }); // stalls in stat
    await new Promise((r) => setTimeout(r, 100));
    fs.writeFileSync(file, Buffer.alloc(2000)); // the watcher reloads after ~800 ms
    await s.until(() => s.panel.webview.html !== html0, 4000);
    await s.send({ type: 'ready' }); // the new page
    await first;
    const libav = s.posted.filter((m) => m.type === 'libav');
    assert.strictEqual(libav.length, 1, `one libav for the new page (got ${libav.length})`);
    assert.strictEqual(libav[0].meta.size, 2000, 'with the new file size');
    s.panel.dispose();
    console.log('reload during open: ok');
  } finally {
    fs.promises.stat = origStat;
    fs.unlinkSync(file);
  }
})().catch((e) => { console.error(e); process.exit(1); });
