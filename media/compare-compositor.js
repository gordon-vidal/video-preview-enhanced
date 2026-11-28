// @ts-check
// WebGL helpers for Compare's metrics, and the tiles' renderers (one shared beyond four tiles).
'use strict';

(() => {
  // checkJs: start
  const VS = `#version 300 es
    in vec2 p; out vec2 uv; uniform float flip;
    void main() { uv = vec2(p.x * 0.5 + 0.5, 0.5 - flip * p.y * 0.5); gl_Position = vec4(p, 0.0, 1.0); }`;

  /** @param {WebGL2RenderingContext} gl */
  function glProgram(gl, fsSrc) {
    const sh = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || 'shader');
      return s;
    };
    const prog = gl.createProgram();
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, fsSrc));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) || 'link');
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'p');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0);
    const u = (n) => gl.getUniformLocation(prog, n);
    return { prog, u };
  }
  /** @param {WebGL2RenderingContext} gl */
  function glTexture(gl, unit, filter) {
    const t = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, t);
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, filter], [gl.TEXTURE_MAG_FILTER, filter], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
    return t;
  }

  /**
   * WebGL renderers for a page's video tiles. Chromium keeps 16 WebGL contexts per page and silently loses the oldest
   * beyond that, so the first `maxOwn` live tiles get a renderer of their own and every further tile shares one
   * renderer on a scratch canvas: its picture is drawn there and copied into the tile's canvas (a 2D canvas, no
   * context of its own). With more than four tiles each picture is capped so all of them hold one 4K picture
   * (media/compare-grid.js texturePixels).
   * @param {{ doc: any, Grid: any, maxOwn?: number }} o
   */
  function createTileRenderers({ doc, Grid, maxOwn = 4 }) {
    const own = new Set();
    let shared = /** @type {any} */ (null);
    let scratch = /** @type {any} */ (null);
    let users = 0;
    const maxPixels = () => Grid.texturePixels(own.size + users);
    /** A renderer of its own on `cv`, its context lost when the tile goes. */
    function ownRenderer(Renderer, cv) {
      const r = new Renderer(cv);
      Object.defineProperty(r, 'maxPixels', { get: maxPixels, set() {}, configurable: true });
      own.add(r);
      const dispose = r.dispose.bind(r);
      r.dispose = (/** @type {any} */ opts) => { own.delete(r); dispose({ ...(opts || {}), loseContext: true }); };
      return r;
    }
    function sharedRenderer(Renderer, cv) {
      const ctx = cv.getContext('2d', { alpha: false });
      if (!ctx) return ownRenderer(Renderer, cv);
      if (!shared) {
        scratch = doc.createElement('canvas');
        shared = new Renderer(scratch);
      }
      const renderer = shared;
      users++;
      let rotation = 0;
      let held = /** @type {any} */ (null);
      let gone = false;
      const out = {
        cv, gl: null, norm16: renderer.norm16, hdrPeak: 0, hdr: 0,
        onUploaded: /** @type {any} */ (null), onFrame: /** @type {any} */ (null), twin: /** @type {any} */ (null),
        get rot() { return rotation; },
        setRotation(/** @type {number} */ deg) { rotation = [90, 180, 270].includes(deg) ? deg : 0; },
        prepareNative(/** @type {number} */ w, /** @type {number} */ h) {
          const r = rotation % 180 ? [h, w] : [w, h];
          const c = Grid.capSize(r[0], r[1], maxPixels());
          if (cv.width !== c.w || cv.height !== c.h) { cv.width = c.w; cv.height = c.h; }
        },
        drawYuv(/** @type {any} */ f) { draw(() => renderer.drawYuv(f)); },
        drawFrame(/** @type {any} */ vf) { draw(() => renderer.drawFrame(vf)); },
        dispose() {
          if (out.onFrame) {
            const fn = out.onFrame;
            out.onFrame = null;
            fn(null);
          }
          out.onUploaded = null;
          out.twin = null;
          held = null;
          if (gone) return;
          gone = true;
          users--;
          if (!users && shared === renderer) {
            shared.dispose({ loseContext: true });
            shared = scratch = null;
          }
        },
      };
      /** @param {() => void} render */
      const draw = (render) => {
        if (gone || renderer.disposed) return;
        renderer.setRotation(rotation);
        renderer.maxPixels = maxPixels();
        renderer.hdrPeak = out.hdrPeak;
        renderer.heldBuf = held;
        renderer.onUploaded = out.onUploaded;
        renderer.onFrame = out.onFrame;
        renderer.twin = out.twin;
        render();
        renderer.onFrame = null;
        renderer.twin = null;
        held = renderer.heldBuf;
        renderer.heldBuf = null;
        out.hdr = renderer.hdr;
        const src = renderer.cv;
        if (cv.width !== src.width || cv.height !== src.height) { cv.width = src.width; cv.height = src.height; }
        ctx.drawImage(src, 0, 0);
      };
      return out;
    }
    return {
      /** For media/engine.js's env.createRenderer. @param {any} Renderer media/gl-renderer.js GLRenderer @param {any} cv */
      create(Renderer, cv) { return own.size < maxOwn ? ownRenderer(Renderer, cv) : sharedRenderer(Renderer, cv); },
      /** 1 while the shared renderer's WebGL context is open (each own renderer's is its tile's p.gl.gl). */
      get sharedContexts() { return shared ? 1 : 0; },
    };
  }

  const api = { createTileRenderers, glProgram, glTexture };
  const commonJs = /** @type {{ exports?: typeof api } | undefined} */ (
    // @ts-ignore The webview has no CommonJS globals.
    typeof module === 'undefined' ? undefined : module
  );
  if (commonJs) commonJs.exports = api;
  else /** @type {typeof globalThis & { VpeCompareCompositor?: typeof api }} */ (globalThis).VpeCompareCompositor = api;
  // checkJs: end
})();
