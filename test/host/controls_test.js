'use strict';
// node test/host/controls_test.js: the player's panels helpers (media/controls.js): speed clamp and
// step, jump-size names, the shortcuts sheet following the jump sizes, and the "About this video"
// facts in plain words for a native ffmpeg file and a WebAssembly file (docs/notes/ui-simple.md).
const assert = require('assert');
const C = require('../../media/controls');

// A replacement cancels the old timer or fade and keeps the new duration and announcement.
{
  const timers = new Map();
  const motion = { matches: false };
  const originals = { setTimeout, clearTimeout, matchMedia: globalThis.matchMedia };
  let animation;
  const element = {
    hidden: true,
    animate() {
      animation = { cancel() { this.cancelled = true; } };
      return animation;
    },
  };
  const announced = [];
  try {
    globalThis.matchMedia = () => motion;
    globalThis.setTimeout = (fn, ms) => { timers.set(fn, ms); return fn; };
    globalThis.clearTimeout = (id) => timers.delete(id);
    const toast = C.createToast(element, (text) => announced.push(text));
    const expire = () => {
      const [fn] = timers.keys();
      timers.delete(fn);
      fn();
    };
    toast('Fill');
    assert.deepStrictEqual([...timers.values()], [1500]);
    toast('Stretch', 3000);
    assert.deepStrictEqual([...timers.values()], [3000]);
    expire();
    const oldExit = animation;
    assert.strictEqual(element.hidden, false);
    toast('Fit');
    assert.ok(oldExit.cancelled && oldExit.onfinish === null, 'old fade cannot hide the replacement');
    assert.strictEqual(element.textContent, 'Fit');
    assert.deepStrictEqual(announced, ['Fill', 'Stretch', 'Fit']);
    expire();
    animation.onfinish();
    assert.strictEqual(element.hidden, true);
    motion.matches = true;
    const lastAnimation = animation;
    toast('Fill');
    expire();
    assert.strictEqual(animation, lastAnimation, 'reduced motion skips both fades');
    assert.strictEqual(element.hidden, true);
  } finally {
    Object.assign(globalThis, originals);
  }
}

// A second toggle replaces the running animation and switches the glyph immediately.
{
  const animations = [];
  const element = {
    style: {},
    classList: { toggle: (name, on) => { element[name] = on; } },
    animate(frames, options) {
      const animation = { frames, options, cancel() { this.cancelled = true; } };
      animations.push(animation);
      return animation;
    },
  };
  const flash = C.createPlayFlash(element, { getBoundingClientRect: () => ({ left: 10, top: 20, width: 300, height: 200 }) });
  flash(false);
  assert.strictEqual(element.playing, false);
  assert.deepStrictEqual(element.style, { left: '160px', top: '120px' });
  flash(true);
  assert.strictEqual(element.playing, true);
  assert.ok(animations[0].cancelled);
  assert.deepStrictEqual(animations[1].frames.opacity, [1, 1, 0]);
}

// Both pins are independent of the band, which is shown only with two endpoints.
{
  const band = { style: {}, classList: { toggle: (name, on) => { band[name] = on; } } };
  const a = { style: {} }, b = { style: {} };
  const ab = require('../../media/abloop').create();
  const draw = () => C.drawRangeMarks(band, a, b, ab.marks(10));
  ab.set('a', 1, 1);
  draw();
  assert.deepStrictEqual([band['has-range'], a.hidden, b.hidden, a.style.left], [false, false, true, '10%']);
  ab.set('b', 10, 10);
  draw();
  assert.deepStrictEqual([band['has-range'], b.hidden, b.style.left, band.style.width], [true, false, '100%', '90%']);
  ab.set('a', 1, 1);
  draw();
  assert.deepStrictEqual([band['has-range'], a.hidden, b.hidden], [false, true, false]);
  ab.clear();
  draw();
  assert.deepStrictEqual([band.hidden, a.hidden, b.hidden], [true, true, true]);
}

// Speed: 0.25–4× in steps of 0.05 (the time stretch's range: the sound always keeps playing).
assert.strictEqual(C.clampRate(0.1), 0.25);
assert.strictEqual(C.clampRate(9), 4);
assert.strictEqual(C.clampRate(1.07), 1.05);
assert.strictEqual(C.clampRate(1 + 3 * 0.05), 1.15);
assert.strictEqual(C.SPEED_STEP, 0.05);
assert.strictEqual(C.speedText(1.5), '1.5×');
assert.strictEqual(C.speedText(0.25), '0.25×');
// The preset ladder the wheel over the speed button walks (Shift+wheel keeps the 0.05 steps).
assert.deepStrictEqual(C.SPEEDS, [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4]);
assert.strictEqual(C.presetRate(1, 1), 1.25);
assert.strictEqual(C.presetRate(1, -1), 0.75);
assert.strictEqual(C.presetRate(1.1, 1), 1.25, 'between presets: the next one up');
assert.strictEqual(C.presetRate(1.1, -1), 1, 'between presets: the next one down');
assert.strictEqual(C.presetRate(4, 1), 4, 'the top stays');
assert.strictEqual(C.presetRate(0.25, -1), 0.25, 'the bottom stays');
assert.strictEqual(C.presetRate(2.95, 1), 3);
assert.deepStrictEqual(C.NAV, ['frame', 1, 5, 10, 30]);
assert.strictEqual(C.navName('frame'), '1 frame');
assert.strictEqual(C.navName(30), '30 s');

// The sheet shows the chosen jump sizes.
const seek = (jump) => C.keyGroups({ jump }).find((g) => g.title === 'Seek').rows.slice(0, 3).map((r) => r[0]);
assert.deepStrictEqual(seek({ arrow: 5, shift: 1, ctrl: 'frame' }), ['Back / forward 5 s', 'Back / forward 1 s', 'Back / forward 1 frame']);
assert.deepStrictEqual(seek({ arrow: 'frame', shift: 30, ctrl: 10 }), ['Back / forward 1 frame', 'Back / forward 30 s', 'Back / forward 10 s']);
const all = JSON.stringify(C.keyGroups({ jump: { arrow: 5, shift: 1, ctrl: 'frame' } }));
assert.ok(!/Alt\+/.test(all), 'no Alt+arrow binding (VS Code: Go Back / Forward)');
assert.ok(/Volume ±5 %/.test(all) && /Ctrl\+C|Cmd\+C/.test(all));

// Picture size: the sheet names Z for the player and for compare (+ / - only in the player: compare nudges offsets with them).
const view = (p) => JSON.stringify(C.keyGroups({ jump: { arrow: 5, shift: 1, ctrl: 'frame' }, ...p }));
for (const compare of [false, true]) assert.ok(view({ compare }).includes('"A–B range start / end","A","B"'));
assert.ok(view({}).includes('"Picture size: Fit, Fill, Stretch, 100 %","Z"') && view({}).includes('"Zoom in / out","+","-"'), 'player sheet: Z and + / -');
assert.ok(view({ compare: true }).includes('"Picture size (all videos)","Z"') && !view({ compare: true }).includes('Zoom in / out'), 'compare sheet: Z, no + / - zoom');

const row = (f, k) => (f.rows.find((r) => r[0] === k) || [])[1];

// Native ffmpeg: 4K HEVC 10-bit HDR, AAC 5.1 (what src/native.js posts as streams info).
let f = C.facts({
  name: 'night_drive_4k.mkv', size: 2.1e9, duration: 250, width: 3840, height: 2160, fps: 24000 / 1001, native: true,
  info: {
    native: true, method: 'd3d11va', trackCounts: { audio: 2, sub: 0 },
    video: { codec: 'hevc', pixFmt: 'yuv420p10le', sourceWidth: 3840, sourceHeight: 2160, width: 1920, height: 1080, colorTrc: 16, bitRate: 38e6 },
    audio: { codec: 'aac', channels: 2, sampleRate: 48000, sourceChannels: 6, sourceRate: 48000, bitRate: 384000 },
  },
  tracks: { audio: 2, sub: 0 },
});
assert.strictEqual(f.title, 'night_drive_4k.mkv');
assert.strictEqual(f.sub, '2.1 GB · 4 min 10 s');
assert.strictEqual(row(f, 'Picture'), '3840 × 2160 (4K), 23.98 frames per second');
assert.strictEqual(row(f, 'Quality'), 'HDR (PQ / HDR10), 10-bit colour');
assert.strictEqual(row(f, 'Video'), 'HEVC (H.265), about 38 Mb/s');
assert.strictEqual(row(f, 'Sound'), 'AAC, 5.1 surround, 48 kHz, about 384 kb/s');
assert.strictEqual(row(f, 'Tracks'), '2 audio · no subtitles');
assert.strictEqual(row(f, 'Played by'), 'your GPU (d3d11va), through ffmpeg');

// WebAssembly: 1080p MPEG-2, no stream bit rate (whole-file rate instead), MP2 stereo, one subtitle file.
f = C.facts({
  name: 'clip.mpg', size: 25e6, duration: 20, width: 1920, height: 1080, fps: 25, vmode: 'soft', amode: 'soft',
  info: { video: { codec: 'mpeg2video', depth: 8, colorTrc: 1 }, audio: { codec: 'mp2', channels: 2, sampleRate: 44100 } },
  tracks: { audio: 1, sub: 1 },
});
assert.strictEqual(row(f, 'Picture'), '1920 × 1080 (1080p), 25 frames per second');
assert.strictEqual(row(f, 'Quality'), 'standard range (SDR), 8-bit colour');
assert.strictEqual(row(f, 'Video'), 'MPEG-2, about 10 Mb/s (whole file)');
assert.strictEqual(row(f, 'Sound'), 'MPEG audio layer 2, stereo, 44.1 kHz');
assert.strictEqual(row(f, 'Tracks'), '1 audio · 1 subtitle');
assert.strictEqual(row(f, 'Played by'), 'the built-in decoder (WebAssembly, on the processor)');
assert.strictEqual(f.sub, '25.0 MB · 20 s');

// GPU (WebCodecs) H.264 without sound; the remote stream.
f = C.facts({ name: 'a.mp4', size: 1e6, duration: 5, width: 1280, height: 720, fps: 30, vmode: 'webcodecs', amode: 'none', info: { video: { codec: 'h264', depth: 8 } }, tracks: { audio: 0, sub: 0 } });
assert.strictEqual(row(f, 'Sound'), 'none');
assert.strictEqual(row(f, 'Tracks'), 'no sound · no subtitles');
assert.strictEqual(row(f, 'Played by'), 'your GPU (built into VS Code)');
f = C.facts({ name: 'r.mkv', remoteStream: true, native: true, info: { video: { codec: 'hevc' } } });
assert.match(row(f, 'Played by'), /remote machine/);

// A URL (Open Video URL…): the host and "stream" instead of the size; a live stream has no length.
f = C.facts({ name: 'src.mp4', size: 25e6, duration: 20, stream: { host: 'example.com' }, info: { video: { codec: 'h264' } } });
assert.strictEqual(f.sub, 'example.com · stream · 20 s');
f = C.facts({ name: 'live.m3u8', duration: 0, stream: { host: 'cdn.example.com:8443', live: true }, info: { video: { codec: 'h264' } } });
assert.strictEqual(f.sub, 'cdn.example.com:8443 · live stream');
// HLS: the variant playing in the facts; the Quality page (Auto first, largest picture down, duplicates once).
f = C.facts({ name: 'master.m3u8', duration: 10, stream: { host: 'h', variant: { width: 640, height: 360, bandwidth: 1.5e6 } }, info: { video: { codec: 'h264' } } });
assert.strictEqual(row(f, 'Stream'), 'HLS variant 640 × 360, about 1.5 Mb/s');
const Q = { pick: 'auto', current: 1, variants: [{ id: 0, width: 320, height: 180, bandwidth: 4e5 }, { id: 1, width: 640, height: 360, bandwidth: 1.5e6 }, { id: 2, width: 640, height: 360, bandwidth: 1.5e6 }, { id: 3, width: 0, height: 0, bandwidth: 64e3 }] };
assert.deepStrictEqual(C.qualityRows(Q).map((r) => [r.id, r.label, r.sub, r.checked]), [
  ['auto', 'Auto', '360p', true], [1, '360p', '1.5 Mb/s · 640 × 360', false], [0, '180p', '400 kb/s · 320 × 180', false], [3, '64 kb/s', '', false],
]);
assert.strictEqual(C.qualityLabel(Q), 'Auto (360p)');
assert.strictEqual(C.qualityLabel({ ...Q, pick: 0, current: 0 }), '180p');

console.log('controls_test: ok');

// Buttons beside Play: tooltips say what they do with the current setting (stepButtons: frame | jump).
{
  const tips = (stepButtons, ctrl) => C.stepTips({ stepButtons, jump: { arrow: 5, shift: 1, ctrl } });
  assert.deepStrictEqual([tips('frame', 10).back, tips('frame', 10).fwd], ['Previous frame  ,', 'Next frame  .']);
  assert.strictEqual(tips(undefined, 10).backLabel, 'Previous frame', 'default: frame step');
  assert.match(tips('jump', 10).back, /^Back 10 s/);
  assert.match(tips('jump', 5).fwd, /^Forward 5 s/);
  assert.match(tips('jump', 'frame').fwdLabel, /^Forward one frame/);
}

// Step size badge: the tab's pick wins over the setting; badges and amounts for each size; the default is quiet.
{
  const p = (stepSize, stepButtons = 'frame', ctrl = 10) => ({ stepSize, stepButtons, jump: { arrow: 5, shift: 1, ctrl } });
  assert.deepStrictEqual(C.STEP_SIZES, ['frame', 'frames5', 1, 5, 10]);
  assert.strictEqual(C.stepSizeOf(p(null)), 'frame');
  assert.strictEqual(C.stepSizeOf(p(null, 'jump', 30)), 30, 'no pick: the setting (jump by the Ctrl size)');
  assert.strictEqual(C.stepSizeOf(p('frames5', 'jump', 30)), 'frames5', 'a pick wins');
  assert.deepStrictEqual(C.STEP_SIZES.map(C.stepBadge), ['1f', '5f', '1s', '5s', '10s']);
  assert.deepStrictEqual(C.STEP_SIZES.map(C.stepName), ['1 frame', '5 frames', '1 s', '5 s', '10 s']);
  assert.deepStrictEqual(C.STEP_SIZES.map(C.stepAmount), [{ n: 1 }, { n: 5 }, { s: 1 }, { s: 5 }, { s: 10 }]);
  assert.strictEqual(C.stepTips(p('frames5')).backLabel, 'Back 5 frames');
  assert.strictEqual(C.stepTips(p(5)).fwdLabel, 'Forward 5 s');
  assert.strictEqual(C.stepTips(p('frame', 'jump')).back, 'Previous frame  ,', 'picking 1 frame overrides stepButtons: jump');
  const badge = () => ({ dataset: {}, attrs: {}, textContent: '', title: '', setAttribute(k, v) { this.attrs[k] = v; } });
  const [a, b] = [badge(), badge()];
  C.drawStepBadges([a, b], 'frame');
  assert.deepStrictEqual([a.textContent, a.dataset.default, b.attrs['aria-label']], ['1f', '1', 'Step size: 1 frame']);
  C.drawStepBadges([a, b], 10);
  assert.deepStrictEqual([b.textContent, b.dataset.default, a.title], ['10s', '0', 'Step size: 10 s. Click to change']);
}

// Click outside: a press on the bar, another control or the picture closes an open panel; the bar's panel
// buttons are left to toggle their own page; a press on the picture is reported once so its click does not play / pause.
{
  const listeners = {};
  const fake = (inside = []) => ({
    hidden: false, style: {}, classList: { toggle() {} }, children: [], attributes: {}, textContent: '',
    addEventListener() {}, setAttribute(k, v) { this.attributes[k] = v; }, appendChild() {}, querySelectorAll: () => [], querySelector: () => null,
    getBoundingClientRect: () => ({ top: 300 }), contains(n) { return n === this || inside.includes(n); }, focus() {},
  });
  const saved = { document: globalThis.document, window: globalThis.window };
  try {
    globalThis.document = { addEventListener: (t, fn, cap) => { listeners[t] = { fn, cap }; }, activeElement: null, createDocumentFragment: () => ({ appendChild() {} }) };
    globalThis.window = { addEventListener() {}, innerHeight: 600 };
    const mute = {}, seek = {}, picture = {}, empty = {}, inPanel = {};
    const panel = fake([inPanel]);
    const info = fake(), cog = fake();
    const bar = fake([mute, seek, empty, info, cog]);
    const sheet = fake(); sheet.hidden = true;
    const ctl = C.create({
      panel, sheet, bar, buttons: { cog, info, rate: fake(), tracks: fake(), keys: fake() }, get: () => ({}), act: {},
      views: { t: { label: 'T', render: () => ({}) } },
    });
    assert.ok(listeners.pointerdown && listeners.pointerdown.cap === true, 'capture pointerdown on the document');
    const press = (target) => listeners.pointerdown.fn({ target });
    const open = () => { ctl.show('t', info); assert.ok(ctl.anyOpen()); };

    press(picture); assert.strictEqual(ctl.consumeDismiss(), false, 'nothing open: nothing dismissed');
    for (const target of [mute, seek, empty]) {
      open(); press(target);
      assert.ok(!ctl.anyOpen(), 'a press on the bar closes the panel');
      assert.strictEqual(ctl.consumeDismiss(), false, 'the bar control keeps working: no dismissal to swallow');
    }
    open(); press(picture);
    assert.ok(!ctl.anyOpen(), 'a press on the picture closes the panel');
    assert.strictEqual(ctl.consumeDismiss(), true, 'its click is the dismissal (no play / pause)');
    assert.strictEqual(ctl.consumeDismiss(), false, 'reported once');
    open(); press(inPanel); assert.ok(ctl.anyOpen(), 'a press inside the panel keeps it');
    press(info); assert.ok(ctl.anyOpen(), 'the panel button toggles its own page (not closed twice)');
    press(picture); press(picture);
    assert.strictEqual(ctl.consumeDismiss(), false, 'a later press resets the flag');
  } finally { Object.assign(globalThis, saved); if (!saved.document) delete globalThis.document; if (!saved.window) delete globalThis.window; }
}
