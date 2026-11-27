'use strict';
// Live transcode over a very slow simulated Remote-SSH link (1 Mb/s, 150 ms round trip: src/link-sim.js, the
// maintainer's `review.cmd --link very-slow-ssh --transcode always`), on a generated 4K H.264 clip at ~80 Mb/s with a
// keyframe every 10 s (the stress clips' shape, test/media .stress): how long opening takes until a picture shows, and
// whether every seek input moves what the UI owns (seek bar, time) at once, with the loading ring after 150 ms and the
// picture after it (docs/notes/seek-pending-feedback.md).
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const lib = require('../lib');

const ASSOC = { '*.mp4': 'videoPreviewEnhanced.playerOptional' };
const FPS = 25;

/**
 * 20 s of 4K HEVC 10-bit HDR (PQ) at 25 fps, ~80 Mb/s (grain), a keyframe every 250 frames, with sound (AAC): the shape of
 * the stress clip hevc10_pq_2160p25_100mbps_gop250.mp4. Frame n carries n in binary (ten white boxes in a black band at the
 * top, as remote_stream.js makeWarmClip). Made once into test/vscode/out (libx265, a few minutes).
 */
function makeClip(ffmpeg) {
  const dir = path.join(__dirname, '..', 'out');
  fs.mkdirSync(dir, { recursive: true });
  const name = 'rs_slow_2160p_hevc10_pq_80mbps_gop250';
  const out = path.join(dir, `${name}.mp4`);
  if (fs.existsSync(out)) return out;
  const pending = path.join(dir, `${name}.part.mp4`);
  const boxes = ['noise=alls=24:allf=t', 'drawbox=x=0:y=0:w=3840:h=216:color=black:t=fill'];
  for (let k = 0; k < 10; k++) boxes.push(`drawbox=x=${k * 384 + 32}:y=24:w=320:h=168:color=white:t=fill:enable='gt(bitand(n,${1 << k}),0)'`);
  boxes.push('format=yuv420p10le');
  const r = spawnSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=s=3840x2160:r=${FPS}:d=20`,
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=20', '-vf', boxes.join(','),
    '-c:v', 'libx265', '-preset', 'ultrafast', '-b:v', '80M', '-x265-params',
    'keyint=250:min-keyint=250:bframes=0:scenecut=0:vbv-maxrate=100000:vbv-bufsize=160000:log-level=error',
    '-color_primaries', 'bt2020', '-color_trc', 'smpte2084', '-colorspace', 'bt2020nc', '-color_range', 'tv', '-tag:v', 'hvc1',
    '-c:a', 'aac', '-ac', '2', '-movflags', '+faststart', pending], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`making the slow-link clip: ${r.stderr}`);
  fs.renameSync(pending, out);
  return out;
}

/** Host log lines of this clip since `from`, as [ms since t0, text] (the log's own ISO timestamps). */
function timeline(vs, name, from, t0) {
  vs.mark();
  return vs.lines.slice(from).filter((l) => l.includes(`[${name}]`) || /remote stream encoder|link-sim/.test(l)).map((l) => {
    const m = /^(\d{4}-\d\d-\d\dT[\d:.]+Z) (.*)$/.exec(l);
    return m ? [Date.parse(m[1]) - t0, m[2].replace(`[${name}] `, '').slice(0, 220)] : [null, l.slice(0, 220)];
  });
}

/**
 * Runs `input` through the page's trace probe and reads when the bar, the time, the ring and the picture answered.
 * rows: [ms, seek value, time text, tiles loading, pulse, frame shown, seek pending].
 */
async function trace(p, input, ms = 6000) {
  const r = await p.ask('trace', Array.isArray(input) ? { inputs: input, ms } : { input, ms }, ms + 15000);
  const rows = r.rows;
  const base = rows[0];
  const first = (f) => { const x = rows.find(f); return x ? x[0] : null; };
  return {
    from: base[5],
    barMs: first((x) => x[1] !== base[1]),
    bar: rows[rows.length - 1][1],
    timeMs: first((x) => x[2] !== base[2]),
    ringMs: first((x) => x[3] > 0),
    pictureMs: first((x) => x[5] === rows[rows.length - 1][1] && x[5] !== base[5]),
    end: rows[rows.length - 1].slice(1),
    maxGapMs: r.maxGapMs,
    rows: rows.length > 14 ? [...rows.slice(0, 8), '...', ...rows.slice(-5)] : rows,
  };
}

module.exports = [{
  name: 'remote_slow_link',
  ffmpeg: true,
  env: { VPE_SIMULATE_LINK: 'mbps=1,rtt=150,jitter=30', VPE_SIMULATE_REMOTE: 'ssh-remote' },
  settings: {
    'videoPreviewEnhanced.transcode': 'always', 'videoPreviewEnhanced.loop': false, 'videoPreviewEnhanced.sizeFramesToView': false,
    'workbench.editorAssociations': ASSOC,
  },
  timeout: 12 * 60e3,
  async run(vs, h) {
    const { out, run } = lib.recorder();
    // VPE_SLOW_LINK_CLIP: another clip for measuring (a stress clip of test/media/make_stress_media.js); the frame
    // numbers drawn in the picture are then not checked.
    const file = process.env.VPE_SLOW_LINK_CLIP || makeClip(h.ffmpeg);
    let p = null;
    await run('open', async (ok, r) => {
      const t0 = Date.now();
      p = await lib.open(vs, h, file, { timeout: 90000 });
      r.firstPictureMs = Date.now() - t0;
      const s = await p.waitState((x) => x.firstShown, { timeout: 60000, what: 'first picture' });
      r.state = { vmode: s.vmode, canvas: s.canvas, frame: s.frame, playing: s.playing };
      await h.sleep(4000);
      r.timeline = timeline(vs, p.name, p.fromMark, t0);
      ok(s.vmode === 'webcodecs', `not Live transcode: ${s.vmode}`);
      // A hardware tone-mapper that fails (libplacebo without a Vulkan device on some ffmpeg builds) is tried once: not
      // again by the per-seek ffmpeg after the kept-running decoder, which stays on with the next tone-mapper.
      const lines = r.timeline.map((x) => x[1]);
      const failed = lines.filter((l) => /HDR tone-mapping failed/.test(l)).map((l) => /: (\w+) HDR tone-mapping/.exec(l)[1]);
      ok(new Set(failed).size === failed.length, `a tone-mapper failed more than once: ${failed.join(', ')}`);
      ok(!failed.length || !lines.some((l) => /kept-running decoder failed/.test(l)), 'a tone-mapper failure turned the kept-running decoder off');
    });
    if (!p) return out;
    await run('seek-inputs', async (ok, r) => {
      p.pause();
      await h.sleep(1500);
      r.inputs = {};
      const n = (await p.state()).seekMax;
      const f = (x) => Math.max(0, Math.min(n, Math.round(x * n)));
      // Each input from where the last one landed. Everything the UI owns (the bar, the time) moves on the input, before
      // the picture and before the input's next event (a press before its release, a drag at each move); the paused ones
      // then land on the bar's frame.
      const go = async (label, input, { paused = true } = {}) => {
        const from = vs.mark();
        const t0 = Date.now();
        const x = await trace(p, input);
        r.inputs[label] = x;
        const list = Array.isArray(input) ? input : [input];
        const next = list.length > 1 ? list[1].at : Infinity;
        if (x.barMs === null || x.timeMs === null) ok(false, `${label}: the bar or the time did not move (${JSON.stringify(x.rows)})`);
        else {
          ok(x.timeMs < next && x.barMs < next, `${label}: the bar / time moved ${x.barMs} / ${x.timeMs} ms after the input, after its next event (${next} ms)`);
          if (x.pictureMs !== null) ok(x.timeMs <= x.pictureMs, `${label}: the time moved after the picture`);
        }
        if (paused) {
          try {
            const s = await p.waitState((y) => !y.playing && y.frame === x.bar, { timeout: 30000, interval: 100, what: `${label}: frame ${x.bar}` });
            x.landed = s.frame;
          } catch (e) {
            // What the host and the page did meanwhile, for the report.
            r.stuck = { label, log: timeline(vs, p.name, from, t0).filter((l) => !/webview: (state|trace) \{/.test(l[1])) };
            throw e;
          }
        }
        await h.sleep(1500);
        return x;
      };
      const at = (fr) => fr / n;
      const click = (fr) => [{ action: 'dom', ev: 'pointerdown', frac: at(fr) }, { action: 'dom', ev: 'pointerup', frac: at(fr), at: 90 }];
      const drag = (fs) => [{ action: 'dom', ev: 'pointerdown', frac: at(fs[0]) },
        ...fs.slice(1).map((fr, i) => ({ action: 'dom', ev: 'pointermove', frac: at(fr), at: 120 * (i + 1) })),
        { action: 'dom', ev: 'pointerup', frac: at(fs[fs.length - 1]), at: 120 * fs.length }];
      const keys = (key, k, every) => Array.from({ length: k }, (_, i) => ({ action: 'key', key, at: i * every }));
      // With VPE_SLOW_LINK_PER_SEEK: the kept-running decoder off (ffmpeg per seek, as for a Compare tile that does not
      // set the clock), the paused inputs twice.
      if (process.env.VPE_SLOW_LINK_PER_SEEK) {
        p.act({ action: 'warmDecoder', on: false });
        for (let i = 0; i < 2; i++) {
          await go(`ps${i}-click`, click(f(0.6 - 0.3 * i)));
          await go(`ps${i}-arrow-right`, { action: 'key', key: 'ArrowRight' });
          await go(`ps${i}-end`, { action: 'key', key: 'End' });
          await go(`ps${i}-number-3`, { action: 'key', key: '3' });
          await go(`ps${i}-arrow-left-x2`, keys('ArrowLeft', 2, 120));
        }
        p.act({ action: 'warmDecoder', on: true });
      }
      await go('seekbar-click', click(f(0.6)));
      await go('arrow-right', { action: 'key', key: 'ArrowRight' });
      await go('frame-step', { action: 'key', key: '.' });
      await go('frame-back', { action: 'key', key: ',' });
      await go('wheel', { action: 'wheel', deltaY: 100 });
      await go('home', { action: 'key', key: 'Home' });
      await go('number-5', { action: 'key', key: '5' });
      await go('end', { action: 'key', key: 'End' });
      await go('arrow-left-x2', keys('ArrowLeft', 2, 120));
      await go('frame-back-x6', keys(',', 6, 60));
      await go('wheel-x6', Array.from({ length: 6 }, (_, i) => ({ action: 'wheel', deltaY: -100, at: i * 50 })));
      await go('drag', drag([0.1, 0.18, 0.26, 0.34, 0.42].map(f)));
      // Playing: the same inputs while the clock runs (the bar and time then move on with the clock).
      p.play();
      await h.sleep(3000);
      await go('play-click', click(f(0.7)), { paused: false });
      await go('play-arrow-left', { action: 'key', key: 'ArrowLeft' }, { paused: false });
      await go('play-number-2', { action: 'key', key: '2' }, { paused: false });
      await go('play-drag', drag([0.3, 0.38, 0.46].map(f)), { paused: false });
      p.pause();
    });
    try { await h.closeClip(vs); } catch { /* gone */ }
    return out;
  },
}];
