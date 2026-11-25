'use strict';
// node test/host/lifecycle_fuzz_test.js: deterministic seeded fuzzing of host Session, CompareSession, and HttpFile
// lifecycle, reload, stale-page/boot cancellation, malformed envelopes, and close-mid-read invariants.
const assert = require('assert');
const { EventEmitter } = require('events');
const childProcess = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { load, webviewConfig } = require('./mock_vscode');
const { HttpFile } = require('../../src/urlsource');
const compareModule = require('../../src/compare');
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

async function runSuiteA(rng, tmpDir) {
  const fileSize = 4096;
  const file = path.join(tmpDir, 'single_fuzz.mkv');
  const groundTruth = Buffer.alloc(fileSize);
  for (let i = 0; i < fileSize; i++) groundTruth[i] = (i * 31 + 17) & 255;
  fs.writeFileSync(file, groundTruth);

  const origStat = fs.promises.stat;
  const origOpen = fs.promises.open;
  let openHandles = 0;

  fs.promises.stat = async (p, ...a) => {
    if (p === file && rng.bool(0.5)) await tick(rng.int(1, 3));
    return origStat(p, ...a);
  };
  fs.promises.open = async (p, ...a) => {
    if (p === file && rng.bool(0.5)) await tick(rng.int(1, 3));
    const fh = await origOpen(p, ...a);
    if (p === file) {
      openHandles++;
      const origRead = fh.read.bind(fh);
      const origClose = fh.close.bind(fh);
      let closed = false;
      fh.read = async (...ra) => {
        if (rng.bool(0.5)) await tick(rng.int(1, 3));
        return origRead(...ra);
      };
      fh.close = async (...ca) => {
        if (!closed) { closed = true; openHandles--; }
        return origClose(...ca);
      };
    }
    return fh;
  };

  const fakeFfmpeg = path.join(tmpDir, 'no_such_ffmpeg_bin');
  const children = [];
  const thumbPath = require.resolve('../../src/thumbhost');
  const previousThumb = require.cache[thumbPath];
  const spawn = childProcess.spawn;
  const registerCompare = compareModule.registerCompare;
  let host;
  compareModule.registerCompare = (context, deps) => {
    host = deps;
    return registerCompare(context, deps);
  };
  delete require.cache[thumbPath];
  childProcess.spawn = () => {
    const proc = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(), stderr: new EventEmitter(), kills: 0,
      kill() { this.kills++; }, // Deliberately never emits close.
    });
    children.push(proc);
    return proc;
  };
  try { require(thumbPath); } finally { childProcess.spawn = spawn; }
  let h;
  try {
    h = load({
      settings: {
        'videoPreviewEnhanced.decoder': 'builtin',
        'videoPreviewEnhanced.ffmpegPath': fakeFfmpeg,
      },
    });
  } finally {
    compareModule.registerCompare = registerCompare;
    if (previousThumb) require.cache[thumbPath] = previousThumb;
    else delete require.cache[thumbPath];
  }

  try {
    const watch = fs.watch;
    let first;
    let firstSession;
    let emitFirstWatchEvent;
    try {
      fs.watch = (dir, onEvent) => {
        emitFirstWatchEvent = onEvent;
        return watch(dir, onEvent);
      };
      first = h.open(file);
      firstSession = host.lastActivePlayer();
      await first.shown;
    } finally {
      fs.watch = watch;
    }
    const second = h.open(file);
    const session = host.lastActivePlayer();
    await second.shown;
    emitFirstWatchEvent('change', path.basename(file));
    assert.ok(firstSession.watchTimer);
    first.panel.dispose();
    assert.strictEqual(firstSession.watchTimer, null);
    first.panel.active = true;
    first.setVisible(true); // A late callback must not restore a closed session.
    assert.ok(firstSession.disposed);
    assert.strictEqual(host.lastActivePlayer(), session);

    for (const endPage of [() => session.reload(), () => second.panel.dispose()]) {
      const native = new NativeDecoder({ file, tools: { ffmpeg: fakeFfmpeg }, probed: { video: { width: 80, height: 48 } } });
      session.native = native;
      const request = { page: session.page, id: 1, t: 0, w: 80, h: 48 };
      const before = children.length;
      const cancelled = session.sendThumb(request);
      const firstChild = children.at(-1);
      session.sendThumb({ ...request, cancel: true });
      assert.strictEqual(firstChild.kills, 1);
      await within(cancelled, 1000, 'release cancellation without child close');
      assert.strictEqual(children.length, before + 1);

      const thumbs = session.sendThumb({ ...request, id: 2 });
      const child = children.at(-1);
      const childCount = children.length;
      assert.strictEqual(childCount, before + 2);
      child.stdout.emit('data', Buffer.alloc(128));
      // Include a waiter with a separate signal, as range exports use their own controller.
      const exportReply = session.grabFrame(0, new AbortController().signal);
      assert.strictEqual(session.exportWait.size, 1);
      const posts = second.posted.length;
      endPage();
      assert.strictEqual(session.exportWait.size, 0);
      assert.strictEqual(session.thumbJob, null);
      assert.strictEqual(child.kills, 1);
      assert.deepStrictEqual(await exportReply, { error: 'export cancelled' });
      await within(thumbs, 1000, 'thumbnail cancellation without child close');
      assert.strictEqual(children.length, childCount, 'teardown must not restart thumbnails');
      assert.strictEqual(second.posted.length, posts, 'cancelled thumbnails must not reply');
    }
    session.dispose();
    assert.strictEqual(host.lastActivePlayer(), null);

    const episodes = 10;
    for (let ep = 0; ep < episodes; ep++) {
      const s = h.open(file);
      const currentSession = host.lastActivePlayer();
      await s.shown;
      let curPage = webviewConfig(s.panel.webview).page;
      let bootSeq = 0;
      let curBoot = `boot-${ep}-${++bootSeq}`;
      const stalePages = new Set([0, -1, curPage - 1, curPage + 100]);
      const staleBoots = new Set(['stale-boot-0']);
      // Map of dead boot -> post index at which that boot became dead.
      const deadBootCutoff = new Map([['stale-boot-0', 0]]);
      const deadPageCutoff = new Map([[0, 0], [-1, 0]]);
      const pending = [];
      let disposedAt = -1;

      const sendRaw = (msg) => {
        const p = Promise.resolve(s.send(msg)); // delivered now, so a boot or page change cutoff never overtakes it
        pending.push(p);
        return p;
      };

      // Initial ready on some episodes, delayed on others.
      if (rng.bool(0.8)) {
        sendRaw({ type: 'ready', page: curPage, boot: curBoot });
      }

      const steps = 30;
      for (let step = 0; step < steps; step++) {
        const op = rng.int(0, 9);
        if (op === 0) {
          // Valid readBlock for current page/boot.
          const pos = rng.int(0, fileSize - 1);
          const len = rng.int(1, 1024);
          sendRaw({ type: 'readBlock', page: curPage, boot: curBoot, pos, len });
        } else if (op === 1) {
          // Out-of-bounds readBlock (past EOF, zero len, negative pos/len).
          const badRange = rng.pick([
            { pos: fileSize + rng.int(0, 5000), len: 256 },
            { pos: fileSize, len: 0 },
            { pos: 0, len: 0 },
            { pos: 0, len: -64 },
            { pos: -1, len: 64 },
            { pos: -32, len: 64 },
          ]);
          sendRaw({ type: 'readBlock', page: curPage, boot: curBoot, ...badRange });
        } else if (op === 2) {
          // Non-finite / malformed readBlock.
          const malformed = rng.pick([
            { pos: NaN, len: 128 },
            { pos: 0, len: NaN },
            { pos: Infinity, len: 64 },
            { pos: -Infinity, len: 64 },
            { pos: 0, len: Infinity },
            { pos: 1.5, len: 32 },
            { pos: 'bad', len: null },
            {},
          ]);
          sendRaw({ type: 'readBlock', page: curPage, boot: curBoot, ...malformed });
        } else if (op === 3) {
          // New ready with a fresh boot ID on the current page (resets page generation).
          staleBoots.add(curBoot);
          deadBootCutoff.set(curBoot, s.posted.length);
          curBoot = `boot-${ep}-${++bootSeq}`;
          await sendRaw({ type: 'ready', page: curPage, boot: curBoot });
          deadBootCutoff.set(staleBoots.values().next().value, deadBootCutoff.get(staleBoots.values().next().value));
        } else if (op === 4) {
          // Full webview reload via transcodePref 'always', advancing page ID in webview.html.
          const prevPage = curPage;
          const prevBoot = curBoot;
          await sendRaw({ type: 'transcodePref', mode: 'always', boot: curBoot });
          const nextPage = webviewConfig(s.panel.webview).page;
          if (nextPage !== prevPage) {
            stalePages.add(prevPage);
            deadPageCutoff.set(prevPage, s.posted.length);
            staleBoots.add(prevBoot);
            deadBootCutoff.set(prevBoot, s.posted.length);
            curPage = nextPage;
            curBoot = `boot-${ep}-${++bootSeq}`;
            sendRaw({ type: 'ready', page: curPage, boot: curBoot });
          }
        } else if (op === 5) {
          // Stale messages from a prior page or prior boot.
          const oldPage = rng.pick([...stalePages]);
          const oldBoot = rng.pick([...staleBoots]);
          const cutoff = s.posted.length;
          if (!deadPageCutoff.has(oldPage)) deadPageCutoff.set(oldPage, cutoff);
          if (!deadBootCutoff.has(oldBoot)) deadBootCutoff.set(oldBoot, cutoff);
          const staleMsg = rng.pick([
            { type: 'readBlock', page: oldPage, boot: oldBoot, pos: 0, len: 64 },
            { type: 'readBlock', page: oldPage, boot: curBoot, pos: 0, len: 64 },
            { type: 'readBlock', page: curPage, boot: oldBoot, pos: 0, len: 64 },
            { type: 'ready', page: oldPage, boot: `stale-ready-${step}` },
            { type: 'ready', page: curPage, boot: oldBoot },
            { type: 'thumb', page: oldPage, boot: oldBoot, id: step, t: 1, w: 80, h: 45 },
            { type: 'grabExactFrame', page: oldPage, boot: oldBoot, reqId: step, t: 0.5 },
            { type: 'saveFrame', page: oldPage, boot: oldBoot, data: new Uint8Array(8), frame: 0 },
          ]);
          sendRaw(staleMsg);
        } else if (op === 6) {
          // Valid and invalid pref / playbackPrefs updates.
          const prefMsg = rng.pick([
            { type: 'pref', boot: curBoot, key: 'jump.arrow', value: rng.pick(['frame', 1, 5, 10, 30]) },
            { type: 'pref', boot: curBoot, key: 'stepButtons', value: rng.pick(['frame', 'jump']) },
            { type: 'pref', boot: curBoot, key: 'jump.arrow', value: 'invalid-jump' },
            { type: 'pref', boot: curBoot, key: '__proto__', value: 'polluted' },
            { type: 'playbackPrefs', boot: curBoot, volume: 0.5, rate: 1.25, timeMode: 1, stepSize: 'frame' },
            { type: 'playbackPrefs', boot: curBoot, volume: NaN, rate: -10, timeMode: 99, stepSize: 'bad' },
            { type: 'whenSlow', boot: curBoot, value: rng.pick(['every', 'skip', 'invalid']) },
          ]);
          sendRaw(prefMsg);
        } else if (op === 7) {
          // Malformed envelopes.
          const badEnv = rng.pick([
            {},
            { type: null },
            { type: 12345 },
            { type: 'nonexistentType', boot: curBoot },
            { type: 'ready', page: curPage, boot: '' },
            { type: 'ready', page: curPage, boot: null },
            { type: 'ready', page: 'not-a-page', boot: 'b' },
            { type: 'nd', boot: curBoot, m: null },
            { type: 'grabExactFrame', page: curPage, boot: curBoot, reqId: 'not-an-int', t: 'bad' },
            { type: 'pos', boot: curBoot, t: NaN, d: -5 },
          ]);
          sendRaw(badEnv);
        } else if (op === 8) {
          // Visibility toggle or micro-yield.
          if (rng.bool(0.5)) s.setVisible(rng.bool());
          await tick(rng.int(1, 2));
        } else if (op === 9 && step > 20 && disposedAt < 0) {
          // Early dispose mid-episode, followed by double dispose and post-dispose messages.
          s.panel.dispose();
          disposedAt = s.posted.length;
          s.panel.dispose(); // idempotent double dispose
        }
      }

      // Null and primitive envelopes are ignored, not thrown on (fixed order, so the seeded sequence stays put).
      if (disposedAt < 0) for (const junk of [null, undefined, 7, 'readBlock', true]) await sendRaw(junk);

      if (disposedAt < 0) {
        s.panel.dispose();
        disposedAt = s.posted.length;
      }
      // Double and triple dispose must be idempotent.
      s.panel.dispose();
      s.panel.dispose();

      // Messages sent after dispose must never throw or emit replies.
      await sendRaw({ type: 'ready', page: curPage, boot: `post-dispose-${ep}` });
      await sendRaw({ type: 'readBlock', page: curPage, boot: curBoot, pos: 0, len: 64 });
      await sendRaw({ type: 'pref', boot: curBoot, key: 'jump.arrow', value: 10 });
      await Promise.all(pending);
      await tick(2);
      assert.strictEqual(host.lastActivePlayer(), null);
      assert.strictEqual(host.sessions.size, 0);
      assert.strictEqual(currentSession.watchTimer, null);
      assert.strictEqual(currentSession.watcher, null);
      assert.strictEqual(currentSession.frames, null);
      assert.strictEqual(currentSession.thumbJob, null);

      assert.strictEqual(
        s.posted.length,
        disposedAt,
        `Episode ${ep}: no messages may be posted after dispose() (was ${disposedAt}, now ${s.posted.length})`,
      );

      // Verify all posted block messages: valid in-bounds reads match groundTruth, and no dead page/boot
      // emitted a reply after its cutoff index.
      for (let idx = 0; idx < s.posted.length; idx++) {
        const m = s.posted[idx];
        if (m.page !== undefined && deadPageCutoff.has(m.page)) {
          const cutoff = deadPageCutoff.get(m.page);
          assert.ok(idx < cutoff, `Episode ${ep}: message ${m.type} for dead page ${m.page} posted at ${idx} >= ${cutoff}`);
        }
        if (m.boot !== undefined && deadBootCutoff.has(m.boot)) {
          const cutoff = deadBootCutoff.get(m.boot);
          assert.ok(idx < cutoff, `Episode ${ep}: message ${m.type} for dead boot ${m.boot} posted at ${idx} >= ${cutoff}`);
        }
        if (m.type === 'block' && !(Number.isInteger(m.pos) && m.pos >= 0)) {
          assert.strictEqual(m.data.length, 0, `Episode ${ep}: a bad position (${String(m.pos)}) answers an empty block`);
        }
        assert.ok(m.type !== 'error' || !/RangeError|ERR_OUT_OF_RANGE/.test(String(m.message)), `Episode ${ep}: ${m.message}`);
        if (m.type === 'block' && Number.isInteger(m.pos) && m.pos >= 0 && m.pos < fileSize && m.data.length > 0) {
          const expected = groundTruth.subarray(m.pos, m.pos + m.data.length);
          assert.ok(Buffer.from(m.data).equals(expected), `Episode ${ep}: corrupted block data at pos=${m.pos}`);
        }
      }
    }
    await tick(3);
    assert.strictEqual(openHandles, 0, `Suite A leaked ${openHandles} open file handle(s)`);
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

async function runSuiteB(rng, tmpDir) {
  const files = [0, 1, 2, 3].map((k) => {
    const p = path.join(tmpDir, `cmp_${k}.mp4`);
    const buf = Buffer.alloc(2048 + k * 256);
    for (let i = 0; i < buf.length; i++) buf[i] = ((i * 13) ^ (k * 53)) & 255;
    fs.writeFileSync(p, buf);
    return { path: p, buf };
  });

  const origStat = fs.promises.stat;
  const origOpen = fs.promises.open;
  let openHandles = 0;
  const trackedPaths = new Set(files.map((f) => f.path));

  fs.promises.stat = async (p, ...a) => {
    if (trackedPaths.has(p) && rng.bool(0.4)) await tick(rng.int(1, 3));
    return origStat(p, ...a);
  };
  fs.promises.open = async (p, ...a) => {
    if (trackedPaths.has(p) && rng.bool(0.4)) await tick(rng.int(1, 3));
    const fh = await origOpen(p, ...a);
    if (trackedPaths.has(p)) {
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

  const fakeFfmpeg = path.join(tmpDir, 'no_such_ffmpeg_bin');
  const h = load({
    settings: {
      'videoPreviewEnhanced.decoder': 'builtin',
      'videoPreviewEnhanced.ffmpegPath': fakeFfmpeg,
      'videoPreviewEnhanced.compare.maxVideos': 4,
    },
  });

  try {
    const uris = files.map((f) => h.vscode.Uri.file(f.path));
    const episodes = 10;

    for (let ep = 0; ep < episodes; ep++) {
      const posts = [];
      let receive = null;
      const disposeListeners = [];
      const panel = {
        visible: true,
        active: true,
        viewColumn: 1,
        title: '',
        webview: {
          html: '',
          cspSource: 'vscode-resource:',
          asWebviewUri: (u) => u,
          postMessage: (m) => { posts.push(m); return Promise.resolve(true); },
          onDidReceiveMessage: (fn) => { receive = fn; },
        },
        onDidDispose: (fn) => { disposeListeners.push(fn); },
        onDidChangeViewState: () => {},
        dispose: () => { for (const fn of disposeListeners) fn(); },
      };
      h.vscode.window.createWebviewPanel = () => panel;
      h.vscode.window.showOpenDialog = async () => {
        if (rng.bool(0.5)) await tick(rng.int(1, 2));
        return rng.bool(0.8) ? [rng.pick(uris)] : undefined;
      };

      const compare = await h.vscode._commands['videoPreviewEnhanced.compare'](null, [uris[0], uris[1]]);
      const origOnMessage = compare.onMessage.bind(compare);
      const inFlight = [];
      compare.onMessage = (m) => {
        const p = origOnMessage(m);
        inFlight.push(p.catch(() => {}));
        return p;
      };

      const deadPageCutoff = new Map([[0, 0], [-1, 0], [999, 0]]);
      let trackedPage = compare.page;
      const notePageChange = () => {
        if (compare.page !== trackedPage) {
          deadPageCutoff.set(trackedPage, posts.length);
          trackedPage = compare.page;
        }
      };

      const send = (m) => {
        receive(m);
        notePageChange();
      };

      let disposedAt = -1;
      const steps = 30;
      for (let step = 0; step < steps; step++) {
        notePageChange();
        const curPage = compare.page;
        const op = rng.int(0, 8);

        if (op === 0) {
          // ready on current page.
          send({ type: 'ready', page: curPage, tile: { w: 1280, h: 720, cols: 2, rows: 1 } });
        } else if (op === 1) {
          // readBlock with valid tile keys ('A'..'D', 'sA', 'sB') and valid or edge pos/len.
          const key = rng.pick(['A', 'B', 'C', 'D', 'sA', 'sB']);
          const pos = rng.pick([0, 64, 512, 4096, -16, NaN]);
          const len = rng.pick([64, 256, 0, -10, NaN]);
          send({ type: 'readBlock', page: curPage, key, pos, len });
        } else if (op === 2) {
          // readBlock with invalid/malformed tile keys.
          const badKey = rng.pick(['Z', 'P', '', null, undefined, 123, '?', 'tile-A', {}]);
          send({ type: 'readBlock', page: curPage, key: badKey, pos: 0, len: 64 });
        } else if (op === 3) {
          // Stale page ID messages (or missing page ID): must be completely ignored.
          const stalePage = rng.pick([...deadPageCutoff.keys(), curPage - 1, curPage + 50, undefined, null, '1']);
          const beforeCount = inFlight.length;
          receive(rng.pick([
            { type: 'ready', page: stalePage },
            { type: 'readBlock', page: stalePage, key: 'A', pos: 0, len: 64 },
            { type: 'remove', page: stalePage, index: 0 },
            { type: 'add', page: stalePage },
            { type: 'tileSize', page: stalePage, tile: { w: 800, h: 600 } },
            { type: 'stop', page: stalePage },
          ]));
          if (!compare.disposed && stalePage !== compare.page) {
            assert.strictEqual(inFlight.length, beforeCount, `Stale page=${String(stalePage)} must not reach onMessage`);
          }
        } else if (op === 4) {
          // add / addUris (triggers reload when room is available).
          if (rng.bool(0.5)) {
            send({ type: 'add', page: curPage });
          } else {
            compare.addUris([rng.pick(uris)]);
            notePageChange();
          }
        } else if (op === 5) {
          // remove with valid, out-of-bounds, negative, fractional, and non-finite indices.
          const idx = rng.pick([0, 1, 2, 3, -1, 99, 1.5, NaN, '0', null]);
          send({ type: 'remove', page: curPage, index: idx });
        } else if (op === 6) {
          // reload / stop / tileSize / tileOrder / pref.
          const sub = rng.int(0, 4);
          if (sub === 0) { compare.reload(); notePageChange(); }
          else if (sub === 1) send({ type: 'stop', page: curPage });
          else if (sub === 2) send({ type: 'tileSize', page: curPage, tile: rng.pick([null, {}, { w: -1, h: NaN, cols: 'bad', factor: 0 }]) });
          else if (sub === 3) send({ type: 'tileOrder', page: curPage, order: rng.pick([null, 'bad', [2, 0, 1, 99, -1]]) });
          else send({ type: 'pref', page: curPage, key: rng.pick(['jump.arrow', 'bad']), value: rng.pick([5, 'bad']) });
        } else if (op === 7) {
          // Malformed envelopes.
          receive(rng.pick([
            null,
            undefined,
            {},
            { page: curPage },
            { type: null, page: curPage },
            { type: 123, page: curPage },
            { type: 'nd', page: curPage, key: null, m: null },
            { type: 'nd', page: curPage, key: 123, m: {} },
            { type: 'transcodePref', page: curPage, mode: 'invalid', maxBitrateMbps: -5 },
          ]));
        } else if (op === 8) {
          await tick(rng.int(1, 2));
          notePageChange();
        }
      }

      // Dispose and double dispose (both direct and via panel).
      compare.dispose();
      disposedAt = posts.length;
      compare.dispose();
      panel.dispose();
      panel.dispose();

      // Post-dispose messages must be ignored.
      const beforeInFlight = inFlight.length;
      receive({ type: 'ready', page: compare.page });
      receive({ type: 'readBlock', page: compare.page, key: 'A', pos: 0, len: 64 });
      compare.addUris([uris[2]]);
      assert.strictEqual(inFlight.length, beforeInFlight, 'No onMessage calls after CompareSession.dispose()');

      await Promise.all(inFlight);
      await tick(2);

      assert.strictEqual(
        posts.length,
        disposedAt,
        `Compare episode ${ep}: no messages may be posted after dispose() (was ${disposedAt}, now ${posts.length})`,
      );

      for (let idx = 0; idx < posts.length; idx++) {
        const m = posts[idx];
        assert.strictEqual(typeof m.page, 'number', 'Compare host posts must carry numeric page id');
        if (m.type === 'block') {
          assert.ok(/^(s[AB]|[A-P])$/.test(m.key), `Compare episode ${ep}: block for tile key ${String(m.key)}`);
          if (!(Number.isInteger(m.pos) && m.pos >= 0)) assert.strictEqual(m.data.length, 0, `bad position ${String(m.pos)} answers empty`);
        }
        assert.ok(m.type !== 'error' || !/RangeError|ERR_OUT_OF_RANGE/.test(String(m.message)), `Compare episode ${ep}: ${m.message}`);
        if (deadPageCutoff.has(m.page)) {
          const cutoff = deadPageCutoff.get(m.page);
          assert.ok(idx < cutoff, `Compare episode ${ep}: post ${m.type} for dead page ${m.page} at ${idx} >= ${cutoff}`);
        }
      }
    }

    await tick(3);
    assert.strictEqual(openHandles, 0, `Suite B leaked ${openHandles} open file handle(s)`);
  } finally {
    fs.promises.stat = origStat;
    fs.promises.open = origOpen;
    h.dispose();
  }
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
    await runSuiteA(rng, tmpDir);
    await runSuiteB(rng, tmpDir);
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
