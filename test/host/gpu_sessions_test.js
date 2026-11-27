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
  { // Fills and sharp frames take a session of their own while they run; over the budget they are skipped.
    const gpu = createGpuSessions(2);
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
  { // A stream already on the CPU encoder needs no session for its sharp frames.
    const gpu = createGpuSessions(1);
    gpu.acquire('stream');
    const a = stream(gpu, { encoder: 'libx264' });
    a.s.sharp({ id: 1, t: 4 });
    assert.strictEqual(a.jobs.length, 1);
    assert.strictEqual(gpu.used, 1);
    a.s.dispose();
  }
  console.log('gpu sessions: ok');
})().catch((e) => { console.error(e); process.exit(1); });
