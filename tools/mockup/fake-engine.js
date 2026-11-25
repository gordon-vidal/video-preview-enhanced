'use strict';
// Deterministic synthetic EngineAdapter for the reusable UI mockup harness (tools/mockup/render.js).
// Draws crisp, animated 2D canvas frames per clip with zero decoder/ffmpeg/WebCodecs dependencies.
(() => {
  const SAMPLE_CLIPS = [
    { id: 'clip-0', name: 'shot_01_graded.mp4', codec: 'H.264 4K', fps: 24, frames: 240, color: '#38bdf8', bg1: '#0f2942', bg2: '#1d4e89', accent: '#38bdf8' },
    { id: 'clip-1', name: 'shot_01_raw.mov', codec: 'ProRes 422', fps: 24, frames: 240, color: '#f59e0b', bg1: '#3b240c', bg2: '#7c3e0f', accent: '#fbbf24' },
    { id: 'clip-2', name: 'shot_02_denoise.mkv', codec: 'HEVC 10b', fps: 24, frames: 240, color: '#a78bfa', bg1: '#241442', bg2: '#4c1d95', accent: '#c4b5fd' },
    { id: 'clip-3', name: 'shot_03_grade_b.mp4', codec: 'AV1 10b', fps: 24, frames: 240, color: '#34d399', bg1: '#0c2e26', bg2: '#065f46', accent: '#6ee7b7' },
    { id: 'clip-4', name: 'shot_04_proxy.webm', codec: 'VP8 1080p', fps: 24, frames: 240, color: '#fb7185', bg1: '#3b1020', bg2: '#881337', accent: '#fda4af' },
    { id: 'clip-5', name: 'shot_05_hdr.mkv', codec: 'HEVC HDR10', fps: 24, frames: 240, color: '#f97316', bg1: '#3a1a0a', bg2: '#9a3412', accent: '#fdba74' },
  ];

  function createFakeEngine(clips = SAMPLE_CLIPS) {
    const byId = new Map(clips.map((c, idx) => [c.id, { ...c, seed: idx }]));
    return {
      clips,
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
    };
  }

  const api = { SAMPLE_CLIPS, createFakeEngine };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else globalThis.VpeFakeEngine = api;
})();
