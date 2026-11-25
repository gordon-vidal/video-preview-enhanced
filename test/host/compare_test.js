'use strict';
// Compare's native queue uses WSL host memory, and a new page reads the current file rotation.
const assert = require('assert');
const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { load } = require('./mock_vscode');
const { GB, budgets } = require('../../media/membudget');
const { rotationOf } = require('../../src/rotation');
const { make } = require('../media/make_cases_media');

(async () => {
  const rotated = make('rotated.mp4');
  const upright = make('s_h264.mp4');
  assert.ok(rotated && upright, 'ffmpeg test clips');
  const { totalmem, freemem } = os;
  const h = load({ settings: {
    'videoPreviewEnhanced.decoder': 'ffmpeg',
    'videoPreviewEnhanced.compare.maxVideos': 4,
  } });
  let compare;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vpe-compare-'));
  const rewritten = path.join(dir, 'rewritten.mp4');
  try {
    fs.copyFileSync(upright, rewritten);
    os.totalmem = () => 8 * GB;
    os.freemem = () => 4 * GB;
    h.vscode.env.remoteName = 'wsl';
    h.vscode.window.withProgress = async () => null;
    const posts = [];
    const warnings = [];
    h.vscode.window.showWarningMessage = async (w) => { warnings.push(w); };
    let receive = null;
    const webview = {
      cspSource: 'vscode-resource:', asWebviewUri: (u) => u,
      postMessage(m) { posts.push(m); }, onDidReceiveMessage(fn) { receive = fn; },
    };
    h.vscode.window.createWebviewPanel = () => ({ webview, onDidDispose() {}, onDidChangeViewState() {} });
    compare = await h.vscode._commands['videoPreviewEnhanced.compare'](null, [rewritten, upright].map(h.vscode.Uri.file));
    const cfg = () => JSON.parse(/<script type="application\/json" id="cfg">([^<]*)<\/script>/.exec(webview.html)[1]);
    assert.strictEqual(cfg().engine.mem, null, 'WSL webview uses client memory');
    assert.deepStrictEqual(cfg().rotation, [0, 0]);
    await compare.onMessage({ type: 'ready' });
    const queue = Math.floor(budgets(8).nativeQueue / 2);
    assert.deepStrictEqual(compare.natives.map((n) => n.maxQueued), [queue, queue]);

    fs.copyFileSync(rotated, rewritten);
    // s_h264.mp4 and rotated.mp4 have identical byte sizes; ensure a distinct mtime on coarse-clock filesystems.
    const nextMtime = new Date(Date.now() + 2000);
    fs.utimesSync(rewritten, nextMtime, nextMtime);
    await compare.reload();
    const rotation = await rotationOf(rotated);
    assert.ok(rotation > 0, 'rotated fixture');
    assert.deepStrictEqual(cfg().rotation, [rotation, 0], 'reload reads the rewritten file');

    // Messages carry the page id: the host stamps its posts and ignores a replaced page's messages.
    const page = cfg().page;
    assert.ok(page > 1, `each page has a new id: ${page}`);
    compare.post({ type: 'visible', visible: true });
    assert.strictEqual(posts.pop().page, page, 'host posts carry the page id');
    let handled = 0;
    const boot = 'current-document';
    await receive({ type: 'ready', page, boot });
    const onMessage = compare.onMessage;
    compare.onMessage = async () => { handled++; };
    receive({ type: 'tileSize', page: page - 1, boot });
    receive({ type: 'tileSize', boot });
    assert.strictEqual(handled, 0, 'messages from an old page (or without one) are dropped');
    receive({ type: 'tileSize', page, boot });
    assert.strictEqual(handled, 1, 'messages from the current page are handled');
    compare.onMessage = onMessage;

    // A read still in flight when the file set changes: its reply would reach the new page under a
    // tile key now used by another file. The overflow warning counts only usable files.
    let finishRead;
    let closed = false;
    const delayed = new Promise((resolve) => { finishRead = resolve; });
    compare.fhs[0] = Promise.resolve({ fh: { read: () => delayed, close: () => { closed = true; } }, size: 32 });
    posts.length = 0;
    const read = compare.readBlock('A', 0, 32);
    await Promise.resolve();
    const remote = h.vscode.Uri.file(upright).with({ scheme: 'http' });
    await compare.addUris([remote, ...Array(2).fill(h.vscode.Uri.file(upright))]);
    assert.strictEqual(cfg().names.length, 4, 'two usable files fill the two free slots');
    assert.deepStrictEqual(warnings, [], 'a skipped non-file URI is not counted as overflow');
    finishRead({ bytesRead: 32 });
    await read;
    assert.ok(closed, 'reload closes the old file');
    assert.ok(!posts.some((m) => m.type === 'block'), 'reload drops the reply of the old read');
    compare.addUris([h.vscode.Uri.file(upright)]);
    assert.strictEqual(cfg().names.length, 4);
    assert.strictEqual(warnings.length, 1, `full view warns: ${warnings}`);

    // A page whose decoders failed to start asks the host to stop: files and native tiles close.
    await compare.onMessage({ type: 'ready' });
    const natives = compare.natives.slice();
    assert.strictEqual(natives.length, 4);
    await compare.onMessage({ type: 'stop' });
    assert.ok(natives.every((n) => n.disposed) && !compare.natives.length, 'stop disposes every native tile');
    await compare.onMessage({ type: 'remove', index: 1.5 });
    assert.strictEqual(cfg().names.length, 4, 'a fractional index removes nothing');

    // Exercise the real session and stream ownership without requiring a GPU or encoder.
    let prefs = { transcode: 'always', transcodeMaxBitrate: 12, transcodeSplitBitrate: true };
    compare.prefs = () => prefs;
    compare.nativeFor = async () => ({
      tools: {}, maxHeight: 1080,
      probed: { duration: 10, video: { width: 1920, height: 1080, fps: 30 } },
      stream: { encoder: 'h264_nvenc', cpuEncoder: null, remote: false },
    });
    await compare.reload(compare.uris.slice(0, 2));
    compare.panel.visible = false;
    const ready = () => compare.onMessage({ type: 'ready', tile: { w: 1280, h: 720, cols: 2, rows: 1 } });
    const caps = () => compare.natives.filter(Boolean).map((n) => n.activeCapKbps());
    await ready();
    assert.ok(compare.natives.every((n) => n.hidden), 'host constructs streams hidden before the page configures them');
    compare.panel.visible = true;
    assert.deepStrictEqual(caps(), [6000, 6000]);
    const pair = compare.natives.slice();
    compare.addUris([h.vscode.Uri.file(upright)]);
    assert.ok(pair.every((n) => n.disposed), 'add reload closes the old streams');
    await ready();
    assert.deepStrictEqual(caps(), [4000, 4000, 4000]);
    compare.panel.visible = false;
    await compare.onMessage({ type: 'nd', key: 'A', m: { type: 'open' } });
    assert.strictEqual(compare.natives[0].spawns, 0, 'a panel hidden during page startup starts no encoder');
    compare.panel.visible = true;
    const trio = compare.natives.slice();
    await compare.onMessage({ type: 'remove', index: 1 });
    assert.ok(trio.every((n) => n.disposed), 'remove reload closes the old streams');
    await ready();
    assert.deepStrictEqual(caps(), [6000, 6000]);
    compare.updateTranscode(prefs = { ...prefs, transcodeSplitBitrate: false });
    assert.deepStrictEqual(caps(), [12000, 12000]);
    compare.updateTranscode(prefs = { ...prefs, transcodeSplitBitrate: true, transcodeMaxBitrate: 10 });
    assert.deepStrictEqual(caps(), [5000, 5000]);
    const [failed, survivor] = compare.natives;
    failed.onFail('no software encoder');
    assert.ok(failed.disposed);
    assert.strictEqual(compare.natives[1], survivor);
    assert.deepStrictEqual(caps(), [10000]);
    posts.length = 0;
    failed.post({ type: 'batch' });
    trio[1].post({ type: 'batch' });
    assert.deepStrictEqual(posts, [], 'disposed streams cannot post to the current tile or page');

    compare.addUris([compare.uris[1]]);
    await ready();
    const paths = () => Array.from(compare.uris, (_, i) => Boolean(compare.natives[i]));
    assert.deepStrictEqual(paths(), [false, true, true], 'add keeps fallback on the original occurrence');
    await compare.onMessage({ type: 'originalTile', index: 2 });
    compare.replaceUri(1, h.vscode.Uri.file(upright));
    await ready();
    assert.deepStrictEqual(paths(), [false, true, false], 'unrelated replace keeps both original tiles');
    await compare.onMessage({ type: 'remove', index: 0 });
    await ready();
    assert.deepStrictEqual(paths(), [true, false], 'remove shifts the surviving override with its tile');
    compare.replaceUri(1, compare.uris[1]);
    await ready();
    assert.deepStrictEqual(paths(), [true, true], 'replacing the overridden occurrence allows transcode again');

    // Multi-tile Direct Stream (-c:v copy + Opus) in Compare: eligibility, informTranscode suppression,
    // setCompareOutput size/cap transitions, pre-open state, ABR step-down/recovery, and mixed tiles.
    {
      const mkFakeProc = () => {
        const p = new EventEmitter();
        p.stdout = new EventEmitter();
        p.stdout.pause = () => {};
        p.stdout.resume = () => {};
        p.stdout.isPaused = () => false;
        p.stdout.destroy = () => {};
        p.stderr = new EventEmitter();
        p.err = { text: '' };
        p.kill = () => {};
        p.exitCode = null;
        p.signalCode = null;
        return p;
      };
      const hookLaunch = (stream) => {
        const runs = [];
        stream.launch = (t, audio = false) => {
          const argv = stream.args(t, audio);
          const p = mkFakeProc();
          p.t = t;
          p.directStream = !audio && stream.pipelineMode === 'direct-stream';
          runs.push({ t, audio: !!audio, argv, mode: stream.pipelineMode, directStream: p.directStream, proc: p });
          return p;
        };
        return runs;
      };
      const h264Sdr = {
        index: 0, codec: 'h264', pixFmt: 'yuv420p', depth: 8, width: 1920, height: 1080, fps: 30, bitRate: 5e6, rotation: 0,
      };
      const hevcSdr = { ...h264Sdr, codec: 'hevc', pixFmt: 'yuv420p10le', depth: 10 };
      let informed = 0;
      compare.informTranscode = async () => { informed++; };
      prefs = { transcode: 'auto', transcodeMaxBitrate: 12, transcodeSplitBitrate: true };
      compare.nativeFor = async () => ({
        tools: {}, maxHeight: 1080, informTranscode: true,
        probed: { duration: 30, video: h264Sdr, audio: { index: 1, codec: 'aac' } },
        stream: { encoder: 'h264_nvenc', cpuEncoder: 'libx264', audioEncoder: 'libopus', remote: true },
      });
      await compare.reload([upright, upright].map(h.vscode.Uri.file));
      await compare.onMessage({ type: 'ready', tile: { w: 3840, h: 2160, cols: 2, rows: 1 } });
      assert.strictEqual(informed, 0, 'informTranscode stays suppressed when all Compare tiles are lossless Direct Stream');
      assert.deepStrictEqual(compare.natives.map((n) => n.pipelineMode), ['direct-stream', 'direct-stream']);
      assert.deepStrictEqual(compare.natives.map((n) => n.videoEncoder), ['copy', 'copy']);
      assert.deepStrictEqual(compare.natives.map((n) => n.lossy()), [false, false]);

      const runsA = hookLaunch(compare.natives[0]);
      const runsB = hookLaunch(compare.natives[1]);
      await compare.onMessage({ type: 'nd', key: 'A', m: { type: 'open' } });
      await compare.onMessage({ type: 'nd', key: 'B', m: { type: 'open' } });
      assert.strictEqual(runsA[0].directStream, true, 'tile A opens in Direct Stream');
      assert.strictEqual(runsA[0].argv[runsA[0].argv.indexOf('-c:v') + 1], 'copy');
      assert.strictEqual(runsA[1].audio, true);
      assert.strictEqual(runsA[1].argv[runsA[1].argv.indexOf('-c:a') + 1], 'libopus', 'Direct Stream pairs with Opus audio');
      assert.strictEqual(runsB[0].directStream, true, 'tile B opens in Direct Stream');

      // Shrink below source height -> transitions cleanly from direct-stream to lossy re-encode.
      posts.length = 0;
      await compare.onMessage({ type: 'tileSize', tile: { w: 1280, h: 720, cols: 2, rows: 1 } });
      assert.strictEqual(posts.some((m) => m.type === 'resize'), false, 'shrinking does not emit deferred grow resize');
      assert.deepStrictEqual(compare.natives.map((n) => n.lossy()), [true, true], 'downscaled tiles leave direct-stream');
      assert.deepStrictEqual(compare.natives.map((n) => n.videoEncoder), ['h264_nvenc', 'h264_nvenc']);
      assert.strictEqual(runsA.at(-1).directStream, false);
      assert.strictEqual(runsA.at(-1).argv[runsA.at(-1).argv.indexOf('-c:v') + 1], 'h264_nvenc');

      // Zoom / grow back to source size -> deferred grow emits resize without spawning early; seek restores direct-stream.
      posts.length = 0;
      const beforeGrowA = runsA.length;
      const beforeGrowB = runsB.length;
      await compare.onMessage({ type: 'tileSize', tile: { w: 1920, h: 1080, cols: 2, rows: 1, factor: 2, zoom: 2 } });
      const resizeMsg = posts.find((m) => m.type === 'resize');
      assert.deepStrictEqual(resizeMsg && resizeMsg.tiles, [0, 1], 'growing emits resize for both tiles');
      assert.strictEqual(runsA.length, beforeGrowA, 'deferred grow does not spawn ffmpeg before seek');
      assert.strictEqual(runsB.length, beforeGrowB);
      compare.natives[0].lastSpawnAt = 0;
      compare.natives[0].lastSeekAt = 0;
      compare.natives[1].lastSpawnAt = 0;
      compare.natives[1].lastSeekAt = 0;
      await compare.onMessage({ type: 'nd', key: 'A', m: { type: 'seek', gen: 1, t: 0 } });
      await compare.onMessage({ type: 'nd', key: 'B', m: { type: 'seek', gen: 1, t: 0 } });
      assert.deepStrictEqual(compare.natives.map((n) => n.lossy()), [false, false], 'zoomed tiles re-enter direct-stream');
      assert.deepStrictEqual(compare.natives.map((n) => n.pipelineMode), ['direct-stream', 'direct-stream']);
      assert.strictEqual(runsA.filter((r) => !r.audio).at(-1).directStream, true);

      // Lower bitrate cap below source bitrate (6 Mb/s split across 2 tiles = 3 Mb/s < 5 Mb/s) -> leaves direct-stream.
      compare.updateTranscode(prefs = { ...prefs, transcodeMaxBitrate: 6, transcodeSplitBitrate: true });
      assert.deepStrictEqual(compare.natives.map((n) => n.lossy()), [true, true], 'tight cap leaves direct-stream');
      assert.strictEqual(runsA.filter((r) => !r.audio).at(-1).argv[runsA.filter((r) => !r.audio).at(-1).argv.indexOf('-c:v') + 1], 'h264_nvenc');

      // Raise bitrate cap back above source bitrate (12 Mb/s split = 6 Mb/s >= 5 Mb/s) -> restores direct-stream.
      compare.updateTranscode(prefs = { ...prefs, transcodeMaxBitrate: 12, transcodeSplitBitrate: true });
      assert.deepStrictEqual(compare.natives.map((n) => n.lossy()), [false, false], 'raised cap restores direct-stream');
      assert.strictEqual(runsA.filter((r) => !r.audio).at(-1).directStream, true);

      // ABR step-down on a slow remote link cleanly leaves direct-stream and posts accurate transcodeInfo.
      const tileA = compare.natives[0];
      tileA.settleAt = 0;
      posts.length = 0;
      const badSample = { type: 'remoteLink', gen: 1, kbps: 4000, videoKbps: 5000, mediaRate: 0.6, buffer: 0.05, starved: true, behind: false, readMs: 1500, hostWaitMs: 0 };
      await compare.onMessage({ type: 'nd', key: 'A', m: badSample });
      await compare.onMessage({ type: 'nd', key: 'A', m: badSample });
      assert.ok(tileA.tier > 0, 'ABR stepped down on slow remote link');
      assert.strictEqual(tileA.lossy(), true, 'stepped-down Compare tile leaves direct-stream');
      assert.strictEqual(tileA.videoEncoder, 'h264_nvenc');
      assert.strictEqual(runsA.filter((r) => !r.audio).at(-1).directStream, false);
      const downInfo = posts.filter((m) => m.type === 'nd' && m.key === 'A' && m.m.type === 'transcodeInfo').at(-1);
      assert.ok(downInfo, 'ABR step-down posts transcodeInfo');
      assert.strictEqual(downInfo.m.transcode.lossy, true, 'step-down transcodeInfo reports lossy re-encode, not stale direct-stream');
      assert.strictEqual(downInfo.m.transcode.encoder, 'h264_nvenc');
      assert.strictEqual(downInfo.m.transcode.adaptingDir, 'down');

      // ABR recovery back to tier 0 cleanly re-enters direct-stream and posts accurate lossless transcodeInfo.
      const goodSample = { type: 'remoteLink', gen: 1, kbps: 12000, videoKbps: 5000, mediaRate: 1, buffer: 1, starved: false, behind: false, readMs: 800, hostWaitMs: 0 };
      for (let attempt = 0; tileA.tier > 0 && attempt < 20; attempt++) {
        tileA.settleAt = 0;
        tileA.link.upAfter = 0; // skip the real 28 s upgrade cooldown (src/stream-adapt.js UP_COOLDOWN_MS)
        posts.length = 0;
        for (let k = 0; k < 4; k++) await compare.onMessage({ type: 'nd', key: 'A', m: goodSample });
      }
      assert.strictEqual(tileA.tier, 0, 'good samples recover within the test window');
      assert.strictEqual(tileA.lossy(), false, 'recovered Compare tile re-enters direct-stream');
      assert.strictEqual(tileA.videoEncoder, 'copy');
      assert.strictEqual(runsA.filter((r) => !r.audio).at(-1).directStream, true);
      const upInfo = posts.filter((m) => m.type === 'nd' && m.key === 'A' && m.m.type === 'transcodeInfo').at(-1);
      assert.ok(upInfo && upInfo.m.transcode.mode === 'direct-stream' && upInfo.m.transcode.lossy === false && upInfo.m.transcode.adaptingDir === 'up');

      // Pre-open setCompareOutput updates lossy() / pipelineMode immediately.
      await compare.reload([upright, upright].map(h.vscode.Uri.file));
      await compare.onMessage({ type: 'ready', tile: { w: 3840, h: 2160, cols: 2, rows: 1 } });
      assert.deepStrictEqual(compare.natives.map((n) => n.lossy()), [false, false]);
      compare.updateTranscode(prefs = { ...prefs, transcodeMaxBitrate: 6, transcodeSplitBitrate: true });
      assert.deepStrictEqual(compare.natives.map((n) => n.lossy()), [true, true], 'pre-open cap drop updates lossy() immediately');
      compare.updateTranscode(prefs = { ...prefs, transcodeMaxBitrate: 12, transcodeSplitBitrate: true });
      assert.deepStrictEqual(compare.natives.map((n) => n.lossy()), [false, false], 'pre-open cap raise restores lossless immediately');

      // Mixed session (one Direct Stream H.264 tile + one lossy HEVC tile): notice fires for the lossy tile.
      informed = 0;
      let idx = 0;
      compare.nativeFor = async () => ({
        tools: {}, maxHeight: 1080, informTranscode: true,
        probed: { duration: 30, video: idx++ === 0 ? h264Sdr : hevcSdr, audio: null },
        stream: { encoder: 'h264_nvenc', cpuEncoder: 'libx264', remote: true },
      });
      await compare.reload([upright, upright].map(h.vscode.Uri.file));
      await compare.onMessage({ type: 'ready', tile: { w: 3840, h: 2160, cols: 2, rows: 1 } });
      assert.deepStrictEqual(compare.natives.map((n) => n.lossy()), [false, true], 'mixed session keeps H.264 lossless and HEVC lossy');
      assert.strictEqual(informed, 1, 'informTranscode fires when at least one Compare tile is lossy');
    }

    // Extension shutdown disposes open compare sessions (and their native tiles).
    await compare.onMessage({ type: 'ready' });
    const live = compare.natives.slice();
    h.dispose();
    assert.ok(compare.disposed && live.every((n) => n.disposed), 'deactivate disposes the compare session');
  } finally {
    if (compare) compare.dispose();
    h.dispose();
    os.totalmem = totalmem;
    os.freemem = freemem;
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().then(() => console.log('compare: ok'), (e) => { console.error(e); process.exitCode = 1; });
