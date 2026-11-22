'use strict';

const assert = require('node:assert/strict');
const { EventEmitter, once } = require('node:events');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const ff = require('../../src/ffmpeg');
const rotation = require('../../src/rotation');
const { NativeDecoder } = require('../../src/native');
const { load, webviewConfig } = require('./mock_vscode');

const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};
const pageOf = (s) => webviewConfig(s.panel.webview).page;
const video = { codec: 'hevc', width: 320, height: 180, depth: 8, pixFmt: 'yuv420p', fps: 30 };
const probe = { video, duration: 2 };
const nativeSettings = { 'videoPreviewEnhanced.decoder': 'ffmpeg', 'videoPreviewEnhanced.gpuDecoding': false };

async function earlyHandoff(file, replace) {
  const prestarted = deferred();
  const pendingProbe = deferred();
  const awaitingProbe = deferred();
  let signal;
  let kills = 0;
  rotation.sniffNativeMp4 = async () => probe;
  ff.probe = (_tools, _file, s) => { signal = s; return pendingProbe.promise; };
  NativeDecoder.prototype.prestart = function () {
    this.proc = { exitCode: null, kill: () => { kills++; } };
    prestarted.resolve();
  };
  const h = load({ settings: nativeSettings });
  const output = h.context.subscriptions.find((sub) => Array.isArray(sub.lines));
  const appendLine = output.appendLine.bind(output);
  output.appendLine = (line) => {
    appendLine(line);
    if (line.endsWith('waiting for early ffprobe')) awaitingProbe.resolve();
  };
  const s = h.open(file);
  try {
    await s.shown;
    await prestarted.promise;
    const oldPage = pageOf(s);
    const opening = s.send({ type: 'ready', page: oldPage });
    await awaitingProbe.promise;
    await replace(s);
    s.posted.length = 0;
    assert.equal(signal.aborted, true, 'the claimed probe is cancelled');
    assert.equal(kills, 1, 'the claimed decoder is killed even while the probe is pending');
    pendingProbe.resolve(probe);
    await opening;
    await s.send({ type: 'ready', page: oldPage });
    assert.deepEqual(s.posted, []);
    assert.equal(kills, 1);
  } finally {
    s.panel.dispose();
    h.dispose();
  }
}

async function reloadDocument(file) {
  const h = load({ settings: { 'videoPreviewEnhanced.decoder': 'builtin' } });
  const s = h.open(file);
  const originalOpen = fs.promises.open;
  const reading = deferred();
  const eof = deferred();
  const closed = deferred();
  try {
    await s.shown;
    const html = s.panel.webview.html;
    const page = pageOf(s);
    const first = { type: 'ready', page, boot: 'document-1' };
    const second = { ...first, boot: 'document-2' };
    const starts = () => s.posted.filter((m) => m.type === 'libav').length;
    await s.send(first);
    await s.send(first);
    assert.equal(starts(), 1, 'duplicate ready starts one decoder');

    fs.promises.open = (name, ...args) => name === file ? Promise.resolve({
      stat: async () => ({ size: 1 }),
      read: () => { reading.resolve(); return eof.promise; },
      close: async () => { closed.resolve(); },
    }) : originalOpen(name, ...args);
    const read = s.send({ type: 'readBlock', page, boot: first.boot, pos: 0, len: 1 });
    await reading.promise;
    await s.send(second);
    assert.equal(s.panel.webview.html, html, 'the second document boots from the original HTML');
    assert.equal(starts(), 2, 'the recreated document reacquires playback');
    await closed.promise;
    eof.resolve({ bytesRead: 0 });
    await read;
    await s.send({ type: 'thumb', page, boot: first.boot, id: 1 });
    await s.send(first);
    await s.send(second);
    assert.equal(starts(), 2, 'a retired or duplicate boot cannot restart playback');
    assert.ok(!s.posted.some((m) => m.type === 'block' || m.type === 'thumb'));
  } finally {
    fs.promises.open = originalOpen;
    s.panel.dispose();
    h.dispose();
  }
}

async function pendingFile(file, replace) {
  const open = fs.promises.open;
  const arrived = deferred();
  const handle = deferred();
  let closes = 0;
  const avi = require('../../src/avi');
  const parse = avi.parseAvi;
  avi.parseAvi = async () => ({ isMjpeg: true, frames: [{ offset: 0, size: 1 }] });
  fs.promises.open = (name, ...args) => {
    if (name !== file) return open(name, ...args);
    arrived.resolve();
    return handle.promise;
  };
  const h = load({ settings: { 'videoPreviewEnhanced.decoder': 'builtin' } });
  const s = h.open(file);
  try {
    await s.shown;
    const opening = s.send({ type: 'ready' });
    await arrived.promise;
    await replace(s);
    s.posted.length = 0;
    handle.resolve({ close: async () => { closes++; } });
    await opening;
    assert.equal(closes, 1, 'the late file handle is closed exactly once');
    assert.deepEqual(s.posted, []);
  } finally {
    fs.promises.open = open;
    avi.parseAvi = parse;
    s.panel.dispose();
    h.dispose();
  }
}

async function inspectUrl() {
  const connected = deferred();
  const disconnected = deferred();
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
    res.write('#EXTM3U\n');
    res.on('close', disconnected.resolve);
    connected.resolve();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  let receive;
  let dispose;
  const posted = [];
  const panel = {
    visible: true,
    onDidChangeViewState() {},
    onDidDispose(fn) { dispose = fn; },
    webview: {
      asWebviewUri: () => ({ toString: () => 'https://webview/asset' }),
      onDidReceiveMessage(fn) { receive = fn; },
      postMessage(m) { posted.push(m); return Promise.resolve(true); },
    },
  };
  const h = load({
    settings: { 'videoPreviewEnhanced.decoder': 'builtin' },
    setup(vscode) {
      vscode.window.createWebviewPanel = () => panel;
      vscode.window.showInputBox = async () => `http://127.0.0.1:${server.address().port}/test.m3u8`;
    },
  });
  try {
    await h.vscode._commands['videoPreviewEnhanced.openUrl']();
    const opening = receive({ type: 'ready', page: webviewConfig(panel.webview).page, boot: 'url-document' });
    await connected.promise;
    posted.length = 0;
    dispose();
    await Promise.all([opening, disconnected.promise]);
    assert.deepEqual(posted, []);
  } finally {
    dispose?.();
    h.dispose();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

async function exportAndThumb(file, replace) {
  const thumbhost = require('../../src/thumbhost');
  const { decodeThumb } = thumbhost;
  const started = deferred();
  const finished = deferred();
  const grab = deferred();
  let thumbnailCalls = 0;
  let thumbCancels = 0;
  let kills = 0;
  let writes = 0;
  let progressDisposals = 0;
  thumbhost.decodeThumb = (...args) => {
    thumbnailCalls++;
    args.at(-1).addEventListener('abort', () => {
      thumbCancels++;
      finished.resolve({ w: 1, h: 1, data: Buffer.alloc(4) });
    }, { once: true });
    started.resolve();
    return finished.promise;
  };
  ff.probe = async () => probe;
  NativeDecoder.prototype.prestart = function () {
    this.proc = { exitCode: null, kill: () => { kills++; } };
    this.w = video.width;
    this.h = video.height;
  };
  const h = load({
    settings: nativeSettings,
    setup(vscode) {
      vscode.window.showOpenDialog = async () => [vscode.Uri.file(path.dirname(file))];
      vscode.workspace.fs.readDirectory = async () => [];
      vscode.workspace.fs.writeFile = async () => { writes++; };
      vscode.window.withProgress = (_options, run) => run({ report() {} }, {
        onCancellationRequested: () => ({ dispose: () => { progressDisposals++; } }),
      });
    },
  });
  const s = h.open(file, { visible: false });
  try {
    await s.shown;
    await s.send({ type: 'ready' });
    assert.ok(s.posted.some((m) => m.type === 'libav' && m.meta.native));
    s.setVisible(true);
    const post = s.panel.webview.postMessage;
    s.panel.webview.postMessage = (m) => {
      if (m.type === 'exportGrab') grab.resolve(m);
      return post(m);
    };
    const page = pageOf(s);
    const exporting = s.send({ type: 'exportRange', page, range: { fa: 0, fb: 1, fps: 30 } });
    const { id } = await grab.promise;
    await s.send({ type: 'thumb', page, id: 1, t: 0, w: 20, h: 20 });
    await started.promise;
    await s.send({ type: 'thumb', page, id: 2, t: 1, w: 20, h: 20 });
    s.posted.length = 0;
    await replace(s);
    await s.send({ type: 'exportFrame', page, id, frame: 0, data: Uint8Array.of(1) });
    await s.send({ type: 'thumb', page, id: 1, t: 0, w: 20, h: 20 });
    await exporting;
    await s.send({ type: 'exportFrame', page, id, frame: 0, data: Uint8Array.of(1) });
    assert.deepEqual(s.posted, []);
    assert.equal(kills, 1, 'the native process serving the export is killed once');
    assert.equal(progressDisposals, 1, 'the cancelled frame wait releases progress once');
    assert.equal(writes, 0);
    assert.equal(thumbnailCalls, 1, 'queued thumbnails never start after cancellation');
    assert.equal(thumbCancels, 1, 'the in-flight thumbnail is cancelled once');
  } finally {
    s.panel.dispose();
    h.dispose();
    thumbhost.decodeThumb = decodeThumb;
  }
}

async function killThumbnailProcess() {
  // Reload thumbhost with a controllable process. Abort sends one kill, then close settles the decode.
  const children = require('node:child_process');
  const spawn = children.spawn;
  const filename = require.resolve('../../src/thumbhost');
  const cached = require.cache[filename];
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  let kills = 0;
  child.kill = () => { kills++; };
  delete require.cache[filename];
  children.spawn = () => child;
  try {
    const { decodeThumb } = require(filename);
    const controller = new AbortController();
    const decoding = decodeThumb({ ffmpeg: 'fake' }, 'video.mp4', { w: 10, h: 10 }, 0, 10, 10,
      undefined, controller.signal);
    controller.abort();
    controller.abort();
    assert.equal(kills, 1);
    child.stdout.emit('data', Buffer.alloc(400));
    child.emit('close', null);
    assert.equal(await decoding, null);
  } finally {
    children.spawn = spawn;
    require.cache[filename] = cached;
  }
}

let complete = false;
process.on('beforeExit', () => {
  if (!complete) { console.error('page lifecycle: a controlled operation never settled'); process.exitCode = 1; }
});

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vpe_page_'));
  const file = path.join(dir, 'video.mp4');
  const avi = path.join(dir, 'video.avi');
  fs.writeFileSync(file, '');
  fs.writeFileSync(avi, '');
  ff.locateTools = async () => ({ ffmpeg: 'fake', ffprobe: 'fake', version: 'fake' });
  const reload = (s) => s.send({ type: 'transcodePref', mode: 'always' });
  const close = (s) => { s.panel.dispose(); s.panel.dispose(); };
  try {
    for (const replace of [reload, close]) {
      await earlyHandoff(file, replace);
      await pendingFile(avi, replace);
      await exportAndThumb(file, replace);
    }
    await reloadDocument(file);
    await inspectUrl();
    await killThumbnailProcess();
    complete = true;
    console.log('page lifecycle: acquisition, export and thumbnail cancellation passed');
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
})().catch((e) => { complete = true; console.error(e); process.exitCode = 1; });
