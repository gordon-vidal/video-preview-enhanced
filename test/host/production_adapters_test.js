'use strict';
// The production adapters (media/player-engine-adapter.js, media/player-host-adapter.js) against the same contract
// the mockup's fakes pass (test/host/adapter_contract_test.js), plus what only the production side does: player
// metadata, the sound routing over N players, the page / boot envelope, the per-surface message names and the
// webview state. No video is decoded: the players are in-memory stubs, the host is FakeHost behind a vscode bridge.
const assert = require('assert');
const { runEngineAdapterContract, runHostAdapterContract, fakeCanvas } = require('./adapter_contract_test');
const VpeEngineAdapter = require('../../media/player-engine-adapter.js');
const VpeHostAdapter = require('../../media/player-host-adapter.js');
const VpePicture = require('../../media/picture.js');
const { createFakeEngine } = require('../../tools/mockup/fake-engine');
const { createFakeHost } = require('../../tools/mockup/fake-host');

const T0 = Date.now();
const pngSource = createFakeEngine();

/**
 * An engine.js-like player: meta, fps, n, info, the shown picture, thumbnails and volume. A seek is presented
 * `o.delayMs` later (engine.js: seekTarget clears, shownT is set, shownCount counts the picture), and the picture's
 * PNG ends with the shown frame's number, so successive frames give visibly different bytes.
 */
function stubPlayer(/** @type {any} */ o) {
  const png = (/** @type {number} */ k) => Buffer.concat([Buffer.from(pngSource.snapshot('clip-0', 0).data), Buffer.from([k & 255])]);
  const p = {
    meta: { duration: o.frames / o.fps, width: o.width, height: o.height, size: 1e6 },
    fps: o.fps, n: o.frames, audio: o.audio ? {} : null,
    info: { video: { codec: 'h264', width: o.width, height: o.height }, ...(o.audio ? { audio: { codec: 'aac', channels: 2, sampleRate: 48000 } } : {}) },
    shown: 0,
    shownT: /** @type {number | null} */ (0),
    seekTarget: /** @type {number | null} */ (null),
    shownCount: 1,
    seeks: /** @type {number[]} */ ([]),
    paused: 0,
    volume: /** @type {any} */ (null),
    thumbs: 0,
    leaves: 0,
    currentFrame() { return p.shown; },
    pause() { p.paused++; },
    seekFrame(/** @type {number} */ k) {
      p.seeks.push(k);
      p.seekTarget = k / o.fps;
      setTimeout(() => {
        if (p.seekTarget !== k / o.fps) return; // a later seek won
        p.shown = k;
        p.shownT = k / o.fps;
        p.seekTarget = null;
        p.shownCount++;
      }, o.delayMs || 0);
    },
    snapshotSource() {
      const k = p.shown;
      return { width: o.width, height: o.height, toDataURL: () => `data:image/png;base64,${png(k).toString('base64')}` };
    },
    thumbnail(/** @type {number} */ _t, /** @type {any} */ cb) { p.thumbs++; cb({ width: 160, height: 90 }); return true; },
    thumbnailLeave() { p.leaves++; },
    setVolume(/** @type {number} */ v, /** @type {boolean} */ m) { p.volume = { v, m }; },
    bufferedRanges() { return [[0, 1]]; },
    statsText() { return `stats ${o.id}`; },
  };
  return p;
}

function makeEngine(/** @type {any} */ extra = {}) {
  const specs = [
    { id: 'A', fps: 24, frames: 240, width: 1920, height: 1080, audio: true },
    { id: 'B', fps: 25, frames: 250, width: 1280, height: 720, audio: true },
    { id: 'C', fps: 30, frames: 300, width: 1080, height: 1920, audio: false },
  ];
  const players = Object.fromEntries(specs.map((s) => [s.id, stubPlayer(s)]));
  const engine = VpeEngineAdapter.create({
    clips: specs.map((s) => ({ id: s.id, name: `${s.id.toLowerCase()}.mp4` })),
    getPlayer: (id) => players[id] || null,
    pictureApi: VpePicture,
    ...extra,
  });
  return { engine, players };
}

/**
 * A webview: vscode API + window 'message' events, wired to a FakeHost that answers with this page's envelope.
 * On 'compare' the bridge plays src/compare.js: it keeps its own slot table (tiles in the order the host opened
 * them) and reads only the numeric `order` / `index` / `keep` the adapter sends, never the ids beside them, so a
 * wrong index reaches FakeHost as the wrong video.
 */
function makeBridge(/** @type {string} */ surface, /** @type {{ page?: string, boot?: string }} */ env = { page: 'page-1', boot: 'boot-1' }) {
  const { page, boot } = env;
  /** @type {string[]} Compare's host: clip ids by tile index, in opening order */
  const hostSlots = [];
  const compare = surface === 'compare';
  const idAt = (/** @type {any} */ i) => (Number.isInteger(i) ? hostSlots[i] : undefined);
  /** Production host messages back to FakeHost's unified names: a stand-in for src/extension.js / src/compare.js. */
  const toUnified = (/** @type {any} */ m) => {
    switch (m.type) {
      case 'comparePick': case 'add': return { type: 'pickVideo', exclude: m.exclude || [] };
      case 'replace': return { type: 'replaceVideo', oldId: idAt(m.index) };
      case 'leave': return { type: 'leaveCompare', keepId: idAt(m.keep), t: m.t };
      case 'tileOrder': return { type: 'tileOrder', order: compare ? (m.order || []).map(idAt) : m.order };
      case 'tileSize': return m.tile ? { type: 'tileSize', ...m.tile } : m;
      case 'playbackPrefs': return m.prefs ? m : { type: 'playbackPrefs', prefs: { volume: m.volume, rate: m.rate, timeMode: m.timeMode, stepSize: m.stepSize } };
      default: return m;
    }
  };
  /** What the host does to its own tiles (opening order; a replaced tile keeps its slot). @param {any} m */
  const hostTracks = (m) => {
    if (!compare) return;
    // The page only shows tiles the host opened: one it reports that the host has not seen was opened before.
    if (m.type === 'tiles' && Array.isArray(m.tiles)) for (const id of m.tiles) if (!hostSlots.includes(id)) hostSlots.push(id);
    if (m.type === 'leave' && idAt(m.keep)) hostSlots.splice(0, hostSlots.length, /** @type {string} */ (idAt(m.keep)));
  };
  /** @type {Set<(e: any) => void>} */
  const listeners = new Set();
  const win = {
    addEventListener(/** @type {string} */ t, /** @type {any} */ f) { if (t === 'message') listeners.add(f); },
    removeEventListener(/** @type {string} */ t, /** @type {any} */ f) { if (t === 'message') listeners.delete(f); },
  };
  const dispatch = (/** @type {any} */ data) => { for (const f of [...listeners]) f({ data }); };
  const deliver = (/** @type {any} */ m) => {
    if (compare && m.type === 'replaceTile') { const i = hostSlots.indexOf(m.oldId); if (i >= 0) hostSlots[i] = m.newId; }
    if (compare && m.type === 'openVideo' && m.compare && !hostSlots.includes(m.clipId)) hostSlots.push(m.clipId);
    dispatch({ ...m, page, boot });
  };
  const fake = createFakeHost({ clips: createFakeEngine().clips, deliver });
  /** @type {any[]} */
  const sent = [];
  let state = /** @type {any} */ (undefined);
  const vscode = {
    postMessage(/** @type {any} */ m) { sent.push(m); const u = toUnified(m); hostTracks(m); fake.post(u); },
    getState: () => state,
    setState: (/** @type {any} */ s) => { state = s; },
  };
  const host = VpeHostAdapter.create({ vscode, win, page, boot, surface: /** @type {any} */ (surface) });
  return { host, fake, sent, listeners, dispatch, vscode, hostSlots };
}

(async () => {
  // ---- the shared contracts ----
  await runEngineAdapterContract('production EngineAdapter', () => makeEngine().engine);
  await runEngineAdapterContract('production EngineAdapter (no pictureApi)', () => makeEngine({ pictureApi: undefined }).engine);
  for (const surface of ['unified', 'player', 'compare']) {
    await runHostAdapterContract(`production HostAdapter (${surface})`, () => {
      const b = makeBridge(surface);
      // The fake's own record of what reached the host, so the contract checks the round trip too.
      return Object.assign(b.host, { snapshot: b.fake.snapshot, broadcastPrefs: b.fake.broadcastPrefs, exitFocusMode: b.fake.exitFocusMode });
    });
  }

  // ---- engine: metadata from the players ----
  {
    const { engine, players } = makeEngine();
    assert.deepStrictEqual(engine.getClip('B'), {
      id: 'B', name: 'b.mp4', fps: 25, frames: 250, duration: 10, width: 1280, height: 720, hasAudio: true, codec: 'h264', size: 1e6,
    });
    assert.strictEqual(engine.getClip('nope'), null, 'an unknown clip is null');
    assert.strictEqual(engine.hasAudio('C'), false);
    players.A.n = 480; // a player that learns more (an index read) is followed without telling the adapter
    assert.strictEqual(engine.getClip('A').frames, 480);
    assert.deepStrictEqual(engine.shownFrame('B', 25, { unit: 'ms', v: 1000 }), { frame: 50, outOfRange: false }, 'ms at the clip\'s own fps');
    assert.deepStrictEqual(engine.statsText('A'), 'stats A');
    assert.deepStrictEqual(engine.bufferedRanges('A'), [[0, 1]]);
    assert.deepStrictEqual(engine.chapters('A'), [], 'a missing pass-through gives its fallback');
    assert.strictEqual(engine.cueAt('nope', 1), null);
  }

  // ---- engine: facts through VpeControls.facts when given ----
  {
    /** @type {any} */
    let seen = null;
    const controlsApi = { facts: (/** @type {any} */ o) => { seen = o; return { title: o.name, sub: 'sub', rows: [['Picture', `${o.width} × ${o.height}`]] }; } };
    const { engine } = makeEngine({ controlsApi });
    assert.deepStrictEqual(engine.facts('B'), { title: 'b.mp4', sub: 'sub', rows: [['Picture', '1280 × 720']] });
    assert.strictEqual(seen.fps, 25);
    assert.strictEqual(seen.hasSound, true);
    const broken = makeEngine({ controlsApi: { facts: () => { throw new Error('x'); } } }).engine;
    assert.ok(broken.facts('A').rows.length > 0, 'a throwing facts() falls back');
  }

  // ---- engine: sound goes to one player, the others are muted ----
  {
    const { engine, players } = makeEngine();
    engine.setVolume(0.5, false);
    engine.setSoundSource('B');
    assert.deepStrictEqual([players.A.volume, players.B.volume, players.C.volume], [{ v: 0.5, m: true }, { v: 0.5, m: false }, { v: 0.5, m: true }]);
    engine.setVolume(2, true);
    assert.deepStrictEqual(players.B.volume, { v: 1, m: true }, 'clamped, and muted by the user');
    engine.setSoundSource(null);
    engine.setVolume(0.2, false);
    assert.ok(['A', 'B', 'C'].every((id) => players[id].volume.m === true), 'no sound source: all muted');
    assert.deepStrictEqual(engine.sound(), { soundSource: null, volume: 0.2, muted: false });
  }

  // ---- engine: draw goes to the compositor, then the player's draw ----
  {
    /** @type {any[]} */
    const presented = [];
    const compositor = { present: (/** @type {any[]} */ ...a) => presented.push(a) };
    const cv = fakeCanvas();
    makeEngine({ compositor }).engine.draw(cv, 'A', 3, { splitClipRatio: 0.5 });
    assert.deepStrictEqual(presented, [[cv, 'A', 3, { splitClipRatio: 0.5 }]]);
    const { engine, players } = makeEngine();
    /** @type {any[]} */
    const drawn = [];
    players.B.draw = (/** @type {any[]} */ ...a) => drawn.push(a);
    engine.draw(cv, 'B', 9);
    assert.strictEqual(drawn.length, 1);
    assert.doesNotThrow(() => makeEngine({ compositor: { present() { throw new Error('lost context'); } } }).engine.draw(cv, 'A', 0));
  }

  // ---- engine: thumbnails through the player, leave reaches every player ----
  {
    const { engine, players } = makeEngine();
    /** @type {any[]} */
    const got = [];
    engine.thumbnail('A', 2, (/** @type {any} */ t) => got.push(t));
    assert.strictEqual(got[0].frame, 48);
    assert.deepStrictEqual(got[0].picture, { width: 160, height: 90 }, 'the player\'s picture is passed on');
    engine.thumbnailLeave(true);
    assert.ok(players.A.leaves === 1 && players.C.leaves === 1);
  }

  // ---- engine: snapshot from an exact-frame grabber, else the shown picture ----
  {
    const { engine, players } = makeEngine();
    players.A.shown = 33;
    assert.strictEqual(engine.snapshot('A').frame, 33, 'no frame: the shown one');
    /** @type {number[]} */
    const asked = [];
    players.B.snapshot = (/** @type {number} */ f) => { asked.push(f); return { data: pngSource.snapshot('clip-1', f).data, width: 1280, height: 720 }; };
    const s = engine.snapshot('B', 12);
    assert.deepStrictEqual([asked, s.frame, s.width, s.mimeType], [[12], 12, 1280, 'image/png']);
    players.C.snapshotSource = () => null;
    assert.strictEqual(engine.snapshot('C', 1), null, 'no picture yet: null');
  }

  // ---- host: page / boot envelope on every post ----
  {
    const b = makeBridge('compare', { page: 'p7', boot: 'b7' });
    b.host.post({ type: 'copyText', text: 'x' });
    assert.deepStrictEqual(b.sent.pop(), { type: 'copyText', text: 'x', page: 'p7', boot: 'b7' });
    const plain = makeBridge('player', {});
    plain.host.post({ type: 'external' });
    assert.deepStrictEqual(plain.sent.pop(), { type: 'external' }, 'no envelope fields when the page has none');
  }

  // ---- host: replies for another page or boot are dropped; toasts are capped ----
  {
    const b = makeBridge('unified', { page: 'p1', boot: 'b1' });
    /** @type {any[]} */
    const got = [];
    b.host.connect((m) => got.push(m));
    b.dispatch({ type: 'toast', text: 'other page', page: 'p2', boot: 'b1' });
    b.dispatch({ type: 'toast', text: 'old boot', page: 'p1', boot: 'b0' });
    b.dispatch({ type: 'toast', text: 'no envelope', ms: 99999 });
    b.dispatch({ type: 'toast', text: 'mine', page: 'p1', boot: 'b1', ms: 2500 });
    b.dispatch(null);
    b.dispatch({ noType: true });
    assert.deepStrictEqual(got.map((m) => [m.text, m.ms]), [['no envelope', 10000], ['mine', 2500]]);
  }

  // ---- host: pickVideo and the other names per surface ----
  {
    const player = makeBridge('player');
    player.host.post({ type: 'pickVideo', exclude: ['clip-0'], t: 1.5 });
    assert.deepStrictEqual(player.sent.pop(), { type: 'comparePick', t: 1.5, exclude: ['clip-0'], page: 'page-1', boot: 'boot-1' });
    const cmp = makeBridge('compare');
    cmp.host.post({ type: 'pickVideo', exclude: ['clip-0'] });
    assert.strictEqual(cmp.sent.pop().type, 'add');
    const uni = makeBridge('unified');
    uni.host.post({ type: 'pickVideo', exclude: [] });
    assert.strictEqual(uni.sent.pop().type, 'pickVideo');

    cmp.host.post({ type: 'tiles', tabId: 1, tiles: ['clip-0', 'clip-1', 'clip-2'], current: 'clip-0' });
    cmp.sent.length = 0;
    cmp.host.post({ type: 'tileOrder', order: ['clip-2', 'clip-0', 'clip-1'] });
    cmp.host.post({ type: 'replaceVideo', oldId: 'clip-1' });
    cmp.host.post({ type: 'leaveCompare', keepId: 'clip-2', t: 4 });
    cmp.host.post({ type: 'tileSize', w: 640, h: 360, cols: 2, rows: 1, zoom: 1 });
    cmp.host.post({ type: 'playbackPrefs', prefs: { volume: 0.5, rate: 2 } });
    const strip = (/** @type {any} */ m) => { const { page: _p, boot: _b, ...rest } = m; return rest; };
    assert.deepStrictEqual(cmp.sent.map(strip), [
      { type: 'tileOrder', order: [2, 0, 1], ids: ['clip-2', 'clip-0', 'clip-1'] },
      { type: 'replace', index: 1, oldId: 'clip-1' },
      { type: 'leave', keepId: 'clip-2', keep: 2, t: 4 },
      { type: 'tileSize', tile: { w: 640, h: 360, cols: 2, rows: 1, zoom: 1 } },
      { type: 'playbackPrefs', volume: 0.5, rate: 2 },
    ]);
    cmp.sent.length = 0;
    cmp.host.post({ type: 'replaceVideo', oldId: 'not-a-tile' });
    cmp.host.post({ type: 'leaveCompare' });
    cmp.host.post({ type: 'tileOrder', order: ['x'] });
    assert.deepStrictEqual(cmp.sent, [], 'an unknown tile is never sent as an index');
    for (const type of ['rail', 'neighbour', 'copyText', 'saveFrame', 'openSettings', 'openUrl', 'external', 'focusMode', 'focusModeExited']) {
      cmp.host.post({ type, x: 1 });
      assert.strictEqual(strip(cmp.sent.pop()).type, type, `${type} keeps its name`);
    }
  }

  // ---- host: storage and dispose ----
  {
    const b = makeBridge('player');
    assert.strictEqual(b.host.storage.getState(), undefined);
    b.host.storage.setState({ volume: 0.3 });
    assert.deepStrictEqual(b.host.storage.getState(), { volume: 0.3 });
    const throwing = VpeHostAdapter.create({ vscode: { postMessage() {}, getState() { throw new Error('x'); }, setState() { throw new Error('x'); } }, win: null });
    assert.doesNotThrow(() => { throwing.storage.setState({}); throwing.storage.getState(); });

    /** @type {any[]} */
    const got = [];
    b.host.connect((m) => got.push(m));
    assert.strictEqual(b.listeners.size, 1);
    b.host.dispose();
    assert.strictEqual(b.listeners.size, 0, 'dispose removes the message listener');
    b.dispatch({ type: 'toast', text: 'late', page: 'page-1', boot: 'boot-1' });
    b.host.post({ type: 'copyText', text: 'late' });
    assert.deepStrictEqual([got.length, b.sent.length], [0, 0], 'nothing in or out after dispose');
    assert.doesNotThrow(() => b.host.dispose(), 'dispose twice');
  }

  // ---- engine: showFrame waits for a slow decoder to present, and each frame is its own picture ----
  {
    const specs = [{ id: 'S', fps: 25, frames: 100, width: 640, height: 360, audio: false, delayMs: 30 }];
    const players = { S: stubPlayer(specs[0]) };
    const engine = VpeEngineAdapter.create({ clips: [{ id: 'S' }], getPlayer: (id) => /** @type {any} */ (players)[id] || null });
    const p = players.S;
    const picture = () => engine.snapshot('S').data;
    const s5 = engine.showFrame('S', 5);
    assert.strictEqual(p.shown, 0, 'nothing presented yet: showFrame did not answer before the decoder');
    assert.strictEqual(await s5, 5, 'showFrame resolves once frame 5 is presented');
    assert.ok(p.paused > 0, 'showFrame pauses the player');
    const pic5 = picture();
    assert.strictEqual(pic5[pic5.length - 1], 5, 'the snapshot is frame 5\'s picture');
    assert.strictEqual(await engine.showFrame('S', 6), 6);
    const pic6 = picture();
    assert.strictEqual(pic6[pic6.length - 1], 6, 'the snapshot is frame 6\'s picture');
    assert.notDeepStrictEqual(pic5, pic6, 'successive frames give distinct pictures');
    // A still taken before the decoder has presented is still the old frame: showFrame is what makes it exact.
    const s7 = engine.showFrame('S', 7);
    assert.strictEqual(picture()[pic6.length - 1], 6, 'before presentation the picture is the previous frame');
    assert.strictEqual(await s7, 7);
    assert.strictEqual(picture()[pic6.length - 1], 7);
    const seeks = p.seeks.length;
    assert.strictEqual(await engine.showFrame('S', 7), 7, 'the frame already on screen answers at once');
    assert.strictEqual(p.seeks.length, seeks, '... without a seek');

    const ac = new AbortController();
    const aborted = engine.showFrame('S', 40, { signal: ac.signal });
    setTimeout(() => ac.abort(), 5);
    assert.strictEqual(await aborted, null, 'aborted mid-presentation: null');
    const pre = new AbortController();
    pre.abort();
    const before = p.seeks.length;
    assert.strictEqual(await engine.showFrame('S', 50, { signal: pre.signal }), null, 'aborted before: null');
    assert.strictEqual(p.seeks.length, before, 'an aborted request never seeks');
    await new Promise((r) => setTimeout(r, 50)); // let the aborted seek's presentation land

    // The decoder lands on a neighbour (VFR or a gap): the frame actually shown is returned, not the one asked.
    p.seekFrame = (/** @type {number} */ k) => {
      p.seekTarget = k;
      setTimeout(() => { p.shown = k - 1; p.shownT = (k - 1) / 25; p.seekTarget = null; p.shownCount++; }, 10);
    };
    assert.strictEqual(await engine.showFrame('S', 20), 19, 'the frame presented, not the frame asked');

    // A player with its own showFrame(frame, opts) is awaited and its answer passed on.
    /** @type {any[]} */
    const asked = [];
    /** @type {any} */ (p).showFrame = async (/** @type {number} */ k, /** @type {any} */ o) => {
      asked.push([k, !!(o && o.signal)]);
      await new Promise((r) => setTimeout(r, 10));
      return k + 1;
    };
    const ac2 = new AbortController();
    assert.strictEqual(await engine.showFrame('S', 30, { signal: ac2.signal }), 31, 'the player\'s own showFrame answer');
    assert.deepStrictEqual(asked, [[30, true]], 'the signal is passed to the player');
    const ac3 = new AbortController();
    const cut = engine.showFrame('S', 31, { signal: ac3.signal });
    ac3.abort();
    assert.strictEqual(await cut, null, 'aborted while the player\'s showFrame runs: null');
    assert.strictEqual(await engine.showFrame('nope', 1), null, 'an unknown clip: null');
  }

  // ---- engine: showFrame needs a fresh picture: a stale or uncounted one times out to null, never the old frame ----
  {
    const spec = { id: 'S', fps: 25, frames: 100, width: 640, height: 360, audio: false };
    const p = stubPlayer(spec);
    const engine = VpeEngineAdapter.create({ clips: [{ id: 'S' }], getPlayer: () => p, showFrameTimeoutMs: 120 });
    // The seek clears but the decoder never presents: shownCount stays, the old frame 0 is still on screen.
    p.seekFrame = (/** @type {number} */ k) => { p.seeks.push(k); p.seekTarget = null; };
    assert.strictEqual(await engine.showFrame('S', 10), null, 'no new picture: null, not the previous frame');
    // A stale picture of the asked frame is not settled, even with nothing pending.
    /** @type {any} */ (p).shownStale = true;
    p.shown = 10;
    const seeks = p.seeks.length;
    assert.strictEqual(await engine.showFrame('S', 10), null, 'stale on the asked frame: null after the timeout');
    assert.strictEqual(p.seeks.length, seeks + 1, 'a stale picture is sought again, not taken as shown');
    // A presentation that counts but stays stale (skipped-over frames) is no evidence either.
    p.seekFrame = (/** @type {number} */ k) => {
      p.seekTarget = k / 25;
      setTimeout(() => { p.shown = k; p.shownT = k / 25; p.seekTarget = null; p.shownCount++; }, 5);
    };
    assert.strictEqual(await engine.showFrame('S', 12), null, 'counted but stale: null');
    // A fresh picture: shownCount moves, shownStale clears.
    p.seekFrame = (/** @type {number} */ k) => {
      p.seekTarget = k / 25;
      setTimeout(() => {
        p.shown = k; p.shownT = k / 25; p.seekTarget = null; p.shownCount++;
        /** @type {any} */ (p).shownStale = false;
      }, 5);
    };
    assert.strictEqual(await engine.showFrame('S', 14), 14, 'a fresh presentation resolves with the frame shown');
    const n = p.seekTarget;
    p.seekFrame = () => { throw new Error('must not seek'); };
    assert.strictEqual(await engine.showFrame('S', 14), 14, 'already cleanly on screen: at once, no seek');
    assert.strictEqual(n, null);
    // A seek still pending on the asked frame is not "already shown".
    p.seekTarget = 3;
    p.seekFrame = (/** @type {number} */ k) => { p.seeks.push(k); };
    assert.strictEqual(await engine.showFrame('S', 14), null, 'a pending seek never counts as shown');
  }

  // ---- engine: mixed-fps Compare: a 24 fps clock on a 60 fps tile ----
  {
    const { engine } = makeEngine();
    engine.registerClip({ id: 'P60', name: 'p60.mp4', fps: 60, frames: 600, width: 1280, height: 720, hasAudio: false });
    assert.deepStrictEqual(engine.shownFrame('P60', 24, 0, 24), { frame: 60, outOfRange: false }, '1.0 s of a 24 fps clock is frame 60');
    assert.deepStrictEqual(engine.shownFrame('P60', 24, 0), { frame: 24, outOfRange: false }, 'no clock rate: the frame as given');
    assert.deepStrictEqual(engine.shownFrame('P60', 24, 0, 60), { frame: 24, outOfRange: false }, 'the tile\'s own rate: the frame as given');
    assert.deepStrictEqual(engine.shownFrame('P60', 24, 6, 24), { frame: 66, outOfRange: false }, 'the frame offset is in the tile\'s frames');
    assert.deepStrictEqual(engine.shownFrame('P60', 24, { unit: 'ms', v: 500 }, 24), { frame: 90, outOfRange: false }, 'then +500 ms at 60 fps');
    assert.deepStrictEqual(engine.shownFrame('A', 60, 0, 60), { frame: 24, outOfRange: false }, 'and back: 1.0 s of a 60 fps clock on a 24 fps tile');
    assert.deepStrictEqual(engine.shownFrame('A', 600, 0, 60), { frame: null, outOfRange: true }, '10 s is past a 10 s tile');
  }

  // ---- engine: a clip opened after boot replaces the original as the only tile ----
  {
    const { engine, players } = makeEngine();
    assert.strictEqual(engine.getClip('D'), null, 'D is not there at boot');
    engine.setSoundSource('D');
    assert.strictEqual(engine.sound().soundSource, null, 'an unknown clip is never the sound source (no fall back to the first clip)');
    assert.ok(players.A.volume.m && players.B.volume.m, 'and nothing is heard');
    /** @type {any} */ (players).D = stubPlayer({ id: 'D', fps: 50, frames: 500, width: 3840, height: 2160, audio: true });
    const got = engine.registerClip({ id: 'D', name: 'd.mov' });
    assert.deepStrictEqual([got.id, got.fps, got.frames, got.width, got.hasAudio], ['D', 50, 500, 3840, true], 'its player\'s metadata');
    assert.strictEqual(players.D.volume.m, true, 'a new player starts muted');
    engine.setSoundSource('D');
    assert.strictEqual(engine.sound().soundSource, 'D');
    assert.deepStrictEqual([players.A.volume.m, players.D.volume.m], [true, false], 'D is heard, A is not');
    for (const id of ['A', 'B', 'C']) assert.strictEqual(engine.unregisterClip(id), true);
    assert.deepStrictEqual(engine.clips.map((c) => c.id), ['D'], 'D is the only tile');
    assert.strictEqual(engine.getClip('A'), null, 'the original clip is gone');
    assert.deepStrictEqual(engine.naturalSize('D'), { width: 3840, height: 2160 });
    assert.strictEqual(engine.hasAudio('D'), true);
    assert.strictEqual(engine.facts('D').title, 'd.mov');
    assert.deepStrictEqual(engine.shownFrame('D', 499), { frame: 499, outOfRange: false });
    assert.strictEqual(engine.sound().soundSource, 'D', 'closing other tiles keeps D heard');
    engine.setVolume(0.7, false);
    assert.deepStrictEqual(players.D.volume, { v: 0.7, m: false });
    assert.strictEqual(await engine.showFrame('D', 12), 12, 'showFrame on the registered clip');
    await runEngineAdapterContract('production EngineAdapter (registered after boot)', () => engine);
    engine.unregisterClip('D');
    assert.strictEqual(players.D.volume.m, true, 'an unregistered player is muted');
    assert.strictEqual(engine.sound().soundSource, null, 'and is no longer the sound source');
  }

  // ---- engine: pixelAt through the player's pixelAt or readPixels ----
  {
    const { engine, players } = makeEngine();
    assert.strictEqual(engine.pixelAt('A', 1, 2), null, 'no pixel reader: null');
    /** @type {any} */ (players.A).readPixels = () => [10, 20, 30, 255];
    assert.deepStrictEqual(engine.pixelAt('A', 1, 2), { r: 10, g: 20, b: 30, a: 255, text: 'x=1 y=2 rgb=(10,20,30) #0a141e' });
    /** @type {any} */ (players.A).readPixels = () => new Uint8Array([255, 0, 128]);
    assert.strictEqual(engine.pixelAt('A', 3, 4).text, 'x=3 y=4 rgb=(255,0,128) #ff0080', 'a typed array, no alpha');
    /** @type {any} */ (players.A).readPixels = () => ({ r: 1, g: 2, b: 3 });
    assert.deepStrictEqual(engine.pixelAt('A', 0, 0), { r: 1, g: 2, b: 3, a: 255, text: 'x=0 y=0 rgb=(1,2,3) #010203' });
    /** @type {any} */ (players.A).readPixels = () => ({ text: 'frame 3 x=0 y=0 rgb=(1,2,3)' });
    assert.strictEqual(engine.pixelAt('A', 0, 0).text, 'frame 3 x=0 y=0 rgb=(1,2,3)', 'a player\'s own text is kept');
    /** @type {any} */ (players.A).readPixels = () => null;
    assert.strictEqual(engine.pixelAt('A', 0, 0), null, 'outside the picture: null');
    /** @type {any} */ (players.A).readPixels = () => { throw new Error('lost context'); };
    assert.strictEqual(engine.pixelAt('A', 0, 0), null, 'a throwing reader: null');
    /** @type {any} */ (players.B).pixelAt = (/** @type {number} */ x, /** @type {number} */ y) => `B ${x},${y}`;
    /** @type {any} */ (players.B).readPixels = () => { throw new Error('not used'); };
    assert.deepStrictEqual(engine.pixelAt('B', 5, 6), { text: 'B 5,6' }, 'the player\'s pixelAt wins');
    assert.strictEqual(engine.pixelAt('nope', 0, 0), null, 'an unknown clip: null');
  }

  // ---- engine: pixelAt on a production-shaped player (engine.js): no pixelAt / readPixels, only its picture ----
  {
    /** A 4×2 2D canvas whose pixel (x, y) is (x*10, y*20, 7, 255). */
    const reads = /** @type {any[]} */ ([]);
    const px = (/** @type {number} */ x, /** @type {number} */ y) => new Uint8ClampedArray([x * 10, y * 20, 7, 255]);
    const ctx2d = { getImageData: (/** @type {number} */ x, /** @type {number} */ y, /** @type {number} */ w, /** @type {number} */ h) => { reads.push([x, y, w, h]); return { data: px(x, y) }; } };
    const canvas = { width: 4, height: 2, getContext: (/** @type {string} */ k) => (k === '2d' ? ctx2d : null) };
    const players = /** @type {any} */ ({ A: { snapshotSource: () => canvas } });
    const engine = VpeEngineAdapter.create({ clips: [{ id: 'A' }, { id: 'G' }, { id: 'W' }], getPlayer: (id) => players[id] || null, doc: null });
    assert.deepStrictEqual(engine.pixelAt('A', 3, 1), { r: 30, g: 20, b: 7, a: 255, text: 'x=3 y=1 rgb=(30,20,7) #1e1407' },
      'the presented canvas, read 1×1 as media/inspect.js does');
    assert.deepStrictEqual(reads.pop(), [3, 1, 1, 1]);
    assert.strictEqual(engine.pixelAt('A', 4, 0), null, 'right of the picture: null');
    assert.strictEqual(engine.pixelAt('A', -1, 0), null, 'left of the picture: null');
    players.A = { canvas };
    assert.strictEqual(engine.pixelAt('A', 1, 0).text, 'x=1 y=0 rgb=(10,0,7) #0a0007', 'a player with only a canvas');
    // engine.js's WebGL renderer (p.gl.gl): one pixel from the default framebuffer, rows from the bottom.
    const glCalls = /** @type {any[]} */ ([]);
    const gl = {
      READ_FRAMEBUFFER_BINDING: 1, READ_FRAMEBUFFER: 2, RGBA: 3, UNSIGNED_BYTE: 4,
      getParameter: () => 'fb', bindFramebuffer: (/** @type {any} */ _t, /** @type {any} */ b) => glCalls.push(['bind', b]),
      readPixels: (/** @type {number} */ x, /** @type {number} */ y, /** @type {number} */ _w, /** @type {number} */ _h, /** @type {any} */ _f, /** @type {any} */ _t, /** @type {Uint8Array} */ buf) => {
        glCalls.push(['read', x, y]);
        buf.set([1, 2, 3, 255]);
      },
    };
    players.G = { gl: { gl }, snapshotSource: () => ({ width: 4, height: 2, getContext: () => null }) };
    assert.strictEqual(engine.pixelAt('G', 2, 0).text, 'x=2 y=0 rgb=(1,2,3) #010203', 'the WebGL picture');
    assert.deepStrictEqual(glCalls, [['bind', null], ['read', 2, 1], ['bind', 'fb']], 'GL row 1 is picture row 0; the framebuffer is restored');
    // A WebGL canvas without the renderer at hand: drawn into a 1×1 2D canvas from opts.doc.
    const drawn = /** @type {any[]} */ ([]);
    const doc = { createElement: () => ({ width: 0, height: 0, getContext: () => ({
      drawImage: (/** @type {any[]} */ ...a) => drawn.push(a.slice(1)), getImageData: () => ({ data: new Uint8ClampedArray([9, 8, 7, 255]) }),
    }) }) };
    const engine2 = VpeEngineAdapter.create({ clips: [{ id: 'W' }], getPlayer: () => ({ snapshotSource: () => ({ width: 4, height: 2, getContext: () => null }) }), doc });
    assert.strictEqual(engine2.pixelAt('W', 1, 1).text, 'x=1 y=1 rgb=(9,8,7) #090807', 'a source with no 2D context: via a 1×1 canvas');
    assert.deepStrictEqual(drawn, [[1, 1, 1, 1, 0, 0, 1, 1]]);
    assert.strictEqual(engine.pixelAt('W', 0, 0), null, 'no player picture: null');
  }

  // ---- host: a Swap reorders the display, never Compare's slots ----
  {
    const [A, B] = ['clip-0', 'clip-1'];
    const strip = (/** @type {any} */ m) => { const { page: _p, boot: _b, ...rest } = m; return rest; };
    const b = makeBridge('compare');
    b.host.post({ type: 'tiles', tiles: [A, B], current: A });
    b.host.post({ type: 'tiles', tiles: [B, A], current: B });
    assert.deepStrictEqual(b.host.slots(), [A, B], 'a reordered tiles report keeps the slot table');
    b.sent.length = 0;
    b.host.post({ type: 'tileOrder', order: [B, A] });
    assert.deepStrictEqual(strip(b.sent.pop()).order, [1, 0], 'after a Swap the order is [1, 0]');
    assert.deepStrictEqual(b.fake.snapshot().tileOrder, [B, A], 'the host read the numeric order as [B, A]');
    b.host.post({ type: 'leaveCompare', keepId: B, t: 1 });
    assert.strictEqual(strip(b.sent.pop()).keep, 1, 'leaveCompare keeps host slot 1 (B)');
    assert.deepStrictEqual(b.fake.snapshot().leftCompare, { keepId: B, t: 1 }, 'the host kept B, not A');

    const r = makeBridge('compare');
    /** @type {any[]} */
    const got = [];
    r.host.connect((m) => got.push(m));
    r.host.post({ type: 'tiles', tiles: [A, B], current: A });
    r.host.post({ type: 'tiles', tiles: [B, A], current: B });
    r.host.post({ type: 'tileOrder', order: [B, A] });
    r.sent.length = 0;
    r.host.post({ type: 'replaceVideo', oldId: B });
    assert.strictEqual(strip(r.sent.pop()).index, 1, 'replaceVideo of B targets host slot 1');
    const rep = got.filter((m) => m.type === 'replaceTile').pop();
    assert.ok(rep && rep.oldId === B, 'the host replaced B, not A');
    assert.deepStrictEqual(r.host.slots(), [A, rep.newId], 'the new video takes B\'s slot');
    assert.deepStrictEqual(r.hostSlots, [A, rep.newId], '... as on the host');
    r.host.post({ type: 'tiles', tiles: [rep.newId, A], current: rep.newId });
    assert.deepStrictEqual(r.host.slots(), [A, rep.newId], 'the page\'s report after the replace changes nothing');
    r.host.post({ type: 'replaceVideo', oldId: rep.newId });
    assert.strictEqual(strip(r.sent.pop()).index, 1, 'the replaced tile is still slot 1');
    r.host.post({ type: 'tiles', tiles: [r.host.slots()[1], A, 'x-late'] });
    assert.deepStrictEqual(r.host.slots().slice(0, 1).concat(r.host.slots().slice(2)), [A, 'x-late'], 'a new tile is appended');
    r.host.post({ type: 'tiles', tiles: ['x-late', A] });
    assert.deepStrictEqual(r.host.slots(), [A, 'x-late'], 'a closed tile drops out; the others keep their order');
    assert.deepStrictEqual(VpeHostAdapter.mergeSlots(['x', 'y', 'z'], ['z', 'w', 'x', 7]), ['x', 'z', 'w'], 'mergeSlots');
  }

  // ---- pictureInfo / transcodeInfo / exactFrame: what the reduced-res and slow notices and the Live chip read ----
  {
    const quality = { variants: [{ height: 720 }, { height: 1080 }] };
    /** @type {any[]} */
    const grabs = [];
    const { engine, players } = makeEngine({
      streamInfo: (/** @type {string} */ id) => (id === 'C' ? quality : null),
      grabExact: (/** @type {string} */ id, /** @type {any} */ p) => { grabs.push([id, p]); return Promise.resolve({ w: 1, h: 1 }); },
    });
    const e = /** @type {any} */ (engine);
    assert.deepStrictEqual(e.pictureInfo('A'), {
      clipId: 'A', nativeLossy: false, transcoded: false, streaming: false,
      video: { codec: 'h264', width: 1920, height: 1080 }, stream: null, display: null,
    }, 'a plain built-in clip: neither lossy nor transcoded nor streaming');
    // Native ffmpeg scaled B down; Live transcode feeds A from a remote stream.
    /** @type {any} */ (players.B).nativeLossy = true;
    const remote = { fps: 24, w: 1280, h: 720 };
    Object.assign(/** @type {any} */ (players.A), { remoteStream: true });
    Object.assign(players.A.info, { remoteStream: remote, transcode: { lossy: true, codec: 'h264' } });
    const a = e.pictureInfo('A');
    assert.ok(a.transcoded && a.streaming && a.stream === remote, `Live transcode: transcoded and streaming ${JSON.stringify(a)}`);
    assert.ok(e.pictureInfo('B').nativeLossy && !e.pictureInfo('B').transcoded, 'native lossy, not transcoded');
    const c = e.pictureInfo('C');
    assert.ok(c.streaming && !c.transcoded && c.quality === quality, 'an HLS clip streams, with its Quality variants');
    assert.strictEqual(e.pictureInfo('nope').clipId, 'A', 'an unknown clip reads as the first, as getClip does');
    assert.deepStrictEqual(e.transcodeInfo(), {
      clipId: 'A', lossy: true, transcode: { lossy: true, codec: 'h264' }, stream: remote, quality: null,
    }, 'transcodeInfo(): the first transcoded clip');
    assert.strictEqual(e.transcodeInfo('B'), null, 'B is not transcoded');
    // A spec the host marks transcoded counts before its decoder knows.
    e.registerClip({ id: 'C', name: 'c.mp4', transcoded: true });
    assert.strictEqual(e.transcodeInfo('C').clipId, 'C', 'spec.transcoded');
    // exactFrame: the player's own wins, else the page's grabExact; no player, null.
    assert.deepStrictEqual(await e.exactFrame('A'), { w: 1, h: 1 });
    assert.ok(grabs.length === 1 && grabs[0][0] === 'A' && grabs[0][1] === players.A, 'grabExact gets the clip and its player');
    /** @type {any} */ (players.B).exactFrame = () => ({ own: true });
    assert.deepStrictEqual(await e.exactFrame('B'), { own: true }, 'the player\'s exactFrame wins');
    assert.strictEqual(await e.exactFrame('Z'), null, 'unknown clip');
    assert.strictEqual(grabs.length, 1);
  }

  console.log(`production_adapters_test: ok (${Date.now() - T0} ms)`);
})().catch((e) => { console.error(e); process.exitCode = 1; });
