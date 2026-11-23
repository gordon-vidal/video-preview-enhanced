// @ts-check
// Codec X-ray: a strip above the seek bar with one bar per video packet (height =
// size, colour = picture type I/P/B), a bitrate line, chapter ticks on the seek
// bar, and keys to step between keyframes and chapters.
//
// The packet index comes from xray-worker.js (its own libav.js instance, demux
// only), which reads the file through the engine's block cache as reader 'xray'.
// The file is indexed in time segments: the ones in view, nearest the playhead
// first, reading on without seeking while the next one is wanted. For big files a
// view indexes at most a byte budget (2 GB local, 256 MB remote): beyond it only
// every m-th segment is read (a stride), and zooming in fills the gaps.
//
// Keys: Shift+X strip on/off, { } previous/next keyframe, PageUp/PageDown
// previous/next chapter. Over the strip: hover for details, click to go to the
// frame, wheel to zoom, Shift+wheel to pan, double-click to zoom out.
'use strict';

/* exported createXray */
// eslint-disable-next-line no-unused-vars
function createXray(env) {
  const { cfg, ui, getPlayer, fmtTime, toast, log } = env;
  const T_NAMES = ['?', 'I', 'P', 'B'];
  const T_LONG = ['unknown type', 'I (intra)', 'P (predicted)', 'B (bi-predicted)'];
  const SEG_MAX = 768; // segments over the whole file
  const SEG_MIN_S = 2; // shortest segment (s)
  const IDLE_STOP_MS = 15e3; // the index worker (a libav.js instance) ends this long after its last work while hidden

  // ---- DOM ----------------------------------------------------------------------
  const box = document.createElement('div');
  box.id = 'xray';
  box.hidden = true;
  const cv = document.createElement('canvas');
  const legend = document.createElement('div');
  legend.id = 'xrayLegend';
  const tip = document.createElement('div');
  tip.id = 'xrayTip';
  tip.hidden = true;
  box.append(cv, legend, tip);
  const seekRow = ui.seek.parentElement;
  seekRow.parentElement.insertBefore(box, seekRow);
  const ticks = document.createElement('div');
  ticks.id = 'xrayChapters';
  seekRow.append(ticks);

  // Theme colours (VS Code chart colours where the theme has them).
  let colors = null;
  function themeColors() {
    const cs = getComputedStyle(document.body);
    const v = (name, fb) => (cs.getPropertyValue(name) || '').trim() || fb;
    return {
      t: [v('--vscode-descriptionForeground', '#888'), v('--vscode-charts-red', '#e5534b'), v('--vscode-charts-blue', '#4493f8'), v('--vscode-charts-green', '#3fb950')],
      line: v('--vscode-charts-yellow', '#d29922'),
      fg: v('--vscode-foreground', '#ccc'),
      dim: v('--vscode-editorWidget-background', '#252526'),
    };
  }
  new MutationObserver(() => { colors = null; dirtyBase = true; }).observe(document.body, { attributes: true, attributeFilter: ['class'] });

  // ---- state --------------------------------------------------------------------
  let shown = false;
  let st = null; // index state for the current player
  let view = null; // [t0, t1] relative seconds, or null for the whole file
  let dirtyBase = true;
  let hoverX = -1;

  function newState(p) {
    return {
      p, worker: null, starting: false, opened: false, failed: false, base: 0, dur: 0, segDur: 0, nSeg: 0, segState: new Uint8Array(0),
      busy: false, prevSeg: -1, demand: new Set(), chapters: null, n: 0, cap: 0, pts: null, dts: null, fdur: null, size: null, key: null, pict: null,
      seen: new Map(), order: null, cum: null, keys: null, sortedAt: 0, sortGap: 250, dirty: false, pending: null, bytes: 0, eofSeg: Infinity,
    };
  }
  const player = () => {
    const p = getPlayer();
    if (!p || typeof p.onWorkerRead !== 'function') return null;
    if (!st || st.p !== p) { if (st) stop(); st = newState(p); view = null; dirtyBase = true; }
    return p;
  };
  const startT = () => (st && st.p.startT !== null && st.p.startT !== undefined ? st.p.startT : st ? st.base : 0);
  const duration = () => (st && (st.p.meta.duration || st.dur)) || 0;
  const fps = () => (st && (st.p.fps || st.idxFps)) || 0;
  const frameNo = (pts) => { const f = fps(); return f ? Math.max(0, Math.floor((pts - startT()) * f + 0.01)) + 1 : 0; };
  const curAbs = () => { const p = st.p; return p.shownT !== null && p.shownT !== undefined ? p.shownT : startT() + p.currentTime(); };

  // ---- index worker -------------------------------------------------------------------
  async function startIndex() {
    if (!st || st.worker || st.starting || st.failed) return;
    st.starting = true;
    const s = st;
    try {
      const e = cfg.engine || {};
      const [src, loader, toImport, wasmurl] = await workerBlobs(e);
      if (st !== s || s.worker) return;
      const w = new Worker(src);
      s.worker = w;
      // File reads share the engine's block cache (reader id 'xray').
      s.p.sideReaders = s.p.sideReaders || new Map();
      s.p.sideReaders.set('xray', w);
      w.onmessage = (ev) => onWorker(s, ev.data);
      w.onerror = (ev) => { log(`xray worker error: ${ev.message}`); s.failed = true; };
      w.postMessage({ type: 'init', loader, toImport, wasmurl, variant: e.variant });
    } catch (err) {
      log(`xray: start failed: ${err && err.stack || err}`);
      s.failed = true;
    } finally { s.starting = false; }
  }

  /** Worker and libav.js blob URLs: made once and shared by every start (they never change). */
  let blobs = null;
  function workerBlobs(e) {
    if (!blobs) {
      const wurl = e.xrayWorkerUrl || String(e.workerUrl || '').replace(/decoder-worker\.js(\?.*)?$/, 'xray-worker.js');
      const blobUrl = async (url, type) => {
        const r = await fetch(url);
        if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
        return URL.createObjectURL(new Blob([await r.arrayBuffer()], { type }));
      };
      const stem = e.loader.replace(/\.js$/, '');
      blobs = Promise.all([
        blobUrl(wurl, 'text/javascript'), blobUrl(e.loader, 'text/javascript'), blobUrl(`${stem}.wasm.js`, 'text/javascript'), blobUrl(`${stem}.wasm.wasm`, 'application/wasm'),
      ]);
      blobs.catch(() => { blobs = null; });
    }
    return blobs;
  }

  /**
   * Ends the index worker; the packet index stays. A later start (strip shown,
   * keyframe step) opens the file again and reads only the segments still missing.
   */
  function stopWorker(s) {
    clearTimeout(s.idleTimer);
    if (s.worker) s.worker.terminate();
    const p = s.p;
    if (p.sideReaders) p.sideReaders.delete('xray');
    p.dropBlockReader?.('xray');
    s.worker = null;
    s.opened = false;
    s.busy = false;
    for (let k = 0; k < s.segState.length; k++) if (s.segState[k] === 1) s.segState[k] = 0;
  }

  function stop() { if (st) stopWorker(st); }

  /** Nothing to index and the strip hidden: end the worker after a while (showing the strip or a keyframe step restarts it). */
  function idleLater(s) {
    clearTimeout(s.idleTimer);
    s.idleTimer = setTimeout(() => {
      if (st === s && s.worker && !shown && !s.busy && !s.pending && !s.demand.size) {
        log('xray: index worker idle, stopped');
        stopWorker(s);
      }
    }, IDLE_STOP_MS);
  }

  function onWorker(s, m) {
    if (s !== st) return;
    switch (m.type) {
      case 'ready': s.worker.postMessage({ type: 'open', size: s.p.meta.size }); break;
      case 'read': s.p.onWorkerRead(m.pos, m.len, 'xray'); break;
      case 'opened': {
        if (!m.video) { s.failed = true; stopWorker(s); break; }
        s.opened = true;
        s.codec = m.codec;
        s.base = m.first;
        s.dur = m.duration;
        if (m.chapters && m.chapters.length) s.chapters = m.chapters;
        const d = duration();
        const nSeg = d > 0 ? Math.max(1, Math.min(SEG_MAX, Math.ceil(d / SEG_MIN_S))) : 1;
        // A restarted worker keeps the segments already indexed.
        if (nSeg !== s.nSeg) { s.nSeg = nSeg; s.segState = new Uint8Array(nSeg); s.seen.clear(); }
        s.segDur = d > 0 ? d / s.nSeg : Infinity;
        log(`xray: indexing ${m.codec}, ${s.nSeg} segments of ${s.segDur.toFixed(2)} s`);
        if (s.pending) runPending();
        schedule();
        break;
      }
      case 'pk': ingest(s, m); break;
      case 'segdone':
        s.segState[m.id] = 2;
        s.busy = false;
        s.prevSeg = m.id;
        s.demand.delete(m.id);
        // The duration can be overestimated: nothing after the end of the file.
        if (m.eof) for (let k = m.id + 1; k < s.nSeg; k++) { s.segState[k] = 2; s.demand.delete(k); }
        forgetEdges(s, m.id, m.eof ? s.nSeg - 1 : m.id);
        dirtyBase = true;
        if (s.pending) runPending();
        schedule();
        break;
      case 'log': log(m.msg); break;
      case 'error':
        log(`xray worker ${m.where} error: ${m.message}`);
        if (m.where === 'seg') { s.segState[m.id] = 2; s.busy = false; forgetEdges(s, m.id, m.id); schedule(); } else { s.failed = true; stopWorker(s); }
        break;
      default: break;
    }
  }

  const segOf = (abs) => Math.max(0, Math.min(st.nSeg - 1, Math.floor((abs - st.base) / st.segDur)));
  const segT0 = (k) => st.base + k * st.segDur;
  const segDone = (k) => k < 0 || k >= st.nSeg || st.segState[k] === 2;

  /** Next segment to index: demanded ones first, then the view (strided for big files). */
  function pickSeg() {
    const s = st;
    const focus = segOf(curAbs());
    const nearest = (list) => {
      if (list.includes(s.prevSeg + 1)) return s.prevSeg + 1; // reads on without a seek
      let best = -1;
      for (const k of list) if (best < 0 || Math.abs(k - focus) < Math.abs(best - focus)) best = k;
      return best;
    };
    const dem = [...s.demand].filter((k) => !segDone(k) && s.segState[k] === 0);
    if (dem.length) return nearest(dem);
    if (!shown) return -1;
    const [v0, v1] = viewRange();
    const a = segOf(startT() + v0);
    const b = segOf(startT() + v1);
    const remote = !!(cfg.engine && cfg.engine.remote);
    const budget = remote ? 256e6 : 2e9;
    const segBytes = (s.p.meta.size || 0) / s.nSeg;
    const m = Math.max(1, Math.ceil(((b - a + 1) * segBytes) / budget));
    const list = [];
    for (let k = a; k <= b; k++) if (s.segState[k] === 0 && (m === 1 || k % m === 0)) list.push(k);
    s.stride = m;
    return list.length ? nearest(list) : -1;
  }

  function schedule() {
    const s = st;
    if (!s || !s.opened || s.busy || !s.worker) return;
    const k = pickSeg();
    if (k < 0) { if (!shown && !s.pending) idleLater(s); return; }
    clearTimeout(s.idleTimer);
    s.busy = true;
    s.segState[k] = 1;
    // Low priority: give playback the CPU, more so while decoding is behind.
    const p = s.p;
    const behind = p.behindUntil && performance.now() < p.behindUntil;
    const delay = p.isPlaying() ? (behind ? 500 : 40) : 0;
    setTimeout(() => {
      if (st !== s || !s.worker) return;
      s.worker.postMessage({ type: 'seg', id: k, t0: segT0(k), t1: k === s.nSeg - 1 ? null : segT0(k + 1) });
    }, delay);
  }

  function ingest(s, m) {
    const len = m.pts.length;
    if (s.n + len > s.cap) {
      const cap = Math.max(4096, (s.n + len) * 2);
      const grow = (a, T) => { const b = new T(cap); if (a) b.set(a.subarray(0, s.n)); return b; };
      s.pts = grow(s.pts, Float64Array); s.dts = grow(s.dts, Float64Array); s.fdur = grow(s.fdur, Float32Array);
      s.size = grow(s.size, Uint32Array); s.key = grow(s.key, Uint8Array); s.pict = grow(s.pict, Uint8Array);
      s.cap = cap;
    }
    for (let i = 0; i < len; i++) {
      const pts = m.pts[i];
      if (!isFinite(pts)) continue;
      // A packet near a segment boundary can come from both segments (MPEG-PS times
      // differ after a seek): one packet per pts and size. Kept per boundary, and
      // dropped once the segments on both sides are indexed (forgetEdges).
      const id = Math.round(pts * 1000) * 1000003 + (m.size[i] % 1000003);
      const edge = isFinite(s.segDur) ? Math.round((pts - s.base) / s.segDur) : 0;
      let seen = s.seen.get(edge);
      if (!seen) { seen = new Set(); s.seen.set(edge, seen); }
      if (seen.has(id)) continue;
      seen.add(id);
      const j = s.n++;
      s.pts[j] = pts; s.dts[j] = m.dts[i]; s.fdur[j] = m.dur[i]; s.size[j] = m.size[i]; s.key[j] = m.key[i]; s.pict[j] = m.pict[i];
      s.bytes += m.size[i];
    }
    s.dirty = true;
  }

  /** Segments k0..k1 are indexed: boundaries with indexed segments on both sides can get no more duplicates. */
  function forgetEdges(s, k0, k1) {
    for (const b of [...s.seen.keys()]) if (b >= k0 && b <= k1 + 1 && segDone(b - 1) && segDone(b)) s.seen.delete(b);
  }

  /** Presentation order, prefix sums of sizes and keyframe times (rebuilt at most 4x/s while loading). */
  function sorted(force) {
    const s = st;
    if (!s || !s.n) return false;
    if (s.dirty && (force || !s.order || performance.now() - s.sortedAt > s.sortGap)) {
      const c0 = performance.now();
      const n = s.n;
      const order = new Int32Array(n);
      for (let i = 0; i < n; i++) order[i] = i;
      const pts = s.pts;
      order.sort((a, b) => pts[a] - pts[b]);
      const cum = new Float64Array(n + 1);
      const keys = [];
      const opts = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        const j = order[i];
        opts[i] = pts[j];
        cum[i + 1] = cum[i] + s.size[j];
        if (s.key[j]) keys.push(pts[j]);
      }
      s.order = order;
      s.opts = opts; // pts in presentation order
      s.cum = cum;
      s.keys = Float64Array.from(keys);
      s.sn = n; // packets in the sorted arrays (more may have arrived since)
      // Frame rate from the index until the engine has one (same snapping as engine.js).
      if (n > 24 && !s.idxFps) {
        const d = [];
        for (let i = 1; i < Math.min(n, 200); i++) if (opts[i] - opts[i - 1] > 1e-4) d.push(opts[i] - opts[i - 1]);
        d.sort((x, y) => x - y);
        const f = d.length ? 1 / d[d.length >> 1] : 0;
        const near = [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60, 120].reduce((b, c) => (Math.abs(c - f) < Math.abs(b - f) ? c : b), 24);
        if (f > 0) s.idxFps = Math.abs(near - f) / near < 0.005 ? near : Math.round(f * 1000) / 1000;
      }
      s.dirty = false;
      s.sortedAt = performance.now();
      // Re-sort at most 4x/s, and spend at most ~5% of the time on it for big files.
      s.sortGap = Math.max(250, (s.sortedAt - c0) * 20);
      dirtyBase = true;
    }
    return !!s.order;
  }

  /** First index in sorted array a with a[i] >= x. */
  function lower(a, x, n = a.length) {
    let lo = 0;
    let hi = n;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (a[mid] < x) lo = mid + 1; else hi = mid; }
    return lo;
  }

  // ---- view ---------------------------------------------------------------------------
  function viewRange() {
    const d = duration() || 1;
    return view || [0, d];
  }
  function setView(v) {
    const d = duration();
    if (!d) return;
    if (!v) { view = null; dirtyBase = true; schedule(); return; }
    const minSpan = Math.max(0.2, 20 / (fps() || 30));
    let [a, b] = v;
    if (b - a < minSpan) { const c = (a + b) / 2; a = c - minSpan / 2; b = c + minSpan / 2; }
    if (b - a >= d) { view = null; dirtyBase = true; schedule(); return; }
    if (a < 0) { b -= a; a = 0; }
    if (b > d) { a -= b - d; b = d; }
    view = [Math.max(0, a), Math.min(d, b)];
    dirtyBase = true;
    schedule();
  }
  const inset = () => parseFloat(getComputedStyle(box).getPropertyValue('--xray-inset')) || 0;
  /** Strip x (CSS px from the box's left) <-> relative time. */
  function xToT(x) {
    const [a, b] = viewRange();
    const w = box.clientWidth - 2 * inset();
    return a + ((x - inset()) / Math.max(1, w)) * (b - a);
  }
  function tToX(t) {
    const [a, b] = viewRange();
    const w = box.clientWidth - 2 * inset();
    return inset() + ((t - a) / (b - a)) * w;
  }

  // ---- drawing ------------------------------------------------------------------------------
  const base = document.createElement('canvas'); // bars and bitrate; the playhead goes on top
  let lastHead = NaN;

  function drawBase() {
    const s = st;
    const dpr = window.devicePixelRatio || 1;
    const W = Math.max(1, Math.round(box.clientWidth * dpr));
    const H = Math.max(1, Math.round(box.clientHeight * dpr));
    if (base.width !== W || base.height !== H) { base.width = W; base.height = H; }
    const g = base.getContext('2d');
    g.clearRect(0, 0, W, H);
    if (!colors) colors = themeColors();
    const d = duration();
    if (!s || !d) return;
    const [v0, v1] = viewRange();
    const x0 = inset() * dpr;
    const pw = W - 2 * x0;
    const sx = pw / (v1 - v0); // device px per second
    const T0 = startT();
    const top = 12 * dpr; // legend line
    const hb = H - top - 1;

    // Not yet indexed: hatched.
    if (s.nSeg) {
      g.fillStyle = colors.fg;
      g.globalAlpha = 0.07;
      for (let k = segOf(T0 + v0); k <= segOf(T0 + v1); k++) {
        if (s.segState[k] === 2) continue;
        const a = Math.max(x0, x0 + (segT0(k) - T0 - v0) * sx);
        const b = Math.min(W - x0, x0 + (segT0(k + 1) - T0 - v0) * sx);
        if (b > a) g.fillRect(a, top, b - a, hb);
      }
      g.globalAlpha = 1;
    }
    if (!sorted(false)) return;
    const n = s.sn;
    const i0 = Math.max(0, lower(s.opts, T0 + v0, n) - 1);
    const i1 = Math.min(n, lower(s.opts, T0 + v1, n) + 1);
    let max = 1;
    for (let i = i0; i < i1; i++) max = Math.max(max, s.size[s.order[i]]);
    const fd = fps() ? 1 / fps() : (i1 - i0 > 1 ? (s.opts[i1 - 1] - s.opts[i0]) / (i1 - i0 - 1) : 1 / 30);
    const ppf = fd * sx; // device px per frame
    if (ppf >= 3) {
      // One bar per frame.
      const bw = Math.max(1, Math.floor(ppf * 0.8));
      for (let i = i0; i < i1; i++) {
        const j = s.order[i];
        const x = x0 + (s.opts[i] - T0 - v0) * sx;
        const h = Math.max(1, (s.size[j] / max) * hb);
        g.fillStyle = colors.t[s.pict[j]];
        g.fillRect(Math.round(x), H - h, bw, h);
      }
    } else {
      // Zoomed out: per pixel column, the biggest packet of each type (tallest drawn first).
      const cols = Math.ceil(pw);
      const mx = [new Float32Array(cols), new Float32Array(cols), new Float32Array(cols), new Float32Array(cols)];
      for (let i = i0; i < i1; i++) {
        const j = s.order[i];
        const c = Math.floor((s.opts[i] - T0 - v0) * sx);
        if (c < 0 || c >= cols) continue;
        const t = s.pict[j];
        if (s.size[j] > mx[t][c]) mx[t][c] = s.size[j];
      }
      const ord = [0, 1, 2, 3];
      for (let c = 0; c < cols; c++) {
        ord.sort((a, b) => mx[b][c] - mx[a][c]);
        for (const t of ord) {
          if (!mx[t][c]) continue;
          const h = Math.max(1, (mx[t][c] / max) * hb);
          g.fillStyle = colors.t[t];
          g.fillRect(x0 + c, H - h, 1, h);
        }
      }
    }

    // Bitrate over a sliding window, where the index is complete.
    const win = v1 - v0 <= 6 ? 0.5 : 1;
    const step = Math.max(1, Math.round(2 * dpr));
    const pts = [];
    let bmax = 0;
    for (let c = 0; c <= pw; c += step) {
      const t = T0 + v0 + c / sx;
      const ka = segOf(t - win / 2);
      const kb = segOf(t + win / 2);
      let ok = true;
      for (let k = ka; k <= kb && ok; k++) ok = segDone(k);
      if (!ok) { pts.push(null); continue; }
      const a = lower(s.opts, t - win / 2, n);
      const b = lower(s.opts, t + win / 2, n);
      // At the ends of the file the window holds less time.
      const span = Math.min(t + win / 2, s.opts[n - 1] + fd) - Math.max(t - win / 2, s.opts[0]);
      if (span <= win * 0.25) { pts.push(null); continue; }
      const bps = ((s.cum[b] - s.cum[a]) * 8) / span;
      pts.push([x0 + c, bps]);
      if (bps > bmax) bmax = bps;
    }
    if (bmax > 0) {
      g.strokeStyle = colors.line;
      g.lineWidth = Math.max(1, dpr * 1.25);
      g.beginPath();
      let pen = false;
      for (const q of pts) {
        if (!q) { pen = false; continue; }
        const y = H - 1 - (q[1] / bmax) * (hb - 2);
        if (pen) g.lineTo(q[0], y); else g.moveTo(q[0], y);
        pen = true;
      }
      g.stroke();
    }
    s.viewMax = max;
    s.viewBitrate = bmax;
    s.win = win;
  }

  function fmtRate(bps) { return bps >= 1e6 ? `${(bps / 1e6).toFixed(bps >= 1e8 ? 0 : 1)} Mbit/s` : `${Math.round(bps / 1e3)} kbit/s`; }
  function fmtBytes(b) { return b >= 1e6 ? `${(b / 1e6).toFixed(2)} MB` : `${(b / 1e3).toFixed(1)} kB`; }

  function updateLegend() {
    const s = st;
    let text = 'Codec X-ray';
    if (!s) text += ': not available for this file';
    else if (s.failed && !s.n) text += ': index not available';
    else if (!s.opened) text += ': starting…';
    else {
      const done = s.segState.reduce((a, x) => a + (x === 2 ? 1 : 0), 0);
      const pct = Math.round((done / s.nSeg) * 100);
      const esc = (x) => String(x).replace(/[<>&"]/g, (c) => `&#${c.charCodeAt(0)};`);
      const parts = [`<b class="i">I</b> <b class="p">P</b> <b class="b">B</b> ${esc(s.codec)}`];
      if (s.viewBitrate) parts.push(`bitrate (${s.win} s): max ${fmtRate(s.viewBitrate)}`);
      if (s.viewMax > 1) parts.push(`biggest ${fmtBytes(s.viewMax)}`);
      if (pct < 100) parts.push(`indexed ${pct}%${s.stride > 1 ? ` (every ${s.stride}th part in this view; zoom in for all)` : ''}`);
      if (view) parts.push(`zoom ${fmtTime(view[0])}–${fmtTime(view[1])}`);
      legend.innerHTML = parts.join(' · ');
      return;
    }
    legend.textContent = text;
  }

  let lastLegend = 0;
  // The strip's own frame loop runs only while it is shown (toggle starts it); the chapter ticks on the
  // seek bar follow the player's frame loop (chapterTicks).
  let looping = false;
  function frame() {
    if (!shown) { looping = false; return; }
    requestAnimationFrame(frame);
    const p = player();
    if (p) renderChapters();
    if (!p) return;
    const dpr = window.devicePixelRatio || 1;
    const W = Math.max(1, Math.round(box.clientWidth * dpr));
    const H = Math.max(1, Math.round(box.clientHeight * dpr));
    if (st.dirty && performance.now() - st.sortedAt > st.sortGap) dirtyBase = true;
    if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; dirtyBase = true; }
    // Follow the playhead in a zoomed view.
    const cur = p.currentTime();
    if (view && p.isPlaying() && (cur > view[1] || cur < view[0])) setView([cur, cur + (view[1] - view[0])]);
    if (performance.now() - lastLegend > 300) { lastLegend = performance.now(); updateLegend(); }
    if (!dirtyBase && cur === lastHead) return;
    if (dirtyBase) { drawBase(); dirtyBase = false; }
    lastHead = cur;
    const g = cv.getContext('2d');
    g.clearRect(0, 0, W, H);
    g.drawImage(base, 0, 0);
    if (!colors) colors = themeColors();
    const x = tToX(cur) * dpr;
    g.fillStyle = colors.fg;
    g.fillRect(Math.round(x), 0, Math.max(1, Math.round(dpr)), H);
    if (hoverX >= 0) { g.globalAlpha = 0.4; g.fillRect(Math.round(hoverX * dpr), 0, 1, H); g.globalAlpha = 1; }
  }
  function startLoop() {
    if (looping) return;
    looping = true;
    requestAnimationFrame(frame);
  }

  // ---- interaction -----------------------------------------------------------------------
  /** Packet (index into presentation order) nearest to strip x, within a few pixels. */
  function hit(x, force = false) {
    const s = st;
    if (!s || !sorted(force)) return -1;
    const t = startT() + xToT(x);
    const i = lower(s.opts, t, s.sn);
    let best = -1;
    for (const k of [i - 1, i]) if (k >= 0 && k < s.sn && (best < 0 || Math.abs(s.opts[k] - t) < Math.abs(s.opts[best] - t))) best = k;
    if (best < 0) return -1;
    // Bars start at their pts: prefer the frame whose bar contains x.
    if (best > 0 && s.opts[best] > t) best--;
    const px = Math.abs(tToX(s.opts[best] - startT()) - x);
    const [a, b] = viewRange();
    const fd = fps() ? 1 / fps() : 0.04;
    return px <= Math.max(4, (fd / (b - a)) * box.clientWidth + 2) ? best : -1;
  }

  box.addEventListener('mousemove', (e) => {
    const r = box.getBoundingClientRect();
    const x = e.clientX - r.left;
    hoverX = x;
    lastHead = NaN;
    const s = st;
    const i = s ? hit(x) : -1;
    if (i < 0) { tip.hidden = true; return; }
    const j = s.order[i];
    const pts = s.opts[i];
    const fn = frameNo(pts);
    const t = pts - startT();
    // Bitrate around this frame (1 s window).
    const a = lower(s.opts, pts - 0.5, s.sn);
    const b = lower(s.opts, pts + 0.5, s.sn);
    const kseg = segOf(pts);
    const br = segDone(segOf(pts - 0.5)) && segDone(kseg) && segDone(segOf(pts + 0.5)) ? ` · ${fmtRate((s.cum[b] - s.cum[a]) * 8)}` : '';
    tip.textContent = `${fn ? `#${fn} · ` : ''}${fmtTime(t)} · ${T_LONG[s.pict[j]]}${s.key[j] ? ' · keyframe' : ''} · ${fmtBytes(s.size[j])}${br}`;
    tip.title = '';
    tip.hidden = false;
    const w = tip.offsetWidth;
    tip.style.left = `${Math.max(w / 2 + 2, Math.min(r.width - w / 2 - 2, x))}px`;
  });
  box.addEventListener('mouseleave', () => { tip.hidden = true; hoverX = -1; lastHead = NaN; });
  box.addEventListener('click', (e) => {
    const p = player();
    if (!p) return;
    const r = box.getBoundingClientRect();
    const i = hit(e.clientX - r.left, true);
    p.pause();
    if (i >= 0) p.seekTime(st.opts[i] - startT());
    else p.seekTime(Math.max(0, xToT(e.clientX - r.left)));
  });
  box.addEventListener('dblclick', (e) => { e.preventDefault(); setView(null); });
  box.addEventListener('wheel', (e) => {
    if (!player() || !duration()) return;
    e.preventDefault();
    const [a, b] = viewRange();
    const span = b - a;
    const r = box.getBoundingClientRect();
    if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      const d = (e.shiftKey ? e.deltaY : e.deltaX) || e.deltaX;
      setView([a + (d / 500) * span, b + (d / 500) * span]);
      return;
    }
    const c = xToT(e.clientX - r.left);
    const f = Math.exp(Math.max(-1, Math.min(1, e.deltaY * 0.002)));
    setView([c - (c - a) * f, c + (b - c) * f]);
  }, { passive: false });

  // ---- keyframe and chapter steps -------------------------------------------------------------
  /** Keyframe after (dir 1) or before (dir -1) the shown frame; indexes what it needs first. */
  function stepKey(dir) {
    const p = player();
    if (!p) { toast('Keyframe steps need the built-in decoder engine'); return; }
    if (st.failed) { toast('No keyframe index for this file'); return; }
    st.pending = { dir, at: curAbs(), t: performance.now() };
    startIndex();
    runPending();
  }

  function runPending() {
    const s = st;
    const q = s.pending;
    if (!q || !s.opened) return;
    const k0 = segOf(q.at);
    sorted(true);
    const keys = s.keys || new Float64Array(0);
    let found = null;
    if (q.dir > 0) {
      const i = lower(keys, q.at + 1e-4);
      if (i < keys.length) found = keys[i];
    } else {
      const i = lower(keys, q.at - 1e-4) - 1;
      if (i >= 0) found = keys[i];
    }
    // Everything between here and the keyframe (or the end) must be indexed.
    const k1 = found === null ? (q.dir > 0 ? s.nSeg - 1 : 0) : segOf(found);
    // (one more on each side: a packet's decode time, which picks its segment, is before its pts).
    const lo = Math.max(0, Math.min(k0, k1) - 1);
    const hi = Math.min(s.nSeg - 1, Math.max(k0, k1) + 1);
    let missing = -1;
    if (q.dir > 0) {
      for (let k = lo; k <= hi && missing < 0; k++) if (!segDone(k)) missing = k;
    } else {
      for (let k = hi; k >= lo && missing < 0; k--) if (!segDone(k)) missing = k;
    }
    if (missing >= 0) {
      s.demand.add(missing);
      if (performance.now() - q.t > 400 && !q.told) { q.told = true; toast('Indexing keyframes…'); }
      schedule();
      return;
    }
    s.pending = null;
    if (found === null) { toast(q.dir > 0 ? 'No later keyframe' : 'No earlier keyframe'); return; }
    s.p.pause();
    s.p.seekTime(found - startT());
    const fn = frameNo(found);
    toast(`Keyframe${fn ? ` #${fn}` : ''} · ${fmtTime(found - startT())}`);
  }

  function chapters() {
    const p = player();
    if (!p) return [];
    const c = (p.info && p.info.chapters && p.info.chapters.length ? p.info.chapters : st && st.chapters) || [];
    return c;
  }
  function stepChapter(dir) {
    const p = player();
    const ch = chapters();
    if (!p || !ch.length) { toast('No chapters in this file'); return; }
    const t0 = startT();
    const cur = p.currentTime();
    let target = null;
    if (dir > 0) target = ch.find((c) => c.start - t0 > cur + 0.05);
    else {
      // Back to the start of this chapter, or to the previous one when near its start.
      for (let i = ch.length - 1; i >= 0; i--) if (ch[i].start - t0 < cur - 1) { target = ch[i]; break; }
    }
    if (!target) { if (dir < 0) { p.seekTime(0); toast('Start'); } else toast('Last chapter'); return; }
    p.seekTime(Math.max(0, target.start - t0));
    const n = ch.indexOf(target) + 1;
    toast(`Chapter ${n}/${ch.length}${target.title ? `: ${target.title}` : ''}`);
  }

  let chapSig = '';
  function renderChapters() {
    const ch = chapters();
    const d = duration();
    const sig = `${ch.length}|${d}|${startT()}`;
    if (sig === chapSig) return;
    chapSig = sig;
    ticks.textContent = '';
    if (!d) return;
    for (const c of ch) {
      const r = (c.start - startT()) / d;
      if (r <= 0.001 || r >= 1) continue;
      const m = document.createElement('span');
      m.style.left = `${r * 100}%`;
      ticks.append(m);
    }
  }
  // Chapter title in the seek bar's hover tip (player.js writes the time first).
  ui.seek.addEventListener('mousemove', (e) => {
    const ch = chapters();
    const d = duration();
    if (!ch.length || !d) return;
    const r = ui.seek.getBoundingClientRect();
    const t = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * d + startT();
    let c = null;
    for (const x of ch) if (x.start <= t + 1e-3) c = x;
    if (c) ui.tip.append(` · ${c.title || `Chapter ${ch.indexOf(c) + 1}`}`);
  });

  // ---- toggle and keys -------------------------------------------------------------------
  function toggle(on) {
    const p = player();
    shown = on === undefined ? !shown : !!on;
    if (shown && !p) { shown = false; toast('Codec X-ray needs the built-in decoder engine (not used for this file)'); return; }
    box.hidden = !shown;
    document.body.classList.toggle('xray', shown);
    if (shown) { startIndex(); dirtyBase = true; lastHead = NaN; schedule(); startLoop(); } else if (st && !st.busy && !st.pending) idleLater(st);
    toast(shown ? 'Codec X-ray on (Shift+X)' : 'Codec X-ray off');
  }

  document.addEventListener('keydown', (e) => {
    // AltGr (Ctrl+Alt on Windows) types { } on many layouts: still the keyframe keys.
    const altGr = !!(e.getModifierState && e.getModifierState('AltGraph'));
    if (!getPlayer() || e.target === ui.rate || (typeof VpeModes !== 'undefined' && VpeModes.ownsKey(e)) || e.metaKey || (!altGr && (e.ctrlKey || e.altKey))) return;
    let handled = true;
    switch (e.key) {
      case 'X': if (e.shiftKey) toggle(); else handled = false; break;
      case '{': stepKey(-1); break;
      case '}': stepKey(1); break;
      case 'PageUp': stepChapter(-1); break;
      case 'PageDown': stepChapter(1); break;
      default: handled = false;
    }
    if (handled) e.preventDefault();
  });

  /** From the player's frame loop: chapter ticks on the seek bar (only redrawn when the chapters change). */
  const chapterTicks = () => { if (player()) renderChapters(); };
  return { toggle, stepKey, stepChapter, chapterTicks, isShown: () => shown, _state: () => st };
}
