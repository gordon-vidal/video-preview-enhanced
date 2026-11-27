'use strict';
// node test/run.js unit --grep paused_sharp: Live transcode, paused (src/stream.js): the fast first picture (a small
// first keyframe when the link is slow) and the sharp paused frame (one visually lossless picture, sent in pieces the
// page pulls), without ffmpeg.
const assert = require('assert');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const { EncodedStream, FAST_FIRST_SHARE } = require('../../src/stream');
const { encoderArgs, GPU_ENCODERS } = require('../../src/transcode_args');
const { createGpuSessions } = require('../../src/gpu-sessions');

{ // Encoder arguments: the small first keyframe only where it is honoured (x264), the sharp picture for every encoder.
  const x = encoderArgs('libx264', 25, 8000, 0.5, { firstKeyBits: 400000 });
  assert.strictEqual(x[x.indexOf('-rc_init_occupancy') + 1], '400000');
  assert.deepStrictEqual(encoderArgs('libx264', 25, 8000, 0.5, { firstKeyBits: 0 }), encoderArgs('libx264', 25, 8000, 0.5),
    'without it: the usual arguments');
  const capped = encoderArgs('libx264', 25, 100, 0.5, { firstKeyBits: 9e9 });
  assert.strictEqual(capped[capped.indexOf('-rc_init_occupancy') + 1], '100000', 'never more than the buffer');
  // Measured (RTX 4070): NVENC ignores it in this mode; the arguments stay as they were for the GPU encoders.
  for (const e of GPU_ENCODERS) assert.deepStrictEqual(encoderArgs(e, 25, 8000, 0.5, { firstKeyBits: 400000 }), encoderArgs(e, 25, 8000, 0.5), e);
  const sx = encoderArgs('libx264', 25, 8000, 0.5, { sharp: true });
  assert.strictEqual(sx[sx.indexOf('-crf') + 1], '11');
  assert.ok(!sx.includes('-maxrate'), 'one picture: no rate cap');
  const sn = encoderArgs('h264_nvenc', 25, 8000, 0.5, { sharp: true });
  assert.strictEqual(sn[sn.indexOf('-cq') + 1], '13');
  for (const e of [...GPU_ENCODERS, 'libopenh264']) {
    const a = encoderArgs(e, 25, 8000, 0.5, { sharp: true });
    assert.ok(a.includes(e) && !a.includes('-maxrate') && a.includes('high'), `${e}: ${a.join(' ')}`);
  }
}

function fakeProc() {
  const proc = new EventEmitter();
  Object.assign(proc, { stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, signalCode: null, err: { text: '' } });
  proc.kill = (sig) => { proc.signalCode = sig; setImmediate(() => proc.emit('close', null, sig)); };
  return proc;
}

function make({ remote = true, encoder = 'libx264', hdr = false } = {}) {
  const posted = [];
  const s = new EncodedStream({
    tools: { ffmpeg: 'ffmpeg', gpuFilters: new Set(['zscale', 'tonemap']) }, file: 'x.mkv', post: (m) => posted.push(m), log: () => {},
    remote, maxHeight: 1080, encoder, cpuEncoder: 'libx264', gpuSessions: createGpuSessions(8),
    probed: { duration: 60, audio: null, video: { index: 0, codec: 'hevc', pixFmt: 'yuv420p10le', width: 1920, height: 1080, fps: 25,
      ...(hdr ? { colorTransfer: 'smpte2084', colorPrimaries: 'bt2020' } : {}) } },
  });
  s.fps = 25;
  s.sizeVideo();
  const jobs = [];
  s.spawnJob = (argv) => { const p = fakeProc(); p.argv = argv; jobs.push(p); return p; };
  return { s, posted, jobs };
}

(async () => {
  { // Fast first picture: paused over a slow (or not yet measured) link; not while playing, locally or on a fast link.
    const { s } = make();
    const full = Math.round(1920 * 1080 * 0.1);
    assert.strictEqual(s.fastFirstBits(), Math.round(full * 8 * FAST_FIRST_SHARE), 'no link estimate yet: assume slow');
    s.link.fastKbps = s.link.slowKbps = 2000; // a 200 KB keyframe: 0.8 s
    assert.ok(s.fastFirstBits() > 0);
    s.keyBytes = 1000; // a measured keyframe at this size counts instead of the estimate...
    s.keyBytesFor = '1920x1080';
    assert.strictEqual(s.fastFirstBits(), 0, '...and 1 KB crosses 2 Mb/s in 4 ms');
    s.keyBytes = 0;
    s.link.fastKbps = s.link.slowKbps = 100000; // 200 KB in 16 ms
    assert.strictEqual(s.fastFirstBits(), 0, 'a fast link');
    s.link.fastKbps = s.link.slowKbps = 0;
    s.playing = true;
    assert.strictEqual(s.fastFirstBits(), 0, 'playing');
    s.playing = false;
    s.fastFirstHook = false; // the test hook (media/debug-probe.js pausedSharp)
    assert.strictEqual(s.fastFirstBits(), 0);
    s.fastFirstHook = true;
    s.link.fastKbps = s.link.slowKbps = 100000;
    assert.ok(s.fastFirstBits() > 0, 'on whatever the link');
    assert.strictEqual(make({ remote: false }).s.fastFirstBits(), 0, 'a local window');
    // The paused start's ffmpeg gets it, the first keyframe is marked small (not a full keyframe's size) and the log says so.
    const m = make();
    const launched = [];
    m.s.launch = (t, audio, opts) => { launched.push(opts); const p = fakeProc(); p.t = t; return p; };
    m.s.spawnVideo();
    assert.ok(launched[0] && launched[0].firstKeyBits > 0);
    assert.ok(m.s.proc.firstKeyBits > 0);
    m.s.playing = true;
    m.s.restartVideo(2);
    assert.strictEqual(launched[1], undefined, 'started while playing: a full first keyframe');
    m.s.dispose();
  }
  { // The keyframe size measured from what was sent, a small first one aside.
    const { s } = make();
    s.vAll.push({ t: 0, key: true, small: true, data: new Uint8Array(50) }, { t: 0.04, key: false, data: new Uint8Array(10) },
      { t: 0.5, key: true, data: new Uint8Array(900) }, { t: 1, key: true, data: new Uint8Array(400) });
    s.vNext = 0;
    s.more({ gen: 0, limit: 1e6 });
    assert.strictEqual(s.keyBytes, 900, 'the largest full keyframe: the ones after a small start are held down too');
    assert.strictEqual(s.keyBytesFor, '1920x1080');
    s.dispose();
  }
  { // The sharp frame: that frame alone (on the stream's frame grid), the sharp arguments, the stream's state untouched.
    const { s, posted, jobs } = make({ hdr: true });
    s.badTonemap.add('opencl');
    const live = s.args(10, false); // the stream's own start at frame 250 (10.000 s)
    s.args(0, false); // the live stream's pipeline, as recorded
    const before = [s.pipelineMode, s.tonemapKind, s.gpuDecode];
    s.pipelineMode = 'gpu-encode'; // what the live stream reports must stay, whatever the sharp encode builds
    s.sharp({ id: 3, t: 10.019 }); // within frame 250 at 25 fps
    assert.strictEqual(jobs.length, 1);
    const argv = jobs[0].argv;
    assert.strictEqual(argv[argv.indexOf('-ss') + 1], live[live.indexOf('-ss') + 1], 'frame 250 (10.000 s), as the stream would seek');
    assert.strictEqual(argv[argv.indexOf('-vf') + 1].split(',setpts')[0], live[live.indexOf('-vf') + 1].split(',setpts')[0], 'and keeps the same frames');
    assert.strictEqual(argv[argv.indexOf('-frames:v') + 1], '1');
    assert.strictEqual(argv[argv.indexOf('-crf') + 1], '11');
    assert.ok(argv.join(' ').includes('scale') && /tonemap/.test(argv.join(' ')), 'the stream\'s scale and tone-mapping');
    assert.ok(argv.join(' ').includes('1920') || argv.join(' ').includes('1080'), 'the stream\'s size');
    assert.strictEqual(s.pipelineMode, 'gpu-encode');
    assert.deepStrictEqual([s.tonemapKind, s.gpuDecode], before.slice(1));
    // Encoded: 250 KB goes out in pieces of 96 KiB, one per page request.
    const pic = Buffer.alloc(250 * 1024, 7);
    jobs[0].stdout.write(pic);
    await new Promise((r) => setImmediate(r));
    jobs[0].emit('close', 0, null);
    const pieces = [posted.pop()];
    assert.strictEqual(pieces[0].type, 'sharpFrame');
    assert.strictEqual(pieces[0].t, 10);
    assert.strictEqual(pieces[0].data.length, 96 * 1024);
    assert.strictEqual(pieces[0].data.buffer.byteLength, 96 * 1024, 'each piece in its own ArrayBuffer (the webview gets the whole buffer)');
    assert.strictEqual(pieces[0].done, false);
    s.sharpMore({ id: 99 }); // another request's: nothing
    assert.strictEqual(posted.length, 0);
    while (!pieces[pieces.length - 1].done) { s.sharpMore({ id: 3 }); pieces.push(posted.pop()); }
    assert.strictEqual(pieces.length, 3);
    assert.ok(Buffer.concat(pieces.map((p) => Buffer.from(p.data))).equals(pic));
    assert.strictEqual(pieces[2].total, pic.length);
    assert.strictEqual(s.sharping, null);
    s.dispose();
  }
  { // A page request before the encode ends waits for it; play, hide or a seek kill it and nothing is sent.
    const { s, posted, jobs } = make();
    s.sharp({ id: 1, t: 2 });
    s.sharpMore({ id: 1 });
    assert.strictEqual(posted.length, 0);
    jobs[0].stdout.write(Buffer.alloc(10, 1));
    await new Promise((r) => setImmediate(r));
    jobs[0].emit('close', 0, null);
    assert.strictEqual(posted.pop().done, true, 'sent when it ended');
    for (const stop of [(x) => x.handle({ type: 'playback', playing: true }), (x) => x.setHidden(true), (x) => x.seek({ gen: 2, t: 5 }),
      (x) => x.handle({ type: 'sharpStop' }), (x) => x.sharp({ id: 9, t: 3 })]) {
      const m = make();
      m.s.sharp({ id: 1, t: 2 });
      stop(m.s);
      assert.strictEqual(m.jobs[0].signalCode, 'SIGKILL', String(stop));
      await new Promise((r) => setImmediate(r));
      assert.ok(!m.posted.some((p) => p.type === 'sharpFrame' && p.id === 1), String(stop));
      m.s.dispose();
    }
    // Refused: while playing, or for a Direct Stream copy (the source's own pictures).
    const p = make();
    p.s.playing = true;
    p.s.sharp({ id: 1, t: 2 });
    assert.strictEqual(p.posted.pop().error, 'playing');
    const failing = make();
    failing.s.sharp({ id: 4, t: 1 });
    failing.jobs[0].stderr.write('bad things\n');
    await new Promise((r) => setImmediate(r));
    failing.jobs[0].emit('close', 1, null);
    failing.s.sharpMore({ id: 4 });
    assert.strictEqual(failing.posted.pop().error, 'bad things');
  }
  console.log('paused sharp: ok');
})().catch((e) => { console.error(e); process.exit(1); });
