'use strict';
// Mouse-wheel frame steps on heavy 4K while paused (bug of 2026-11-21: steps back were dropped or landed on the
// wrong frame). A step back seeks to the keyframe before and decodes up to the previous frame, which takes long
// on 4K HEVC 10-bit; notches that come meanwhile must add up to one target, not be lost or restart from the
// frame still shown. Every check is the exact frame (the player's count and the picture against ffmpeg's frame).
//   slow:  single notches back and forward, each waiting for its frame (also back across a keyframe)
//   rapid: 10 notches back at once across a keyframe, then 3 forward, then 6 back again
// Built-in decoder (WebAssembly) and native ffmpeg, each with the SDR clip and the same stream tagged PQ through
// the HDR output path (VPE_HDR_FORCE=1; native: 10-bit frames from ffmpeg). The PQ clip is synthetic on purpose:
// the real-footage 4K PQ clip's neighbouring frames are too alike once tone-mapped to tell apart against ffmpeg.
const lib = require('../lib');

const SETTINGS = { 'videoPreviewEnhanced.autoplay': false };

/** Wheel notches at the middle of the picture: d > 0 forward (wheel down), d < 0 back. */
async function notches(P, n, d, gapMs) {
  const s = await P.state();
  const [x, y, w, hh] = s.canvasRect;
  for (let i = 0; i < n; i++) {
    P.dom('wheel', x + w / 2, y + hh / 2, { deltaY: d > 0 ? 100 : -100 });
    if (gapMs) await lib.sleep(gapMs);
  }
}

/** The engine's "seek landed in N ms" times (seek to its frame decoded) since line `from`. */
const landedMs = (vs, from) => lib.lines(vs, /seek landed in \d+ ms/, from).map((l) => Number(/seek landed in (\d+) ms/.exec(l)[1]));

// step4k_hevc10*.mp4: keyframes at 0, 60, 120 (2 s GOP). Slow steps inside a GOP, rapid notches back across the
// keyframe at 60 (the step to 59 decodes frames 0-59), then slow steps back that each decode most of a GOP.
// plan: [count, direction, gap] rows; gap 'slow' waits for each notch's frame, a number of ms sends the notches
// that far apart and waits for the sum at the end (the hook delivers them within one of its polls).
const START = 66;
const PLAN = [[4, -1, 'slow'], [2, 1, 'slow'], [10, -1, 30], [3, 1, 30], [6, -1, 0], [3, -1, 'slow']];

async function wheelChecks(vs, h, R, label, { hdr = false } = {}) {
  await R.run(label, async (ok, r) => {
    const P = await lib.open(vs, h, lib.clip(hdr ? 'step4k_hevc10_pq.mp4' : 'step4k_hevc10.mp4'), { timeout: 60000 });
    try {
      await P.waitFirstFrame(60000);
      const fps = await P.cachedFps();
      const T = 60000; // a 4K step back decodes up to a GOP in software: generous, the frame is what counts
      P.seek((START + 0.5) / fps);
      await P.expectFrame(START, 'seek', T);
      let k = START;
      r.steps = [];
      for (const [n, d, gap] of PLAN) {
        const from = vs.mark();
        const what = `${gap === 'slow' ? 'slow' : 'rapid'} ${n} ${d > 0 ? 'forward' : 'back'} from ${k}`;
        const step = { what };
        r.steps.push(step);
        if (gap === 'slow') {
          for (let i = 0; i < n; i++) {
            await notches(P, 1, d, 0);
            k += d;
            await P.expectFrame(k, `${what}: notch ${i + 1}`, T);
          }
        } else {
          await notches(P, n, d, gap);
          k += n * d;
          await P.expectFrame(k, what, T);
        }
        step.landedMs = landedMs(vs, from);
        step.seeks = lib.lines(vs, /seek to \d/, from).length;
        step.ffmpegStarts = lib.lines(vs, /native decode from/, from).length;
        step.fromMemory = lib.lines(vs, /step back from memory/, from).length;
      }
      const s = await P.state();
      r.label = s.label;
      if (hdr) ok(/HDR output/.test(s.label || ''), `the HDR output path: ${s.label}`);
    } catch (e) {
      r.log = lib.lines(vs, /^(?!.*webview: (state|thumb|report) )/, P.fromMark).slice(-60);
      throw e;
    } finally { await P.close(); }
  });
}

const run = (prefix) => async (vs, h) => {
  const R = lib.recorder();
  if (!h.ffmpeg) return [{ name: 'skipped', ok: true, skipped: 'no ffmpeg (test clips and reference frames)', problems: [] }];
  await wheelChecks(vs, h, R, `${prefix}/hevc10_4k`);
  await wheelChecks(vs, h, R, `${prefix}/hevc10_4k_pq_hdr`, { hdr: true });
  return R.out;
};

module.exports = [
  { name: 'wheel_step', settings: SETTINGS, env: { VPE_HDR_FORCE: '1' }, run: run('wasm') },
  { name: 'wheel_step_native', settings: SETTINGS, env: { VPE_HDR_FORCE: '1' }, ffmpeg: true, run: run('native') },
];
