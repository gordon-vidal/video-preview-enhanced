// @ts-check
'use strict';

// checkJs: start
(() => {
  /**
   * @typedef {{ offset: number, stride: number }} PlaneLayout
   * @typedef {{
   *   width: number, height: number, data: Uint8Array, layout: PlaneLayout[],
   *   depth?: number, cw?: number, ch?: number, fullRange?: boolean,
   *   space?: number, trc?: number, prim?: number, recycle?: boolean
   * }} YuvFrame
   * @typedef {{
   *   displayWidth: number, displayHeight: number,
   *   clone?: () => VideoFrameLike, close?: () => void,
   *   format?: string | null, codedWidth?: number, codedHeight?: number,
   *   visibleRect?: { x: number, y: number, width: number, height: number } | null,
   *   allocationSize?: (opts?: any) => number,
   *   copyTo?: (dest: BufferSource, opts?: any) => Promise<PlaneLayout[]>
   * }} VideoFrameLike
   * @typedef {{ yuv?: YuvFrame, vf?: VideoFrameLike } | null} CapturedFrame
   */

  const BT2020_TO_709_COL_MAJOR = [
    1.6604910, -0.1245505, -0.0181508,
    -0.5876411, 1.1328999, -0.1005789,
    -0.0728499, -0.0083494, 1.1187297,
  ];
  const IDENTITY_3X3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

  /** Default matrix by frame dimensions (BT.709 for HD+, BT.601 for SD). */
  const matrixBySize = (/** @type {number} */ w, /** @type {number} */ h) => (w >= 1280 || h >= 720 ? 709 : 601);

  /**
   * YUV -> R'G'B' conversion parameters for a decoded picture:
   * scale normalizes raw sample values, then rgb = m * (yuv * scale - off), with column-major m.
   * HDR (PQ 16 / HLG 18, >8-bit) uses exact n-bit levels (64..940 at 10-bit); SDR keeps 8-bit levels.
   * @param {{
   *   width: number, height: number, depth?: number,
   *   fullRange?: boolean, space?: number, trc?: number
   * }} f
   */
  function yuvMatrix(f) {
    const depth = f.depth || 8;
    const deep = depth > 8;
    const space = f.space || matrixBySize(f.width, f.height);
    const [kr, kb] = space === 2020 ? [0.2627, 0.0593] : space === 709 ? [0.2126, 0.0722] : [0.299, 0.114];
    const kg = 1 - kr - kb;
    const hdrBits = (f.trc === 16 || f.trc === 18) && deep ? depth - 8 : 0;
    const q = hdrBits ? (1 << depth) - 1 : 255;
    const lv = 1 << hdrBits;
    const ys = f.fullRange ? 1 : q / (219 * lv);
    const cs = f.fullRange ? 1 : q / (224 * lv);
    const rv = 2 * (1 - kr) * cs;
    const bu = 2 * (1 - kb) * cs;
    const gu = (2 * kb * (1 - kb) / kg) * cs;
    const gv = (2 * kr * (1 - kr) / kg) * cs;
    return {
      depth,
      deep,
      space,
      scale: deep ? 65535 / ((1 << depth) - 1) : 1,
      rawScale: 1 / ((1 << depth) - 1),
      m: [ys, ys, ys, 0, -gu, bu, rv, -gv, 0],
      off: f.fullRange ? [0, 128 * lv / q, 128 * lv / q] : [16 * lv / q, 128 * lv / q, 128 * lv / q],
    };
  }

  /**
   * HDR -> SDR tone-mapping parameters (PQ 16 -> tf 1, HLG 18 -> tf 2, SDR -> tf 0).
   * @param {number | undefined} trc
   * @param {number | undefined} prim
   * @param {number} [hdrPeak]
   */
  function transferParams(trc, prim, hdrPeak = 0) {
    const tf = trc === 16 ? 1 : trc === 18 ? 2 : 0;
    const peak = tf === 1 && hdrPeak > 203 ? hdrPeak : 1000;
    const key = `${tf}/${prim}/${peak}`;
    if (!tf) return { tf: 0, hdr: 0, peak, key, eetf: null, prim: null };
    const pq = (/** @type {number} */ n) => {
      const p = (n / 10000) ** 0.1593017578125;
      return ((0.8359375 + 18.8515625 * p) / (1 + 18.6875 * p)) ** 78.84375;
    };
    const top = pq(peak);
    const white = pq(203) / top;
    return {
      tf,
      hdr: /** @type {number} */ (trc),
      peak,
      key,
      eetf: [top, white, 1.5 * white - 0.5],
      prim: prim === 9 ? BT2020_TO_709_COL_MAJOR : IDENTITY_3X3,
    };
  }

  /**
   * Install an explicit render/capture listener on a renderer or shared-renderer proxy.
   * Calls `onFrame({ yuv } | { vf } | null)` on each draw and `null` on dispose, with zero
   * extra pixel copies or GPU readbacks inside the renderer.
   * @param {any} target
   * @param {((frame: CapturedFrame) => void) | null} onFrame
   */
  function setCapture(target, onFrame) {
    if (!target) return null;
    target.onFrame = onFrame || null;
    return target;
  }

  class GLRenderer {
    /**
     * @param {HTMLCanvasElement | { width: number, height: number, getContext: (id: 'webgl2', opts: any) => any }} cv
     */
    constructor(cv) {
      const gl = /** @type {any} */ (cv.getContext('webgl2', {
        preserveDrawingBuffer: true, alpha: false, antialias: false,
      }));
      if (!gl) throw new Error('WebGL2 is not available');
      this.gl = gl;
      this.cv = cv;
      this.maxPixels = 0; // compare's shared large-grid renderer caps its output (media/compare-grid.js)
      const vs = `#version 300 es
        in vec2 p; out vec2 uv; uniform int rot;
        void main() {
          vec2 d = vec2(p.x * 0.5 + 0.5, 0.5 - p.y * 0.5);
          // Display rotation (clockwise): where each output pixel samples the decoded picture.
          uv = rot == 90 ? vec2(d.y, 1.0 - d.x) : rot == 180 ? vec2(1.0 - d.x, 1.0 - d.y) : rot == 270 ? vec2(1.0 - d.y, d.x) : d;
          gl_Position = vec4(p, 0.0, 1.0);
        }`;
      const fs = `#version 300 es
        precision mediump float;
        in vec2 uv; out vec4 o;
        uniform sampler2D ty, tu, tv, trgb; uniform int mode; uniform mat3 m; uniform vec3 off; uniform float scale;
        // HDR to SDR (tf 1 PQ, 2 HLG; 0 SDR leaves the picture untouched). prim: BT.2020 -> BT.709
        // in linear light; eetf: PQ signal of the content peak, of SDR white (203 nits) over it, knee.
        uniform int tf; uniform highp mat3 prim; uniform highp vec3 eetf;
        highp vec3 pqToNits(highp vec3 e) {
          highp vec3 p = pow(max(e, 0.0), vec3(1.0 / 78.84375));
          return 10000.0 * pow(max(p - 0.8359375, 0.0) / (18.8515625 - 18.6875 * p), vec3(1.0 / 0.1593017578125));
        }
        highp float nitsToPq(highp float n) {
          highp float p = pow(max(n, 0.0) / 10000.0, 0.1593017578125);
          return pow((0.8359375 + 18.8515625 * p) / (1.0 + 18.6875 * p), 78.84375);
        }
        vec3 hdrToSdr(highp vec3 c) {
          c = clamp(c, 0.0, 1.0);
          highp vec3 L;
          if (tf == 1) L = pqToNits(c);
          else {
            // HLG: inverse OETF to scene light, then the OOTF of a 1000-nit display (gamma 1.2).
            highp vec3 lo = c * c / 3.0;
            highp vec3 hi = (exp((c - 0.55991073) / 0.17883277) + 0.28466892) / 12.0;
            highp vec3 e = mix(lo, hi, step(0.5, c));
            L = 1000.0 * pow(max(dot(vec3(0.2627, 0.6780, 0.0593), e), 1e-6), 0.2) * e;
          }
          L = max(prim * L, 0.0);
          // BT.2390 EETF on the brightest channel (keeps hue): content peak -> 203 nits.
          highp float sig = max(max(L.r, L.g), L.b);
          if (sig > 1e-4) {
            highp float e1 = min(nitsToPq(sig) / eetf.x, 1.0);
            highp float e2 = e1;
            if (e1 > eetf.z) {
              highp float t = (e1 - eetf.z) / (1.0 - eetf.z);
              highp float t2 = t * t; highp float t3 = t2 * t;
              e2 = (2.0 * t3 - 3.0 * t2 + 1.0) * eetf.z + (t3 - 2.0 * t2 + t) * (1.0 - eetf.z) + (-2.0 * t3 + 3.0 * t2) * eetf.y;
            }
            L *= pqToNits(vec3(e2 * eetf.x)).r / sig;
          }
          // 203 nits is SDR white; encode for the display (BT.1886, gamma 2.4) like SDR video.
          return pow(clamp(L / 203.0, 0.0, 1.0), vec3(1.0 / 2.4));
        }
        void main() {
          if (mode == 1) { o = vec4(texture(trgb, uv).rgb, 1.0); return; }
          vec3 yuv = vec3(texture(ty, uv).r, texture(tu, uv).r, texture(tv, uv).r) * scale - off;
          vec3 rgb = m * yuv;
          if (tf != 0) { o = vec4(hdrToSdr(rgb), 1.0); return; }
          o = vec4(clamp(rgb, 0.0, 1.0), 1.0);
        }`;
      /** @param {number} type @param {string} src */
      const sh = (type, src) => {
        const s = gl.createShader(type);
        gl.shaderSource(s, src);
        gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || 'shader');
        return s;
      };
      const prog = gl.createProgram();
      const vShader = sh(gl.VERTEX_SHADER, vs);
      const fShader = sh(gl.FRAGMENT_SHADER, fs);
      gl.attachShader(prog, vShader);
      gl.attachShader(prog, fShader);
      gl.linkProgram(prog);
      gl.useProgram(prog);
      this.prog = prog;
      this.shaders = [vShader, fShader];
      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      this.buf = buf;
      const loc = gl.getAttribLocation(prog, 'p');
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      this.tex = ['ty', 'tu', 'tv', 'trgb'].map((name, i) => {
        const t = gl.createTexture();
        gl.activeTexture(gl.TEXTURE0 + i);
        gl.bindTexture(gl.TEXTURE_2D, t);
        for (const [k, v] of [
          [gl.TEXTURE_MIN_FILTER, gl.LINEAR],
          [gl.TEXTURE_MAG_FILTER, gl.LINEAR],
          [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE],
          [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE],
        ]) gl.texParameteri(gl.TEXTURE_2D, k, v);
        gl.uniform1i(gl.getUniformLocation(prog, name), i);
        return t;
      });
      /** @type {string[]} */
      this.planeKeys = [];
      this.uScale = gl.getUniformLocation(prog, 'scale');
      this.uRot = gl.getUniformLocation(prog, 'rot');
      this.rot = 0;
      // 16-bit planes (10/12-bit video) as normalized textures, so the shader converts them.
      this.norm16 = gl.getExtension('EXT_texture_norm16');
      this.uMode = gl.getUniformLocation(prog, 'mode');
      this.uM = gl.getUniformLocation(prog, 'm');
      this.uOff = gl.getUniformLocation(prog, 'off');
      this.uTf = gl.getUniformLocation(prog, 'tf');
      this.uPrim = gl.getUniformLocation(prog, 'prim');
      this.uEetf = gl.getUniformLocation(prog, 'eetf');
      this.hdrPeak = 0; // content peak in nits from the stream (0: assume 1000)
      this.hdrKey = '';
      this.hdr = 0; // transfer of the last picture: 0 SDR, 16 PQ, 18 HLG
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      /** @type {((buf: ArrayBufferLike) => void) | null} */
      this.onUploaded = null;
      /** @type {ArrayBufferLike | null} */
      this.heldBuf = null;
      /** @type {((frame: CapturedFrame) => void) | null} */
      this.onFrame = null;
      /** @type {((f: YuvFrame | null) => void) | null} */
      this.twin = null; // HDR output: each picture also goes to the WebGPU HDR canvas (Player.setupHdr)
      this.disposed = false;
    }

    /** Phone videos: turn the picture by 0/90/180/270 degrees clockwise. @param {number} deg */
    setRotation(deg) {
      if (this.disposed) return;
      this.rot = [90, 180, 270].includes(deg) ? deg : 0;
      this.gl.uniform1i(this.uRot, this.rot);
    }

    /** @param {number} w @param {number} h */
    size(w, h) {
      if (this.disposed) return;
      if (this.rot === 90 || this.rot === 270) { const x = w; w = h; h = x; }
      if (this.maxPixels && w * h > this.maxPixels) {
        const s = Math.sqrt(this.maxPixels / (w * h));
        w = Math.max(1, Math.floor(w * s));
        h = Math.max(1, Math.floor(h * s));
      }
      const cv = this.cv;
      if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
      this.gl.viewport(0, 0, w, h);
    }

    /**
     * Binds plane texture i (on the active unit) with storage for w x h R8 or R16
     * samples. Storage is allocated once per size and format (texStorage2D); frames
     * then only upload (texSubImage2D), with no reallocation per frame.
     * @param {number} i
     * @param {number} w
     * @param {number} h
     * @param {boolean} deep
     */
    plane(i, w, h, deep) {
      const gl = this.gl;
      const key = `${w}x${h}${deep ? 'r16' : 'r8'}`;
      if (!this.planeKeys) this.planeKeys = [];
      if (this.planeKeys[i] !== key) {
        if (this.tex[i]) gl.deleteTexture(this.tex[i]);
        const t = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, t);
        for (const [k, v] of [
          [gl.TEXTURE_MIN_FILTER, gl.LINEAR],
          [gl.TEXTURE_MAG_FILTER, gl.LINEAR],
          [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE],
          [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE],
        ]) gl.texParameteri(gl.TEXTURE_2D, k, v);
        gl.texStorage2D(gl.TEXTURE_2D, 1, deep ? this.norm16.R16_EXT : gl.R8, w, h);
        this.tex[i] = t;
        this.planeKeys[i] = key;
      } else gl.bindTexture(gl.TEXTURE_2D, this.tex[i]);
    }

    /** Allocate native 4:2:0 textures while ffmpeg is still decoding the first picture. @param {number} w @param {number} h */
    prepareNative(w, h) {
      if (this.disposed) return;
      const gl = this.gl;
      this.size(w, h);
      for (let i = 0; i < 3; i++) {
        gl.activeTexture(gl.TEXTURE0 + i);
        this.plane(i, i ? w / 2 : w, i ? h / 2 : h, false);
      }
      // Initialize the sampling path and mask colour writes to keep the opening canvas black.
      gl.colorMask(false, false, false, false);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.colorMask(true, true, true, true);
      gl.flush();
    }

    /**
     * Planar YUV from the decoder: 8..16 bits, 4:2:0 / 4:2:2 / 4:4:4. Deep and
     * full-chroma formats are converted here on the GPU instead of in WebAssembly.
     * @param {YuvFrame} f
     */
    drawYuv(f) {
      if (this.disposed) return;
      if (this.onFrame) this.onFrame({ yuv: f });
      const gl = this.gl;
      this.size(f.width, f.height);
      const p = yuvMatrix(f);
      const { deep } = p;
      const cw = f.cw === undefined ? 1 : f.cw;
      const chh = f.ch === undefined ? 1 : f.ch;
      const pw = (f.width + (1 << cw) - 1) >> cw;
      const ph = (f.height + (1 << chh) - 1) >> chh;
      const planes = [[f.width, f.height], [pw, ph], [pw, ph]];
      const data16 = deep ? new Uint16Array(f.data.buffer, f.data.byteOffset, f.data.byteLength >> 1) : null;
      for (let i = 0; i < 3; i++) {
        gl.activeTexture(gl.TEXTURE0 + i);
        this.plane(i, planes[i][0], planes[i][1], deep);
        if (deep) {
          gl.pixelStorei(gl.UNPACK_ROW_LENGTH, f.layout[i].stride >> 1);
          gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, planes[i][0], planes[i][1],
            gl.RED, gl.UNSIGNED_SHORT, data16, f.layout[i].offset >> 1);
        } else {
          gl.pixelStorei(gl.UNPACK_ROW_LENGTH, f.layout[i].stride);
          gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, planes[i][0], planes[i][1],
            gl.RED, gl.UNSIGNED_BYTE, f.data, f.layout[i].offset);
        }
      }
      gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
      // The planes are on the GPU: the decoder can reuse this buffer.
      // Give the previous frame's buffer back, not this one: the pixel inspector and compare mode
      // still read the shown frame's planes, and a paused redraw uploads the same frame again.
      if (this.onUploaded) {
        const buf = f.recycle ? f.data.buffer : null;
        if (this.heldBuf && this.heldBuf !== buf) this.onUploaded(this.heldBuf);
        this.heldBuf = buf;
      }
      // Samples arrive normalized to the texture range; rescale n-bit values to 0..1.
      gl.uniform1f(this.uScale, p.scale);
      gl.uniformMatrix3fv(this.uM, false, p.m);
      gl.uniform3fv(this.uOff, p.off);
      this.setTransfer(f.trc, f.prim);
      gl.uniform1i(this.uMode, 0);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      if (this.twin) this.twin(f);
    }

    /**
     * HDR (PQ 16 / HLG 18) is tone-mapped to SDR in the shader: linear light, BT.2020 -> BT.709
     * primaries (AVCOL_PRI 9), BT.2390 EETF from the content peak (default 1000 nits) to
     * 203 nits = SDR white, BT.1886 encode. Anything else draws exactly as before.
     * @param {number | undefined} trc
     * @param {number | undefined} prim
     */
    setTransfer(trc, prim) {
      if (this.disposed) return;
      const tf = trc === 16 ? 1 : trc === 18 ? 2 : 0;
      const peak = tf === 1 && this.hdrPeak > 203 ? this.hdrPeak : 1000;
      const key = `${tf}/${prim}/${peak}`;
      this.hdr = tf ? /** @type {number} */ (trc) : 0;
      if (key === this.hdrKey) return;
      this.hdrKey = key;
      const gl = this.gl;
      const t = transferParams(trc, prim, this.hdrPeak);
      gl.uniform1i(this.uTf, t.tf);
      if (!t.tf) return;
      gl.uniform3fv(this.uEetf, t.eetf);
      // Column-major: BT.2020 -> BT.709 (ITU-R BT.2087), identity for other primaries.
      gl.uniformMatrix3fv(this.uPrim, false, t.prim);
    }

    /** A VideoFrame from WebCodecs (already RGB-ready). @param {VideoFrameLike} vf */
    drawFrame(vf) {
      if (this.disposed) return;
      if (this.onFrame) this.onFrame({ vf });
      const gl = this.gl;
      this.size(vf.displayWidth, vf.displayHeight);
      gl.activeTexture(gl.TEXTURE3);
      gl.bindTexture(gl.TEXTURE_2D, this.tex[3]);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, vf);
      gl.uniform1f(this.uScale, 1);
      gl.uniform1i(this.uMode, 1);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      if (this.twin) this.twin(null);
    }

    /**
     * Idempotently frees textures, buffers, shaders and program, and clears capture/recycle hooks.
     * @param {{ loseContext?: boolean }} [opts]
     */
    dispose(opts) {
      if (this.onFrame) {
        const fn = this.onFrame;
        this.onFrame = null;
        fn(null);
      }
      this.onUploaded = null;
      this.heldBuf = null;
      this.twin = null;
      const gl = this.gl;
      if (!this.disposed) {
        this.disposed = true;
        if (gl) {
          if (this.tex) {
            for (const t of this.tex) if (t && typeof gl.deleteTexture === 'function') gl.deleteTexture(t);
            this.tex = [];
          }
          if (this.planeKeys) this.planeKeys.length = 0;
          if (this.buf && typeof gl.deleteBuffer === 'function') {
            gl.deleteBuffer(this.buf);
            this.buf = null;
          }
          if (this.shaders && typeof gl.deleteShader === 'function') {
            for (const s of this.shaders) if (s) gl.deleteShader(s);
            this.shaders = [];
          }
          if (this.prog && typeof gl.deleteProgram === 'function') {
            gl.deleteProgram(this.prog);
            this.prog = null;
          }
        }
      }
      if (opts && opts.loseContext && gl && typeof gl.getExtension === 'function') {
        gl.getExtension('WEBGL_lose_context')?.loseContext();
      }
    }
  }

  /**
   * @param {HTMLCanvasElement | { width: number, height: number, getContext: (id: 'webgl2', opts: any) => any }} cv
   */
  function create(cv) {
    return new GLRenderer(cv);
  }

  const api = {
    GLRenderer,
    create,
    setCapture,
    matrixBySize,
    yuvMatrix,
    transferParams,
    BT2020_TO_709_COL_MAJOR,
    IDENTITY_3X3,
  };
  // @ts-ignore The webview has no CommonJS globals.
  if (typeof module === 'object' && module.exports) module.exports = api;
  else /** @type {typeof globalThis & { VpeGlRenderer?: typeof api }} */ (globalThis).VpeGlRenderer = api;
})();
// checkJs: end
