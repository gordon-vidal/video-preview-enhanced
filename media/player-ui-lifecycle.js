// @ts-check
// Player UI lifecycle and host sync (phase 4): the parts of the page that talk to the extension host and to the
// webview's saved state, cut out of media/player.js and media/compare.js so a Node test can drive them on the fake
// DOM (test/host/player_ui_lifecycle_test.js). Five small controllers:
//   createPrefsSync           shared playback prefs (volume, speed, time display, step size), live settings, setState
//   createGotoAndResume       frame links (#t= / #frame=, vscode:// goto) and the resume position when a tab opens
//   createRailHandoffController  Autoplay's "Play next in folder", folder-rail handoffs between tabs, the rail seed
//   createOverlayController   the centre overlay: status lines, errors with their one action button
//   createLifecycleBridge     ready / tileSize to the host, pauseForTest, pagehide
// Nothing here knows VS Code, a decoder or the page's globals: the window (timers, events), the host (postMessage),
// the state store (getState / setState) and every effect come in as arguments.
'use strict';

(function (root) {
  // checkJs: start

  /** @typedef {{ postMessage: (msg: any) => void }} Host */
  /** @typedef {{ getState: () => any, setState: (state: any) => void }} Storage */
  /**
   * @typedef {{
   *   setTimeout: (fn: () => void, ms: number) => any,
   *   clearTimeout: (id: any) => void,
   *   addEventListener?: (type: string, fn: (e: any) => void, opts?: any) => void,
   *   removeEventListener?: (type: string, fn: (e: any) => void) => void,
   *   location?: { origin?: string },
   * }} Win
   */
  /** @typedef {{ volume?: number, rate?: number, timeMode?: number, stepSize?: any }} PlaybackPrefs */

  const noop = () => {};
  const STEP_SIZE_NULL = null;

  // ---------------------------------------------------------------------------------------------------------------
  // 1. Prefs sync
  // ---------------------------------------------------------------------------------------------------------------

  /**
   * Keeps only the fields a playback-prefs message may carry, each valid (src/extension.js rememberPlaybackPrefs).
   * @param {any} p
   * @returns {PlaybackPrefs}
   */
  function cleanPlaybackPrefs(p) {
    /** @type {PlaybackPrefs} */
    const out = {};
    if (!p || typeof p !== 'object') return out;
    const vol = Number(p.volume);
    if (p.volume !== undefined && Number.isFinite(vol) && vol >= 0 && vol <= 1) out.volume = Math.round(vol * 100) / 100;
    const rate = Number(p.rate);
    if (p.rate !== undefined && Number.isFinite(rate) && rate > 0) out.rate = rate;
    if ([0, 1, 2].includes(p.timeMode)) out.timeMode = p.timeMode;
    if (p.stepSize !== undefined) out.stepSize = p.stepSize; // null: back to the stepButtons setting
    return out;
  }

  /**
   * The live settings the host sends when VS Code's settings change ({ type: 'prefs' }), normalised the way
   * media/player.js reads them. Fields the message leaves out stay out.
   * @param {any} p
   */
  function cleanLivePrefs(p) {
    /** @type {{ jump?: any, stepButtons?: 'frame'|'jump', transcode?: string, transcodeMaxBitrate?: number, transcodeResolution?: number }} */
    const out = {};
    if (!p || typeof p !== 'object') return out;
    if (p.jump && typeof p.jump === 'object') out.jump = { ...p.jump };
    if (p.stepButtons !== undefined) out.stepButtons = p.stepButtons === 'jump' ? 'jump' : 'frame';
    if (p.transcode) out.transcode = String(p.transcode);
    if (p.transcodeMaxBitrate !== undefined) out.transcodeMaxBitrate = Number(p.transcodeMaxBitrate) || 0;
    if (p.transcodeResolution !== undefined) out.transcodeResolution = Number(p.transcodeResolution) || 0;
    return out;
  }

  /** @param {any} a @param {any} b */
  const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  /**
   * @param {{
   *   win: Win, host: Host, storage: Storage,
   *   onApplyPlaybackPrefs?: (prefs: PlaybackPrefs, info: { quiet: true }) => void,
   *   onApplyLivePrefs?: (prefs: ReturnType<typeof cleanLivePrefs>) => void,
   *   debounceMs?: number,
   * }} opts
   */
  function createPrefsSync({ win, host, storage, onApplyPlaybackPrefs = noop, onApplyLivePrefs = noop, debounceMs = 300 }) {
    /** The shared prefs as this tab last knew them (sent or received): a publish of the same values is no news. */
    /** @type {PlaybackPrefs} */
    let known = {};
    /** JSON of the last snapshot written to storage. */
    let lastSaved = '';
    /** @type {any} */
    let timer = null;
    /** @type {any} */
    let pending;
    let disposed = false;

    const loadSaved = () => {
      const s = storage.getState();
      return s && typeof s === 'object' ? s : {};
    };
    /** The prefs also live in the saved state, so a reload starts with them (media/player.js postPlaybackPrefs). */
    const mergeIntoState = (/** @type {PlaybackPrefs} */ p) => {
      const next = { ...loadSaved(), ...p };
      storage.setState(next);
      lastSaved = JSON.stringify(next);
    };

    /**
     * This tab changed a shared pref: tell the host (the other tabs follow it). Unchanged values post nothing, which
     * also stops the echo of a prefs message this tab just applied.
     * @param {PlaybackPrefs} p
     * @returns {boolean} whether a message went out
     */
    function publishPlaybackPrefs(p) {
      if (disposed) return false;
      const clean = cleanPlaybackPrefs(p);
      const next = { ...known, ...clean };
      if (sameJson(next, known)) return false;
      known = next;
      mergeIntoState(clean);
      host.postMessage({ type: 'playbackPrefs', volume: known.volume, rate: known.rate, timeMode: known.timeMode,
        stepSize: known.stepSize === undefined ? STEP_SIZE_NULL : known.stepSize });
      return true;
    }

    /**
     * Host messages this controller owns. Returns whether it handled the message.
     * @param {any} msg
     */
    function onHostMessage(msg) {
      if (disposed || !msg) return false;
      if (msg.type === 'playbackPrefs') {
        const clean = cleanPlaybackPrefs(msg.prefs);
        if (!Object.keys(clean).length) return true;
        known = { ...known, ...clean };
        mergeIntoState(clean);
        // Quiet: the page applies the values without publishing them again.
        onApplyPlaybackPrefs(clean, { quiet: true });
        return true;
      }
      if (msg.type === 'prefs') {
        const clean = cleanLivePrefs(msg.prefs);
        if (Object.keys(clean).length) onApplyLivePrefs(clean);
        return true;
      }
      return false;
    }

    /**
     * Writes the snapshot unless it equals the last one written (a paused page would write the same state every
     * second otherwise). Returns whether it wrote.
     * @param {any} [snapshot]
     */
    function saveNow(snapshot) {
      if (timer !== null) { win.clearTimeout(timer); timer = null; }
      const s = snapshot !== undefined ? snapshot : pending;
      pending = undefined;
      if (disposed || s === undefined) return false;
      const json = JSON.stringify(s);
      if (json === lastSaved) return false;
      lastSaved = json;
      storage.setState(s);
      return true;
    }

    /** Saves `snapshot` after `debounceMs` of quiet; a newer snapshot replaces a waiting one. @param {any} snapshot */
    function scheduleSave(snapshot) {
      if (disposed) return;
      pending = snapshot;
      if (timer !== null) win.clearTimeout(timer);
      timer = win.setTimeout(() => { timer = null; saveNow(); }, debounceMs);
    }

    function dispose() {
      if (timer !== null) win.clearTimeout(timer);
      timer = null;
      pending = undefined;
      disposed = true;
    }

    /** Seeds what this tab knows (the saved state or the host's initial prefs) without posting anything. */
    const seed = (/** @type {any} */ p) => { known = { ...known, ...cleanPlaybackPrefs(p) }; };

    return {
      publishPlaybackPrefs, onHostMessage, scheduleSave, saveNow, loadSaved, dispose, seed,
      pendingSave: () => timer !== null,
      known: () => ({ ...known }),
    };
  }

  // ---------------------------------------------------------------------------------------------------------------
  // 2. Goto and resume
  // ---------------------------------------------------------------------------------------------------------------

  /** A resume position shorter than this (seconds) is the start: no seek, no toast. */
  const RESUME_MIN = 0.5;
  /** A resume position this close to the end (seconds) starts over instead: the video was watched to its end. */
  const RESUME_END_MARGIN = 1;

  /**
   * Seconds from "90", "90.5", "1:30", "1:30.5" or "1:02:03". NaN when it is none of these.
   * @param {string} s
   */
  function parseClock(s) {
    const str = String(s).trim();
    if (!/^\d+(?::\d{1,2}){0,2}(?:\.\d+)?$/.test(str)) return NaN;
    const parts = str.split(':').map(Number);
    // Minutes and seconds after the first field stay below 60 ("1:99" is a typo, not 2:39).
    if (parts.slice(1).some((x) => x >= 60)) return NaN;
    return parts.reduce((acc, part) => acc * 60 + part, 0);
  }

  /**
   * A URL fragment frame link: `#t=<seconds | m:ss | h:mm:ss>` or `#frame=<1-based>` (the first one that parses
   * among `&`-separated keys). Null when it has none.
   * @param {string | null | undefined} hash
   * @returns {{ t: number } | { frame: number } | null}
   */
  function parseFragmentLink(hash) {
    if (!hash) return null;
    const body = String(hash).replace(/^#/, '');
    for (const part of body.split('&')) {
      const eq = part.indexOf('=');
      if (eq < 0) continue;
      const key = part.slice(0, eq).trim().toLowerCase();
      let val = part.slice(eq + 1);
      try { val = decodeURIComponent(val); } catch { /* keep the raw text */ }
      if (key === 't') {
        const t = parseClock(val.replace(/s$/, ''));
        if (Number.isFinite(t) && t >= 0) return { t };
      } else if (key === 'frame') {
        if (/^\d+$/.test(val.trim()) && Number(val) >= 1) return { frame: Number(val) };
      }
    }
    return null;
  }

  /** m:ss.mmm (h:mm:ss.mmm past an hour): the fallback when no formatter is given. @param {number} t */
  function defaultFormatTime(t) {
    const ms = Math.max(0, Math.round(t * 1000));
    const h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, s = Math.floor(ms / 1000) % 60;
    const tail = `${String(s).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`;
    return h ? `${h}:${String(m).padStart(2, '0')}:${tail}` : `${m}:${tail}`;
  }

  /**
   * A goto target from a host message or config: { frame } (1-based) or { t }, plus an optional layout `mode`.
   * @param {any} g
   * @returns {{ frame?: number, t?: number, mode?: string } | null}
   */
  function cleanGoto(g) {
    if (!g || typeof g !== 'object') return null;
    const frame = Number(g.frame), t = Number(g.t);
    const mode = typeof g.mode === 'string' && g.mode ? g.mode : undefined;
    if (g.frame !== undefined && g.frame !== null && Number.isInteger(frame) && frame >= 1) return { frame, mode };
    if (g.t !== undefined && g.t !== null && Number.isFinite(t) && t >= 0) return { t, mode };
    return mode ? { mode } : null;
  }

  /**
   * @param {{
   *   onSeek: (target: { frame: number } | { time: number }) => void,
   *   onSetLayout?: (mode: string) => void,
   *   onToast?: (text: string) => void,
   *   formatTime?: (t: number) => string,
   * }} opts
   */
  function createGotoAndResume({ onSeek, onSetLayout = noop, onToast = noop, formatTime = defaultFormatTime }) {
    /** @param {{ frame?: number, t?: number, mode?: string }} g */
    function go(g) {
      if (g.mode) onSetLayout(g.mode);
      if (g.frame !== undefined) {
        onSeek({ frame: g.frame });
        onToast(`Frame ${g.frame}`);
      } else if (g.t !== undefined) {
        onSeek({ time: g.t });
        onToast(formatTime(g.t));
      }
    }

    /**
     * What a newly opened tab shows first. A frame link (config goto, else the URL fragment) wins over the saved
     * position and opens paused; else a saved position past RESUME_MIN and not at the end resumes with a toast.
     * @param {{ gotoCfg?: any, fragment?: string | { t?: number, frame?: number } | null, savedTime?: number, duration?: number }} a
     * @returns {{ kind: 'goto', paused: true, frame?: number, t?: number, mode?: string } | { kind: 'resume', t: number } | { kind: 'start' }}
     */
    function applyOpenTarget({ gotoCfg, fragment, savedTime, duration } = {}) {
      const link = cleanGoto(gotoCfg)
        || cleanGoto(typeof fragment === 'string' ? parseFragmentLink(fragment) : fragment);
      if (link && (link.frame !== undefined || link.t !== undefined)) {
        go(link);
        return { kind: 'goto', paused: true, ...link };
      }
      const t = Number(savedTime);
      const d = Number(duration);
      const nearEnd = Number.isFinite(d) && d > 0 && d - t < RESUME_END_MARGIN;
      if (Number.isFinite(t) && t > RESUME_MIN && !nearEnd) {
        onSeek({ time: t });
        onToast(`Resumed at ${formatTime(t)} (Home: start)`);
        return { kind: 'resume', t };
      }
      return { kind: 'start' };
    }

    /** A live { type: 'goto', mode?, frame?, t? } from the host (a frame link opened on this tab). @param {any} msg */
    function handleGotoMessage(msg) {
      if (!msg || msg.type !== 'goto') return false;
      const g = cleanGoto(msg);
      if (g) go(g);
      return true;
    }

    return { applyOpenTarget, handleGotoMessage, parseFragmentLink };
  }

  // ---------------------------------------------------------------------------------------------------------------
  // 3. Rail handoff (Autoplay "Play next in folder", folder navigation between tabs)
  // ---------------------------------------------------------------------------------------------------------------

  /**
   * @param {{
   *   host: Host,
   *   rail?: { go: (dir: number, auto?: boolean) => void, adopt: (state: any) => void, onMessage?: (m: any) => void } | null,
   *   onSetAutoplay?: (mode: string) => void,
   *   onPlayFromStart?: () => void,
   * }} opts
   */
  function createRailHandoffController({ host, rail = null, onSetAutoplay = noop, onPlayFromStart = noop }) {
    let ready = false;
    let seeded = false;
    /** @type {any} the newest handoff not applied yet (a newer one replaces it) */
    let pending = null;

    /**
     * The video played into its end. Autoplay "Play next in folder" opens the next one, but only for a visible tab
     * playing forward a file of a folder (not a URL).
     * @param {{ visible?: boolean, rate?: number, isFile?: boolean, autoplayMode?: string }} s
     */
    function onNaturalEnd({ visible, rate, isFile, autoplayMode }) {
      if (autoplayMode !== 'next' || !visible || !(Number(rate) > 0) || !isFile || !rail) return false;
      rail.go(1, true);
      return true;
    }

    function apply() {
      const m = pending;
      if (!m || !ready) return false;
      pending = null;
      if (m.onEnd) onSetAutoplay(m.onEnd);
      if (rail && m.rail) rail.adopt(m.rail);
      if (m.fromAutoNext) onPlayFromStart();
      // Only now may the host close the source tab.
      host.postMessage({ type: 'railAdopted', id: m.id, ok: true });
      return true;
    }

    /** The player began (first picture on the way, resume applied): a waiting handoff applies now. */
    function markReady() {
      ready = true;
      apply();
    }

    /** A new clip loads in this page: handoffs wait again and the rail gets a fresh seed. */
    function resetClip() {
      ready = false;
      seeded = false;
    }

    /** @param {any} msg */
    function onHostMessage(msg) {
      if (!msg) return false;
      switch (msg.type) {
        case 'railHandoff': pending = msg; apply(); return true;
        case 'railHandoffCancel': if (pending && pending.id === msg.id) pending = null; return true;
        case 'rail': if (rail && rail.onMessage) rail.onMessage(msg); return true;
        default: return false;
      }
    }

    /** The rail as it was before a reload (config railCarry). @param {any} carry */
    function adoptCarry(carry) {
      if (!rail || !carry) return false;
      rail.adopt(carry);
      return true;
    }

    /**
     * Tells the rail this file's duration and picture size so it need not probe it again; once per clip.
     * @param {{ duration?: number, width?: number, height?: number, codec?: string }} meta
     */
    function seedSelf({ duration, width, height, codec } = {}) {
      if (seeded || !rail) return false;
      seeded = true;
      host.postMessage({ type: 'rail', op: 'self', duration: Number(duration) || 0, width: Number(width) || 0,
        height: Number(height) || 0, codec: codec ? String(codec) : '' });
      return true;
    }

    return {
      onNaturalEnd, markReady, resetClip, onHostMessage, adoptCarry, seedSelf,
      hasPending: () => !!pending,
      isReady: () => ready,
    };
  }

  // ---------------------------------------------------------------------------------------------------------------
  // 4. Overlay (status, errors, the one action)
  // ---------------------------------------------------------------------------------------------------------------

  /** The actions an error may offer, by id (the host names the id only). */
  const ACTIONS = { setupFfmpeg: 'Set up ffmpeg' };

  /**
   * @param {{
   *   doc: { createElement: (tag: string) => any },
   *   overlayEl: any, messageEl: any, hintEl: any, actionEl?: any,
   *   host: Host,
   *   onAnnounce?: (text: string) => void,
   * }} opts
   */
  function createOverlayController({ doc, overlayEl, messageEl, hintEl, actionEl, host, onAnnounce = noop }) {
    /** @type {{ id: string, label: string } | null} */
    let action = null;
    let lastAnnounced = '';
    let btn = actionEl || null;
    let wired = false;

    const button = () => {
      if (!btn) {
        btn = doc.createElement('button');
        btn.setAttribute('type', 'button');
        btn.className = 'overlay-action';
        overlayEl.appendChild(btn);
      }
      if (!wired) {
        wired = true;
        btn.addEventListener('click', (/** @type {any} */ e) => {
          if (e && e.stopPropagation) e.stopPropagation();
          if (!action || btn.disabled) return;
          btn.disabled = true;
          btn.textContent = 'Downloading…';
          host.postMessage({ type: 'action', id: action.id });
        });
      }
      return btn;
    };

    /** @param {string} text */
    const announce = (text) => {
      if (!text || text === lastAnnounced) return;
      lastAnnounced = text;
      onAnnounce(text);
    };

    /** @param {string | string[]} textOrLines */
    function renderMessage(textOrLines) {
      if (Array.isArray(textOrLines)) {
        const lines = textOrLines.map((x) => String(x)).filter(Boolean);
        messageEl.replaceChildren();
        for (const line of lines) {
          const div = doc.createElement('div');
          div.className = 'overlay-line';
          div.textContent = line;
          messageEl.appendChild(div);
        }
        return lines.join('. ');
      }
      const text = String(textOrLines || '');
      messageEl.textContent = text;
      return text;
    }

    /** @param {{ id: string, label: string } | null} a */
    function setAction(a) {
      action = a;
      if (!a) { if (btn) btn.hidden = true; return; }
      const b = button();
      b.hidden = false;
      b.disabled = false;
      b.textContent = a.label;
    }

    /**
     * A progress line ("Opening…", "Switching quality…") or one line per Compare tile ("A: Opening…").
     * @param {string | string[]} textOrLines
     * @param {string} [hint]
     */
    function showStatus(textOrLines, hint = '') {
      const text = renderMessage(textOrLines);
      hintEl.textContent = hint || '';
      overlayEl.classList.remove('error');
      setAction(null);
      overlayEl.hidden = !text;
      announce(hint ? `${text} ${hint}` : text);
    }

    /**
     * An error, its hint and at most one action (by id; the label is ACTIONS[id] unless given).
     * @param {{ message: string, hint?: string, action?: string | { id: string, label?: string } | null }} e
     */
    function showError({ message, hint = '', action: act = null }) {
      const text = renderMessage(String(message || ''));
      hintEl.textContent = hint || '';
      overlayEl.classList.add('error');
      const id = typeof act === 'string' ? act : act && act.id;
      const label = (act && typeof act === 'object' && act.label) || (id && ACTIONS[/** @type {keyof typeof ACTIONS} */ (id)]);
      setAction(id && label ? { id, label } : null);
      overlayEl.hidden = !text;
      announce(hint ? `${text} ${hint}` : text);
    }

    function hide() {
      overlayEl.hidden = true;
      overlayEl.classList.remove('error');
      messageEl.textContent = '';
      hintEl.textContent = '';
      setAction(null);
      lastAnnounced = '';
    }

    /**
     * Host 'error' (shown) and 'status' (shown only while the overlay is up and nothing plays yet).
     * @param {any} msg
     * @param {{ started?: boolean }} [ctx]
     */
    function onHostMessage(msg, ctx = {}) {
      if (!msg) return false;
      if (msg.type === 'error') { showError({ message: msg.message, hint: msg.hint, action: msg.action || null }); return true; }
      if (msg.type === 'status') {
        if (!ctx.started && !overlayEl.hidden) showStatus(String(msg.text || ''));
        return true;
      }
      return false;
    }

    return { showStatus, showError, hide, onHostMessage, isShown: () => !overlayEl.hidden };
  }

  // ---------------------------------------------------------------------------------------------------------------
  // 5. Lifecycle bridge (ready, tile size, pauseForTest, pagehide)
  // ---------------------------------------------------------------------------------------------------------------

  /** Tile-size debounce: raw native frames resize fast; a transcoded tile restarts ffmpeg, so it waits longer. */
  const TILE_FAST_MS = 150;
  const TILE_SLOW_MS = 300;

  /**
   * @param {{
   *   win: Win, host: Host,
   *   onTileSize?: (tile: any) => void,
   *   onPauseForTest?: () => boolean | void,
   *   onToast?: (text: string, ms?: number) => void,
   *   onDispose?: () => void,
   * }} opts
   */
  function createLifecycleBridge({ win, host, onTileSize = noop, onPauseForTest = noop, onToast = noop, onDispose = noop }) {
    let lastTileKey = '';
    /** @type {any} */
    let timer = null;
    let disposed = false;

    /** @param {{ tile?: any, origin?: string, view?: any }} a */
    function sendReady({ tile, origin, view } = {}) {
      /** @type {any} */
      const msg = { type: 'ready' };
      if (tile !== undefined) { msg.tile = tile; lastTileKey = JSON.stringify(tile); }
      const o = origin !== undefined ? origin : win.location && win.location.origin;
      if (o !== undefined) msg.origin = o;
      if (view !== undefined) msg.view = view;
      host.postMessage(msg);
    }

    /**
     * Posts { type: 'tileSize', tile } after a quiet spell; `tile` may be a function read when the timer fires (the
     * size after the resize settled). An empty or unchanged size posts nothing.
     * @param {any} tile
     * @param {boolean} [fast]
     */
    function scheduleTileSize(tile, fast = false) {
      if (disposed) return;
      if (timer !== null) win.clearTimeout(timer);
      timer = win.setTimeout(() => {
        timer = null;
        const t = typeof tile === 'function' ? tile() : tile;
        if (!t || !t.w || !t.h) return;
        const key = JSON.stringify(t);
        if (key === lastTileKey) return;
        lastTileKey = key;
        host.postMessage({ type: 'tileSize', tile: t });
        onTileSize(t);
      }, fast ? TILE_FAST_MS : TILE_SLOW_MS);
    }

    /** @param {any} msg */
    function onHostMessage(msg) {
      if (!msg || msg.type !== 'pauseForTest') return false;
      // onPauseForTest returns false when nothing was playing: nothing to say then.
      if (onPauseForTest() !== false) onToast('Paused while ffmpeg is tested', 3000);
      return true;
    }

    const onPageHide = () => dispose();

    function dispose() {
      if (disposed) return;
      disposed = true;
      if (timer !== null) win.clearTimeout(timer);
      timer = null;
      if (win.removeEventListener) win.removeEventListener('pagehide', onPageHide);
      onDispose();
    }

    if (win.addEventListener) win.addEventListener('pagehide', onPageHide, { once: true });

    return { sendReady, scheduleTileSize, onHostMessage, dispose, isDisposed: () => disposed };
  }

  // checkJs: end
  const api = {
    createPrefsSync, createGotoAndResume, createRailHandoffController, createOverlayController, createLifecycleBridge,
    parseFragmentLink, parseClock, cleanPlaybackPrefs, cleanLivePrefs, defaultFormatTime,
    RESUME_MIN, RESUME_END_MARGIN, TILE_FAST_MS, TILE_SLOW_MS, ACTIONS,
  };
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) /** @type {any} */ (root).VpePlayerUiLifecycle = api;
}(typeof self !== 'undefined' ? self : typeof window !== 'undefined' ? window : this));
