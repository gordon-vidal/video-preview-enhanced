'use strict';
// Drives media/decoder-worker.js (or media/pool.js) in Node worker_threads the way
// engine.js does, with an await-able API for tests: open, pull batches, seek, send.
const fs = require('fs');
const path = require('path');
const { Worker: WT } = require('worker_threads');

const root = path.resolve(__dirname, '..', '..');
const media = path.join(root, 'media');
const shim = path.join(root, 'test', 'pool', 'worker-shim.js');
const workerScript = path.join(media, 'decoder-worker.js');

// Every thread still running, so a test file can stop and join them before it exits (shutdownWorkers).
const live = new Set();

if (!globalThis.Worker) {
  globalThis.Worker = class {
    constructor() {
      this.w = new WT(shim, { workerData: { script: workerScript } });
      live.add(this.w);
      this.w.on('exit', () => live.delete(this.w));
      this.w.on('message', (d) => this.onmessage && this.onmessage({ data: d }));
      this.w.on('error', (e) => this.onerror && this.onerror(e));
    }
    postMessage(m, transfer) { this.w.postMessage(m, transfer || []); }
    terminate() { this.w.terminate(); }
  };
  require(path.join(media, 'pool.js'));
}

const libdir = path.join(media, 'libav-vpe');
const initMsg = {
  type: 'init', loader: path.join(libdir, 'libav-6.11.9.0.2-vpe.js'), toImport: path.join(libdir, 'libav-6.11.9.0.2-vpe.wasm.js'),
  wasmurl: path.join(libdir, 'libav-6.11.9.0.2-vpe.wasm.wasm'), variant: 'vpe',
};

/**
 * Terminates the decoder threads still alive and waits (at most `ms`) until each has really exited. A worker
 * that engine.dispose() / pool.terminate() only asked to stop can still be tearing down its WebAssembly instance
 * when the file calls process.exit(); exiting then has hung (STALLED after the summary line), so a file joins them
 * first. Returns how many did not exit in time (their stop is then logged, and the caller exits anyway).
 */
async function shutdownWorkers(ms = 5000) {
  const threads = [...live];
  await Promise.race([
    Promise.all(threads.map((w) => w.terminate())),
    new Promise((r) => setTimeout(r, ms).unref()),
  ]);
  const left = threads.filter((w) => live.has(w)).length;
  if (left) console.log(`warning: ${left} decoder thread(s) did not exit within ${ms} ms`);
  return left;
}

/** Hash of the visible samples (as test/pool/harness.js). */
function hashFrame(v) {
  let h = 2166136261;
  const bps = (v.depth || 8) > 8 ? 2 : 1;
  const cw = v.cw === undefined ? 1 : v.cw;
  const chh = v.ch === undefined ? 1 : v.ch;
  for (let p = 0; p < 3; p++) {
    const w = (p ? (v.width + (1 << cw) - 1) >> cw : v.width) * bps;
    const hh = p ? (v.height + (1 << chh) - 1) >> chh : v.height;
    const { offset, stride } = v.layout[p];
    for (let y = 0; y < hh; y += 3) {
      const row = offset + y * stride;
      for (let x = (y * 7) % 13; x < w; x += 13) h = Math.imul(h ^ v.data[row + x], 16777619);
    }
  }
  return (h >>> 0).toString(16);
}

class Session {
  /**
   * @param {string} file
   * @param {{pool?: boolean, workers?: number, video?: 'auto'|'soft'|'webcodecs', audio?: 'soft'|'webcodecs', keepStreams?: boolean, log?: boolean}} o
   */
  constructor(file, o = {}) {
    this.file = file;
    this.o = o;
    this.size = fs.statSync(file).size;
    this.fd = fs.openSync(file, 'r');
    this.w = o.pool ? new globalThis.DecoderPool('decoder-worker.js', { multiRead: true, workers: o.workers, log: true }) : new globalThis.Worker('decoder-worker.js');
    this.gen = 0;
    this.waiters = [];
    this.inbox = [];
    this.logs = [];
    this.errors = [];
    this.subs = []; // every 'subs' message
    this.readBytes = 0;
    this.reads = 0;
    this.w.onerror = (e) => this.errors.push(String(e && e.message));
    this.w.onmessage = (e) => this.onMsg(e.data);
  }

  onMsg(m) {
    if (m.type === 'read') {
      setImmediate(() => {
        if (this.closed) return;
        const n = Math.max(0, Math.min(m.len, this.size - m.pos));
        const buf = Buffer.alloc(n);
        if (n) fs.readSync(this.fd, buf, 0, n, m.pos);
        this.readBytes += n;
        this.reads++;
        this.w.postMessage({ type: 'block', pos: m.pos, data: new Uint8Array(buf.buffer, buf.byteOffset, n), rid: m.rid });
      });
      return;
    }
    if (m.type === 'log') { this.logs.push(m.msg); if (this.o.log) console.log(`    ${m.msg}`); return; }
    if (m.type === 'error') this.errors.push(`${m.where}: ${m.message}`);
    if (m.type === 'subs') this.subs.push(m);
    if (m.type === 'ready') { this.w.postMessage({ type: 'open', size: this.size }); return; }
    this.inbox.push(m);
    this.flush();
  }

  flush() {
    for (let i = 0; i < this.waiters.length; i++) {
      const wt = this.waiters[i];
      const k = this.inbox.findIndex(wt.pred);
      if (k >= 0) {
        const [m] = this.inbox.splice(k, 1);
        this.waiters.splice(i--, 1);
        wt.res(m);
      }
    }
  }

  wait(pred, ms = 120e3) {
    return new Promise((res, rej) => {
      const wt = { pred, res };
      this.waiters.push(wt);
      setTimeout(() => { const i = this.waiters.indexOf(wt); if (i >= 0) { this.waiters.splice(i, 1); rej(new Error(`timeout waiting (${this.errors.join('; ')})`)); } }, ms).unref();
      this.flush();
    });
  }

  async open() {
    this.w.postMessage(initMsg);
    const s = await this.wait((m) => m.type === 'streams' || m.type === 'error');
    if (s.type === 'error') throw new Error(s.message);
    this.info = s.info;
    const v = s.info.video;
    let video = 'none';
    if (v) video = this.o.video && this.o.video !== 'auto' ? this.o.video : /^(h264|vp8)$/.test(v.codec) ? 'webcodecs' : 'soft';
    this.w.postMessage({ type: 'config', video, audio: s.info.audio ? (this.o.audio || 'soft') : 'none', deep: true, keepStreams: !!this.o.keepStreams });
    this.configured = await this.wait((m) => m.type === 'configured');
    return this;
  }

  /** One 'more' round trip: the batch of the current gen. */
  async more(limit = 96 * 1024) {
    for (;;) {
      this.w.postMessage({ type: 'more', gen: this.gen, limit });
      const b = await this.wait((m) => m.type === 'batch');
      if (b.gen === this.gen) return b;
    }
  }

  async seek(t, fast = false) {
    this.gen++;
    this.w.postMessage({ type: 'seek', gen: this.gen, t, fast });
    await this.wait((m) => m.type === 'seeked' && m.gen === this.gen);
  }

  send(m) { this.w.postMessage(m); }

  close() {
    this.closed = true;
    this.w.terminate();
    fs.closeSync(this.fd);
  }
}

module.exports = { Session, hashFrame, shutdownWorkers };
