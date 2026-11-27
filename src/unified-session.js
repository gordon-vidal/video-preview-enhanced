// @ts-check
'use strict';
// The unified page's host side (docs/notes/player-ui-controller.md, "Production wiring"): one webview
// panel that grows from 1 video to N and back to 1 in place, without a new webview: this coordinator only tells the
// page what changed (openVideo, replaceTile) and keeps the host's view of it: the clips, their display order, the
// tab title, the folder rail's "in Compare" marks and whether newly opened videos join this panel (capture).
//
// Pure: no vscode, no fs. Every effect is an injected callback, so a Node test drives it
// (test/host/unified_session_test.js). src/unified-viewer.js gives it those effects for a real panel, and
// src/extension.js asks createUnifiedRegistry().routeOpen() before a newly opened video gets a tab of its own.
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
 * @property {(clip: UnifiedClip | null, m: PageMessage, s: UnifiedSession) => any} [onLoadSubs]  "Load subtitles…"
 * @property {(clip: UnifiedClip, m: PageMessage, s: UnifiedSession) => any} [onCopyLink]  a frame link to the clipboard
 * @property {(kind: AbKind, clip: UnifiedClip | null, m: PageMessage, s: UnifiedSession) => any} [onExportAb]
 *   the A-B export protocol: the page's range (exportRange, clipRange, ffmpegRange) or a grabbed frame (exportFrame)
 * @property {(clip: UnifiedClip, m: PageMessage, s: UnifiedSession) => any} [onExactFrame]  'grabExactFrame'
 * @property {(clip: UnifiedClip, pos: SavedPos, s: UnifiedSession) => any} [onPos]  the page's position report
 * @property {(id: string, m: PageMessage, s: UnifiedSession) => any} [onAction]  'action' (and 'whenSlow' as id 'whenSlow')
 * @property {(m: PageMessage, s: UnifiedSession) => any} [onTranscodePref]
 * @property {(clip: UnifiedClip | null, m: PageMessage, s: UnifiedSession) => any} [onTranscodeResolution]
 * @property {(clip: UnifiedClip, m: PageMessage, s: UnifiedSession) => any} [onOriginalTile]  Live transcode -> built-in
 * @property {(clip: UnifiedClip, m: PageMessage, s: UnifiedSession) => any} [onQuality]  a URL clip's HLS quality pick
 * @property {(m: PageMessage, s: UnifiedSession) => any} [onRailAdopted]  the page's answer to a 'railHandoff'
 * @property {(m: PageMessage, s: UnifiedSession) => any} [onOther]  any other page message (decode speed samples,
 *   WebCodecs failures, Compare's quick pick on key D ...): src/extension.js decides what it means
 * @property {OpenTarget | null} [openTarget]  what the first page shows first: a frame link, the saved position, the rail
 * @property {(s: UnifiedSession) => void} [onDispose]
 *
 * @typedef {'exportRange' | 'clipRange' | 'ffmpegRange' | 'exportFrame'} AbKind
 * @typedef {'file' | 'url' | 'sequence'} SourceKind
 * @typedef {{ frame?: number, t?: number, mode?: string }} GotoTarget
 * @typedef {{ t: number, d: number }} SavedPos
 * @typedef {{ goto?: GotoTarget | null, savedPos?: SavedPos | null, railCarry?: any, fromAutoNext?: boolean }} OpenTarget
 * @typedef {ClipDescriptor & { sourceKind: SourceKind, goto?: GotoTarget, savedPos?: SavedPos }} ClipDescriptorPlus
 *
 * @typedef {'active' | 'capture' | 'clips' | 'dispose'} SessionEvent
 * @typedef {ReturnType<typeof createUnifiedSession>} UnifiedSession
 */

const DEFAULT_MAX = 8;
/** Titles name this many clips; more add " (+k)". */
const TITLE_NAMES = 3;
/** Page state the 'sessionState' message on 'ready' carries anyway: not queued before the page is ready. */
const STATE_MESSAGES = new Set(['openVideo', 'replaceTile']);
/** What a batch (session.batch) drops: the tile changes its closing render carries in the new page's sessionState. */
const BATCH_DROPPED = new Set([...STATE_MESSAGES, 'removeVideo']);
/**
 * Replies to a page's requests and its decoders' data (file blocks, native frames and sound, thumbnails, exact frames,
 * native tile sizes): they reach the page that asked at once, also inside a batch, and are never queued: a page that is
 * not ready yet asked for none of them (the one that did is gone), so they would only reach the wrong page.
 */
const REPLY_MESSAGES = new Set(['block', 'nd', 'nda', 'ndv', 'thumb', 'exactFrame', 'resize']);

const SOURCE_KINDS = new Set(['file', 'url', 'sequence']);
const AB_KINDS = new Set(['exportRange', 'clipRange', 'ffmpegRange', 'exportFrame']);

/** @param {unknown} v */
const isId = (v) => typeof v === 'string' && v.length > 0 && v.length <= 200;

/** The file a clip shows, for duplicate checks: its URI, else its path. @param {Partial<UnifiedClip>} c */
function fileKeyOf(c) {
  if (c.uri) return String(c.uri);
  return c.fsPath || '';
}

/**
 * A frame link's target as the page takes it (media/player-ui-lifecycle.js cleanGoto): a frame or a time; anything
 * else is dropped.
 * @param {any} g @returns {GotoTarget | null}
 */
function cleanGoto(g) {
  if (!g || typeof g !== 'object') return null;
  /** @type {GotoTarget} */
  const out = {};
  if (Number.isSafeInteger(g.frame) && g.frame >= 0) out.frame = g.frame;
  if (Number.isFinite(g.t) && g.t >= 0) out.t = g.t;
  if (out.frame === undefined && out.t === undefined) return null;
  if (typeof g.mode === 'string' && /^[a-z]{1,16}$/i.test(g.mode)) out.mode = g.mode;
  return out;
}

/** A position { t, d } in seconds (d: the duration, 0 when unknown), or null. @param {any} p @returns {SavedPos | null} */
function cleanPos(p) {
  if (!p || typeof p !== 'object' || !(Number.isFinite(p.t) && p.t >= 0)) return null;
  return { t: p.t, d: Number.isFinite(p.d) && p.d >= 0 ? p.d : 0 };
}

/** What a clip plays from: its sourceKind, else its kind, else (and for anything else) a file. @param {any} c @returns {SourceKind} */
function sourceKindOf(c) {
  const meta = c && c.meta && typeof c.meta === 'object' ? c.meta : {};
  for (const v of [c && c.sourceKind, c && c.kind, meta.sourceKind, meta.kind]) {
    if (SOURCE_KINDS.has(v)) return /** @type {SourceKind} */ (v);
  }
  return 'file';
}

/**
 * What the page may know about a clip: its id, label and probed facts, never its path or URI (the page reads
 * blocks by clip id). A field the clip lacks comes from its meta, if that has it. The numbers (size, duration,
 * fps ...) are what the page's decoders need before they probe (media/player-unified.js createPlayer). A frame link
 * (goto) or saved position (savedPos) the clip opens at rides along when it has one.
 * @param {UnifiedClip} c
 * @returns {ClipDescriptorPlus}
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
  /** @type {ClipDescriptorPlus} */
  const d = {
    clipId: c.id, label: c.label, name: c.label,
    size: num('size'), duration: num('duration'), fps: num('fps'), frames: num('frames'),
    width: num('width'), height: num('height'), rotation: num('rotation'),
    hasAudio: pick('hasAudio') !== false,
    native: !!pick('native'),
    codec: typeof codec === 'string' ? codec : '',
    kind: typeof kind === 'string' && kind ? kind : 'file',
    sourceKind: sourceKindOf(c),
  };
  const g = cleanGoto(pick('goto'));
  if (g) d.goto = g;
  const p = cleanPos(pick('savedPos'));
  if (p) d.savedPos = p;
  return d;
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
  // The grid and fit factor size each native tile's output (src/unified-viewer.js nativeHeightFor).
  for (const k of /** @type {const} */ (['n', 'cols', 'rows', 'zoom', 'rate', 'factor', 'aspect'])) if (Number.isFinite(t[k])) size[k] = t[k];
  if (typeof t.layout === 'string') size.layout = t.layout;
  if (typeof t.actual === 'boolean') size.actual = t.actual;
  return size;
}

/**
 * A tileSize message's per-tile cells ({ tile: { tiles: [{ clipId, w, h }] } }, media/player-ui.js in Compare): the
 * well-formed entries only (at most 64: more tiles than Compare shows are not the page's).
 * @param {PageMessage} m @returns {Array<{ clipId: string, w: number, h: number }>}
 */
function perTileSizes(m) {
  const t = m.tile && typeof m.tile === 'object' ? m.tile : m;
  const list = Array.isArray(t.tiles) ? t.tiles.slice(0, 64) : [];
  /** @type {Array<{ clipId: string, w: number, h: number }>} */
  const out = [];
  for (const e of list) {
    if (!e || typeof e !== 'object' || typeof e.clipId !== 'string') continue;
    const w = Number(e.w), h = Number(e.h);
    if (w > 0 && h > 0 && Number.isFinite(w) && Number.isFinite(h)) out.push({ clipId: e.clipId, w, h });
  }
  return out;
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
  /**
   * Open session.batch calls: while > 0 tile changes are not posted one by one, other posts (toasts) wait for the new
   * page, replies (REPLY_MESSAGES) go on to the old one.
   */
  let batchDepth = 0;
  /** @type {Map<string, { w: number, h: number }>} */
  const tileSizes = new Map();
  /** @type {TileSize | null} the last size the page reported, for any tile */
  let lastTileSize = null;
  /** @type {{ refreshMembers(): void } | null} */
  let rail = null;
  let title = '';
  /** @type {Map<string, SavedPos>} each clip's last reported position ('pos'), for a reload in place */
  const positions = new Map();
  /** @type {OpenTarget | null} what the next page shows first; sent with its sessionState, then spent */
  let openTarget = null;
  /** @param {OpenTarget | null | undefined} t */
  const setOpenTarget = (t) => {
    const goto = t ? cleanGoto(t.goto) : null;
    const savedPos = t ? cleanPos(t.savedPos) : null;
    const railCarry = t && t.railCarry !== undefined && t.railCarry !== null ? t.railCarry : null;
    const fromAutoNext = !!(t && t.fromAutoNext);
    openTarget = !disposed && (goto || savedPos || railCarry || fromAutoNext)
      ? { goto, savedPos, railCarry, ...(fromAutoNext ? { fromAutoNext: true } : {}) } : null;
  };
  setOpenTarget(deps.openTarget);
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
    const reply = REPLY_MESSAGES.has(m.type);
    if (batchDepth > 0 && !reply) {
      if (!BATCH_DROPPED.has(m.type)) queued.push(m);
      return;
    }
    if (!ready) {
      if (!STATE_MESSAGES.has(m.type) && !reply) queued.push(m);
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
    for (const id of [...positions.keys()]) if (!clipOf(id)) positions.delete(id);
    if (rail) rail.refreshMembers();
    emit('clips');
  }

  /** Clip ids sent via openVideo/replaceTile that the page has not yet echoed back in a `tiles` report. @type {Set<string>} */
  const pendingAdds = new Set();

  /**
   * Adds a video after the ones shown. A duplicate or a full panel only says so (a toast).
   * @param {Partial<UnifiedClip> & { uri?: UriLike | string }} clip
   * @param {{ compare?: boolean, allowDuplicate?: boolean }} [o] compare: the page shows the clips side by side (else
   *   it may swap the view). allowDuplicate: a file already shown joins again under a fresh clip id (an explicit
   *   list that names the same file twice, e.g. to check that identical pictures measure as identical); everything
   *   else (the Explorer, Add video, Add Mode) declines a duplicate.
   * @returns {boolean} added
   */
  function addClip(clip, { compare = true, allowDuplicate = false } = {}) {
    if (disposed || !clip) return false;
    const dup = duplicateOf(clip);
    if (dup && !allowDuplicate) { toast(`${dup.label} is in compare already`, 2000); return false; }
    if (clips.length >= maxVideos) { toast(`Compare is full (${maxVideos} videos)`, 2500); return false; }
    let fresh = clip;
    if (dup && isId(clip.id) && clipOf(/** @type {string} */ (clip.id))) {
      let k = 2;
      while (clipOf(`${clip.id}s${k}`)) k++;
      fresh = { ...clip, id: `${clip.id}s${k}` };
    }
    const c = normalize(fresh);
    clips = [...clips, c];
    order = [...order, c.id];
    pendingAdds.add(c.id);
    changed();
    post({ type: 'openVideo', clipId: c.id, label: c.label, clip: clipDescriptor(c), compare });
    return true;
  }

  /**
   * Shows another video in a tile's place (same position in the order).
   * @param {string} oldId
   * @param {Partial<UnifiedClip> & { uri?: UriLike | string }} newClip
   * @param {{ autoPlay?: boolean }} [opts]  autoPlay: Autoplay "Play next in folder" went on at the end of the one
   *   before, so the page plays the new video from its start (a manual Next leaves play/pause as it is)
   * @returns {boolean} replaced
   */
  function replaceClip(oldId, newClip, opts = {}) {
    if (disposed || !newClip || !clipOf(oldId)) return false;
    const dup = duplicateOf(newClip, oldId);
    if (dup) { toast(`${dup.label} is in compare already`, 2000); return false; }
    const c = normalize(newClip);
    clips = clips.map((x) => (x.id === oldId ? c : x));
    order = order.map((id) => (id === oldId ? c.id : id));
    pendingAdds.delete(oldId);
    pendingAdds.add(c.id);
    tileSizes.delete(oldId);
    changed();
    const auto = opts.autoPlay ? { autoPlay: true } : {};
    post({ type: 'replaceTile', oldId, newId: c.id, label: c.label, clip: clipDescriptor(c), ...auto });
    return true;
  }

  /**
   * The same source again (its file changed on disk, or it must be decoded another way), in the tile's place and at
   * its last position: the page starts a new decoder for it (replaceTile under a new id, reload: true) and the webview
   * stays. Not a duplicate of the clip it replaces.
   * @param {string} clipId
   * @param {Partial<UnifiedClip> & { uri?: UriLike | string }} newClip
   * @returns {string | null} the new clip id (null: no such clip, or a duplicate of another one)
   */
  function reloadClip(clipId, newClip) {
    if (disposed || !newClip || !clipOf(clipId)) return null;
    const dup = duplicateOf(newClip, clipId);
    if (dup) { toast(`${dup.label} is in compare already`, 2000); return null; }
    const pos = positions.get(clipId);
    const src = /** @type {Record<string, any>} */ (newClip);
    // Never the old id (nor another shown one): the page must drop the old decoder and its cached frames.
    const freshId = isId(newClip.id) && newClip.id !== clipId && !clipOf(/** @type {string} */ (newClip.id));
    const c = normalize({
      ...newClip, id: freshId ? newClip.id : undefined,
      ...(src.savedPos === undefined && pos ? { savedPos: pos } : {}),
    });
    clips = clips.map((x) => (x.id === clipId ? c : x));
    order = order.map((id) => (id === clipId ? c.id : id));
    if (pendingAdds.delete(clipId)) pendingAdds.add(c.id);
    const size = tileSizes.get(clipId);
    tileSizes.delete(clipId);
    if (size) tileSizes.set(c.id, size);
    if (pos) positions.set(c.id, pos);
    changed();
    post(/** @type {any} */ ({ type: 'replaceTile', oldId: clipId, newId: c.id, label: c.label, clip: clipDescriptor(c), reload: true }));
    return c.id;
  }

  /**
   * The clip a page message is about: its clipId (or key), else the first one shown. An id the session does not show
   * is no clip (a tile closed meanwhile).
   * @param {any} m @returns {UnifiedClip | null}
   */
  function clipFor(m) {
    const id = m && (m.clipId !== undefined && m.clipId !== null ? m.clipId : m.key);
    if (id !== undefined && id !== null) return isId(id) ? clipOf(id) : null;
    return ordered()[0] || null;
  }

  /**
   * Removes one clip from a multi-video session (e.g. clicking an already-compared video in the folder rail).
   * Never removes the last remaining clip.
   * @param {string} id
   * @returns {boolean} removed
   */
  function removeClip(id) {
    if (disposed || clips.length < 2 || !clipOf(id)) return false;
    clips = clips.filter((c) => c.id !== id);
    order = order.filter((x) => x !== id);
    pendingAdds.delete(id);
    tileSizes.delete(id);
    positions.delete(id);
    if (clips.length < 2) setCapture(false);
    changed();
    post(/** @type {any} */ ({ type: 'removeVideo', clipId: id }));
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
    pendingAdds.clear();
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
      for (const id of known) pendingAdds.delete(id);
      // Preserve newly added clips the page hasn't acknowledged yet so an older tiles report cannot drop them.
      const keep = [...known, ...order.filter((id) => pendingAdds.has(id) && !known.includes(id) && clipOf(id))];
      // The page never shows no video: an empty or foreign list is not one of ours.
      if (keep.length) {
        clips = clips.filter((c) => keep.includes(c.id));
        order = keep;
        for (const id of [...tileSizes.keys()]) if (!keep.includes(id)) tileSizes.delete(id);
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
        const first = ordered()[0];
        /** @type {Record<string, any>} */
        const state = {
          type: 'sessionState', clips: ordered().map(clipDescriptor),
          order: [...order], capture, maxVideos, sourceKind: first ? sourceKindOf(first) : 'file',
        };
        // A frame link, the saved position and the rail carried over a reload: for the first page only.
        if (openTarget) {
          if (openTarget.goto) state.goto = openTarget.goto;
          if (openTarget.savedPos) state.savedPos = openTarget.savedPos;
          if (openTarget.railCarry) state.railCarry = openTarget.railCarry;
          if (openTarget.fromAutoNext) state.fromAutoNext = true;
          openTarget = null;
        }
        send(/** @type {any} */ (state));
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
        for (const id of o) pendingAdds.delete(id);
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
        // Compare: each tile's own cell (a Spotlight's hero and its strip differ), for the clips this session shows.
        for (const t of perTileSizes(m)) if (clipOf(t.clipId)) tileSizes.set(t.clipId, { ...size, w: t.w, h: t.h });
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
      case 'loadSubs': return deps.onLoadSubs ? deps.onLoadSubs(clipFor(m), m, session) : undefined;
      case 'copyLink': {
        const c = clipFor(m);
        return c && deps.onCopyLink ? deps.onCopyLink(c, m, session) : undefined;
      }
      case 'exportRange':
      case 'clipRange':
      case 'ffmpegRange':
      case 'exportFrame':
        return deps.onExportAb && AB_KINDS.has(m.type) ? deps.onExportAb(/** @type {AbKind} */ (m.type), clipFor(m), m, session) : undefined;
      case 'grabExactFrame': {
        const c = clipFor(m);
        return c && deps.onExactFrame ? deps.onExactFrame(c, m, session) : undefined;
      }
      case 'pos': {
        const c = clipFor(m);
        const p = cleanPos(m);
        if (!c || !p) return undefined;
        positions.set(c.id, p);
        return deps.onPos ? deps.onPos(c, p, session) : undefined;
      }
      case 'action': return typeof m.id === 'string' && deps.onAction ? deps.onAction(m.id, m, session) : undefined;
      case 'whenSlow': return deps.onAction ? deps.onAction('whenSlow', m, session) : undefined;
      case 'transcodePref': return deps.onTranscodePref ? deps.onTranscodePref(m, session) : undefined;
      case 'transcodeResolution': return deps.onTranscodeResolution ? deps.onTranscodeResolution(clipFor(m), m, session) : undefined;
      case 'originalTile': {
        const c = clipFor(m);
        return c && deps.onOriginalTile ? deps.onOriginalTile(c, m, session) : undefined;
      }
      case 'quality': {
        const c = clipFor(m);
        return c && deps.onQuality ? deps.onQuality(c, m, session) : undefined;
      }
      case 'railAdopted': return deps.onRailAdopted ? deps.onRailAdopted(m, session) : undefined;
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
      // An image sequence's frame player asks for pictures (media/frame-player.js): its host decoder answers.
      case 'frames': {
        const c = clipFor(m);
        if (!c || !deps.onNative || !Array.isArray(m.indices)) return undefined;
        return deps.onNative(c, { ...m, m: { type: 'frames', indices: m.indices } });
      }
      default: return deps.onOther ? deps.onOther(m, session) : undefined;
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

  /**
   * A host transaction: the clip changes `fn` makes (addClip, replaceClip, reloadClip, removeClip ...) post nothing
   * one by one; the page is set once at the end (render), and its 'ready' sessionState carries them all. Other posts
   * made meanwhile (toasts) wait for that page. Replies to the old page's requests (REPLY_MESSAGES: blocks, native
   * frames, thumbnails, exact frames) reach it at once, as it lives until the render, and never the new page. `fn`
   * may be async: the batch ends when its promise settles, also on a failure (the changes made until then still show). Nested batches render once, at the outermost end.
   * @template T
   * @param {() => T} fn
   * @returns {T}
   */
  function batch(fn) {
    batchDepth++;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      if (--batchDepth === 0 && !disposed) render();
    };
    let out;
    try { out = fn(); } catch (e) { finish(); throw e; }
    if (out && typeof (/** @type {any} */ (out)).then === 'function') {
      return /** @type {any} */ (Promise.resolve(out).finally(finish));
    }
    finish();
    return out;
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
    addClip, removeClip, replaceClip, reloadClip, leaveCompare, shouldCapture, onMessage, render, batch, dispose, post,
    postNativeReply, clipFor, setOpenTarget,
    /** A session.batch is open (its tile changes wait for one render). */
    get batching() { return batchDepth > 0; },
    /** What the next page shows first (null: nothing), until its 'ready' spends it. */
    get openTarget() { return openTarget; },
    /** A clip's last reported position, or null. @param {string} id */
    positionOf: (id) => positions.get(id) || null,
    /**
     * A frame link opened on this panel while it is open: the page seeks there, paused.
     * @param {any} target { frame?, t?, mode? } @param {string} [clipId] the tile it names (default: the page's)
     * @returns {boolean} posted (false: not a target)
     */
    goto(target, clipId) {
      const g = cleanGoto(target);
      if (disposed || !g) return false;
      post(/** @type {any} */ (clipId && isId(clipId) && clipOf(clipId) ? { type: 'goto', ...g, clipId } : { type: 'goto', ...g }));
      return true;
    },
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

module.exports = {
  createUnifiedSession, createUnifiedRegistry, titleOf, clipDescriptor, cleanGoto, cleanPos, sourceKindOf, DEFAULT_MAX,
};
