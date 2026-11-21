/* global matrixBySize */
// @ts-check
// Video scopes for the player: luma waveform, RGB parade, vectorscope and histogram
// of the displayed frame (W cycles them, then off). The frame is sampled at about
// 256 columns: a nearest-neighbour blit of the WebGL canvas into a small framebuffer
// on the GPU, one small readPixels, then binning on the CPU. Updates at ~10 Hz while
// playing and at once when a paused frame changes. Loaded before player.js.
// The pure helpers at the top are also loaded by the Node tests.
'use strict';

/* exported VpeScopes */
// eslint-disable-next-line no-unused-vars
const VpeScopes = (() => {
  const COLS = 256; // sampled columns
  const MODES = ['waveform', 'parade', 'vector', 'histogram'];
  const NAMES = { waveform: 'Luma waveform', parade: 'RGB parade', vector: 'Vectorscope', histogram: 'Histogram' };

  /** Luma weights (Kr, Kg, Kb) for the displayed signal. */
  const weights = (m) => m === 601 ? [0.299, 0.587, 0.114] : m === 2020 ? [0.2627, 0.678, 0.0593] : [0.2126, 0.7152, 0.0722];

  /** 8-bit limited-range code value (16..235) of a 0..1 signal, unclamped and rounded. */
  const code = (v) => Math.round(16 + 219 * v);

  /** Size of the sample grid for a w×h picture: COLS wide (fewer for narrow pictures), height in proportion, at most 256. */
  function sampleSize(w, h) {
    const sw = Math.max(1, Math.min(COLS, w));
    const sh = Math.max(1, Math.min(256, Math.round((sw * h) / Math.max(1, w))));
    return [sw, sh];
  }

  /**
   * Bins an RGBA sample grid (top row first) for the scopes in `need` (default all):
   *  wave: luma code values per column (cols × 256 counts, index col * 256 + level)
   *  parade: same for R, G, B ([3][cols × 256])
   *  vec: 256 × 256 counts of (Cb, Cr) at 0.5 → radius 120, with the summed RGB of each cell for colour
   *  hist: 256-bin counts of R, G, B and luma (full-range 0..255 display values)
   * @param {Uint8Array|Uint8ClampedArray} px
   * @param {string[]} [need] 'waveform', 'parade', 'vector', 'histogram'
   */
  function analyse(px, w, h, matrix, need = MODES) {
    const [kr, kg, kb] = weights(matrix);
    const doWave = need.includes('waveform');
    const doParade = need.includes('parade');
    const doVec = need.includes('vector');
    const doHist = need.includes('histogram');
    const wave = doWave ? new Uint32Array(w * 256) : null;
    const parade = doParade ? [new Uint32Array(w * 256), new Uint32Array(w * 256), new Uint32Array(w * 256)] : null;
    const vec = doVec ? new Uint32Array(256 * 256) : null;
    const vecRgb = doVec ? new Float32Array(256 * 256 * 3) : null;
    const hist = doHist ? [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)] : null;
    // Lookup tables: each channel's share of luma, and 8-bit value -> code value.
    const lr = new Float32Array(256); const lg = new Float32Array(256); const lb = new Float32Array(256);
    const cv = new Uint8Array(256);
    for (let v = 0; v < 256; v++) { lr[v] = (kr * v) / 255; lg[v] = (kg * v) / 255; lb[v] = (kb * v) / 255; cv[v] = code(v / 255); }
    const cbK = 240 / (2 * (1 - kb));
    const crK = 240 / (2 * (1 - kr));
    const n = w * h;
    for (let i = 0, x = 0; i < n; i++, x = x + 1 === w ? 0 : x + 1) {
      const o = i * 4;
      const R = px[o]; const G = px[o + 1]; const B = px[o + 2];
      const Y = lr[R] + lg[G] + lb[B];
      if (doWave) wave[x * 256 + Math.min(255, (16.5 + 219 * Y) | 0)]++;
      if (doParade) { parade[0][x * 256 + cv[R]]++; parade[1][x * 256 + cv[G]]++; parade[2][x * 256 + cv[B]]++; }
      if (doVec) {
        const vx = Math.max(0, Math.min(255, Math.floor(128.5 + (B / 255 - Y) * cbK)));
        const vy = Math.max(0, Math.min(255, Math.floor(128.5 - (R / 255 - Y) * crK)));
        const vi = vy * 256 + vx;
        vec[vi]++;
        vecRgb[vi * 3] += R; vecRgb[vi * 3 + 1] += G; vecRgb[vi * 3 + 2] += B;
      }
      if (doHist) { hist[0][R]++; hist[1][G]++; hist[2][B]++; hist[3][Math.min(255, (Y * 255 + 0.5) | 0)]++; }
    }
    return { w, h, matrix, wave, parade, vec, vecRgb, hist };
  }

  /** Vectorscope cell (x, y in 0..255) of an RGB colour (0..1): Cb right, Cr up, 0.5 at radius 240/2. */
  function vectorXY(r, g, b, matrix) {
    const [kr, kg, kb] = weights(matrix);
    const Y = kr * r + kg * g + kb * b;
    const cb = (b - Y) / (2 * (1 - kb));
    const cr = (r - Y) / (2 * (1 - kr));
    return [128 + cb * 240, 128 - cr * 240];
  }

  /** 75 % colour-bar targets (R, Yl, G, Cy, B, Mg) in vectorscope cells. */
  function targets75(matrix) {
    const L = 0.75;
    return [['R', L, 0, 0], ['Yl', L, L, 0], ['G', 0, L, 0], ['Cy', 0, L, L], ['B', 0, 0, L], ['Mg', L, 0, L]]
      .map(([name, r, g, b]) => { const [x, y] = vectorXY(/** @type {number} */ (r), /** @type {number} */ (g), /** @type {number} */ (b), matrix); return { name, x, y, rgb: [r, g, b] }; });
  }

  /** Levels in one waveform column that hold at least `minShare` of its samples, ascending. */
  function columnLevels(wave, col, minShare = 0.05) {
    let total = 0;
    for (let l = 0; l < 256; l++) total += wave[col * 256 + l];
    const out = [];
    for (let l = 0; l < 256; l++) if (total && wave[col * 256 + l] / total >= minShare) out.push(l);
    return out;
  }

  // ---- in the webview ---------------------------------------------------------

  /**
   * @param {{stage: HTMLElement, canvas: HTMLCanvasElement, getPlayer: () => any, toast: Function, log: Function}} env
   */
  function create(env) {
    const { stage, canvas, getPlayer, toast, log } = env;
    const getExact = env.getExact || (() => null); // the exact picture of the paused frame (media/exactframe.js), or null
    const panel = document.createElement('div');
    panel.id = 'scopes';
    panel.hidden = true;
    const title = document.createElement('div');
    title.className = 'scopesTitle';
    const view = document.createElement('canvas');
    view.width = 512;
    view.height = 288;
    panel.append(title, view);
    stage.appendChild(panel);
    const vctx = /** @type {CanvasRenderingContext2D} */ (view.getContext('2d'));
    const img = document.createElement('canvas'); // the binned picture, before scaling and graticule
    const ictx = /** @type {CanvasRenderingContext2D} */ (img.getContext('2d'));

    let mode = -1; // index into MODES, -1 off
    let lastAt = 0;
    let lastKey = '';
    let last = null; // last analysis (tests read it)
    const perf = { n: 0, ms: 0, max: 0, sample: 0, bin: 0, draw: 0 };

    // GPU sampling: blit the canvas (nearest) into a small renderbuffer, read it into a
    // pixel-pack buffer and fence; the bytes are fetched once the GPU is done (a later
    // animation frame), so the main thread never waits for the GPU.
    let gpu = null;
    let pending = null;
    function gpuStart(gl, sw, sh) {
      if (!gpu || gpu.gl !== gl || gpu.w !== sw || gpu.h !== sh) {
        if (gpu && gpu.gl === gl) { gl.deleteFramebuffer(gpu.fb); gl.deleteRenderbuffer(gpu.rb); gl.deleteBuffer(gpu.pbo); }
        const fb = gl.createFramebuffer();
        const rb = gl.createRenderbuffer();
        const pbo = gl.createBuffer();
        const prevRb = gl.getParameter(gl.RENDERBUFFER_BINDING);
        gl.bindRenderbuffer(gl.RENDERBUFFER, rb);
        gl.renderbufferStorage(gl.RENDERBUFFER, gl.RGBA8, sw, sh);
        gl.bindRenderbuffer(gl.RENDERBUFFER, prevRb);
        const prevFb = gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING);
        gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, fb);
        gl.framebufferRenderbuffer(gl.DRAW_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, rb);
        gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, prevFb);
        const prevPack = gl.getParameter(gl.PIXEL_PACK_BUFFER_BINDING);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo);
        gl.bufferData(gl.PIXEL_PACK_BUFFER, sw * sh * 4, gl.STREAM_READ);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, prevPack);
        gpu = { gl, fb, rb, pbo, w: sw, h: sh, buf: new Uint8Array(sw * sh * 4), out: new Uint8Array(sw * sh * 4) };
      }
      const prevRead = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING);
      const prevDraw = gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING);
      const prevPack = gl.getParameter(gl.PIXEL_PACK_BUFFER_BINDING);
      const scissor = gl.isEnabled(gl.SCISSOR_TEST);
      if (scissor) gl.disable(gl.SCISSOR_TEST);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, gpu.fb);
      gl.blitFramebuffer(0, 0, canvas.width, canvas.height, 0, 0, sw, sh, gl.COLOR_BUFFER_BIT, gl.NEAREST);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, gpu.fb);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, gpu.pbo);
      gl.readPixels(0, 0, sw, sh, gl.RGBA, gl.UNSIGNED_BYTE, 0);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, prevPack);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, prevRead);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, prevDraw);
      if (scissor) gl.enable(gl.SCISSOR_TEST);
      const fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
      gl.flush();
      return { gl, fence, sw, sh, at: performance.now() };
    }

    /** The pixels of a finished GPU read (top row first), null while the GPU is busy, false when it failed. */
    function gpuFetch(pd) {
      const gl = pd.gl;
      const st = gl.clientWaitSync(pd.fence, 0, 0);
      if (st === gl.TIMEOUT_EXPIRED && performance.now() - pd.at < 1000) return null;
      gl.deleteSync(pd.fence);
      if (st === gl.TIMEOUT_EXPIRED || st === gl.WAIT_FAILED || !gpu || gpu.gl !== gl || gpu.w !== pd.sw || gpu.h !== pd.sh) return false;
      const prevPack = gl.getParameter(gl.PIXEL_PACK_BUFFER_BINDING);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, gpu.pbo);
      gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, gpu.buf);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, prevPack);
      // GL rows start at the bottom.
      const row = pd.sw * 4;
      for (let r = 0; r < pd.sh; r++) gpu.out.set(gpu.buf.subarray((pd.sh - 1 - r) * row, (pd.sh - r) * row), r * row);
      return gpu.out;
    }

    // Frame players (MJPEG, sequences) draw with a 2D context: scale down with drawImage.
    let cpu = null;
    function cpuSample(sw, sh, src = canvas) {
      if (!cpu) {
        const c = document.createElement('canvas');
        cpu = { c, ctx: /** @type {CanvasRenderingContext2D} */ (c.getContext('2d', { willReadFrequently: true })) };
      }
      if (cpu.c.width !== sw || cpu.c.height !== sh) { cpu.c.width = sw; cpu.c.height = sh; }
      cpu.ctx.imageSmoothingEnabled = false;
      cpu.ctx.drawImage(src, 0, 0, sw, sh);
      return cpu.ctx.getImageData(0, 0, sw, sh).data;
    }

    /** Starts a sample of the shown frame; false when none could start (nothing shown, or one is still in flight). */
    function update() {
      const p = getPlayer();
      if (!p || !canvas.width || !canvas.height || pending) return false;
      const t0 = performance.now();
      const [sw, sh] = sampleSize(canvas.width, canvas.height);
      const gl = p.gl && p.gl.gl;
      const job = { mode: MODES[mode], matrix: p.shownMatrix ? p.shownMatrix(true) : matrixBySize(canvas.width, canvas.height), sw, sh };
      try {
        if (gl && gl.fenceSync && !getExact()) {
          pending = Object.assign(gpuStart(gl, sw, sh), job, { ms: performance.now() - t0 });
          return true;
        }
        const ex = getExact();
        finish(cpuSample(sw, sh, ex ? ex.img : canvas), job, performance.now() - t0);
      } catch (e) { log(`scopes: ${e && e.message}`); pending = null; return false; }
      return true;
    }

    function poll() {
      if (!pending) return;
      const t0 = performance.now();
      let px;
      try { px = gpuFetch(pending); } catch (e) { log(`scopes: ${e && e.message}`); px = false; }
      if (px === null) return;
      const job = pending;
      pending = null;
      if (px) finish(px, job, job.ms + performance.now() - t0);
    }

    function finish(px, job, sampleMs) {
      const t1 = performance.now();
      last = analyse(px, job.sw, job.sh, job.matrix, [job.mode]);
      const t2 = performance.now();
      if (mode >= 0 && MODES[mode] === job.mode) draw(last);
      const t3 = performance.now();
      const ms = sampleMs + t3 - t1;
      perf.n++; perf.ms += ms; perf.max = Math.max(perf.max, ms);
      perf.sample += sampleMs; perf.bin += t2 - t1; perf.draw += t3 - t2;
    }

    // ---- drawing ----------------------------------------------------------------
    const css = (name, fb) => (getComputedStyle(panel).getPropertyValue(name).trim() || fb);

    /** Brightness of a bin: a few hits are visible, a full column saturates. */
    const glow = (n, ref) => (n ? Math.min(1, 0.35 + Math.sqrt(n / ref)) : 0);
    /** Paints a dot of (dx0..dx1, dy0..dy1) cells around (x, y), keeping the brighter value per channel. */
    function dot(d, W, H, x, y, r, g, b, dx0, dx1, dy0, dy1) {
      for (let yy = Math.max(0, y + dy0); yy <= Math.min(H - 1, y + dy1); yy++) {
        for (let xx = Math.max(0, x + dx0); xx <= Math.min(W - 1, x + dx1); xx++) {
          const o = (yy * W + xx) * 4;
          if (r > d[o]) d[o] = r;
          if (g > d[o + 1]) d[o + 1] = g;
          if (b > d[o + 2]) d[o + 2] = b;
          d[o + 3] = 255;
        }
      }
    }

    /** A cleared ImageData of w×h, reused between updates. */
    let idCache = null;
    function imageData(w, h) {
      if (!idCache || idCache.width !== w || idCache.height !== h) idCache = ictx.createImageData(w, h);
      else idCache.data.fill(0);
      return idCache;
    }

    function drawWave(a, chans) {
      const W = a.w * chans.length;
      if (img.width !== W || img.height !== 256) { img.width = W; img.height = 256; }
      const id = imageData(W, 256);
      const d = id.data;
      const ref = Math.max(4, a.h * 0.25);
      const tint = chans.length === 1 ? [[150, 255, 170]] : [[255, 70, 70], [70, 255, 90], [80, 140, 255]];
      chans.forEach((bins, ci) => {
        const [tr, tg, tb] = tint[ci];
        for (let x = 0; x < a.w; x++) {
          for (let l = 0; l < 256; l++) {
            const n = bins[x * 256 + l];
            if (!n) continue;
            const g = glow(n, ref);
            dot(d, W, 256, ci * a.w + x, 255 - l, tr * g, tg * g, tb * g, 0, 0, -1, 0);
          }
        }
      });
      ictx.putImageData(id, 0, 0);
      const pad = 26;
      const gw = view.width - pad - 4;
      const gh = view.height - 8;
      vctx.imageSmoothingEnabled = true;
      vctx.drawImage(img, pad, 4, gw, gh);
      // Graticule: 0, 16, 235, 255 (8-bit code values).
      const fg = css('--scope-fg', '#ccc');
      vctx.font = '10px var(--vscode-editor-font-family, monospace)';
      vctx.textBaseline = 'middle';
      for (const [lv, strong] of [[0, false], [16, true], [128, false], [235, true], [255, false]]) {
        const y = Math.round(4 + ((255 - /** @type {number} */ (lv)) / 255) * gh) + 0.5;
        vctx.strokeStyle = strong ? 'rgba(255, 200, 80, 0.75)' : 'rgba(160, 160, 160, 0.35)';
        vctx.setLineDash(strong ? [] : [3, 3]);
        vctx.beginPath(); vctx.moveTo(pad, y); vctx.lineTo(pad + gw, y); vctx.stroke();
        vctx.fillStyle = fg;
        vctx.fillText(String(lv), 2, Math.max(8, Math.min(view.height - 6, y)));
      }
      vctx.setLineDash([]);
      if (chans.length === 3) {
        vctx.strokeStyle = 'rgba(160, 160, 160, 0.5)';
        for (let i = 1; i < 3; i++) { const x = Math.round(pad + (gw * i) / 3) + 0.5; vctx.beginPath(); vctx.moveTo(x, 4); vctx.lineTo(x, 4 + gh); vctx.stroke(); }
      }
    }

    function drawVector(a) {
      if (img.width !== 256 || img.height !== 256) { img.width = 256; img.height = 256; }
      const id = imageData(256, 256);
      const d = id.data;
      const ref = Math.max(2, (a.w * a.h) / 2000);
      for (let i = 0; i < 65536; i++) {
        const n = a.vec[i];
        if (!n) continue;
        const g = glow(n, ref);
        // Each point in its own colour, lifted so dark colours show.
        const r = a.vecRgb[i * 3] / n; const gg = a.vecRgb[i * 3 + 1] / n; const b = a.vecRgb[i * 3 + 2] / n;
        const lift = 255 / Math.max(64, r, gg, b);
        dot(d, 256, 256, i & 255, i >> 8, r * lift * g, gg * lift * g, b * lift * g, -1, 1, -1, 1);
      }
      ictx.putImageData(id, 0, 0);
      const S = view.height - 8;
      const x0 = (view.width - S) / 2;
      const y0 = 4;
      const k = S / 256;
      vctx.imageSmoothingEnabled = true;
      vctx.drawImage(img, x0, y0, S, S);
      const cx = x0 + 128 * k;
      const cy = y0 + 128 * k;
      vctx.strokeStyle = 'rgba(160, 160, 160, 0.45)';
      vctx.beginPath(); vctx.arc(cx, cy, 120 * k, 0, Math.PI * 2); vctx.stroke();
      vctx.beginPath(); vctx.moveTo(cx - 120 * k, cy); vctx.lineTo(cx + 120 * k, cy); vctx.moveTo(cx, cy - 120 * k); vctx.lineTo(cx, cy + 120 * k); vctx.stroke();
      // Skin-tone line (about 123° from +Cb).
      const sk = (123 * Math.PI) / 180;
      vctx.setLineDash([3, 3]);
      vctx.beginPath(); vctx.moveTo(cx, cy); vctx.lineTo(cx + Math.cos(sk) * 120 * k, cy - Math.sin(sk) * 120 * k); vctx.stroke();
      vctx.setLineDash([]);
      // 75 % targets.
      vctx.font = '10px var(--vscode-editor-font-family, monospace)';
      vctx.textBaseline = 'middle';
      const fg = css('--scope-fg', '#ccc');
      for (const t of targets75(a.matrix)) {
        const x = x0 + t.x * k;
        const y = y0 + t.y * k;
        vctx.strokeStyle = 'rgba(255, 200, 80, 0.85)';
        vctx.strokeRect(Math.round(x - 5) + 0.5, Math.round(y - 5) + 0.5, 10, 10);
        vctx.fillStyle = fg;
        const dx = x - cx; const dy = y - cy; const len = Math.hypot(dx, dy) || 1;
        vctx.fillText(t.name, x + (dx / len) * 14 - 6, y + (dy / len) * 14);
      }
      vctx.fillStyle = fg;
      vctx.fillText(`BT.${a.matrix} · 75 %`, 4, view.height - 10);
    }

    function drawHist(a) {
      const pad = 4;
      const gw = view.width - 2 * pad;
      const gh = view.height - 2 * pad;
      let max = 1;
      // Scale to the tallest bin, ignoring the end bins (clipped black/white would flatten the rest).
      for (const h of a.hist) for (let i = 1; i < 255; i++) max = Math.max(max, h[i]);
      const cols = ['rgba(255, 70, 70, 0.55)', 'rgba(70, 255, 90, 0.55)', 'rgba(80, 140, 255, 0.55)'];
      vctx.globalCompositeOperation = 'lighter';
      a.hist.slice(0, 3).forEach((h, ci) => {
        vctx.fillStyle = cols[ci];
        vctx.beginPath();
        vctx.moveTo(pad, pad + gh);
        for (let i = 0; i < 256; i++) vctx.lineTo(pad + (i / 255) * gw, pad + gh - Math.min(1, h[i] / max) * gh);
        vctx.lineTo(pad + gw, pad + gh);
        vctx.closePath();
        vctx.fill();
      });
      vctx.globalCompositeOperation = 'source-over';
      vctx.strokeStyle = 'rgba(235, 235, 235, 0.9)';
      vctx.beginPath();
      for (let i = 0; i < 256; i++) { const x = pad + (i / 255) * gw; const y = pad + gh - Math.min(1, a.hist[3][i] / max) * gh; if (i) vctx.lineTo(x, y); else vctx.moveTo(x, y); }
      vctx.stroke();
      vctx.strokeStyle = 'rgba(160, 160, 160, 0.35)';
      vctx.setLineDash([3, 3]);
      for (const q of [0.25, 0.5, 0.75]) { const x = Math.round(pad + q * gw) + 0.5; vctx.beginPath(); vctx.moveTo(x, pad); vctx.lineTo(x, pad + gh); vctx.stroke(); }
      vctx.setLineDash([]);
    }

    function draw(a) {
      vctx.clearRect(0, 0, view.width, view.height);
      const m = MODES[mode];
      if (m === 'waveform') drawWave(a, [a.wave]);
      else if (m === 'parade') drawWave(a, a.parade);
      else if (m === 'vector') drawVector(a);
      else drawHist(a);
    }

    function setMode(i) {
      mode = i;
      panel.hidden = mode < 0;
      lastKey = '';
      lastAt = 0;
      if (mode >= 0) {
        title.textContent = `${NAMES[MODES[mode]]}  (W: next)`;
        vctx.clearRect(0, 0, view.width, view.height);
        if (update()) lastKey = 'started';
      }
      toast(mode < 0 ? 'Scopes off' : NAMES[MODES[mode]]);
    }
    const cycle = () => setMode(mode + 1 >= MODES.length ? -1 : mode + 1);

    /** From the player's frame loop: ~10 Hz while playing, at once when a paused frame changes. */
    function tick(now) {
      poll();
      if (mode < 0) return;
      const p = getPlayer();
      if (!p) return;
      const key = `${p.currentFrame()}|${p.shownCount || p.shown}|${canvas.width}x${canvas.height}${getExact() ? '|exact' : ''}`;
      if (p.isPlaying()) {
        if (now - lastAt < 100) return;
      } else if (key === lastKey) return;
      if (!update()) return; // busy: try again next frame
      lastAt = now;
      lastKey = key;
    }

    return {
      cycle, tick, setMode: (name) => setMode(name ? MODES.indexOf(name) : -1),
      mode: () => (mode < 0 ? null : MODES[mode]),
      analysis: () => last,
      perf: () => { const k = perf.n || 1; return { updates: perf.n, avgMs: perf.ms / k, maxMs: perf.max, sampleMs: perf.sample / k, binMs: perf.bin / k, drawMs: perf.draw / k }; },
    };
  }

  return { create, analyse, sampleSize, vectorXY, targets75, columnLevels, code, MODES };
})();

if (typeof module !== 'undefined') module.exports = VpeScopes;
