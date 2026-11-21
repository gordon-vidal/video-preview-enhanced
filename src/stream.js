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
const { OggOpus } = require('./remoteopus');
const {
  CPU_ENCODERS,
  buildVideoPipeline,
  defaultCodecLevel,
  pipelineLabel,
} = require('./transcode_args');
const { encoderCacheKey } = require('./transcode_probe');
const { effectiveMaxKbps } = require('./transcode_policy');

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
// Packets kept for seeks back without a restart: HISTORY_S behind the last one sent, and from
// SEEK_KEEP_S before the last seek target, but never more than HISTORY_MAX_S behind the last sent.
const HISTORY_S = 5;
const SEEK_KEEP_S = 1.5;
const HISTORY_MAX_S = 20;
// Sound sent at most this far past the picture sent.
const AUDIO_LEAD_S = 2;
const MAX_QUEUED_AUDIO = 4 * AUDIO_RATE * 4; // four seconds of unsent stereo s16le
const MAX_AUDIO_BATCH = 256 * 1024;
// Capped slow-link tiers (used when allowLinkAdapt is enabled on remote links).
const LINK_TIERS = [null, { height: 720, kbps: 3000 }, { height: 480, kbps: 1200 }, { height: 360, kbps: 450 }];
// Opus budget includes the 80 ms seek preroll repeated in each half-second batch.
const PCM_KBPS = AUDIO_RATE * 4 * 8 / 1000;
const OPUS_KBPS = 128;
const audioEncoders = new Map();

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

// Link samples (2 s windows from the webview) are ignored until this long after ffmpeg's first
// output following a start, restart or seek, so its start-up stall is not taken for a slow link.
const LINK_SETTLE_MS = 2500;
// A window counts as link-limited only when the host waited for ffmpeg less than this share of the read time.
const ENCODER_WAIT_SHARE = 0.5;

class EncodedStream {
  constructor({
    tools, file, post, log, maxHeight, probed, onFail, stats, encoder, device,
    cpuEncoder: cpu, decodeMethod = 'none', onEncoderFail, audioEncoder = null,
    fitView = true, maxKbps = 0, maxBitrateMbps = 0, allowLinkAdapt = true, remote = true,
    allowSoftwareFallback = true,
  }) {
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
    this.cpuEncoder = CPU_ENCODERS.includes(cpu) ? cpu : (cpu === null ? null : 'libx264');
    this.encoder = encoder || process.env.VPE_RS_ENCODER || this.cpuEncoder;
    this.device = device;
    this.decodeMethod = decodeMethod || 'none';
    this.maxBitrateMbps = Number(maxBitrateMbps) > 0 ? Number(maxBitrateMbps) : (Number(maxKbps) > 0 ? Number(maxKbps) / 1000 : 0);
    this.allowLinkAdapt = allowLinkAdapt !== false;
    this.remote = !!remote;
    this.allowSoftwareFallback = allowSoftwareFallback !== false;
    this.pipelineMode = CPU_ENCODERS.includes(this.encoder) ? 'cpu' : 'gpu-encode';
    this.hidden = false;
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

  // Keep a working hardware encoder across capped quality tiers (encoderArgs applies VBV maxrate/bufsize).
  get videoEncoder() { return this.encoder; }

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
    this.takeStandby(NaN);
    this.log(`live transcode: max bitrate ${next > 0 ? `${next} Mb/s` : 'auto'}`);
    // Only restart an actively running video pipeline; deferred seeks and hidden tabs pick up the new cap on spawn.
    if (this.fps && !this.disposed && !this.hidden && !this.startTimer && this.proc) this.restartVideo();
  }

  /** Live-update the max bitrate cap in kb/s (0 = Auto). */
  setMaxKbps(kbps) {
    const n = Number(kbps) > 0 ? Number(kbps) / 1000 : 0;
    this.setMaxBitrateMbps(n);
  }

  /** Current pipeline metadata for ⓘ (About this video) and stats. */
  transcodeInfo() {
    const cap = this.activeCapKbps();
    return {
      encoder: this.videoEncoder,
      mode: this.pipelineMode,
      remote: this.remote,
      maxKbps: cap,
      label: pipelineLabel({
        encoder: this.videoEncoder,
        mode: this.pipelineMode,
        remote: this.remote,
        w: this.w,
        h: this.h,
        fps: this.fps,
        maxKbps: cap,
      }),
    };
  }

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
   * The tab was hidden: the ffmpeg processes (encoder and sound) and the standby stop, and
   * what was read goes. Showing the tab re-seeks the page (media/engine.js setHidden).
   */
  setHidden(on) {
    this.hidden = !!on;
    if (!on || !this.fps) return;
    const had = !!this.proc || !!this.audioProc || !!this.standby || !!this.startTimer;
    clearTimeout(this.startTimer);
    this.startTimer = null;
    this.deferredSince = null;
    this.takeStandby(NaN);
    this.reset(this.base);
    if (had) this.log('live transcode: tab hidden, ffmpeg stopped until it is shown');
  }

  open() {
    const v = this.pr.video;
    this.sizeVideo();
    this.fps = v.fps || 30;
    this.startAt(0);
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
    if (grow) this.post({ type: 'refresh' });
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
    const cap = this.activeCapKbps();
    const pipe = audio ? { pre: [], vf: '', encArgs: [], mode: 'cpu' } : buildVideoPipeline({
      encoder: this.videoEncoder,
      device: this.device,
      decodeMethod: this.tier ? 'none' : this.decodeMethod,
      gpuFilters: this.tools && this.tools.gpuFilters ? this.tools.gpuFilters : null,
      video: v,
      w: this.w,
      h: this.h,
      fps: this.fps,
      maxKbps: cap,
    });
    if (!audio) this.pipelineMode = pipe.mode;
    const args = ['-hide_banner', '-nostdin', '-v', 'error', ...pipe.pre];
    if (t > 0) args.push('-ss', Math.max(0, t - 0.0005).toFixed(4));
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
    this.base = t;
    this.vBase = t;
    this.frameIndex = 0; // video packets read from this stream
    this.vAll = []; // packets read: history already sent, and packets not sent yet
    this.vNext = 0; // index in vAll of the next packet to send
    this.aStore = []; // sound read
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
    this.log(`live transcode: Opus failed (${why}); using s16 PCM`);
    this.audioEncoder = null;
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
        this.log(`live transcode: first bytes ${Date.now() - t0} ms after start${proc.adopted ? ' (prepared at the end)' : ''}`);
        this.settleAt = Date.now() + LINK_SETTLE_MS;
        if (this.spawns > 1) this.post({ type: 'transcodeInfo', transcode: this.transcodeInfo() });
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
      this.split(true);
      this.videoEnded = true;
      if (this.audioEnded) this.prepareLoop();
      this.answer();
    });
    const cap = this.activeCapKbps();
    this.log(`remote stream from ${t.toFixed(3)} s: ${this.pr.video.codec} ${this.pr.video.pixFmt} ${this.pr.video.width}x${this.pr.video.height} -> H.264 ${this.w}x${this.h} (${this.videoEncoder}, ${this.pipelineMode}${cap ? `, ${cap} kb/s cap` : ''})`);
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

  /** Restart at the first unsent frame. The in-band IDR changes size without disturbing audio. */
  restartVideo() {
    this.takeStandby(NaN);
    const proc = this.proc;
    this.proc = null;
    if (proc) { proc.stdout.destroy(); proc.kill('SIGKILL'); }
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
   * The quality ladder, from the webview's 2 s link samples (media/engine.js sampleRemoteLink).
   * Only active when allowLinkAdapt is true (remote links).
   */
  adapt(m) {
    if (!this.allowLinkAdapt) return;
    if (m.gen !== this.gen || (!this.proc && this.vNext === this.vAll.length)) return;
    const now = Date.now();
    if (now - this.lastLinkSample > 3500) this.linkRun = 0;
    this.lastLinkSample = now;
    if (now < this.settleAt) return; // ffmpeg start-up is in this window
    if (!this.tier && m.videoKbps > 0) {
      this.topKbps = this.topKbps ? 0.75 * this.topKbps + 0.25 * m.videoKbps : m.videoKbps;
      this.topPeak = Math.max(m.videoKbps, 0.9 * this.topPeak);
    }
    const nextCap = LINK_TIERS[this.tier - 1]?.kbps ?? Math.max(3000, this.topKbps, this.topPeak);
    const pcm = this.pr.audio ? (this.audioEncoder ? OPUS_KBPS : PCM_KBPS) : 0;
    const readMs = m.readMs ?? 0;
    const linkLimited = !(readMs > 0) || (m.hostWaitMs || 0) < ENCODER_WAIT_SHARE * readMs;
    const down = linkLimited && m.starved && (m.mediaRate < 0.95 || m.behind);
    const up = this.tier > 0 && m.buffer >= 0.25 && !m.starved && !m.behind && m.kbps > 1.3 * (nextCap + pcm);
    const step = down ? 1 : up ? -1 : 0;
    const detail = `${Math.round(m.kbps)} kb/s delivered, ${m.buffer.toFixed(2)} s buffered${m.hostWaitMs ? `, ${Math.round(m.hostWaitMs)} of ${Math.round(readMs)} ms waiting for ffmpeg` : ''}`;
    if (this.stats && (this.tier || m.starved)) this.log(`live transcode link: ${detail}, video ${m.mediaRate.toFixed(2)}x, starved=${m.starved}, behind=${m.behind}, link-limited=${linkLimited}, next profile ${Math.round(nextCap + pcm)} kb/s`);
    const run_ = this.linkRun;
    this.linkRun = step && (Math.sign(run_) === step ? run_ + step : step);
    if (this.linkRun < 2 && this.linkRun > -4) return;
    this.linkRun = 0;
    const last = LINK_TIERS.length - 1;
    if (down && this.tier === last) { this.slowLink(detail); return; }
    let tier = this.tier + step;
    if (down) while (tier < last && LINK_TIERS[tier].kbps + pcm > m.kbps) tier++;
    this.tier = tier;
    this.sizeVideo();
    this.log(`remote stream: quality ${down ? 'down' : 'up'} to ${this.h}p (${detail})`);
    if (down && tier === last && LINK_TIERS[last].kbps + pcm > m.kbps) this.slowLink(detail);
    else if (down) this.notice('quality', `Slow connection: live transcode lowered the picture to ${this.h}p to keep playing. It goes back up when the connection allows.`);
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

  prepareLoop() {
    if (this.standby || this.disposed) return;
    const sb = this.launch(0);
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
    let key = false;
    for (let i = data.indexOf(AUD.subarray(0, 3)); i >= 0 && i + 3 < data.length; i = data.indexOf(AUD.subarray(0, 3), i + 3)) {
      if ((data[i + 3] & 0x1f) === 5) { key = true; break; }
    }
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

  answer() {
    const m = this.waiting;
    if (!m) return;
    const gen = this.gen;
    const limit = Math.min(m.limit || 384 * 1024, this.tier ? 128 * 1024 : Infinity);
    const videoUntil = m.videoUntil ?? Infinity;
    const frameLimit = this.tier && this.pr.audio ? Math.max(1, Math.floor(this.fps / 2)) : Infinity;
    let end = this.vNext;
    let bytes = 0;
    while (end < this.vAll.length && end - this.vNext < frameLimit
      && (end === this.vNext || (this.vAll[end].t <= videoUntil && bytes + this.vAll[end].data.length <= limit))) bytes += this.vAll[end++].data.length;
    const vT = end > 0 ? this.vAll[end - 1].t + 1 / this.fps : this.base;
    const tail = this.videoEnded && this.vNext === this.vAll.length;
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
    this.post({ type: 'batch', gen, video, audio, videoEnd: this.videoEnded && this.vNext === this.vAll.length, hostWaitMs: Date.now() - this.waitingSince });
  }

  takeAudio(hi) {
    const from = this.aNext;
    const n = hi - from;
    if (n < 1) return [];
    if (this.audioEncoder) {
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
    if (this.pr.audio && s < have) return false;
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
      if (proc.exitCode === null && !proc.signalCode) proc.kill('SIGKILL');
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

module.exports = {
  EncodedStream,
  LINK_TIERS,
  PCM_KBPS,
  OPUS_KBPS,
  LINK_SETTLE_MS,
  audioEncoderFor,
  opusArgs,
};
