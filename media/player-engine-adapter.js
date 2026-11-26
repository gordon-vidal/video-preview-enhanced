// @ts-check
'use strict';
// Production EngineAdapter for media/player-ui.js (docs/notes/player-ui-controller.md, "Production wiring").
// It puts the decoders a page already runs (engine.js players, frame-player.js, the Compare compositor) behind the
// same contract the mockup's FakeEngine passes (test/host/adapter_contract_test.js), so VpePlayerUi.create() can
// mount in a production webview without knowing about decoders.
//
//   const engine = VpeEngineAdapter.create({
//     clips: [{ id: 'A', name: 'a.mp4' }, ...],   // what the page shows; player metadata fills the rest
//     getPlayer: (id) => players[id] || null,     // the page's decoder per clip (may be null until it opens)
//     compositor, pictureApi: VpePicture, controlsApi: VpeControls,
//   });
//
// The adapter owns no decoder and no timer: it reads what the player knows (meta, fps, n, info) on every call, so a
// player that opens later, or is replaced, is picked up without telling the adapter.
(function (root) {
  // checkJs: start
  /**
   * The shared contracts (media/unified-contracts.d.ts): this adapter implements EngineAdapter.
   * @typedef {import('./unified-contracts').EngineAdapter} EngineAdapter
   * @typedef {import('./unified-contracts').ClipSpec} ClipSpec
   * @typedef {import('./unified-contracts').ClipMeta} ClipMeta
   * @typedef {import('./unified-contracts').PictureRect} Rect
   * @typedef {import('./unified-contracts').OffsetSpec} Offset
   * @typedef {{ clips: ClipSpec[], getPlayer: (id: string) => any, compositor?: any, pictureApi?: any,
   *   controlsApi?: any, doc?: any, showFrameTimeoutMs?: number, streamInfo?: (id: string) => any,
   *   grabExact?: (id: string, player: any) => any }} EngineAdapterOptions
   * streamInfo: the host's 'stream' report for a clip (URL / HLS: its Quality variants), or null.
   * grabExact: the page's exact-frame request for a clip (media/exactframe.js grab), or null when none applies.
   */

  const FALLBACK = { fps: 24, frames: 240, width: 1920, height: 1080 };
  const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

  const pos = (/** @type {any} */ v) => (Number(v) > 0 ? Number(v) : 0);
  const clamp01 = (/** @type {any} */ v) => Math.max(0, Math.min(1, Number(v) || 0));

  /**
   * An offset in frames of the clip (a plain number is frames; { unit: 'ms', v } is milliseconds).
   * @param {Offset} offset @param {number} fps
   */
  function offsetFrames(offset, fps) {
    if (typeof offset === 'number') return Number.isFinite(offset) ? offset : 0;
    if (!offset || typeof offset !== 'object') return 0;
    const v = Number(offset.v) || 0;
    return offset.unit === 'ms' ? (v / 1000) * fps : v;
  }

  /**
   * Fit / fill / stretch / actual inside a cell, zoom about the centre, pan in px: the contract's maths, used when
   * no pictureApi (media/picture.js) is given.
   * @param {{ width: number, height: number }} nat @param {number} cellW @param {number} cellH
   * @param {string} mode @param {number} zoom @param {number} panX @param {number} panY
   * @returns {Rect}
   */
  function plainRect(nat, cellW, cellH, mode, zoom, panX, panY) {
    const cw = Math.max(0, Number(cellW) || 0);
    const ch = Math.max(0, Number(cellH) || 0);
    let w;
    let h;
    if (mode === 'stretch') { w = cw; h = ch; }
    else if (mode === 'actual') { w = nat.width; h = nat.height; }
    else {
      const s = mode === 'fill' ? Math.max(cw / nat.width, ch / nat.height) : Math.min(cw / nat.width, ch / nat.height);
      w = nat.width * s;
      h = nat.height * s;
    }
    const z = Number(zoom) > 0 ? Number(zoom) : 1;
    w *= z;
    h *= z;
    return { x: (cw - w) / 2 + (Number(panX) || 0), y: (ch - h) / 2 + (Number(panY) || 0), w, h };
  }

  /** @param {string} b64 */
  function base64Bytes(b64) {
    const atobFn = /** @type {any} */ (globalThis).atob;
    if (typeof atobFn === 'function') {
      const bin = atobFn(b64);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    }
    const B = /** @type {any} */ (globalThis).Buffer; // Node tests only; never reached in a webview
    return B ? new Uint8Array(B.from(b64, 'base64')) : new Uint8Array(0);
  }

  /** @param {any} data */
  function toBytes(data) {
    if (data instanceof Uint8Array) return data;
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    if (typeof data === 'string') {
      const comma = data.indexOf(',');
      return base64Bytes(data.startsWith('data:') ? data.slice(comma + 1) : data);
    }
    return null;
  }

  /** @param {Uint8Array | null} bytes */
  const isPng = (bytes) => !!bytes && bytes.length > 8 && PNG_SIGNATURE.every((b, i) => bytes[i] === b);

  /**
   * The clock frame in the tile's own frames: a Compare clock may run at another clip's rate, so it is mapped
   * through time (clockFrame / clockFps seconds). Without a clock rate, or the same rate, the frame is kept as is.
   * @param {number} clockFrame @param {number} tileFps @param {number} [clockFps]
   */
  function clockToTileFrame(clockFrame, tileFps, clockFps) {
    const f = Number(clockFrame) || 0;
    const cf = Number(clockFps);
    if (!(cf > 0) || !Number.isFinite(cf) || !(tileFps > 0) || Math.abs(cf - tileFps) < 1e-9) return Math.round(f);
    return Math.round((f / cf) * tileFps);
  }

  const hex2 = (/** @type {number} */ v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');

  /**
   * A player's pixel read as the { text } the inspector copies (media/player-ui-tools.js pickAt), keeping the
   * channels when there are some. Accepts a string, { text }, { r, g, b, a? } or [r, g, b, a?]; else null.
   * @param {any} v @param {number} x @param {number} y
   */
  function formatPixel(v, x, y) {
    if (v === null || v === undefined) return null;
    if (typeof v === 'string') return v ? { text: v } : null;
    if (typeof v !== 'object') return null;
    const arr = Array.isArray(v) || ArrayBuffer.isView(v) ? /** @type {any} */ (v) : null;
    const [r, g, b, a] = arr ? [arr[0], arr[1], arr[2], arr[3]] : [v.r, v.g, v.b, v.a];
    const rgb = [r, g, b].every((n) => typeof n === 'number' && Number.isFinite(n));
    const channels = rgb ? { r, g, b, a: typeof a === 'number' && Number.isFinite(a) ? a : 255 } : {};
    if (!arr && typeof v.text === 'string' && v.text) return { ...v, ...channels, text: v.text };
    if (!rgb) return null;
    // Same wording as the single player's inspector (media/inspect.js).
    return { ...channels, text: `x=${Math.round(x)} y=${Math.round(y)} rgb=(${r},${g},${b}) #${hex2(r)}${hex2(g)}${hex2(b)}` };
  }

  const SHOW_FRAME_TIMEOUT_MS = 20000;
  const SHOW_FRAME_POLL_MS = 16;

  /** @param {EngineAdapterOptions} opts */
  function create(opts) {
    if (!opts || !Array.isArray(opts.clips) || typeof opts.getPlayer !== 'function') {
      throw new Error('VpeEngineAdapter.create: clips (array) and getPlayer (function) are required');
    }
    // Live: registerClip / unregisterClip change both in place, so `engine.clips` follows the page's tiles.
    const specs = opts.clips.filter((c) => c && typeof c.id === 'string');
    const byId = new Map(specs.map((c) => [c.id, c]));
    const { compositor, pictureApi, controlsApi } = opts;
    const doc = opts.doc || /** @type {any} */ (globalThis).document || null;
    const showFrameTimeoutMs = Number(opts.showFrameTimeoutMs) > 0 ? Number(opts.showFrameTimeoutMs) : SHOW_FRAME_TIMEOUT_MS;
    /** @param {string} id */
    const streamOf = (id) => {
      if (typeof opts.streamInfo !== 'function') return null;
      try { return opts.streamInfo(id) || null; } catch { return null; }
    };

    /** @param {string} id */
    const playerOf = (id) => {
      if (!byId.has(id)) return null;
      try { return opts.getPlayer(id) || null; } catch { return null; }
    };

    /**
     * The clip as the player knows it now; the spec's own numbers win (the host may know them before the decoder).
     * @param {string} id @returns {ClipMeta | null}
     */
    function getClip(id) {
      const spec = byId.get(id);
      if (!spec) return null;
      const p = playerOf(id);
      const meta = (p && p.meta) || {};
      const video = (p && p.info && p.info.video) || null;
      const fps = pos(spec.fps) || pos(p && p.fps) || pos(meta.fps) || FALLBACK.fps;
      const seconds = pos(spec.duration) || pos(meta.duration);
      const frames = Math.round(pos(spec.frames) || pos(p && p.n) || (seconds ? seconds * fps : 0)) || FALLBACK.frames;
      const width = pos(spec.width) || pos(meta.width) || pos(video && (video.sourceWidth || video.width)) || FALLBACK.width;
      const height = pos(spec.height) || pos(meta.height) || pos(video && (video.sourceHeight || video.height)) || FALLBACK.height;
      const hasAudio = typeof spec.hasAudio === 'boolean' ? spec.hasAudio
        : !!(p && (p.audio || (p.info && p.info.audio) || meta.hasAudio));
      return {
        id, name: typeof spec.name === 'string' ? spec.name : id,
        fps, frames, duration: frames / fps, width, height, hasAudio,
        codec: spec.codec || (video && video.codec) || '', size: pos(spec.size) || pos(meta.size),
      };
    }
    /** @param {string} id */
    const clipOrFirst = (id) => getClip(id) || getClip(specs[0] && specs[0].id);

    /** @param {string} id */
    function naturalSize(id) {
      const c = clipOrFirst(id);
      return c ? { width: c.width, height: c.height } : { width: FALLBACK.width, height: FALLBACK.height };
    }

    /** "About this video": VpeControls.facts over what the player knows, else a plain summary. @param {string} id */
    function facts(id) {
      const c = clipOrFirst(id);
      if (!c) return { title: String(id), sub: '', rows: [['Video', 'not open']] };
      const p = playerOf(c.id);
      if (controlsApi && typeof controlsApi.facts === 'function') {
        try {
          const info = (p && p.info) || {};
          let tracks = null;
          try { tracks = p && typeof p.tracks === 'function' ? p.tracks() : null; } catch { tracks = null; }
          const f = controlsApi.facts({
            name: c.name, size: c.size, duration: c.duration, width: c.width, height: c.height, fps: c.fps, info,
            vmode: p && p.vmode, amode: p && p.amode, native: !!(p && p.cfg && p.cfg.native),
            remoteStream: !!(p && p.remoteStream), hasSound: c.hasAudio,
            tracks: { audio: tracks && tracks.audio ? tracks.audio.length : c.hasAudio ? 1 : 0, sub: tracks && tracks.sub ? tracks.sub.length : 0 },
          });
          const rows = f && Array.isArray(f.rows)
            ? f.rows.filter((/** @type {any} */ r) => Array.isArray(r) && r.length === 2).map((/** @type {any[]} */ r) => [String(r[0]), String(r[1])])
            : [];
          if (f && rows.length) return { title: String(f.title || c.name), sub: String(f.sub || ''), rows };
        } catch { /* a facts() failure must not break the About panel: the plain summary below */ }
      }
      const video = [c.codec, `${c.width}×${c.height}`, `${+c.fps.toFixed(3)} fps`].filter(Boolean);
      return {
        title: c.name, sub: video.join(' · '),
        rows: [
          ['Video', video.join(', ')],
          ['Duration', `${c.duration.toFixed(3)} s (${c.frames} frames)`],
          ['Audio', c.hasAudio ? 'Yes' : 'None'],
        ],
      };
    }

    /**
     * The frame a tile shows at the shared clock frame with its sync offset; outside the clip there is no picture.
     * With `clockFps` (the clock's rate, when it differs from the tile's) the clock frame is mapped through time
     * first, then the offset in the tile's own frames is added.
     * @param {string} clipId @param {number} clockFrame @param {Offset} [offset] @param {number} [clockFps]
     */
    function shownFrame(clipId, clockFrame, offset, clockFps) {
      const c = clipOrFirst(clipId);
      if (!c) return { frame: null, outOfRange: true };
      const f = clockToTileFrame(clockFrame, c.fps, clockFps) + Math.round(offsetFrames(offset, c.fps));
      if (f < 0 || f >= c.frames) return { frame: null, outOfRange: true };
      return { frame: f, outOfRange: false };
    }

    /**
     * The picture's rect in cell pixels. With media/picture.js the pan is the shared view's (cx, cy) point as Compare
     * keeps it; panX / panY in px shift that result, so both callers agree.
     * @param {string} clipId @param {number} cellW @param {number} cellH
     * @param {string} [picMode] @param {number} [zoom] @param {number} [panX] @param {number} [panY]
     * @returns {Rect}
     */
    function pictureRect(clipId, cellW, cellH, picMode = 'fit', zoom = 1, panX = 0, panY = 0) {
      const nat = naturalSize(clipId);
      const mode = ['fit', 'fill', 'stretch', 'actual'].includes(picMode) ? picMode : 'fit';
      const dpr = (typeof window !== 'undefined' && Number(window.devicePixelRatio) > 0) ? Number(window.devicePixelRatio) : 1;
      if (pictureApi && typeof pictureApi.rectOf === 'function') {
        try {
          const view = { w: Math.max(0, Number(cellW) || 0), h: Math.max(0, Number(cellH) || 0) };
          const size = { w: nat.width, h: nat.height };
          const z = Number(zoom) > 0 ? Number(zoom) : 1;
          // rectOf clamps the pan to keep the picture covering the area; the adapter's pan is a free shift in px.
          const r = pictureApi.rectOf({ mode, zoom: z, cx: 0.5, cy: 0.5 }, size, size, view, { dpr });
          if (r && [r.x, r.y, r.w, r.h].every(Number.isFinite)) {
            return { x: r.x + (Number(panX) || 0), y: r.y + (Number(panY) || 0), w: r.w, h: r.h };
          }
        } catch { /* fall through to the plain maths */ }
      }
      return plainRect(nat, cellW, cellH, mode, zoom, panX, panY);
    }

    /**
     * Present a tile's frame into a canvas: the compositor if the page has one, else the player's own draw, else
     * the player's current picture (snapshotSource) fitted with the split clip. Never throws.
     * @param {any} canvas @param {string} clipId @param {number} frame
     * @param {{ splitClipRatio?: number | null, width?: number, height?: number, picMode?: string, zoom?: number, panX?: number, panY?: number }} [o]
     */
    function draw(canvas, clipId, frame, o = {}) {
      if (!canvas) return;
      try {
        if (compositor && typeof compositor.present === 'function') {
          compositor.present(canvas, clipId, frame, o);
          return;
        }
        const p = playerOf(clipId);
        if (p && typeof p.draw === 'function') { p.draw(canvas, frame, o); return; }
        const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
        const cssW = pos(o.width) || canvas.clientWidth || 320;
        const cssH = pos(o.height) || canvas.clientHeight || 180;
        const w = Math.max(1, Math.round(cssW * dpr));
        const h = Math.max(1, Math.round(cssH * dpr));
        if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
        const ctx = canvas.getContext && canvas.getContext('2d');
        if (!ctx) return;
        ctx.save();
        if (typeof o.splitClipRatio === 'number') {
          const sx = Math.round(w * clamp01(o.splitClipRatio));
          ctx.clearRect(sx, 0, w - sx, h);
          ctx.beginPath();
          ctx.rect(sx, 0, w - sx, h);
          ctx.clip();
        } else ctx.clearRect(0, 0, w, h);
        const src = p && typeof p.snapshotSource === 'function' ? p.snapshotSource() : null;
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, w, h);
        if (src && src.width > 0 && src.height > 0) {
          const r = pictureRect(clipId, cssW, cssH, o.picMode || 'fit', o.zoom, o.panX, o.panY);
          ctx.drawImage(src, r.x * dpr, r.y * dpr, r.w * dpr, r.h * dpr);
        }
        ctx.restore();
      } catch { /* a tile that cannot paint stays as it was */ }
    }

    // ---- seek-bar hover preview: a scrub is coalesced to one microtask so thumbnailLeave() can cancel it ----
    /** @type {{ clipId: string, seconds: number, cb: any } | null} */
    let pendingThumb = null;
    let thumbGen = 0;
    /** @param {{ clipId: string, seconds: number, cb: any }} q */
    function deliverThumb(q) {
      const c = clipOrFirst(q.clipId);
      if (!c) return;
      const frame = Math.max(0, Math.min(c.frames - 1, Math.round((Number(q.seconds) || 0) * c.fps)));
      const seconds = frame / c.fps;
      const base = { clipId: c.id, seconds, frame, width: c.width, height: c.height };
      const p = playerOf(c.id);
      const gen = thumbGen;
      const give = (/** @type {any} */ picture) => {
        if (gen !== thumbGen) return;
        if (typeof q.cb === 'function') q.cb(picture ? { ...base, picture } : base);
        else if (q.cb && typeof q.cb.getContext === 'function') {
          if (picture && picture.width > 0) {
            try { q.cb.getContext('2d').drawImage(picture, 0, 0, q.cb.width, q.cb.height); } catch { /* no picture */ }
          } else draw(q.cb, c.id, frame, {});
        }
      };
      let asked = false;
      if (p && typeof p.thumbnail === 'function') {
        try { asked = p.thumbnail(seconds, give, false) !== false; } catch { asked = false; }
      }
      if (!asked) give(null);
    }
    /**
     * @param {string} clipId @param {number} seconds @param {any} cb a function ({ clipId, seconds, frame, width,
     *   height, picture? }) or a canvas @param {boolean} [scrubbing]
     */
    function thumbnail(clipId, seconds, cb, scrubbing) {
      if (!scrubbing) { pendingThumb = null; deliverThumb({ clipId, seconds, cb }); return; }
      const first = !pendingThumb;
      pendingThumb = { clipId, seconds, cb };
      if (!first) return;
      const gen = thumbGen;
      Promise.resolve().then(() => {
        const q = pendingThumb;
        pendingThumb = null;
        if (q && gen === thumbGen) deliverThumb(q);
      });
    }
    /** @param {boolean} [immediate] */
    function thumbnailLeave(immediate) {
      thumbGen++;
      pendingThumb = null;
      for (const s of specs) {
        const p = playerOf(s.id);
        if (p && typeof p.thumbnailLeave === 'function') { try { p.thumbnailLeave(immediate); } catch { /* ignore */ } }
      }
    }

    /**
     * A still at natural size as PNG bytes. An exact-frame grabber on the player (snapshot(frame)) wins; otherwise
     * the player's current picture is captured, so the caller seeks to `frame` first.
     * @param {string} clipId @param {number} [frame]
     */
    function snapshot(clipId, frame) {
      const c = clipOrFirst(clipId);
      if (!c) return null;
      const p = playerOf(c.id);
      const current = p && typeof p.currentFrame === 'function' ? Number(p.currentFrame()) || 0 : 0;
      const f = Math.max(0, Math.min(c.frames - 1, Math.round(frame === undefined || frame === null ? current : Number(frame) || 0)));
      const out = (/** @type {Uint8Array} */ data, /** @type {number} */ width, /** @type {number} */ height) =>
        ({ clipId: c.id, frame: f, width, height, mimeType: 'image/png', data });
      if (p && typeof p.snapshot === 'function') {
        try {
          const s = p.snapshot(f);
          const data = s && toBytes(s.data !== undefined ? s.data : s);
          if (isPng(data)) return out(/** @type {Uint8Array} */ (data), pos(s && s.width) || c.width, pos(s && s.height) || c.height);
        } catch { /* fall back to the shown picture */ }
      }
      const src = p && typeof p.snapshotSource === 'function' ? p.snapshotSource() : null;
      if (!src) return null;
      try {
        let cv = src;
        if (doc && typeof doc.createElement === 'function' && (src.width !== c.width || src.height !== c.height)) {
          // A native tile may hold a smaller frame: scale it to the video's own size, as Save frame does.
          cv = doc.createElement('canvas');
          cv.width = c.width;
          cv.height = c.height;
          cv.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
        }
        const data = typeof cv.toDataURL === 'function' ? toBytes(cv.toDataURL('image/png')) : null;
        return isPng(data) ? out(/** @type {Uint8Array} */ (data), c.width, c.height) : null;
      } catch { return null; }
    }

    /**
     * Show `frame` paused and resolve with the frame actually on screen once the player has presented it (VFR or
     * gapped video can land on a neighbour), or null: unknown clip, no player, aborted, or nothing after 20 s.
     * A player's own showFrame(frame, opts) wins; otherwise the adapter seeks and watches the player settle
     * (engine.js: seekTarget / shownT / shownCount / shownStale; frame-player.js: shown), as media/player.js does.
     * An engine.js player counts only on positive evidence: a fresh picture (shownCount past its value at the seek,
     * not stale, no seek pending), or the exact frame already cleanly on screen. A seek that never presents gives
     * null, never the previous picture: an export or a still must not silently take the wrong frame.
     * @param {string} clipId @param {number} frame @param {{ signal?: AbortSignal | null }} [o]
     * @returns {Promise<number | null>}
     */
    async function showFrame(clipId, frame, o = {}) {
      const signal = (o && o.signal) || null;
      const aborted = () => !!(signal && signal.aborted);
      const c = getClip(clipId);
      const p = c ? playerOf(clipId) : null;
      if (!c || !p || aborted()) return null;
      const k = Math.max(0, Math.min(c.frames - 1, Math.round(Number(frame) || 0)));
      try { if (typeof p.pause === 'function') p.pause(); } catch { /* a closed player */ }
      if (typeof p.showFrame === 'function') {
        let r;
        try { r = await p.showFrame(k, o); } catch { return null; }
        return !aborted() && typeof r === 'number' && Number.isFinite(r) ? r : null;
      }
      if (typeof p.seekFrame !== 'function') return null;
      const engineLike = 'seekTarget' in p;
      const current = () => (typeof p.currentFrame === 'function' ? Number(p.currentFrame()) : NaN);
      // A stale picture (engine.js: skipped over, or a seek's first picture not shown yet) is never settled.
      const settled = () => p.seekTarget == null && !p.shownStale && p.shownT !== null && p.shownT !== undefined;
      if (engineLike ? settled() && current() === k : p.shown === k) return k;
      const before = Number(p.shownCount) || 0;
      try { p.seekFrame(k); } catch { return null; }
      return new Promise((resolve) => {
        const t0 = Date.now();
        /** @type {any} */
        let timer = null;
        /** @param {number | null} f */
        const finish = (f) => {
          if (timer !== null) clearTimeout(timer);
          timer = null;
          if (signal) signal.removeEventListener('abort', cancel);
          resolve(aborted() ? null : f);
        };
        const cancel = () => finish(null);
        const check = () => {
          timer = null;
          if (aborted() || playerOf(clipId) !== p) { finish(null); return; }
          if (engineLike) {
            const f = current();
            if (settled() && (Number(p.shownCount) || 0) > before && Number.isFinite(f)) { finish(f); return; }
          } else if (p.shown === k) { finish(k); return; }
          else if (!('shown' in p) && current() === k) { finish(k); return; }
          if (Date.now() - t0 >= showFrameTimeoutMs) { finish(null); return; }
          timer = setTimeout(check, SHOW_FRAME_POLL_MS);
        };
        if (signal) signal.addEventListener('abort', cancel, { once: true });
        timer = setTimeout(check, 0);
      });
    }

    /**
     * The pixel under picture point (x, y) as { text } (plus r, g, b, a when known), or null when the clip's
     * player cannot read pixels. The player's pixelAt wins, else its readPixels, else the presented picture as
     * media/inspect.js reads it (engine.js has neither): its WebGL renderer (p.gl.gl), its 2D context (p.ctx), or
     * its canvas (snapshotSource() / canvas) through a 1×1 2D canvas. (x, y) are the canvas's pixels.
     * @param {string} clipId @param {number} x @param {number} y
     */
    function pixelAt(clipId, x, y) {
      const p = playerOf(clipId);
      if (!p) return null;
      try {
        if (typeof p.pixelAt === 'function') return formatPixel(p.pixelAt(x, y), x, y);
        if (typeof p.readPixels === 'function') return formatPixel(p.readPixels(x, y), x, y);
        return formatPixel(samplePresented(p, Math.floor(Number(x)), Math.floor(Number(y))), x, y);
      } catch { /* a lost context or a closed player: no pixel */ }
      return null;
    }

    /**
     * RGBA of the presented picture at canvas pixel (x, y), or null (outside it, or nothing to read).
     * @param {any} p @param {number} x @param {number} y
     */
    function samplePresented(p, x, y) {
      if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0) return null;
      let src = null;
      try { src = typeof p.snapshotSource === 'function' ? p.snapshotSource() : null; } catch { src = null; }
      src = src || p.canvas || null;
      const w = Number(src && src.width) || 0;
      const h = Number(src && src.height) || 0;
      if (src && w && h && (x >= w || y >= h)) return null;
      const gl = p.gl && p.gl.gl;
      if (gl && typeof gl.readPixels === 'function' && h) {
        // GL rows start at the bottom; read the default framebuffer, as media/inspect.js does.
        const buf = new Uint8Array(4);
        const prev = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING);
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
        gl.readPixels(x, h - 1 - y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, buf);
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, prev);
        return buf;
      }
      if (p.ctx && typeof p.ctx.getImageData === 'function') return p.ctx.getImageData(x, y, 1, 1).data;
      if (!src || !w || !h) return null;
      // A 2D canvas is read directly; any other source (a WebGL canvas, a bitmap) is drawn into a 1×1 canvas.
      const own = typeof src.getContext === 'function' && !(p.gl && p.gl.gl) ? src.getContext('2d') : null;
      if (own && typeof own.getImageData === 'function') return own.getImageData(x, y, 1, 1).data;
      if (!doc || typeof doc.createElement !== 'function') return null;
      const one = doc.createElement('canvas');
      one.width = 1;
      one.height = 1;
      const ctx = one.getContext('2d');
      if (!ctx) return null;
      ctx.drawImage(src, x, y, 1, 1, 0, 0, 1, 1);
      return ctx.getImageData(0, 0, 1, 1).data;
    }

    // ---- sound: one tile is heard, every other is muted ----
    /** @type {string | null} */
    let soundSource = null;
    let volume = 1;
    let muted = false;
    function applySound() {
      for (const s of specs) {
        const p = playerOf(s.id);
        if (!p || typeof p.setVolume !== 'function') continue;
        const heard = s.id === soundSource;
        try { p.setVolume(volume, heard ? muted : true); } catch { /* a closed player */ }
      }
    }
    /** @param {string | null} clipId */
    function setSoundSource(clipId) {
      soundSource = typeof clipId === 'string' && byId.has(clipId) ? clipId : null;
      applySound();
    }
    /** @param {number} v 0..1 @param {boolean} m */
    function setVolume(v, m) {
      volume = clamp01(v);
      muted = !!m;
      applySound();
    }

    // ---- clips opened, replaced or closed after boot ----
    /**
     * Add a clip the page opened after boot (or update a known one's spec in place). Its player is found through
     * getPlayer as for the boot clips. Returns the clip as getClip gives it, or null for a spec without an id.
     * @param {ClipSpec} clip
     */
    function registerClip(clip) {
      if (!clip || typeof clip.id !== 'string' || !clip.id) return null;
      const known = byId.get(clip.id);
      if (known) {
        const i = specs.indexOf(known);
        if (i >= 0) specs[i] = clip;
      } else specs.push(clip);
      byId.set(clip.id, clip);
      applySound(); // a new player starts muted unless it is the sound source
      return getClip(clip.id);
    }
    /**
     * Forget a clip the page closed or replaced. Its player is muted first; if it was the sound source, no tile
     * is heard until the page picks another (the adapter never moves the sound on its own). True when known.
     * @param {string} clipId
     */
    function unregisterClip(clipId) {
      const spec = byId.get(clipId);
      if (!spec) return false;
      const p = playerOf(clipId);
      if (p && typeof p.setVolume === 'function') { try { p.setVolume(volume, true); } catch { /* closed */ } }
      byId.delete(clipId);
      const i = specs.indexOf(spec);
      if (i >= 0) specs.splice(i, 1);
      if (soundSource === clipId) soundSource = null;
      return true;
    }

    /**
     * An optional pass-through: the player's method, or `fallback` when it has none (or throws).
     * @param {string} name @param {any} fallback
     */
    const passThrough = (name, fallback) => (/** @type {string} */ clipId, /** @type {any[]} */ ...args) => {
      const p = playerOf(clipId);
      if (!p || typeof p[name] !== 'function') return fallback;
      try { return p[name](...args); } catch { return fallback; }
    };

    // ---- what the picture is made of: the reduced-resolution / slow-playback notices and the Live chip read it ----
    /**
     * `{ clipId, nativeLossy, transcoded, streaming, video, stream, display }` for the clip, or null for an unknown
     * one. nativeLossy: native ffmpeg scaled the picture down or reduced it to 8-bit (engine.js); transcoded: Live
     * transcode (the host said so in the clip's spec, or the decoder is fed a remote stream); streaming: a URL / HLS
     * clip (the host's 'stream' report, then also `quality`) or a remote Live stream.
     * @param {string} clipId
     */
    function pictureInfo(clipId) {
      const c = clipOrFirst(clipId);
      if (!c) return null;
      const spec = /** @type {any} */ (byId.get(c.id)) || {};
      const p = playerOf(c.id);
      const info = (p && p.info) || {};
      const quality = streamOf(c.id);
      const remote = !!(p && p.remoteStream);
      return {
        clipId: c.id,
        nativeLossy: !!(p && p.nativeLossy),
        transcoded: spec.transcoded === true || remote,
        streaming: !!quality || remote,
        video: info.video || null,
        stream: info.remoteStream || null,
        display: null,
        ...(quality ? { quality } : {}),
      };
    }
    /**
     * The Live transcode the clip plays through (the first transcoded clip when no id is given), or null when none
     * does: `{ clipId, lossy, transcode, stream, quality }` (engine.js info.transcode / info.remoteStream).
     * @param {string} [clipId]
     */
    function transcodeInfo(clipId) {
      const ids = typeof clipId === 'string' ? [clipId] : specs.map((s) => s.id);
      for (const id of ids) {
        const pi = pictureInfo(id);
        if (!pi || !pi.transcoded) continue;
        const p = playerOf(pi.clipId);
        const transcode = (p && p.info && p.info.transcode) || null;
        return {
          clipId: pi.clipId, lossy: transcode && transcode.lossy !== undefined ? !!transcode.lossy : pi.nativeLossy,
          transcode, stream: pi.stream, quality: streamOf(pi.clipId),
        };
      }
      return null;
    }
    /**
     * The exact (full-resolution) picture of the clip's shown frame during Live transcode or lossy native playback:
     * the player's own exactFrame() wins, else the page's grabExact (answered by the host's 'exactFrame' reply).
     * Resolves `{ img, w, h, png }`, `{ error }` or null (no player, or the shown picture is exact already).
     * @param {string} clipId
     */
    function exactFrame(clipId) {
      const p = playerOf(clipId);
      if (!p) return Promise.resolve(null);
      try {
        if (typeof p.exactFrame === 'function') return Promise.resolve(p.exactFrame()).catch(() => null);
        if (typeof opts.grabExact === 'function') return Promise.resolve(opts.grabExact(clipId, p)).catch(() => null);
      } catch { /* a closed player */ }
      return Promise.resolve(null);
    }

    const adapter = {
      clips: specs,
      getClip,
      naturalSize,
      /** @param {string} id */
      hasAudio(id) { const c = clipOrFirst(id); return !!(c && c.hasAudio); },
      facts,
      shownFrame,
      pictureRect,
      draw,
      thumbnail,
      thumbnailLeave,
      snapshot,
      showFrame,
      pixelAt,
      registerClip,
      unregisterClip,
      pictureInfo,
      transcodeInfo,
      exactFrame,
      setSoundSource,
      setVolume,
      /** Inspection and subtitles, when the clip's player has them (else null / []). */
      readPixels: passThrough('readPixels', null),
      statsText: passThrough('statsText', ''),
      packetIndex: passThrough('packetIndex', null),
      chapters: passThrough('chapters', []),
      bufferedRanges: passThrough('bufferedRanges', []),
      cueAt: passThrough('cueAt', null),
      /** What the adapter applied (tests and debugging). */
      sound: () => ({ soundSource, volume, muted }),
    };
    // More than the contract (sound), so checked as a value, not as a fresh literal.
    return /** @satisfies {EngineAdapter} */ (adapter);
  }

  const api = { create, offsetFrames, plainRect, clockToTileFrame, formatPixel };
  // checkJs: end
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.VpeEngineAdapter = api;
}(typeof self !== 'undefined' ? self : /** @type {any} */ (this)));
