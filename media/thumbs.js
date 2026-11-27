// @ts-check
// Seek-bar hover thumbnails. One low-priority worker (thumbs-worker.js, a second
// keyframe-only libav.js instance) is started on the first hover and decodes one
// keyframe at a time; it is idle when nobody hovers and is closed 20 s (o.idleMs)
// after the pointer leaves (the cache stays). Engine side: the "seek-bar thumbnails" section
// of engine.js. Not used for MJPEG AVI/image sequences (FramePlayer, no libav)
// or audio-only files.
//
// Lazy (docs/notes/seek-preview.md): nothing decodes until the pointer is on the seek bar
// (hover or drag). The picture under the pointer comes first (newest position wins), then,
// while the pointer stays, a few neighbouring places so moving along the bar is quick.
// When the pointer leaves, requests stop (a running worker request is cancelled) and the
// worker is closed after some idle time. Decoded pictures stay cached (memory budget).
// Native ffmpeg and Live transcode backend: o.request(t, w, h, signal) replaces the worker; the extension host runs
//   ffmpeg -skip_frame nokey -noaccurate_seek -ss T -i FILE -frames:v 1 -vf scale=W:H,showinfo -c:v mjpeg -f image2pipe -
// and answers with a small JPEG plus the decoded keyframe's time (src/thumbhost.js).
'use strict';

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
   * @param {number} [o.radius] neighbouring places filled each side of the pointer (default 4)
   * @param {(msg: string) => void} [o.log]
   * @param {number} [o.cap] bytes of thumbnails kept
   * @param {(t: number, w: number, h: number, signal: AbortSignal) => Promise<any>} [o.request]
   *   decodes one thumbnail elsewhere (native ffmpeg in the extension host) instead of the libav.js
   *   worker; resolves {kt, w, h, data, fmt} (data is a JPEG when fmt is 'jpeg', else RGBA) or null
   */
  constructor(o) {
    this.o = o;
    this.rot = [90, 180, 270].includes(o.rotation || 0) ? o.rotation || 0 : 0;
    // Grid: about 200 places along the bar, so nearby hovers share requests and cache entries.
    this.step = Math.max(o.duration / 200, 1 / (o.fps || 30));
    this.box = this.rot === 90 || this.rot === 270 ? { w: 120, h: 160 } : { w: 160, h: 120 };
    this.cap = o.cap > 0 ? o.cap : 30e6; // bytes of thumbnails kept (less on small machines: media/membudget.js)
    /** @type {Map<number|string, {bmp: ImageBitmap, w: number, h: number, bytes: number}>} keyframe time -> picture (LRU order) */
    this.cache = new Map();
    this.bytes = 0;
    /** @type {Map<number, number|string|null>} grid slot -> keyframe time (null: none found) */
    this.slotKt = new Map();
    this.coverage = new Map();
    this.epoch = 0;
    this.worker = null;
    this.state = 'off'; // off | starting | ready | failed
    this.id = 0;
    this.inflight = null; // {id, slot, prefetch}
    this.want = null; // slot the pointer is on
    this.cb = null;
    this.debounce = 0;
    this.idleTimer = 0;
    this.stats = { requests: 0, decoded: 0, ms: [] };
  }

  /** Counters (tests, notes): requests made, pictures decoded and cached, worker state. */
  stats0() {
    return { requests: this.stats.requests, decoded: this.stats.decoded, cached: this.cache.size, slots: this.slotKt.size, bytes: this.bytes, state: this.state, worker: !!this.worker, hovering: this.want !== null };
  }

  /** The cached picture nearest to `slot` (shown while the exact one decodes). */
  nearest(slot) {
    let best = null;
    let bd = Infinity;
    for (const [s, kt] of this.slotKt) {
      if (kt === null || kt === undefined || !this.cache.has(kt)) continue;
      const d = Math.abs(s - slot);
      if (d < bd) { bd = d; best = s; }
    }
    return best === null ? null : this.lookup(best);
  }

  log(m) { if (this.o.log) this.o.log(`thumbs: ${m}`); }

  /**
   * Pointer at `rel` seconds on the bar. cb(picture | null) is called with the
   * cached picture at once, or later when it is decoded (only if still wanted).
   */
  hover(rel, cb, scrub = false) {
    if (this.state === 'failed') return;
    const slot = Math.max(0, Math.min(Math.floor(this.o.duration / this.step), Math.round(rel / this.step)));
    this.scrub = scrub;
    this.cb = cb;
    this.want = slot;
    this.lastHover = performance.now();
    const hit = this.lookup(slot);
    if (hit) cb(hit);
    else {
      const near = this.nearest(slot);
      if (near) cb(near); // at once; replaced when the exact keyframe arrives
    }
    if (hit && this.nextNear() === null) return; // exact picture and neighbours cached: no work, no worker
    this.start();
    // Let the active decode finish. Only the latest pending position gets dispatched.
    if (this.inflight) { this.kick(); return; }
    if (!this.debounce) this.debounce = setTimeout(() => { this.debounce = 0; this.kick(); }, 40);
  }

  /** Pointer left the bar. */
  leave(immediate = false) {
    this.want = null;
    this.cb = null;
    clearTimeout(this.debounce);
    this.debounce = 0;
    if (immediate || this.o.request && this.inflight) { this.stop(); return; }
    // Ordinary hover can keep the warm context after cancelling the packet scan.
    if (this.inflight && this.worker && !this.inflight.cancelSent) {
      this.inflight.cancelSent = true;
      this.worker.postMessage({ type: 'cancel', below: this.inflight.id + 1 });
    }
    if (!this.inflight) this.kick();
  }

  /** @returns {{bmp: ImageBitmap, w: number, h: number, rot: number} | null} */
  lookup(slot) {
    let kt = this.slotKt.get(slot);
    if (kt === undefined || kt === null || !this.cache.has(kt)) {
      const target = this.o.startT + slot * this.step;
      for (const [anchor, end] of this.coverage) {
        if (anchor <= target && target <= end && (kt == null || !this.cache.has(kt) || anchor > kt)) kt = anchor;
      }
      if (kt !== null && kt !== undefined && this.cache.has(kt)) this.slotKt.set(slot, kt);
    }
    const e = kt === null || kt === undefined ? null : this.cache.get(kt);
    if (!e) return null;
    // Recently used last.
    this.cache.delete(/** @type {number|string} */ (kt));
    this.cache.set(/** @type {number|string} */ (kt), e);
    return { bmp: e.bmp, w: e.w, h: e.h, rot: this.rot };
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
    this.inflight?.abort?.abort();
    clearTimeout(this.idleTimer);
    clearTimeout(this.debounce);
    this.debounce = 0;
    if (this.worker) this.worker.terminate();
    this.worker = null;
    this.inflight = null;
    if (this.state !== 'failed') this.state = 'off';
    if (this.o.onIdle) this.o.onIdle();
  }

  dispose() {
    this.state = 'failed';
    this.leave(true);
    for (const e of this.cache.values()) e.bmp.close();
    this.cache.clear();
    this.coverage.clear();
    this.slotKt.clear();
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
        if (this.inflight && this.inflight.id === m.id) { this.slotKt.set(this.inflight.slot, null); this.inflight = null; }
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
      // Pointer away: nothing to decode. Close the worker after some idle time.
      if (this.o.onIdle) this.o.onIdle();
      const left = (this.o.idleMs ?? 20e3) - (performance.now() - (this.lastHover || 0));
      if (left <= 0) this.stop();
      else this.idleTimer = setTimeout(() => this.kick(), left);
      return;
    }
    if (!this.lookup(this.want) && !(this.slotKt.has(this.want) && this.slotKt.get(this.want) === null)) slot = this.want;
    else if (!(this.o.busy && this.o.busy())) {
      slot = this.nextNear();
      prefetch = slot !== null;
    }
    if (slot === null) {
      // Pointer on the bar and everything near it is there (or playback is busy: look again soon).
      if (this.o.onIdle) this.o.onIdle();
      if (this.o.busy && this.o.busy() && this.nextNear() !== null) this.idleTimer = setTimeout(() => this.kick(), 500);
      return;
    }
    this.inflight = { id: ++this.id, slot, prefetch, t: performance.now() };
    this.stats.requests++;
    if (this.o.request) {
      this.inflight.abort = new AbortController();
      this.requestHost(this.inflight);
      return;
    }
    this.worker.postMessage({ type: 'thumb', id: this.id, t: this.o.startT + slot * this.step, w: this.box.w, h: this.box.h });
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
      r = await this.o.request(this.o.startT + req.slot * this.step, this.box.w, this.box.h, req.abort.signal);
    } catch (e) { this.log(`host: ${e}`); }
    this.onThumb({ ...r, id: req.id, ms: Math.round(performance.now() - req.t) });
  }

  /** The nearest place around the pointer without a picture (within the radius), or null. */
  nextNear() {
    if (this.scrub || this.o.remote || this.want === null) return null;
    const last = Math.floor(this.o.duration / this.step);
    const rad = this.o.radius ?? 4;
    for (let d = 1; d <= rad; d++) {
      for (const s of [this.want + d, this.want - d]) {
        if (s >= 0 && s <= last && !this.lookup(s) && this.slotKt.get(s) !== null) return s;
      }
    }
    return null;
  }

  async onThumb(m) {
    const req = this.inflight;
    if (!req || req.id !== m.id) return;
    if (!m.cancelled && !req.cancelSent) {
      const wantedHit = this.want !== null && this.lookup(this.want);
      const target = this.o.startT + req.slot * this.step;
      // A timestamp-less picture is reusable at this slot only.
      const kt = Number.isFinite(m.kt) ? m.kt : `slot:${req.slot}`;
      const bytes = m.w * m.h * 4;
      const jpeg = m.fmt === 'jpeg';
      // A JPEG reply (native ffmpeg) is a few KB on the wire; the cache still holds the decoded w*h*4 bitmap.
      if (m.data && Number.isInteger(m.w) && Number.isInteger(m.h) &&
          m.w > 0 && m.w <= this.box.w && m.h > 0 && m.h <= this.box.h &&
          bytes <= this.cap && (jpeg ? m.data.byteLength > 0 : m.data.byteLength === bytes)) {
        try {
          const bmp = await createImageBitmap(jpeg ? new Blob([m.data], { type: 'image/jpeg' })
            : new ImageData(new Uint8ClampedArray(m.data.buffer, m.data.byteOffset, bytes), m.w, m.h));
          if (this.inflight !== req) { bmp.close(); return; }
          if (req.cancelSent) bmp.close();
          else {
            this.add(kt, { bmp, w: m.w, h: m.h, bytes });
            this.stats.decoded++;
            if (this.stats.ms.length === 200) this.stats.ms.shift();
            this.stats.ms.push(Math.round(performance.now() - req.t));
          }
        } catch (e) { this.log(`bitmap failed: ${e}`); }
      }
      if (!req.cancelSent && this.cache.has(kt)) {
        this.slotKt.set(req.slot, kt);
        if (m.covered && Number.isFinite(m.kt) && kt <= target) {
          this.coverage.set(kt, Math.max(target, this.coverage.get(kt) ?? kt));
        }
        if (this.want !== null && this.cb && (!wantedHit || this.want === req.slot)) {
          const hit = this.lookup(this.want);
          if (hit) this.cb(hit);
        }
      } else if (!req.cancelSent) {
        this.slotKt.set(req.slot, null);
      }
      if (!this.cache.has(kt) && Number.isFinite(m.kt)) this.post({ type: 'forget', kt });
    } else if (Number.isFinite(m.kt) && !this.cache.has(m.kt)) {
      this.post({ type: 'forget', kt: m.kt });
    }
    if (this.inflight === req) this.inflight = null;
    this.kick();
  }

  add(kt, e) {
    const old = this.cache.get(kt);
    if (old) { this.bytes -= old.bytes; old.bmp.close(); this.cache.delete(kt); }
    this.cache.set(kt, e);
    this.bytes += e.bytes;
    for (const [k, v] of this.cache) {
      if (this.bytes <= this.cap) break;
      this.cache.delete(k);
      this.coverage.delete(k);
      this.bytes -= v.bytes;
      v.bmp.close();
      if (this.worker) this.worker.postMessage({ type: 'forget', kt: k });
    }
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
