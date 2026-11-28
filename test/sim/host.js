'use strict';

const assert = require('node:assert/strict');
const cp = require('node:child_process');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { createLinkSimulator } = require('../../src/link-sim');
const { createGpuSessions } = require('../../src/gpu-sessions');
const { createVirtualClock } = require('../lib/virtual-clock');

let spawnScript;
const spawn = cp.spawn;
let EncodedStream, NativeDecoder;
try {
  cp.spawn = (cmd, args, options) => spawnScript(cmd, args, options);
  ({ EncodedStream } = require('../../src/stream'));
  ({ NativeDecoder } = require('../../src/native'));
  require('../../src/unified-viewer');
} finally {
  cp.spawn = spawn;
}

class FakeHostPage {
  constructor(clock) {
    this.clock = clock;
    this.received = [];
    this.dropped = [];
    this.gen = 0;
    this.seekId = { fill: null, sharp: null };
    this.link({ downMbps: 100, upMbps: 100, rttMs: 2 });
  }

  link(spec) {
    if (this.linkSim) {
      assert.equal(this.channel.pending(), 0, 'change link speed between transfers');
      this.linkSim.dispose();
    }
    this.linkSim = createLinkSimulator(spec, { clock: this.clock });
    this.channel = this.linkSim.wrapChannel('preview');
  }

  send(message) {
    const { type } = message;
    if (type === 'seek') {
      this.gen = message.gen;
      this.seekId = { fill: null, sharp: null };
    }
    if (type === 'fill' || type === 'sharp') this.seekId[type] = message.id;
    this.channel.sendUp(message, () => {
      this.jobs.push(this.decoder.handle(message));
    });
  }

  post = (message) => {
    this.channel.sendDown(message, () => {
      const kind = { fillBatch: 'fill', sharpFrame: 'sharp' }[message.type];
      const stale = (message.gen !== undefined && message.gen !== this.gen)
        || (kind && message.id !== this.seekId[kind]);
      (stale ? this.dropped : this.received).push(message);
    });
  };

  messages(type) {
    return this.received.filter((m) => m.type === type);
  }

  async advance(ms) {
    this.clock.advance(ms);
    await Promise.all(this.jobs.splice(0));
    await new Promise((resolve) => setImmediate(resolve));
  }

  jobs = [];
}

function fakeProcess(clock, args, stdio) {
  const proc = new EventEmitter();
  proc.args = args;
  proc.stdio = stdio.map(() => new PassThrough());
  [proc.stdin, proc.stdout, proc.stderr] = proc.stdio;
  proc.exitCode = proc.signalCode = null;
  const pending = new Set();
  const schedule = (ms, fn) => {
    const timer = clock.setTimeout(() => { pending.delete(timer); fn(); }, ms);
    pending.add(timer);
  };
  const close = (code, signal) => {
    for (const timer of pending) clock.clearTimeout(timer);
    pending.clear();
    proc.exitCode = code;
    proc.signalCode = signal;
    clock.setTimeout(() => proc.emit('close', code, signal), 0);
  };
  proc.output = (ms, bytes, fd = 1) => schedule(ms, () => proc.stdio[fd].write(bytes));
  proc.exit = (ms, code = 0) => schedule(ms, () => close(code, null));
  proc.kill = (signal = 'SIGTERM') => {
    if (proc.exitCode === null && !proc.signalCode) close(null, signal);
  };
  return proc;
}

async function withHost({ native = false, audio = false, options = {}, script = () => {} } = {}, run) {
  const clock = createVirtualClock(100_000);
  const page = new FakeHostPage(clock);
  const processes = [];
  const failures = [];
  const saved = { setTimeout, clearTimeout, now: Date.now };
  assert.equal(spawnScript, undefined, 'run simulator journeys serially');
  spawnScript = (cmd, args, { stdio }) => {
    assert.equal(cmd, 'fake-ffmpeg');
    const proc = fakeProcess(clock, args, stdio);
    processes.push(proc);
    script(proc, processes);
    return proc;
  };
  Object.assign(global, { setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
  Date.now = clock.now;
  try {
    const opts = {
      tools: { ffmpeg: 'fake-ffmpeg', gpuFilters: new Set() },
      file: 'fixture.mkv', post: page.post, postRaw: page.post, log() {},
      onFail: (reason) => failures.push(reason),
      maxHeight: 1080, messageMaxHeight: 1080, transport: 'message',
      fitView: true, encoder: 'libx264', gpuSessions: createGpuSessions(8), warm: false,
      probed: {
        duration: 90, formatName: 'matroska,webm',
        video: { index: 0, codec: 'hevc', width: 1920, height: 1080, pixFmt: 'yuv420p', fps: 25,
          cfr: true, fileStart: 0, startTime: 0 },
        audio: audio ? { index: 1, codec: 'aac', sampleRate: 48000, channels: 2 } : null,
      },
      ...options,
    };
    page.decoder = native ? new NativeDecoder(opts) : new EncodedStream(opts);
    await run({ page, processes, clock, spawn: spawnScript, createNative: (opts) => new NativeDecoder(opts) });
    assert.deepEqual(failures, []);
  } finally {
    try {
      page.linkSim.dispose();
      page.decoder?.dispose();
      await page.advance(0);
      assert.ok(processes.every((p) => p.exitCode !== null || p.signalCode), 'all fake children stopped');
      assert.equal(clock.pending(), 0, 'all timers cleared');
    } finally {
      Date.now = saved.now;
      Object.assign(global, { setTimeout: saved.setTimeout, clearTimeout: saved.clearTimeout });
      spawnScript = undefined;
    }
  }
}

const idr = Buffer.from([0, 0, 1, 9, 0xf0, 0, 0, 1, 0x67, 0x11, 0, 0, 1, 0x68, 0x11, 0, 0, 1, 0x65, 0x11]);
const inter = Buffer.from([0, 0, 1, 9, 0xf0, 0, 0, 1, 0x41, 0x22]);
const gop = (n) => Buffer.concat([idr, ...Array(n - 1).fill(inter)]);
function arg(proc, name) {
  const at = proc.args.indexOf(name);
  return at < 0 ? undefined : proc.args[at + 1];
}

module.exports = { withHost, idr, inter, gop, arg };
