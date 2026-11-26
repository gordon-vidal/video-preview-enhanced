// @ts-check
'use strict';
// Production HostAdapter for media/player-ui.js (docs/notes/player-ui-controller.md, "Next step: one unified page"):
// `post(msg)` goes to the extension host through the webview's vscode API, tagged with this page's `page` / `boot`
// envelope, and translated from the unified controller's names to what the host of today's page understands;
// the host's replies arrive on window 'message' and go to `connect(onHostMessage)`. Same contract as the mockup's
// FakeHost (test/host/adapter_contract_test.js).
//
//   const host = VpeHostAdapter.create({ vscode: acquireVsCodeApi(), win: window, page: cfg.page, boot, surface: 'compare' });
//   host.connect(ui.onHostMessage);
//
// surface: 'player' (src/extension.js single player), 'compare' (src/compare.js) or 'unified' (no translation; the
// future single page whose host speaks the controller's protocol).
(function (root) {
  // checkJs: start
  /**
   * @typedef {'player' | 'compare' | 'unified'} Surface
   * @typedef {{ vscode: { postMessage: (m: any) => void, getState?: () => any, setState?: (s: any) => void },
   *   win?: { addEventListener: (t: string, f: (e: any) => void) => void, removeEventListener: (t: string, f: (e: any) => void) => void } | null,
   *   page?: any, boot?: any, surface?: Surface }} HostAdapterOptions
   */

  const MAX_TOAST_MS = 10000;
  const PREF_KEYS = ['volume', 'rate', 'timeMode', 'stepSize'];

  /** A toast the page shows: `ms` (how long it stays) is optional and capped at 10 s. @param {any} m */
  function capToast(m) {
    const n = Number(m && m.ms);
    const { ms: _ms, ...rest } = m || {};
    return { ...rest, type: 'toast', text: String((m && m.text) || ''), ...(n > 0 ? { ms: Math.min(MAX_TOAST_MS, Math.round(n)) } : {}) };
  }

  /**
   * The unified controller's message as the given surface's host understands it (null = nothing to send).
   * Ids become tile indices on Compare through `slots` (the host's slot table in opening order; see mergeSlots).
   * Fields the host does not read are kept, so a host may move to the unified names without a page change.
   * @param {any} m @param {Surface} surface @param {string[]} slots
   */
  function translate(m, surface, slots) {
    if (surface === 'unified') return m;
    const indexOf = (/** @type {any} */ id) => slots.indexOf(id);
    switch (m.type) {
      case 'pickVideo':
        return surface === 'player'
          ? { ...m, type: 'comparePick', t: Number(m.t) || 0, exclude: Array.isArray(m.exclude) ? m.exclude.slice() : [] }
          : { ...m, type: 'add', exclude: Array.isArray(m.exclude) ? m.exclude.slice() : [] };
      case 'playbackPrefs': {
        // Today's hosts read the prefs flat on the message (src/settings.js rememberPlaybackPrefs).
        const src = m.prefs && typeof m.prefs === 'object' ? m.prefs : m;
        /** @type {any} */
        const flat = { type: 'playbackPrefs' };
        for (const k of PREF_KEYS) if (src[k] !== undefined) flat[k] = src[k];
        return flat;
      }
      default: break;
    }
    if (surface !== 'compare') return m;
    switch (m.type) {
      case 'replaceVideo': {
        // An unknown tile is not sent: Compare's host would act on a wrong index.
        const oldId = m.oldId !== undefined ? m.oldId : m.clipId;
        const index = indexOf(oldId);
        return index < 0 ? null : { ...m, type: 'replace', index, oldId };
      }
      case 'leaveCompare': {
        const keep = indexOf(m.keepId);
        return keep < 0 ? null : { ...m, type: 'leave', keep, t: Number(m.t) || 0 };
      }
      case 'tileOrder': {
        // Indices stay the tiles' slots (the order they were opened in); the order is a display permutation.
        const ids = Array.isArray(m.order) ? m.order : [];
        const order = ids.map((/** @type {any} */ id) => (typeof id === 'number' ? id : indexOf(id)));
        if (!order.length || order.some((/** @type {number} */ i) => i < 0)) return null;
        return { ...m, type: 'tileOrder', order, ids: ids.slice() };
      }
      case 'tileSize': {
        if (m.tile) return m;
        const tile = { w: Number(m.w) || 0, h: Number(m.h) || 0, cols: Number(m.cols) || 1, rows: Number(m.rows) || 1, zoom: Number(m.zoom) || 1 };
        return { type: 'tileSize', tile };
      }
      default: return m;
    }
  }

  /**
   * The host's slot table after the page reports its tiles. Compare's host keeps its tiles in the order they were
   * opened and addresses them by that index; the page's 'tiles' list is in display order, which a Swap or a drag
   * permutes. So a reported list never reorders the table: slots still shown keep their index, closed ones drop
   * out (the host splices them too) and new ones are appended in the order reported.
   * @param {string[]} slots @param {any[]} tiles @returns {string[]}
   */
  function mergeSlots(slots, tiles) {
    const shown = new Set(tiles.filter((id) => typeof id === 'string'));
    const next = slots.filter((id) => shown.has(id));
    for (const id of shown) if (!next.includes(id)) next.push(id);
    return next;
  }

  /** @param {HostAdapterOptions} opts */
  function create(opts) {
    if (!opts || !opts.vscode || typeof opts.vscode.postMessage !== 'function') {
      throw new Error('VpeHostAdapter.create: vscode.postMessage is required');
    }
    const { vscode, page, boot } = opts;
    const win = opts.win === undefined ? /** @type {any} */ (globalThis).window || null : opts.win;
    /** @type {Surface} */
    const surface = opts.surface === 'player' || opts.surface === 'compare' ? opts.surface : 'unified';
    /** @type {((m: any) => void) | null} */
    let listener = null;
    /** @type {string[]} the host's slot table: clip ids by the tile index Compare's host uses (opening order) */
    let slots = [];
    let disposed = false;

    const envelope = () => ({ ...(page !== undefined ? { page } : {}), ...(boot !== undefined ? { boot } : {}) });
    const toPage = (/** @type {any} */ m) => { if (listener && !disposed) listener(m); };

    /** @param {any} e */
    function onWindowMessage(e) {
      const m = e && e.data;
      if (!m || typeof m !== 'object' || typeof m.type !== 'string') return;
      // A reply meant for another page or the page before a reload: same rule as player.js / compare.js.
      if (m.page !== undefined && page !== undefined && m.page !== page) return;
      if (m.boot !== undefined && boot !== undefined && m.boot !== boot) return;
      // The envelope is the adapter's business: the controller sees the host's message alone.
      const { page: _page, boot: _boot, ...msg } = m;
      // The host swapped a tile's video: the new one takes the old one's slot, as it does on the host.
      if (msg.type === 'replaceTile' && typeof msg.oldId === 'string' && typeof msg.newId === 'string') {
        const i = slots.indexOf(msg.oldId);
        if (i >= 0 && !slots.includes(msg.newId)) slots[i] = msg.newId;
      }
      toPage(msg.type === 'toast' ? capToast(msg) : msg);
    }

    /** Send one controller message to the host. Never throws. @param {any} msg */
    function post(msg) {
      if (disposed || !msg || typeof msg !== 'object' || typeof msg.type !== 'string') return;
      // Shown by the page itself: the host has nothing to add to a toast the page asked for.
      if (msg.type === 'toast') { toPage(capToast(msg)); return; }
      if (msg.type === 'tiles' && Array.isArray(msg.tiles)) slots = mergeSlots(slots, msg.tiles);
      const out = translate(msg, surface, slots);
      if (!out) return;
      try { vscode.postMessage({ ...out, ...envelope() }); } catch { /* the panel is closing */ }
    }

    /** @param {(m: any) => void} onHostMessage */
    function connect(onHostMessage) {
      listener = typeof onHostMessage === 'function' ? onHostMessage : null;
    }

    if (win && typeof win.addEventListener === 'function') win.addEventListener('message', onWindowMessage);

    function dispose() {
      if (disposed) return;
      disposed = true;
      listener = null;
      if (win && typeof win.removeEventListener === 'function') win.removeEventListener('message', onWindowMessage);
    }

    /** The webview's saved state (survives a reload); never throws. */
    const storage = {
      getState() {
        try { return typeof vscode.getState === 'function' ? vscode.getState() : undefined; } catch { return undefined; }
      },
      /** @param {any} state */
      setState(state) {
        try { if (typeof vscode.setState === 'function') vscode.setState(state); } catch { /* the panel is closing */ }
      },
    };

    return { post, connect, dispose, storage, surface, slots: () => slots.slice() };
  }

  const api = { create, translate, capToast, mergeSlots, MAX_TOAST_MS };
  // checkJs: end
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.VpeHostAdapter = api;
}(typeof self !== 'undefined' ? self : /** @type {any} */ (this)));
