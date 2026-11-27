'use strict';
// Remote stream (src/remotestream.js) in a local window: videoPreviewEnhanced.remoteStream "on"
// streams HEVC 10-bit as H.264 re-encoded by ffmpeg, decoded by WebCodecs in the real webview.
// The same path a remote window takes with "auto" (test/vscode/remote_ssh.js runs that one).
//
// remote_stream: three clips play (decoder path, shownFps, paused seeks); on the 2 s HEVC clip
//   (all of it stays in memory) a burst of seeks and steps back must not restart ffmpeg at all.
// remote_stream_long: a generated 200 s clip whose sound track starts 0.3 s after the picture,
//   played for 150 s (60 s with --quick): the position must follow the wall clock, sound must be
//   sent in step with the picture (at most 2 s ahead, the host's cap), no ffmpeg restarts while it
//   plays; then a burst of 20 seeks across the clip must start ffmpeg only a few times and land on
//   the last target, and of 3 steps back only the first may restart (1 s early, so the rest come
//   from memory).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const lib = require('../lib');

// Save Frame as PNG writes here instead of opening the save dialog (src/extension.js VPE_SAVE_DIR).
const SAVE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vpe-rs-save-'));
const pngSize = (f) => { const b = fs.readFileSync(f); return [b.readUInt32BE(16), b.readUInt32BE(20)]; };

const CLIPS = ['hevc_10_2160p.mp4', 'hevc_10_1080p.mp4', 'vp9_opus_anim_1080p.webm'];
const ASSOC = { '*.mp4': 'videoPreviewEnhanced.playerOptional', '*.webm': 'videoPreviewEnhanced.playerOptional', '*.mkv': 'videoPreviewEnhanced.playerOptional' };

/** report line -> { frame (0-based), t, playing } */
async function report(vs, h, name) {
  const m0 = vs.mark();
  vs.send({ action: 'report', name, delay: 0 });
  const rep = await vs.waitLog(new RegExp(`\\[${h.esc(name)}\\] webview: report frame=`), { from: m0, timeout: 10000, what: `${name}: report` });
  return { frame: Number(/frame=(\d+)/.exec(rep)[1]) - 1, t: Number(/ t=([\d.]+)/.exec(rep)[1]), playing: /playing=true/.test(rep) };
}

async function waitFrame(vs, h, name, k, ms = 12000) {
  const t0 = Date.now();
  let got = null;
  while (Date.now() - t0 < ms) {
    await h.sleep(150);
    got = (await report(vs, h, name)).frame;
    if (got === k) return { got, ms: Date.now() - t0 };
  }
  return { got, ms: Date.now() - t0 };
}

// 20 targets spread over the 200 s clip, jumping back and forth.
const LONG_TARGETS = Array.from({ length: 20 }, (_, i) => 10 + ((i * 7) % 20) * 9.1);

const starts = (vs, name, from) => vs.lines.slice(from).filter((l) => l.includes(`[${name}] remote stream from `)).length;

/**
 * Scrubbing and steps back on an open clip (paused first): targets (s) sent 40 ms apart; at most
 * maxStarts ffmpeg starts for them and maxStepStarts for 3 steps back. Exported for test/vscode/remote_ssh.js.
 */
async function seekChecks(vs, h, name, fps, targets, maxStarts, maxStepStarts) {
  const r = { ok: true, problems: [] };
  const bad = (m) => { r.ok = false; r.problems.push(m); };
  vs.send({ action: 'pause', name });
  await h.sleep(500);
  // Scrubbing: seeks 40 ms apart (the test hook seeks directly, like a fast drag).
  const m0 = vs.mark();
  for (const t of targets) { vs.send({ action: 'seek', name, t }); await h.sleep(40); }
  const k = Math.floor(targets[targets.length - 1] * fps);
  const w = await waitFrame(vs, h, name, k);
  vs.mark();
  r.scrub = { seeks: targets.length, ffmpegStarts: starts(vs, name, m0), landed: w.got, want: k, msAfterLast: w.ms };
  if (w.got !== k) bad(`scrub: landed on ${w.got}, want ${k}`);
  if (r.scrub.ffmpegStarts > maxStarts) bad(`scrub: ${r.scrub.ffmpegStarts} ffmpeg starts for ${targets.length} seeks`);
  // Wait for each frame before sending the next step, which is relative to the picture shown.
  const m1 = vs.mark();
  const steps = [];
  for (let i = 1; i <= 3; i++) {
    const s0 = Date.now();
    vs.send({ action: 'step', name, d: -1 });
    const s = await waitFrame(vs, h, name, k - i, 6000);
    steps.push({ want: k - i, got: s.got, ms: Date.now() - s0 });
    if (s.got !== k - i) { bad(`step back ${i}: showed ${s.got}, want ${k - i}`); break; }
    // On the long clip, give paused read-ahead time to fill after the first step primes the history.
    if (i === 1 && maxStepStarts) await h.sleep(6000);
  }
  vs.mark();
  r.stepsBack = { steps, ffmpegStarts: starts(vs, name, m1), fromMemory: vs.lines.slice(m1).filter((l) => l.includes(`[${name}] remote stream: seek to`) && l.includes('from memory')).length };
  if (r.stepsBack.ffmpegStarts > maxStepStarts) bad(`steps back restarted ffmpeg ${r.stepsBack.ffmpegStarts} times`);
  return r;
}

/** 200 s, 640x360 MPEG-4 Part 2 (streamed), 25 fps; sound (PCM, 44.1 kHz) starts 0.3 s after the picture. */
function makeLongClip(ffmpeg) {
  const dir = path.join(os.tmpdir(), 'vpe-rs-case');
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, 'rs_sync_200s.mkv');
  if (fs.existsSync(out)) return out;
  const v = "testsrc2=s=640x360:r=25:d=200,drawbox=enable='lt(mod(t\\,10)\\,0.04)':c=white:t=fill";
  const a = "aevalsrc='if(lt(mod(t+0.3\\,10)\\,0.05)\\,sin(2*PI*1000*t)\\,0.1*sin(2*PI*220*t))':s=44100:d=200";
  const r = spawnSync(ffmpeg || 'ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', v, '-itsoffset', '0.3', '-f', 'lavfi', '-i', a,
    '-map', '0', '-map', '1', '-c:v', 'mpeg4', '-q:v', '5', '-g', '50', '-c:a', 'pcm_s16le', out], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`making the long clip: ${r.stderr}`);
  return out;
}

/** Moving detail makes uncapped H.264 exceed the test link's rate. With `sound`, a tone the stream sends as PCM. */
function makeLinkClip(ffmpeg, sound = false) {
  const dir = path.join(__dirname, '..', 'out');
  fs.mkdirSync(dir, { recursive: true });
  const name = sound ? 'rs_link_1080p_sound' : 'rs_link_1080p';
  const out = path.join(dir, `${name}.mkv`);
  if (fs.existsSync(out)) return out;
  const pending = path.join(dir, `${name}.part.mkv`);
  const audio = sound ? ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=60', '-c:a', 'aac', '-ac', '2'] : [];
  const r = spawnSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=1920x1080:r=25:d=60', ...audio.slice(0, 4),
    '-vf', 'noise=alls=18:allf=t+u', '-c:v', 'mpeg4', '-q:v', '5', '-g', '50', ...audio.slice(4), pending], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`making the slow-link clip: ${r.stderr}`);
  fs.renameSync(pending, out);
  return out;
}

/**
 * A 60 s 4K HEVC clip (15 fps, a keyframe every 50 frames, B-frames, open GOP) whose frame n carries n in binary: ten
 * white boxes in a black band at the top (box k for bit k). Made once into test/vscode/out (libx265, ~25 s).
 */
function makeWarmClip(ffmpeg) {
  const dir = path.join(__dirname, '..', 'out');
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, 'rs_warm_2160p_hevc_60s.mp4');
  if (fs.existsSync(out)) return out;
  const pending = path.join(dir, 'rs_warm_2160p_hevc_60s.part.mp4');
  const boxes = ['drawbox=x=0:y=0:w=3840:h=216:color=black:t=fill'];
  for (let k = 0; k < 10; k++) boxes.push(`drawbox=x=${k * 384 + 32}:y=24:w=320:h=168:color=white:t=fill:enable='gt(bitand(n,${1 << k}),0)'`);
  const r = spawnSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=3840x2160:r=15:d=60', '-vf', boxes.join(','),
    '-c:v', 'libx265', '-preset', 'ultrafast', '-x265-params', 'keyint=50:min-keyint=50:bframes=3:open-gop=1:scenecut=0:log-level=error',
    '-pix_fmt', 'yuv420p', '-tag:v', 'hvc1', pending], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`making the warm-decoder clip: ${r.stderr}`);
  fs.renameSync(pending, out);
  return out;
}

/** The frame number drawn by makeWarmClip, read from a w x h luma thumbnail of the picture (-1: no band). */
function drawnFrame(y, w, h) {
  let n = 0;
  const row0 = Math.round(h * 0.03);
  const row1 = Math.round(h * 0.08);
  for (let k = 0; k < 10; k++) {
    const x0 = Math.round(((k * 384 + 96) / 3840) * w);
    const x1 = Math.round(((k * 384 + 288) / 3840) * w);
    let sum = 0;
    let count = 0;
    for (let row = row0; row < row1; row++) for (let x = x0; x < x1; x++) { sum += y[row * w + x]; count++; }
    if (sum / count > 128) n |= 1 << k;
  }
  return n;
}

/**
 * Whether `spans` ([from, to, ...] in time order: the page's packet cache, media/debug-probe.js state.packets) cover
 * [from, to] without a gap wider than `gap` (consecutive GOPs: the next keyframe a frame after the last frame).
 * @param {number[][] | undefined} spans @param {number} from @param {number} to @param {number} gap
 */
function covers(spans, from, to, gap) {
  let reach = -Infinity;
  for (const [a, b] of [...(spans || [])].sort((x, y) => x[0] - y[0])) {
    if (reach === -Infinity) { if (a > from + 1e-3) return false; reach = b; continue; }
    if (a > reach + gap) break;
    reach = Math.max(reach, b);
  }
  return reach >= to - 1e-3;
}

/**
 * The source's frames n-1, n, n+1 of `file` as luma (BT.709 limited range, like media/engine.js sharpThumb): scaled to
 * the stream's size as the host does (bilinear), cropped to the thumb's rectangle. Mean absolute difference of each to
 * the page's sharp frame, each with its mean removed (the page's colour conversion shifts the level a little).
 */
function whichFrame(ffmpeg, file, n, th) {
  const [W, H] = th.size;
  const r = spawnSync(ffmpeg, ['-v', 'error', '-i', file, '-vf',
    `select='between(n,${n - 1},${n + 1})',scale=${W}:${H}:flags=bilinear,crop=${th.w}:${th.h}:${th.x}:${th.y},format=gray`,
    '-fps_mode', 'passthrough', '-f', 'rawvideo', 'pipe:1'], { maxBuffer: 1 << 24, windowsHide: true });
  if (r.status !== 0) throw new Error(`reference frames: ${r.stderr}`);
  const y = Buffer.from(th.luma, 'base64');
  const k = th.w * th.h;
  const mad = [];
  const mean = (b) => { let m = 0; for (let i = 0; i < k; i++) m += b[i]; return m / k; };
  const my = mean(y);
  for (let f = 0; f < 3; f++) {
    const ref = r.stdout.subarray(f * k, (f + 1) * k);
    const mr = mean(ref);
    let d = 0;
    for (let i = 0; i < k; i++) d += Math.abs(y[i] - my - (ref[i] - mr));
    mad.push(Math.round((d / k) * 100) / 100);
  }
  if (r.stdout.length !== 3 * k) throw new Error(`reference frames: ${r.stdout.length} bytes for 3 x ${k}`);
  return mad; // [n-1, n, n+1]
}

/** Plays an open clip for `seconds` and checks it keeps time. Exported for test/vscode/remote_ssh.js. */
async function longChecks(vs, h, name, seconds) {
  const r = { ok: true, problems: [] };
  const bad = (m) => { r.ok = false; r.problems.push(m); };
  const m0 = vs.mark();
  const first = await report(vs, h, name);
  const w0 = Date.now();
  const samples = [];
  while (Date.now() - w0 < seconds * 1000) {
    await h.sleep(10000);
    const rep = await report(vs, h, name);
    samples.push({ wall: (Date.now() - w0) / 1000, t: rep.t - first.t, playing: rep.playing });
  }
  vs.mark();
  // Position vs wall clock: playback runs in real time (timer clock here: the hidden desktop's
  // AudioContext stays suspended), so a growing gap means stalls.
  const last = samples[samples.length - 1];
  r.positionVsWall = { wall: Math.round(last.wall), position: Math.round(last.t * 10) / 10, lagS: Math.round((last.wall - last.t) * 100) / 100 };
  if (samples.some((s) => !s.playing)) bad('stopped playing');
  if (last.wall - last.t > 1.5) bad(`position ${last.t.toFixed(1)} s after ${last.wall.toFixed(1)} s of playback`);
  // Picture and sound sent in step: the host's stats (every 2 s) give how far each was sent.
  const st = vs.lines.slice(m0).filter((l) => l.includes(`[${name}] remote stream stats:`))
    .map((l) => /sent to ([\d.]+) s video \/ ([\d.]+) s sound/.exec(l)).filter(Boolean).map((m) => Number(m[2]) - Number(m[1]));
  r.soundLeadS = st.length ? { n: st.length, min: Math.min(...st).toFixed(2), max: Math.max(...st).toFixed(2), last: st[st.length - 1].toFixed(2) } : null;
  if (!st.length) bad('no stats lines with sound');
  else if (st.some((d) => d < -0.5 || d > 2.1)) bad(`sound sent ${Math.min(...st).toFixed(2)}..${Math.max(...st).toFixed(2)} s ahead of the picture (want -0.5..2)`);
  r.ffmpegStarts = starts(vs, name, m0);
  if (r.ffmpegStarts) bad(`${r.ffmpegStarts} ffmpeg restarts while playing`);
  return r;
}

module.exports = [{
  name: 'remote_stream',
  ffmpeg: true,
  settings: { 'videoPreviewEnhanced.remoteStream': 'on', 'videoPreviewEnhanced.sizeFramesToView': false, 'workbench.editorAssociations': ASSOC },
  async run(vs, h) {
    const out = [];
    for (const file of CLIPS) {
      try {
        // Encoder probing plus a 4K software decode can wait behind other agents' CPU work.
        const r = await h.playClip(vs, { file, expect: 'webcodecs' }, {
          seconds: h.seconds, slow: true, firstFrameTimeout: file.includes('2160p') ? 120000 : 45000,
        });
        if (!/^remote stream/.test(r.decision || '')) { r.ok = false; r.problems.push(`decision: ${r.decision || 'none logged'}`); }
        const stats = vs.lines.filter((l) => l.includes(`[${file}] remote stream stats:`)).map((l) => l.replace(/^.*stats: /, ''));
        r.streamStats = stats.slice(-3);
        out.push({ name: file, ...r });
      } catch (e) { out.push({ name: file, ok: false, problems: [e.message] }); try { await h.closeClip(vs); } catch { /* gone */ } }
    }
    const enc = vs.lines.find((l) => l.includes('remote stream encoder on'));
    out.push({ name: 'encoder', ok: !!enc, problems: enc ? [] : ['no encoder probe line'], line: enc && enc.replace(/^.*remote stream encoder/, 'remote stream encoder') });
    // Seeks on 1080p HEVC 10-bit (24 fps).
    const name = 'hevc_10_1080p.mp4';
    try {
      const from = await h.openClip(vs, path.join(h.MEDIA, name));
      await vs.waitLog(new RegExp(`\\[${h.esc(name)}\\] webview: first frame shown`), { from, timeout: 45000 });
      await h.sleep(1500);
      // 20 targets in 0.15..1.67 s; all from memory.
      const targets = Array.from({ length: 20 }, (_, i) => 0.15 + ((i * 7) % 20) * 0.08);
      out.push({ name: 'seeks', ...(await seekChecks(vs, h, name, 24, targets, 0, 0)) });
    } catch (e) { out.push({ name: 'seeks', ok: false, problems: [e.message] }); }
    try { await h.closeClip(vs); } catch { /* gone */ }
    return out;
  },
}, {
  name: 'remote_stream_long',
  ffmpeg: true,
  settings: { 'videoPreviewEnhanced.remoteStream': 'on', 'videoPreviewEnhanced.loop': false, 'videoPreviewEnhanced.sizeFramesToView': false, 'workbench.editorAssociations': ASSOC },
  async run(vs, h) {
    const file = makeLongClip(h.ffmpeg);
    const name = path.basename(file);
    try {
      const from = await h.openClip(vs, file);
      await vs.waitLog(new RegExp(`\\[${h.esc(name)}\\] webview: first frame shown`), { from, timeout: 45000 });
      const dec = vs.lines.slice(from).find((l) => l.includes(`[${name}] decoder: `));
      // Layer 3 (h.scenario): the decision and the seeks; the 150 s soak (lag, sound lead) is layer 4 (test/perf).
      const r = h.scenario ? { ok: true, problems: [] } : await longChecks(vs, h, name, h.quick ? 60 : 150);
      r.decision = dec && dec.replace(/^.*?decoder: /, '');
      if (!/^remote stream/.test(r.decision || '')) { r.ok = false; r.problems.push(`decision: ${r.decision || 'none logged'}`); }
      // The test hook delivers commands in bunches (~300 ms apart): a start per bunch at most, plus the leading one.
      const s = await seekChecks(vs, h, name, 25, LONG_TARGETS, 8, 1);
      return [{ name: h.scenario ? 'decision' : name, ...r }, { name: 'seeks', ...s }];
    } catch (e) { return [{ name, ok: false, problems: [e.message] }]; } finally { try { await h.closeClip(vs); } catch { /* gone */ } }
  },
}, {
  name: 'remote_stream_size',
  ffmpeg: true,
  settings: { 'videoPreviewEnhanced.remoteStream': 'on', 'videoPreviewEnhanced.sizeFramesToView': true,
    'workbench.editorAssociations': ASSOC },
  async run(vs, h) {
    const { out, run } = lib.recorder();
    await run('size-to-picture', async (ok) => {
      const p = await lib.open(vs, h, path.join(h.MEDIA, 'hevc_10_2160p.mp4'));
      try {
        await p.waitState((s) => s.vmode === 'webcodecs' && s.firstShown);
        p.pause();
        // A large picture first: the hidden window's own picture (786 px wide) already fits 540p frames. Then a
        // position past the start, so each seek below goes back (a seek forward within decoded frames, or to the
        // frame already shown, does not ask the host and so applies no pending size).
        p.act({ action: 'stageSize', w: 1920, h: 1080 });
        await p.waitState((s) => !s.playing && s.canvas[1] === 1080, { what: '1080p frames for a 1920x1080 picture' });
        p.seek(1.5);
        const big = await p.waitState((s) => !s.playing && s.canvas[1] === 1080 && Math.abs(s.t - 1.5) < 0.1, { what: 'the frame at 1.5 s' });
        const from = vs.mark();
        p.act({ action: 'stageSize', w: 640, h: 360 });
        await vs.waitLog(/remote stream: picture .* -> 960x540 at the next seek/, { from });
        const kept = await p.state();
        ok(kept.canvas[1] === 1080 && Math.abs(kept.t - big.t) <= 1 / kept.fps, 'shrinking restarted the picture before a seek');
        p.seek(0.5);
        const small = await p.waitState((s) => !s.playing && s.canvas[1] === 540 && Math.abs(s.t - 0.5) < 0.1, { what: '540p frames at 0.5 s' });
        p.act({ action: 'stageSize', w: 1920, h: 1080 });
        const large = await p.waitState((s) => !s.playing && s.canvas[1] === 1080);
        ok(Math.abs(large.t - small.t) <= 1 / large.fps, 'enlarging moved the paused playhead');
        const shrink = vs.mark();
        p.act({ action: 'stageSize', w: 640, h: 360 });
        await vs.waitLog(/remote stream: picture .* -> 960x540 at the next seek/, { from: shrink });
        const held = await p.state();
        ok(held.canvas[1] === 1080, 'shrinking restarted the picture before a seek');
        p.seek(0);
        await p.waitState((s) => s.canvas[1] === 540 && s.t < 0.1, { what: '540p frames at the start' });
      } finally { await h.closeClip(vs); }
    });
    return out;
  },
}, {
  // The page keeps the H.264 packets it received (media/packet-cache.js): on a slow link, a paused seek back to a
  // place already seen and a step back across a keyframe decode from them, frame-exact, sending nothing over the link.
  // The same seeks with the cache off go to the host for comparison (times reported, not asserted).
  name: 'remote_stream_packets',
  ffmpeg: true,
  settings: { 'videoPreviewEnhanced.remoteStream': 'on', 'videoPreviewEnhanced.loop': false, 'videoPreviewEnhanced.sizeFramesToView': false, 'workbench.editorAssociations': ASSOC },
  async run(vs, h) {
    const { out, run } = lib.recorder();
    // Paused over a slow link (2 Mb/s): a seek the host serves shows a small first keyframe (fast first picture), and
    // once the page has rested on the frame for 150 ms the host sends that frame visually lossless, which replaces it
    // only while the page is still on it (media/engine.js requestSharp, src/stream.js sharp). Measured before (both
    // off) and after on fresh places; the sharp frame must be the frame shown, checked against the source's frames.
    // First in this case: no link estimate from an earlier clip in this session.
    await run('paused-sharp', async (ok, r) => {
      const file = makeLinkClip(h.ffmpeg);
      const p = await lib.open(vs, h, file);
      const fps = 25;
      const seekTo = async (sec) => {
        const frame = sec * fps;
        const s0 = await p.state();
        const from = vs.mark();
        const t0 = Date.now();
        p.seek(sec + 0.5 / fps);
        const s = await p.waitState((x) => !x.playing && x.frame === frame && x.gen > s0.gen, { timeout: 30000, interval: 50, what: `frame ${frame}` });
        const lines = vs.lines.slice(from).filter((l) => l.includes(`[${p.name}]`));
        const landed = lines.map((l) => /webview: seek landed in (\d+) ms \(gen (\d+)\)/.exec(l)).filter((x) => x && Number(x[2]) === s.gen);
        const start = lines.find((l) => /remote stream from /.test(l)) || '';
        const key = /first keyframe ~(\d+) KiB/.exec(start);
        return {
          frame, gen: s.gen, ms: Date.now() - t0, firstPictureMs: landed.length ? Number(landed[0][1]) : null, hostSeek: !!start,
          encoder: (/-> H\.264 \d+x\d+ \(([^,)]+)/.exec(start) || [])[1] || '', firstKeyKiB: key ? Number(key[1]) : 0,
          asked: s0.sharp ? s0.sharp.asked : 0, shown: s0.sharp ? s0.sharp.shown : 0,
        };
      };
      try {
        await p.waitState((s) => s.vmode === 'webcodecs' && s.firstShown);
        p.pause();
        // The picture at full size (the stream follows the view: the hidden window alone would make it ~786x442).
        p.act({ action: 'stageSize', w: 1920, h: 1080 });
        await h.sleep(1500);
        p.act({ action: 'remoteStreamRate', bytesPerSecond: 250000 }); // 2 Mb/s
        p.act({ action: 'pausedSharp', sharp: false, fastFirst: false });
        r.before = [];
        for (const sec of [20, 36]) {
          const x = await seekTo(sec);
          await h.sleep(1500);
          const s = await p.state();
          x.sharpShown = (s.sharp ? s.sharp.shown : 0) - x.shown;
          r.before.push(x);
        }
        ok(r.before.every((x) => x.hostSeek && x.sharpShown === 0 && x.firstKeyKiB === 0), `before: ${JSON.stringify(r.before)}`);
        p.act({ action: 'pausedSharp', sharp: true, fastFirst: true });
        r.after = [];
        for (const sec of [24, 44]) {
          const x = await seekTo(sec);
          // The sharp frame of this seek (its generation) and this frame: a late picture of the previous request does not count.
          const s = await p.waitState((y) => y.sharp && y.sharp.last && y.sharp.last.gen === x.gen && y.sharp.last.frame === x.frame
            && y.frame === x.frame && !y.sharp.pending, { timeout: 30000, interval: 50, what: `sharp frame ${x.frame} of gen ${x.gen}` });
          const last = s.sharp.last;
          Object.assign(x, { sharpFrame: last.frame, sharpKiB: Math.round(last.bytes / 1024), sharpAfterSeekMs: last.sinceSeekMs,
            sharpAskedToShownMs: last.ms, sharpLinkMs: last.linkMs, frameAfter: s.frame });
          const th = await p.ask('sharpThumb');
          // The thumbnail and the stats read apart must be the same sharp request (nothing is asked while paused here).
          ok(th.req === last.req && th.gen === last.gen, `the thumbnail is of request ${th.req} (gen ${th.gen}), the stats of ${last.req} (gen ${last.gen})`);
          x.mad = whichFrame(h.ffmpeg, file, x.frame, th); // to the source's frames n-1, n, n+1
          r.after.push(x);
          ok(x.hostSeek, `after: the seek to ${sec} s did not go to the host`);
          ok(last.frame === x.frame && s.frame === x.frame, `the sharp frame is ${last.frame}, shown ${s.frame}, asked ${x.frame}`);
          ok(x.mad[1] < x.mad[0] && x.mad[1] < x.mad[2], `the sharp picture is not frame ${x.frame} of the source: ${JSON.stringify(x.mad)}`);
        }
        // Rapid steps (40 ms apart) ask for nothing until the page rests: then one request, for the frame it rests on.
        {
          const s0 = await p.state();
          for (let i = 0; i < 6; i++) { p.step(1); await h.sleep(40); }
          const s = await p.waitState((y) => y.sharp && y.sharp.shown > s0.sharp.shown && !y.sharp.pending && y.sharp.last.frame === y.frame
            && y.sharp.last.gen === y.gen, { timeout: 30000, interval: 50, what: 'sharp after steps, of the frame rested on' });
          r.steps = { asked: s.sharp.asked - s0.sharp.asked, frame: s.frame, sharpFrame: s.sharp.last.frame, dropped: s.sharp.dropped - s0.sharp.dropped };
          ok(r.steps.sharpFrame === s.frame, `after the steps the sharp frame is ${r.steps.sharpFrame}, shown ${s.frame}`);
          ok(r.steps.asked <= 2, `steps 40 ms apart asked for ${r.steps.asked} sharp frames`);
        }
        const avg = (a, k) => Math.round(a.reduce((n, x) => n + x[k], 0) / a.length);
        r.summary = { firstPictureBeforeMs: avg(r.before, 'firstPictureMs'), firstPictureAfterMs: avg(r.after, 'firstPictureMs'),
          sharpAfterSeekMs: avg(r.after, 'sharpAfterSeekMs'), encoder: r.after[0] && r.after[0].encoder };
      } finally {
        p.act({ action: 'stageSize' });
        r.notes = vs.lines.filter((l) => l.includes(`[${p.name}]`) && /sharp frame|first keyframe|remote stream from /.test(l) && !/webview: state /.test(l))
          .map((l) => l.replace(/^.*\] /, '')).slice(-16);
        p.act({ action: 'remoteStreamRate', bytesPerSecond: 0 });
        await h.closeClip(vs);
      }
    });
    // The quick first picture (src/stream.js startQuick, media/engine.js onQuickFrame): over the same 2 Mb/s link, a
    // paused seek the host serves first shows the target frame at half the width and height, sent before the stream's
    // frames, then the stream's own frame. For any encoder (NVENC ignores the small first keyframe); here forced on
    // through the test hook, before = neither it nor x264's small first keyframe. Times from the page (not asserted:
    // this machine is shared); asserted: the quick picture shows, and the seek still lands on its exact frame after it.
    await run('paused-quick', async (ok, r) => {
      const file = makeLinkClip(h.ffmpeg);
      const p = await lib.open(vs, h, file);
      const fps = 25;
      const seekTo = async (sec) => {
        const frame = sec * fps;
        const s0 = await p.state();
        const from = vs.mark();
        p.seek(sec + 0.5 / fps);
        const s = await p.waitState((x) => !x.playing && x.frame === frame && x.gen > s0.gen, { timeout: 30000, interval: 50, what: `frame ${frame}` });
        const lines = vs.lines.slice(from).filter((l) => l.includes(`[${p.name}]`));
        const landed = lines.map((l) => /webview: seek landed in (\d+) ms \(gen (\d+)\)/.exec(l)).filter((x) => x && Number(x[2]) === s.gen);
        const start = lines.find((l) => /remote stream from /.test(l)) || '';
        const host = lines.map((l) => /quick picture at [\d.]+ s, (\d+x\d+), (\d+) KiB in (\d+) ms/.exec(l)).find(Boolean);
        const shownQuick = (s.quick ? s.quick.shown : 0) - (s0.quick ? s0.quick.shown : 0);
        const firstPictureMs = landed.length ? Number(landed[0][1]) : null;
        const quickMs = shownQuick && s.quick.last ? s.quick.last.sinceSeekMs : null;
        return {
          frame, shows: s.frame, firstPictureMs, quickMs, toFirstPictureMs: quickMs !== null ? Math.min(quickMs, firstPictureMs) : firstPictureMs,
          shownQuick, hostSeek: !!start, encoder: (/-> H\.264 \d+x\d+ \(([^,)]+)/.exec(start) || [])[1] || '',
          quickSize: host ? host[1] : '', quickKiB: host ? Number(host[2]) : 0, quickEncodeMs: host ? Number(host[3]) : null,
          canvas: s.canvas,
        };
      };
      try {
        await p.waitState((s) => s.vmode === 'webcodecs' && s.firstShown);
        p.pause();
        p.act({ action: 'stageSize', w: 1920, h: 1080 });
        await h.sleep(1500);
        p.act({ action: 'remoteStreamRate', bytesPerSecond: 250000 }); // 2 Mb/s
        p.act({ action: 'pausedSharp', sharp: false, fastFirst: false, quick: false });
        r.before = [];
        // Fresh places only: away from the resume position (the last clip ended near 44 s) and from each other.
        for (const sec of [8, 16, 28]) { r.before.push(await seekTo(sec)); await h.sleep(1200); }
        p.act({ action: 'pausedSharp', sharp: false, fastFirst: true, quick: true });
        r.after = [];
        for (const sec of [12, 24, 34]) { r.after.push(await seekTo(sec)); await h.sleep(1200); }
        for (const x of [...r.before, ...r.after]) {
          ok(x.hostSeek, `the seek to frame ${x.frame} did not go to the host`);
          ok(x.shows === x.frame, `the seek to frame ${x.frame} shows ${x.shows}`);
        }
        ok(r.before.every((x) => !x.shownQuick), `before: a quick picture showed (${JSON.stringify(r.before)})`);
        // On a loaded machine a quick encode can miss its wait (then the stream goes first): at least one must show,
        // and none after the seek's own frame.
        ok(r.after.some((x) => x.shownQuick === 1), `after: no quick picture showed (${JSON.stringify(r.after)})`);
        ok(r.after.every((x) => !x.shownQuick || x.quickMs < x.firstPictureMs), `after: a quick picture came after the stream's frame (${JSON.stringify(r.after)})`);
        // After the quick picture, the stream's own frame at full size.
        const last = r.after[r.after.length - 1];
        ok(last.canvas && last.canvas[0] === 1920 && last.canvas[1] === 1080, `the picture after the quick one is ${JSON.stringify(last.canvas)}`);
        const med = (a) => { const v = a.filter((x) => Number.isFinite(x)).sort((x, y) => x - y); return v.length ? v[v.length >> 1] : null; };
        r.summary = {
          encoder: r.after[0] && r.after[0].encoder,
          firstPictureBeforeMs: med(r.before.map((x) => x.firstPictureMs)), firstPictureAfterMs: med(r.after.map((x) => x.toFirstPictureMs)),
          streamFrameAfterMs: med(r.after.map((x) => x.firstPictureMs)), quickKiB: med(r.after.map((x) => x.quickKiB)),
          quickEncodeMs: med(r.after.map((x) => x.quickEncodeMs)),
        };
      } finally {
        p.act({ action: 'pausedSharp', quick: null });
        p.act({ action: 'remoteStreamRate', bytesPerSecond: 0 });
        // Leave the clip where paused-sharp left it (its resume position decides what the next opens read first).
        p.seek(44.64);
        await p.waitState((x) => !x.playing && x.frame === 1116, { timeout: 15000, interval: 100, what: 'frame 1116' }).catch(() => {});
        p.act({ action: 'stageSize' });
        r.notes = vs.lines.filter((l) => l.includes(`[${p.name}]`) && /quick picture|remote stream from /.test(l) && !/webview: state /.test(l))
          .map((l) => l.replace(/^.*\] /, '')).slice(-12);
        p.act({ action: 'remoteStreamRate', bytesPerSecond: 0 });
        await h.closeClip(vs);
      }
    });
    // Play after a paused seek served from the page's packets: the page keeps the sound it received too
    // (media/packet-cache.js addSound), so play starts with the picture and sound it holds while the host sends what
    // follows them (media/engine.js takeHeld, src/stream.js skipHeld). Page times from play to the picture moving and to
    // the sound playing, and where that sound starts; before = the held sound not used (test hook). Asserted: every
    // seek served from the page, the held sound offered and skipped by the host, sound from the play position.
    await run('play-cached-sound', async (ok, r) => {
      const file = makeLinkClip(h.ffmpeg, true);
      const p = await lib.open(vs, h, file);
      const fps = 25;
      const playFrom = async (sec) => {
        const frame = Math.round(sec * fps);
        let from = vs.mark();
        p.seek(sec + 0.5 / fps);
        await p.waitState((x) => !x.playing && x.frame === frame, { timeout: 30000, interval: 50, what: `frame ${frame}` });
        const local = vs.lines.slice(from).some((l) => l.includes(`[${p.name}] webview: seek to`) && l.includes("from the page's packets"));
        await h.sleep(600);
        from = vs.mark();
        p.play();
        const line = await vs.waitLog(new RegExp(`\\[${p.name}\\] webview: play from [\\d.]+ s: picture moving after \\d+ ms`), { from, timeout: 15000, what: 'play start' });
        const m = /picture moving after (\d+) ms(?:, sound ready after (\d+) ms)?(?:, no sound from the start)?(?:, heard after (\d+) ms from (-?[\d.]+) s past the start)?/.exec(line);
        await h.sleep(1000);
        const s = await p.state();
        p.pause();
        const lines = vs.lines.slice(from).filter((l) => l.includes(`[${p.name}]`));
        await h.sleep(400);
        return {
          frame, local, pictureMs: Number(m[1]), soundReadyMs: m[2] ? Number(m[2]) : null, soundMs: m[3] ? Number(m[3]) : null,
          soundFromS: m[4] ? Number(m[4]) : null,
          pageSound: lines.some((l) => /webview: seek to .* from the page and sound to/.test(l)),
          hostSkipped: lines.some((l) => /remote stream: the page holds /.test(l)),
          hostSkippedSound: lines.some((l) => /remote stream: the page holds .* and sound to/.test(l)),
          audioMaster: s.audioMaster, ac: s.ac, driftMs: s.drift === null ? null : Math.round(s.drift * 1000),
        };
      };
      try {
        await p.waitState((s) => s.vmode === 'webcodecs' && s.firstShown);
        p.pause();
        await h.sleep(1500);
        // Receive 4..10 s with sound: a paused seek there, then play until the page holds the picture and the sound of
        // that whole range (the places measured below lie in it).
        p.seek(4 + 0.5 / fps);
        await p.waitState((x) => !x.playing && x.frame === 100, { timeout: 30000, interval: 50, what: 'frame 100' });
        p.play();
        const held = await p.waitState((x) => !!x.packets && covers(x.packets.video, 4, 10, 1.5 / fps) && covers(x.packets.sound, 4, 10, 0.01),
          { timeout: 30000, interval: 100, what: 'the picture and sound of 4-10 s held by the page' });
        r.ac = held.ac;
        p.pause();
        await h.sleep(500);
        // Over a 2 Mb/s link (the host's sound takes its time there); backwards, so each seek is behind what was read.
        p.act({ action: 'remoteStreamRate', bytesPerSecond: 250000 });
        p.act({ action: 'packetCache', sound: false });
        r.before = [];
        for (const sec of [8.2, 6.6, 5]) r.before.push(await playFrom(sec));
        p.act({ action: 'packetCache', sound: true });
        // Past the places measured next, so the first of them is behind the playhead too.
        p.seek(9.6 + 0.5 / fps);
        await p.waitState((x) => !x.playing && x.frame === 240, { timeout: 30000, interval: 50, what: 'frame 240' });
        await h.sleep(600);
        r.after = [];
        for (const sec of [8.6, 7, 5.4]) r.after.push(await playFrom(sec));
        // The page path: the seek served from the page's packets and the host still holding that GOP (it skips the
        // packets the page offers: src/stream.js skipHeld). Otherwise the host restarts there and sends everything.
        // Each place was received whole before (the 6 s of play), so every seek is served from the page: a read of a
        // held GOP that the next seek cut off part way must not lose the frames it did not reach (packet-cache add).
        const paged = (a) => a.filter((x) => x.local && x.hostSkipped);
        ok(r.before.every((x) => !x.pageSound), 'before: the held sound was used');
        ok([...r.before, ...r.after].every((x) => x.local), `a seek was not served from the page's packets: ${JSON.stringify([...r.before, ...r.after])}`);
        ok(r.after.every((x) => !x.local || (x.hostSkipped && x.pageSound && x.hostSkippedSound)), `after: a play after a seek served from the page did not take the page path: ${JSON.stringify(r.after)}`);
        // Sound ready from the play position at once (the hidden desktop gives no user gesture, so the AudioContext
        // stays suspended and nothing is heard: where it is running, heard from the play position too).
        ok(paged(r.after).every((x) => x.soundReadyMs !== null && x.soundReadyMs < 300), `after: the sound was not ready at once: ${JSON.stringify(r.after)}`);
        const ran = r.after.filter((x) => x.ac === 'running');
        ok(ran.every((x) => x.soundFromS !== null && x.soundFromS < 0.1), `after: the sound started past the play position: ${JSON.stringify(ran)}`);
        const med = (a) => { const v = a.filter((x) => Number.isFinite(x)).sort((x, y) => x - y); return v.length ? v[v.length >> 1] : null; };
        const B = paged(r.before);
        const A = paged(r.after);
        r.summary = {
          pagePath: `${B.length}/${r.before.length} before, ${A.length}/${r.after.length} after`,
          pictureBeforeMs: med(B.map((x) => x.pictureMs)), pictureAfterMs: med(A.map((x) => x.pictureMs)),
          soundReadyBeforeMs: med(B.map((x) => x.soundReadyMs)), soundReadyAfterMs: med(A.map((x) => x.soundReadyMs)),
          soundBeforeMs: med(r.before.map((x) => x.soundMs)), soundAfterMs: med(r.after.map((x) => x.soundMs)),
          soundFromBeforeS: med(r.before.map((x) => x.soundFromS)), soundFromAfterS: med(r.after.map((x) => x.soundFromS)),
          driftBeforeMs: med(r.before.map((x) => x.driftMs)), driftAfterMs: med(r.after.map((x) => x.driftMs)),
        };
      } finally {
        p.act({ action: 'packetCache', sound: true });
        p.act({ action: 'remoteStreamRate', bytesPerSecond: 0 });
        r.notes = vs.lines.filter((l) => l.includes(`[${p.name}]`) && /play from|page holds|from the page/.test(l) && !/webview: state /.test(l))
          .map((l) => l.replace(/^.*\] /, '')).slice(-12);
        await h.closeClip(vs);
      }
    });
    await run('slow-link-seek-back', async (ok, r) => {
      const file = makeLinkClip(h.ffmpeg);
      const p = await lib.open(vs, h, file);
      const fps = 25;
      const timed = async (fn, frame, what) => {
        const t0 = Date.now();
        const from = vs.mark();
        fn();
        const s = await p.waitState((x) => !x.playing && x.frame === frame, { timeout: 30000, interval: 50, what });
        const local = vs.lines.slice(from).some((l) => l.includes(`[${p.name}] webview: seek to`) && l.includes("from the page's packets"));
        const memory = vs.lines.slice(from).some((l) => l.includes(`[${p.name}] webview: step back from memory`));
        const hostSeeks = vs.lines.slice(from).filter((l) => l.includes(`[${p.name}] remote stream`) && /seek to|remote stream from /.test(l)).length;
        // The page's own time from the seek to its frame decoded (the harness round trips add ~0.5 s to ms).
        const landed = vs.lines.slice(from).map((l) => /\] webview: seek landed in (\d+) ms/.exec(l)).filter(Boolean).map((x) => Number(x[1]));
        return { ms: Date.now() - t0, pageMs: landed.length ? landed[landed.length - 1] : 0, frame: s.frame, local, memory, hostSeeks };
      };
      try {
        await p.waitState((s) => s.vmode === 'webcodecs' && s.firstShown);
        p.pause();
        // Visit 10..~14 s (played: paused read-ahead fetches only about a second), then go far away.
        r.visit = await timed(() => p.seek(10.0 + 0.5 / fps), 250, 'frame 250');
        p.play();
        await h.sleep(4000);
        p.pause();
        await h.sleep(500);
        const fillFrom = vs.mark();
        r.away = await timed(() => p.seek(30.0 + 0.5 / fps), 750, 'frame 750');
        // Paused on a fresh jump: the host fills in the 2 s behind it (src/stream.js fill), so steps back stay on the
        // page even over the slow link. Its encode started paused: keyframes every 0.5 s.
        const filled = await vs.waitLog(new RegExp(`\\[${p.name}\\] webview: fill behind the paused frame: \\d+ frames`), { from: fillFrom, timeout: 15000, what: 'fill behind' }).catch(() => '');
        r.fill = filled.replace(/^.*webview: /, '');
        ok(!!filled, 'no fill behind the paused frame');
        p.act({ action: 'remoteStreamRate', bytesPerSecond: 250000 }); // 2 Mb/s
        r.stepsAfterJump = [];
        for (let i = 1; i <= 3; i++) r.stepsAfterJump.push(await timed(() => p.step(-1), 750 - i, `frame ${750 - i}`));
        ok(r.stepsAfterJump.every((x) => x.hostSeeks === 0), `a step back after the jump went to the host: ${JSON.stringify(r.stepsAfterJump)}`);
        // A fast scroll back over the 2 Mb/s link (a wheel): 30 steps 40 ms apart. Measured, not asserted: the fills
        // race the user here, and a slow link can fall behind.
        {
          const from = vs.mark();
          const t0 = Date.now();
          for (let i = 0; i < 30; i++) { p.step(-1); await h.sleep(40); }
          const s = await p.waitState((x) => !x.playing && x.frame === 717, { timeout: 30000, interval: 50, what: 'frame 717 after the scroll' }).catch(() => null);
          const lines = vs.lines.slice(from);
          r.scroll = {
            settledMs: Date.now() - t0, frame: s && s.frame,
            hostSeeks: lines.filter((l) => l.includes(`[${p.name}] remote stream`) && /seek to|remote stream from /.test(l)).length,
            fromPackets: lines.filter((l) => l.includes(`[${p.name}] webview: seek to`) && l.includes("from the page's packets")).length,
            fromMemory: lines.filter((l) => l.includes(`[${p.name}] webview: step back from memory`)).length,
            fills: lines.filter((l) => l.includes(`[${p.name}] webview: fill behind the paused frame:`) && /frames from/.test(l)).length,
          };
          ok(s !== null, 'the scroll back never settled on frame 717');
        }
        r.back = await timed(() => p.seek(11.0 + 0.5 / fps), 275, 'frame 275 (seek back)');
        ok(r.back.local, 'the seek back to a place already received went to the host');
        r.steps = [];
        for (let i = 1; i <= 3; i++) r.steps.push(await timed(() => p.step(-1), 275 - i, `frame ${275 - i}`));
        // The seek decoded its GOP up to the target: the frames before it are kept, steps back show them at once.
        ok(r.steps.every((x) => x.hostSeeks === 0), 'a step back went to the host');
        ok(r.steps.slice(1).some((x) => x.memory), 'no step back came from the decoded frames kept');
        // Across a keyframe: on frame 300 (a GOP's first frame when the stream started at 10 s), one back is 299.
        r.atKey = await timed(() => p.seek(12.0 + 0.5 / fps), 300, 'frame 300');
        r.acrossKey = await timed(() => p.step(-1), 299, 'frame 299');
        ok(r.acrossKey.local || r.acrossKey.hostSeeks === 0, 'the step back across a keyframe went to the host');
        // Play from there: the page offers the GOP it holds, the host (its history has it) sends only what follows.
        {
          const from = vs.mark();
          const t0 = Date.now();
          p.play();
          const s = await p.waitState((x) => x.playing && x.frame >= 310, { timeout: 30000, interval: 50, what: 'playing past 310' });
          const lines = vs.lines.slice(from);
          r.play = {
            ms: Date.now() - t0, frame: s.frame,
            pageHeld: lines.some((l) => l.includes(`[${p.name}] webview: seek to`) && l.includes('from the page, the host sends what follows')),
            hostSkipped: lines.some((l) => l.includes(`[${p.name}] remote stream: the page holds`)),
          };
          p.pause();
          await h.sleep(300);
          ok(r.play.pageHeld && r.play.hostSkipped, `play after the step back sent the held GOP again (${JSON.stringify(r.play)})`);
        }
        // The same seek back with the cache off: the host sends the GOP again over the 2 Mb/s link.
        p.act({ action: 'packetCache', mb: 0 });
        await timed(() => p.seek(30.0 + 0.5 / fps), 750, 'frame 750');
        // Over the 2 Mb/s link this seek takes seconds: the tile shows its loading spinner and the bar pulses until it lands.
        let spinner = null;
        const watch = (async () => {
          const t0 = Date.now();
          const s = await p.waitState((x) => x.loading > 0 && x.seekPulse, { timeout: 5000, interval: 30, what: 'loading spinner' }).catch(() => null);
          spinner = s ? Date.now() - t0 : null;
        })();
        r.backHost = await timed(() => p.seek(11.4 + 0.5 / fps), 285, 'frame 285 (seek back, no cache)');
        await watch;
        r.backHost.spinnerMs = spinner;
        ok(!r.backHost.local, 'the cache was off but served the seek');
        ok(spinner !== null, `no loading spinner during a ${r.backHost.ms} ms seek over the slow link`);
        const after = await p.waitState((x) => x.loading === 0 && !x.seekPulse, { timeout: 3000, interval: 30, what: 'spinner gone' }).catch(() => null);
        ok(after !== null, 'the spinner stayed after the seek landed');
      } finally {
        r.notes = vs.lines.filter((l) => l.includes(`[${p.name}]`) && /frames stay on the GPU|frame copy failed|step back from memory|page's packets/.test(l))
          .map((l) => l.replace(/^.*webview: /, '')).slice(-14);
        p.act({ action: 'remoteStreamRate', bytesPerSecond: 0 });
        await h.closeClip(vs);
      }
    });
    // The kept-running decoder (src/warm-decoder.js): paused jumps to places the host does not hold, on a 4K HEVC clip
    // (B-frames, open GOP, 50-frame GOPs), with ffmpeg started per jump (before) and fed by the warm process (after).
    // Page time from the seek to its frame decoded and the host's time to its first bytes are reported (not asserted:
    // this machine is shared); every landing must show the exact frame (its number is drawn in the picture).
    await run('warm-decoder', async (ok, r) => {
      const file = makeWarmClip(h.ffmpeg);
      const p = await lib.open(vs, h, file);
      const fps = 15;
      const jump = async (frame) => {
        const from = vs.mark();
        p.seek(frame / fps + 0.5 / fps);
        const s = await p.waitState((x) => !x.playing && x.frame === frame, { timeout: 30000, interval: 50, what: `frame ${frame}` });
        const lines = vs.lines.slice(from).filter((l) => l.includes(`[${p.name}]`));
        const landed = lines.map((l) => /webview: seek landed in (\d+) ms \(gen (\d+)\)/.exec(l)).filter((x) => x && Number(x[2]) === s.gen);
        const first = lines.map((l) => /live transcode: first bytes (\d+) ms after start( \(kept-running decoder\))?/.exec(l)).filter(Boolean).pop();
        const th = await p.ask('thumb', { w: 320, h: 180 });
        return {
          frame, pageMs: landed.length ? Number(landed[0][1]) : null, hostMs: first ? Number(first[1]) : null, warm: !!(first && first[2]),
          hostSeek: lines.some((l) => /remote stream from /.test(l)), shows: drawnFrame(Buffer.from(th.y, 'base64'), 320, 180),
        };
      };
      try {
        await p.waitState((s) => s.vmode === 'webcodecs' && s.firstShown, { timeout: 45000, what: 'first frame' });
        p.pause();
        p.act({ action: 'stageSize', w: 1920, h: 1080 });
        // Same conditions both times: no small first keyframe (it needs a fresh encoder), no sharp frame after landing.
        p.act({ action: 'pausedSharp', sharp: false, fastFirst: false });
        p.act({ action: 'warmDecoder', on: false });
        await h.sleep(1500);
        // Places 4 s apart, never visited before (the host holds about 2 s ahead of a jump, the page's fill 2 s behind
        // it), at different depths into their 50-frame GOPs. All past 14.8 s: a single video's stream keeps its size when
        // the stage grows (no restart), so what it read from the open (6 s and more) stays in the host's history.
        const before = [222, 342, 462, 582, 702, 822];
        const after = [282, 402, 522, 642, 762, 882];
        r.before = [];
        for (const f of before) { r.before.push(await jump(f)); await h.sleep(1500); }
        p.act({ action: 'warmDecoder', on: true });
        r.after = [];
        for (const f of after) { r.after.push(await jump(f)); await h.sleep(1500); }
        for (const x of [...r.before, ...r.after]) {
          ok(x.hostSeek, `the jump to frame ${x.frame} did not go to the host`);
          ok(x.shows === x.frame, `the jump to frame ${x.frame} shows frame ${x.shows}`);
        }
        ok(r.before.every((x) => !x.warm), 'before: a jump used the kept-running decoder');
        ok(r.after.every((x) => x.warm), `after: a jump started ffmpeg instead (${JSON.stringify(r.after.map((x) => x.warm))})`);
        const med = (a) => { const v = a.filter((x) => Number.isFinite(x)).sort((x, y) => x - y); return v.length ? v[v.length >> 1] : null; };
        // The first jump after turning it on starts the warm process (once per video); the median is over the rest.
        r.summary = {
          pageMsBefore: med(r.before.map((x) => x.pageMs)), pageMsAfter: med(r.after.slice(1).map((x) => x.pageMs)), pageMsAfterFirst: r.after[0].pageMs,
          hostMsBefore: med(r.before.map((x) => x.hostMs)), hostMsAfter: med(r.after.slice(1).map((x) => x.hostMs)), hostMsAfterFirst: r.after[0].hostMs,
        };
        const failed = vs.lines.find((l) => l.includes(`[${p.name}]`) && /kept-running decoder failed/.test(l));
        ok(!failed, `the kept-running decoder failed: ${failed}`);
      } finally {
        r.notes = vs.lines.filter((l) => l.includes(`[${p.name}]`) && /kept-running decoder|remote stream from /.test(l) && !/webview: state /.test(l))
          .map((l) => l.replace(/^.*\] /, '')).slice(-8);
        p.act({ action: 'warmDecoder' });
        p.act({ action: 'stageSize' });
        await h.closeClip(vs);
      }
    });
    return out;
  },
}, {
  // Play pressed while a paused seek is still on its way (slow link: the host's; or the page's own packets): the bar
  // keeps the seek's target and plays on from there. It never shows the frame still on screen from before the seek.
  name: 'remote_stream_play_during_seek',
  ffmpeg: true,
  settings: { 'videoPreviewEnhanced.remoteStream': 'on', 'videoPreviewEnhanced.loop': false, 'videoPreviewEnhanced.sizeFramesToView': false, 'workbench.editorAssociations': ASSOC },
  async run(vs, h) {
    const { out, run } = lib.recorder();
    await run('bar-keeps-target', async (ok, r) => {
      const file = makeLinkClip(h.ffmpeg);
      const p = await lib.open(vs, h, file);
      const fps = 25;
      const barSec = (s) => {
        const m = /(\d+):(\d+(?:\.\d+)?)/.exec(s.timeText || '');
        return m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
      };
      /** Bar times while playing for `ms` after play was pressed during the seek to `target` s. */
      const sampleAfterPlay = async (target, ms) => {
        const t0 = Date.now();
        const seen = [];
        while (Date.now() - t0 < ms) { seen.push(Number(barSec(await p.state()).toFixed(3))); await h.sleep(60); }
        return { min: Math.min(...seen), max: Math.max(...seen), n: seen.length, below: seen.filter((x) => x < target - 0.5) };
      };
      try {
        await p.waitState((s) => s.vmode === 'webcodecs' && s.firstShown);
        p.pause();
        // Receive 10..14 s (the page keeps those packets), then stand far away at 30 s.
        p.seek(10.0 + 0.5 / fps);
        await p.waitState((s) => !s.playing && s.frame === 250, { timeout: 30000 });
        p.play();
        await p.waitState((s) => !!s.packets && covers(s.packets.video, 10, 14, 1.5 / fps),
          { timeout: 30000, interval: 100, what: 'the packets of 10-14 s held by the page' });
        p.pause();
        p.seek(30.0 + 0.5 / fps);
        await p.waitState((s) => !s.playing && s.frame === 750, { timeout: 30000 });
        // (a) The host's seek over a 2 Mb/s link: play pressed while it loads.
        p.act({ action: 'remoteStreamRate', bytesPerSecond: 250000 });
        const g0 = (await p.state()).gen;
        p.seek(45.0 + 0.5 / fps);
        // Play while that seek is still loading (its target pending), not after a fixed wait.
        await p.waitState((s) => s.gen > g0 && s.seekPending, { timeout: 15000, interval: 20, what: 'the seek to 45 s under way' });
        p.play();
        r.host = await sampleAfterPlay(45, 2500);
        ok(r.host.below.length === 0, `play during the host's seek: the bar went back before 45 s (${JSON.stringify(r.host)})`);
        p.pause();
        p.act({ action: 'remoteStreamRate', bytesPerSecond: 0 });
        await h.sleep(500);
        p.seek(30.0 + 0.5 / fps);
        await p.waitState((s) => !s.playing && s.frame === 750, { timeout: 30000 });
        // (b) A seek served from the page's packets, play pressed at once (the decode is still running).
        p.seek(11.0 + 0.5 / fps);
        p.play();
        r.local = await sampleAfterPlay(11, 2000);
        ok(r.local.below.length === 0 && r.local.max < 20, `play during a seek from the page's packets: the bar left 11 s (${JSON.stringify(r.local)})`);
        p.pause();
      } finally {
        // A seek that does not land (seen intermittently): the host's and the page's account of it.
        {
          r.log = vs.lines.filter((l) => l.includes(`[${p.name}]`) && /seek|remote stream|live transcode|landed|warm|quick|fill|sharp|batch|first bytes/.test(l))
            .slice(-80).map((l) => l.replace(/^\S+ /, '').slice(0, 260));
        }
        p.act({ action: 'remoteStreamRate', bytesPerSecond: 0 });
        await h.closeClip(vs);
      }
    });
    return out;
  },
}, {
  // HDR over Live transcode: tone-mapped on the host; on an NVIDIA host NVDEC decodes and scales before the tone-mapper
  // (src/transcode_args.js cudaDecodeDownload), also when the encoder is the CPU one. Seeks and a step land exactly.
  name: 'remote_stream_hdr',
  ffmpeg: true,
  settings: { 'videoPreviewEnhanced.remoteStream': 'on', 'videoPreviewEnhanced.loop': false, 'videoPreviewEnhanced.sizeFramesToView': false, 'workbench.editorAssociations': ASSOC },
  async run(vs, h) {
    const { out, run } = lib.recorder();
    await run('hdr-seek-step', async (ok, r) => {
      const from = vs.mark();
      const p = await lib.open(vs, h, path.join(h.MEDIA, 'hevc_10_pq_2160p.mp4'));
      try {
        await p.waitState((s) => s.vmode === 'webcodecs' && s.firstShown, { timeout: 45000, what: 'first frame' });
        p.pause();
        const at = async (fn, frame) => {
          const t0 = Date.now();
          fn();
          const s = await p.waitState((x) => !x.playing && x.frame === frame, { timeout: 30000, interval: 50, what: `frame ${frame}` });
          return { ms: Date.now() - t0, frame: s.frame };
        };
        r.seek = await at(() => p.seek(40.5 / 30), 40); // 30 fps, 60 frames
        r.step = await at(() => p.step(-1), 39);
        const starts = vs.lines.slice(from).filter((l) => l.includes(`[${p.name}] remote stream from`)).map((l) => l.replace(/^.*remote stream /, ''));
        r.pipeline = starts.slice(-1)[0] || '';
        ok(starts.length > 0, 'no Live transcode start logged');
        ok(/tone-mapping/.test(r.pipeline), `HDR not tone-mapped on the host: ${r.pipeline}`);
        r.gpuDecode = /GPU decode/.test(r.pipeline);
      } finally {
        await h.closeClip(vs);
      }
    });
    return out;
  },
}, {
  name: 'remote_stream_fallback',
  ffmpeg: true,
  env: { VPE_RS_ENCODER: 'libx264', VPE_SAVE_DIR: SAVE_DIR },
  settings: { 'videoPreviewEnhanced.remoteStream': 'on', 'videoPreviewEnhanced.loop': false, 'videoPreviewEnhanced.advancedMode': true, 'videoPreviewEnhanced.sizeFramesToView': false, 'workbench.editorAssociations': ASSOC },
  async run(vs, h) {
    const { out, run } = lib.recorder();
    await run('pixel-tools', async (ok) => {
      const p = await lib.open(vs, h, path.join(h.MEDIA, 'hevc_10_2160p.mp4'));
      try {
        await p.waitState((s) => s.vmode === 'webcodecs' && s.firstShown && s.canvas[1] === 1080);
        p.pause();
        const from = vs.mark();
        p.key('x');
        // Live transcode stays on: the inspector reads one exact full-resolution frame from the host (docs/PRODUCT.md).
        await vs.waitLog(new RegExp(`\\[${p.name}\\] webview: exact frame 3840x2160 for frame`), { from, timeout: 20000 });
        const s = await p.state();
        ok(s.vmode === 'webcodecs' && s.canvas[1] === 1080, `left Live transcode: ${s.vmode} ${s.canvas}`);
        const click = await p.ask('click', { sel: '#notice:not([hidden]) #noticeAction', text: 'Use full resolution' });
        ok(!click.found, 'the inspector still offers full resolution under Live transcode');
        // The scopes alone (inspector off) on the next frame: they ask for its exact frame too (docs/PRODUCT.md).
        p.key('x');
        p.key('.');
        const from2 = vs.mark();
        p.key('w');
        await vs.waitLog(new RegExp(`\\[${p.name}\\] webview: exact frame 3840x2160 for frame`), { from: from2, timeout: 20000, what: 'the exact frame for the scopes' });
        const sc = await p.ask('scopesDump');
        ok(sc.mode === 'waveform', `scopes open: ${sc.mode}`);
        ok(!(await p.ask('click', { sel: '#notice:not([hidden]) #noticeAction', text: 'Use full resolution' })).found,
          'the scopes still offer full resolution under Live transcode');
        p.key('w'); p.key('w'); p.key('w'); p.key('w'); // back to off
        // Save Frame as PNG: the exact full-resolution frame, not the 1080p transcoded picture.
        for (const f of fs.readdirSync(SAVE_DIR)) fs.rmSync(path.join(SAVE_DIR, f), { force: true });
        p.key('s');
        const t0 = Date.now();
        let png = null;
        while (!png && Date.now() - t0 < 20000) {
          await h.sleep(200);
          const f = fs.readdirSync(SAVE_DIR).find((x) => x.endsWith('.png'));
          if (f && fs.statSync(path.join(SAVE_DIR, f)).size > 1000) png = path.join(SAVE_DIR, f);
        }
        ok(!!png, `no PNG saved (${fs.readdirSync(SAVE_DIR)})`);
        if (png) ok(pngSize(png).join('x') === '3840x2160', `Save Frame wrote ${pngSize(png).join('x')}, not the exact 3840x2160 frame`);
      } finally { await h.closeClip(vs); }
    });
    await run('ffmpeg-exit', async (ok) => {
      const file = makeLongClip(h.ffmpeg);
      const p = await lib.open(vs, h, file);
      try {
        await p.waitState((s) => s.vmode === 'webcodecs' && s.firstShown);
        const from = vs.mark();
        p.act({ action: 'remoteStreamKill' });
        // The hook kills ffmpeg with SIGKILL since fb6d612 (as the extension does: SIGTERM doesn't stop one blocked on a pipe on Linux).
        await vs.waitLog(/remote stream failed \(signal SIG(KILL|TERM)\b.*\); using the built-in decoder/, { from });
        const s = await p.waitState((s) => s.vmode === 'soft' && s.firstShown && s.playing);
        ok(s.canvas[1] === 360, `built-in decoder canvas: ${s.canvas}`);
        ok(starts(vs, p.name, from) === 0, 'stream was retried after the failure');
      } finally { await h.closeClip(vs); }
    });
    await run('slow-link', async (ok, r) => {
      const file = makeLinkClip(h.ffmpeg);
      const p = await lib.open(vs, h, file);
      try {
        const first = await p.waitState((s) => s.playing && s.vmode === 'webcodecs' && s.firstShown && s.canvas[1] === 1080);
        p.act({ action: 'remoteStreamRate', bytesPerSecond: 550000 });
        const reduced = await p.waitState((s) => s.playing && s.canvas[1] === 720, { timeout: 18000, what: 'a 720p frame' });
        ok(reduced.gen === first.gen && reduced.t > first.t, 'quality drop interrupted the playback timeline');
        // The capped profile fits this link. Leave the throttle in place long enough to catch oscillation.
        await h.sleep(4500);
        const steady = await p.state();
        // Stays at 720p and keeps playing (no oscillation, no stall); keeping exact time is a number for layer 4.
        ok(steady.playing && steady.canvas[1] === 720 && steady.frame - reduced.frame >= 1 * steady.fps, `720p did not keep playing on the throttled link: ${steady.frame - reduced.frame} frames in 4.5 s at ${steady.canvas[1]}p`);
        p.act({ action: 'remoteStreamRate', bytesPerSecond: 0 });
        const restored = await p.waitState((s) => s.playing && s.canvas[1] === 1080, { timeout: 35000, what: 'full quality after link recovery' });
        ok(restored.gen === first.gen && restored.t > reduced.t, 'quality recovery interrupted the playback timeline');
        // Too slow even for the lowest quality: stay there and say so; never the built-in decoder (review 7 #3, #5).
        p.act({ action: 'remoteStreamRate', bytesPerSecond: 12000 });
        const from = vs.mark();
        // At 96 kb/s the 1080p data already in flight takes longer than this to drain, so check the decision, not a 360p frame.
        await vs.waitLog(/remote stream: the link can't carry the lowest quality \(.*\); staying at 360p/, { from, timeout: 45000 });
        await h.sleep(5000);
        const floor = await p.state();
        ok(floor.vmode === 'webcodecs', `left the remote stream at the floor: ${floor.vmode}`);
        ok(!vs.lines.slice(from).some((l) => l.includes(`[${p.name}] remote stream failed`)), 'link speed made the stream fail over');
      } finally {
        r.quality = vs.lines.filter((l) => l.includes(`[${p.name}] remote stream: quality`)).map((l) => l.split('remote stream: ')[1]);
        await h.closeClip(vs);
      }
    });
    await run('slow-link-sound', async (ok, r) => {
      // Opus lets a 1.6 Mb/s link carry 480p with sound (1.2 Mb/s video + 0.128 Mb/s audio budget).
      const file = makeLinkClip(h.ffmpeg, true);
      const p = await lib.open(vs, h, file);
      try {
        const first = await p.waitState((s) => s.playing && s.vmode === 'webcodecs' && s.firstShown && s.canvas[1] === 1080);
        p.act({ action: 'remoteStreamRate', bytesPerSecond: 200000 });
        const reduced = await p.waitState((s) => s.playing && s.canvas[1] < 1080, { timeout: 20000, what: 'a lower-quality frame' });
        ok(reduced.canvas[1] === 480, `stepped to ${reduced.canvas[1]}p, expected 480p`);
        ok(reduced.gen === first.gen && reduced.t > first.t, 'quality drop interrupted the playback timeline');
        await h.sleep(5000);
        const steady = await p.state();
        ok(steady.playing && steady.vmode === 'webcodecs' && steady.frame - reduced.frame >= 1 * steady.fps, `480p with sound did not keep playing: ${steady.frame - reduced.frame} frames in 5 s`);
        // A 0.7 Mb/s link can still carry the lowest tier with compressed sound.
        const from = vs.mark();
        p.act({ action: 'remoteStreamRate', bytesPerSecond: 87500 });
        const floor = await p.waitState((s) => s.canvas[1] === 360 || s.vmode !== 'webcodecs', { timeout: 30000, what: 'a 360p frame' });
        ok(floor.vmode === 'webcodecs' && floor.canvas[1] === 360, `at the floor: ${floor.vmode} ${floor.canvas}`);
        ok(!vs.lines.slice(from).some((l) => l.includes("link can't carry the lowest quality with its sound")), 'Opus floor did not fit 0.7 Mb/s');
        ok(vs.lines.some((l) => l.includes(`[${p.name}] webview: remote sound: Opus decoded`)), 'no WebAssembly Opus output');
        ok(!vs.lines.slice(from).some((l) => l.includes(`[${p.name}] remote stream failed`)), 'link speed made the stream fail over');
      } finally {
        r.quality = vs.lines.filter((l) => l.includes(`[${p.name}] remote stream: quality`)).map((l) => l.split('remote stream: ')[1]);
        await h.closeClip(vs);
      }
    });
    return out;
  },
}];

module.exports.seekChecks = seekChecks;
module.exports.longChecks = longChecks;
module.exports.makeLongClip = makeLongClip;
module.exports.LONG_TARGETS = LONG_TARGETS;
