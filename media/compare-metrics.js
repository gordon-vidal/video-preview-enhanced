// @ts-check
'use strict';

(function () {
  // checkJs: start
  /** @typedef {{data: Uint8Array | Uint16Array, w: number, h: number, depth: number}} LumaPlane */

  /**
   * Keeps the last drawn frame's source so metrics can use the decoded luma plane
   * itself (exact, like ffmpeg) instead of luma recovered from RGB. Uses the
   * renderer's explicit onFrame capture contract (media/gl-renderer.js).
   * Software frames: a reference to the YUV object (read on demand; if a later
   * frame path recycles or detaches its buffer, metrics fall back to RGB).
   * WebCodecs frames: a clone of the VideoFrame (released when the next one is drawn).
   * @param {any} p
   * @param {{setCapture?: (renderer: any, onFrame: (frame: any) => void) => void}} [renderer]
   */
  function captureLuma(p, renderer) {
    const g = p.gl;
    if (!g) return;
    const keep = (snap) => {
      const old = p.lumaSrc;
      if (old && old.vf) { try { old.vf.close(); } catch { /* closed */ } }
      p.lumaSrc = snap;
    };
    const onFrame = (frame) => {
      if (!frame) { keep(null); return; }
      if (frame.yuv) { keep({ yuv: frame.yuv }); return; }
      if (frame.vf) {
        let c = null;
        try { c = frame.vf.clone(); } catch { /* unsupported */ }
        keep(c ? { vf: c } : null);
      }
    };
    if (renderer && typeof renderer.setCapture === 'function') {
      renderer.setCapture(g, onFrame);
    } else {
      g.onFrame = onFrame;
    }
    if (typeof g.dispose !== 'function') {
      const dispose = p.dispose.bind(p);
      p.dispose = () => { keep(null); dispose(); };
    }
  }

  /**
   * The shown frame's luma plane, or null when it can't be had.
   * @param {any} p
   * @param {(message: string) => void} [log]
   * @returns {Promise<LumaPlane | null>}
   */
  async function lumaOf(p, log = () => {}) {
    const s = p.lumaSrc;
    if (!s) return null;
    if (s.luma !== undefined) return s.luma;
    let out = null;
    try {
      if (s.yuv) {
        const f = s.yuv;
        const depth = f.depth || 8;
        const L = f.layout && f.layout[0];
        if (L && f.data && f.data.byteLength) {
          const w = f.width, h = f.height;
          if (depth > 8) {
            const src = new Uint16Array(f.data.buffer, f.data.byteOffset, f.data.byteLength >> 1);
            const d = new Uint16Array(w * h);
            const o = L.offset >> 1, st2 = L.stride >> 1;
            for (let y = 0; y < h; y++) d.set(src.subarray(o + y * st2, o + y * st2 + w), y * w);
            out = { data: d, w, h, depth };
          } else {
            const d = new Uint8Array(w * h);
            for (let y = 0; y < h; y++) d.set(f.data.subarray(L.offset + y * L.stride, L.offset + y * L.stride + w), y * w);
            out = { data: d, w, h, depth };
          }
        }
      } else if (s.vf) {
        const vf = s.vf;
        // Planar or semi-planar 8-bit: plane 0 is luma.
        if (/^(I420|I420A|I422|I444|NV12)$/.test(vf.format || '')) {
          const vr = vf.visibleRect || { x: 0, y: 0, width: vf.codedWidth, height: vf.codedHeight };
          const buf = new Uint8Array(vf.allocationSize());
          const layout = await vf.copyTo(buf);
          const L = layout[0];
          const vw = vr.width, vh = vr.height;
          const d = new Uint8Array(vw * vh);
          for (let y = 0; y < vh; y++) {
            const o = L.offset + (vr.y + y) * L.stride + vr.x;
            d.set(buf.subarray(o, o + vw), y * vw);
          }
          out = { data: d, w: vw, h: vh, depth: 8 };
        }
      }
    } catch (e) {
      log(`luma read failed: ${e && e.message || e}`);
      out = null;
    }
    if (p.lumaSrc === s) s.luma = out;
    return out;
  }

  /**
   * PSNR of R, G, B and of luma Y, plus SSIM of Y when asked.
   * Y is limited range (16-235), as the decoder had it: recovered from RGB with the
   * reference frame's matrix weights and rounded.
   * @param {Uint8Array} pa
   * @param {Uint8Array} pb
   * @param {Uint8Array} ya
   * @param {Uint8Array} yb
   * @param {number} w
   * @param {number} h
   * @param {{ssim?: boolean, matrix: number}} opt
   */
  function computeMetrics(pa, pb, ya, yb, w, h, opt) {
    const [kr, kb] = opt.matrix === 2020 ? [0.2627, 0.0593] : opt.matrix === 709 ? [0.2126, 0.0722] : [0.299, 0.114];
    const kg = 1 - kr - kb;
    const s = 219 / 255;
    let er = 0, eg = 0, eb = 0, ey = 0;
    const n = w * h;
    for (let i = 0, j = 0; i < n; i++, j += 4) {
      const r1 = pa[j], g1 = pa[j + 1], b1 = pa[j + 2];
      const r2 = pb[j], g2 = pb[j + 1], b2 = pb[j + 2];
      const dr = r1 - r2, dg = g1 - g2, db = b1 - b2;
      er += dr * dr; eg += dg * dg; eb += db * db;
      const y1 = Math.round(16 + s * (kr * r1 + kg * g1 + kb * b1));
      const y2 = Math.round(16 + s * (kr * r2 + kg * g2 + kb * b2));
      ya[i] = y1; yb[i] = y2;
      const dy = y1 - y2;
      ey += dy * dy;
    }
    const psnr = (mse) => (mse > 0 ? 10 * Math.log10((255 * 255) / mse) : Infinity);
    const mseRgb = (er + eg + eb) / (3 * n);
    const res = { psnrY: psnr(ey / n), psnrRGB: psnr(mseRgb), mseY: ey / n, mseRGB: mseRgb, ssimY: NaN, w, h };
    if (opt.ssim) res.ssimY = ssim(ya, yb, w, h);
    return res;
  }

  /**
   * SSIM over 8x8 windows on a 4-pixel grid (sums of 4x4 blocks, combined 2x2),
   * mean over all windows, using unbiased variances and constants scaled to the peak.
   * @param {Uint8Array | Uint16Array} x
   * @param {Uint8Array | Uint16Array} y
   * @param {number} w
   * @param {number} h
   */
  function ssim(x, y, w, h, peak = 255) {
    const bw = w >> 2, bh = h >> 2;
    if (bw < 2 || bh < 2) return NaN;
    const s1 = new Float64Array(bw * bh), s2 = new Float64Array(bw * bh), ss = new Float64Array(bw * bh), s12 = new Float64Array(bw * bh);
    for (let by = 0; by < bh; by++) {
      for (let bx = 0; bx < bw; bx++) {
        let a1 = 0, a2 = 0, aa = 0, a12 = 0;
        for (let yy = 0; yy < 4; yy++) {
          let o = (by * 4 + yy) * w + bx * 4;
          for (let xx = 0; xx < 4; xx++, o++) {
            const p = x[o], q = y[o];
            a1 += p; a2 += q; aa += p * p + q * q; a12 += p * q;
          }
        }
        const k = by * bw + bx;
        s1[k] = a1; s2[k] = a2; ss[k] = aa; s12[k] = a12;
      }
    }
    const N = 64;
    const C1 = (0.01 * peak) ** 2 * N * N;
    const C2 = (0.03 * peak) ** 2 * N * (N - 1);
    let sum = 0;
    for (let by = 0; by < bh - 1; by++) {
      for (let bx = 0; bx < bw - 1; bx++) {
        const k = by * bw + bx;
        const k2 = k + bw;
        const S1 = s1[k] + s1[k + 1] + s1[k2] + s1[k2 + 1];
        const S2 = s2[k] + s2[k + 1] + s2[k2] + s2[k2 + 1];
        const SS = ss[k] + ss[k + 1] + ss[k2] + ss[k2 + 1];
        const S12 = s12[k] + s12[k + 1] + s12[k2] + s12[k2 + 1];
        const vars = SS * N - S1 * S1 - S2 * S2;
        const covar = S12 * N - S1 * S2;
        sum += ((2 * S1 * S2 + C1) * (2 * covar + C2)) / ((S1 * S1 + S2 * S2 + C1) * (vars + C2));
      }
    }
    return sum / ((bw - 1) * (bh - 1));
  }

  /**
   * PSNR (and SSIM) of two luma planes of the same size and depth.
   * @param {LumaPlane} la
   * @param {LumaPlane} lb
   * @param {boolean} wantSsim
   */
  function lumaMetrics(la, lb, wantSsim) {
    const a = la.data, b = lb.data;
    let e = 0;
    for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; e += d * d; }
    const peak = (1 << la.depth) - 1;
    const mse = e / a.length;
    const r = { psnrY: mse > 0 ? 10 * Math.log10((peak * peak) / mse) : Infinity, mseY: mse, ssimY: NaN };
    if (wantSsim) r.ssimY = ssim(a, b, la.w, la.h, peak);
    return r;
  }

  /**
   * Bilinear resize of a luma plane (pixel centres aligned), rounded to integers.
   * @param {LumaPlane} l
   * @param {number} w
   * @param {number} h
   */
  function resizeLuma(l, w, h) {
    const src = l.data, sw = l.w, sh = l.h;
    const d = l.depth > 8 ? new Uint16Array(w * h) : new Uint8Array(w * h);
    const fx = sw / w, fy = sh / h;
    for (let y = 0; y < h; y++) {
      const sy = Math.max(0, Math.min(sh - 1, (y + 0.5) * fy - 0.5));
      const y0 = Math.floor(sy), y1 = Math.min(sh - 1, y0 + 1), ty = sy - y0;
      for (let x = 0; x < w; x++) {
        const sx = Math.max(0, Math.min(sw - 1, (x + 0.5) * fx - 0.5));
        const x0 = Math.floor(sx), x1 = Math.min(sw - 1, x0 + 1), tx = sx - x0;
        const a = src[y0 * sw + x0] * (1 - tx) + src[y0 * sw + x1] * tx;
        const b = src[y1 * sw + x0] * (1 - tx) + src[y1 * sw + x1] * tx;
        d[y * w + x] = Math.round(a * (1 - ty) + b * ty);
      }
    }
    return { data: d, w, h, depth: l.depth };
  }

  const COPY_FS = `#version 300 es
    precision highp float;
    in vec2 uv; out vec4 o; uniform sampler2D t;
    void main() { o = vec4(texture(t, uv).rgb, 1.0); }`;

  /** Reads two pictures back at the first one's size and computes PSNR / SSIM on the CPU. */
  class Metrics {
    /**
     * @param {MetricsDeps} deps
     */
    constructor({ glProgram, glTexture }) {
      const cv = document.createElement('canvas');
      cv.width = 4; cv.height = 4;
      const gl = cv.getContext('webgl2', { alpha: false, antialias: false });
      if (!gl) throw new Error('WebGL2 is not available');
      this.gl = gl;
      const { u } = glProgram(gl, COPY_FS);
      gl.uniform1f(u('flip'), -1); // FBO row 0 = top of the picture, so rows read back top-down
      gl.uniform1i(u('t'), 0);
      this.tex = glTexture(gl, 0, gl.LINEAR);
      this.fbo = gl.createFramebuffer();
      this.rt = gl.createTexture();
      this.w = 0; this.h = 0;
    }
    /**
     * @param {HTMLCanvasElement} src
     * @param {number} w
     * @param {number} h
     * @param {Uint8Array} out
     */
    readBack(src, w, h, out) {
      const gl = this.gl;
      gl.bindTexture(gl.TEXTURE_2D, this.tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, out);
    }
    /**
     * @param {HTMLCanvasElement} a reference picture (its size is used)
     * @param {HTMLCanvasElement} b scaled to a's size
     * @param {{ssim?: boolean, matrix: number}} opt
     */
    measure(a, b, opt) {
      const gl = this.gl;
      const w = a.width, h = a.height;
      if (!w || !h || !b.width) return null;
      if (w !== this.w || h !== this.h) {
        this.w = w; this.h = h;
        gl.bindTexture(gl.TEXTURE_2D, this.rt);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.rt, 0);
        gl.viewport(0, 0, w, h);
        this.pa = new Uint8Array(w * h * 4);
        this.pb = new Uint8Array(w * h * 4);
        this.ya = new Uint8Array(w * h);
        this.yb = new Uint8Array(w * h);
      }
      gl.activeTexture(gl.TEXTURE0);
      this.readBack(a, w, h, this.pa);
      this.readBack(b, w, h, this.pb);
      return computeMetrics(this.pa, this.pb, this.ya, this.yb, w, h, opt);
    }
  }

  /**
   * @typedef {{
   *   glProgram: (gl: WebGL2RenderingContext, fsSrc: string) => {u: (name: string) => WebGLUniformLocation | null},
   *   glTexture: (gl: WebGL2RenderingContext, unit: number, filter: number) => WebGLTexture | null,
   *   log: (message: string) => void,
   * }} MetricsDeps
   */

  /** @param {MetricsDeps} deps */
  function install(deps) {
    const { log } = deps;
    /** @type {Metrics | null} */
    let metrics = null;
    const getMetrics = () => (metrics = metrics || new Metrics(deps));

    /**
     * Metrics of two engines' shown frames. Luma comes from the decoded planes when both
     * have the same depth and rotation. Resized planes are marked inexact.
     * RGB PSNR is always from the pictures as shown (B scaled to A's size).
     * @param {any} pa
     * @param {any} pb
     * @param {{ssim: boolean, rgb: boolean}} options
     */
    async function pairMetrics(pa, pb, { ssim: wantSsim, rgb }) {
      const [la, lb0] = await Promise.all([lumaOf(pa, log), lumaOf(pb, log)]);
      const planes = !!(la && lb0 && la.depth === lb0.depth && (pa.gl.rot || 0) === (pb.gl.rot || 0));
      const exact = planes && la.w === lb0.w && la.h === lb0.h;
      // Another size: B's plane resized to A's (bilinear), still free of colour-matrix guesses.
      const lb = planes && !exact ? resizeLuma(lb0, la.w, la.h) : lb0;
      /** @type {({psnrRGB: number, w: number, h: number} & Partial<ReturnType<typeof computeMetrics>>
       *   & {exactY?: boolean}) | null} */
      let m = null;
      if (rgb || !planes) m = getMetrics().measure(pa.cv, pb.cv, { ssim: wantSsim && !planes, matrix: pa.shownMatrix(true) });
      if (planes) m = { ...(m || { psnrRGB: NaN, w: pa.cv.width, h: pa.cv.height }), ...lumaMetrics(la, lb, wantSsim) };
      if (m) m.exactY = exact;
      return m;
    }

    return {
      pairMetrics,
      hasReadback: () => !!metrics,
      resetReadback: () => {
        metrics?.gl.getExtension('WEBGL_lose_context')?.loseContext();
        metrics = null;
      },
    };
  }

  const api = { computeMetrics, ssim, lumaMetrics, resizeLuma, lumaOf, captureLuma, Metrics, install };
  const commonJs = /** @type {{ exports?: typeof api } | undefined} */ (
    // @ts-ignore The webview has no CommonJS globals.
    typeof module === 'undefined' ? undefined : module
  );
  if (commonJs) commonJs.exports = api;
  else /** @type {typeof globalThis & { VpeCompareMetrics?: typeof api }} */ (globalThis).VpeCompareMetrics = api;
  // checkJs: end
})();
