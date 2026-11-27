'use strict';
// node test/run.js unit --grep stream_fill: Live transcode, paused (src/stream.js fill / skipHeld) without ffmpeg: a fill
// behind the paused frame reports what it delivered, and every packet says which encode it came from, so the page's
// packets of one encode are never continued with another encode's frames.
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

function make() {
  const posted = [];
  const logs = [];
  const s = new EncodedStream({
    tools: { ffmpeg: 'ffmpeg', gpuFilters: new Set() }, file: 'x.mkv', post: (m) => posted.push(m), log: (l) => logs.push(l),
    remote: true, maxHeight: 1080, encoder: 'libx264', cpuEncoder: 'libx264', gpuSessions: createGpuSessions(8), warm: false,
    probed: { duration: 60, audio: null, video: { index: 0, codec: 'hevc', pixFmt: 'yuv420p', width: 1920, height: 1080, fps: 25 } },
  });
  s.fps = 25;
  s.sizeVideo();
  const jobs = [];
  s.spawnJob = (argv) => { const p = fakeProc(); p.argv = argv; jobs.push(p); return p; };
  const launched = [];
  s.launch = (t) => { const p = fakeProc(); p.t = t; launched.push(p); return p; };
  return { s, posted, logs, jobs, launched };
}

// Annex B access units as the encoder writes them (an access unit delimiter first).
const idr = Buffer.from([0, 0, 1, 9, 0xf0, 0, 0, 1, 0x67, 0x11, 0, 0, 1, 0x68, 0x11, 0, 0, 1, 0x65, 0x11]);
const inter = Buffer.from([0, 0, 1, 9, 0xf0, 0, 0, 1, 0x41, 0x22]);
const gop = (n) => Buffer.concat([idr, ...Array.from({ length: n - 1 }, () => inter)]);
const tick = () => new Promise((r) => setImmediate(r));

/** Pulls a fill to its end as the page does (fillMore after each piece). */
function pull(s, posted, id) {
  const out = [];
  for (let i = 0; i < 100; i++) {
    const m = posted.filter((x) => x.type === 'fillBatch' && x.id === id).at(-1);
    if (m && !out.includes(m)) out.push(m);
    if (m && m.done) return out;
    s.fillMore({ id });
  }
  throw new Error('the fill never ended');
}

(async () => {
  { // A fill whose ffmpeg stops part way: the page is told it failed, and only whole frames went out.
    const { s, posted, jobs } = make();
    s.fill({ id: 1, from: 2, to: 4 }); // 50 frames
    const job = jobs[0];
    job.stdout.write(Buffer.concat([gop(10), inter.subarray(0, 7)])); // 10 frames, then the start of one cut off
    await tick();
    job.stderr.write('Conversion failed!\n');
    await tick();
    job.emit('close', 1, null);
    const pieces = pull(s, posted, 1);
    const last = pieces.at(-1);
    assert.ok(last.done);
    assert.match(String(last.error), /Conversion failed|only/, 'a partial fill is reported, not a success');
    const frames = pieces.flatMap((m) => m.video);
    assert.strictEqual(frames.length, 10, `only the frames that arrived whole: ${frames.length}`);
    s.dispose();
  }
  { // Fewer frames than asked, though ffmpeg ended cleanly: reported short too.
    const { s, posted, jobs } = make();
    s.fill({ id: 2, from: 2, to: 4 });
    jobs[0].stdout.write(gop(20));
    await tick();
    jobs[0].emit('close', 0, null);
    const last = pull(s, posted, 2).at(-1);
    assert.ok(last.done && last.error, 'a short fill is not a success');
    s.dispose();
  }
  { // A whole fill: done without an error.
    const { s, posted, jobs } = make();
    s.fill({ id: 3, from: 2, to: 2.4 }); // 10 frames
    jobs[0].stdout.write(gop(10));
    await tick();
    jobs[0].emit('close', 0, null);
    const pieces = pull(s, posted, 3);
    assert.strictEqual(pieces.at(-1).error, undefined);
    assert.strictEqual(pieces.flatMap((m) => m.video).length, 10);
    s.dispose();
  }
  { // Every packet names its encode: the stream's run and each fill differ.
    const { s, posted, jobs, launched } = make();
    s.seek({ gen: 1, t: 4, playing: false, quick: false });
    assert.strictEqual(launched.length, 1);
    launched[0].stdout.write(gop(5));
    await tick();
    s.more({ gen: 1, limit: 1e6 });
    const sent = posted.filter((m) => m.type === 'batch').flatMap((m) => m.video);
    assert.ok(sent.length && sent.every((p) => p.enc !== undefined && p.enc === sent[0].enc), 'the stream\'s packets: one encode');
    s.fill({ id: 4, from: 2, to: 2.4 });
    jobs[0].stdout.write(gop(10));
    await tick();
    jobs[0].emit('close', 0, null);
    const fill = pull(s, posted, 4).flatMap((m) => m.video);
    assert.ok(fill.length && fill.every((p) => p.enc !== undefined && p.enc === fill[0].enc), 'the fill\'s: one encode');
    assert.notStrictEqual(fill[0].enc, sent[0].enc, 'another encode than the stream\'s');
    s.dispose();
  }
  console.log('stream fill: ok');
})().catch((e) => { console.error(e); process.exit(1); });
