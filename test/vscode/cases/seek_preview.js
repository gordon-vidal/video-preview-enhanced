'use strict';
// Seek-bar previews (docs/notes/seek-preview.md) in a real VS Code, simple mode (the default).
//   pass:    without any hover, the background keyframe pass gives every place on the bar a picture, then closes
//            its worker (or ends its ffmpeg); a hover then draws at once with no request
//   pass-hidden: a tab hidden before the pass starts does no pass work until it is shown again
//   between: on a clip with a 10 s GOP, without any hover, the fill gives the floor and then every slot a frame of
//            its own (not the keyframe, not a refine); hovers then need no request. webcodecs/between: the same on
//            H.264 that plays through WebCodecs, whose fill decodes on the worker's own hardware VideoDecoder
// With the pass turned off (debug probe 'thumbPass'), so the hover checks stay about the hover:
//   idle:    after open nothing is decoded (no request, no worker, no ffmpeg thumbnail process) until the
//            first hover, also not 4 s after the first frame; the shown frame may already be a preview (capture)
//   hover:   a thumbnail shows up on hover (the exact keyframe; neighbours fill while the pointer stays)
//   drag:    while the slider is dragged (synthetic: pointerdown, input events, then pointerup)
//            the thumbnail follows the slider and changes, and the main picture holds its committed frame
//   stop:    after the pointer leaves and after the drag ends, no further thumbnail request is made
//   exact:   on release the picture is exactly the frame under the slider (ffmpeg reference), and
//            a later seek and frame step stay exact
//   capture: on a clip with a 10 s GOP, play 5 s, then hover a time between keyframes: the picture is a played
//            frame within one slot (X) of it, not the keyframe; reports what a capture cost the frame loop
//   refine:  on the same clip, rest 5 s after a keyframe: the exact frame (within X of the pointer), a different
//            picture than the keyframe itself; reports the latency from the hover
// Decode paths: WebAssembly (MPEG-2, built-in decoder), WebCodecs (H.264, between only) and native ffmpeg (HEVC,
// ffmpeg: true).
// The 20 s clips are made from long_20s.mp4 with a keyframe every second.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const lib = require('../lib');

const SETTINGS = { 'videoPreviewEnhanced.autoplay': false };

function makeClip(h, name, args) {
  const out = path.join(h.MEDIA, 'cases', name);
  if (fs.existsSync(out)) return out;
  const src = lib.clip('long_20s.mp4');
  const r = spawnSync(h.ffmpeg, ['-v', 'error', '-y', '-i', src, '-an', ...args, out], { windowsHide: true });
  if (r.status !== 0) throw new Error(`making ${name}: ${String(r.stderr).slice(0, 300)}`);
  return out;
}

async function previewChecks(vs, h, file, R, label) {
  await R.run(`${label}`, async (ok, r) => {
    const P = await lib.open(vs, h, file);
    try {
      await P.waitFirstFrame();
      await P.ask('thumbPass', { on: false });
      // 1. Idle: with the pass off, nothing decodes on its own (longer than the pass's 3 s start delay).
      await lib.sleep(4000);
      const idle = await P.state();
      ok(!idle.strip || (idle.strip.requests === 0 && !idle.strip.worker), `no request or worker before the first hover (${JSON.stringify(idle.strip)})`);
      ok(idle.thumb.hidden, 'no thumbnail shown');
      ok(!lib.lines(vs, /thumbs:|thumb ffmpeg/, P.fromMark).length, 'no thumbnail worker or ffmpeg process started');
      const [sx, sy, sw, sh] = idle.seekRect;

      // 2. Hover: a picture appears (worker start or ffmpeg + one keyframe), then neighbours fill.
      const th0 = Date.now();
      P.dom('mousemove', sx + sw * 0.37, sy + sh / 2);
      const hv = await P.waitState((x) => !x.thumb.hidden && x.thumb.w > 0, { timeout: 15000, what: 'hover thumbnail', interval: 50 });
      r.firstPictureMs = Date.now() - th0;
      ok(!hv.tip.hidden, 'time tip shown');
      // One keyframe can answer several slots, so the neighbourhood may need fewer than 9 requests.
      const filled = await P.waitState((x) => x.strip && x.strip.filled, { timeout: 15000, what: 'neighbours filled while hovering' });
      r.hover = filled.strip;
      ok(filled.strip.slots >= 3 && filled.strip.slots <= 9, `only the neighbourhood is decoded (${filled.strip.slots} places, ${filled.strip.cached} pictures)`);
      P.dom('mouseleave', sx + sw / 2, sy - 200, { target: 'seek' });
      await lib.sleep(300);
      ok((await P.state()).thumb.hidden, 'leaving hides the thumbnail');
      const afterLeave = (await P.state()).strip.requests;
      await lib.sleep(2500);
      const still = (await P.state()).strip;
      ok(still.requests === afterLeave && !still.hovering, `after leaving no further decoding (${afterLeave} -> ${still.requests} requests)`);

      // 3. Drag: pointerdown on the bar, slider input events, the thumbnail follows; the committed frame stays visible.
      const before = await P.report();
      P.dom('pointerdown', sx + sw * 0.1, sy + sh / 2, { target: 'seek' });
      const sigs = new Set();
      let previousSig;
      const frames = new Set();
      for (const frac of [0.15, 0.3, 0.45, 0.6, 0.75, 0.9]) {
        await P.ask('scrub', { frac });
        const s = await P.waitState((x) => !x.thumb.hidden && x.thumb.w > 0 && x.thumb.sig !== previousSig, { timeout: 15000, what: `drag thumbnail at ${frac}`, interval: 50 });
        sigs.add(s.thumb.sig);
        previousSig = s.thumb.sig;
        await lib.sleep(250);
        frames.add((await P.report()).frame0);
      }
      ok(sigs.size >= 4, `the thumbnail changes while dragging (${sigs.size} pictures for 6 places)`);
      ok(frames.size === 1 && frames.has(before.frame0), `the main picture holds its committed frame while dragging (frames ${[...frames]}, before ${before.frame0})`);
      r.drag = { pictures: sigs.size, frames: [...frames] };

      // 4. Release: exactly the frame under the slider.
      const end = await P.ask('scrub', { frac: 0.62, end: true, off: true }); // released above the bar
      await lib.sleep(200);
      const st = await P.state();
      ok(st.thumb.hidden, 'release off the pointer: the thumbnail goes');
      const reqEnd = st.strip.requests;
      await lib.sleep(2500);
      ok((await P.state()).strip.requests === reqEnd, 'after the drag ended no further decoding');
      await P.expectFrame(end.value, 'release');
      // 5. Later seeks and steps stay exact.
      P.seek(5.5); // frame 165 at 30 fps
      const fps = await P.cachedFps();
      await P.expectFrame(Math.floor(5.5 * fps), 'seek after drag');
      P.step(1);
      await P.expectFrame(Math.floor(5.5 * fps) + 1, 'step after drag');
      r.decoder = lib.lines(vs, /decoder: |native ffmpeg backend/, P.fromMark).slice(0, 2);
      r.thumbLog = lib.lines(vs, /thumbs: (d+xd+|worker ready)/, P.fromMark).slice(0, 3);
    } finally { await P.close(); }
  });
}

async function passChecks(vs, h, file, other, R, label) {
  await R.run(`${label}/pass`, async (ok, r) => {
    const P = await lib.open(vs, h, file);
    try {
      await P.waitFirstFrame();
      const t0 = Date.now();
      const done = await P.waitState((x) => x.strip && x.strip.pass && /^done/.test(x.strip.pass.state), { timeout: 30000, what: 'the background pass' });
      r.fullBarS = (Date.now() - t0) / 1000;
      r.pass = done.strip.pass;
      r.bar = `${done.strip.bar}/${done.strip.n}`;
      ok(done.strip.pass.state === 'done:complete', `the pass completes (${done.strip.pass.state})`);
      ok(done.strip.bar === done.strip.n, `every place has a picture without a hover (${r.bar})`);
      ok(!done.strip.hovering && done.strip.pass.requests > 0, `pictures came from the pass (${done.strip.pass.requests} asks)`);
      const idle = await P.waitState((x) => !x.strip.worker && x.strip.state === 'off', { timeout: 3000, what: 'worker closed after the pass' });
      const [sx, sy, sw, sh] = idle.seekRect;
      const n0 = idle.strip.requests;
      const th0 = Date.now();
      P.dom('mousemove', sx + sw * 0.63, sy + sh / 2);
      await P.waitState((x) => !x.thumb.hidden && x.thumb.w > 0, { timeout: 3000, what: 'hover picture', interval: 50 });
      r.hoverMs = Date.now() - th0;
      await lib.sleep(600);
      const after = (await P.state()).strip.requests;
      ok(after === n0, `the hover needs no request (${n0} -> ${after})`);
      P.dom('mouseleave', sx + sw / 2, sy - 200, { target: 'seek' });
      r.log = lib.lines(vs, /thumbs: pass /, P.fromMark).slice(0, 1);
    } finally { await P.close(); }
  });
  await R.run(`${label}/pass-hidden`, async (ok, r) => {
    const A = await lib.open(vs, h, file);
    try {
      await A.waitFirstFrame();
      const B = await lib.open(vs, h, other); // in front: A is hidden before its pass starts (3 s)
      const m = vs.mark();
      await B.waitFirstFrame();
      // Sampled while A is hidden: past the pass's start delay, then 3 s later.
      const seen = [];
      for (const wait of [3000, 3000]) {
        await lib.sleep(wait);
        const x = await A.state();
        seen.push({ hidden: x.engineHidden, pass: x.strip && x.strip.pass });
      }
      r.whileHidden = seen;
      const mine = new RegExp(`\\[${lib.esc(A.name)}\\].*(thumbs: starting worker|thumb ffmpeg)`);
      const hiddenWork = lib.lines(vs, mine, m);
      ok(seen.every((x) => x.hidden), 'A was hidden');
      ok(!hiddenWork.length, `no pass work while hidden (${hiddenWork.slice(0, 2)})`);
      ok(seen.every((x) => !x.pass || (x.pass.requests === 0 && x.pass.state === 'paused:hidden')), `the pass waits while hidden (${JSON.stringify(seen)})`);
      vs.send({ command: 'workbench.action.closeActiveEditor' }); // B: A is shown again
      await lib.sleep(700);
      const done = await A.waitState((x) => x.strip && x.strip.pass && /^done/.test(x.strip.pass.state), { timeout: 30000, what: 'the pass after showing' });
      ok(done.strip.bar === done.strip.n, `the pass fills the bar once shown (${done.strip.bar} of ${done.strip.n})`);
    } finally { await A.close(); }
  });
}

async function betweenChecks(vs, h, file, R, label, gpu = '') {
  await R.run(`${label}/between`, async (ok, r) => {
    const P = await lib.open(vs, h, file);
    try {
      await P.waitFirstFrame();
      const t0 = Date.now();
      const done = await P.waitState((x) => x.strip && x.strip.pass && /^done/.test(x.strip.pass.state), { timeout: 40000, what: 'the background passes' });
      r.doneS = (Date.now() - t0) / 1000;
      r.pass = done.strip.pass;
      const bw = done.strip.pass.between;
      ok(bw && bw.state === 'done:complete' && bw.requests > 0 && bw.pictures > 0, `the fill ran after the keyframe pass (${JSON.stringify(bw)})`);
      const { floorS, fullS } = done.strip.pass;
      ok(floorS > 0 && fullS >= floorS, `the floor, then a full bar (${floorS} s, ${fullS} s)`);
      ok(!done.strip.hovering, 'without any hover');
      if (gpu) {
        ok(bw.gpu === gpu && done.strip.previewDecoder === 'ready', `the fill decoded on ${gpu} (${bw.gpu}, preview decoder ${done.strip.previewDecoder})`);
      }
      const [sx, sy, sw, sh] = done.seekRect;
      const x = (t) => sx + (sw * t) / done.duration;
      const at = 15; // keyframes at 0, 10 and 20 s
      P.dom('mousemove', x(at), sy + sh / 2);
      const mid = await P.waitState((v) => !v.thumb.hidden && v.strip && v.strip.shown, { timeout: 5000, what: 'hover picture', interval: 50 });
      const shown = mid.strip.shown;
      r.shown = shown;
      ok(shown.kind === 'frame' && !shown.refined && Math.abs(shown.t - at) <= mid.strip.X + 0.05,
        `a frame from the pass within X = ${mid.strip.X} s of ${at} s, not a keyframe or a refine (${JSON.stringify(shown)})`);
      P.dom('mousemove', x(10.3), sy + sh / 2);
      const key = await P.waitState((v) => !v.thumb.hidden && v.strip && v.strip.shown && v.strip.shown.kind === 'key', { timeout: 5000, what: 'keyframe picture', interval: 50 });
      ok(mid.thumb.sig && key.thumb.sig && mid.thumb.sig !== key.thumb.sig, `the picture differs from the keyframe's (${JSON.stringify(key.strip.shown)})`);
      ok(key.strip.requests === done.strip.requests, `the hovers need no request (${done.strip.requests} -> ${key.strip.requests})`);
      P.dom('mouseleave', sx + sw / 2, sy - 200, { target: 'seek' });
      r.log = lib.lines(vs, /thumbs: pass /, P.fromMark).slice(0, 1);
    } finally { await P.close(); }
  });
}

async function captureChecks(vs, h, file, R, label) {
  await R.run(`${label}/capture`, async (ok, r) => {
    const P = await lib.open(vs, h, file);
    try {
      await P.waitFirstFrame();
      await P.ask('thumbPass', { on: false });
      P.play();
      await P.waitState((x) => x.t >= 5.2, { timeout: 20000, what: 'played 5 s' });
      P.pause();
      const s0 = await P.state();
      r.played = s0.strip;
      ok(s0.strip && s0.strip.requests === 0 && !s0.strip.worker, `playing asked for no thumbnail (${JSON.stringify(s0.strip)})`);
      ok(s0.strip && s0.strip.frames >= 4, `played frames became previews (${s0.strip && s0.strip.frames})`);
      const [sx, sy, sw, sh] = s0.seekRect;
      const at = 3.5; // keyframes at 0 and 10 s
      P.dom('mousemove', sx + (sw * at) / s0.duration, sy + sh / 2);
      const hv = await P.waitState((x) => !x.thumb.hidden && x.strip && x.strip.shown, { timeout: 10000, what: 'hover picture', interval: 50 });
      const shown = hv.strip.shown;
      r.shown = shown;
      ok(shown.kind === 'frame' && Math.abs(shown.t - at) <= hv.strip.X + 0.05,
        `the picture is a played frame within X = ${hv.strip.X} s of ${at} s (${JSON.stringify(shown)})`);
      r.captureMs = hv.strip.captureMs;
      P.dom('mouseleave', sx + sw / 2, sy - 200, { target: 'seek' });
    } finally { await P.close(); }
  });
}

async function refineChecks(vs, h, file, R, label) {
  await R.run(`${label}/refine`, async (ok, r) => {
    const P = await lib.open(vs, h, file);
    try {
      await P.waitFirstFrame();
      const s0 = await P.state();
      const [sx, sy, sw, sh] = s0.seekRect;
      const at = 15; // keyframes at 0 and 10 s: 5 s after one, nothing played there
      const x = (t) => sx + (sw * t) / s0.duration;
      const t0 = Date.now();
      P.dom('mousemove', x(at), sy + sh / 2);
      const ref = await P.waitState((v) => !v.thumb.hidden && v.strip && v.strip.shown && v.strip.shown.refined, { timeout: 15000, what: 'refined picture', interval: 50 });
      r.refineMs = Date.now() - t0;
      const shown = ref.strip.shown;
      r.shown = shown;
      r.strip = { refines: ref.strip.refines, refineMs: ref.strip.refineMs, skipped: ref.strip.skipped, frameMs: ref.strip.frameMs, keys: ref.strip.keys };
      ok(Math.abs(shown.t - at) <= ref.strip.X + 0.05, `after resting, the picture is the frame within X = ${ref.strip.X} s of ${at} s (${JSON.stringify(shown)})`);
      // Next to the keyframe at 10 s the keyframe itself is close enough (no refine): a different picture.
      P.dom('mousemove', x(10.6), sy + sh / 2);
      const key = await P.waitState((v) => !v.thumb.hidden && v.strip && v.strip.shown && v.strip.shown.kind === 'key' && Math.abs(v.strip.shown.t - 10) < 0.6, { timeout: 15000, what: 'keyframe picture', interval: 50 });
      ok(ref.thumb.sig && key.thumb.sig && ref.thumb.sig !== key.thumb.sig, 'the refined picture differs from the keyframe');
      P.dom('mouseleave', sx + sw / 2, sy - 200, { target: 'seek' });
    } finally { await P.close(); }
  });
}

module.exports = [{
  name: 'seek_preview',
  settings: SETTINGS,
  async run(vs, h) {
    const R = lib.recorder();
    if (!h.ffmpeg) return [{ name: 'skipped', ok: true, skipped: 'no ffmpeg (reference frames)', problems: [] }];
    const file = makeClip(h, 'sp_mpeg2_20s.mpg', ['-c:v', 'mpeg2video', '-g', '25', '-q:v', '4']);
    await previewChecks(vs, h, file, R, 'wasm');
    const gop = makeClip(h, 'sp_mpeg2_gop10.mpg', ['-c:v', 'mpeg2video', '-g', '300', '-bf', '0', '-q:v', '4']);
    await passChecks(vs, h, file, gop, R, 'wasm');
    await betweenChecks(vs, h, gop, R, 'wasm');
    await captureChecks(vs, h, gop, R, 'wasm');
    await refineChecks(vs, h, gop, R, 'wasm');
    const h264 = makeClip(h, 'sp_h264_gop10.mp4', ['-c:v', 'libx264', '-preset', 'veryfast', '-g', '300', '-keyint_min', '300', '-sc_threshold', '0', '-bf', '2', '-pix_fmt', 'yuv420p']);
    await betweenChecks(vs, h, h264, R, 'webcodecs', 'webcodecs');
    return R.out;
  },
}, {
  name: 'seek_preview_native',
  settings: SETTINGS,
  ffmpeg: true,
  async run(vs, h) {
    const R = lib.recorder();
    if (!h.ffmpeg) return [{ name: 'skipped', ok: true, skipped: 'no ffmpeg', problems: [] }];
    const file = makeClip(h, 'sp_hevc_20s.mp4', ['-c:v', 'libx265', '-x265-params', 'keyint=25:min-keyint=25:log-level=error', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p']);
    await previewChecks(vs, h, file, R, 'native');
    const gop = makeClip(h, 'sp_hevc_gop10.mp4', ['-c:v', 'libx265', '-x265-params', 'keyint=300:min-keyint=300:scenecut=0:log-level=error', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p']);
    await passChecks(vs, h, file, gop, R, 'native');
    await betweenChecks(vs, h, gop, R, 'native');
    await captureChecks(vs, h, gop, R, 'native');
    await refineChecks(vs, h, gop, R, 'native');
    return R.out;
  },
}];
