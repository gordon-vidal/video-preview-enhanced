// @ts-check
'use strict';
// The unified page's host side (docs/notes/player-ui-controller.md, "Next step: one unified page"): one webview
// panel that grows from 1 video to N and back to 1 in place, without a new webview. CompareSession
// (src/compare.js) replaces its page when a video is added or removed; this coordinator only tells the page
// what changed (openVideo, replaceTile) and keeps the host's view of it: the clips, their display order, the
// tab title, the folder rail's "in Compare" marks and whether newly opened videos join this panel (capture).
//
// Pure: no vscode, no fs. Every effect is an injected callback, so a Node test drives it
// (test/host/unified_session_test.js). Not wired yet: the Phase 5 cutover creates sessions from src/extension.js
// and asks createUnifiedRegistry().routeOpen() before it opens a new tab for a video.
const { unifiedHtml } = require('./unified-html');

// checkJs: start
/**
 * @typedef {{ toString(): string }} UriLike
 * @typedef {object} UnifiedClip
 * @property {string} id      stable id the page uses for this clip's tile (readBlock / thumb route by it)
 * @property {UriLike | string} [uri]
 * @property {string} label   the file name shown in the tab title and the tile
 * @property {string} [fsPath]
 * @property {unknown} [meta]
 *
 * The shared contracts (media/unified-contracts.d.ts): the page's messages in, the host's out.
 * @typedef {import('../media/unified-contracts').PageToHostMessage} PageToHostMessage
 * @typedef {import('../media/unified-contracts').HostToPageMessage} HostToPageMessage
 * @typedef {import('../media/unified-contracts').ClipDescriptor} ClipDescriptor
 * @typedef {import('../media/unified-contracts').TileSizePayload} TileSize
 * A page message as received: untrusted, so every field is read loosely and checked at run time.
 * @typedef {{ type: string, [k: string]: any }} PageMessage
 *
 * @typedef {object} UnifiedSessionDeps
 * @property {any} [panel]  the WebviewPanel (title, webview.html, webview.postMessage); optional in tests
 * @property {Partial<UnifiedClip> & { uri?: UriLike | string }} initialClip
 * @property {number} [maxVideos]  the setting compare.maxVideos (2-16)
 * @property {boolean} [capture]   start capturing newly opened videos (default off)
 * @property {(s: UnifiedSession) => any} [renderHtml]  the page's UnifiedHtmlInput when render() gets none
 * @property {(m: HostToPageMessage) => void} [onPost]    host -> page (default: panel.webview.postMessage)
 * @property {(title: string) => void} [onTitleChange]
 * @property {(excludeIds: string[], s: UnifiedSession) => Promise<any> | any} [onPickVideo]
 *   "Add video": a clip, an array of clips, or nothing (cancelled)
 * @property {(oldId: string, excludeIds: string[], s: UnifiedSession) => Promise<any> | any} [onReplacePick]
 * @property {(m: PageMessage, s: UnifiedSession) => any} [onSaveFrame]
 * @property {(text: string) => any} [onCopyText]
 * @property {() => any} [onOpenSettings]
 * @property {(m: PageMessage) => any} [onOpenUrl]
 * @property {(m: PageMessage) => any} [onExternal]
 * @property {(what: 'toggle' | 'exited') => any} [onFocusMode]
 * @property {(m: PageMessage, s: UnifiedSession) => any} [onPlaybackPrefs]
 * @property {(m: PageMessage, s: UnifiedSession) => any} [onRailMessage]  'rail' and 'neighbour'
 * @property {(clip: UnifiedClip, m: PageMessage) => any} [onReadBlock]
 * @property {(clip: UnifiedClip, m: PageMessage) => any} [onThumb]
 * @property {(clip: UnifiedClip, m: PageMessage) => any} [onNative]  'nd': the page's native-decoder request for a clip
 * @property {(size: TileSize, clip: UnifiedClip | null) => any} [onTileSize]  the page's decode size (clip: per tile)
 * @property {(s: UnifiedSession) => void} [onDispose]
 *
 * @typedef {'active' | 'capture' | 'clips' | 'dispose'} SessionEvent
 * @typedef {ReturnType<typeof createUnifiedSession>} UnifiedSession
 */

const DEFAULT_MAX = 8;
/** Titles name this many clips; more add " (+k)". */
const TITLE_NAMES = 3;
/** Page state the 'sessionState' message on 'ready' carries anyway: not queued before the page is ready. */
const STATE_MESSAGES = new Set(['openVideo', 'replaceTile']);

/** @param {unknown} v */
const isId = (v) => typeof v === 'string' && v.length > 0 && v.length <= 200;

/** The file a clip shows, for duplicate checks: its URI, else its path. @param {Partial<UnifiedClip>} c */
function fileKeyOf(c) {
  if (c.uri) return String(c.uri);
  return c.fsPath || '';
}

/**
 * What the page may know about a clip: its id, label and probed facts, never its path or URI (the page reads
 * blocks by clip id). A field the clip lacks comes from its meta, if that has it. The numbers (size, duration,
 * fps ...) are what the page's decoders need before they probe (media/player-unified.js createPlayer).
 * @param {UnifiedClip} c
 * @returns {ClipDescriptor}
 */
function clipDescriptor(c) {
  const meta = c.meta && typeof c.meta === 'object' ? /** @type {Record<string, any>} */ (c.meta) : {};
  const src = /** @type {Record<string, any>} */ (c);
  /** @param {string} k */
  const pick = (k) => (src[k] !== undefined ? src[k] : meta[k]);
  /** @param {string} k */
  const num = (k) => { const v = Number(pick(k)); return Number.isFinite(v) && v >= 0 ? v : 0; };
  const codec = pick('codec');
  const kind = pick('kind');
  return {
    clipId: c.id, label: c.label, name: c.label,
    size: num('size'), duration: num('duration'), fps: num('fps'), frames: num('frames'),
    width: num('width'), height: num('height'), rotation: num('rotation'),
    hasAudio: pick('hasAudio') !== false,
    native: !!pick('native'),
    codec: typeof codec === 'string' ? codec : '',
    kind: typeof kind === 'string' && kind ? kind : 'file',
  };
}

/**
 * A tileSize message's size: { tile: { w, h, ... } } (media/player-ui-lifecycle.js) or top-level w, h.
 * @param {PageMessage} m @returns {TileSize | null}
 */
function tileSizeOf(m) {
  const t = m.tile && typeof m.tile === 'object' ? m.tile : m;
  const w = Number(t.w), h = Number(t.h);
  if (!(w > 0 && h > 0 && Number.isFinite(w) && Number.isFinite(h))) return null;
  /** @type {TileSize} */
  const size = { w, h };
  for (const k of /** @type {const} */ (['n', 'zoom', 'rate'])) if (Number.isFinite(t[k])) size[k] = t[k];
  if (typeof t.layout === 'string') size.layout = t.layout;
  return size;
}

/** @param {string} p */
const baseName = (p) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;

/**
 * The tab title for clip labels in display order: "a.mp4", "a.mp4 ↔ b.mp4", "a · b · c (+2)".
 * @param {string[]} labels
 */
function titleOf(labels) {
  if (labels.length <= 1) return labels[0] || '';
  if (labels.length === 2) return `${labels[0]} ↔ ${labels[1]}`;
  const more = labels.length - TITLE_NAMES;
  return labels.slice(0, TITLE_NAMES).join(' · ') + (more > 0 ? ` (+${more})` : '');
}

/**
 * @param {UnifiedSessionDeps} deps
 */
function createUnifiedSession(deps) {
  const panel = deps.panel || null;
  const maxVideos = Number.isInteger(deps.maxVideos) && /** @type {number} */ (deps.maxVideos) >= 1
    ? /** @type {number} */ (deps.maxVideos) : DEFAULT_MAX;
  let nextId = 0;
  /** @param {Partial<UnifiedClip> & { uri?: UriLike | string }} c @returns {UnifiedClip} */
  const normalize = (c) => {
    const id = isId(c.id) ? /** @type {string} */ (c.id) : `clip${++nextId}`;
    const label = c.label || (c.fsPath ? baseName(c.fsPath) : c.uri ? baseName(String(c.uri)) : id);
    return { ...c, id, label };
  };

  /** @type {UnifiedClip[]} */
  let clips = [normalize(deps.initialClip || {})];
  /** @type {string[]} display order of clip ids */
  let order = [clips[0].id];
  let capture = !!deps.capture;
  let active = false;
  let disposed = false;
  let ready = false;
  /** @type {HostToPageMessage[]} posts before the page is ready (toasts): sent on 'ready' */
  let queued = [];
  /** @type {Map<string, { w: number, h: number }>} */
  const tileSizes = new Map();
  /** @type {TileSize | null} the last size the page reported, for any tile */
  let lastTileSize = null;
  /** @type {{ refreshMembers(): void } | null} */
  let rail = null;
  let title = '';
  /** @type {Set<(e: SessionEvent, s: UnifiedSession) => void>} */
  const listeners = new Set();

  /** @param {string} id */
  const clipOf = (id) => clips.find((c) => c.id === id) || null;
  const ordered = () => order.map(clipOf).filter((c) => !!c).map((c) => /** @type {UnifiedClip} */ (c));
  /** @param {Partial<UnifiedClip>} c @param {string} [except] a clip id that does not count */
  const duplicateOf = (c, except) => {
    const key = fileKeyOf(c);
    return clips.find((x) => x.id !== except && ((isId(c.id) && x.id === c.id) || (key && fileKeyOf(x) === key))) || null;
  };

  /** @param {SessionEvent} e */
  const emit = (e) => { for (const fn of [...listeners]) { try { fn(e, session); } catch { /* a listener never breaks the session */ } } };

  /** @param {HostToPageMessage} m */
  function post(m) {
    if (disposed) return;
    if (!ready) {
      if (!STATE_MESSAGES.has(m.type)) queued.push(m);
      return;
    }
    send(m);
  }
  /** @param {HostToPageMessage} m */
  function send(m) {
    if (deps.onPost) deps.onPost(m);
    else if (panel && panel.webview) panel.webview.postMessage(m);
  }

  /** @param {string} text @param {number} ms */
  const toast = (text, ms) => post({ type: 'toast', text, ms });

  /** The clips changed: tab title, rail marks, listeners. */
  function changed() {
    const next = titleOf(ordered().map((c) => c.label));
    if (next !== title) {
      title = next;
      if (panel) panel.title = next;
      if (deps.onTitleChange) deps.onTitleChange(next);
    }
    if (rail) rail.refreshMembers();
    emit('clips');
  }

  /**
   * Adds a video after the ones shown. A duplicate or a full panel only says so (a toast).
   * @param {Partial<UnifiedClip> & { uri?: UriLike | string }} clip
   * @param {{ compare?: boolean }} [o] compare: the page shows the clips side by side (else it may swap the view)
   * @returns {boolean} added
   */
  function addClip(clip, { compare = true } = {}) {
    if (disposed || !clip) return false;
    const dup = duplicateOf(clip);
    if (dup) { toast(`${dup.label} is in compare already`, 2000); return false; }
    if (clips.length >= maxVideos) { toast(`Compare is full (${maxVideos} videos)`, 2500); return false; }
    const c = normalize(clip);
    clips = [...clips, c];
    order = [...order, c.id];
    changed();
    post({ type: 'openVideo', clipId: c.id, label: c.label, clip: clipDescriptor(c), compare });
    return true;
  }

  /**
   * Shows another video in a tile's place (same position in the order).
   * @param {string} oldId
   * @param {Partial<UnifiedClip> & { uri?: UriLike | string }} newClip
   * @returns {boolean} replaced
   */
  function replaceClip(oldId, newClip) {
    if (disposed || !newClip || !clipOf(oldId)) return false;
    const dup = duplicateOf(newClip, oldId);
    if (dup) { toast(`${dup.label} is in compare already`, 2000); return false; }
    const c = normalize(newClip);
    clips = clips.map((x) => (x.id === oldId ? c : x));
    order = order.map((id) => (id === oldId ? c.id : id));
    tileSizes.delete(oldId);
    changed();
    post({ type: 'replaceTile', oldId, newId: c.id, label: c.label, clip: clipDescriptor(c) });
    return true;
  }

  /**
   * Back to one video: the kept clip stays, capture ends.
   * @param {string} keepId
   * @returns {boolean} collapsed (false: no such clip)
   */
  function leaveCompare(keepId) {
    if (disposed) return false;
    const kept = clipOf(keepId);
    if (!kept) return false;
    clips = [kept];
    order = [kept.id];
    for (const id of [...tileSizes.keys()]) if (id !== kept.id) tileSizes.delete(id);
    setCapture(false);
    changed();
    return true;
  }

  /** @param {boolean} on */
  function setCapture(on) {
    if (capture === !!on) return;
    capture = !!on;
    emit('capture');
  }

  const shouldCapture = () => !disposed && capture && clips.length < maxVideos;

  /** The page's tiles: the clips it still shows, in its order (a tile closed in the page). @param {PageMessage} m */
  function syncTiles(m) {
    // media/player-ui.js posts { tiles, current }; older pages { order } or { clips }.
    const list = Array.isArray(m.tiles) ? m.tiles : Array.isArray(m.order) ? m.order : Array.isArray(m.clips) ? m.clips : null;
    const ids = list ? list.map((/** @type {any} */ c) => (c && typeof c === 'object' ? c.clipId || c.id : c)) : null;
    if (ids) {
      const known = [...new Set(ids.filter((id) => isId(id) && clipOf(id)))];
      // The page never shows no video: an empty or foreign list is not one of ours.
      if (known.length) {
        clips = clips.filter((c) => known.includes(c.id));
        order = known;
        for (const id of [...tileSizes.keys()]) if (!known.includes(id)) tileSizes.delete(id);
      }
    }
    if (typeof m.capture === 'boolean') setCapture(m.capture);
    changed();
  }

  /** @param {PageToHostMessage} msg */
  async function onMessage(msg) {
    const m = /** @type {PageMessage} */ (msg);
    if (disposed || !m || typeof m !== 'object' || typeof m.type !== 'string') return undefined;
    switch (m.type) {
      case 'ready': {
        ready = true;
        send({
          type: 'sessionState', clips: ordered().map(clipDescriptor),
          order: [...order], capture, maxVideos,
        });
        const q = queued;
        queued = [];
        for (const x of q) send(x);
        return undefined;
      }
      case 'tiles': return syncTiles(m);
      case 'tileOrder': {
        const o = Array.isArray(m.order) ? m.order : null;
        // Only a reordering of the clips shown: same ids, each once.
        if (!o || o.length !== order.length || new Set(o).size !== o.length || !o.every((id) => isId(id) && clipOf(id))) return undefined;
        order = [...o];
        changed();
        return undefined;
      }
      case 'tileSize': {
        const size = tileSizeOf(m);
        if (!size) return undefined;
        // A clip id the session does not show: not ours (a tile closed meanwhile).
        if (m.clipId !== undefined && !(isId(m.clipId) && clipOf(m.clipId))) return undefined;
        const c = m.clipId !== undefined ? clipOf(m.clipId) : null;
        lastTileSize = size;
        if (c) tileSizes.set(c.id, size);
        return deps.onTileSize ? deps.onTileSize(size, c) : undefined;
      }
      case 'capture': {
        const on = typeof m.on === 'boolean' ? m.on : m.capture;
        if (typeof on === 'boolean') setCapture(on);
        return undefined;
      }
      case 'pickVideo': {
        if (!deps.onPickVideo) return undefined;
        if (clips.length >= maxVideos) { toast(`Compare is full (${maxVideos} videos)`, 2500); return undefined; }
        const r = await deps.onPickVideo(clips.map((c) => c.id), session);
        if (disposed || !r) return undefined;
        for (const c of Array.isArray(r) ? r : [r]) addClip(c, { compare: true });
        return undefined;
      }
      case 'replaceVideo': {
        const oldId = m.clipId ?? m.oldId;
        if (!deps.onReplacePick || !isId(oldId) || !clipOf(oldId)) return undefined;
        const r = await deps.onReplacePick(oldId, clips.map((c) => c.id), session);
        if (disposed || !r) return undefined;
        replaceClip(oldId, r);
        return undefined;
      }
      case 'leaveCompare': {
        const keepId = m.keepId ?? m.clipId;
        return isId(keepId) ? leaveCompare(keepId) : undefined;
      }
      case 'playbackPrefs': return deps.onPlaybackPrefs ? deps.onPlaybackPrefs(m, session) : undefined;
      case 'copyText': return deps.onCopyText ? deps.onCopyText(String(m.text || '')) : undefined;
      case 'saveFrame': return deps.onSaveFrame ? deps.onSaveFrame(m, session) : undefined;
      case 'openSettings': return deps.onOpenSettings ? deps.onOpenSettings() : undefined;
      case 'openUrl': return deps.onOpenUrl ? deps.onOpenUrl(m) : undefined;
      case 'external': return deps.onExternal ? deps.onExternal(m) : undefined;
      case 'focusMode': return deps.onFocusMode ? deps.onFocusMode('toggle') : undefined;
      case 'focusModeExited': return deps.onFocusMode ? deps.onFocusMode('exited') : undefined;
      case 'rail':
      case 'neighbour': return deps.onRailMessage ? deps.onRailMessage(m, session) : undefined;
      // A clip's file blocks and seek-bar thumbnails: by the tile's clip id, never a path from the page.
      case 'readBlock': {
        const c = isId(m.clipId) ? clipOf(m.clipId) : null;
        return c && deps.onReadBlock ? deps.onReadBlock(c, m) : undefined;
      }
      case 'thumb': {
        const c = isId(m.clipId) ? clipOf(m.clipId) : null;
        return c && deps.onThumb ? deps.onThumb(c, m) : undefined;
      }
      // Native ffmpeg (src/native.js): per clip; a reply goes back through postNativeReply with the same id.
      case 'nd': {
        const id = m.clipId ?? m.key;
        const c = id === undefined || id === null ? (clips.length === 1 ? clips[0] : null) : isId(id) ? clipOf(id) : null;
        return c && deps.onNative ? deps.onNative(c, m) : undefined;
      }
      default: return undefined;
    }
  }

  /**
   * A native decoder's message to the page for one clip, tagged so two native tiles' replies never mix.
   * @param {string} clipId @param {any} reply
   * @returns {boolean} posted (false: the clip is gone)
   */
  function postNativeReply(clipId, reply) {
    if (disposed || !isId(clipId) || !clipOf(clipId)) return false;
    post({ type: 'nd', clipId, key: clipId, m: reply });
    return true;
  }

  /**
   * The page: src/unified-html.js with the unified boot script; body.compare from 2 clips on (media/compare.css).
   * Setting the HTML starts a new page, so posts wait for its 'ready' again.
   * @param {any} [htmlInput] UnifiedHtmlInput (default: deps.renderHtml(session))
   */
  function render(htmlInput) {
    const input = htmlInput || (deps.renderHtml ? deps.renderHtml(session) : null);
    if (!input) throw new Error('unified session: render needs the page input');
    const html = unifiedHtml({ ...input, entryScript: 'player-unified.js', bodyClass: clips.length >= 2 ? 'compare' : '' });
    if (panel && panel.webview && !disposed) {
      ready = false;
      panel.webview.html = html;
    }
    return html;
  }

  function dispose() {
    if (disposed) return;
    capture = false;
    disposed = true;
    queued = [];
    rail = null;
    if (deps.onDispose) deps.onDispose(session);
    emit('dispose');
    listeners.clear();
  }

  const session = {
    addClip, replaceClip, leaveCompare, shouldCapture, onMessage, render, dispose, post, postNativeReply,
    /** @param {boolean} on */
    setCapture(on) { if (!disposed) setCapture(on); },
    /** The panel became (in)active (onDidChangeViewState): the registry prefers the most recently active. @param {boolean} on */
    setActive(on) {
      if (disposed) return;
      active = !!on;
      emit('active');
    },
    /** The folder rail controller (src/folder-rail.js createFolderRail): its "in Compare" marks follow the clips. */
    setRail(/** @type {{ refreshMembers(): void } | null} */ r) { rail = disposed ? null : r; },
    /** The files shown, in display order (createFolderRail's deps.members). */
    members: () => ordered().map((c) => c.fsPath || '').filter(Boolean),
    /** @param {(e: SessionEvent, s: UnifiedSession) => void} fn @returns {() => void} unsubscribe */
    onChange(fn) { listeners.add(fn); return () => { listeners.delete(fn); }; },
    clipOf,
    get clips() { return ordered(); },
    get order() { return [...order]; },
    get capture() { return capture; },
    get active() { return active; },
    get disposed() { return disposed; },
    get ready() { return ready; },
    get title() { return title; },
    get maxVideos() { return maxVideos; },
    /** @param {string} id */
    tileSize: (id) => tileSizes.get(id) || null,
    /** The last size the page reported for any tile (its decode size), or null. */
    get lastTileSize() { return lastTileSize; },
  };
  changed();
  return session;
}

/**
 * Every live unified session, most recently active (or capture-switched) first. A video the user opens goes into
 * the first session that captures instead of a new tab.
 */
function createUnifiedRegistry() {
  /** @type {UnifiedSession[]} most recent first */
  let sessions = [];
  /** @type {Map<UnifiedSession, () => void>} */
  const unsubscribe = new Map();

  /** @param {UnifiedSession} s */
  const touch = (s) => { sessions = [s, ...sessions.filter((x) => x !== s)]; };
  /** @param {UnifiedSession} s */
  const remove = (s) => {
    sessions = sessions.filter((x) => x !== s);
    const off = unsubscribe.get(s);
    unsubscribe.delete(s);
    if (off) off();
  };

  return {
    /** @param {UnifiedSession} s @returns {() => void} remove */
    add(s) {
      if (!s || s.disposed || unsubscribe.has(s)) return () => remove(s);
      sessions = [...sessions, s];
      unsubscribe.set(s, s.onChange((e) => {
        if (e === 'dispose') remove(s);
        else if ((e === 'active' && s.active) || (e === 'capture' && s.capture)) touch(s);
      }));
      if (s.active) touch(s);
      return () => remove(s);
    },
    remove,
    /** The session a newly opened video would join, or null. */
    capturing() { return sessions.find((s) => s.shouldCapture()) || null; },
    /**
     * A video is being opened: the capturing session takes it (a duplicate only toasts there), else the caller
     * opens a tab.
     * @param {Partial<UnifiedClip> & { uri?: UriLike | string }} clip
     * @returns {{ captured: true, session: UnifiedSession, added: boolean } | { captured: false }}
     */
    routeOpen(clip) {
      const session = sessions.find((s) => s.shouldCapture());
      if (!session) return { captured: false };
      return { captured: true, session, added: session.addClip(clip) };
    },
    get sessions() { return [...sessions]; },
  };
}
// checkJs: end

module.exports = { createUnifiedSession, createUnifiedRegistry, titleOf, clipDescriptor, DEFAULT_MAX };
