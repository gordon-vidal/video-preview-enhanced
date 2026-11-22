'use strict';
// Localhost frame transport for native ffmpeg (docs/notes/native-transfer.md).
//
// postMessage from the extension host to a webview carried 150-460 MB/s (laptop / desktop) and
// kept the host thread 50-75 % busy at 4K (12.4 MB a frame). Here the host serves raw frames on
// 127.0.0.1 (random port, one shared server per extension host) and the webview reads them itself
// (~0-4 % of the host thread). Each decoder gets a channel: an unguessable path
// (/f/<id>/<32-byte token>) that accepts one connection at a time, as a streaming HTTP response
// (the default: fetch + BYOB reader) or a WebSocket (one binary message per record). Every
// record carries a 40-byte header (frameHeader). Requests need the token and the owning webview's
// exact Origin. Local windows only: in remote windows 127.0.0.1 is the remote
// machine, and the existing paths (postMessage, the remote stream) stay.

const http = require('http');
const crypto = require('crypto');
const { SRC_UNKNOWN, encodeSrc, decodeSrc } = require('./nativepts');

const HEADER = 40;
const MAGIC = 0x46455056; // 'VPEF' little-endian
const KIND_FRAME = 1;
const KIND_END = 2;
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

let serverP = null;
let port = 0;
const channels = new Map(); // id -> Channel

/** The shared server (started on first use). Rejects when 127.0.0.1 can't be bound. */
function start() {
  if (!serverP) {
    serverP = new Promise((resolve, reject) => {
      const srv = http.createServer(onRequest);
      srv.on('upgrade', onUpgrade);
      srv.on('clientError', (_e, sock) => sock.destroy());
      srv.once('error', reject);
      srv.listen(0, '127.0.0.1', () => {
        srv.removeListener('error', reject);
        srv.on('error', () => {});
        port = srv.address().port;
        srv.unref(); // never keeps the extension host alive
        resolve(srv);
      });
    });
    serverP.catch(() => { serverP = null; });
  }
  return serverP;
}

function stop() {
  const p = serverP;
  serverP = null;
  port = 0;
  for (const c of channels.values()) c.close();
  channels.clear();
  if (p) p.then((s) => s.close(), () => {});
}

/**
 * The 40-byte record header: magic, kind, gen, w, h, ys (luma bytes), t (float64), payload length, src.
 * src (int32): microseconds from t to the picture's own source timestamp (src/nativepts.js), the
 * minimum int32 when unknown. It was reserved (0) before, so the size and every other field stay put.
 */
function frameHeader(kind, gen, t, w, h, ys, len, src = NaN) {
  const b = Buffer.alloc(HEADER);
  b.writeUInt32LE(MAGIC, 0);
  b.writeUInt32LE(kind, 4);
  b.writeUInt32LE(gen >>> 0, 8);
  b.writeUInt32LE(w, 12);
  b.writeUInt32LE(h, 16);
  b.writeUInt32LE(ys, 20);
  b.writeDoubleLE(t, 24);
  b.writeUInt32LE(len, 32);
  b.writeInt32LE(encodeSrc(t, src), 36);
  return b;
}

function parseHeader(b) {
  if (b.length < HEADER || b.readUInt32LE(0) !== MAGIC) return null;
  return { kind: b.readUInt32LE(4), gen: b.readUInt32LE(8), w: b.readUInt32LE(12), h: b.readUInt32LE(16), ys: b.readUInt32LE(20), t: b.readDoubleLE(24), len: b.readUInt32LE(32), src: decodeSrc(b.readDoubleLE(24), b.readInt32LE(36)) };
}

/** WebSocket frame header for a server -> client binary message (unmasked) of n bytes. */
function wsHeader(n, opcode = 2) {
  if (n < 126) return Buffer.from([0x80 | opcode, n]);
  if (n < 65536) { const b = Buffer.alloc(4); b[0] = 0x80 | opcode; b[1] = 126; b.writeUInt16BE(n, 2); return b; }
  const b = Buffer.alloc(10);
  b[0] = 0x80 | opcode;
  b[1] = 127;
  b.writeUInt32BE(Math.floor(n / 2 ** 32), 2);
  b.writeUInt32BE(n >>> 0, 6);
  return b;
}

const sameToken = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

/** The channel a request names, or null (unknown id, wrong token, foreign origin). */
function channelFor(req) {
  const m = /^\/f\/([0-9a-f]{16})\/([0-9a-f]{64})$/.exec((req.url || '').split('?')[0]);
  const c = m && channels.get(m[1]);
  if (!c || !sameToken(c.token, m[2]) || req.headers.origin !== c.origin) return null;
  return c;
}

const cors = (c) => ({ 'Access-Control-Allow-Origin': c.origin, Vary: 'Origin' });

function onRequest(req, res) {
  if (req.method === 'OPTIONS') {
    // CORS / Private Network Access preflight: the answer reveals nothing without the token.
    const c = channelFor(req);
    if (c) res.writeHead(204, { ...cors(c), 'Access-Control-Allow-Methods': 'GET', 'Access-Control-Allow-Private-Network': 'true', 'Access-Control-Max-Age': '600' });
    else res.writeHead(403);
    res.end();
    return;
  }
  const c = req.method === 'GET' ? channelFor(req) : null;
  if (!c) { res.writeHead(403, { 'Content-Type': 'text/plain' }); res.end('forbidden'); return; }
  if (c.conn) { res.writeHead(409); res.end(); return; }
  res.writeHead(200, { ...cors(c), 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  if (res.flushHeaders) res.flushHeaders();
  c.attach({ kind: 'http', res, sock: req.socket });
}

function onUpgrade(req, sock) {
  const c = channelFor(req);
  const key = req.headers['sec-websocket-key'];
  if (!c || !key || String(req.headers.upgrade || '').toLowerCase() !== 'websocket') {
    sock.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    return;
  }
  if (c.conn) { sock.end('HTTP/1.1 409 Conflict\r\nConnection: close\r\n\r\n'); return; }
  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  // The client sends nothing but control frames (close, pong): read only to notice a close.
  sock.on('data', (d) => { if (d.length && (d[0] & 0x0f) === 8) sock.end(); });
  c.attach({ kind: 'ws', sock });
}

/**
 * One decoder's endpoint. onConnect(kind) when the webview connects, onLost(why) when an
 * established connection drops (not after close()).
 */
class Channel {
  constructor({ origin, onConnect, onLost, onClose, expiresIn }) {
    if (!/^vscode-webview:\/\/[a-z0-9-]+$/.test(origin)) throw new Error('Missing or invalid frame channel origin');
    this.id = crypto.randomBytes(8).toString('hex');
    this.token = crypto.randomBytes(32).toString('hex');
    this.origin = origin;
    this.onConnect = onConnect || (() => {});
    this.onLost = onLost || (() => {});
    this.onClose = onClose;
    this.conn = null;
    this.closed = false;
    channels.set(this.id, this);
    if (expiresIn) this.expiry = setTimeout(() => this.close(), expiresIn).unref();
  }

  /** URLs for the webview (the server must have started). */
  urls() {
    const p = `127.0.0.1:${port}/f/${this.id}/${this.token}`;
    return { http: `http://${p}`, ws: `ws://${p}` };
  }

  attach(conn) {
    if (this.closed || this.conn) { end(conn); return; }
    this.conn = conn;
    conn.sock.setNoDelay(true);
    const lost = (why) => {
      if (this.conn !== conn) return;
      this.conn = null;
      this.onLost(why);
    };
    conn.sock.on('close', () => lost('connection closed'));
    conn.sock.on('error', (e) => lost(e.message));
    this.onConnect(conn.kind);
  }

  get connected() { return !!this.conn && this.conn.sock.writable; }

  /** Bytes the socket hasn't taken yet (backpressure). */
  get buffered() { return this.conn ? this.conn.sock.writableLength : 0; }

  /**
   * One record: header + payload (a Buffer, or a list of Buffers written as they are, or null).
   * Corked, so the pieces leave in one writev. False when not connected.
   */
  send(kind, gen, t, w, h, ys, payload, src = NaN) {
    if (!this.connected) return false;
    const parts = !payload ? [] : Array.isArray(payload) ? payload : [payload];
    const len = parts.reduce((n, p) => n + p.length, 0);
    const head = frameHeader(kind, gen, t, w, h, ys, len, src);
    const c = this.conn;
    const out = c.kind === 'ws' ? c.sock : c.res;
    out.cork();
    out.write(c.kind === 'ws' ? Buffer.concat([wsHeader(HEADER + len), head]) : head);
    for (const p of parts) if (p.length) out.write(p);
    out.uncork();
    return true;
  }

  /** src: the picture's own timestamp (s, same origin as t), when ffmpeg reported it. */
  sendFrame(gen, t, w, h, ys, data, src = NaN) { return this.send(KIND_FRAME, gen, t, w, h, ys, data, src); }

  sendEnd(gen) { return this.send(KIND_END, gen, 0, 0, 0, 0, null); }

  /** Calls fn once the socket has taken what is buffered. */
  onDrain(fn) {
    if (!this.conn || !this.conn.sock.writableLength) { fn(); return; }
    this.conn.sock.once('drain', fn);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.expiry);
    channels.delete(this.id);
    const c = this.conn;
    this.conn = null;
    if (c) end(c);
    const onClose = this.onClose;
    this.onConnect = this.onLost = this.onClose = null;
    if (onClose) onClose();
  }
}

function end(conn) {
  try {
    if (conn.kind === 'ws') { conn.sock.end(Buffer.from([0x88, 0])); } else conn.res.end();
  } catch { /* gone */ }
  setTimeout(() => conn.sock.destroy(), 200).unref();
}

module.exports = { start, stop, Channel, frameHeader, parseHeader, wsHeader, HEADER, MAGIC, SRC_UNKNOWN, KIND_FRAME, KIND_END, get port() { return port; } };
