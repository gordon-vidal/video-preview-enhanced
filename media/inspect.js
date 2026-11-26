// @ts-check
// Developer inspection for the player: zoom and pan, pixel inspector with loupe,
// go to frame/time, frame links and the stats overlay. Loaded before player.js,
// which creates one inspector and forwards keys, wheel and ticks to it.
// The pure helpers at the top are also loaded by the Node tests (test/inspect).
'use strict';

/* exported VpeInspect */
// eslint-disable-next-line no-unused-vars
const VpeInspect = (() => {
  const Pic = typeof VpePicture !== 'undefined' ? VpePicture : require('./picture');
  const NEAREST_AT = 2; // nearest-neighbour from 200 %
  const GRID_AT = 8; // pixel grid from 800 %
  const LOUPE_PX = 15; // loupe source size (odd: the centre pixel is the cursor)
  const LOUPE_SCALE = 8;

  /**
   * Parses the go-to box: a frame number as shown in the player ("1432", 1 = first),
   * a time ("1:23.456", "83.5s", "1:02:03"), a percentage ("50%") or a relative
   * frame step ("+10", "-3"). Returns null when it is none of these.
   * @param {string} text
   * @returns {{frame: number} | {time: number} | {fraction: number} | {delta: number} | null}
   */
  function parseGoto(text) {
    const s = String(text || '').trim().replace(/^#/, '');
    let m;
    if ((m = /^([+-])\s*(\d+)$/.exec(s))) return { delta: (m[1] === '-' ? -1 : 1) * Number(m[2]) };
    if (/^\d+$/.test(s)) return { frame: Number(s) };
    if ((m = /^(\d+(?:\.\d*)?|\.\d+)\s*%$/.exec(s))) return { fraction: Math.min(1, Number(m[1]) / 100) };
    if ((m = /^(\d+(?:\.\d*)?|\.\d+)\s*s$/i.exec(s))) return { time: Number(m[1]) };
    if ((m = /^(?:(\d+):)?(\d+):(\d+(?:\.\d*)?)$/.exec(s))) {
      return { time: Number(m[1] || 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) };
    }
    if ((m = /^(\d*\.\d+)$/.exec(s))) return { time: Number(m[1]) };
    return null;
  }

  /**
   * Turns a parsed go-to into a 0-based frame or a time, given the clip.
   * @returns {{frame?: number, time?: number}}
   */
  function resolveGoto(g, cur, n, duration) {
    if (!g) return {};
    if ('delta' in g) return { frame: Math.max(0, Math.min(Math.max(0, n - 1), cur + g.delta)) };
    if ('frame' in g) return { frame: Math.max(0, Math.min(Math.max(0, n - 1), g.frame - 1)) };
    if ('fraction' in g) return { time: g.fraction * (duration || 0) };
    return { time: Math.max(0, duration ? Math.min(g.time, duration) : g.time) };
  }

  /** `#t=12.3`, `#frame=42`, `t=1:02.5` (link fragments and URI queries). */
  function parseFragment(frag) {
    const out = {};
    for (const part of String(frag || '').replace(/^#/, '').split('&')) {
      const [k, v] = part.split('=');
      if (!v) continue;
      if (k === 'frame' && /^\d+$/.test(v)) out.frame = Number(v);
      if (k === 't') {
        let text = v;
        try { text = decodeURIComponent(v); } catch { /* a stray % (t=50%): use the raw text */ }
        const g = parseGoto(/^\d+(\.\d+)?$/.test(v) ? `${v}s` : text);
        if (g && 'time' in g) out.t = g.time;
      }
    }
    return out;
  }

  /** Keeps a zoomed picture of size w×h (CSS px) inside a view of vw×vh: centred when smaller, edges never inside the view. */
  function clampPan(tx, ty, w, h, vw, vh) {
    const ax = w <= vw ? (vw - w) / 2 : Math.max(vw - w, Math.min(0, tx));
    const ay = h <= vh ? (vh - h) / 2 : Math.max(vh - h, Math.min(0, ty));
    return [ax, ay];
  }

  /** New pan offset so that the picture point under (px, py) stays there when the scale goes from s0 to s1. */
  function zoomAround(s0, tx, ty, s1, px, py) {
    return [px - ((px - tx) / s0) * s1, py - ((py - ty) / s0) * s1];
  }

  /**
   * Source pixel for a displayed pixel, undoing the renderer's rotation
   * (the same mapping as the vertex shader in GLRenderer).
   */
  function displayToSource(x, y, dw, dh, rot, sw, sh) {
    const dx = (x + 0.5) / dw;
    const dy = (y + 0.5) / dh;
    const [u, v] = rot === 90 ? [dy, 1 - dx] : rot === 180 ? [1 - dx, 1 - dy] : rot === 270 ? [1 - dy, dx] : [dx, dy];
    return [Math.min(sw - 1, Math.floor(u * sw)), Math.min(sh - 1, Math.floor(v * sh))];
  }

  /**
   * Y, U, V code values at a source pixel of a planar frame from the soft decoder
   * ({width, height, data, layout[3], depth, cw, ch}, as GLRenderer.drawYuv takes it).
   * Null when the frame data is gone (transferred back to a worker).
   */
  function yuvAt(f, x, y) {
    if (!f || !f.data || !f.data.byteLength || !f.layout) return null;
    const deep = (f.depth || 8) > 8;
    const cw = f.cw === undefined ? 1 : f.cw;
    const ch = f.ch === undefined ? 1 : f.ch;
    const at = (i, px, py) => {
      const l = f.layout[i];
      if (deep) {
        const o = f.data.byteOffset + l.offset + py * l.stride + px * 2;
        if (o + 2 > f.data.byteOffset + f.data.byteLength) return NaN;
        return new DataView(f.data.buffer).getUint16(o, true);
      }
      const o = l.offset + py * l.stride + px;
      return o < f.data.length ? f.data[o] : NaN;
    };
    const v = [at(0, x, y), at(1, x >> cw, y >> ch), at(2, x >> cw, y >> ch)];
    return v.some(Number.isNaN) ? null : { y: v[0], u: v[1], v: v[2], depth: f.depth || 8 };
  }

  /** Pixel format name of a soft frame, e.g. yuv420p, yuv422p10. */
  function softFormat(f) {
    if (!f) return '';
    const cw = f.cw === undefined ? 1 : f.cw;
    const ch = f.ch === undefined ? 1 : f.ch;
    const sub = cw && ch ? '420' : cw ? '422' : '444';
    return `yuv${sub}p${(f.depth || 8) > 8 ? f.depth : ''}${f.fullRange ? ' full' : ''}`;
  }

  /** Y/U/V from a VideoFrame.copyTo of a 2×2 (chroma aligned) rect; dx, dy is the pixel inside it. */
  function vfSample(format, buf, layouts, dx, dy) {
    const fmt = String(format || '');
    const wide = /P1[02]|P16/.test(fmt);
    const rd = (o) => (wide ? buf[o] | (buf[o + 1] << 8) : buf[o]);
    const bps = wide ? 2 : 1;
    const l = layouts;
    const y = rd(l[0].offset + dy * l[0].stride + dx * bps);
    if (/^NV12/.test(fmt)) return { y, u: rd(l[1].offset), v: rd(l[1].offset + bps), depth: wide ? 10 : 8 };
    let cx = 0;
    let cy = 0;
    if (/^I444/.test(fmt)) { cx = dx; cy = dy; } else if (/^I422/.test(fmt)) cy = dy;
    if (!/^I4[24][024]/.test(fmt) || l.length < 3) return null;
    const depth = /P10/.test(fmt) ? 10 : /P12/.test(fmt) ? 12 : 8;
    return { y, u: rd(l[1].offset + cy * l[1].stride + cx * bps), v: rd(l[2].offset + cy * l[2].stride + cx * bps), depth };
  }

  const hex = (r, g, b) => `#${[r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('').toUpperCase()}`;

  /** The pixel of a w×h picture under the fractional position (fx, fy: 0..1 over the picture), rounded once. */
  const exactPixel = (fx, fy, w, h) => [Math.max(0, Math.min(w - 1, Math.floor(fx * w))), Math.max(0, Math.min(h - 1, Math.floor(fy * h)))];

  // ---- in the webview ---------------------------------------------------------

  /**
   * @param {{vscode: any, stage: HTMLElement, canvas: HTMLCanvasElement, log: Function, toast: Function,
   *   getPlayer: () => any, fmtTime: (t: number) => string, cfg: any, getExact?: () => any, exactCtx?: (e: any) => any}} env
   */
  function create(env) {
    const { vscode, stage, canvas, toast, getPlayer, fmtTime } = env;
    const el = (tag, id, parent) => { const e = document.createElement(tag); e.id = id; e.hidden = true; parent.appendChild(e); return e; };

    // ---- picture size, zoom and pan -------------------------------------------
    // The picture's size and place come from media/picture.js (a mode: Fit, Fill, Stretch or 100 %, plus a zoom and
    // a pan). The plain Fit keeps the CSS layout while the picture only shrinks or stays; once it must grow (a small video in
    // a big area) and in every other view the canvas is placed with a transform in the stage ('zoom' class). The canvas holds the picture at its own size (rotation
    // included), so a CSS transform with image-rendering is exact and costs no extra GPU pass.
    let pic = Pic.fresh(env.picture);
    let forceNearest = false;
    const grid = el('div', 'pxgrid', stage);

    const area = () => ({ w: stage.clientWidth, h: stage.clientHeight });
    const natural = () => ({ w: canvas.width, h: canvas.height });
    const dprOf = () => globalThis.devicePixelRatio || 1;
    function source() {
      const p = getPlayer();
      const m = p && p.meta;
      return Pic.sourceSize(natural(), m && { w: m.width, h: m.height });
    }
    const opts = () => ({ dpr: dprOf() });
    const rectNow = () => Pic.rectOf(pic, natural(), source(), area(), opts());
    const isPlain = () => pic.mode === 'fit' && Pic.plain(pic);
    /** The CSS layout does the plain Fit (max-width / max-height shrink, never enlarge); a picture that must grow needs the transform. */
    const cssFit = () => isPlain() && !!canvas.width && rectNow().w <= canvas.width + 0.5;
    /** CSS px per canvas pixel as shown now. */
    function scale() {
      if (!cssFit()) return canvas.width ? rectNow().w / canvas.width : 1;
      const r = canvas.getBoundingClientRect();
      return canvas.width ? r.width / canvas.width : 1;
    }

    let lastLayout = '';
    let lastZoom = 'fit|1';
    let lastPicture = '';
    let started = false; // the callbacks wait until create() has returned (the player's `insp` does not exist before)
    function apply() {
      const v = area();
      if (canvas.width && canvas.height) pic = Pic.clamp(pic, natural(), source(), v, opts());
      let r = null;
      if (cssFit() || !canvas.width) canvas.style.transform = '';
      else {
        r = rectNow();
        // On whole device pixels: at 100 % every video pixel must land on one screen pixel (a half pixel blurs the picture).
        const d = dprOf();
        r = { ...r, x: Math.round(r.x * d) / d, y: Math.round(r.y * d) / d };
        canvas.style.transform = `translate(${r.x}px, ${r.y}px) scale(${r.w / canvas.width}, ${r.h / canvas.height})`;
      }
      stage.classList.toggle('fit', !r);
      stage.classList.toggle('zoom', !!r);
      stage.classList.toggle('pannable', !!r && (r.w > v.w + 0.5 || r.h > v.h + 0.5));
      stage.dataset.picture = pic.mode;
      const k = scale();
      canvas.style.imageRendering = forceNearest || k >= NEAREST_AT ? 'pixelated' : '';
      // Pixel grid: lines every video pixel, drawn over the visible part of the picture.
      grid.hidden = !(r && k >= GRID_AT);
      if (!grid.hidden && r) {
        const x0 = Math.max(0, r.x);
        const y0 = Math.max(0, r.y);
        const x1 = Math.min(v.w, r.x + r.w);
        const y1 = Math.min(v.h, r.y + r.h);
        Object.assign(grid.style, {
          left: `${x0}px`, top: `${y0}px`, width: `${Math.max(0, x1 - x0)}px`, height: `${Math.max(0, y1 - y0)}px`,
          backgroundSize: `${r.w / canvas.width}px ${r.h / canvas.height}px`, backgroundPosition: `${r.x - x0}px ${r.y - y0}px`,
        });
      }
      lastLayout = layoutKey();
      const z = `${pic.mode}|${pic.zoom}`;
      if (z !== lastZoom) { lastZoom = z; if (started && env.onZoom) env.onZoom(); }
      if (z !== lastPicture) { lastPicture = z; if (started && env.onPicture) env.onPicture(); }
    }
    const layoutKey = () => `${pic.mode}|${pic.zoom}|${pic.cx}|${pic.cy}|${canvas.width}x${canvas.height}|${stage.clientWidth}x${stage.clientHeight}`;

    /** The picture's size in CSS px ({ w, h }) native frames should have, or null while the plain Fit lets the stage decide. */
    function zoomedSize() {
      return canvas.width && canvas.height ? Pic.frameNeed(pic, rectNow(), natural()) : null;
    }

    /** Sets the mode (zoom and pan start over). */
    function setMode(m, quiet) {
      pic = Pic.fresh(m);
      apply();
      if (!quiet) toastPicture();
    }
    /** The toast for the current size: the mode with its percent, or "Zoom N%" once zoomed. */
    function toastPicture() {
      toast(Pic.pictureToast(pic.mode, canvas.width ? zoomPercent() : null, Pic.isZoomed(pic)));
    }
    /** Z: the next mode; zoomed in, back to Fit first. */
    function cycleMode() {
      pic = Pic.cycle(pic);
      apply();
      toastPicture();
    }
    function resetZoom() {
      pic = Pic.fresh(pic.mode);
      apply();
    }
    const zoomPercent = () => Pic.percent(rectNow(), source(), dprOf());

    function zoomTo(z1, px, py) {
      const v = area();
      if (px === undefined) { px = v.w / 2; py = v.h / 2; }
      pic = Pic.zoomAt(pic, z1, px, py, natural(), source(), v, opts());
      apply();
    }
    /** + / - keys: one step around the middle of the picture area. */
    function zoomStep(dir) {
      if (!canvas.width) return;
      zoomTo(pic.zoom * (dir > 0 ? Pic.STEP : 1 / Pic.STEP));
      toastPicture();
    }

    /** Ctrl+wheel (and trackpad pinch) zooms around the cursor. */
    function onWheel(e) {
      if (!e.ctrlKey || !canvas.width) return false;
      const sr = stage.getBoundingClientRect();
      let f = Math.exp(-Math.max(-300, Math.min(300, e.deltaY)) * 0.002);
      // Snap through 100 % (one video pixel per screen pixel) when the zoom crosses it.
      const k = zoomPercent() / 100;
      if ((k < 1 && k * f > 1) || (k > 1 && k * f < 1)) f = 1 / k;
      zoomTo(pic.zoom * f, e.clientX - sr.left, e.clientY - sr.top);
      toastPicture();
      return true;
    }

    function toggleNearest() {
      forceNearest = !forceNearest;
      apply();
      toast(forceNearest ? 'Nearest-neighbour on' : `Nearest-neighbour from ${NEAREST_AT * 100}%`);
    }

    // Drag to pan (when the picture is larger than the area); a drag (or an inspector click) is not a play/pause click.
    let drag = null;
    // The click right after a pan's pointerup is swallowed. Only that one: a pan that
    // ends with no click (released outside, cancelled) must not eat a later click.
    let swallowUntil = 0;
    stage.addEventListener('pointerdown', (e) => {
      swallowUntil = 0;
      if (e.button !== 0 || !stage.classList.contains('pannable') || e.target !== canvas && e.target !== stage && e.target !== grid) return;
      drag = { x: e.clientX, y: e.clientY, pic, moved: false, id: e.pointerId };
    });
    stage.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) < 4) return;
      if (!drag.moved) { drag.moved = true; stage.setPointerCapture(e.pointerId); stage.classList.add('panning'); }
      pic = Pic.panBy(drag.pic, dx, dy, natural(), source(), area(), opts());
      apply();
    });
    const endDrag = (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      if (drag.moved && e.type === 'pointerup') swallowUntil = performance.now() + 400;
      drag = null;
      stage.classList.remove('panning');
    };
    stage.addEventListener('pointerup', endDrag);
    stage.addEventListener('pointercancel', endDrag);
    stage.addEventListener('click', (e) => {
      if (swallowUntil && performance.now() < swallowUntil) { swallowUntil = 0; e.stopImmediatePropagation(); return; }
      swallowUntil = 0;
      if (inspecting && e.target === canvas && lastPick) {
        e.stopImmediatePropagation();
        copyText(lastPick.text, 'Pixel value copied');
      }
    }, true);
    stage.addEventListener('dblclick', (e) => { if (inspecting) e.stopImmediatePropagation(); }, true);

    // ---- pixel inspector ------------------------------------------------------
    let inspecting = false;
    let loupeOn = true;
    const readout = el('div', 'pxread', stage);
    const readText = document.createElement('div');
    const loupe = document.createElement('canvas');
    loupe.width = LOUPE_PX * LOUPE_SCALE;
    loupe.height = LOUPE_PX * LOUPE_SCALE;
    loupe.className = 'loupe';
    readout.append(loupe, readText);
    const lctx = /** @type {CanvasRenderingContext2D} */ (loupe.getContext('2d'));
    const tile = document.createElement('canvas');
    tile.width = LOUPE_PX;
    tile.height = LOUPE_PX;
    const tctx = /** @type {CanvasRenderingContext2D} */ (tile.getContext('2d'));
    let mouse = null;
    let pickQueued = false;
    let lastPick = null;
    let yuvSeq = 0;

    // Pointer events retain fractional CSS coordinates on HiDPI displays, where
    // at 100 % several video pixels can share an integer mouse coordinate.
    stage.addEventListener('pointermove', (e) => {
      if (e.pointerType === 'touch') return;
      mouse = { x: e.clientX, y: e.clientY };
      if (inspecting && !pickQueued) { pickQueued = true; requestAnimationFrame(pick); }
    });
    stage.addEventListener('pointerleave', () => { mouse = null; if (inspecting) readout.hidden = true; });

    /** 15×15 RGBA around (x, y), top row first; outside the picture is transparent. */
    function readBlock(p, x, y) {
      const h = LOUPE_PX >> 1;
      if (p.gl && p.gl.gl) {
        const gl = p.gl.gl;
        const out = new Uint8ClampedArray(LOUPE_PX * LOUPE_PX * 4);
        const x0 = Math.max(0, x - h);
        const x1 = Math.min(canvas.width, x + h + 1);
        const y0 = Math.max(0, y - h);
        const y1 = Math.min(canvas.height, y + h + 1);
        if (x1 <= x0 || y1 <= y0) return out;
        const w = x1 - x0;
        const hh = y1 - y0;
        const buf = new Uint8Array(w * hh * 4);
        const prev = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING);
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
        // GL rows start at the bottom.
        gl.readPixels(x0, canvas.height - y1, w, hh, gl.RGBA, gl.UNSIGNED_BYTE, buf);
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, prev);
        for (let r = 0; r < hh; r++) {
          const src = (hh - 1 - r) * w * 4;
          const dst = ((y0 + r - (y - h)) * LOUPE_PX + (x0 - (x - h))) * 4;
          out.set(buf.subarray(src, src + w * 4), dst);
        }
        return out;
      }
      if (p.ctx) return p.ctx.getImageData(x - h, y - h, LOUPE_PX, LOUPE_PX).data;
      return null;
    }

    /** 15×15 RGBA around (x, y) of the exact picture (transparent outside it). */
    function readExact(ex, x, y) {
      const h = LOUPE_PX >> 1;
      return env.exactCtx(ex).getImageData(x - h, y - h, LOUPE_PX, LOUPE_PX).data;
    }

    function pick() {
      pickQueued = false;
      const p = getPlayer();
      if (!inspecting || !mouse || !p || !canvas.width) return;
      const r = canvas.getBoundingClientRect();
      const x = Math.floor(((mouse.x - r.left) / r.width) * canvas.width);
      const y = Math.floor(((mouse.y - r.top) / r.height) * canvas.height);
      if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) { readout.hidden = true; lastPick = null; return; }
      // Live transcode, paused: the exact picture of the file (media/exactframe.js), read at the same place of the picture.
      // The pointer's fractional place in the picture goes straight into the exact picture's pixels (one rounding).
      const ex = env.getExact ? env.getExact() : null;
      const [exX, exY] = ex ? exactPixel((mouse.x - r.left) / r.width, (mouse.y - r.top) / r.height, ex.w, ex.h) : [x, y];
      const block = ex ? readExact(ex, exX, exY) : readBlock(p, x, y);
      if (!block) return;
      const c = ((LOUPE_PX >> 1) * LOUPE_PX + (LOUPE_PX >> 1)) * 4;
      const [R, G, B] = [block[c], block[c + 1], block[c + 2]];
      const rot = !ex && p.gl ? p.gl.rot || 0 : 0;
      const frame = p.currentFrame();
      const base = `${exX},${exY}`;
      const lines = [`x ${exX}  y ${exY}${rot ? `  (turned ${rot}°)` : ''}${ex ? '  (exact frame)' : ''}`, `RGB ${R} ${G} ${B}  ${hex(R, G, B)}`];
      let text = `frame ${frame + 1} x=${exX} y=${exY} rgb=(${R},${G},${B}) ${hex(R, G, B)}${ex ? ' exact' : ''}`;
      // Source code values: soft frames are kept on the CPU; GPU frames via copyTo.
      const shown = p.lastShown;
      if (ex) { /* the transcoded picture's code values are not the file's */ } else if (shown && shown.yuv) {
        const [sx, sy] = displayToSource(x, y, canvas.width, canvas.height, rot, shown.yuv.width, shown.yuv.height);
        const v = yuvAt(shown.yuv, sx, sy);
        if (v) {
          lines.push(`YUV ${v.y} ${v.u} ${v.v}  ${v.depth}-bit`);
          text += ` yuv=(${v.y},${v.u},${v.v}) ${v.depth}-bit`;
        }
      } else if (shown && shown.vf) {
        const seq = ++yuvSeq;
        readVf(shown.vf, x, y, rot).then((v) => {
          if (!v || seq !== yuvSeq || !lastPick || lastPick.base !== base) return;
          lastPick.text += ` yuv=(${v.y},${v.u},${v.v}) ${v.depth}-bit`;
          readText.textContent += `\nYUV ${v.y} ${v.u} ${v.v}  ${v.depth}-bit`;
        }, () => {});
      }
      lastPick = { base, text };
      readText.textContent = lines.join('\n');
      loupe.hidden = !loupeOn;
      if (loupeOn) {
        tctx.putImageData(new ImageData(new Uint8ClampedArray(block), LOUPE_PX, LOUPE_PX), 0, 0);
        lctx.imageSmoothingEnabled = false;
        lctx.clearRect(0, 0, loupe.width, loupe.height);
        lctx.drawImage(tile, 0, 0, loupe.width, loupe.height);
        const m = (LOUPE_PX >> 1) * LOUPE_SCALE;
        lctx.strokeStyle = R + G + B > 382 ? '#000' : '#fff';
        lctx.strokeRect(m + 0.5, m + 0.5, LOUPE_SCALE - 1, LOUPE_SCALE - 1);
      }
      // Next to the cursor, flipped at the stage edges.
      readout.hidden = false;
      const sr = stage.getBoundingClientRect();
      const bw = readout.offsetWidth;
      const bh = readout.offsetHeight;
      let left = mouse.x - sr.left + 18;
      let top = mouse.y - sr.top + 18;
      if (left + bw > sr.width - 4) left = mouse.x - sr.left - bw - 18;
      if (top + bh > sr.height - 4) top = mouse.y - sr.top - bh - 18;
      readout.style.left = `${Math.max(4, left)}px`;
      readout.style.top = `${Math.max(4, top)}px`;
    }

    async function readVf(vf, x, y, rot) {
      if (!vf.format || vf.format === 'RGBA' || vf.format === 'BGRA' || vf.format === 'RGBX' || vf.format === 'BGRX') return null;
      const vr = vf.visibleRect || { x: 0, y: 0, width: vf.codedWidth, height: vf.codedHeight };
      const [sx, sy] = displayToSource(x, y, canvas.width, canvas.height, rot, vr.width, vr.height);
      const ax = vr.x + (sx & ~1);
      const ay = vr.y + (sy & ~1);
      const rect = { x: ax, y: ay, width: Math.min(2, vf.codedWidth - ax), height: Math.min(2, vf.codedHeight - ay) };
      const buf = new Uint8Array(vf.allocationSize({ rect }));
      const layouts = await vf.copyTo(buf, { rect });
      return vfSample(vf.format, buf, layouts, vr.x + sx - ax, vr.y + sy - ay);
    }

    function setInspecting(on) {
      inspecting = on;
      stage.classList.toggle('inspecting', on);
      if (!on) { readout.hidden = true; lastPick = null; } else if (mouse) pick();
    }
    function cycleInspector() {
      if (!inspecting) { loupeOn = true; setInspecting(true); toast('Pixel inspector: click copies the value (X again: no loupe)'); } else if (loupeOn) { loupeOn = false; if (mouse) pick(); toast('Pixel inspector without loupe'); } else { setInspecting(false); toast('Pixel inspector off'); }
    }

    // ---- go to frame / time -----------------------------------------------------
    const gotoBox = el('div', 'goto', stage);
    const gotoInput = document.createElement('input');
    gotoInput.type = 'text';
    gotoInput.spellcheck = false;
    gotoInput.setAttribute('aria-label', 'Go to frame, time or percentage');
    gotoInput.placeholder = 'Frame 1432, time 1:23.456 or 50%';
    gotoBox.appendChild(gotoInput);
    gotoBox.addEventListener('click', (e) => e.stopPropagation());
    gotoInput.addEventListener('keydown', (e) => {
      e.stopPropagation(); // the player's keys stay off while typing
      if (e.key === 'Escape') { closeGoto(); e.preventDefault(); }
      if (e.key === 'Enter') {
        e.preventDefault();
        const g = parseGoto(gotoInput.value);
        if (!g) { gotoBox.classList.add('bad'); return; }
        closeGoto();
        goTo(g);
      }
    });
    gotoInput.addEventListener('input', () => gotoBox.classList.remove('bad'));
    gotoInput.addEventListener('blur', () => closeGoto());
    function openGoto() {
      const p = getPlayer();
      gotoBox.hidden = false;
      gotoBox.classList.remove('bad');
      gotoInput.value = p ? String(p.currentFrame() + 1) : '';
      gotoInput.focus();
      gotoInput.select();
    }
    // The frame counter opens it too (plain G is the subtitle delay).
    const frameLabel = document.getElementById('frame');
    if (frameLabel) {
      frameLabel.title = 'Frame number: click or Ctrl+G to go to a frame or time';
      frameLabel.classList.add('gotoable');
      frameLabel.addEventListener('click', (e) => { e.stopPropagation(); openGoto(); });
    }
    function closeGoto() { gotoBox.hidden = true; if (document.activeElement === gotoInput) gotoInput.blur(); }

    let pendingGoto = null;
    /** Seeks to a parsed go-to; frame numbers wait until the frame rate is known. */
    function goTo(g) {
      const p = getPlayer();
      if (!p) { pendingGoto = g; return; }
      if (('frame' in g || 'delta' in g) && !(p.fps > 0 && p.n > 0)) { pendingGoto = g; return; }
      pendingGoto = null;
      const r = resolveGoto(g, p.currentFrame(), p.n, p.meta && p.meta.duration);
      p.pause();
      if (r.frame !== undefined) { p.seekFrame(r.frame); toast(`Frame ${r.frame + 1}`); } else if (r.time !== undefined) { p.seekTime(r.time); toast(fmtTime(r.time)); }
    }

    /** From a link: {t, frame} (frame 1-based). Time is exact before the frame rate is known. */
    function goToLink(q) {
      const p = getPlayer();
      if (q.t !== undefined && p && p.deferSeek && p.startT === null) { p.pause(); p.deferSeek(q.t); return; }
      if (q.t !== undefined) goTo({ time: q.t }); else if (q.frame !== undefined) goTo({ frame: q.frame });
    }

    function copyText(text, note) {
      vscode.postMessage({ type: 'copyText', text });
      toast(note);
    }
    function copyLink() {
      const p = getPlayer();
      if (!p) return;
      const f = p.currentFrame();
      const fps = p.fps || (p.meta && p.meta.fps) || 0;
      // The time is the middle of the frame, so it lands on it before the frame rate is known.
      const t = fps ? (f + 0.5) / fps : p.currentTime();
      vscode.postMessage({ type: 'copyLink', frame: f + 1, t: Math.round(t * 1e4) / 1e4 });
    }

    // ---- stats overlay ----------------------------------------------------------
    const stats = el('pre', 'stats', stage);
    let statsAt = 0;
    let shownMark = null;

    const mb = (b) => `${(b / 1e6).toFixed(b < 1e7 ? 1 : 0)} MB`;
    function statsText(p, now) {
      const L = [];
      const row = (k, v) => L.push(`${k.padEnd(9)}${v}`);
      // Shown frames per second over the last second or so.
      const count = p.shownCount || 0;
      if (!shownMark) shownMark = { at: now, n: count, fps: '-' };
      else if (now - shownMark.at >= 950) shownMark = { at: now, n: count, fps: ((count - shownMark.n) / ((now - shownMark.at) / 1000)).toFixed(1) };
      const shownFps = shownMark.fps;
      if (!p.queue) {
        // Frame player (MJPEG AVI, image sequences): JPEG/PNG decoded by the browser.
        row('decoder', 'browser images (MJPEG / sequence)');
        row('picture', `${canvas.width}×${canvas.height}`);
        row('fps', `${p.fps}`);
        row('cache', `${p.bitmaps.size} frames, ${p.inflight.size} loading`);
        row('rate', `${p.playing ? '' : 'paused '}${(p.audio && p.audio.playbackRate) || 1}×`);
        return L.join('\n');
      }
      const v = p.info && p.info.video;
      const a = p.info && p.info.audio;
      // Which decoder makes the picture, and why not WebCodecs when it was skipped or failed.
      const wi = p.wcInfo;
      const path = p.cfg && p.cfg.native ? 'native ffmpeg'
        : p.vmode === 'webcodecs' ? `WebCodecs ${wi ? `${wi.codec} ` : ''}(GPU)`
          : p.vmode === 'soft' ? `WebAssembly (soft)${wi && wi.failed ? ` · WebCodecs failed: ${wi.failed}` : wi && wi.skipped ? ` · WebCodecs off: ${wi.skipped}` : ''}` : p.vmode || '-';
      const pool = p.worker && p.worker.extras ? ` · pool ${p.worker.mode} +${p.worker.extras.filter((x) => x.state === 'ready').length}` : '';
      row('decoder', `${path}${pool}`);
      row('video', v ? `${v.codec}${v.profile > 0 ? ` p${v.profile}` : ''} ${p.meta.width}×${p.meta.height}${p.gl && p.gl.rot ? ` turned ${p.gl.rot}°` : ''}` : 'none');
      const ls = p.lastShown;
      const fmt = ls && ls.yuv ? softFormat(ls.yuv) : p.shownFmt;
      row('pixels', fmt ? `${fmt} · ${p.shownMatrix()}` : '-');
      if (v && (v.colorTrc === 16 || v.colorTrc === 18)) {
        const tf = v.colorTrc === 16 ? 'PQ' : 'HLG';
        const out = p.hdrOutput && p.hdrOutput.on;
        row('HDR', out ? `${tf} · HDR output (Display P3, 203 nits = SDR white)`
          : `${tf} → SDR · HDR tone-mapped to SDR · ${v.colorTrc === 16 ? (p.gl && p.gl.hdrPeak > 203 ? `peak ${p.gl.hdrPeak} nits` : 'peak 1000 nits (assumed)') : '1000-nit display'} · BT.2390${p.hdrOutput && p.hdrOutput.why ? ` (${p.hdrOutput.why})` : ''}`);
      }
      row('fps', `${p.fps || '?'} file · ${shownFps} shown`);
      row('frames', `${p.dropped || 0} dropped · ${p.late || 0} late · ${p.skips || 0} skips`);
      const ratio = p.decodeRate && p.fps ? p.decodeRate / p.fps : null;
      row('decode', `${ratio ? `${ratio.toFixed(2)}× real time` : '-'}${p.decodeRate ? ` (${p.decodeRate.toFixed(1)} fps)` : ''}`);
      const q = p.queue;
      const ahead = q.length ? p.rel(q[q.length - 1].t) - p.currentTime() : 0;
      row('queue', `${q.length} frames · ${ahead.toFixed(2)} s · ${mb(p.queuedBytes())}${p.vdec ? ` · ${p.vdec.decodeQueueSize} in decoder` : ''}`);
      const master = p.audioMaster && p.audioMaster();
      const drift = master && p.shownT !== null && p.playing ? `${((p.now() - p.shownT) * 1000).toFixed(0)} ms` : '-';
      row('audio', a ? `${a.codec} ${a.sampleRate / 1000} kHz ${a.channels} ch · ${p.amode} · ${p.ac ? p.ac.state : '-'}` : 'none');
      row('clock', `${master ? 'audio' : 'timer'} · drift ${drift} · ${p.audio.length} chunks`);
      row('rate', `${p.rate}× ${p.playing ? 'playing' : 'paused'} · when slow: ${p.whenSlow}${p.autoEvery ? ' (auto every)' : ''}`);
      if (p.blocks) row('cache', `${p.blocks.size} × ${mb(p.blockSize)} = ${mb(p.blockBytes)} · ${p.inflight.size} in flight · ahead ${p.readAhead}${p.cfg.remote ? ' · remote' : ''}`);
      else row('cache', p.cfg && p.cfg.native ? 'native reader' : '-');
      const st = p.status && p.status();
      if (st) row('status', st.text);
      return L.join('\n');
    }

    function tick(now) {
      const p = getPlayer();
      if (pendingGoto && p) goTo(pendingGoto);
      if (layoutKey() !== lastLayout) apply();
      if (!stats.hidden && p && now - statsAt >= 250) {
        statsAt = now;
        try { stats.textContent = statsText(p, now); } catch (e) { stats.textContent = `stats: ${e && e.message}`; }
      }
      // Paused frame changes (stepping): refresh the readout under a still cursor.
      if (inspecting && p && mouse && !pickQueued) {
        const key = `${p.currentFrame()}|${p.shownCount || p.shown}${env.getExact && env.getExact() ? '|exact' : ''}`;
        if (key !== tick.key) { tick.key = key; pickQueued = true; requestAnimationFrame(pick); }
      }
    }
    tick.key = '';

    /** Keys handled here first (before the player's). True when handled. */
    function onKey(e) {
      // AltGr (Ctrl+Alt on Windows) is a character key on many layouts, not Ctrl.
      const altGr = !!(e.getModifierState && e.getModifierState('AltGraph'));
      if (e.metaKey || (e.altKey && !altGr)) return false;
      if (e.ctrlKey && !altGr) {
        if (e.key === 'g' || e.key === 'G') { e.stopPropagation(); openGoto(); return true; }
        return false;
      }
      switch (e.key) {
        case 'Escape':
          if (!inspecting) return false;
          setInspecting(false);
          toast('Pixel inspector off');
          return true;
        // X cycles: inspector with loupe, without loupe, off (Shift+X is the codec X-ray).
        case 'x': case 'X': if (e.shiftKey) return false; cycleInspector(); return true;
        case 'Z': if (e.shiftKey) { toggleNearest(); return true; } return false;
        case 'I': if (e.shiftKey) { stats.hidden = !stats.hidden; statsAt = 0; shownMark = null; return true; } return false;
        case 'C': if (e.shiftKey) { copyLink(); return true; } return false;
        default: return false;
      }
    }

    apply();
    started = true;
    /** Nothing here needs the player's frame loop: no stats overlay, no pending go-to, no pick queued. */
    const idle = () => stats.hidden && !pendingGoto && !pickQueued;
    return {
      onKey, onWheel, tick, idle, cycleMode, setMode, resetZoom, zoomStep, zoomTo, zoomPercent, zoomedSize,
      picture: () => ({ ...pic }), goToLink, copyLink, inspecting: () => inspecting,
    };
  }

  const mb = (b) => `${(b / 1e6).toFixed(b < 1e7 ? 1 : 0)} MB`;
  /** Format the Shift+I stats overlay text for decoder `p` (shared by VpeInspect.create and media/player-unified.js). */
  function formatStats(p, now, canvas, mark) {
    const L = [];
    const row = (k, v) => L.push(`${k.padEnd(9)}${v}`);
    const count = p.shownCount || 0;
    let nextMark = mark;
    if (!nextMark) nextMark = { at: now, n: count, fps: '-' };
    else if (now - nextMark.at >= 950) nextMark = { at: now, n: count, fps: ((count - nextMark.n) / ((now - nextMark.at) / 1000)).toFixed(1) };
    const shownFps = nextMark.fps;
    if (!p.queue) {
      row('decoder', 'browser images (MJPEG / sequence)');
      row('picture', `${(canvas && canvas.width) || 0}×${(canvas && canvas.height) || 0}`);
      row('fps', `${p.fps}`);
      row('cache', `${p.bitmaps.size} frames, ${p.inflight.size} loading`);
      row('rate', `${p.playing ? '' : 'paused '}${(p.audio && p.audio.playbackRate) || 1}×`);
      return { text: L.join('\n'), mark: nextMark };
    }
    const v = p.info && p.info.video;
    const a = p.info && p.info.audio;
    const wi = p.wcInfo;
    const path = p.cfg && p.cfg.native ? 'native ffmpeg'
      : p.vmode === 'webcodecs' ? `WebCodecs ${wi ? `${wi.codec} ` : ''}(GPU)`
        : p.vmode === 'soft' ? `WebAssembly (soft)${wi && wi.failed ? ` · WebCodecs failed: ${wi.failed}` : wi && wi.skipped ? ` · WebCodecs off: ${wi.skipped}` : ''}` : p.vmode || '-';
    const pool = p.worker && p.worker.extras ? ` · pool ${p.worker.mode} +${p.worker.extras.filter((x) => x.state === 'ready').length}` : '';
    row('decoder', `${path}${pool}`);
    row('video', v ? `${v.codec}${v.profile > 0 ? ` p${v.profile}` : ''} ${p.meta.width}×${p.meta.height}${p.gl && p.gl.rot ? ` turned ${p.gl.rot}°` : ''}` : 'none');
    const ls = p.lastShown;
    const fmt = ls && ls.yuv ? softFormat(ls.yuv) : p.shownFmt;
    row('pixels', fmt ? `${fmt} · ${p.shownMatrix()}` : '-');
    if (v && (v.colorTrc === 16 || v.colorTrc === 18)) {
      const tf = v.colorTrc === 16 ? 'PQ' : 'HLG';
      const out = p.hdrOutput && p.hdrOutput.on;
      row('HDR', out ? `${tf} · HDR output (Display P3, 203 nits = SDR white)`
        : `${tf} → SDR · HDR tone-mapped to SDR · ${v.colorTrc === 16 ? (p.gl && p.gl.hdrPeak > 203 ? `peak ${p.gl.hdrPeak} nits` : 'peak 1000 nits (assumed)') : '1000-nit display'} · BT.2390${p.hdrOutput && p.hdrOutput.why ? ` (${p.hdrOutput.why})` : ''}`);
    }
    row('fps', `${p.fps || '?'} file · ${shownFps} shown`);
    row('frames', `${p.dropped || 0} dropped · ${p.late || 0} late · ${p.skips || 0} skips`);
    const ratio = p.decodeRate && p.fps ? p.decodeRate / p.fps : null;
    row('decode', `${ratio ? `${ratio.toFixed(2)}× real time` : '-'}${p.decodeRate ? ` (${p.decodeRate.toFixed(1)} fps)` : ''}`);
    const q = p.queue;
    const ahead = q.length ? p.rel(q[q.length - 1].t) - p.currentTime() : 0;
    row('queue', `${q.length} frames · ${ahead.toFixed(2)} s · ${mb(p.queuedBytes())}${p.vdec ? ` · ${p.vdec.decodeQueueSize} in decoder` : ''}`);
    const master = p.audioMaster && p.audioMaster();
    const drift = master && p.shownT !== null && p.playing ? `${((p.now() - p.shownT) * 1000).toFixed(0)} ms` : '-';
    row('audio', a ? `${a.codec} ${a.sampleRate / 1000} kHz ${a.channels} ch · ${p.amode} · ${p.ac ? p.ac.state : '-'}` : 'none');
    row('clock', `${master ? 'audio' : 'timer'} · drift ${drift} · ${p.audio.length} chunks`);
    row('rate', `${p.rate}× ${p.playing ? 'playing' : 'paused'} · when slow: ${p.whenSlow}${p.autoEvery ? ' (auto every)' : ''}`);
    if (p.blocks) row('cache', `${p.blocks.size} × ${mb(p.blockSize)} = ${mb(p.blockBytes)} · ${p.inflight.size} in flight · ahead ${p.readAhead}${p.cfg.remote ? ' · remote' : ''}`);
    else row('cache', p.cfg && p.cfg.native ? 'native reader' : '-');
    const st = p.status && p.status();
    if (st) row('status', st.text);
    return { text: L.join('\n'), mark: nextMark };
  }

  return { create, formatStats, exactPixel, parseGoto, resolveGoto, parseFragment, clampPan, zoomAround, displayToSource, yuvAt, softFormat, vfSample };
})();

if (typeof module !== 'undefined') module.exports = VpeInspect;
