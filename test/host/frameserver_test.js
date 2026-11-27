'use strict';
// node test/host/frameserver_test.js: the localhost frame server (src/frameserver.js) that carries
// native frames to the webview: records over a streaming HTTP response and over a WebSocket,
// 403 for a wrong token or a foreign origin, onLost when the reader goes away. Plus
// NativeDecoder's automatic fallback to postMessage when the webview never connects.
const assert = require('assert');
const { once } = require('events');
const disk = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('../../src/frameserver');
const { NativeDecoder } = require('../../src/native');
const { load } = require('./mock_vscode');

const origin = 'vscode-webview://abc';
const owner = { Origin: origin };
const request = (url, headers, method = 'GET') => new Promise((resolve, reject) => {
  const req = http.request(url, { method, headers }, resolve).on('error', reject);
  req.on('upgrade', (res, sock, head) => {
    if (head.length) sock.unshift(head);
    resolve(res);
  });
  req.end();
});
const get = (url, headers = {}) => request(url, headers);
const upgrade = (url, headers) => request(url.replace(/^ws:/, 'http:'), {
  ...headers, Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': Buffer.alloc(16).toString('base64'), 'Sec-WebSocket-Version': '13',
});

/** Reads n records from a stream of chunks (header + payload each). */
function readRecords(stream, n) {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const out = [];
    stream.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        const h = fs.parseHeader(buf);
        if (!h || buf.length < fs.HEADER + h.len) break;
        out.push({ ...h, data: buf.subarray(fs.HEADER, fs.HEADER + h.len) });
        buf = buf.subarray(fs.HEADER + h.len);
        if (out.length === n) { resolve(out); return; }
      }
    });
    stream.on('error', reject);
    stream.on('end', () => reject(new Error(`stream ended after ${out.length} records`)));
  });
}

async function interruptedBenchmarks() {
  const file = path.join(os.tmpdir(), `vpe_benchfs_${process.pid}.mkv`);
  const log = `${file}.log`;
  disk.writeFileSync(file, Buffer.alloc(1));
  const h = load({ env: { VPE_LOG: log }, settings: { 'videoPreviewEnhanced.decoder': 'builtin' } });
  const s = h.open(file);
  const bench = async () => {
    const from = s.posted.length;
    disk.appendFileSync(`${log}.cmd`, JSON.stringify({ benchFs: 'http', size: 3110400, count: 180 }) + '\n');
    await s.until((posted) => posted.slice(from).some((m) => m.type === 'benchFs'));
    return s.posted.slice(from).find((m) => m.type === 'benchFs').url;
  };
  try {
    await s.shown;
    assert.ok(s.panel.webview.html.includes(`http://127.0.0.1:${fs.port}`), 'CSP permits the selected port');
    assert.ok(!s.panel.webview.html.includes('127.0.0.1:*'), 'CSP has no wildcard port');
    await s.send({ type: 'ready', origin });
    const dropped = await bench();
    const res = await get(dropped, owner);
    assert.strictEqual(res.statusCode, 200);
    const closed = once(res, 'close');
    res.destroy(); // stop reading while the benchmark waits for drain
    await closed;
    await new Promise((r) => setTimeout(r, 100));
    assert.strictEqual((await get(dropped, owner)).statusCode, 403, 'disconnect closed the benchmark channel');

    // VS Code recreated the document (a second 'ready' from the same page): its waiting channel closes.
    const reloaded = await bench();
    await s.send({ type: 'ready', origin, boot: 'document-2' });
    assert.strictEqual((await get(reloaded, owner)).statusCode, 403, 'a new document closed a waiting channel');
    const disposed = await bench();
    s.panel.dispose();
    assert.strictEqual((await get(disposed, owner)).statusCode, 403, 'disposal closed a waiting channel');
  } finally {
    s.panel.dispose();
    h.dispose();
    for (const f of [file, log, `${log}.cmd`]) disk.rmSync(f, { force: true });
  }
}

(async () => {
  await fs.start();
  assert.ok(fs.port > 0, 'listening');

  // HTTP stream: two frames and the end, in order.
  let connected = null;
  let lost = null;
  const ch = new fs.Channel({ origin, onConnect: (k) => { connected = k; }, onLost: (w) => { lost = w; } });
  const res = await get(ch.urls().http, owner);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.headers['access-control-allow-origin'], origin);
  assert.strictEqual(connected, 'http');
  assert.strictEqual((await get(ch.urls().http, owner)).statusCode, 409, 'second HTTP reader');
  assert.strictEqual((await upgrade(ch.urls().ws, owner)).statusCode, 409, 'second WebSocket reader');
  const frame = Buffer.alloc(1920 * 1080 * 1.5, 9);
  assert.ok(ch.sendFrame(3, 1.5, 1920, 1080, 1920 * 1080, frame));
  assert.ok(ch.sendFrame(3, 1.5 + 1 / 30, 1920, 1080, 1920 * 1080, frame));
  assert.ok(ch.sendEnd(3));
  const recs = await readRecords(res, 3);
  assert.deepStrictEqual(recs.map((r) => [r.kind, r.gen, r.w, r.h, r.len]), [[1, 3, 1920, 1080, frame.length], [1, 3, 1920, 1080, frame.length], [2, 3, 0, 0, 0]]);
  assert.strictEqual(recs[0].t, 1.5);
  assert.ok(recs[1].data.every((x) => x === 9), 'payload intact');
  res.destroy();
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(lost, 'onLost after the reader went away');
  assert.strictEqual(ch.connected, false);
  ch.close();

  // Wrong token, foreign origin, unknown channel: 403.
  const ch2 = new fs.Channel({ origin });
  const bad = ch2.urls().http.replace(/[0-9a-f]{64}$/, '0'.repeat(64));
  assert.strictEqual((await get(bad, owner)).statusCode, 403, 'wrong token');
  assert.strictEqual((await get(ch2.urls().http, { Origin: 'https://evil.example' })).statusCode, 403, 'foreign origin');
  assert.strictEqual((await get(ch2.urls().http, { Origin: 'vscode-webview://other' })).statusCode, 403, 'different webview');
  assert.strictEqual((await get(ch2.urls().http)).statusCode, 403, 'missing Origin');
  assert.strictEqual((await request(ch2.urls().http, {}, 'OPTIONS')).statusCode, 403, 'preflight must match the owner');
  assert.strictEqual((await request(ch2.urls().http, owner, 'OPTIONS')).statusCode, 204, 'owner preflight');
  ch2.close();
  assert.strictEqual((await get(ch2.urls().http, owner)).statusCode, 403, 'closed channel');

  // WebSocket upgrade is subject to the same origin check and carries one record per message.
  const ch3 = new fs.Channel({ origin });
  assert.strictEqual((await upgrade(ch3.urls().ws, {})).statusCode, 403, 'WebSocket requires Origin');
  const ws = await upgrade(ch3.urls().ws, owner);
  assert.strictEqual(ws.statusCode, 101);
  const small = Buffer.alloc(6, 5);
  assert.ok(ch3.sendFrame(1, 0, 2, 2, 4, small));
  assert.ok(ch3.sendEnd(1));
  const expected = Buffer.concat([fs.wsHeader(fs.HEADER + small.length), fs.frameHeader(1, 1, 0, 2, 2, 4, small.length), small,
    fs.wsHeader(fs.HEADER), fs.frameHeader(2, 1, 0, 0, 0, 0, 0)]);
  const chunks = [];
  for await (const data of ws.socket) {
    chunks.push(data);
    if (Buffer.concat(chunks).length >= expected.length) break;
  }
  assert.deepStrictEqual(Buffer.concat(chunks), expected);
  ch3.close();

  // An unconnected channel expires and calls its owner's cleanup once.
  let closes = 0;
  const expiring = new fs.Channel({ origin, expiresIn: 10, onClose: () => closes++ });
  await new Promise((r) => setTimeout(r, 30));
  assert.strictEqual((await get(expiring.urls().http, owner)).statusCode, 403, 'expired channel');
  expiring.close();
  assert.strictEqual(closes, 1);

  // NativeDecoder: a rejected negotiation picks the message cap before starting ffmpeg.
  const posted = [];
  const nd = new NativeDecoder({ origin, tools: {}, file: 'x', probed: { video: { width: 3840, height: 2160 } },
    post: (m) => { posted.push(m); if (m.type === 'link') nd.handle({ type: 'transport', failed: 'HTTP 403' }); },
    postRaw() {}, log() {}, transport: 'http', maxHeight: 2160, messageMaxHeight: 1080 });
  nd.startAt = (t) => assert.strictEqual(t, 0);
  await nd.open();
  assert.strictEqual(nd.link, 'message');
  assert.deepStrictEqual(posted.map((m) => m.type), ['link', 'streams']);
  assert.strictEqual(posted[1].info.video.height, 1080);
  nd.dispose();
  // 'message' never opens a channel.
  assert.strictEqual(await new NativeDecoder({ tools: {}, file: 'x', post() {}, postRaw() {}, log() {} }).openChannel(), null);

  await interruptedBenchmarks();
  console.log('frameserver: ok');
})().catch((e) => { console.error(e); process.exit(1); });
