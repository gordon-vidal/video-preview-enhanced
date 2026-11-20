'use strict';
// Compare's native queue uses WSL host memory, and a new page reads the current file rotation.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { load } = require('./mock_vscode');
const { GB, budgets } = require('../../media/membudget');
const { rotationOf } = require('../../src/rotation');
const { make } = require('../media/make_cases_media');

(async () => {
  const rotated = make('rotated.mp4');
  const upright = make('s_h264.mp4');
  assert.ok(rotated && upright, 'ffmpeg test clips');
  const rewritten = path.join(path.dirname(rotated), `vpe_compare_${process.pid}.mp4`);
  const { totalmem, freemem } = os;
  const h = load({ settings: { 'videoPreviewEnhanced.decoder': 'ffmpeg' } });
  let compare;
  try {
    fs.copyFileSync(upright, rewritten);
    os.totalmem = () => 8 * GB;
    os.freemem = () => 4 * GB;
    h.vscode.env.remoteName = 'wsl';
    h.vscode.window.withProgress = async () => null;
    const posts = [];
    const warnings = [];
    h.vscode.window.showWarningMessage = async (w) => { warnings.push(w); };
    let receive = null;
    const webview = {
      cspSource: 'vscode-resource:', asWebviewUri: (u) => u,
      postMessage(m) { posts.push(m); }, onDidReceiveMessage(fn) { receive = fn; },
    };
    h.vscode.window.createWebviewPanel = () => ({ webview, onDidDispose() {}, onDidChangeViewState() {} });
    compare = await h.vscode._commands['videoPreviewEnhanced.compare'](null, [rewritten, upright].map(h.vscode.Uri.file));
    const cfg = () => JSON.parse(/<script type="application\/json" id="cfg">([^<]*)<\/script>/.exec(webview.html)[1]);
    assert.strictEqual(cfg().engine.mem, null, 'WSL webview uses client memory');
    assert.deepStrictEqual(cfg().rotation, [0, 0]);
    await compare.onMessage({ type: 'ready' });
    const queue = Math.floor(budgets(8).nativeQueue / 2);
    assert.deepStrictEqual(compare.natives.map((n) => n.maxQueued), [queue, queue]);

    fs.copyFileSync(rotated, rewritten);
    compare.reload();
    const rotation = rotationOf(rotated);
    assert.ok(rotation > 0, 'rotated fixture');
    assert.deepStrictEqual(cfg().rotation, [rotation, 0], 'reload reads the rewritten file');

    // Messages carry the page id: the host stamps its posts and ignores a replaced page's messages.
    const page = cfg().page;
    assert.ok(page > 1, `each page has a new id: ${page}`);
    compare.post({ type: 'visible', visible: true });
    assert.strictEqual(posts.pop().page, page, 'host posts carry the page id');
    let handled = 0;
    const onMessage = compare.onMessage;
    compare.onMessage = async () => { handled++; };
    receive({ type: 'tileSize', page: page - 1 });
    receive({ type: 'tileSize' });
    assert.strictEqual(handled, 0, 'messages from an old page (or without one) are dropped');
    receive({ type: 'tileSize', page });
    assert.strictEqual(handled, 1, 'messages from the current page are handled');
    compare.onMessage = onMessage;

    // A read still in flight when the file set changes: its reply would reach the new page under a
    // tile key now used by another file. The overflow warning counts only usable files.
    let finishRead;
    let closed = false;
    const delayed = new Promise((resolve) => { finishRead = resolve; });
    compare.fhs[0] = Promise.resolve({ fh: { read: () => delayed, close: () => { closed = true; } }, size: 32 });
    posts.length = 0;
    const read = compare.readBlock('A', 0, 32);
    await Promise.resolve();
    const remote = h.vscode.Uri.file(upright).with({ scheme: 'http' });
    compare.addUris([remote, ...Array(2).fill(h.vscode.Uri.file(upright))]);
    assert.strictEqual(cfg().names.length, 4, 'two usable files fill the two free slots');
    assert.deepStrictEqual(warnings, [], 'a skipped non-file URI is not counted as overflow');
    finishRead({ bytesRead: 32 });
    await read;
    assert.ok(closed, 'reload closes the old file');
    assert.ok(!posts.some((m) => m.type === 'block'), 'reload drops the reply of the old read');
    compare.addUris([h.vscode.Uri.file(upright)]);
    assert.strictEqual(cfg().names.length, 4);
    assert.strictEqual(warnings.length, 1, `full view warns: ${warnings}`);

    // A page whose decoders failed to start asks the host to stop: files and native tiles close.
    await compare.onMessage({ type: 'ready' });
    const natives = compare.natives.slice();
    assert.strictEqual(natives.length, 4);
    await compare.onMessage({ type: 'stop' });
    assert.ok(natives.every((n) => n.disposed) && !compare.natives.length, 'stop disposes every native tile');
    await compare.onMessage({ type: 'remove', index: 1.5 });
    assert.strictEqual(cfg().names.length, 4, 'a fractional index removes nothing');

    // Extension shutdown disposes open compare sessions (and their native tiles).
    await compare.onMessage({ type: 'ready' });
    const live = compare.natives.slice();
    h.dispose();
    assert.ok(compare.disposed && live.every((n) => n.disposed), 'deactivate disposes the compare session');
  } finally {
    if (compare) compare.dispose();
    h.dispose();
    os.totalmem = totalmem;
    os.freemem = freemem;
    fs.rmSync(rewritten, { force: true });
  }
})().then(() => console.log('compare: ok'), (e) => { console.error(e); process.exitCode = 1; });
