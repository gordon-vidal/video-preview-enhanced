'use strict';
// node test/run.js unit --grep warm_decoder: Live transcode's kept-running decoder (src/warm-decoder.js) and how the
// stream uses it (src/stream.js warmSegment): which sources qualify, the remux's time mapping, the MPEG-TS feed (whole
// frames, continuity counters, the end-of-sequence NAL before each jump) and output (frames by PES), a segment's
// checks (frame sequence, IDR first), the idle end, the GPU session, the stream's fallback to ffmpeg per seek; with
// ffmpeg on PATH, generated H.264 and HEVC clips with B-frames (HEVC: open GOP) land on the exact frame after every jump.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const { spawn, spawnSync } = require('child_process');
const W = require('../../src/warm-decoder');
const { EncodedStream } = require('../../src/stream');
const { createGpuSessions } = require('../../src/gpu-sessions');

const PROBED = (over = {}) => ({
  duration: 60, audio: null, formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
  video: { index: 0, codec: 'hevc', pixFmt: 'yuv420p10le', width: 1920, height: 1080, fps: 25, cfr: true, fileStart: 0, startTime: 0, fieldOrder: 'progressive', ...over },
});

{ // Which sources qualify.
  assert.strictEqual(W.warmSourceRefusal(PROBED()), '');
  assert.strictEqual(W.warmSourceRefusal({ ...PROBED(), formatName: 'matroska,webm' }), '');
  assert.match(W.warmSourceRefusal(PROBED({ codec: 'vp9' })), /codec vp9/, 'no VP9 / AV1 / ProRes in MPEG-TS');
  assert.match(W.warmSourceRefusal({ ...PROBED(), formatName: 'avi' }), /container/, 'AVI packets carry no times');
  assert.match(W.warmSourceRefusal(PROBED({ cfr: false })), /variable/);
  assert.match(W.warmSourceRefusal(PROBED({ cfr: undefined })), /variable/, 'an older probe record: no');
  assert.match(W.warmSourceRefusal(PROBED({ fieldOrder: 'tt' })), /interlaced/);
  assert.match(W.warmSourceRefusal(PROBED({ fileStart: null })), /start/);
  assert.strictEqual(W.warmSourceRefusal(PROBED({ fileStart: 1.4, startTime: 1.48 })), '', 'two frames after the file start: on the grid');
  assert.match(W.warmSourceRefusal(PROBED({ fileStart: 0, startTime: 0.02 })), /grid/, 'half a frame off');
}

{ // The remux: from the keyframe at or before a quarter frame past the target, copied, times onto the warm clock.
  const a = W.remuxArgs({ file: 'in.mp4', streamIndex: 1, t: 12, fps: 25, fileStart: 0.5, S: 600 });
  assert.strictEqual(a[a.indexOf('-ss') + 1], '12.0100');
  assert.ok(a.includes('-copyts') && a[a.indexOf('-c') + 1] === 'copy' && a[a.indexOf('-map') + 1] === '0:1');
  const bsf = a[a.indexOf('-bsf:v') + 1];
  assert.match(bsf, /^setts=pts=.*:dts=/);
  assert.ok(bsf.includes('12.500000'), 'the target is the file start + t');
  assert.ok(!/[^\\],/.test(bsf.replace(/^setts=/, '')), 'every comma in the expressions is escaped');
  // The mapping itself (the expression, evaluated here): before the target half a frame off the grid, from it exact.
  const map = (P) => { const k = (P - 12.5) * 25; const r = Math.round(k); return 600 + (r < 0 ? r - 0.5 : k) / 25; };
  assert.strictEqual(map(12.5), 600);
  assert.strictEqual(map(12.54), 600.04);
  assert.strictEqual(map(12.46), 600 - 1.5 / 25);
  const onGrid = (x) => Math.abs(x * 25 - Math.round(x * 25)) < 0.25;
  assert.ok(onGrid(map(12.5)) && onGrid(map(12.5 + 13 / 25)) && !onGrid(map(12.46)) && !onGrid(map(10)));
  for (let i = 1; i < 200; i++) assert.ok(map(12.5 + (i - 100) / 25) > map(12.5 + (i - 101) / 25), 'monotonic: decode times stay in order');
  assert.match(W.warmSelect(25), /^select='lt\(abs\(t\*25-round\(t\*25\)\)\\,0\.25\)'$/);
  assert.deepStrictEqual(W.warmKeyArgs('libx264', 0.5, 25).slice(0, 1), ['-force_key_frames']);
  assert.ok(W.warmKeyArgs('h264_nvenc', 0.5, 25).includes('-forced-idr'), 'NVENC: forced keyframes as IDRs');
}

// ---- MPEG-TS helpers --------------------------------------------------------------------------------------------
/** A TS packet; pes: { pts } starts a video PES. */
function tsPacket(pid, { pes = null, payload = 0x11, cc = 0, len = 0 } = {}) {
  const b = Buffer.alloc(188, payload);
  b[0] = 0x47; b[1] = (pes ? 0x40 : 0) | ((pid >> 8) & 31); b[2] = pid & 255; b[3] = 0x10 | cc;
  if (pes) {
    const p = Math.round(pes.pts * 90000);
    const hi = Math.floor(p / 2 ** 30) & 7;
    const lo = p % 2 ** 30;
    Buffer.from([0, 0, 1, 0xe0, (len >> 8) & 255, len & 255, 0x80, 0x80, 5,
      0x21 | (hi << 1), (lo >> 22) & 255, ((lo >> 14) & 254) | 1, (lo >> 7) & 255, ((lo << 1) & 254) | 1]).copy(b, 4);
  }
  return b;
}
const packets = (buf) => Array.from({ length: buf.length / 188 }, (_, i) => buf.subarray(i * 188, i * 188 + 188));

{ // The feed: a video PES goes in only once the next begins, counters run on across segments, EOS before a jump.
  const cc = new Map();
  const f1 = new W.TsFeed({ cc, codec: 'hevc', eos: false, S: 600, fps: 25 });
  let out = f1.push(Buffer.concat([tsPacket(0), tsPacket(0x100, { pes: { pts: 599.92 } }), tsPacket(0x100)]));
  assert.strictEqual(out.length, 188, 'PAT now; the frame waits for its end');
  out = f1.push(tsPacket(0x100, { pes: { pts: 600 } }).subarray(0, 100));
  assert.strictEqual(out.length, 0, 'half a packet waits');
  out = f1.push(tsPacket(0x100, { pes: { pts: 600 } }).subarray(100));
  assert.strictEqual(out.length, 2 * 188, 'the first frame (2 packets) once the second begins');
  assert.strictEqual(f1.post, 1, 'one frame at or after the target fed');
  assert.ok(Math.abs(f1.maxPts - 600) < 1e-6 && Math.abs(f1.firstPts - 599.92) < 1e-6);
  out = f1.end();
  assert.strictEqual(out.length, 188, 'the end: the last frame');
  // A second segment on the same process: the PAT and video counters go on from where they were, EOS first.
  const f2 = new W.TsFeed({ cc, codec: 'hevc', eos: true, S: 700, fps: 25 });
  out = f2.push(Buffer.concat([tsPacket(0, { cc: 0 }), tsPacket(0x100, { pes: { pts: 699 }, cc: 0 }), tsPacket(0x100, { pes: { pts: 699.04 }, cc: 1 })]));
  const ps = packets(out);
  assert.strictEqual(ps.length, 3, 'PAT, EOS, the first frame');
  assert.strictEqual(ps[0][3] & 15, 1, 'PAT counter continues (0 -> 1)');
  const eos = ps[1];
  assert.strictEqual(((eos[1] & 31) << 8) | eos[2], 0x100);
  assert.strictEqual(eos[3] & 15, 3, 'video counter continues (0-2 sent before)');
  const q = 5 + eos[4];
  assert.deepStrictEqual([...eos.subarray(q, q + 4)], [0, 0, 1, 0xe0]);
  assert.strictEqual(eos[q + 7], 0x80, 'PTS only');
  assert.ok(Math.abs(W.readPts(eos, q + 9) - 699) < 1e-4, 'timed like the frame after it');
  assert.deepStrictEqual([...eos.subarray(q + 14, q + 20)], [0, 0, 0, 1, 0x48, 0x01], 'HEVC end of sequence');
  assert.strictEqual(ps[2][3] & 15, 4);
  const h = W.eosPacket(0x100, 'h264', Buffer.from([0x31, 0, 1, 0, 1]));
  assert.deepStrictEqual([...h.subarray(183)], [0, 0, 0, 1, 0x0a], 'H.264 end of sequence');
  assert.strictEqual(h[188 - 19 + 9], 0x21, 'PTS-only marker bits');
}

{ // The output: frames by PES, complete at their length or when the next begins.
  const r = new W.TsFrames();
  const withLen = tsPacket(0x100, { pes: { pts: 600 }, len: 3 + 5 + 20 });
  let done = r.push(withLen);
  assert.strictEqual(done.length, 1, 'its length reached: complete at once');
  assert.strictEqual(done[0].data.length, 20);
  assert.ok(Math.abs(done[0].pts - 600) < 1e-6);
  done = r.push(Buffer.concat([tsPacket(0x100, { pes: { pts: 600.04 } }), tsPacket(0x100), tsPacket(0x1000)]));
  assert.strictEqual(done.length, 0, 'no length: waits for the next frame');
  done = r.push(tsPacket(0x100, { pes: { pts: 600.08 } }));
  assert.strictEqual(done.length, 1);
  assert.strictEqual(done[0].data.length, 188 - 4 - 14 + 188 - 4);
  assert.strictEqual(r.end().length, 1, 'the last one at the end');
  const idr = Buffer.from([0, 0, 0, 1, 9, 0xf0, 0, 0, 0, 1, 0x67, 1, 0, 0, 0, 1, 0x68, 1, 0, 0, 1, 0x65, 0x88]);
  assert.ok(W.startsDecoder(idr));
  assert.ok(!W.startsDecoder(Buffer.from([0, 0, 0, 1, 0x65, 0x88])), 'an IDR without SPS/PPS');
  assert.ok(!W.startsDecoder(Buffer.from([0, 0, 0, 1, 0x67, 1, 0, 0, 1, 0x68, 1, 0, 0, 1, 0x41, 1])), 'a P-frame');
}

// ---- WarmDecoder with fake processes ----------------------------------------------------------------------------
function fakeProc(argv) {
  const p = new EventEmitter();
  Object.assign(p, { argv, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, signalCode: null, pid: 1 });
  p.kill = (sig) => { if (p.exitCode !== null || p.signalCode) return; p.signalCode = sig; setImmediate(() => p.emit('close', null, sig)); };
  p.exit = (code) => { p.exitCode = code; setImmediate(() => p.emit('close', code, null)); };
  return p;
}
/** One encoded frame as the warm process writes it: a video PES with its length. */
function outFrame(pts, key) {
  const au = key ? [0, 0, 0, 1, 9, 0xf0, 0, 0, 0, 1, 0x67, 1, 0, 0, 0, 1, 0x68, 1, 0, 0, 1, 0x65, 0x88] : [0, 0, 0, 1, 9, 0xf0, 0, 0, 1, 0x41, 1];
  const b = tsPacket(0x100, { pes: { pts }, len: 3 + 5 + au.length });
  Buffer.from(au).copy(b, 18);
  return b;
}
const tick = () => new Promise((r) => setImmediate(r));

(async () => {
  { // Segments: frames of an older jump are dropped, the sequence is checked, the idle end, one release.
    const procs = [];
    let released = 0;
    let ended = '';
    const dec = new W.WarmDecoder({ ffmpeg: 'ffmpeg', argv: ['warm'], key: 'k', file: 'in.mp4', streamIndex: 0, fps: 25, fileStart: 0,
      duration: 60, codec: 'hevc', spawn: (cmd, a) => { const p = fakeProc(a); procs.push(p); return p; },
      release: () => { released++; }, onEnd: (why) => { ended = why; }, idleMs: 50 });
    const warm = procs[0];
    const s1 = dec.segment(10);
    assert.strictEqual(s1.S, W.firstS(25));
    assert.strictEqual(W.firstS(25), W.FIRST_S, '600 s is on the 25 fps grid');
    assert.strictEqual(procs.length, 2, 'a remux for the jump');
    assert.strictEqual(procs[1].argv[procs[1].argv.indexOf('-ss') + 1], '10.0100');
    const got = [];
    s1.stdout.on('data', (d) => got.push(d));
    // The remux feeds a frame up to 601: the next segment starts past it.
    procs[1].stdout.write(Buffer.concat([tsPacket(0x100, { pes: { pts: 600 } }), tsPacket(0x100, { pes: { pts: 601 } })]));
    await tick();
    warm.stdout.write(Buffer.concat([outFrame(600, true), outFrame(600.04, false)]));
    await tick();
    assert.strictEqual(got.length, 2, 'two frames, one access unit per data event');
    assert.ok(s1.firstMs >= 0);
    // Paused (the stream holds enough): the remux stops, frames still coming out wait.
    s1.stdout.pause();
    assert.ok(procs[1].stdout.isPaused());
    warm.stdout.write(outFrame(600.08, false));
    await tick();
    assert.strictEqual(got.length, 2);
    s1.stdout.resume();
    assert.strictEqual(got.length, 3);
    // A jump: the old segment ends (its remux killed), the new one starts past everything fed.
    s1.kill();
    assert.strictEqual(procs[1].signalCode, 'SIGKILL');
    const s2 = dec.segment(30);
    assert.ok(s2.S >= 601 + W.GAP_S && Math.abs(s2.S * 25 - Math.round(s2.S * 25)) < 1e-6, `S ${s2.S} on the grid past 601`);
    const got2 = [];
    s2.stdout.on('data', (d) => got2.push(d));
    warm.stdout.write(Buffer.concat([outFrame(600.12, false), outFrame(s2.S, true)]));
    await tick();
    assert.strictEqual(got2.length, 1, 'the old jump\'s frame is dropped');
    // A frame out of sequence fails the segment.
    const closed = new Promise((r) => s2.once('close', (code) => r(code)));
    warm.stdout.write(outFrame(s2.S + 2 / 25, false));
    assert.strictEqual(await closed, 1);
    assert.match(s2.err.text, /came out as 2\.00/);
    // Nothing running: the process ends after its idle time, the session goes back once.
    await new Promise((r) => setTimeout(r, 120));
    assert.ok(dec.dead && /unused/.test(ended), ended);
    assert.strictEqual(warm.signalCode, 'SIGKILL');
    dec.dispose();
    assert.strictEqual(released, 1);
    assert.strictEqual(dec.segment(5), null, 'dead: the caller makes a new one');
  }
  { // The first frame must be an IDR with SPS/PPS; the source's end closes stdin and the segment ends with code 0.
    const procs = [];
    const dec = new W.WarmDecoder({ ffmpeg: 'ffmpeg', argv: ['warm'], key: 'k', file: 'in.mp4', streamIndex: 0, fps: 25, fileStart: 0,
      duration: 60, codec: 'h264', spawn: (cmd, a) => { const p = fakeProc(a); procs.push(p); return p; } });
    const warm = procs[0];
    const s1 = dec.segment(1);
    const c1 = new Promise((r) => s1.once('close', (code) => r(code)));
    warm.stdout.write(outFrame(600, false));
    assert.strictEqual(await c1, 1);
    assert.match(s1.err.text, /not an IDR/);
    const s2 = dec.segment(59);
    let stdinEnded = false;
    warm.stdin.on('finish', () => { stdinEnded = true; });
    warm.stdin.resume();
    procs[2].exit(0);
    await tick();
    await tick();
    assert.ok(stdinEnded && dec.ended, 'the source ended: stdin closed');
    assert.strictEqual(dec.segment(10), null, 'no more jumps on this process');
    const c2 = new Promise((r) => s2.once('close', (code) => r(code)));
    warm.stdout.end(outFrame(s2.S, true));
    warm.exit(0);
    assert.strictEqual(await c2, 0, 'its last frames, then the end of the video');
  }
  { // Every segment, the first too, starts on the frame grid at any rate (600 s is 0.386 of a frame off it at 23.976).
    for (const fps of [25, 24000 / 1001, 48000 / 1001, 30000 / 1001]) {
      const dec = new W.WarmDecoder({ ffmpeg: 'ffmpeg', argv: ['warm'], key: 'k', file: 'in.mp4', streamIndex: 0, fps, fileStart: 0,
        duration: 60, codec: 'h264', spawn: (cmd, a) => fakeProc(a) });
      for (const t of [1, 30]) {
        const seg = dec.segment(t);
        assert.ok(Math.abs(seg.S * fps - Math.round(seg.S * fps)) < 1e-6, `${fps.toFixed(3)} fps: segment at ${seg.S} off the grid`);
        seg.kill();
      }
      dec.dispose();
    }
  }
  { // A stall: the target fed, nothing out for stallMs.
    const procs = [];
    const dec = new W.WarmDecoder({ ffmpeg: 'ffmpeg', argv: ['warm'], key: 'k', file: 'in.mp4', streamIndex: 0, fps: 25, fileStart: 0,
      duration: 60, codec: 'h264', spawn: (cmd, a) => { const p = fakeProc(a); procs.push(p); return p; }, stallMs: 30 });
    procs[0].stdin.resume();
    const s = dec.segment(1);
    const closed = new Promise((r) => s.once('close', (code) => r(code)));
    for (let i = 0; i <= 3; i++) procs[1].stdout.write(tsPacket(0x100, { pes: { pts: 600 + i / 25 } }));
    assert.strictEqual(await closed, 1);
    assert.match(s.err.text, /no picture/);
    dec.dispose();
  }

  // ---- The stream's use of it (fakes) ---------------------------------------------------------------------------
  /** No spawn throttle (src/stream.js SPAWN_GAP_MS): each seek starts at once. */
  const quiet = (s) => { s.lastSpawnAt = -Infinity; s.lastSeekAt = -Infinity; };
  function make({ encoder = 'libx264', probed = PROBED(), gpu = createGpuSessions(8), warm = true } = {}) {
    const logs = [];
    const s = new EncodedStream({
      tools: { ffmpeg: 'ffmpeg', gpuFilters: new Set(['scale_cuda', 'hwdownload']) }, file: 'in.mp4', post: () => {}, log: (m) => logs.push(m),
      remote: false, maxHeight: 1080, encoder, cpuEncoder: 'libx264', gpuSessions: gpu, probed, warm,
    });
    s.fps = 25;
    s.sizeVideo();
    const launched = [];
    s.launch = (t) => { const p = fakeProc([]); p.t = t; p.err = { text: '' }; launched.push(p); return p; };
    const warmProcs = [];
    s.spawnWarm = (cmd, a) => { const p = fakeProc(a); warmProcs.push(p); return p; };
    return { s, logs, launched, warmProcs };
  }
  { // A paused start comes from the warm process; a playing seek starts ffmpeg; play keeps the warm one for later.
    const { s, logs, launched, warmProcs } = make();
    s.handle({ type: 'open', view: { w: 1920, h: 1080 } });
    assert.strictEqual(launched.length, 0, 'the paused open: no ffmpeg of its own');
    assert.strictEqual(warmProcs.length, 2, 'the warm process and its first remux');
    const argv = warmProcs[0].argv;
    assert.ok(argv.includes('pipe:0') && argv.includes('passthrough') && argv[argv.indexOf('-f', argv.indexOf('-omit_video_pes_length')) + 1] === 'mpegts', argv.join(' '));
    assert.ok(!argv.includes('-ss') && !argv.includes('-r'), 'no seek, no frame-rate conversion');
    assert.match(argv[argv.indexOf('-vf') + 1], /^select=/);
    assert.ok(argv.includes(String(Math.round(25 * 0.5))), '0.5 s keyframes (paused starts)');
    assert.ok(s.proc.warm);
    assert.ok(logs.some((l) => /kept-running decoder started/.test(l)) && logs.some((l) => /remote stream from 0\.000 s.*kept-running decoder/.test(l)));
    quiet(s); s.handle({ type: 'seek', gen: 1, t: 30, playing: false });
    assert.strictEqual(warmProcs.length, 3, 'a jump: a remux, no new process');
    assert.strictEqual(launched.length, 0);
    quiet(s); s.handle({ type: 'seek', gen: 2, t: 45, playing: true });
    assert.strictEqual(launched.length, 1, 'playing: ffmpeg as before (2 s keyframes)');
    assert.ok(s.warm && !s.warm.dead, 'kept for the next paused jump');
    quiet(s); s.handle({ type: 'seek', gen: 3, t: 12, playing: false });
    assert.strictEqual(launched.length, 1);
    assert.strictEqual(warmProcs.length, 4);
    // Compare: the page says this tile no longer sets the clock: the warm one goes at the next start.
    quiet(s); s.handle({ type: 'seek', gen: 4, t: 50, playing: false, warm: false });
    assert.strictEqual(launched.length, 2);
    assert.strictEqual(s.warm, null);
    s.dispose();
  }
  { // Sources and encoders that do not qualify start ffmpeg as before.
    for (const o of [{ probed: PROBED({ cfr: false }) }, { probed: PROBED({ codec: 'vp9' }) }, { encoder: 'h264_qsv' }, { warm: false }]) {
      const { s, launched, warmProcs } = make(o);
      s.handle({ type: 'open', view: { w: 1920, h: 1080 } });
      assert.strictEqual(warmProcs.length, 0, JSON.stringify(o));
      assert.strictEqual(launched.length, 1);
      s.dispose();
    }
  }
  { // GPU encoder sessions: the warm process holds one; none free: ffmpeg as before.
    const gpu = createGpuSessions(1);
    const a = make({ encoder: 'h264_nvenc', gpu });
    a.s.handle({ type: 'open', view: { w: 1920, h: 1080 } });
    assert.deepStrictEqual(gpu.counts(), { warm: 1 }, 'the warm session only: the stream has no encoder of its own');
    assert.ok(a.warmProcs[0].argv.includes('-forced-idr'));
    const b = make({ encoder: 'h264_nvenc', gpu });
    b.s.handle({ type: 'open', view: { w: 1920, h: 1080 } });
    assert.strictEqual(b.warmProcs.length, 0, 'over the budget: no warm process');
    assert.strictEqual(b.launched.length, 1);
    a.s.handle({ type: 'hidden', on: true });
    assert.strictEqual(a.s.warm, null, 'hidden: the warm process stops');
    assert.deepStrictEqual(gpu.counts(), {});
    a.s.dispose();
    b.s.dispose();
  }
  { // A failure: back to ffmpeg per seek, from the first frame not sent.
    const { s, logs, launched, warmProcs } = make();
    s.handle({ type: 'open', view: { w: 1920, h: 1080 } });
    const seg = s.proc;
    warmProcs[0].stdout.write(outFrame(seg.S, false)); // not an IDR
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(logs.some((l) => /kept-running decoder failed \(.*not an IDR/.test(l)), logs.join('\n'));
    assert.strictEqual(launched.length, 1);
    assert.strictEqual(launched[0].t, 0);
    quiet(s); s.handle({ type: 'seek', gen: 1, t: 20, playing: false });
    assert.strictEqual(launched.length, 2, 'stays off for this video');
    assert.strictEqual(warmProcs.length, 2);
    s.dispose();
  }

  { // A stall (no picture stallMs after the target was fed, as under heavy CPU load) is temporary: this seek goes to
    // ffmpeg at once, and after a while the kept-running decoder is tried again; a tone-mapper is not blamed for it.
    const stall = async (s, warmProcs) => {
      s.warmStallMs = 30; // the stream's test hook for the 5 s stall limit
      s.handle({ type: 'open', view: { w: 1920, h: 1080 } });
      warmProcs[0].stdin.resume();
      for (let i = 0; i <= 3; i++) warmProcs[1].stdout.write(tsPacket(0x100, { pes: { pts: W.firstS(25) + i / 25 } }));
      await new Promise((r) => setTimeout(r, 100));
    };
    const { s, logs, launched, warmProcs } = make();
    await stall(s, warmProcs);
    assert.ok(logs.some((l) => /no picture 30 ms/.test(l)), logs.join('\n'));
    assert.strictEqual(launched.length, 1, 'this seek: ffmpeg at once');
    assert.strictEqual(launched[0].t, 0);
    quiet(s); s.handle({ type: 'seek', gen: 1, t: 20, playing: false });
    assert.strictEqual(launched.length, 2, 'right after it: ffmpeg per seek');
    const realNow = Date.now;
    Date.now = () => realNow() + 10 * 60 * 1000;
    try { quiet(s); s.handle({ type: 'seek', gen: 2, t: 30, playing: false }); } finally { Date.now = realNow; }
    assert.strictEqual(launched.length, 2, 'minutes later: the kept-running decoder again');
    assert.ok(s.proc && s.proc.warm);
    s.dispose();
    // HDR on a hardware tone-mapper that has not given a frame yet: a stall does not mark it bad.
    const tools = { ffmpeg: 'ffmpeg', gpuFilters: new Set(['scale_cuda', 'hwdownload', 'hwupload', 'libplacebo', 'tonemap_opencl']) };
    const h = new EncodedStream({
      tools, file: 'in.mp4', post: () => {}, log: () => {}, remote: false, maxHeight: 1080, encoder: 'h264_nvenc', cpuEncoder: 'libx264',
      gpuSessions: createGpuSessions(8), probed: PROBED({ pixFmt: 'yuv420p10le', colorTransfer: 'smpte2084', colorPrimaries: 'bt2020' }),
    });
    h.fps = 25;
    h.sizeVideo();
    h.launch = (t) => { const p = fakeProc([]); p.t = t; p.err = { text: '' }; return p; };
    const hw = [];
    h.spawnWarm = (cmd, a) => { const p = fakeProc(a); hw.push(p); return p; };
    await stall(h, hw);
    assert.strictEqual(h.badTonemap.size, 0, 'the tone-mapper is not blamed for a stall');
    h.dispose();
  }

  { // HDR: a hardware tone-mapper that never gave a frame fails the warm process (libplacebo without a Vulkan device, seen
    // with a 2024 ffmpeg and NVENC): the tone-mapper is dropped, not the warm process, and no per-seek ffmpeg tries it again.
    // Every stream with the same ffmpeg (one tools object per check) skips it from then on: no second failed start.
    const tools = { ffmpeg: 'ffmpeg', gpuFilters: new Set(['scale_cuda', 'hwdownload', 'hwupload', 'libplacebo', 'tonemap_opencl']) };
    const pq = PROBED({ pixFmt: 'yuv420p10le', colorTransfer: 'smpte2084', colorPrimaries: 'bt2020' });
    const mk = () => {
      const logs = [];
      const s = new EncodedStream({
        tools, file: 'in.mp4', post: () => {}, log: (m) => logs.push(m), remote: false, maxHeight: 1080, encoder: 'h264_nvenc',
        cpuEncoder: 'libx264', gpuSessions: createGpuSessions(8), probed: pq,
      });
      s.fps = 25;
      s.sizeVideo();
      const launched = [];
      s.launch = (t) => { const p = fakeProc([]); p.t = t; p.err = { text: '' }; launched.push(p); return p; };
      const warmProcs = [];
      s.spawnWarm = (cmd, a) => { const p = fakeProc(a); warmProcs.push(p); return p; };
      return { s, logs, launched, warmProcs };
    };
    const a = mk();
    a.s.handle({ type: 'open', view: { w: 1920, h: 1080 } });
    assert.match(a.warmProcs[0].argv.join(' '), /libplacebo=/);
    a.warmProcs[0].exit(4294967274); // Invalid argument, before any frame
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(a.logs.some((l) => /libplacebo HDR tone-mapping failed/.test(l)), a.logs.join('\n'));
    assert.ok(!a.logs.some((l) => /kept-running decoder failed/.test(l)), 'the warm process is not blamed');
    assert.strictEqual(a.launched.length, 0, 'no per-seek ffmpeg with the failed tone-mapper');
    const again = a.warmProcs.filter((p) => p.argv.includes('pipe:0') && /tonemap_opencl/.test(p.argv.join(' ')));
    assert.strictEqual(again.length, 1, 'a new warm process with the next tone-mapper');
    const b = mk();
    b.s.handle({ type: 'open', view: { w: 1920, h: 1080 } });
    assert.ok(!/libplacebo=/.test(b.warmProcs[0].argv.join(' ')) && /tonemap_opencl/.test(b.warmProcs[0].argv.join(' ')),
      'the next video with this ffmpeg skips the failed tone-mapper');
    a.s.dispose();
    b.s.dispose();
  }

  // ---- Real ffmpeg: every landing is the exact frame ----------------------------------------------------------
  const ff = spawnSync('ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf8', windowsHide: true });
  if (ff.status !== 0) { console.log('warm decoder: no ffmpeg on PATH, real-process checks skipped'); return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vpe-warm-'));
  try {
    // Frame n shows its number in binary: 9 columns of 32 px, white for a 1. Noise on top makes frames of a real size
    // (a clip small enough to fit the pipe would reach its end at once, which ends a warm process by design).
    // 25 fps, and the NTSC-style rates whose frames are not on whole milliseconds (23.976, 47.952).
    const clips = [['h264', 'libx264', ['-bf', '3', '-g', '50', '-sc_threshold', '0'], '25'],
      ['h264', 'libx264', ['-bf', '3', '-g', '50', '-sc_threshold', '0'], '24000/1001'],
      ['h264', 'libx264', ['-bf', '3', '-g', '50', '-sc_threshold', '0'], '48000/1001']];
    const x265 = ['-x265-params', 'keyint=50:min-keyint=50:bframes=3:open-gop=1:scenecut=0:log-level=error'];
    if (/libx265/.test(ff.stdout)) clips.push(['hevc', 'libx265', x265, '25'], ['hevc', 'libx265', x265, '24000/1001']);
    const bits = String.raw`format=yuv420p,geq=lum='if(bitand(N\,pow(2\,floor(X/32)))\,235\,16)':cb=128:cr=128,noise=alls=30:allf=t`;
    for (const [codec, enc, opts, rate] of clips) {
      const [rn, rd = 1] = rate.split('/').map(Number);
      const fps = rn / rd;
      const file = path.join(dir, `${codec}-${rn}.mkv`);
      const mk = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `nullsrc=s=288x160:r=${rate}`, '-frames:v', '300',
        '-vf', bits, '-c:v', enc, ...opts, '-pix_fmt', 'yuv420p', file], { encoding: 'utf8', windowsHide: true });
      assert.strictEqual(mk.status, 0, mk.stderr);
      const probed = await require('../../src/ffmpeg').probe({ ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' }, file);
      assert.strictEqual(W.warmSourceRefusal(probed), '', `${codec}: ${W.warmSourceRefusal(probed)}`);
      const s = new EncodedStream({ tools: { ffmpeg: 'ffmpeg', gpuFilters: new Set() }, file, post: () => {}, log: () => {}, remote: false,
        maxHeight: 1080, encoder: 'libx264', cpuEncoder: 'libx264', gpuSessions: createGpuSessions(8), probed });
      // MKV times are whole milliseconds: its average rate can be a little off the nominal one (47.952055 for 47.952048).
      assert.ok(Math.abs(probed.video.fps / fps - 1) < 1e-5, `${rate}: probed ${probed.video.fps}`);
      s.fps = probed.video.fps;
      s.directStreamFailed = true; // a small H.264 clip would be copied (Direct Stream), not re-encoded
      s.sizeVideo();
      const argv = s.args(0, false, { warm: true });
      const make = () => new W.WarmDecoder({ ffmpeg: 'ffmpeg', argv, key: 'k', file, streamIndex: probed.video.index, fps: probed.video.fps,
        fileStart: probed.video.fileStart, duration: probed.duration, codec,
        spawn: (cmd, a) => spawn(cmd, a, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }) });
      let dec = make();
      let processes = 1;
      try {
        // Back and forth, on keyframes (0, 50, 100), one before and after one, deep into a GOP, near the end.
        for (const n of [37, 100, 99, 151, 50, 12, 250, 201, 0, 149, 296, 120]) {
          let seg = dec.segment(n / fps);
          if (!seg) { dec.dispose(); dec = make(); processes++; seg = dec.segment(n / fps); } // the source's end ended it
          assert.ok(seg);
          const first = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`${codec} ${rate} frame ${n}: no picture`)), 8000);
            seg.stdout.once('data', (d) => { clearTimeout(timer); resolve(d); });
            seg.once('close', (code) => { if (code) { clearTimeout(timer); reject(new Error(`${codec} ${rate} frame ${n}: ${seg.err.text}`)); } });
          });
          seg.kill();
          const y = spawnSync('ffmpeg', ['-v', 'error', '-f', 'h264', '-i', 'pipe:0', '-frames:v', '1', '-pix_fmt', 'yuv420p', '-f', 'rawvideo', 'pipe:1'],
            { input: first, windowsHide: true });
          const Y = y.stdout; // 288 x 160, the Y plane first
          let shown = 0;
          for (let bit = 0; bit < 9; bit++) {
            let sum = 0;
            for (let row = 40; row < 120; row++) for (let x = bit * 32 + 8; x < bit * 32 + 24; x++) sum += Y[row * 288 + x];
            if (sum / (80 * 16) > 125) shown |= 1 << bit;
          }
          assert.strictEqual(shown, n, `${codec} ${rate}: the jump to frame ${n} shows frame ${shown}`);
        }
        assert.ok(processes <= 2, `${processes} processes for 12 jumps (one more only after the source's end)`);
        console.log(`warm decoder: ${codec} ${rate} fps (${enc}, B-frames${codec === 'hevc' ? ', open GOP' : ''}): 12 jumps on the exact frame, ${processes} process(es)`);
      } finally { dec.dispose(); }
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
})().then(() => console.log('warm_decoder_test ok'), (e) => { console.error(e); process.exit(1); });
