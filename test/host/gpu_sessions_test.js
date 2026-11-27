'use strict';
// node test/run.js unit --grep gpu_sessions: the host's GPU encoder session budget (src/gpu-sessions.js) and how Live
// transcode uses it (src/stream.js): a live stream over the budget encodes on the CPU (one notice per session), fills
// and sharp paused frames over it are skipped, and every session is given back.
const assert = require('assert');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const { createGpuSessions, isGpuEncoder, limitOf, DEFAULT_GPU_SESSIONS } = require('../../src/gpu-sessions');
const { EncodedStream } = require('../../src/stream');

{ // The accounting.
  const g = createGpuSessions(2);
  assert.strictEqual(g.limit, 2);
  const a = g.acquire('stream');
  const b = g.acquire('fill');
  assert.ok(a && b);
  assert.strictEqual(g.acquire('sharp'), null, 'a third session over a budget of 2');
  assert.deepStrictEqual(g.counts(), { stream: 1, fill: 1 });
  g.release(a);
  g.release(a); // twice: nothing more
  g.release(null);
  assert.strictEqual(g.used, 1);
  const c = g.acquire('sharp');
  assert.ok(c, 'a released session is free again');
  g.setLimit(1); // lower: the running ones keep theirs, new ones wait
  assert.strictEqual(g.used, 2);
  g.release(b);
  assert.strictEqual(g.acquire('fill'), null, 'still at the new limit of 1');
  g.release(c);
  assert.ok(g.acquire('fill'));
  assert.ok(g.firstNotice());
  assert.ok(!g.firstNotice(), 'the CPU notice once per session');
}
{ // Short jobs (fills, sharp frames, quick pictures) leave the last free session to the live streams.
  const g = createGpuSessions(3);
  assert.ok(g.acquire('stream'));
  assert.ok(g.acquireShort('fill'), 'two free: a short job takes one');
  assert.strictEqual(g.acquireShort('sharp'), null, 'one free: kept for a stream');
  assert.ok(g.acquire('stream'), 'which a stream gets');
  assert.strictEqual(createGpuSessions(1).acquireShort('quick'), null, 'a budget of 1: only streams');
}
{ // Limits from the setting, and which encoders count.
  assert.strictEqual(limitOf(0), DEFAULT_GPU_SESSIONS);
  assert.strictEqual(limitOf('x'), DEFAULT_GPU_SESSIONS);
  assert.strictEqual(limitOf(3.7), 3);
  assert.strictEqual(createGpuSessions(-1).limit, DEFAULT_GPU_SESSIONS);
  for (const e of ['h264_nvenc', 'h264_qsv', 'h264_amf', 'h264_vaapi', 'h264_videotoolbox', 'h264_mf']) assert.ok(isGpuEncoder(e), e);
  for (const e of ['libx264', 'libopenh264', 'copy', '', null]) assert.ok(!isGpuEncoder(e), String(e));
}

function fakeProc() {
  const proc = new EventEmitter();
  Object.assign(proc, { stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, signalCode: null, err: { text: '' } });
  proc.kill = (sig) => { proc.signalCode = sig; setImmediate(() => proc.emit('close', null, sig)); };
  return proc;
}

function stream(gpu, { encoder = 'h264_nvenc', file = '/v/clip.mkv' } = {}) {
  const posted = [];
  const logs = [];
  const s = new EncodedStream({
    tools: { ffmpeg: 'ffmpeg' }, file, post: (m) => posted.push(m), log: (l) => logs.push(l), remote: true, maxHeight: 1080,
    encoder, cpuEncoder: 'libx264', decodeMethod: 'cuda', gpuSessions: gpu,
    probed: { duration: 60, video: { index: 0, codec: 'hevc', pixFmt: 'yuv420p10le', width: 1920, height: 1080, fps: 25 }, audio: null },
  });
  s.fps = 25;
  s.sizeVideo();
  const jobs = [];
  s.spawnJob = (argv) => { const p = fakeProc(); p.argv = argv; jobs.push(p); return p; };
  return { s, posted, logs, jobs };
}

(async () => {
  { // Live streams: the third over a budget of 2 encodes on the CPU, says so once, and gives nothing back it never took.
    const gpu = createGpuSessions(2);
    const a = stream(gpu);
    const b = stream(gpu);
    const c = stream(gpu, { file: 'C:\\v\\third.mkv' });
    const d = stream(gpu, { file: '/v/fourth.mkv' });
    for (const x of [a, b, c, d]) x.s.holdGpu();
    assert.strictEqual(gpu.used, 2);
    assert.strictEqual(a.s.encoder, 'h264_nvenc');
    assert.strictEqual(c.s.encoder, 'libx264', 'over the budget: the CPU encoder');
    assert.strictEqual(c.s.decodeMethod, 'none');
    assert.ok(c.s.args(0, false).includes('libx264'), 'its ffmpeg encodes with x264');
    const notes = [...c.posted, ...d.posted].filter((m) => m.type === 'remoteNotice');
    assert.strictEqual(notes.length, 1, 'one notice per session');
    assert.ok(/^third\.mkv is transcoded on the processor/.test(notes[0].text), notes[0].text);
    assert.ok(/GPU Encoder Sessions/.test(notes[0].text));
    assert.ok(c.logs.some((l) => /all 2 GPU encoder sessions/.test(l)));
    c.s.dispose();
    assert.strictEqual(gpu.used, 2, 'a CPU stream held none');
    a.s.dispose();
    assert.strictEqual(gpu.used, 1, 'dispose gives the session back');
    a.s.dispose();
    assert.strictEqual(gpu.used, 1);
    // Hidden: its encoder stops, so the session is free; shown again, it takes one before ffmpeg starts.
    b.s.setHidden(true);
    assert.strictEqual(gpu.used, 0);
    b.s.holdGpu();
    assert.strictEqual(gpu.used, 1);
    // An encoder that failed for good (GPU -> CPU fallback) gives its session back.
    b.s.restartVideo = () => {};
    b.s.encoderFallback('test');
    assert.strictEqual(gpu.used, 0);
  }
  { // Fills and sharp frames take a session of their own while they run; over the budget (less one kept free for a
    // stream) they are skipped.
    const gpu = createGpuSessions(3);
    const a = stream(gpu);
    a.s.holdGpu();
    a.s.fill({ id: 1, from: 8, to: 10 });
    assert.strictEqual(a.jobs.length, 1);
    assert.deepStrictEqual(gpu.counts(), { stream: 1, fill: 1 });
    a.s.sharp({ id: 7, t: 10 });
    assert.deepStrictEqual(a.posted.pop(), { type: 'sharpFrame', id: 7, done: true, error: 'busy' }, 'no session left: the soft picture stays');
    a.s.stopFill();
    await new Promise((r) => setImmediate(r));
    assert.deepStrictEqual(gpu.counts(), { stream: 1 }, 'the killed fill gave its session back');
    a.s.sharp({ id: 8, t: 10 });
    assert.deepStrictEqual(gpu.counts(), { stream: 1, sharp: 1 });
    a.s.fill({ id: 2, from: 8, to: 10 });
    assert.strictEqual(a.posted.pop().error, 'busy', 'a fill over the budget');
    a.s.seek({ gen: 1, t: 20 }); // a seek stops the sharp encode
    await new Promise((r) => setImmediate(r));
    assert.deepStrictEqual(gpu.counts(), { stream: 1 });
    a.s.dispose();
    assert.strictEqual(gpu.used, 0);
  }
  { // A fill whose arguments cannot be built (HDR with no tone-mapping filter in this ffmpeg) gives its session back and
    // says why, as a sharp frame does; nothing escapes the message handler.
    const gpu = createGpuSessions(8);
    const posted = [];
    const s = new EncodedStream({
      tools: { ffmpeg: 'ffmpeg', gpuFilters: new Set() }, file: '/v/hdr.mkv', post: (m) => posted.push(m), log: () => {}, remote: true,
      maxHeight: 1080, encoder: 'h264_nvenc', cpuEncoder: 'libx264', gpuSessions: gpu,
      probed: { duration: 60, audio: null, video: { index: 0, codec: 'hevc', pixFmt: 'yuv420p10le', width: 1920, height: 1080, fps: 25,
        colorTransfer: 'smpte2084', colorPrimaries: 'bt2020' } },
    });
    s.fps = 25;
    s.sizeVideo();
    s.spawnJob = () => { throw new Error('no ffmpeg in this test'); };
    await s.handle({ type: 'fill', id: 3, from: 8, to: 10 });
    const reply = posted.find((m) => m.type === 'fillBatch');
    assert.ok(reply && reply.done && /tone-mapping/.test(reply.error), JSON.stringify(reply));
    assert.strictEqual(gpu.used, 0, 'its session went back');
    s.dispose();
  }
  { // A stream already on the CPU encoder needs no session for its sharp frames.
    const gpu = createGpuSessions(1);
    gpu.acquire('stream');
    const a = stream(gpu, { encoder: 'libx264' });
    a.s.sharp({ id: 1, t: 4 });
    assert.strictEqual(a.jobs.length, 1);
    assert.strictEqual(gpu.used, 1);
    a.s.dispose();
  }
  // A launch's encoder: the stream keeps its GPU encoder and asks for a session at each launch; only a launch that cannot
  // get one encodes on the CPU (before that the stream gives back the session of its own idle kept-running decoder).
  const WARM_PROBED = { duration: 60, audio: null, formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
    video: { index: 0, codec: 'hevc', pixFmt: 'yuv420p', width: 1920, height: 1080, fps: 25, cfr: true, fileStart: 0, startTime: 0, fieldOrder: 'progressive' } };
  function live(gpu, { file = '/v/clip.mkv', probed, remote = false } = {}) {
    const posted = [];
    const logs = [];
    const s = new EncodedStream({
      tools: { ffmpeg: 'ffmpeg', gpuFilters: new Set() }, file, post: (m) => posted.push(m), log: (l) => logs.push(l), remote,
      maxHeight: 1080, encoder: 'h264_nvenc', cpuEncoder: 'libx264', gpuSessions: gpu, warm: !!probed,
      probed: probed || { duration: 60, video: { index: 0, codec: 'hevc', pixFmt: 'yuv420p', width: 1920, height: 1080, fps: 25 }, audio: null },
    });
    s.fps = 25;
    s.sizeVideo();
    const launched = [];
    // As launch() does, without ffmpeg: the session first, then the arguments of the encoder it leaves.
    s.launch = function (t, audio, opts) {
      if (!audio) this.holdGpu();
      const p = fakeProc();
      p.argv = this.args(t, !!audio, opts);
      p.encoder = p.argv[p.argv.indexOf('-c:v') + 1];
      launched.push(p);
      return p;
    };
    const warmProcs = [];
    s.spawnWarm = (cmd, a) => { const p = fakeProc(); p.argv = a; p.stdin = new PassThrough(); warmProcs.push(p); return p; };
    s.spawnJob = (argv) => { const p = fakeProc(); p.argv = argv; return p; };
    const quiet = () => { s.lastSpawnAt = -Infinity; s.lastSeekAt = -Infinity; };
    return { s, posted, logs, launched, warmProcs, quiet };
  }
  { // No session for one launch: that launch on the CPU; the next one with a session free is back on the GPU.
    const gpu = createGpuSessions(1);
    const other = gpu.acquire('stream'); // another video's encoder
    const a = live(gpu);
    a.s.handle({ type: 'open', view: { w: 1920, h: 1080 } });
    assert.strictEqual(a.launched[0].encoder, 'libx264', 'no session free: this launch on the CPU');
    gpu.release(other);
    a.quiet(); a.s.seek({ gen: 1, t: 20, playing: true });
    assert.strictEqual(a.launched.at(-1).encoder, 'h264_nvenc', 'a session free again: the next launch on the GPU');
    assert.deepStrictEqual(gpu.counts(), { stream: 1 });
    // Taken again by another video: the next launch goes back to the CPU, and the notice is not shown twice.
    a.s.kill();
    a.s.releaseGpu();
    const again = gpu.acquire('stream');
    a.quiet(); a.s.seek({ gen: 2, t: 30, playing: true });
    assert.strictEqual(a.launched.at(-1).encoder, 'libx264');
    assert.strictEqual(a.posted.filter((m) => m.type === 'remoteNotice').length, 1, 'one notice');
    gpu.release(again);
    a.s.dispose();
    assert.strictEqual(gpu.used, 0);
  }
  { // Its own idle kept-running decoder holds the only session: a launch while playing takes that one back first.
    const gpu = createGpuSessions(1);
    const a = live(gpu, { probed: WARM_PROBED });
    a.s.handle({ type: 'open', view: { w: 1920, h: 1080 } });
    assert.ok(a.s.warm, 'the paused open: a kept-running decoder');
    assert.deepStrictEqual(gpu.counts(), { warm: 1 });
    a.quiet(); a.s.seek({ gen: 1, t: 30, playing: true }); // playing: ffmpeg per seek, which needs a session of its own
    assert.strictEqual(a.launched.at(-1).encoder, 'h264_nvenc', 'still on the GPU');
    assert.strictEqual(a.s.warm, null, 'the idle kept-running decoder gave its session back');
    assert.deepStrictEqual(gpu.counts(), { stream: 1 });
    assert.ok(!a.posted.some((m) => m.type === 'remoteNotice'), 'no notice');
    a.s.dispose();
    assert.strictEqual(gpu.used, 0);
  }
  { // The notice does not count short encodes as videos.
    const gpu = createGpuSessions(3);
    gpu.acquire('stream');
    gpu.acquireShort('fill');
    gpu.acquire('stream');
    const c = live(gpu, { file: '/v/third.mkv' });
    c.s.handle({ type: 'open', view: { w: 1920, h: 1080 } });
    const note = c.posted.find((m) => m.type === 'remoteNotice');
    assert.ok(note && /^third\.mkv is transcoded on the processor/.test(note.text), note && note.text);
    assert.ok(!/encoding 3 videos/.test(note.text), note.text);
    assert.ok(/GPU Encoder Sessions/.test(note.text));
    c.s.dispose();
  }
  console.log('gpu sessions: ok');
})().catch((e) => { console.error(e); process.exit(1); });
