/* global VpeCodecUtils, VpeDecoderBoot, ThumbService, FrameStream, VpeHdr, VpeBlockCache, VpeGlRenderer, VpePacketCache */
// @ts-check
// Decode-only playback engine for the webview. Demuxing and software decoding
// run in decoder-worker.js (libav.js / WebAssembly); H.264 and VP8 go to the
// browser's hardware decoder (WebCodecs). Frames are drawn with WebGL, sound is
// played with WebAudio, which is also the clock. Nothing is ever re-encoded.
'use strict';
/** @import { ThumbRequest } from '../tools/page-work-contract.js' */

/* exported createEngine, matrixBySize */
const { GLRenderer, matrixBySize } = VpeGlRenderer;
const { taggedMatrix, h264Config, hdrLabel, toWebAudio, AUDIO_CODECS, speedText,
  measureRate, snapRate, nv12ToI420 } = VpeCodecUtils;
const { memFor, pictureArea, startupTimeline, mark } = VpeDecoderBoot;

// eslint-disable-next-line no-unused-vars
function createEngine(env) {
  const { vscode, canvas, log, showMessage, getState, setMuteUi, toast } = env;
  /** Start-up timeline (epoch ms, first time only), logged with the first frame when debugging. */
  const mark = (k) => { const m = self.vpeMarks || (self.vpeMarks = {}); if (!(k in m)) m[k] = Math.round(performance.timeOrigin + performance.now()); };
  /** The page's start-up: navigation, script and libav.js loads (epoch ms), and the marks above. */
  const startupTimeline = () => {
    const o = performance.timeOrigin;
    const at = (x) => (x > 0 ? Math.round(o + x) : undefined);
    const nav = /** @type {any} */ (performance.getEntriesByType('navigation')[0]) || {};
    const res = /** @type {any[]} */ (performance.getEntriesByType('resource'));
    const scripts = res.filter((r) => /\.js(\?|$)/.test(r.name) && !/libav/.test(r.name));
    const lib = res.filter((r) => /libav|decoder-worker/.test(r.name)).map((r) => ({ f: r.name.replace(/^.*\//, ''), start: at(r.startTime), end: at(r.responseEnd), kb: Math.round((r.transferSize || r.encodedBodySize || 0) / 1024) }));
    return {
      origin: Math.round(o), domInteractive: at(nav.domInteractive), domLoaded: at(nav.domContentLoadedEventEnd),
      scriptsEnd: scripts.length ? at(Math.max(...scripts.map((r) => r.responseEnd))) : undefined,
      ...(self.vpeMarks || {}), lib,
    };
  };
  const { bootDecoder, preload, takePreload, dropPreload } = VpeDecoderBoot.create(env);
  // Live transcode, paused: the host fills in this much video behind the shown frame (fillBehind), looked at no more
  // than every FILL_CHECK_MS (also during a fast wheel scroll back), when less than FILL_AHEAD_S behind it is held.
  // Steps back then decode on the page.
  const FILL_SPAN_S = 2;
  const FILL_AHEAD_S = 1.5;
  const FILL_CHECK_MS = 250;
  // Live transcode, paused: once a frame has stayed shown this long, the host sends it visually lossless (requestSharp).
  // Steps and scrolls faster than this ask for nothing.
  const SHARP_WAIT_MS = 150;
  const PER_PX_WASM = 3.5e-6; // ms per pixel, cheap decode in the thumbnail worker: measured 1.6e-6 (1080p H.264) to 3.3e-6 (4K HEVC)
  /**
   * Tests (debug only): the luma of the top-left 320x180 of a sharp frame (test clips move there), at full size, for
   * test/vscode to compare with the source's frames (which frame it is). BT.709 limited range, as ffmpeg's gray output.
   */
  const sharpThumb = (vf, t) => {
    try {
      const w = Math.min(320, vf.displayWidth);
      const h = Math.min(180, vf.displayHeight);
      const cv = new OffscreenCanvas(w, h);
      const cx = cv.getContext('2d', { willReadFrequently: true });
      const sx = 0;
      const sy = 0;
      cx.drawImage(vf, sx, sy, w, h, 0, 0, w, h);
      const px = cx.getImageData(0, 0, w, h).data;
      const y = new Uint8Array(w * h);
      for (let i = 0; i < y.length; i++) {
        y[i] = Math.round(16 + (0.2126 * px[i * 4] + 0.7152 * px[i * 4 + 1] + 0.0722 * px[i * 4 + 2]) * 219 / 255);
      }
      let bin = '';
      for (let i = 0; i < y.length; i++) bin += String.fromCharCode(y[i]);
      return { t, w, h, x: sx, y: sy, size: [vf.displayWidth, vf.displayHeight], luma: btoa(bin) };
    } catch (e) { return { t, error: String(e && e.message || e) }; }
  };
  const SPEED_WARMUP_MS = 1500; // decode speed samples (sampleSpeed): ignore the start
  const SPEED_SAMPLE_MS = 3000;
  const FAST_CODECS = new Set(['hevc', 'h264']); // decoders that honour skip_loop_filter (fast preview)
  // Reading and decoding (decoder-worker.js 'more', 'seek', the pool's 'segment'): an error there is asked again on the
  // next tick; this many in a row at one spot stop playback there instead (a frozen picture that re-asks for ever).
  const DECODE_STEPS = new Set(['more', 'seek', 'segment']);
  const DECODE_TRIES = 3;
  const SETUP_NOTICE_RATIO = 0.5; // below this decode speed (x real time), prioritize the ffmpeg setup notice
  const onTracks = env.onTracks || (() => {}); // (player) when the track list or a selection changes
  // Live transcode: whether this video sets the clock (a single video, Compare's clock tile): only it keeps a decoder
  // running on the host between seeks (src/warm-decoder.js), sent with each seek.
  const isClock = env.isClock || (() => true);
  // (player, {natural, ran}) once playback paused at the end of the file with loop off (media/autoplay.js decides what next).
  const onEnded = env.onEnded || (() => {});
  // Something arrived or changed outside the page's input events (a worker or host message, a decoder
  // output, a seek from code): the page's frame loop runs again if it was resting (Player.settled).
  const wake = env.wake || (() => {});

  /** Sound that stopped coming hands the clock to the timer after this long (audioMaster). */
  const AUDIO_DRY_MS = 500;
  /** Decode speed is measured over this many ms of frame arrivals. */
  const RATE_WINDOW = 4000;
  /** WebCodecs frames kept open while paused (hardware decoders stall when all their surfaces are held). */
  const GPU_FRAMES = 6;
  /** Paused read-ahead (s) for decoders much faster than real time (native ffmpeg, WebCodecs); the built-in decoder fills its budget. */
  const PAUSED_AHEAD_S = 1.0;
  const REMOTE_AHEAD_S = 3.25;
  /**
   * Paused steps that need a seek while the previous step's seek is still decoding start at most this often (ms):
   * a quick turn of the wheel was one seek per notch (each a new ffmpeg process with native decoding).
   */
  const STEP_SEEK_MS = 80;
  /**
   * Remote Live transcode: a step seek waits for the wheel to rest this long (each notch restarts the wait, up to
   * REMOTE_STEP_MAX_MS after the first): every seek sends the GOP before its target over the link again, and at a
   * few Mbit/s that takes longer than STEP_SEEK_MS, so quick notches queued GOP after GOP.
   */
  const REMOTE_STEP_QUIET_MS = 200;
  const REMOTE_STEP_MAX_MS = 1000;
  /** WebCodecs frames copied to memory at a time for steps back (keepBack); the rest of a GOP waits in line. */
  const BACK_COPIES = 3;
  /** A step back waits this long at most for those copies before it seeks instead. */
  const BACK_WAIT_MS = 400;
  /**
   * Paused this long (or hidden), the AudioContext is suspended: a running one keeps the audio render
   * thread and the system's output stream busy (~100 callbacks/s, and Windows counts an open stream
   * against idle sleep). play() resumes it and holds the clock until it runs, AC_WAKE_MAX_MS at most.
   */
  const AC_REST_MS = 3000;
  const AC_WAKE_MAX_MS = 400;
  /** Sound codecs whose WebCodecs decoder lagged in this webview (audioToSoft): the built-in decoder from then on. */
  const wcFailed = new Set();
  // ---- Player -------------------------------------------------------------
  class LibavPlayer {
    constructor(meta, cfg) {
      this.meta = meta;
      this.cfg = cfg;
      if (cfg.videoOnly) this.slowWarned = true;
      /** @type {(() => number) | null} */
      this.followerClock = null;
      /** @type {number | undefined} */
      this.frameBudget = undefined;
      this.fps = 0;
      this.n = 0;
      this.gen = 0;
      this.startT = null; // first presentation time in the file
      this.queue = []; // decoded video, sorted by t: {t, yuv?|vf?, bytes}
      this.audio = []; // {t, dur, buffer(AudioBuffer)|planes, scheduled}
      this.sources = new Set();
      this.requesting = false;
      this.eof = false;
      this.playing = false;
      this.pauseT = 0; // absolute media time while paused
      this.shownT = null;
      // The shown picture predates the queue (a seek or jump since): frames between them were never shown.
      this.shownStale = false;
      this.seekTarget = null;
      this.seekBefore = null;
      this.seekGoalFrame = null;
      this.hold = null; // last frame before a seek target
      this.back = []; // decoded frames just before the shown one, paused (keepBack): steps back are served from them
      this.backBytes = 0;
      this.keptBufs = new WeakSet(); // buffers of frames shown and kept for steps (not recycled after upload)
      this.tsSeen = [];
      this.vdec = null;
      this.adec = null;
      this.outCount = 0;
      canvas.hidden = false;
      if (cfg.noWebgl) throw new Error('WebGL2 is not available'); // test hook (VPE_NO_WEBGL, with VPE_LOG)
      // Compare's large grid draws every tile with one shared renderer (Chromium keeps 16 WebGL contexts per page).
      this.gl = env.createRenderer ? env.createRenderer(GLRenderer) : new GLRenderer(canvas);
      this.gl.setRotation(cfg.rotation || 0);
      // Uploaded buffers go back to the decoder unless the next loop still needs them.
      this.gl.onUploaded = (buf) => {
        if (this.worker && buf.byteLength && !this.loopCache?.buffers.has(buf) && !this.keptBufs.has(buf)) this.worker.postMessage({ type: 'recycle', bufs: [buf] }, [buf]);
      };
      this.ac = null;
      this.gain = null;
      this.rate = 1;
      this.loopEnabled = true;
      this.whenSlow = cfg.whenSlow === 'skip' ? 'skip' : 'every';
      this.volume = 1;
      this.muted = false;
      this.mem = memFor(cfg);
      this.started = this.start();
    }

    async start() {
      if (this.meta.native) {
        // Native ffmpeg in the extension host decodes; same messages as the worker.
        this.cfg = { ...this.cfg, native: true };
        this.worker = {
          postMessage: (m) => {
            // Frame buffers from the frame server are reused here; never send them to the host.
            if (m.type === 'recycle') { this.keepBuffers(m.bufs); return; }
            vscode.postMessage({ type: 'nd', m });
          },
          terminate: () => this.closeFrameStream(),
        };
        mark('engine');
        log('engine: native ffmpeg backend');
        // HDR output: ffmpeg sends 10-bit samples for HDR video (an SDR display answers at once).
        const hdr = await this.hdrStart();
        if (this.disposed) return;
        // The picture area: native frames are sized to it (src/native.js fitView).
        const view = pictureArea();
        this.worker.postMessage({ type: 'open', ...(hdr && hdr.on ? { hdr: true } : {}), ...(view ? { view } : {}) });
        return;
      }
      try {
        mark('engine');
        // Started while the page loaded (preload(), the usual case for the player), else now.
        this.boot = takePreload() || bootDecoder(this.cfg, this.mem);
        const d = await this.boot.promise;
        if (this.disposed) return;
        this.workerBlob = d.url; // kept: the pool starts more workers from it later
        this.libavBlobs = d.libav; // also for the thumbnail worker
        this.worker = d.worker;
        this.worker.onmessage = (e) => this.onWorker(e.data);
        this.worker.onerror = (e) => { log(`worker error: ${e.message} ${e.filename}:${e.lineno}`); showMessage('The decoder failed to start.', e.message); };
        mark('libavFetched');
        log(`engine: decoder ${d.preloaded ? 'preloaded' : 'loaded'} (worker source ${d.chars} chars)`);
        // What the worker said before this player took it over ('ready' when it was preloaded).
        for (const m of d.queue) this.onWorker(m);
        if (d.error) this.worker.onerror(d.error);
      } catch (err) {
        if (this.disposed) { this.revokeBlobs(); return; }
        log(`engine start failed: ${err && err.stack || err}`);
        showMessage('The decoder failed to start.', String(err && err.message || err));
      } finally { this.boot = null; }
    }

    // Data for the worker's file reads comes from the extension host.
    blockReader() {
      return this.blockCache ??= VpeBlockCache.create({
        page: env.page, size: this.meta.size, budget: this.mem.blocks,
        largeBlocks: !!((this.cfg.remote || this.cfg.net) && !this.cfg.largeGrid),
        request: (message) => vscode.postMessage(message),
        send: (rid, message, transfer) => this.sendBlock(rid, message, transfer),
        log,
      });
    }

    onWorkerRead(pos, len, rid = 0) {
      if (!this.disposed) this.blockReader().read(pos, len, rid);
    }

    onBlock(pos, data, error) {
      if (!this.disposed) this.blockReader().receive(pos, data, error);
    }

    dropBlockReader(rid) { this.blockCache?.dropReader(rid); }

    async onWorker(m) {
      if (this.disposed) return;
      wake();
      if (this.waits && this.waits.length) this.settleWait(m);
      switch (m.type) {
        case 'ready': mark('libavReady'); this.worker.postMessage({ type: 'open', size: this.meta.size }); break;
        case 'read': this.onWorkerRead(m.pos, m.len, m.rid); break;
        case 'readers': for (const rid of m.drop) this.dropBlockReader(rid); break;
        case 'streams': mark('streams'); await this.onStreams(m.info); break;
        case 'link': this.openFrameStream(m); break; // native: the frame server's address, before 'streams'
        case 'transport': this.recoverFrameStream(m); break;
        // Native: the picture area changed size; the host sizes the frames anew with a seek to the same moment.
        case 'refresh': if (this.info && !this.hidden) this.refreshNativeFrame(); break;
        case 'size':
          if (this.info && this.info.video) {
            Object.assign(this.info.video, { width: m.width, height: m.height });
            this.updateNativeSize();
            env.onMeta(this);
          }
          break;
        case 'transcodeInfo':
          if (this.info && m.transcode) {
            this.info.transcode = m.transcode;
            if (m.transcode.lossy !== undefined) this.nativeLossy = !!m.transcode.lossy;
            env.onMeta(this);
          }
          break;
        case 'configured': mark('configured'); this.onConfigured(m); break;
        case 'fillBatch': this.onFillBatch(m); break;
        case 'sharpFrame': this.onSharpFrame(m); break;
        case 'quickFrame': if (this.remoteStream) this.onQuickFrame(m); break;
        case 'batch':
          if (this.remoteStream) this.receiveRemoteBatch(m);
          else this.onBatch(m);
          break;
        case 'seeked':
          if (m.gen === this.gen) {
            // Remote CFR seeks resolve to a frame timestamp shared by picture and PCM.
            if (this.remoteStream && this.seekTarget !== null && Number.isFinite(m.t)) {
              this.seekTarget = this.pauseT = m.t;
              this.anchor(m.t);
            }
            // The seek is answered: the next request has one owner. The held packets and sound (takeHeld) feed in
            // without asking; the pump below then sends the one request for what follows.
            this.requesting = false;
            this.skipping = false;
            if (this.pendingHave) this.takeHeld(m);
            this.pump();
          }
          break;
        case 'subs': this.onSubs(m); break;
        case 'videoMode': this.onVideoMode(m); break;
        case 'videoReread': this.onVideoReread(m); break;
        case 'log': log(m.msg); break;
        case 'error':
          this.loopCache = null;
          if (DECODE_STEPS.has(m.where) && this.decodeError(m)) break;
          log(`worker ${m.where} error: ${m.message}`);
          if (m.where === 'open') showMessage('This file could not be opened.', 'It may be damaged or incomplete (for example a recording that was cut off before it finished), or not a video file.');
          else if (m.where === 'init') showMessage('The decoder could not be loaded.', m.message);
          this.requesting = false;
          // The re-read after a decoder error failed in the worker: go on as if it had answered so.
          if (m.where === 'rereadVideo') this.onVideoReread({ gen: this.gen, rewound: false });
          break;
      }
    }

    async onStreams(info) {
      if (this.cfg.videoOnly) info = { ...info, audio: null };
      this.info = info;
      if (!this.meta.duration && info.duration) this.meta.duration = info.duration;
      const v = info.video;
      const a = info.audio;
      let video = 'none';
      let audio = 'none';
      // Dolby Vision without an HDR10, HLG or SDR base layer (profile 5): no picture we could show right.
      const dv = v && typeof VpeHdr !== 'undefined' ? VpeHdr.dolbyVision(v.dv) : null;
      if (dv && !dv.supported) {
        log(`unsupported: ${dv.label} (base layer compatibility ${dv.compat})`);
        showMessage(`Dolby Vision profile ${dv.profile} isn't supported.`, "This file has no HDR10, HLG or SDR base layer: its colours need Dolby's own decoder (profile 5 is used by streaming services). Dolby Vision profile 8 (and 7) files play, as HDR10 or HLG.");
        return;
      }
      if (info.native) {
        // Native ffmpeg already decodes to raw frames and PCM.
        video = v ? 'soft' : 'none';
        audio = a ? 'soft' : 'none';
        this.meta.width = v ? v.sourceWidth : 0;
        this.meta.height = v ? v.sourceHeight : 0;
        // Use the source size for untagged video even when ffmpeg scales it down for transport.
        this.nativeColour = v ? { space: taggedMatrix(v.colorSpace) || matrixBySize(v.sourceWidth, v.sourceHeight), trc: v.colorTrc, prim: v.colorPrimaries } : {};
        // HDR output: 10-bit samples in 16-bit words (the host's 'open' asked for them).
        if (v && v.depth > 8) this.nativeColour.depth = v.depth;
        this.gl.hdrPeak = (v && v.hdrPeak) || 0;
        this.setupHdr(v);
        this.updateNativeSize();
        if (v && v.fps) { this.fps = v.fps; this.n = Math.max(1, Math.round((info.duration || 0) * v.fps)); this.meta.fps = v.fps; this.meta.frames = this.n; this.tsSeen = new Array(40); env.onMeta(this); }
        this.worker.postMessage({ type: 'config', video, audio });
        if (v && v.width > 0 && v.height > 0) {
          mark('nativePrepareStart');
          this.gl.prepareNative(v.width, v.height);
          mark('nativePrepareEnd');
        }
        return;
      }
      if (v) {
        video = 'soft';
        let conf = null;
        if (v.codec === 'h264') conf = h264Config(v);
        else if (v.codec === 'vp8') conf = { codec: 'vp8', codedWidth: v.width, codedHeight: v.height };
        // HDR (PQ/HLG): the built-in decoder, so our shader tone-maps it. A WebCodecs frame
        // uploaded to WebGL arrives as the PQ/HLG signal in BT.2020 primaries, not tone-mapped
        // (Edge 2026-11, checked); HDR in H.264/VP8 is rare, so software is the simple fix.
        this.gl.hdrPeak = v.hdrPeak || 0;
        // Why the picture is (not) on WebCodecs, for the stats overlay.
        this.wcInfo = conf ? { codec: conf.codec } : null;
        if (conf && (v.colorTrc === 16 || v.colorTrc === 18)) { this.wcInfo.skipped = 'HDR, exact tone mapping'; conf = null; log('HDR video: decoded in software for tone mapping'); }
        this.setupHdr(v);
        if (conf && typeof VideoDecoder !== 'undefined') {
          try {
            const r = await VideoDecoder.isConfigSupported(conf);
            if (r.supported) { video = 'webcodecs'; this.vconf = conf; } else this.wcInfo.skipped = 'not supported here';
          } catch (e) { log(`VideoDecoder check failed: ${e}`); }
        }
        this.meta.width = v.width;
        this.meta.height = v.height;
        // The container may state the rate (MP4/MOV, MXF: avg_frame_rate) or the frame count (MP4 sample table):
        // the count is known at once, End works before 24 timestamps were seen. trackTs refines it afterwards.
        const dur = this.meta.duration || 0;
        const stated = v.fps > 0 ? v.fps : v.frames > 0 && dur > 0 ? v.frames / dur : 0;
        if (stated > 0 && dur > 0 && !this.fps) this.setFrameRate(stated);
      }
      if (a) {
        const r = await this.audioConfig(a);
        audio = r.mode;
        if (r.conf) this.aconf = r.conf;
        this.audioId = a.id === undefined ? null : a.id;
      }
      this.meta.label = `${v ? v.codec : 'no video'}${a ? ` + ${a.codec}` : ''}${hdrLabel(v, this.hdrOutput)} · decoded: video ${video === 'webcodecs' ? 'by the GPU (WebCodecs)' : video === 'soft' ? 'by the built-in decoder' : '–'}, audio ${audio === 'webcodecs' ? 'WebCodecs' : audio === 'soft' ? 'built-in decoder' : '–'}`;
      // The stream can change size and encoder mid-playback. Display dimensions follow its frames.
      if (info.remoteStream) {
        const s = info.remoteStream;
        this.meta.label = `${s.sourceCodec} ${s.sourcePixFmt} ${s.sourceWidth}×${s.sourceHeight} · streamed from the remote host as H.264, decoded by WebCodecs`;
        this.nativeLossy = !(info.transcode && info.transcode.lossy === false);
        this.remoteStream = true;
        // The packets received, for paused seeks and steps back without the link (seekFromPackets).
        if (typeof VpePacketCache !== 'undefined' && !(this.cfg.packetCacheMB === 0)) {
          this.packetCache = VpePacketCache.create({ cap: (this.cfg.packetCacheMB || 64) * 1e6 });
        }
        if (this.playing) this.worker.postMessage({ type: 'playback', playing: true });
      }
      log(`streams: ${JSON.stringify({ v: v && { c: v.codec, w: v.width, h: v.height, fmt: v.format }, a: a && { c: a.codec, sr: a.sampleRate, ch: a.channels }, dur: info.duration })} -> video ${video}, audio ${audio}`);
      if (!this.disposed) this.worker.postMessage({ type: 'config', video, audio, deep: !!this.gl.norm16 });
    }

    /** WebCodecs for the sound when the browser has the codec, else the built-in decoder. */
    async audioConfig(a) {
      const codec = AUDIO_CODECS[a.codec];
      const failed = wcFailed.has(`audio-${a.codec}`) || (this.cfg.wcFailed || []).includes(`audio-${a.codec}`);
      if (failed) log(`WebCodecs not used for ${a.codec} sound: it lagged earlier in this session`);
      if (codec && !failed && typeof AudioDecoder !== 'undefined') {
        const conf = { codec, sampleRate: a.sampleRate, numberOfChannels: a.channels };
        if (a.extradata && a.codec !== 'mp3') conf.description = a.extradata;
        try {
          const r = await AudioDecoder.isConfigSupported(conf);
          if (r.supported) return { mode: 'webcodecs', conf };
        } catch (e) { log(`AudioDecoder check failed: ${e}`); }
      }
      return { mode: 'soft', conf: null };
    }

    onConfigured(m) {
      // Switched to software after WebCodecs errors: continue from the shown frame.
      if (this.reconfigure) { this.reconfigure = false; this.vmode = m.video; this.seekAbs(this.shownT !== null ? this.shownT : this.pauseT); return; }
      this.vmode = m.video;
      this.amode = m.audio;
      if (m.videoError) log(m.videoError);
      if (m.audioError) log(m.audioError);
      if (this.vmode === 'none' && this.amode === 'none') {
        showMessage('This video uses a codec the built-in decoder does not include.', m.videoError || m.audioError || '');
        return;
      }
      if (this.info.video && this.vmode === 'none') showMessage('The picture uses a codec the built-in decoder does not include.', m.videoError || '');
      // The picture decodes in WebAssembly: in a remote window the extension may offer ffmpeg there (src/remoteff.js).
      if (this.info.video && this.vmode === 'soft' && !this.cfg.native) vscode.postMessage({ type: 'softVideo', codec: this.info.video.codec, depth: this.info.video.depth || 8 });
      if (this.info.audio && this.amode === 'none') toast(`No sound: ${this.info.audio.codec} is not in the built-in decoder`);
      if (this.vmode === 'webcodecs') this.makeVideoDecoder();
      if (this.amode === 'webcodecs') this.makeAudioDecoder();
      this.ensureAudio();
      env.onReady(this);
      this.beginLoopCache();
      if (this.info.tracks) onTracks(this);
      this.pump();
    }

    /** resume: the decoder that replaces a failed one in the same read (resumeAfterVideoError); else a new read starts. */
    makeVideoDecoder(resume = false) {
      const g = this.gen;
      if (!resume) { this.vOutT = undefined; this.vKeyT = undefined; this.keyAfter = undefined; this.vRereadTo = undefined; }
      this.vdec = new VideoDecoder({
        output: (vf) => {
          wake();
          if (g !== this.gen || vf.timestamp % 2 !== 0) { vf.close(); return; }
          let t = vf.timestamp / 2e6;
          if (this.noPts) t = (this.ptsBase || 0) + this.outCount / (this.fps || 30);
          this.outCount++;
          if (!(t <= this.vOutT)) this.vOutT = t; // how far the picture got out of this read (resumeAfterVideoError)
          const fr = { t, vf, bytes: vf.displayWidth * vf.displayHeight * 1.5 };
          // Chromium can default to BT.709 for untagged SD or miss a container-only tag.
          // When its matrix differs, let our shader convert the decoded planes.
          if (!this.noSpill && this.frameMatrix(vf) !== (taggedMatrix(vf.colorSpace && vf.colorSpace.matrix) || 709)) this.toMemory(fr);
          this.addFrame(fr);
        },
        error: (e) => {
          log(`VideoDecoder error: ${e.message}`);
          if (g !== this.gen || this.vmode !== 'webcodecs') return;
          this.loopCache = null;
          // The error closed the decoder: a new one continues from the next keyframe. Keeps failing: decode in software.
          this.vErrors = (this.vErrors || 0) + 1;
          if (this.vErrors < 3) { this.resumeAfterVideoError(); return; }
          log('VideoDecoder keeps failing; decoding the picture in software');
          this.wcInfo = { ...(this.wcInfo || {}), failed: `${this.vErrors} decode errors` };
          this.vdec = null;
          this.vmode = 'soft';
          this.reconfigure = true;
          this.worker.postMessage({ type: 'config', video: 'soft', audio: this.amode, deep: !!this.gl.norm16 });
        },
      });
      // The decoder taking packets (decodeQueueSize falls) can let pump() read on: wake a resting page.
      this.vdec.ondequeue = () => wake();
      this.vdec.configure(this.vconf);
      this.needKey = true;
    }

    /**
     * A new decoder after a WebCodecs error. The failed one took every packet it still held with it, and
     * WebCodecs is handed packets far ahead of what it has decoded: in a short file all of them, to the end.
     * So the worker reads the picture again from the failure, and the new decoder starts at the first keyframe
     * after it. (Without the re-read the end of the file followed the error: a 5 s clip with one damaged
     * picture at 2.5 s stopped there as "fully decoded".)
     */
    resumeAfterVideoError() {
      // The failure lies after the last picture that came out, or at the keyframe the decoder started with.
      const from = Math.max(this.vOutT ?? -Infinity, this.vKeyT ?? -Infinity);
      this.makeVideoDecoder(true);
      // No presentation times to find the place by, or packets fed by the host (Live transcode: no demuxer
      // here to rewind): the new decoder takes the next keyframe that is read.
      if (this.noPts || !Number.isFinite(from) || this.cfg.native) return;
      this.keyAfter = from;
      this.vRereadTo = this.readVT; // packets up to here were counted for the frame rate already
      this.vReread = this.gen; // pending until 'videoReread': no reads meanwhile (pump), and no end of file
      this.worker.postMessage({ type: 'rereadVideo', gen: this.gen, t: from });
    }

    /** The worker's answer to 'rereadVideo': the picture comes again from the failure on, or it can't (rewound false). */
    onVideoReread(m) {
      if (m.gen !== this.gen || this.vReread !== this.gen) return;
      this.vReread = undefined;
      const held = this.eofHeld === this.gen;
      this.eofHeld = undefined;
      if (m.rewound) {
        // Also for an end of file that is being flushed or was reached with the failed decoder: read on.
        this.eof = false;
        this.rewinds = (this.rewinds || 0) + 1;
      } else {
        log('the picture could not be read again after the decoder error; continuing at the next keyframe read');
        if (held) { this.finishEof(); return; }
      }
      this.pump();
    }

    openGopToSoft() {
      if (this.toSoft) return;
      this.toSoft = true;
      this.requesting = true; // wait for videoMode before asking the worker for more
      log('open-GOP H.264: no IDR to start WebCodecs at; decoding the picture in software');
      this.wcInfo = { ...(this.wcInfo || {}), failed: 'open GOP, no IDR' };
      try { this.vdec.close(); } catch { /* closed */ }
      this.vdec = null;
      this.worker.postMessage({ type: 'videoMode', video: 'soft' });
    }

    onVideoMode(m) {
      if (m.video !== 'soft') {
        this.requesting = false;
        log(`software video failed: ${m.error || ''}`);
        return;
      }
      this.vmode = 'soft';
      // Start over where the picture is wanted (a pending accurate seek, else the playhead).
      const t = this.seekTarget !== null ? this.seekTarget : this.shownT !== null && !this.playing ? this.shownT : this.now();
      this.seekAbs(t);
    }

    makeAudioDecoder() {
      const g = this.gen;
      this.aSubmitT = undefined;
      this.aLagFrom = null;
      this.adec = new AudioDecoder({
        output: (ad) => {
          wake();
          if (g !== this.gen) { ad.close(); return; }
          const planes = [];
          for (let c = 0; c < ad.numberOfChannels; c++) {
            const p = new Float32Array(ad.numberOfFrames);
            ad.copyTo(p, { planeIndex: c, format: 'f32-planar' });
            planes.push(p);
          }
          this.addAudio(ad.timestamp / 1e6, ad.sampleRate, planes);
          ad.close();
        },
        error: (e) => log(`AudioDecoder error: ${e.message}`),
      });
      this.adec.ondequeue = () => wake();
      this.adec.configure(this.aconf);
    }

    /**
     * WebCodecs sound that can't keep up, while more than a second of it waits in the decoder:
     * it comes out slower than it plays (rate above 1x, measured over 0.5 s), or little is decoded
     * ahead of the playhead, for 0.4 s. Edge's AAC decoder here releases sound at about real time,
     * so 2x starved for seconds. The built-in decoder takes over from the playhead.
     */
    checkAudioLag() {
      if (this.amode !== 'webcodecs' || !this.adec || !this.playing || this.aToSoft || this.seekTarget !== null || this.aSubmitT === undefined || this.cfg.native) { this.aLagFrom = null; this.aOutWin = []; return; }
      const now = this.now();
      const last = this.audio[this.audio.length - 1];
      const aEnd = last ? last.t + last.dur : now;
      const t = performance.now();
      // Media seconds of sound coming out of the decoder per second (a new window after a rate change).
      const w = this.aOutWin && this.aOutWin.rate === this.rate ? this.aOutWin : (this.aOutWin = Object.assign([], { rate: this.rate }));
      w.push([t, aEnd]);
      while (w.length > 2 && t - w[1][0] >= 500) w.shift();
      const outRate = t - w[0][0] >= 500 ? (aEnd - w[0][1]) / ((t - w[0][0]) / 1000) : null;
      const backlog = this.aSubmitT - Math.max(aEnd, now);
      const slow = this.rate > 1 && outRate !== null && outRate < 0.85 * this.rate;
      const dry = aEnd - now < 0.3 * Math.max(1, this.rate);
      if (backlog <= 1 || !(slow || dry)) { this.aLagFrom = null; return; }
      if (this.aLagFrom === null || this.aLagFrom === undefined) { this.aLagFrom = t; return; }
      if (t - this.aLagFrom < 400) return;
      this.audioToSoft(`WebCodecs ${this.info.audio.codec} sound lags at ${this.rate}x (out at ${outRate === null ? '?' : outRate.toFixed(2)}x, ${backlog.toFixed(1)} s in the decoder, ${this.adec.decodeQueueSize} chunks queued)`);
    }

    /**
     * Sound from the built-in decoder (same track). What WebCodecs already decoded keeps playing;
     * the worker re-reads from its end, and sound before that is dropped (audioKeepUntil).
     */
    audioToSoft(why) {
      if (this.aToSoft || this.disposed) return undefined;
      this.aToSoft = true;
      const codec = this.info.audio.codec;
      wcFailed.add(`audio-${codec}`);
      vscode.postMessage({ type: 'wcFailed', codec: `audio-${codec}`, reason: why });
      log(`${why}; the built-in decoder takes over the sound`);
      return this.trackOp(async () => {
        if (this.disposed) return;
        this.loopCache = null;
        const now = this.now();
        if (this.adec) { try { this.adec.close(); } catch { /* closed */ } this.adec = null; }
        const last = this.audio[this.audio.length - 1];
        const from = last ? Math.max(now, last.t + last.dur) : now;
        this.audioKeepUntil = from;
        const reply = this.waitWorker('audioSelected', 'selectAudio');
        this.worker.postMessage({ type: 'selectAudio', id: this.audioId, mode: 'soft', t: from });
        let r;
        try { r = await reply; } catch (e) { if (e && e.disposed) return; log(`sound to the built-in decoder failed: ${e && e.message || e}`); return; }
        if (this.disposed) return;
        this.amode = r.audio;
        this.aconf = null;
        if (r.audioError) log(r.audioError);
        if (r.rewound) { this.eof = false; this.catchUp = true; this.rewinds = (this.rewinds || 0) + 1; this.readVT = undefined; }
        this.pump();
      }).catch((e) => { if (!e || !e.disposed) throw e; });
    }

    ensureAudio() {
      if (!this.info.audio || this.ac) return;
      this.ac = new AudioContext({ latencyHint: 'playback' });
      if (this.ac.state === 'running') this.acUnlocked = true;
      this.ac.onstatechange = () => this.onAudioRunning();
      // Native ffmpeg resamples to the context's own rate (from its next start) instead of 48 kHz.
      if (this.cfg.native && !this.remoteStream) this.worker.postMessage({ type: 'audioRate', rate: this.ac.sampleRate });
      this.gain = this.ac.createGain();
      this.gain.connect(this.ac.destination);
      this.applyVolume();
      if (!this.playing) this.restAudioLater();
    }

    onAudioRunning() {
      if (this.disposed || !this.ac || this.ac.state !== 'running') return;
      this.acUnlocked = true;
      if (!this.muted) setMuteUi(false);
      if (!this.playing) this.restAudioLater(this.hidden ? 0 : AC_REST_MS);
      wake();
    }

    /** True while the AudioContext is still suspended by the browser's autoplay policy (not resting while paused). */
    audioBlocked() {
      if (!this.ac || this.amode === 'none' || this.acUnlocked || this.acRest) return false;
      if (this.ac.state === 'running') { this.acUnlocked = true; return false; }
      return this.ac.state === 'suspended';
    }

    /** Called on a user gesture in the page: unlocks a suspended AudioContext so sound can play now or when unmuted later. */
    unlockAudio() {
      if (!this.ac || this.acUnlocked || this.acRest) return;
      if (this.ac.state === 'running') { this.acUnlocked = true; return; }
      this.ac.resume().then(() => this.onAudioRunning(), () => {});
      if (this.ac.state === 'running') this.onAudioRunning();
    }

    /** Suspends the AudioContext after ms unless playback starts (restAudio). */
    restAudioLater(ms = AC_REST_MS) {
      clearTimeout(this.acTimer);
      this.acTimer = setTimeout(() => this.restAudio(), ms);
    }

    restAudio() {
      this.acTimer = 0;
      if (!this.ac || this.playing || this.disposed) return;
      if (this.acWaking) {
        this.acWaking = false;
        clearTimeout(this.acWakeTimer);
        this.acRest = true;
        this.ac.suspend().catch(() => {});
        return;
      }
      if (this.ac.state !== 'running') return;
      this.acUnlocked = true;
      this.acRest = true;
      this.ac.suspend().catch(() => {});
    }

    /**
     * play() after restAudio: resume, and hold the clock (now()) until the context runs, so picture
     * and sound start together at the paused frame. A resume that hangs plays on the timer clock.
     */
    wakeAudio() {
      this.acRest = false;
      this.acWaking = true;
      const done = () => {
        if (!this.acWaking) return;
        const held = this.now();
        this.acWaking = false;
        clearTimeout(this.acWakeTimer);
        if (this.ac && this.ac.state === 'running') this.acUnlocked = true;
        if (this.playing && !this.disposed) this.anchor(held);
        wake();
      };
      this.ac.resume().then(done, done);
      this.acWakeTimer = setTimeout(done, AC_WAKE_MAX_MS);
    }

    // ---- data in --------------------------------------------------------

    async receiveRemoteBatch(m) {
      const videoBytes = m.video.reduce((n, it) => n + it.data.byteLength, 0);
      const bytes = videoBytes + m.audio.reduce((n, it) => {
        if (it.kind === 'opus') return n + it.packets.reduce((sum, p) => sum + p.byteLength, 0) + it.head.byteLength;
        return n + (it.data ? it.data.byteLength : it.planes.reduce((sum, p) => sum + p.byteLength, 0));
      }, 0);
      const receive = async () => {
        if (this.disposed || m.gen !== this.gen) return;
        const w = this.remoteWindow;
        if (w && this.remoteReadAt >= w.eligibleSince) {
          w.videoBytes += videoBytes;
          w.frames += m.fragment && m.fragment.offset + videoBytes < m.fragment.total ? 0 : m.video.length;
          w.bytes += bytes;
          w.readMs += performance.now() - this.remoteReadAt;
          w.hostWaitMs += m.hostWaitMs || 0; // the host waiting for its ffmpeg, not the link
        }
        if (m.fragment) {
          const { offset, total } = m.fragment;
          const packet = m.video[0];
          if (offset === 0) this.remoteFragment = new Uint8Array(total);
          this.remoteFragment.set(packet.data, offset);
          if (offset + videoBytes === total) {
            m.video = [{ ...packet, data: this.remoteFragment }];
            this.remoteFragment = null;
          } else {
            this.requesting = false;
            this.pump();
            return;
          }
        } else this.remoteFragment = null;
        // The sound as received goes into the packet cache too (takeHeld: play after a seek served from there).
        if (this.packetCache) for (const it of m.audio) this.packetCache.addSound(it);
        try {
          // Sound held by the page goes first (takeHeld): what the host sends follows it.
          if (this.soundGate) { await this.soundGate; if (this.disposed || m.gen !== this.gen) return; }
          if (m.audio.some((it) => it.kind === 'opus')) m.audio = await this.decodeRemoteAudio(m.audio);
          if (this.disposed || m.gen !== this.gen) return;
          this.remoteVideoEnd = m.eof || m.videoEnd;
          this.onBatch(m);
        } catch (e) {
          if (this.disposed || m.gen !== this.gen) return;
          log(`remote sound decode failed: ${e.message}`);
          this.worker.postMessage({ type: 'remoteAudioFailed', message: e.message });
        }
      };
      // The VS Code test hook paces delivery at a fixed payload rate, including PCM.
      if (this.debugRemoteRate > 0) setTimeout(receive, bytes * 1000 / this.debugRemoteRate);
      else receive();
    }

    async decodeRemoteAudio(audio) {
      if (!this.remoteAudioBoot) {
        const boot = bootDecoder({ ...this.cfg, singleWorker: true }, this.mem);
        this.remoteAudioBoot = boot;
        this.remoteAudioPending = new Map();
        this.remoteAudioId = 0;
        this.remoteAudioReady = boot.promise.then((d) => {
          this.remoteAudioWorker = d.worker;
          d.worker.onmessage = (e) => {
            const m = e.data;
            const pending = this.remoteAudioPending && this.remoteAudioPending.get(m.id);
            if (pending && (m.type === 'remoteAudio' || m.type === 'error')) {
              this.remoteAudioPending.delete(m.id);
              if (m.type === 'error') pending.reject(new Error(m.message));
              else {
                if (!this.remoteAudioLogged) { log('remote sound: Opus decoded by the built-in decoder'); this.remoteAudioLogged = true; }
                pending.resolve(m.audio);
              }
            }
          };
          d.worker.onerror = (e) => {
            for (const pending of this.remoteAudioPending.values()) pending.reject(new Error(e.message));
            this.remoteAudioPending.clear();
          };
        });
      }
      await this.remoteAudioReady;
      if (this.disposed) return [];
      return new Promise((resolve, reject) => {
        const id = ++this.remoteAudioId;
        this.remoteAudioPending.set(id, { resolve, reject });
        this.remoteAudioWorker.postMessage({ type: 'remoteAudio', id, audio });
      });
    }

    onBatch(m) {
      wake();
      if (m.gen !== this.gen) return;
      // Only the producer's batch answers the request in flight; the page's own packets (m.local) answer none.
      if (!m.local) this.requesting = false;
      if (this.catchUp) {
        // The sound shows how far the re-read got (the pool's picture comes from other workers); without sound, the picture.
        const items = this.amode !== 'none' ? m.audio.filter((it) => it.aid === undefined || it.aid === this.audioId) : m.video;
        const hi = items.reduce((x, it) => (it.t !== null && it.t > x ? it.t : x), -Infinity);
        if (m.eof || hi >= this.now() + 1) this.catchUp = false;
      }
      const keep = this.packetCache && !m.local ? this.packetCache : null;
      for (const it of m.video) {
        if (it.t !== null && it.t !== undefined && !(it.t <= this.readVT)) this.readVT = it.t;
        if (keep && it.kind === 'packet') keep.add(m.gen, it);
        if (it.kind === 'packet') {
          if (!this.vdec || this.vdec.state !== 'configured') continue;
          // Read before the worker rewound the picture after a decoder error: it comes again.
          if (this.vReread === this.gen) continue;
          // After a decoder error the pictures up to the failure are out or lost: on at the first keyframe after it.
          if (this.needKey && this.keyAfter !== undefined && it.t !== null && !(it.t > this.keyAfter + 5e-4)) continue;
          // After configure/flush WebCodecs needs an IDR. An open-GOP I-frame (idr false) is
          // no entry point for it, and IDRs can be minutes apart: decode in software instead.
          if (this.needKey && it.key && it.idr === false) {
            this.openGopToSoft();
            // The software decoder will re-read this batch. Its EOF must not clear the pending seek.
            return;
          }
          if (this.needKey && !it.key) continue;
          if (this.needKey) this.vKeyT = it.t === null ? undefined : it.t;
          this.needKey = false;
          if (it.t === null) { this.noPts = true; if (this.ptsBase === undefined) this.ptsBase = it.dts || 0; }
          const ts = Math.round((it.t === null ? (it.dts || 0) : it.t) * 1e6);
          // No presentation times (H.264 in AVI): the decode times are frame-spaced, so they give the rate.
          // (Not a second time for packets read again after a decoder error.)
          if (!(it.t <= this.vRereadTo)) this.trackTs(it.t === null ? (Number.isFinite(it.dts) ? it.dts : null) : it.t);
          try {
            // Carry discard on the chunk itself. Multiple edits can put a visible
            // packet and a decode-only dependency at the same presentation time.
            const timestamp = ts * 2 + (it.discard ? 1 : 0);
            this.vdec.decode(new EncodedVideoChunk({ type: it.key ? 'key' : 'delta', timestamp, data: it.data }));
          } catch (e) {
            log(`decode: ${e.message}`);
          }
        } else if (it.kind === 'yuv') {
          const t = it.t === null ? (this.lastT || 0) + 1 / (this.fps || 30) : it.t;
          this.trackTs(t);
          this.addFrame({ t, yuv: it, bytes: it.data.byteLength });
        }
      }
      for (let it of m.audio) {
        if (it.aid !== undefined && it.aid !== this.audioId) continue; // a track switched away from
        if (it.kind === 'packet') {
          if (!this.adec || this.adec.state !== 'configured' || it.t === null) continue;
          try {
            this.adec.decode(new EncodedAudioChunk({ type: 'key', timestamp: Math.round(it.t * 1e6), data: it.data }));
            // How far sound has gone into the decoder (pump throttles on what hasn't come out yet).
            this.aSubmitT = Math.max(this.aSubmitT === undefined ? -Infinity : this.aSubmitT, it.t);
          } catch (e) { log(`audio decode: ${e.message}`); }
        } else if (it.kind === 's16') {
          // After takeHeld: sound the page already holds may come again from the host; keep only what follows it.
          if (this.audioKeepUntil !== undefined && it.t < this.audioKeepUntil - 1e-4) {
            const cut = typeof VpePacketCache !== 'undefined' ? VpePacketCache.trimSound(it, this.audioKeepUntil) : null;
            if (!cut) continue;
            it = cut;
          }
          const samples = new DataView(it.data.buffer, it.data.byteOffset, it.data.byteLength);
          const planes = [new Float32Array(it.data.byteLength / 4), new Float32Array(it.data.byteLength / 4)];
          for (let i = 0; i < planes[0].length; i++) {
            planes[0][i] = samples.getInt16(i * 4, true) / 32768;
            planes[1][i] = samples.getInt16(i * 4 + 2, true) / 32768;
          }
          this.addAudio(it.t, it.sampleRate, planes);
        } else if (it.kind === 'pcm' && it.t !== null) {
          let { t, planes } = it;
          // After audioToSoft: the re-read repeats sound that is already decoded; keep only what follows it.
          if (this.audioKeepUntil !== undefined && t < this.audioKeepUntil - 1e-4) {
            const skip = Math.round((this.audioKeepUntil - t) * it.sampleRate);
            if (!planes.length || skip >= planes[0].length) continue;
            planes = planes.map((p) => p.subarray(skip));
            t = this.audioKeepUntil;
          }
          this.addAudio(t, it.sampleRate, planes, it.mask);
        }
      }
      if (m.eof) this.finishEof();
      this.pump();
    }

    /** The demuxer is at the end. WebCodecs still holds the last frames and sound: the end is reached when both flushes are done. */
    finishEof() {
      const g = this.gen;
      const rw = this.rewinds || 0;
      const flushes = [this.vdec, this.adec].filter((d) => d && d.state === 'configured').map((d) => d.flush().catch(() => {}));
      this.requesting = true;
      Promise.all(flushes).then(() => {
        if (g !== this.gen) return;
        this.requesting = false;
        // A track switch (or the re-read after a decoder error) rewound the demuxer while this end was flushed: read on instead.
        if (rw !== (this.rewinds || 0)) { this.pump(); return; }
        // The video decoder failed (its flush with it) and its packets are asked for again: onVideoReread decides.
        if (this.vReread === this.gen) { this.eofHeld = this.gen; return; }
        this.eof = true;
        // A short file with no rate in its container: the timestamps seen are all there are.
        if (!this.fps && this.tsSeen.length >= 3 && this.tsSeen.length < 24) this.measureRate();
        // A seek past the last frame (End): show the last one.
        if (this.seekTarget !== null) {
          this.insertHold();
          this.seekTarget = null;
          this.seekBefore = null;
          if (this.playing) { this.stopAudio(); this.anchor(this.pauseT); }
        }
        this.pump();
      });
    }

    /** Native backend: one raw frame per message (or frame server record). recycle: its buffer holds only this frame and comes back through keepBuffers. */
    onNativeVideo(m, recycle = false) {
      wake();
      const st = this.ndvStats || (this.ndvStats = { n: 0, bytes: 0 });
      st.n++;
      st.bytes += m.data.byteLength;
      if (m.gen !== this.gen) return;
      if (!this.firstShown) mark('nativeFrameReceived');
      this.requesting = false;
      const k = this.nativeColour && this.nativeColour.depth > 8 ? 2 : 1; // bytes per sample
      const half = (m.w / 2) * k;
      this.addFrame({
        // srcT: the picture's own timestamp from ffmpeg (src/nativepts.js); without it, t is only a slot count.
        t: m.t, bytes: m.data.byteLength, srcT: Number.isFinite(m.src) ? m.src : undefined, nativeTimestamp: !Number.isFinite(m.src),
        yuv: { width: m.w, height: m.h, data: m.data, fullRange: false, recycle, layout: [{ offset: 0, stride: m.w * k }, { offset: m.ys, stride: half }, { offset: m.ys + m.ys / 4, stride: half }], ...this.nativeColour },
      });
    }

    /**
     * Native frames from the localhost frame server (src/frameserver.js, framestream.js) instead
     * of messages. The host distinguishes a failed negotiation from an interrupted decode.
     */
    openFrameStream(tr) {
      this.closeFrameStream();
      const failed = (err) => {
        log(`engine: frame stream failed (${err && err.message}); frames by message`);
        this.worker.postMessage({ type: 'transport', failed: String(err && err.message || err) });
      };
      try {
        const stream = FrameStream.open({
          mode: tr.mode, url: tr.url,
          onOpen: () => { if (this.frameStream === stream) log(`engine: native frames over ${tr.mode}`); },
          onRecord: (head, data, owned) => {
            if (this.disposed || this.frameStream !== stream) return;
            if (head.kind === 1) this.onNativeVideo({ gen: head.gen, t: head.t, src: head.src, w: head.w, h: head.h, ys: head.ys, data }, owned);
            else if (head.kind === 2) this.onWorker({ type: 'batch', gen: head.gen, eof: true, video: [], audio: [] });
          },
          onClose: (err) => {
            if (this.disposed || this.frameStream !== stream) return;
            this.closeFrameStream();
            failed(err);
          },
        });
        this.frameStream = stream;
      } catch (err) { failed(err); }
    }

    closeFrameStream() {
      const stream = this.frameStream;
      this.frameStream = null;
      if (stream) stream.close();
    }

    /** Native: tell the host the picture area's size (player.js calls this when the stage resizes or the picture is zoomed). */
    nativeView(zoomed) {
      const view = this.meta.native && !this.disposed && this.worker ? pictureArea(zoomed) : null;
      // Live transcode: while playing, a larger picture starts in the host without a seek (sound and clock go on).
      if (view) this.worker.postMessage({ type: 'view', ...view, ...(zoomed ? { zoomed: true } : {}), ...(this.remoteStream && this.playing ? { playing: true } : {}) });
    }

    updateNativeSize() {
      const { video: v, audio: a } = this.info;
      this.meta.label = `${v ? `${v.codec} ${v.pixFmt}` : 'no video'}${a ? ` + ${a.codec}` : ''}${hdrLabel(v, this.hdrOutput)} · decoded by native ffmpeg${v && v.height !== v.sourceHeight ? ` · shown at ${v.width}×${v.height}` : ''}`;
      // Scaling and 8-bit conversion change the pixels the inspection tools would read.
      this.nativeLossy = !!v && (v.height !== v.sourceHeight || v.width !== v.sourceWidth || !/^(yuv420p|yuvj420p|nv12)$/.test(v.pixFmt || ''));
    }

    recoverFrameStream({ width, height }) {
      this.closeFrameStream();
      Object.assign(this.info.video, { width, height });
      this.updateNativeSize();
      env.onMeta(this);
      // Frames in the decoded queue can't fill the gap left by undelivered socket writes.
      this.refreshNativeFrame(true);
    }

    refreshNativeFrame(recoverTransport = false, rel) {
      // The host's output changed (a new picture size): the kept packets are of the old one.
      if (this.packetCache) this.packetCache.clear();
      const start = this.startT || 0;
      const end = this.meta.duration ? start + this.meta.duration - 0.5 / (this.fps || 30) : Infinity;
      const playhead = this.startT === null ? this.pauseT : this.now();
      const target = rel === undefined || this.startT === null ? playhead : start + rel;
      // A seek still in flight wins over the clock sample a resize brings: the resize must not cancel it.
      const t = this.seekTarget ?? Math.max(start, Math.min(target, end));
      this.seekAbs(t, this.playing, recoverTransport);
    }

    /** Frame buffers the renderer has uploaded go back to the frame stream for its next records. */
    keepBuffers(bufs) {
      if (this.frameStream) for (const b of bufs || []) this.frameStream.recycle(b);
    }

    onNativeAudio(m) {
      if (m.gen !== this.gen) return;
      this.requesting = false;
      // Interleaved stereo f32 from the host (src/native.js sendAudio), at the rate the page asked for.
      const raw = m.data.byteOffset % 4 ? m.data.slice() : m.data;
      const f = new Float32Array(raw.buffer, raw.byteOffset, m.n * 2);
      const l = new Float32Array(m.n);
      const r = new Float32Array(m.n);
      for (let i = 0, j = 0; i < m.n; i++, j += 2) { l[i] = f[j]; r[i] = f[j + 1]; }
      this.addAudio(m.t, m.rate || 48000, [l, r]);
    }

    /** Frame rate from the spacing of the first presentation times. */
    trackTs(t) {
      if (t === null || this.tsSeen.length >= 40) return;
      this.tsSeen.push(t);
      if (this.tsSeen.length >= 24) this.measureRate();
    }

    /** Rate from the timestamps seen; at the end of a short file (under 24 frames) from what there is. */
    measureRate() {
      const fps = measureRate(this.tsSeen);
      if (fps !== undefined) this.setFrameRate(fps);
    }

    /** Takes a measured or stated rate (snapped to a common one when close) and derives the frame count. */
    setFrameRate(fps) {
      this.fps = snapRate(fps);
      this.n = Math.max(1, Math.round((this.meta.duration || 0) * this.fps));
      this.meta.fps = this.fps;
      this.meta.frames = this.n;
      env.onMeta(this);
    }

    addFrame(fr) {
      const nowMs = performance.now();
      // Arrival times for decodeRate / mediaRate (getters below).
      if (!this.rateFrom) this.rateFrom = nowMs;
      (this.rateWin = this.rateWin || []).push([nowMs, fr.t]);
      while (this.rateWin.length && nowMs - this.rateWin[0][0] > RATE_WINDOW) this.rateWin.shift();
      if (this.startT === null) {
        this.startT = fr.t;
        if (!this.playing) this.pauseT = fr.t;
        // Autoplay anchored the clock at 0 before the start time (TS at 1.4 s, broadcast at 3600 s) was known.
        else if (this.seekTarget === null) { this.pauseT = fr.t; this.stopAudio(); this.anchor(fr.t); }
        if (this.pendingCues) { const p = this.pendingCues; this.pendingCues = null; for (const c of p) if (c.track === this.subId) this.emitCue(c); }
        // A position restored before the start time was known is applied now.
        if (this.pendingSeek !== undefined) {
          const t = this.pendingSeek;
          this.pendingSeek = undefined;
          setTimeout(() => this.seekTime(t), 0);
        }
      }
      this.lastT = fr.t;
      // Accurate seek: keep only the last frame before the target until we reach it.
      if (this.seekTarget !== null) {
        if (typeof this.seekBefore === 'number') {
          // Step back by k pictures: keep every picture strictly before the frame stepped from, newest k held,
          // then land on the k-th last (k = 1 for a single step; dense VFR spacing differs from 1 / fps).
          if (fr.t < this.seekBefore - 1e-4) {
            const run = this.holdRun || (this.holdRun = []);
            run.push(fr);
            if (run.length > (this.seekBackCount || 1)) this.keepBack(run.shift());
            this.hold = run[0];
            return;
          }
          const run = this.holdRun;
          this.pauseT = run && run.length ? run[0].t : fr.t;
          this.insertHold();
          if (this.stepTo && this.stepTo.gen === this.gen && !this.stepTo.timer) this.stepTo.t = this.pauseT;
          this.seekTarget = null;
          this.seekBefore = null;
        } else {
          // Seek targets sit mid-frame; playing, anything starting 3/4 of a frame earlier is a previous frame. Paused,
          // the picture to land on is the one currentFrame() numbers as the target's frame: after a gap in the
          // timestamps (clips joined together) pictures start late in their slots, and one 3/4 of a frame before the
          // target is the previous frame's, so a step forward would show the same picture again.
          const f = 1 / (this.fps || 30);
          const want = this.playing ? 0 : this.frameAt(this.seekTarget);
          const at = this.playing ? (fr.t < this.seekTarget - 0.75 * f ? -1 : fr.t > this.seekTarget + 0.25 * f ? 1 : 0)
            : this.frameAt(fr.t);
          if (at < want) {
            if (this.hold) this.keepBack(this.hold);
            this.hold = fr;
            return;
          }
          if (this.hold && at > want) this.insert(this.hold);
          else {
            if (this.hold) this.keepBack(this.hold);
            // Paused, a picture past the target is the one to show (late in its slot, an exact frame time from the
            // host whose source frame sits a little later, a gap in a variable rate), so the clock moves to it: held
            // at the target, tick would never draw a frame more than a quarter frame ahead of it.
            if (!this.playing && fr.t > this.seekTarget + 0.25 * f) this.pauseT = fr.t;
          }
          this.hold = null;
          this.seekTarget = null;
        }
        // Landed when its picture is drawn (tick), not when decoded: a frame that is never shown is no landing.
        if (this.seekStartMs !== undefined) this.landingGen = this.gen;
        if (!this.playing) this.scheduleFill();
        // The clock waited for the seek (now()); start it at the target.
        if (this.playing) { this.stopAudio(); this.anchor(this.pauseT); }
      }
      this.insert(fr);
      if (this.loopCache && this.keepLoopBytes(fr.yuv ? fr.yuv.data.buffer.byteLength : fr.bytes)) {
        this.loopCache.video.push(fr);
        if (fr.yuv) this.loopCache.buffers.add(fr.yuv.data.buffer);
        // Holding VideoFrames can use up the decoder's surfaces before it reaches EOF.
        else if (!this.noSpill && !fr.spilling) this.toMemory(fr);
      }
      if (!this.playing || this.remoteReadAhead()) this.spill();
    }

    /**
     * Open WebCodecs frames: the queue, the frame held during an accurate seek and the
     * inspector's copy of the shown frame (a clone keeps the decoder's surface too).
     */
    gpuFrames() {
      let n = this.queue.reduce((k, f) => k + (f.vf ? 1 : 0), 0);
      if (this.hold && this.hold.vf) n++;
      if (this.holdRun) for (const x of this.holdRun) if (x !== this.hold && x.vf) n++;
      if (this.lastShown && this.lastShown.vf) n++;
      return n;
    }

    /**
     * When decoding ahead: a hardware decoder has a few output surfaces and stops
     * when they are all held (Edge after ~13 frames). Keep the next GPU_FRAMES frames as
     * they are and copy later ones to memory, which returns their surfaces.
     */
    spill() {
      if (this.noSpill) return;
      let keep = GPU_FRAMES - (this.hold && this.hold.vf ? 1 : 0) - (this.lastShown && this.lastShown.vf ? 1 : 0);
      for (const fr of this.queue) {
        if (!fr.vf || fr.spilling) continue;
        if (keep-- > 0) continue;
        this.toMemory(fr);
      }
    }

    frameMatrix(vf) {
      const v = this.info && this.info.video;
      const tag = v && taggedMatrix(v.colorSpace);
      if (tag) return tag;
      const fallback = matrixBySize(v ? v.width : vf.codedWidth, v ? v.height : vf.codedHeight);
      const frame = taggedMatrix(vf.colorSpace && vf.colorSpace.matrix);
      // A BT.709 frame alone cannot distinguish Chromium's default from a stream tag.
      return frame && frame !== 709 ? frame : fallback;
    }

    /** Matrix of the shown frame, or of the display signal after HDR tone mapping. */
    shownMatrix(display = false) {
      if (display && this.gl.hdr) return 709;
      const s = this.lastShown;
      if (s && s.yuv) return s.yuv.space || matrixBySize(s.yuv.width, s.yuv.height);
      if (s && s.vf) return this.frameMatrix(s.vf);
      const v = this.info && this.info.video;
      return v && taggedMatrix(v.colorSpace) || matrixBySize(v ? v.width : canvas.width, v ? v.height : canvas.height);
    }

    async toMemory(fr) {
      const vf = fr.vf;
      const fmt = vf.format;
      const w = vf.visibleRect ? vf.visibleRect.width : vf.codedWidth;
      const h = vf.visibleRect ? vf.visibleRect.height : vf.codedHeight;
      if ((fmt !== 'I420' && fmt !== 'NV12') || w !== vf.displayWidth || h !== vf.displayHeight) {
        // Opaque, deep or anamorphic: no copy; decoding ahead stops at GPU_FRAMES instead (pump).
        this.noSpill = true;
        log(`frames stay on the GPU (${fmt}, ${w}x${h} shown ${vf.displayWidth}x${vf.displayHeight}); paused read-ahead limited`);
        return;
      }
      fr.spilling = true;
      try {
        const src = new Uint8Array(vf.allocationSize());
        const lay = await vf.copyTo(src);
        if (fr.vf !== vf || vf.format === null) return; // shown or dropped meanwhile
        const { data, layout } = fmt === 'NV12' ? nv12ToI420(src, lay, w, h) : { data: src, layout: lay };
        const cs = vf.colorSpace || {};
        if (this.loopCache?.video.includes(fr)) this.keepLoopBytes(data.byteLength - fr.bytes);
        fr.yuv = { width: w, height: h, data, layout, fullRange: !!cs.fullRange, space: this.frameMatrix(vf) };
        fr.bytes = data.byteLength;
        fr.vf = null;
        vf.close();
      } catch (e) {
        if (vf.format !== null) { this.noSpill = true; log(`frame copy failed: ${e && e.message || e}; paused read-ahead limited`); }
      } finally { fr.spilling = false; }
      wake();
      this.pump();
    }

    insert(fr) {
      const q = this.queue;
      let i = q.length;
      while (i > 0 && q[i - 1].t > fr.t) i--;
      q.splice(i, 0, fr);
    }

    release(fr) { if (fr.vf) fr.vf.close(); }

    /** Decoded sound (planes of float samples; mask: the channel layout, when known). */
    addAudio(t, sampleRate, planes, mask = 0) {
      if (!this.ac || !planes.length || !planes[0].length) return;
      planes = toWebAudio(planes, mask);
      const keep = this.keepLoopBytes(planes.length * planes[0].length * 4);
      // Container times are often rounded to the ms: a chunk within 5 ms of the previous one's end continues it exactly.
      const prev = this.audio[this.audio.length - 1];
      if (prev && Math.abs(t - (prev.t + prev.dur)) < 0.005) t = prev.t + prev.dur;
      // Play's sound is ready once decoded sound covers the play position (notePlayStart), whatever the AudioContext.
      const ps = this.playStart;
      if (ps && ps.soundReadyMs === undefined && t <= ps.from + 0.02 && t + planes[0].length / sampleRate > ps.from + 0.02) {
        ps.soundReadyMs = Math.round(performance.now() - ps.t0);
        this.notePlayStart();
      }
      // Tiny chunks (TrueHD: 40 samples, under a millisecond) join the previous one while it is short
      // and not playing yet: a source node per chunk was 1200 nodes a second.
      if (prev && !prev.src && t === prev.t + prev.dur && prev.dur < 0.05 && prev.buf.sampleRate === sampleRate && prev.buf.numberOfChannels === planes.length) {
        const n0 = prev.buf.length;
        const joined = this.ac.createBuffer(planes.length, n0 + planes[0].length, sampleRate);
        planes.forEach((p, c) => { const d = new Float32Array(n0 + p.length); d.set(prev.buf.getChannelData(c)); d.set(p, n0); joined.copyToChannel(d, c); });
        prev.buf = joined;
        prev.dur = joined.duration;
        return;
      }
      const buf = this.ac.createBuffer(planes.length, planes[0].length, sampleRate);
      planes.forEach((p, c) => buf.copyToChannel(p, c));
      const chunk = { t, dur: buf.duration, buf, src: null };
      this.audio.push(chunk);
      if (keep) this.loopCache.audio.push(chunk);
    }

    // ---- flow control -----------------------------------------------------

    pump() {
      if (this.scrubHeldT !== undefined || this.requesting || this.eof || !this.worker || this.vmode === undefined) return;
      if (this.localGen === this.gen) return; // served from the page's packets (seekFromPackets): no producer to ask
      if (this.vReread === this.gen) return; // the worker is rewinding the picture after a decoder error (onVideoReread reads on)
      if (this.stuckGen === this.gen) return; // the decoder failed here again and again (decodeError): a seek or play tries again
      const now = this.now();
      // A paused remote stream can fill its decode cache far past the shown frame and evict
      // that frame's seek history on the host. Leave room in the host's 20 s window for steps back.
      const videoUntil = this.remoteStream && !this.playing ? now + 10 : undefined;
      if (videoUntil !== undefined && this.readVT >= videoUntil) return;
      const vAhead = this.queue.length ? this.queue[this.queue.length - 1].t - now : 0;
      const pending = (this.vdec ? this.vdec.decodeQueueSize : 0);
      // Frames kept for a short loop count too: the queue is a part of them (review 2026-11-19-4 #2).
      // (And the frames kept for steps back.)
      const bytes = Math.max(this.queue.reduce((n, f) => n + f.bytes, 0), this.loopCache ? this.loopCache.bytes : 0) + (this.backBytes || 0);
      const aEnd = this.audio.length ? this.audio[this.audio.length - 1].t + this.audio[this.audio.length - 1].dur : 0;
      // A remote link needs enough headroom for short interruptions. Both GPU frames and copies
      // count against the existing budget. Paused decoding still leaves room for step history.
      const playingAhead = this.remoteReadAhead() ? REMOTE_AHEAD_S : 1;
      const ahead = this.playing ? playingAhead : this.fastDecoder() ? PAUSED_AHEAD_S : 3600;
      // Frames that can't be copied to memory hold the decoder's surfaces: paused, read ahead no further.
      const gpuFull = this.vmode === 'webcodecs' && !this.playing && this.noSpill && this.gpuFrames() + pending >= GPU_FRAMES;
      // (Only decoded frames count: a hardware decoder can hold the packets it was given until it gets more,
      // so counting those as read ahead stalled a paused step forward.)
      const needV = this.vmode !== 'none' && (this.queue.length + pending < 8 || vAhead < ahead) && bytes < this.budget() && pending < 30 && !gpuFull;
      // Sound that ended early, has a gap or lost its decoder stops lagging the picture by seconds: don't read on for it.
      // (The picture read since the last seek or rewind: after a track switch re-reads the sound, the
      // picture decoded before it is far ahead without the sound having stalled.)
      const aStalled = this.vmode !== 'none' && this.readVT !== undefined && this.readVT > Math.max(aEnd, now) + 3;
      // WebCodecs sound not out of the decoder yet: Edge's AAC decoder releases it at about real time,
      // so at 2x the reader pushed the whole file's packets in (500+ queued) while the sound ran dry.
      const aInDecoder = this.amode === 'webcodecs' && this.aSubmitT !== undefined ? this.aSubmitT - Math.max(aEnd, now) : 0;
      const needA = this.amode !== 'none' && aEnd - now < 1.5 * Math.max(1, this.rate) && !aStalled && aInDecoder < 2 * Math.max(1, this.rate);
      // After a track switch rewound the demuxer: read on regardless of budget and need until the read passes the playhead again.
      if ((this.catchUp && !this.hidden) || ((needV || needA || this.seekTarget !== null) && bytes < this.budget())) {
        this.requesting = true;
        // Software video decodes a whole batch at once; keep batches small so frames don't pile up.
        // Until the first picture is shown, one packet per batch: the first frame comes back as soon
        // as it is decoded, not with the ~6 after it (1080p HEVC: ~220 -> ~135 ms from the streams to the first frame).
        // Paused WebCodecs reads ~1 s ahead (PAUSED_AHEAD_S): in smaller batches, or one batch of small packets overshoots by seconds.
        // A large compare grid: one packet per batch for the built-in decoder, whose batch becomes full-size frames in every tile.
        const limit = this.vmode === 'soft' ? (this.firstShown && !this.cfg.largeGrid ? 96 * 1024 : 1) : !this.playing && this.firstShown ? 64 * 1024 : 384 * 1024;
        if (this.remoteStream) this.remoteReadAt = performance.now();
        this.worker.postMessage({ type: 'more', gen: this.gen, limit, ...(videoUntil !== undefined ? { videoUntil } : {}) });
      }
    }

    /** Native ffmpeg (also the remote stream) or WebCodecs: decoding much faster than real time (pump's paused read-ahead). */
    fastDecoder() { return !!this.cfg.native || this.vmode === 'webcodecs'; }

    /** Live transcode over a remote link can buffer more once frames can be copied off decoder surfaces. */
    remoteReadAhead() { return this.remoteStream && this.info?.remoteStream?.linkAdaptive && !this.noSpill; }

    // checkJs: start
    /** Override the decoded-frame budget for this tile. @param {number} budget */
    setBudget(budget) { this.frameBudget = budget; }
    // checkJs: end

    /** Memory for decoded frames: ~400 MB on 32 GB (about 130 frames of 1080p, 30 of 4K), less on smaller machines (memFor). */
    budget() { return this.frameBudget ?? (this.hidden ? 0 : this.mem.frames); }

    /** Whether decoded frames span the requested playback position. */
    hasQueuedTime(time, lead) {
      return this.queue[0]?.t <= time + lead && this.queue[this.queue.length - 1].t >= time;
    }

    /** Presentation readiness for lockstep sync, distinct from the idle frame-loop check settled(). */
    syncState() {
      const { startT, shownT, pauseT, seekTarget, eof, gen } = this;
      const fps = this.fps || 30;
      const nextQueuedT = this.queue[0]?.t ?? null;
      const due = pauseT + 0.25 / fps;
      const current = shownT !== null && (!this.shownStale || this.vmode === 'none');
      // A stale picture can pass the time checks below while the queue head is still ahead: never call it settled.
      const ready = seekTarget === null && current && startT !== null;
      return Object.freeze({
        startT, shownT, pauseT, seekTarget, nextQueuedT, eof, gen, fps, shownCount: this.shownCount || 0,
        // Whether the shown picture continues into the queue: false from a seek or jump until its first picture shows.
        current,
        firstFrameReady: ready && shownT === startT && due < startT + 0.75 / fps,
        settled: ready && shownT <= due + 1e-6 && (nextQueuedT === null ? eof : nextQueuedT > due),
      });
    }

    /** A full pass from the start can share its decoded frames with the playback queue. */
    beginLoopCache() {
      const dur = this.meta.duration;
      // Picture subtitles have their own bounded history and can need the worker to read them again.
      const bitmap = this.info?.tracks?.sub?.some((s) => s.id === this.subId && s.kind === 'bitmap');
      if (this.loop && !this.hidden && !this.cfg.native && !this.remoteStream && this.vmode !== 'none'
        && !bitmap && !this.fastUsed && !this.nonRef && !this.noSpill && !this.loopOverBudget && dur > 0 && dur <= 5) {
        this.loopCache = { video: [], audio: [], buffers: new Set(), bytes: 0 };
      }
    }

    keepLoopBytes(bytes) {
      const cache = this.loopCache;
      if (!cache) return false;
      cache.bytes += bytes;
      if (cache.bytes <= this.budget()) return true;
      this.loopCache = null;
      this.loopOverBudget = true;
      return false;
    }

    /** At drained EOF the complete pass can restart without resetting either decoder. */
    restartLoop(now, end) {
      const start = this.startT || 0;
      const cache = this.loopCache;
      if (!cache?.video.length || cache.video.some((fr) => !fr.yuv)) {
        this.seekAbs(start, true);
        return this.now();
      }
      if (!cache.ready) {
        cache.video.sort((a, b) => a.t - b.t);
        cache.ready = true;
        log(`loop: replaying ${cache.video.length} cached frames`);
      }
      // A new generation: compare's followers resync on it (review 2026-11-19-4 #1). The worker is idle at EOF.
      this.gen++;
      this.shownStale = true;
      this.queue = cache.video.slice();
      this.stopAudio();
      for (const a of cache.audio) a.src = null;
      this.audio = cache.audio.slice();
      // Carry the sub-frame overshoot so display ticks don't lengthen every loop.
      const t = start + (now - end) % (end - start);
      this.updateAudioLive(t);
      this.anchor(t);
      return t;
    }

    /**
     * Hidden tab: free the decoded frames and the pool's extra workers, decode nothing; re-seek when shown.
     * Native ffmpeg (and the remote stream) stops in the host while hidden: showing always re-seeks.
     */
    setHidden(h) {
      wake();
      if (h === !!this.hidden || this.vmode === undefined) return;
      this.hidden = h;
      if (h) { this.cancelFill(); this.cancelSharp(); }
      if (h) this.thumbnailLeave(true);
      if (h && this.ac && !this.playing) this.restAudioLater(0);
      // A live stream (Open Video URL…) can't seek back to where it was: its ffmpeg keeps running.
      const stopNative = this.cfg.native && !this.meta.live;
      if (!this.cfg.native || stopNative) this.worker.postMessage({ type: 'hidden', on: h });
      if (h && stopNative) this.resyncOnShow = true;
      if (h) this.dropBack();
      if (h && (this.queue.length || this.loopCache)) {
        this.loopCache = null;
        for (const f of this.queue) this.release(f);
        this.queue = [];
        this.resyncOnShow = true;
      } else if (!h && this.resyncOnShow) {
        this.resyncOnShow = false;
        // Native: frames still in flight when the tab was hidden must not stand in for the seek that restarts ffmpeg.
        if (this.cfg.native) { for (const f of this.queue) this.release(f); this.queue = []; }
        this.seekTime(this.rel(this.shownT !== null ? this.shownT : this.pauseT));
      }
    }

    queuedBytes() { return this.queue.reduce((n, f) => n + f.bytes, 0); }

    /**
     * Nothing will change without an outside event (env.wake, or the page's input): paused with no
     * seek, read or decode under way and no frame due, or hidden. The page's frame loop may rest then.
     */
    settled() {
      if (this.disposed || this.hidden) return true;
      if (this.vmode === undefined || this.playing || this.seekTarget !== null || this.requesting || this.catchUp || this.skipping) return false;
      if (!this.firstShown && !this.eof) return false;
      // Packets waiting in a WebCodecs decoder don't count: its outputs and 'dequeue' events wake the page
      // (a paused hardware decoder can hold dozens of them until frames are released).
      if (this.queue.some((f) => f.spilling)) return false;
      return !(this.queue.length && this.queue[0].t <= this.now() + 0.25 / (this.fps || 30));
    }

    /**
     * Decode speed over the last RATE_WINDOW ms (or since the last seek, when sooner), at the
     * time of asking: frames that arrive in a burst (a software batch) count over the whole span,
     * and a decoder that stops delivering decays towards 0. Null with under 0.5 s to go by.
     * The old rate, (frames - 1) / (newest - oldest arrival), read 8666x for a burst of frames
     * a millisecond apart and Infinity for frames in the same millisecond.
     */
    rateSpan() {
      const t = performance.now();
      const w = this.rateWin || [];
      while (w.length && t - w[0][0] > RATE_WINDOW) w.shift();
      const span = this.rateFrom ? Math.min(RATE_WINDOW, t - this.rateFrom) / 1000 : 0;
      return span >= 0.5 ? { w, span } : null;
    }
    /** Frames decoded per second. */
    get decodeRate() { const r = this.rateSpan(); return r ? r.w.length / r.span : null; }
    /** Media seconds decoded per second (frame times can be sparse: non-reference frames dropped). */
    get mediaRate() {
      const r = this.rateSpan();
      if (!r) return null;
      if (r.w.length < 2) return r.w.length / Math.max(1, this.fps || 30) / r.span;
      let lo = Infinity; let hi = -Infinity;
      for (const [, t] of r.w) { if (t < lo) lo = t; if (t > hi) hi = t; }
      return (hi - lo + 1 / (this.fps || 30)) / r.span;
    }
    /** Starts the decode-speed measurement over (seeks, keyframe skips). */
    resetRate() { this.rateWin = []; this.rateFrom = performance.now(); }

    /** Measure delivery only while reads are outstanding, and buffer over the whole playback window. */
    sampleRemoteLink(nowMs, now) {
      if (!this.playing || this.rate !== 1 || this.hidden || this.seekTarget !== null || this.remoteVideoEnd) {
        this.remoteWindow = null;
        return;
      }
      const w = this.remoteWindow || (this.remoteWindow = {
        eligibleSince: nowMs, start: nowMs, last: nowMs, readMs: 0, hostWaitMs: 0, frames: 0, bytes: 0, videoBytes: 0, lowMs: 0, bufferMs: 0,
      });
      const ahead = this.queue.length ? Math.max(0, this.queue[this.queue.length - 1].t - now) : 0;
      const dt = nowMs - w.last;
      if (ahead < 0.2) w.lowMs += dt;
      w.bufferMs += ahead * dt;
      w.last = nowMs;
      const span = nowMs - w.start;
      if (span < 2000) return;
      const fps = this.info.remoteStream.fps;
      const mediaMs = w.frames * 1000 / fps;
      const decodeFps = this.decodeRate;
      this.worker.postMessage({
        type: 'remoteLink', gen: this.gen,
        // The per-tab test throttle does not measure the window's shared link.
        debugRate: this.debugRemoteRate !== undefined,
        // Link speed: the read time without the time the host waited for its ffmpeg.
        kbps: w.readMs - w.hostWaitMs > 0 ? w.bytes * 8 / (w.readMs - w.hostWaitMs) : 0,
        readMs: w.readMs, hostWaitMs: w.hostWaitMs,
        videoKbps: mediaMs ? w.videoBytes * 8 / mediaMs : 0,
        mediaRate: mediaMs / span, buffer: w.bufferMs / span, starved: w.lowMs > span * 0.6,
        behind: this.behindUntil > nowMs && decodeFps !== null && decodeFps < 0.9 * fps,
      });
      // A read spanning two windows is charged once, when it arrives.
      Object.assign(w, { start: nowMs, readMs: 0, hostWaitMs: 0, frames: 0, bytes: 0, videoBytes: 0, lowMs: 0, bufferMs: 0 });
    }

    /** What the status pill shows: decode speed, what's buffered, behind or not. */
    status() {
      const now = performance.now();
      if (this.vmode === undefined) return null;
      // Decode speed: decoded frames per wall-clock second vs the video's frame rate.
      const rate = this.decodeRate;
      const ratio = rate !== null && this.fps ? rate / this.fps : null;
      const ahead = this.queue.length ? this.rel(this.queue[this.queue.length - 1].t) - this.currentTime() : 0;
      const behind = this.behindUntil && now < this.behindUntil;
      // Decoder reached the end with nothing in flight: stays true until the next seek.
      if (this.eof && !(this.vdec && this.vdec.decodeQueueSize) && this.seekTarget === null) {
        return { text: 'Fully decoded', level: 'ok', title: 'The rest of the video is decoded and in memory: playback and stepping are instant.' };
      }
      // Live transcode adapts through ABR (shown in the Live chip) and never frame-skips, so local-decoder
      // slow-playback notices ("Skip frames (all videos)") do not apply to it.
      if (behind && !this.remoteStream) {
        const r = ratio !== null ? speedText(ratio) : 'slow';
        const mediaRatio = this.nonRef ? this.mediaRate : ratio;
        const offerSetup = !this.cfg.native && this.ffmpeg?.offer;
        if (offerSetup && mediaRatio !== null && mediaRatio < SETUP_NOTICE_RATIO) {
          return { text: `Decoding ${speedText(mediaRatio)} · Set up ffmpeg`, level: 'warn', slowNotice: 'setupFfmpeg' };
        }
        if (this.autoEvery && this.whenSlow === 'skip') {
          return { text: `Decoding ${r} · slowed down`, level: 'warn', slowNotice: 'autoEvery' };
        }
        if (this.fast) return { text: `Decoding ${r} · fast preview`, level: 'warn', slowNotice: 'fast' };
        return this.whenSlow === 'every'
          ? { text: `Decoding ${r} · every frame`, level: 'warn', slowNotice: 'every' }
          : { text: `Decoding ${r} · skipping`, level: 'warn', slowNotice: 'skip' };
      }
      if (!this.playing && ahead > 0.5) return { text: `${ahead.toFixed(1)} s decoded ahead`, level: 'info', title: 'Decoding ahead while paused.' };
      // Keeping up: decoding only runs about a second ahead, so its speed reads ~1x and says nothing. Stay quiet.
      if (this.playing || !ratio) return null;
      return { text: `Decoding ${speedText(ratio)}`, level: 'info', title: 'Decode speed relative to real time.' };
    }

    /**
     * Decode speed samples for the extension (per-machine speed records, the hint to set up
     * ffmpeg when the built-in decoder can't keep up, and the offer of the GPU test when playback
     * is behind with ffmpeg installed; native samples say native: true). One sample per ~3 s of plain
     * playback (1x, shown, no seek in between): slow when it was behind real time nearly
     * all that time, real time when never behind; mixed windows (a seek blip) say nothing.
     */
    sampleSpeed(nowMs) {
      const v = this.info && this.info.video;
      const eligible = v && this.vmode !== undefined && this.vmode !== 'none' && this.playing && this.rate === 1 &&
        !this.hidden && this.seekTarget === null && !this.eof && this.startT !== null && !this.skipping;
      if (!eligible) { this.spWin = null; this.spSince = 0; return null; }
      if (!this.spSince) this.spSince = nowMs;
      if (nowMs - this.spSince < SPEED_WARMUP_MS) return null; // decoders and pool workers starting up
      const behind = !!(this.behindUntil && nowMs < this.behindUntil);
      const w = this.spWin || (this.spWin = { t0: nowMs, last: nowMs, behindMs: 0 });
      if (behind) w.behindMs += nowMs - w.last;
      w.last = nowMs;
      const span = nowMs - w.t0;
      if (span < SPEED_SAMPLE_MS) return null;
      this.spWin = null;
      const frac = w.behindMs / span;
      const ratio = this.nonRef ? this.mediaRate : this.decodeRate && this.fps ? this.decodeRate / this.fps : null;
      let s = null;
      if (frac >= 0.8 && ratio > 0 && ratio < 1) s = { realtime: false, ratio: Math.round(ratio * 1000) / 1000 };
      else if (frac === 0) s = { realtime: true, ratio: 1 };
      if (!s) return null;
      const sample = {
        type: 'decodeSpeed', codec: v.codec, depth: v.depth || 8, width: v.width, height: v.height, fps: this.fps, vmode: this.vmode,
        playing: !!this.playing, rate: this.rate, hidden: !!this.hidden, sinceEventMs: Math.round(nowMs - this.spSince),
        ...(this.cfg.native ? { native: true } : {}), ...(this.remoteStream ? { remoteStream: true } : {}), ...s,
      };
      vscode.postMessage(sample);
      return sample;
    }

    setWhenSlow(value) {
      this.whenSlow = value;
      this.autoEvery = false;
      if (this.nonRef) this.setNonRef(false);
      this.skipLog = [];
      toast(this.whenSlow === 'every' ? 'When slow: show every frame' : 'When slow: skip frames, keep time');
    }

    // ---- clock ------------------------------------------------------------

    /** Audio drives the clock at 1x, and at 0.25x-4x through the pitch-keeping time stretch. */
    canStretch(r) { return r === 1 || (r >= 0.25 && r <= 4 && !!globalThis.TimeStretch); }
    /**
     * The sound is the clock only while it actually plays: an AudioContext that runs with
     * nothing scheduled (a decoder that produces no sound, or sound that ran dry while the
     * picture decodes far slower than real time: 4K VVC + TrueHD 5.1) let the clock run on past
     * a frozen picture, dropping the sound it passed, and snap back by 10+ s when a frame came.
     * Without sound the clock is the timer (see audioLive), which waits for the picture (tick).
     */
    audioMaster() { return !!(this.ac && !this.acWaking && this.ac.state === 'running' && this.canStretch(this.rate) && this.amode !== 'none' && this.audioLive); }

    /**
     * Sound is flowing: sources are scheduled, or decoded sound covers the playhead (it is
     * scheduled this tick). It stops flowing after AUDIO_DRY_MS without either, so a short gap
     * between decoder outputs doesn't flip the clock back and forth.
     */
    updateAudioLive(now) {
      if (this.amode === 'none' || !this.ac) { this.audioLive = false; return; }
      const t = performance.now();
      const covered = this.sources.size > 0 || this.audio.some((a) => a.t <= now + 0.1 && a.t + a.dur > now);
      if (covered) { this.audioLive = true; this.audioLiveAt = t; } else if (this.audioLive && t - this.audioLiveAt > AUDIO_DRY_MS) this.audioLive = false;
      if (this.playing && this.anchoredOnAudio !== this.audioMaster()) this.anchor(now);
    }

    // checkJs: start
    /** Follow an external media clock during playback. Null resumes the engine's own clock.
     * @param {(() => number) | null} clockFn
     */
    setFollowerMode(clockFn) {
      if (clockFn === this.followerClock) return;
      const time = this.playing ? this.now() : this.pauseT;
      this.followerClock = clockFn;
      if (clockFn) {
        this.loopCache = null;
        this.behindUntil = 0;
        this.waitPic = false;
      }
      if (this.playing) this.holdAt(clockFn ? clockFn() : time);
    }

    /** Restart sound and anchor the local clock at an absolute media timestamp. @param {number} mediaTime */
    holdAt(mediaTime) {
      this.stopAudio();
      this.anchor(mediaTime);
    }

    /** Move the paused playhead without discarding decoded frames. @param {number} mediaTime */
    retargetPaused(mediaTime) {
      if (!this.playing) this.pauseT = mediaTime;
    }
    // checkJs: end

    /**
     * Why the playhead is where it is, in one place (now(), tick() and audioMayRun() read this instead of each
     * repeating the booleans). Order matters: the first match wins.
     *  scrubbing: the seek bar holds a picture; paused: not playing; playing: the clock advances (a follower
     *  tile's clock is its leader's); loading: no picture yet (opening, autoplay); seeking: an accurate seek holds
     *  the clock until its frame is decoded (a slow seek is not "behind"); waking: the audio context is resuming.
     *  Sound-only files (vmode 'none') are never loading or seeking.
     * @returns {'scrubbing' | 'paused' | 'loading' | 'seeking' | 'waking' | 'playing'}
     */
    playbackPhase() {
      if (this.scrubHeldT !== undefined) return 'scrubbing';
      if (!this.playing) return 'paused';
      if (this.followerClock) return 'playing';
      if (this.shownT === null && this.vmode !== 'none') return 'loading';
      if (this.seekTarget !== null && this.vmode !== 'none') return 'seeking';
      if (this.acWaking) return 'waking';
      return 'playing';
    }

    /** True while now() advances; every other phase holds it at pauseT (or scrubHeldT). */
    clockRunning() { return this.playbackPhase() === 'playing'; }

    /** Sound may be queued: the clock runs, or only the audio context is still waking (not loading or seeking). */
    audioMayRun() {
      const phase = this.playbackPhase();
      if (phase === 'waking') return true;
      // A follower's clock is its leader's: its own pending seek never held sound back.
      return phase === 'playing' && !(this.followerClock && this.seekTarget !== null && this.vmode !== 'none');
    }

    now() {
      const phase = this.playbackPhase();
      if (phase === 'scrubbing') return this.scrubHeldT;
      if (phase === 'paused') return this.pauseT;
      if (this.followerClock) return this.followerClock();
      if (phase !== 'playing') return this.pauseT;
      const elapsed = this.anchoredOnAudio ? this.ac.currentTime - this.anchorAc
        : (performance.now() - this.anchorPerf) / 1000;
      const time = this.anchorMedia + elapsed * this.rate;
      return this.remoteStream && !this.hidden && !this.eof && !this.queue.length && this.shownT !== null
        ? Math.min(time, this.remotePictureLimit()) : time;
    }

    remotePictureLimit() { return this.shownT + Math.max(0.15, 1 / (this.fps || 30)); }

    anchor(t) {
      this.anchorMedia = t;
      this.anchorPerf = performance.now();
      this.anchorAc = this.ac ? this.ac.currentTime : 0;
      this.anchoredOnAudio = this.audioMaster();
      // Every stopAudio() is followed by an anchor(): restart the stretcher at the playhead.
      if (this.ts) this.ts.reset();
      this.tsWhen = null;
      this.tsCursor = t;
    }

    stopAudio() {
      for (const s of this.sources) { try { s.stop(); } catch { /* already stopped */ } }
      this.sources.clear();
      for (const a of this.audio) a.src = null;
    }

    scheduleAudio(now) {
      if (!this.audioMaster()) return;
      const ac = this.ac;
      while (this.audio.length && this.audio[0].t + this.audio[0].dur < now - 0.5) this.audio.shift();
      if (this.rate !== 1) return this.scheduleStretched();
      for (const a of this.audio) {
        if (a.src || a.t + a.dur <= now) continue;
        if (a.t > now + 1.0) break;
        const when = this.anchorAc + (a.t - this.anchorMedia);
        const src = ac.createBufferSource();
        src.buffer = a.buf;
        src.connect(this.gain);
        if (when < ac.currentTime) src.start(ac.currentTime, Math.min(a.dur, ac.currentTime - when));
        else src.start(when);
        src.onended = () => this.sources.delete(src);
        this.sources.add(src);
        a.src = src;
        const ps = this.playStart;
        if (ps && this.playing && ps.soundMs === undefined) {
          ps.soundMs = Math.round(performance.now() - ps.t0);
          ps.soundFromS = Math.max(a.t, now) - ps.from; // sound before this was never heard
          this.notePlayStart();
        }
      }
    }

    /** Play got going: the picture moves and (with sound) the sound plays. Logged once, kept for the debug probe. */
    notePlayStart() {
      const ps = this.playStart;
      if (!ps || ps.pictureMs === undefined) return;
      // Waits for the sound to be ready from the play position; heard (soundMs) only with a running AudioContext.
      // No sound 3 s after the picture moved (sound that never came): logged without it.
      if (ps.sound && (ps.soundReadyMs === undefined || (ps.soundMs === undefined && this.ac.state === 'running')) && !ps.late) {
        if (!ps.timer) ps.timer = setTimeout(() => { if (this.playStart === ps) { ps.late = true; this.notePlayStart(); } }, 3000);
        return;
      }
      clearTimeout(ps.timer);
      this.playStart = null;
      this.playStats = { from: ps.from, pictureMs: ps.pictureMs, soundReadyMs: ps.soundReadyMs, soundMs: ps.soundMs, soundFromS: ps.soundFromS };
      const ready = ps.soundReadyMs !== undefined ? `, sound ready after ${ps.soundReadyMs} ms` : ps.sound ? ', no sound from the start' : '';
      log(`play from ${this.rel(ps.from).toFixed(3)} s: picture moving after ${ps.pictureMs} ms${ready}`
        + `${ps.soundMs !== undefined ? `, heard after ${ps.soundMs} ms from ${ps.soundFromS.toFixed(3)} s past the start`
          : ps.sound ? ` (AudioContext ${this.ac ? this.ac.state : 'none'})` : ''}`);
    }

    /** Rates other than 1x: decoded chunks go through one TimeStretch, output plays back to back. */
    scheduleStretched() {
      const ac = this.ac;
      const r = this.rate;
      for (;;) {
        if (this.tsWhen !== null && this.tsWhen > ac.currentTime + 0.5) break;
        const a = this.audio.find((x) => x.t + x.dur > this.tsCursor + 1e-6);
        if (!a) break; // wait for decoding
        const sr = a.buf.sampleRate;
        const ch = a.buf.numberOfChannels;
        if (!this.ts || this.ts.sampleRate !== sr || this.ts.channels !== ch) {
          this.ts = new globalThis.TimeStretch({ channels: ch, sampleRate: sr });
          this.tsWhen = null;
        }
        // A real gap in the sound: restart the stretcher and place the chunk by the clock.
        if (a.t > this.tsCursor + 0.005 && this.tsWhen !== null) { this.ts.reset(); this.tsWhen = null; }
        this.ts.setRate(r);
        // The first chunk after a reset starts at the playhead, not at the chunk start.
        const skip = Math.max(0, Math.round((this.tsCursor - a.t) * sr));
        const planes = [];
        for (let c = 0; c < ch; c++) planes.push(a.buf.getChannelData(c).subarray(skip));
        const out = this.ts.push(planes, a.t + skip / sr);
        this.tsCursor = a.t + a.dur;
        const n = out.planes.length ? out.planes[0].length : 0;
        if (!n) continue;
        const buf = ac.createBuffer(ch, n, sr);
        out.planes.forEach((p, c) => buf.copyToChannel(p, c));
        // First output placed by the media clock; afterwards strictly back to back (no clicks).
        const when = this.tsWhen !== null ? this.tsWhen : this.anchorAc + (out.time - this.anchorMedia) / r;
        const src = ac.createBufferSource();
        src.buffer = buf;
        src.connect(this.gain);
        if (when < ac.currentTime) src.start(ac.currentTime, Math.min(buf.duration, ac.currentTime - when));
        else src.start(when);
        src.onended = () => this.sources.delete(src);
        this.sources.add(src);
        this.tsWhen = when + n / sr;
      }
    }

    // ---- presentation ---------------------------------------------------------

    tick(_wallTime, loopRange) {
      if (this.scrubHeldT !== undefined || this.vmode === undefined) return;
      this.updateAudioLive(this.now());
      this.checkAudioLag();
      let now = this.now();
      // Re-anchor when the clock source changes (audio started, rate changed).
      if (this.playing && this.anchoredOnAudio !== this.audioMaster()) { this.anchor(now); }
      const limit = !this.followerClock && this.playing && this.seekTarget === null && loopRange ? loopRange.end + 1e-6 : Infinity;
      if (limit !== Infinity && (!this.queue.length || this.queue[0].t > limit)) {
        // Present B before wrapping, even when the next picture is already due after a delayed tick.
        const next = this.queue[0]?.t ?? (this.eof && this.lastT !== undefined
          ? Math.max(limit, this.lastT + 1 / (this.fps || 30)) : Infinity);
        if (now >= next) {
          this.seekAbs(loopRange.start, true);
          return;
        }
      }
      const end = this.startT !== null && this.meta.duration ? this.startT + this.meta.duration : Infinity;
      if (this.playing && this.eof && !this.queue.length && now >= this.endT() && this.seekTarget === null) {
        // The data ran out well before the length the file declares (a cut-off recording, a lost tail): not its end.
        if (this.shortOfEnd(this.endT())) this.stopped(this.endT(), 'the data ends before the length the file declares');
        else if (this.loop && this.loopAgain()) now = this.restartLoop(now, this.endT()); else this.ended(this.endT());
      } else if (this.playing && now > end + 0.5 && !this.queue.length && (this.eof || now > end + 1.5)) {
        // Past the end with nothing left to show (also when a skip overshot the last keyframe).
        // Without the decoder's or transport's end of file (a stalled native or remote feed) it pauses all the same, but
        // the report is not "played into the end": Autoplay must not move on to another file.
        if (this.loop && this.loopAgain()) this.seekAbs(this.startT || 0, true); else this.ended(end, !!this.eof);
      }
      // Every frame (no sound driving the clock) or a starved remote Live transcode stream (network blackout):
      // hold the clock at the next frame's time instead of running on past the frozen picture and snapping back.
      const remoteStarved = this.remoteStream && !this.queue.length && !this.eof
        && now >= this.remotePictureLimit();
      const localStarved = !this.remoteStream && !this.audioMaster() && (this.whenSlow === 'every' || this.autoEvery)
        && !this.queue.length && !this.eof && now > this.shownT + (this.waitPic ? 1 / (this.fps || 30) : 0.25);
      if (!this.followerClock && this.playing && this.vmode !== 'none'
        && this.seekTarget === null && this.shownT !== null && !this.hidden && (remoteStarved || localStarved)) {
        if (!this.waitPic) { this.waitPic = true; if (!this.slowWarned) log(`waiting for the picture at ${this.rel(this.shownT).toFixed(2)} s (${remoteStarved ? 'remote stream buffering' : 'no sound drives the clock'})`); }
        if (remoteStarved) this.stopAudio();
        else this.behindUntil = performance.now() + 3000;
        this.reanchorCount = (this.reanchorCount || 0) + 1;
        this.anchor(remoteStarved ? now : this.shownT + 1 / (this.fps || 30));
        now = this.now();
      } else if (this.queue.length) this.waitPic = false;
      // Before the first picture the clock holds (now()): sound starts with it.
      const firstPending = this.playbackPhase() === 'loading';
      if (firstPending && this.seekTarget === null && this.queue.length && !this.queue[0].spilling && this.queue[0].t > now) {
        // The first decoded picture starts after the held time (a seek target between frames): start there.
        this.pauseT = this.queue[0].t;
        this.anchor(this.pauseT);
        now = this.pauseT;
      }
      if (this.audioMayRun() && !(this.remoteStream && this.waitPic)) this.scheduleAudio(now);
      // Drop sound that is already behind the playhead (also when audio isn't playing).
      while (this.audio.length && this.audio[0].t + this.audio[0].dur < now - 0.5 && !this.audio[0].src) this.audio.shift();
      // Show the newest frame that is due; drop older ones.
      let show = null;
      // Frames are due a quarter frame early at most, so a mid-frame target shows exactly that frame.
      let early = 0.25 / (this.fps || 30);
      // A paused step shows exactly its picture: a quarter frame of nominal lead would also take the next one when
      // the stream is denser than its nominal rate (120 fps inside 24 fps). Only rounded-ms timestamps get slack.
      const st = this.stepTo;
      if (!this.playing && st && st.gen === this.gen && !st.timer && this.seekTarget === null
        && Math.abs(st.t - this.pauseT) < 1e-4) early = Math.min(early, 1e-3);
      // Showing every frame while decoding is behind: never drop, take the oldest due one.
      const everyFrame = this.playing && (this.whenSlow === 'every' || this.autoEvery) && this.behindUntil && performance.now() < this.behindUntil;
      // ...unless frames are decoded past the clock: then the display, not decoding, is slow (120 fps on 60 Hz), so drop to the newest due one.
      const decodedAhead = this.queue.length && this.queue[this.queue.length - 1].t > now + early;
      // A frame being copied waits for the shader to display it with the chosen matrix.
      while (this.queue.length && this.queue[0].t <= Math.min(now + early, limit) && !this.queue[0].spilling) {
        if (show) { if (this.playing) this.release(show); else this.keepBack(show); this.dropped = (this.dropped || 0) + 1; }
        show = this.queue.shift();
        if (everyFrame && !decodedAhead) break;
      }
      if (show) {
        if (this.playing && now - show.t > 1 / (this.fps || 30)) this.late = (this.late || 0) + 1;
        // Decoding can't keep up (e.g. 4K HEVC in WebAssembly): let the clock wait for
        // the picture instead of running away, so playback slows down but stays whole.
        if (!this.followerClock && this.playing && now - show.t > 0.25 && this.vmode !== 'none') {
          this.behindUntil = performance.now() + 3000;
          if (!this.slowWarned) {
            this.slowWarned = true;
            log(`decoding behind real time at ${this.rel(show.t).toFixed(2)} s (${this.whenSlow})`);
            if (!this.cfg.native && !(this.ffmpeg && this.ffmpeg.installed)) toast('Slower than real time here. Optional ffmpeg decodes this on the GPU.');
          }
          // Skipping only helps when decoding is nearly real time. Far below that (4K in
          // WebAssembly at 0.4x, keyframes seconds apart) every jump lands too late: show
          // every frame instead and say so.
          const recentSkips = (this.skipLog || []).filter((x) => performance.now() - x < 6000).length;
          // Decode speed in media time: with non-reference frames dropped, fewer frames cover the same time.
          const speed = this.nonRef ? this.mediaRate : this.decodeRate && this.fps ? this.decodeRate / this.fps : undefined;
          // Repeated keyframe seeks flush the stream's buffers while the link is already starved.
          // A remote stream's late frames are a link or encoder stall, not slow decoding: it never
          // keyframe-skips (below) and doesn't switch to showing every frame for good, which would
          // stop and restart the sound on every stall.
          const tooSlow = !this.remoteStream && ((speed !== undefined && speed !== null && speed < 0.75) || recentSkips >= 3);
          if (this.whenSlow === 'skip' && tooSlow && !this.autoEvery) {
            this.autoEvery = true;
            log('skipping does not keep up; showing every frame instead');
          }
          // Skipping: first stop decoding non-reference frames (B-frames mostly), then jump to keyframes.
          if (this.whenSlow === 'skip' && !this.autoEvery && this.vmode === 'soft' && !this.nonRef) this.setNonRef(true);
          if (this.nonRef && (this.whenSlow !== 'skip' || this.autoEvery)) this.setNonRef(false);
          // Opt-in fast preview: the picture is approximate while playing behind; exact again when paused.
          if (this.cfg.fastWhenBehind && !this.fast && this.vmode === 'soft' && this.info && this.info.video && FAST_CODECS.has(this.info.video.codec)) this.setFast(true);
          if (this.whenSlow === 'every' || this.autoEvery) {
            // Show every frame: the clock waits for the picture.
            this.stopAudio();
            this.reanchorCount = (this.reanchorCount || 0) + 1;
            this.anchor(show.t);
            now = show.t;
          } else if (!this.remoteStream && now - show.t > 0.6 && !this.skipping && !(this.nonRef && performance.now() - this.nonRefAt < 2000)) {
            // Keep time: jump the decoder to the next keyframe after where the clock will be.
            this.skipTo(now + Math.min(2, 0.4 + (now - show.t) * 0.5));
          }
        }
        this.noteShown(show);
        if (!this.firstShown && this.cfg.native) mark('nativeDraw');
        if (this.remoteStream) {
          const width = show.vf ? show.vf.displayWidth : show.yuv.width;
          const height = show.vf ? show.vf.displayHeight : show.yuv.height;
          if (this.meta.width !== width || this.meta.height !== height) {
            this.meta.width = width;
            this.meta.height = height;
            env.onMeta(this);
          }
        }
        if (show.vf) {
          this.gl.drawFrame(show.vf);
          show.vf.close();
        } else this.gl.drawYuv(show.yuv);
        this.captureThumb(show.t);
        this.shownT = show.t;
        this.shownStale = false;
        this.shownCount = (this.shownCount || 0) + 1;
        if (this.landingGen === this.gen && this.seekTarget === null) {
          this.landingGen = undefined;
          this.lastSeekMs = performance.now() - this.seekStartMs; // seek to its frame shown
          log(`seek landed in ${Math.round(this.lastSeekMs)} ms (gen ${this.gen})`);
        }
        const ps = this.playStart;
        if (ps && this.playing && ps.pictureMs === undefined && show.t > ps.from + 0.5 / (this.fps || 30)) {
          ps.pictureMs = Math.round(performance.now() - ps.t0);
          this.notePlayStart();
        }
        // Another picture: a sharp one asked for the last is no longer wanted; paused, this one may become sharp.
        if (this.remoteStream) { if (this.playing) this.cancelSharp(); else this.scheduleSharp(); }
        // The clock held for this first picture (now()): it runs from here, not from when playback was asked for.
        if (firstPending) { this.stopAudio(); this.anchor(now); }
        if (!this.firstShown) {
          this.firstShown = true;
          showMessage('');
          log(`first frame shown at ${show.t.toFixed(3)} s`);
          if (this.cfg.debug || env.debug) { mark('firstFrame'); log(`startup ${JSON.stringify(startupTimeline())}`); }
          vscode.postMessage({ type: 'playing' });
        }
      }
      if (this.vmode === 'none' && this.playing) this.shownT = now;
      // Sound only (no picture stream, or none we can decode): ready once sound is decoded.
      if (this.vmode === 'none' && !this.firstShown && (this.audio.length || this.eof)) {
        this.firstShown = true;
        if (!(this.info && this.info.video)) showMessage('');
        log(`sound ready at ${this.rel(now).toFixed(3)} s (no picture)`);
        vscode.postMessage({ type: 'playing' });
      }
      // Caught up for a while: decode every frame again (longer each time it falls behind soon after).
      if (this.nonRef && (!this.behindUntil || performance.now() > this.behindUntil + (this.nonRefHold || 5000))) this.setNonRef(false);
      if (this.fast && (!this.behindUntil || performance.now() > this.behindUntil + 5000)) this.setFast(false);
      this.sampleSpeed(performance.now());
      if (this.remoteStream) this.sampleRemoteLink(performance.now(), now);
      this.pump();
    }

    /**
     * Pixel inspector and stats (inspect.js): the last shown frame. Soft frames are
     * referenced as they are; a GPU frame is cloned (one more frame on top of the queue).
     */
    noteShown(show) {
      if (this.lastShown && this.lastShown.vf) this.lastShown.vf.close();
      this.shownFmt = show.vf ? show.vf.format : null;
      this.lastShown = show.yuv ? { yuv: show.yuv } : show.vf ? { vf: show.vf.clone() } : null;
      this.shownFrame = show.yuv && !show.vf ? show : null; // stepFrame can hand it back to the queue or keepBack
    }

    /**
     * Playback reached the end with loop off: pause on the last frame and tell the page (Autoplay). `natural`: it ran
     * into the end (visible, at least MIN_RUN since the last play or seek), not a seek or skip that landed there, and
     * `terminal`: the end of file came from the decoder or transport, not from the clock passing the declared duration.
     */
    ended(at, terminal = true) {
      const ran = Number.isFinite(this.runFromT) ? at - this.runFromT : Infinity;
      const hidden = !!this.hidden;
      this.pause();
      const ranIn = typeof VpeAutoplay !== 'undefined' ? VpeAutoplay.natural({ playing: true, ran, hidden }) : !hidden && ran >= 0.25;
      onEnded(this, { natural: ranIn && terminal, ran, terminal });
    }

    /**
     * The file declares more after `at` than a rounding of its last frame (2 frames, at least 0.5 s): its data ended
     * early. An unknown or zero length says nothing, so that end counts as the end.
     */
    shortOfEnd(at) {
      const d = this.meta.duration;
      if (!(d > 0)) return false;
      return at < (this.startT || 0) + d - Math.max(2 / (this.fps || 30), 0.5);
    }

    /**
     * Decoding stopped before the end of the file (its data ends early, or the decoder fails at one spot): pause on
     * the last picture and tell the page, which says so and offers to try again. Not an end: Loop and Autoplay do
     * not act on it.
     */
    stopped(at, why) {
      const ran = Number.isFinite(this.runFromT) ? at - this.runFromT : Infinity;
      this.pause();
      const t = Math.max(0, at - (this.startT || 0));
      log(`decoding stopped at ${t.toFixed(3)} s${this.meta.duration ? ` of ${this.meta.duration.toFixed(3)} s` : ''}: ${why}`);
      onEnded(this, { natural: false, stopped: true, ran, terminal: false, t });
    }

    /**
     * A read or decode failed in the worker. Errors in a row at one spot (no new generation, nothing read since) are
     * counted: after DECODE_TRIES, playback stops there (stopped) and the worker is not asked again until a seek or
     * play. Returns true when the error was handled (and logged, or kept out of the log once stopped).
     */
    decodeError(m) {
      const spot = `${this.gen}:${this.readVT}`;
      this.decodeErrors = this.decodeErrors && this.decodeErrors.spot === spot ? { spot, n: this.decodeErrors.n + 1 } : { spot, n: 1 };
      this.requesting = false;
      if (this.stuckGen === this.gen) return true;
      log(`worker ${m.where} error: ${m.message}`);
      if (this.decodeErrors.n < DECODE_TRIES) return true;
      this.stuckGen = this.gen;
      this.stopped(this.shownT ?? this.now(), `the decoder failed ${this.decodeErrors.n} times here`);
      return true;
    }

    /** End of what was decoded: the last frame's end or the end of the sound, whichever is later. */
    endT() {
      const a = this.audio[this.audio.length - 1];
      const v = this.lastT !== undefined ? this.lastT + 1 / (this.fps || 30) : -Infinity;
      return Math.max(v, a ? a.t + a.dur : -Infinity, this.startT || 0);
    }

    /** Loop only when something was shown or heard since the last loop: a file that never decodes would loop for ever. */
    loopAgain() {
      const shown = this.shownCount || 0;
      const again = shown > (this.loopMark || 0) || this.audio.length > 0;
      this.loopMark = shown;
      return again;
    }

    setNonRef(on) {
      if (on) this.loopCache = null;
      const t = performance.now();
      if (on && this.nonRefOffAt && t - this.nonRefOffAt < 5000) this.nonRefHold = Math.min(60000, (this.nonRefHold || 5000) * 2);
      this.nonRef = on;
      if (on) this.nonRefUsed = true;
      this.nonRefAt = t;
      if (!on) this.nonRefOffAt = t;
      log(on ? 'behind: not decoding non-reference frames' : 'caught up: decoding every frame again');
      this.worker.postMessage({ type: 'skipNonRef', on });
    }

    /** Fast preview (skip_loop_filter) on or off. fastUsed: frames since the last exact seek may be approximate. */
    setFast(on) {
      if (!!this.fast === on) return;
      this.fast = on;
      if (on) { this.fastUsed = true; this.loopCache = null; }
      log(on ? 'behind: fast preview (no deblocking) while playing' : 'fast preview off');
      this.worker.postMessage({ type: 'fastDecode', on });
    }

    // ---- controls ---------------------------------------------------------------

    rel(t) { return t - (this.startT || 0); }
    /**
     * The shown picture's time for an exact clip: native ffmpeg reports the file's own timestamp, the other
     * decoders' picture times are those already. Null before a picture shows.
     */
    shownMarkTime() {
      if (this.shownT === null) return null;
      const own = this.shownFrame && this.shownFrame.srcT;
      return this.rel(Number.isFinite(own) ? own : this.shownT);
    }
    currentTime() { return this.rel(this.shownT !== null && !this.playing ? this.shownT : this.now()); }
    frameNumberRate() {
      // Snapping can accumulate frame-number drift. Use the source rate when it agrees with the
      // measured cadence (unreliable metadata can report AVI timestamp ticks as the frame rate).
      const rate = this.fps || 30;
      const sourceFps = this.info?.video?.fps;
      return sourceFps > 0 && Math.abs(sourceFps - rate) < rate * 0.005 ? sourceFps : rate;
    }
    currentFrame() { return this.frameAt(this.shownT !== null ? this.shownT : this.now()); }
    frameAt(t) {
      const fps = this.frameNumberRate();
      // The relative time subtracts two PTS values, each of which can be rounded by half a millisecond.
      const frame = Math.max(0, Math.floor(this.rel(t) * fps + Math.min(fps * 1e-3, 0.125) + 1e-6));
      return this.n > 0 ? Math.min(this.n - 1, frame) : frame;
    }
    isPlaying() { return this.playing; }

    play() {
      wake();
      this.seekGoalFrame = null;
      if (this.playing) return;
      this.cancelFill();
      this.cancelSharp();
      clearTimeout(this.acTimer);
      if (this.ac && (this.acRest || (this.acUnlocked && this.ac.state === 'suspended'))) this.wakeAudio();
      else if (this.ac && this.ac.state === 'suspended') {
        this.ac.resume().then(() => this.onAudioRunning(), () => {});
        if (this.ac.state === 'running') this.onAudioRunning();
        // Autoplay without a user gesture stays silent until one arrives.
        else if (this.ac.state === 'suspended' && !this.muted) setMuteUi(true);
      } else if (this.ac && this.ac.state === 'running') {
        this.acUnlocked = true;
      }
      this.playing = true;
      if (this.remoteStream) this.worker.postMessage({ type: 'playback', playing: true });
      // How long play takes to get going (notePlayStart): the picture moving, and the sound.
      this.playStart = { t0: performance.now(), from: this.shownT ?? this.pauseT, sound: this.amode !== 'none' && !!this.ac };
      this.endSteps();
      // A read served from the page's packets has no sound and no producer: the host goes on from there. From the
      // seek's target while it is still decoding (play pressed at once): the frame on screen is the one before the seek.
      if (this.localGen === this.gen) { this.seekAbs(this.seekTarget ?? this.shownT ?? this.pauseT, true); return; }
      // Stopped where the decoder kept failing (decodeError): try again from the picture on screen.
      if (this.stuckGen === this.gen) { this.seekAbs(this.shownT ?? this.pauseT, true); return; }
      // At the end (loop off): play starts over.
      if (this.eof && !this.queue.length && this.seekTarget === null && this.pauseT >= this.endT() - 1e-6) { this.seekAbs(this.startT || 0, true); return; }
      this.runFromT = this.pauseT; // Autoplay: how far playback ran before reaching the end (ended)
      this.anchor(this.pauseT);
    }

    pause() {
      wake();
      if (!this.playing) return;
      this.pauseT = this.now();
      this.playing = false;
      if (this.remoteStream) this.worker.postMessage({ type: 'playback', playing: false });
      this.stopAudio();
      if (this.ac) this.restAudioLater(this.hidden ? 0 : AC_REST_MS);
      if (this.nonRef || this.fastUsed) {
        // Paused frames are looked at one by one: decode every frame again (exactly), from the one shown.
        if (this.nonRef) this.setNonRef(false);
        this.setFast(false);
        this.seekAbs(this.shownT !== null ? this.shownT : this.pauseT, false);
        return;
      }
      this.spill();
    }

    beginScrub() {
      if (this.scrubHeldT !== undefined) return;
      this.scrubHeldT = this.shownT ?? this.now();
      this.stopAudio();
    }

    endScrub() {
      if (this.scrubHeldT === undefined) return;
      this.anchor(this.scrubHeldT);
      this.scrubHeldT = undefined;
      wake();
    }

    commitScrubFrame(frame) {
      const force = this.nonRefUsed || this.fastUsed || this.skipping;
      this.skipping = false;
      this.setFast(false);
      if (this.nonRef) this.setNonRef(false);
      this.seekFrame(frame, force);
    }

    seekAbs(t, keepPlaying, recoverTransport = false) {
      wake();
      const wasPlaying = keepPlaying !== undefined ? keepPlaying : this.playing;
      if (!wasPlaying && this.nonRef) this.setNonRef(false); // a paused seek or step shows every frame
      if (!wasPlaying) this.setFast(false); // ...decoded exactly
      if (!this.fast) this.fastUsed = false; // decoded from a keyframe again, exactly
      this.nonRefUsed = !!this.nonRef;
      this.gen++;
      this.loopCache = null;
      this.remoteWindow = null;
      this.remoteFragment = null;
      this.remoteVideoEnd = false;
      if (t === (this.startT || 0)) this.beginLoopCache();
      this.resetRate();
      this.readVT = undefined;
      this.catchUp = false;
      for (const f of this.queue) this.release(f);
      this.queue = [];
      this.releaseHold();
      this.dropBack(); // the frames decoded up to the new target are kept instead
      this.stopAudio();
      this.audio = [];
      this.audioKeepUntil = undefined;
      this.eof = false;
      this.requesting = true;
      this.seekTarget = this.vmode === 'none' ? null : t; // no picture: nothing would clear it
      this.shownStale = true;
      this.seekBefore = null;
      this.seekStartMs = performance.now();
      this.pauseT = t;
      this.runFromT = t;
      this.outCount = 0;
      this.ptsBase = undefined;
      if (this.vdec) { try { this.vdec.close(); } catch { /* closed */ } this.makeVideoDecoder(); }
      if (this.adec) { try { this.adec.close(); } catch { /* closed */ } this.makeAudioDecoder(); }
      this.playing = wasPlaying;
      this.anchor(t);
      this.cancelSharp(); // the host stops it on the seek too
      log(`seek to ${this.rel(t).toFixed(3)} s (gen ${this.gen})`);
      if (this.remoteStream && !wasPlaying && !recoverTransport && this.seekFromPackets(t)) return;
      // Playing (play after a seek served from the packets, or a seek while playing): offer the host what the page
      // holds of the target's GOP, so it sends only what follows (seeked.have, then onSeeked feeds them).
      const have = this.remoteStream && wasPlaying && !recoverTransport ? this.packetsHeld(t) : null;
      // ...and the sound it holds from t on (a second past those packets at most), so play starts with it at once.
      const sound = have && !this.soundCacheOff && this.amode !== 'none' ? this.packetCache.soundFrom(t, have.lastT + 1) : null;
      if (have && sound) have.audioUntil = sound.end;
      this.pendingHave = have ? { gen: this.gen, packets: have.packets, sound: sound ? sound.items : [], audioUntil: sound ? sound.end : undefined } : null;
      if (this.fill) this.fill = null; // the host stops its fill on a seek
      this.worker.postMessage({ type: 'seek', gen: this.gen, t,
        // The encode those packets came from (src/stream.js skipHeld continues only that encode's own frames).
        ...(have ? { have: { keyT: have.keyT, lastT: have.lastT, enc: have.enc, ...(have.audioUntil !== undefined ? { audioUntil: have.audioUntil } : {}) } } : {}),
        ...(this.remoteStream ? { playing: this.playing, warm: this.warmHook !== undefined ? this.warmHook : !!isClock() } : {}),
        ...(this.remoteStream && this.fastFirstHook !== undefined ? { fastFirst: this.fastFirstHook } : {}),
        ...(this.remoteStream && this.quickHook !== undefined ? { quick: this.quickHook } : {}),
        ...(recoverTransport ? { recoverTransport: true } : {}) });
    }

    /**
     * Live transcode, paused: a seek into a GOP the page already received decodes from the packets kept here
     * (media/packet-cache.js) instead of asking the host to send that GOP over the link again. The host is not told:
     * this read (localGen) has no producer, and play or a target outside the kept packets seeks the host as before.
     * The packets after the target in its GOP go in too (steps forward from memory), then a flush: a hardware decoder
     * can hold its last frames until more input comes, and none will.
     */
    seekFromPackets(t) {
      const cache = this.packetCache;
      if (!cache || this.vmode !== 'webcodecs' || !this.vdec || this.vdec.state !== 'configured') return false;
      const hit = cache.find(t);
      if (!hit) return false;
      const gen = this.gen;
      const ahead = cache.after(hit.keyT, hit.frameT);
      this.localGen = gen;
      this.requesting = false; // no producer: nothing is asked of the host for this read
      this.seekTarget = this.pauseT = hit.frameT; // what the host's 'seeked' would say: the frame at or before t
      this.anchor(hit.frameT);
      const packets = hit.packets.concat(ahead).map((p) => ({ kind: 'packet', ...p }));
      const bytes = packets.reduce((n, p) => n + p.data.byteLength, 0);
      log(`seek to ${this.rel(hit.frameT).toFixed(3)} s from the page's packets: ${hit.packets.length} to the target + ${ahead.length} after, `
        + `${(bytes / 1024).toFixed(0)} KiB, keyframe ${this.rel(hit.keyT).toFixed(3)} s, nothing sent over the link`);
      queueMicrotask(() => {
        if (this.disposed || this.gen !== gen) return;
        this.onBatch({ gen, video: packets, audio: [], local: true });
        const dec = this.vdec;
        if (dec && dec.state === 'configured') dec.flush().catch(() => {});
      });
      return true;
    }

    /**
     * Paused, a frame shown: see within FILL_CHECK_MS whether the host should fill in behind it (fillBehind). A check
     * already due is not pushed back, so a run of steps (a wheel scroll back) keeps the fill ahead of it.
     */
    scheduleFill() {
      if (!this.remoteStream || !this.packetCache || this.fillTimer) return;
      this.fillTimer = setTimeout(() => { this.fillTimer = 0; this.fillBehind(); }, FILL_CHECK_MS);
    }

    /**
     * Live transcode, paused: steps back from a fresh jump need the frames before it, which the page never received
     * (the host's encode started at the target). Ask the host to encode FILL_SPAN_S behind the packets held here,
     * ending where they begin, for the packet cache only (nothing is shown or decoded now): the next steps back then
     * decode on the page (media/packet-cache.js find) instead of a seek each over the link. Pulled a piece at a time
     * (onFillBatch); a seek or play stops it. Again once the frame is within FILL_AHEAD_S of what is held.
     */
    fillBehind() {
      const cache = this.packetCache;
      if (this.disposed || !cache || !this.remoteStream || this.playing || this.hidden || this.fill) return;
      if (this.vmode !== 'webcodecs' || this.seekTarget !== null || this.shownT === null) return;
      if (this.fillRetryAt && performance.now() < this.fillRetryAt) return;
      const f = 1 / (this.fps || 30);
      const start = this.startT || 0;
      const need = this.shownT - FILL_AHEAD_S;
      if (need <= start + f / 2 || cache.find(need)) return; // held far enough behind, or the file starts there
      // Back along the GOPs held without a gap: the fill ends where the first of them begins.
      let to = this.shownT;
      for (let i = 0; i < 64; i++) {
        const h = cache.find(to - 0.5 * f);
        if (!h || !(h.keyT < to - f / 4)) break;
        to = h.keyT;
      }
      const from = Math.max(start, to - FILL_SPAN_S);
      if (to - from < f / 2) return;
      const id = (this.fillSeq = (this.fillSeq || 0) + 1);
      this.fill = { id, gen: `fill:${id}`, from, to, t0: performance.now(), n: 0, lastT: -Infinity };
      log(`fill behind the paused frame: ${this.rel(from).toFixed(3)}-${this.rel(to).toFixed(3)} s asked from the host`);
      this.worker.postMessage({ type: 'fill', id, from, to });
    }

    /** A piece of the fill (fillBehind): into the packet cache; the next piece is asked while still paused. */
    onFillBatch(m) {
      const fl = this.fill;
      if (!fl || m.id !== fl.id || !this.packetCache) return;
      for (const p of m.video) {
        this.packetCache.add(fl.gen, p);
        if (Number.isFinite(p.t) && !(p.t <= fl.lastT)) fl.lastT = p.t;
      }
      fl.n += m.video.length;
      if (!m.done) {
        if (!this.playing) this.worker.postMessage({ type: 'fillMore', id: fl.id });
        return;
      }
      this.fill = null;
      // Held only as far as its packets reach: a fill that stopped short (its ffmpeg failed or ended early) must not
      // claim the frames it never sent, or a step back into them would show another frame.
      const short = !!m.error || !(fl.lastT >= fl.to - 1.5 / (this.fps || 30));
      if (short) {
        this.packetCache.close(fl.gen, -Infinity); // its last GOP covers what arrived, nothing after
        log(fl.n ? `fill behind the paused frame: ${fl.n} frames to ${this.rel(fl.lastT).toFixed(3)} s only (${m.error || 'ended early'})`
          : `fill behind the paused frame: none (${m.error || 'no frames'})`);
        this.fillRetryAt = performance.now() + (m.error === 'busy' ? 2000 : 30000);
        return;
      }
      this.packetCache.close(fl.gen, fl.to);
      log(`fill behind the paused frame: ${fl.n} frames from ${this.rel(fl.from).toFixed(3)} s held in ${Math.round(performance.now() - fl.t0)} ms`);
      this.scheduleFill();
    }

    /** Stop a fill in flight (play, hide): the host kills its encode. */
    cancelFill() {
      clearTimeout(this.fillTimer);
      this.fillTimer = 0;
      if (!this.fill) return;
      this.fill = null;
      this.worker.postMessage({ type: 'fillStop' });
    }

    /**
     * Live transcode, paused: a frame just drawn (tick). Once it has stayed shown SHARP_WAIT_MS, ask the host for it
     * visually lossless (requestSharp); every new picture, seek, play or hide before that cancels the wait, so steps and
     * scrolls ask for nothing until they rest. The frames from the page's packets and decoded memory count the same.
     */
    scheduleSharp() {
      this.cancelSharp();
      if (!this.sharpWanted()) return;
      const r = { t: this.shownT, shown: this.shownCount || 0, gen: this.gen };
      this.sharpTimer = setTimeout(() => { this.sharpTimer = 0; this.requestSharp(r); }, SHARP_WAIT_MS);
    }

    /** A lossy Live transcode picture (not Direct Stream), paused and visible, decoded by WebCodecs. */
    sharpWanted() {
      return !!this.remoteStream && !!this.nativeLossy && !this.sharpOff && !this.playing && !this.hidden && !this.disposed
        && this.vmode === 'webcodecs' && !!this.vconf && typeof VideoDecoder !== 'undefined';
    }

    /** Still paused on the frame the sharp one was asked for: nothing else shown, sought or stepped since. */
    sharpStill(r) {
      return this.sharpWanted() && this.seekTarget === null && this.gen === r.gen && (this.shownCount || 0) === r.shown
        && this.shownT === r.t && !this.pendingStep();
    }

    requestSharp(r) {
      if (!this.sharpStill(r)) return;
      r.id = (this.sharpSeq = (this.sharpSeq || 0) + 1);
      r.t0 = performance.now();
      r.pieces = [];
      r.bytes = 0;
      this.sharp = r;
      const st = this.sharpStats || (this.sharpStats = { asked: 0, shown: 0, dropped: 0, failed: 0 });
      st.asked++;
      this.worker.postMessage({ type: 'sharp', id: r.id, t: r.t });
    }

    /**
     * A piece of the sharp frame (requestSharp; src/stream.js sharp). The whole picture decodes in a VideoDecoder of its
     * own (sharpDecoder): an IDR fed to the main decoder would break the references of the P-frames after it. It is
     * drawn only while the page is still paused on that frame, and kept nowhere (not the packets, the frames kept for
     * steps back, nor the queue): the next picture shown replaces it as usual.
     */
    onSharpFrame(m) {
      const r = this.sharp;
      if (!r || m.id !== r.id) return;
      const st = this.sharpStats;
      if (m.error) {
        this.sharp = null;
        st.failed++;
        log(`sharp frame: none (${m.error})`);
        return;
      }
      const receive = () => {
        if (this.sharp !== r) return;
        if (!this.sharpStill(r)) { this.cancelSharp(); st.dropped++; return; }
        r.pieces.push(m.data);
        r.bytes += m.data.byteLength;
        if (!m.done) { this.worker.postMessage({ type: 'sharpMore', id: r.id }); return; }
        const data = new Uint8Array(r.bytes);
        let at = 0;
        for (const x of r.pieces) { data.set(x, at); at += x.byteLength; }
        r.pieces = [];
        r.arrivedMs = performance.now();
        const dec = this.sharpDecoder();
        if (!dec) { this.sharp = null; st.failed++; return; }
        try {
          dec.decode(new EncodedVideoChunk({ type: 'key', timestamp: Math.round(r.t * 1e6), data }));
          this.sideJobs.push({ kind: 'sharp', r });
          dec.flush().catch(() => {});
        } catch (e) {
          this.sharp = null;
          st.failed++;
          log(`sharp frame: decode failed (${e && e.message || e})`);
        }
      };
      // The VS Code test hook paces delivery at its fixed rate, as for the stream's batches (receiveRemoteBatch).
      if (this.debugRemoteRate > 0) setTimeout(receive, m.data.byteLength * 1000 / this.debugRemoteRate);
      else receive();
    }

    /**
     * The quick first picture of a paused host seek on a slow link (src/stream.js startQuick): the target frame alone at
     * half the stream's width and height, one IDR, sent before the stream's own frames. It decodes in the sharp frames'
     * decoder (never the main one: its P-frames' references would break) and is drawn scaled up to the stream's size
     * only while that seek has shown nothing yet; the seek's own frame (or a sharp frame after it) replaces it as usual.
     * It is kept nowhere: not the packets, the frames kept for steps back, nor the queue.
     */
    onQuickFrame(m) {
      if (m.gen !== this.gen || !m.data) return;
      const r = { gen: m.gen, t: m.t, w: m.w, h: m.h, bytes: m.data.byteLength };
      const st = this.quickStats || (this.quickStats = { got: 0, shown: 0, dropped: 0, failed: 0 });
      st.got++;
      const receive = () => {
        if (!this.quickStill(r)) { st.dropped++; return; }
        const dec = this.sharpDecoder();
        if (!dec) { st.failed++; return; }
        r.arrivedMs = performance.now();
        this.quick = r;
        try {
          dec.decode(new EncodedVideoChunk({ type: 'key', timestamp: Math.round(r.t * 1e6), data: m.data }));
          this.sideJobs.push({ kind: 'quick', r });
          dec.flush().catch(() => {});
        } catch (e) {
          this.quick = null;
          st.failed++;
          log(`quick picture: decode failed (${e && e.message || e})`);
        }
      };
      // The VS Code test hook paces delivery at its fixed rate, as for the stream's batches (receiveRemoteBatch).
      if (this.debugRemoteRate > 0) setTimeout(receive, m.data.byteLength * 1000 / this.debugRemoteRate);
      else receive();
    }

    /** That seek is still waiting for its first picture (paused, visible, nothing shown or sought since), and r is its target. */
    quickStill(r) {
      return !!this.remoteStream && !this.playing && !this.hidden && !this.disposed && this.vmode === 'webcodecs'
        && this.gen === r.gen && this.seekTarget !== null && Math.abs(r.t - this.seekTarget) < 0.5 / (this.fps || 30)
        && !!this.vconf && typeof VideoDecoder !== 'undefined';
    }

    /** @param {any} vf @param {any} r the quick picture this output decodes (onQuickFrame) */
    showQuick(vf, r) {
      const current = !!r && this.quick === r;
      if (current) this.quick = null;
      wake();
      const st = this.quickStats;
      if (!current || Math.round(r.t * 1e6) !== vf.timestamp || !this.quickStill(r)) { vf.close(); if (st) st.dropped++; return; }
      let big = null;
      try {
        // Scaled up: the renderer sizes its canvas by the frame's display size, which is the stream's.
        big = r.w > 0 && r.h > 0 ? new VideoFrame(vf, { displayWidth: r.w, displayHeight: r.h }) : null;
        this.gl.drawFrame(big || vf);
      } catch (e) {
        st.failed++;
        log(`quick picture: draw failed (${e && e.message || e})`);
        return;
      } finally { if (big) big.close(); vf.close(); }
      const now = performance.now();
      st.shown++;
      st.last = {
        t: r.t, frame: this.frameAt(r.t), bytes: r.bytes, size: [vf.codedWidth, vf.codedHeight],
        sinceSeekMs: this.seekStartMs !== undefined ? Math.round(now - this.seekStartMs) : null,
        decodeMs: Math.round(now - r.arrivedMs),
      };
      log(`quick picture shown at ${this.rel(r.t).toFixed(3)} s: ${(r.bytes / 1024).toFixed(0)} KiB, `
        + `${st.last.sinceSeekMs} ms after the seek`);
    }

    /** The sharp frames' own decoder (onSharpFrame, and the quick picture: onQuickFrame), made once and kept. */
    sharpDecoder() {
      const d = this.sharpDec;
      if (d && d.state === 'configured') return d;
      // Which request each output answers, in decode order (each is one IDR: no reordering). The request itself, not
      // the current one: a result of an older request must neither cancel nor stand in for a newer one.
      this.sideJobs = [];
      try {
        const dec = new VideoDecoder({
          output: (vf) => {
            const job = this.sideJobs.shift();
            if (job && job.kind === 'quick') this.showQuick(vf, job.r); else this.showSharp(vf, job ? job.r : null);
          },
          error: (e) => { log(`sharp frame decoder: ${e && e.message || e}`); if (this.sharpDec === dec) this.sharpDec = null; },
        });
        dec.configure(this.vconf);
        this.sharpDec = dec;
        return dec;
      } catch (e) {
        log(`sharp frame decoder unavailable: ${e && e.message || e}`);
        this.sharpOff = true;
        return null;
      }
    }

    /** @param {any} vf @param {any} r the sharp request this output decodes (onSharpFrame) */
    showSharp(vf, r) {
      wake();
      if (!r || this.sharp !== r || Math.round(r.t * 1e6) !== vf.timestamp || !this.sharpStill(r)) {
        vf.close();
        // Only its own request ends here; an older request's late picture leaves the current one waiting.
        if (r && this.sharp === r) this.sharp = null;
        if (this.sharpStats) this.sharpStats.dropped++;
        return;
      }
      this.sharp = null;
      try {
        // Tests read the thumbnail and the stats below apart: both name the request (req) and the seek (gen) they show.
        if (this.cfg.debug || env.debug) this.sharpThumb = { ...sharpThumb(vf, r.t), req: r.id, gen: r.gen };
        this.gl.drawFrame(vf);
        this.captureThumb(r.t);
      } finally { vf.close(); }
      const now = performance.now();
      const st = this.sharpStats;
      st.shown++;
      st.last = {
        t: r.t, frame: this.frameAt(r.t), bytes: r.bytes, req: r.id, gen: r.gen,
        ms: Math.round(now - r.t0), linkMs: Math.round(r.arrivedMs - r.t0), decodeMs: Math.round(now - r.arrivedMs),
        // From the seek that started the paused frame (its first picture is lastSeekMs after it): a seek's whole story.
        sinceSeekMs: this.seekStartMs !== undefined ? Math.round(now - this.seekStartMs) : null,
      };
      log(`sharp frame shown at ${this.rel(r.t).toFixed(3)} s: ${(r.bytes / 1024).toFixed(0)} KiB, ${st.last.ms} ms after asking `
        + `(${st.last.linkMs} ms to arrive)`);
    }

    /** Drop a sharp frame waited for or on its way (a new picture, seek, play, hide): the host kills its encode. */
    cancelSharp() {
      if (this.sharpTimer) clearTimeout(this.sharpTimer);
      this.sharpTimer = 0;
      const r = this.sharp;
      if (!r) return;
      this.sharp = null;
      this.worker.postMessage({ type: 'sharpStop' });
    }

    /** The kept packets of the GOP holding t, from its keyframe to the last one held (null: none, or not WebCodecs). */
    packetsHeld(t) {
      const cache = this.packetCache;
      if (!cache || this.vmode !== 'webcodecs') return null;
      const hit = cache.find(t);
      if (!hit) return null;
      const packets = hit.packets.concat(cache.after(hit.keyT, hit.frameT));
      return { keyT: hit.keyT, lastT: packets[packets.length - 1].t, enc: hit.enc, packets: packets.map((p) => ({ kind: 'packet', ...p })) };
    }

    /** The host's answer to a seek that offered packets (seekAbs): it skipped them, so they decode from here. */
    takeHeld(m) {
      const held = this.pendingHave;
      this.pendingHave = null;
      if (!held || held.gen !== m.gen || !m.have) return;
      const bytes = held.packets.reduce((n, p) => n + p.data.byteLength, 0);
      log(`seek to ${this.rel(m.t).toFixed(3)} s: ${held.packets.length} packets (${(bytes / 1024).toFixed(0)} KiB) from the page`
        + `${held.sound.length ? ` and sound to ${this.rel(held.audioUntil).toFixed(3)} s` : ''}, the host sends what follows`);
      // PCM goes in with the picture; Opus decodes first, and the host's next batches wait for it (soundGate). Sound the
      // host sends again anyway (it did not hold that far) is cut where the page's ends (audioKeepUntil, onBatch).
      const opus = held.sound.filter((it) => it.kind === 'opus');
      const keep = () => { if (held.sound.length && this.gen === m.gen) this.audioKeepUntil = held.audioUntil; };
      this.onBatch({ gen: m.gen, video: held.packets, audio: held.sound.filter((it) => it.kind !== 'opus'), local: true });
      if (!opus.length) { keep(); return; }
      const gate = this.decodeRemoteAudio(opus).then((audio) => {
        if (this.disposed || this.gen !== m.gen) return;
        this.onBatch({ gen: m.gen, video: [], audio, local: true });
        keep();
      }, (e) => log(`held sound decode failed: ${e && e.message || e}`)).finally(() => { if (this.soundGate === gate) this.soundGate = null; });
      this.soundGate = gate;
    }

    /** Real-time catch-up: continue from the first keyframe at or after t, clock untouched. */
    skipTo(t) {
      const end = this.startT !== null && this.meta.duration ? this.startT + this.meta.duration : Infinity;
      if (t > end - 0.5) { this.autoEvery = true; return; } // nothing left to skip to
      this.skipping = true;
      this.cancelSharp();
      this.gen++;
      this.loopCache = null;
      this.resetRate();
      this.readVT = undefined;
      for (const f of this.queue) this.release(f);
      this.queue = [];
      this.releaseHold();
      this.eof = false;
      this.requesting = true;
      this.seekTarget = null;
      this.seekBefore = null;
      this.shownStale = true;
      if (this.vdec) { try { this.vdec.close(); } catch { /* closed */ } this.makeVideoDecoder(); }
      if (this.adec) { try { this.adec.close(); } catch { /* closed */ } this.makeAudioDecoder(); }
      this.stopAudio();
      this.anchor(this.now()); // same time; restarts the stretcher
      this.audio = [];
      this.audioKeepUntil = undefined;
      this.skips = (this.skips || 0) + 1;
      (this.skipLog = this.skipLog || []).push(performance.now());
      this.worker.postMessage({ type: 'seek', gen: this.gen, t, fast: true });
    }

    seekTime(rel, stepping = false, force = false) {
      if (this.vmode === undefined) return; // keys before the decoder is ready
      if (this.meta.live) return; // a live stream plays from the live edge (Open Video URL…)
      if (!stepping) this.clearStepGoal();
      const dur = this.meta.duration || 0;
      const r = Math.max(0, dur ? Math.min(rel, dur - 0.5 / (this.fps || 30)) : rel);
      const t = (this.startT || 0) + r;
      // Forward within what is already decoded: no seek needed.
      if (!force && this.queue.length && t >= this.queue[0].t - 1e-3 && t <= this.queue[this.queue.length - 1].t && (this.shownT === null || t >= this.shownT)) {
        while (this.queue.length > 1 && this.queue[1].t <= t + 1e-3) this.release(this.queue.shift());
        this.dropBack();
        this.shownStale = true; // the frames skipped over were never shown
        this.pauseT = t;
        this.stopAudio();
        this.anchor(t);
        return;
      }
      // Back onto a frame kept for steps back (keepBack: consecutive frames ending just before the shown one): no
      // seek. The unified viewer steps its decoders with frame seeks (player-unified.js seekTo), not stepFrame, so
      // without this every paused step back decoded its GOP again (over a remote link: the host sent it again).
      const back = this.back;
      if (!force && !this.playing && back && back.length && this.shownT !== null && this.seekTarget === null
        && t < this.shownT - 1e-4 && t >= back[0].t - 1e-4) {
        let j = back.length - 1;
        while (j >= 0 && back[j].t > t + 1e-4) j--;
        if (j >= 0 && this.stepBack(back.length - j, this.shownT) !== null) return;
      }
      this.seekAbs(t);
    }
    frameSeekTime(i) { return (Math.max(0, i) + 0.5) / this.frameNumberRate(); }
    seekFrame(i, force = false) { this.seekTime(this.frameSeekTime(i), false, force); }
    /** The requested step stays active until its picture shows or something else moves the player. */
    pendingStep() {
      const st = this.stepTo;
      if (!this.playing && st && st.gen === this.gen
        && (st.timer || this.seekTarget !== null || (this.shownCount || 0) === st.shown)) return st;
      return null;
    }

    /**
     * Steps by actual frames: forward to the next decoded one, back to the last one before the shown one.
     * A step that comes before the previous one is on screen counts from that step's frame, not from the one
     * still shown: a step back on 4K decodes from the keyframe before (up to seconds), and wheel notches that
     * came meanwhile all restarted from the shown frame, so 10 notches back moved one or two frames.
     */
    //
    // Steps back are served from memory where they can be: the frames decoded on the way to a paused seek target
    // (from the keyframe before it) and the frames a step forward passes are kept (this.back, up to half the frame
    // budget, consecutive frames ending just before the shown one), so a step back on 4K HEVC shows the previous
    // frame at once instead of decoding up to a GOP again (seconds in WebAssembly).
    stepFrame(d, noWait = false) {
      this.seekGoalFrame = null;
      this.pause();
      let retryDeadline = 0;
      if (this.backRetry) {
        // Notches while a step back waits for its copies: one step by the sum, keeping the first deadline.
        d += this.backRetry.d;
        retryDeadline = this.backRetry.deadline;
        clearTimeout(this.backRetry.timer);
        this.backRetry = null;
        if (!d) return;
      }
      const f = 1 / (this.fps || 30);
      if (this.shownT === null || this.vmode === 'none') { this.endSteps(); this.seekFrame(this.currentFrame() + d); return; }
      const st = this.pendingStep();
      const pending = !!st;
      const waiting = pending && !!st.timer; // its seek waits (STEP_SEEK_MS): what is in memory belongs to an older target
      const base = pending ? st.t : this.shownT;
      const start = this.startT || 0;
      const last = this.meta.duration ? start + this.meta.duration - f : Infinity;
      let to;
      let seek;
      let origin; // a cache-missing step back: the picture stepped from and the pictures to go back from it
      let count;
      if (d > 0) {
        const next = waiting ? null : this.queue.filter((x) => x.t > base + 1e-4)[d - 1];
        if (next) { to = next.t; this.keepPassed(to); this.showQueued(to); } // decoded already: at once
        else if (!this.eof || this.queue.length) { to = Math.min(last, base + d * f); seek = this.rel(base) + d * f; }
        else return;
      } else {
        const nowWait = performance.now();
        const deadline = retryDeadline || (nowWait + BACK_WAIT_MS);
        const remain = deadline - nowWait;
        if (!waiting && !noWait && remain > 0 && this.seekTarget === null && (this.backSpilling || 0) > 0) {
          // The GOP just decoded is still being copied for steps back (even before the first copy finishes):
          // wait up to the original BACK_WAIT_MS deadline rather than seek and re-send the GOP over the link.
          const r = { d, gen: this.gen, deadline };
          r.timer = setTimeout(() => this.runBackRetry(r), remain);
          this.backRetry = r;
          return;
        }
        const hit = waiting ? null : this.stepBack(-d, base);
        if (hit !== null) {
          to = hit;
        } else {
          to = Math.max(start, base + d * f);
          // Notches that come while the seek is still on its way count from the first one's picture: the decoder
          // lands on that many pictures before it, whatever the spacing (VFR), not on nominal 1 / fps intervals.
          const more = pending && (st.timer || this.seekTarget !== null) && st.origin !== undefined;
          origin = more ? st.origin : base;
          count = (more ? st.count : 0) - d;
          // A seek target half a frame before the picture lands before it; the decoder picks the exact one.
          seek = this.rel(origin) - (count - 0.5) * f;
        }
      }
      const now = performance.now();
      if (seek === undefined) { this.stepTo = { t: to, gen: this.gen, shown: this.shownCount || 0, at: pending ? st.at : 0 }; return; }
      if (this.meta.live) return; // a step outside the retained frames would require a seek
      if (waiting) {
        st.t = to; st.seek = seek; st.origin = origin; st.count = count; // the waiting seek takes the new target
        if (st.quietFrom !== undefined) { clearTimeout(st.timer); st.timer = setTimeout(() => this.flushStep(st), this.quietWait(st, now)); }
        return;
      }
      const remote = !!this.remoteStream;
      const wait = pending && this.seekTarget !== null ? (remote ? REMOTE_STEP_QUIET_MS : STEP_SEEK_MS - (now - st.at)) : 0;
      if (wait > 0) {
        const s = { t: to, gen: this.gen, shown: this.shownCount || 0, at: st.at, seek, origin, count };
        if (remote) s.quietFrom = now;
        s.timer = setTimeout(() => this.flushStep(s), wait);
        this.stepTo = s;
        return;
      }
      this.seekTime(seek, true);
      if (origin !== undefined && this.seekTarget !== null) { this.seekBefore = origin; this.seekBackCount = count; }
      this.stepTo = { t: to, gen: this.gen, shown: this.shownCount || 0, at: now, origin, count };
    }

    /** Paused: shows the queued frame at time t (frames before it leave the queue). */
    showQueued(t) {
      while (this.queue.length > 1 && this.queue[1].t <= t + 1e-3) this.release(this.queue.shift());
      this.pauseT = t;
      this.stopAudio();
      this.anchor(t);
    }

    /** A step's seek that waited (STEP_SEEK_MS) starts now, unless something else moved the player meanwhile. */
    flushStep(s) {
      s.timer = null;
      if (this.stepTo !== s || s.gen !== this.gen || this.playing) return;
      this.seekTime(s.seek, true);
      if (s.origin !== undefined && this.seekTarget !== null) { this.seekBefore = s.origin; this.seekBackCount = s.count; }
      this.stepTo = { t: s.t, gen: this.gen, shown: this.shownCount || 0, at: performance.now(), origin: s.origin, count: s.count };
    }

    /** Remote: the waiting step seek starts once notches rest REMOTE_STEP_QUIET_MS, or REMOTE_STEP_MAX_MS after the first. */
    quietWait(s, now) { return Math.max(0, Math.min(REMOTE_STEP_QUIET_MS, s.quietFrom + REMOTE_STEP_MAX_MS - now)); }

    /** A step back that waited for copies of frames to memory (keepBack) runs now, seeking if they are still busy. */
    runBackRetry(r) {
      if (this.backRetry !== r) return;
      clearTimeout(r.timer);
      this.backRetry = null;
      if (r.gen !== this.gen || this.playing || this.hidden) return;
      this.stepFrame(r.d, true);
    }

    clearStepGoal() {
      this.seekGoalFrame = null;
      if (this.stepTo && this.stepTo.timer) clearTimeout(this.stepTo.timer);
      this.stepTo = null;
      if (this.backRetry) { clearTimeout(this.backRetry.timer); this.backRetry = null; }
    }

    /** Playing or seeking elsewhere: no step on its way, no frames kept for steps back. */
    endSteps() {
      this.clearStepGoal();
      this.dropBack();
    }

    /** The memory steps back may use: remote Live transcode keeps more, as a miss costs a seek over the link. */
    backBudget() { return this.remoteStream ? Math.round(this.budget() * 0.65) : this.budget() / 2; }

    /** Puts a decoded frame in this.back in time order; the oldest go when it is over backBudget(). */
    insertBack(fr) {
      if (!this.back) this.dropBack();
      const back = this.back;
      // Older than a frame already let go for the budget: kept, it would leave a gap.
      if (this.backFloor !== undefined && fr.t <= this.backFloor + 1e-4) { this.release(fr); return; }
      let i = back.length;
      while (i > 0 && back[i - 1].t > fr.t) i--;
      if (i > 0 && Math.abs(back[i - 1].t - fr.t) <= 1e-4) { this.release(fr); return; } // already kept
      if (i === back.length) back.push(fr);
      else back.splice(i, 0, fr);
      this.backBytes += fr.bytes;
      this.trimBack();
    }

    /** The oldest kept frames go (then the oldest waiting for a copy) while over backBudget(). */
    trimBack() {
      const cap = this.backBudget();
      const wait = this.backWait || [];
      const est = (x) => (x.vf ? (x.vf.codedWidth || 0) * (x.vf.codedHeight || 0) * 1.5 : x.bytes || 0);
      let bytes = this.backBytes + wait.reduce((n, x) => n + est(x), 0);
      const floor = (t) => { this.backFloor = this.backFloor === undefined ? t : Math.max(this.backFloor, t); };
      while (this.back.length && bytes > cap) {
        const x = this.back.shift();
        this.backBytes -= x.bytes;
        bytes -= x.bytes;
        floor(x.t);
      }
      while (wait.length > 1 && bytes > cap) {
        const x = wait.shift();
        bytes -= est(x);
        floor(x.t);
        this.release(x);
        this.backSpilling = Math.max(0, (this.backSpilling || 1) - 1);
      }
    }

    /** Starts copies of waiting frames to memory, BACK_COPIES at a time; done ones go into this.back. */
    copyBack() {
      const wait = this.backWait;
      while (wait && wait.length && (this.backCopying || 0) < BACK_COPIES) {
        const fr = wait.shift();
        const gen = this.gen;
        const run = this.backGen || 0;
        const mine = () => gen === this.gen && run === (this.backGen || 0);
        this.backCopying = (this.backCopying || 0) + 1;
        this.toMemory(fr).then(() => {
          if (mine() && !this.playing && !this.hidden) {
            if (fr.yuv && !fr.vf) this.insertBack(fr);
            else { this.dropBack(); this.release(fr); }
          } else this.release(fr);
        }, () => {
          if (mine()) this.dropBack();
          this.release(fr);
        }).finally(() => {
          this.backCopying = Math.max(0, (this.backCopying || 1) - 1);
          if (mine()) this.backSpilling = Math.max(0, (this.backSpilling || 1) - 1);
          this.copyBack();
          if (!this.backSpilling && this.backRetry) this.runBackRetry(this.backRetry);
        });
      }
    }

    /** Keeps a decoded frame (paused, in memory, consecutive with the kept ones) for steps back; else lets it go. */
    keepBack(fr) {
      // (Compare steps its tiles by seeking them: no frames kept there.)
      if (this.playing || this.hidden || this.cfg.noStepBack) { this.release(fr); return; }
      if (fr.spilling) { this.dropBack(); this.release(fr); return; }
      if (fr.vf) {
        // Remote Live transcode decodes to WebCodecs frames, which hold the decoder's surfaces: the frames just
        // before a paused seek target are copied to memory (a few at a time) so that consecutive steps back are
        // served from here, not from another seek and decode of the GOP over the link.
        // A GOP decodes faster than its frames copy: they wait in line (copyBack) instead of the run being dropped,
        // which kept only the last few pictures of each GOP.
        const near = this.remoteStream && !this.noSpill && this.seekTarget !== null && this.seekTarget - fr.t <= 3;
        if (!near) { this.dropBack(); this.release(fr); return; }
        if (!this.back) this.dropBack();
        (this.backWait || (this.backWait = [])).push(fr);
        this.backSpilling = (this.backSpilling || 0) + 1; // stepBack() waits for the copies: they set adjacency
        this.trimBack();
        this.copyBack();
        return;
      }
      if (!fr.yuv) { this.dropBack(); this.release(fr); return; }
      this.insertBack(fr);
    }

    /** The pictures held for a step back (this.hold is the oldest, landing one): into the queue. */
    insertHold() {
      const run = this.holdRun && this.holdRun.length ? this.holdRun : this.hold ? [this.hold] : [];
      for (const x of run) this.insert(x);
      this.hold = null;
      this.holdRun = null;
    }

    releaseHold() {
      const run = this.holdRun && this.holdRun.length ? this.holdRun : this.hold ? [this.hold] : [];
      for (const x of run) this.release(x);
      this.hold = null;
      this.holdRun = null;
    }

    /** Lets go of the frames kept for steps back and of those waiting for a copy (copies running drop theirs). */
    dropBack() {
      if (this.backWait) for (const fr of this.backWait.splice(0)) this.release(fr);
      this.back = [];
      this.backBytes = 0;
      this.backFloor = undefined;
      this.backSpilling = 0;
      this.backGen = (this.backGen || 0) + 1;
      // A step back waiting for those copies seeks now (asynchronously: dropBack runs inside seeks and plays).
      if (this.backRetry) { const r = this.backRetry; setTimeout(() => this.runBackRetry(r), 0); }
    }

    /** Before a paused step forward to frame time t: the shown frame and the decoded ones passed are kept for steps back. */
    keepPassed(t) {
      const sf = this.shownFrame;
      const before = this.queue.filter((x) => x.t < t - 1e-4);
      const passed = before.filter((x) => x.yuv && !x.vf); // (WebCodecs frames still on the GPU stay)
      const haveShown = this.shownT !== null && this.shownT < t - 1e-4
        && !this.queue.some((x) => Math.abs(x.t - this.shownT) < 1e-4);
      if (haveShown) {
        if (sf && sf.yuv && !sf.vf && sf.t === this.shownT) {
          this.keptBufs.add(sf.yuv.data.buffer); // shown: else its buffer goes back to the decoder after the next upload
          passed.push(sf);
        } else {
          // Shown picture is not in CPU memory: keeping older frames would leave a gap.
          this.dropBack();
          return;
        }
      }
      if (passed.length < before.length + (haveShown ? 1 : 0)) {
        // A passed frame in the queue is still on the GPU: keeping earlier frames would leave a gap.
        this.dropBack();
        return;
      }
      passed.sort((a, b) => a.t - b.t);
      for (const x of passed) if (!this.back.length || x.t > this.back[this.back.length - 1].t + 1e-4) this.keepBack(x);
    }

    /** A paused step back by `steps` pictures from the frame at `base`, from the kept frames: target time or null. */
    stepBack(steps, base) {
      const back = this.back;
      if (!back || !back.length || this.seekTarget !== null || !(steps >= 1)) return null;
      // A copy still running may belong between the kept pictures and `base`: finished ones prove no adjacency.
      if ((this.backSpilling || 0) > 0) return null;
      if (!(base - back[back.length - 1].t > 1e-4)) return null;
      const i = back.length - steps;
      if (i < 0) return null;
      // Preserve the currently shown frame in the forward queue so a following step forward returns to N instead of
      // skipping to N+1. If N was displayed from a GPU VideoFrame (shownFrame is null), clone it from lastShown; if
      // N cannot be restored at all, fall back to a seek rather than consuming the backward cache.
      let restore = null;
      const needRestore = this.shownT !== null && Math.abs(this.shownT - base) < 1e-4
        && !this.queue.some((x) => Math.abs(x.t - this.shownT) < 1e-4);
      if (needRestore) {
        const sf = this.shownFrame;
        if (sf && sf.t === this.shownT) restore = sf;
        else if (this.lastShown && this.lastShown.vf) {
          try { restore = { t: this.shownT, vf: this.lastShown.vf.clone() }; } catch { return null; }
        } else return null;
      }
      const moved = back.splice(i);
      for (const x of moved) this.backBytes -= x.bytes;
      if (restore) {
        if (restore.yuv) this.keptBufs.add(restore.yuv.data.buffer);
        moved.push(restore);
      }
      for (const x of moved) this.insert(x);
      log(`step back from memory to ${this.rel(moved[0].t).toFixed(3)} s (${back.length} more kept)`);
      this.scheduleFill();
      this.pauseT = moved[0].t;
      this.stopAudio();
      this.anchor(this.pauseT);
      return moved[0].t;
    }
    deferSeek(t) { if (this.startT === null) this.pendingSeek = t; else this.seekTime(t); }
    setRate(r) {
      if (r === this.rate) return;
      const now = this.now();
      this.rate = r;
      this.stopAudio();
      this.anchor(now);
      if (this.pauseT !== undefined && !this.playing) this.pauseT = now;
      if (!this.canStretch(r) && this.amode !== 'none') toast('Sound plays at 0.25×–4× only');
    }
    get loop() { return this.loopEnabled && !this.followerClock; }
    set loop(l) { this.setLoop(l); }
    setLoop(l) { this.loopEnabled = l; if (!l) this.loopCache = null; }
    setVolume(volume, muted) {
      this.volume = volume;
      this.muted = muted;
      // (Suspended while paused, restAudio: play() resumes it.)
      if (!muted && this.ac && this.ac.state === 'suspended' && !this.acRest) {
        this.ac.resume().then(() => this.onAudioRunning(), () => {});
        if (this.ac.state === 'running') this.onAudioRunning();
      }
      this.applyVolume();
    }
    applyVolume() { if (this.gain) this.gain.gain.value = this.muted ? 0 : this.volume; }
    snapshotSource() { return canvas; }
    bufferedRanges() {
      if (!this.queue.length || this.startT === null) return [];
      return [[this.rel(this.queue[0].t), this.rel(this.queue[this.queue.length - 1].t)]];
    }
    // ---- audio and subtitle tracks (tracks-streams) ----------------------------
    // tracks() lists the file's sound and subtitle streams; selectAudio/selectSub
    // switch without touching the picture (the worker rewinds the demuxer and
    // skips what it already handed out). Text subtitle cues go to
    // player.onSubCue({start, end, text, ass?, track}) once per selection, in
    // player time (like currentTime()); subCues() returns those read so far.
    // Picture subtitles (kind 'bitmap': PGS, DVB, DVD) go the same way as
    // {start, end|null, rects, frame, span, gen, track}, plus span markers without
    // rects; they are not kept here (see onSubs and Subtitles.BitmapCueIndex).

    tracks() {
      const t = this.info && this.info.tracks;
      const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));
      return {
        audio: t ? t.audio.map((a) => pick(a, ['id', 'codec', 'lang', 'title', 'channels', 'default', 'forced'])) : [],
        sub: t ? t.sub.map((x) => pick(x, ['id', 'codec', 'lang', 'title', 'default', 'forced', 'kind', 'header'])) : [],
        audioId: this.audioId === undefined ? null : this.audioId,
        subId: this.subId === undefined ? null : this.subId,
      };
    }

    disposedError() {
      return Object.assign(new Error('player disposed'), { disposed: true });
    }

    /** Waits for the worker's answer of this type (or its error from `where`). */
    waitWorker(type, where) {
      if (this.disposed) return Promise.reject(this.disposedError());
      return new Promise((res, rej) => (this.waits = this.waits || []).push({ type, where, res, rej }));
    }

    settleWait(m) {
      const i = this.waits.findIndex((w) => w.type === m.type || (m.type === 'error' && m.where === w.where));
      if (i < 0) return;
      const [w] = this.waits.splice(i, 1);
      if (m.type === 'error') w.rej(new Error(m.message)); else w.res(m);
    }

    /** One track change at a time. */
    trackOp(fn) {
      this.trackChain = (this.trackChain || Promise.resolve()).catch(() => {}).then(() => {
        if (this.disposed) throw this.disposedError();
        return fn();
      });
      return this.trackChain;
    }

    /** Switches the sound to stream `id`. Resolves with tracks(). */
    selectAudio(id) {
      return this.trackOp(async () => {
        const tr = this.info && this.info.tracks && this.info.tracks.audio.find((a) => a.id === id);
        if (!tr) throw new Error(`no audio track ${id}`);
        if (this.cfg.native) throw new Error('switching the sound needs the built-in decoder');
        if (id === this.audioId) return this.tracks();
        const { mode, conf } = await this.audioConfig(tr);
        if (this.disposed) throw this.disposedError();
        const now = this.now();
        const prev = this.audioId;
        this.loopCache = null;
        this.loopOverBudget = false;
        this.audioId = id; // from here on, sound of the old track is dropped
        if (this.adec) { try { this.adec.close(); } catch { /* closed */ } this.adec = null; }
        this.stopAudio();
        this.audio = [];
        this.audioKeepUntil = undefined;
        if (this.playing) this.anchor(now);
        const reply = this.waitWorker('audioSelected', 'selectAudio');
        this.worker.postMessage({ type: 'selectAudio', id, mode, t: now });
        let r;
        try { r = await reply; } catch (e) { this.audioId = prev; throw e; }
        if (this.disposed) throw this.disposedError();
        this.amode = r.audio;
        this.aconf = conf;
        this.info.audio = tr;
        if (r.audioError) { log(r.audioError); toast(`No sound: ${tr.codec} is not in the built-in decoder`); }
        if (this.amode === 'webcodecs') this.makeAudioDecoder();
        this.ensureAudio();
        if (r.rewound) { this.eof = false; this.catchUp = true; this.rewinds = (this.rewinds || 0) + 1; this.readVT = undefined; }
        log(`audio track ${id} (${tr.codec}${tr.lang ? ` ${tr.lang}` : ''}): ${this.amode}${r.rewound ? '' : ', not rewound'}`);
        this.pump();
        onTracks(this);
        return this.tracks();
      });
    }

    /** Shows subtitle stream `id`, or none for null. Resolves with tracks(). */
    selectSub(id) {
      return this.trackOp(async () => {
        const want = id === null || id === undefined ? null : id;
        const tr = want === null ? null : this.info && this.info.tracks && this.info.tracks.sub.find((x) => x.id === want);
        if (want !== null && !tr) throw new Error(`no subtitle track ${id}`);
        if (want !== null && this.cfg.native) throw new Error('embedded subtitles need the built-in decoder');
        if (want === this.subId) return this.tracks();
        const prev = this.subId;
        this.loopCache = null;
        this.subId = want;
        this.pendingCues = null;
        // Cues of this track read before come first; new ones follow as they are read.
        for (const c of this.cueList(want)) this.emitCue(c);
        const reply = this.waitWorker('subSelected', 'selectSub');
        this.worker.postMessage({ type: 'selectSub', id: want, t: this.now() });
        let r;
        try { r = await reply; } catch (e) { this.subId = prev; throw e; }
        if (this.disposed) throw this.disposedError();
        if (r.rewound) { this.eof = false; this.catchUp = true; this.rewinds = (this.rewinds || 0) + 1; this.readVT = undefined; }
        if (r.error) { log(r.error); toast(`Subtitles: ${tr ? tr.codec : ''} is not in the built-in decoder`); }
        if (tr) log(`subtitle track ${want} (${tr.codec}, ${tr.kind})${r.rewound ? '' : ', not rewound'}`);
        this.pump();
        onTracks(this);
        return this.tracks();
      });
    }

    onSubs(m) {
      // Picture subtitles are not kept here (the overlay keeps a bounded window of them):
      // a span marker, then the pictures, each tagged with its span and the worker's gen.
      if (m.bitmap) {
        if (m.id !== this.subId) return;
        this.emitCue({ track: m.id, span: m.span, gen: m.gen, rects: null });
        for (const c of m.cues) this.emitCue({ ...c, track: m.id, span: m.span, gen: m.gen });
        return;
      }
      let cache = this.cueCache && this.cueCache.get(m.id);
      if (!cache) (this.cueCache = this.cueCache || new Map()).set(m.id, (cache = new Map()));
      for (const c of m.cues) {
        const key = `${c.start.toFixed(3)}|${c.ass || c.text}`;
        if (cache.has(key)) continue;
        const cue = { ...c, track: m.id };
        cache.set(key, cue);
        if (m.id === this.subId) this.emitCue(cue);
      }
    }

    cueList(id) {
      const cache = id !== null && id !== undefined && this.cueCache && this.cueCache.get(id);
      return cache ? [...cache.values()].sort((a, b) => a.start - b.start) : [];
    }

    playerCue(c) {
      if (c.span !== undefined) {
        const pic = { track: c.track, span: c.span, gen: c.gen, rects: c.rects };
        if (c.rects) Object.assign(pic, { start: this.rel(c.start), end: c.end === null ? null : this.rel(c.end), frame: c.frame });
        return pic;
      }
      const cue ={ start: this.rel(c.start), end: this.rel(c.end), text: c.text, track: c.track };
      if (c.ass !== undefined) cue.ass = c.ass;
      return cue;
    }

    /** To the overlay in player time; held back until the first frame fixes the start time. */
    emitCue(c) {
      if (this.startT === null && this.info && this.info.video && this.vmode !== 'none') { (this.pendingCues = this.pendingCues || []).push(c); return; }
      if (typeof this.onSubCue !== 'function') return;
      try { this.onSubCue(this.playerCue(c)); } catch (e) { log(`onSubCue: ${e && e.message || e}`); }
    }

    /** Cues of the selected subtitle read so far, in player time. */
    subCues() { return this.startT === null && this.info && this.info.video && this.vmode !== 'none' ? [] : this.cueList(this.subId).map((c) => this.playerCue(c)); }

    // ---- seek-bar thumbnails (thumbs.js, thumbs-worker.js) -------------------
    // Shown frames become small previews for free (captureThumb). Keyframes come from the pointer on the seek bar and,
    // after the first frame, from a low-priority background pass (clock tile only); exact pictures where the pointer
    // rests and from the pass's fill, which gives every slot a frame of its own. They are decoded by a second
    // libav.js worker whose file reads share the block cache above as
    // reader 'thumbs', or for native ffmpeg and Live transcode by a short ffmpeg on the extension host
    // (src/thumbhost.js, never the running stream). Not for URLs or audio-only files; MJPEG/image sequences use
    // FramePlayer and have no thumbnails (docs/notes/seek-preview.md).

    /** The thumbnail service, made on first use (a capture or a hover); null when this file has none. */
    thumbService() {
      if (this.thumbs) return this.thumbs;
      const v = this.info && this.info.video;
      if (typeof ThumbService !== 'function' || !v || this.vmode === undefined || this.vmode === 'none' || this.startT === null || !(this.meta.duration > 0)) return null;
      if (!this.cfg.native && !this.libavBlobs) return null; // Live transcode (remoteStream) asks the host like native ffmpeg
      if (this.cfg.net) return null; // a URL: every thumbnail would be more HTTP range requests
      const startT = this.startT;
      this.thumbs = new ThumbService({
        workerSrcUrl: String(this.cfg.workerUrl || '').replace(/decoder-worker\.js(\?.*)?$/, 'thumbs-worker.js$1'),
        libav: this.libavBlobs, size: this.meta.size, duration: this.meta.duration, startT,
        fps: this.fps, rotation: this.cfg.rotation || 0, remote: !!this.cfg.remote, log, cap: this.mem.thumbs,
        onRead: (pos, len) => this.thumbRead(pos, len),
        onIdle: () => this.dropBlockReader('thumbs'),
        busy: () => this.thumbsBusy(),
        hidden: () => !!this.hidden || this.disposed,
        passOn: () => !this.thumbPassOff && isClock(),
        pass: this.cfg.thumbPass === false ? undefined : {},
        playing: () => !!this.playing,
        // Files playback decodes with WebCodecs (H.264, VP8): sweeps on a hardware decoder of the worker's own.
        hw: !this.cfg.native && this.vmode === 'webcodecs' && this.vconf ? this.vconf : null,
        hwOn: () => !this.previewDecoderOff,
        // First guess per frame between keyframes, refined by replies: about 1 ns per source pixel for native ffmpeg
        // with the cheap flags (2 threads), PER_PX_WASM for the single-threaded worker (docs/notes/seek-preview.md).
        // Native and Live transcode decode the source, not the smaller picture they send the page.
        frameMs: ((v.sourceWidth || v.width) * (v.sourceHeight || v.height) || 2e6)
          * (this.cfg.native ? 1e-6 : PER_PX_WASM),
        request: this.cfg.native ? async (t, w, h, signal, mode, opts) => {
          const o = opts || {};
          const r = await this.hostThumb(t - startT, w, h, signal, mode, { pass: !!o.pass, ...(mode === 'sweep' ? { to: o.to - startT, step: o.step, gpu: !!o.gpu } : {}) });
          if (!r) return null;
          const abs = (rel) => (Number.isFinite(rel) ? startT + rel : undefined);
          const kt = abs(r.rel);
          const next = r.next && abs(r.next.rel) !== undefined ? { kt: abs(r.next.rel), data: r.next.data } : undefined;
          const more = r.more && r.more.map((x) => ({ kt: abs(x.rel), data: x.data }));
          return { ...r, kt, next, more, covered: kt !== undefined && (mode === 'key' || mode === 'near') };
        } : undefined,
      });
      return this.thumbs;
    }

    /** Hover at `rel` seconds: cb(picture) now or when decoded. False when there are no thumbnails. */
    thumbnail(rel, cb, scrub = false) {
      if (this.hidden || this.disposed) return false;
      const s = this.thumbService();
      if (!s) return false;
      const gen = this.gen;
      s.hover(rel, (picture) => {
        if (!this.hidden && !this.disposed && this.gen === gen) cb(picture);
      }, scrub);
      return true;
    }

    /**
     * Native and Live transcode backend: one thumbnail from the extension host ({rel, w, h, fmt: 'jpeg', data, next?,
     * more?, end?, cpu?: ms of CPU, gpu?: the method}, or null).
     * @param {'key' | 'near' | 'exact' | 'run' | 'sweep'} [mode]
     * @param {{pass?: boolean, to?: number, step?: number, gpu?: boolean}} [opts] pass: a background pass request (one
     *   thread); to, step: a sweep's end (seconds from the start) and step; gpu: the sweep is worth the GPU
     */
    hostThumb(rel, w, h, signal, mode = 'key', opts = {}) {
      const id = (this.hostThumbId = (this.hostThumbId || 0) + 1);
      this.hostThumbWait = this.hostThumbWait || new Map();
      return new Promise((resolve) => {
        // checkJs: start
        const request = /** @satisfies {ThumbRequest} */ ({
          type: 'thumb', page: env.page, id, t: Math.max(0, rel), w, h, mode, ...(opts.pass ? { pass: true } : {}),
          ...(mode === 'sweep' ? { to: opts.to, step: opts.step, gpu: !!opts.gpu } : {}),
        });
        // checkJs: end
        const cancel = () => {
          done(null);
          vscode.postMessage({ ...request, cancel: true });
        };
        const done = (m) => {
          clearTimeout(timer);
          signal.removeEventListener('abort', cancel);
          this.hostThumbWait.delete(id);
          resolve(m);
        };
        const timer = setTimeout(cancel, mode === 'sweep' ? 30e3 : 10e3);
        this.hostThumbWait.set(id, done);
        signal.addEventListener('abort', cancel, { once: true });
        vscode.postMessage(request);
      });
    }

    /** player.js: the host's answer to hostThumb(). */
    onHostThumb(m) {
      if (m.page !== env.page) return;
      const done = this.hostThumbWait && this.hostThumbWait.get(m.id);
      if (!done) return;
      const next = m.next && m.next.data ? { rel: m.next.rel, data: new Uint8Array(m.next.data) } : undefined;
      const more = Array.isArray(m.more) ? m.more.filter((x) => x && x.data).map((x) => ({ rel: x.rel, data: new Uint8Array(x.data) })) : undefined;
      const cost = { cpu: Number.isFinite(m.cpu) ? m.cpu : undefined, gpu: typeof m.gpu === 'string' ? m.gpu : undefined };
      done(m.data ? { rel: m.rel, w: m.w, h: m.h, fmt: m.fmt, data: new Uint8Array(m.data), next, kn: m.kn === null ? null : undefined, more, end: m.end === true, ...cost } : null);
    }

    /**
     * The frame just drawn at `t` as a seek-bar preview, when its slot has none: the canvas (already turned and
     * tone-mapped) scaled to the 160 x 120 box, at most one per slot, one at a time, never while playback is behind.
     */
    captureThumb(t) {
      if (!this.thumbPassArmed) this.armThumbPass();
      if (this.capturing || this.captureOff || this.hidden || this.disposed || typeof createImageBitmap !== 'function') return;
      const cv = this.gl && this.gl.cv;
      if (!cv || !(cv.width > 0 && cv.height > 0) || !isClock()) return;
      const s = this.thumbService();
      if (!s || !s.wants(t) || this.playbackBehind()) return;
      const k = Math.min(160 / cv.width, 120 / cv.height);
      const resizeWidth = Math.max(1, Math.round(cv.width * k));
      const resizeHeight = Math.max(1, Math.round(cv.height * k));
      const t0 = performance.now();
      this.capturing = true;
      let pending;
      try {
        pending = createImageBitmap(cv, { resizeWidth, resizeHeight, resizeQuality: 'low' });
      } catch { this.capturing = false; return; }
      const syncMs = performance.now() - t0; // what the frame loop paid; the scaling finishes off it
      pending.then((b) => {
        if (this.thumbs === s && !this.disposed) s.offer(t, b, 0, Math.round(syncMs * 100) / 100); else b.close();
      }, () => {}).finally(() => { this.capturing = false; });
    }

    /** After the first frame drawn while visible on the clock tile: the background keyframe pass, once per file. */
    armThumbPass() {
      if (this.hidden || this.disposed || !isClock()) return;
      this.thumbPassArmed = true;
      const s = this.thumbService();
      if (s) s.passArm();
    }

    /** Tests: thumbnail service counters, or null while nothing has made it. */
    thumbStrip() { return this.thumbs ? this.thumbs.stats0() : null; }

    thumbnailLeave(immediate = false) { if (this.thumbs) this.thumbs.leave(immediate); }

    /** A thumbnail-worker read: like onWorkerRead, but only the block it needs (no read-ahead). */
    thumbRead(pos, len) {
      this.onWorkerRead(pos, len, 'thumbs');
    }

    /** Decoding is behind (a status warning or a recent catch-up). */
    playbackBehind() {
      const st = this.status();
      if (st && st.level === 'warn') return true;
      return !!(this.behindUntil && performance.now() < this.behindUntil);
    }

    /** Playback needs the CPU: decoding is behind, or little is decoded ahead while playing. */
    thumbsBusy() {
      if (this.playbackBehind()) return true;
      if (!this.playing || this.vmode === 'none' || this.eof) return false;
      const ahead = this.queue.length ? this.queue[this.queue.length - 1].t - this.now() : 0;
      return ahead < 0.5;
    }

    /** Block answers go to the reader that asked (pool workers by rid, or the thumbnail worker). */
    sendBlock(rid, msg, transfer) {
      if (rid === 'thumbs') { if (this.thumbs) this.thumbs.post(msg, transfer); return; }
      // X-ray index worker and other side readers register in sideReaders (rid -> worker).
      const side = this.sideReaders && this.sideReaders.get(rid);
      (side || this.worker).postMessage(msg, transfer);
    }
    // ---- end of seek-bar thumbnails --------------------------------------------

    revokeBlobs() {
      const b = this.libavBlobs;
      if (b) for (const u of [b.loader, b.toImport, b.wasmurl]) URL.revokeObjectURL(u);
      if (this.workerBlob) URL.revokeObjectURL(this.workerBlob);
      this.libavBlobs = null;
      this.workerBlob = null;
    }

    /** HDR output for this page (media/hdr.js): null on pages without the setting (compare). */
    hdrStart() {
      if (typeof VpeHdr === 'undefined' || !this.cfg.hdrOutput) return Promise.resolve(null);
      return VpeHdr.start(this.cfg.hdrOutput, !!this.cfg.hdrForce).catch((e) => { log(`HDR output check failed: ${e}`); return null; });
    }

    /**
     * HDR video (PQ / HLG): shown as HDR when the display reports HDR and WebGPU has an
     * extended-range canvas here (media/hdr.js), else tone-mapped to SDR as before. The page's
     * canvas always keeps the tone-mapped picture: the pixel tools, scopes and export read it.
     */
    async setupHdr(v) {
      if (!v || (v.colorTrc !== 16 && v.colorTrc !== 18) || this.hdrOutput) return;
      const h = await this.hdrStart();
      if (this.disposed || this.hdrOutput) return;
      this.hdrOutput = { on: false, why: h ? h.why : 'not available here' };
      if (h && h.on) {
        try {
          const out = new VpeHdr.Output(h.device, canvas);
          this.hdrOutput = { on: true, why: h.why, out };
          this.gl.twin = (f) => {
            try {
              if (!f || !this.gl.hdr) out.hide();
              else out.draw({ ...f, space: f.space || matrixBySize(f.width, f.height) }, this.gl.rot);
            } catch (e) {
              // The SDR picture below stays: HDR output stops for this player.
              log(`HDR output failed: ${e && e.message || e}`);
              this.gl.twin = null;
              out.dispose();
              this.hdrOutput = { on: false, why: `failed: ${String(e && e.message || e).slice(0, 120)}` };
            }
          };
          // The picture already shown (paused at the first frame) gets its HDR version now.
          const ls = this.lastShown;
          if (ls && ls.yuv) this.gl.twin(ls.yuv);
        } catch (e) {
          log(`HDR output failed: ${e && e.message || e}`);
          this.hdrOutput = { on: false, why: `failed: ${String(e && e.message || e).slice(0, 120)}` };
          this.gl.twin = null;
        }
      }
      const label = VpeHdr.outputLabel(this.hdrOutput.on);
      log(`HDR: ${label} (${this.hdrOutput.why})`);
      if (this.meta.label && !this.meta.label.includes(label)) {
        this.meta.label = this.meta.label.replace(/ · HDR (PQ|HLG)/, `$& (${label})`);
        if (this.n) env.onMeta(this);
      }
    }

    dispose() {
      if (this.disposed) return;
      clearTimeout(this.fillTimer);
      if (this.sharpTimer) clearTimeout(this.sharpTimer);
      this.sharp = null;
      if (this.sharpDec) { try { this.sharpDec.close(); } catch { /* closed */ } this.sharpDec = null; }
      this.disposed = true;
      this.remoteFragment = null;
      this.loopCache = null;
      if (this.hdrOutput && this.hdrOutput.out) { this.hdrOutput.out.dispose(); this.gl.twin = null; }
      if (this.boot) this.boot.drop();
      if (this.remoteAudioBoot) this.remoteAudioBoot.drop();
      if (this.remoteAudioPending) {
        for (const pending of this.remoteAudioPending.values()) pending.resolve([]);
        this.remoteAudioPending.clear();
      }
      this.gen++; // late decoder outputs and worker messages of the old generation are dropped
      this.blockCache?.dispose();
      clearTimeout(this.acTimer);
      clearTimeout(this.acWakeTimer);
      this.endSteps();
      if (this.waits && this.waits.length) {
        const err = this.disposedError();
        for (const w of this.waits.splice(0)) w.rej(err);
      }
      if (this.thumbs) this.thumbs.dispose();
      if (this.hostThumbWait) {
        for (const done of this.hostThumbWait.values()) done(null);
        this.hostThumbWait.clear();
      }
      if (this.worker) this.worker.terminate();
      this.stopAudio();
      if (this.ac) this.ac.close().catch(() => {});
      for (const f of this.queue) this.release(f);
      if (this.lastShown && this.lastShown.vf) this.lastShown.vf.close();
      this.lastShown = null;
      this.queue = [];
      this.releaseHold();
      for (const d of [this.vdec, this.adec]) if (d && d.state !== 'closed') { try { d.close(); } catch { /* closed */ } }
      this.gl?.dispose?.();
      this.revokeBlobs();
    }
  }

  return { LibavPlayer, preload, dropPreload };
}
