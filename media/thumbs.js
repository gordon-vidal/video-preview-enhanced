// @ts-check
// Seek-bar hover pictures (docs/notes/seek-preview.md). Three sources fill one sorted list of pictures:
// - keyframes asked for while the pointer is on the bar: a second libav.js worker (thumbs-worker.js, started on
//   the first hover, closed o.idleMs after the pointer left) or, for native ffmpeg and Live transcode,
//   o.request(t, w, h, signal, mode) answered by the extension host (src/thumbhost.js). The nearer keyframe on
//   either side of the pointer is shown; replies teach the service the keyframe times (keys);
// - frames the player already shows (playback, seeks, steps), handed over by engine.js through offer();
// - refining: after the pointer rested REST_MS on a slot whose best picture is more than X away, one cheap
//   decode of the exact picture, when its estimated cost fits the budget (never while dragging or busy);
// - the background keyframe pass (passArm, after the first frame): coarse to fine over the slots still without a
//   picture, one at a time, paced, paused while busy, hidden, the pointer is on the bar or another tile sets the clock;
//   then, for short or light files, the between pass: cheap decodes of whole stretches ('sweep') that fill the slots
//   with no picture within X of their middle.
// The bar is a grid of N slots of X seconds (interval()); one picture per slot is enough. Pictures are kept
// as small JPEGs; a few near the pointer also as ready-to-draw ImageBitmaps (HOT). Not used for MJPEG
// AVI/image sequences (FramePlayer, no libav) or audio-only files.
'use strict';

/** Ready-to-draw bitmaps kept at most (the rest stay as JPEG and are decoded again on show). */
const HOT = 32;
const JPEG_QUALITY = 0.75;
const REST_MS = 250;
/** Estimated decoder time (ms) one refine may take: while playing, and while paused. */
const BUDGET_PLAYING = 500;
const BUDGET_PAUSED = 2000;
const PASS_DELAY_MS = 3000;
const PASS_RETRY_MS = 500;
/** How often a running pass request checks whether it should give way. */
const PASS_WATCH_MS = 100;
/** Share of wall time the pass may decode: here, and on a far host (Live transcode, remote native, shared CPU). */
const PASS_DUTY = 0.5;
const PASS_DUTY_FAR = 0.25;
/** Decoder wall time (ms) a far host spends on one file's pass. */
const PASS_BUDGET_FAR_MS = 20e3;
/** Host runs: keyframes per ffmpeg, and the most keyframes per slot at which a run beats one ffmpeg per slot. */
const RUN_KEYS_PER_SLOT = 1.25;
/** Between pass: estimated decoder time (ms, one thread, so about CPU time) per file, here and on a far host. */
const BETWEEN_BUDGET_MS = 3000;
const BETWEEN_BUDGET_FAR_MS = 1000;
/** A sweep ends at the first known keyframe past this much estimated decoding (what a cancel can lose). */
const BETWEEN_CHUNK_MS = 500;
/** The first per-frame guess is pessimistic: start while the estimate is within TRY x budget, go on while the
 *  measured estimate stays within OVER x budget. */
const BETWEEN_TRY = 2;
const BETWEEN_OVER = 1.25;

/**
 * @typedef {{ t: number, kind: 'key' | 'frame', end: number, jpeg: Blob | null, bmp: ImageBitmap | null,
 *   w: number, h: number, rot: number, used: number, warming?: Promise<void> | null, gone?: boolean,
 *   refined?: boolean }} Entry
 *   t: source time (absolute seconds); a key entry answers every time in [t, end] (its keyframe is the latest
 *   keyframe there); rot: how the bitmap is turned when drawn (captures come from the canvas, already turned).
 */

/* exported ThumbService */
// eslint-disable-next-line no-unused-vars
class ThumbService {
  /**
   * @param {object} o
   * @param {string} o.workerSrcUrl URL of thumbs-worker.js (fetched, then run from a blob)
   * @param {{loader: string, toImport: string, wasmurl: string, variant: string}} o.libav blob URLs of libav.js
   * @param {number} o.size file size
   * @param {number} o.duration seconds
   * @param {number} o.startT first presentation time (absolute)
   * @param {number} [o.fps]
   * @param {number} [o.rotation] 0/90/180/270 clockwise
   * @param {(pos: number, len: number) => void} o.onRead the worker wants file data
   * @param {() => void} [o.onIdle] the worker stopped reading for now
   * @param {() => boolean} [o.busy] true while playback needs the CPU (no neighbour filling then)
   * @param {boolean} [o.remote] the file is on another machine (SSH/WSL): no neighbour filling,
   *   since every thumbnail costs at least one 4 MB block over the connection
   * @param {number} [o.idleMs] ms after the pointer left until the worker is closed (default 20 s)
   * @param {number} [o.radius] neighbouring slots filled each side of the pointer (default 4)
   * @param {(msg: string) => void} [o.log]
   * @param {number} [o.cap] bytes of pictures kept (JPEGs plus hot bitmaps)
   * @param {(t: number, w: number, h: number, signal: AbortSignal, mode?: 'key' | 'near' | 'exact' | 'run' | 'sweep',
   *   opts?: {pass?: boolean, to?: number, step?: number}) => Promise<any>} [o.request]
   *   decodes one thumbnail elsewhere (native ffmpeg in the extension host) instead of the libav.js
   *   worker; resolves {kt, w, h, data, fmt, next?: {kt, data}} (data is a JPEG when fmt is 'jpeg', else RGBA) or null;
   *   'run': the next keyframes from t on, {kt, data, more: [{kt, data}], end} (end: no keyframe after the last);
   *   'sweep': the first frame at or after each of t, t + step, ... before `to`, decoded cheaply, in the same shape
   * @param {() => boolean} [o.playing] playback runs (the smaller refine budget)
   * @param {number} [o.frameMs] first guess of what decoding one frame between keyframes costs (ms); replies refine it
   * @param {number} [o.restMs] rest before refining (default REST_MS)
   * @param {{delayMs?: number, far?: boolean, budgetMs?: number, betweenMs?: number}} [o.pass] the background pass
   *   (passArm); far: decoding on a far host (slower pace, a total budget, a smaller between budget)
   * @param {() => boolean} [o.hidden] the page is hidden (no pass work)
   * @param {() => boolean} [o.passOn] the pass may run (this tile sets the clock, not turned off by a test)
   */
  constructor(o) {
    this.o = o;
    this.rot = [90, 180, 270].includes(o.rotation || 0) ? o.rotation || 0 : 0;
    this.X = ThumbService.interval(o.duration, o.fps);
    this.n = Math.max(1, Math.ceil(o.duration / this.X - 1e-9));
    this.box = this.rot === 90 || this.rot === 270 ? { w: 120, h: 160 } : { w: 160, h: 120 };
    this.cap = o.cap > 0 ? o.cap : 30e6; // less on small machines: media/membudget.js
    /** @type {Entry[]} sorted by t */
    this.list = [];
    this.bytes = 0;
    /** @type {Map<number, Entry | null>} slot -> the keyframe a request answered (null: none found) */
    this.asked = new Map();
    this.epoch = 0;
    this.worker = null;
    this.state = 'off'; // off | starting | ready | failed
    this.id = 0;
    this.inflight = null; // {id, slot, prefetch}
    this.want = null; // slot the pointer is on
    this.wantT = 0; // the pointer's time (absolute)
    this.cb = null;
    this.debounce = 0;
    this.idleTimer = 0;
    this.stats = { requests: 0, decoded: 0, ms: [], captured: 0, captureMs: [], refines: 0, refineMs: [], skipped: 0 };
    /** @type {{t: number, kind: string, refined: boolean} | null} the last picture handed to a hover callback */
    this.shown = null;
    /** @type {{t: number, next: number | null | undefined}[]} known keyframes, sorted; next: the following
     *  keyframe (null: none, undefined: not known yet) */
    this.keys = [];
    this.frameMs = o.frameMs > 0 ? o.frameMs : 2;
    this.restTimer = 0;
    this.restSlot = -1;
    this.restSince = 0;
    /** @type {Set<number>} slots refined (or tried) */
    this.refined = new Set();
    /** @type {Set<number>} slots a refine was skipped for (over budget), counted once */
    this.skipped = new Set();
    /** The background pass's state (passArm), or null. */
    this.ps = null;
  }

  /**
   * Seconds per slot: at least 20 pictures, at most 240, 2 s in between (docs/notes/seek-preview.md).
   * @param {number} d duration @param {number} [fps]
   */
  static interval(d, fps) {
    return Math.max(d / 240, Math.min(2, d / 20), 1 / (fps || 30));
  }

  /** Counters (tests, notes). */
  stats0() {
    let hot = 0;
    let jpegs = 0;
    let frames = 0;
    for (const e of this.list) { if (e.bmp) hot++; if (e.jpeg) jpegs++; if (e.kind === 'frame') frames++; }
    let slots = 0;
    for (const e of this.asked.values()) if (e && !e.gone) slots++;
    const spread = (a) => {
      const s = a.slice().sort((x, y) => x - y);
      return s.length ? { median: s[s.length >> 1], max: s[s.length - 1], n: s.length } : null;
    };
    return {
      requests: this.stats.requests, decoded: this.stats.decoded, cached: this.list.length, slots, bytes: this.bytes,
      cap: this.cap, hot, jpegs, frames, captured: this.stats.captured, X: this.X, n: this.n,
      captureMs: spread(this.stats.captureMs),
      refines: this.stats.refines, refineMs: spread(this.stats.refineMs), skipped: this.stats.skipped,
      keys: this.keys.length, frameMs: Math.round(this.frameMs * 100) / 100,
      shown: this.shown && { t: this.shown.t - this.o.startT, kind: this.shown.kind, refined: this.shown.refined },
      bar: this.answered(), pass: this.passStats(),
      state: this.state, worker: !!this.worker, hovering: this.want !== null,
      // The pointer's slot and its neighbourhood have their pictures (nothing left to ask for there).
      filled: this.want !== null && !this.inflight && !this.need(this.want) && this.nextNear() === null,
    };
  }

  log(m) { if (this.o.log) this.o.log(`thumbs: ${m}`); }

  /** @param {number} rel seconds from the start */
  slotOf(rel) { return Math.max(0, Math.min(this.n - 1, Math.floor(rel / this.X))); }

  /** The time a request for `slot` asks for (absolute): the slot's middle, inside the file. */
  target(slot) {
    const d = this.o.duration;
    return this.o.startT + Math.max(0, Math.min((slot + 0.5) * this.X, d - 1 / (this.o.fps || 30)));
  }

  /** Index of the first entry with t >= time. */
  index(time) {
    let lo = 0;
    let hi = this.list.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (this.list[mid].t < time) lo = mid + 1; else hi = mid; }
    return lo;
  }

  /** The entry closest to `time` inside `slot`, or null. */
  inSlot(slot, time) {
    const a = this.o.startT + slot * this.X;
    const b = a + this.X;
    let best = null;
    for (let i = this.index(a); i < this.list.length && this.list[i].t < b; i++) {
      if (!best || Math.abs(this.list[i].t - time) < Math.abs(best.t - time)) best = this.list[i];
    }
    return best;
  }

  /** Records keyframe `t` and, when known, the keyframe after it (null: none). */
  addKey(t, next) {
    if (!Number.isFinite(t)) return;
    let lo = 0;
    let hi = this.keys.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (this.keys[mid].t < t) lo = mid + 1; else hi = mid; }
    let k = this.keys[lo];
    if (!k || k.t !== t) { k = { t, next: undefined }; this.keys.splice(lo, 0, k); }
    if (next === null || (Number.isFinite(next) && /** @type {number} */ (next) > t)) k.next = next;
  }

  /** The keyframes around `time` when both are known: {kp <= time, kn > time (null: none)}, else null. */
  gop(time) {
    let lo = 0;
    let hi = this.keys.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (this.keys[mid].t <= time) lo = mid + 1; else hi = mid; }
    const k = this.keys[lo - 1];
    if (!k || k.next === undefined || (k.next !== null && k.next <= time)) return null;
    return { kp: k.t, kn: k.next };
  }

  /** The keyframe closer to `time` of the two around it, when both are known. */
  nearerKey(time) {
    const g = this.gop(time);
    if (!g) return null;
    return g.kn !== null && g.kn - time < time - g.kp ? g.kn : g.kp;
  }

  /**
   * The keyframe answer for `slot`: a request's answer, else the nearer known keyframe's picture (null while it is
   * not decoded), else a key entry whose range covers the slot's target.
   */
  keyFor(slot) {
    const a = this.asked.get(slot);
    if (a && !a.gone) return a;
    const T = this.target(slot);
    const k = this.nearerKey(T);
    if (k !== null) return this.keyAt(k);
    for (let i = this.index(T + 1e-9) - 1; i >= 0; i--) {
      const e = this.list[i];
      if (e.kind === 'key') return e.end >= T ? e : null;
    }
    return null;
  }

  /**
   * The best picture for the pointer at `time` in `slot`: the slot's own, or a closer one next to the pointer;
   * `exact`: no keyframe request would give a better one.
   */
  best(slot, time) {
    const own = this.inSlot(slot, time) || this.keyFor(slot);
    const i = this.index(time);
    let e = own;
    for (const c of [this.list[i - 1], this.list[i]]) if (c && (!e || Math.abs(c.t - time) < Math.abs(e.t - time))) e = c;
    // Without an own picture, the nearest one stands in while the slot's picture decodes.
    return e ? { e, exact: !!own } : null;
  }

  /** Whether `slot` still needs a request. */
  need(slot) {
    if (this.asked.get(slot) === null) return false; // asked, nothing found
    return !this.inSlot(slot, this.target(slot)) && !this.keyFor(slot);
  }

  /**
   * Pointer at `rel` seconds on the bar. cb(picture | null) is called with the
   * cached picture at once, or later when it is decoded (only if still wanted).
   */
  hover(rel, cb, scrub = false) {
    if (this.disposed) return;
    const slot = this.slotOf(rel);
    if (this.inflight && this.inflight.pass) this.cancel(this.inflight); // the pointer always wins
    this.scrub = scrub;
    this.cb = cb;
    this.want = slot;
    this.wantT = this.o.startT + Math.max(0, rel);
    this.lastHover = performance.now();
    if (slot !== this.restSlot || scrub) this.moved(slot);
    const b = this.best(slot, this.wantT);
    if (b) this.give(b.e);
    this.warmAround(slot);
    if (b && b.exact && this.nextNear() === null) return; // the slot's picture and neighbours are there: no work
    this.start();
    // Let the active decode finish. Only the latest pending position gets dispatched.
    if (this.inflight) { this.kick(); return; }
    if (!this.debounce) this.debounce = setTimeout(() => { this.debounce = 0; this.kick(); }, 40);
  }

  /** The pointer reached another slot (or drags): a running refine is stale, and the rest starts again. */
  moved(slot) {
    this.restSlot = slot;
    this.restSince = performance.now();
    clearTimeout(this.restTimer);
    this.restTimer = 0;
    const req = this.inflight;
    if (req && req.refine && req.slot !== slot) this.cancel(req);
    if (this.scrub || !this.canRefine()) return;
    this.restTimer = setTimeout(() => {
      this.restTimer = 0;
      if (this.want !== slot || this.refineCost(slot) === null) return;
      if (this.state === 'off') this.start(); else this.kick();
    }, this.o.restMs ?? REST_MS);
  }

  /** Whether this file can refine at all: not for a remote file read by the worker (a GOP of blocks over the link). */
  canRefine() { return !this.disposed && (!!this.o.request || !this.o.remote); }

  /**
   * The estimated cost (ms) of refining `slot` now, or null when it should not: not rested, dragging, busy, done,
   * a close enough picture, or over budget (counted in stats.skipped).
   */
  refineCost(slot) {
    if (!this.canRefine() || this.scrub || this.want !== slot || this.refined.has(slot)) return null;
    if (performance.now() - this.restSince < (this.o.restMs ?? REST_MS) - 1) return null;
    if (this.o.busy && this.o.busy()) return null;
    const T = this.target(slot);
    const b = this.best(slot, T);
    if (!b || !b.exact || Math.abs(b.e.t - T) <= this.X) return null;
    const kp = this.keyBefore(T);
    const frames = Math.max(1, (T - kp) * (this.o.fps || 30));
    const fixed = this.medianMs();
    const cost = fixed + frames * this.frameMs;
    const budget = this.o.playing && this.o.playing() ? BUDGET_PLAYING : BUDGET_PAUSED;
    if (cost > budget) {
      if (!this.skipped.has(slot)) { this.skipped.add(slot); this.stats.skipped++; }
      return null;
    }
    return cost;
  }

  /** Median time of a keyframe request (the fixed part of a refine: process start, seek, one decode). */
  medianMs() {
    const s = this.stats.ms.slice().sort((a, b) => a - b);
    return s.length ? s[s.length >> 1] : 0;
  }

  /** Hands `e` to the hover callback, at once when its bitmap is ready, else after decoding its JPEG. */
  give(e) {
    const cb = this.cb;
    if (!cb) return;
    e.used = performance.now();
    if (e.bmp) { this.shown = { t: e.t, kind: e.kind, refined: !!e.refined }; cb({ bmp: e.bmp, w: e.w, h: e.h, rot: e.rot, t: e.t }); return; }
    this.warm(e).then(() => {
      if (this.cb !== cb || !e.bmp) return;
      const b = this.want === null ? null : this.best(this.want, this.wantT);
      if (b && b.e === e) this.give(e);
    });
  }

  /** Decodes a cold entry's JPEG into its bitmap. */
  warm(e) {
    if (e.bmp || !e.jpeg) return Promise.resolve();
    if (!e.warming) {
      e.warming = createImageBitmap(e.jpeg).then((bmp) => {
        e.warming = null;
        if (e.gone || e.bmp) { bmp.close(); return; }
        e.bmp = bmp;
        this.bytes += e.w * e.h * 4;
        this.trim();
      }, (err) => { e.warming = null; this.log(`jpeg decode failed: ${err}`); });
    }
    return e.warming;
  }

  /** Warms the pictures of the slots next to the pointer, so moving along the bar draws at once. */
  warmAround(slot) {
    for (let d = 1; d <= 2; d++) {
      for (const s of [slot - d, slot + d]) {
        if (s < 0 || s >= this.n) continue;
        const e = this.inSlot(s, this.target(s)) || this.keyFor(s);
        if (e && !e.bmp) { e.used = performance.now(); this.warm(e); }
      }
    }
  }

  /** Pointer left the bar. */
  leave(immediate = false) {
    this.want = null;
    this.cb = null;
    clearTimeout(this.debounce);
    this.debounce = 0;
    clearTimeout(this.restTimer);
    this.restTimer = 0;
    this.restSlot = -1;
    if (immediate || this.o.request && this.inflight) { this.stop(); return; }
    // Ordinary hover can keep the warm context after cancelling the packet scan.
    if (this.inflight && this.worker) this.cancel(this.inflight);
    if (!this.inflight) this.kick();
  }

  /** Cancels a running request: an abort of the host job, or a `cancel` to the worker. */
  cancel(req) {
    if (req.cancelSent) return;
    req.cancelSent = true;
    if (req.abort) req.abort.abort();
    else if (this.worker) this.worker.postMessage({ type: 'cancel', below: req.id + 1 });
  }

  /** Whether a frame shown at `t` (absolute) would fill a slot that has no picture of its own yet. */
  wants(t) {
    if (this.disposed) return false;
    const rel = t - this.o.startT;
    if (!(rel >= 0 && rel <= this.o.duration)) return false;
    return !this.inSlot(this.slotOf(rel), t);
  }

  /**
   * engine.js: a frame the player showed at `t` (absolute), scaled to fit the 160 x 120 box. The service owns `bmp`.
   * @param {number} t @param {ImageBitmap} bmp @param {number} [rot] how it is turned when drawn
   * @param {number} [ms] what making it cost (stats)
   */
  offer(t, bmp, rot = 0, ms) {
    if (!this.wants(t) || !(bmp.width > 0 && bmp.height > 0)) { bmp.close(); return false; }
    /** @type {Entry} */
    const e = { t, kind: 'frame', end: t, jpeg: null, bmp, w: bmp.width, h: bmp.height, rot, used: 0 };
    this.insert(e);
    this.stats.captured++;
    if (Number.isFinite(ms)) {
      if (this.stats.captureMs.length === 200) this.stats.captureMs.shift();
      this.stats.captureMs.push(/** @type {number} */ (ms));
    }
    this.encode(e);
    if (this.want !== null && this.cb) {
      const b = this.best(this.want, this.wantT);
      if (b && b.e === e) this.give(e);
    }
    return true;
  }

  /** Adds `e` in time order (replacing an entry at the same time) and keeps the budget. */
  insert(e) {
    const i = this.index(e.t);
    const old = this.list[i];
    if (old && old.t === e.t) { this.drop(old, i); }
    this.list.splice(this.index(e.t), 0, e);
    this.bytes += (e.bmp ? e.w * e.h * 4 : 0) + (e.jpeg ? e.jpeg.size : 0);
    this.trim();
  }

  /** Stores a bitmap-only entry as JPEG too, so its bitmap can be let go. */
  async encode(e) {
    if (e.jpeg || !e.bmp) return;
    let blob = null;
    try { blob = await ThumbService.toJpeg(e.bmp); } catch (err) { this.log(`jpeg encode failed: ${err}`); }
    if (!blob || e.gone || e.jpeg) return;
    e.jpeg = blob;
    this.bytes += blob.size;
    this.trim();
  }

  /** @param {ImageBitmap} bmp @returns {Promise<Blob | null>} */
  static async toJpeg(bmp) {
    if (typeof OffscreenCanvas !== 'function') return null;
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = c.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(bmp, 0, 0);
    return c.convertToBlob({ type: 'image/jpeg', quality: JPEG_QUALITY });
  }

  /** Removes an entry (and tells the worker it may decode that keyframe again). */
  drop(e, i = this.list.indexOf(e)) {
    if (i >= 0) this.list.splice(i, 1);
    e.gone = true;
    this.bytes -= (e.bmp ? e.w * e.h * 4 : 0) + (e.jpeg ? e.jpeg.size : 0);
    if (e.bmp) e.bmp.close();
    e.bmp = null;
    if (e.kind === 'key' && this.worker) this.worker.postMessage({ type: 'forget', kt: e.t });
  }

  /** Keeps at most HOT bitmaps and the bytes under the cap: cold bitmaps first, then whole entries, least used first. */
  trim() {
    const byUse = this.list.slice().sort((a, b) => a.used - b.used);
    let hot = 0;
    for (const e of this.list) if (e.bmp) hot++;
    for (const e of byUse) {
      if (hot <= HOT && this.bytes <= this.cap) break;
      if (e.bmp && e.jpeg) { this.bytes -= e.w * e.h * 4; e.bmp.close(); e.bmp = null; hot--; }
    }
    for (const e of byUse) {
      if (this.bytes <= this.cap) break;
      this.drop(e);
    }
  }

  async start() {
    if (this.state !== 'off') return;
    this.state = 'starting';
    const epoch = this.epoch;
    this.t0 = performance.now();
    if (this.o.request) { this.state = 'ready'; this.kick(); return; }
    try {
      const res = await fetch(this.o.workerSrcUrl);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const source = await res.text();
      if (epoch !== this.epoch) return;
      const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
      try { this.worker = new Worker(url); } finally { URL.revokeObjectURL(url); }
      this.worker.onmessage = (e) => { if (epoch === this.epoch) this.onMessage(e.data); };
      this.worker.onerror = (e) => { if (epoch === this.epoch) this.fail(`worker error: ${e.message}`); };
      this.log(`starting worker (source fetched in ${Math.round(performance.now() - this.t0)} ms)`);
      this.worker.postMessage({ type: 'init', ...this.o.libav });
    } catch (e) {
      if (epoch === this.epoch) this.fail(String(e && /** @type {any} */ (e).message || e));
    }
  }

  fail(why) {
    this.log(`off (${why})`);
    this.state = 'failed';
    this.stop();
  }

  /** Frees the worker (and its WebAssembly memory); the next hover starts it again. */
  stop() {
    this.epoch++;
    if (this.inflight && this.inflight.pass && this.inflight.mode !== 'sweep' && this.ps) this.ps.retry = this.inflight.slot;
    this.inflight?.abort?.abort();
    clearTimeout(this.idleTimer);
    clearTimeout(this.debounce);
    clearTimeout(this.restTimer);
    this.debounce = 0;
    this.restTimer = 0;
    if (this.worker) this.worker.terminate();
    this.worker = null;
    this.inflight = null;
    if (this.state !== 'failed') this.state = 'off';
    if (this.o.onIdle) this.o.onIdle();
    if (this.ps && !this.ps.done && !this.disposed && !this.ps.timer) this.passLater(PASS_RETRY_MS);
  }

  dispose() {
    this.disposed = true;
    if (this.ps) { clearTimeout(this.ps.timer); this.ps.timer = 0; this.ps.done = this.ps.done || 'closed'; }
    this.state = 'failed';
    this.leave(true);
    for (const e of this.list.slice()) this.drop(e);
    this.asked.clear();
    this.bytes = 0;
  }

  /** Engine: a file block for the worker. */
  post(msg, transfer) { if (this.worker) this.worker.postMessage(msg, transfer || []); }

  onMessage(m) {
    switch (m.type) {
      case 'ready': this.post({ type: 'open', size: this.o.size }); break;
      case 'read': this.o.onRead(m.pos, m.len); break;
      case 'opened':
        if (!m.ok) { this.fail(m.why); return; }
        this.state = 'ready';
        this.log(`worker ready in ${Math.round(performance.now() - this.t0)} ms (${m.codec})`);
        this.kick();
        break;
      case 'thumb': this.onThumb(m); break;
      case 'log': this.log(m.msg); break;
      case 'error':
        this.log(`${m.where}: ${m.message}`);
        if (m.where !== 'thumb') { this.fail(m.message); return; }
        if (this.inflight && this.inflight.id === m.id) { this.asked.set(this.inflight.slot, null); this.inflight = null; }
        this.kick();
        break;
    }
  }

  /** Sends the next request: the hovered slot first, otherwise a prefetch slot. */
  kick() {
    if (this.state !== 'ready' || (!this.worker && !this.o.request)) return;
    clearTimeout(this.idleTimer);
    if (this.inflight) return;
    let slot = null;
    let prefetch = false;
    if (this.want === null) {
      if (this.passKick()) return;
      // Pointer away and no pass work: close the worker after some idle time.
      if (this.o.onIdle) this.o.onIdle();
      // Never hovered (the pass alone used it): close at once.
      const left = this.lastHover ? (this.o.idleMs ?? 20e3) - (performance.now() - this.lastHover) : 0;
      if (left <= 0) this.stop();
      else this.idleTimer = setTimeout(() => this.kick(), left);
      return;
    }
    const busy = !!(this.o.busy && this.o.busy());
    let refine = false;
    if (this.need(this.want)) slot = this.want;
    else if (this.refineCost(this.want) !== null) { slot = this.want; refine = true; } else if (!busy) {
      slot = this.nextNear();
      prefetch = slot !== null;
    }
    if (slot === null) {
      // Pointer on the bar and everything near it is there (or playback is busy: look again soon).
      if (this.o.onIdle) this.o.onIdle();
      const later = this.nextNear() !== null || (this.canRefine() && !this.scrub && !this.refined.has(this.want));
      if (busy && later) this.idleTimer = setTimeout(() => this.kick(), 500);
      return;
    }
    this.send(slot, { prefetch, refine });
  }

  /**
   * Asks for `slot`'s picture: its known keyframe by time ('key'), the nearer keyframe ('near'), the exact picture
   * (refine), the keyframes from the slot's start on ('run', host only), or a between-pass stretch ('sweep').
   * @param {number} slot
   * @param {{prefetch?: boolean, refine?: boolean, pass?: boolean, run?: boolean, sweep?: {to: number}}} kind
   */
  send(slot, kind) {
    const T = this.target(slot);
    // A keyframe whose time is known is asked for by its time (+0.5 ms: under any frame, over rounding).
    const k = kind.refine || kind.run || kind.sweep ? null : this.nearerKey(T);
    const mode = kind.sweep ? 'sweep' : kind.run ? 'run' : kind.refine ? 'exact' : k !== null ? 'key' : 'near';
    const t = kind.run ? this.o.startT + slot * this.X + 0.0005 : k !== null ? k + 0.0005 : T;
    const to = kind.sweep ? kind.sweep.to : undefined;
    this.inflight = { id: ++this.id, slot, prefetch: !!kind.prefetch, refine: !!kind.refine, pass: !!kind.pass, mode, at: t, to, t: performance.now() };
    this.stats.requests++;
    if (this.o.request) {
      this.inflight.abort = new AbortController();
      this.requestHost(this.inflight);
      return;
    }
    const sweep = kind.sweep ? { to, step: this.X } : {};
    this.worker.postMessage({ type: 'thumb', id: this.id, t, w: this.box.w, h: this.box.h, mode: kind.refine ? 'between' : mode, ...sweep });
  }

  // ---- the background pass (docs/notes/seek-preview.md, phases 3 and 4) ----

  /** Starts the pass once per file, after its delay; not for a remote file read by the worker (a block per keyframe). */
  passArm() {
    const p = this.o.pass;
    if (!p || this.ps || this.disposed || (this.o.remote && !this.o.request)) return;
    this.ps = {
      order: ThumbService.coarseToFine(this.n), at: 0, tried: new Set(), retry: /** @type {number | null} */ (null),
      timer: 0, notBefore: 0, ms: 0, requests: 0, runs: 0, done: '', paused: '', since: 0, t0: performance.now(),
      duty: p.far ? PASS_DUTY_FAR : PASS_DUTY, budget: p.budgetMs ?? (p.far ? PASS_BUDGET_FAR_MS : Infinity),
      /** @type {any} the between pass, set once the keyframe pass has nothing left (sweepNext) */
      bw: null,
    };
    this.passLater(p.delayMs ?? PASS_DELAY_MS);
  }

  passLater(ms) {
    const ps = this.ps;
    clearTimeout(ps.timer);
    ps.timer = setTimeout(() => { ps.timer = 0; this.passStep(); }, Math.max(0, ms));
  }

  /** Why the pass waits now ('' when it may decode). */
  passWhy() {
    if (this.o.passOn && !this.o.passOn()) return 'off';
    if (this.o.hidden && this.o.hidden()) return 'hidden';
    if (this.want !== null) return 'pointer';
    if (this.o.busy && this.o.busy()) return 'busy';
    return '';
  }

  passPause(why) {
    const ps = this.ps;
    if (ps.paused !== why) { ps.paused = why; ps.since = performance.now(); }
  }

  /** Timer: watches a running pass request (cancelled when it should give way), or starts the next one. */
  passStep() {
    const ps = this.ps;
    if (!ps || ps.done || this.disposed) return;
    const req = this.inflight;
    if (req) {
      if (req.pass && this.passWhy()) this.cancel(req);
      if (req.pass) this.passLater(PASS_WATCH_MS);
      return; // its reply kicks
    }
    if (this.state === 'ready') { this.kick(); return; }
    if (this.state === 'failed') { this.passDone('failed'); return; }
    if (this.state !== 'off') return;
    const why = this.passWhy();
    if (why) { this.passPause(why); this.passLater(PASS_RETRY_MS); return; }
    if (this.passNext() === null && !this.sweepNext()) { this.passDone('complete'); return; }
    this.start();
  }

  /** kick() with the pointer away: sends the next pass request; true while the pass keeps the worker. */
  passKick() {
    const ps = this.ps;
    if (!ps || ps.done || this.disposed) return false;
    const now = performance.now();
    const why = this.passWhy();
    if (why) {
      this.passPause(why);
      this.passLater(PASS_RETRY_MS);
      // A short busy spell keeps the worker; hidden, another clock tile or a long pause let it close.
      return why === 'busy' && now - ps.since < (this.o.idleMs ?? 20e3);
    }
    ps.paused = '';
    if (ps.ms >= ps.budget) { this.passDone('budget'); return false; }
    const slot = this.passNext();
    const sweep = slot === null ? this.sweepNext() : null;
    if (slot === null && !sweep) { this.passDone('complete'); return false; }
    if (ps.notBefore > now) { this.passLater(ps.notBefore - now); return true; }
    if (sweep) {
      this.send(sweep.slot, { pass: true, sweep });
      this.passLater(PASS_WATCH_MS);
      return true;
    }
    const run = this.runMode();
    const from = run ? this.runFrom(slot) : slot;
    ps.tried.add(from);
    ps.retry = null;
    if (run) ps.runs++;
    this.send(from, { pass: true, run });
    this.passLater(PASS_WATCH_MS);
    return true;
  }

  /** The next slot to ask for: a cancelled one first, then coarse to fine, skipping answered and tried slots. */
  passNext() {
    const ps = this.ps;
    if (ps.retry !== null && !ps.tried.has(ps.retry) && this.need(ps.retry)) return ps.retry;
    for (; ps.at < ps.order.length; ps.at++) {
      const s = ps.order[ps.at];
      if (!ps.tried.has(s) && this.need(s)) return s;
    }
    return null;
  }

  /**
   * Host only: keyframe runs pay off when the known GOPs give at most RUN_KEYS_PER_SLOT keyframes per slot (one
   * ffmpeg start for several keyframes instead of one per slot); with more per slot a run decodes keyframes no slot
   * needs.
   */
  runMode() {
    if (!this.o.request) return false;
    const gaps = [];
    for (const k of this.keys) if (typeof k.next === 'number') gaps.push(k.next - k.t);
    if (gaps.length < 3) return false;
    gaps.sort((a, b) => a - b);
    return this.X / gaps[gaps.length >> 1] <= RUN_KEYS_PER_SLOT;
  }

  /** A run starts at the first slot of the gap that holds `slot`, so it fills forward without overlap. */
  runFrom(slot) {
    let s = slot;
    while (s > 0 && !this.ps.tried.has(s - 1) && this.need(s - 1)) s--;
    return s;
  }

  /** After a pass reply: its cost counts against its budget and sets the pause before the next. */
  passAfter(req, m) {
    const ps = this.ps;
    if (!req.pass || !ps) return;
    const ms = performance.now() - req.t;
    const cancelled = m.cancelled || req.cancelSent;
    if (req.mode === 'sweep') {
      // A cancelled sweep starts again from its first slot still without a picture.
      ps.bw.ms += ms;
      if (!cancelled) ps.bw.requests++;
    } else {
      ps.ms += ms;
      if (cancelled) { ps.tried.delete(req.slot); ps.retry = req.slot; } else ps.requests++;
    }
    ps.notBefore = performance.now() + ms * (1 / ps.duty - 1);
  }

  passDone(why) {
    const ps = this.ps;
    ps.done = why;
    clearTimeout(ps.timer);
    ps.timer = 0;
    const bw = ps.bw;
    const between = bw ? `; between ${bw.state} (estimate ${Math.round(bw.est)} ms): ${bw.requests} sweeps, ${bw.pictures} pictures, ${Math.round(bw.ms)} ms` : '';
    this.log(`pass ${why}: ${this.answered()} of ${this.n} places, ${ps.requests} asks (${ps.runs} runs), ${Math.round(ps.ms)} ms decoding in ${Math.round(performance.now() - ps.t0)} ms${between}`);
  }

  /** Whether `slot` has no picture within X of its middle (what the between pass fills). */
  betweenNeed(slot) {
    const T = this.target(slot);
    const i = this.index(T);
    for (const e of [this.list[i - 1], this.list[i]]) if (e && Math.abs(e.t - T) <= this.X) return false;
    return true;
  }

  /** The latest known keyframe at or before `time` (the real one is never earlier), else the start. */
  keyBefore(time) {
    let kp = this.o.startT;
    for (const k of this.keys) { if (k.t <= time) kp = k.t; else break; }
    return kp;
  }

  /**
   * The between pass's next stretch once the keyframe pass has nothing left: from the first slot without a picture
   * within X to the first known keyframe BETWEEN_CHUNK_MS of decoding later (or the end). Null when it is done, does
   * not fit its budget, or ran out of it. Estimate = frames from the keyframe before that slot to the end x cost per
   * frame + one keyframe request's measured time.
   * @returns {{slot: number, t: number, to: number} | null}
   */
  sweepNext() {
    const ps = this.ps;
    const fps = this.o.fps || 30;
    const end = this.o.startT + this.o.duration;
    if (!ps.bw) {
      const p = this.o.pass || {};
      // Cost per frame: the refines' (or the engine's first guess) until a sweep measures it.
      ps.bw = { state: 'running', budget: p.betweenMs ?? (p.far ? BETWEEN_BUDGET_FAR_MS : BETWEEN_BUDGET_MS),
        frameMs: this.frameMs, measured: false, est: 0, ms: 0, requests: 0, pictures: 0, tried: new Set() };
    }
    const bw = ps.bw;
    if (bw.state !== 'running') return null;
    let slot = -1;
    for (let s = 0; s < this.n; s++) if (!bw.tried.has(s) && this.betweenNeed(s)) { slot = s; break; }
    if (slot < 0) { bw.state = 'done:complete'; return null; }
    const t = this.target(slot);
    const kp = this.keyBefore(t);
    const left = (end - kp) * fps * bw.frameMs + this.medianMs();
    if (!bw.requests) bw.est = left;
    if (bw.ms + left > (bw.measured ? BETWEEN_OVER : BETWEEN_TRY) * bw.budget) {
      bw.state = bw.requests ? 'done:budget' : 'skip';
      return null;
    }
    let to = end + 1;
    for (const k of this.keys) if (k.t > t && (k.t - kp) * fps * bw.frameMs >= BETWEEN_CHUNK_MS) { to = k.t; break; }
    return { slot, t, to };
  }

  /** A sweep reply: pictures for slots still without one within X; its cost per frame replaces the guess. */
  async onSweep(req, m) {
    const bw = this.ps && this.ps.bw;
    const ok = !m.cancelled && !req.cancelSent;
    const pics = [];
    if (ok && Number.isFinite(m.kt)) {
      pics.push({ kt: m.kt, data: m.data });
      for (const x of m.more || []) if (x && Number.isFinite(x.kt)) pics.push(x);
    }
    // Decided before adding: the reply's own pictures do not stand in for each other.
    const fill = pics.filter((x) => {
      const slot = this.slotOf(x.kt - this.o.startT);
      return Math.abs(x.kt - this.target(slot)) <= this.X && this.betweenNeed(slot);
    });
    for (const x of fill) {
      const p = await this.picture({ data: x.data, w: m.w, h: m.h, fmt: m.fmt });
      if (this.inflight !== req) { if (p) p.bmp.close(); return; }
      if (p) { this.add(x.kt, 'frame', p, m.w, m.h); if (bw) bw.pictures++; }
    }
    if (bw && ok) {
      for (let s = req.slot; s < this.n && this.target(s) < req.to; s++) bw.tried.add(s);
      // The host does not count frames: from the keyframe before the first picture to the last.
      const last = pics.length ? pics[pics.length - 1].kt : req.at;
      const frames = m.frames > 0 ? m.frames : (last - this.keyBefore(req.at)) * (this.o.fps || 30);
      if (frames >= 10) { bw.frameMs = Math.max(0.05, (performance.now() - req.t) / frames); bw.measured = true; }
    }
    this.passAfter(req, m);
    if (this.inflight === req) this.inflight = null;
    this.kick();
  }

  /** Slots with a picture (or known to have none). */
  answered() {
    let n = 0;
    for (let s = 0; s < this.n; s++) if (!this.need(s)) n++;
    return n;
  }

  passStats() {
    const ps = this.ps;
    if (!ps) return null;
    const state = ps.done ? `done:${ps.done}` : ps.paused ? `paused:${ps.paused}` : ps.requests || this.inflight?.pass ? 'running' : 'waiting';
    const bw = ps.bw;
    const between = bw && { state: bw.state, est: Math.round(bw.est), requests: bw.requests, pictures: bw.pictures,
      ms: Math.round(bw.ms), frameMs: Math.round(bw.frameMs * 100) / 100 };
    return { state, requests: ps.requests, runs: ps.runs, ms: Math.round(ps.ms), s: Math.round((performance.now() - ps.t0) / 100) / 10, between };
  }

  /** 0..n-1 ordered so every prefix covers the range evenly (n/2, n/4, 3n/4, ...). */
  static coarseToFine(n) {
    const out = [];
    const seen = new Uint8Array(n);
    for (let div = 1; out.length < n && div <= 2 * n; div *= 2) {
      for (let k = 0; k < div; k++) {
        const i = Math.min(n - 1, Math.floor(((k + 0.5) / div) * n));
        if (!seen[i]) { seen[i] = 1; out.push(i); }
      }
    }
    for (let i = 0; i < n; i++) if (!seen[i]) out.push(i);
    return out;
  }

  /** Native backend: one cancellable thumbnail from the extension host. */
  async requestHost(req) {
    let r = null;
    try {
      const sweep = req.mode === 'sweep' ? { to: req.to, step: this.X } : {};
      r = await this.o.request(req.at, this.box.w, this.box.h, req.abort.signal, req.mode, req.pass ? { pass: true, ...sweep } : undefined);
    } catch (e) { this.log(`host: ${e}`); }
    this.onThumb({ ...r, id: req.id, ms: Math.round(performance.now() - req.t) });
  }

  /** The nearest slot around the pointer without a picture (within the radius), or null. */
  nextNear() {
    if (this.scrub || this.o.remote || this.want === null) return null;
    const rad = this.o.radius ?? 4;
    for (let d = 1; d <= rad; d++) {
      for (const s of [this.want + d, this.want - d]) {
        if (s >= 0 && s < this.n && this.need(s)) return s;
      }
    }
    return null;
  }

  /** A keyframe entry already in the list at time `kt`. */
  keyAt(kt) {
    const e = this.list[this.index(kt)];
    return e && e.t === kt && e.kind === 'key' ? e : null;
  }

  /** A reply's picture as a bitmap and its JPEG (null for RGBA), or null when the reply has none that fits. */
  async picture(m) {
    const jpeg = m.fmt === 'jpeg';
    if (!m.data || !Number.isInteger(m.w) || !Number.isInteger(m.h) ||
        !(m.w > 0 && m.w <= this.box.w && m.h > 0 && m.h <= this.box.h) ||
        !(jpeg ? m.data.byteLength > 0 : m.data.byteLength === m.w * m.h * 4)) return null;
    try {
      const blob = jpeg ? new Blob([m.data], { type: 'image/jpeg' }) : null;
      const bmp = await createImageBitmap(blob
        || new ImageData(new Uint8ClampedArray(m.data.buffer, m.data.byteOffset, m.w * m.h * 4), m.w, m.h));
      return { bmp, blob };
    } catch (err) { this.log(`bitmap failed: ${err}`); return null; }
  }

  /** Adds a decoded picture to the list. */
  add(t, kind, p, w, h) {
    /** @type {Entry} */
    const e = { t, kind, end: t, jpeg: p.blob, bmp: p.bmp, w, h, rot: this.rot, used: performance.now() };
    this.insert(e);
    if (!p.blob) this.encode(e);
    return e;
  }

  /** A refine reply: the exact picture becomes a frame entry; its cost teaches frameMs. */
  async onRefine(req, m) {
    const p = !m.cancelled && !req.cancelSent && Number.isFinite(m.kt) ? await this.picture(m) : null;
    if (this.inflight !== req) { if (p) p.bmp.close(); return; }
    if (!m.cancelled && !req.cancelSent) {
      this.refined.add(req.slot);
      if (Number.isFinite(m.kp)) this.addKey(m.kp);
      if (p) {
        const e = this.add(m.kt, 'frame', p, m.w, m.h);
        e.refined = true;
        const ms = Math.round(performance.now() - req.t);
        this.stats.refines++;
        if (this.stats.refineMs.length === 200) this.stats.refineMs.shift();
        this.stats.refineMs.push(ms);
        const kp = Number.isFinite(m.kp) ? m.kp : this.gop(m.kt)?.kp;
        const frames = m.frames > 0 ? m.frames : kp !== undefined ? (m.kt - kp) * (this.o.fps || 30) : 0;
        if (frames >= 10) this.frameMs = 0.5 * this.frameMs + 0.5 * Math.max(0.05, (ms - this.medianMs()) / frames);
        if (this.want !== null && this.cb) {
          const b = this.best(this.want, this.wantT);
          if (b && b.e === e) this.give(e);
        }
      }
    } else if (p) p.bmp.close();
    if (this.inflight === req) this.inflight = null;
    this.kick();
  }

  /** A host run: consecutive keyframes, so each teaches the next (and the last none when the run reached the end). */
  async onRun(req, m) {
    const pics = [];
    if (!m.cancelled && !req.cancelSent && Number.isFinite(m.kt)) {
      pics.push({ kt: m.kt, data: m.data });
      for (const x of m.more || []) if (x && Number.isFinite(x.kt) && x.kt > pics[pics.length - 1].kt) pics.push(x);
    }
    for (let i = 0; i < pics.length; i++) this.addKey(pics[i].kt, i + 1 < pics.length ? pics[i + 1].kt : m.end ? null : undefined);
    for (const x of pics) {
      if (this.keyAt(x.kt)) continue;
      const p = await this.picture({ data: x.data, w: m.w, h: m.h, fmt: m.fmt });
      if (this.inflight !== req) { if (p) p.bmp.close(); return; }
      if (p) { this.add(x.kt, 'key', p, m.w, m.h); this.stats.decoded++; }
    }
    if (!pics.length && !m.cancelled && !req.cancelSent) this.asked.set(req.slot, null);
    this.passAfter(req, m);
    if (this.inflight === req) this.inflight = null;
    this.kick();
  }

  async onThumb(m) {
    const req = this.inflight;
    if (!req || req.id !== m.id) return;
    if (req.refine) { await this.onRefine(req, m); return; }
    if (req.mode === 'run') { await this.onRun(req, m); return; }
    if (req.mode === 'sweep') { await this.onSweep(req, m); return; }
    if (!m.cancelled && !req.cancelSent) {
      const asked = req.at;
      // A timestamp-less picture stands for the asked time (this slot only).
      const kt = Number.isFinite(m.kt) ? m.kt : asked;
      const next = m.next && Number.isFinite(m.next.kt) && m.next.kt > kt ? m.next : null;
      if (Number.isFinite(m.kt)) {
        // A 'near' reply knows the keyframe after (kn, or the host decoded it; null: none to the end).
        const kn = Number.isFinite(m.kn) || m.kn === null ? m.kn : next ? next.kt : undefined;
        this.addKey(Number.isFinite(m.kp) ? m.kp : kt, kn);
        if (Number.isFinite(kn)) this.addKey(kn);
      }
      let e = this.keyAt(kt);
      if (!e) {
        const p = await this.picture(m);
        if (p && (this.inflight !== req || req.cancelSent)) { p.bmp.close(); if (this.inflight !== req) return; } else if (p) {
          e = this.add(kt, 'key', p, m.w, m.h);
          this.stats.decoded++;
          if (this.stats.ms.length === 200) this.stats.ms.shift();
          this.stats.ms.push(Math.round(performance.now() - req.t));
        }
      }
      if (next && !this.keyAt(next.kt) && !req.cancelSent && this.inflight === req) {
        const p = await this.picture({ ...next, w: m.w, h: m.h, fmt: m.fmt });
        if (p && this.inflight === req) this.add(next.kt, 'key', p, m.w, m.h); else if (p) p.bmp.close();
        if (this.inflight !== req) return;
      }
      // The slot's answer: the nearer of the two keyframes a 'near' reply brought.
      const T = this.target(req.slot);
      const alt = next && this.keyAt(next.kt);
      if (alt && (!e || alt.t - T < T - e.t)) e = alt;
      if (!req.cancelSent && e && !e.gone) {
        this.asked.set(req.slot, e);
        if (m.covered && Number.isFinite(m.kt) && kt <= asked) { const k = this.keyAt(kt); if (k) k.end = Math.max(k.end, asked); }
        e.used = performance.now();
        if (this.want !== null && this.cb) {
          const b = this.best(this.want, this.wantT);
          if (b && (b.e === e || req.slot === this.want)) this.give(b.e);
        }
      } else if (!req.cancelSent) {
        this.asked.set(req.slot, null);
        if (Number.isFinite(m.kt)) this.post({ type: 'forget', kt: m.kt });
      }
    } else if (Number.isFinite(m.kt) && !this.keyAt(m.kt)) {
      this.post({ type: 'forget', kt: m.kt });
    }
    this.passAfter(req, m);
    if (this.inflight === req) this.inflight = null;
    this.kick();
  }

  /**
   * Draws a picture from hover() into a canvas, turned like the video.
   * @param {HTMLCanvasElement} cv
   * @param {{bmp: ImageBitmap, w: number, h: number, rot: number}} p
   */
  static draw(cv, p) {
    const side = p.rot === 90 || p.rot === 270;
    const w = side ? p.h : p.w;
    const h = side ? p.w : p.h;
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
    const ctx = /** @type {CanvasRenderingContext2D} */ (cv.getContext('2d'));
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.translate(w / 2, h / 2);
    ctx.rotate((p.rot * Math.PI) / 180);
    ctx.drawImage(p.bmp, -p.w / 2, -p.h / 2);
  }
}
