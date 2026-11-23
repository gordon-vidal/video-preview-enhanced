// @ts-check
// Compare tile textures and the shared WebGL renderer for large grids.
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

  // Each tile is drawn into its own rectangle of the stage-sized canvas (viewport), the split's second
  // tile clipped to the right of the divider (scissor). Tile i's picture is texture slot i.
  const DRAW_FS = `#version 300 es
    precision highp float;
    in vec2 uv; out vec4 o; uniform sampler2D t; uniform vec4 win;
    void main() { o = vec4(texture(t, win.xy + uv * win.zw).rgb, 1.0); }`;

  class Compositor {
    /** @param {HTMLCanvasElement} cv */
    constructor(cv, slots, grid) {
      const gl = cv.getContext('webgl2', { preserveDrawingBuffer: true, alpha: false, antialias: false });
      if (!gl) throw new Error('WebGL2 is not available');
      this.gl = gl;
      this.cv = cv;
      this.grid = grid;
      this.renderer = null;
      this.scratch = null;
      const { u } = glProgram(gl, DRAW_FS);
      gl.uniform1i(u('t'), 0);
      gl.uniform1f(u('flip'), 1);
      this.uwin = u('win'); // the part of the picture a rectangle shows (zoomed in, only a crop of it is on screen)
      this.tex = [];
      this.size = [];
      for (let i = 0; i < slots; i++) {
        // Mipmapped: a 4K picture in a 960-pixel cell is averaged, not sampled every fourth pixel.
        const t = glTexture(gl, 0, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
        this.tex.push(t);
        this.size.push([0, 0]);
      }
    }
    get contextCount() { return 1 + Number(!!this.renderer); }
    hasPicture(slot) { return !!this.size[slot][0]; }

    /** Uploads tile `slot`'s engine canvas. */
    upload(slot, src) {
      const gl = this.gl;
      if (!src.width || !src.height || slot >= this.tex.length) return;
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.tex[slot]);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
      gl.generateMipmap(gl.TEXTURE_2D);
      this.size[slot] = [src.width, src.height];
    }
    /**
     * @param {number} w canvas width (device pixels)
     * @param {number} h canvas height
     * @param {{slot: number, x: number, y: number, w: number, h: number, clipX?: number, win?: number[], nearest?: boolean}[]} rects device pixels from the top left
     */
    draw(w, h, rects) {
      const gl = this.gl;
      if (this.cv.width !== w || this.cv.height !== h) { this.cv.width = w; this.cv.height = h; }
      gl.disable(gl.SCISSOR_TEST);
      gl.viewport(0, 0, w, h);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.activeTexture(gl.TEXTURE0);
      for (const r of rects) {
        if (!this.size[r.slot][0] || r.w < 1 || r.h < 1) continue;
        const y = h - r.y - r.h;
        gl.bindTexture(gl.TEXTURE_2D, this.tex[r.slot]);
        // Enlarged to twice or more: single pixels, as the player's nearest-neighbour zoom.
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, r.nearest ? gl.NEAREST : gl.LINEAR);
        const w4 = r.win || [0, 0, 1, 1];
        gl.uniform4f(this.uwin, w4[0], w4[1], w4[2], w4[3]);
        gl.viewport(Math.round(r.x), Math.round(y), Math.round(r.w), Math.round(r.h));
        if (r.clipX !== undefined) {
          gl.enable(gl.SCISSOR_TEST);
          gl.scissor(Math.round(r.clipX), Math.round(y), Math.max(0, Math.round(r.x + r.w - r.clipX)), Math.round(r.h));
        } else gl.disable(gl.SCISSOR_TEST);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      }
      gl.disable(gl.SCISSOR_TEST);
    }
    // A WebGL context per engine plus the compositor's would pass Chromium's 16 per page (the oldest is
    // lost). From 5 tiles on, one renderer on a scratch canvas draws each tile's frame when its engine
    // shows it, and the result goes straight into that tile's compositor texture; the engine's own
    // canvas only keeps the size (no context). Buffer recycling and colour state stay per tile.
    sharedRenderer(Renderer, cv, slot) {
      const { grid } = this;
      let { renderer, scratch } = this;
      if (!renderer) {
        scratch = this.scratch = this.cv.ownerDocument.createElement('canvas');
        renderer = this.renderer = new Renderer(scratch);
        renderer.maxPixels = grid.texturePixels(this.tex.length); // all tiles' textures together: one 4K picture
      }
      let rotation = 0;
      let held = null;
      const out = {
        norm16: renderer.norm16, hdrPeak: 0, hdr: 0, onUploaded: null, onFrame: null, twin: null, gl: null,
        get rot() { return rotation; },
        setRotation(deg) { rotation = [90, 180, 270].includes(deg) ? deg : 0; },
        prepareNative(w, h) {
          const r = rotation % 180 ? [h, w] : [w, h];
          const c = grid.capSize(r[0], r[1], renderer ? renderer.maxPixels : 0);
          if (cv.width !== c.w || cv.height !== c.h) { cv.width = c.w; cv.height = c.h; }
        },
        drawYuv(f) { draw(() => renderer.drawYuv(f)); },
        drawFrame(vf) { draw(() => renderer.drawFrame(vf)); },
        dispose() {
          if (out.onFrame) {
            const fn = out.onFrame;
            out.onFrame = null;
            fn(null);
          }
          out.onUploaded = null;
          out.twin = null;
          held = null;
        },
      };
      const draw = (render) => {
        if (!this.renderer) return;
        renderer.setRotation(rotation);
        renderer.hdrPeak = out.hdrPeak;
        renderer.heldBuf = held;
        renderer.onUploaded = out.onUploaded;
        renderer.onFrame = out.onFrame;
        render();
        renderer.onFrame = null;
        held = renderer.heldBuf;
        out.hdr = renderer.hdr;
        if (cv.width !== scratch.width || cv.height !== scratch.height) { cv.width = scratch.width; cv.height = scratch.height; }
        this.upload(slot, scratch);
      };
      return out;
    }
    dispose() {
      this.renderer?.dispose({ loseContext: true });
      this.renderer = this.scratch = null;
      this.gl.getExtension('WEBGL_lose_context')?.loseContext();
    }
  }

  const api = { Compositor, glProgram, glTexture };
  const commonJs = /** @type {{ exports?: typeof api } | undefined} */ (
    // @ts-ignore The webview has no CommonJS globals.
    typeof module === 'undefined' ? undefined : module
  );
  if (commonJs) commonJs.exports = api;
  else /** @type {typeof globalThis & { VpeCompareCompositor?: typeof api }} */ (globalThis).VpeCompareCompositor = api;
  // checkJs: end
})();
