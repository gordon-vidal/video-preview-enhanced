'use strict';
// node test/host/send_frames_test.js: every requested frame gets an answer, even
// when it can't be read (review 1 #18: FramePlayer inflight).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { load } = require('./mock_vscode');

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vpe_seq_'));
  try {
    const files = [0, 1, 2].map((i) => path.join(dir, `f_${String(i).padStart(4, '0')}.png`));
    for (const f of files) fs.writeFileSync(f, Buffer.from('png'));
    const h = load();
    // Borrow a mock panel, then open a sequence through the playSequence command.
    const s = h.open(files[0]);
    s.panel.dispose();
    const panel = s.panel;
    h.vscode.window.createWebviewPanel = () => panel;
    panel.webview.html = '';
    await h.vscode._commands['videoPreviewEnhanced.playSequence'](h.vscode.Uri.file(files[0]));
    assert.ok(panel.webview.html, 'sequence session');
    await s.send({ type: 'ready' });
    fs.unlinkSync(files[1]); // unreadable frame
    s.posted.length = 0;
    await s.send({ type: 'frames', indices: [0, 1, 2, 7] });
    for (const indices of ['0', [NaN], [-1], [1.5], ['1'], Array(1), Array(126).fill(0)]) {
      await s.send({ type: 'frames', indices });
    }
    const got = s.posted.filter((m) => m.type === 'frame');
    assert.deepStrictEqual(got.map((m) => m.index), [0, 1, 2, 7], 'every index answered');
    assert.deepStrictEqual(got.map((m) => m.data.length), [3, 0, 3, 0]);
    panel.dispose();
    console.log('send frames: ok');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch((e) => { console.error(e); process.exit(1); });
