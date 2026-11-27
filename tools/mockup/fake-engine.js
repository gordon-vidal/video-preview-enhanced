'use strict';
// Deterministic synthetic EngineAdapter for the reusable UI mockup harness (tools/mockup/render.js).
// Draws crisp, animated 2D canvas frames per clip with zero decoder/ffmpeg/WebCodecs dependencies.
// It implements the EngineAdapter contract of media/unified-contracts.d.ts (tools/unified-contracts-check.js).
(() => {
  /** @typedef {import('../../media/unified-contracts').EngineAdapter} EngineAdapter */
  // width/height are the natural picture size; hasAudio false on clip-2 so a no-audio clip is testable.
  const SAMPLE_CLIPS = [
    { id: 'clip-0', name: 'shot_01_graded.mp4', codec: 'H.264 4K', fps: 24, frames: 240, width: 3840, height: 2160, hasAudio: true, color: '#38bdf8', bg1: '#0f2942', bg2: '#1d4e89', accent: '#38bdf8' },
    { id: 'clip-1', name: 'shot_01_raw.mov', codec: 'ProRes 422', fps: 24, frames: 240, width: 1920, height: 1080, hasAudio: true, color: '#f59e0b', bg1: '#3b240c', bg2: '#7c3e0f', accent: '#fbbf24' },
    { id: 'clip-2', name: 'shot_02_denoise.mkv', codec: 'HEVC 10b', fps: 24, frames: 240, width: 1920, height: 800, hasAudio: false, color: '#a78bfa', bg1: '#241442', bg2: '#4c1d95', accent: '#c4b5fd' },
    { id: 'clip-3', name: 'shot_03_grade_b.mp4', codec: 'AV1 10b', fps: 24, frames: 240, width: 2560, height: 1440, hasAudio: true, color: '#34d399', bg1: '#0c2e26', bg2: '#065f46', accent: '#6ee7b7' },
    { id: 'clip-4', name: 'shot_04_proxy.webm', codec: 'VP8 1080p', fps: 24, frames: 240, width: 1080, height: 1920, hasAudio: true, color: '#fb7185', bg1: '#3b1020', bg2: '#881337', accent: '#fda4af' },
    { id: 'clip-5', name: 'shot_05_hdr.mkv', codec: 'HEVC HDR10', fps: 24, frames: 240, width: 3840, height: 2160, hasAudio: true, color: '#f97316', bg1: '#3a1a0a', bg2: '#9a3412', accent: '#fdba74' },
  ].map((c) => ({ ...c, duration: c.frames / c.fps }));

  function createFakeEngine(/** @type {any[]} */ initialClips = SAMPLE_CLIPS) {
    // A copy: registerClip / unregisterClip change this engine's list, never the caller's (or SAMPLE_CLIPS).
    const clips = initialClips.slice();
    const first = clips[0];
    let nextSeed = clips.length;
    const byId = new Map(clips.map((c, idx) => [c.id, { ...c, seed: idx }]));
    const clipOf = (/** @type {string} */ id) => byId.get(id) || byId.get(clips.length ? clips[0].id : first.id) || { ...first, seed: 0 };
    // Caller-supplied clips may omit the newer metadata: fall back to a 1080p, 24 fps, 240-frame clip with sound.
    const fpsOf = (/** @type {any} */ c) => (c.fps > 0 ? c.fps : 24);
    const framesOf = (/** @type {any} */ c) => (c.frames > 0 ? c.frames : 240);
    const sizeOf = (/** @type {any} */ c) => ({ width: c.width > 0 ? c.width : 1920, height: c.height > 0 ? c.height : 1080 });
    /** What the contract tests read back: calls the page made that have no visible output in a fake. */
    const fake = {
      soundSource: /** @type {string | null} */ (null), volume: 1, muted: false, thumbnails: 0, thumbHover: false,
      /** @type {Record<string, number>} the frame each clip last showed through showFrame */
      shown: /** @type {Record<string, number>} */ ({}),
      /**
       * Simulated seek latency (tools/mockup/render.js): until `until` (performance.now() ms) each clip keeps
       * drawing the frame it showed before the seek, as a real decoder keeps its last picture until the new one lands.
       * Call it right after the render that asked for the new frame. @param {string[]} clipIds @param {number} until
       */
      hold(clipIds, until) {
        const t = clock();
        for (const id of clipIds) {
          const h = holds.get(id);
          if (h && t < h.until) { h.until = Math.max(h.until, until); continue; }
          const d = drawn.get(id);
          if (!d) continue;
          // The render just before this call drew the new frame: the one to keep is the one before it.
          holds.set(id, { frame: t - d.changedAt < 50 ? d.prev : d.cur, until });
        }
      },
      /** The frame a held clip keeps showing, or null when it is not held. @param {string} clipId */
      held(clipId) {
        const h = holds.get(clipId);
        return h && clock() < h.until ? h.frame : null;
      },
      /** End every hold now (the next draw shows the frame asked for). */
      release() { holds.clear(); },
    };
    const clock = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
    /** @type {Map<string, { frame: number, until: number }>} clips whose new frame has not "landed" yet */
    const holds = new Map();
    /** @type {Map<string, { cur: number, prev: number, changedAt: number }>} the last frames each clip drew */
    const drawn = new Map();
    /** The frame to paint for `frame` asked of `clipId`: the held one while a hold lasts. */
    function heldFrame(/** @type {string} */ clipId, /** @type {number} */ frame) {
      const h = holds.get(clipId);
      if (h && clock() < h.until) return h.frame;
      if (h) holds.delete(clipId);
      const d = drawn.get(clipId);
      if (!d) drawn.set(clipId, { cur: frame, prev: frame, changedAt: clock() });
      else if (d.cur !== frame) { d.prev = d.cur; d.cur = frame; d.changedAt = clock(); }
      return frame;
    }
    /** @type {{ clipId: string, seconds: number, cb: any } | null} a scrub preview coalesced to the next microtask */
    let pendingThumb = null;
    let thumbGen = 0;

    /**
     * Paint frame `frame` of `clip`; the canvas gets the CSS size (opts.width/height, else its own) times `dpr`.
     * @param {HTMLCanvasElement} canvas @param {any} clip @param {number} frame
     * @param {{ width?: number, height?: number, splitClipRatio?: number | null, splitClipX?: number | null }} opts @param {number} dpr
     */
    function paintFrame(canvas, clip, frame, opts, dpr) {
      const cssW = Number(opts.width) > 0 ? Number(opts.width) : (canvas.clientWidth || 320);
      const cssH = Number(opts.height) > 0 ? Number(opts.height) : (canvas.clientHeight || 180);
      const w = Math.max(1, Math.round(cssW * dpr));
      const h = Math.max(1, Math.round(cssH * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.save();
      if (typeof opts.splitClipX === 'number' || typeof opts.splitClipRatio === 'number') {
        const sx = typeof opts.splitClipX === 'number'
          ? Math.max(0, Math.min(w, Math.round(opts.splitClipX * dpr)))
          : Math.round(w * /** @type {number} */ (opts.splitClipRatio));
        ctx.clearRect(0, 0, w, h);
        ctx.beginPath();
        ctx.rect(sx, 0, w - sx, h);
        ctx.clip();
      }
      const grad = ctx.createLinearGradient(0, 0, w, h);
      grad.addColorStop(0, clip.bg1);
      grad.addColorStop(1, clip.bg2);
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, w, h);

      const t = frame / (clip.fps || 24);
      ctx.strokeStyle = clip.accent;
      ctx.globalAlpha = 0.25;
      ctx.lineWidth = Math.max(1.5, 2 * dpr);
      ctx.beginPath();
      const step = Math.max(8, w / 40);
      for (let x = 0; x <= w; x += step) {
        const y = h * 0.52 + Math.sin(x * 0.015 + t * 2.4 + clip.seed * 1.4) * (h * 0.14);
        if (x === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();

      const ox = ((frame * 3.2 + clip.seed * 70) % (w + 60)) - 30;
      const oy = h * 0.52 + Math.sin(ox * 0.015 + t * 2.4 + clip.seed * 1.4) * (h * 0.14);
      ctx.globalAlpha = 0.85;
      ctx.fillStyle = clip.accent;
      ctx.beginPath();
      ctx.arc(ox, oy, Math.max(4, Math.min(9, w * 0.018)), 0, Math.PI * 2);
      ctx.fill();

      ctx.globalAlpha = 0.78;
      ctx.fillStyle = '#fff';
      ctx.font = `600 ${Math.max(11, Math.min(16, Math.round(w * 0.032)))}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(clip.name, w / 2, h / 2 - 8 * dpr);
      ctx.globalAlpha = 0.52;
      ctx.font = `${Math.max(9, Math.min(12, Math.round(w * 0.022)))}px ui-monospace, monospace`;
      ctx.fillText(`${clip.codec}  ·  frame #${frame}`, w / 2, h / 2 + 12 * dpr);
      ctx.restore();
    }

    const engine = {
      clips,
      fake,
      getClip(id) {
        return byId.get(id) || clips[0];
      },
      /** A clip opened after boot (or a known one updated). Returns it, or null without an id. @param {any} clip */
      registerClip(clip) {
        if (!clip || typeof clip.id !== 'string' || !clip.id) return null;
        const known = byId.get(clip.id);
        const i = clips.findIndex((c) => c.id === clip.id);
        if (i >= 0) clips[i] = clip;
        else clips.push(clip);
        const base = SAMPLE_CLIPS[(known ? known.seed : nextSeed) % SAMPLE_CLIPS.length];
        // Colours come from a sample clip so a new tile still draws; the caller's fields win.
        byId.set(clip.id, { ...base, ...clip, seed: known ? known.seed : nextSeed++ });
        return clip;
      },
      /** Forget a closed clip; true when it was known. @param {string} clipId */
      unregisterClip(clipId) {
        if (!byId.has(clipId)) return false;
        byId.delete(clipId);
        const i = clips.findIndex((c) => c.id === clipId);
        if (i >= 0) clips.splice(i, 1);
        if (fake.soundSource === clipId) fake.soundSource = null;
        delete fake.shown[clipId];
        return true;
      },
      /**
       * Render a deterministic synthetic video frame onto a 2D canvas. While a simulated seek latency holds the clip
       * (fake.hold), the frame it showed before stays, as a real decoder keeps its last picture until the new one lands.
       * @param {HTMLCanvasElement} canvas
       * @param {string} clipId
       * @param {number} frame
       * @param {{ splitClipRatio?: number | null }} [opts]
       */
      draw(canvas, clipId, frame, opts = {}) {
        const clip = byId.get(clipId) || clips[0];
        const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
        paintFrame(canvas, clip, heldFrame(clip.id, frame), opts, dpr);
      },

      // ---- metadata ----
      /** @param {string} clipId */
      naturalSize(clipId) { return sizeOf(clipOf(clipId)); },
      /** @param {string} clipId */
      hasAudio(clipId) { return clipOf(clipId).hasAudio !== false; },
      /** "About this video" facts, same shape as the fallback in media/player-ui.js (title, sub, rows). */
      facts(/** @type {string} */ clipId) {
        const c = clipOf(clipId);
        const { width, height } = sizeOf(c);
        const fps = fpsOf(c);
        const frames = framesOf(c);
        const video = [c.codec, `${width}×${height}`, `${fps} fps`].filter(Boolean);
        return {
          id: c.id, title: c.name, sub: video.join(' · '),
          width, height, fps, frames, duration: frames / fps, hasAudio: c.hasAudio !== false, codec: c.codec || '',
          rows: [
            ['Video', video.join(', ')],
            ['Duration', `${(frames / fps).toFixed(3)} s (${frames} frames)`],
            ['Audio', c.hasAudio !== false ? 'Yes' : 'None'],
          ],
        };
      },

      // ---- timing ----
      /**
       * The frame a tile shows at the shared clock frame, given its sync offset (frames, or { unit, v }).
       * Outside the clip there is no picture: { frame: null, outOfRange: true }. A clock at another rate
       * (`clockFps`) is mapped through time into the clip's frames before the offset is added.
       * @param {string} clipId @param {number} clockFrame
       * @param {number | { unit: 'frames' | 'ms', v: number } | null} [offset] @param {number} [clockFps]
       */
      shownFrame(clipId, clockFrame, offset, clockFps) {
        const c = clipOf(clipId);
        const fps = fpsOf(c);
        const cf = Number(clockFps);
        const mixed = Number.isFinite(cf) && cf > 0 && Math.abs(cf - fps) >= 1e-9;
        const base = mixed ? Math.round(((Number(clockFrame) || 0) / cf) * fps) : Math.round(Number(clockFrame) || 0);
        let off = 0;
        if (typeof offset === 'number') off = offset;
        else if (offset && typeof offset === 'object') {
          const v = Number(offset.v) || 0;
          off = offset.unit === 'ms' ? (v / 1000) * fps : v;
        }
        const f = base + Math.round(off);
        if (f < 0 || f >= framesOf(c)) return { frame: null, outOfRange: true };
        return { frame: f, outOfRange: false };
      },

      // ---- geometry ----
      /**
       * The picture's rect inside a cell, in cell pixels: 'fit' letterboxes, 'fill' covers (may overflow the cell),
       * 'stretch' takes the cell, 'actual' is 1:1 natural pixels; zoom scales about the centre, pan shifts in px.
       * @param {string} clipId @param {number} cellW @param {number} cellH
       * @param {string} [picMode] @param {number} [zoom] @param {number} [panX] @param {number} [panY]
       */
      pictureRect(clipId, cellW, cellH, picMode = 'fit', zoom = 1, panX = 0, panY = 0) {
        const { width, height } = sizeOf(clipOf(clipId));
        const cw = Math.max(0, Number(cellW) || 0);
        const ch = Math.max(0, Number(cellH) || 0);
        let w;
        let h;
        if (picMode === 'stretch') { w = cw; h = ch; }
        else if (picMode === 'actual') { w = width; h = height; }
        else {
          const s = picMode === 'fill' ? Math.max(cw / width, ch / height) : Math.min(cw / width, ch / height);
          w = width * s;
          h = height * s;
        }
        const z = Number(zoom) > 0 ? Number(zoom) : 1;
        w *= z;
        h *= z;
        return { x: (cw - w) / 2 + (Number(panX) || 0), y: (ch - h) / 2 + (Number(panY) || 0), w, h };
      },

      // ---- seek-bar hover preview ----
      /**
       * Preview of the frame at `seconds`. `cb` is a function (gets { clipId, seconds, frame, width, height }) or a
       * canvas (drawn into). A scrub (`scrubbing`) is coalesced to one microtask, so thumbnailLeave() can still
       * cancel it; otherwise the preview is delivered at once. No timers: nothing keeps Node alive.
       * @param {string} clipId @param {number} seconds @param {any} cb @param {boolean} [scrubbing]
       */
      thumbnail(clipId, seconds, cb, scrubbing) {
        fake.thumbHover = true;
        const deliver = (/** @type {{ clipId: string, seconds: number, cb: any }} */ p) => {
          const c = clipOf(p.clipId);
          const fps = fpsOf(c);
          const frame = Math.max(0, Math.min(framesOf(c) - 1, Math.round((Number(p.seconds) || 0) * fps)));
          fake.thumbnails++;
          if (typeof p.cb === 'function') p.cb({ clipId: c.id, seconds: frame / fps, frame, ...sizeOf(c) });
          else if (p.cb && typeof p.cb.getContext === 'function') {
            // Like media/thumbs.js: a picture fitted in 160 x 120 at one canvas pixel per CSS pixel, so the canvas'
            // own size is its layout size (sizing it from clientWidth x dpr grew it on every hover on HiDPI).
            const { width, height } = sizeOf(c);
            const s = Math.min(160 / width, 120 / height);
            paintFrame(p.cb, c, frame, { width: Math.round(width * s), height: Math.round(height * s) }, 1);
          }
        };
        if (!scrubbing) { pendingThumb = null; deliver({ clipId, seconds, cb }); return; }
        const first = !pendingThumb;
        pendingThumb = { clipId, seconds, cb };
        if (!first) return;
        const gen = thumbGen;
        Promise.resolve().then(() => {
          const p = pendingThumb;
          pendingThumb = null;
          if (p && gen === thumbGen) deliver(p);
        });
      },
      /** The pointer left the seek bar: drop any pending preview. @param {boolean} [_immediate] */
      thumbnailLeave(_immediate) {
        thumbGen++;
        pendingThumb = null;
        fake.thumbHover = false;
      },

      // ---- capture ----
      /**
       * A still of a frame at natural size. The bytes are a well-formed PNG header (signature, IHDR and IEND with
       * real CRCs) but carry no pixel data: a full 4K frame would be ~25 MB of zeros for no test value.
       * @param {string} clipId @param {number} [frame]
       */
      snapshot(clipId, frame) {
        const c = clipOf(clipId);
        const { width, height } = sizeOf(c);
        const asked = frame === undefined || frame === null ? fake.shown[c.id] || 0 : frame;
        const f = Math.max(0, Math.min(framesOf(c) - 1, Math.round(Number(asked) || 0)));
        return { clipId: c.id, frame: f, width, height, mimeType: 'image/png', data: pngHeader(width, height) };
      },
      /**
       * Show `frame` paused; resolves (next microtask, like a presented picture) with the frame shown, or null for
       * an unknown clip or an aborted signal. @param {string} clipId @param {number} frame
       * @param {{ signal?: AbortSignal | null }} [opts] @returns {Promise<number | null>}
       */
      async showFrame(clipId, frame, opts = {}) {
        const signal = opts && opts.signal;
        const c = byId.get(clipId);
        if (!c || (signal && signal.aborted)) return null;
        await Promise.resolve();
        if (signal && signal.aborted) return null;
        const f = Math.max(0, Math.min(framesOf(c) - 1, Math.round(Number(frame) || 0)));
        fake.shown[c.id] = f;
        return f;
      },
      /**
       * The pixel at picture point (x, y): a deterministic colour per clip and place, as { r, g, b, a, text }.
       * Outside the picture there is none (null). @param {string} clipId @param {number} x @param {number} y
       */
      pixelAt(clipId, x, y) {
        const c = byId.get(clipId);
        if (!c) return null;
        const { width, height } = sizeOf(c);
        const px = Math.floor(Number(x));
        const py = Math.floor(Number(y));
        if (!(px >= 0 && py >= 0 && px < width && py < height)) return null;
        const r = (px * 7 + c.seed * 40) & 255;
        const g = (py * 5 + c.seed * 90) & 255;
        const b = ((fake.shown[c.id] || 0) * 3 + c.seed * 60) & 255;
        const hex = [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
        return { r, g, b, a: 255, text: `x=${px} y=${py} rgb=(${r},${g},${b}) #${hex}` };
      },

      // ---- sound ----
      /** Which tile's audio plays (null = none). @param {string | null} clipId */
      setSoundSource(clipId) { fake.soundSource = clipId && byId.has(clipId) ? clipId : null; },
      /** @param {number} volume 0..1 @param {boolean} muted */
      setVolume(volume, muted) {
        fake.volume = Math.max(0, Math.min(1, Number(volume) || 0));
        fake.muted = !!muted;
      },
    };
    return /** @satisfies {EngineAdapter} */ (engine);
  }

  /** @type {number[] | null} */
  let crcTable = null;
  /** @param {Uint8Array} bytes */
  function crc32(bytes) {
    if (!crcTable) {
      crcTable = [];
      for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        crcTable.push(c >>> 0);
      }
    }
    let crc = 0xffffffff;
    for (const b of bytes) crc = crcTable[(crc ^ b) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }
  /** @param {number} width @param {number} height */
  function pngHeader(width, height) {
    const out = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    const u32 = (/** @type {number} */ v) => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
    const chunk = (/** @type {string} */ type, /** @type {number[]} */ body) => {
      const td = new Uint8Array([...type].map((ch) => ch.charCodeAt(0)).concat(body));
      out.push(...u32(body.length), ...td, ...u32(crc32(td)));
    };
    chunk('IHDR', [...u32(width), ...u32(height), 8, 2, 0, 0, 0]); // 8-bit RGB, no interlace
    chunk('IEND', []);
    return new Uint8Array(out);
  }

  const api = { SAMPLE_CLIPS, createFakeEngine };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else globalThis.VpeFakeEngine = api;
})();
