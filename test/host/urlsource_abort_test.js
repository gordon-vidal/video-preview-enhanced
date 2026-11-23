'use strict';
// Network cancellation in src/urlsource.js (docs/review/2026-11-21-architecture.md L2): a load's AbortSignal
// reaches inspection, HLS planning and range reads; an abort settles them at once with an AbortError; no
// 'abort' listener stays on a shared signal; and ffmpeg asks for certificate checks (-tls_verify 1) on https://.
// Local servers only (127.0.0.1); the HTTPS part also needs ffprobe/ffmpeg and openssl and is skipped without them.
const assert = require('assert');
const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, execFileSync, spawnSync } = require('child_process');
const us = require('../../src/urlsource');
const ff = require('../../src/ffmpeg');

const within = (p, ms, what) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`${what}: still pending after ${ms} ms`)), ms);
  p.then(
    (v) => { clearTimeout(timer); resolve(v); },
    (e) => { clearTimeout(timer); reject(e); },
  );
});
const isAbort = (e) => e && e.name === 'AbortError';

/** A signal that counts its live 'abort' listeners (add minus remove) and the most there were at once. */
function countedSignal() {
  const ctl = new AbortController();
  const s = ctl.signal;
  const add = s.addEventListener.bind(s);
  const del = s.removeEventListener.bind(s);
  const c = { live: 0, peak: 0, added: 0, ctl, signal: s };
  const mine = new Map(); // listener -> what was really registered
  const sync = () => { c.live = mine.size; c.peak = Math.max(c.peak, c.live); };
  s.addEventListener = (type, fn, o) => {
    if (type !== 'abort') return add(type, fn, o);
    c.added++;
    // A { once: true } listener removes itself when it fires: count that as a removal too.
    const real = o && o.once ? (e) => { mine.delete(fn); sync(); fn(e); } : fn;
    mine.set(fn, real);
    sync();
    return add(type, real, o);
  };
  s.removeEventListener = (type, fn, o) => {
    if (type !== 'abort') return del(type, fn, o);
    const real = mine.get(fn);
    mine.delete(fn);
    sync();
    return del(type, real || fn, o);
  };
  return c;
}

(async () => {
  const warnings = [];
  process.on('warning', (w) => warnings.push(w));

  // 188-byte-aligned dummy segment bytes are enough: nothing here decodes.
  const BODY = Buffer.alloc(4096, 7);
  const hits = [];
  const sockets = new Set();
  const hitWaiters = new Map(); // pathname -> Array<() => void>
  const notifyHit = (p) => {
    const ws = hitWaiters.get(p);
    if (!ws) return;
    hitWaiters.delete(p);
    for (const r of ws) r();
  };
  const waitHit = (p) => new Promise((r) => {
    const ws = hitWaiters.get(p) || [];
    ws.push(r);
    hitWaiters.set(p, ws);
  });
  let redirectBodyClosed = null;
  let markRedirectClosed = null;

  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    hits.push(u.pathname);
    const base = `http://${req.headers.host}`;
    switch (u.pathname) {
      case '/ok.mp4': { // range-capable file
        const m = /^bytes=(\d+)-(\d+)?$/.exec(req.headers.range || '');
        if (!m) { res.writeHead(200, { 'Content-Length': BODY.length, 'Content-Type': 'video/mp4' }); res.end(BODY); return; }
        const a = Number(m[1]);
        const b = Math.min(BODY.length - 1, m[2] === undefined ? BODY.length - 1 : Number(m[2]));
        res.writeHead(206, { 'Content-Type': 'video/mp4', 'Content-Range': `bytes ${a}-${b}/${BODY.length}`, 'Content-Length': b - a + 1 });
        res.end(BODY.subarray(a, b + 1));
        return;
      }
      case '/redirect.mp4': res.writeHead(302, { Location: `${base}/ok.mp4` }); res.end(); return;
      case '/redirect-stream.mp4': {
        res.writeHead(302, { Location: `${base}/ok.mp4` });
        res.write('redirecting...');
        const iv = setInterval(() => { if (!res.destroyed) res.write('...'); }, 25);
        res.on('close', () => { clearInterval(iv); if (markRedirectClosed) markRedirectClosed(); });
        return;
      }
      case '/missing.mp4': res.writeHead(404); res.end(); return;
      case '/hang.mp4': notifyHit('/hang.mp4'); return; // no answer at all
      case '/trickle.mp4': // headers and one byte, then nothing
        res.writeHead(206, { 'Content-Type': 'video/mp4', 'Content-Range': 'bytes 0-4095/4096', 'Content-Length': 4096 });
        res.write(Buffer.alloc(1), () => notifyHit('/trickle.mp4'));
        return;
      case '/master.m3u8':
        res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
        res.end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=640x360\nhang.m3u8\n');
        return;
      case '/hang.m3u8': notifyHit('/hang.m3u8'); return;
      case '/seg.ts': // a segment that starts and then stalls
        res.writeHead(206, { 'Content-Type': 'video/mp2t', 'Content-Range': 'bytes 0-99/100', 'Content-Length': 100 });
        res.write(Buffer.alloc(1), () => notifyHit('/seg.ts'));
        return;
      default: res.writeHead(404); res.end();
    }
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  let passed = 0;
  const check = async (name, fn) => { try { await fn(); passed++; } catch (e) { e.message = `${name}: ${e.message}`; throw e; } };

  try {
    await check('a signal aborted before the call sends nothing', async () => {
      const ctl = new AbortController();
      ctl.abort();
      const before = hits.length;
      for (const run of [
        () => us.inspect(`${base}/ok.mp4`, { signal: ctl.signal }),
        () => us.fetchRange(`${base}/ok.mp4`, 0, 9, { signal: ctl.signal }),
        () => us.open(`${base}/ok.mp4`, { signal: ctl.signal }),
        () => us.hlsOpen({ text: '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nv.m3u8\n', url: `${base}/master.m3u8` }, { signal: ctl.signal }),
      ]) await assert.rejects(within(run(), 1000, 'pre-aborted'), isAbort);
      assert.strictEqual(hits.length, before, 'no request was sent');
      // Files with a pre-aborted signal are closed synchronously (even with cached head bytes).
      const f = new us.HttpFile({ url: `${base}/ok.mp4`, size: 4096, rangeOk: true, head: Buffer.alloc(64, 1) }, { signal: ctl.signal });
      assert.strictEqual(f.closed, true, 'HttpFile closed synchronously');
      await assert.rejects(f.read(0, 10), (e) => e.code === 'CLOSED');
    });

    await check('abort while the server has not answered (inspect)', async () => {
      const c = countedSignal();
      const arrived = waitHit('/hang.mp4');
      const p = us.inspect(`${base}/hang.mp4`, { signal: c.signal, timeoutMs: 10000 });
      await within(arrived, 2000, 'hang.mp4 hit');
      c.ctl.abort();
      await assert.rejects(within(p, 1000, 'inspect'), isAbort);
      assert.strictEqual(c.live, 0, 'no listener left');
    });

    await check('abort in the middle of the body (inspect, fetchRange)', async () => {
      for (const run of [(o) => us.inspect(`${base}/trickle.mp4`, o), (o) => us.fetchRange(`${base}/trickle.mp4`, 0, 4095, o)]) {
        const c = countedSignal();
        const streaming = waitHit('/trickle.mp4');
        const p = run({ signal: c.signal, timeoutMs: 10000 });
        await within(streaming, 2000, 'trickle.mp4 body start');
        c.ctl.abort();
        await assert.rejects(within(p, 1000, 'body read'), isAbort);
        assert.strictEqual(c.live, 0, 'no listener left');
      }
    });

    await check('abort during HLS planning (variant playlist)', async () => {
      const c = countedSignal();
      const arrived = waitHit('/hang.m3u8');
      const info = { text: '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=640x360\nhang.m3u8\n', url: `${base}/master.m3u8` };
      const p = us.hlsOpen(info, { signal: c.signal, timeoutMs: 10000 });
      await within(arrived, 2000, 'hang.m3u8 hit');
      c.ctl.abort();
      await assert.rejects(within(p, 1000, 'hlsOpen'), isAbort);
      assert.strictEqual(c.live, 0);
    });

    await check('abort during an HLS segment read, and the file follows the load signal', async () => {
      const c = countedSignal();
      const text = `#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\n#EXT-X-BYTERANGE:100@0\n${base}/seg.ts\n#EXT-X-ENDLIST\n`;
      const hls = new us.HlsFile({ text, url: `${base}/v.m3u8`, kind: 'hls' }, { signal: c.signal, timeoutMs: 10000 });
      await hls.open(); // byte ranges give the sizes: no request yet
      assert.strictEqual(hls.size, 100);
      const streaming = waitHit('/seg.ts');
      const p = hls.read(0, 50);
      await within(streaming, 2000, 'seg.ts body start');
      c.ctl.abort(); // the load is superseded: nobody calls hls.close()
      const e = await within(p.then(() => null, (x) => x), 1000, 'segment read');
      assert.ok(e && (isAbort(e) || e.code === 'CLOSED'), `the read rejects as cancelled (${e && e.message})`);
      assert.strictEqual(hls.closed, true, 'closed by the signal');
      await assert.rejects(hls.read(0, 10), (x) => x.code === 'CLOSED');
      assert.strictEqual(c.live, 0);
    });

    await check('abort during an HttpFile range read, with the load signal', async () => {
      const c = countedSignal();
      const f = new us.HttpFile({ url: `${base}/trickle.mp4`, size: 4096, rangeOk: true, head: Buffer.alloc(0) }, { signal: c.signal, timeoutMs: 10000 });
      const streaming = waitHit('/trickle.mp4');
      const p = f.read(0, 4096).then(() => null, (x) => x);
      await within(streaming, 2000, 'trickle.mp4 range start');
      c.ctl.abort();
      const e = await within(p, 1000, 'range read');
      assert.ok(e instanceof Error && (isAbort(e) || e.code === 'CLOSED'), `rejected (${e && e.message})`);
      assert.strictEqual(f.closed, true);
      assert.strictEqual(c.live, 0);
    });

    await check('redirect with a streaming body destroys the discarded response at handoff', async () => {
      const c = countedSignal();
      redirectBodyClosed = new Promise((r) => { markRedirectClosed = r; });
      const r = await within(us.fetchRange(`${base}/redirect-stream.mp4`, 0, 9, { signal: c.signal }), 2000, 'redirect');
      assert.strictEqual(r.body.length, 10);
      await within(redirectBodyClosed, 1000, 'discarded redirect response closed');
      assert.strictEqual(c.live, 0);
    });

    await check('closing a file removes its link to the load signal', async () => {
      const c = countedSignal();
      const f = new us.HttpFile({ url: `${base}/ok.mp4`, size: 4096, rangeOk: true, head: Buffer.alloc(0) }, { signal: c.signal });
      assert.strictEqual(c.live, 1);
      f.close();
      assert.strictEqual(c.live, 0);
      const h = new us.HlsFile({ text: `#EXTM3U\n#EXTINF:2,\n#EXT-X-BYTERANGE:10@0\n${base}/ok.mp4\n#EXT-X-ENDLIST\n`, url: `${base}/v.m3u8` }, { signal: c.signal });
      assert.strictEqual(c.live, 1);
      h.close();
      assert.strictEqual(c.live, 0);
    });

    await check('no abort listener is left after many reads on one signal', async () => {
      const c = countedSignal();
      const o = { signal: c.signal };
      for (let i = 0; i < 60; i++) {
        const r = await us.fetchRange(`${base}/ok.mp4`, 0, 99, o);
        assert.strictEqual(r.body.length, 100);
      }
      for (let i = 0; i < 10; i++) await us.fetchRange(`${base}/redirect.mp4`, 0, 9, o);
      for (let i = 0; i < 10; i++) await assert.rejects(us.fetchRange(`${base}/missing.mp4`, 0, 9, o), /404/);
      for (let i = 0; i < 10; i++) await us.inspect(`${base}/ok.mp4`, o);
      // Concurrent reads share the signal: 40 in flight at once.
      await Promise.all(Array.from({ length: 40 }, (_, i) => us.fetchRange(`${base}/ok.mp4`, i, i + 9, o)));
      assert.strictEqual(c.live, 0, `listeners left: ${c.live}`);
      assert.ok(c.peak <= 1, `one shared listener at most, saw ${c.peak}`);
      assert.deepStrictEqual(warnings.filter((w) => /MaxListeners/.test(w.name)), [], 'no MaxListenersExceededWarning');
    });

    await check('onAbort: isolation, live unsubscribe during dispatch, pre-aborted and re-entrant hooks', async () => {
      const c = countedSignal();
      const ran = [];
      let offSkipped = () => {};
      const offA = us.onAbort(c.signal, () => {
        ran.push('a');
        offSkipped(); // unsubscribes a later hook during dispatch
        us.onAbort(c.signal, () => ran.push('reentrant')); // signal is already aborted: runs immediately
        throw new Error('boom'); // must not stop later hooks
      });
      const offB = us.onAbort(c.signal, () => ran.push('b'));
      offSkipped = us.onAbort(c.signal, () => ran.push('skipped'));
      us.onAbort(c.signal, () => ran.push('c'));
      assert.strictEqual(c.live, 1);
      offB();
      offB();
      c.ctl.abort();
      assert.deepStrictEqual(ran, ['a', 'reentrant', 'c']);
      offA();
      assert.strictEqual(c.live, 0);
      // Already-aborted signal runs synchronously and registers no listener.
      let immediate = 0;
      us.onAbort(c.signal, () => { immediate++; });
      assert.strictEqual(immediate, 1);
      assert.strictEqual(c.live, 0);
      us.onAbort(undefined, () => {})(); // no signal: a no-op
    });

  } finally {
    for (const s of sockets) s.destroy();
    server.close();
  }

  // ---- ffmpeg: -tls_verify 1 -----------------------------------------------------------------
  await check('inputArgs asks ffmpeg to verify certificates on https:// only', () => {
    const a = ff.inputArgs({ url: 'https://h.com/a.mp4' });
    const i = a.indexOf('-tls_verify');
    assert.ok(i >= 0 && a[i + 1] === '1', `-tls_verify 1 in ${a.join(' ')}`);
    assert.ok(i < a.indexOf('-i'), 'an input option: before -i');
    assert.deepStrictEqual(a.slice(-2), ['-i', 'https://h.com/a.mp4']);
    // Plain http:// must NOT get -tls_verify (ffmpeg rejects it with Option not found).
    assert.ok(!ff.inputArgs({ url: 'http://h.com/a.mp4' }).includes('-tls_verify'));
    assert.ok(!ff.inputArgs({ url: 'http://h.com/a.mp4', proxy: 'http://p:3128' }).includes('-tls_verify'));
    // http.proxyStrictSSL off (a proxy that re-signs HTTPS): the user's choice is kept.
    assert.ok(!ff.inputArgs({ url: 'https://h.com/a.mp4', strictSSL: false }).includes('-tls_verify'));
    assert.ok(ff.inputArgs({ url: 'https://h.com/a.mp4', strictSSL: true }).includes('-tls_verify'));
    // Files are untouched.
    assert.deepStrictEqual(ff.inputArgs('C:\\v\\a.mp4'), ['-protocol_whitelist', 'file', '-i', 'C:\\v\\a.mp4']);
  });

  const have = (cmd, args) => { try { return spawnSync(cmd, args, { windowsHide: true }).status === 0; } catch { return false; } };
  if (have('ffprobe', ['-version']) && have('ffmpeg', ['-version']) && have('openssl', ['version'])) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vpe_tls_'));
    const servers = [];
    try {
      const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'ignore', windowsHide: true });
      run('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=d=1:s=64x64:r=10', '-pix_fmt', 'yuv420p', path.join(dir, 't.mp4')]);
      run('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem'), '-days', '1', '-subj', '/CN=localhost']);
      const bytes = fs.readFileSync(path.join(dir, 't.mp4'));
      const handler = (q, r) => { r.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': bytes.length }); r.end(bytes); };
      const sec = https.createServer({ key: fs.readFileSync(path.join(dir, 'k.pem')), cert: fs.readFileSync(path.join(dir, 'c.pem')) }, handler);
      const plain = http.createServer(handler);
      for (const s of [sec, plain]) { await new Promise((r) => s.listen(0, '127.0.0.1', r)); servers.push(s); }
      // Async: the local servers live in this process and must keep answering while ffprobe/ffmpeg runs.
      const probe = (input) => new Promise((resolve) => {
        const args = ff.inputArgs(input);
        execFile('ffprobe', ['-v', 'error', ...args.slice(0, -2), '-show_entries', 'format=duration', '-of', 'csv=p=0', ...args.slice(-2)],
          { windowsHide: true, timeout: 15000 }, (err, stdout, stderr) => resolve({ status: err ? (err.code || 1) : 0, stdout, stderr }));
      });
      const decode = (input) => new Promise((resolve) => {
        const args = ff.inputArgs(input);
        execFile('ffmpeg', ['-v', 'error', ...args, '-frames:v', '1', '-f', 'null', '-'],
          { windowsHide: true, timeout: 15000 }, (err, stdout, stderr) => resolve({ status: err ? (err.code || 1) : 0, stdout, stderr }));
      });
      // Plain http probes AND decodes cleanly; self-signed HTTPS is refused by both ffprobe and ffmpeg.
      const httpInput = { url: `http://127.0.0.1:${plain.address().port}/t.mp4` };
      const httpsInput = { url: `https://localhost:${sec.address().port}/t.mp4` };
      const okProbe = await probe(httpInput);
      assert.strictEqual(okProbe.status, 0, `plain http ffprobe: ${okProbe.stderr}`);
      assert.ok(Number(okProbe.stdout) > 0);
      const okDecode = await decode(httpInput);
      assert.strictEqual(okDecode.status, 0, `plain http ffmpeg decode: ${okDecode.stderr}`);
      const badProbe = await probe(httpsInput);
      assert.notStrictEqual(badProbe.status, 0, 'ffprobe refuses self-signed certificate');
      assert.match(badProbe.stderr, /certificate|verif|I\/O error|Input\/output/i);
      const badDecode = await decode(httpsInput);
      assert.notStrictEqual(badDecode.status, 0, 'ffmpeg refuses self-signed certificate');
      assert.match(badDecode.stderr, /certificate|verif|I\/O error|Input\/output/i);
      passed++;
    } catch (e) {
      e.message = `ffprobe/ffmpeg with -tls_verify 1: ${e.message}`;
      throw e;
    } finally {
      for (const s of servers) s.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  } else console.log('urlsource_abort_test: ffprobe/openssl not found, the HTTPS check is skipped');

  assert.deepStrictEqual(warnings.filter((w) => /MaxListeners/.test(w.name)), [], 'no MaxListenersExceededWarning');
  console.log(`urlsource_abort_test: ${passed} ok`);
})().catch((e) => { console.error(e); process.exit(1); });
