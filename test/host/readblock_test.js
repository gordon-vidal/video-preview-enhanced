'use strict';
// node test/host/readblock_test.js: concurrent readBlock calls share one handle,
// short reads are trimmed, and a failed read still answers (empty block).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { load, webviewConfig } = require('./mock_vscode');

(async () => {
  const file = path.join(os.tmpdir(), `vpe_rb_${process.pid}.bin`);
  const bytes = Buffer.alloc(3 * 1024 * 1024 + 123);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7) & 255;
  fs.writeFileSync(file, bytes);

  let opens = 0;
  const origOpen = fs.promises.open;
  fs.promises.open = (...a) => { opens++; return origOpen(...a); };
  const h = load();
  const s = h.open(file);
  try {
    await s.shown;
    const { page } = webviewConfig(s.panel.webview);
    const B = 1 << 20;
    await Promise.all([0, 1, 2, 3, 4].map((k) => s.send({ type: 'readBlock', page, pos: k * B, len: B })));
    const blocks = s.posted.filter((m) => m.type === 'block');
    assert.strictEqual(opens, 1, `one open for concurrent reads (got ${opens})`);
    assert.strictEqual(blocks.length, 5);
    for (const b of blocks) {
      assert.strictEqual(b.page, page);
      const want = bytes.subarray(b.pos, Math.min(bytes.length, b.pos + B));
      assert.ok(Buffer.from(b.data).equals(want), `block ${b.pos} content`);
    }
    assert.strictEqual(blocks.find((b) => b.pos === 4 * B).data.length, 0, 'past EOF is empty');

    // A failed open still answers, so the webview doesn't wait forever.
    s.panel.dispose();
    const bad = load().open(path.join(os.tmpdir(), 'vpe_missing_file.bin'));
    await bad.shown;
    await bad.send({ type: 'readBlock', page: webviewConfig(bad.panel.webview).page, pos: 0, len: 1024 });
    const ans = bad.posted.filter((m) => m.type === 'block');
    assert.strictEqual(ans.length, 1, 'answered after error');
    assert.strictEqual(ans[0].data.length, 0);
    assert.ok(bad.posted.some((m) => m.type === 'error'), 'error shown');
    bad.panel.dispose();
    console.log('readblock: ok');
  } finally {
    fs.promises.open = origOpen;
    fs.unlinkSync(file);
  }
})().catch((e) => { console.error(e); process.exit(1); });
