'use strict';
// node test/run.js unit --grep compare_test: a viewer comparing videos through the host (src/extension.js with the
// mock vscode, src/unified-viewer.js): in WSL the native queue is the host's memory shared by the tiles and the page
// sizes its own; a reloaded clip reads the rewritten file's rotation; Live transcode streams (real EncodedStream,
// ffmpeg never started) are built hidden for a hidden panel, share the bitrate cap across the tiles shown, play
// Direct Stream (-c:v copy) while the tile shows the source size and re-encode when it shrinks; a failed stream gives
// way to the built-in decoder and is not heard any more; closing the window disposes every tile.
const assert = require('assert');
const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { load } = require('./mock_vscode');
const { GB, budgets } = require('../../media/membudget');
const { rotationOf } = require('../../src/rotation');
const { make } = require('../media/make_cases_media');
const ff = require('../../src/ffmpeg');
const hardware = require('../../src/hardware');
const transcodeProbe = require('../../src/transcode_probe');
const { NativeDecoder } = require('../../src/native');
const { EncodedStream } = require('../../src/stream');

const tools = { ffmpeg: 'fake-ffmpeg', ffprobe: 'fake-ffprobe', version: 'fake 1', gpuFilters: new Set() };

function fakeProc() {
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
}

(async () => {
  const rotated = make('rotated.mp4');
  const upright = make('s_h264.mp4');
  assert.ok(rotated && upright, 'ffmpeg test clips');
  const { totalmem, freemem } = os;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vpe-compare-'));
  const rewritten = path.join(dir, 'rewritten.mp4');
  const third = path.join(dir, 'third.mp4');
  const saved = { locate: ff.locateTools, probe: ff.probe, detect: hardware.detect, encoderFor: transcodeProbe.encoderFor,
    open: NativeDecoder.prototype.open, launch: EncodedStream.prototype.launch };
  let video = { index: 0, codec: 'hevc', pixFmt: 'yuv420p10le', depth: 10, width: 1920, height: 1080, fps: 30, rotation: 0 };
  ff.locateTools = async () => tools;
  ff.probe = async () => ({ duration: 30, video: { ...video }, audio: null });
  hardware.detect = async () => ({ os: process.platform, arch: process.arch, gpus: [], nvidiaDriver: null, vaapi: false });
  transcodeProbe.encoderFor = async () => ({ encoder: 'h264_nvenc', hw: true, cpu: 'libx264', driverNotice: null });
  NativeDecoder.prototype.open = async function () { this.proc = { exitCode: null, kill() {} }; };
  const runs = [];
  EncodedStream.prototype.launch = function (t, audio = false) {
    const argv = this.args(t, audio);
    runs.push({ stream: this, audio: !!audio, argv, direct: !audio && this.pipelineMode === 'direct-stream' });
    return fakeProc();
  };
  let h = null;
  try {
    fs.copyFileSync(upright, rewritten);
    fs.copyFileSync(upright, third);
    os.totalmem = () => 8 * GB;
    os.freemem = () => 4 * GB;

    // ---- WSL: native ffmpeg tiles share the host's queue; the page sizes its frame memory itself ----
    h = load({ settings: { 'videoPreviewEnhanced.decoder': 'ffmpeg', 'videoPreviewEnhanced.transcode': 'off', 'videoPreviewEnhanced.compare.maxVideos': 4 } });
    h.vscode.env.remoteName = 'wsl';
    h.vscode.window.withProgress = async () => null;
    let s = h.nextPanel();
    let viewer = await h.vscode._commands['videoPreviewEnhanced.compare'](null, [rewritten, upright].map(h.vscode.Uri.file));
    assert.strictEqual(s.cfg().engine.mem, null, 'WSL webview uses client memory');
    assert.deepStrictEqual(s.cfg().clips.map((c) => [c.native, c.rotation]), [[true, 0], [true, 0]]);
    await s.send({ type: 'ready' });
    for (const c of viewer.session.clips) await s.send({ type: 'nd', clipId: c.id, m: { type: 'open' } });
    const queue = Math.floor(budgets(8).nativeQueue / 2);
    assert.deepStrictEqual(viewer.session.clips.map((c) => viewer.decoderOf(c.id).maxQueued), [queue, queue]);

    // A rewritten file reloads in its tile and its rotation is read again.
    fs.copyFileSync(rotated, rewritten);
    const nextMtime = new Date(Date.now() + 2000); // same byte size: a distinct mtime on coarse-clock file systems
    fs.utimesSync(rewritten, nextMtime, nextMtime);
    s.posted.length = 0;
    await viewer.reloadClip(viewer.session.clips[0].id);
    const rotation = await rotationOf(rotated);
    assert.ok(rotation > 0, 'rotated fixture');
    const reloaded = s.posted.find((m) => m.type === 'replaceTile');
    assert.deepStrictEqual([reloaded.reload, reloaded.clip.rotation], [true, rotation], 'reload reads the rewritten file');
    s.panel.dispose();
    h.dispose();

    // ---- Live transcode tiles: real EncodedStreams from src/extension.js createStream ----
    h = load({ settings: {
      'videoPreviewEnhanced.transcode': 'always', 'videoPreviewEnhanced.transcodeMaxBitrate': 12,
      'videoPreviewEnhanced.transcodeSplitBitrate': true, 'videoPreviewEnhanced.compare.maxVideos': 4,
    } });
    h.vscode.window.withProgress = async () => null;
    s = h.nextPanel();
    viewer = await h.vscode._commands['videoPreviewEnhanced.compare'](null, [upright, rewritten].map(h.vscode.Uri.file));
    await s.send({ type: 'ready' });
    await s.send({ type: 'tileSize', tile: { w: 1280, h: 720, cols: 2, rows: 1 } });
    s.panel.visible = false;
    for (const c of viewer.session.clips) await s.send({ type: 'nd', clipId: c.id, m: { type: 'open' } });
    let streams = () => viewer.session.clips.map((c) => viewer.decoderOf(c.id)).filter(Boolean);
    assert.ok(streams().length === 2 && streams().every((x) => x instanceof EncodedStream), 'one stream per tile');
    assert.ok(streams().every((x) => x.hidden), 'streams of a hidden panel are built hidden');
    assert.strictEqual(runs.length, 0, 'a hidden panel starts no encoder');
    s.panel.visible = true;
    assert.deepStrictEqual(streams().map((x) => x.activeCapKbps()), [6000, 6000], '12 Mb/s split over two tiles');
    await viewer.addUri(h.vscode.Uri.file(third));
    const added = viewer.session.clips[2];
    await s.send({ type: 'nd', clipId: added.id, m: { type: 'open' } });
    await s.send({ type: 'tileSize', tile: { w: 1920, h: 720, cols: 3, rows: 1 } });
    assert.deepStrictEqual(streams().map((x) => x.activeCapKbps()), [4000, 4000, 4000], 'three tiles share it');

    // A failed stream: the built-in decoder in its tile; it is not heard any more.
    const [failed] = streams();
    const failedId = viewer.session.clips[0].id;
    s.posted.length = 0;
    failed.onFail('no software encoder');
    const swap = s.posted.find((m) => m.type === 'replaceTile');
    assert.deepStrictEqual([swap.oldId, swap.clip.native], [failedId, false]);
    s.posted.length = 0;
    failed.post({ type: 'batch' });
    assert.deepStrictEqual(s.posted.filter((m) => m.type === 'nd'), [], 'a disposed stream cannot post');
    s.panel.dispose();
    h.dispose();

    // ---- Direct Stream: 8-bit H.264 at the tile's source size is copied; a smaller tile re-encodes ----
    video = { index: 0, codec: 'h264', pixFmt: 'yuv420p', depth: 8, width: 1920, height: 1080, fps: 30, bitRate: 5e6, rotation: 0 };
    h = load({ settings: {
      'videoPreviewEnhanced.transcode': 'always', 'videoPreviewEnhanced.transcodeMaxBitrate': 12,
      'videoPreviewEnhanced.transcodeSplitBitrate': true,
    } });
    h.vscode.window.withProgress = async () => null;
    const informed = [];
    h.vscode.window.showInformationMessage = async (text) => { informed.push(text); };
    s = h.nextPanel();
    viewer = await h.vscode._commands['videoPreviewEnhanced.compare'](null, [upright, third].map(h.vscode.Uri.file));
    await s.send({ type: 'ready' });
    await s.send({ type: 'tileSize', tile: { w: 3840, h: 2160, cols: 2, rows: 1 } });
    runs.length = 0;
    for (const c of viewer.session.clips) await s.send({ type: 'nd', clipId: c.id, m: { type: 'open' } });
    streams = () => viewer.session.clips.map((c) => viewer.decoderOf(c.id)).filter(Boolean);
    assert.deepStrictEqual(streams().map((x) => x.pipelineMode), ['direct-stream', 'direct-stream']);
    assert.deepStrictEqual(streams().map((x) => x.lossy()), [false, false]);
    assert.ok(runs.length >= 2 && runs.every((r) => r.direct && r.argv[r.argv.indexOf('-c:v') + 1] === 'copy'), 'tiles open copying');
    // The transcode setting is 'always' here: the one-time lossy notice is not shown either way.
    assert.ok(!informed.some((t) => /Live transcode/.test(t)));
    await s.send({ type: 'tileSize', tile: { w: 1280, h: 720, cols: 2, rows: 1 } });
    assert.deepStrictEqual(streams().map((x) => x.lossy()), [true, true], 'downscaled tiles leave Direct Stream');
    const last = runs.filter((r) => !r.audio).at(-1);
    assert.strictEqual(last.argv[last.argv.indexOf('-c:v') + 1], 'h264_nvenc');

    // Closing the window disposes every viewer and its streams.
    const live = streams();
    h.dispose();
    assert.ok(viewer.disposed && live.every((x) => x.disposed), 'deactivate disposes the viewer and its tiles');
    h = null;
  } finally {
    if (h) h.dispose();
    Object.assign(ff, { locateTools: saved.locate, probe: saved.probe });
    hardware.detect = saved.detect;
    transcodeProbe.encoderFor = saved.encoderFor;
    NativeDecoder.prototype.open = saved.open;
    EncodedStream.prototype.launch = saved.launch;
    os.totalmem = totalmem;
    os.freemem = freemem;
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().then(() => { console.log('compare: ok'); process.exit(0); }, (e) => { console.error(e); process.exit(1); });
