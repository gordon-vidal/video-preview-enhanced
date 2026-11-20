// @ts-check
// HDR output (docs/notes/hdr-output.md): colour maths for PQ / HLG to the canvas's extended range,
// the decision between real HDR output and tone mapping to SDR, and a probe of what the page can do.
// Used by the webview (engine.js, player.js) and by Node tests (test/host/hdr_math_test.js).
'use strict';

(function (root) {
  // ---- SMPTE ST 2084 (PQ) and ARIB STD-B67 / BT.2100 (HLG) -----------------------------------
  const M1 = 0.1593017578125;
  const M2 = 78.84375;
  const C1 = 0.8359375;
  const C2 = 18.8515625;
  const C3 = 18.6875;
  /** PQ signal (0..1) -> display light in nits (0..10000). */
  function pqEotf(e) {
    const p = Math.max(e, 0) ** (1 / M2);
    return 10000 * (Math.max(p - C1, 0) / (C2 - C3 * p)) ** (1 / M1);
  }
  /** Nits -> PQ signal. */
  function pqInverse(n) {
    const p = (Math.max(n, 0) / 10000) ** M1;
    return ((C1 + C2 * p) / (1 + C3 * p)) ** M2;
  }
  const HA = 0.17883277;
  const HB = 0.28466892; // 1 - 4a
  const HC = 0.55991073; // 0.5 - a ln(4a)
  /** HLG signal (0..1) -> normalised scene light (0..1), BT.2100 inverse OETF. */
  function hlgInverseOetf(e) {
    e = Math.min(Math.max(e, 0), 1);
    return e <= 0.5 ? (e * e) / 3 : (Math.exp((e - HC) / HA) + HB) / 12;
  }
  /** HLG system gamma for a display of `peak` nits (BT.2100: 1.2 at 1000 nits). */
  const hlgGamma = (peak) => 1.2 + 0.42 * Math.log10(peak / 1000);
  /**
   * HLG signal RGB (BT.2020) -> display light in nits on a `peak`-nit display: inverse OETF,
   * then the OOTF (luminance to the power gamma - 1 scales all three channels).
   */
  function hlgToNits(rgb, peak = 1000) {
    const e = rgb.map(hlgInverseOetf);
    const y = 0.2627 * e[0] + 0.678 * e[1] + 0.0593 * e[2];
    const k = peak * Math.max(y, 1e-6) ** (hlgGamma(peak) - 1);
    return e.map((v) => k * v);
  }

  // ---- Primaries ---------------------------------------------------------------------------
  // Row-major 3x3, linear light. BT.2020 -> BT.709 is ITU-R BT.2087; BT.2020 -> Display P3 (D65)
  // from the primaries' XYZ matrices (computed in test/host/hdr_math_test.js and checked there).
  const BT2020_TO_709 = [
    [1.6604910, -0.5876411, -0.0728499],
    [-0.1245505, 1.1328999, -0.0083494],
    [-0.0181508, -0.1005789, 1.1187297],
  ];
  const BT2020_TO_P3 = [
    [1.3435783, -0.2821797, -0.0613986],
    [-0.0652975, 1.0757879, -0.0104905],
    [0.0028218, -0.0195985, 1.0167767],
  ];
  /** BT.709 primaries (PQ / HLG video tagged BT.709, rare) -> Display P3. */
  const BT709_TO_P3 = [
    [0.8224620, 0.1775380, 0],
    [0.0331942, 0.9668058, 0],
    [0.0170826, 0.0723974, 0.9105199],
  ];
  const mul = (m, v) => m.map((r) => r[0] * v[0] + r[1] * v[1] + r[2] * v[2]);
  /** Column-major for gl.uniformMatrix3fv. */
  const colMajor = (m) => [m[0][0], m[1][0], m[2][0], m[0][1], m[1][1], m[2][1], m[0][2], m[1][2], m[2][2]];

  // ---- Extended-range output ---------------------------------------------------------------
  /** HDR reference white (BT.2408): drawn at the display's SDR white, 1.0 in the canvas. */
  const REF_WHITE = 203;
  /** sRGB transfer, extended to the whole real line (sign kept, values above 1 continue the curve). */
  function srgbEncodeExt(x) {
    const a = Math.abs(x);
    const y = a <= 0.0031308 ? 12.92 * a : 1.055 * a ** (1 / 2.4) - 0.055;
    return x < 0 ? -y : y;
  }
  /**
   * The value the canvas gets for one pixel: display-light nits in BT.2020 -> the canvas's
   * primaries (BT.709 for 'srgb', P3 for 'display-p3'), relative to reference white (1.0 = 203
   * nits = SDR white; 4.93 = 1000 nits), then the sRGB transfer (extended) that both predefined
   * canvas colour spaces use. Negative values (outside the canvas gamut) are kept: the extended
   * float canvas carries them, as scRGB does.
   */
  function nitsToCanvas(nits2020, space = 'display-p3') {
    const lin = mul(space === 'srgb' ? BT2020_TO_709 : BT2020_TO_P3, nits2020).map((v) => v / REF_WHITE);
    return lin.map(srgbEncodeExt);
  }
  /** A PQ or HLG BT.2020 signal (non-linear R'G'B', 0..1) -> canvas values (see nitsToCanvas). */
  function signalToCanvas(rgb, trc, space = 'display-p3', hlgPeak = 1000) {
    const nits = trc === 16 ? rgb.map(pqEotf) : hlgToNits(rgb, hlgPeak);
    return nitsToCanvas(nits, space);
  }

  // ---- Decision ----------------------------------------------------------------------------
  /**
   * Whether to show HDR content as HDR. setting: videoPreviewEnhanced.hdrOutput ('auto' | 'off');
   * caps: the probe (displayHdr: the display reports high dynamic range; api: an output path that
   * works here, or ''); force: test override. Returns { on, why }.
   */
  function decide(setting, caps, force) {
    if (force) return { on: !!(caps && caps.api), why: caps && caps.api ? 'forced (test)' : 'forced, but no HDR canvas here' };
    if (setting === 'off') return { on: false, why: 'setting off' };
    if (!caps) return { on: false, why: 'not probed' };
    if (!caps.displayHdr) return { on: false, why: 'the display is SDR' };
    if (!caps.api) return { on: false, why: 'no HDR canvas in this editor' };
    return { on: true, why: 'HDR display' };
  }

  /**
   * Dolby Vision from the stream's configuration record ({ profile, compat }: dv_profile and
   * dv_bl_signal_compatibility_id). Players without Dolby's decoder show the base layer: HDR10
   * (compatibility 1, or 6 for profile 7's Blu-ray layer), HLG (4) or SDR (2). Profile 5 and
   * others with compatibility 0 have no such layer (IPT-PQ-c2 needs the RPU reshaping): not shown.
   */
  function dolbyVision(dv) {
    if (!dv || !(dv.profile >= 0)) return null;
    const c = dv.compat | 0;
    const base = c === 1 || c === 6 ? 'HDR10' : c === 4 ? 'HLG' : c === 2 ? 'SDR' : '';
    return { profile: dv.profile, compat: c, base, supported: !!base, label: `Dolby Vision ${dv.profile}${base ? `.${c}` : ''}` };
  }

  /** The info and stats text for an HDR picture's output: "HDR output" or "HDR tone-mapped to SDR". */
  const outputLabel = (on) => (on ? 'HDR output' : 'HDR tone-mapped to SDR');

  // ---- The page: what it can do ------------------------------------------------------------
  /** WebGL 2 with a float16 drawing buffer in display-p3 and extended tone mapping (null: not here). */
  function webglHdr(gl) {
    const g = /** @type {any} */ (gl);
    const out = { colorSpace: 'drawingBufferColorSpace' in g, storage: typeof g.drawingBufferStorage === 'function', toneMapping: typeof g.drawingBufferToneMapping === 'function', format: 0, ok: false, error: '' };
    try {
      if (out.storage) {
        g.drawingBufferStorage(g.RGBA16F, g.drawingBufferWidth || 1, g.drawingBufferHeight || 1);
        out.format = g.drawingBufferFormat || 0;
      }
      if (out.colorSpace) g.drawingBufferColorSpace = 'display-p3';
      if (out.toneMapping) g.drawingBufferToneMapping({ mode: 'extended' });
      out.ok = out.storage && out.format === g.RGBA16F && out.toneMapping && g.drawingBufferColorSpace === 'display-p3';
    } catch (e) { out.error = String(e && e.message || e).slice(0, 200); }
    return out;
  }

  /**
   * Everything the page reports about HDR output (no side effects on the player's canvas).
   * displayHdr: (dynamic-range: high). api: 'webgl' when WebGL takes a float16 buffer with
   * extended tone mapping, 'webgpu' when a WebGPU canvas does, else ''.
   */
  async function probe() {
    const r = /** @type {any} */ ({});
    const mq = (q) => { try { return matchMedia(q).matches; } catch { return null; } };
    r.ua = navigator.userAgent;
    r.dynamicRange = mq('(dynamic-range: high)') ? 'high' : 'standard';
    r.videoDynamicRange = mq('(video-dynamic-range: high)') ? 'high' : 'standard';
    r.gamut = ['srgb', 'p3', 'rec2020'].filter((g) => mq(`(color-gamut: ${g})`));
    const scr = /** @type {any} */ (screen);
    r.screen = { colorDepth: scr.colorDepth, pixelDepth: scr.pixelDepth, dpr: devicePixelRatio, hdrHeadroom: scr.highDynamicRangeHeadroom, hdr: scr.isHighDynamicRange };
    r.secure = self.isSecureContext;
    r.isolated = self.crossOriginIsolated;
    const fp = /** @type {any} */ (document).featurePolicy || /** @type {any} */ (document).permissionsPolicy;
    r.policy = fp && fp.allowsFeature ? { webgpu: safe(() => fp.allowsFeature('webgpu')), features: safe(() => fp.features().filter((f) => /gpu|xr|hdr|display/.test(f))) } : null;
    // WebGL 2
    try {
      const c = document.createElement('canvas');
      c.width = c.height = 4;
      const gl = c.getContext('webgl2');
      if (gl) {
        const dbg = gl.getExtension('WEBGL_debug_renderer_info');
        r.webgl = { renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER), floatBuffer: !!gl.getExtension('EXT_color_buffer_float'), ...webglHdr(gl) };
        const h = /** @type {any} */ (HTMLCanvasElement.prototype);
        r.webgl.canvasConfigureHdr = typeof h.configureHighDynamicRange === 'function';
        r.webgl.unpackColorSpace = 'unpackColorSpace' in gl;
      } else r.webgl = null;
    } catch (e) { r.webgl = { error: String(e) }; }
    // 2D canvas with float16 storage
    try {
      const c = document.createElement('canvas');
      const ctx = /** @type {any} */ (c.getContext('2d', /** @type {any} */ ({ colorSpace: 'display-p3', colorType: 'float16' })));
      const a = ctx && ctx.getContextAttributes ? ctx.getContextAttributes() : {};
      r.canvas2d = { colorSpace: a.colorSpace, colorType: a.colorType || a.pixelFormat };
    } catch (e) { r.canvas2d = { error: String(e) }; }
    // WebGPU
    const gpu = /** @type {any} */ (navigator).gpu;
    r.webgpu = { present: !!gpu };
    if (gpu) {
      try {
        r.webgpu.preferredFormat = gpu.getPreferredCanvasFormat();
        r.webgpu.wgsl = gpu.wgslLanguageFeatures ? [...gpu.wgslLanguageFeatures] : [];
        const adapter = await withTimeout(gpu.requestAdapter(), 5000);
        if (!adapter) r.webgpu.adapter = null;
        else {
          const info = adapter.info || (adapter.requestAdapterInfo ? await adapter.requestAdapterInfo() : {});
          r.webgpu.adapter = { vendor: info.vendor, architecture: info.architecture, description: info.description, device: info.device, fallback: adapter.isFallbackAdapter || info.isFallbackAdapter, features: [...adapter.features].filter((f) => /float16|shader-f16|rg11|norm16|texture-formats-tier/.test(f)) };
          const device = await withTimeout(adapter.requestDevice(), 5000);
          const c = document.createElement('canvas');
          c.width = c.height = 4;
          const ctx = c.getContext('webgpu');
          r.webgpu.context = !!ctx;
          if (ctx && device) {
            ctx.configure({ device, format: 'rgba16float', colorSpace: 'display-p3', toneMapping: { mode: 'extended' }, alphaMode: 'opaque' });
            const cfg = ctx.getConfiguration ? ctx.getConfiguration() : null;
            r.webgpu.configured = cfg ? { format: cfg.format, colorSpace: cfg.colorSpace, toneMapping: cfg.toneMapping ? cfg.toneMapping.mode : '(not returned)' } : '(no getConfiguration)';
            r.webgpu.extended = !!(cfg && cfg.toneMapping && cfg.toneMapping.mode === 'extended' && cfg.format === 'rgba16float');
            r.webgpu.glCopy = await glToGpuCopy(device).catch((e) => ({ error: String(e && e.message || e).slice(0, 300) }));
            device.destroy();
          }
        }
      } catch (e) { r.webgpu.error = String(e && e.message || e).slice(0, 300); }
    }
    r.displayHdr = r.dynamicRange === 'high';
    r.api = r.webgl && r.webgl.ok ? 'webgl' : r.webgpu.extended ? 'webgpu' : '';
    return r;
  }
  /**
   * Does a float16 WebGL canvas keep values above 1 (and below 0) when WebGPU copies it
   * (copyExternalImageToTexture)? Clears a display-p3 RGBA16F WebGL buffer to (2, 0.5, -0.25),
   * copies it into an rgba16float texture and reads that back.
   */
  async function glToGpuCopy(device) {
    const c = document.createElement('canvas');
    c.width = c.height = 4;
    const gl = /** @type {any} */ (c.getContext('webgl2', { preserveDrawingBuffer: true, alpha: false, antialias: false }));
    gl.drawingBufferStorage(gl.RGBA16F, 4, 4);
    gl.drawingBufferColorSpace = 'display-p3';
    gl.clearColor(2, 0.5, -0.25, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const glPx = new Float32Array(4);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.FLOAT, glPx);
    const GU = /** @type {any} */ (self).GPUTextureUsage;
    const tex = device.createTexture({ size: [4, 4], format: 'rgba16float', usage: GU.COPY_DST | GU.COPY_SRC | GU.RENDER_ATTACHMENT | GU.TEXTURE_BINDING });
    device.queue.copyExternalImageToTexture({ source: c }, { texture: tex, colorSpace: 'display-p3' }, [4, 4]);
    const buf = device.createBuffer({ size: 256 * 4, usage: /** @type {any} */ (self).GPUBufferUsage.COPY_DST | /** @type {any} */ (self).GPUBufferUsage.MAP_READ });
    const enc = device.createCommandEncoder();
    enc.copyTextureToBuffer({ texture: tex }, { buffer: buf, bytesPerRow: 256 }, [4, 4]);
    device.queue.submit([enc.finish()]);
    await buf.mapAsync(/** @type {any} */ (self).GPUMapMode.READ);
    const h = new Uint16Array(buf.getMappedRange().slice(0, 8));
    const half = (x) => { const s = x >> 15 ? -1 : 1; const e = (x >> 10) & 31; const f = x & 1023; return e === 0 ? s * f * 2 ** -24 : e === 31 ? (f ? NaN : s * Infinity) : s * (1 + f / 1024) * 2 ** (e - 15); };
    return { gl: [...glPx].map((v) => +v.toFixed(3)), gpu: [...h].map((v) => +half(v).toFixed(3)) };
  }
  // ---- The player's HDR output --------------------------------------------------------------
  let started = null;
  /**
   * Once per page: should HDR pictures be shown as HDR here? setting 'off' or an SDR display
   * answers at once without touching WebGPU (the SDR setups stay as they were); otherwise a WebGPU
   * device and a canvas with extended tone mapping are tried. Resolves { on, why, device, caps }.
   */
  function start(setting, force) {
    if (started) return started;
    started = (async () => {
      const quick = { displayHdr: matchMedia('(dynamic-range: high)').matches, api: '' };
      if (!force && (setting === 'off' || !quick.displayHdr)) return { ...decide(setting, quick, false), device: null, caps: quick };
      const caps = { ...quick, api: '' };
      let device = null;
      try {
        const gpu = /** @type {any} */ (navigator).gpu;
        const adapter = gpu && await withTimeout(gpu.requestAdapter(), 5000);
        device = adapter && await withTimeout(adapter.requestDevice(), 5000);
        if (device) {
          const c = document.createElement('canvas');
          const ctx = /** @type {any} */ (c.getContext('webgpu'));
          ctx.configure(gpuConfig(device));
          const cfg = ctx.getConfiguration ? ctx.getConfiguration() : null;
          if (cfg && cfg.toneMapping && cfg.toneMapping.mode === 'extended' && cfg.format === 'rgba16float') caps.api = 'webgpu';
          ctx.unconfigure();
        }
      } catch (e) { caps.error = String(e && e.message || e).slice(0, 200); }
      const d = decide(setting, caps, force);
      if (!d.on && device) { device.destroy(); device = null; }
      return { ...d, device, caps };
    })();
    return started;
  }
  /** The output canvas: float16, Display P3, values above 1.0 shown brighter than SDR white. */
  function gpuConfig(device) {
    return { device, format: 'rgba16float', colorSpace: 'display-p3', toneMapping: { mode: 'extended' }, alphaMode: 'opaque' };
  }

  /**
   * The YUV -> R'G'B' conversion of a decoded picture, as GLRenderer.drawYuv does it (engine.js):
   * scale takes raw n-bit sample values to 0..1, then rgb = m * (yuv * scale - off). m is
   * column-major. HDR (PQ / HLG, deeper than 8 bits) uses exact n-bit levels (64..940 at 10-bit).
   * f: { width, height, depth, fullRange, space (601 / 709 / 2020), trc }.
   */
  function yuvParams(f) {
    const depth = f.depth || 8;
    const deep = depth > 8;
    const space = f.space || (f.width >= 1280 || f.height >= 720 ? 709 : 601);
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
      scale: 1 / ((1 << depth) - 1),
      m: [ys, ys, ys, 0, -gu, bu, rv, -gv, 0],
      off: f.fullRange ? [0, 128 * lv / q, 128 * lv / q] : [16 * lv / q, 128 * lv / q, 128 * lv / q],
    };
  }

  // WGSL: raw samples (r8uint / r16uint, bilinear by hand like WebGL's LINEAR + CLAMP_TO_EDGE),
  // YUV -> R'G'B' (yuvParams), PQ / HLG -> nits, primaries to Display P3, / 203, extended sRGB curve.
  const WGSL = `
struct U { m: mat3x3f, prim: mat3x3f, off: vec3f, scale: f32, tf: i32, rot: i32, pad0: i32, pad1: i32 };
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var ty: texture_2d<u32>;
@group(0) @binding(2) var tu: texture_2d<u32>;
@group(0) @binding(3) var tv: texture_2d<u32>;
struct VO { @builtin(position) pos: vec4f, @location(0) uv: vec2f };
@vertex fn vs(@builtin(vertex_index) i: u32) -> VO {
  var ps = array<vec2f, 4>(vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0), vec2f(1.0, 1.0));
  let p = ps[i];
  let d = vec2f(p.x * 0.5 + 0.5, 0.5 - p.y * 0.5);
  var uv = d;
  if (u.rot == 90) { uv = vec2f(d.y, 1.0 - d.x); }
  else if (u.rot == 180) { uv = vec2f(1.0 - d.x, 1.0 - d.y); }
  else if (u.rot == 270) { uv = vec2f(1.0 - d.y, d.x); }
  var o: VO;
  o.pos = vec4f(p, 0.0, 1.0);
  o.uv = uv;
  return o;
}
fn samp(t: texture_2d<u32>, uv: vec2f) -> f32 {
  let sz = vec2i(textureDimensions(t));
  let f = uv * vec2f(sz) - 0.5;
  let fl = floor(f);
  let w = f - fl;
  let i0 = vec2i(fl);
  let mx = sz - vec2i(1, 1);
  let a = f32(textureLoad(t, clamp(i0, vec2i(0, 0), mx), 0).r);
  let b = f32(textureLoad(t, clamp(i0 + vec2i(1, 0), vec2i(0, 0), mx), 0).r);
  let c = f32(textureLoad(t, clamp(i0 + vec2i(0, 1), vec2i(0, 0), mx), 0).r);
  let e = f32(textureLoad(t, clamp(i0 + vec2i(1, 1), vec2i(0, 0), mx), 0).r);
  return mix(mix(a, b, w.x), mix(c, e, w.x), w.y);
}
fn pqToNits(e: vec3f) -> vec3f {
  let p = pow(max(e, vec3f(0.0)), vec3f(1.0 / 78.84375));
  return 10000.0 * pow(max(p - 0.8359375, vec3f(0.0)) / (18.8515625 - 18.6875 * p), vec3f(1.0 / 0.1593017578125));
}
@fragment fn fs(i: VO) -> @location(0) vec4f {
  let yuv = vec3f(samp(ty, i.uv), samp(tu, i.uv), samp(tv, i.uv)) * u.scale - u.off;
  let c = clamp(u.m * yuv, vec3f(0.0), vec3f(1.0));
  var L: vec3f;
  if (u.tf == 1) { L = pqToNits(c); }
  else {
    let lo = c * c / 3.0;
    let hi = (exp((c - 0.55991073) / 0.17883277) + 0.28466892) / 12.0;
    let e = select(lo, hi, c > vec3f(0.5));
    L = 1000.0 * pow(max(dot(vec3f(0.2627, 0.678, 0.0593), e), 1e-6), 0.2) * e;
  }
  let x = u.prim * L / 203.0;
  let a = abs(x);
  let s = select(12.92 * a, 1.055 * pow(a, vec3f(1.0 / 2.4)) - 0.055, a > vec3f(0.0031308));
  return vec4f(sign(x) * s, 1.0);
}`;

  /**
   * Shows HDR pictures over the player's canvas. The player's WebGL canvas keeps drawing the
   * tone-mapped SDR picture (the pixel tools, scopes, thumbnails and export read it). WebGPU
   * uploads the same YUV planes and draws the HDR values (WGSL above) into an extended-range
   * float16 Display P3 canvas laid exactly over the player's canvas. (Copying a float16 WebGL
   * canvas into WebGPU clamps to 0..1 at 8 bits in VS Code 1.147, so WebGL can't draw it.)
   */
  class Output {
    constructor(device, under) {
      this.device = device;
      this.under = under;
      const c = document.createElement('canvas');
      c.className = 'hdr-out';
      c.setAttribute('aria-hidden', 'true');
      Object.assign(c.style, { position: 'absolute', pointerEvents: 'none', left: '0', top: '0', margin: '0', maxWidth: 'none', maxHeight: 'none', transform: 'none' });
      c.hidden = true;
      under.after(c);
      this.canvas = c;
      this.ctx = /** @type {any} */ (c.getContext('webgpu'));
      this.configured = false;
      this.frames = 0;
      const module = device.createShaderModule({ code: WGSL });
      this.pipeline = device.createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: 'vs' },
        fragment: { module, entryPoint: 'fs', targets: [{ format: 'rgba16float' }] },
        primitive: { topology: 'triangle-strip' },
      });
      const g = /** @type {any} */ (self);
      this.ubuf = device.createBuffer({ size: 128, usage: g.GPUBufferUsage.UNIFORM | g.GPUBufferUsage.COPY_DST });
      this.planes = [null, null, null];
      this.keys = ['', '', ''];
      this.bind = null;
    }

    /** One decoded picture (the GLRenderer.drawYuv frame), turned by rot degrees clockwise. */
    draw(f, rot) {
      const dev = this.device;
      const g = /** @type {any} */ (self);
      const depth = f.depth || 8;
      const deep = depth > 8;
      const cw = f.cw === undefined ? 1 : f.cw;
      const chh = f.ch === undefined ? 1 : f.ch;
      const pw = (f.width + (1 << cw) - 1) >> cw;
      const ph = (f.height + (1 << chh) - 1) >> chh;
      const sizes = [[f.width, f.height], [pw, ph], [pw, ph]];
      let rebind = !this.bind;
      for (let i = 0; i < 3; i++) {
        const [w, h] = sizes[i];
        const key = `${w}x${h}${deep ? 'u16' : 'u8'}`;
        if (this.keys[i] !== key) {
          if (this.planes[i]) this.planes[i].destroy();
          this.planes[i] = dev.createTexture({ size: [w, h], format: deep ? 'r16uint' : 'r8uint', usage: g.GPUTextureUsage.TEXTURE_BINDING | g.GPUTextureUsage.COPY_DST });
          this.keys[i] = key;
          rebind = true;
        }
        const L = f.layout[i];
        dev.queue.writeTexture({ texture: this.planes[i] }, f.data.buffer, { offset: f.data.byteOffset + L.offset, bytesPerRow: L.stride, rowsPerImage: h }, [w, h]);
      }
      if (rebind) {
        this.bind = dev.createBindGroup({
          layout: this.pipeline.getBindGroupLayout(0),
          entries: [{ binding: 0, resource: { buffer: this.ubuf } }, ...this.planes.map((t, i) => ({ binding: i + 1, resource: t.createView() }))],
        });
      }
      const p = yuvParams(f);
      const prim = colMajor(f.prim === 9 ? BT2020_TO_P3 : BT709_TO_P3);
      const ab = new ArrayBuffer(128);
      const fl = new Float32Array(ab);
      const it = new Int32Array(ab);
      for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) { fl[c * 4 + r] = p.m[c * 3 + r]; fl[12 + c * 4 + r] = prim[c * 3 + r]; }
      fl.set(p.off, 24);
      fl[27] = p.scale;
      it[28] = f.trc === 16 ? 1 : 2;
      it[29] = [90, 180, 270].includes(rot) ? rot : 0;
      dev.queue.writeBuffer(this.ubuf, 0, ab);
      const turned = it[29] === 90 || it[29] === 270;
      const W = turned ? f.height : f.width;
      const H = turned ? f.width : f.height;
      const cv = this.canvas;
      if (cv.width !== W || cv.height !== H || !this.configured) {
        cv.width = W;
        cv.height = H;
        this.ctx.configure(gpuConfig(dev));
        this.configured = true;
      }
      this.place();
      cv.hidden = this.under.hidden;
      this.render(this.ctx.getCurrentTexture());
      this.frames++;
    }

    render(texture) {
      const enc = this.device.createCommandEncoder();
      const pass = enc.beginRenderPass({ colorAttachments: [{ view: texture.createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }] });
      pass.setPipeline(this.pipeline);
      pass.setBindGroup(0, this.bind);
      pass.draw(4);
      pass.end();
      this.device.queue.submit([enc.finish()]);
    }

    /** Lay the output over the player's canvas (zoom and pan move that one: follow its box). */
    place() {
      const u = this.under;
      const p = /** @type {HTMLElement} */ (u.parentElement);
      if (!p) return;
      const r = u.getBoundingClientRect();
      const pr = p.getBoundingClientRect();
      const s = this.canvas.style;
      const left = `${r.left - pr.left - p.clientLeft + p.scrollLeft}px`;
      const top = `${r.top - pr.top - p.clientTop + p.scrollTop}px`;
      if (s.left !== left) s.left = left;
      if (s.top !== top) s.top = top;
      if (s.width !== `${r.width}px`) s.width = `${r.width}px`;
      if (s.height !== `${r.height}px`) s.height = `${r.height}px`;
      if (s.imageRendering !== u.style.imageRendering) s.imageRendering = u.style.imageRendering;
    }

    hide() { this.canvas.hidden = true; }

    /** Tests: the last picture's output values at pts ([x, y] canvas pixels): drawn again into a texture and read back. */
    async read(pts) {
      if (!this.bind) return [];
      const g = /** @type {any} */ (self);
      const W = this.canvas.width;
      const H = this.canvas.height;
      const tex = this.device.createTexture({ size: [W, H], format: 'rgba16float', usage: g.GPUTextureUsage.RENDER_ATTACHMENT | g.GPUTextureUsage.COPY_SRC });
      this.render(tex);
      const out = [];
      for (const [x, y] of pts) {
        const buf = this.device.createBuffer({ size: 256, usage: g.GPUBufferUsage.COPY_DST | g.GPUBufferUsage.MAP_READ });
        const enc = this.device.createCommandEncoder();
        enc.copyTextureToBuffer({ texture: tex, origin: [Math.min(W - 1, x), Math.min(H - 1, y)] }, { buffer: buf, bytesPerRow: 256 }, [1, 1]);
        this.device.queue.submit([enc.finish()]);
        await buf.mapAsync(g.GPUMapMode.READ);
        const h = new Uint16Array(buf.getMappedRange().slice(0, 8));
        out.push([0, 1, 2].map((i) => +half(h[i]).toFixed(4)));
        buf.destroy();
      }
      tex.destroy();
      return out;
    }

    dispose() {
      try { this.ctx.unconfigure(); } catch { /* gone */ }
      for (const t of this.planes) if (t) t.destroy();
      this.ubuf.destroy();
      this.canvas.remove();
    }
  }

  const half = (x) => { const s = x >> 15 ? -1 : 1; const e = (x >> 10) & 31; const f = x & 1023; return e === 0 ? s * f * 2 ** -24 : e === 31 ? (f ? NaN : s * Infinity) : s * (1 + f / 1024) * 2 ** (e - 15); };

  /** Tests (debug hook 'hdrpixels'): the player's HDR output state and, when on, the output values at pts. */
  async function debugPixels(player, pts) {
    const o = player && player.hdrOutput;
    if (!o) return { state: null };
    const r = /** @type {any} */ ({ state: { on: o.on, why: o.why, frames: o.out ? o.out.frames : 0, hidden: o.out ? o.out.canvas.hidden : true } });
    if (!o.on) return r;
    const c = o.out.canvas;
    r.size = [c.width, c.height];
    r.out = await o.out.read(pts);
    r.outRect = [c.style.left, c.style.top, c.style.width, c.style.height];
    return r;
  }

  function safe(f) { try { return f(); } catch (e) { return String(e); } }
  function withTimeout(p, ms) { return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`timed out after ${ms} ms`)), ms))]); }

  const api = {
    pqEotf, pqInverse, hlgInverseOetf, hlgGamma, hlgToNits, srgbEncodeExt, nitsToCanvas, signalToCanvas,
    BT2020_TO_709, BT2020_TO_P3, BT709_TO_P3, REF_WHITE, mul, colMajor, decide, outputLabel, probe, webglHdr, start, Output, debugPixels, dolbyVision, yuvParams, WGSL,
  };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.VpeHdr = api;
}(typeof self !== 'undefined' ? self : this));
