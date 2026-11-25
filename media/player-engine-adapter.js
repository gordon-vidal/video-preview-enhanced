// @ts-check
'use strict';
// Production EngineAdapter for media/player-ui.js (docs/notes/player-ui-controller.md, "Next step: one unified page").
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
   * @typedef {{ id: string, name?: string, fps?: number, frames?: number, duration?: number, width?: number,
   *   height?: number, hasAudio?: boolean, codec?: string, size?: number }} ClipSpec
   * @typedef {{ id: string, name: string, fps: number, frames: number, duration: number, width: number,
   *   height: number, hasAudio: boolean, codec: string, size: number }} ClipMeta
   * @typedef {{ x: number, y: number, w: number, h: number }} Rect
   * @typedef {number | { unit?: string, v?: number } | null | undefined} Offset
   * @typedef {{ clips: ClipSpec[], getPlayer: (id: string) => any, compositor?: any, pictureApi?: any,
   *   controlsApi?: any, doc?: any }} EngineAdapterOptions
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

  /** @param {EngineAdapterOptions} opts */
  function create(opts) {
    if (!opts || !Array.isArray(opts.clips) || typeof opts.getPlayer !== 'function') {
      throw new Error('VpeEngineAdapter.create: clips (array) and getPlayer (function) are required');
    }
    const specs = opts.clips.filter((c) => c && typeof c.id === 'string');
    const byId = new Map(specs.map((c) => [c.id, c]));
    const { compositor, pictureApi, controlsApi } = opts;
    const doc = opts.doc || /** @type {any} */ (globalThis).document || null;

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
     * @param {string} clipId @param {number} clockFrame @param {Offset} [offset]
     */
    function shownFrame(clipId, clockFrame, offset) {
      const c = clipOrFirst(clipId);
      if (!c) return { frame: null, outOfRange: true };
      const f = Math.round(Number(clockFrame) || 0) + Math.round(offsetFrames(offset, c.fps));
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
      if (pictureApi && typeof pictureApi.rectOf === 'function') {
        try {
          const view = { w: Math.max(0, Number(cellW) || 0), h: Math.max(0, Number(cellH) || 0) };
          const size = { w: nat.width, h: nat.height };
          const z = Number(zoom) > 0 ? Number(zoom) : 1;
          // rectOf clamps the pan to keep the picture covering the area; the adapter's pan is a free shift in px.
          const r = pictureApi.rectOf({ mode, zoom: z, cx: 0.5, cy: 0.5 }, size, size, view, { dpr: 1 });
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
     * @param {{ splitClipRatio?: number | null, width?: number, height?: number, picMode?: string }} [o]
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
        if (src && src.width > 0 && src.height > 0) {
          const r = pictureRect(clipId, w, h, o.picMode || 'fit');
          ctx.drawImage(src, r.x, r.y, r.w, r.h);
        } else {
          ctx.fillStyle = '#000';
          ctx.fillRect(0, 0, w, h);
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

    /**
     * An optional pass-through: the player's method, or `fallback` when it has none (or throws).
     * @param {string} name @param {any} fallback
     */
    const passThrough = (name, fallback) => (/** @type {string} */ clipId, /** @type {any[]} */ ...args) => {
      const p = playerOf(clipId);
      if (!p || typeof p[name] !== 'function') return fallback;
      try { return p[name](...args); } catch { return fallback; }
    };

    return {
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
  }

  const api = { create, offsetFrames, plainRect };
  // checkJs: end
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.VpeEngineAdapter = api;
}(typeof self !== 'undefined' ? self : /** @type {any} */ (this)));
