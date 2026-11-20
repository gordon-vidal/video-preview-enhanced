// @ts-check
// DecoderPool: several decoder-worker.js instances behind the interface of one
// Worker (postMessage / onmessage / onerror / terminate), so software video
// decoding uses more than one core. Webviews are not cross-origin isolated (no
// SharedArrayBuffer, so no WebAssembly threads); instead each worker has its own
// libav.js and decodes its own time segment of the picture.
//
// Worker 0 (the primary) opens the file and does everything a single worker
// does. When the picture is decoded in software and there are cores to spare,
// extra video-only workers start; once they are ready the primary stops decoding
// the picture and keeps the sound. Segment k covers [lo_k, hi_k): the first one
// after a seek starts like a single worker (keyframe at or before the target,
// all frames kept); later ones start at the first keyframe at or after their
// nominal start. Frames are merged in time order and handed out only when the
// engine asks ('more'), within a memory budget. File reads from all workers go
// to the engine tagged with a reader id (rid), and its 'block' answers come back
// with that id. Fewer than two extra workers, WebCodecs video, or an engine that
// does not echo rid (opts.multiRead false): it behaves exactly like one worker.
'use strict';

/* exported DecoderPool */
// eslint-disable-next-line no-unused-vars
const DecoderPool = (() => {
  const DEFAULTS = {
    workers: undefined, // extra video workers; default min(cores - 2, 6)
    maxWorkers: 6,
    minWorkers: 2,
    budget: 600e6, // bytes of decoded frames held in the pool (all segments)
    batchFrames: 12, // frames per answer to 'more'
    batchBytes: 100e6,
    maxSegSec: 2, // segment length bounds (seconds); intra-only codecs use short ones
    minSegFrames: 2,
    audioLead: 3, // read sound at most this far (s) past the delivered picture
    multiRead: false, // the engine routes 'block' answers by rid
    minPixels: 1280 * 720, // smaller pictures decode fast enough on one core
    log: true,
  };
  const EPS = 1e-6;

  class DecoderPool {
    /**
     * @param {string | URL} url worker script (blob) URL
     * @param {object} [opts] see DEFAULTS; globalThis.DecoderPoolOptions overrides
     */
    constructor(url, opts) {
      this.url = url;
      this.o = { ...DEFAULTS, ...(opts || {}), ...(/** @type {any} */ (globalThis).DecoderPoolOptions || {}) };
      const cores = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 1;
      // Leave two cores for the page and the primary (sound, demuxing): more workers than cores is slower than one.
      this.nExtra = this.o.workers !== undefined ? this.o.workers : Math.min(cores - 2, this.o.maxWorkers);
      /** @type {((e: {data: any}) => void) | null} */
      this.onmessage = null;
      /** @type {((e: any) => void) | null} */
      this.onerror = null;
      this.mode = 'single'; // 'single' | 'parallel'
      this.extras = []; // {w, rid, state: 'starting'|'ready'|'dead', seg}
      this.extrasSettled = false;
      this.gen = 0;
      this.lastSeek = null; // {t, fast} of the current gen
      this.lastVT = null; // last picture time handed to the engine (this gen)
      this.lastAT = null; // last sound time read by the primary (this gen)
      this.lastDAT = null; // last sound time handed to the engine (this gen)
      this.eofSent = false;
      this.primaryBusy = false;
      this.seekPending = false;
      this.internalSeek = 0;
      this.dropVUpTo = null; // after a fallback re-sync
      this.dropAUpTo = null;
      this.pendingMore = null;
      this.audioItems = [];
      this.audioEof = false;
      this.segs = [];
      this.sid = 0;
      this.keys = new Set();
      this.frameBytes = 0;
      this.fps = 0;
      this.stats = { segments: 0, dupes: 0, delivered: 0, dropped: 0, peakBytes: 0 };
      this.primary = this.spawn(0, true);
      this.workers = [this.primary];
    }

    // ---- Worker interface ---------------------------------------------------

    postMessage(m, transfer) {
      switch (m.type) {
        case 'init': this.initMsg = m; this.primary.postMessage(m, transfer || []); break;
        case 'open': this.size = m.size; this.primary.postMessage(m, transfer || []); break;
        case 'config':
          this.config = m;
          this.primary.postMessage(m, transfer || []);
          if (m.video === 'soft' && this.o.multiRead && this.nExtra >= this.o.minWorkers && this.bigEnough()) this.startExtras();
          break;
        case 'block': {
          const w = this.workers[m.rid || 0];
          if (w) w.postMessage({ type: 'block', pos: m.pos, data: m.data }, transfer || []);
          break;
        }
        case 'recycle': this.recycle(m, transfer); break;
        case 'more': this.onMore(m); break;
        case 'seek': this.onSeek(m); break;
        case 'hidden':
          // Hidden tab: free the extra workers and their frames; they start again when it is shown.
          if (m.on && this.extras.length) { this.hiddenStop = true; if (this.mode === 'parallel') this.fallback('hidden'); else this.stopExtras(); }
          else if (!m.on && this.hiddenStop) { this.hiddenStop = false; this.extrasSettled = false; this.startExtras(); }
          break;
        case 'selectAudio':
          // The primary rewinds for the new sound: read it again from there.
          this.aid = m.id;
          this.lastAT = null;
          this.dropAUpTo = null;
          this.audioItems = [];
          this.audioEof = false;
          this.primary.postMessage(m, transfer || []);
          break;
        case 'selectSub':
          // The primary rewinds to read the subtitle's recent cues: let it read at once.
          this.lastAT = null;
          this.primary.postMessage(m, transfer || []);
          break;
        case 'skipNonRef':
          this.skipNonRef = !!m.on;
          for (const w of this.workers) if (w) w.postMessage(m);
          break;
        case 'fastDecode':
          this.fastDecode = !!m.on;
          for (const w of this.workers) if (w) w.postMessage(m);
          break;
        default: this.primary.postMessage(m, transfer || []);
      }
    }

    /**
     * Frame buffers back from the engine go to the primary in single mode. In
     * parallel mode they are dropped: returning them to the picture workers measured
     * slower than fresh allocation (pool, 3 workers: mpeg2 1080p 202 vs 286 fps,
     * hevc 10-bit 2160p 16.8 vs 17.7 fps).
     */
    recycle(m, transfer) {
      if (this.mode !== 'parallel') this.primary.postMessage(m, transfer || []);
    }

    bigEnough() {
      const v = this.info && this.info.video;
      return !!v && v.width * v.height >= this.o.minPixels;
    }

    terminate() {
      for (const w of this.workers) if (w) w.terminate();
      this.release(this.segs.flatMap((s) => s.frames));
      this.segs = [];
    }

    /** To the engine, asynchronously and in order, like a Worker's messages. */
    emit(m) {
      (this.outbox = this.outbox || []).push(m);
      if (this.outbox.length > 1) return;
      queueMicrotask(() => {
        const box = this.outbox;
        this.outbox = [];
        for (const x of box) if (this.onmessage) this.onmessage({ data: x });
      });
    }

    log(msg) { if (this.o.log) this.emit({ type: 'log', msg: `pool: ${msg}` }); }

    spawn(rid, primary) {
      const w = new Worker(this.url);
      w.onmessage = (e) => (primary ? this.fromPrimary(e.data) : this.fromExtra(rid, e.data));
      w.onerror = (e) => {
        if (primary) { if (this.onerror) this.onerror(e); return; }
        this.extraFailed(rid, `worker error: ${e && e.message}`);
      };
      return w;
    }

    // ---- primary --------------------------------------------------------------

    fromPrimary(m) {
      switch (m.type) {
        case 'read': this.emit({ type: 'read', pos: m.pos, len: m.len, rid: 0 }); return;
        case 'streams': this.info = m.info; break;
        case 'configured':
          this.vmode = m.video;
          this.amode = m.audio;
          if (m.video !== 'soft') this.stopExtras();
          break;
        case 'audioSelected': this.amode = m.audio; break;
        case 'videoMode':
          // Open-GOP H.264 fell back from WebCodecs to software: now the extra workers can help.
          if (m.video === 'soft' && this.vmode !== 'soft' && this.o.multiRead && this.nExtra >= this.o.minWorkers && !this.hiddenStop && this.bigEnough()) {
            this.vmode = m.video;
            this.extrasSettled = false;
            this.startExtras();
          }
          this.vmode = m.video;
          break;
        case 'seeked':
          if (m.iid !== undefined) { this.internalSeek--; if (this.mode === 'single' && this.pendingMore) this.forwardMore(this.pendingMore); return; }
          if (m.gen !== this.gen) return; // an older seek's reply: the newest is still pending
          this.seekPending = false;
          break;
        case 'batch': this.onPrimaryBatch(m); return;
        default: break;
      }
      this.emit(m);
    }

    forwardMore(m) {
      this.pendingMore = null;
      this.primaryBusy = true;
      this.primary.postMessage(m);
    }

    onMore(m) {
      if (m.gen !== this.gen) return;
      if (this.mode === 'single') {
        if (this.internalSeek) { this.pendingMore = m; return; }
        this.forwardMore(m);
        return;
      }
      this.pendingMore = m;
      this.pumpPrimary();
      this.answer();
    }

    onPrimaryBatch(b) {
      this.primaryBusy = false;
      // Read before a fallback's re-seek: the primary reads it again after the seek.
      if (b.gen !== this.gen || this.internalSeek > 0) return;
      if (this.aid !== undefined) b.audio = b.audio.filter((a) => a.aid === undefined || a.aid === this.aid); // sound of a track switched away from
      if (this.dropAUpTo !== null) b.audio = b.audio.filter((a) => a.t === null || a.t > this.dropAUpTo);
      for (const a of b.audio) if (a.t !== null) this.lastAT = Math.max(this.lastAT === null ? -Infinity : this.lastAT, a.t);
      if (this.mode === 'parallel') {
        this.audioItems.push(...b.audio);
        if (b.eof) this.audioEof = true;
        this.answer();
        return;
      }
      if (this.dropVUpTo !== null) b.video = b.video.filter((v) => v.t === null || v.t > this.dropVUpTo);
      for (const v of b.video) if (v.t !== null) this.lastVT = v.t;
      if (b.eof) this.eofSent = true;
      this.delivered(b.audio);
      // Switch before the engine reacts to this batch with its next 'more'.
      if (!b.eof) this.trySwitch();
      this.emit(b);
    }

    // ---- extra workers --------------------------------------------------------

    startExtras() {
      if (this.extras.length) return;
      this.log(`starting ${this.nExtra} video workers`);
      for (let i = 1; i <= this.nExtra; i++) {
        const w = this.spawn(i, false);
        this.workers[i] = w;
        this.extras.push({ w, rid: i, state: 'starting', seg: null });
        w.postMessage(this.initMsg);
      }
    }

    stopExtras() {
      for (const x of this.extras) { x.w.terminate(); x.state = 'dead'; this.workers[x.rid] = null; }
      // The engine keeps read positions per reader (cache eviction): forget these.
      if (this.extras.length) this.emit({ type: 'readers', drop: this.extras.map((x) => x.rid) });
      this.extras = [];
    }

    fromExtra(rid, m) {
      const x = this.extras.find((e) => e.rid === rid);
      if (!x) return;
      switch (m.type) {
        case 'read': this.emit({ type: 'read', pos: m.pos, len: m.len, rid }); break;
        case 'ready': x.w.postMessage({ type: 'open', size: this.size, role: 'video' }); break;
        case 'streams': x.w.postMessage({ type: 'config', video: 'soft', audio: 'none', deep: !!(this.config && this.config.deep) }); break;
        case 'configured':
          x.state = m.video === 'soft' ? 'ready' : 'dead';
          if (this.skipNonRef) x.w.postMessage({ type: 'skipNonRef', on: true });
          if (this.fastDecode) x.w.postMessage({ type: 'fastDecode', on: true });
          this.extraSettled();
          break;
        case 'vframes': this.onFrames(x, m); break;
        case 'error':
          this.extraFailed(rid, `${m.where}: ${m.message}`);
          break;
        case 'log': if (!/libav ready/.test(m.msg)) this.emit({ type: 'log', msg: `w${rid} ${m.msg}` }); break;
        default: break;
      }
    }

    extraSettled() {
      if (this.extrasSettled || this.extras.some((x) => x.state === 'starting')) return;
      this.extrasSettled = true;
      const ready = this.extras.filter((x) => x.state === 'ready').length;
      if (ready < this.o.minWorkers) {
        this.log(`only ${ready} video workers ready; single worker`);
        this.stopExtras();
        return;
      }
      this.log(`${ready} video workers ready`);
      if (!this.primaryBusy) this.trySwitch();
    }

    extraFailed(rid, why) {
      const x = this.extras.find((e) => e.rid === rid);
      if (!x) return;
      this.log(`video worker ${rid} failed (${why})`);
      x.state = 'dead';
      if (!this.extrasSettled) { this.extraSettled(); return; }
      if (this.mode === 'parallel') this.fallback(`worker ${rid} failed`);
    }

    // ---- switching between one worker and the pool ------------------------------

    canSwitch() {
      return this.mode === 'single' && this.extrasSettled && this.extras.length > 0 && !this.internalSeek && this.vmode === 'soft';
    }

    trySwitch() {
      if (!this.canSwitch() || this.seekPending || this.eofSent) return;
      this.mode = 'parallel';
      this.primary.postMessage({ type: 'video', on: false });
      const resume = this.lastVT !== null;
      this.log(`parallel video from ${resume ? this.lastVT.toFixed(3) : 'start'} s`);
      this.audioItems = [];
      this.audioEof = false;
      if (resume) this.startSegments('max', this.lastVT, this.lastVT + EPS);
      else if (this.lastSeek) this.startSegments(this.lastSeek.fast ? 'min' : 'max', this.lastSeek.t, -Infinity);
      else this.startSegments('max', 0, -Infinity);
    }

    /** Back to the primary alone, continuing after what was handed out. */
    fallback(why) {
      this.log(`back to one worker: ${why}`);
      this.cancelSegments();
      this.stopExtras();
      this.mode = 'single';
      this.dropVUpTo = this.lastVT;
      // Sound already read but not handed out goes first.
      const pend = this.pendingMore;
      if (this.audioItems.length && pend) {
        this.emit({ type: 'batch', gen: this.gen, eof: false, video: [], audio: this.audioItems });
        this.delivered(this.audioItems);
        this.pendingMore = null;
      }
      this.audioItems = [];
      // Sound not handed out is read again after the re-seek.
      this.dropAUpTo = this.lastDAT;
      this.lastAT = this.lastDAT;
      this.primary.postMessage({ type: 'video', on: true });
      const t = this.lastVT !== null ? this.lastVT : this.lastSeek ? this.lastSeek.t : 0;
      this.internalSeek++;
      // Nothing handed out after a fast seek (skip): keep it fast. Internal seeks carry an id; replies are matched by it.
      const fast = this.lastVT === null && !!(this.lastSeek && this.lastSeek.fast);
      this.primary.postMessage({ type: 'seek', gen: this.gen, t, fast, iid: (this.iid = (this.iid || 0) + 1) });
    }

    /** Last sound time handed to the engine. */
    delivered(audio) {
      for (const a of audio) if (a.t !== null) this.lastDAT = Math.max(this.lastDAT === null ? -Infinity : this.lastDAT, a.t);
    }

    onSeek(m) {
      this.gen = m.gen;
      this.lastSeek = { t: m.t, fast: !!m.fast };
      this.lastVT = null;
      this.lastAT = null;
      this.lastDAT = null;
      this.dropVUpTo = null;
      this.dropAUpTo = null;
      this.eofSent = false;
      this.pendingMore = null;
      this.primaryBusy = false;
      this.seekPending = true;
      if (this.mode === 'single' && this.canSwitch()) {
        this.mode = 'parallel';
        this.primary.postMessage({ type: 'video', on: false });
        this.log(`parallel video from seek to ${m.t.toFixed(3)} s`);
      }
      if (this.mode === 'single') { this.primary.postMessage(m); return; }
      this.cancelSegments();
      this.audioItems = [];
      this.audioEof = false;
      this.primary.postMessage(m);
      this.startSegments(m.fast ? 'min' : 'max', m.t, -Infinity);
    }

    // ---- segments ---------------------------------------------------------------

    cancelSegments() {
      for (const s of this.segs) {
        if (s.x && s.x.seg === s) { s.x.w.postMessage({ type: 'segctl', sid: s.sid, cancel: true }); s.x.seg = null; }
        this.release(s.frames);
      }
      this.segs = [];
      this.videoEnd = false;
      this.planEnd = false;
    }

    release(frames) { frames.length = 0; }

    /** Estimated bytes per frame and seconds per frame. */
    frameSize() {
      if (this.frameBytes) return this.frameBytes;
      const v = this.info && this.info.video;
      return v ? v.width * v.height * 2 : 8e6;
    }

    frameDur() { return this.fps ? 1 / this.fps : 1 / 30; }

    /** Median distance between keyframes seen so far (seconds), or 0. */
    gop() {
      if (this.keys.size < 3) return 0;
      const k = [...this.keys].sort((a, b) => a - b);
      const d = [];
      for (let i = 1; i < k.length; i++) if (k[i] - k[i - 1] > EPS) d.push(k[i] - k[i - 1]);
      d.sort((a, b) => a - b);
      return d.length ? d[d.length >> 1] : 0;
    }

    /**
     * Segment length: as many frames as fit the budget across the workers (short
     * for intra-only 4K, ~1 s for 1080p), at least half a GOP so most segments
     * start on their own keyframe.
     */
    segLen() {
      const workers = this.extras.filter((x) => x.state === 'ready').length || 1;
      const frames = Math.max(this.o.minSegFrames, Math.floor(this.o.budget / (2 * workers * this.frameSize())));
      let L = Math.min(this.o.maxSegSec, frames * this.frameDur());
      const g = this.gop();
      if (g > this.frameDur() * 1.5) L = Math.max(L, g * 0.5);
      return L;
    }

    startSegments(mode, t, lo) {
      this.segs = [];
      this.videoEnd = false;
      this.planEnd = false;
      this.newSegment({ first: true, mode, t, lo, start: t });
      this.assign();
    }

    idleWorker() { return this.extras.find((x) => x.state === 'ready' && !x.seg); }

    newSegment(p) {
      const x = this.idleWorker();
      if (!x) return null;
      const s = {
        sid: ++this.sid, x, first: !!p.first, start: p.start, next: p.start + this.segLen(), lo: p.first ? p.lo : undefined,
        hi: null, K: undefined, frames: [], done: false, eof: false, recv: 0, deliv: 0, allow: 0,
      };
      x.seg = s;
      this.segs.push(s);
      this.stats.segments++;
      x.w.postMessage({
        type: 'segment', sid: s.sid, gen: this.gen, first: s.first, mode: p.first ? p.mode : 'min', t: p.t, start: s.start,
        lo: s.lo, next: s.next, allow: 0, limit: this.frameSize() > 4e6 ? 1 : 32 * 1024,
      });
      return s;
    }

    /** Hand idle workers the next segments. */
    assign() {
      if (this.mode !== 'parallel') return;
      while (!this.planEnd && this.idleWorker() && this.segs.length < 3 * this.extras.length) {
        const last = this.segs[this.segs.length - 1];
        if (!last || last.eof || last.hi !== null) break;
        if (!this.newSegment({ first: false, t: last.next, start: last.next })) break;
      }
      this.grant();
    }

    onFrames(x, m) {
      const s = this.segs.find((q) => q.sid === m.sid);
      if (!s || m.gen !== this.gen) return;
      for (const f of m.frames) {
        // Untimed frames only come where a single worker would give them too (leading
        // frames right after a seek); they pass through untouched.
        s.frames.push(f);
        s.recv += f.data.byteLength;
        this.nRecv = (this.nRecv || 0) + 1;
        this.frameBytes = this.frameBytes ? this.frameBytes + (f.data.byteLength - this.frameBytes) / Math.min(this.nRecv, 16) : f.data.byteLength;
      }
      for (const k of m.keys) if (k !== null) this.keys.add(k);
      if (m.K !== undefined) s.K = m.K;
      if (m.done) {
        s.done = true;
        s.eof = m.eof;
        if (x.seg === s) x.seg = null;
      }
      this.resolve();
      this.assign();
      this.extend(s);
      this.answer();
      this.grant();
    }

    /**
     * The newest segment has no successor while every worker is busy: rather than
     * pause at its end, it keeps going (its end moves on) until a worker is free.
     */
    extend(s) {
      const last = this.segs[this.segs.length - 1];
      if (s !== last || s.done || s.hi !== null || this.planEnd || this.idleWorker() || !s.frames.length) return;
      const L = this.segLen();
      const t = s.frames[s.frames.length - 1].t;
      if (t === null) return;
      if (t >= s.next - L / 2) this.setBound(s, { next: Math.max(s.next, t) + L });
    }

    /** Frame rate from the spacing of handed-out frames (median of the first 24). */
    trackFps(dt) {
      if (this.fps || !(dt > 1e-4)) return;
      (this.gaps = this.gaps || []).push(dt);
      if (this.gaps.length < 24) return;
      this.gaps.sort((a, b) => a - b);
      this.fps = 1 / this.gaps[this.gaps.length >> 1];
    }

    /** Settles segment boundaries in order: hi of one is lo of the next. */
    resolve() {
      for (let j = 0; j < this.segs.length; j++) {
        const a = this.segs[j];
        if (a.K === undefined && !a.done) return;
        if (a.eof) { // nothing after the end of the file
          for (const b of this.segs.splice(j + 1)) this.dropSeg(b);
          this.planEnd = true;
          if (a.hi === null) a.hi = Infinity;
          return;
        }
        const b = this.segs[j + 1];
        if (!b || a.hi !== null) continue;
        if (b.K === undefined && !b.done) return;
        if (b.K === undefined || b.K === null) { // b found no keyframe after its start: a runs to the end
          for (const c of this.segs.splice(j + 1)) this.dropSeg(c);
          this.planEnd = true;
          this.setBound(a, { hi: Infinity });
          return;
        }
        if (a.K !== undefined && a.K !== null && b.K <= a.K + EPS) {
          // Same keyframe as a: b would decode a's frames again. Start later instead.
          this.segs.splice(j + 1, 1);
          this.dropSeg(b);
          this.stats.dupes++;
          const c = this.segs[j + 1];
          this.setBound(a, { next: c ? c.start : Math.max(b.next, b.K + this.segLen()) });
          j--;
          continue;
        }
        this.setBound(a, { hi: Math.max(b.K, b.start) });
      }
    }

    setBound(s, p) {
      if (p.hi !== undefined) s.hi = p.hi;
      if (p.next !== undefined) s.next = p.next;
      if (s.x && s.x.seg === s) s.x.w.postMessage({ type: 'segctl', sid: s.sid, ...p });
    }

    dropSeg(s) {
      if (s.x && s.x.seg === s) { s.x.w.postMessage({ type: 'segctl', sid: s.sid, cancel: true }); s.x.seg = null; }
      this.release(s.frames);
    }

    /** Frames held per segment (bytes received, not yet handed out). */
    held(s) { return s.recv - s.deliv; }

    /**
     * Hands out decode allowance (cumulative bytes per segment) within the budget,
     * earlier segments first. Each running segment may hold its share of the
     * budget; the head (the one being handed out) may always hold two frames so it
     * never waits on the others.
     */
    grant() {
      const total = this.segs.reduce((n, q) => n + this.held(q), 0);
      if (total > this.stats.peakBytes) this.stats.peakBytes = total;
      const running = this.segs.filter((q) => !q.done && q.x && q.x.seg === q);
      const outstanding = (q) => Math.max(0, q.allow - q.recv);
      let free = this.o.budget - total - running.reduce((n, q) => n + outstanding(q), 0);
      const cap = this.o.budget / Math.max(1, running.length);
      const head = this.segs.find((q) => q.frames.length || !q.done);
      for (const s of running) {
        let r = Math.min(cap - this.held(s) - outstanding(s), free);
        if (s === head) r = Math.max(r, 2 * this.frameSize() - this.held(s) - outstanding(s));
        if (r <= 0) continue;
        free -= r;
        s.allow += r;
        s.x.w.postMessage({ type: 'segctl', sid: s.sid, allow: s.allow });
      }
    }

    // ---- handing frames to the engine -------------------------------------------

    take() {
      const out = [];
      let bytes = 0;
      while (this.segs.length) {
        const s = this.segs[0];
        while (s.frames.length && out.length < this.o.batchFrames && bytes < this.o.batchBytes) {
          const f = s.frames[0];
          if (f.t === null) { s.frames.shift(); s.deliv += f.data.byteLength; out.push(f); bytes += f.data.byteLength; continue; }
          if (s.hi === null && f.t >= s.next) break; // wait for the boundary
          s.frames.shift();
          s.deliv += f.data.byteLength;
          if ((s.hi !== null && f.t >= s.hi) || (this.lastVT !== null && f.t <= this.lastVT) || f.t < (s.first ? s.lo : s.start) - EPS) {
            this.stats.dropped++;
            continue;
          }
          out.push(f);
          bytes += f.data.byteLength;
          if (this.lastVT !== null) this.trackFps(f.t - this.lastVT);
          this.lastVT = f.t;
          this.stats.delivered++;
        }
        if (out.length >= this.o.batchFrames || bytes >= this.o.batchBytes) break;
        if (s.frames.length && !(s.hi !== null && s.frames[0].t >= s.hi)) break;
        if (!s.done) break;
        // Segment finished and drained.
        this.release(s.frames);
        this.segs.shift();
        if (s.eof || (this.planEnd && !this.segs.length)) { this.videoEnd = true; this.segs.length = 0; break; }
      }
      if (this.planEnd && !this.segs.length) this.videoEnd = true;
      return out;
    }

    audioActive() { return this.amode === 'soft' || this.amode === 'webcodecs'; }

    pumpPrimary() {
      const m = this.pendingMore;
      if (!m || this.primaryBusy || this.seekPending || !this.audioActive() || this.audioEof) return;
      const vt = this.lastVT !== null ? this.lastVT : this.lastSeek ? this.lastSeek.t : 0;
      if (this.lastAT !== null && this.lastAT > vt + this.o.audioLead && !this.videoEnd) return;
      this.primaryBusy = true;
      this.primary.postMessage({ type: 'more', gen: m.gen, limit: m.limit });
    }

    answer() {
      if (this.mode !== 'parallel' || !this.pendingMore || this.seekPending) return;
      const video = this.take();
      this.grant();
      const audioDone = !this.audioActive() || this.audioEof;
      const eof = this.videoEnd && audioDone && !this.primaryBusy;
      if (video.length || this.audioItems.length || eof) {
        const audio = this.audioItems;
        this.audioItems = [];
        this.delivered(audio);
        this.pendingMore = null;
        if (eof) this.eofSent = true;
        const transfer = new Set();
        for (const f of video) transfer.add(f.data.buffer);
        this.emit({ type: 'batch', gen: this.gen, eof, video, audio }, [...transfer]);
        if (eof) this.log(`end: ${JSON.stringify(this.stats)}`);
        return;
      }
      this.pumpPrimary();
    }
  }
  return DecoderPool;
})();
if (typeof globalThis !== 'undefined') /** @type {any} */ (globalThis).DecoderPool = DecoderPool;
