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
  name: 'remote_stream_fallback',
  ffmpeg: true,
  env: { VPE_RS_ENCODER: 'libx264' },
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
