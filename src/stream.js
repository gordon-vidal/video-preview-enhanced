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
  seekArgs,
  defaultCodecLevel,
  pipelineLabel,
  toneMapSupport,
} = require('./transcode_args');
const { encoderCacheKey } = require('./transcode_probe');
const { effectiveMaxKbps, isHdr, canDirectStreamVideo, resolutionOf } = require('./transcode_policy');
const { LinkAdaptController, LINK_TIERS, LINK_SETTLE_MS } = require('./stream-adapt');
const { SeekHistoryBuffer, AUDIO_RATE, MAX_QUEUED_AUDIO } = require('./stream-buffer');
const { sessions: hostGpuSessions, isGpuEncoder } = require('./gpu-sessions');
const { WarmDecoder, warmSourceRefusal, warmSelect, warmKeyArgs, WARM_INPUT, WARM_OUTPUT, WARM_ENCODERS } = require('./warm-decoder');

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
// Keyframe spacing of the host's H.264: 2 s while playing (compact), 0.5 s for an encode started paused (stepping,
// inspecting): a step back across a keyframe then decodes at most half a second on the page instead of two.
const PLAY_GOP_S = 2;
const PAUSED_GOP_S = 0.5;
// Fills behind a paused frame (fill): at most this many encodes at once on this host (each holds a GPU encoder session;
// consumer NVIDIA cards allow a handful), and each reply at most this many bytes (whole packets) so a seek sent
// meanwhile waits behind little on the link.
const MAX_FILLS = 2;
const FILL_PIECE_BYTES = 96 * 1024;
let fillsRunning = 0;
// A paused frame made sharp (sharp): sent in pieces of at most this many bytes, one per page request, like a fill.
const SHARP_PIECE_BYTES = 96 * 1024;
// Fast first picture (fastFirstBits): a paused start's first keyframe is made about this share of a full one, unless the
// link would carry a full one within FAST_FIRST_SKIP_MS anyway.
const FAST_FIRST_SHARE = 0.25;
const FAST_FIRST_SKIP_MS = 100;
// Quick first picture (startQuick): on a slow link, when the encoder cannot make its first keyframe small (fastFirstBits:
// only x264 can), the target frame is encoded once more at half the width and height (a quarter of the pixels, so about
// a quarter of the bytes) and sent before the stream's own frames. They wait for it at most 3/4 of the time a full
// keyframe would take on the link (beyond that the full one would show sooner), within QUICK_HOLD_MIN_MS..MAX_MS; the
// most with no link estimate yet. (Measured: the quick encode alone takes ~320 ms with NVENC, ffmpeg start included.)
const QUICK_HOLD_SHARE = 0.75;
const QUICK_HOLD_MIN_MS = 100;
const QUICK_HOLD_MAX_MS = 1000;
// A full keyframe's size before one was measured, in bytes per pixel (1080p: ~200 KB).
const KEY_BYTES_PER_PIXEL = 0.1;
// Sound sent at most this far past the picture sent.
const AUDIO_LEAD_S = 2;
const MAX_AUDIO_BATCH = 256 * 1024;
// Opus budget includes the 80 ms seek preroll repeated in each half-second batch.
const PCM_KBPS = AUDIO_RATE * 4 * 8 / 1000;
const OPUS_KBPS = 128;
const audioEncoders = new Map();
// Largest video batch per reply on a remote link (see answer()).
const REMOTE_BATCH_BYTES = 128 * 1024;
// HDR tone-mappers that failed with an ffmpeg (src/ffmpeg.js locateTools gives one tools object per check): every stream
// with it skips them, so a second video does not pay the failed start again (libplacebo without a Vulkan device: ~1 s).
const BAD_TONEMAP = new WeakMap();
/** @param {any} tools @returns {Set<string>} */
function badTonemapFor(tools) {
  if (!tools || typeof tools !== 'object') return new Set();
  let bad = BAD_TONEMAP.get(tools);
  if (!bad) { bad = new Set(); BAD_TONEMAP.set(tools, bad); }
  return bad;
}

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

/** Half a picture side, even (the quick picture: startQuick). @param {number} x */
const quickSize = (x) => Math.max(2, Math.round(x / 4) * 2);

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
    initialLink = undefined, onLinkUpdate = undefined, gpuSessions = hostGpuSessions, warm = true,
  }) {
    // Packets and sound read, and the history for seeks back (src/stream-buffer.js). The fields it owns are
    // reachable as this.vAll, this.aNext ... (accessors below the class).
    this.buf = new SeekHistoryBuffer({ hasAudio: !!(probed && probed.audio), audioEncoder, remote: !!remote });
    this.tools = tools;
    this.file = file;
    // This host's GPU encoder sessions (src/gpu-sessions.js): the live encode holds one while it runs on a GPU encoder.
    this.gpu = gpuSessions;
    this.gpuToken = null;
    /** @type {{ encoder: string, decodeMethod: string, device: any } | null} the GPU encoder a launch with no session left */
    this.gpuFallback = null;
    // The kept-running decoder for paused starts (src/warm-decoder.js): wanted for a single video and Compare's clock
    // tile (the page says so with each seek); warmOff: why this stream stopped using it (a failure).
    this.warmWanted = warm !== false;
    /** @type {any} */
    this.warm = null;
    this.warmOff = '';
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
    this.badTonemap = badTonemapFor(tools); // paths that failed with this ffmpeg: the next start picks the next best
    this.tonemapOk = null; // the tone-mapping path that gave a frame (a later failure is not the tone-mapper's)
    this.rotation = Number(rotation) || 0;
    this.directStreamFailed = false;
    this.hidden = hidden;
    this.allowOverlap = allowOverlap;
    this.playing = false;
    this.overlap = null;
    this.onLinkUpdate = this.remote && this.allowLinkAdapt ? onLinkUpdate : undefined;
    this.link = new LinkAdaptController(this.remote && this.allowLinkAdapt && !this.lockHeight ? initialLink : undefined);
    if (this.pr && this.pr.video) this.sizeVideo();
    this.pipelineMode = this.defaultPipelineMode();
    this.waitingSince = 0;
    this.gen = 0;
    this.proc = null;
    this.seekT = 0;
    // The next video start is a seek's (or the open's) own first one: only it may send a quick picture (startQuick).
    this.seekStart = false;
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
    if (this.disposed || this.failed) return undefined;
    switch (m.type) {
      case 'open':
        if (m.hidden) this.setHidden(true);
        this.setView(m.view);
        return this.open();
      case 'view': return this.setView(m, !!m.playing);
      case 'playback': this.playing = !!m.playing; if (this.playing) { this.stopFill(); this.stopSharp(); this.stopQuick(); } return undefined;
      case 'remoteAudioFailed':
        if (!this.audioEncoder) return;
        this.audioFallback(m.message);
        // The page discarded the batch that contained the undecodable sound.
        return this.post({ type: 'refresh' });
      case 'config':
        if (m.video !== 'webcodecs' && this.pr.video) { this.onFail('H.264 WebCodecs not available in this webview'); return undefined; }
        return this.post({ type: 'configured', video: this.pr.video ? m.video : 'none', audio: this.buf.hasAudio ? m.audio : 'none' });
      case 'more': return this.more(m);
      case 'seek': return this.seek(m);
      case 'remoteLink': return this.adapt(m);
      case 'hidden': return this.setHidden(!!m.on);
      case 'fill': return this.fill(m);
      case 'fillMore': return this.fillMore(m);
      case 'fillStop': return this.stopFill();
      case 'sharp': return this.sharp(m);
      case 'sharpMore': return this.sharpMore(m);
      case 'sharpStop': return this.stopSharp();
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
    if (on) { this.stopFill(); this.stopSharp(); this.stopQuick(); }
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
    this.releaseGpu(); // its encoder stopped: another video may use the session meanwhile
    this.disposeWarm('the tab is hidden');
    if (had) this.log('live transcode: tab hidden, ffmpeg stopped until it is shown');
  }

  open() {
    const v = this.pr.video;
    if (this.hdr && !toneMapSupport(this.tools && this.tools.gpuFilters, this.encoder).any) {
      this.fail('HDR needs ffmpeg with zscale and tonemap (or a GPU tone-mapper)');
      return undefined;
    }
    this.sizeVideo();
    this.fps = v.fps || 30;
    if (this.hidden) {
      this.pipelineMode = this.defaultPipelineMode();
    } else {
      this.startAt(0);
      if (this.failed) return;
    }
    const level = defaultCodecLevel(this.w, this.h, this.fps);
    this.post({
      type: 'streams',
      info: {
        duration: this.pr.duration,
        remoteStream: {
          fps: this.fps, sourceCodec: v.codec, sourcePixFmt: v.pixFmt, sourceWidth: v.width, sourceHeight: v.height,
          linkAdaptive: this.remote && this.allowLinkAdapt,
        },
        transcode: this.transcodeInfo(),
        // H.264 High, Annex B (no description: SPS/PPS come in-band before every IDR), SDR BT.709.
        video: { codec: 'h264', width: this.w, height: this.h, profile: 100, level, colorSpace: 1, colorTrc: 0 },
        audio: this.buf.hasAudio ? { codec: this.audioEncoder ? 'opus' : 'pcm_s16le', sampleRate: AUDIO_RATE, channels: 2 } : null,
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

  /**
   * @param {number} t @param {boolean} audio
   * @param {{ exactAudio?: boolean, sharp?: boolean, firstKeyBits?: number, warm?: boolean, quick?: boolean }} [opts]
   *   sharp: one visually lossless picture (sharp); firstKeyBits: a small first keyframe (fastFirstBits);
   *   warm: the kept-running decoder's process (src/warm-decoder.js): MPEG-TS in and out, frames kept as they come;
   *   quick: at half the stream's width and height (startQuick)
   */
  args(t, audio, { exactAudio = false, sharp = false, firstKeyBits = 0, warm = false, quick = false } = {}) {
    const v = this.pr.video;
    if (!audio && !warm && this.useDirectStream()) {
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
      w: quick ? quickSize(this.w) : this.w,
      h: quick ? quickSize(this.h) : this.h,
      fps: this.fps,
      maxKbps: cap,
      // Started paused (a jump or a step): keyframes every PAUSED_GOP_S, so a step back decodes few frames on the page.
      gopS: this.playing && !warm ? PLAY_GOP_S : PAUSED_GOP_S,
      sharp,
      firstKeyBits,
      badTonemap: this.badTonemap,
    });
    if (!audio) { this.pipelineMode = pipe.mode; this.tonemapKind = pipe.tonemap; this.gpuDecode = !!pipe.gpuDecode; }
    const args = ['-hide_banner', '-nostdin', '-v', 'error', ...pipe.pre];
    if (warm) {
      args.push(...WARM_INPUT, '-map', '0:v:0', '-vf', `${warmSelect(this.fps)},${pipe.vf}`, '-fps_mode', 'passthrough',
        ...pipe.encArgs, ...warmKeyArgs(this.encoder, PAUSED_GOP_S, this.fps),
        '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
        '-bsf:v', 'h264_metadata=aud=insert', ...WARM_OUTPUT, 'pipe:1');
      return args;
    }
    // Video: from the keyframe at or before t, never the one before it (transcode_args.js seekArgs).
    const seek = audio ? { input: [], vf: '' } : seekArgs(t, { formatName: this.pr.formatName, bFrames: !!v.bFrames });
    if (audio && t > 0) args.push('-ss', (exactAudio ? t : Math.max(0, t - 0.0005)).toFixed(exactAudio ? 6 : 4));
    args.push(...seek.input, '-noautorotate', '-protocol_whitelist', 'file', '-i', this.file);
    // Keep the outputs in separate processes: a full PCM pipe must not stall video (or vice
    // versa), and changing the video encoder must not move the audio sample clock.
    if (audio) return args.concat('-map', `0:${this.pr.audio.index}`, '-af', `aresample=${AUDIO_RATE}:async=1:first_pts=0`,
      '-ac', '2', '-ar', String(AUDIO_RATE), ...(this.audioEncoder
        ? [...opusArgs(this.audioEncoder), '-page_duration', '20000', '-f', 'opus'] : ['-f', 's16le']), 'pipe:1');
    // Timestamps: both outputs follow the stream's timestamps from the output's zero (the seek target).
    args.push('-map', `0:${v.index}`, '-vf', seek.vf ? `${seek.vf},${pipe.vf}` : pipe.vf,
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
    this.audioEnded = !this.buf.hasAudio;
    this.audioPaused = false;
    this.waiting = null;
    this.videoFragment = null;
    this.gotOutput = false;
    this.link.waitForOutput();
  }

  startAt(t) {
    if (this.disposed) return;
    this.failed = false;
    this.reset(t);
    this.seekStart = true;
    this.spawnNow();
  }

  audioFallback(why) {
    if (!this.audioEncoder) return;
    this.log(`live transcode: Opus failed (${why}); using s16 PCM`);
    this.audioEncoder = null;
    this.buf.setConfiguration('');
    const proc = this.audioProc;
    this.audioProc = null;
    this.stopProcess(proc);
    this.audioPaused = false;
    this.buf.resetAudio(this.aNext);
    this.audioEnded = false;
    if (!this.hidden) this.spawnAudio(this.base + this.aNext / AUDIO_RATE, true);
  }

  audioFailed(why) {
    if (this.audioEncoder) return this.audioFallback(why);
    const proc = this.audioProc;
    this.audioProc = null;
    this.stopProcess(proc);
    this.audioPaused = false;
    this.buf.hasAudio = false;
    this.buf.setConfiguration('');
    this.audioEnded = true;
    this.notice('audio', `No sound: ${why}`);
    if (this.videoEnded) this.prepareLoop();
  }

  /** Starts ffmpeg for the current (reset) stream. */
  spawnNow() {
    if (this.disposed || this.failed) return;
    this.hidden = false;
    clearTimeout(this.startTimer);
    this.startTimer = null;
    this.deferredSince = null;
    if (this.resizePending) this.sizeVideo();
    if (!this.spawnVideo()) return;
    this.buf.setConfiguration(this.cacheConfiguration());
    if (this.buf.hasAudio) this.spawnAudio(this.base);
  }

  spawnAudio(t, exact = false) {
    let proc;
    try { proc = this.launch(t, true, { exactAudio: exact }); }
    catch (e) { this.audioFailed(e.message); return; }
    this.audioProc = proc;
    proc.stdout.on('data', (d) => {
      if (proc !== this.audioProc) return;
      try { this.addAudio(d); } catch (e) { this.audioFailed(e.message); }
      this.answer();
    });
    this.onExit(proc, (code, signal) => {
      if (proc !== this.audioProc) return;
      this.audioProc = null;
      if (code !== 0 || signal) {
        this.audioFailed(this.exitReason(proc, code, signal));
        this.answer();
        return;
      }
      this.audioEnded = true;
      if (this.videoEnded) this.prepareLoop();
      this.answer();
    });
  }

  spawnVideo() {
    if (this.failed || this.disposed) return false;
    const t = this.vBase;
    this.regainGpu();
    // The quick picture is of the seek target: not for a step back's earlier start, a restart or a region going on.
    const atSeekTarget = this.seekStart && t === this.seekT;
    this.seekStart = false;
    let proc;
    let firstKeyBits = 0;
    let slowStart = false;
    try {
      proc = this.takeStandby(t);
      if (!proc) {
        firstKeyBits = this.fastFirstBits();
        slowStart = firstKeyBits > 0;
        if (this.quickHook === true) firstKeyBits = 0; // tests: the quick picture instead
        // A small first keyframe (only x264 honours it) needs a fresh encoder: it wins over the kept-running one.
        proc = firstKeyBits && this.encoder === 'libx264' ? null : this.warmSegment(t);
        if (proc) firstKeyBits = 0;
        else {
          proc = this.launch(t, false, firstKeyBits ? { firstKeyBits } : undefined);
          if (this.encoder !== 'libx264') firstKeyBits = 0; // only x264 honours it (transcode_args.js encoderArgs)
          proc.firstKeyBits = firstKeyBits;
        }
      }
    } catch (e) { this.fail(e.message); return false; }
    this.proc = proc;
    this.spawns++;
    this.lastSpawnAt = Date.now();
    this.watchVideo(proc);
    // A seek's first start at its target, a slow link and no small first keyframe (NVENC and the other encoders, or the
    // kept-running decoder): a quick picture.
    if (atSeekTarget && slowStart && !proc.firstKeyBits && this.quickHook !== false && this.pipelineMode !== 'direct-stream') this.startQuick(t);
    const cap = this.activeCapKbps();
    this.log(`remote stream from ${t.toFixed(3)} s: ${this.pr.video.codec} ${this.pr.video.pixFmt} ${this.pr.video.width}x${this.pr.video.height} -> H.264 ${this.w}x${this.h} (${this.videoEncoder}, ${this.pipelineMode}${this.gpuDecode ? ', GPU decode' : ''}${this.hdr && this.tonemapKind ? `, ${this.tonemapKind} tone-mapping` : ''}${cap ? `, ${cap} kb/s cap` : ''}${firstKeyBits ? `, first keyframe ~${Math.round(firstKeyBits / 8192)} KiB for a fast first picture` : ''}${proc.warm ? ', kept-running decoder' : ''})`);
    return true;
  }

  /**
   * Fast first picture: an encode started paused (a jump, a step the page could not serve) starts with its rate buffer
   * nearly empty, so its first keyframe is about FAST_FIRST_SHARE of a full one and shows sooner over a slow link; the
   * frames after it refill the buffer within a few frames, and the page asks for the frame it stays on sharp (sharp).
   * Same size, encoder and SPS/PPS as the rest of the stream (the page's packet cache keeps both). 0 (off) while playing,
   * on a local window, or when the link estimate (stream-adapt.js) carries a full keyframe within FAST_FIRST_SKIP_MS.
   * @returns {number} the first keyframe's size in bits, or 0
   */
  fastFirstBits() {
    if (this.playing || !this.remote || this.fastFirstHook === false || !this.w || !this.h) return 0;
    const { key, ms } = this.fullKeyOnLink();
    if (ms <= FAST_FIRST_SKIP_MS && this.fastFirstHook !== true) return 0;
    return Math.round(key * 8 * FAST_FIRST_SHARE);
  }

  /**
   * A full keyframe at this picture size (the largest measured, else 0.1 byte per pixel) and how long the link estimate
   * (stream-adapt.js fastKbps / slowKbps) takes to carry it: { key: bytes, ms } (ms Infinity with no estimate yet).
   */
  fullKeyOnLink() {
    const key = this.keyBytes > 0 && this.keyBytesFor === `${this.w}x${this.h}` ? this.keyBytes
      : Math.round(this.w * this.h * KEY_BYTES_PER_PIXEL);
    const kbps = Math.min(this.link.fastKbps || 0, this.link.slowKbps || this.link.fastKbps || 0);
    return { key, ms: kbps > 0 ? (key * 8) / kbps : Infinity }; // bits / (kb/s) = ms
  }

  /**
   * A live encode on a GPU encoder holds one of this host's GPU encoder sessions (src/gpu-sessions.js). Called before
   * every video encode starts (launch); a CPU encoder holds none. With all of them in use (other videos, Compare tiles,
   * short encodes), the stream first takes back the one its own idle kept-running decoder holds; failing that this
   * launch encodes on the CPU (gpuFallback) and the user is told once per session which video and why. The stream keeps
   * its GPU encoder: the next launch with a session free goes back to it (regainGpu).
   */
  holdGpu() {
    if (this.gpuToken || !isGpuEncoder(this.encoder) || this.pipelineMode === 'direct-stream' || this.useDirectStream()) return;
    this.gpuToken = this.gpu.acquire('stream');
    if (!this.gpuToken && this.warm && !(this.proc && this.proc.warm)) {
      this.disposeWarm('its GPU encoder session goes to the stream');
      this.gpuToken = this.gpu.acquire('stream');
    }
    if (this.gpuToken || !this.cpuEncoder || !this.allowSoftwareFallback) return; // no CPU encoder: try the GPU anyway
    const enc = this.encoder;
    const name = String(this.file || '').split(/[\\/]/).pop();
    this.log(`live transcode: all ${this.gpu.limit} GPU encoder sessions on this host are in use (${JSON.stringify(this.gpu.counts())}); `
      + `encoding with ${this.cpuEncoder} instead of ${enc} until one is free (videoPreviewEnhanced.gpuEncoderSessions)`);
    this.gpuFallback = { encoder: enc, decodeMethod: this.decodeMethod, device: this.device };
    this.encoder = this.cpuEncoder;
    this.decodeMethod = 'none';
    this.device = undefined;
    this.pipelineMode = this.defaultPipelineMode();
    if (this.gpu.firstNotice()) {
      this.post({ type: 'remoteNotice', kind: 'gpuSessions', text: `${name} is transcoded on the processor for now: all `
        + `${this.gpu.limit} GPU encoder sessions here are in use. It may play less smoothly until one is free. Settings: GPU Encoder Sessions.` });
    }
  }

  /**
   * A stream on the CPU only because no GPU encoder session was free (holdGpu): back on its GPU encoder for the next
   * launch when one is free now (or its own idle kept-running decoder's can be taken back).
   */
  regainGpu() {
    const f = this.gpuFallback;
    if (!f || this.gpu.used >= this.gpu.limit) return;
    this.gpuFallback = null;
    this.encoder = f.encoder;
    this.decodeMethod = f.decodeMethod;
    this.device = f.device;
    this.pipelineMode = this.defaultPipelineMode();
    this.log(`live transcode: a GPU encoder session is free again; encoding with ${f.encoder}`);
  }

  releaseGpu() {
    this.gpu.release(this.gpuToken);
    this.gpuToken = null;
  }

  watchVideo(proc, overlap = null) {
    const t0 = Date.now();
    const first = this.vAll.length;
    let checkedStart = false;
    const checkDirectStart = () => {
      if (checkedStart || !this.vAll[first]) return true;
      checkedStart = true;
      if (spliceKeyframe(this.vAll[first])) return true;
      // An open-GOP recovery point cannot start the webview decoder. Keep the original seek target.
      this.log('live transcode: direct stream did not start with SPS/PPS and IDR; falling back to re-encoding');
      this.directStreamFailed = true;
      this.restartVideo(this.vBase);
      return false;
    };
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
      this.tonemapOk = this.tonemapKind;
      if (!this.gotOutput) {
        this.log(`live transcode: first bytes ${Date.now() - t0} ms after start${proc.adopted ? ' (prepared at the end)' : ''}${proc.warm ? ' (kept-running decoder)' : ''}`);
        this.link.noteFirstOutput(Date.now());
        if (this.spawns > 1) this.post({ type: 'transcodeInfo', transcode: this.transcodeInfo() });
      }
      this.gotOutput = true;
      this.pending = this.pending.length ? Buffer.concat([this.pending, d]) : d;
      if (proc.directStream) {
        this.buf.splitMpegTs(false);
        if (!checkDirectStart()) return;
      } else this.buf.split(!!proc.warm); // the kept-running decoder hands over whole access units
      if (proc.firstKeyBits && !proc.markedSmall && this.vAll[first]) { proc.markedSmall = true; this.vAll[first].small = true; }
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
      if ((code !== 0 || signal) && proc.warm) {
        const why = this.exitReason(proc, code, signal);
        // A hardware tone-mapper that has not given a frame yet is the likelier cause: drop it, keep the warm process
        // (a new one with the next path), rather than turning the warm process off and failing again per seek.
        if (this.tonemapUnproven()) {
          this.log(`live transcode: ${this.tonemapKind} HDR tone-mapping failed in the kept-running decoder (${why}); trying the next tone-mapping path`);
          this.badTonemap.add(/** @type {string} */ (this.tonemapKind));
          this.disposeWarm('tone-mapping failed');
          this.restartVideo();
          return;
        }
        this.warmFailed(why);
        return;
      }
      if (code !== 0 || signal) {
        const why = this.exitReason(proc, code, signal);
        // Step 0a: a failed hardware tone-mapper (QSV, VA-API, libplacebo, OpenCL) drops to the next best path, for
        // every stream with this ffmpeg; only one that has not given a frame here (a later failure is not its fault).
        if (this.tonemapUnproven()) {
          this.log(`live transcode: ${this.tonemapKind} HDR tone-mapping failed (${why}); trying the next tone-mapping path`);
          this.badTonemap.add(/** @type {string} */ (this.tonemapKind));
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
        if ((this.pipelineMode === 'gpu-full' || this.gpuDecode) && this.decodeMethod !== 'none') {
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
      if (proc.directStream) {
        this.buf.splitMpegTs(true);
        if (!checkDirectStart()) return;
      } else this.buf.split(true);
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
    if (this.failed || this.disposed) return;
    this.failed = true;
    clearTimeout(this.startTimer);
    this.startTimer = null;
    this.kill();
    this.takeStandby(NaN);
    this.waiting = null;
    this.releaseGpu();
    this.disposeWarm();
    this.onFail(why);
  }

  encoderFallback(why) {
    const enc = this.encoder;
    this.log(`live transcode: ${enc} failed (${why}); retrying this stream with ${this.cpuEncoder}`);
    this.gpuFallback = null; // failed, not just busy: the CPU for good
    this.encoder = this.cpuEncoder;
    this.decodeMethod = 'none';
    this.device = undefined;
    this.releaseGpu();
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
  restartVideo(next = this.nextVideoTime()) {
    this.cancelOverlap();
    this.takeStandby(NaN);
    const proc = this.proc;
    this.proc = null;
    this.stopProcess(proc);
    this.videoFragment = null;
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
    const pcm = this.buf.hasAudio ? (this.audioEncoder ? OPUS_KBPS : PCM_KBPS) : 0;
    const timestamp = Date.now();
    const samples = this.link.bwSamples;
    const d = this.link.onSample(m, timestamp, pcm);
    if (!d) return;
    if (this.onLinkUpdate && !m.debugRate && (samples !== this.link.bwSamples || d.change === 'tier')) {
      this.onLinkUpdate({ fastKbps: d.fastKbps, slowKbps: d.slowKbps, tier: this.tier, upAfter: this.link.upAfter, timestamp });
    }
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
    this.notice('slow', `The connection is too slow for this video${this.pr.audio ? ' with its sound' : ''}, even at ${this.h}p. Playback may pause to load.`);
  }

  /** A notice in the webview, once per stream and kind. */
  notice(kind, text) {
    if (!this.link.firstNotice(kind)) return;
    this.post({ type: 'remoteNotice', kind, text });
  }

  launch(t, audio = false, opts = undefined) {
    if (!audio) this.holdGpu();
    const argv = this.args(t, audio, opts);
    const proc = lowerPriority(spawn(this.tools.ffmpeg, argv, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }));
    proc.t = t;
    proc.directStream = !audio && this.pipelineMode === 'direct-stream';
    proc.err = { text: '' };
    proc.on('error', (e) => { proc.err.text += String(e); });
    if (!proc.stdout || !proc.stderr) throw new Error('ffmpeg could not open its output pipes');
    proc.stderr.on('data', (d) => { proc.err.text = (proc.err.text + d).slice(-2000); });
    return proc;
  }

  prepareLoop() {
    if (this.standby || this.disposed || this.failed) return;
    const mode = this.pipelineMode;
    const tonemap = this.tonemapKind;
    let sb;
    try { sb = this.launch(0); }
    catch (e) { this.log(`live transcode: loop standby unavailable (${e.message})`); return; }
    finally {
      this.pipelineMode = mode;
      this.tonemapKind = tonemap;
    }
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
    // The quick picture goes on the link first (startQuick): the stream's frames wait for it, at most q.holdMs.
    const q = this.quick;
    if (q && q.gen === this.gen) {
      const left = q.holdMs - (Date.now() - q.t0);
      if (left > 0) {
        if (!q.timer) q.timer = setTimeout(() => { q.timer = null; this.answer(); }, left);
        return;
      }
      this.log(`remote stream: quick picture not ready after ${Math.round(q.holdMs)} ms; the stream goes first`);
      this.stopQuick();
    }
    if (this.restored) this.continueRegion();
    if (this.failed) return;
    const gen = this.gen;
    // A remote link keeps at most REMOTE_BATCH_BYTES in flight even at tier 0: the pipe is a FIFO, so a seek's reply
    // waits behind every old-generation byte already queued (4 Mb/s SSH: 384 KB x several batches = seconds).
    const limit = Math.min(m.limit || 384 * 1024, this.tier || this.remote ? REMOTE_BATCH_BYTES : Infinity);
    const first = this.vAll[this.vNext];
    const fragment = this.videoFragment;
    // Leave the boundary frame unsent until the replacement can supply it.
    const boundary = this.overlap ? this.overlap.spliceT - 0.5 / this.fps : Infinity;
    if (first?.t >= boundary) {
      this.overlapFallback('replacement missed the splice point');
      return;
    }
    let lastPiece;
    if (this.remote && first && first.data.byteLength > REMOTE_BATCH_BYTES) {
      // Pull one piece at a time so a seek only waits for the piece already on the FIFO.
      const offset = fragment?.packet === first ? fragment.offset : 0;
      const data = first.data.slice(offset, offset + REMOTE_BATCH_BYTES);
      const next = offset + data.byteLength;
      const done = next === first.data.byteLength;
      const piece = { video: [{ ...first, data }], fragment: { offset, total: first.data.byteLength } };
      if (!done) {
        this.videoFragment = { packet: first, offset: next };
        this.waiting = null;
        this.account(0, data.byteLength, []);
        this.post({ type: 'batch', gen, ...piece, audio: [], hostWaitMs: Date.now() - this.waitingSince });
        return;
      }
      lastPiece = piece;
    }
    this.videoFragment = null;
    const videoUntil = m.videoUntil ?? Infinity;
    // Even at the top tier, picture must not outrun the half second of Opus we can send per reply.
    const frameLimit = this.buf.hasAudio && (this.tier || this.audioEncoder) ? Math.max(1, Math.floor(this.fps / 2)) : Infinity;
    let end = this.vNext + (lastPiece ? 1 : 0);
    let bytes = lastPiece ? lastPiece.video[0].data.byteLength : 0;
    while (!lastPiece && end < this.vAll.length && this.vAll[end].t < boundary && end - this.vNext < frameLimit
      && (end === this.vNext || (this.vAll[end].t <= videoUntil && bytes + this.vAll[end].data.length <= limit))) bytes += this.vAll[end++].data.length;
    // A full keyframe's size at this picture size (fastFirstBits): the largest sent, as the ones right after a small
    // first keyframe (fast first picture) are still held down by the rate buffer; the small one does not count.
    const size = `${this.w}x${this.h}`;
    if (this.keyBytesFor !== size) { this.keyBytes = 0; this.keyBytesFor = size; }
    for (let i = this.vNext; i < end; i++) {
      if (this.vAll[i].key && !this.vAll[i].small) this.keyBytes = Math.max(this.keyBytes, this.vAll[i].data.byteLength);
    }
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
    const video = lastPiece ? lastPiece.video : this.vAll.slice(this.vNext, end);
    this.vNext = end;
    const audio = this.buf.takeAudio(aHi, canSendAudioTail);
    this.buf.trim();
    this.account(video.length, bytes, audio);
    if (this.proc && this.proc.stdout.isPaused() && this.vAll.length - this.vNext < (MAX_QUEUED_SECONDS * this.fps) / 2) this.proc.stdout.resume();
    if (this.audioProc && this.audioPaused && (this.aEnd - this.aNext) * 4 < MAX_QUEUED_AUDIO / 2) {
      this.audioPaused = false;
      this.audioProc.stdout.resume();
    }
    this.post({ type: 'batch', gen, video, ...(lastPiece ? { fragment: lastPiece.fragment } : {}), audio,
      videoEnd: this.videoEnded && this.vNext === this.vAll.length, hostWaitMs: Date.now() - this.waitingSince });
  }

  /** Whether ffmpeg is actively supplying playback data or starting a run. */
  busy() {
    return !!(this.proc || this.audioProc)
      && Date.now() - Math.max(this.sentAt || 0, (this.lastSpawnAt || 0) + 3000) < 1500;
  }

  account(n, bytes) {
    this.sentAt = Date.now();
    if (!this.stats) return;
    const now = this.sentAt;
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
    this.stopFill();
    this.stopSharp();
    this.stopQuick();
    // The page's test hook (media/debug-probe.js pausedSharp): false off, true on whatever the link estimate says.
    if (m.fastFirst !== undefined) this.fastFirstHook = !!m.fastFirst;
    // Same hook: true sends the quick picture whatever the encoder (instead of x264's small first keyframe), false never.
    if (m.quick !== undefined) this.quickHook = m.quick === null ? undefined : !!m.quick;
    // The page: whether this video sets the clock (Compare's clock tile, or a single video); tests turn it off.
    if (m.warm !== undefined) this.setWarmWanted(!!m.warm);
    this.videoFragment = null;
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
      const have = !startingHere && this.skipHeld(m.have);
      this.post({ type: 'seeked', gen: m.gen, t, ...(have ? { have: true } : {}) });
      return;
    }
    const from = this.vAll.length ? this.vAll[0].t : this.base;
    const start = stepBackStart(t, { from, base: this.base, hasPackets: this.vAll.length > 0, fps: this.fps, remote: this.remote });
    if (!interruptedOverlap && !this.resizePending && this.buf.configuration === this.cacheConfiguration()) {
      this.buf.archive(this.videoEnded, this.audioEnded);
    }
    this.sizeVideo();
    this.reset(start);
    this.seekStart = true;
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

  /**
   * After reuseHistory: the page offered the packets it holds of this GOP ({ keyT, lastT }, media/engine.js
   * packetsHeld). They are the ones this history sent it (same encode: the page drops packets of another stream
   * configuration), so the reply starts after them and the link does not carry the GOP again. True when skipped;
   * false (send from the keyframe as usual) unless the history's GOP is that one and holds every packet up to lastT.
   */
  skipHeld(have) {
    if (!have || !Number.isFinite(have.keyT) || !Number.isFinite(have.lastT)) return false;
    const eps = 1e-4;
    const k = this.vNext;
    const first = this.vAll[k];
    if (!first || !first.key || Math.abs(first.t - have.keyT) > eps) return false;
    let j = k + 1;
    while (j < this.vAll.length && !this.vAll[j].key && this.vAll[j].t <= have.lastT + eps) j++;
    if (Math.abs(this.vAll[j - 1].t - have.lastT) > eps) return false;
    this.vNext = j;
    // The sound it holds from the seek on (have.audioUntil): send from there, or from as far as this history has it
    // (the page cuts what it already holds: media/engine.js takeHeld).
    let sound = '';
    if (Number.isFinite(have.audioUntil) && this.buf.hasAudio) {
      const s = Math.round((have.audioUntil - this.base) * AUDIO_RATE);
      const to = Math.min(s, this.aEnd);
      if (to > this.aNext) { this.aNext = to; sound = ` and sound to ${(this.base + to / AUDIO_RATE).toFixed(3)} s`; }
    }
    this.log(`remote stream: the page holds ${j - k} packets (${have.keyT.toFixed(3)}-${have.lastT.toFixed(3)} s)${sound}; sending from the next`);
    return true;
  }

  /**
   * Paused: encode [from, to) behind the shown frame for the page's packet cache (media/engine.js fillBehind), so steps
   * back from a fresh jump decode on the page. A second, short encode with this stream's own pipeline (same size,
   * encoder and settings, so the page keeps both: media/packet-cache.js drops GOPs of another configuration) and the
   * paused keyframe spacing. The page pulls it a piece at a time (fillMore) while it has nothing else to ask; a seek,
   * play or hide stops it. Replies 'fillBatch' { id, video, done, error? }.
   */
  fill(m) {
    this.stopFill();
    const id = m.id;
    const fps = this.fps;
    const from = Math.max(0, Math.round(Number(m.from) * fps) / fps);
    const frames = Math.round((Number(m.to) - from) * fps);
    const no = (error) => this.post({ type: 'fillBatch', id, video: [], done: true, error });
    if (this.disposed || this.failed || this.hidden || !this.pr.video || !(fps > 0)) return no('unavailable');
    if (!(frames > 0)) return no('nothing to fill');
    // A copy of the source's own GOPs (B-frames, sparse keyframes) is not kept by the page: nothing to gain.
    if (this.pipelineMode === 'direct-stream' || this.useDirectStream()) return no('direct stream');
    if (fillsRunning >= MAX_FILLS) return no('busy');
    const token = isGpuEncoder(this.encoder) ? this.gpu.acquireShort('fill') : null;
    if (isGpuEncoder(this.encoder) && !token) return no('busy'); // every GPU encoder session is in use
    // args() records the pipeline it builds on this stream: the fill must not change what the live stream reports.
    const keep = [this.pipelineMode, this.tonemapKind, this.gpuDecode, this.playing];
    let argv;
    try { this.playing = false; argv = this.args(from, false); }
    finally { [this.pipelineMode, this.tonemapKind, this.gpuDecode, this.playing] = keep; }
    argv.splice(argv.length - 1, 0, '-frames:v', String(frames));
    let proc;
    try {
      proc = this.spawnJob(argv);
    } catch (e) { this.gpu.release(token); return no(String(e && e.message || e)); }
    fillsRunning++;
    const buf = new SeekHistoryBuffer({ fps, hasAudio: false, remote: this.remote });
    buf.reset(from);
    const f = { id, proc, buf, sent: 0, ended: false, waiting: false, failed: '', t0: Date.now(), from, frames, bytes: 0 };
    this.filling = f;
    let err = '';
    proc.on('error', (e) => { err += String(e); });
    proc.stderr.on('data', (d) => { err = (err + d).slice(-500); });
    proc.stdout.on('data', (d) => {
      buf.pending = buf.pending.length ? Buffer.concat([buf.pending, d]) : d;
      buf.split(false);
      if (f.waiting && this.filling === f) this.fillMore({ id });
    });
    proc.on('close', (code) => {
      fillsRunning = Math.max(0, fillsRunning - 1);
      this.gpu.release(token);
      buf.split(true);
      f.ended = true;
      if (code !== 0 && !buf.vAll.length) f.failed = err.trim().split(/\r?\n/).pop() || `ffmpeg exit ${code}`;
      if (this.filling === f && f.waiting) this.fillMore({ id });
    });
    this.log(`remote stream: filling ${from.toFixed(3)}-${(from + frames / fps).toFixed(3)} s behind the paused frame (${frames} frames)`);
    f.waiting = true; // the first piece goes out as soon as there is one
  }

  /** The page asks for the next piece of the fill (see fill). */
  fillMore(m) {
    const f = this.filling;
    if (!f || f.id !== m.id) return;
    const vAll = f.buf.vAll;
    let end = f.sent;
    let bytes = 0;
    while (end < vAll.length && (end === f.sent || bytes + vAll[end].data.byteLength <= FILL_PIECE_BYTES)) bytes += vAll[end++].data.byteLength;
    if (end === f.sent) {
      if (!f.ended) { f.waiting = true; return; }
      this.filling = null;
      if (f.failed) this.log(`remote stream: fill failed (${f.failed})`);
      this.post({ type: 'fillBatch', id: f.id, video: [], done: true, ...(f.failed ? { error: f.failed } : {}) });
      return;
    }
    f.waiting = false;
    const video = vAll.slice(f.sent, end);
    f.sent = end;
    f.bytes += bytes;
    const done = f.ended && end === vAll.length;
    if (done) {
      this.filling = null;
      this.log(`remote stream: filled ${f.sent} frames behind the paused frame, ${(f.bytes / 1024).toFixed(0)} KiB in ${Date.now() - f.t0} ms`);
    }
    this.post({ type: 'fillBatch', id: f.id, video, done });
  }

  stopFill() {
    const f = this.filling;
    if (!f) return;
    this.filling = null;
    if (!f.ended) this.stopProcess(f.proc);
  }

  /** A short ffmpeg job beside the live stream (a fill, a sharp frame); tests replace it. @param {string[]} argv */
  spawnJob(argv) {
    return lowerPriority(spawn(this.tools.ffmpeg, argv, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }));
  }

  /**
   * Paused, the page stayed on frame t for a moment (media/engine.js scheduleSharp): encode that one frame visually
   * lossless (transcode_args.js sharpArgs) as one IDR, at the stream's size, with its pipeline and tone-mapping (the
   * same frame grid: -ss t, constant rate), and send it in pieces the page pulls (sharpMore). The page decodes it with a
   * decoder of its own and shows it only if it is still paused on that frame; it never enters a cache. A seek, play or
   * hide stops it (its ffmpeg is killed). Replies 'sharpFrame' { id, t, data, done, total?, error? }.
   */
  sharp(m) {
    this.stopSharp();
    const id = m.id;
    const fps = this.fps;
    const no = (error) => this.post({ type: 'sharpFrame', id, done: true, error });
    if (this.disposed || this.failed || this.hidden || !this.pr || !this.pr.video || !(fps > 0)) return no('unavailable');
    if (this.playing) return no('playing');
    // A copy of the source's own H.264 is already its own pictures: nothing to sharpen.
    if (this.pipelineMode === 'direct-stream' || this.useDirectStream()) return no('direct stream');
    const t = Math.max(0, Math.floor(Number(m.t) * fps + 1e-6)) / fps;
    const gpu = isGpuEncoder(this.encoder);
    const token = gpu ? this.gpu.acquireShort('sharp') : null;
    if (gpu && !token) return no('busy'); // every GPU encoder session is in use: the soft picture stays
    // args() records the pipeline it builds on this stream: the sharp frame must not change what the live stream reports.
    const keep = [this.pipelineMode, this.tonemapKind, this.gpuDecode];
    let argv;
    try { argv = this.args(t, false, { sharp: true }); } catch (e) { this.gpu.release(token); return no(String(e && e.message || e)); }
    finally { [this.pipelineMode, this.tonemapKind, this.gpuDecode] = keep; }
    argv.splice(argv.length - 1, 0, '-frames:v', '1');
    let proc;
    try { proc = this.spawnJob(argv); } catch (e) { this.gpu.release(token); return no(String(e && e.message || e)); }
    const s = { id, t, proc, chunks: [], data: null, sent: 0, waiting: true, ended: false, failed: '', t0: Date.now(), token };
    this.sharping = s;
    let err = '';
    proc.on('error', (e) => { err += String(e); });
    if (proc.stderr) proc.stderr.on('data', (d) => { err = (err + d).slice(-500); });
    proc.stdout.on('data', (d) => { s.chunks.push(d); });
    proc.on('close', (code) => {
      this.gpu.release(token);
      s.ended = true;
      s.data = Buffer.concat(s.chunks);
      s.chunks = [];
      if (code !== 0 || !s.data.length) s.failed = err.trim().split(/\r?\n/).pop() || `ffmpeg exit ${code}`;
      if (this.sharping !== s) return;
      if (!s.failed) this.log(`remote stream: sharp frame at ${t.toFixed(3)} s, ${(s.data.length / 1024).toFixed(0)} KiB in ${Date.now() - s.t0} ms`);
      if (s.waiting) this.sharpMore({ id });
    });
  }

  /** The page asks for the next piece of the sharp frame (see sharp). */
  sharpMore(m) {
    const s = this.sharping;
    if (!s || s.id !== m.id) return;
    if (!s.ended) { s.waiting = true; return; }
    s.waiting = false;
    if (s.failed) {
      this.sharping = null;
      this.log(`remote stream: sharp frame failed (${s.failed})`);
      this.post({ type: 'sharpFrame', id: s.id, done: true, error: s.failed });
      return;
    }
    const total = s.data.length;
    // Its own ArrayBuffer: a view on a larger one crosses to the webview as the whole buffer (as stream-buffer.js copies).
    const end = Math.min(total, s.sent + SHARP_PIECE_BYTES);
    const data = new Uint8Array(s.data.buffer.slice(s.data.byteOffset + s.sent, s.data.byteOffset + end));
    s.sent = end;
    const done = s.sent >= total;
    if (done) this.sharping = null;
    this.post({ type: 'sharpFrame', id: s.id, t: s.t, data, offset: s.sent - data.length, total, done });
  }

  stopSharp() {
    const s = this.sharping;
    if (!s) return;
    this.sharping = null;
    if (!s.ended) this.stopProcess(s.proc);
  }

  /**
   * Quick first picture: a paused start on a slow link whose first keyframe stays full size (fastFirstBits is x264 only;
   * NVENC and the other GPU encoders ignore the rate buffer's start, and the kept-running decoder's encoder is already
   * running) also encodes the target frame alone, at half the width and height with the stream's encoder, pipeline and
   * tone-mapping, as one IDR. It goes to the page before the stream's own frames (answer holds them at most 3/4 of a
   * full keyframe's time on the link, QUICK_HOLD_SHARE); the page decodes it with the sharp frame's decoder, draws it
   * scaled up while that seek has shown nothing yet, and keeps it nowhere. A GPU encoder holds one of the host's GPU encoder sessions for it (none free: no
   * quick picture). A seek, hide or dispose stops it. Posts 'quickFrame' { gen, t, w, h, data } (w x h: the stream's size).
   * @param {number} t
   */
  startQuick(t) {
    this.stopQuick();
    if (!this.remote || !this.w || !this.h) return;
    const gpu = isGpuEncoder(this.encoder);
    const token = gpu ? this.gpu.acquireShort('quick') : null;
    if (gpu && !token) { this.log('remote stream: no quick picture: every GPU encoder session is in use'); return; }
    // args() records the pipeline it builds on this stream: the quick picture must not change what the live stream reports.
    const keep = [this.pipelineMode, this.tonemapKind, this.gpuDecode];
    let argv;
    try { argv = this.args(t, false, { quick: true }); } catch { this.gpu.release(token); return; }
    finally { [this.pipelineMode, this.tonemapKind, this.gpuDecode] = keep; }
    argv.splice(argv.length - 1, 0, '-frames:v', '1');
    let proc;
    try { proc = this.spawnJob(argv); } catch { this.gpu.release(token); return; }
    const { ms } = this.fullKeyOnLink();
    const forced = this.quickHook === true || this.fastFirstHook === true; // tests: whatever the estimate says
    const holdMs = forced ? QUICK_HOLD_MAX_MS : Math.max(QUICK_HOLD_MIN_MS, Math.min(QUICK_HOLD_MAX_MS, ms * QUICK_HOLD_SHARE));
    const q = { gen: this.gen, t, proc, chunks: [], t0: Date.now(), ended: false, timer: null, holdMs };
    this.quick = q;
    let err = '';
    proc.on('error', (e) => { err += String(e); });
    if (proc.stderr) proc.stderr.on('data', (d) => { err = (err + d).slice(-500); });
    proc.stdout.on('data', (d) => { q.chunks.push(d); });
    proc.on('close', (code) => {
      this.gpu.release(token);
      q.ended = true;
      if (this.quick !== q) return;
      this.stopQuick();
      const data = Buffer.concat(q.chunks);
      q.chunks = [];
      if (code !== 0 || !data.length) {
        this.log(`remote stream: no quick picture (${err.trim().split(/\r?\n/).pop() || `ffmpeg exit ${code}`})`);
      } else {
        this.log(`remote stream: quick picture at ${t.toFixed(3)} s, ${quickSize(this.w)}x${quickSize(this.h)}, `
          + `${(data.length / 1024).toFixed(0)} KiB in ${Date.now() - q.t0} ms`);
        // Its own ArrayBuffer: a view on a larger one crosses to the webview as the whole buffer.
        this.post({ type: 'quickFrame', gen: q.gen, t, w: this.w, h: this.h,
          data: new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.length)) });
      }
      this.answer();
    });
  }

  stopQuick() {
    const q = this.quick;
    if (!q) return;
    this.quick = null;
    if (q.timer) clearTimeout(q.timer);
    if (!q.ended) this.stopProcess(q.proc);
  }

  /**
   * Why this stream does not use the kept-running decoder now ('' when it may). The lasting reasons also stop one that
   * is idle (its GPU session goes back); 'playing' only skips it for this start.
   */
  warmRefusal() {
    if (!this.warmWanted) return 'not the clock';
    if (this.warmOff) return this.warmOff;
    if (this.disposed || this.failed || this.hidden) return 'stopped';
    if (!this.tools || !this.tools.ffmpeg || this.tools.legacy) return 'this ffmpeg';
    if (!WARM_ENCODERS.includes(this.encoder)) return `encoder ${this.encoder}`;
    if (this.pipelineMode === 'direct-stream' || this.useDirectStream()) return 'direct stream';
    return warmSourceRefusal(this.pr);
  }

  /**
   * A paused start from the kept-running decoder (src/warm-decoder.js): no ffmpeg start-up (probe, open, hardware init)
   * per jump. Made on the first paused start, one per stream, holding a GPU encoder session of its own (none free: null,
   * and the stream starts ffmpeg as before). A seek while playing starts ffmpeg as before (its 2 s keyframe spacing).
   * @param {number} t @returns {any} a proc-like segment, or null
   */
  warmSegment(t) {
    const why = this.warmRefusal();
    if (why) { this.disposeWarm(); return null; }
    if (this.playing) return null;
    // args() records the pipeline it builds: the warm process is this stream's video encoder from here on.
    const argv = this.args(0, false, { warm: true });
    const key = argv.join('\u0001');
    if (this.warm && (this.warm.key !== key || !this.warm.usable)) this.disposeWarm();
    // No encoder of the stream's own runs here (spawnVideo): the warm process's session covers this stream's encode.
    this.releaseGpu();
    for (let tries = 0; tries < 2; tries++) {
      if (!this.warm && !this.startWarm(argv, key)) return null;
      const seg = this.warm.segment(t);
      if (seg) return seg;
      this.disposeWarm('its clock is used up'); // a new process
    }
    return null;
  }

  /** @param {string[]} argv @param {string} key @returns {boolean} */
  startWarm(argv, key) {
    const gpu = isGpuEncoder(this.encoder);
    const token = gpu ? this.gpu.acquire('warm') : null;
    if (gpu && !token) {
      this.log(`live transcode: no GPU encoder session free for a kept-running decoder (${JSON.stringify(this.gpu.counts())}); ffmpeg starts per seek`);
      return false;
    }
    const v = this.pr.video;
    /** @type {any} */
    let w = null;
    try {
      w = new WarmDecoder({
        ffmpeg: this.tools.ffmpeg, argv, key, file: this.file, streamIndex: v.index, fps: this.fps, fileStart: v.fileStart,
        duration: this.pr.duration, codec: v.codec, spawn: (cmd, a) => this.spawnWarm(cmd, a),
        release: () => this.gpu.release(token),
        onEnd: (why) => {
          if (this.warm === w) this.warm = null;
          this.log(`live transcode: kept-running decoder ended (${why})`);
        },
      });
    } catch (e) {
      this.gpu.release(token);
      this.log(`live transcode: kept-running decoder unavailable (${e && /** @type {any} */ (e).message || e})`);
      return false;
    }
    if (w.dead) return false;
    this.warm = w;
    this.log(`live transcode: kept-running decoder started (${this.videoEncoder}, ${this.pipelineMode}${this.gpuDecode ? ', GPU decode' : ''}); it ends after 60 s unused`);
    return true;
  }

  /** The warm process and its remuxes (stdin piped); tests replace it. @param {string} cmd @param {string[]} argv */
  spawnWarm(cmd, argv) {
    return lowerPriority(spawn(cmd, argv, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }));
  }

  /** Stops the kept-running decoder (its GPU session goes back). @param {string} [why] */
  disposeWarm(why = 'stopped') {
    const w = this.warm;
    this.warm = null;
    if (w) w.dispose(why);
  }

  /** The page says whether this video sets the clock (Compare: only that tile keeps a warm decoder). @param {boolean} on */
  setWarmWanted(on) {
    if (on === this.warmWanted) return;
    this.warmWanted = on;
    // One serving the current read stays until the next start; an idle one gives its session back now.
    if (!on && this.warm && !(this.proc && this.proc.warm)) this.disposeWarm('not the clock tile');
  }

  /**
   * The kept-running decoder failed (a frame out of sequence, no IDR at the target, the process or a remux exited):
   * this stream starts ffmpeg per seek from now on, from the first frame not sent yet.
   * @param {string} why
   */
  warmFailed(why) {
    this.log(`live transcode: kept-running decoder failed (${why}); ffmpeg starts per seek for this video`);
    this.warmOff = 'failed';
    this.disposeWarm('failed');
    this.restartVideo();
  }

  /** An HDR stream on a hardware tone-mapper that has not given a frame and has not failed before. */
  tonemapUnproven() {
    const k = this.tonemapKind;
    return !!(this.hdr && k && k !== 'cpu' && !this.badTonemap.has(k) && this.tonemapOk !== k);
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
      this.audioEnded = !this.buf.hasAudio || region.audioEnded;
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
      if (!this.spawnVideo()) return;
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
    this.stopFill();
    this.stopSharp();
    this.stopQuick();
    this.disposed = true;
    this.videoFragment = null;
    clearTimeout(this.startTimer);
    this.startTimer = null;
    this.kill();
    this.takeStandby(NaN);
    this.releaseGpu();
    this.disposeWarm();
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
  PAUSED_GOP_S,
  PLAY_GOP_S,
  FAST_FIRST_SHARE,
  FAST_FIRST_SKIP_MS,
  stepBackStart,
  audioEncoderFor,
  opusArgs,
};
