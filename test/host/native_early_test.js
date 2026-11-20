'use strict';
// node test/host/native_early_test.js: native ffmpeg starts with the session, before the page is
// ready (docs/notes/startup-memory.md), with the mock vscode and a real ffmpeg (on PATH, or
// VPE_FFMPEG). The early process is kept when the page connects to the frame server (no second
// ffmpeg, frames at the frame server's size), restarted at the message size when the transport
// falls back, and killed when the tab closes, the decision changes or the file changes before
// the page is ready. Skipped without ffmpeg.
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const ff = require('../../src/ffmpeg');
const frameserver = require('../../src/frameserver');
const { load } = require('./mock_vscode');

const src = path.join(__dirname, '..', '..', 'media', 'probe', 'hevc_10_2160.mkv');
const origin = 'vscode-webview://early-test';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function gone(pid, what) {
  for (let i = 0; i < 200 && alive(pid); i++) await wait(10);
  assert.ok(!alive(pid), `${what}: the early ffmpeg (pid ${pid}) was killed`);
}

(async () => {
  const tools = await ff.locateTools(process.env.VPE_FFMPEG || '', '');
  if (!tools) { console.log('native early start: skipped (no ffmpeg)'); return; }
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'vpe_early_'));
  const clip = path.join(work, 'hevc_10_2160.mkv');
  fs.copyFileSync(src, clip);
  const settings = { 'videoPreviewEnhanced.ffmpegPath': tools.ffmpeg };
  const record = {
    fp: 'whatever', complete: true, ffmpeg: tools.version, ffmpegPath: tools.ffmpeg, gpus: [], at: 1, maxHeight: 2160,
    results: { 'hevc/10/2160': { method: 'none', fps: 140, realtimeFactor: 4.6, sw: 140, tried: [{ method: 'none', ok: true, fps: 140 }] } },
  };
  const loaded = [];
  const start = async () => {
    const h = load({ settings });
    loaded.push(h);
    h.vscode.window.withProgress = async () => null; // no background GPU test
    await h.context.globalState.update('videoPreviewEnhanced.probe', record);
    const logs = h.context.subscriptions.find((x) => x && Array.isArray(x.lines)).lines;
    const s = h.open(clip);
    await s.shown;
    const until = async (re, ms = 15000) => {
      const t0 = Date.now();
      while (!logs.some((l) => re.test(l))) {
        if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${re}\n${logs.join('\n')}`);
        await wait(5);
      }
      return logs.find((l) => re.test(l));
    };
    const early = await until(/ffmpeg started before the page/);
    const pid = Number(/pid (\d+)/.exec(early)[1]);
    return { h, s, logs, until, pid };
  };
  const nd = (s, m) => s.send({ type: 'nd', m });
  const posted = (s, type) => s.posted.filter((m) => m.type === 'nd' && m.m.type === type).map((m) => m.m);
  const spawns = (logs) => logs.filter((l) => /native decode from /.test(l)).length;

  try {
    // 1. Kept: the page connects to the frame server, the early ffmpeg's frames arrive at full size.
    {
      const { h, s, logs, until, pid } = await start();
      assert.ok(alive(pid), 'running before the page is ready');
      assert.match(logs.join('\n'), /native decode from 0\.000 s: 3840x2160/);
      await s.send({ type: 'ready', origin });
      assert.ok(s.posted.some((m) => m.type === 'libav' && m.meta.native), 'native ffmpeg chosen');
      const opening = nd(s, { type: 'open' });
      await s.until(() => posted(s, 'link').length, 5000);
      const link = posted(s, 'link')[0];
      const res = await new Promise((resolve, reject) => http.get(link.url, { headers: { Origin: origin } }, resolve).on('error', reject));
      assert.strictEqual(res.statusCode, 200);
      await opening;
      const streams = posted(s, 'streams')[0];
      assert.ok(streams, 'streams posted');
      assert.deepStrictEqual([streams.info.video.width, streams.info.video.height], [3840, 2160]);
      assert.match(logs.join('\n'), /keeping the ffmpeg started before the page/);
      assert.strictEqual(spawns(logs), 1, 'one ffmpeg, no restart');
      await nd(s, { type: 'config' });
      const head = new Promise((resolve) => {
        let buf = Buffer.alloc(0);
        res.on('data', (d) => { buf = Buffer.concat([buf, d]); if (buf.length >= frameserver.HEADER) { res.destroy(); resolve(frameserver.parseHeader(buf)); } });
      });
      await nd(s, { type: 'more', gen: 0 });
      const rec = await head;
      assert.deepStrictEqual([rec.kind, rec.w, rec.h, rec.t], [frameserver.KIND_FRAME, 3840, 2160, 0], 'first frame from the early ffmpeg');
      s.panel.dispose();
      await gone(pid, 'tab closed after playing');
      h.dispose();
    }

    // 2. The transport falls back to messages (no origin): restarted at the message size.
    {
      const { h, s, logs, pid } = await start();
      await s.send({ type: 'ready' });
      await nd(s, { type: 'open' });
      const streams = posted(s, 'streams')[0];
      assert.deepStrictEqual([streams.info.video.width, streams.info.video.height], [1920, 1080]);
      assert.match(logs.join('\n'), /restarting ffmpeg at 1920x1080 \(started before the page at 3840x2160\)/);
      assert.strictEqual(spawns(logs), 2);
      await gone(pid, 'transport fell back');
      s.panel.dispose();
      h.dispose();
    }

    // 3. The tab closes before the page is ready.
    {
      const { h, s, logs, pid } = await start();
      s.panel.dispose();
      await gone(pid, 'tab closed before ready');
      assert.match(logs.join('\n'), /early ffmpeg stopped: closed/);
      h.dispose();
    }

    // 4. The decision changes before the page is ready (decoder: builtin): killed, built-in.
    {
      const { h, s, logs, pid } = await start();
      settings['videoPreviewEnhanced.decoder'] = 'builtin';
      try {
        await s.send({ type: 'ready', origin });
        await s.until((p) => p.some((m) => m.type === 'libav'), 5000);
      } finally { delete settings['videoPreviewEnhanced.decoder']; }
      assert.ok(!s.posted.find((m) => m.type === 'libav').meta.native, 'built-in');
      await gone(pid, 'decision changed');
      assert.match(logs.join('\n'), /early ffmpeg stopped: not used/);
      s.panel.dispose();
      h.dispose();
    }

    // 5. The file changes before the page is ready: killed; the page's open probes again.
    {
      const { h, s, logs, until, pid } = await start();
      const t = new Date(Date.now() + 5000);
      fs.utimesSync(clip, t, t);
      await until(/early ffmpeg stopped: file changed/, 5000);
      await gone(pid, 'file changed');
      await s.send({ type: 'ready', origin });
      assert.ok(s.posted.find((m) => m.type === 'libav').meta.native, 'native again');
      assert.ok(!/keeping the ffmpeg/.test(logs.join('\n')));
      s.panel.dispose();
      h.dispose();
    }
    // 6. The file is rewritten before the page is ready, faster than the watcher (800 ms): open()
    //    sees another size/date than the early probe had, probes again and replaces the early ffmpeg.
    {
      const { h, s, logs, pid } = await start();
      fs.copyFileSync(path.join(__dirname, '..', '..', 'media', 'probe', 'hevc_8_1080.mkv'), clip);
      await s.send({ type: 'ready', origin });
      await gone(pid, 'file rewritten');
      const all = logs.join('\n');
      assert.match(all, /early ffmpeg stopped: the decision changed/);
      assert.match(all, /native decode from 0\.000 s: 1920x1080/, all);
      s.panel.dispose();
      h.dispose();
      fs.copyFileSync(src, clip);
    }

    // 7. MJPEG AVI skips ffprobe. The file is rewritten as MPEG-4 and reloads: probed then.
    {
      const avi = path.join(work, 'clip.avi');
      fs.copyFileSync(path.join(__dirname, '..', 'media', 'cases', 's_mjpeg.avi'), avi);
      const h = load({ settings });
      loaded.push(h);
      h.vscode.window.withProgress = async () => null;
      const logs = h.context.subscriptions.find((x) => x && Array.isArray(x.lines)).lines;
      const probe = ff.probe;
      let probes = 0;
      ff.probe = (...args) => { probes++; return probe(...args); };
      try {
        const s = h.open(avi);
        await s.shown;
        await s.send({ type: 'ready', origin });
        assert.ok(!s.posted.some((m) => m.type === 'libav'), 'MJPEG frame player, not a decoder');
        assert.strictEqual(probes, 0);
        const html0 = s.panel.webview.html;
        fs.copyFileSync(path.join(__dirname, '..', 'media', 'cases', 's_xvid.avi'), avi);
        await s.until(() => s.panel.webview.html !== html0, 5000);
        s.posted.length = 0;
        await s.send({ type: 'ready', origin });
        await s.until((p) => p.some((m) => m.type === 'libav'), 15000);
        assert.strictEqual(probes, 1);
        const decisions = logs.filter((l) => /\] decoder: /.test(l));
        assert.ok(decisions.length >= 1, logs.join('\n'));
        assert.match(decisions[decisions.length - 1], /mpeg4/i, `decided from the rewritten file: ${decisions.join('\n')}`);
        assert.ok(!logs.some((l) => /using the ffmpeg started before the page/.test(l)), 'no early ffmpeg of the old file');
        s.panel.dispose();
        h.dispose();
      } finally { ff.probe = probe; }
    }

    // 8. A restored background tab waits for visibility. Closing it during ffprobe or
    //    changing the decoder before ready cancels it, even once open() has taken the probe.
    for (const discard of ['closed', 'ready then closed', 'built-in']) {
      const h = load({ settings });
      loaded.push(h);
      h.vscode.window.withProgress = async () => null;
      const s = h.open(clip, { visible: false });
      const probe = ff.probe;
      const locateTools = ff.locateTools;
      let lookups = 0;
      const signals = [];
      ff.locateTools = async () => { lookups++; return tools; };
      ff.probe = (_tools, _file, signal) => {
        assert.ok(signal, 'only the early probe is expected');
        signals.push(signal);
        return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
      };
      try {
        await s.shown;
        assert.strictEqual(lookups, 0, 'hidden tab does not start the lookup');
        s.setVisible(true);
        await s.until(() => signals.length);
        s.setVisible(false);
        s.setVisible(true);
        if (discard === 'built-in') settings['videoPreviewEnhanced.decoder'] = 'builtin';
        const ready = discard === 'closed' ? null : s.send({ type: 'ready', origin });
        if (discard === 'ready then closed') await s.until((p) => p.some((m) => m.type === 'ffmpegState'));
        if (discard === 'built-in') await ready;
        else s.panel.dispose();
        await ready;
        assert.strictEqual(signals.length, 1, 'one early probe across visibility changes');
        assert.ok(signals[0].aborted, discard);
      } finally {
        s.panel.dispose();
        h.dispose();
        ff.probe = probe;
        ff.locateTools = locateTools;
        delete settings['videoPreviewEnhanced.decoder'];
      }
    }

    // 9. A visible tab that cannot use native playback skips the early lookup.
    for (const mode of ['builtin', 'untrusted', 'ssh']) {
      const h = load({ settings: { ...settings, 'videoPreviewEnhanced.decoder': mode === 'builtin' ? 'builtin' : 'auto' } });
      if (mode === 'untrusted') h.vscode.workspace.isTrusted = false;
      if (mode === 'ssh') h.vscode.env.remoteName = 'ssh-remote';
      const locateTools = ff.locateTools;
      let lookups = 0;
      ff.locateTools = async () => { lookups++; return tools; };
      const s = h.open(clip);
      try {
        await s.shown;
        assert.strictEqual(lookups, 0, mode);
      } finally {
        s.panel.dispose();
        h.dispose();
        ff.locateTools = locateTools;
      }
    }

    // 10. A header can launch ffmpeg while ffprobe is pending, but cannot authorize its frames.
    for (const [file, field, value] of [
      ['hevc_10_2160p.mp4', 'fps', 15],
      ['cases/fmt/hevc10_opus.mkv', 'pixFmt', 'yuv422p10le'],
    ]) {
      const media = path.join(__dirname, '..', 'media', file);
      const h = load({ settings: { ...settings, 'videoPreviewEnhanced.gpuDecoding': false } });
      loaded.push(h);
      h.vscode.window.withProgress = async () => null;
      const actualProbe = ff.probe;
      const pr = await actualProbe(tools, media);
      const openFile = fs.promises.open;
      let confirm, releaseSniff;
      let probeCalled = false;
      let sniffCalled = false;
      const pending = new Promise((resolve) => { confirm = resolve; });
      const sniffPending = new Promise((resolve) => { releaseSniff = resolve; });
      fs.promises.open = async (file, ...args) => {
        if (file === media) { sniffCalled = true; await sniffPending; }
        return openFile(file, ...args);
      };
      ff.probe = () => { probeCalled = true; return pending; };
      const s = h.open(media);
      const logs = h.context.subscriptions.find((x) => x && Array.isArray(x.lines)).lines;
      try {
        await s.shown;
        await s.until(() => sniffCalled && probeCalled, 5000);
        assert.ok(!spawns(logs), 'ffprobe starts while the header read is pending');
        releaseSniff();
        await s.until(() => logs.some((l) => /ffmpeg started before the page/.test(l)), 5000);
        const early = logs.find((l) => /ffmpeg started before the page/.test(l));
        const pid = Number(/pid (\d+)/.exec(early)[1]);
        const opening = s.send({ type: 'ready', origin });
        assert.ok(!s.posted.some((m) => m.type === 'libav'), 'the page still needs confirmation');
        pr.video[field] = value;
        confirm(pr);
        await opening;
        await gone(pid, `ffprobe disagreed with the ${file} header`);
        assert.match(logs.join('\n'), /early ffmpeg stopped: the decision changed/);
        assert.strictEqual(spawns(logs), 2);
      } finally {
        releaseSniff();
        confirm(pr);
        fs.promises.open = openFile;
        ff.probe = actualProbe;
        s.panel.dispose();
        h.dispose();
      }
    }

    // 11. The signal reaches the subprocess, including on Windows.
    const pidFile = path.join(work, 'probe.pid');
    const abort = new AbortController();
    const child = ff.run(process.execPath, ['-e', "require('fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000)", pidFile], 30000, abort.signal);
    try {
      for (let i = 0; i < 200 && !fs.existsSync(pidFile); i++) await wait(10);
      const pid = Number(fs.readFileSync(pidFile, 'utf8'));
      assert.ok(pid > 0 && alive(pid));
      abort.abort();
      assert.notStrictEqual((await child).code, 0);
      await gone(pid, 'probe cancelled');
    } finally { abort.abort(); }
    console.log('native early start: ok');
  } finally {
    for (const h of loaded) try { h.dispose(); } catch { /* done */ }
    await wait(300);
    fs.rmSync(work, { recursive: true, force: true });
  }
})().catch((e) => { console.error(e); process.exit(1); });
