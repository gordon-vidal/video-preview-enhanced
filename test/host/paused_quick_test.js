'use strict';
// node test/run.js unit --grep paused_quick: Live transcode, paused, on a slow link (src/stream.js startQuick): when the
// encoder cannot make its first keyframe small (NVENC and the other GPU encoders; only x264 can), the host encodes the
// target frame once more at half the width and height and sends it before the stream's own frames; it holds a GPU
// encoder session, is skipped over the budget, and a seek or hide stops it. Without ffmpeg (fake processes).
const assert = require('assert');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const { EncodedStream } = require('../../src/stream');
const { createGpuSessions } = require('../../src/gpu-sessions');

function fakeProc() {
  const proc = new EventEmitter();
  Object.assign(proc, { stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, signalCode: null, err: { text: '' } });
  proc.kill = (sig) => { proc.signalCode = sig; setImmediate(() => proc.emit('close', null, sig)); };
  return proc;
}

function make({ remote = true, encoder = 'h264_nvenc', gpu = createGpuSessions(8) } = {}) {
  const posted = [];
  const logs = [];
  const s = new EncodedStream({
    tools: { ffmpeg: 'ffmpeg', gpuFilters: new Set() }, file: 'x.mkv', post: (m) => posted.push(m), log: (l) => logs.push(l),
    remote, maxHeight: 1080, encoder, cpuEncoder: 'libx264', gpuSessions: gpu,
    probed: { duration: 60, audio: null, video: { index: 0, codec: 'hevc', pixFmt: 'yuv420p10le', width: 1920, height: 1080, fps: 25 } },
  });
  s.fps = 25;
  s.sizeVideo();
  const jobs = [];
  const launched = [];
  s.spawnJob = (argv) => { const p = fakeProc(); p.argv = argv; jobs.push(p); return p; };
  s.launch = (t, audio, opts) => { const p = fakeProc(); p.t = t; launched.push({ t, opts }); return p; };
  return { s, posted, logs, jobs, launched };
}

const tick = () => new Promise((r) => setImmediate(r));
const quickOf = (jobs) => jobs.find((j) => j.argv.includes('-frames:v'));
const sizeIn = (argv) => /scale\w*=(?:w=)?(\d+):(?:h=)?(\d+)/.exec(argv.join(' '));

(async () => {
  { // NVENC, paused, a slow (not yet measured) link: one picture at half the width and height, on the stream's encoder.
    const gpu = createGpuSessions(8);
    const { s, posted, jobs, launched } = make({ gpu });
    s.seek({ gen: 1, t: 10.019, playing: false });
    assert.strictEqual(launched.length, 1, 'the stream itself starts as before');
    assert.ok(!s.proc.firstKeyBits, 'NVENC: no small first keyframe');
    const q = quickOf(jobs);
    assert.ok(q, 'a quick picture is encoded');
    assert.strictEqual(q.argv[q.argv.indexOf('-frames:v') + 1], '1');
    assert.ok(q.argv.includes('h264_nvenc'), 'with the stream\'s encoder');
    const size = sizeIn(q.argv);
    assert.ok(size && Number(size[1]) === 960 && Number(size[2]) === 540, `half of 1920x1080: ${q.argv.join(' ')}`);
    assert.strictEqual(gpu.counts().quick, 1, 'it holds a GPU encoder session');
    assert.strictEqual(s.pipelineMode === 'direct-stream', false);
    // The page asks for the stream's frames: they wait for the quick picture...
    s.vAll.push({ t: 10, key: true, data: new Uint8Array(1000) });
    s.vNext = 0;
    s.more({ gen: 1, limit: 1e6 });
    assert.ok(!posted.some((m) => m.type === 'batch'), 'the stream\'s first frames wait for the quick picture');
    // ...which goes first, in its own ArrayBuffer, with the stream's size to draw it at.
    q.stdout.write(Buffer.alloc(30000, 5));
    await tick();
    q.emit('close', 0, null);
    const i = posted.findIndex((m) => m.type === 'quickFrame');
    const j = posted.findIndex((m) => m.type === 'batch');
    assert.ok(i >= 0 && j > i, `the quick picture goes before the stream's frames: ${posted.map((m) => m.type)}`);
    const qf = posted[i];
    assert.deepStrictEqual([qf.gen, qf.t, qf.w, qf.h, qf.data.length, qf.data.buffer.byteLength], [1, 10, 1920, 1080, 30000, 30000]);
    assert.strictEqual(gpu.counts().quick, undefined, 'its session goes back');
    s.dispose();
  }
  { // Not ready in time: the stream goes first and the quick picture is dropped (it could no longer be ahead). The wait:
    // 3/4 of a full keyframe's time on the link (beyond that the full keyframe would show sooner), 1 s at most.
    const { s, posted, jobs, logs } = make();
    const key = 1920 * 1080 * 0.1; // no keyframe measured yet: 0.1 byte per pixel
    s.link.fastKbps = s.link.slowKbps = (key * 8) / 400; // a full keyframe takes 400 ms: wait 300 ms
    s.seek({ gen: 1, t: 4, playing: false });
    s.vAll.push({ t: 4, key: true, data: new Uint8Array(1000) });
    s.vNext = 0;
    s.more({ gen: 1, limit: 1e6 });
    await new Promise((r) => setTimeout(r, 250));
    assert.ok(!posted.some((m) => m.type === 'batch'), 'still waiting at 250 ms');
    await new Promise((r) => setTimeout(r, 120));
    assert.ok(posted.some((m) => m.type === 'batch'), 'the stream waited 300 ms at most');
    assert.strictEqual(quickOf(jobs).signalCode, 'SIGKILL');
    assert.ok(logs.some((l) => /quick picture not ready/.test(l)));
    await tick();
    assert.ok(!posted.some((m) => m.type === 'quickFrame'));
    s.dispose();
  }
  { // Not asked for: x264 (its small first keyframe does it), playing, a local window, a fast link, the hook off.
    const x = make({ encoder: 'libx264' });
    x.s.seek({ gen: 1, t: 4, playing: false });
    assert.ok(x.launched[0].opts && x.launched[0].opts.firstKeyBits > 0, 'x264: the small first keyframe');
    assert.ok(!quickOf(x.jobs), 'x264: no quick picture');
    x.s.dispose();
    const cases = [
      ['playing', make(), { playing: true }],
      ['local', make({ remote: false }), {}],
      ['fast link', (() => { const m = make(); m.s.link.fastKbps = m.s.link.slowKbps = 1e6; return m; })(), {}],
      ['hook off', make(), { fastFirst: false }],
      ['quick hook off', make(), { quick: false }],
    ];
    for (const [what, m, extra] of cases) {
      m.s.seek({ gen: 1, t: 4, playing: false, ...extra });
      assert.ok(!quickOf(m.jobs), what);
      m.s.dispose();
    }
    // The test hook: the quick picture with x264 too, instead of its small first keyframe.
    const h = make({ encoder: 'libx264' });
    h.s.seek({ gen: 1, t: 4, playing: false, quick: true });
    assert.ok(!(h.launched[0].opts && h.launched[0].opts.firstKeyBits), 'no small first keyframe then');
    assert.ok(quickOf(h.jobs) && quickOf(h.jobs).argv.includes('libx264'));
    h.s.dispose();
  }
  { // Over the GPU encoder session budget: skipped (the streams' own encoders come first).
    const gpu = createGpuSessions(1);
    gpu.acquire('stream'); // another video's encoder holds the only one
    const { s, jobs, logs } = make({ gpu });
    s.seek({ gen: 1, t: 4, playing: false });
    assert.ok(!quickOf(jobs), 'no session left: no quick picture');
    assert.ok(logs.some((l) => /no quick picture: every GPU encoder session/.test(l)));
    s.dispose();
  }
  { // A seek, hide or dispose stops it: its ffmpeg is killed and nothing is sent.
    for (const stop of [(x) => x.seek({ gen: 2, t: 8, playing: false, quick: false }), (x) => x.setHidden(true), (x) => x.dispose(),
      (x) => x.seek({ gen: 2, t: 8, playing: true })]) {
      const m = make();
      m.s.seek({ gen: 1, t: 4, playing: false });
      const q = quickOf(m.jobs);
      stop(m.s);
      assert.strictEqual(q.signalCode, 'SIGKILL', String(stop));
      await tick();
      assert.ok(!m.posted.some((p) => p.type === 'quickFrame'), String(stop));
      m.s.dispose();
    }
    // A failed encode: nothing sent, the stream goes on.
    const f = make();
    f.s.seek({ gen: 1, t: 4, playing: false });
    f.s.vAll.push({ t: 4, key: true, data: new Uint8Array(10) });
    f.s.vNext = 0;
    f.s.more({ gen: 1, limit: 1e6 });
    const q = quickOf(f.jobs);
    q.stderr.write('no NVENC\n');
    await tick();
    q.emit('close', 1, null);
    assert.ok(!f.posted.some((p) => p.type === 'quickFrame'));
    assert.ok(f.posted.some((p) => p.type === 'batch'), 'the stream is released at once');
    assert.ok(f.logs.some((l) => /no quick picture \(no NVENC\)/.test(l)));
    f.s.dispose();
  }
  console.log('paused quick: ok');
})().catch((e) => { console.error(e); process.exit(1); });
