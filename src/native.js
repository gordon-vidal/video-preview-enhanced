'use strict';
// Optional native backend: ffmpeg decodes (on the GPU where it can) and writes
// raw YUV 4:2:0 frames and float PCM, which the webview draws and plays. It
// speaks the same messages as media/decoder-worker.js (open, config, more, seek),
// so the webview engine treats both alike. Nothing is ever encoded.

const { spawn } = require('child_process');
const ff = require('./ffmpeg');
const hw = require('./hwaccel');
const frameserver = require('./frameserver');
const stamps = require('./nativepts');
const Grid = require('../media/compare-grid');

const MAX_QUEUED_FRAMES = 12; // on a 32 GB machine; less on smaller ones (opts.maxQueued, media/membudget.js)
// Sound goes out at the page's AudioContext rate (the page tells us when it makes one; else 48 kHz):
// Web Audio resamples a buffer of any other rate itself, but ffmpeg's resampler is better and it
// is one step less. A rate told mid-run applies from the next start of ffmpeg (startAt).
const AUDIO_RATE = 48000;
let lastAudioRate = AUDIO_RATE; // the last rate a page told: later files of the window start with it
const sane = (r) => (Number.isFinite(r) && r >= 8000 && r <= 192000 ? Math.round(r) : 0);
const STANDBY_MS = 20000;
// The webview has this long to connect to the frame server before frames go by postMessage.
const CONNECT_MS = 3000;
// fitView: frames no larger than the player's picture needs, in these steps (the smallest that holds
// the picture's device pixels). A 4K frame costs the extension host, VS Code's network process, the
// renderer and the GPU process about 2.4 cores together on an i7-9700K (docs/notes/cpu-4k.md); 1080p
// still ~0.8 core at 30 fps, so a picture shown at 720 or 540 device pixels (a split editor, a laptop
// panel) gets 720p or 540p frames (docs/notes/perf-invisible.md).
const VIEW_HEIGHTS = [540, 720, 1080, 1440, 2160];
// Failures last as long as this ffmpeg installation's tools object. Keep small inputs
// separate because hardware decoders can reject dimensions below their minimum.
const failedGpuFilters = new WeakMap();
// Methods guessed without a GPU test (decide.vendorMethod) that produced no picture, per ffmpeg
// installation and class (same key shape as the filters): later files of that class start with
// ffmpeg's own pick instead of failing once more.
const failedMethods = new WeakMap();
// ffmpeg builds (per tools) whose filter graph refused the timestamp filter: the next decoders skip it.
const noStampTools = new WeakSet();
// Pictures that may wait for their timestamp before the pipe is taken for silent (about two frames of skew are normal).
const MAX_UNPAIRED = 16;
// More than this many unpaired pictures and the reader waits for the stamps (they are a pipe read behind); if none
// arrives in STAMP_SILENCE_MS the pipe is taken for dead.
const STAMP_SKEW = 8;
const STAMP_SILENCE_MS = 3000;
const STAMP_FAILURE = /metadata|No such filter|No option name|Error (?:parsing|initializing|reinitializing) (?:a )?filter|Bad file descriptor|pipe:4/i;
// Told when a guessed method fails (the extension detects the GPUs again: they may have changed).
let guessFailed = () => {};
function onGuessFailed(fn) { guessFailed = typeof fn === 'function' ? fn : () => {}; }

function gpuFilterKey(filter, v) {
  return `${filter}/${v.codec}/${v.pixFmt}/${v.height < 144 ? 'small' : hw.classOf(v.codec, hw.depthOf(v.pixFmt, v.codec), v.width, v.height)}`;
}

class NativeDecoder {
  /**
   * method: the decoding method from the probe ('d3d11va', 'qsv', 'none'…; 'auto'
   * before the probe has run). onFail(error, rejectedMedia): native ffmpeg failed
   * (failed again in software after a GPU method failed); the caller switches to
   * the built-in decoder.
   * transport: how frames reach the webview. 'message': postMessage (postRaw). 'http' / 'ws': the
   * localhost frame server (src/frameserver.js), falling back to postMessage by itself when the
   * server can't start, the webview can't connect within CONNECT_MS or the connection drops.
   * 'fail' (tests): a channel the webview can't open, to exercise that fallback.
   * maxHeight: the frame size cap; messageMaxHeight: a lower cap when frames go by postMessage
   * (decided when the transport settles or changes).
   */
  constructor({ tools, file, input, post, postRaw, log, maxHeight, messageMaxHeight, method, methodGuessed, onFail, probed, stats, transport, origin, maxQueued, onMessages, fitView, view, largeGrid = false }) {
    this.transport = transport || 'message';
    this.onMessages = onMessages; // told once frames fall back to messages mid-play (compare re-sizes every tile)
    this.origin = origin;
    this.maxQueued = maxQueued > 0 ? maxQueued : MAX_QUEUED_FRAMES;
    // A tile of compare's large grid (5-16 videos, media/compare-grid.js): fewer frames in flight, no loop standby.
    this.largeGrid = !!largeGrid;
    this.credit = Grid.nativeCredits(this.largeGrid);
    this.messageMaxHeight = messageMaxHeight || maxHeight || 1080;
    this.link = 'message'; // 'pending' (waiting for the webview to connect), 'stream', 'message'
    this.tools = tools;
    this.file = file;
    // What ffmpeg reads: the file's path, or { url, proxy } for a URL the user entered (src/ffmpeg.js inputArgs).
    this.input = input || file;
    this.post = post;
    this.postRaw = postRaw;
    this.log = log;
    this.maxHeight = maxHeight || 1080;
    // The player's picture area in device pixels ({ w, h }, sent by the page; at first the last one seen):
    // with fitView, the frame height steps down to what it shows (VIEW_HEIGHTS).
    this.fitView = !!fitView;
    this.view = viewOf(view);
    this.method = method || 'none';
    // No GPU test chose the method (decide.vendorMethod): when it fails, ffmpeg's own pick comes before software.
    this.methodGuessed = !!methodGuessed && this.method !== 'auto' && this.method !== 'none';
    const v = probed && probed.video;
    if (this.methodGuessed && v && failedMethods.get(tools)?.has(gpuFilterKey(this.method, v))) {
      this.method = 'auto';
      this.methodGuessed = false;
    }
    this.onFail = onFail || (() => {});
    this.pr = probed || null;
    this.stats = !!stats; // test logs: where the frames wait, every 2 s
    this.proc = null;
    this.gen = 0;
    this.frames = []; // (startAt resets them) the transport can settle before the first start
    this.credits = 0;
    this.early = null; // { w, h }: ffmpeg started before the page was ready (prestart)
  }

  /**
   * Starts ffmpeg before the webview is ready: its spawn, demux and first decode (300-450 ms for
   * 4K) overlap the page load. Frames wait here (no credits yet; at most maxQueued, then ffmpeg
   * blocks) at the size the expected transport takes: the frame server's, unless frames go by
   * message. open() keeps the process when the transport settles at that size and restarts it
   * at the new size otherwise. Nothing reaches the webview before attach() and its 'open'.
   */
  prestart() {
    const v = this.pr.video;
    if (v) {
      this.sizeVideo(this.transport === 'message' ? 'message' : 'stream');
      this.fps = v.fps || 30;
    }
    this.startAt(0);
    this.early = { w: this.w, h: this.h };
    this.log(`native: ffmpeg started before the page (${v ? `${this.w}x${this.h}` : 'sound only'}, pid ${this.proc.pid})`);
  }

  /** The session's page: where messages go, the failure handler and the webview's origin (frame server). */
  attach({ post, postRaw, onFail, origin }) {
    this.post = post;
    this.postRaw = postRaw;
    this.onFail = onFail;
    this.origin = origin;
  }

  /** True when what the webview gets differs from the file's pixels: scaled down, or deeper/fuller chroma than 8-bit 4:2:0. */
  lossy() {
    const v = this.pr && this.pr.video;
    if (!v) return false;
    return this.h !== v.height || this.w !== v.width || !/^(yuv420p|yuvj420p|nv12)$/.test(v.pixFmt || '');
  }

  async handle(m) {
    if (this.disposed) return undefined;
    switch (m.type) {
      case 'open': return this.open(m);
      case 'config': return this.post({ type: 'configured', video: this.pr.video ? 'soft' : 'none', audio: this.pr.audio ? 'soft' : 'none' });
      case 'more': return this.more(m);
      case 'seek': return this.seek(m);
      case 'transport': return this.toMessages(`webview: ${String(m.failed || 'failed').slice(0, 200)}`);
      case 'view': return this.setView(m);
      case 'hidden': return this.setHidden(!!m.on);
      case 'audioRate': { const r = sane(m.rate); if (r) { lastAudioRate = r; if (r !== (this.nextRate || this.rate)) this.takeStandby(NaN); this.nextRate = r; } return undefined; }
      default: return undefined;
    }
  }

  /**
   * The tab was hidden: ffmpeg, its standby and the frames waiting here go (a blocked ffmpeg holds
   * its GPU decoder and up to maxQueued frames in this process). Showing the tab re-seeks the page
   * (media/engine.js setHidden), and the seek starts ffmpeg again, as any seek does.
   */
  setHidden(on) {
    this.hidden = on;
    if (!on || !this.fps || this.disposed) return;
    const had = !!this.proc || !!this.standby;
    this.kill();
    this.takeStandby(NaN);
    this.frames = [];
    this.audioChunks = [];
    this.audioBytes = this.credits = 0;
    this.draining = false;
    if (had) this.log('native: tab hidden, ffmpeg stopped until it is shown');
  }

  /** m.hdr: the page shows HDR video as HDR (media/hdr.js): PQ / HLG video then comes as 10-bit samples. */
  async open(m = {}) {
    const pr = this.pr || await ff.probe(this.tools, this.input);
    this.pr = pr;
    this.deep = !!(m && m.hdr) && isHdr(pr.video);
    if (viewOf(m && m.view)) this.view = viewOf(m.view);
    if (pr.video) {
      // The webview connects to the frame server first (one round trip, ~15 ms): the frame size
      // depends on how the frames will travel.
      const link = await this.openChannel();
      if (link) {
        const settled = new Promise((r) => { this.settle = r; });
        this.post({ type: 'link', ...link });
        await settled;
      }
      if (this.disposed) return;
      this.sizeVideo();
      this.fps = pr.video.fps || 30;
      if (this.fitView && this.view) this.log(`native: picture ${this.view.w}x${this.view.h}: frames at ${this.w}x${this.h}`);
    }
    if (this.disposed || this.failed) return; // failed: onFail already switched the page to the built-in decoder
    const early = this.early;
    this.early = null;
    if (early && this.proc && this.w === early.w && this.h === early.h && !this.deep) {
      this.log(`native: keeping the ffmpeg started before the page (${Date.now() - this.spawnedAt} ms ago, ${this.frames.length} frames waiting)`);
    } else {
      if (early) {
        this.log(`native: restarting ffmpeg at ${this.w}x${this.h}${this.deep ? ' 10-bit for HDR output' : ''} (started before the page at ${early.w}x${early.h})`);
        this.takeStandby(NaN);
      }
      this.startAt(0);
    }
    this.post({
      type: 'streams',
      info: {
        duration: pr.duration,
        native: true,
        video: pr.video ? { codec: pr.video.codec, width: this.w, height: this.h, format: 0, sourceWidth: pr.video.width, sourceHeight: pr.video.height, pixFmt: pr.video.pixFmt, fps: this.fps, bitRate: pr.video.bitRate || 0, ...colourTags(pr.video), ...(this.deep ? { depth: 10 } : {}), ...(pr.video.dv ? { dv: pr.video.dv } : {}) } : null,
        audio: pr.audio ? { codec: pr.audio.codec, sampleRate: this.rate || lastAudioRate, channels: 2, sourceRate: pr.audio.sampleRate || 0, sourceChannels: pr.audio.channels || 0, bitRate: pr.audio.bitRate || 0 } : null,
        // For the player's "About this video" panel (media/controls.js facts).
        method: this.method, trackCounts: pr.counts || null,
      },
    });
  }

  /** The output size for a link ('stream': the frame server's cap; else the message cap). */
  videoSize(link = this.link) {
    const v = this.pr.video;
    const cap8 = link === 'stream' ? this.maxHeight : Math.min(this.maxHeight, this.messageMaxHeight);
    // HDR output: two bytes per sample; the same bytes per frame as 8-bit at the cap (1/sqrt(2) the height).
    // The picture's size caps it too (fitView), as is: it is no transfer limit.
    const cap = Math.min(this.deep ? Math.floor(cap8 / Math.SQRT2) : cap8, this.viewCap());
    const h = Math.min(v.height, cap);
    const height = h - (h % 2);
    const w = Math.round(v.width * height / v.height);
    return { width: w - (w % 2), height };
  }

  /** The frame height the player's picture needs (a VIEW_HEIGHTS step), Infinity without fitView or a known view. */
  viewCap() {
    const v = this.pr && this.pr.video;
    const view = this.fitView && this.view;
    if (!v || !view) return Infinity;
    const r = v.height / Math.max(1, v.width);
    // Either orientation (phone videos turn in the shader): the larger picture height it could need.
    const need = Math.max(Math.min(view.h, view.w * r), Math.min(view.w, view.h * r));
    return VIEW_HEIGHTS.find((h) => h >= need) || Infinity;
  }

  /** The page's picture area changed (opened, resized, fullscreen): a new frame size applies with a seek to the same moment. */
  setView(m) {
    const view = viewOf(m);
    if (!view) return;
    this.view = view;
    if (this.fitView) this.reSize(`picture ${view.w}x${view.h}`);
  }

  /** The sizeFramesToView setting changed: frames follow the picture (on) or the cap alone (off). */
  setFit(on) {
    if (this.fitView === !!on) return;
    this.fitView = !!on;
    this.reSize(`frames sized to the picture ${on ? 'on' : 'off'}`);
  }

  /** Applies a new frame size (videoSize) with the next seek: at once when larger, at the next seek or loop when smaller. */
  reSize(why) {
    if (!this.fps || !this.w) return; // open() sizes the frames
    const { width, height } = this.videoSize();
    if (width === this.w && height === this.h) return;
    // Applied by the next seek (seek()). Larger frames are worth one now (fullscreen); smaller ones wait
    // for the next seek or loop, so a picture resized back and forth across a step doesn't restart ffmpeg each time.
    this.resizePending = true;
    const grow = height > this.h;
    this.log(`native: ${why}: frames ${this.w}x${this.h} -> ${width}x${height}${grow ? '' : ' at the next seek'}`);
    if (grow && !this.recovering) this.post({ type: 'refresh' });
  }

  sizeVideo(link = this.link) {
    const { width, height } = this.videoSize(link);
    this.w = width;
    this.h = height;
  }

  /** Update the caps; return true if compare needs to seek this tile to apply them. */
  resize(maxHeight, messageMaxHeight) {
    this.maxHeight = maxHeight;
    this.messageMaxHeight = messageMaxHeight;
    if (!this.fps || this.resizePending) return;
    const { width, height } = this.videoSize();
    if (width === this.w && height === this.h) return;
    this.resizePending = true;
    return !this.recovering; // the recovery seek can apply it too
  }

  /**
   * A frame server channel for this decoder ({ mode, url } for the webview), or null: frames go by
   * postMessage. Until the webview connects, frames wait (CONNECT_MS at most, then postMessage).
   */
  async openChannel() {
    if (this.transport === 'message' || !this.origin) return null;
    try { await frameserver.start(); } catch (e) { this.log(`native transport: message (frame server could not start: ${e.message})`); return null; }
    if (this.disposed) return null;
    const ch = new frameserver.Channel({
      origin: this.origin,
      onConnect: (kind) => {
        if (this.channel !== ch || this.link !== 'pending') return;
        clearTimeout(this.connectTimer);
        this.link = 'stream';
        this.log(`native transport: ${kind} (127.0.0.1:${frameserver.port}, connected after ${Date.now() - this.connectFrom} ms)`);
        this.settled();
        this.flushWaiting();
      },
      onLost: (why) => { if (this.channel === ch) this.toMessages(`connection lost: ${why}`); },
    });
    this.channel = ch;
    this.link = 'pending';
    this.connectFrom = Date.now();
    this.connectTimer = setTimeout(() => this.toMessages(`the editor did not connect within ${CONNECT_MS} ms`), CONNECT_MS);
    const mode = this.transport === 'ws' ? 'ws' : 'http';
    let url = ch.urls()[mode];
    if (this.transport === 'fail') url = url.replace(/[0-9a-f]{64}$/, '0'.repeat(64)); // tests: a wrong token (403)
    return { mode, url };
  }

  /** The transport is known (open() waits for it). */
  settled() {
    const r = this.settle;
    this.settle = null;
    if (r) r();
  }

  /** Frames go by postMessage from now on (the frame server failed, or was never used). */
  toMessages(why) {
    if (this.link === 'message') return;
    const restart = this.link === 'stream' && !!this.proc;
    const ch = this.channel;
    this.channel = null;
    clearTimeout(this.connectTimer);
    if (ch) ch.close();
    this.link = 'message';
    this.log(`native transport: message (${why})`);
    this.settled();
    // A large grid re-sizes all its tiles together for the message budget, also before ffmpeg starts.
    if (this.onMessages && (restart || this.largeGrid)) {
      this.messagesTimer = setTimeout(() => {
        this.messagesTimer = null;
        if (!this.disposed && this.onMessages) this.onMessages();
      }, 0);
    }
    // open() will choose the message size before starting ffmpeg; after a hidden tab stopped it, the next seek does.
    if (!restart) { if (this.fps && this.w) this.resizePending = true; return; }

    // Socket writes may have consumed credits or sent EOF without reaching the player. Wait
    // for its recovery seek so the new process starts at the latest target, in a new generation.
    this.recovering = true;
    this.kill();
    this.takeStandby(NaN);
    this.frames = [];
    this.audioChunks = [];
    this.audioBytes = this.credits = 0;
    this.draining = false;
    this.sizeVideo();
    this.post({ type: 'transport', width: this.w, height: this.h });
  }

  startAt(t, credits = 0) {
    this.kill();
    this.base = t;
    this.frameIndex = 0;
    this.samples = 0;
    this.rate = this.nextRate || lastAudioRate;
    this.frames = [];
    this.pending = Buffer.alloc(0);
    this.audioChunks = [];
    this.audioBytes = 0;
    this.ended = false;
    this.credits = credits;
    this.eofSent = false;
    this.gotOutput = false;
    const v = this.pr.video;
    const a = this.pr.audio;
    const proc = this.takeStandby(t) || this.launch(t);
    this.proc = proc;
    this.spawnedAt = proc.startedAt;
    this.frameBytes = v ? ((this.w * this.h * 3) / 2) * (this.deep ? 2 : 1) : 0;
    const err = proc.err;
    if (v) {
      // Pipe chunks are ~64 KB (190 per 4K frame). A frame is kept as its list of chunks, not
      // copied: the frame server writes the list as it is (one writev), postMessage joins it once.
      let parts = [];
      let have = 0;
      proc.clearPartialFrame = () => { parts = []; have = 0; };
      proc.stdout.on('data', (d) => {
        if (proc !== this.proc) return;
        const h0 = this.stats ? process.hrtime.bigint() : 0n;
        let off = 0;
        while (off < d.length) {
          const take = Math.min(d.length - off, this.frameBytes - have);
          parts.push(off === 0 && take === d.length ? d : d.subarray(off, off + take));
          off += take;
          have += take;
          if (have < this.frameBytes) break;
          this.picture(proc, parts);
          parts = [];
          have = 0;
          if (!this.gotOutput && this.stats) this.log(`native: first frame ${Date.now() - this.spawnedAt} ms after start`);
          this.gotOutput = true;
          if (this.st) this.st.read++;
        }
        // Backpressure: stop reading so ffmpeg blocks instead of filling memory.
        if (this.frames.length >= this.maxQueued) {
          this.lastBackpressureAt = Date.now();
          proc.stdout.pause();
        }
        if (this.st) this.st.readMs += Number(process.hrtime.bigint() - h0) / 1e6;
        this.flushWaiting();
      });
    }
    if (proc.stamped) {
      proc.raw = []; // pictures waiting for their timestamp
      proc.stampQ = [];
      proc.placed = 0;
      proc.resampler = new stamps.Resampler(this.fps);
      const parser = new stamps.StampParser();
      proc.stdio[stamps.STAMP_FD].setEncoding('utf8');
      proc.stdio[stamps.STAMP_FD].on('data', (d) => {
        if (proc !== this.proc || proc.untrusted) return;
        proc.stampQ.push(...parser.push(d));
        this.pair(proc);
        this.flushWaiting();
      });
    }
    if (a) {
      // Audio is small; always drain it so ffmpeg never blocks on this pipe.
      proc.stdio[3].on('data', (d) => {
        if (proc !== this.proc) return;
        this.audioChunks.push(Buffer.from(d));
        this.audioBytes += d.length;
        // Sound counts as output except while a GPU filter is on trial (its retry would repeat the
        // sound); a few seconds of sound without a picture ends the trial too (review 2026-11-19-6 #2).
        if (!proc.gpuFilter || this.audioBytes > 2e6) this.gotOutput = true;
        // Before the first picture there may be no video callback to flush the audio.
        if (!this.frameIndex && !this.frames.length && this.gotOutput) this.flushWaiting();
      });
    }
    let completed = false;
    const finish = (code, signal, error) => {
      if (completed || proc !== this.proc) return;
      completed = true;
      const failed = !!error || code !== 0 || !!signal;
      const exit = error ? ff.redactErrorUrls(error.message) : signal || `exit ${code}`;
      // A clipped first line may start halfway through a URL, so it cannot be safely redacted.
      const firstCompleteLine = err.clipped ? err.text.indexOf('\n') + 1 : 0;
      const diagnostic = err.clipped && !firstCompleteLine ? '' : err.text.slice(firstCompleteLine);
      const why = error ? exit : ff.redactErrorUrls(diagnostic).trim().split(/\r?\n/).slice(-2).join(' | ');
      if (error) this.log(`native ffmpeg spawn failed: ${why}`);
      else if (failed) this.log(`native ffmpeg exited ${signal || code}: ${why}`);
      if (failed && !this.gotOutput && proc.stamped && STAMP_FAILURE.test(err.text)) {
        // This build cannot run the timestamp filter (no metadata filter, no fd 4): one retry with ffmpeg's own
        // constant-rate output, before any GPU or decoder fallback.
        this.log(`ffmpeg refused the timestamp filter (${why}); decoding without source timestamps`);
        this.noStamps = true;
        noStampTools.add(this.tools);
        this.takeStandby(NaN);
        this.startAt(t, this.credits);
        return;
      }
      if (failed && !this.gotOutput) {
        if (proc.gpuFilter) {
          this.log(`${proc.gpuFilter} failed on this file; scaling in software with ${this.method} decoding`);
          let failed = failedGpuFilters.get(this.tools);
          if (!failed) failedGpuFilters.set(this.tools, failed = new Set());
          failed.add(proc.gpuFilterKey);
          this.takeStandby(NaN);
          this.startAt(t, this.credits);
          return;
        }
        // Nothing came out (like mpv's hwdec fallback): a GPU method that can't do this file
        // gets one more try in software; when software fails too, the built-in decoder takes over.
        if (this.method !== 'none') {
          const next = this.methodGuessed ? 'auto' : 'none';
          this.log(`${this.method} failed on this file; ${next === 'auto' ? "decoding with ffmpeg's own pick (-hwaccel auto)" : 'decoding in software'}`);
          if (this.methodGuessed && this.pr.video) {
            let failed = failedMethods.get(this.tools);
            if (!failed) failedMethods.set(this.tools, failed = new Set());
            failed.add(gpuFilterKey(this.method, this.pr.video));
            try { guessFailed(this.method); } catch { /* the listener's problem */ }
          }
          this.methodGuessed = false;
          this.method = next;
          this.startAt(t, this.credits); // the webview's requests still stand (review 2026-11-19-6 #1)
          return;
        }
        this.failed = true;
        // A spawn error or external kill says nothing about whether the media can be decoded.
        const rejectedMedia = !error && !!proc.pid && Number.isInteger(code) && code > 0 && !signal;
        this.onFail(why || exit, rejectedMedia);
        return;
      }
      if (proc.stamped) this.pair(proc, true);
      this.ended = true;
      this.flushWaiting();
      // 16 waiting ffmpegs (one per tile) cost more than a loop's start-up saves.
      if (!failed && proc === this.proc && !this.largeGrid) this.prepareLoop();
    };
    proc.on('error', (error) => finish(null, null, error));
    proc.on('close', (code, signal) => finish(code, signal));
    this.log(`native decode from ${t.toFixed(3)} s: ${this.w}x${this.h}${this.deep ? ' 10-bit (HDR output)' : ''} (${this.method === 'none' ? 'software' : this.method})${proc.gpuFilter ? `, ${proc.gpuFilter}` : ''}${proc.adopted ? ', ffmpeg prepared at the end' : ''}`);
  }

  /** An ffmpeg decoding from t (output not read yet). */
  launch(t) {
    const v = this.pr.video;
    const a = this.pr.audio;
    const modern = !this.tools.legacy;
    const filter = v ? hw.gpuFilter(this.method, this.tools.gpuFilters, v) : '';
    const filterKey = filter ? gpuFilterKey(filter, v) : '';
    // HDR output (10-bit): the CPU scaler; the GPU filters here only produce 8-bit.
    const gpuFilter = this.deep || failedGpuFilters.get(this.tools)?.has(filterKey) ? '' : filter;
    const args = ['-hide_banner', '-nostdin', '-v', 'error'];
    // Source timestamps (src/nativepts.js): every picture passes unchanged, its timestamp comes on fd 4, and the
    // constant-rate slots are made here. Old ffmpeg builds (no -fps_mode) keep ffmpeg's own resampling.
    const timeBase = v ? stamps.parseTimeBase(v.timeBase) : null;
    const stamped = !!timeBase && modern && !this.noStamps && !noStampTools.has(this.tools);
    if (stamped) args.push('-copyts');
    // Leave surfaces on the GPU when the build has a filter for this source format.
    if (v) args.push(...hw.inputArgs(this.method, gpuFilter));
    // -ss counts from the file's start; frame times from the picture's (lead: the sound starts first).
    // Also from 0: else the cfr output fills the sound-only start with a repeat and every frame comes one late.
    const lead = (v && v.lead) || 0;
    if (t > 0 || lead > 0) args.push('-ss', Math.max(0, t + lead - 0.0005).toFixed(4));
    // Frames stay as stored: the webview turns phone videos in its shader (src/rotation.js),
    // as for the built-in decoder. Autorotate ran before scale=w:h and squashed them.
    if (v) args.push('-noautorotate');
    args.push(...ff.inputArgs(this.input));
    if (v) {
      const filters = hw.videoFilter(this.method, this.w, this.h, gpuFilter, hw.depthOf(v.pixFmt, v.codec), this.deep ? 'yuv420p10le' : 'yuv420p');
      args.push('-map', `0:${v.index}`, '-vf', stamped ? `${filters},${stamps.STAMP_FILTER}` : filters,
        ...(stamped ? ['-fps_mode', 'passthrough'] : modern ? ['-fps_mode', 'cfr'] : ['-vsync', 'cfr']),
        ...(stamped ? [] : ['-r', String(this.fps)]), '-f', 'rawvideo', 'pipe:1');
    }
    if (a) args.push('-map', `0:${a.index}`, '-ac', '2', '-ar', String(this.rate), '-f', 'f32le', 'pipe:3');
    const proc = ff.lowerPriority(spawn(this.tools.ffmpeg, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'pipe', ...(stamped ? ['pipe'] : [])] }));
    proc.t = t;
    proc.stamped = stamped;
    proc.timeBase = timeBase;
    proc.method = this.method;
    proc.gpuFilter = gpuFilter;
    proc.gpuFilterKey = filterKey;
    proc.deep = !!this.deep;
    proc.w = this.w;
    proc.h = this.h;
    proc.startedAt = Date.now();
    proc.err = { text: '', clipped: false };
    proc.stderr.on('data', (d) => {
      const text = proc.err.text + d;
      const start = Math.max(0, text.length - 2000);
      if (start) proc.err.clipped = text[start - 1] !== '\n';
      proc.err.text = text.slice(start);
    });
    return proc;
  }

  /** A decoded picture read from ffmpeg: queued as it is, or until its timestamp has arrived on the side pipe. */
  picture(proc, parts) {
    if (!proc.stamped) { this.frames.push({ parts, src: NaN, left: 1 }); return; }
    proc.raw.push(parts);
    this.pair(proc, !!proc.untrusted);
    // Stamps stopped coming (or stopped following the pictures) while pictures go on: waiting for them would
    // fill memory (12 MB a picture at 4K) and stall playback. This run goes on without source times.
    if (proc.raw.length > MAX_UNPAIRED && !proc.untrusted) {
      this.dropStamps(proc);
      this.pair(proc, true);
    }
    if (!proc.untrusted && proc.raw.length >= STAMP_SKEW && !proc.stampWait) {
      // The stamp pipe is read a little behind the pictures: let it catch up before reading more.
      proc.stampWait = true;
      if (proc.stdout && !proc.stdout.isPaused()) proc.stdout.pause();
      proc.silence = setTimeout(() => { if (proc === this.proc && proc.stampWait) { this.dropStamps(proc); this.pair(proc, true); this.flushWaiting(); } }, this.stampSilenceMs ?? STAMP_SILENCE_MS);
      if (proc.silence.unref) proc.silence.unref();
    }
  }

  /** The stamps caught up (or were given up on): the reader this paused goes on, unless the queue of pictures is full. */
  endStampWait(proc) {
    proc.stampWait = false;
    clearTimeout(proc.silence);
    if (proc.stdout && proc.stdout.isPaused() && this.frames.length < this.maxQueued) proc.stdout.resume();
  }

  /** This run goes on without source times (and so do the next ones of this decoder). */
  dropStamps(proc) {
    proc.untrusted = true;
    this.noStamps = true;
    this.takeStandby(NaN);
    this.log(`native: ${proc.raw.length} pictures without timestamps; continuing without source times`);
    this.endStampWait(proc);
  }

  /**
   * Pairs pictures with their timestamps (two pipes, both in decode order) and puts them on the constant-rate
   * slots the player paces on. flush: ffmpeg is done, pictures still without a stamp go on with an unknown one.
   */
  pair(proc, flush = false) {
    while (proc.raw.length && (proc.stampQ.length || flush || proc.untrusted)) {
      const parts = proc.raw.shift();
      const stamp = proc.stampQ.shift();
      // The count printed with each stamp must follow the pictures; else this run's stamps are not trusted.
      if (stamp && stamp.n !== proc.placed) proc.untrusted = true;
      proc.placed++;
      const seconds = stamp && !proc.untrusted ? stamps.stampSeconds(stamp, proc.timeBase) : NaN;
      const slot = proc.resampler.place(seconds);
      if (!slot) continue; // on a slot already filled: dropped, as cfr did
      if (slot.hold && proc.last) this.frames.push({ ...proc.last, left: slot.hold });
      // The player's time starts at the first picture; a start at 0 is that picture.
      // The origin is the first picture of a run from 0, as ffprobe finds it for the exporter. Until one has been seen
      // a declared start_time could disagree with it (AVI with B-frames), so marks stay without source times.
      if (Number.isFinite(seconds) && proc.t === 0 && proc.placed === 1) this.stampOrigin = seconds;
      const src = Number.isFinite(seconds) && Number.isFinite(this.stampOrigin) ? seconds - this.stampOrigin : NaN;
      const entry = { parts, src, left: 1 };
      proc.last = entry;
      this.frames.push(entry);
    }
    if (proc.stampWait && proc.raw.length < STAMP_SKEW / 2) this.endStampWait(proc);
    if (this.frames.length >= this.maxQueued && proc.stdout && !proc.stdout.isPaused()) { this.lastBackpressureAt = Date.now(); proc.stdout.pause(); }
  }

  /**
   * At the end, an ffmpeg for the start waits (its output unread, so it blocks after its first
   * frames): a looping clip restarts without ffmpeg's start-up (0.4-1.4 s for 4K with a GPU
   * method on the Core Ultra laptop, most of a 2 s clip). Dropped after STANDBY_MS unused.
   */
  prepareLoop() {
    if (this.standby || this.disposed) return;
    const sb = this.launch(0);
    this.standby = sb;
    const discard = () => {
      if (this.standby !== sb) return;
      this.standby = null;
      clearTimeout(sb.timer);
    };
    sb.on('error', discard);
    sb.on('close', discard);
    sb.timer = setTimeout(() => { discard(); sb.kill("SIGKILL"); }, STANDBY_MS);
  }

  takeStandby(t) {
    const sb = this.standby;
    this.standby = null;
    if (!sb) return null;
    clearTimeout(sb.timer);
    if (sb.t === t && sb.method === this.method && sb.w === this.w && sb.h === this.h && sb.deep === !!this.deep && sb.exitCode === null &&
        !(sb.gpuFilter && failedGpuFilters.get(this.tools)?.has(sb.gpuFilterKey))) { sb.adopted = true; return sb; }
    sb.kill("SIGKILL");
    return null;
  }

  /**
   * Whether the host ffmpeg producer is keeping up / backpressured by the webview consumer
   * (transfer bottleneck rather than decode bottleneck).
   */
  hostKeepsUp(now = Date.now()) {
    if (this.frames.length >= 2 || !!this.draining) return true;
    if (this.proc && this.proc.stdout && this.proc.stdout.isPaused()) return true;
    return !!(this.lastBackpressureAt && now - this.lastBackpressureAt < 3500);
  }

  /** Each 'more' grants credits; frames are pushed as they arrive, up to the credits. */
  more(m) {
    if (this.recovering || m.gen !== this.gen) return;
    this.credits = Math.min(this.credit.cap, (this.credits || 0) + this.credit.batch);
    this.flushWaiting();
  }

  flushWaiting() {
    this.account();
    if (!this.credits) return;
    const gen = this.gen;
    this.sendAudio(gen);
    // Waiting for the webview to connect to the frame server: the picture waits (sound doesn't).
    if (this.link === 'pending') return;
    const ys = this.w * this.h * (this.deep ? 2 : 1);
    while (this.credits > 0 && this.frames.length) {
      // The socket takes everything without blocking: credits only count frames the webview asked
      // for, not ones it has read. Hold back while two frames wait in the socket (else a webview
      // reading slower than ffmpeg decodes would queue seconds of 4K in this process).
      if (this.link === 'stream' && this.channel.buffered > 2 * this.frameBytes) {
        this.lastBackpressureAt = Date.now();
        if (!this.draining) {
          this.draining = true;
          const ch = this.channel;
          ch.onDrain(() => { if (this.channel === ch) { this.draining = false; this.flushWaiting(); } });
        }
        break;
      }
      const entry = this.frames[0];
      if (--entry.left <= 0) this.frames.shift();
      const f = entry.parts;
      const t = this.base + this.frameIndex / this.fps;
      this.frameIndex++;
      this.credits--;
      if (this.st) this.st.sent++;
      this.sentAt = Date.now();
      const p0 = this.stats ? process.hrtime.bigint() : 0n;
      if (this.stats && gen === 0 && this.frameIndex === 1) this.log('native: first frame sent');
      if (this.link === 'stream' && !this.channel.sendFrame(gen, t, this.w, this.h, ys, f, entry.src)) { this.toMessages('connection gone'); return; }
      // Binary data at the top level of the message: VS Code transfers it efficiently there.
      if (this.link === 'message') {
        const b = f.length === 1 ? f[0] : Buffer.concat(f, this.frameBytes);
        this.postRaw({ type: 'ndv', gen, t, ...(Number.isFinite(entry.src) ? { src: entry.src } : {}), w: this.w, h: this.h, ys, data: new Uint8Array(b.buffer, b.byteOffset, b.length) });
      }
      if (this.st) this.st.postMs += Number(process.hrtime.bigint() - p0) / 1e6;
    }
    if (this.proc && this.proc.stdout.isPaused() && !this.proc.stampWait && this.frames.length < this.maxQueued / 2) this.proc.stdout.resume();
    if (this.ended && this.frames.length === 0 && !this.eofSent) {
      this.sendAudio(gen);
      this.eofSent = true;
      // The end goes the way the frames went, so it can't overtake them.
      if (this.link === 'stream') {
        if (!this.channel.sendEnd(gen)) this.toMessages('connection gone');
      } else this.post({ type: 'batch', gen, eof: true, video: [], audio: [] });
    }
  }

  /** Starting, or frames went to the webview in the last 1.5 s (playing; a paused player stops asking). */
  busy() { return !!this.proc && Date.now() - Math.max(this.sentAt || 0, (this.spawnedAt || 0) + 3000) < 1500; }

  /** Test logs: frames read from ffmpeg and sent per second, and how long frames waited for the webview or the webview for ffmpeg. */
  account() {
    if (!this.stats) return;
    const now = Date.now();
    const st = this.st || (this.st = { t0: now, last: now, read: 0, sent: 0, ff: 0, wv: 0, readMs: 0, postMs: 0 });
    const dt = now - st.last;
    st.last = now;
    if (this.frames.length && !this.credits) st.wv += dt; else if (!this.frames.length && this.credits && !this.ended) st.ff += dt;
    const span = now - st.t0;
    if (span < 2000) return;
    const pct = (x) => Math.round((x / span) * 100);
    this.log(`native stats: read ${(st.read * 1000 / span).toFixed(1)} fps, sent ${(st.sent * 1000 / span).toFixed(1)} fps, webview waited for ffmpeg ${pct(st.ff)}%, frames waited for the webview ${pct(st.wv)}%, host thread: reading ${pct(st.readMs)}%, sending ${pct(st.postMs)}% (${this.link}), ${this.w}x${this.h} ${this.method}`);
    this.st = { t0: now, last: now, read: 0, sent: 0, ff: 0, wv: 0, readMs: 0, postMs: 0 };
  }

  sendAudio(gen) {
    // Hold audio until the first picture so a decoder retry cannot send duplicate audio.
    if (this.proc?.gpuFilter && !this.gotOutput && !this.ended) return;
    if (this.audioBytes < 8) return;
    const all = Buffer.concat(this.audioChunks, this.audioBytes);
    const n = Math.floor(all.length / 8); // stereo float32, interleaved
    const rest = all.subarray(n * 8);
    this.audioChunks = rest.length ? [Buffer.from(rest)] : [];
    this.audioBytes = rest.length;
    // Interleaved as ffmpeg wrote it (a copy, not a per-sample loop here): the page splits the channels.
    const data = new Uint8Array(n * 8);
    data.set(all.subarray(0, n * 8));
    this.postRaw({ type: 'nda', gen, t: this.base + this.samples / this.rate, rate: this.rate, n, data });
    this.samples += n;
    if (!this.pr.video) this.credits--;
  }

  seek(m) {
    if (this.recovering) {
      if (!m.recoverTransport || m.gen <= this.gen) return;
      this.recovering = false;
    } else if (m.recoverTransport) return;
    this.gen = m.gen;
    if (this.resizePending) {
      this.resizePending = false;
      const size = this.videoSize();
      if (size.width !== this.w || size.height !== this.h) {
        this.takeStandby(NaN);
        this.w = size.width;
        this.h = size.height;
        this.post({ type: 'size', ...size });
      }
    }
    // Start exactly on a frame: ffmpeg drops frames before -ss, and output frame i is base + i/fps.
    const fps = this.fps || 30;
    const idx = Math.max(0, Math.floor(m.t * fps + 1e-6));
    this.startAt(idx / fps);
    this.post({ type: 'seeked', gen: m.gen });
  }

  kill() {
    const proc = this.proc;
    this.proc = null;
    if (!proc) return;
    proc.clearPartialFrame?.();
    clearTimeout(proc.silence);
    proc.silence = null;
    if (proc.raw) proc.raw.length = 0;
    if (proc.stampQ) proc.stampQ.length = 0;
    // A paused stdout can otherwise keep unread pictures after the process exits.
    proc.stdout?.destroy?.();
    if (proc.exitCode === null && !proc.signalCode) proc.kill("SIGKILL");
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.connectTimer);
    clearTimeout(this.messagesTimer);
    this.connectTimer = null;
    this.messagesTimer = null;
    const channel = this.channel;
    this.channel = null;
    if (channel) channel.close();
    this.settled();
    this.kill();
    this.takeStandby(NaN);
    this.frames = [];
    this.audioChunks = [];
    this.pending = Buffer.alloc(0);
    this.audioBytes = this.credits = 0;
    this.draining = false;
    this.early = null;
  }
}

/** A page's { w, h } picture size in device pixels, or null. */
function viewOf(m) {
  const w = Math.round(Number(m && m.w));
  const h = Math.round(Number(m && m.h));
  return w >= 16 && h >= 16 && w <= 32768 && h <= 32768 ? { w, h } : null;
}

/** PQ or HLG video (HDR10, HLG, HDR10+ and Dolby Vision 8.1/8.4 base layers). */
function isHdr(v) {
  return !!v && (v.colorTransfer === 'smpte2084' || v.colorTransfer === 'arib-std-b67');
}

/** ffprobe colour names as libav's numbers (as the built-in decoder reports them). */
function colourTags(v) {
  return {
    colorSpace: /^bt2020/.test(v.colorSpace) ? 9 : v.colorSpace === 'bt709' ? 1 : v.colorSpace === 'bt470bg' ? 5 : v.colorSpace === 'smpte170m' ? 6 : 0,
    colorTrc: v.colorTransfer === 'smpte2084' ? 16 : v.colorTransfer === 'arib-std-b67' ? 18 : 0,
    colorPrimaries: v.colorPrimaries === 'bt2020' ? 9 : v.colorPrimaries === 'bt709' ? 1 : 0,
  };
}

module.exports = { NativeDecoder, isHdr, onGuessFailed };
