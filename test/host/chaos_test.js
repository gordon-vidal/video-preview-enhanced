'use strict';

const assert = require('node:assert/strict');
const { EventEmitter, once } = require('events');
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { makeStepping, makeFaults } = require('../media/make_heavy_media');
const { load, webviewConfig } = require('./mock_vscode');
const { createVirtualClock } = require('../lib/virtual-clock');
const { createLinkSimulator } = require('../../src/link-sim');

// Observe real children at the spawn boundary, including export's private subprocess.
const spawn = cp.spawn;
const children = [];
let killAfterOutput = false;
let killRepeats = 0; // more ffmpeg children after the next one that die the same way (a fault that comes back)
cp.spawn = (cmd, args, options) => {
  const fault = cmd === ffmpeg && killAfterOutput;
  if (fault) {
    if (killRepeats > 0) killRepeats--;
    else killAfterOutput = false;
  }
  const paced = fault ? ['-re', ...args] : args;
  const exportProgress = fault && !options.stdio;
  if (exportProgress) paced.unshift('-progress', 'pipe:1', '-stats_period', '0.05');
  const proc = spawn(cmd, paced, options);
  const record = { proc, closed: new Promise((resolve) => proc.once('close', resolve)), killed: false };
  children.push(record);
  if (fault) {
    let progress = '';
    let outputBytes = 0;
    const onOutput = (chunk) => {
      outputBytes += chunk.length;
      if (exportProgress) {
        progress = (progress + chunk).slice(-4096);
        if (!/out_time_(?:us|ms)=[1-9]/.test(progress)) return;
      }
      if (!fault(outputBytes)) return;
      proc.stdout.off('data', onOutput);
      record.killed = proc.kill('SIGKILL');
    };
    proc.stdout.on('data', onOutput);
  }
  return proc;
};
const ffmpeg = process.env.VPE_FFMPEG || 'ffmpeg';
const { NativeDecoder } = require('../../src/native');
const { EncodedStream } = require('../../src/stream');
const { inspectSource, makeClip } = require('../../src/clipexport');
cp.spawn = spawn;

const tools = { ffmpeg, ffprobe: ffmpeg.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1') };
const probed = { duration: 21, video: { index: 0, codec: 'h264', pixFmt: 'yuv420p', width: 192, height: 108, fps: 24 } };
const ignore = () => {};
const options = (file) => ({ tools, file, probed, log: ignore, post: ignore, postRaw: ignore });

async function killed(run, ready = () => true) {
  killAfterOutput = ready;
  const index = children.length;
  try {
    await run();
    const record = children[index];
    assert.ok(record?.killed, record?.proc.err?.text || 'injection must kill a child after it produces output');
    assert.notEqual(await record.closed, 0, 'injected child must exit unsuccessfully');
  } finally {
    killAfterOutput = false;
  }
}

async function streamFault(file) {
  const failures = [];
  const stream = new EncodedStream({ ...options(file), encoder: 'libx264', onFail: (why) => failures.push(why) });
  try {
    await killed(async () => {
      stream.open();
      await children.at(-1).closed;
    });
    assert.equal(failures.length, 1);
    assert.match(failures[0], /signal|exit/);
    assert.equal(stream.proc, null);
    stream.startAt(5);
    await once(stream.proc.stdout, 'data');
    assert.equal(failures.length, 1);
  } finally {
    stream.dispose();
  }
}

async function nativeFault(file, faults) {
  const failures = [];
  const output = new EventEmitter();
  const shown = [];
  const decoder = new NativeDecoder({
    ...options(file), largeGrid: true, onFail: (why) => failures.push(why),
    postRaw: (frame) => { if (frame.type === 'ndv') shown.push(frame.t); output.emit('frame', frame); },
  });
  try {
    // ffmpeg dies after its first picture (a crash, a GPU reset, the OOM killer): that is not the end of the file.
    // The decode goes on from the picture after the last one delivered, with the same method, and nothing fails.
    const spawned = children.length;
    await killed(async () => {
      await decoder.open();
      decoder.more({ gen: 0 });
      await children.at(-1).closed;
    }, (bytes) => bytes >= decoder.frameBytes);
    assert.equal(decoder.ended, false, 'an abnormal exit after output is not the end of the file');
    assert.deepEqual(failures, []);
    assert.ok(children.length > spawned + 1, 'ffmpeg started again after the loss');
    const before = shown.length;
    const resumed = once(output, 'frame');
    decoder.more({ gen: 0 });
    const [first] = await resumed;
    const expected = before ? shown[before - 1] + 1 / probed.video.fps : 0;
    assert.ok(Math.abs(first.t - expected) < 1e-6, `resumed at ${first.t}, expected ${expected} (after the last delivered picture)`);
    const next = once(output, 'frame');
    decoder.startAt(5, 1);
    const [frame] = await next;
    assert.equal(frame.type, 'ndv');
    assert.equal(frame.t, 5);
  } finally {
    decoder.dispose();
  }

  // The same loss again at the same spot after the restart: no endless restarts; it fails over as a decoder that never
  // produced output does (software decoding here, so the built-in decoder takes over via onFail).
  const again = new NativeDecoder({ ...options(file), largeGrid: true, onFail: (why) => failures.push(why) });
  try {
    killRepeats = 1;
    await killed(async () => {
      await again.open();
      await children.at(-1).closed;
      await children.at(-1).closed;
    }, (bytes) => bytes >= again.frameBytes);
    assert.equal(again.ended, false, 'a repeated loss is not the end of the file either');
    assert.equal(again.failed, true, 'a repeated loss at the same spot fails over');
    assert.equal(failures.length, 1);
  } finally {
    killRepeats = 0;
    again.dispose();
  }
  failures.length = 0;

  for (const malformed of Object.values(faults)) {
    const bad = new NativeDecoder({ ...options(malformed), onFail: (why) => failures.push(why) });
    const before = failures.length;
    try {
      await bad.open();
      await children.at(-1).closed;
      assert.equal(bad.failed, true, path.basename(malformed));
      assert.equal(failures.length, before + 1);
      assert.ok(failures.at(-1));
    } finally {
      bad.dispose();
    }
  }
}

async function exportFault(file, dir) {
  const source = await inspectSource(tools, file, { a: 0, b: 5, early: 0 });
  const output = path.join(dir, 'stage.mp4');
  const settings = { exact: false };
  await killed(() => assert.rejects(makeClip(tools, file, output, source, settings), /Native ffmpeg did not complete/));
  await fs.promises.rm(output, { force: true });
  await makeClip(tools, file, output, source, settings);
  assert.ok(fs.statSync(output).size > 0);
}

async function churn(file) {
  for (let i = 0; i < 12; i++) {
    const decoder = new NativeDecoder(options(file));
    try {
      const opening = decoder.open();
      if (i % 2) await opening;
      decoder.dispose();
      await opening;
      assert.equal(decoder.proc, null);
    } finally {
      decoder.dispose();
    }
  }
}

async function fileHandleChurn(file, dir) {
  const originalOpen = fs.promises.open;
  const closes = [];
  let openHandles = 0;
  fs.promises.open = async (name, ...args) => {
    const handle = await originalOpen(name, ...args);
    if (name !== file) return handle;
    openHandles++;
    const close = handle.close.bind(handle);
    handle.close = () => {
      const pending = close().then(() => { openHandles--; });
      closes.push(pending);
      return pending;
    };
    return handle;
  };
  const host = load({
    settings: { 'videoPreviewEnhanced.decoder': 'builtin',
      'videoPreviewEnhanced.ffmpegPath': path.join(dir, 'no-ffmpeg') },
  });
  try {
    for (let i = 0; i < 8; i++) {
      const session = host.open(file);
      try {
        await session.shown;
        const { page } = webviewConfig(session.panel.webview);
        const reads = [0, 4096, 8192].map((pos) => session.send({ type: 'readBlock', page, pos, len: 4096 }));
        if (i % 2) await Promise.all(reads);
        session.panel.dispose();
        const posted = session.posted.length;
        await Promise.all(reads);
        assert.equal(session.posted.length, posted, 'closed session sent a late block');
      } finally {
        session.panel.dispose();
      }
    }
    await Promise.all(closes);
    assert.ok(closes.length > 0, 'churn must open real file handles');
    assert.equal(openHandles, 0, 'file handles leaked across sessions');
  } finally {
    fs.promises.open = originalOpen;
    host.dispose();
  }
}

function linkFaults() {
  const seed = Number(process.env.VPE_FUZZ_SEED) || 20261124;
  let state = seed;
  const next = (n) => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0) % n;
  for (let burst = 0; burst < 24; burst++) {
    const clock = createVirtualClock();
    const period = 30 + next(50);
    const dark = 1 + next(period - 1);
    const errors = [];
    const link = createLinkSimulator({
      downMbps: 1, upMbps: 0.5, rttMs: 80, jitterMs: 20 + next(100),
      blackoutEveryMs: period, blackoutDurationMs: dark, seed: next(2 ** 32),
    }, { clock, onError: (error) => errors.push(error) });
    const closed = link.wrapChannel('closed');
    const live = link.wrapChannel('live');
    for (const direction of ['sendUp', 'sendDown']) {
      const expected = [];
      const received = [];
      for (let id = 0; id < 20; id++) {
        const bytes = Buffer.alloc(next(4096));
        closed[direction](bytes, () => assert.fail('closed channel delivered a packet'));
        const handle = live[direction](bytes, () => {
          assert.equal(link.stats().inBlackout, false);
          received.push(id);
        });
        if (next(5) === 0) handle.cancel();
        else expected.push(id);
      }
      closed.dispose();
      clock.runAll();
      assert.deepEqual(received, expected, `seed ${seed}, burst ${burst}, ${direction}`);
      assert.equal(live.pending(), 0);
    }
    live.sendDown('still queued', () => assert.fail('disposed link delivered a packet'));
    link.dispose();
    assert.equal(clock.pending(), 0);
    clock.runAll();
    assert.deepEqual(errors, []);
  }
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vpe-chaos-'));
  try {
    const { longGop } = makeStepping();
    linkFaults();
    await streamFault(longGop);
    await nativeFault(longGop, makeFaults(dir, longGop));
    await exportFault(longGop, dir);
    await churn(longGop);
    await fileHandleChurn(longGop, dir);
    await Promise.all(children.map(({ closed }) => closed));
    for (const { proc } of children) {
      assert.ok(proc.exitCode !== null || proc.signalCode !== null, 'child still alive');
      assert.ok(proc.stdio.every((pipe) => !pipe || pipe.destroyed), 'child pipe still open');
    }
    console.log(`chaos_test: link, stream, native, malformed media, export and churn passed (${children.length} children closed)`);
  } finally {
    for (const { proc } of children) {
      if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
    }
    await Promise.all(children.map(({ closed }) => closed));
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
