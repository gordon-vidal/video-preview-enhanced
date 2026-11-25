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

/** An engine.js-like player: meta, fps, n, info, the shown picture, thumbnails and volume. */
function stubPlayer(/** @type {any} */ o) {
  const p = {
    meta: { duration: o.frames / o.fps, width: o.width, height: o.height, size: 1e6 },
    fps: o.fps, n: o.frames, audio: o.audio ? {} : null,
    info: { video: { codec: 'h264', width: o.width, height: o.height }, ...(o.audio ? { audio: { codec: 'aac', channels: 2, sampleRate: 48000 } } : {}) },
    shown: 0,
    volume: /** @type {any} */ (null),
    thumbs: 0,
    leaves: 0,
    currentFrame() { return p.shown; },
    snapshotSource() {
      return { width: o.width, height: o.height, toDataURL: () => `data:image/png;base64,${Buffer.from(pngSource.snapshot('clip-0', 0).data).toString('base64')}` };
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

/** Production host messages back to FakeHost's unified names: a stand-in for src/extension.js / src/compare.js. */
function toUnified(/** @type {any} */ m) {
  switch (m.type) {
    case 'comparePick': case 'add': return { type: 'pickVideo', exclude: m.exclude || [] };
    case 'replace': return { type: 'replaceVideo', oldId: m.oldId };
    case 'leave': return { type: 'leaveCompare', keepId: m.keepId, t: m.t };
    case 'tileOrder': return { type: 'tileOrder', order: m.ids || m.order };
    case 'tileSize': return m.tile ? { type: 'tileSize', ...m.tile } : m;
    case 'playbackPrefs': return m.prefs ? m : { type: 'playbackPrefs', prefs: { volume: m.volume, rate: m.rate, timeMode: m.timeMode, stepSize: m.stepSize } };
    default: return m;
  }
}

/** A webview: vscode API + window 'message' events, wired to a FakeHost that answers with this page's envelope. */
function makeBridge(/** @type {string} */ surface, /** @type {{ page?: string, boot?: string }} */ env = { page: 'page-1', boot: 'boot-1' }) {
  const { page, boot } = env;
  /** @type {Set<(e: any) => void>} */
  const listeners = new Set();
  const win = {
    addEventListener(/** @type {string} */ t, /** @type {any} */ f) { if (t === 'message') listeners.add(f); },
    removeEventListener(/** @type {string} */ t, /** @type {any} */ f) { if (t === 'message') listeners.delete(f); },
  };
  const dispatch = (/** @type {any} */ data) => { for (const f of [...listeners]) f({ data }); };
  const fake = createFakeHost({ clips: createFakeEngine().clips, deliver: (m) => dispatch({ ...m, page, boot }) });
  /** @type {any[]} */
  const sent = [];
  let state = /** @type {any} */ (undefined);
  const vscode = {
    postMessage(/** @type {any} */ m) { sent.push(m); fake.post(toUnified(m)); },
    getState: () => state,
    setState: (/** @type {any} */ s) => { state = s; },
  };
  const host = VpeHostAdapter.create({ vscode, win, page, boot, surface: /** @type {any} */ (surface) });
  return { host, fake, sent, listeners, dispatch, vscode };
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

  console.log(`production_adapters_test: ok (${Date.now() - T0} ms)`);
})().catch((e) => { console.error(e); process.exitCode = 1; });
