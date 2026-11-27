'use strict';
// node test/run.js unit --grep lifecycle_fuzz: deterministic seeded fuzzing of the viewer's host side (src/extension.js,
// src/unified-viewer.js) and HttpFile: lifecycle, reload, stale-page cancellation, malformed envelopes, and
// close-mid-read invariants; and the native decoders' dispose.
const assert = require('assert');
const { EventEmitter } = require('events');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { load } = require('./mock_vscode');
const { HttpFile } = require('../../src/urlsource');
const { NativeDecoder } = require('../../src/native');
const { RemoteStream } = require('../../src/remotestream');

const RAW_SEED = process.env.VPE_FUZZ_SEED || '20261123';

function parseSeed(raw) {
  const n = Number(raw);
  if (Number.isInteger(n) && n !== 0) return n >>> 0;
  let h = 2166136261 >>> 0;
  for (let i = 0; i < String(raw).length; i++) {
    h ^= String(raw).charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return (h >>> 0) || 1;
}

function makePrng(seed) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    bool: (p = 0.5) => next() < p,
  };
}

const within = (p, ms, what) => {
  let timer;
  return Promise.race([
    p,
    new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`${what}: timed out after ${ms} ms`)), ms); }),
  ]).finally(() => clearTimeout(timer));
};

const tick = ( hops = 1) => {
  let p = Promise.resolve();
  for (let i = 0; i < hops; i++) p = p.then(() => new Promise((r) => setImmediate(r)));
  return p;
};
const delay = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : tick(1));

/**
 * The viewer (src/extension.js + src/unified-viewer.js over the mock vscode), 1 to 3 videos, under random page traffic:
 * reads by current, replaced and unknown clip ids with good and bad ranges, a recreated document, stale and missing
 * page numbers, videos added, removed and reloaded, malformed envelopes, delayed stat / open / read, and a close in
 * the middle. Invariants: posts carry the page number, a block's bytes are its file's, nothing reaches a closed panel,
 * a stale page's message never reaches the session, and every file handle is closed in the end.
 */
async function runSuiteViewer(rng, tmpDir) {
  const files = [0, 1, 2, 3].map((k) => {
    const p = path.join(tmpDir, `view_${k}.mp4`);
    const buf = Buffer.alloc(2048 + k * 256);
    for (let i = 0; i < buf.length; i++) buf[i] = ((i * 13) ^ (k * 53)) & 255;
    fs.writeFileSync(p, buf);
    return { path: p, name: path.basename(p), buf };
  });
  const tracked = new Set(files.map((f) => f.path));
  const origStat = fs.promises.stat;
  const origOpen = fs.promises.open;
  let openHandles = 0;
  fs.promises.stat = async (p, ...a) => {
    if (tracked.has(p) && rng.bool(0.4)) await tick(rng.int(1, 3));
    return origStat(p, ...a);
  };
  fs.promises.open = async (p, ...a) => {
    if (tracked.has(p) && rng.bool(0.4)) await tick(rng.int(1, 3));
    const fh = await origOpen(p, ...a);
    if (tracked.has(p)) {
      openHandles++;
      const origRead = fh.read.bind(fh);
      const origClose = fh.close.bind(fh);
      let closed = false;
      fh.read = async (...ra) => {
        if (rng.bool(0.4)) await tick(rng.int(1, 3));
        return origRead(...ra);
      };
      fh.close = async (...ca) => {
        if (!closed) { closed = true; openHandles--; }
        return origClose(...ca);
      };
    }
    return fh;
  };

  const h = load({ settings: {
    'videoPreviewEnhanced.decoder': 'builtin',
    'videoPreviewEnhanced.ffmpegPath': path.join(tmpDir, 'no_such_ffmpeg_bin'),
    'videoPreviewEnhanced.compare.maxVideos': 4,
  } });
  try {
    const uris = files.map((f) => h.vscode.Uri.file(f.path));
    h.vscode.window.showOpenDialog = async () => {
      if (rng.bool(0.5)) await tick(rng.int(1, 2));
      return rng.bool(0.8) ? [rng.pick(uris)] : undefined;
    };
    for (let ep = 0; ep < 12; ep++) {
      const s = h.nextPanel();
      // One video ([a, a]: the duplicate is not added) or a comparison of two or three.
      const n = rng.int(1, 3);
      const viewer = await h.vscode._commands['videoPreviewEnhanced.compare'](null, n === 1 ? [uris[0], uris[0]] : uris.slice(0, n));
      let reached = 0;
      const onMessage = viewer.session.onMessage;
      viewer.session.onMessage = (m) => { reached++; return onMessage(m); };
      await s.send({ type: 'ready', boot: 'doc-1' });
      let boot = 1;
      let disposedAt = -1;
      const pending = [];
      const later = (p) => pending.push(Promise.resolve(p).catch(() => {}));
      for (let step = 0; step < 30; step++) {
        const shown = viewer.session.clips.map((c) => c.id);
        const seen = [...new Set([...shown, ...s.posted.filter((m) => m.type === 'replaceTile').map((m) => m.oldId)])];
        const op = rng.int(0, 8);
        if (op === 0) {
          later(s.send({ type: 'ready', boot: `doc-${++boot}` }));
        } else if (op === 1) {
          // A shown or a replaced clip id, good and bad ranges.
          later(s.send({ type: 'readBlock', clipId: rng.pick(seen), pos: rng.pick([0, 64, 512, 4096, -16, NaN]), len: rng.pick([64, 256, 0, -10, NaN]) }));
        } else if (op === 2) {
          later(s.send({ type: 'readBlock', clipId: rng.pick(['Z', '', null, 123, '?', 'tile-A', {}]), pos: 0, len: 64 }));
        } else if (op === 3) {
          // A stale page (or none): never reaches the session.
          await Promise.all(pending); // the earlier steps' messages have arrived
          const current = s.cfg().page;
          const stale = rng.pick([current - 1, current + 50, 0, -1, '1', null]);
          const before = reached;
          await s.send(rng.pick([
            { type: 'ready', page: stale }, { type: 'readBlock', page: stale, clipId: shown[0], pos: 0, len: 64 },
            { type: 'tiles', page: stale, tiles: [] }, { type: 'pickVideo', page: stale },
            { type: 'tileSize', page: stale, tile: { w: 800, h: 600 } },
          ]));
          if (!viewer.disposed) assert.strictEqual(reached, before, `episode ${ep}: a stale page (${String(stale)}) never reaches the session`);
        } else if (op === 4) {
          later(rng.bool(0.5) ? s.send({ type: 'pickVideo' }) : viewer.addUri(rng.pick(uris)));
        } else if (op === 5) {
          // The page closed a tile, or sent nonsense.
          later(s.send({ type: 'tiles', tiles: rng.pick([shown.slice(1), shown.slice(0, 1), [], null, ['bogus']]) }));
        } else if (op === 6) {
          const sub = rng.int(0, 3);
          if (sub === 0 && shown.length) later(viewer.reloadClip(rng.pick(shown)));
          else if (sub === 1) later(s.send({ type: 'tileSize', tile: rng.pick([null, {}, { w: -1, h: NaN, cols: 'bad', factor: 0 }]) }));
          else if (sub === 2) later(s.send({ type: 'tileOrder', order: rng.pick([null, 'bad', [2, 0, 1, 99, -1]]) }));
          else later(s.send({ type: 'pref', key: rng.pick(['jump.arrow', 'bad']), value: rng.pick([5, 'bad']) }));
        } else if (op === 7) {
          later(s.send(rng.pick([
            null, undefined, {}, { type: null }, { type: 123 }, { type: 'nd', clipId: null, m: null },
            { type: 'nd', clipId: 123, m: {} }, { type: 'transcodePref', mode: 'invalid', maxBitrateMbps: -5 },
          ])));
        } else {
          await tick(rng.int(1, 2));
        }
        if (step === 20 && rng.bool(0.5)) {
          // Closed in the middle of the traffic.
          s.panel.dispose();
          disposedAt = s.posted.length;
        }
      }
      if (disposedAt < 0) {
        await Promise.all(pending);
        await tick(2);
        s.panel.dispose();
        disposedAt = s.posted.length;
      }
      s.panel.dispose(); // twice: nothing more happens
      await Promise.all(pending);
      // After the close: nothing reaches the session and nothing is posted.
      const before = reached;
      await s.send({ type: 'ready' });
      await s.send({ type: 'readBlock', clipId: viewer.session.clips.map((c) => c.id)[0], pos: 0, len: 64 });
      assert.ok(await viewer.addUri(uris[3]) === false, 'a closed viewer adds nothing');
      await tick(3);
      assert.strictEqual(reached, before, `episode ${ep}: nothing reaches a closed viewer's session`);
      assert.strictEqual(s.posted.length, disposedAt, `episode ${ep}: no messages after the panel closed (${disposedAt} -> ${s.posted.length})`);
      // The clips the page was given (by id and name, never a path), and the bytes of each block.
      const nameOf = new Map();
      for (const m of s.posted) {
        if (m.type === 'sessionState') for (const c of m.clips) nameOf.set(c.clipId, c.name);
        if (m.type === 'openVideo') nameOf.set(m.clipId, m.label);
        if (m.type === 'replaceTile') nameOf.set(m.newId, m.label);
      }
      for (const m of s.posted) {
        assert.strictEqual(typeof m.page, 'number', 'host posts carry a numeric page id');
        assert.ok(m.type !== 'error' || !/RangeError|ERR_OUT_OF_RANGE/.test(String(m.message)), `episode ${ep}: ${m.message}`);
        if (m.type !== 'block') continue;
        assert.ok(nameOf.has(m.clipId), `episode ${ep}: a block only for a clip the page was given (${String(m.clipId)})`);
        if (!(Number.isInteger(m.pos) && m.pos >= 0)) { assert.strictEqual(m.data.length, 0, `bad position ${String(m.pos)} answers empty`); continue; }
        const f = files.find((x) => x.name === nameOf.get(m.clipId));
        assert.ok(Buffer.from(m.data).equals(f.buf.subarray(m.pos, m.pos + m.data.length)), `episode ${ep}: block bytes of ${f.name} at ${m.pos}`);
      }
    }
    await tick(5);
    assert.strictEqual(openHandles, 0, `the viewer suite leaked ${openHandles} open file handle(s)`);
  } finally {
    fs.promises.stat = origStat;
    fs.promises.open = origOpen;
    h.dispose();
  }
}

function checkDecoderDisposal() {
  const bytes = Buffer.alloc(64);
  const native = new NativeDecoder({});
  const stream = new RemoteStream({ probed: {}, audioEncoder: 'libopus' });
  const makeProcess = () => ({
    exitCode: null,
    kills: 0,
    stdout: { destroy() {} },
    kill() { this.kills++; },
  });
  const proc = native.proc = makeProcess();
  proc.raw = [bytes];
  proc.stampQ = [{}];
  proc.silence = setTimeout(assert.fail, 30000);
  native.connectTimer = setTimeout(assert.fail, 30000);
  native.frames = [bytes];
  native.pending = bytes;
  native.audioChunks = [bytes];
  native.audioBytes = bytes.length;
  native.credits = 2;
  native.draining = true;
  let closes = 0;
  let settles = 0;
  native.channel = { close() { closes++; native.dispose(); } };
  native.settle = () => { settles++; };
  native.dispose();
  native.dispose();
  assert.strictEqual(proc.kills, 1);
  assert.strictEqual(closes, 1);
  assert.strictEqual(settles, 1);
  assert.strictEqual(proc.silence, null);
  assert.strictEqual(native.connectTimer, null);
  assert.deepStrictEqual([proc.raw, proc.stampQ, native.frames, native.audioChunks], [[], [], [], []]);
  assert.strictEqual(native.pending.length + native.audioBytes + native.credits, 0);
  assert.strictEqual(native.draining, false);

  const video = stream.proc = makeProcess();
  const audio = stream.audioProc = makeProcess();
  stream.standby = makeProcess();
  stream.standby.timer = setTimeout(assert.fail, 30000);
  stream.startTimer = setTimeout(assert.fail, 30000);
  stream.vAll = [bytes];
  stream.aStore = [bytes];
  stream.pending = stream.aRest = bytes;
  stream.waiting = {};
  stream.dispose();
  stream.dispose();
  assert.strictEqual(video.kills, 1);
  assert.strictEqual(audio.kills, 1);
  assert.deepStrictEqual([stream.vAll, stream.aStore], [[], []]);
  assert.strictEqual(stream.pending.length + stream.aRest.length, 0);
  assert.deepStrictEqual([stream.waiting, stream.ogg, stream.startTimer, stream.standby], [null, null, null, null]);
}

async function runSuiteC(rng) {
  const fileSize = 2048;
  const payload = Buffer.alloc(fileSize);
  for (let i = 0; i < fileSize; i++) payload[i] = (i * 19 + 7) & 255;

  const sockets = new Set();
  const timers = new Set();
  const addTimer = (fn, ms) => {
    const t = setTimeout(() => { timers.delete(t); fn(); }, ms);
    timers.add(t);
    return t;
  };

  const server = http.createServer((req, res) => {
    const mode = req.url.includes('stall') ? 'stall' : req.url.includes('trickle') ? 'trickle' : 'fast';
    const rangeHdr = req.headers.range;
    let slice = payload;
    let status = 200;
    const headers = { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes' };

    if (rangeHdr && !req.url.includes('norange')) {
      const m = /^bytes=(\d+)-(\d*)$/.exec(rangeHdr);
      if (m) {
        const start = Number(m[1]);
        const end = m[2] ? Math.min(fileSize - 1, Number(m[2])) : fileSize - 1;
        slice = payload.subarray(start, end + 1);
        status = 206;
        headers['Content-Range'] = `bytes ${start}-${end}/${fileSize}`;
      }
    }
    headers['Content-Length'] = slice.length;
    res.writeHead(status, headers);

    if (mode === 'fast') {
      res.end(slice);
      return;
    }
    if (mode === 'stall') {
      // Send a tiny prefix (or nothing) and then stall until client aborts.
      if (slice.length > 0 && rng.bool(0.7)) res.write(slice.subarray(0, Math.min(8, slice.length)));
      return;
    }
    // Trickle mode: send in 2-4 small chunks over a few milliseconds.
    const mid = Math.max(1, Math.floor(slice.length / 2));
    res.write(slice.subarray(0, mid));
    addTimer(() => {
      if (!res.destroyed && !res.writableEnded) {
        if (rng.bool(0.6)) res.end(slice.subarray(mid));
      }
    }, rng.int(1, 6));
  });

  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const episodes = 20;
    for (let ep = 0; ep < episodes; ep++) {
      const rangeOk = rng.bool(0.55);
      const kind = rng.pick(['stall', 'trickle', 'fast']);
      const url = `${baseUrl}/video_${ep}_${kind}${rangeOk ? '' : '_norange'}.mp4`;
      const headLen = rng.pick([0, 32]);
      const f = new HttpFile({
        url,
        size: fileSize,
        rangeOk,
        head: payload.subarray(0, headLen),
      });

      const numReads = rng.int(3, 8);
      const reads = [];
      for (let r = 0; r < numReads; r++) {
        const pos = rng.pick([0, 16, rng.int(0, fileSize - 64), fileSize + 100]);
        const len = rng.pick([32, 128, 512, 0]);
        const p = f.read(pos, len).then(
          (buf) => ({ ok: true, buf, pos, len }),
          (err) => ({ ok: false, err, pos, len }),
        );
        reads.push(p);
      }

      // Close at a randomized point mid-transfer (immediate, microtask hops, or timer tick).
      const modeClose = rng.int(0, 2);
      if (modeClose === 1) await tick(rng.int(1, 4));
      else if (modeClose === 2) await delay(1);
      f.close();
      f.close(); // idempotent double close

      const results = await within(Promise.all(reads), 1000, `Suite C episode ${ep} pending reads`);
      for (const res of results) {
        if (res.ok) {
          const wantEnd = Math.min(fileSize, res.pos + Math.max(0, res.len));
          const want = res.pos >= fileSize || res.len <= 0 ? Buffer.alloc(0) : payload.subarray(res.pos, wantEnd);
          assert.ok(Buffer.from(res.buf).equals(want), `Episode ${ep}: resolved read returned wrong bytes`);
        } else {
          assert.ok(res.err instanceof Error, `Episode ${ep}: rejected read must reject with an Error`);
        }
      }

      if (f.whole) {
        assert.strictEqual(f.whole.waits.length, 0, `Episode ${ep}: HttpFile retained ${f.whole.waits.length} waiter(s)`);
      }

      // Any read after close() must reject promptly with code === 'CLOSED'.
      const postCloseRead = within(
        f.read(0, 64).then(() => 'resolved', (e) => e),
        250,
        `Suite C episode ${ep} post-close read`,
      );
      const postErr = await postCloseRead;
      assert.ok(postErr instanceof Error && postErr.code === 'CLOSED', `Episode ${ep}: post-close read must reject with CLOSED`);
    }
  } finally {
    for (const t of timers) clearTimeout(t);
    for (const s of sockets) s.destroy();
    await new Promise((r) => server.close(r));
  }
}

(async () => {
  const seed = parseSeed(RAW_SEED);
  const rng = makePrng(seed);
  const unhandled = [];
  const onUnhandled = (err) => unhandled.push(err);
  process.on('unhandledRejection', onUnhandled);
  process.on('uncaughtException', onUnhandled);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `vpe_fuzz_${process.pid}_`));
  const t0 = Date.now();
  try {
    checkDecoderDisposal();
    await runSuiteViewer(rng, tmpDir);
    await runSuiteC(rng);
    assert.strictEqual(unhandled.length, 0, `Unhandled errors/rejections: ${unhandled.map((e) => e && e.stack || e).join('\n')}`);
    const elapsed = Date.now() - t0;
    console.log(`lifecycle_fuzz_test: ok (seed=${RAW_SEED} [${seed}], ${elapsed} ms)`);
  } catch (e) {
    console.error(`lifecycle_fuzz_test FAILED (reproduce with VPE_FUZZ_SEED=${RAW_SEED})`);
    throw e;
  } finally {
    process.off('unhandledRejection', onUnhandled);
    process.off('uncaughtException', onUnhandled);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
