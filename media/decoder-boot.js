// @ts-check
// Decoder worker startup, preloading and page startup diagnostics.
'use strict';

(() => {
  // checkJs: start
  const page = /** @type {any} */ (globalThis);
  /** Start-up timeline (epoch ms, first time only), logged with the first frame when debugging. */
  function mark(k) {
    const marks = page.vpeMarks || (page.vpeMarks = {});
    if (!(k in marks)) marks[k] = Math.round(performance.timeOrigin + performance.now());
  }
  /** The page's start-up: navigation, script and libav.js loads (epoch ms), and the marks above. */
  const startupTimeline = () => {
    const o = performance.timeOrigin;
    const at = (x) => (x > 0 ? Math.round(o + x) : undefined);
    const nav = /** @type {any} */ (performance.getEntriesByType('navigation')[0]) || {};
    const res = /** @type {any[]} */ (performance.getEntriesByType('resource'));
    const scripts = res.filter((r) => /\.js(\?|$)/.test(r.name) && !/libav/.test(r.name));
    const lib = res.filter((r) => /libav|decoder-worker/.test(r.name)).map((r) => ({ f: r.name.replace(/^.*\//, ''), start: at(r.startTime), end: at(r.responseEnd), kb: Math.round((r.transferSize || r.encodedBodySize || 0) / 1024) }));
    return {
      origin: Math.round(o), domInteractive: at(nav.domInteractive), domLoaded: at(nav.domContentLoadedEventEnd),
      scriptsEnd: scripts.length ? at(Math.max(...scripts.map((r) => r.responseEnd))) : undefined,
      ...(page.vpeMarks || {}), lib,
    };
  };
  // Memory budgets (media/membudget.js): these are a 32 GB machine's, the sizes before they scaled.
  const MEM_DEFAULT = { frames: 400e6, pool: 600e6, batch: 100e6, blocks: 64e6, freeBufs: 64e6, thumbs: 30e6, workers: 6, gb: 0 };
  /**
   * The player's picture area in device pixels ({ w, h }), or null (no stage, hidden or not laid out).
   * zoomed: the zoomed picture's size in CSS px (media/inspect.js zoomedSize), which counts instead of the stage.
   */
  function pictureArea(zoomed = undefined) {
    const st = typeof document !== 'undefined' ? document.getElementById('stage') : null;
    if (!st) return null;
    const r = st.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return null; // hidden
    const dpr = globalThis.devicePixelRatio || 1;
    const w = Math.min(32768, Math.round((zoomed ? zoomed.w : r.width) * dpr));
    const h = Math.min(32768, Math.round((zoomed ? zoomed.h : r.height) * dpr));
    return w >= 16 && h >= 16 ? { w, h } : null;
  }

  /** The host's budgets (local windows), else from navigator.deviceMemory (remote windows; reported up to 8). */
  function memFor(cfg) {
    if (cfg.mem) return { ...MEM_DEFAULT, ...cfg.mem };
    const MB = /** @type {any} */ (globalThis).MemBudget;
    return MB ? MB.fromDeviceMemory(/** @type {any} */ (navigator).deviceMemory) : MEM_DEFAULT;
  }

  /** Each engine owns its preload until a player takes it or drops it. */
  function create({ log, debug }) {
    /**
     * The WebAssembly decoder, started: worker source and libav.js fetched (as blob URLs: workers
     * made from blobs can't reach the webview's resource origin), the worker (or the decoder pool,
     * pool.js) created and sent 'init'. Its messages wait in `queue` until a player takes it over.
     */
    function bootDecoder(cfg, mem) {
      // A response the page's head started fetching (src/extension.js html(), self.vpeEarly), else a new fetch.
      const early = page.vpeEarly;
      delete page.vpeEarly;
      const controller = early ? early.controller : new AbortController();
      const { signal } = controller;
      const urls = new Set();
      let worker;
      const drop = () => {
        controller.abort();
        if (worker) { worker.terminate(); worker = null; }
        for (const url of urls) URL.revokeObjectURL(url);
        urls.clear();
      };
      const get = async (url) => {
        const response = early && await early.responses[url];
        signal.throwIfAborted();
        const r = response || await fetch(url, { signal });
        if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
        return r;
      };
      const blobUrl = (data, type) => {
        // A body read can finish just before another decoder takes over.
        signal.throwIfAborted();
        const url = URL.createObjectURL(new Blob([data], { type }));
        urls.add(url);
        return url;
      };
      const asset = async (url, type) => {
        const res = await get(url);
        return blobUrl(await res.arrayBuffer(), type);
      };
      // The decoder's wasm as a blob URL (libav.js loads it by URL) and compiled once here for the workers.
      const wasmAsset = async (url) => {
        const buf = await (await get(url)).arrayBuffer();
        const out = { url: blobUrl(buf, 'application/wasm'), module: null };
        try { if (buf.byteLength) out.module = await WebAssembly.compile(buf); } catch (e) { log(`WebAssembly compile in the page failed: ${e && e.message || e}`); }
        signal.throwIfAborted();
        return out;
      };
      const stem = cfg.loader.replace(/\.js$/, '');
      // Fetch all four at once, and start loading the worker while the wasm is still downloading.
      const startWorker = async () => {
        const res = await get(cfg.workerUrl);
        const src = await res.text();
        const url = blobUrl(src, 'text/javascript');
        if (cfg.debug || debug) log(`memory budgets: ${mem.gb ? `${mem.gb} GB` : 'default'}: frames ${Math.round(mem.frames / 1e6)} MB, pool ${Math.round(mem.pool / 1e6)} MB, ${mem.workers} extra workers at most, blocks ${Math.round(mem.blocks / 1e6)} MB`);
        // Several WebAssembly decoders for heavy intra/short-GOP video (pool.js); one worker otherwise.
        const poolOpts = { budget: mem.pool, batchBytes: mem.batch, maxWorkers: mem.workers, ...(cfg.pool || {}), multiRead: true };
        // @ts-ignore DecoderPool is supplied by pool.js as a classic-script global.
        worker = !cfg.singleWorker && typeof DecoderPool === 'function' ? new DecoderPool(url, poolOpts) : new Worker(url);
        const d = { url, worker, chars: src.length, queue: [], error: null, libav: null, preloaded: false };
        worker.onmessage = (e) => d.queue.push(e.data);
        worker.onerror = (e) => { d.error = e; };
        return d;
      };
      const promise = Promise.all([
        startWorker(),
        asset(cfg.loader, 'text/javascript'),
        asset(`${stem}.wasm.js`, 'text/javascript'),
        wasmAsset(`${stem}.wasm.wasm`),
      ]).then(([d, loader, toImport, { url: wasmurl, module: wasmModule }]) => {
        signal.throwIfAborted();
        d.libav = { loader, toImport, wasmurl, variant: cfg.variant };
        // One compiled module for every worker (pool, thumbnails): the compile happens once.
        // A large compare grid shares one buffer budget among its tiles: no two-buffer floor per worker.
        const strict = cfg.largeGrid ? { strictFreeBytes: true } : {};
        try {
          d.worker.postMessage({ type: 'init', ...d.libav, ...(wasmModule ? { wasmModule } : {}), freeBytes: mem.freeBufs, ...strict });
          if (wasmModule) d.libav.wasmModule = wasmModule;
        } catch (e) {
          log(`shared WebAssembly module not sent: ${e && e.message || e}`);
          d.worker.postMessage({ type: 'init', ...d.libav, freeBytes: mem.freeBufs, ...strict });
        }
        return d;
      }).catch((err) => { drop(); throw err; });
      return { promise, drop };
    }
    let preloaded = null;
    /** The player's decoder, started while the host decides (most files need it: GPU and WebAssembly paths both demux in it). */
    function preload(cfg) {
      if (preloaded || !cfg || !cfg.workerUrl) return;
      preloaded = bootDecoder(cfg, memFor(cfg));
      preloaded.promise.then((d) => { d.preloaded = true; }, () => {});
    }
    /** The preloaded decoder for the first player that wants it (null: none, or already taken). */
    function takePreload() { const p = preloaded; preloaded = null; return p; }
    /** Native ffmpeg or the frame player took the file: the preloaded decoder isn't needed. */
    function dropPreload() {
      const p = takePreload();
      if (p) p.drop();
      if (page.vpeEarly) {
        page.vpeEarly.controller.abort();
        delete page.vpeEarly;
      }
    }
    return { bootDecoder, preload, takePreload, dropPreload };
  }

  const api = { create, pictureArea, memFor, startupTimeline, mark };
  const commonJs = /** @type {{ exports?: typeof api } | undefined} */ (
    // @ts-ignore The webview has no CommonJS globals.
    typeof module === 'undefined' ? undefined : module
  );
  if (commonJs) commonJs.exports = api;
  else /** @type {typeof globalThis & { VpeDecoderBoot?: typeof api }} */ (globalThis).VpeDecoderBoot = api;
  // checkJs: end
})();
