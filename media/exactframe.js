// @ts-check
// Exact frames for the pixel tools while Live transcode is active (src/exact_frame.js is the host half).
// The transcoded canvas is not the file's own pixels, so Copy Frame, Save Frame as PNG, the pixel inspector and
// the scopes ask the host for one full-resolution PNG at the shown time. This module owns the request
// (one at a time, a newer one supersedes the older, a reply for another page is ignored) and keeps the decoded
// picture of the paused frame, so moving the mouse in the inspector or switching scopes costs nothing.
// Plain logic over injected functions: test/host/exact_frame_test.js loads it without a browser.
'use strict';
(function (root) {
  const SLOW_MS = 250; // a grab slower than this shows "Fetching exact frame…"
  const GIVE_UP_MS = 25000; // the host stops at 20 s; this one only frees the page if no answer ever comes

  /**
   * @param {{
   *   page: number, post: (m: any) => void, toast?: (t: string, ms?: number) => void, log?: (m: string) => void,
   *   decode?: (png: Uint8Array) => Promise<any>, setTimeout?: Function, clearTimeout?: Function,
   * }} o decode: PNG bytes to a drawable picture ({width, height, close?}), default createImageBitmap
   */
  function create(o) {
    const toast = o.toast || (() => {});
    const log = o.log || (() => {});
    const st = o.setTimeout || setTimeout;
    const ct = o.clearTimeout || clearTimeout;
    const decode = o.decode || ((png) => createImageBitmap(new Blob([png], { type: 'image/png' })));
    let reqId = 0;
    /** @type {null | {id: number, key: string, resolve: (r: any) => void, timer: any, slow: any}} */
    let pending = null;
    /** @type {null | {key: string, img: any, w: number, h: number, png: Uint8Array, ctx?: any}} */
    let cache = null;
    let failedKey = null; // the frame the host could not give: not asked again until the frame changes

    const finish = (r) => {
      const p = pending;
      if (!p) return;
      pending = null;
      ct(p.timer);
      ct(p.slow);
      p.resolve(r);
    };
    function drop() {
      if (cache && cache.img && cache.img.close) { try { cache.img.close(); } catch { /* closed */ } }
      cache = null;
    }

    /**
     * Asks the host for the exact frame at `t`. Resolves {img, w, h, png} (the cached one when `key` matches),
     * {error} or null when superseded or invalidated.
     */
    function grab(key, t, { notify = true } = {}) {
      if (cache && cache.key === key) return Promise.resolve(cache);
      if (pending && pending.key === key) return new Promise((resolve) => { const prev = pending.resolve; pending.resolve = (r) => { prev(r); resolve(r); }; });
      finish(null); // superseded
      const id = ++reqId;
      return new Promise((resolve) => {
        const timer = st(() => finish({ error: 'no answer from the extension host' }), GIVE_UP_MS);
        const slow = notify ? st(() => toast('Fetching exact frame…', 2000), SLOW_MS) : null;
        pending = { id, key, resolve, timer, slow };
        o.post({ type: 'grabExactFrame', page: o.page, reqId: id, t });
      });
    }

    /** The host's reply ('exactFrame' message). Replies of another page or an older request are dropped. */
    async function onReply(m) {
      if (!m || m.page !== o.page || !pending || m.reqId !== pending.id) return;
      const p = pending;
      if (!m.png) {
        failedKey = p.key;
        log(`exact frame: ${m.error || 'failed'}`);
        finish({ error: String(m.error || 'failed') });
        return;
      }
      let img = null;
      try { img = await decode(m.png); } catch (e) { log(`exact frame: PNG decode failed: ${e && e.message || e}`); }
      if (pending !== p) { if (img && img.close) img.close(); return; } // superseded while decoding
      if (!img) { failedKey = p.key; finish({ error: 'the picture could not be decoded' }); return; }
      drop();
      cache = { key: p.key, img, w: m.w || img.width, h: m.h || img.height, png: m.png };
      finish(cache);
    }

    /** The cached picture when it belongs to `key`. */
    const peek = (key) => (cache && cache.key === key ? cache : null);

    /** Forget the picture and any request in flight: a seek, play, close or reload. */
    function invalidate() {
      finish(null);
      drop();
      failedKey = null;
    }

    /** A 2D canvas context holding the picture (for small reads with getImageData), made once per picture. */
    function ctxOf(entry) {
      if (!entry.ctx) {
        const c = document.createElement('canvas');
        c.width = entry.w;
        c.height = entry.h;
        entry.ctx = c.getContext('2d', { willReadFrequently: true });
        entry.ctx.drawImage(entry.img, 0, 0);
      }
      return entry.ctx;
    }

    return { grab, onReply, peek, invalidate, ctxOf, failed: (key) => failedKey === key, inflight: (key) => !!pending && pending.key === key };
  }

  const api = { create, SLOW_MS };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.VpeExact = api;
}(typeof self !== 'undefined' ? self : this));
