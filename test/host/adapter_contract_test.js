'use strict';
// Shared adapter contracts for media/player-ui.js: what any EngineAdapter and HostAdapter must do, written once so
// the same suite runs against the mockup fakes now (tools/mockup/fake-engine.js, fake-host.js) and against the
// production adapters later. A fake that passes here is a "verified fake": UI tests built on it stay honest.
//
//   const { runEngineAdapterContract, runHostAdapterContract } = require('./adapter_contract_test');
//   await runEngineAdapterContract('real engine', () => makeEngine());
//   await runHostAdapterContract('real host', () => makeHost());
//
// Run directly (node test/run.js unit --grep adapter_contract), it checks both fakes. No video is decoded.
const assert = require('assert');

/** A 2D canvas good enough for draw(): every context call is accepted, sizes are kept, calls are counted. */
function fakeCanvas(clientWidth = 320, clientHeight = 180) {
  let calls = 0;
  const ctx = new Proxy({}, {
    get(target, key) {
      if (key in target) return target[key];
      if (key === 'createLinearGradient') return () => { calls++; return { addColorStop() {} }; };
      return () => { calls++; };
    },
    set(target, key, value) { target[key] = value; return true; },
  });
  return { width: 0, height: 0, clientWidth, clientHeight, getContext: () => ctx, calls: () => calls };
}

const near = (/** @type {number} */ a, /** @type {number} */ b, /** @type {string} */ msg) => assert.ok(Math.abs(a - b) < 1e-6, `${msg}: ${a} ≈ ${b}`);

/**
 * @param {string} label
 * @param {() => any} createAdapter returns a fresh EngineAdapter
 */
async function runEngineAdapterContract(label, createAdapter) {
  const at = (/** @type {string} */ what) => `${label}: ${what}`;
  const engine = createAdapter();

  // ---- clips and metadata ----
  assert.ok(Array.isArray(engine.clips) && engine.clips.length > 0, at('clips is a non-empty list'));
  for (const c of engine.clips) {
    const m = engine.getClip(c.id);
    assert.ok(m && m.id === c.id, at(`getClip(${c.id}) returns that clip`));
    assert.strictEqual(typeof m.name, 'string', at(`${c.id} has a name`));
    for (const k of ['fps', 'frames', 'duration', 'width', 'height']) {
      assert.ok(Number(m[k]) > 0, at(`${c.id}.${k} is a positive number`));
    }
    near(m.duration, m.frames / m.fps, at(`${c.id}.duration = frames / fps`));
    assert.strictEqual(typeof m.hasAudio, 'boolean', at(`${c.id}.hasAudio is a boolean`));
    const size = engine.naturalSize(c.id);
    assert.ok(size.width > 0 && size.height > 0, at(`naturalSize(${c.id}) is positive`));
    assert.deepStrictEqual(size, { width: m.width, height: m.height }, at(`naturalSize(${c.id}) matches the clip`));
    assert.strictEqual(engine.hasAudio(c.id), m.hasAudio, at(`hasAudio(${c.id}) matches the clip`));
  }
  const id = engine.clips[0].id;
  const clip = engine.getClip(id);

  // ---- facts ----
  const f = engine.facts(id);
  assert.strictEqual(typeof f.title, 'string', at('facts().title'));
  assert.strictEqual(typeof f.sub, 'string', at('facts().sub'));
  assert.ok(Array.isArray(f.rows) && f.rows.length > 0, at('facts().rows is a non-empty list'));
  for (const r of f.rows) assert.ok(Array.isArray(r) && r.length === 2 && r.every((x) => typeof x === 'string'), at('facts() rows are [label, value]'));

  // ---- shownFrame: offsets in frames and ms, and the clip's edges ----
  assert.deepStrictEqual(engine.shownFrame(id, 10, 0), { frame: 10, outOfRange: false }, at('offset 0'));
  assert.deepStrictEqual(engine.shownFrame(id, 10), { frame: 10, outOfRange: false }, at('no offset'));
  assert.deepStrictEqual(engine.shownFrame(id, 10, 5), { frame: 15, outOfRange: false }, at('+5 frames (number)'));
  assert.deepStrictEqual(engine.shownFrame(id, 10, -4), { frame: 6, outOfRange: false }, at('-4 frames (number)'));
  assert.deepStrictEqual(engine.shownFrame(id, 10, { unit: 'frames', v: 3 }), { frame: 13, outOfRange: false }, at('+3 frames (unit)'));
  assert.deepStrictEqual(engine.shownFrame(id, 2 * clip.fps, { unit: 'ms', v: 1000 }), { frame: 3 * clip.fps, outOfRange: false }, at('+1000 ms'));
  assert.deepStrictEqual(engine.shownFrame(id, 2 * clip.fps, { unit: 'ms', v: -1000 }), { frame: clip.fps, outOfRange: false }, at('-1000 ms'));
  assert.deepStrictEqual(engine.shownFrame(id, 0, -1), { frame: null, outOfRange: true }, at('before the start'));
  assert.deepStrictEqual(engine.shownFrame(id, clip.frames - 1, 0), { frame: clip.frames - 1, outOfRange: false }, at('last frame'));
  assert.deepStrictEqual(engine.shownFrame(id, clip.frames - 1, 1), { frame: null, outOfRange: true }, at('past the end'));
  assert.deepStrictEqual(engine.shownFrame(id, 0, { unit: 'ms', v: -5000 }), { frame: null, outOfRange: true }, at('-5 s before the start'));

  // ---- shownFrame with a clock at another rate (mixed-fps Compare): mapped through time, then the offset ----
  {
    const half = clip.fps / 2; // the clock runs at half the tile's rate: clock frame 10 is the tile's frame 20
    assert.deepStrictEqual(engine.shownFrame(id, 10, 0, half), { frame: 20, outOfRange: false }, at('clock at half the rate'));
    assert.deepStrictEqual(engine.shownFrame(id, 10, 3, half), { frame: 23, outOfRange: false }, at('offset in the tile\'s frames after mapping'));
    assert.deepStrictEqual(engine.shownFrame(id, 10, { unit: 'ms', v: 1000 }, half), { frame: 20 + clip.fps, outOfRange: false }, at('ms offset after mapping'));
    assert.deepStrictEqual(engine.shownFrame(id, 10, 0, clip.fps), { frame: 10, outOfRange: false }, at('the same rate keeps the frame'));
    for (const bad of [0, -24, NaN, Infinity, undefined, null, 'x']) {
      assert.deepStrictEqual(engine.shownFrame(id, 10, 0, bad), { frame: 10, outOfRange: false }, at(`clockFps ${String(bad)} is ignored`));
    }
    assert.deepStrictEqual(engine.shownFrame(id, clip.frames, 0, clip.fps * 2), { frame: Math.round(clip.frames / 2), outOfRange: false },
      at('a faster clock past the tile\'s length in its own frames is still inside the tile'));
  }

  // ---- pictureRect: aspect ratio per Picture mode ----
  {
    const cellW = 800;
    const cellH = 800;
    const aspect = clip.width / clip.height;
    const fit = engine.pictureRect(id, cellW, cellH, 'fit');
    near(fit.w / fit.h, aspect, at('fit keeps the aspect ratio'));
    assert.ok(fit.w <= cellW + 1e-6 && fit.h <= cellH + 1e-6, at('fit stays inside the cell'));
    assert.ok(Math.abs(fit.w - cellW) < 1e-6 || Math.abs(fit.h - cellH) < 1e-6, at('fit touches two edges'));
    near(fit.x * 2 + fit.w, cellW, at('fit is centred horizontally'));
    near(fit.y * 2 + fit.h, cellH, at('fit is centred vertically'));
    assert.deepStrictEqual(engine.pictureRect(id, cellW, cellH), fit, at('fit is the default'));
    const fill = engine.pictureRect(id, cellW, cellH, 'fill');
    near(fill.w / fill.h, aspect, at('fill keeps the aspect ratio'));
    assert.ok(fill.w >= cellW - 1e-6 && fill.h >= cellH - 1e-6, at('fill covers the cell'));
    assert.deepStrictEqual(engine.pictureRect(id, cellW, cellH, 'stretch'), { x: 0, y: 0, w: cellW, h: cellH }, at('stretch takes the cell'));
    const actual = engine.pictureRect(id, cellW, cellH, 'actual');
    assert.deepStrictEqual([actual.w, actual.h], [clip.width, clip.height], at('actual is natural pixels'));
    const zoomed = engine.pictureRect(id, cellW, cellH, 'fit', 2, 10, -20);
    near(zoomed.w, fit.w * 2, at('zoom 2 doubles the width'));
    near(zoomed.x + zoomed.w / 2, cellW / 2 + 10, at('pan x shifts the centre'));
    near(zoomed.y + zoomed.h / 2, cellH / 2 - 20, at('pan y shifts the centre'));
  }

  // ---- draw ----
  {
    const cv = fakeCanvas();
    assert.doesNotThrow(() => engine.draw(cv, id, 12), at('draw without opts'));
    assert.ok(cv.width > 0 && cv.height > 0 && cv.calls() > 0, at('draw sizes the canvas and paints'));
    const cv2 = fakeCanvas();
    assert.doesNotThrow(() => engine.draw(cv2, id, 12, { splitClipRatio: 0.5 }), at('draw with splitClipRatio'));
    assert.ok(cv2.calls() > 0, at('a split draw paints'));
    assert.doesNotThrow(() => engine.draw(fakeCanvas(), 'no-such-clip', 0), at('draw of an unknown clip does not throw'));
  }

  // ---- thumbnail / thumbnailLeave ----
  {
    /** @type {any[]} */
    const got = [];
    engine.thumbnail(id, 1, (/** @type {any} */ t) => got.push(t));
    await Promise.resolve();
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(got.length, 1, at('thumbnail calls back once'));
    assert.strictEqual(got[0].frame, Math.round(clip.fps), at('thumbnail shows the frame at the time'));
    engine.thumbnailLeave();

    /** @type {any[]} */
    const scrub = [];
    for (const s of [0.5, 1, 1.5]) engine.thumbnail(id, s, (/** @type {any} */ t) => scrub.push(t), true);
    await new Promise((r) => setImmediate(r));
    assert.ok(scrub.length >= 1, at('a scrub delivers a preview'));
    assert.strictEqual(scrub[scrub.length - 1].frame, Math.round(1.5 * clip.fps), at('a scrub ends on the last position'));

    /** @type {any[]} */
    const cancelled = [];
    engine.thumbnail(id, 2, (/** @type {any} */ t) => cancelled.push(t), true);
    engine.thumbnailLeave(true);
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(cancelled.length, 0, at('thumbnailLeave cancels a pending scrub preview'));
    assert.doesNotThrow(() => { engine.thumbnailLeave(); engine.thumbnailLeave(false); }, at('thumbnailLeave twice is safe'));
  }

  // ---- snapshot ----
  {
    const s = engine.snapshot(id, 7);
    assert.strictEqual(s.frame, 7, at('snapshot frame'));
    assert.deepStrictEqual([s.width, s.height], [clip.width, clip.height], at('snapshot is natural size'));
    assert.strictEqual(s.mimeType, 'image/png', at('snapshot is a PNG'));
    assert.ok(s.data instanceof Uint8Array && s.data.length > 8, at('snapshot has bytes'));
    assert.deepStrictEqual([...s.data.slice(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], at('PNG signature'));
    assert.strictEqual(typeof engine.snapshot(id).frame, 'number', at('snapshot without a frame'));
  }

  // ---- sound ----
  assert.doesNotThrow(() => { engine.setSoundSource(id); engine.setVolume(0.4, true); engine.setSoundSource(null); }, at('sound calls'));
  if (engine.fake) {
    engine.setSoundSource(id);
    engine.setVolume(0.4, true);
    assert.deepStrictEqual([engine.fake.soundSource, engine.fake.volume, engine.fake.muted], [id, 0.4, true], at('the fake records sound'));
    engine.setVolume(3, false);
    assert.deepStrictEqual([engine.fake.volume, engine.fake.muted], [1, false], at('volume is clamped to 0..1'));
  }
  const silent = engine.clips.find((c) => !engine.hasAudio(c.id));
  if (engine.fake) assert.ok(silent, at('the fake has a clip without audio'));

  // ---- showFrame: async, resolves with the frame presented, honours an AbortSignal ----
  {
    assert.strictEqual(typeof engine.showFrame, 'function', at('showFrame exists'));
    const pending = engine.showFrame(id, 5);
    assert.ok(pending && typeof pending.then === 'function', at('showFrame returns a promise'));
    assert.strictEqual(await pending, 5, at('showFrame resolves with the frame shown'));
    assert.strictEqual(engine.snapshot(id).frame, 5, at('a snapshot after showFrame is of that frame'));
    assert.strictEqual(await engine.showFrame(id, clip.frames + 50), clip.frames - 1, at('showFrame clamps to the last frame'));
    const ac = new AbortController();
    ac.abort();
    assert.strictEqual(await engine.showFrame(id, 3, { signal: ac.signal }), null, at('an aborted signal gives null'));
    const late = new AbortController();
    const racing = engine.showFrame(id, 4, { signal: late.signal });
    late.abort();
    assert.strictEqual(await racing, null, at('aborting before presentation gives null'));
    assert.strictEqual(await engine.showFrame('no-such-clip', 1), null, at('showFrame of an unknown clip gives null'));
  }

  // ---- pixelAt: { text } (or null when this clip cannot read pixels) ----
  {
    assert.strictEqual(typeof engine.pixelAt, 'function', at('pixelAt exists'));
    const px = engine.pixelAt(id, 1, 2);
    assert.ok(px === null || (typeof px === 'object' && typeof px.text === 'string' && px.text.length > 0), at('pixelAt is null or { text }'));
    if (engine.fake) assert.ok(px, at('the fake reads pixels'));
    assert.doesNotThrow(() => engine.pixelAt('no-such-clip', 0, 0), at('pixelAt of an unknown clip does not throw'));
  }

  // ---- registerClip / unregisterClip: clips opened after boot ----
  {
    const newId = `${label}-registered`;
    const spec = { id: newId, name: 'late.mp4', fps: 30, frames: 90, width: 640, height: 360, hasAudio: true };
    assert.ok(!engine.clips.some((/** @type {any} */ c) => c.id === newId), at('the new clip is not there at boot'));
    engine.registerClip(spec);
    assert.ok(engine.clips.some((/** @type {any} */ c) => c.id === newId), at('registerClip adds to clips'));
    const m = engine.getClip(newId);
    assert.deepStrictEqual([m.id, m.fps, m.frames, m.width, m.height, m.hasAudio], [newId, 30, 90, 640, 360, true], at('getClip of a registered clip'));
    assert.deepStrictEqual(engine.naturalSize(newId), { width: 640, height: 360 }, at('naturalSize of a registered clip'));
    assert.strictEqual(engine.hasAudio(newId), true, at('hasAudio of a registered clip'));
    assert.strictEqual(engine.facts(newId).title, 'late.mp4', at('facts of a registered clip'));
    assert.deepStrictEqual(engine.shownFrame(newId, 89), { frame: 89, outOfRange: false }, at('shownFrame uses the registered length'));
    assert.deepStrictEqual(engine.shownFrame(newId, 90), { frame: null, outOfRange: true }, at('past the registered end'));
    engine.setSoundSource(newId);
    if (engine.fake) assert.strictEqual(engine.fake.soundSource, newId, at('a registered clip can be the sound source'));
    if (engine.sound) assert.strictEqual(engine.sound().soundSource, newId, at('a registered clip can be the sound source'));
    assert.strictEqual(engine.unregisterClip(newId), true, at('unregisterClip of a known clip'));
    assert.ok(!engine.clips.some((/** @type {any} */ c) => c.id === newId), at('unregisterClip removes from clips'));
    if (engine.fake) assert.strictEqual(engine.fake.soundSource, null, at('the removed sound source is no longer heard'));
    if (engine.sound) assert.strictEqual(engine.sound().soundSource, null, at('the removed sound source is no longer heard'));
    assert.strictEqual(engine.unregisterClip(newId), false, at('unregisterClip twice'));
  }
}

/**
 * @param {string} label
 * @param {() => any} createAdapter returns a fresh HostAdapter (connect(fn), post(msg))
 */
async function runHostAdapterContract(label, createAdapter) {
  const at = (/** @type {string} */ what) => `${label}: ${what}`;
  const host = createAdapter();
  /** @type {any[]} */
  let out = [];
  host.connect((/** @type {any} */ m) => out.push(m));
  const take = () => { const r = out; out = []; return r; };
  const ofType = (/** @type {any[]} */ ms, /** @type {string} */ type, /** @type {string} */ op = '') => ms.filter((m) => m.type === type && (!op || m.op === op));

  // ---- rail: open lists the folder, filter is harmless ----
  host.post({ type: 'rail', op: 'open' });
  let ms = take();
  const list = ofType(ms, 'rail', 'list')[0];
  assert.ok(list, at('rail open answers a list'));
  assert.ok(Number.isInteger(list.gen) && Array.isArray(list.entries), at('a list has gen and entries'));
  const videos = list.entries.filter((/** @type {any} */ e) => e.kind === 'video').map((/** @type {any} */ e) => e.id);
  assert.ok(videos.length >= 3, at('the root folder lists at least three videos'));
  assert.doesNotThrow(() => host.post({ type: 'rail', op: 'filter', text: 'shot' }), at('rail filter'));
  take();

  // ---- tiles: the page reports its videos; the rail's members follow ----
  host.post({ type: 'tiles', tabId: 1, tiles: [videos[0], videos[1]], current: videos[0] });
  ms = take();
  assert.ok(ofType(ms, 'rail').length > 0, at('tiles updates the open rail'));
  assert.ok(ofType(ms, 'rail', 'list').concat(ofType(ms, 'rail', 'members')).some((m) => (m.members || m.ids || []).includes(videos[1])),
    at('rail members include the reported tiles'));

  // ---- rail list again: the current video is marked ----
  host.post({ type: 'rail', op: 'list' });
  host.post({ type: 'rail', op: 'open' });
  ms = take();
  assert.strictEqual(ofType(ms, 'rail', 'list').pop().current, videos[0], at('the list marks the current video'));

  // ---- tileOrder ----
  host.post({ type: 'tileOrder', order: [videos[1], videos[0]] });
  ms = take();
  const members = ofType(ms, 'rail', 'members').pop();
  assert.ok(members, at('tileOrder updates the rail members'));
  assert.deepStrictEqual(members.ids, [videos[1], videos[0]], at('members follow the new order'));
  if (host.snapshot) {
    assert.deepStrictEqual(host.snapshot().tileOrder, [videos[1], videos[0]], at('tileOrder is recorded'));
    assert.strictEqual(host.snapshot().current, videos[1], at('the first tile becomes current'));
  }

  // ---- tileSize ----
  assert.doesNotThrow(() => host.post({ type: 'tileSize', w: 640, h: 360, cols: 2, rows: 1, zoom: 1 }), at('tileSize'));
  if (host.snapshot) assert.deepStrictEqual(host.snapshot().tileSize, { w: 640, h: 360, cols: 2, rows: 1, zoom: 1 }, at('tileSize is recorded'));
  take();

  // ---- pickVideo ----
  host.post({ type: 'pickVideo', exclude: [videos[0], videos[1]] });
  ms = take();
  const opened = ofType(ms, 'openVideo')[0];
  assert.ok(opened && opened.compare === true, at('pickVideo answers openVideo into Compare'));
  assert.ok(![videos[0], videos[1]].includes(opened.clipId), at('pickVideo skips excluded videos'));

  // ---- replaceVideo ----
  host.post({ type: 'replaceVideo', oldId: videos[0] });
  ms = take();
  const rep = ofType(ms, 'replaceTile')[0];
  assert.ok(rep, at('replaceVideo answers replaceTile'));
  assert.strictEqual(rep.oldId, videos[0], at('replaceTile names the old video'));
  assert.ok(typeof rep.newId === 'string' && rep.newId !== videos[0] && rep.newId !== videos[1], at('replaceTile picks a video not shown'));
  if (host.snapshot) assert.ok(host.snapshot().tiles.includes(rep.newId) && !host.snapshot().tiles.includes(videos[0]), at('the host swapped the tile'));

  // ---- leaveCompare ----
  host.post({ type: 'leaveCompare', keepId: videos[1], t: 2.5 });
  ms = take();
  const left = ofType(ms, 'rail', 'members').pop();
  assert.ok(left, at('leaveCompare updates the rail members'));
  assert.deepStrictEqual(left.ids, [videos[1]], at('only the kept video remains'));
  if (host.snapshot) assert.deepStrictEqual(host.snapshot().leftCompare, { keepId: videos[1], t: 2.5 }, at('leaveCompare is recorded'));

  // ---- playbackPrefs: stored, and another tab's change arrives as a broadcast ----
  host.post({ type: 'playbackPrefs', prefs: { volume: 0.3, rate: 1.5, timeMode: 'frames', stepSize: 'second' } });
  assert.strictEqual(take().length, 0, at('storing prefs answers nothing'));
  if (host.snapshot) assert.deepStrictEqual(host.snapshot().prefs, { volume: 0.3, rate: 1.5, timeMode: 'frames', stepSize: 'second' }, at('prefs are stored'));
  if (host.broadcastPrefs) {
    host.broadcastPrefs({ rate: 2 });
    const b = ofType(take(), 'playbackPrefs')[0];
    assert.ok(b, at('a cross-tab change is broadcast'));
    assert.deepStrictEqual(b.prefs, { volume: 0.3, rate: 2, timeMode: 'frames', stepSize: 'second' }, at('the broadcast carries every pref'));
  }

  // ---- toast with a duration ----
  host.post({ type: 'toast', text: 'Hello', ms: 3000 });
  assert.deepStrictEqual(ofType(take(), 'toast')[0], { type: 'toast', text: 'Hello', ms: 3000 }, at('toast keeps ms'));
  host.post({ type: 'toast', text: 'Long', ms: 60000 });
  assert.ok(ofType(take(), 'toast')[0].ms <= 10000, at('toast ms is capped at 10 s'));
  host.post({ type: 'toast', text: 'Plain' });
  assert.deepStrictEqual(ofType(take(), 'toast')[0], { type: 'toast', text: 'Plain' }, at('toast without ms'));

  // ---- focusMode (Zen Mode) ----
  host.post({ type: 'focusMode', active: true });
  assert.deepStrictEqual(ofType(take(), 'focusMode'), [{ type: 'focusMode', active: true }], at('focusMode on'));
  host.post({ type: 'focusModeExited' });
  assert.deepStrictEqual(ofType(take(), 'focusMode'), [{ type: 'focusMode', active: false }], at('focusModeExited turns it off'));
  if (host.exitFocusMode) {
    host.post({ type: 'focusMode', active: true });
    take();
    host.exitFocusMode();
    assert.deepStrictEqual(ofType(take(), 'focusMode'), [{ type: 'focusMode', active: false }], at('leaving Zen Mode elsewhere is reported'));
  }

  // ---- unknown or malformed messages are harmless ----
  for (const m of [undefined, null, {}, { type: 'noSuchMessage' }, { type: 'rail' }, { type: 'rail', op: 'activate', gen: -1, id: 'x' },
    { type: 'tileOrder' }, { type: 'replaceVideo' }, { type: 'leaveCompare' }, { type: 'playbackPrefs' }]) {
    assert.doesNotThrow(() => host.post(m), at(`post(${JSON.stringify(m)}) does not throw`));
  }
  take();
}

module.exports = { runEngineAdapterContract, runHostAdapterContract, fakeCanvas };

if (require.main === module) {
  const T0 = Date.now();
  const { createFakeEngine } = require('../../tools/mockup/fake-engine');
  const { createFakeHost } = require('../../tools/mockup/fake-host');
  (async () => {
    await runEngineAdapterContract('FakeEngine', () => createFakeEngine());
    // Mixed-fps Compare: a 24 fps clock at frame 24 (1.0 s) is frame 60 of a 60 fps tile, not frame 24.
    const mixed = createFakeEngine([{ id: 'p60', name: 'p60.mp4', fps: 60, frames: 600, width: 1280, height: 720, hasAudio: true }]);
    assert.deepStrictEqual(mixed.shownFrame('p60', 24, 0, 24), { frame: 60, outOfRange: false }, 'FakeEngine: 24 fps clock on a 60 fps tile');
    assert.deepStrictEqual(mixed.shownFrame('p60', 24, { unit: 'ms', v: 500 }, 24), { frame: 90, outOfRange: false }, 'FakeEngine: then +500 ms');
    const sample = createFakeEngine();
    sample.registerClip({ id: 'extra', name: 'extra.mp4' });
    assert.ok(!createFakeEngine().clips.some((c) => c.id === 'extra'), 'FakeEngine: registerClip never changes SAMPLE_CLIPS');
    await runHostAdapterContract('FakeHost', () => createFakeHost({ clips: createFakeEngine().clips }));
    // A host with no subfolder and few clips still passes (the contract does not lean on the fake's tree).
    await runHostAdapterContract('FakeHost (flat)', () => createFakeHost({ clips: createFakeEngine().clips, subfolder: 0 }));
    console.log(`adapter_contract_test: ok (${Date.now() - T0} ms)`);
  })().catch((e) => { console.error(e); process.exitCode = 1; });
}
