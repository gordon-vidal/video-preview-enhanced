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
  const h = load({ settings: {
    'videoPreviewEnhanced.decoder': 'ffmpeg',
    'videoPreviewEnhanced.compare.maxVideos': 4,
  } });
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

    // Exercise the real session and stream ownership without requiring a GPU or encoder.
    let prefs = { transcode: 'always', transcodeMaxBitrate: 12, transcodeSplitBitrate: true };
    compare.prefs = () => prefs;
    compare.nativeFor = async () => ({
      tools: {}, maxHeight: 1080,
      probed: { duration: 10, video: { width: 1920, height: 1080, fps: 30 } },
      stream: { encoder: 'h264_nvenc', cpuEncoder: null, remote: false },
    });
    compare.reload(compare.uris.slice(0, 2));
    compare.panel.visible = false;
    const ready = () => compare.onMessage({ type: 'ready', tile: { w: 1280, h: 720, cols: 2, rows: 1 } });
    const caps = () => compare.natives.filter(Boolean).map((n) => n.activeCapKbps());
    await ready();
    assert.ok(compare.natives.every((n) => n.hidden), 'host constructs streams hidden before the page configures them');
    compare.panel.visible = true;
    assert.deepStrictEqual(caps(), [6000, 6000]);
    const pair = compare.natives.slice();
    compare.addUris([h.vscode.Uri.file(upright)]);
    assert.ok(pair.every((n) => n.disposed), 'add reload closes the old streams');
    await ready();
    assert.deepStrictEqual(caps(), [4000, 4000, 4000]);
    compare.panel.visible = false;
    await compare.onMessage({ type: 'nd', key: 'A', m: { type: 'open' } });
    assert.strictEqual(compare.natives[0].spawns, 0, 'a panel hidden during page startup starts no encoder');
    compare.panel.visible = true;
    const trio = compare.natives.slice();
    await compare.onMessage({ type: 'remove', index: 1 });
    assert.ok(trio.every((n) => n.disposed), 'remove reload closes the old streams');
    await ready();
    assert.deepStrictEqual(caps(), [6000, 6000]);
    compare.updateTranscode(prefs = { ...prefs, transcodeSplitBitrate: false });
    assert.deepStrictEqual(caps(), [12000, 12000]);
    compare.updateTranscode(prefs = { ...prefs, transcodeSplitBitrate: true, transcodeMaxBitrate: 10 });
    assert.deepStrictEqual(caps(), [5000, 5000]);
    const [failed, survivor] = compare.natives;
    failed.onFail('no software encoder');
    assert.ok(failed.disposed);
    assert.strictEqual(compare.natives[1], survivor);
    assert.deepStrictEqual(caps(), [10000]);
    posts.length = 0;
    failed.post({ type: 'batch' });
    trio[1].post({ type: 'batch' });
    assert.deepStrictEqual(posts, [], 'disposed streams cannot post to the current tile or page');

    compare.addUris([compare.uris[1]]);
    await ready();
    const paths = () => Array.from(compare.uris, (_, i) => Boolean(compare.natives[i]));
    assert.deepStrictEqual(paths(), [false, true, true], 'add keeps fallback on the original occurrence');
    await compare.onMessage({ type: 'originalTile', index: 2 });
    compare.replaceUri(1, h.vscode.Uri.file(upright));
    await ready();
    assert.deepStrictEqual(paths(), [false, true, false], 'unrelated replace keeps both original tiles');
    await compare.onMessage({ type: 'remove', index: 0 });
    await ready();
    assert.deepStrictEqual(paths(), [true, false], 'remove shifts the surviving override with its tile');
    compare.replaceUri(1, compare.uris[1]);
    await ready();
    assert.deepStrictEqual(paths(), [true, true], 'replacing the overridden occurrence allows transcode again');

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
