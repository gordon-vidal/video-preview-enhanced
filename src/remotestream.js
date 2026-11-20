'use strict';
// Remote stream (track E, docs/notes/remote-stream.md): remote windows (SSH, WSL, containers, tunnels).
//
// The extension host runs on the remote machine, so native ffmpeg's raw frames would cross the
// network (1080p30 4:2:0 = 93 MB/s). Instead ffmpeg on the remote decodes the file with whatever it
// has, scales it for the panel and re-encodes a low-latency H.264 stream (Annex B, an AUD before
// every frame, no B-frames) with the remote's GPU encoder when it has one (probeEncoder), else
// libx264 (GPL builds) or libopenh264 (the LGPL build src/remoteff.js downloads); the packets go
// to the webview, which decodes them with WebCodecs (H.264 is one of the two video codecs VS Code
// webviews can decode). Sound goes as Opus (96 kb/s), or signed 16-bit PCM when no Opus encoder
// works. A seek inside what was already read is served from memory; others restart
// ffmpeg at the target frame, at most one start per burst of seeks (scrubbing).
//
// It speaks media/decoder-worker.js's protocol (streams, config, more -> batch, seek -> seeked)
// with H.264 'packet' items, so media/engine.js takes its existing WebCodecs path. The frames are
// not the file's (scaled, 8-bit, lossy): pixel tools switch to the built-in decoder (lossy()).

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const { lowerPriority, run } = require('./ffmpeg');
const { OggOpus } = require('./remoteopus');

const AUDIO_RATE = 48000;
const MAX_QUEUED_SECONDS = 2; // packets read ahead of the webview before ffmpeg is paused
const AUD = Buffer.from([0, 0, 1, 9]); // access unit delimiter (h264_metadata=aud=insert)
// Seeks: a burst (the seek bar dragged, keys held) starts ffmpeg once it pauses this long...
const SEEK_QUIET_MS = 60;
// ...and at most once per this while it goes on, never deferring a seek longer than SEEK_MAX_DEFER_MS.
const SPAWN_GAP_MS = 200;
const SEEK_MAX_DEFER_MS = 400;
// A seek this far past the last packet read, with ffmpeg still running, waits for it instead of restarting.
const REUSE_AHEAD_S = 0.5;
// A seek back by at most STEP_BACK_SPAN_S from the stream's start restarts STEP_BACK_LEAD_S before the target.
const STEP_BACK_SPAN_S = 2;
const STEP_BACK_LEAD_S = 1;
// Packets kept for seeks back without a restart: HISTORY_S behind the last one sent (~3 MB at
// 5 Mb/s), and from SEEK_KEEP_S before the last seek target (a paused webview reads seconds
// ahead of the frame it shows), but never more than HISTORY_MAX_S behind the last one sent.
const HISTORY_S = 5;
const SEEK_KEEP_S = 1.5;
const HISTORY_MAX_S = 20;
// Sound sent at most this far past the picture sent.
const AUDIO_LEAD_S = 2;
const MAX_QUEUED_AUDIO = 4 * AUDIO_RATE * 4; // four seconds of unsent stereo s16le
const MAX_AUDIO_BATCH = 256 * 1024;
// Keep the normal encoder on fast links. Capped tiers use x264's VBV across ffmpeg builds.
const LINK_TIERS = [null, { height: 720, kbps: 3000 }, { height: 480, kbps: 1200 }, { height: 360, kbps: 450 }];
// Opus budget includes the 80 ms seek preroll repeated in each half-second batch.
const PCM_KBPS = AUDIO_RATE * 4 * 8 / 1000;
const OPUS_KBPS = 128;
const audioEncoders = new Map();

async function audioEncoderFor(tools, exec = run) {
  const key = encoderCacheKey(tools);
  if (!audioEncoders.has(key)) audioEncoders.set(key, (async () => {
    for (const encoder of ['libopus', 'opus']) {
      const r = await exec(tools.ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i',
        'anullsrc=r=48000:cl=stereo', '-t', '0.04', ...opusArgs(encoder), '-f', 'null', '-'], 10000);
      if (r.code === 0) return encoder;
    }
    return null;
  })());
  return audioEncoders.get(key);
}

function opusArgs(encoder) {
  return ['-c:a', encoder, '-strict', '-2', '-b:a', '96k',
    ...(encoder === 'libopus' ? ['-vbr', 'off', '-frame_duration', '20'] : [])];
}
// Link samples (2 s windows from the webview) are ignored until this long after ffmpeg's first
// output following a start, restart or seek, so its start-up stall is not taken for a slow link.
const LINK_SETTLE_MS = 2500;
// A window counts as link-limited only when the host waited for ffmpeg less than this share of the read time.
const ENCODER_WAIT_SHARE = 0.5;

/** Formats worth streaming: everything the webview can't already decode on the GPU (8-bit 4:2:0 H.264, VP8). */
function wanted(pr) {
  const v = pr && pr.video;
  if (!v) return false;
  if (v.codec === 'vp8') return false;
  if (v.codec === 'h264' && /^(yuv420p|yuvj420p)$/.test(v.pixFmt || '')) return false;
  return true;
}

/**
 * Whether a window streams at all, from videoPreviewEnhanced.remoteStream:
 * 'on' any window (tests); 'auto' (default) remote windows only (SSH, WSL, containers, tunnels),
 * and only when native ffmpeg won't play the file here (nativeChosen: the decoder rule picked it,
 * as in WSL with ffmpeg installed); 'off' never. The per-file checks (wanted(), decoder: builtin,
 * the failed-file list, pixel tools, Restricted Mode) come on top.
 */
function enabled({ setting, remote, nativeChosen }) {
  if (setting === 'on') return true;
  if (setting === 'off') return false;
  return !!remote && !nativeChosen;
}

// GPU encoders, in the order tried; a CPU encoder is the fallback.
const GPU_ENCODERS = ['h264_nvenc', 'h264_qsv', 'h264_amf', 'h264_vaapi'];
// CPU encoders: libx264 (GPL builds, distro packages), else libopenh264 (BSD; in BtbN's LGPL builds,
// which have no libx264: the build src/remoteff.js downloads on a remote).
const CPU_ENCODERS = ['libx264', 'libopenh264'];

/** The CPU encoder in an `ffmpeg -encoders` listing: libx264, else libopenh264 (libx264 when neither, as before). */
function cpuEncoder(listing) {
  if (/\slibx264\s/.test(listing || '')) return 'libx264';
  return /\slibopenh264\s/.test(listing || '') ? 'libopenh264' : 'libx264';
}

/** ffmpeg's H.264 encoder arguments for a low-latency stream, no B-frames, 2 s GOP. */
function encoderArgs(enc, fps, kbps) {
  const g = String(Math.max(1, Math.round(fps * 2)));
  switch (enc) {
    case 'h264_nvenc': return ['-c:v', 'h264_nvenc', '-preset', 'p1', '-tune', 'ull', '-rc', 'vbr', '-cq', '23', '-b:v', '0', '-maxrate', '20M', '-bufsize', '10M', '-bf', '0', '-g', g, '-profile:v', 'high'];
    case 'h264_qsv': return ['-c:v', 'h264_qsv', '-preset', 'veryfast', '-global_quality', '23', '-look_ahead', '0', '-async_depth', '1', '-bf', '0', '-g', g, '-profile:v', 'high'];
    case 'h264_amf': return ['-c:v', 'h264_amf', '-usage', 'lowlatency', '-quality', 'speed', '-rc', 'cqp', '-qp_i', '23', '-qp_p', '23', '-bf', '0', '-g', g, '-profile:v', 'high'];
    case 'h264_vaapi': return ['-c:v', 'h264_vaapi', '-qp', '23', '-bf', '0', '-g', g, '-profile:v', 'high'];
    // No B-frames in OpenH264. 4 slices on 4 threads: ~3x the single-thread speed at 1080p (220 fps).
    case 'libopenh264': return ['-c:v', 'libopenh264', '-rc_mode', 'quality', '-b:v', kbps ? `${kbps}k` : '8M', '-maxrate', kbps ? `${kbps}k` : '20M', '-allow_skip_frames', '0', '-threads', '4', '-slices', '4', '-g', g, '-profile:v', 'high'];
    default: return ['-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-crf', '23', '-maxrate', kbps ? `${kbps}k` : '20M', '-bufsize', kbps ? `${kbps / 2}k` : '10M', '-g', g, '-profile:v', 'high'];
  }
}

/** What goes before -i (VAAPI's device) and the end of the video filter (pixel format, upload), per encoder. */
function encoderFrame(enc, device) {
  if (enc === 'h264_vaapi') return { pre: ['-vaapi_device', device || '/dev/dri/renderD128'], vf: 'format=nv12,hwupload' };
  if (enc === 'h264_qsv' || enc === 'h264_amf') return { pre: [], vf: 'format=nv12' };
  return { pre: [], vf: 'format=yuv420p' };
}

/** VAAPI render nodes on a Linux host (none elsewhere). */
function renderNodes() {
  if (process.platform !== 'linux') return [];
  try { return fs.readdirSync('/dev/dri').filter((f) => /^renderD\d+$/.test(f)).sort().map((f) => `/dev/dri/${f}`); } catch { return []; }
}

/**
 * The best H.264 encoder this ffmpeg can use on this host: the first GPU encoder that is built in
 * and encodes a few test frames with the stream's own arguments, else the CPU encoder (cpuEncoder()).
 * run(cmd, args, timeoutMs) -> { code, stdout, stderr } (src/ffmpeg.js run). Returns { encoder, device?, tried, cpu }
 * (cpu: the CPU encoder to fall back to).
 */
async function probeEncoder(ffmpeg, run, { nodes = renderNodes() } = {}) {
  const tried = [];
  const list = await run(ffmpeg, ['-hide_banner', '-encoders'], 10000);
  if (list.code !== 0) throw new Error(`ffmpeg -encoders failed (${list.code}): ${String(list.stderr || '').trim()}`);
  const have = new Set(GPU_ENCODERS.filter((e) => new RegExp(`\\s${e}\\s`).test(list.stdout || '')));
  const cpu = cpuEncoder(list.stdout);
  for (const enc of GPU_ENCODERS) {
    if (!have.has(enc)) continue;
    for (const device of enc === 'h264_vaapi' ? nodes : [undefined]) {
      const fr = encoderFrame(enc, device);
      const args = ['-hide_banner', '-nostdin', '-v', 'error', ...fr.pre, '-f', 'lavfi', '-i', 'testsrc2=s=320x240:r=30:d=0.4',
        '-vf', fr.vf, ...encoderArgs(enc, 30), '-frames:v', '8', '-f', 'null', '-'];
      const r = await run(ffmpeg, args, 8000);
      const ok = r.code === 0;
      // The encoder's own first complaint says why (driver too old, no device); ffmpeg's last line doesn't.
      const lines = String(r.stderr || r.code).trim().split(/\r?\n/);
      const why = lines.find((l) => l.includes(`[${enc} @`)) || lines[lines.length - 1];
      tried.push({ encoder: enc, device, ok, error: ok ? undefined : why.replace(/^\[[^\]]*\]\s*/, '') });
      if (ok) return { encoder: enc, device, tried, cpu };
    }
  }
  return { encoder: cpu, tried, cpu };
}

// Encoder choice per host and ffmpeg: confirmed choices are kept in globalState (store).
const encoderMem = new Map();
const ENCODER_KEY = 'remoteStreamEncoders';
const ENCODER_RETRY_MS = 60000;

function encoderCacheKey(tools) {
  return `${os.hostname()}|${tools.ffmpeg}|${tools.version || ''}`;
}

/** The cached encoder for this host and ffmpeg, probing it the first time. store: a Memento (globalState) or null. */
async function encoderFor(tools, run, store, log = () => {}) {
  if (process.env.VPE_RS_ENCODER) return { encoder: process.env.VPE_RS_ENCODER };
  const key = encoderCacheKey(tools);
  const cached = encoderMem.get(key);
  if (cached && cached.until > Date.now()) return cached.result;
  const saved = !cached && store && (store.get(ENCODER_KEY) || {})[key];
  // Older CPU entries could have come from a failed listing or one failed input.
  if (saved && (saved.noGpu || GPU_ENCODERS.includes(saved.encoder))) {
    encoderMem.set(key, { choice: saved, result: Promise.resolve(saved), until: Infinity });
    return saved;
  }
  const entry = { until: Infinity };
  entry.result = (async () => {
    const t0 = Date.now();
    let r;
    try { r = await probeEncoder(tools.ffmpeg, run); } catch (e) {
      log(`remote stream encoder probe on ${os.hostname()} failed: ${e.message}; using libx264 for this stream`);
      entry.until = 0;
      return { encoder: 'libx264' };
    }
    log(`remote stream encoder on ${os.hostname()}: ${r.encoder}${r.device ? ` (${r.device})` : ''}, tested in ${Date.now() - t0} ms${r.tried.length ? `: ${r.tried.map((x) => `${x.encoder}${x.device ? ` ${x.device}` : ''} ${x.ok ? 'ok' : `failed (${x.error})`}`).join('; ')}` : ''}`);
    const rec = { encoder: r.encoder, device: r.device, cpu: r.cpu, at: Date.now() };
    entry.choice = rec;
    if (CPU_ENCODERS.includes(r.encoder)) {
      // A test encode can fail temporarily (e.g. all GPU sessions are in use).
      if (r.tried.length) { entry.until = Date.now() + ENCODER_RETRY_MS; return rec; }
      rec.noGpu = true;
    }
    if (store) {
      const all = { ...(store.get(ENCODER_KEY) || {}) };
      all[key] = rec;
      // Few hosts in practice; keep the newest 20.
      const keys = Object.keys(all).sort((a, b) => (all[b].at || 0) - (all[a].at || 0));
      for (const k of keys.slice(20)) delete all[k];
      try { await store.update(ENCODER_KEY, all); } catch { /* memory only */ }
    }
    return rec;
  })();
  encoderMem.set(key, entry);
  return entry.result;
}

/** A runtime failure can be input-specific. Reprobe the next time, including other candidates. */
function encoderFailed(tools, choice) {
  const entry = encoderMem.get(encoderCacheKey(tools));
  if (entry && entry.choice === choice) entry.until = 0;
}

class RemoteStream {
  constructor({ tools, file, post, log, maxHeight, probed, onFail, stats, encoder, device,
    cpuEncoder: cpu, onEncoderFail, audioEncoder = null, fitView = true }) {
    this.tools = tools;
    this.file = file;
    this.post = post;
    this.log = log;
    this.maxHeight = maxHeight || 1080;
    this.fitView = fitView;
    this.audioEncoder = audioEncoder;
    this.pr = probed;
    this.onFail = onFail || (() => {});
    this.onEncoderFail = onEncoderFail || (() => {});
    this.stats = !!stats;
    this.cpuEncoder = CPU_ENCODERS.includes(cpu) ? cpu : 'libx264'; // the fallback when a GPU encoder fails
    this.encoder = encoder || process.env.VPE_RS_ENCODER || this.cpuEncoder;
    this.device = device;
    this.tier = 0;
    this.topKbps = 0;
    this.topPeak = 0;
    this.linkRun = 0;
    this.lastLinkSample = 0;
    this.settleAt = Infinity; // when link samples count again (see LINK_SETTLE_MS)
    this.noticed = new Set(); // notices the user got already: 'quality', 'slow'
    this.waitingSince = 0;
    this.gen = 0;
    this.proc = null;
    this.seekT = 0;
    this.spawns = 0;
    this.lastSpawnAt = -Infinity;
    this.lastSeekAt = -Infinity;
    this.deferredSince = null;
    this.startTimer = null;
    this.reset(0);
  }

  /** Always: re-encoded, scaled, 8-bit. */
  lossy() { return true; }

  // Capped tiers use the CPU encoder this remote has (libx264, or libopenh264 in the LGPL build).
  get videoEncoder() { return this.tier ? this.cpuEncoder : this.encoder; }

  async handle(m) {
    if (this.disposed) return undefined;
    switch (m.type) {
      case 'open': this.setView(m.view); return this.open();
      case 'view': return this.setView(m);
      case 'remoteAudioFailed': return this.audioFallback(m.message);
      case 'config':
        if (m.video !== 'webcodecs' && this.pr.video) { this.onFail('H.264 WebCodecs not available in this webview'); return undefined; }
        return this.post({ type: 'configured', video: this.pr.video ? m.video : 'none', audio: this.pr.audio ? m.audio : 'none' });
      case 'more': return this.more(m);
      case 'seek': return this.seek(m);
      case 'remoteLink': return this.adapt(m);
      case 'hidden': return this.setHidden(!!m.on);
      default: return undefined; // recycle: nothing held here
    }
  }

  /**
   * The tab was hidden: the remote ffmpeg processes (encoder and sound) and the standby stop, and
   * what was read goes. Showing the tab re-seeks the page (media/engine.js setHidden), which starts
   * a new stream there, as a seek past memory does.
   */
  setHidden(on) {
    if (!on || !this.fps) return;
    const had = !!this.proc || !!this.audioProc || !!this.standby || !!this.startTimer;
    clearTimeout(this.startTimer);
    this.startTimer = null;
    this.deferredSince = null;
    this.takeStandby(NaN);
    this.reset(this.base);
    if (had) this.log('remote stream: tab hidden, ffmpeg stopped until it is shown');
  }

  open() {
    const v = this.pr.video;
    this.sizeVideo();
    this.fps = v.fps || 30;
    this.startAt(0);
    this.post({
      type: 'streams',
      info: {
        duration: this.pr.duration,
        remoteStream: { fps: this.fps, sourceCodec: v.codec, sourcePixFmt: v.pixFmt, sourceWidth: v.width, sourceHeight: v.height },
        // H.264 High, Annex B (no description: SPS/PPS come in-band before every IDR), SDR BT.709.
        video: { codec: 'h264', width: this.w, height: this.h, profile: 100, level: this.w * this.h > 1920 * 1088 ? 51 : 42, colorSpace: 1, colorTrc: 0 },
        audio: this.pr.audio ? { codec: this.audioEncoder ? 'opus' : 'pcm_s16le', sampleRate: AUDIO_RATE, channels: 2 } : null,
      },
    });
  }

  setView(view) {
    if (!view || !(view.w > 0 && view.h > 0) || !Number.isFinite(view.w + view.h)) return;
    this.view = { w: view.w, h: view.h };
    this.reSize();
  }

  setFit(on) { this.fitView = !!on; this.reSize(); }

  viewCap() {
    if (!this.fitView || !this.view) return Infinity;
    const r = this.pr.video.height / this.pr.video.width;
    const { w, h } = this.view;
    const need = Math.max(Math.min(h, w * r), Math.min(w, h * r));
    return [540, 720, 1080, 1440, 2160].find((x) => x >= need) || Infinity;
  }

  reSize() {
    if (!this.fps) return;
    const { w, h } = this;
    this.sizeVideo();
    const grow = this.h > h;
    this.resizePending = this.w !== w || this.h !== h;
    if (this.resizePending) this.log(`remote stream: picture ${this.view?.w}x${this.view?.h}: frames ${w}x${h} -> ${this.w}x${this.h}${grow ? '' : ' at the next seek'}`);
    this.w = w;
    this.h = h;
    // Drop the page's queued smaller frames too, as native playback does on enlargement.
    if (grow) this.post({ type: 'refresh' });
    // Shrinking waits for a seek; the ladder always remains an upper cap.
  }

  sizeVideo() {
    const v = this.pr.video;
    const h = Math.min(v.height, this.maxHeight, this.viewCap(), LINK_TIERS[this.tier]?.height ?? Infinity);
    const height = h - (h % 2);
    if (height !== this.h && this.standby) this.takeStandby(NaN);
    this.h = height;
    const w = Math.round((v.width * this.h) / v.height);
    this.w = w - (w % 2);
    this.resizePending = false;
  }

  args(t, audio) {
    const v = this.pr.video;
    const cap = LINK_TIERS[this.tier]?.kbps;
    const fr = encoderFrame(this.videoEncoder, this.device);
    const args = ['-hide_banner', '-nostdin', '-v', 'error', ...(audio ? [] : fr.pre)];
    if (t > 0) args.push('-ss', Math.max(0, t - 0.0005).toFixed(4));
    args.push('-noautorotate', '-protocol_whitelist', 'file', '-i', this.file);
    // Keep the outputs in separate processes: a full PCM pipe must not stall video (or vice
    // versa), and changing the video encoder must not move the audio sample clock.
    if (audio) return args.concat('-map', `0:${this.pr.audio.index}`, '-af', `aresample=${AUDIO_RATE}:async=1:first_pts=0`,
      '-ac', '2', '-ar', String(AUDIO_RATE), ...(this.audioEncoder
        ? [...opusArgs(this.audioEncoder), '-page_duration', '20000', '-f', 'opus'] : ['-f', 's16le']), 'pipe:1');
    // Timestamps: both outputs follow the stream's timestamps from the output's zero (the seek
    // target), so frame i is at base + i/fps and sample n at base + n/48000 exactly:
    // cfr duplicates/drops video frames to the timestamps (a late video start is filled), and
    // aresample's async=1 + first_pts=0 fills or trims sound to its timestamps (a sound track that
    // starts after the picture, or has gaps, would otherwise play early and drift).
    // HDR sources are shown untone-mapped here; colour is tagged BT.709 limited range.
    args.push('-map', `0:${v.index}`, '-vf', `scale=${this.w}:${this.h}:flags=bilinear,${fr.vf}`,
      ...(this.tools.legacy ? ['-vsync', 'cfr'] : ['-fps_mode', 'cfr']), '-r', String(this.fps), ...encoderArgs(this.videoEncoder, this.fps, cap),
      '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
      '-bsf:v', 'h264_metadata=aud=insert', '-f', 'h264', 'pipe:1');
    return args;
  }

  /** Forgets the current stream (kills its ffmpeg) and sets up an empty one starting at t. */
  reset(t) {
    this.kill();
    this.base = t;
    this.vBase = t;
    this.frameIndex = 0; // video packets read from this stream
    this.vAll = []; // packets read: the previous and the current GOP already sent, and the ones not sent yet
    this.vNext = 0; // index in vAll of the next packet to send
    this.aStore = []; // sound read, { s: first sample (from base), b: interleaved s16le Buffer, or Opus packet }
    this.aEnd = 0; // samples read
    this.ogg = this.audioEncoder ? new OggOpus((p) => {
      this.aStore.push(p);
      this.aEnd = Math.max(this.aEnd, p.s + p.n);
    }) : null;
    this.aRest = Buffer.alloc(0); // bytes of a partial sample
    this.aNext = 0; // next sample to send
    this.pending = Buffer.alloc(0);
    this.videoEnded = false;
    this.audioEnded = !this.pr.audio;
    this.audioPaused = false;
    this.waiting = null;
    this.gotOutput = false;
    this.settleAt = Infinity;
  }

  startAt(t) {
    if (this.disposed) return;
    this.reset(t);
    this.spawnNow();
  }

  audioFallback(why) {
    if (!this.audioEncoder) return;
    this.log(`remote stream: Opus failed (${why}); using s16 PCM`);
    this.audioEncoder = null;
    this.takeStandby(NaN);
    this.reset(this.base);
    // Let the page seek from its playhead, discarding compressed batches from the old generation.
    this.post({ type: 'refresh' });
  }

  /** Starts ffmpeg for the current (reset) stream. */
  spawnNow() {
    if (this.disposed) return;
    clearTimeout(this.startTimer);
    this.startTimer = null;
    this.deferredSince = null;
    this.spawnVideo();
    if (!this.pr.audio) return;
    const proc = this.launch(this.base, true);
    this.audioProc = proc;
    proc.stdout.on('data', (d) => {
      if (proc !== this.audioProc) return;
      try { this.addAudio(d); this.answer(); } catch (e) { this.audioFallback(e.message); }
    });
    this.onExit(proc, (code, signal) => {
      if (proc !== this.audioProc) return;
      this.audioProc = null;
      if (code !== 0 || signal) {
        if (this.audioEncoder) this.audioFallback(this.exitReason(proc, code, signal));
        else this.fail(`audio: ${this.exitReason(proc, code, signal)}`);
        return;
      }
      this.audioEnded = true;
      if (this.videoEnded) this.prepareLoop();
      this.answer();
    });
  }

  spawnVideo() {
    const t = this.vBase;
    const proc = this.takeStandby(t) || this.launch(t);
    this.proc = proc;
    this.spawns++;
    this.lastSpawnAt = Date.now();
    const t0 = Date.now();
    proc.stdout.on('data', (d) => {
      if (proc !== this.proc) return;
      if (!this.gotOutput) {
        this.log(`remote stream: first bytes ${Date.now() - t0} ms after start${proc.adopted ? ' (prepared at the end)' : ''}`);
        this.settleAt = Date.now() + LINK_SETTLE_MS;
      }
      this.gotOutput = true;
      this.pending = this.pending.length ? Buffer.concat([this.pending, d]) : d;
      this.split(false);
      if (this.vAll.length - this.vNext > MAX_QUEUED_SECONDS * this.fps) proc.stdout.pause();
      this.answer();
    });
    this.onExit(proc, (code, signal) => {
      if (proc !== this.proc) return;
      this.proc = null;
      if (code !== 0 || signal) {
        const why = this.exitReason(proc, code, signal);
        if (!CPU_ENCODERS.includes(this.videoEncoder)) this.encoderFallback(why);
        else this.fail(why);
        return;
      }
      this.split(true);
      this.videoEnded = true;
      if (this.audioEnded) this.prepareLoop();
      this.answer();
    });
    const cap = LINK_TIERS[this.tier]?.kbps;
    this.log(`remote stream from ${t.toFixed(3)} s: ${this.pr.video.codec} ${this.pr.video.pixFmt} ${this.pr.video.width}x${this.pr.video.height} -> H.264 ${this.w}x${this.h} (${this.videoEncoder}${cap ? `, ${cap} kb/s cap` : ''})`);
  }

  onExit(proc, finish) {
    // Unread bytes in a paused pipe can hold 'close' open after a kill. On failure discard
    // those bytes, but let stderr drain so the error still includes ffmpeg's diagnostic.
    proc.on('exit', (code, signal) => { if ((code !== 0 || signal) && proc.stdout.isPaused()) proc.stdout.destroy(); });
    proc.on('close', finish);
  }

  exitReason(proc, code, signal) {
    const why = proc.err.text.trim().split(/\r?\n/).slice(-2).join(' | ');
    return [signal ? `signal ${signal}` : `exit ${code}`, why].filter(Boolean).join(': ');
  }

  fail(why) {
    this.kill();
    this.waiting = null;
    this.onFail(why);
  }

  encoderFallback(why) {
    const enc = this.encoder;
    this.log(`remote stream: ${enc} failed (${why}); retrying this stream with ${this.cpuEncoder}`);
    this.encoder = this.cpuEncoder;
    this.device = undefined;
    this.onEncoderFail(enc);
    this.restartVideo();
  }

  /** Restart at the first unsent frame. The in-band IDR changes size without disturbing PCM. */
  restartVideo() {
    this.takeStandby(NaN);
    const proc = this.proc;
    this.proc = null;
    if (proc) { proc.stdout.destroy(); proc.kill("SIGKILL"); }
    const next = this.vNext < this.vAll.length ? this.vAll[this.vNext].t : this.vBase + this.frameIndex / this.fps;
    this.vBase = Math.round(next * this.fps) / this.fps;
    this.vAll.length = this.vNext;
    this.frameIndex = 0;
    this.pending = Buffer.alloc(0);
    this.gotOutput = false;
    this.settleAt = Infinity;
    this.linkRun = 0;
    this.videoEnded = false;
    this.spawnVideo();
  }

  /**
   * The quality ladder, from the webview's 2 s link samples (media/engine.js sampleRemoteLink):
   * kbps is what the link delivered (the time the host waited for ffmpeg taken out), starved
   * that the picture buffer ran low most of the window. Only link-limited windows count: a window
   * where the host mostly waited for ffmpeg (a slow remote CPU or source decode) says nothing about
   * the link, and neither do the windows right after ffmpeg (re)started. Two bad windows step down,
   * straight to the first tier whose video cap plus the sound (Opus or s16 PCM) fits what the
   * link delivered; four good windows with 30% headroom step up one tier. The lowest tier is the
   * floor: when the link can't carry even that, the stream stays there and says so once (the
   * built-in decoder would read the whole source file over the same link).
   */
  adapt(m) {
    if (m.gen !== this.gen || (!this.proc && this.vNext === this.vAll.length)) return;
    const now = Date.now();
    if (now - this.lastLinkSample > 3500) this.linkRun = 0;
    this.lastLinkSample = now;
    if (now < this.settleAt) return; // ffmpeg start-up is in this window
    // Use the measured cost of the top tier, smoothing keyframe and scene-change bursts; keep a
    // decayed peak beside it, so a quiet scene doesn't make a busy one look affordable later.
    if (!this.tier && m.videoKbps > 0) {
      this.topKbps = this.topKbps ? 0.75 * this.topKbps + 0.25 * m.videoKbps : m.videoKbps;
      this.topPeak = Math.max(m.videoKbps, 0.9 * this.topPeak);
    }
    const nextCap = LINK_TIERS[this.tier - 1]?.kbps ?? Math.max(3000, this.topKbps, this.topPeak);
    const pcm = this.pr.audio ? (this.audioEncoder ? OPUS_KBPS : PCM_KBPS) : 0;
    // No read completed in the window (one read outlasted it): only a very slow link does that.
    const readMs = m.readMs ?? 0;
    const linkLimited = !(readMs > 0) || (m.hostWaitMs || 0) < ENCODER_WAIT_SHARE * readMs;
    const down = linkLimited && m.starved && (m.mediaRate < 0.95 || m.behind);
    const up = this.tier > 0 && m.buffer >= 0.25 && !m.starved && !m.behind && m.kbps > 1.3 * (nextCap + pcm);
    const step = down ? 1 : up ? -1 : 0;
    const detail = `${Math.round(m.kbps)} kb/s delivered, ${m.buffer.toFixed(2)} s buffered${m.hostWaitMs ? `, ${Math.round(m.hostWaitMs)} of ${Math.round(readMs)} ms waiting for ffmpeg` : ''}`;
    if (this.stats && (this.tier || m.starved)) this.log(`remote stream link: ${detail}, video ${m.mediaRate.toFixed(2)}x, starved=${m.starved}, behind=${m.behind}, link-limited=${linkLimited}, next profile ${Math.round(nextCap + pcm)} kb/s`);
    const run = this.linkRun;
    this.linkRun = step && (Math.sign(run) === step ? run + step : step);
    // Drop after two bad windows, but take four good windows and bandwidth headroom to recover.
    if (this.linkRun < 2 && this.linkRun > -4) return;
    this.linkRun = 0;
    const last = LINK_TIERS.length - 1;
    if (down && this.tier === last) { this.slowLink(detail); return; }
    let tier = this.tier + step;
    // Skip tiers that cannot fit alongside the sound.
    if (down) while (tier < last && LINK_TIERS[tier].kbps + pcm > m.kbps) tier++;
    this.tier = tier;
    this.sizeVideo();
    this.log(`remote stream: quality ${down ? 'down' : 'up'} to ${this.h}p (${detail})`);
    if (down && tier === last && LINK_TIERS[last].kbps + pcm > m.kbps) this.slowLink(detail);
    else if (down) this.notice('quality', `Slow connection: the remote stream lowered the picture to ${this.h}p to keep playing. It goes back up when the connection allows.`);
    this.restartVideo();
  }

  /** At the lowest tier the link still can't keep up: stay there (no fallback) and tell the user once. */
  slowLink(detail) {
    this.log(`remote stream: the link can't carry the lowest quality${this.pr.audio ? ' with its sound' : ''} (${detail}); staying at ${this.h}p`);
    this.notice('slow', `The connection is too slow for this video${this.pr.audio ? ` with its sound (${this.audioEncoder ? 'Opus, about 0.13' : 'uncompressed, about 1.5'} Mb/s)` : ''}, even at ${this.h}p: playback may stutter.`);
  }

  /** A notice in the webview, once per stream and kind. */
  notice(kind, text) {
    if (this.noticed.has(kind)) return;
    this.noticed.add(kind);
    this.post({ type: 'remoteNotice', kind, text });
  }

  launch(t, audio = false) {
    const proc = lowerPriority(spawn(this.tools.ffmpeg, this.args(t, audio), { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }));
    proc.t = t;
    proc.err = { text: '' };
    proc.stderr.on('data', (d) => { proc.err.text = (proc.err.text + d).slice(-2000); });
    proc.on('error', (e) => { proc.err.text += String(e); });
    return proc;
  }

  /**
   * At the end, an ffmpeg for the start waits with its output unread (it blocks after its first
   * packets), so a looping clip restarts without ffmpeg's ~0.2 s start-up (as src/native.js does).
   */
  prepareLoop() {
    if (this.standby || this.disposed) return;
    const sb = this.launch(0);
    this.standby = sb;
    sb.timer = setTimeout(() => { if (this.standby === sb) { this.standby = null; sb.kill("SIGKILL"); } }, 20000);
  }

  takeStandby(t) {
    const sb = this.standby;
    this.standby = null;
    if (!sb) return null;
    clearTimeout(sb.timer);
    if (sb.t === t && sb.pid && sb.exitCode === null && !sb.signalCode) { sb.adopted = true; return sb; }
    sb.kill("SIGKILL");
    return null;
  }

  /** Cuts complete access units (AUD to AUD) off the pending bytes; at the end, the rest too. */
  split(final) {
    const buf = this.pending;
    let start = buf.indexOf(AUD);
    if (start < 0) { if (final) this.pending = Buffer.alloc(0); return; }
    start = start > 0 && buf[start - 1] === 0 ? start - 1 : start;
    for (;;) {
      let next = buf.indexOf(AUD, start + 4);
      if (next < 0) {
        if (final && start < buf.length) this.pushPacket(buf.subarray(start));
        this.pending = final ? Buffer.alloc(0) : Buffer.from(buf.subarray(start));
        return;
      }
      if (buf[next - 1] === 0) next--;
      this.pushPacket(buf.subarray(start, next));
      start = next;
    }
  }

  pushPacket(data) {
    // An IDR slice (NAL type 5) makes it a keyframe; SPS/PPS precede it in-band.
    let key = false;
    for (let i = data.indexOf(AUD.subarray(0, 3)); i >= 0 && i + 3 < data.length; i = data.indexOf(AUD.subarray(0, 3), i + 3)) {
      if ((data[i + 3] & 0x1f) === 5) { key = true; break; }
    }
    // Output frame i of a cfr stream is at i/fps after the output's zero (the seek target): the
    // stream's own timestamp (raw H.264 carries none, so it is computed, not counted from arrivals).
    const t = this.vBase + this.frameIndex / this.fps;
    this.frameIndex++;
    this.vAll.push({ kind: 'packet', t, key, idr: key, data: new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.length)) });
  }

  addAudio(d) {
    if (this.audioEncoder) {
      this.ogg.push(d);
      if (this.aEnd - this.aNext >= 4 * AUDIO_RATE) {
        this.audioPaused = true;
        this.audioProc.stdout.pause();
      }
      return;
    }
    const all = this.aRest.length ? Buffer.concat([this.aRest, d]) : Buffer.from(d);
    const n = Math.floor(all.length / 4);
    this.aRest = Buffer.from(all.subarray(n * 4));
    if (!n) return;
    this.aStore.push({ s: this.aEnd, b: all.subarray(0, n * 4) });
    this.aEnd += n;
    if ((this.aEnd - this.aNext) * 4 >= MAX_QUEUED_AUDIO) {
      this.audioPaused = true;
      this.audioProc.stdout.pause();
    }
  }

  more(m) {
    if (this.disposed || m.gen !== this.gen) return;
    this.waiting = m;
    this.waitingSince = Date.now();
    this.answer();
  }

  /**
   * Sends one batch for the outstanding 'more': packets up to its byte limit, and the sound read
   * so far up to AUDIO_LEAD_S past the picture sent (ffmpeg's sound output can run far ahead of
   * its picture; the webview would hold it all). After the last picture, send the tail on demand.
   */
  answer() {
    const m = this.waiting;
    if (!m) return;
    const gen = this.gen;
    // Smaller reads on constrained links reduce the wait for a single batch. Keep the normal
    // batch size on fast links so message round trips don't artificially limit throughput.
    const limit = Math.min(m.limit || 384 * 1024, this.tier ? 128 * 1024 : Infinity);
    const videoUntil = m.videoUntil ?? Infinity; // paused read-ahead stays within seek history, even with tiny packets
    // Small H.264 packets at capped rates can cover several seconds. Limit the video span
    // when PCM is also capped per read, so sound can catch up with each picture batch.
    const frameLimit = this.tier && this.pr.audio ? Math.max(1, Math.floor(this.fps / 2)) : Infinity;
    let end = this.vNext;
    let bytes = 0;
    while (end < this.vAll.length && end - this.vNext < frameLimit
      && (end === this.vNext || (this.vAll[end].t <= videoUntil && bytes + this.vAll[end].data.length <= limit))) bytes += this.vAll[end++].data.length;
    const vT = end > 0 ? this.vAll[end - 1].t + 1 / this.fps : this.base;
    const tail = this.videoEnded && this.vNext === this.vAll.length;
    // Catch sound up to each picture batch even when it contains several seconds of small
    // H.264 packets. Once there is only sound left, each read gets a bounded chunk of PCM.
    const aCap = tail ? this.aNext + Math.max(1, Math.floor(Math.min(limit, MAX_AUDIO_BATCH) / 4))
      : Math.round((vT + AUDIO_LEAD_S - this.base) * AUDIO_RATE);
    const aHi = Math.min(this.aEnd, aCap, this.audioEncoder ? this.aNext + AUDIO_RATE / 2 : Infinity,
      this.tier ? this.aNext + Math.floor(MAX_AUDIO_BATCH / 4) : Infinity);
    if (end === this.vNext && (aHi - this.aNext < 1
      || (this.audioEncoder && !this.audioEnded && aHi - this.aNext < AUDIO_RATE / 2))) {
      if (tail && this.audioEnded) { this.waiting = null; this.post({ type: 'batch', gen, eof: true, video: [], audio: [], hostWaitMs: Date.now() - this.waitingSince }); }
      return;
    }
    this.waiting = null;
    const video = this.vAll.slice(this.vNext, end);
    this.vNext = end;
    const audio = this.takeAudio(aHi);
    this.trim();
    this.account(video.length, bytes, audio);
    if (this.proc && this.proc.stdout.isPaused() && this.vAll.length - this.vNext < (MAX_QUEUED_SECONDS * this.fps) / 2) this.proc.stdout.resume();
    if (this.audioProc && this.audioPaused && (this.aEnd - this.aNext) * 4 < MAX_QUEUED_AUDIO / 2) {
      this.audioPaused = false;
      this.audioProc.stdout.resume();
    }
    // How long this read waited here for ffmpeg's output: the webview takes it out of the link time.
    this.post({ type: 'batch', gen, video, audio, videoEnd: this.videoEnded && this.vNext === this.vAll.length, hostWaitMs: Date.now() - this.waitingSince });
  }

  /** The sound from aNext up to sample hi (read already), still compressed or signed 16-bit. */
  takeAudio(hi) {
    const from = this.aNext;
    const n = hi - from;
    if (n < 1) return [];
    if (this.audioEncoder) {
      // Every batch is independently decodable: 80 ms of Opus preroll makes seeks and loop
      // starts use exactly the same path as ordinary reads, without moving the sample clock.
      if (!this.audioEnded && n < AUDIO_RATE / 2) return [];
      const packets = this.aStore.filter((p) => p.s + p.n > from - 3840 && p.s < hi);
      if (!packets.length) return [];
      this.aNext = hi;
      return [{ kind: 'opus', t: this.base + from / AUDIO_RATE, sampleRate: AUDIO_RATE,
        head: this.ogg.head, packets: packets.map((p) => new Uint8Array(p.b)),
        skip: from - packets[0].s, samples: n }];
    }
    const data = new Uint8Array(n * 4);
    for (const c of this.aStore) {
      const lo = Math.max(from, c.s);
      const top = Math.min(hi, c.s + c.b.length / 4);
      if (top > lo) data.set(c.b.subarray((lo - c.s) * 4, (top - c.s) * 4), (lo - from) * 4);
    }
    this.aNext = hi;
    return [{ kind: 's16', t: this.base + from / AUDIO_RATE, sampleRate: AUDIO_RATE, data }];
  }

  /**
   * Keeps what was sent from the keyframe at or before HISTORY_S behind the last packet sent, or
   * SEEK_KEEP_S before the last seek target if that is earlier (at most HISTORY_MAX_S back), and
   * the sound from there, for seeks and steps back: the webview reads ahead of the shown frame
   * (seconds of small packets), so the history is by time, not by GOPs.
   */
  trim() {
    if (!this.vNext) return;
    const lastT = this.vAll[this.vNext - 1].t;
    const keepT = Math.max(lastT - HISTORY_MAX_S, Math.min(lastT - HISTORY_S, this.seekT - SEEK_KEEP_S));
    let k = -1;
    for (let i = this.vNext - 1; i >= 0; i--) if (this.vAll[i].key && this.vAll[i].t <= keepT) { k = i; break; }
    if (k > 0) {
      this.vAll.splice(0, k);
      this.vNext -= k;
    }
    const keepFrom = this.vAll.length ? Math.round((this.vAll[0].t - this.base) * AUDIO_RATE) : this.aNext;
    const sMin = Math.max(Math.min(keepFrom, this.aNext), this.aNext - HISTORY_MAX_S * AUDIO_RATE) - (this.audioEncoder ? 4800 : 0);
    while (this.aStore.length && this.aStore[0].s + (this.aStore[0].n ?? this.aStore[0].b.length / 4) <= sMin) this.aStore.shift();
  }

  /** Test logs: packets and megabits per second sent, and how far sound leads the picture, every 2 s. */
  account(n, bytes, audio) {
    if (!this.stats) return;
    const now = Date.now();
    const st = this.st || (this.st = { t0: now, n: 0, bytes: 0 });
    st.n += n;
    st.bytes += bytes;
    const span = now - st.t0;
    if (span < 2000) return;
    const vT = this.vNext > 0 ? this.vAll[this.vNext - 1].t + 1 / this.fps : this.base;
    const aT = this.base + this.aNext / AUDIO_RATE;
    this.log(`remote stream stats: ${(st.n * 1000 / span).toFixed(1)} fps sent, video ${(st.bytes * 8 / span / 1000).toFixed(2)} Mb/s, ${this.w}x${this.h} ${this.videoEncoder}, sent to ${vT.toFixed(2)} s video / ${this.pr.audio ? `${aT.toFixed(2)} s sound` : 'no sound'}, ffmpeg starts ${this.spawns}`);
    this.st = { t0: now, n: 0, bytes: 0 };
  }

  /**
   * A seek: served from memory when the target frame was read already (or is about to be, with
   * ffmpeg running), else ffmpeg restarts there. Restarts are coalesced while seeks keep coming
   * (scrubbing): the first starts at once, later ones once the burst pauses SEEK_QUIET_MS, at most
   * one start per SPAWN_GAP_MS and no seek waits longer than SEEK_MAX_DEFER_MS. The webview gets
   * 'seeked' at once either way and asks for packets; they come when ffmpeg has them.
   */
  seek(m) {
    if (this.disposed) return;
    this.gen = m.gen;
    this.linkRun = 0;
    this.settleAt = Date.now() + LINK_SETTLE_MS; // the buffer refills after any seek, from memory or not
    const idx = Math.max(0, Math.floor(m.t * this.fps + 1e-6));
    const t = idx / this.fps;
    this.seekT = t;
    const now = Date.now();
    const quiet = now - this.lastSeekAt >= SEEK_QUIET_MS;
    this.lastSeekAt = now;
    if (!this.resizePending && this.reuse(t)) {
      this.post({ type: 'seeked', gen: m.gen, t });
      return;
    }
    // A short seek back (frame steps back) starts up to STEP_BACK_LEAD_S earlier, so the next steps
    // back come from memory; the webview skips the frames before the target, sound starts at it.
    // "Short": just before what memory holds, or just before where this stream started.
    const from = this.vAll.length ? this.vAll[0].t : this.base;
    const near = (x) => t < x && x - t <= STEP_BACK_SPAN_S;
    const back = this.vAll.length && t < from && (near(from) || near(this.base));
    const start = back ? Math.max(0, idx - Math.round(this.fps * STEP_BACK_LEAD_S)) / this.fps : t;
    this.sizeVideo();
    this.reset(start);
    this.aNext = Math.max(0, Math.round((t - start) * AUDIO_RATE));
    this.post({ type: 'seeked', gen: m.gen, t });
    clearTimeout(this.startTimer);
    this.startTimer = null;
    const due = this.lastSpawnAt + SPAWN_GAP_MS;
    if (quiet && now >= due) { this.spawnNow(); return; }
    if (this.deferredSince === null) this.deferredSince = now;
    const at = Math.min(Math.max(due, now + SEEK_QUIET_MS), this.deferredSince + SEEK_MAX_DEFER_MS);
    this.startTimer = setTimeout(() => { this.startTimer = null; if (!this.disposed && !this.proc) this.spawnNow(); }, Math.max(0, at - now));
  }

  /** Seek to t from the packets in memory: from the last keyframe at or before t; false when t isn't covered. */
  reuse(t) {
    if (!this.vAll.length || (!this.proc && !this.videoEnded)) return false;
    const eps = 0.25 / this.fps;
    const last = this.vAll[this.vAll.length - 1].t;
    const running = this.proc && this.proc.exitCode === null && !this.proc.signalCode;
    if (t > last + eps && !(running && t <= last + REUSE_AHEAD_S)) return false;
    let k = -1;
    for (let i = this.vAll.length - 1; i >= 0; i--) if (this.vAll[i].key && this.vAll[i].t <= t + eps) { k = i; break; }
    if (k < 0) return false;
    const s = Math.max(0, Math.round((t - this.base) * AUDIO_RATE));
    const have = this.aStore.length ? this.aStore[0].s : this.aEnd;
    if (this.pr.audio && s < have) return false; // the sound for t is gone already (should not happen: it is kept with the packets)
    this.vNext = k;
    this.aNext = s;
    this.waiting = null;
    this.log(`remote stream: seek to ${t.toFixed(3)} s from memory (keyframe at ${this.vAll[k].t.toFixed(3)} s), no restart`);
    return true;
  }

  kill() {
    const video = this.proc;
    const audio = this.audioProc;
    this.proc = null;
    this.audioProc = null;
    for (const proc of [video, audio]) {
      if (!proc) continue;
      proc.stdout.destroy();
      if (proc.exitCode === null && !proc.signalCode) proc.kill("SIGKILL");
    }
  }

  dispose() {
    this.disposed = true;
    clearTimeout(this.startTimer);
    this.startTimer = null;
    this.kill();
    this.takeStandby(NaN);
  }
}

module.exports = { RemoteStream, wanted, enabled, encoderArgs, encoderFrame, probeEncoder, encoderFor, encoderFailed, cpuEncoder, GPU_ENCODERS, CPU_ENCODERS, ENCODER_KEY, LINK_TIERS, PCM_KBPS, OPUS_KBPS, audioEncoderFor, LINK_SETTLE_MS };
