'use strict';
// Preload for test/pool/worker-shim.js (workerData.preload): a stand-in for WebCodecs' VideoDecoder in the
// thumbnail worker. It "decodes" in presentation order with a reorder delay of a few chunks like H.264 with B-frames,
// counts what it made and closed, and fails on purpose when workerData.fake says so:
//   { none: true }            no VideoDecoder at all
//   { unsupported: true }     isConfigSupported says no
//   { failAfter: n }          the error callback after n chunks (once per worker)
// Pictures it makes are posted as plain {fake: 'bmp', width, height} (worker_threads cannot transfer them).
const { workerData } = require('worker_threads');

const o = workerData.fake || {};
const counts = { decoders: 0, closedDecoders: 0, chunks: 0, firstType: [], frames: 0, closedFrames: 0, bitmaps: 0, configs: [] };
globalThis.fakeCounts = counts;

class FakeFrame {
  constructor(ts) { this.timestamp = ts; this.displayWidth = 320; this.displayHeight = 180; this.closed = false; counts.frames++; }
  close() { if (!this.closed) { this.closed = true; counts.closedFrames++; } }
}

class FakeBitmap {
  constructor(w, h) { this.width = w; this.height = h; counts.bitmaps++; }
  close() {}
}

let failed = false;
class FakeDecoder extends EventTarget {
  constructor(init) {
    super();
    this.init = init;
    this.state = 'unconfigured';
    this.decodeQueueSize = 0;
    this.held = [];
    this.n = 0;
    counts.decoders++;
  }
  static async isConfigSupported(c) { return { supported: !o.unsupported, config: c }; }
  configure(c) { this.state = 'configured'; counts.configs.push(c); }
  decode(chunk) {
    if (this.state !== 'configured') throw new Error('decode: not configured');
    if (this.n === 0) counts.firstType.push(chunk.type);
    this.n++;
    counts.chunks++;
    if (o.failAfter && !failed && counts.chunks >= o.failAfter) {
      failed = true;
      setTimeout(() => { this.state = 'closed'; this.init.error(new Error('fake decode error')); }, 0);
      return;
    }
    this.held.push(chunk.timestamp);
    this.held.sort((a, b) => a - b);
    this.decodeQueueSize++;
    setTimeout(() => {
      this.decodeQueueSize--;
      this.dispatchEvent(new Event('dequeue'));
      if (this.state === 'configured' && this.held.length > 3) this.init.output(new FakeFrame(this.held.shift()));
    }, 0);
  }
  async flush() {
    await new Promise((r) => setTimeout(r, 1));
    if (this.state !== 'configured') throw new Error('flush: closed');
    while (this.held.length) this.init.output(new FakeFrame(this.held.shift()));
  }
  close() { if (this.state !== 'closed') counts.closedDecoders++; this.state = 'closed'; this.held = []; }
}

if (!o.none) {
  globalThis.VideoDecoder = FakeDecoder;
  globalThis.EncodedVideoChunk = class { constructor(c) { this.type = c.type; this.timestamp = c.timestamp; this.byteLength = c.data.byteLength; } };
  globalThis.createImageBitmap = async (src, opt) => {
    if (src.closed) throw new Error('createImageBitmap: closed frame');
    await new Promise((r) => setTimeout(r, 0));
    return new FakeBitmap(opt.resizeWidth, opt.resizeHeight);
  };
}

const post = globalThis.postMessage;
globalThis.postMessage = (m, transfer) => {
  const plain = (b) => (b instanceof FakeBitmap ? { fake: 'bmp', width: b.width, height: b.height } : b);
  if (m && m.type === 'thumb') {
    if (m.bmp) m.bmp = plain(m.bmp);
    if (m.more) m.more = m.more.map((x) => (x.bmp ? { ...x, bmp: plain(x.bmp) } : x));
    m.fake = { ...counts, firstType: counts.firstType.slice(), configs: counts.configs.length };
  }
  post(m, (transfer || []).filter((x) => !(x instanceof FakeBitmap)));
};
