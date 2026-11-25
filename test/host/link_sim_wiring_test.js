'use strict';
// VPE_SIMULATE_LINK in the host (src/extension.js, src/compare.js): a Compare panel's `nd` messages take the simulated
// link in both directions, other messages do not, the window acts like SSH, a closed panel gets no late message, and
// with the variable unset nothing is delayed. (The rules of the link itself: link_sim_test.js, on a virtual clock.)
const assert = require('assert');
const { load } = require('./mock_vscode');
const { make } = require('../media/make_cases_media');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function openCompare(clip) {
  const h = load({ settings: { 'videoPreviewEnhanced.decoder': 'builtin' } });
  const posts = [];
  let receive = null;
  const webview = {
    cspSource: 'vscode-resource:', asWebviewUri: (u) => u,
    postMessage(m) { posts.push(m); }, onDidReceiveMessage(fn) { receive = fn; },
  };
  h.vscode.window.createWebviewPanel = () => ({ webview, onDidDispose() {}, onDidChangeViewState() {} });
  const compare = await h.vscode._commands['videoPreviewEnhanced.compare'](null, [clip, clip].map(h.vscode.Uri.file));
  const cfg = () => JSON.parse(/<script type="application\/json" id="cfg">([^<]*)<\/script>/.exec(webview.html)[1]);
  const boot = 'link-document';
  await receive({ type: 'ready', page: cfg().page, boot });
  return { h, compare, posts, receive: (m) => receive({ boot, ...m }), cfg };
}

(async () => {
  const clip = make('s_h264.mp4');
  assert.ok(clip, 'ffmpeg test clip');
  const saved = process.env.VPE_SIMULATE_LINK;
  const savedRemote = process.env.VPE_SIMULATE_REMOTE;
  delete process.env.VPE_SIMULATE_REMOTE;
  const nd = (posts) => posts.filter((m) => m.type === 'nd');
  try {
    // Link on: 60 ms round trip, 30 ms each way.
    process.env.VPE_SIMULATE_LINK = 'mbps=8,rtt=60';
    const on = await openCompare(clip);
    const { compare, posts, cfg } = on;
    assert.strictEqual(on.h.vscode.env.remoteName, undefined, 'a local window');
    assert.strictEqual(cfg().engine.remote, true, 'the page is told it is on a remote link');

    const page = cfg().page;
    posts.length = 0;
    compare.post({ type: 'visible', visible: true });
    assert.strictEqual(posts.length, 1, 'only nd messages take the link');
    compare.post({ type: 'nd', key: 'A', m: { type: 'frame' } });
    assert.strictEqual(nd(posts).length, 0, 'an nd message is on the link');
    await wait(120);
    assert.deepStrictEqual(nd(posts).map((m) => [m.key, m.page]), [['A', page]], 'it arrives, with the page id');

    const handled = [];
    compare.onMessage = async (m) => { handled.push(m.type); };
    on.receive({ type: 'tileSize', page });
    on.receive({ type: 'nd', key: 'A', m: { type: 'open' }, page });
    assert.deepStrictEqual(handled, ['tileSize'], 'the page\'s nd message is on the link too');
    await wait(120);
    assert.deepStrictEqual(handled, ['tileSize', 'nd']);

    // Gone before it arrives: nothing reaches the closed panel, and nothing runs for it.
    posts.length = 0;
    compare.post({ type: 'nd', key: 'A', m: { type: 'frame' } });
    on.receive({ type: 'nd', key: 'A', m: { type: 'open' }, page });
    compare.dispose();
    await wait(120);
    assert.strictEqual(nd(posts).length, 0, 'no late post');
    assert.deepStrictEqual(handled, ['tileSize', 'nd'], 'no late handler');
    on.h.dispose();

    // Link off: the same calls are immediate.
    delete process.env.VPE_SIMULATE_LINK;
    const off = await openCompare(clip);
    assert.strictEqual(off.cfg().engine.remote, false);
    off.posts.length = 0;
    off.compare.post({ type: 'nd', key: 'A', m: { type: 'frame' } });
    assert.strictEqual(nd(off.posts).length, 1, 'no delay without the variable');
    let ran = 0;
    off.compare.onMessage = async () => { ran++; };
    off.receive({ type: 'nd', key: 'A', m: {}, page: off.cfg().page });
    assert.strictEqual(ran, 1);
    off.compare.dispose();
    off.h.dispose();

    // A spec that does not parse simulates nothing, not even the SSH window.
    process.env.VPE_SIMULATE_LINK = 'dialup';
    const bad = await openCompare(clip);
    assert.strictEqual(bad.cfg().engine.remote, false);
    bad.compare.dispose();
    bad.h.dispose();

    // VPE_SIMULATE_REMOTE alone changes the window kind, not the transport.
    delete process.env.VPE_SIMULATE_LINK;
    process.env.VPE_SIMULATE_REMOTE = 'dev-container';
    const kind = await openCompare(clip);
    assert.strictEqual(kind.cfg().engine.remote, true);
    kind.posts.length = 0;
    kind.compare.post({ type: 'nd', key: 'A', m: {} });
    assert.strictEqual(nd(kind.posts).length, 1);
    kind.compare.dispose();
    kind.h.dispose();
  } finally {
    for (const [k, v] of [['VPE_SIMULATE_LINK', saved], ['VPE_SIMULATE_REMOTE', savedRemote]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
  console.log('link_sim_wiring ok');
})().catch((e) => { console.error(e); process.exit(1); });
