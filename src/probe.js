'use strict';
// The ffmpeg probe: on this machine, with this ffmpeg and GPU driver, which
// decoding method plays each codec/resolution fastest, and does it decode
// correctly? Short clips of real footage (media/probe/) go through the native
// decode pipeline, including GPU scaling where playback uses it.
// Results are stored per ffmpeg version and GPU driver
// fingerprint, so a new ffmpeg or driver tests again.
//
// Few ffmpeg processes, because starting one costs 0.2-0.7 s and each GPU decoder
// another 0.1-1 s (on a busy laptop more):
// 1. the reference run: software decoding of every clip in one process (each clip an
//    input with its own output: frame CHECK_FRAME, small, to its own pipe);
// 2. per method and resolution one run: the clips that still need this method are
//    concatenated (concat filter), each looped for a short segment. The frame counter
//    (-progress) gives each segment's speed, the decoder's log says whether the frames
//    came from the GPU (ffmpeg falls back to software silently), and frame CHECK_FRAME
//    of each segment, sent to a pipe, is compared with the reference (broken drivers).
// The runs follow each other (a run beside another would slow both down).

const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const hwaccel = require('./hwaccel');

// frames: frames in the clip (segments are counted in frames). In each resolution the
// codecs GPUs most often lack (AV1, then VP9) come last: a decoder that fails ends a run.
const CLIPS = [
  { file: 'h264_8_1080.mkv', codec: 'h264', depth: 8, res: '1080', frames: 30 },
  { file: 'hevc_8_1080.mkv', codec: 'hevc', depth: 8, res: '1080', frames: 30 },
  { file: 'hevc_10_1080.mkv', codec: 'hevc', pixFmt: 'yuv420p10le', depth: 10, res: '1080', frames: 30 },
  { file: 'prores_10_1080.mkv', codec: 'prores', depth: 10, res: '1080', frames: 5 },
  { file: 'vp9_8_1080.mkv', codec: 'vp9', depth: 8, res: '1080', frames: 30 },
  { file: 'av1_8_1080.mkv', codec: 'av1', depth: 8, res: '1080', frames: 30 },
  { file: 'h264_8_2160.mkv', codec: 'h264', depth: 8, res: '2160', frames: 15 },
  { file: 'hevc_8_2160.mkv', codec: 'hevc', depth: 8, res: '2160', frames: 15 },
  { file: 'hevc_10_2160.mkv', codec: 'hevc', pixFmt: 'yuv420p10le', depth: 10, res: '2160', frames: 15 },
  { file: 'vp9_8_2160.mkv', codec: 'vp9', depth: 8, res: '2160', frames: 15 },
  { file: 'av1_8_2160.mkv', codec: 'av1', depth: 8, res: '2160', frames: 15 },
];
const CLIP_FPS = 30;
// The frame compared against software decoding (a predicted frame: broken drivers show there too).
const CHECK_FRAME = 4;
const CHECK_SIZE = [640, 360];
// Input i of a run is read at CHECK_RATE + i fps (-r): ffmpeg's log line naming the pixel
// format an input's decoder delivers sometimes loses its "[... stream i:0]" prefix (another
// thread logged half a line just before); the rate in it still says which input it was.
const CHECK_RATE = 100;
// Below this, the GPU picture is wrong (green or garbled frames are far below 20 dB;
// the same picture through a different scaler stays above 35 dB).
const MIN_PSNR = 30;
// A method decoding at least this fast (2x real time for 30 fps) is good enough:
// the first such one in the platform's order wins over a faster one further down
// (the GPU leaves the CPU free and uses less power).
const COMFORT_FPS = 60;
// Once a method reaches this, the methods after it in order are not timed: the choice for
// any video up to 60 fps (decide.js wants 2x its frame rate) can no longer change.
const STOP_FPS = 2 * COMFORT_FPS;
// A method further down the order replaces an earlier one only when it is at least this much
// faster: two methods within a few percent of each other don't swap places from run to run.
const HYSTERESIS = 1.3;
// Frames per timing segment (the clip repeated), and the frames at its start not measured
// (the decoder starts with its segment; its first frames take longer).
const SEGMENT_FRAMES = { 1080: 60, 2160: 30 };
const SKIP_FRAMES = 6;
const CPU_SEGMENTS = 3;
// A segment still running after this long is slow; its speed so far is its result.
const SEGMENT_LIMIT_MS = 2500;
const START_LIMIT_MS = 20000;
const REF_LIMIT_MS = 30000;
const STATE_KEY = 'videoPreviewEnhanced.probe';
// Part of the fingerprint: a probe that measures differently (3: per-stream GPU scaling) tests again.
const PROBE_VERSION = 3;

/**
 * What decides whether stored results still apply: the probe's version, ffmpeg build and where it is, GPUs with
 * driver versions, OS version, and whether GPU decoding is allowed at all (gpu false: CPU only).
 */
function fingerprint(tools, hw, gpu = true) {
  const gpus = (hw.gpus || []).map((g) => `${g.name}@${g.driver || ''}`).sort().join(';');
  const text = [PROBE_VERSION, tools.version || '', tools.ffmpeg || '', gpus, hw.nvidiaDriver || '', `${os.platform()} ${os.release()}`, gpu ? 'gpu' : 'cpu'].join('|');
  return crypto.createHash('sha1').update(text).digest('hex').slice(0, 16);
}

// ---- running ffmpeg -------------------------------------------------------------

/**
 * Spawns ffmpeg hidden, at normal priority (it is short, and playback runs at normal priority
 * too). pipes: extra output pipes (fd 3, 4, ...), collected. onStdout(text), onStderr(text):
 * output as it arrives, onPipe(i, bytes) the extra pipes' data. Returns { done: Promise<{ code, stderr, pipes: Buffer[], aborted, killed }>, kill() }.
 */
function ffSpawn(ffmpeg, args, { pipes = 0, onStdout, onStderr, onPipe, signal, limitMs = REF_LIMIT_MS } = {}) {
  let p;
  let killed = false;
  const kill = () => { killed = true; try { p.kill(); } catch { /* gone */ } };
  const done = new Promise((resolve) => {
    try {
      p = spawn(ffmpeg, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', ...Array(pipes).fill('pipe')] });
    } catch (e) {
      resolve({ code: -1, stderr: String(e), pipes: [], aborted: false, killed: false });
      return;
    }
    const bufs = Array.from({ length: pipes }, () => []);
    for (let i = 0; i < pipes; i++) { const s = p.stdio[3 + i]; if (s) s.on('data', (d) => { bufs[i].push(d); if (onPipe) onPipe(i, d.length); }); }
    let err = '';
    p.stdout.on('data', (d) => { if (onStdout) onStdout(d.toString()); });
    p.stderr.on('data', (d) => { if (onStderr) onStderr(d.toString()); if (err.length < 4e6) err += d; });
    p.on('error', (e) => { err += String(e); });
    const limit = setTimeout(kill, limitMs);
    const onAbort = () => kill();
    if (signal) { if (signal.aborted) kill(); else signal.addEventListener('abort', onAbort); }
    p.on('close', (code) => {
      clearTimeout(limit);
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve({ code: code === null ? -1 : code, stderr: err, pipes: bufs.map((b) => Buffer.concat(b)), aborted: !!(signal && signal.aborted), killed });
    });
  });
  return { done, kill };
}

/** Output size the native player would use for a clip of this height (src/native.js). */
function outSize(res, maxHeight) {
  const [w, h] = res === '2160' ? [3840, 2160] : [1920, 1080];
  let oh = Math.min(h, maxHeight || 1080);
  oh -= oh % 2;
  let ow = Math.round((w * oh) / h);
  ow -= ow % 2;
  return [ow, oh];
}

const CHECK_SCALE = `scale=${CHECK_SIZE[0]}:${CHECK_SIZE[1]}:flags=bilinear,format=yuv420p`;
const FRAME_BYTES = (CHECK_SIZE[0] * CHECK_SIZE[1] * 3) / 2;

/**
 * Arguments for the reference run: software decoding (one thread each: five frames only),
 * frame CHECK_FRAME of every clip through playback's filter chain at its playback size
 * (sizes[i]), then made small, to pipe:3, pipe:4, ...
 */
function referenceArgs(files, sizes) {
  const args = ['-hide_banner', '-nostdin', '-v', 'error', '-filter_threads', '1'];
  for (const f of files) args.push('-threads', '1', '-i', f);
  files.forEach((f, i) => {
    args.push('-map', `${i}:v:0`, '-frames:v', '1', '-vf', `select=eq(n\\,${CHECK_FRAME}),${hwaccel.videoFilter('none', sizes[i][0], sizes[i][1])},${CHECK_SCALE}`,
      '-f', 'rawvideo', `pipe:${3 + i}`);
  });
  return args;
}

/** Runs the reference: { code, stderr, frames: [Buffer|null per input], aborted }. */
async function ffReference(ffmpeg, args, n, { signal } = {}) {
  const r = await ffSpawn(ffmpeg, args, { pipes: n, signal }).done;
  return { code: r.code, stderr: r.stderr, aborted: r.aborted, frames: r.pipes.map((b) => (b.length >= FRAME_BYTES ? b.subarray(0, FRAME_BYTES) : null)) };
}

/**
 * Loops of a clip and frames of its timing segment. Software decoding of the light clips is
 * fast (300-1000 fps): its segments are CPU_SEGMENTS times longer, so they last long enough
 * (0.2-0.4 s) to be measured.
 */
function segmentOf(clip, method) {
  const want = (SEGMENT_FRAMES[clip.res] || 60) * (method === 'none' ? CPU_SEGMENTS : 1);
  const loops = Math.max(1, Math.ceil(want / (clip.frames || 30)));
  return { loops, frames: loops * (clip.frames || 30) };
}

/**
 * Arguments for a run: the clips (all of one resolution, so one output size) one after the
 * other (concat filter), each repeated for its segment, decoded with `method` and through
 * the baseline filter chain, then dropped (null). Every frame is tagged with its clip (metadata
 * vpe=i, printed after concat): the log says when each frame of each clip was done. Frame
 * CHECK_FRAME of each segment goes, small, to pipe:3. -v verbose: the decoders' pixel formats
 * (GPU or software frames) and, at the end, frames decoded and errors per input.
 * A clip is repeated by a concat list (loopList in listDir), not -stream_loop: a loop seeks back
 * and flushes the decoder (qsv then drops frames and sets up again; playback never does that).
 * Without listDir: -stream_loop. items: [{ path|file, frames, res, codec, pixFmt, depth }], size: [w, h].
 */
function runArgs(method, items, size, listDir, gpuFilters) {
  const [w, h] = size;
  const filters = items.map((it) => hwaccel.gpuFilter(method, gpuFilters, it));
  const args = ['-hide_banner', '-nostdin', '-v', 'verbose'];
  const starts = [];
  let total = 0;
  items.forEach((it, i) => {
    const { loops, frames } = segmentOf(it, method);
    starts.push(total);
    total += frames;
    const input = listDir ? ['-f', 'concat', '-safe', '0', '-i', loopList(listDir, it.path || it.file, loops)] : ['-stream_loop', String(loops - 1), '-i', it.path || it.file];
    args.push('-r', String(CHECK_RATE + i), ...hwaccel.inputArgs(method, filters[i]), ...input);
  });
  const chains = items.map((it, i) => `[${i}:v:0]${hwaccel.videoFilter(method, w, h, filters[i], it.depth)},setsar=1,metadata=mode=add:key=vpe:value=${i}[s${i}]`);
  const pick = starts.map((s) => `eq(n\\,${s + CHECK_FRAME})`).join('+');
  const graph = `${chains.join(';')};${items.map((_, i) => `[s${i}]`).join('')}concat=n=${items.length}:v=1:a=0,metadata=mode=print:key=vpe,split=2[out][chk];` +
    `[chk]select=${pick},${CHECK_SCALE}[k]`;
  args.push('-filter_complex', graph, '-map', '[out]', '-f', 'null', '-', '-map', '[k]', '-f', 'rawvideo', 'pipe:3');
  return args;
}

/** A concat list (ffconcat) that plays `file` `loops` times, written into dir once. */
function loopList(dir, file, loops) {
  const list = path.join(dir, `${path.basename(file).replace(/[^\w.-]/g, '_')}.${loops}.ffconcat`);
  if (!fs.existsSync(list)) {
    // ffconcat quoting: 'path', a ' inside as '\''.
    const line = `file '${path.resolve(file).replace(/\\/g, '/').replace(/'/g, "'\\''")}'\n`;
    fs.writeFileSync(list, `ffconcat version 1.0\n${line.repeat(loops)}`);
  }
  return list;
}

/**
 * Speed of a segment from the times its frames were done: from the frame SKIP_FRAMES into it
 * (the decoder starts when its segment does; its first frames take longer) to its last frame.
 * 0 with fewer than 5 frames to measure.
 */
function segmentSpeed(times) {
  const skip = Math.min(SKIP_FRAMES, Math.max(0, times.length - 6));
  const span = times[times.length - 1] - times[skip];
  return times.length - skip >= 6 && span > 0 ? ((times.length - 1 - skip) * 1000) / span : 0;
}

/** Per input of a finished run (ffmpeg -v verbose summary): { frames, errors }. */
function decodedPerInput(stderr) {
  const out = {};
  const re = /Input stream #(\d+):\d+ \(video\): \d+ packets read[^;\n]*; (\d+) frames decoded; (\d+) decode errors/g;
  let m;
  while ((m = re.exec(stderr || ''))) out[m[1]] = { frames: Number(m[2]), errors: Number(m[3]) };
  return out;
}

/**
 * Runs a run (see runArgs). A segment that takes longer than SEGMENT_LIMIT_MS ends it: its speed
 * so far is its result (slow). A decoder that fails ends the whole run (one filter graph): the
 * log names it (bad). A segment with fewer frames than planned shifts the check frames after it:
 * those clips aren't done (another run).
 * Returns { code, stderr, fps: [per item], checks: [Buffer|null per item], done: [segment
 * finished per item], bad: index of the clip that failed (or -1), slow, aborted }.
 */
async function ffRun(ffmpeg, args, items, { signal } = {}) {
  const n = items.length;
  const method = args.includes('-hwaccel') ? args[args.indexOf('-hwaccel') + 1] : 'none';
  const want = items.map((it) => segmentOf(it, method).frames);
  const times = Array.from({ length: n }, () => []);
  let cur = -1; // the segment frames are coming from
  let curStart = 0;
  let buf = '';
  let slow = false;
  const onStderr = (text) => {
    buf += text;
    const lines = buf.split(/\r?\n/);
    buf = lines.pop();
    const now = Date.now();
    for (const l of lines) {
      const m = /vpe=(\d+)\s*$/.exec(l);
      if (!m) continue;
      const i = Number(m[1]);
      if (i >= n) continue;
      if (i !== cur) { cur = i; curStart = now; }
      times[i].push(now);
    }
  };
  const h = ffSpawn(ffmpeg, args, { signal, pipes: 1, onStderr, limitMs: START_LIMIT_MS + n * SEGMENT_LIMIT_MS });
  const watchdog = setInterval(() => {
    if (cur >= 0 && times[cur].length < want[cur] && Date.now() - curStart > SEGMENT_LIMIT_MS) { slow = true; h.kill(); }
  }, 50);
  const r = await h.done;
  clearInterval(watchdog);
  const fps = times.map((t) => Math.round(segmentSpeed(t) * 10) / 10);
  // Finished: every segment before the current one, and the current one when the run ended by itself.
  const done = times.map((t, i) => i < cur || (i === cur && !r.killed && r.code === 0));
  let bad = -1;
  if (slow && cur >= 0) {
    const t = times[cur];
    fps[cur] = t.length > 1 ? Math.round((((t.length - 1) * 1000) / Math.max(1, t[t.length - 1] - curStart)) * 10) / 10 : 0.1;
    done[cur] = true;
  } else if (r.code !== 0 && !r.killed) {
    const dec = decodedPerInput(r.stderr);
    bad = Object.keys(dec).map(Number).sort((a, b) => a - b).find((i) => dec[i].errors > 0);
    if (bad === undefined) {
      const m = /vist#(\d+):\d+[^\n]*(error|fail)/i.exec(r.stderr);
      bad = m ? Number(m[1]) : -1;
    }
    if (bad >= 0 && bad < n) for (let i = bad; i < n; i++) done[i] = false;
    else bad = -1;
  }
  // The check frames are picked by frame number: right only while every segment before had all its frames.
  const chk = r.pipes[0] || Buffer.alloc(0);
  const checks = [];
  let shifted = false;
  for (let i = 0; i < n; i++) {
    checks.push(!shifted && chk.length >= (i + 1) * FRAME_BYTES ? chk.subarray(i * FRAME_BYTES, (i + 1) * FRAME_BYTES) : null);
    if (shifted) done[i] = false;
    else if (done[i] && times[i].length !== want[i] && !(slow && i === cur)) shifted = true;
  }
  return { code: r.code, stderr: r.stderr, fps, checks, done, bad, slow, aborted: r.aborted };
}

// ---- choosing ------------------------------------------------------------------

/**
 * The method for a list of tried methods (in the platform's order): walking the order, a later
 * method replaces the current choice only when the current one is not comfortable (below need,
 * COMFORT_FPS by default) and the later one is at least HYSTERESIS times faster.
 */
function pickMethod(tried, need = COMFORT_FPS) {
  let best = null;
  for (const t of tried) {
    if (!t.ok || !(t.fps > 0)) continue;
    if (!best) best = t;
    else if (best.fps < need && t.fps >= best.fps * HYSTERESIS) best = t;
  }
  return best;
}

// ---- the probe -----------------------------------------------------------------

/** Bits per pixel and frame of a clip (file size over frames and pixels): how hard its bitstream is. */
function clipBpp(file, clip) {
  try {
    const px = clip.res === '2160' ? 3840 * 2160 : 1920 * 1080;
    return Math.round(((fs.statSync(file).size * 8) / (clip.frames || 30) / px) * 10000) / 10000;
  } catch { return 0; }
}

/**
 * Tests every clip with every method of this platform's order.
 * opts: { tools, hw, clipDir, maxHeight, methods?, clips?, signal?, onProgress?(fraction, text), log?,
 *         idle?() -> Promise: resolves when nothing else needs the machine (awaited before each ffmpeg run:
 *         native playback and the probe would slow each other down and skew its timings),
 *         reference?(files, sizes) -> ffReference result, run?(method, items, size) -> ffRun result }
 * Returns { fp, ffmpeg, gpus, at, secs, maxHeight, complete, results: { class: { method, fps, realtimeFactor, sw, bpp, tried } } }.
 */
async function runProbe(opts) {
  const { tools, hw, clipDir, signal } = opts;
  const t0 = Date.now();
  const reference = opts.reference || ((files, sizes) => ffReference(tools.ffmpeg, referenceArgs(files, sizes), files.length, { signal }));
  let listDir = null; // concat lists for the default run
  const run = opts.run || ((m, items, size) => {
    if (!listDir) listDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vpe-probe-'));
    return ffRun(tools.ffmpeg, runArgs(m, items, size, listDir, tools.gpuFilters), items, { signal });
  });
  const log = opts.log || (() => {});
  const idle = opts.idle || (async () => {});
  const progress = opts.onProgress || (() => {});
  const maxHeight = opts.maxHeight || 1080;
  // methods: ['none'] when GPU decoding is switched off (videoPreviewEnhanced.gpuDecoding).
  const order = opts.methods || hwaccel.methodOrder(hw);
  const clips = (opts.clips || CLIPS).map((c) => ({
    ...c, path: path.join(clipDir, c.file),
    cls: hwaccel.classOf(c.codec, c.depth, c.res === '2160' ? 3840 : 1920, c.res === '2160' ? 2160 : 1080),
    tried: {},
  }));
  const aborted = () => !!(signal && signal.aborted);
  const fail = (c, m, error, extra = {}) => { c.tried[m] = { method: m, ok: false, fps: 0, error, ...extra }; };

  // 1. The software reference.
  progress(0, 'decoding the test clips on the CPU');
  await idle();
  if (aborted()) return finish(false);
  const ref = await reference(clips.map((c) => c.path), clips.map((c) => outSize(c.res, maxHeight)));
  if (ref.aborted || aborted()) return finish(false);
  clips.forEach((c, i) => {
    c.ref = ref.frames[i];
    if (!c.ref) log(`probe ${c.file}: software decoding failed: ${firstError(ref.stderr) || `exit ${ref.code}`}`);
  });

  // 2. Per method (in order) and resolution one run over the clips that still need it.
  const fast = (c) => Object.values(c.tried).some((t) => t.ok && t.fps >= STOP_FPS);
  const small = (c) => c.res === '2160' && clips.find((s) => s.res === '1080' && s.codec === c.codec && s.depth === c.depth);
  // 4K: a GPU method that failed or wasn't comfortable on the same codec at 1080p has a
  // quarter of the pixels' worth of headroom left at best; not timed (the CPU always is).
  // Not timed at 1080p (an earlier method was fast enough there): unknown, so timed.
  const hopeless = (c, m) => {
    const s = m !== 'none' && small(c);
    const t = s && s.tried[m];
    return !!t && (!t.ok || t.fps < COMFORT_FPS);
  };
  const runs = order.length * 2;
  let done = 0;
  for (const m of order) {
    for (const res of ['1080', '2160']) {
      if (aborted()) return finish(false);
      progress(done++ / runs, `${m === 'none' ? 'CPU' : m}, ${res === '2160' ? '4K' : '1080p'}`);
      let todo = clips.filter((c) => c.res === res && hwaccel.methodMayDecode(m, c.codec) && !fast(c) && !hopeless(c, m));
      for (const c of todo.filter((x) => !x.ref)) fail(c, m, 'software decoding of this clip failed (no reference picture)');
      todo = todo.filter((c) => c.ref);
      // A clip that fails or a segment that runs too long ends a run; the clips after it get another.
      for (let attempt = 0; todo.length && attempt < 6; attempt++) {
        await idle();
        if (aborted()) return finish(false);
        const r = await run(m, todo, outSize(res, maxHeight));
        if (r.aborted || aborted()) return finish(false);
        const rest = [];
        todo.forEach((c, i) => {
          if (i === r.bad) {
            const fb = m === 'none' ? null : hwaccel.checkFallback(m, r.stderr, { rate: CHECK_RATE + i, codec: c.codec });
            const soft = !!(fb && !fb.hw && fb.pixFmt);
            fail(c, m, soft ? `fell back to software: ${fb.reason}` : firstError(r.stderr) || `exit ${r.code}`, soft ? { fallback: true } : {});
          } else if (r.done[i]) judge(c, m, r, i);
          else rest.push(c);
        });
        if (r.bad < 0 && !r.done.some(Boolean)) {
          // Nothing at all (the method doesn't start, e.g. no device): every clip fails with it.
          for (const c of todo) fail(c, m, firstError(r.stderr) || `exit ${r.code}`);
          todo = [];
        } else todo = rest;
      }
      for (const c of todo) fail(c, m, 'not timed');
    }
  }
  return finish(true);

  /** A clip's result in a run: GPU frames (no silent fallback), the right picture, the speed. */
  function judge(c, m, r, i) {
    if (m !== 'none') {
      const fb = hwaccel.checkFallback(m, r.stderr, { rate: CHECK_RATE + i, codec: c.codec });
      if (!fb.hw) { fail(c, m, `fell back to software: ${fb.reason}`, { fallback: !!fb.pixFmt }); return; }
      const db = r.checks[i] ? hwaccel.psnr(c.ref, r.checks[i]) : 0;
      const psnr = db === Infinity ? 99 : Math.round(db * 10) / 10;
      if (db < MIN_PSNR) {
        fail(c, m, r.checks[i] ? `wrong picture (PSNR ${psnr} dB against software decoding)` : r.slow ? `too slow (${r.fps[i]} fps)` : 'no picture to check', { psnr });
        return;
      }
      if (!(r.fps[i] > 0)) { fail(c, m, firstError(r.stderr) || 'not timed', { psnr }); return; }
      c.tried[m] = { method: m, ok: true, fps: r.fps[i], psnr };
      return;
    }
    if (!(r.fps[i] > 0)) { fail(c, m, firstError(r.stderr) || 'not timed'); return; }
    c.tried[m] = { method: m, ok: true, fps: r.fps[i] };
  }

  function finish(complete) {
    if (listDir) { try { fs.rmSync(listDir, { recursive: true, force: true }); } catch { /* temp dir: fine */ } listDir = null; }
    const results = {};
    for (const c of clips) {
      const tried = order.map((m) => c.tried[m]).filter(Boolean);
      const bpp = clipBpp(c.path, c);
      // The stored choice is for a typical file (hwaccel.TYPICAL_BPP), not the light clip: software
      // speeds scaled as decide.js scales them for each file.
      const typical = tried.map((t) => (t.method === 'none' && t.ok ? { ...t, fps: t.fps * hwaccel.bitrateFactor('none', bpp, {}) } : t));
      const pickT = pickMethod(typical);
      const best = pickT && tried.find((t) => t.method === pickT.method);
      const sw = tried.find((x) => x.method === 'none' && x.ok);
      results[c.cls] = best
        ? { method: best.method, fps: best.fps, realtimeFactor: Math.round((best.fps / CLIP_FPS) * 100) / 100, sw: sw ? sw.fps : 0, bpp, tried }
        : { method: null, fps: 0, realtimeFactor: 0, sw: 0, bpp, tried };
      if (complete) log(`probe ${c.cls}: ${tried.map((x) => `${x.method} ${x.ok ? `${x.fps} fps` : `failed (${x.error})`}`).join(', ')} -> ${best ? best.method : 'none works'}`);
    }
    progress(1, 'done');
    return {
      fp: fingerprint(tools, hw, !opts.methods || opts.methods.length > 1), ffmpeg: tools.version, ffmpegPath: tools.ffmpeg, gpus: (hw.gpus || []).map((g) => `${g.name}${g.driver ? ` (${g.driver})` : ''}`),
      at: Date.now(), secs: Math.round((Date.now() - t0) / 100) / 10, maxHeight, complete: complete && !aborted(), results,
    };
  }
}

function firstError(stderr) {
  const lines = String(stderr || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const l = lines.find((x) => /error|fail|cannot|not supported|unsupported|invalid/i.test(x) && !/ 0 decode errors/.test(x)) || lines[lines.length - 1] || '';
  return l.replace(/^\[[^\]]*\]\s*/g, '').slice(0, 200);
}

// ---- stored results ------------------------------------------------------------

/** Stored results when they belong to this ffmpeg and GPU driver (fp), else null. */
function stored(state, fp) {
  const r = state.get(STATE_KEY);
  return r && r.fp === fp && r.complete ? r : null;
}

/** The latest stored results whatever their fingerprint (used until the background re-test is done). */
function latest(state) {
  return state.get(STATE_KEY) || null;
}

function save(state, record) {
  return state.update(STATE_KEY, record);
}

/** Text table of a probe record (log and the Re-test result). */
function table(record) {
  const rows = [`ffmpeg probe (${record.ffmpeg ? record.ffmpeg.replace(/ Copyright.*/, '') : '?'}; ${record.gpus.join(', ') || 'no GPU found'}${record.secs ? `; ${record.secs} s` : ''})`];
  rows.push('class            method     fps  x real time  (all tried)');
  for (const [cls, r] of Object.entries(record.results)) {
    rows.push(`${cls.padEnd(16)} ${String(r.method || '-').padEnd(9)} ${String(r.fps).padStart(5)}  ${String(r.realtimeFactor).padStart(5)}×  ` +
      `(${r.tried.map((t) => `${t.method} ${t.ok ? t.fps : t.fallback ? 'fallback' : 'fail'}`).join(', ')})`);
  }
  return rows.join('\n');
}

module.exports = {
  CLIPS, CLIP_FPS, CHECK_RATE, COMFORT_FPS, STOP_FPS, HYSTERESIS, MIN_PSNR, CHECK_FRAME, SKIP_FRAMES, STATE_KEY,
  fingerprint, ffSpawn, ffReference, ffRun, referenceArgs, runArgs, loopList, segmentOf, segmentSpeed, decodedPerInput,
  runProbe, pickMethod, outSize, clipBpp, stored, latest, save, table,
};
