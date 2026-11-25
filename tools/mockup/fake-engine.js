'use strict';
// Deterministic synthetic EngineAdapter for the reusable UI mockup harness (tools/mockup/render.js).
// Draws crisp, animated 2D canvas frames per clip with zero decoder/ffmpeg/WebCodecs dependencies.
(() => {
  // width/height are the natural picture size; hasAudio false on clip-2 so a no-audio clip is testable.
  const SAMPLE_CLIPS = [
    { id: 'clip-0', name: 'shot_01_graded.mp4', codec: 'H.264 4K', fps: 24, frames: 240, width: 3840, height: 2160, hasAudio: true, color: '#38bdf8', bg1: '#0f2942', bg2: '#1d4e89', accent: '#38bdf8' },
    { id: 'clip-1', name: 'shot_01_raw.mov', codec: 'ProRes 422', fps: 24, frames: 240, width: 1920, height: 1080, hasAudio: true, color: '#f59e0b', bg1: '#3b240c', bg2: '#7c3e0f', accent: '#fbbf24' },
    { id: 'clip-2', name: 'shot_02_denoise.mkv', codec: 'HEVC 10b', fps: 24, frames: 240, width: 1920, height: 800, hasAudio: false, color: '#a78bfa', bg1: '#241442', bg2: '#4c1d95', accent: '#c4b5fd' },
    { id: 'clip-3', name: 'shot_03_grade_b.mp4', codec: 'AV1 10b', fps: 24, frames: 240, width: 2560, height: 1440, hasAudio: true, color: '#34d399', bg1: '#0c2e26', bg2: '#065f46', accent: '#6ee7b7' },
    { id: 'clip-4', name: 'shot_04_proxy.webm', codec: 'VP8 1080p', fps: 24, frames: 240, width: 1080, height: 1920, hasAudio: true, color: '#fb7185', bg1: '#3b1020', bg2: '#881337', accent: '#fda4af' },
    { id: 'clip-5', name: 'shot_05_hdr.mkv', codec: 'HEVC HDR10', fps: 24, frames: 240, width: 3840, height: 2160, hasAudio: true, color: '#f97316', bg1: '#3a1a0a', bg2: '#9a3412', accent: '#fdba74' },
  ].map((c) => ({ ...c, duration: c.frames / c.fps }));

  function createFakeEngine(clips = SAMPLE_CLIPS) {
    const byId = new Map(clips.map((c, idx) => [c.id, { ...c, seed: idx }]));
    const clipOf = (/** @type {string} */ id) => byId.get(id) || byId.get(clips[0].id);
    // Caller-supplied clips may omit the newer metadata: fall back to a 1080p, 24 fps, 240-frame clip with sound.
    const fpsOf = (/** @type {any} */ c) => (c.fps > 0 ? c.fps : 24);
    const framesOf = (/** @type {any} */ c) => (c.frames > 0 ? c.frames : 240);
    const sizeOf = (/** @type {any} */ c) => ({ width: c.width > 0 ? c.width : 1920, height: c.height > 0 ? c.height : 1080 });
    /** What the contract tests read back: calls the page made that have no visible output in a fake. */
    const fake = { soundSource: /** @type {string | null} */ (null), volume: 1, muted: false, thumbnails: 0, thumbHover: false };
    /** @type {{ clipId: string, seconds: number, cb: any } | null} a scrub preview coalesced to the next microtask */
    let pendingThumb = null;
    let thumbGen = 0;

    const engine = {
      clips,
      fake,
      getClip(id) {
        return byId.get(id) || clips[0];
      },
      /**
       * Render a deterministic synthetic video frame onto a 2D canvas.
       * @param {HTMLCanvasElement} canvas
       * @param {string} clipId
       * @param {number} frame
       * @param {{ splitClipRatio?: number | null }} [opts]
       */
      draw(canvas, clipId, frame, opts = {}) {
        const clip = byId.get(clipId) || clips[0];
        const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
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
        if (typeof opts.splitClipRatio === 'number') {
          const sx = Math.round(w * opts.splitClipRatio);
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
       * Outside the clip there is no picture: { frame: null, outOfRange: true }.
       * @param {string} clipId @param {number} clockFrame
       * @param {number | { unit: 'frames' | 'ms', v: number } | null} [offset]
       */
      shownFrame(clipId, clockFrame, offset) {
        const c = clipOf(clipId);
        let off = 0;
        if (typeof offset === 'number') off = offset;
        else if (offset && typeof offset === 'object') {
          const v = Number(offset.v) || 0;
          off = offset.unit === 'ms' ? (v / 1000) * fpsOf(c) : v;
        }
        const f = Math.round(Number(clockFrame) || 0) + Math.round(off);
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
          else if (p.cb && typeof p.cb.getContext === 'function') engine.draw(p.cb, c.id, frame, {});
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
        const f = Math.max(0, Math.min(framesOf(c) - 1, Math.round(Number(frame) || 0)));
        return { clipId: c.id, frame: f, width, height, mimeType: 'image/png', data: pngHeader(width, height) };
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
    return engine;
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
