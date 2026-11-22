'use strict';
// node test/run.js unit --grep nativepts: native ffmpeg reports each picture's own source timestamp
// (src/nativepts.js, src/native.js): stamp parsing, constant-rate slots for VFR / gaps / dropped pictures,
// the frame header's src word, and real ffmpeg runs on generated clips (non-zero start, VFR, a seek that
// lands on the following picture). Exact A-B export then accepts marks set on those pictures.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const np = require('../../src/nativepts');
const frameserver = require('../../src/frameserver');
const ff = require('../../src/ffmpeg');
const { NativeDecoder } = require('../../src/native');
const { inspectSource } = require('../../src/clipexport');
const clipsource = require('../../src/clipsource');

const near = (a, b, eps = 1e-9, why = '') => assert.ok(Math.abs(a - b) <= eps, `${why} ${a} vs ${b}`);

function parsing() {
  const p = new np.StampParser();
  // Chunks split anywhere, also inside a line; the "vpe=1" line carries nothing.
  const text = 'frame:0    pts:46800   pts_time:0.52\nvpe=1\nframe:1    pts:50400   pts_time:0.56\nvpe=1\nframe:2    pts:N/A     pts_time:N/A\n';
  const got = [];
  for (let i = 0; i < text.length; i += 7) got.push(...p.push(text.slice(i, i + 7)));
  assert.deepStrictEqual(got.map((s) => [s.n, s.pts]), [[0, 46800], [1, 50400], [2, NaN]]);
  assert.strictEqual(np.stampSeconds(got[0], [1, 90000]), 0.52, 'ticks times the time base: exact');
  // Six significant digits in pts_time only guard: a changed time base is not trusted.
  assert.ok(Number.isNaN(np.stampSeconds(got[0], [1, 1000])));
  assert.ok(Number.isNaN(np.stampSeconds(got[2], [1, 90000])));
  const late = { n: 0, pts: 3600 * 90000 + 3750, time: 3600.04 }; // 3600.0416666: pts_time lost the digits
  near(np.stampSeconds(late, [1, 90000]), 3600 + 3750 / 90000, 1e-9, 'a non-zero start keeps its precision');
  assert.deepStrictEqual(np.parseTimeBase('1/90000'), [1, 90000]);
  assert.strictEqual(np.parseTimeBase(''), null);
  assert.strictEqual(np.parseTimeBase('0/0'), null);
}

function slots() {
  const place = (fps, times) => {
    const r = new np.Resampler(fps);
    return times.map((t) => r.place(t));
  };
  // CFR: one slot each. A start at a large offset is the same (slots are relative to the first picture).
  assert.deepStrictEqual(place(25, [3600, 3600.04, 3600.08]), [{ hold: 0 }, { hold: 0 }, { hold: 0 }]);
  // VFR with a missing picture at 1.00: the previous picture holds one more slot.
  assert.deepStrictEqual(place(25, [0.92, 0.96, 1.04]), [{ hold: 0 }, { hold: 0 }, { hold: 1 }]);
  // Faster than the grid: a picture falling on a filled slot is dropped, as cfr did.
  assert.deepStrictEqual(place(10, [0, 0.04, 0.08, 0.12, 0.16, 0.2]).map((s) => s && s.hold), [0, null, 0, null, 0, null]);
  // An unknown time takes one slot and goes on counting.
  assert.deepStrictEqual(place(25, [0, NaN, 0.08]).map((s) => s && s.hold), [0, 0, 0]);
}

function header() {
  // The extra word is the old reserved one: the layout and size are unchanged, and no src means unknown.
  const plain = frameserver.parseHeader(frameserver.frameHeader(1, 3, 1.5, 4, 2, 8, 12));
  assert.strictEqual(plain.src, null);
  assert.strictEqual(frameserver.HEADER, 40);
  const t = 1.0333333333;
  const stamped = frameserver.frameHeader(1, 3, t, 4, 2, 8, 12, 1.04);
  assert.strictEqual(stamped.length, 40);
  const h = frameserver.parseHeader(stamped);
  near(h.src, 1.04, 1e-6, 'microsecond precision');
  assert.deepStrictEqual([h.gen, h.w, h.h, h.ys, h.len, h.t], [3, 4, 2, 8, 12, t]);
  assert.strictEqual(frameserver.parseHeader(frameserver.frameHeader(1, 3, 0, 4, 2, 8, 12, 1e7)).src, null, 'out of range: unknown');
  assert.strictEqual(frameserver.parseHeader(frameserver.frameHeader(1, 3, 0, 4, 2, 8, 12, -3)).src, -3);
}

/** NativeDecoder.pair with a stand-in process: stamps and pictures arrive in any order. */
function pairing() {
  const sent = [];
  const nd = new NativeDecoder({ probed: { duration: 4, video: { index: 0, codec: 'h264', pixFmt: 'yuv420p', width: 2, height: 2, fps: 25, timeBase: '1/90000', startTime: 3600 }, audio: null },
    method: 'none', log() {}, post() {}, postRaw: (m) => sent.push(m) });
  const proc = { stamped: true, raw: [], stampQ: [], placed: 0, t: 0, timeBase: [1, 90000], resampler: new np.Resampler(25),
    stdout: { isPaused: () => false, pause() {} } };
  const stamp = (n, sec) => ({ n, pts: Math.round(sec * 90000), time: sec });
  const pic = (i) => [Buffer.from([i])];
  // Picture before its stamp; stamp before its picture; a gap (1.00 missing) and a picture on a filled slot.
  nd.picture(proc, pic(0));
  assert.strictEqual(nd.frames.length, 0, 'a picture waits for its stamp');
  proc.stampQ.push(stamp(0, 3600.92), stamp(1, 3600.96), stamp(2, 3601.04), stamp(3, 3601.045));
  nd.pair(proc);
  nd.picture(proc, pic(1));
  nd.picture(proc, pic(2));
  nd.picture(proc, pic(3));
  const slots = nd.frames.map((e) => [e.parts[0][0], e.left, +e.src.toFixed(6)]);
  // origin is the first picture of a run from 0: 3600.92 here, so srcs are relative to it.
  assert.deepStrictEqual(slots, [[0, 1, 0], [1, 1, 0.04], [1, 1, 0.04], [2, 1, 0.12]], 'the missing picture holds its predecessor one slot');
  // End of ffmpeg with a picture that never got a stamp: unknown time, still shown.
  nd.picture(proc, pic(4));
  nd.pair(proc, true);
  const last = nd.frames.at(-1);
  assert.deepStrictEqual([last.parts[0][0], Number.isNaN(last.src)], [4, true]);
  // A stamp count that does not follow the pictures is not trusted from there on.
  const bad = { ...proc, raw: [], stampQ: [stamp(7, 5)], placed: 0, resampler: new np.Resampler(25), untrusted: false, t: 1 };
  nd.frames = [];
  nd.picture(bad, pic(9));
  assert.ok(Number.isNaN(nd.frames[0].src) && bad.untrusted, 'a stamp that is out of step is dropped');
  nd.dispose();
}

async function real(tools, dir) {
  const clips = {};
  const gen = (name, args) => { clips[name] = path.join(dir, name); execFileSync(tools.ffmpeg, ['-v', 'error', '-y', ...args, clips[name]], { windowsHide: true }); };
  // VFR: the 26th picture (1.00 s) is missing. Offset: starts at 3600 s (a broadcast timestamp origin).
  gen('vfr.mp4', ['-f', 'lavfi', '-i', 'testsrc2=s=160x96:r=25:d=2', '-vf', String.raw`select=not(eq(n\,25))`, '-fps_mode', 'passthrough', '-c:v', 'libx264']);
  gen('gap.mp4', ['-f', 'lavfi', '-i', 'testsrc2=s=160x96:r=25:d=2', '-vf', String.raw`select=not(between(n\,25\,27))`, '-fps_mode', 'passthrough', '-c:v', 'libx264']);
  gen('offset.mkv', ['-f', 'lavfi', '-i', 'testsrc2=s=160x96:r=25:d=2', '-f', 'lavfi', '-i', 'sine=d=2', '-c:v', 'libx264', '-c:a', 'aac', '-output_ts_offset', '3600']);
  const run = async (file, seek, noStamps = false) => {
    const pr = await ff.probe(tools, file);
    const frames = [];
    let done = false;
    const nd = new NativeDecoder({ tools, file, probed: pr, method: 'none', maxHeight: 96, maxQueued: 4, log() {}, post: (m) => { if (m.type === 'batch' && m.eof) done = true; },
      postRaw: (m) => { if (m.type === 'ndv') { frames.push(m); nd.handle({ type: 'more', gen: m.gen }); } } });
    nd.noStamps = noStamps;
    await nd.handle({ type: 'open' });
    nd.handle({ type: 'more', gen: 0 });
    if (seek !== undefined) {
      // As in the player, the seek comes after the first picture (the origin of the source times) has shown.
      const first = Date.now() + 10000;
      while (!frames.length && Date.now() < first) await new Promise((r) => setTimeout(r, 20));
      frames.length = 0;
      nd.handle({ type: 'seek', gen: 1, t: seek });
      nd.handle({ type: 'more', gen: 1 });
    }
    const end = Date.now() + 20000;
    while (!done && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
    nd.dispose();
    return { frames: seek === undefined ? frames : frames.filter((f) => f.gen === 1), pr };
  };

  // Non-zero start: stamps are relative to the first picture, not the 3600 s container clock.
  const off = await run(clips['offset.mkv']);
  near(off.frames[0].src, 0, 1e-6);
  near(off.frames[10].src, 0.4, 1e-6, 'tenth picture');
  assert.ok(off.frames.every((f, i) => Math.abs(f.t - i / 25) < 1e-9), 'slots keep the constant rate');
  const offSeek = await run(clips['offset.mkv'], 1.0);
  near(offSeek.frames[0].t, 1.0, 1e-9);
  near(offSeek.frames[0].src, 1.0, 1e-6, 'a seek reports the picture time, not 3601 s');

  // VFR: three missing pictures (1.00-1.08 s) hold the picture before the gap for their slots, then the next one follows.
  const vfr = await run(clips['gap.mp4']);
  const t = vfr.frames.map((f) => f.t.toFixed(4));
  assert.strictEqual(new Set(t).size, t.length, 'one record per slot');
  const before = vfr.frames.filter((f) => Math.abs(f.src - 0.96) < 1e-6);
  assert.strictEqual(before.length, 3, 'the picture at 0.96 s holds the two slots of the gap');
  const after = vfr.frames[vfr.frames.indexOf(before[2]) + 1];
  near(after.src, 1.12, 1e-6, 'then the picture after the gap');
  assert.ok(vfr.frames.every((f, i) => !i || f.src >= vfr.frames[i - 1].src), 'timestamps never go back');

  // A seek to 1.000 s lands on the following picture (1.04): the label stays the slot, the stamp is the file's.
  const seeked = await run(clips['vfr.mp4'], 1.0);
  near(seeked.frames[0].src, 1.04, 1e-6, 'accurate seek shows the picture after the gap');
  assert.ok(Math.abs(seeked.frames[0].t - 1.0) < 1 / seeked.pr.video.fps, 'labelled by its slot');

  // Exact export accepts marks set on those pictures (the old slot label 1.000 selected the earlier picture).
  const a = seeked.frames[0].src;
  const source = await inspectSource(tools, clips['vfr.mp4'], { a, b: seeked.frames[1].src, early: 0 });
  near(source.start, 1.04, 1e-6, 'A is the marked picture');
  near(source.end, 1.12, 1e-6, 'B is inclusive');
  assert.strictEqual(source.last - source.first, 1);
  await assert.rejects(() => inspectSource(tools, clips['vfr.mp4'], { a, b: a, early: 0, native: true }), /native playback or Live transcode/);
  return clips;
}

/** The unstamped path (an ffmpeg without -fps_mode, or one that refused the filter): ffmpeg's own constant rate, no source times. */
async function unstamped(tools, clip) {
  const pr = await ff.probe(tools, clip);
  const frames = [];
  let done = false;
  const nd = new NativeDecoder({ tools, file: clip, probed: pr, method: 'none', maxHeight: 96, maxQueued: 4, log() {}, post: (m) => { if (m.type === 'batch' && m.eof) done = true; },
    postRaw: (m) => { if (m.type === 'ndv') { frames.push(m); nd.handle({ type: 'more', gen: m.gen }); } } });
  nd.noStamps = true;
  await nd.handle({ type: 'open' });
  nd.handle({ type: 'more', gen: 0 });
  const end = Date.now() + 20000;
  while (!done && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
  nd.dispose();
  assert.ok(frames.length >= 40, `${frames.length} pictures`);
  assert.ok(frames.every((f, i) => f.src === undefined && Math.abs(f.t - i / pr.video.fps) < 1e-9), 'slots by count, no source time');
  assert.ok(nd.proc === null || !nd.proc.stamped);
}

const PROBED = { duration: 4, video: { index: 0, codec: 'h264', pixFmt: 'yuv420p', width: 2, height: 2, fps: 25, timeBase: '1/90000', startTime: 3600 }, audio: null };
const stampLine = (n, sec) => ({ n, pts: Math.round(sec * 90000), time: sec });
const stampedProc = (t = 0) => ({ stamped: true, raw: [], stampQ: [], placed: 0, t, timeBase: [1, 90000], resampler: new np.Resampler(25),
  stdout: { isPaused: () => false, pause() {} } });

/** The stamp pipe goes silent while pictures keep coming and ffmpeg stays open: bounded memory, playback goes on. */
function silentPipe() {
  const nd = new NativeDecoder({ probed: PROBED, method: 'none', log() {}, post() {}, postRaw() {} });
  const proc = stampedProc();
  for (let i = 0; i < 100; i++) {
    nd.picture(proc, [Buffer.from([i])]);
    assert.ok(proc.raw.length <= 16, `at most 16 pictures wait for a stamp (${proc.raw.length} at picture ${i})`);
  }
  assert.ok(proc.untrusted && nd.noStamps, 'the run goes on without source times, and so does the next');
  assert.strictEqual(nd.frames.length, 100, 'every picture was delivered');
  assert.ok(nd.frames.every((e) => Number.isNaN(e.src)), 'unstamped: marks stay ineligible');
  assert.deepStrictEqual(nd.frames.map((e) => e.parts[0][0]), [...Array(100).keys()], 'in order');
  // Late stamps of the abandoned run are ignored.
  nd.dispose();
}

/** Marks stay without source times until the first picture of a run from 0 has been seen. */
function unverifiedOrigin() {
  const nd = new NativeDecoder({ probed: PROBED, method: 'none', log() {}, post() {}, postRaw() {} });
  const seek = stampedProc(1);
  seek.stampQ.push(stampLine(0, 3601.04), stampLine(1, 3601.08));
  nd.picture(seek, [Buffer.from([0])]);
  nd.picture(seek, [Buffer.from([1])]);
  assert.ok(nd.frames.every((e) => Number.isNaN(e.src)), 'a declared start_time (3600 s here) is not trusted as the origin');
  const first = stampedProc(0);
  first.stampQ.push(stampLine(0, 3600.04), stampLine(1, 3600.08));
  nd.frames = [];
  nd.picture(first, [Buffer.from([0])]);
  nd.picture(first, [Buffer.from([1])]);
  near(nd.frames[0].src, 0, 1e-9, 'the first picture of the run from 0 is the origin');
  near(nd.frames[1].src, 0.04, 1e-9);
  nd.frames = [];
  const later = stampedProc(1);
  later.stampQ.push(stampLine(0, 3601.04));
  nd.picture(later, [Buffer.from([0])]);
  near(nd.frames[0].src, 1.0, 1e-9, 'a later seek is relative to it');
  nd.dispose();
}

/** A modern ffmpeg without the metadata filter: one retry without stamps, before any GPU or decoder fallback. */
function filterRefused() {
  const { EventEmitter } = require('events');
  const launched = [];
  const failures = [];
  const nd = new NativeDecoder({ probed: PROBED, method: 'd3d11va', log() {}, post() {}, postRaw() {}, onFail: (e) => failures.push(e) });
  nd.tools = { ffmpeg: 'fake' };
  nd.w = 2; nd.h = 2; nd.fps = 25;
  nd.launch = (t) => {
    const stamped = !nd.noStamps;
    const stdio = [null, null, null, new EventEmitter(), Object.assign(new EventEmitter(), { setEncoding() {} })];
    const proc = Object.assign(new EventEmitter(), { t, stamped, method: nd.method, exitCode: null, err: { text: '' }, stdio,
      stdout: Object.assign(new EventEmitter(), { isPaused: () => false }), stderr: new EventEmitter(), kill() {}, timeBase: [1, 90000] });
    stdio[1] = proc.stdout;
    launched.push(proc);
    return proc;
  };
  nd.startAt(0);
  assert.ok(launched[0].stamped);
  launched[0].err.text = "[AVFilterGraph @ 0] No such filter: 'metadata'\nError parsing a filter description";
  launched[0].emit('close', 1);
  assert.strictEqual(launched.length, 2, 'retried once');
  assert.ok(nd.noStamps && !launched[1].stamped, 'without the timestamp filter');
  assert.strictEqual(nd.method, 'd3d11va', 'the GPU method was not blamed');
  assert.deepStrictEqual(failures, []);
  // A failure that has nothing to do with the filter keeps the old ladder.
  launched[1].err.text = 'Device creation failed';
  launched[1].emit('close', 1);
  assert.strictEqual(nd.method, 'none', 'software next');
  nd.dispose();
}

function refusal() {
  const range = { a: 1, b: 2, early: 0, native: true };
  // Live transcode: refused early, with the switch to the original video.
  const live = clipsource.syntheticRefusal([{ range }], [0]);
  assert.deepStrictEqual([live.label, live.tiles], ['Use original video', [0]]);
  assert.match(live.message, /Live transcode/);
  // Native ffmpeg without timestamps (old build): the built-in decoder for a single player, text only in Compare.
  assert.strictEqual(clipsource.syntheticRefusal([{ range }], []).label, 'Switch to built-in decoder');
  assert.strictEqual(clipsource.syntheticRefusal([{ tile: 1, range }, { tile: 0, range }], [], true).label, null);
  // Compare: only the transcoded tiles are switched; one exact tile keeps the export going.
  const two = clipsource.syntheticRefusal([{ tile: 0, range }, { tile: 2, range }], [2, 5], true);
  assert.deepStrictEqual(two.tiles, [2]);
  assert.strictEqual(clipsource.syntheticRefusal([{ tile: 0, range }, { tile: 1, range: { ...range, native: false } }], [0], true), null);
  assert.strictEqual(clipsource.syntheticRefusal([{ range: { a: 1, b: 2, early: 0 } }], [0]), null, 'exact marks are never refused');
  assert.strictEqual(clipsource.syntheticRefusal([], [0]), null);
}

(async () => {
  parsing();
  slots();
  header();
  pairing();
  silentPipe();
  unverifiedOrigin();
  filterRefused();
  refusal();
  const tools = await ff.locateTools('', '');
  if (!tools || spawnSync(tools.ffmpeg, ['-version'], { windowsHide: true }).status !== 0) { console.log('nativepts: ok (real ffmpeg part skipped)'); return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vpe-nativepts-'));
  // The stamped fixtures need `-fps_mode` and the metadata filter (ffmpeg 5.1+); older builds only run the unstamped path.
  const help = spawnSync(tools.ffmpeg, ['-h', 'filter=metadata'], { encoding: 'utf8', windowsHide: true }).stdout || '';
  const stampedOk = !tools.legacy && /direct/.test(help);
  try {
    if (stampedOk) await real(tools, dir); else console.log('nativepts: stamped real-ffmpeg checks skipped (ffmpeg without -fps_mode or the metadata filter)');
    const clip = path.join(dir, 'plain.mp4');
    execFileSync(tools.ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=160x96:r=25:d=2', '-c:v', 'libx264', clip], { windowsHide: true });
    await unstamped(tools, clip);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  console.log('nativepts: ok');
})().catch((e) => { console.error(e); process.exit(1); });
