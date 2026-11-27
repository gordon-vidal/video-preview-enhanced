'use strict';
// VPE_SIMULATE_LINK in the host (src/extension.js deps.link, src/unified-viewer.js): a viewer's `nd` messages take the
// simulated link in both directions, other messages do not, the window acts like SSH, a closed panel gets no late
// message, and with the variable unset nothing is delayed. (The rules of the link itself: link_sim_test.js, on a
// virtual clock.)
const assert = require('assert');
const { load } = require('./mock_vscode');
const { make } = require('../media/make_cases_media');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A viewer comparing the clip with itself (Compare's command), its page ready. */
async function openCompare(clip) {
  const h = load({ settings: { 'videoPreviewEnhanced.decoder': 'builtin' } });
  const s = h.nextPanel();
  const viewer = await h.vscode._commands['videoPreviewEnhanced.compare'](null, [clip, clip].map(h.vscode.Uri.file));
  await s.send({ type: 'ready', boot: 'link-document' });
  const id = viewer.session.clips[0].id;
  return { h, viewer, s, posts: s.posted, cfg: s.cfg, id };
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
    const { viewer, posts, cfg, id } = on;
    assert.strictEqual(on.h.vscode.env.remoteName, undefined, 'a local window');
    assert.strictEqual(cfg().engine.remote, true, 'the page is told it is on a remote link');

    const page = cfg().page;
    posts.length = 0;
    viewer.post({ type: 'toast', text: 'x' });
    assert.strictEqual(posts.length, 1, 'only nd messages take the link');
    viewer.session.postNativeReply(id, { type: 'frame' });
    assert.strictEqual(nd(posts).length, 0, 'an nd message is on the link');
    await wait(120);
    assert.deepStrictEqual(nd(posts).map((m) => [m.clipId, m.page]), [[id, page]], 'it arrives, with the page id');

    const handled = [];
    viewer.session.onMessage = async (m) => { handled.push(m.type); };
    on.s.send({ type: 'tileSize', page, tile: { w: 10, h: 10 } });
    on.s.send({ type: 'nd', clipId: id, m: { type: 'open' }, page });
    await wait(5);
    assert.deepStrictEqual(handled, ['tileSize'], 'the page\'s nd message is on the link too');
    await wait(120);
    assert.deepStrictEqual(handled, ['tileSize', 'nd']);

    // Gone before it arrives: nothing reaches the closed panel, and nothing runs for it.
    posts.length = 0;
    viewer.session.postNativeReply(id, { type: 'frame' });
    on.s.send({ type: 'nd', clipId: id, m: { type: 'open' }, page });
    await wait(5);
    on.s.panel.dispose();
    await wait(120);
    assert.strictEqual(nd(posts).length, 0, 'no late post');
    assert.deepStrictEqual(handled, ['tileSize', 'nd'], 'no late handler');
    on.h.dispose();

    // Link off: the same calls are immediate.
    delete process.env.VPE_SIMULATE_LINK;
    const off = await openCompare(clip);
    assert.strictEqual(off.cfg().engine.remote, false);
    off.posts.length = 0;
    off.viewer.session.postNativeReply(off.id, { type: 'frame' });
    assert.strictEqual(nd(off.posts).length, 1, 'no delay without the variable');
    let ran = 0;
    off.viewer.session.onMessage = async () => { ran++; };
    await off.s.send({ type: 'nd', clipId: off.id, m: {}, page: off.cfg().page });
    assert.strictEqual(ran, 1);
    off.s.panel.dispose();
    off.h.dispose();

    // A spec that does not parse simulates nothing, not even the SSH window.
    process.env.VPE_SIMULATE_LINK = 'dialup';
    const bad = await openCompare(clip);
    assert.strictEqual(bad.cfg().engine.remote, false);
    bad.s.panel.dispose();
    bad.h.dispose();

    // VPE_SIMULATE_REMOTE alone changes the window kind, not the transport.
    delete process.env.VPE_SIMULATE_LINK;
    process.env.VPE_SIMULATE_REMOTE = 'dev-container';
    const kind = await openCompare(clip);
    assert.strictEqual(kind.cfg().engine.remote, true);
    kind.posts.length = 0;
    kind.viewer.session.postNativeReply(kind.id, {});
    assert.strictEqual(nd(kind.posts).length, 1);
    kind.s.panel.dispose();
    kind.h.dispose();
  } finally {
    for (const [k, v] of [['VPE_SIMULATE_LINK', saved], ['VPE_SIMULATE_REMOTE', savedRemote]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
  console.log('link_sim_wiring ok');
})().catch((e) => { console.error(e); process.exit(1); });
