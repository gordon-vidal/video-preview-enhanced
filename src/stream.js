'use strict';
// Unified Live transcode stream engine (ADR 0002): local high-rate playback (e.g. 4K60) and
// remote windows (SSH, WSL, containers, tunnels).
//
// Runs ffmpeg on the host (local or remote) to decode, scale and re-encode a low-latency H.264
// stream (Annex B, AUD before every frame, no B-frames) for WebCodecs in the webview:
//   1. Full GPU pipeline when available (GPU decode -> GPU scale -> GPU encode)
//   2. CPU decode -> GPU encode fallback (e.g. codecs without GPU decode, or h264_mf -hw_encoding 1)
//   3. Software encode (libx264 / libopenh264) as the last resort
//
// Speaks media/decoder-worker.js's protocol (streams, config, more -> batch, seek -> seeked)
// with H.264 'packet' items. Pixel tools always switch to exact original pixels (lossy() === true).

const { spawn } = require('child_process');
const { lowerPriority, run } = require('./ffmpeg');
const {
  CPU_ENCODERS,
  buildVideoPipeline,
  buildDirectStreamArgs,
  defaultCodecLevel,
  pipelineLabel,
  toneMapSupport,
} = require('./transcode_args');
const { encoderCacheKey } = require('./transcode_probe');
const { effectiveMaxKbps, isHdr, canDirectStreamVideo, resolutionOf } = require('./transcode_policy');
const { LinkAdaptController, LINK_TIERS, LINK_SETTLE_MS } = require('./stream-adapt');
const { SeekHistoryBuffer, AUDIO_RATE, MAX_QUEUED_AUDIO } = require('./stream-buffer');

const MAX_QUEUED_SECONDS = 2; // packets read ahead of the webview before ffmpeg is paused
const OVERLAP_LEAD_S = 1;
// Seeks: a burst (the seek bar dragged, keys held) starts ffmpeg once it pauses this long...
const SEEK_QUIET_MS = 60;
// ...and at most once per this while it goes on, never deferring a seek longer than SEEK_MAX_DEFER_MS.
const SPAWN_GAP_MS = 200;
const SEEK_MAX_DEFER_MS = 400;
// A seek back by at most STEP_BACK_SPAN_S from the stream's start restarts STEP_BACK_LEAD_S (REMOTE_STEP_BACK_LEAD_S on
// remote links) before the target, so the next backward steps (wheel notches) are served from the packets held.
const STEP_BACK_SPAN_S = 4;
const STEP_BACK_LEAD_S = 1;
const REMOTE_STEP_BACK_LEAD_S = 2.5;
// Sound sent at most this far past the picture sent.
const AUDIO_LEAD_S = 2;
const MAX_AUDIO_BATCH = 256 * 1024;
// Opus budget includes the 80 ms seek preroll repeated in each half-second batch.
const PCM_KBPS = AUDIO_RATE * 4 * 8 / 1000;
const OPUS_KBPS = 128;
const audioEncoders = new Map();
// Largest video batch per reply on a remote link (see answer()).
const REMOTE_BATCH_BYTES = 128 * 1024;

/**
 * Where ffmpeg restarts for a seek to t (pure). A seek back just before the packets held starts the step-back
 * lead (REMOTE_STEP_BACK_LEAD_S on remote links) earlier; any other seek starts at t.
 * @param {number} t
 * @param {{ from: number, base: number, hasPackets: boolean, fps: number, remote?: boolean }} s
 *   from: time of the first packet held; base: time the stream started at
 */
function stepBackStart(t, { from, base, hasPackets, fps, remote = false }) {
  const near = (x) => t < x && x - t <= STEP_BACK_SPAN_S;
  if (!(hasPackets && t < from && (near(from) || near(base)))) return t;
  const lead = remote ? REMOTE_STEP_BACK_LEAD_S : STEP_BACK_LEAD_S;
  const idx = Math.max(0, Math.floor(t * fps + 1e-6));
  return Math.max(0, idx - Math.round(fps * lead)) / fps;
}

function opusArgs(encoder) {
  return ['-c:a', encoder, '-strict', '-2', '-b:a', '96k',
    ...(encoder === 'libopus' ? ['-vbr', 'off', '-frame_duration', '20'] : [])];
}

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

function spliceKeyframe(packet) {
  if (!packet.idr) return false;
  const data = Buffer.from(packet.data.buffer, packet.data.byteOffset, packet.data.byteLength);
  const prefix = Buffer.from([0, 0, 1]);
  let sps = false;
  let pps = false;
  for (let i = data.indexOf(prefix); i >= 0 && i + 3 < data.length; i = data.indexOf(prefix, i + 3)) {
    const type = data[i + 3] & 31;
    if (type === 7) sps = true;
    if (type === 8) pps = true;
    if (type === 5) return sps && pps;
  }
  return false;
}

class EncodedStream {
  constructor({
    tools, file, post, log, maxHeight, probed, onFail, stats, encoder, device,
    cpuEncoder: cpu, decodeMethod = 'none', onEncoderFail, audioEncoder = null,
    fitView = true, maxKbps = 0, maxBitrateMbps = 0, allowLinkAdapt = true, remote = true,
    allowSoftwareFallback = true, hidden = false, allowOverlap = true, rotation = 0, resolution = 0,
  }) {
    // Packets and sound read, and the history for seeks back (src/stream-buffer.js). The fields it owns are
    // reachable as this.vAll, this.aNext ... (accessors below the class).
    this.buf = new SeekHistoryBuffer({ hasAudio: !!(probed && probed.audio), audioEncoder, remote: !!remote });
    this.tools = tools;
    this.file = file;
    this.post = post;
    this.log = log;
    this.maxHeight = maxHeight || 1080;
    // A resolution fixed for this tab (⚙ › Live transcode): that height whatever the view or the link; 0 = Auto.
    this.lockHeight = resolutionOf(resolution);
    this.fitView = fitView;
    this.audioEncoder = audioEncoder;
    this.pr = probed;
    this.onFail = onFail || (() => {});
    this.onEncoderFail = onEncoderFail || (() => {});
    this.stats = !!stats;
    this.cpuEncoder = CPU_ENCODERS.includes(cpu) ? cpu : (cpu === null ? null : 'libx264');
    this.encoder = encoder || process.env.VPE_RS_ENCODER || this.cpuEncoder;
    this.device = device;
    this.decodeMethod = decodeMethod || 'none';
    this.maxBitrateMbps = Number(maxBitrateMbps) > 0 ? Number(maxBitrateMbps) : (Number(maxKbps) > 0 ? Number(maxKbps) / 1000 : 0);
    this.allowLinkAdapt = allowLinkAdapt !== false;
    this.remote = !!remote;
    this.allowSoftwareFallback = allowSoftwareFallback !== false;
    this.pipelineMode = CPU_ENCODERS.includes(this.encoder) ? 'cpu' : 'gpu-encode';
    this.hdr = isHdr(probed && probed.video); // PQ/HLG/Dolby Vision 8.x: tone-mapped to SDR BT.709 (transcode_args.js)
    this.tonemapKind = null; // the tone-mapping path in use ('qsv', 'vaapi', 'libplacebo', 'opencl', 'cpu')
    this.badTonemap = new Set(); // paths that failed on this host: the next start picks the next best
    this.rotation = Number(rotation) || 0;
    this.directStreamFailed = false;
    this.hidden = hidden;
    this.allowOverlap = allowOverlap;
    this.playing = false;
    this.overlap = null;
    this.link = new LinkAdaptController(); // the quality ladder's state (src/stream-adapt.js)
    if (this.pr && this.pr.video) this.sizeVideo();
    this.pipelineMode = this.defaultPipelineMode();
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

  /** The current link tier (0: uncapped); the ladder owns it. */
  get tier() { return this.link.tier; }
  set tier(v) { this.link.tier = v; }
  /** When link samples count again; tests set it. */
  get settleAt() { return this.link.settleAt; }
  set settleAt(v) { this.link.settleAt = v; }

  /** Whether the current video output can copy the H.264 bitstream untouched instead of re-encoding. */
  useDirectStream() {
    if (this.directStreamFailed) return false;
    return canDirectStreamVideo(this.pr && this.pr.video, {
      tier: this.tier,
      w: this.w,
      h: this.h,
      maxKbps: this.activeCapKbps(),
      rotation: this.rotation,
    });
  }

  /** Default pipeline mode before ffmpeg args choose a GPU decode/encode path. */
  defaultPipelineMode() {
    return this.useDirectStream() ? 'direct-stream' : (CPU_ENCODERS.includes(this.encoder) ? 'cpu' : 'gpu-encode');
  }

  /** False when Direct Stream copies the original H.264 bitstream untouched; true when re-encoding. */
  lossy() { return this.pipelineMode !== 'direct-stream'; }

  // Keep a working hardware encoder across capped quality tiers (encoderArgs applies VBV maxrate/bufsize).
  get videoEncoder() { return this.pipelineMode === 'direct-stream' ? 'copy' : this.encoder; }

  /** Effective bitrate ceiling in kb/s for the current tier, output size, and user cap. */
  activeCapKbps() {
    const tierCap = LINK_TIERS[this.tier]?.kbps || 0;
    const baseCap = (this.maxBitrateMbps > 0 || !this.remote)
      ? effectiveMaxKbps({ maxBitrateMbps: this.maxBitrateMbps, w: this.w || this.pr.video.width, h: this.h || this.pr.video.height, fps: this.fps || this.pr.video.fps || 30, remote: this.remote })
      : 0;
    if (tierCap > 0 && baseCap > 0) return Math.min(tierCap, baseCap);
    return tierCap || baseCap || 0;
  }

  /** Live-update the max bitrate cap in Mb/s (0 = Auto) from settings or the ⚙ panel. */
  setMaxBitrateMbps(mbps) {
    const next = Number(mbps) > 0 ? Number(mbps) : 0;
    if (next === this.maxBitrateMbps) return;
    this.maxBitrateMbps = next;
    this.buf.invalidateRegions();
    this.takeStandby(NaN);
    this.log(`live transcode: max bitrate ${next > 0 ? `${next} Mb/s` : 'auto'}`);
    // Only restart an actively running (or restored cached) video pipeline; deferred seeks and hidden tabs pick up the new cap on spawn.
    if (!this.fps && !this.disposed && this.pr && this.pr.video) {
      this.pipelineMode = this.defaultPipelineMode();
    } else if (this.fps && !this.disposed && !this.hidden && !this.startTimer && (this.proc || (this.restored && !this.videoEnded))) {
      this.transitionVideo(this.playing && !!this.proc);
    }
  }

  /**
   * This tab's resolution from the ⚙ panel: a height (the quality ladder stays off and the view size does not
   * matter), or 0 for Auto (view-fitted, the ladder adapts to the link again). Applies at once: playing, through
   * the in-band restart a quality step uses; paused, with a page seek to the same picture.
   */
  setResolution(height) {
    const next = resolutionOf(height);
    if (next === this.lockHeight) return;
    this.lockHeight = next;
    const tier = this.tier;
    if (next) this.tier = 0; // the ladder's step down no longer applies
    this.log(`live transcode: resolution ${next ? `${next}p (fixed)` : 'auto'}`);
    if (this.disposed || !this.pr || !this.pr.video) return;
    this.buf.invalidateRegions();
    this.takeStandby(NaN);
    const { w, h } = this;
    this.sizeVideo();
    const changed = this.w !== w || this.h !== h || this.tier !== tier;
    if (!this.fps) {
      this.pipelineMode = this.defaultPipelineMode();
    } else if (changed && !this.hidden && !this.startTimer && this.playing && this.proc) {
      this.transitionVideo(true);
      if ((this.pipelineMode === 'direct-stream') !== this.useDirectStream()) this.pipelineMode = this.defaultPipelineMode();
    } else if (changed) {
      // Paused (or not running): the next seek starts ffmpeg at the new size; the page makes it now when shown.
      this.w = w;
      this.h = h;
      this.resizePending = true;
      if (!this.hidden) this.post({ type: 'refresh' });
    }
    this.post({ type: 'transcodeInfo', transcode: this.transcodeInfo() });
  }

  /** Live-update the max bitrate cap in kb/s (0 = Auto). */
  setMaxKbps(kbps) {
    const n = Number(kbps) > 0 ? Number(kbps) / 1000 : 0;
    this.setMaxBitrateMbps(n);
  }

  /**
   * Compare owns the output size. Apply size and bitrate together, keeping the audio cursor.
   * With `deferGrow`, a taller output is not started here: the next seek spawns ffmpeg at the new size (the
   * picture shown meanwhile keeps its size) and true tells the caller to make that seek (message 'resize'),
   * so a paused, zoomed tile gets a crisp frame from a single ffmpeg start.
   * @returns {boolean} the output grew and the caller should refresh the tile
   */
  setCompareOutput(height, kbps, { deferGrow = false } = {}) {
    const mbps = Number(kbps) > 0 ? Number(kbps) / 1000 : 0;
    if (this.maxHeight === height && this.maxBitrateMbps === mbps) return false;
    const { w, h } = this;
    this.maxHeight = height;
    this.maxBitrateMbps = mbps;
    this.buf.invalidateRegions();
    this.takeStandby(NaN);
    this.cancelOverlap();
    if (this.disposed) return false;
    if (!this.fps) {
      if (this.pr && this.pr.video) {
        this.sizeVideo();
        this.pipelineMode = this.defaultPipelineMode();
      }
      return false;
    }
    if (deferGrow && !this.hidden) {
      this.sizeVideo();
      if (this.h > h) {
        this.w = w;
        this.h = h;
        this.resizePending = true;
        return true;
      }
    }
    if (!this.hidden && !this.startTimer && (this.proc || (this.restored && !this.videoEnded))) {
      this.sizeVideo();
      this.restartVideo();
    } else {
      this.w = w;
      this.h = h;
      this.resizePending = true;
    }
    return false;
  }

  /** Current pipeline metadata for ⓘ (About this video), stats and the remote status chip. */
  transcodeInfo(extra = null) {
    const cap = this.activeCapKbps();
    return {
      encoder: this.videoEncoder,
      mode: this.pipelineMode,
      lossy: this.lossy(),
      remote: this.remote,
      maxKbps: cap,
      hdrTonemap: this.hdr,
      tonemap: this.hdr ? this.tonemapKind : null,
      w: this.w,
      h: this.h,
      tier: this.tier,
      adapting: this.tier > 0,
      locked: this.lockHeight, // this tab's fixed resolution (0: Auto)
      adaptingDir: extra && extra.adaptingDir ? extra.adaptingDir : null,
      label: pipelineLabel({
        encoder: this.videoEncoder,
        mode: this.pipelineMode,
        remote: this.remote,
        w: this.w,
        h: this.h,
        fps: this.fps,
        maxKbps: cap,
        hdrTonemap: this.hdr,
      }),
    };
  }

  async handle(m) {
    if (this.disposed) return undefined;
    switch (m.type) {
      case 'open':
        if (m.hidden) this.setHidden(true);
        this.setView(m.view);
        return this.open();
      case 'view': return this.setView(m, !!m.playing);
      case 'playback': this.playing = !!m.playing; return undefined;
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
   * The tab was hidden: the ffmpeg processes (encoder and sound) and the standby stop, and
   * what was read goes. Showing the tab re-seeks the page (media/engine.js setHidden).
   */
  setHidden(on) {
    const wasHidden = this.hidden;
    this.hidden = !!on;
    if (!this.fps) return;
    if (!on) {
      this.hiddenRefresh = false;
      if (wasHidden && !this.spawns && !this.startTimer) this.spawnNow();
      return;
    }
    this.hiddenRefresh = !!this.growQueued;
    this.growQueued = false;
    const had = !!this.proc || !!this.audioProc || !!this.standby || !!this.startTimer;
    clearTimeout(this.startTimer);
    this.startTimer = null;
    this.deferredSince = null;
    this.takeStandby(NaN);
    this.buf.invalidateRegions();
    this.reset(this.base);
    if (had) this.log('live transcode: tab hidden, ffmpeg stopped until it is shown');
  }

  open() {
    const v = this.pr.video;
    if (this.hdr && !toneMapSupport(this.tools && this.tools.gpuFilters).any) {
      this.onFail('HDR needs ffmpeg with zscale and tonemap (or a GPU tone-mapper)');
      return undefined;
    }
    this.sizeVideo();
    this.fps = v.fps || 30;
    if (this.hidden) {
      this.pipelineMode = this.defaultPipelineMode();
    } else {
      this.startAt(0);
    }
    const level = defaultCodecLevel(this.w, this.h, this.fps);
    this.post({
      type: 'streams',
      info: {
        duration: this.pr.duration,
        remoteStream: { fps: this.fps, sourceCodec: v.codec, sourcePixFmt: v.pixFmt, sourceWidth: v.width, sourceHeight: v.height },
        transcode: this.transcodeInfo(),
        // H.264 High, Annex B (no description: SPS/PPS come in-band before every IDR), SDR BT.709.
        video: { codec: 'h264', width: this.w, height: this.h, profile: 100, level, colorSpace: 1, colorTrc: 0 },
        audio: this.pr.audio ? { codec: this.audioEncoder ? 'opus' : 'pcm_s16le', sampleRate: AUDIO_RATE, channels: 2 } : null,
      },
    });
  }

  /** `playing`: the page is playing, so a larger picture can start in-band instead of through a page seek. */
  setView(view, playing = false) {
    if (!view || !(view.w > 0 && view.h > 0) || !Number.isFinite(view.w + view.h)) return;
    this.view = { w: view.w, h: view.h };
    this.reSize(playing);
  }

  setFit(on) { this.fitView = !!on; this.reSize(); }

  viewCap() {
    if (!this.fitView || !this.view) return Infinity;
    const r = this.pr.video.height / this.pr.video.width;
    const { w, h } = this.view;
    const need = Math.max(Math.min(h, w * r), Math.min(w, h * r));
    return [540, 720, 1080, 1440, 2160].find((x) => x >= need) || Infinity;
  }

  reSize(playing = false) {
    if (!this.fps) return;
    const { w, h } = this;
    const queued = this.growQueued;
    this.sizeVideo();
    const grow = this.h > h;
    const changed = this.w !== w || this.h !== h;
    if (changed) this.buf.invalidateRegions();
    if (changed) this.log(`remote stream: picture ${this.view?.w}x${this.view?.h}: frames ${w}x${h} -> ${this.w}x${this.h}${grow ? '' : ' at the next seek'}`);
    // Playing with ffmpeg running: the in-band IDR of a restart changes the size without a page seek, so the sound
    // and the clock go on and the picture shown stays until the first larger frame (as for a quality step).
    if (grow && playing && !this.hidden && !this.startTimer && this.proc) {
      this.transitionVideo(true);
      return;
    }
    this.resizePending = changed;
    this.w = w;
    this.h = h;
    // One page seek per growth: more view messages for the same size (zoom, resize jitter) add none.
    this.growQueued = grow && !this.hidden;
    if (grow && !queued && !this.hidden) this.post({ type: 'refresh' });
  }

  sizeVideo() {
    const v = this.pr.video;
    const h = this.lockHeight ? Math.min(v.height, this.lockHeight)
      : Math.min(v.height, this.maxHeight, this.viewCap(), LINK_TIERS[this.tier]?.height ?? Infinity);
    const height = h - (h % 2);
    if (height !== this.h && this.standby) this.takeStandby(NaN);
    this.h = height;
    const w = Math.round((v.width * this.h) / v.height);
    this.w = w - (w % 2);
    this.resizePending = false;
    this.growQueued = false;
  }

  args(t, audio, { exactAudio = false } = {}) {
    const v = this.pr.video;
    if (!audio && this.useDirectStream()) {
      this.pipelineMode = 'direct-stream';
      return buildDirectStreamArgs({ file: this.file, streamIndex: v.index, startTime: t });
    }
    const cap = this.activeCapKbps();
    const pipe = audio ? { pre: [], vf: '', encArgs: [], mode: 'cpu' } : buildVideoPipeline({
      encoder: this.encoder,
      device: this.device,
      decodeMethod: this.decodeMethod,
      gpuFilters: this.tools && this.tools.gpuFilters ? this.tools.gpuFilters : null,
      video: v,
      w: this.w,
      h: this.h,
      fps: this.fps,
      maxKbps: cap,
      badTonemap: this.badTonemap,
    });
    if (!audio) { this.pipelineMode = pipe.mode; this.tonemapKind = pipe.tonemap; }
    const args = ['-hide_banner', '-nostdin', '-v', 'error', ...pipe.pre];
    if (t > 0) args.push('-ss', (audio && exactAudio ? t : Math.max(0, t - 0.0005)).toFixed(audio && exactAudio ? 6 : 4));
    args.push('-noautorotate', '-protocol_whitelist', 'file', '-i', this.file);
    // Keep the outputs in separate processes: a full PCM pipe must not stall video (or vice
    // versa), and changing the video encoder must not move the audio sample clock.
    if (audio) return args.concat('-map', `0:${this.pr.audio.index}`, '-af', `aresample=${AUDIO_RATE}:async=1:first_pts=0`,
      '-ac', '2', '-ar', String(AUDIO_RATE), ...(this.audioEncoder
        ? [...opusArgs(this.audioEncoder), '-page_duration', '20000', '-f', 'opus'] : ['-f', 's16le']), 'pipe:1');
    // Timestamps: both outputs follow the stream's timestamps from the output's zero (the seek target).
    args.push('-map', `0:${v.index}`, '-vf', pipe.vf,
      ...(this.tools && this.tools.legacy ? ['-vsync', 'cfr'] : ['-fps_mode', 'cfr']), '-r', String(this.fps), ...pipe.encArgs,
      '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
      '-bsf:v', 'h264_metadata=aud=insert', '-f', 'h264', 'pipe:1');
    return args;
  }

  /** Forgets the current stream (kills its ffmpeg) and sets up an empty one starting at t. */
  reset(t) {
    this.kill();
    this.buf.reset(t);
    this.restored = false;
    this.mixedHistoryFrom = null;
    this.videoEnded = false;
    this.audioEnded = !this.pr.audio;
    this.audioPaused = false;
    this.waiting = null;
    this.gotOutput = false;
    this.link.waitForOutput();
  }

  startAt(t) {
    if (this.disposed) return;
    this.reset(t);
    this.spawnNow();
  }

  audioFallback(why) {
    if (!this.audioEncoder) return;
    this.log(`live transcode: Opus failed (${why}); using s16 PCM`);
    this.audioEncoder = null;
    this.buf.setConfiguration('');
    this.takeStandby(NaN);
    this.reset(this.base);
    this.post({ type: 'refresh' });
  }

  /** Starts ffmpeg for the current (reset) stream. */
  spawnNow() {
    if (this.disposed) return;
    this.hidden = false;
    clearTimeout(this.startTimer);
    this.startTimer = null;
    this.deferredSince = null;
    if (this.resizePending) this.sizeVideo();
    this.spawnVideo();
    this.buf.setConfiguration(this.cacheConfiguration());
    if (this.pr.audio) this.spawnAudio(this.base);
  }

  spawnAudio(t, exact = false) {
    const proc = this.launch(t, true, { exactAudio: exact });
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
    this.watchVideo(proc);
    const cap = this.activeCapKbps();
    this.log(`remote stream from ${t.toFixed(3)} s: ${this.pr.video.codec} ${this.pr.video.pixFmt} ${this.pr.video.width}x${this.pr.video.height} -> H.264 ${this.w}x${this.h} (${this.videoEncoder}, ${this.pipelineMode}${cap ? `, ${cap} kb/s cap` : ''})`);
  }

  watchVideo(proc, overlap = null) {
    const t0 = Date.now();
    proc.stdout.on('data', (d) => {
      if (overlap && overlap === this.overlap) {
        const { buf } = overlap;
        buf.pending = buf.pending.length ? Buffer.concat([buf.pending, d]) : d;
        buf.split(false);
        if (buf.vAll.length) {
          if (!spliceKeyframe(buf.vAll[0])) return this.overlapFallback('replacement did not start with SPS/PPS and IDR');
          proc.stdout.pause();
          this.spliceVideo();
        }
        return;
      }
      if (proc !== this.proc) return;
      if (!this.gotOutput) {
        this.log(`live transcode: first bytes ${Date.now() - t0} ms after start${proc.adopted ? ' (prepared at the end)' : ''}`);
        this.link.noteFirstOutput(Date.now());
        if (this.spawns > 1) this.post({ type: 'transcodeInfo', transcode: this.transcodeInfo() });
      }
      this.gotOutput = true;
      this.pending = this.pending.length ? Buffer.concat([this.pending, d]) : d;
      if (proc.directStream) this.buf.splitMpegTs(false);
      else this.buf.split(false);
      if (this.spliceVideo()) return;
      if (this.vAll.length - this.vNext > MAX_QUEUED_SECONDS * this.fps) proc.stdout.pause();
      this.answer();
    });
    this.onExit(proc, (code, signal) => {
      if (overlap && overlap === this.overlap) {
        this.overlapFallback(this.exitReason(proc, code, signal));
        return;
      }
      if (proc !== this.proc) return;
      this.proc = null;
      if (code !== 0 || signal) {
        const why = this.exitReason(proc, code, signal);
        // Step 0a: a failed hardware tone-mapper (QSV, VA-API, libplacebo, OpenCL) drops to the next best path.
        if (this.hdr && this.tonemapKind && this.tonemapKind !== 'cpu' && !this.badTonemap.has(this.tonemapKind)) {
          this.log(`live transcode: ${this.tonemapKind} HDR tone-mapping failed (${why}); trying the next tone-mapping path`);
          this.badTonemap.add(this.tonemapKind);
          this.restartVideo();
          return;
        }
        // Step 0b: if Direct Stream (video copy) exited with an error, fall back seamlessly to re-encoding.
        // External signals (e.g. SIGKILL) report failure instead of silently respawning.
        if (proc.directStream) {
          if (!this.directStreamFailed && !signal) {
            this.log(`live transcode: direct stream failed (${why}); falling back to re-encoding (${this.encoder})`);
            this.directStreamFailed = true;
            this.restartVideo();
            return;
          }
          this.fail(why);
          return;
        }
        // Step 1: if full GPU decode->scale->encode failed, drop GPU decode and retry CPU decode -> GPU encode.
        if (this.pipelineMode === 'gpu-full' && this.decodeMethod !== 'none') {
          this.log(`live transcode: GPU decode pipeline failed (${why}); retrying with CPU decode -> ${this.videoEncoder}`);
          this.decodeMethod = 'none';
          this.restartVideo();
          return;
        }
        // Step 2: if a GPU encoder failed, fall back to software as the last resort (when a CPU encoder is available).
        if (!CPU_ENCODERS.includes(this.videoEncoder) && this.allowSoftwareFallback && this.cpuEncoder) this.encoderFallback(why);
        else this.fail(why);
        return;
      }
      if (proc.directStream) this.buf.splitMpegTs(true);
      else this.buf.split(true);
      if (this.spliceVideo()) return;
      // If the active encoder finished with frames already queued past spliceT, keep the overlap pending until ready.
      if (this.overlap && this.vAll.some((p, i) => i >= this.vNext && p.t >= this.overlap.spliceT - 0.5 / this.fps)) {
        this.answer();
        return;
      }
      // Keep the active encoder's tail if the probed duration outlasts its picture.
      this.cancelOverlap();
      this.videoEnded = true;
      if (this.audioEnded) this.prepareLoop();
      this.answer();
    });
  }

  onExit(proc, finish) {
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
    this.log(`live transcode: ${enc} failed (${why}); retrying this stream with ${this.cpuEncoder}`);
    this.encoder = this.cpuEncoder;
    this.decodeMethod = 'none';
    this.device = undefined;
    this.onEncoderFail(enc);
    this.restartVideo();
  }

  nextVideoTime() {
    return this.vAll[this.vNext]?.t ?? (this.vBase + this.frameIndex / this.fps);
  }

  transitionVideo(playing) {
    this.cancelOverlap();
    const spliceT = (Math.round(this.nextVideoTime() * this.fps) + Math.ceil(OVERLAP_LEAD_S * this.fps)) / this.fps;
    if (!playing || !this.allowOverlap || this.hidden || this.disposed || this.startTimer
      || !this.proc || this.proc.exitCode !== null || this.proc.signalCode || !(spliceT < this.pr.duration - 0.5)
      || this.pipelineMode === 'direct-stream' || this.useDirectStream()) {
      this.restartVideo();
      return;
    }
    this.takeStandby(NaN);
    const activeMode = this.pipelineMode;
    let proc;
    try {
      proc = this.launch(spliceT);
    } catch (e) {
      this.pipelineMode = activeMode;
      this.overlapFallback(e.message);
      return;
    }
    const buf = new SeekHistoryBuffer({ fps: this.fps, hasAudio: false });
    buf.reset(spliceT);
    this.overlap = { proc, spliceT, buf, mode: this.pipelineMode };
    this.pipelineMode = activeMode;
    this.spawns++;
    this.lastSpawnAt = Date.now();
    this.watchVideo(proc, this.overlap);
  }

  spliceVideo() {
    const overlap = this.overlap;
    if (!overlap || !overlap.buf.vAll.length) return false;
    const { proc, spliceT, buf, mode } = overlap;
    const boundary = spliceT - 0.5 / this.fps;
    const producedUntil = this.vBase + this.frameIndex / this.fps;
    if (producedUntil < boundary) return false;
    if (proc.signalCode || (proc.exitCode !== null && proc.exitCode !== 0)) return false;
    const cut = this.vAll.findIndex((p, i) => i >= this.vNext && p.t >= boundary);
    if (cut !== -1) this.vAll.length = cut;
    const old = this.proc;
    this.overlap = null;
    this.proc = proc;
    this.stopProcess(old);
    this.vBase = spliceT;
    this.frameIndex = buf.frameIndex;
    this.pending = buf.pending;
    for (const packet of buf.vAll) this.vAll.push(packet);
    buf.clear();
    this.pipelineMode = mode;
    this.buf.setConfiguration(''); // This active buffer now contains two video configurations.
    this.mixedHistoryFrom = spliceT;
    this.gotOutput = true;
    this.link.resetForRestart();
    this.link.noteFirstOutput(Date.now());
    this.log(`live transcode: video encoder switched at ${spliceT.toFixed(3)} s`);
    this.post({ type: 'transcodeInfo', transcode: this.transcodeInfo() });
    if (this.vAll.length - this.vNext <= MAX_QUEUED_SECONDS * this.fps) proc.stdout.resume();
    this.answer();
    return true;
  }

  cancelOverlap() {
    const overlap = this.overlap;
    this.overlap = null;
    if (!overlap) return;
    overlap.buf.clear();
    this.stopProcess(overlap.proc);
  }

  overlapFallback(why) {
    this.log(`live transcode: video overlap failed (${why}); restarting video`);
    this.restartVideo();
  }

  /** Restart at the first unsent frame. The in-band IDR changes size without disturbing audio. */
  restartVideo() {
    this.cancelOverlap();
    this.takeStandby(NaN);
    const proc = this.proc;
    this.proc = null;
    this.stopProcess(proc);
    const next = this.nextVideoTime();
    this.vBase = Math.round(next * this.fps) / this.fps;
    this.vAll.length = this.vNext;
    this.frameIndex = 0;
    this.pending = Buffer.alloc(0);
    this.buf.resetTs();
    this.gotOutput = false;
    this.link.resetForRestart();
    this.videoEnded = false;
    this.buf.setConfiguration('');
    this.mixedHistoryFrom = this.vBase;
    this.spawnVideo();
  }

  /**
   * The quality ladder, from the webview's 2 s link samples (media/engine.js sampleRemoteLink).
   * Only active when allowLinkAdapt is true (remote links).
   */
  adapt(m) {
    if (!this.allowLinkAdapt || this.lockHeight) return; // a resolution fixed by the user stays
    if (m.gen !== this.gen || (!this.proc && this.vNext === this.vAll.length)) return;
    const pcm = this.pr.audio ? (this.audioEncoder ? OPUS_KBPS : PCM_KBPS) : 0;
    const d = this.link.onSample(m, Date.now(), pcm);
    if (!d) return;
    const { down, detail } = d;
    if (this.stats && (this.tier || m.starved)) this.log(`live transcode link: ${detail}, video ${m.mediaRate.toFixed(2)}x, starved=${m.starved}, behind=${m.behind}, link-limited=${d.linkLimited}, next profile ${Math.round(d.nextCap + pcm)} kb/s`);
    if (d.change === 'none') return;
    if (d.change === 'floor') { this.slowLink(detail); return; }
    this.buf.invalidateRegions();
    this.takeStandby(NaN);
    const last = LINK_TIERS.length - 1;
    this.sizeVideo();
    this.log(`remote stream: quality ${down ? 'down' : 'up'} to ${this.h}p (${detail})`);
    if (down && this.tier === last && LINK_TIERS[last].kbps + pcm > d.fastKbps) this.slowLink(detail);
    else if (down) this.notice('quality', `Slow connection: live transcode lowered the picture to ${this.h}p to keep playing. It goes back up when the connection allows.`);
    this.transitionVideo(!down);
    if ((this.pipelineMode === 'direct-stream') !== this.useDirectStream()) this.pipelineMode = this.defaultPipelineMode();
    this.post({ type: 'transcodeInfo', transcode: this.transcodeInfo({ adaptingDir: down ? 'down' : 'up' }) });
  }

  /** At the lowest tier the link still can't keep up: stay there (no fallback) and tell the user once. */
  slowLink(detail) {
    this.log(`remote stream: the link can't carry the lowest quality${this.pr.audio ? ' with its sound' : ''} (${detail}); staying at ${this.h}p`);
    this.notice('slow', `The connection is too slow for this video${this.pr.audio ? ` with its sound (${this.audioEncoder ? 'Opus, about 0.13' : 'uncompressed, about 1.5'} Mb/s)` : ''}, even at ${this.h}p: playback may stutter.`);
  }

  /** A notice in the webview, once per stream and kind. */
  notice(kind, text) {
    if (!this.link.firstNotice(kind)) return;
    this.post({ type: 'remoteNotice', kind, text });
  }

  launch(t, audio = false, opts = undefined) {
    const argv = this.args(t, audio, opts);
    const proc = lowerPriority(spawn(this.tools.ffmpeg, argv, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }));
    proc.t = t;
    proc.directStream = !audio && this.pipelineMode === 'direct-stream';
    proc.err = { text: '' };
    proc.stderr.on('data', (d) => { proc.err.text = (proc.err.text + d).slice(-2000); });
    proc.on('error', (e) => { proc.err.text += String(e); });
    return proc;
  }

  prepareLoop() {
    if (this.standby || this.disposed) return;
    const mode = this.pipelineMode;
    const tonemap = this.tonemapKind;
    const sb = this.launch(0);
    this.pipelineMode = mode;
    this.tonemapKind = tonemap;
    this.standby = sb;
    sb.timer = setTimeout(() => { if (this.standby === sb) { this.standby = null; sb.kill('SIGKILL'); } }, 20000);
  }

  takeStandby(t) {
    const sb = this.standby;
    this.standby = null;
    if (!sb) return null;
    clearTimeout(sb.timer);
    if (sb.t === t && sb.pid && sb.exitCode === null && !sb.signalCode) { sb.adopted = true; return sb; }
    sb.kill('SIGKILL');
    return null;
  }

  /** Sound from the audio process; pauses its pipe while enough is queued ahead. */
  addAudio(d) {
    if (!this.buf.addAudio(d)) return;
    this.audioPaused = true;
    this.audioProc.stdout.pause();
  }

  more(m) {
    if (this.disposed || m.gen !== this.gen) return;
    this.waiting = m;
    this.waitingSince = Date.now();
    this.answer();
  }

  answer() {
    const m = this.waiting;
    if (!m) return;
    if (this.restored) this.continueRegion();
    const gen = this.gen;
    // A remote link keeps at most REMOTE_BATCH_BYTES in flight even at tier 0: the pipe is a FIFO, so a seek's reply
    // waits behind every old-generation byte already queued (4 Mb/s SSH: 384 KB x several batches = seconds).
    const limit = Math.min(m.limit || 384 * 1024, this.tier || this.remote ? REMOTE_BATCH_BYTES : Infinity);
    const videoUntil = m.videoUntil ?? Infinity;
    // Leave the boundary frame unsent until the replacement can supply it. If a read needs that frame
    // before the replacement is ready, use the usual restart at the first unsent timestamp.
    const boundary = this.overlap ? this.overlap.spliceT - 0.5 / this.fps : Infinity;
    if (this.vAll[this.vNext]?.t >= boundary) {
      this.overlapFallback('replacement missed the splice point');
      return;
    }
    // Even at the top tier, picture must not outrun the half second of Opus we can send per reply.
    const frameLimit = this.pr.audio && (this.tier || this.audioEncoder) ? Math.max(1, Math.floor(this.fps / 2)) : Infinity;
    let end = this.vNext;
    let bytes = 0;
    while (end < this.vAll.length && this.vAll[end].t < boundary && end - this.vNext < frameLimit
      && (end === this.vNext || (this.vAll[end].t <= videoUntil && bytes + this.vAll[end].data.length <= limit))) bytes += this.vAll[end++].data.length;
    const vT = end > 0 ? this.vAll[end - 1].t + 1 / this.fps : this.base;
    const tail = this.videoEnded && this.vNext === this.vAll.length;
    const aCap = tail ? this.aNext + Math.max(1, Math.floor(Math.min(limit, MAX_AUDIO_BATCH) / 4))
      : Math.round((vT + AUDIO_LEAD_S - this.base) * AUDIO_RATE);
    const aHi = Math.min(this.aEnd, aCap, this.audioEncoder ? this.aNext + AUDIO_RATE / 2 : Infinity,
      this.tier ? this.aNext + Math.floor(MAX_AUDIO_BATCH / 4) : Infinity);
    const canSendAudioTail = this.audioEnded || (this.restored && !this.audioProc);
    if (end === this.vNext && (aHi - this.aNext < 1
      || (this.audioEncoder && !canSendAudioTail && aHi - this.aNext < AUDIO_RATE / 2))) {
      if (tail && this.audioEnded) { this.waiting = null; this.post({ type: 'batch', gen, eof: true, video: [], audio: [], hostWaitMs: Date.now() - this.waitingSince }); }
      return;
    }
    this.waiting = null;
    const video = this.vAll.slice(this.vNext, end);
    this.vNext = end;
    const audio = this.buf.takeAudio(aHi, canSendAudioTail);
    this.buf.trim();
    this.account(video.length, bytes, audio);
    if (this.proc && this.proc.stdout.isPaused() && this.vAll.length - this.vNext < (MAX_QUEUED_SECONDS * this.fps) / 2) this.proc.stdout.resume();
    if (this.audioProc && this.audioPaused && (this.aEnd - this.aNext) * 4 < MAX_QUEUED_AUDIO / 2) {
      this.audioPaused = false;
      this.audioProc.stdout.resume();
    }
    this.post({ type: 'batch', gen, video, audio, videoEnd: this.videoEnded && this.vNext === this.vAll.length, hostWaitMs: Date.now() - this.waitingSince });
  }

  account(n, bytes) {
    if (!this.stats) return;
    const now = Date.now();
    const st = this.st || (this.st = { t0: now, n: 0, bytes: 0 });
    st.n += n;
    st.bytes += bytes;
    const span = now - st.t0;
    if (span < 2000) return;
    const vT = this.vNext > 0 ? this.vAll[this.vNext - 1].t + 1 / this.fps : this.base;
    const aT = this.base + this.aNext / AUDIO_RATE;
    this.log(`remote stream stats: ${(st.n * 1000 / span).toFixed(1)} fps sent, video ${(st.bytes * 8 / span / 1000).toFixed(2)} Mb/s, ${this.w}x${this.h} ${this.videoEncoder} (${this.pipelineMode}), sent to ${vT.toFixed(2)} s video / ${this.pr.audio ? `${aT.toFixed(2)} s sound` : 'no sound'}, ffmpeg starts ${this.spawns}`);
    this.st = { t0: now, n: 0, bytes: 0 };
  }

  seek(m) {
    if (this.disposed) return;
    const interruptedOverlap = !!this.overlap;
    this.cancelOverlap();
    if (m.playing !== undefined) this.playing = !!m.playing;
    this.gen = m.gen;
    this.link.resetForSeek(Date.now()); // the buffer refills after any seek, from memory or not
    const idx = Math.max(0, Math.floor(m.t * this.fps + 1e-6));
    const t = idx / this.fps;
    this.seekT = t;
    const now = Date.now();
    const quiet = now - this.lastSeekAt >= SEEK_QUIET_MS;
    this.lastSeekAt = now;
    // The page re-seeks when shown. An encoder just started at that frame can satisfy it.
    const startingHere = this.proc && this.proc.exitCode === null && !this.proc.signalCode
      && !this.gotOutput && this.aNext === 0 && t === this.base && t === this.vBase;
    if (!interruptedOverlap && !this.resizePending && (startingHere || this.reuseHistory(t))) {
      this.waiting = null;
      this.post({ type: 'seeked', gen: m.gen, t });
      return;
    }
    const from = this.vAll.length ? this.vAll[0].t : this.base;
    const start = stepBackStart(t, { from, base: this.base, hasPackets: this.vAll.length > 0, fps: this.fps, remote: this.remote });
    if (!interruptedOverlap && !this.resizePending && this.buf.configuration === this.cacheConfiguration()) {
      this.buf.archive(this.videoEnded, this.audioEnded);
    }
    this.sizeVideo();
    this.reset(start);
    this.aNext = Math.max(0, Math.round((t - start) * AUDIO_RATE));
    this.post({ type: 'seeked', gen: m.gen, t });
    clearTimeout(this.startTimer);
    this.startTimer = null;
    if (this.hidden && (!this.spawns || this.hiddenRefresh)) { this.hiddenRefresh = false; return; }
    const due = this.lastSpawnAt + SPAWN_GAP_MS;
    if (quiet && now >= due) { this.spawnNow(); return; }
    if (this.deferredSince === null) this.deferredSince = now;
    const at = Math.min(Math.max(due, now + SEEK_QUIET_MS), this.deferredSince + SEEK_MAX_DEFER_MS);
    this.startTimer = setTimeout(() => { this.startTimer = null; if (!this.disposed && !this.proc) this.spawnNow(); }, Math.max(0, at - now));
  }

  /** A seek served from the packets held: no ffmpeg restart. */
  reuseHistory(t) {
    if (this.buf.configuration && this.buf.configuration !== this.cacheConfiguration()) return false;
    if (this.mixedHistoryFrom !== null && this.mixedHistoryFrom !== undefined && t < this.mixedHistoryFrom - 0.25 / this.fps) return false;
    const proc = this.proc;
    const running = !!proc && proc.exitCode === null && !proc.signalCode;
    let at = this.buf.reuse(t, { hasProc: !!proc, running, videoEnded: this.videoEnded,
      detached: this.restored && !this.audioProc, restored: this.restored });
    if (at === null) {
      const region = this.buf.restore(t, this.videoEnded, this.audioEnded);
      if (!region) return false;
      this.kill();
      this.takeStandby(NaN);
      clearTimeout(this.startTimer);
      this.startTimer = null;
      this.deferredSince = null;
      this.restored = true;
      this.videoEnded = region.videoEnded;
      this.audioEnded = region.audioEnded;
      this.audioPaused = false;
      at = region.at;
    }
    this.waiting = null;
    this.log(`remote stream: seek to ${t.toFixed(3)} s from memory (keyframe at ${at.toFixed(3)} s), no restart`);
    return true;
  }

  cacheConfiguration() {
    // Direct Stream (-c:v copy) restarts in milliseconds without re-encoding and can have
    // B-frame DTS/PTS reorder, so only transcode regions are archived in the GOP LRU cache.
    if (this.pipelineMode === 'direct-stream') return '';
    return JSON.stringify([this.w, this.h, this.activeCapKbps(), this.tier, this.maxBitrateMbps,
      this.pipelineMode, this.audioEncoder, this.encoder, this.tonemapKind]);
  }

  /** A restored region has no producer. Restart each unfinished pipe on demand at its own boundary. */
  continueRegion() {
    if (!this.proc && !this.videoEnded && this.vNext === this.vAll.length) {
      this.vBase = this.nextVideoTime();
      this.frameIndex = 0;
      this.gotOutput = false;
      this.spawnVideo();
    }
    if (!this.audioProc && !this.audioEnded && this.aNext >= this.aEnd) {
      this.buf.resumeAudio(this.aNext);
      this.spawnAudio(this.base + this.aNext / AUDIO_RATE, true);
    }
    if ((this.proc || this.videoEnded) && (this.audioProc || this.audioEnded)) this.restored = false;
  }

  kill() {
    this.cancelOverlap();
    const video = this.proc;
    const audio = this.audioProc;
    this.proc = null;
    this.audioProc = null;
    this.stopProcess(video);
    this.stopProcess(audio);
  }

  stopProcess(proc) {
    if (!proc) return;
    proc.stdout.destroy();
    if (proc.exitCode === null && !proc.signalCode) proc.kill('SIGKILL');
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.startTimer);
    this.startTimer = null;
    this.kill();
    this.takeStandby(NaN);
    this.buf.clear();
    this.waiting = null;
  }
}

// The stream's buffer state lives in this.buf (src/stream-buffer.js); the stream, its tests and the
// debug probes read and write it under these names.
for (const f of ['base', 'vBase', 'frameIndex', 'vAll', 'vNext', 'aStore', 'aEnd', 'ogg', 'aRest', 'aNext', 'pending',
  'seekT', 'fps', 'audioEncoder']) {
  Object.defineProperty(EncodedStream.prototype, f, {
    get() { return this.buf[f]; },
    set(v) { this.buf[f] = v; },
  });
}

module.exports = {
  EncodedStream,
  LINK_TIERS,
  PCM_KBPS,
  OPUS_KBPS,
  LINK_SETTLE_MS,
  STEP_BACK_SPAN_S,
  STEP_BACK_LEAD_S,
  REMOTE_STEP_BACK_LEAD_S,
  stepBackStart,
  audioEncoderFor,
  opusArgs,
};
