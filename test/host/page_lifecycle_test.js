'use strict';
// node test/run.js unit --grep page_lifecycle: what a viewer's page starts ends with it (src/unified-viewer.js,
// src/extension.js, the mock vscode): closing the tab mid-export and mid-thumbnail cancels both once and kills the
// native ffmpeg once; a recreated document (VS Code can rebuild a page from the same HTML) starts its decoders over;
// a URL tab closed while it is still connecting drops the request and posts nothing; an aborted thumbnail kills its
// ffmpeg once.
const assert = require('node:assert/strict');
const { EventEmitter, once } = require('node:events');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const ff = require('../../src/ffmpeg');
const thumbhost = require('../../src/thumbhost');
const { NativeDecoder } = require('../../src/native');
const { load } = require('./mock_vscode');

const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};
const video = { codec: 'hevc', width: 320, height: 180, depth: 8, pixFmt: 'yuv420p', fps: 30 };
const probe = { video, duration: 2 };
const nativeSettings = { 'videoPreviewEnhanced.decoder': 'ffmpeg', 'videoPreviewEnhanced.gpuDecoding': false };

/** A native ffmpeg that never runs: open() starts this stand-in (one kill counted per process). */
function fakeNative() {
  const counts = { kills: 0, opens: 0 };
  NativeDecoder.prototype.open = async function () {
    counts.opens++;
    this.proc = { exitCode: null, kill: () => { counts.kills++; } };
    this.w = video.width;
    this.h = video.height;
  };
  NativeDecoder.prototype.dispose = function () {
    if (this.proc) this.proc.kill();
    this.proc = null;
  };
  return counts;
}

async function exportAndThumb(file) {
  const { nativeThumb } = thumbhost;
  const started = deferred();
  const finished = deferred();
  const grab = deferred();
  let thumbnailCalls = 0;
  let thumbCancels = 0;
  let writes = 0;
  let progressDisposals = 0;
  thumbhost.nativeThumb = (...args) => {
    thumbnailCalls++;
    args[3].addEventListener('abort', () => { // (decoder, request, log, signal, hw)
      thumbCancels++;
      finished.resolve({ w: 1, h: 1, data: Buffer.alloc(4) });
    }, { once: true });
    started.resolve();
    return finished.promise;
  };
  const counts = fakeNative();
  const h = load({
    settings: nativeSettings,
    setup(vscode) {
      vscode.window.showOpenDialog = async () => [vscode.Uri.file(path.dirname(file))];
      vscode.workspace.fs.readDirectory = async () => [];
      vscode.workspace.fs.stat = async () => { throw Object.assign(new Error('none'), { code: 'FileNotFound' }); };
      vscode.workspace.fs.writeFile = async () => { writes++; };
      vscode.window.withProgress = (_options, run) => run({ report() {} }, {
        onCancellationRequested: () => ({ dispose: () => { progressDisposals++; } }),
      });
    },
  });
  const s = h.open(file);
  try {
    await s.send({ type: 'ready' });
    assert.equal(s.cfg().clips[0].native, true);
    await s.send({ type: 'nd', m: { type: 'open' } });
    assert.equal(counts.opens, 1, 'the page started native ffmpeg');
    const post = s.panel.webview.postMessage;
    s.panel.webview.postMessage = (m) => {
      if (m.type === 'exportGrab') grab.resolve(m);
      return post(m);
    };
    const exporting = s.send({ type: 'exportRange', range: { fa: 0, fb: 1, fps: 30, stride: 1 } });
    const { id } = await grab.promise;
    const thumbnail = s.send({ type: 'thumb', id: 1, t: 0, w: 20, h: 20 });
    await started.promise;
    s.posted.length = 0;
    s.panel.dispose();
    s.panel.dispose();
    await s.send({ type: 'exportFrame', id, frame: 0, data: Uint8Array.of(1) });
    await s.send({ type: 'thumb', id: 1, t: 0, w: 20, h: 20 });
    await Promise.all([exporting, thumbnail]);
    assert.deepEqual(s.posted, [], 'a closed page hears nothing');
    assert.equal(counts.kills, 1, 'the native process is killed once');
    assert.equal(progressDisposals, 1, 'the cancelled frame wait releases progress once');
    assert.equal(writes, 0);
    assert.equal(thumbnailCalls, 1, 'a closed page cannot restart thumbnails');
    assert.equal(thumbCancels, 1, 'the in-flight thumbnail is cancelled once');
  } finally {
    s.panel.dispose();
    h.dispose();
    thumbhost.nativeThumb = nativeThumb;
  }
}

async function reloadDocument(file) {
  const counts = fakeNative();
  const h = load({ settings: nativeSettings });
  const s = h.open(file);
  try {
    await s.send({ type: 'ready', boot: 'document-1' });
    await s.send({ type: 'nd', m: { type: 'open' } });
    const html = s.panel.webview.html;
    const states = () => s.posted.filter((m) => m.type === 'sessionState').length;
    await s.send({ type: 'ready', boot: 'document-2' });
    assert.equal(s.panel.webview.html, html, 'the second document boots from the original HTML');
    assert.equal(states(), 2, 'the recreated document gets the clips again');
    assert.equal(counts.kills, 1, 'its host decoders start over');
    await s.send({ type: 'nd', m: { type: 'open' } });
    assert.equal(counts.opens, 2, 'the new document starts its own');
  } finally {
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
  const h = load({
    settings: { 'videoPreviewEnhanced.decoder': 'builtin' },
    setup(vscode) { vscode.window.showInputBox = async () => `http://127.0.0.1:${server.address().port}/test.m3u8`; },
  });
  const s = h.nextPanel();
  try {
    await h.vscode._commands['videoPreviewEnhanced.openUrl']();
    await s.send({ type: 'ready' });
    const opening = s.send({ type: 'nd', m: { type: 'open' } }); // the page's player asks: the URL is inspected
    await connected.promise;
    s.posted.length = 0;
    s.panel.dispose();
    await Promise.all([opening, disconnected.promise]);
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(s.posted, []);
  } finally {
    s.panel.dispose();
    h.dispose();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
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
  const file = path.join(dir, 'video.mkv');
  fs.writeFileSync(file, 'x');
  ff.locateTools = async () => ({ ffmpeg: 'fake', ffprobe: 'fake', version: 'fake' });
  ff.probe = async () => probe;
  try {
    await exportAndThumb(file);
    await reloadDocument(file);
    await inspectUrl();
    await killThumbnailProcess();
    complete = true;
    console.log('page lifecycle: export, thumbnail, document and URL cancellation passed');
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
})().catch((e) => { complete = true; console.error(e); process.exitCode = 1; });
