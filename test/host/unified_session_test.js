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
  hasAudio: true, native: false, codec: '', kind: 'file', sourceKind: 'file', ...more,
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
      type: 'sessionState', clips: [desc('a.mp4')], order: ['a.mp4'], capture: false, maxVideos: 4, sourceKind: 'file',
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
    // Compare: the page's per-tile cells (a Spotlight hero and its strip) are kept per clip, with the shared fields;
    // an unknown clip or a malformed entry is skipped.
    await s.onMessage({ type: 'tileSize', tile: { w: 1200, h: 680, n: 3, layout: 'spotlight', zoom: 1, tiles: [
      { clipId: 'c.mp4', w: 1200, h: 680 }, { clipId: 'a.mp4', w: 599, h: 300 }, { clipId: 'x', w: 9, h: 9 },
      { clipId: 'b.mp4', w: -1, h: 300 }, null, { clipId: 7, w: 5, h: 5 },
    ] } });
    assert.deepStrictEqual(s.tileSize('c.mp4'), { w: 1200, h: 680, n: 3, layout: 'spotlight', zoom: 1 });
    assert.deepStrictEqual(s.tileSize('a.mp4'), { w: 599, h: 300, n: 3, layout: 'spotlight', zoom: 1 });
    assert.strictEqual(s.tileSize('x'), null);
    assert.strictEqual(s.tileSize('b.mp4'), null, 'a malformed cell is not kept');
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

  { // The player's remaining messages: each to its callback, with the clip it names (else the first one shown).
    const calls = [];
    const rec = (name) => (...a) => { calls.push([name, ...a]); };
    const { s } = make({
      onLoadSubs: rec('loadSubs'), onCopyLink: rec('copyLink'), onExportAb: rec('exportAb'), onExactFrame: rec('exact'),
      onPos: rec('pos'), onAction: rec('action'), onTranscodePref: rec('transcodePref'),
      onTranscodeResolution: rec('transcodeResolution'), onOriginalTile: rec('originalTile'), onQuality: rec('quality'),
      onRailAdopted: rec('railAdopted'),
    });
    s.addClip(clip('b.mp4'));
    await s.onMessage({ type: 'loadSubs', clipId: 'b.mp4' });
    await s.onMessage({ type: 'copyLink', frame: 3, t: 0.12 });
    await s.onMessage({ type: 'copyLink', clipId: 'gone', frame: 3 });
    for (const type of ['exportRange', 'clipRange', 'ffmpegRange']) await s.onMessage({ type, clipId: 'b.mp4', range: { a: 1, b: 2 } });
    await s.onMessage({ type: 'exportFrame', id: 4, frame: 9, data: new Uint8Array(1) });
    await s.onMessage({ type: 'grabExactFrame', key: 'b.mp4', reqId: 1, t: 2 });
    await s.onMessage({ type: 'pos', clipId: 'b.mp4', t: 12.5, d: 60 });
    await s.onMessage({ type: 'pos', t: -1 });
    await s.onMessage({ type: 'pos', clipId: 'a.mp4', t: 'x' });
    await s.onMessage({ type: 'action', id: 'fullRes' });
    await s.onMessage({ type: 'action', id: 7 });
    await s.onMessage({ type: 'whenSlow', value: 'skip' });
    await s.onMessage({ type: 'transcodePref', mode: 'off' });
    await s.onMessage({ type: 'transcodeResolution', height: 720 });
    await s.onMessage({ type: 'originalTile', clipId: 'b.mp4' });
    await s.onMessage({ type: 'quality', pick: 'auto' });
    await s.onMessage({ type: 'railAdopted', id: 2, ok: true });
    // The first argument: a clip (its id), an export kind or action id (a string), or the message (its mode / id).
    const first = (a) => (typeof a === 'string' ? a : a.label ? a.id : a.mode || a.id);
    assert.deepStrictEqual(calls.map((c) => [c[0], first(c[1])]), [
      ['loadSubs', 'b.mp4'], ['copyLink', 'a.mp4'],
      ['exportAb', 'exportRange'], ['exportAb', 'clipRange'], ['exportAb', 'ffmpegRange'], ['exportAb', 'exportFrame'],
      ['exact', 'b.mp4'], ['pos', 'b.mp4'], ['action', 'fullRes'], ['action', 'whenSlow'], ['transcodePref', 'off'],
      ['transcodeResolution', 'a.mp4'], ['originalTile', 'b.mp4'], ['quality', 'a.mp4'], ['railAdopted', 2],
    ]);
    assert.strictEqual(calls.find((c) => c[0] === 'exportAb')[2].id, 'b.mp4', 'the range names its clip');
    assert.deepStrictEqual(calls.find((c) => c[0] === 'pos')[2], { t: 12.5, d: 60 });
    assert.deepStrictEqual(s.positionOf('b.mp4'), { t: 12.5, d: 60 });
    assert.strictEqual(s.positionOf('a.mp4'), null, 'bad positions are not kept');
    assert.strictEqual(calls.find((c) => c[0] === 'action' && c[1] === 'whenSlow')[2].value, 'skip');
    assert.strictEqual(s.clipFor({ clipId: 'zzz' }), null);
    assert.strictEqual(s.clipFor({}).id, 'a.mp4');
    assert.strictEqual(s.clipFor({ key: 'b.mp4' }).id, 'b.mp4');
  }

  { // Open target: a frame link / saved position / rail carry go with the first sessionState only; live goto.
    const { s, posts } = make({
      initialClip: { ...clip('a.mp4'), kind: 'url', goto: { frame: 5, junk: 1 }, savedPos: { t: 3 } },
      openTarget: { goto: { t: 1.5, mode: 'paused' }, savedPos: { t: 40, d: 100 }, railCarry: { open: true } },
    });
    assert.deepStrictEqual(s.openTarget, { goto: { t: 1.5, mode: 'paused' }, savedPos: { t: 40, d: 100 }, railCarry: { open: true } });
    await s.onMessage({ type: 'ready' });
    const st = posts.shift();
    assert.strictEqual(st.sourceKind, 'url');
    assert.deepStrictEqual([st.goto, st.savedPos, st.railCarry], [{ t: 1.5, mode: 'paused' }, { t: 40, d: 100 }, { open: true }]);
    assert.deepStrictEqual(st.clips[0], desc('a.mp4', { kind: 'url', sourceKind: 'url', goto: { frame: 5 }, savedPos: { t: 3, d: 0 } }));
    assert.strictEqual(s.openTarget, null, 'spent');
    await s.onMessage({ type: 'ready' });
    const again = posts.shift();
    assert.ok(!('goto' in again) && !('railCarry' in again), 'a reloaded page does not jump again');
    assert.strictEqual(s.goto({ frame: 10, t: 0.4 }), true);
    assert.deepStrictEqual(posts.pop(), { type: 'goto', frame: 10, t: 0.4 });
    assert.strictEqual(s.goto({ frame: -1 }), false);
    assert.strictEqual(s.goto(null), false);
    assert.strictEqual(s.goto({ t: 2 }, 'a.mp4'), true);
    assert.deepStrictEqual(posts.pop(), { type: 'goto', t: 2, clipId: 'a.mp4' });
    s.setOpenTarget({ goto: { bad: 1 } });
    assert.strictEqual(s.openTarget, null);
    assert.strictEqual(clipDescriptor({ id: 'q', label: 'q', sourceKind: 'sequence', kind: 'url' }).sourceKind, 'sequence');
    assert.strictEqual(clipDescriptor({ id: 'q', label: 'q', kind: 'remote' }).sourceKind, 'file');
  }

  { // reloadClip: the same tile under a new id, at its last position, tile size kept; no webview reload.
    const { s, posts, panel } = make();
    s.addClip(clip('b.mp4'));
    await s.onMessage({ type: 'ready' });
    await s.onMessage({ type: 'tileSize', clipId: 'b.mp4', w: 320, h: 180 });
    await s.onMessage({ type: 'pos', clipId: 'b.mp4', t: 7, d: 20 });
    posts.length = 0;
    const html = panel.webview.html;
    assert.strictEqual(s.reloadClip('b.mp4', { ...clip('b.mp4'), size: 99 }), 'clip1', 'the old id is never reused');
    const r = posts.pop();
    assert.deepStrictEqual([r.type, r.oldId, r.newId, r.reload, r.clip.size, r.clip.savedPos], ['replaceTile', 'b.mp4', 'clip1', true, 99, { t: 7, d: 20 }]);
    assert.deepStrictEqual(s.order, ['a.mp4', 'clip1']);
    assert.deepStrictEqual(s.tileSize('clip1'), { w: 320, h: 180 });
    assert.deepStrictEqual(s.positionOf('clip1'), { t: 7, d: 20 });
    assert.strictEqual(s.positionOf('b.mp4'), null);
    assert.strictEqual(panel.webview.html, html);
    assert.strictEqual(s.reloadClip('clip1', { ...clip('b.mp4'), id: 'b2' }), 'b2');
    assert.strictEqual(s.reloadClip('nope', clip('q.mp4')), null);
    assert.strictEqual(s.reloadClip('b2', clip('a.mp4')), null, 'another shown file');
    assert.deepStrictEqual(s.order, ['a.mp4', 'b2']);
  }

  { // session.batch: a host transaction. Tile changes post nothing one by one, the page is set once at the end, and
    // its 'ready' sessionState carries them all; a toast made meanwhile waits for that page. Async and nested too.
    const input = { cspSource: 'c:', uri: (...p) => p.join('/'), base: 'b', loader: 'l.js', nonce: 'N', cfg: {} };
    const { s, posts, panel } = make({ renderHtml: () => input });
    await s.onMessage({ type: 'ready' });
    assert.ok(s.addClip(clip('b.mp4')));
    posts.length = 0;
    let htmlSets = 0;
    let html = panel.webview.html;
    Object.defineProperty(panel.webview, 'html', { get: () => html, set: (v) => { htmlSets++; html = v; } });

    const out = s.batch(() => {
      assert.strictEqual(s.batching, true);
      s.reloadClip('a.mp4', { ...clip('a.mp4'), id: 'a2' });
      s.batch(() => s.replaceClip('b.mp4', clip('c.mp4'))); // nested: no render of its own
      assert.strictEqual(htmlSets, 0, 'a nested batch does not render');
      s.addClip(clip('a2.mp4'));
      s.removeClip('a2.mp4');
      s.post({ type: 'toast', text: 'kept', ms: 1 });
      return 'done';
    });
    assert.strictEqual(out, 'done', 'batch returns what fn returns');
    assert.strictEqual(s.batching, false);
    assert.deepStrictEqual(posts.map((m) => m.type), [], 'no replaceTile / openVideo / removeVideo / toast to the old page');
    assert.strictEqual(htmlSets, 1, 'rendered once');
    assert.strictEqual(s.ready, false, 'a new page: posts wait for its ready');
    await s.onMessage({ type: 'ready' });
    assert.deepStrictEqual(posts.map((m) => m.type), ['sessionState', 'toast']);
    assert.deepStrictEqual(posts[0].order, ['a2', 'c.mp4'], 'the new page gets every change at once');

    // Async: the batch lasts until the promise settles; a failure still renders the changes made until then.
    posts.length = 0;
    htmlSets = 0;
    let release;
    const gate = new Promise((r) => { release = r; });
    const p = s.batch(async () => { await gate; s.replaceClip('c.mp4', clip('d.mp4')); });
    assert.strictEqual(s.batching, true);
    assert.strictEqual(htmlSets, 0);
    release();
    await p;
    assert.deepStrictEqual([s.batching, htmlSets, posts.length], [false, 1, 0]);
    await assert.rejects(s.batch(async () => { s.replaceClip('d.mp4', clip('e.mp4')); throw new Error('boom'); }), /boom/);
    assert.deepStrictEqual([s.batching, htmlSets, s.order], [false, 2, ['a2', 'e.mp4']], 'a failed batch still renders');
    assert.throws(() => s.batch(() => { throw new Error('sync'); }), /sync/);
    assert.deepStrictEqual([s.batching, htmlSets], [false, 3]);
    // Outside a batch the incremental posts work as before.
    await s.onMessage({ type: 'ready' });
    posts.length = 0;
    s.replaceClip('e.mp4', clip('f.mp4'));
    assert.deepStrictEqual(posts.map((m) => m.type), ['replaceTile']);
  }

  { // session.batch holds back only tile changes and notices: replies to the old page's requests (blocks, native
    // frames, thumbnails, exact frames) reach it at once, and none is sent on to the new page after the render.
    const input = { cspSource: 'c:', uri: (...p) => p.join('/'), base: 'b', loader: 'l.js', nonce: 'N', cfg: {} };
    const { s, posts } = make({ renderHtml: () => input });
    s.render();
    await s.onMessage({ type: 'ready' });
    assert.ok(s.addClip(clip('b.mp4')));
    posts.length = 0;
    let release;
    const gate = new Promise((r) => { release = r; });
    const done = s.batch(async () => {
      s.replaceClip('b.mp4', clip('c.mp4'));
      s.post({ type: 'block', pos: 0, data: 'x' });
      assert.ok(s.postNativeReply('a.mp4', { type: 'frame', n: 1 }));
      s.post({ type: 'thumb', id: 1 });
      s.post({ type: 'exactFrame', id: 2 });
      s.post({ type: 'toast', text: 'later', ms: 1 });
      await gate; // the old page keeps asking while the batch waits (a reload re-preparing its clips)
      s.post({ type: 'block', pos: 1, data: 'y' });
    });
    assert.deepStrictEqual(posts.map((m) => m.type), ['block', 'nd', 'thumb', 'exactFrame'],
      'replies reach the old page at once; no replaceTile, the toast waits');
    release();
    await done;
    assert.deepStrictEqual(posts.map((m) => m.type), ['block', 'nd', 'thumb', 'exactFrame', 'block']);
    assert.strictEqual(s.ready, false, 'the batch rendered a new page');
    // A reply that comes after the render but before the new page is ready is for the old page: never delivered.
    s.post({ type: 'block', pos: 2, data: 'z' });
    posts.length = 0;
    await s.onMessage({ type: 'ready' });
    assert.deepStrictEqual(posts.map((m) => m.type), ['sessionState', 'toast'], 'the new page gets its state and the notice only');
    assert.strictEqual(toasts(posts)[0], 'later');
  }

  console.log('unified_session_test: ok');
})().catch((e) => { console.error(e); process.exit(1); });
