#!/usr/bin/env node
// Runs media/engine.js (LibavPlayer) in Node with stub WebGL/WebAudio, switches
// sound and subtitles in a multi-track file, then checks open-GOP fallback
// with a WebCodecs stand-in.
//
//   node test/tracks/engine_smoke.js [media dir] [--pool] [--log]
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { Session } = require('./driver'); // installs the Worker shim and DecoderPool

const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith('--')) || require('./make_media').ensure();
const usePool = args.includes('--pool');
const LOG = args.includes('--log');
const file = path.join(dir, 'tracks_multi.mkv');
void Session;

// ---- browser stubs -----------------------------------------------------------
globalThis.self = globalThis; // the engine records its start-up marks on the page global
const glFn = () => 1;
const gl = new Proxy({}, { get: (t, k) => (k === 'getExtension' ? () => null : glFn) });
const canvas = { getContext: () => gl, width: 1920, height: 1080, hidden: false };
const t0 = performance.now();
class FakeAudioContext {
  constructor() { this.state = 'running'; this.destination = {}; }
  get currentTime() { return (performance.now() - t0) / 1000; }
  createGain() { return { gain: { value: 1 }, connect() {} }; }
  createBuffer(ch, n, sr) {
    const planes = Array.from({ length: ch }, () => new Float32Array(n));
    return { numberOfChannels: ch, length: n, sampleRate: sr, duration: n / sr, copyToChannel: (p, c) => planes[c].set(p), getChannelData: (c) => planes[c] };
  }
  createBufferSource() { return { connect() {}, start() {}, stop() {}, set onended(f) { this.f = f; } }; }
  resume() { this.state = 'running'; return Promise.resolve(); }
  suspend() { this.state = 'suspended'; return Promise.resolve(); } // engine.js restAudio (the AudioContext rests while paused)
  close() { return Promise.resolve(); }
}
globalThis.AudioContext = FakeAudioContext;
globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => '', arrayBuffer: async () => new ArrayBuffer(0) });
// The pool and the worker shim take the real libav.js paths; the engine's blob URLs are replaced.
const libdir = path.join(__dirname, '..', '..', 'media', 'libav-vpe');
const realInit = { loader: path.join(libdir, 'libav-6.11.9.0.2-vpe.js'), toImport: path.join(libdir, 'libav-6.11.9.0.2-vpe.wasm.js'), wasmurl: path.join(libdir, 'libav-6.11.9.0.2-vpe.wasm.wasm'), variant: 'vpe' };
const BaseWorker = globalThis.Worker;
globalThis.Worker = class extends BaseWorker {
  postMessage(m, tr) { super.postMessage(m && m.type === 'init' ? { ...m, ...realInit } : m, tr); }
};
if (!usePool) delete globalThis.DecoderPool;
else { const P = globalThis.DecoderPool; globalThis.DecoderPool = class extends P { postMessage(m, tr) { super.postMessage(m && m.type === 'init' ? { ...m, ...realInit } : m, tr); } }; }

// ---- engine --------------------------------------------------------------------
globalThis.VpeBlockCache = require('../../media/block-cache');
const src = fs.readFileSync(path.join(__dirname, '..', '..', 'media', 'engine.js'), 'utf8');
vm.runInThisContext(`${src}\nglobalThis.createEngine = createEngine;`, { filename: 'engine.js' });
let size = 0;
let fd = null;
let player = null;
const logs = [];
const trackEvents = [];
let ready;
let readyP;
const engine = globalThis.createEngine({
  vscode: {
    postMessage: (m) => {
      if (m.type !== 'readBlock') return;
      setImmediate(() => {
        const n = Math.max(0, Math.min(m.len, size - m.pos));
        const buf = Buffer.alloc(n);
        if (n) fs.readSync(fd, buf, 0, n, m.pos);
        player.onBlock(m.pos, new Uint8Array(buf.buffer, buf.byteOffset, n));
      });
    },
  },
  canvas,
  log: (x) => { logs.push(x); if (LOG) console.log(`    ${x}`); },
  showMessage: (a, b) => { if (a) logs.push(`MESSAGE ${a} ${b || ''}`); },
  toast: (x) => logs.push(`TOAST ${x}`),
  getState: () => ({}),
  setMuteUi: () => {},
  onReady: (p) => ready(p),
  onMeta: () => {},
  onTracks: (p) => trackEvents.push(p.tracks()),
});

function openPlayer(f) {
  if (fd !== null) fs.closeSync(fd);
  size = fs.statSync(f).size;
  fd = fs.openSync(f, 'r');
  readyP = new Promise((r) => { ready = r; });
  player = new engine.LibavPlayer({ size }, { workerUrl: 'decoder-worker.js', loader: 'libav.js', variant: 'vpe', whenSlow: 'every' });
  return player;
}

/** Stand-in for WebCodecs H.264 that, like Chrome, refuses a key chunk without an IDR slice. */
class FakeVideoDecoder {
  static async isConfigSupported() { return { supported: true }; }
  constructor(init) { this.init = init; this.state = 'unconfigured'; this.decodeQueueSize = 0; this.chunks = 0; this.keyFails = 0; FakeVideoDecoder.last = this; }
  configure() { this.state = 'configured'; this.needKey = true; }
  decode(c) {
    if (this.needKey) {
      if (c.type !== 'key' || !c.idr) throw new Error('A key frame is required after configure() or flush().');
      this.needKey = false;
    }
    this.chunks++;
    setImmediate(() => { if (this.state === 'configured') this.init.output({ timestamp: c.timestamp, displayWidth: 640, displayHeight: 360, close() {}, clone() { return this; } }); });
  }
  flush() { return Promise.resolve(); }
  close() { this.state = 'closed'; }
}
class FakeChunk { constructor(o) { Object.assign(this, o); this.idr = FakeChunk.idr(o.data); } }
FakeChunk.idr = (d) => { // AVCC with 4-byte lengths (MKV/MP4 from x264)
  for (let i = 0; i + 4 < d.length;) { const n = ((d[i] << 24) | (d[i + 1] << 16) | (d[i + 2] << 8) | d[i + 3]) >>> 0; const t = d[i + 4] & 31; if (t === 5) return true; if (t === 1) return false; i += 4 + n; }
  return false;
};

let failed = 0;
const check = (ok, what) => { if (!ok) failed++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  console.log(`engine smoke (${usePool ? 'pool' : 'one worker'})`);
  openPlayer(file);
  const cues = [];
  player.onSubCue = (c) => cues.push(c);
  const tick = setInterval(() => player.tick(), 16);
  await readyP;
  const t = player.tracks();
  check(t.audio.length === 3 && t.sub.length === 2 && t.audioId === 1 && t.subId === null, `tracks(): ${JSON.stringify({ ...t, sub: t.sub.map((s) => ({ ...s, header: s.header && `${s.header.length} chars` })) })}`);
  check(trackEvents.length === 1, `onTracks called on ready (${trackEvents.length})`);
  player.play();
  await sleep(1500);
  const r1 = await player.selectSub(4);
  check(r1.subId === 4, `selectSub(4) → subId ${r1.subId}`);
  await sleep(2500);
  const atSwitch = player.currentTime();
  const shownBefore = player.shownCount;
  const r2 = await player.selectAudio(2);
  check(r2.audioId === 2 && player.amode === 'soft', `selectAudio(2) → audioId ${r2.audioId}, ${player.amode}`);
  await sleep(2000);
  const newAudio = player.audio.length;
  check(newAudio > 0 && player.audio[0].t <= player.now() + 1, `sound of the new track queued (${newAudio} buffers from ${player.audio.length ? player.audio[0].t.toFixed(2) : '-'} s, now ${player.now().toFixed(2)} s)`);
  check(player.shownCount - shownBefore > 20 && player.currentTime() > atSwitch + 1, `picture kept going: ${player.shownCount - shownBefore} frames since the switch at ${atSwitch.toFixed(2)} s, now ${player.currentTime().toFixed(2)} s`);
  check(cues.length >= 2 && cues.every((c) => c.track === 4 && c.end > c.start && typeof c.text === 'string'), `onSubCue: ${cues.length} cues, first ${JSON.stringify(cues[0])}`);
  // Seek into the long cue (36..44): it arrives although it started before the keyframe.
  player.seekTime(41);
  await sleep(2500);
  check(cues.some((c) => c.start === 36 && c.end === 44), 'after seeking to 41 s the long cue 36..44 is delivered');
  check(player.subCues().length === new Set(cues.map((c) => `${c.start}|${c.text}`)).size, `subCues() has every delivered cue once (${player.subCues().length})`);
  const before = cues.length;
  await player.selectSub(5);
  await sleep(1500);
  check(cues.length > before && cues.slice(before).every((c) => c.track === 5 && typeof c.ass === 'string'), `selectSub(5): ${cues.length - before} ASS cues, e.g. ${JSON.stringify(cues[cues.length - 1])}`);
  await player.selectSub(null);
  check(player.tracks().subId === null, 'selectSub(null)');
  // Review 3 #4: paused with a full read-ahead, a new sound track arrives at once (not after the read-ahead drains).
  player.pause();
  await sleep(3000);
  const pausedAt = player.now();
  await player.selectAudio(1);
  await sleep(2000);
  const a1 = player.audio.length ? player.audio[0].t : null;
  check(a1 !== null && a1 <= pausedAt + 0.1 && player.audio[player.audio.length - 1].t >= pausedAt, `paused switch: new sound queued at once (${player.audio.length} buffers from ${a1 === null ? '-' : a1.toFixed(2)} s, paused at ${pausedAt.toFixed(2)} s)`);
  player.play();
  let err = null;
  try { await player.selectAudio(99); } catch (e) { err = e.message; }
  check(err === 'no audio track 99', `selectAudio(99) rejects (${err})`);
  check(trackEvents.length >= 5, `onTracks after each change (${trackEvents.length})`);
  const bad = logs.filter((l) => /error|MESSAGE|TOAST/i.test(l) && !/Slower than real time/.test(l)); // Node decodes 1080p H.264 in software
  check(!bad.length, `no errors (${bad.slice(0, 3).join(' | ')})`);
  clearInterval(tick);
  player.dispose();

  // Open-GOP H.264 in WebCodecs: a seek lands on an I-frame that is no IDR.
  console.log('open-GOP H.264 with (fake) WebCodecs');
  globalThis.VideoDecoder = FakeVideoDecoder;
  globalThis.EncodedVideoChunk = FakeChunk;
  openPlayer(path.join(dir, 'opengop_h264.mkv'));
  const tick2 = setInterval(() => player.tick(), 16);
  await readyP;
  check(player.vmode === 'webcodecs', `starts in WebCodecs (${player.vmode})`);
  await sleep(500);
  const n0 = logs.length;
  // Bypass the decoded queue and seek into the last GOP, where the first batch
  // can contain both the non-IDR key and EOF.
  const target = 9.5;
  player.seekAbs(player.startT + target);
  await sleep(2500);
  const shown = player.shownT !== null ? player.rel(player.shownT) : null;
  check(player.vmode === 'soft' && logs.slice(n0).some((l) => /open-GOP H.264/.test(l)), `falls back to software after the seek (${player.vmode})`);
  check(shown !== null && Math.abs(shown - target) < 0.05, `shows the frame at the seek target (${shown})`);
  check(!logs.some((l) => /decode: A key frame is required/.test(l)), 'never feeds WebCodecs a non-IDR key frame');
  clearInterval(tick2);
  player.dispose();
  console.log(failed ? `${failed} FAILED` : 'all passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.log(`  FAIL ${e && e.stack || e}`); process.exit(1); });
