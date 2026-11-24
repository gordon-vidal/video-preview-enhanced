'use strict';
// Seek-bar previews (docs/notes/seek-preview.md) in a real VS Code, simple mode (the default). Lazy:
//   idle:    after open nothing is decoded (no thumbnail service, no request, no worker, no ffmpeg
//            thumbnail process) until the first hover, also not 4 s after the first frame
//   hover:   a thumbnail shows up on hover (the exact keyframe; neighbours fill while the pointer stays)
//   drag:    while the slider is dragged (synthetic: pointerdown, input events, then pointerup)
//            the thumbnail follows the slider and changes, and the main picture holds its committed frame
//   stop:    after the pointer leaves and after the drag ends, no further thumbnail request is made
//   exact:   on release the picture is exactly the frame under the slider (ffmpeg reference), and
//            a later seek and frame step stay exact
// Two decode paths: WebAssembly (MPEG-2, built-in decoder) and native ffmpeg (HEVC, ffmpeg: true).
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
      // 1. Idle: nothing decodes on its own (longer than the old 2 s strip start).
      await lib.sleep(4000);
      const idle = await P.state();
      ok(!idle.strip, `no thumbnail service before the first hover (${JSON.stringify(idle.strip)})`);
      ok(idle.thumb.hidden, 'no thumbnail shown');
      ok(!lib.lines(vs, /thumbs:|thumb ffmpeg/, P.fromMark).length, 'no thumbnail worker or ffmpeg process started');
      const [sx, sy, sw, sh] = idle.seekRect;

      // 2. Hover: a picture appears (worker start or ffmpeg + one keyframe), then neighbours fill.
      const th0 = Date.now();
      P.dom('mousemove', sx + sw * 0.37, sy + sh / 2);
      const hv = await P.waitState((x) => !x.thumb.hidden && x.thumb.w > 0, { timeout: 15000, what: 'hover thumbnail', interval: 50 });
      r.firstPictureMs = Date.now() - th0;
      ok(!hv.tip.hidden, 'time tip shown');
      const filled = await P.waitState((x) => x.strip && x.strip.slots >= 9 && x.strip.hovering, { timeout: 15000, what: 'neighbours filled while hovering' });
      r.hover = filled.strip;
      ok(filled.strip.slots <= 9, `only the neighbourhood is decoded (${filled.strip.slots} places, ${filled.strip.cached} pictures)`);
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

module.exports = [{
  name: 'seek_preview',
  settings: SETTINGS,
  async run(vs, h) {
    const R = lib.recorder();
    if (!h.ffmpeg) return [{ name: 'skipped', ok: true, skipped: 'no ffmpeg (reference frames)', problems: [] }];
    const file = makeClip(h, 'sp_mpeg2_20s.mpg', ['-c:v', 'mpeg2video', '-g', '25', '-q:v', '4']);
    await previewChecks(vs, h, file, R, 'wasm');
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
    return R.out;
  },
}];
