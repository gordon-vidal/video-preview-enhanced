'use strict';
// Closing an HttpFile must settle every pending read at once (no waiter kept), also without range support.
const assert = require('assert');
const http = require('http');
const { HttpFile } = require('../../src/urlsource');

const within = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what}: still pending after ${ms} ms`)), ms))]);

(async () => {
  // Declares 128 bytes, sends 1, then stalls.
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Length': 128, 'Content-Type': 'video/mp4' });
    res.write(Buffer.alloc(1));
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/a.mp4`;
  try {
    // Whole-file path (no range support).
    const f = new HttpFile({ url, size: 128, rangeOk: false, head: Buffer.alloc(0) });
    const settled = f.read(0, 100).then(() => 'ok', (e) => e);
    await new Promise((r) => setTimeout(r, 200));
    assert.strictEqual(f.whole.waits.length, 1, 'the read is waiting');
    f.close();
    const e = await within(settled, 1000, 'pending read after close');
    assert(e instanceof Error && e.code === 'CLOSED', 'the pending read rejects with the closed error');
    assert.strictEqual(f.whole.waits.length, 0, 'no waiter retained');
    await assert.rejects(f.read(0, 100), (x) => x.code === 'CLOSED', 'new reads are rejected');
    f.close(); // idempotent

    // Range path: a read stalled mid-body is aborted by close, and later reads are rejected.
    const f2 = new HttpFile({ url, size: 128, rangeOk: true, head: Buffer.alloc(0) });
    const p2 = f2.read(0, 100).then(() => 'ok', (x) => x);
    await new Promise((r) => setTimeout(r, 200));
    f2.close();
    const e2 = await within(p2, 1000, 'pending range read after close');
    assert(e2 instanceof Error, 'the range read rejects');
    await assert.rejects(f2.read(0, 100), (x) => x.code === 'CLOSED');
  } finally {
    for (const s of sockets) s.destroy();
    server.close();
  }
  console.log('urlsource_close_test: ok');
})().catch((e) => { console.error(e); process.exit(1); });
