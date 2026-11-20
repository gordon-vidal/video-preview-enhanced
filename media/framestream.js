// @ts-check
'use strict';
// Raw frames from the extension host's localhost frame server (src/frameserver.js), read by the
// webview itself instead of arriving as postMessage. Modes:
//   http  a streaming fetch read with a BYOB reader straight into one buffer per record; the
//         buffers come back (recycle) once the renderer has uploaded them
//         (Reading in a worker and transferring the frames was tried: no faster, and its fetch
//         once failed to connect within 3 s in playback. docs/notes/native-transfer.md)
//   ws    a WebSocket, one binary message per record (the browser assembles it)
// Every record starts with a 40-byte little-endian header: magic 'VPEF', kind (1 frame, 2 end
// of stream), gen, w, h, ys, t (float64), payload length, reserved.
// eslint-disable-next-line no-unused-vars
const FrameStream = (() => {
  const HEADER = 40;
  const MAX_POOL = 4;

  /** Reads records from a fetch body: (url, take(len) -> reusable buffer or null, onOpen(), onRecord(head, buf), signal). */
  async function readHttp(url, take, onOpen, onRecord, signal) {
    const MAGIC = 0x46455056;
    const res = await fetch(url, { cache: 'no-store', signal });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    onOpen();
    /** @type {any} */
    const reader = res.body.getReader({ mode: 'byob' });
    // Reads exactly n bytes into buf (detached and handed back by each read).
    const fill = async (buf, n) => {
      let off = 0;
      while (off < n) {
        const { value, done } = await reader.read(new Uint8Array(buf, off, n - off));
        if (done) throw new Error('frame stream ended');
        buf = value.buffer;
        off += value.byteLength;
      }
      return buf;
    };
    let hb = new ArrayBuffer(HEADER);
    for (;;) {
      hb = await fill(hb, HEADER);
      const dv = new DataView(hb);
      if (dv.getUint32(0, true) !== MAGIC) throw new Error('frame stream: bad record header');
      const head = { kind: dv.getUint32(4, true), gen: dv.getUint32(8, true), w: dv.getUint32(12, true), h: dv.getUint32(16, true), ys: dv.getUint32(20, true), t: dv.getFloat64(24, true), len: dv.getUint32(32, true) };
      const buf = head.len ? await fill(take(head.len) || new ArrayBuffer(head.len), head.len) : new ArrayBuffer(0);
      onRecord(head, buf);
    }
  }

  /**
   * opts: { mode: 'ws'|'http', url, onOpen(), onRecord(head, data: Uint8Array, owned: boolean),
   * onClose(error|null) (not after close()) }.
   * Returns { close(), recycle(ArrayBuffer) }: give an owned record's buffer back for reuse.
   * owned: the data's buffer holds only this payload.
   */
  function open(opts) {
    let closed = false;
    const done = (err) => { if (!closed) { closed = true; opts.onClose(err || null); } };
    if (opts.mode === 'ws') {
      const ws = new WebSocket(opts.url);
      ws.binaryType = 'arraybuffer';
      ws.onopen = () => { if (!closed) opts.onOpen(); };
      ws.onmessage = (e) => {
        if (closed) return;
        try {
          const ab = /** @type {ArrayBuffer} */ (e.data);
          const dv = new DataView(ab, 0, HEADER);
          if (dv.getUint32(0, true) !== 0x46455056) throw new Error('frame stream: bad record header');
          const head = { kind: dv.getUint32(4, true), gen: dv.getUint32(8, true), w: dv.getUint32(12, true), h: dv.getUint32(16, true), ys: dv.getUint32(20, true), t: dv.getFloat64(24, true), len: dv.getUint32(32, true) };
          opts.onRecord(head, new Uint8Array(ab, HEADER, head.len), false);
        } catch (err) { ws.close(); done(err); }
      };
      ws.onerror = () => { ws.close(); done(new Error('WebSocket error')); };
      ws.onclose = (e) => done(new Error(`WebSocket closed (${e.code})`));
      return { close() { closed = true; try { ws.close(); } catch { /* closed */ } }, recycle() {} };
    }
    const ctl = new AbortController();
    const pool = [];
    const take = (len) => { const i = pool.findIndex((b) => b.byteLength === len); return i < 0 ? null : pool.splice(i, 1)[0]; };
    readHttp(opts.url, take, () => { if (!closed) opts.onOpen(); }, (head, buf) => { if (!closed) opts.onRecord(head, new Uint8Array(buf), true); }, ctl.signal)
      .catch((err) => { if (!closed) { ctl.abort(); done(err); } });
    return {
      close() { closed = true; pool.length = 0; ctl.abort(); },
      recycle(buf) {
        if (closed || !buf || !buf.byteLength) return;
        // A compare tile can change size on the same stream. Make room for its new buffers.
        if (pool.length === MAX_POOL) pool.shift();
        pool.push(buf);
      },
    };
  }

  return { open, HEADER };
})();
if (typeof globalThis !== 'undefined') /** @type {any} */ (globalThis).FrameStream = FrameStream;
