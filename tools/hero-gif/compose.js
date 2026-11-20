'use strict';
// Turns a take from record.js (timestamped window frames + the driver's input log) into the GIF,
// the MP4 and review stills.
//
//   node tools/hero-gif/compose.js [--tmp <dir with frames/ and events.json>] [--out media/marketing] [--width 1280] [--fps 15]
//
// - Timeline: from "rec on" to "rec off" in the driver's clock, without the spans marked as cuts
//   (waiting for a player or compare to open); spans between "speed" marks play faster. Output frame i (at i / fps) takes the captured frame
//   closest to its moment, so a capture that stuttered under load still plays at a steady rate.
// - Cursor: PrintWindow has none, so an arrow is drawn at the logged pointer position, with a
//   short ring on each click.
// - Encodes: GIF with palettegen (stats_mode=diff) / paletteuse (Bayer dither, rectangle diff),
//   (128 colours), MP4 with x264 (yuv420p, faststart). Stills (PNG) at the take's "still" marks go to <tmp>/stills.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

// Arrow cursor (Windows' shape at 100 %): outline polygon, then the white fill inside it.
const OUTER = [[0, 0], [0, 18.5], [4.3, 14.4], [7.2, 21], [10.4, 19.6], [7.6, 13.3], [13.3, 13.3]];
const INNER = [[1.2, 2.8], [1.2, 15.7], [4.6, 12.5], [7.8, 19.4], [9, 18.9], [5.9, 12.1], [10.4, 12.1]];

function inside(poly, x, y) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

/** Coverage masks of the cursor (outline, fill), 4x4 supersampled, 15 x 23 px. */
const MASK = (() => {
  const W = 15, H = 23, o = new Float32Array(W * H), f = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let a = 0, b = 0;
    for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) {
      const px = x + (sx + 0.5) / 4, py = y + (sy + 0.5) / 4;
      if (inside(OUTER, px, py)) a++;
      if (inside(INNER, px, py)) b++;
    }
    o[y * W + x] = a / 16; f[y * W + x] = b / 16;
  }
  return { W, H, o, f };
})();

function blend(buf, w, h, x, y, rgb, a) {
  if (x < 0 || y < 0 || x >= w || y >= h || a <= 0) return;
  const i = (y * w + x) * 4;
  buf[i] = buf[i] * (1 - a) + rgb[2] * a;
  buf[i + 1] = buf[i + 1] * (1 - a) + rgb[1] * a;
  buf[i + 2] = buf[i + 2] * (1 - a) + rgb[0] * a;
}

function drawCursor(buf, w, h, cx, cy) {
  const { W, H, o, f } = MASK;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    // soft shadow, then black outline, then white fill
    blend(buf, w, h, cx + x + 1, cy + y + 1, [0, 0, 0], o[y * W + x] * 0.25);
  }
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    blend(buf, w, h, cx + x, cy + y, [0, 0, 0], o[y * W + x]);
    blend(buf, w, h, cx + x, cy + y, [255, 255, 255], f[y * W + x]);
  }
}

/** A click: a ring that grows and fades over `k` 0..1. */
function drawRing(buf, w, h, cx, cy, k) {
  const r = 7 + 13 * k, a = 0.55 * (1 - k), th = 2;
  for (let y = Math.floor(cy - r - th); y <= cy + r + th; y++) for (let x = Math.floor(cx - r - th); x <= cx + r + th; x++) {
    const d = Math.abs(Math.hypot(x - cx, y - cy) - r);
    if (d < th) blend(buf, w, h, x, y, [90, 170, 255], a * Math.min(1, th - d));
  }
}

function readFrame(file) {
  const b = fs.readFileSync(file);
  return { w: b.readInt32LE(0), h: b.readInt32LE(4), px: Buffer.from(b.subarray(8)) };
}

function ffmpeg(args, input) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', ['-v', 'error', '-y', ...args], { stdio: [input ? 'pipe' : 'ignore', 'inherit', 'inherit'], windowsHide: true });
    p.on('error', reject);
    p.on('close', (c) => (c === 0 ? resolve() : reject(new Error(`ffmpeg exited ${c}`))));
    if (input) input(p.stdin);
  });
}

async function compose({ tmp, frames, out, width = 1280, fps = 15, name = 'hero-remote' }) {
  const events = JSON.parse(fs.readFileSync(path.join(tmp, 'events.json'), 'utf8'));
  const list = fs.readdirSync(frames).filter((f) => f.endsWith('.bgra'))
    .map((f) => ({ f: path.join(frames, f), t: Number(/_(\d+)\.bgra$/.exec(f)[1]) })).sort((a, b) => a.t - b.t);
  if (!list.length) throw new Error('no frames');
  const t0 = events.find((e) => e.op === 'rec' && e.on).t;
  const t1 = events.find((e) => e.op === 'rec' && !e.on).t;
  // Kept spans of the driver's clock, each with its playback rate: cuts are dropped, "speed" marks
  // play a span faster (pure pointer travel, where nothing else moves).
  const spans = [];
  let s = t0, rate = 1;
  for (const e of events) {
    if (e.op !== 'mark' || (!e.cut && !e.speed)) continue;
    if (s !== null) spans.push([s, e.t, rate]);
    if (e.cut === 'start') s = null;
    else { s = e.t; if (e.speed) rate = e.speed === 'end' ? 1 : Number(e.speed); }
  }
  spans.push([s, t1, rate]);
  const total = spans.reduce((n, [a, b, r]) => n + (b - a) / r, 0);
  const toSource = (ms) => {
    let left = ms;
    for (const [a, b, r] of spans) { if (left <= (b - a) / r) return a + left * r; left -= (b - a) / r; }
    return t1;
  };
  const toOutput = (src) => {
    let acc = 0;
    for (const [a, b, r] of spans) { if (src <= b) return acc + Math.max(0, src - a) / r; acc += (b - a) / r; }
    return acc;
  };
  const pointer = events.filter((e) => ['move', 'down', 'up', 'dbl'].includes(e.op));
  const clicks = events.filter((e) => e.op === 'dbl' || (e.op === 'down'));
  const n = Math.floor((total / 1000) * fps);
  console.log(`compose: ${list.length} captured frames over ${((t1 - t0) / 1000).toFixed(1)} s (${(list.length / ((t1 - t0) / 1000)).toFixed(1)} fps), `
    + `output ${(total / 1000).toFixed(2)} s = ${n} frames at ${fps} fps; ${spans.length} spans`);
  const nearest = (t) => {
    let lo = 0, hi = list.length - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (list[m].t < t) lo = m + 1; else hi = m; }
    return lo > 0 && Math.abs(list[lo - 1].t - t) <= Math.abs(list[lo].t - t) ? list[lo - 1] : list[lo];
  };
  const { w, h } = readFrame(list[0].f);
  const render = (src) => {
    const img = readFrame(nearest(src).f);
    let p = null;
    for (const e of pointer) { if (e.t <= src) p = e; else break; }
    for (const c of clicks) {
      const k = (src - c.t) / 380;
      if (k >= 0 && k < 1) drawRing(img.px, w, h, c.x, c.y, k);
    }
    if (p) drawCursor(img.px, w, h, p.x, p.y);
    return img.px;
  };
  fs.mkdirSync(out, { recursive: true });
  const master = path.join(tmp, `${name}-master.mkv`);
  await ffmpeg(['-f', 'rawvideo', '-pix_fmt', 'bgra', '-s', `${w}x${h}`, '-r', String(fps), '-i', '-', '-c:v', 'ffv1', '-pix_fmt', 'bgr0', master], async (stdin) => {
    for (let i = 0; i < n; i++) {
      const ok = stdin.write(render(toSource((i * 1000) / fps)));
      if (!ok) await new Promise((r) => stdin.once('drain', r));
    }
    stdin.end();
  });
  const scale = `scale=${width}:-2:flags=lanczos`;
  const mp4 = path.join(out, `${name}.mp4`);
  await ffmpeg(['-i', master, '-vf', `${scale},format=yuv420p`, '-c:v', 'libx264', '-preset', 'slow', '-crf', '20', '-movflags', '+faststart', '-an', mp4]);
  // 128 colours with Bayer scale 5 keep a 12 s, 1280 px take under 5 MB (256 / scale 4: about 6 MB);
  // if it is still bigger, 960 px.
  const gif = path.join(out, `${name}.gif`);
  for (const wd of [width, 960]) {
    await ffmpeg(['-i', master, '-vf', `scale=${wd}:-2:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`, '-loop', '0', gif]);
    if (fs.statSync(gif).size < 5e6) break;
    console.log(`GIF at ${wd} px is ${(fs.statSync(gif).size / 1e6).toFixed(2)} MB; trying 960 px`);
  }
  const stills = path.join(tmp, 'stills');
  fs.rmSync(stills, { recursive: true, force: true });
  fs.mkdirSync(stills, { recursive: true });
  for (const e of events.filter((x) => x.op === 'mark' && x.still)) {
    const raw = path.join(stills, `${e.still}.bgra`);
    fs.writeFileSync(raw, render(e.t));
    await ffmpeg(['-f', 'rawvideo', '-pix_fmt', 'bgra', '-s', `${w}x${h}`, '-i', raw, '-frames:v', '1', path.join(stills, `${e.still}.png`)]);
    fs.rmSync(raw);
    console.log(`still ${e.still} at ${(toOutput(e.t) / 1000).toFixed(2)} s`);
  }
  for (const f of [gif, mp4]) console.log(`${f}: ${(fs.statSync(f).size / 1e6).toFixed(2)} MB`);
  return { gif, mp4, stills, seconds: total / 1000, frames: n };
}

module.exports = { compose };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
  const tmp = path.resolve(opt('--tmp', path.join(os.tmpdir(), 'vpe-hero')));
  compose({ tmp, frames: path.join(tmp, 'frames'), out: path.resolve(opt('--out', path.join(__dirname, '..', '..', 'media', 'marketing'))),
    width: Number(opt('--width', 1280)), fps: Number(opt('--fps', 15)) }).catch((e) => { console.error(e); process.exit(1); });
}
