// @ts-check
// Picture size (docs/notes/ui-simple.md "Picture size"): how the picture sits in its area, as pure maths the
// player (media/inspect.js) and compare (media/compare.js) share and test/host/picture_test.js tests.
//
// A view is { mode, zoom, cx, cy }:
//   mode  fit | fill | stretch | actual (the base size of the picture, below)
//   zoom  1 = the mode's own size; Ctrl+wheel multiplies it
//   cx,cy the picture point (0..1 of its width / height) at the middle of the area; 0.5 = centred.
// Keeping the pan as a point of the picture, not pixels, is what lets compare apply one view to every tile
// ("a magnifier over all videos"): each tile shows the same part of its own picture.
'use strict';
(function (root) {
  const MODES = ['fit', 'fill', 'stretch', 'actual'];
  const NAMES = { fit: 'Fit', fill: 'Fill', stretch: 'Stretch', actual: '100%' };
  const WORDS = {
    fit: 'whole picture visible, bars where the shape differs',
    fill: 'no bars, the edges are cropped',
    stretch: 'fills the area, the picture is distorted',
    actual: 'one video pixel is one screen pixel; drag to move',
  };
  /** The few words next to a mode in the panel. */
  const SHORT = { fit: 'whole picture', fill: 'no bars, cropped', stretch: 'distorted', actual: 'pixel for pixel' };
  const ABS_MAX = 64; // device pixels per video pixel at most
  const ACTUAL_MIN = 1 / 16; // zoomed out below 100 %: a sixteenth of the video's size
  const STEP = 1.25; // one zoom key press

  const isMode = (m) => MODES.includes(m);
  const parse = (m) => (isMode(m) ? m : 'fit');
  const next = (m) => MODES[(MODES.indexOf(parse(m)) + 1) % MODES.length];
  const name = (m) => NAMES[parse(m)];
  const fresh = (mode = 'fit') => ({ mode: parse(mode), zoom: 1, cx: 0.5, cy: 0.5 });
  /** True when the picture sits at its mode's own size, centred. */
  const plain = (v) => v.zoom === 1 && v.cx === 0.5 && v.cy === 0.5;

  /**
   * The mode's picture size in CSS px at zoom 1.
   * @param {string} mode
   * @param {{w:number,h:number}} nat the picture's drawn size (its canvas): the shape, and the size Fit never exceeds unless `enlarge`
   * @param {{w:number,h:number}} src the video's own size (100 % shows this many device pixels)
   * @param {{w:number,h:number}} view the area
   * @param {{enlarge?:boolean, dpr?:number}} [o] enlarge: Fit may scale a small picture up (compare); dpr: device pixels per CSS pixel
   */
  function baseSize(mode, nat, src, view, o = {}) {
    const dpr = o.dpr || 1;
    if (!(nat.w > 0 && nat.h > 0 && view.w > 0 && view.h > 0)) return { w: 0, h: 0 };
    if (mode === 'stretch') return { w: view.w, h: view.h };
    if (mode === 'fill') {
      const s = Math.max(view.w / nat.w, view.h / nat.h);
      return { w: nat.w * s, h: nat.h * s };
    }
    if (mode === 'actual') {
      const s = src.w > 0 && src.h > 0 ? src.w / nat.w : 1; // the source's width: the canvas may hold a smaller native frame
      return { w: (nat.w * s) / dpr, h: (nat.h * s) / dpr };
    }
    const s = Math.min(view.w / nat.w, view.h / nat.h, o.enlarge ? Infinity : 1);
    return { w: nat.w * s, h: nat.h * s };
  }

  /** Smallest and largest zoom for a mode (the picture never goes below its mode's size, except 100 %: a sixteenth). */
  function limits(mode, base, src, o = {}) {
    const dpr = o.dpr || 1;
    const max = base.w > 0 && src.w > 0 ? Math.max(1, (ABS_MAX * src.w) / dpr / base.w) : ABS_MAX;
    return { min: mode === 'actual' ? ACTUAL_MIN : 1, max };
  }

  /** The pan that keeps a picture of size `size` covering its area: centred when it fits, else the middle point within bounds. */
  function clampAxis(c, size, area) {
    if (!(size > area)) return 0.5;
    const half = area / (2 * size);
    return Math.max(half, Math.min(1 - half, c));
  }

  /**
   * The picture's rectangle in the area's own coordinates (CSS px) for a view.
   * @returns {{x:number,y:number,w:number,h:number}}
   */
  function rectOf(v, nat, src, view, o = {}) {
    const b = baseSize(v.mode, nat, src, view, o);
    const w = b.w * v.zoom;
    const h = b.h * v.zoom;
    const cx = clampAxis(v.cx, w, view.w);
    const cy = clampAxis(v.cy, h, view.h);
    return { x: view.w / 2 - cx * w, y: view.h / 2 - cy * h, w, h };
  }

  /** The view with its pan and zoom kept within bounds (a resize can leave them outside). */
  function clamp(v, nat, src, view, o = {}) {
    const b = baseSize(v.mode, nat, src, view, o);
    if (!b.w) return { ...v };
    const lim = limits(v.mode, b, src, o);
    const zoom = Math.max(lim.min, Math.min(lim.max, v.zoom));
    return { mode: v.mode, zoom, cx: clampAxis(v.cx, b.w * zoom, view.w), cy: clampAxis(v.cy, b.h * zoom, view.h) };
  }

  /** Zoom to `zoom` keeping the picture point under (px, py) of the area where it is. Out-of-range zoom is clamped. */
  function zoomAt(v, zoom, px, py, nat, src, view, o = {}) {
    const b = baseSize(v.mode, nat, src, view, o);
    if (!b.w) return { ...v };
    const r = rectOf(v, nat, src, view, o);
    const lim = limits(v.mode, b, src, o);
    const z = Math.max(lim.min, Math.min(lim.max, zoom));
    const w = b.w * z;
    const h = b.h * z;
    const u = r.w > 0 ? (px - r.x) / r.w : 0.5;
    const t = r.h > 0 ? (py - r.y) / r.h : 0.5;
    return { mode: v.mode, zoom: z, cx: clampAxis((view.w / 2 - px) / w + u, w, view.w), cy: clampAxis((view.h / 2 - py) / h + t, h, view.h) };
  }

  /** Drag the picture by (dx, dy) CSS px. */
  function panBy(v, dx, dy, nat, src, view, o = {}) {
    const r = rectOf(v, nat, src, view, o);
    if (!(r.w > 0 && r.h > 0)) return { ...v };
    return { ...v, cx: clampAxis(v.cx - dx / r.w, r.w, view.w), cy: clampAxis(v.cy - dy / r.h, r.h, view.h) };
  }

  /**
   * What Z does: zoomed in (Ctrl+wheel, keys) it goes back to Fit, as Z always did; otherwise the next mode.
   * Any change of mode starts at its own size, centred.
   */
  function cycle(v) {
    if (v.zoom !== 1 || v.cx !== 0.5 || v.cy !== 0.5) return fresh('fit');
    return fresh(next(v.mode));
  }

  /** Percent of the video's pixels per screen pixel the picture shows now (what the zoom toast says). */
  function percent(rect, src, dpr = 1) {
    return src.w > 0 ? Math.round(((rect.w * dpr) / src.w) * 100) : 100;
  }

  /**
   * The picture size native frames should have (CSS px, the video's own shape), or null while the plain Fit
   * (the area decides). Stretch and a crop need the size that covers the whole rectangle at the video's shape.
   */
  function frameNeed(v, rect, nat) {
    if (v.mode === 'fit' && plain(v)) return null;
    if (!(rect.w > 0 && rect.h > 0 && nat.w > 0 && nat.h > 0)) return null;
    const a = nat.w / nat.h;
    return rect.w / rect.h > a ? { w: rect.w, h: rect.w / a } : { w: rect.h * a, h: rect.h };
  }

  /**
   * The source size from what the page knows: the file's width / height (the picture may be turned by 90°: then the
   * canvas is the other way round), else the canvas.
   */
  function sourceSize(canvas, meta) {
    const cw = canvas.w, ch = canvas.h;
    if (!(meta && meta.w > 0 && meta.h > 0)) return { w: cw, h: ch };
    const turned = Math.abs(meta.w / meta.h - cw / ch) > Math.abs(meta.h / meta.w - cw / ch);
    return turned ? { w: meta.h, h: meta.w } : { w: meta.w, h: meta.h };
  }

  const api = { MODES, NAMES, WORDS, SHORT, STEP, parse, isMode, next, name, fresh, plain, baseSize, limits, rectOf, clamp, zoomAt, panBy, cycle, percent, frameNeed, sourceSize };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.VpePicture = api;
}(typeof self !== 'undefined' ? self : this));
