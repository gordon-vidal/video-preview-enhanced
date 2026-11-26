'use strict';
// node test/run.js unit --grep unified_session: the unified page's host coordinator (src/unified-session.js)
// without VS Code: 1 -> 2 -> 3 -> 1 in one panel, tab titles, the duplicate and full toasts, Replace video,
// Leave compare, tile order, message routing by clip id, and the registry that routes newly opened videos into a
// capturing session.
const assert = require('assert');
const { createUnifiedSession, createUnifiedRegistry, titleOf, clipDescriptor } = require('../../src/unified-session');

const clip = (name) => ({ id: name, uri: `file:///v/${name}`, fsPath: `/v/${name}`, label: name });

/** A session over a fake panel; `calls` records every callback. */
function make(more = {}) {
  const posts = [];
  const titles = [];
  const calls = [];
  const panel = { title: '', webview: { html: '', postMessage: (m) => posts.push(m) } };
  const rec = (name) => (...a) => { calls.push([name, ...a]); };
  const s = createUnifiedSession({
    panel, initialClip: clip('a.mp4'), maxVideos: 4,
    onTitleChange: (t) => titles.push(t),
    onPlaybackPrefs: rec('playbackPrefs'), onCopyText: rec('copyText'), onSaveFrame: rec('saveFrame'),
    onOpenSettings: rec('openSettings'), onOpenUrl: rec('openUrl'), onExternal: rec('external'),
    onFocusMode: rec('focusMode'), onRailMessage: rec('rail'), onReadBlock: rec('readBlock'), onThumb: rec('thumb'),
    onDispose: rec('dispose'),
    ...more,
  });
  return { s, posts, titles, calls, panel };
}
/** The descriptor a clip made by clip() has: no probed facts yet. */
const desc = (name, more = {}) => ({
  clipId: name, label: name, name, size: 0, duration: 0, fps: 0, frames: 0, width: 0, height: 0, rotation: 0,
  hasAudio: true, native: false, codec: '', kind: 'file', ...more,
});
const toasts = (posts) => posts.filter((m) => m.type === 'toast').map((m) => m.text);

(async () => {
  { // Titles: one name, A ↔ B, then " · " with at most three names.
    assert.strictEqual(titleOf(['a']), 'a');
    assert.strictEqual(titleOf(['a', 'b']), 'a ↔ b');
    assert.strictEqual(titleOf(['a', 'b', 'c']), 'a · b · c');
    assert.strictEqual(titleOf(['a', 'b', 'c', 'd', 'e']), 'a · b · c (+2)');
  }

  { // 1 -> 2 -> 3 -> 1 in the same panel.
    const { s, posts, titles, panel } = make();
    assert.strictEqual(panel.title, 'a.mp4');
    assert.deepStrictEqual(titles, ['a.mp4']);
    await s.onMessage({ type: 'ready' });
    assert.deepStrictEqual(posts.shift(), {
      type: 'sessionState', clips: [desc('a.mp4')], order: ['a.mp4'], capture: false, maxVideos: 4,
    });
    assert.strictEqual(s.addClip(clip('b.mp4')), true);
    assert.strictEqual(panel.title, 'a.mp4 ↔ b.mp4');
    assert.deepStrictEqual(posts.pop(), { type: 'openVideo', clipId: 'b.mp4', label: 'b.mp4', clip: desc('b.mp4'), compare: true });
    assert.strictEqual(s.addClip(clip('c.mp4'), { compare: false }), true);
    assert.strictEqual(panel.title, 'a.mp4 · b.mp4 · c.mp4');
    assert.strictEqual(posts.pop().compare, false);
    assert.deepStrictEqual(s.order, ['a.mp4', 'b.mp4', 'c.mp4']);
    assert.ok(/class="compare"/.test(s.render({
      cspSource: 'c:', uri: (...p) => p.join('/'), base: 'b', loader: 'l.js', nonce: 'N', cfg: {},
    })), 'two or more clips: body.compare');
    assert.strictEqual(s.ready, false, 'a new page waits for ready again');
    await s.onMessage({ type: 'ready' });
    await s.onMessage({ type: 'leaveCompare', keepId: 'b.mp4' });
    assert.deepStrictEqual(s.clips.map((c) => c.id), ['b.mp4']);
    assert.strictEqual(panel.title, 'b.mp4');
    assert.strictEqual(s.capture, false);
    const html = s.render({ cspSource: 'c:', uri: (...p) => p.join('/'), base: 'b', loader: 'l.js', nonce: 'N', cfg: {} });
    assert.ok(!/<body class=/.test(html) && /src="player-unified\.js"/.test(html), 'one clip: no body class; the unified boot script');
    assert.strictEqual(panel.webview.html, html);
  }

  { // Duplicate and full: a toast, nothing added; posts before 'ready' wait (toasts), page state does not.
    const { s, posts } = make();
    assert.strictEqual(s.addClip(clip('a.mp4')), false);
    assert.strictEqual(s.addClip({ uri: 'file:///v/a.mp4', label: 'other' }), false, 'same file, another id');
    assert.strictEqual(posts.length, 0, 'nothing posted before ready');
    for (const n of ['b', 'c', 'd']) assert.ok(s.addClip(clip(`${n}.mp4`)));
    assert.strictEqual(s.addClip(clip('e.mp4')), false);
    assert.strictEqual(s.clips.length, 4);
    assert.strictEqual(s.title, 'a.mp4 · b.mp4 · c.mp4 (+1)');
    await s.onMessage({ type: 'ready' });
    assert.strictEqual(posts[0].type, 'sessionState');
    assert.deepStrictEqual(posts[0].order, ['a.mp4', 'b.mp4', 'c.mp4', 'd.mp4']);
    assert.ok(!posts.some((m) => m.type === 'openVideo'), 'sessionState carries the clips');
    assert.deepStrictEqual(toasts(posts), ['a.mp4 is in compare already', 'a.mp4 is in compare already', 'Compare is full (4 videos)']);
  }

  { // Add video and Replace video through the page.
    let excluded = null;
    const { s, posts } = make({
      onPickVideo: async (ex) => { excluded = ex; return [clip('b.mp4'), clip('a.mp4')]; },
      onReplacePick: async (oldId, ex) => (oldId === 'b.mp4' && ex.length === 2 ? clip('z.mp4') : null),
    });
    await s.onMessage({ type: 'ready' });
    await s.onMessage({ type: 'pickVideo' });
    assert.deepStrictEqual(excluded, ['a.mp4']);
    assert.deepStrictEqual(s.order, ['a.mp4', 'b.mp4']);
    assert.deepStrictEqual(toasts(posts), ['a.mp4 is in compare already']);
    await s.onMessage({ type: 'replaceVideo', clipId: 'b.mp4' });
    assert.deepStrictEqual(posts.pop(), {
      type: 'replaceTile', oldId: 'b.mp4', newId: 'z.mp4', label: 'z.mp4', clip: desc('z.mp4'),
    });
    assert.deepStrictEqual(s.order, ['a.mp4', 'z.mp4']);
    assert.strictEqual(s.title, 'a.mp4 ↔ z.mp4');
    assert.strictEqual(s.replaceClip('z.mp4', clip('a.mp4')), false, 'replacing with a shown file');
    assert.strictEqual(s.replaceClip('nope', clip('q.mp4')), false);
    await s.onMessage({ type: 'replaceVideo', clipId: 'missing' });
    assert.deepStrictEqual(s.order, ['a.mp4', 'z.mp4']);
  }

  { // tileOrder: only a permutation; tiles: the page's remaining tiles; tileSize; capture; rail marks.
    const { s } = make();
    let refreshed = 0;
    s.setRail({ refreshMembers: () => { refreshed++; } });
    s.addClip(clip('b.mp4'));
    s.addClip(clip('c.mp4'));
    assert.strictEqual(refreshed, 2);
    await s.onMessage({ type: 'tileOrder', order: ['c.mp4', 'a.mp4', 'b.mp4'] });
    assert.strictEqual(s.title, 'c.mp4 · a.mp4 · b.mp4');
    assert.deepStrictEqual(s.members(), ['/v/c.mp4', '/v/a.mp4', '/v/b.mp4']);
    for (const bad of [['c.mp4', 'a.mp4'], ['c.mp4', 'c.mp4', 'a.mp4'], ['x', 'a.mp4', 'b.mp4'], 'c.mp4']) {
      await s.onMessage({ type: 'tileOrder', order: bad });
      assert.deepStrictEqual(s.order, ['c.mp4', 'a.mp4', 'b.mp4'], `ignored: ${JSON.stringify(bad)}`);
    }
    await s.onMessage({ type: 'tileSize', clipId: 'a.mp4', w: 640, h: 360 });
    await s.onMessage({ type: 'tileSize', clipId: 'x', w: 640, h: 360 });
    assert.deepStrictEqual(s.tileSize('a.mp4'), { w: 640, h: 360 });
    assert.strictEqual(s.tileSize('x'), null);
    await s.onMessage({ type: 'tiles', order: ['b.mp4', 'a.mp4'], capture: true });
    assert.deepStrictEqual(s.order, ['b.mp4', 'a.mp4']);
    assert.strictEqual(s.capture, true);
    await s.onMessage({ type: 'tiles', order: [] });
    assert.deepStrictEqual(s.order, ['b.mp4', 'a.mp4'], 'never zero clips');
    await s.onMessage({ type: 'capture', on: false });
    assert.strictEqual(s.capture, false);
    assert.ok(refreshed >= 4);
  }

  { // Routing: the pass-through callbacks, and file reads / thumbnails by clip id only.
    const { s, calls } = make();
    s.addClip(clip('b.mp4'));
    await s.onMessage({ type: 'playbackPrefs', volume: 0.5 });
    await s.onMessage({ type: 'copyText', text: 42 });
    await s.onMessage({ type: 'saveFrame', clipId: 'b.mp4' });
    await s.onMessage({ type: 'openSettings' });
    await s.onMessage({ type: 'openUrl' });
    await s.onMessage({ type: 'external', clipId: 'a.mp4' });
    await s.onMessage({ type: 'focusMode' });
    await s.onMessage({ type: 'focusModeExited' });
    await s.onMessage({ type: 'rail', op: 'list' });
    await s.onMessage({ type: 'neighbour', dir: 1 });
    await s.onMessage({ type: 'readBlock', clipId: 'b.mp4', pos: 0, len: 10 });
    await s.onMessage({ type: 'readBlock', clipId: 'zzz', pos: 0, len: 10 });
    await s.onMessage({ type: 'readBlock', key: 'A', pos: 0, len: 10 });
    await s.onMessage({ type: 'thumb', clipId: 'a.mp4', id: 3 });
    await s.onMessage(null);
    await s.onMessage({ type: 'unknown' });
    assert.deepStrictEqual(calls.map((c) => c[0]), ['playbackPrefs', 'copyText', 'saveFrame', 'openSettings', 'openUrl',
      'external', 'focusMode', 'focusMode', 'rail', 'rail', 'readBlock', 'thumb']);
    assert.strictEqual(calls[0][1].volume, 0.5);
    assert.strictEqual(calls[0][2], s);
    assert.strictEqual(calls[1][1], '42');
    assert.deepStrictEqual([calls[6][1], calls[7][1]], ['toggle', 'exited']);
    assert.strictEqual(calls[10][1].fsPath, '/v/b.mp4');
    assert.strictEqual(calls[10][2].pos, 0);
    assert.strictEqual(calls[11][1].id, 'a.mp4');
  }

  { // Clip descriptors: probed facts reach the page (sessionState, openVideo, replaceTile), paths never do.
    const probed = (name, more) => ({ ...clip(name), ...more });
    const { s, posts } = make({
      initialClip: probed('a.mp4', { size: 1000, duration: 2.5, fps: 25, frames: 62, width: 640, height: 360, codec: 'h264' }),
      onReplacePick: async () => probed('r.mkv', { meta: { size: 77, native: true, codec: 'prores', fsPath: '/secret' } }),
    });
    await s.onMessage({ type: 'ready' });
    const st = posts.shift();
    assert.deepStrictEqual(st.clips, [desc('a.mp4', {
      size: 1000, duration: 2.5, fps: 25, frames: 62, width: 640, height: 360, codec: 'h264',
    })]);
    s.addClip(probed('n.mov', { size: 5e9, native: true, hasAudio: false, kind: 'remote', duration: -1, fps: 'x' }));
    const ov = posts.pop();
    assert.deepStrictEqual(ov.clip, desc('n.mov', { size: 5e9, native: true, hasAudio: false, kind: 'remote' }));
    await s.onMessage({ type: 'replaceVideo', clipId: 'n.mov' });
    const rt = posts.pop();
    assert.deepStrictEqual(rt.clip, desc('r.mkv', { size: 77, native: true, codec: 'prores' }), 'meta fills what the clip lacks');
    const text = JSON.stringify([st, ov, rt]);
    assert.ok(!/\/v\/|file:|secret|fsPath|uri/.test(text), `no path leaks: ${text}`);
    assert.deepStrictEqual(clipDescriptor({ id: 'q', label: 'q' }), { ...desc('q') });
  }

  { // Native decoders ('nd'): by clip id; two native clips' interleaved replies keep their ids; unknown ids ignored.
    const got = [];
    const { s, posts } = make({ initialClip: { ...clip('a.mp4'), native: true }, onNative: (c, m) => { got.push([c.id, m.m.type]); } });
    await s.onMessage({ type: 'nd', m: { type: 'open' } });
    assert.deepStrictEqual(got, [['a.mp4', 'open']], 'one clip: an untagged request is its');
    s.addClip({ ...clip('b.mp4'), native: true });
    await s.onMessage({ type: 'ready' });
    posts.length = 0;
    await s.onMessage({ type: 'nd', key: 'b.mp4', clipId: 'b.mp4', m: { type: 'open' } });
    await s.onMessage({ type: 'nd', clipId: 'a.mp4', m: { type: 'seek', t: 1 } });
    await s.onMessage({ type: 'nd', key: 'b.mp4', m: { type: 'seek', t: 2 } });
    await s.onMessage({ type: 'nd', clipId: 'zzz', m: { type: 'open' } });
    await s.onMessage({ type: 'nd', m: { type: 'open' } });
    assert.deepStrictEqual(got.slice(1), [['b.mp4', 'open'], ['a.mp4', 'seek'], ['b.mp4', 'seek']]);
    assert.ok(s.postNativeReply('a.mp4', { type: 'frame', n: 1 }));
    assert.ok(s.postNativeReply('b.mp4', { type: 'frame', n: 7 }));
    assert.ok(s.postNativeReply('a.mp4', { type: 'frame', n: 2 }));
    assert.strictEqual(s.postNativeReply('zzz', { type: 'frame' }), false);
    assert.deepStrictEqual(posts.map((m) => [m.type, m.clipId, m.key, m.m.n]),
      [['nd', 'a.mp4', 'a.mp4', 1], ['nd', 'b.mp4', 'b.mp4', 7], ['nd', 'a.mp4', 'a.mp4', 2]]);
  }

  { // tiles from media/player-ui.js ({ tabId, tiles, current }): a closed tile leaves the session and frees a slot.
    const { s, panel } = make({ maxVideos: 2 });
    let refreshed = 0;
    s.setRail({ refreshMembers: () => { refreshed++; } });
    assert.ok(s.addClip(clip('b.mp4')));
    assert.strictEqual(s.addClip(clip('c.mp4')), false, 'full');
    assert.deepStrictEqual(s.members(), ['/v/a.mp4', '/v/b.mp4']);
    await s.onMessage({ type: 'tileSize', clipId: 'b.mp4', w: 10, h: 10 });
    await s.onMessage({ type: 'tiles', tabId: 't1', tiles: ['a.mp4', 'b.mp4'], current: 'a.mp4' });
    const before = refreshed;
    await s.onMessage({ type: 'tiles', tabId: 't1', tiles: ['a.mp4'], current: 'a.mp4' });
    assert.deepStrictEqual(s.order, ['a.mp4']);
    assert.deepStrictEqual(s.clips.map((c) => c.id), ['a.mp4']);
    assert.strictEqual(panel.title, 'a.mp4');
    assert.deepStrictEqual(s.members(), ['/v/a.mp4']);
    assert.ok(refreshed > before, 'rail marks refreshed');
    assert.strictEqual(s.tileSize('b.mp4'), null);
    assert.ok(s.addClip(clip('c.mp4')), 'a slot is free again');
    await s.onMessage({ type: 'capture', on: true });
    assert.strictEqual(s.capture, true);
  }

  { // tileSize as media/player-ui-lifecycle.js posts it ({ tile }), and top-level with a clip id.
    const sizes = [];
    const { s } = make({ onTileSize: (size, c) => { sizes.push([size, c && c.id]); } });
    assert.strictEqual(s.lastTileSize, null);
    await s.onMessage({ type: 'tileSize', tile: { w: 800, h: 450, n: 2, layout: 'grid', zoom: 1, rate: 1 } });
    const t = { w: 800, h: 450, n: 2, layout: 'grid', zoom: 1, rate: 1 };
    assert.deepStrictEqual(s.lastTileSize, t);
    assert.deepStrictEqual(sizes, [[t, null]]);
    await s.onMessage({ type: 'tileSize', clipId: 'a.mp4', w: 320, h: 180 });
    assert.deepStrictEqual(s.tileSize('a.mp4'), { w: 320, h: 180 });
    assert.deepStrictEqual(sizes[1], [{ w: 320, h: 180 }, 'a.mp4']);
    await s.onMessage({ type: 'tileSize', tile: { w: 0, h: 450 } });
    await s.onMessage({ type: 'tileSize', clipId: 'gone', w: 1, h: 1 });
    assert.strictEqual(sizes.length, 2, 'bad sizes and unknown clips ignored');
    assert.deepStrictEqual(s.lastTileSize, { w: 320, h: 180 });
  }

  { // Dispose: once, nothing after.
    const { s, calls, posts } = make({ capture: true });
    await s.onMessage({ type: 'ready' });
    s.dispose();
    s.dispose();
    assert.strictEqual(calls.filter((c) => c[0] === 'dispose').length, 1);
    assert.strictEqual(s.shouldCapture(), false);
    assert.strictEqual(s.addClip(clip('b.mp4')), false);
    const n = posts.length;
    await s.onMessage({ type: 'copyText', text: 'x' });
    s.post({ type: 'toast', text: 'late' });
    assert.strictEqual(posts.length, n);
    assert.strictEqual(calls.filter((c) => c[0] === 'copyText').length, 0);
  }

  { // Registry: the most recently active capturing session takes a new video; none captures: a new tab.
    const reg = createUnifiedRegistry();
    const one = make().s;
    const two = make({ initialClip: clip('x.mp4') }).s;
    reg.add(one);
    reg.add(two);
    assert.deepStrictEqual(reg.routeOpen(clip('n.mp4')), { captured: false }, 'capture off everywhere');
    one.setCapture(true);
    two.setCapture(true);
    let r = reg.routeOpen(clip('n.mp4'));
    assert.ok(r.captured && r.session === two && r.added, 'the last one switched on');
    one.setActive(true);
    r = reg.routeOpen(clip('m.mp4'));
    assert.ok(r.captured && r.session === one);
    assert.deepStrictEqual(one.order, ['a.mp4', 'm.mp4']);
    r = reg.routeOpen(clip('m.mp4'));
    assert.ok(r.captured && r.session === one && !r.added, 'a duplicate stays in the capturing panel');
    await one.onMessage({ type: 'capture', on: false });
    r = reg.routeOpen(clip('k.mp4'));
    assert.ok(r.captured && r.session === two, 'capture toggled off: the other one');
    two.dispose();
    assert.deepStrictEqual(reg.routeOpen(clip('j.mp4')), { captured: false }, 'disposed: not routed to');
    assert.ok(!reg.sessions.includes(two));
    one.setCapture(true);
    for (const n of ['p', 'q']) assert.ok(reg.routeOpen(clip(`${n}.mp4`)).captured);
    assert.strictEqual(one.clips.length, 4);
    assert.deepStrictEqual(reg.routeOpen(clip('full.mp4')), { captured: false }, 'full: a new tab');
    one.leaveCompare('a.mp4');
    assert.strictEqual(one.capture, false, 'Leave compare ends capture');
    assert.strictEqual(reg.capturing(), null);
  }

  { // Multi-add interleaving: adding B and C then receiving an earlier [A, B] tiles report does not drop C.
    const { s } = make();
    await s.onMessage({ type: 'ready' });
    assert.strictEqual(s.addClip(clip('b.mp4')), true);
    assert.strictEqual(s.addClip(clip('c.mp4')), true);
    assert.deepStrictEqual(s.order, ['a.mp4', 'b.mp4', 'c.mp4']);
    // Page processed B first and sent tiles: [A, B] before processing C's openVideo.
    await s.onMessage({ type: 'tiles', tiles: ['a.mp4', 'b.mp4'] });
    assert.deepStrictEqual(s.order, ['a.mp4', 'b.mp4', 'c.mp4'], 'in-flight C is preserved');
    assert.strictEqual(s.clips.length, 3);
    // Once the page acknowledges C, a subsequent close of C removes it cleanly.
    await s.onMessage({ type: 'tiles', tiles: ['a.mp4', 'b.mp4', 'c.mp4'] });
    await s.onMessage({ type: 'tiles', tiles: ['a.mp4', 'b.mp4'] });
    assert.deepStrictEqual(s.order, ['a.mp4', 'b.mp4'], 'acknowledged C can be removed');
    assert.strictEqual(s.clips.length, 2);
  }

  console.log('unified_session_test: ok');
})().catch((e) => { console.error(e); process.exit(1); });
