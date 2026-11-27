// @ts-check
'use strict';
// Production HostAdapter for media/player-ui.js (docs/notes/player-ui-controller.md, "Production wiring"):
// `post(msg)` goes to the extension host through the webview's vscode API, tagged with this page's `page` / `boot`
// envelope; the unified controller's messages are sent as they are (src/unified-session.js speaks that protocol);
// the host's replies arrive on window 'message' and go to `connect(onHostMessage)`. Same contract as the mockup's
// FakeHost (test/host/adapter_contract_test.js).
//
//   const host = VpeHostAdapter.create({ vscode: acquireVsCodeApi(), win: window, page: cfg.page, boot });
//   host.connect(ui.onHostMessage);
(function (root) {
  // checkJs: start
  /**
   * @typedef {import('./unified-contracts').HostAdapter} HostAdapter the contract this adapter implements
   * @typedef {{ vscode: { postMessage: (m: any) => void, getState?: () => any, setState?: (s: any) => void },
   *   win?: { addEventListener: (t: string, f: (e: any) => void) => void, removeEventListener: (t: string, f: (e: any) => void) => void } | null,
   *   page?: any, boot?: any }} HostAdapterOptions
   */

  const MAX_TOAST_MS = 10000;

  /** A toast the page shows: `ms` (how long it stays) is optional and capped at 10 s. @param {any} m */
  function capToast(m) {
    const n = Number(m && m.ms);
    const { ms: _ms, ...rest } = m || {};
    return { ...rest, type: 'toast', text: String((m && m.text) || ''), ...(n > 0 ? { ms: Math.min(MAX_TOAST_MS, Math.round(n)) } : {}) };
  }

  /** @param {HostAdapterOptions} opts */
  function create(opts) {
    if (!opts || !opts.vscode || typeof opts.vscode.postMessage !== 'function') {
      throw new Error('VpeHostAdapter.create: vscode.postMessage is required');
    }
    const { vscode, page, boot } = opts;
    const win = opts.win === undefined ? /** @type {any} */ (globalThis).window || null : opts.win;
    /** @type {((m: any) => void) | null} */
    let listener = null;
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
      toPage(msg.type === 'toast' ? capToast(msg) : msg);
    }

    /** Send one controller message to the host. Never throws. @param {any} msg */
    function post(msg) {
      if (disposed || !msg || typeof msg !== 'object' || typeof msg.type !== 'string') return;
      // Shown by the page itself: the host has nothing to add to a toast the page asked for.
      if (msg.type === 'toast') { toPage(capToast(msg)); return; }
      try { vscode.postMessage({ ...msg, ...envelope() }); } catch { /* the panel is closing */ }
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

    return /** @satisfies {HostAdapter} */ ({ post, connect, dispose, storage });
  }

  const api = { create, capToast, MAX_TOAST_MS };
  // checkJs: end
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.VpeHostAdapter = api;
}(typeof self !== 'undefined' ? self : /** @type {any} */ (this)));
