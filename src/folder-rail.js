'use strict';
// The folder rail's host side (docs/notes/folder-rail.md): directory snapshots for the page's rail, the playback
// folder's neighbours (Shift+N / Shift+P, the bar's ‹ 2/5 › capsule, Autoplay "Play next in folder"), lazy
// size / date / ffprobe metadata, the tab-swap handoff and the 1-click Compare preflight. Pure: every I/O call
// is injected, so a Node test drives it (test/host/folder_rail_test.js); src/extension.js wires the real ones.
//
// Two folders are kept apart: the *browse* folder is what the rail lists (the user can walk into subfolders and
// up), the *playback* folder is the playing file's own folder. Next / previous, the 2/5 counter and Autoplay
// always use the playback folder; browsing never changes them until a video is opened from the rail.
//
// The page never sends a path: each listed entry has an opaque id that is only valid for the snapshot (its
// generation) it came with. A stale generation or an unknown id is ignored.
const nodePath = require('path');
const { VIDEO_EXT } = require('./open-video');

// checkJs: start
/**
 * @typedef {'up'|'dir'|'video'|'file'} EntryKind
 * @typedef {{ id: string, name: string, kind: EntryKind, path: string }} Entry
 * @typedef {{ size?: number, mtime?: number, duration?: number, width?: number, height?: number, codec?: string, items?: number }} Meta
 * @typedef {{ name: string, isDirectory(): boolean, isFile(): boolean, isSymbolicLink(): boolean }} Dirent
 * @typedef {{ size: number, mtimeMs: number, isDirectory(): boolean, isFile(): boolean }} Stat
 * @typedef {{ readdir(dir: string, o: { withFileTypes: true }): Promise<Dirent[]>, stat(p: string): Promise<Stat> }} FsLike
 * @typedef {{ open: boolean, width?: number, filter: string, onEnd?: 'off'|'next'|'loop' }} RailCarry
 *   the rail state a folder navigation carries to the next tab (sanitizeRailCarry)
 * @typedef {{ rail: RailCarry, fromAutoNext: boolean, browse: string | null }} HandoffIntent
 *   what the next tab of a folder navigation takes over; browse: the folder the rail showed (null: the playback folder)
 * @typedef {{ key: string, id: number }} HandoffToken  one registration of createHandoffs
 * @typedef {{ type: 'railHandoff', id: number, rail: RailCarry, onEnd?: string, fromAutoNext: boolean }} RailHandoffMessage
 *   host -> page: a navigation landed on this open tab
 * @typedef {{ type: 'railAdopted', id: number, ok: boolean }} RailAdoptedMessage
 *   page -> host: the handoff `id` is applied (ok: with its player ready, Autoplay's play started when asked)
 */

/** Autoplay (setting videoPreviewEnhanced.onEnd): what happens when a video plays to its end. */
const ON_END = ['off', 'next', 'loop'];
/** The rail's right-hand column. */
const COLUMNS = ['duration', 'size', 'modified', 'none'];
/** videoPreviewEnhanced.folderRail.layout: beside the picture (dock) or floating over it (overlay). */
const LAYOUTS = ['dock', 'overlay'];
const WIDTH = { min: 176, max: 360, dflt: 218 };
const RAIL_PREFS_KEY = 'videoPreviewEnhanced.folderRail';

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
/**
 * Natural, case-insensitive name order ("clip 2" before "clip 10"); names the collator calls equal ("A.mp4" and
 * "a.mp4" on a case-sensitive file system) fall back to code-unit order, so the order never depends on readdir's.
 * @param {string} a @param {string} b
 */
function naturalCompare(a, b) {
  return collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);
}

/** @param {string} name */
const isPlayable = (name) => VIDEO_EXT.test(name);

/**
 * Autoplay's effective value. `onEnd` wins wherever the user set it; else an explicitly set (deprecated) `loop`
 * keeps its meaning (true: Loop, false: Off); else Off.
 * @param {any} onEnd   workspace.getConfiguration(...).inspect('onEnd')
 * @param {any} loop    ... .inspect('loop')
 * @returns {'off'|'next'|'loop'}
 */
function resolveOnEnd(onEnd, loop) {
  const explicit = (/** @type {any} */ i) => {
    if (!i) return undefined;
    for (const k of ['workspaceFolderValue', 'workspaceValue', 'globalValue']) if (i[k] !== undefined) return i[k];
    return undefined;
  };
  const o = explicit(onEnd);
  if (ON_END.includes(o)) return o;
  const l = explicit(loop);
  if (typeof l === 'boolean') return l ? 'loop' : 'off';
  return 'off';
}

/**
 * The rail's remembered look (globalState), cleaned.
 * @param {any} raw
 * @returns {{ width: number, column: string, playable: boolean }}
 */
function sanitizeRailPrefs(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const w = Math.round(Number(r.width));
  return {
    width: Number.isFinite(w) && w > 0 ? Math.max(WIDTH.min, Math.min(WIDTH.max, w)) : WIDTH.dflt,
    column: COLUMNS.includes(r.column) ? r.column : 'duration',
    playable: r.playable !== false,
  };
}

/**
 * The rail's state carried to the next tab of a folder navigation (tab swap), cleaned: what the page sent.
 * @param {any} raw
 */
function sanitizeRailCarry(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const w = Math.round(Number(r.width));
  return {
    open: r.open === true,
    width: Number.isFinite(w) && w > 0 ? Math.max(WIDTH.min, Math.min(WIDTH.max, w)) : undefined,
    filter: typeof r.filter === 'string' ? r.filter.slice(0, 200) : '',
    onEnd: ON_END.includes(r.onEnd) ? r.onEnd : undefined,
  };
}

/**
 * 1-click Compare from a rail row: what to do, from the keys (fileKey) of the playing video, the row's video and,
 * when a Compare is open, its members. Capacity is `max` videos (setting compare.maxVideos).
 * @param {{ compareKeys: string[] | null, playerKey: string, targetKey: string, max: number }} o
 * @returns {{ action: 'open', keys: string[] } | { action: 'add', keys: string[], skipped: number } | { action: 'none' | 'full', keys: string[], skipped: number }}
 */
function planCompareRow({ compareKeys, playerKey, targetKey, max }) {
  if (!compareKeys) {
    if (playerKey === targetKey) return { action: 'none', keys: [], skipped: 0 };
    return { action: 'open', keys: [playerKey, targetKey] };
  }
  const have = new Set(compareKeys);
  const missing = [...new Set([playerKey, targetKey])].filter((k) => !have.has(k));
  const room = Math.max(0, max - compareKeys.length);
  const keys = missing.slice(0, room);
  const skipped = missing.length - keys.length;
  if (keys.length) return { action: 'add', keys, skipped };
  return { action: skipped ? 'full' : 'none', keys: [], skipped };
}

/**
 * Short-lived intents for a folder navigation: registered before vscode.openWith, taken by the new tab's
 * resolveCustomEditor (ahead of Compare's Add Mode and Open Together), so that tab knows it continues this one
 * (rail state, Autoplay hand-over). One per target uri *and* editor group (two groups navigating to the same file
 * keep their own); each registration has a token, and only that registration is dropped with it. They expire after
 * `ttlMs`.
 * @param {{ now?: () => number, ttlMs?: number }} [o]
 */
function createHandoffs({ now = Date.now, ttlMs = 15000 } = {}) {
  /** @type {Map<string, { token: number, intent: HandoffIntent, until: number }>} */
  const map = new Map();
  let seq = 0;
  const slot = (/** @type {string} */ key, /** @type {number|undefined} */ column) => `${typeof column === 'number' ? column : '*'}|${key}`;
  const sweep = () => { const t = now(); for (const [k, v] of map) if (v.until < t) map.delete(k); };
  return {
    /**
     * @param {string} key target uri (no fragment) @param {number|undefined} column @param {HandoffIntent} intent
     * @returns {HandoffToken}
     */
    register(key, column, intent) {
      sweep();
      const token = { key: slot(key, column), id: ++seq };
      map.set(token.key, { token: token.id, intent, until: now() + ttlMs });
      return token;
    },
    /**
     * The intent for a tab opening `key` in `column`, consumed; null when none (or only for another editor group).
     * @param {string} key @param {number|undefined} column
     * @returns {HandoffIntent | null}
     */
    take(key, column) {
      sweep();
      const at = map.has(slot(key, column)) ? slot(key, column) : map.has(slot(key, undefined)) ? slot(key, undefined) : null;
      if (!at) return null;
      const v = /** @type {{ intent: HandoffIntent }} */ (map.get(at));
      map.delete(at);
      return v.intent;
    },
    /** Drops this registration if it was not taken (the open failed); a newer one for the same slot stays. */
    drop(/** @type {HandoffToken} */ token) {
      const v = map.get(token.key);
      if (v && v.token === token.id) map.delete(token.key);
    },
    size() { sweep(); return map.size; },
  };
}

/**
 * "Compare all videos in folder" from a rail folder row: what to do with the folder's videos (keys, in order).
 * No Compare open: a new Compare needs at least two; a Compare open: the ones it lacks, up to `max` in all.
 * @param {{ videoKeys: string[], compareKeys: string[] | null, max: number }} o
 * @returns {{ action: 'open' | 'add' | 'few' | 'full' | 'none', keys: string[], skipped: number }}
 */
function planFolderCompare({ videoKeys, compareKeys, max }) {
  const unique = [...new Set(videoKeys)];
  if (!compareKeys) {
    if (unique.length < 2) return { action: 'few', keys: [], skipped: 0 };
    return { action: 'open', keys: unique.slice(0, max), skipped: Math.max(0, unique.length - max) };
  }
  if (!unique.length) return { action: 'few', keys: [], skipped: 0 };
  const have = new Set(compareKeys);
  const missing = unique.filter((k) => !have.has(k));
  const room = Math.max(0, max - compareKeys.length);
  const keys = missing.slice(0, room);
  const skipped = missing.length - keys.length;
  if (keys.length) return { action: 'add', keys, skipped };
  return { action: skipped ? 'full' : 'none', keys: [], skipped };
}

/**
 * A small LRU of file metadata (ffprobe results) keyed by authority, path, size and modification time:
 * a changed file is probed again.
 * @param {number} [max]
 */
function createMetaCache(max = 500) {
  /** @type {Map<string, Meta>} */
  const m = new Map();
  return {
    key: (/** @type {string} */ authority, /** @type {string} */ file, /** @type {number} */ size, /** @type {number} */ mtime) => `${authority}|${file}|${size}|${Math.round(mtime)}`,
    get(/** @type {string} */ k) {
      const v = m.get(k);
      if (v === undefined) return undefined;
      m.delete(k); m.set(k, v);
      return v;
    },
    set(/** @type {string} */ k, /** @type {Meta} */ v) {
      m.delete(k); m.set(k, v);
      while (m.size > max) m.delete(/** @type {string} */ (m.keys().next().value));
    },
    get size() { return m.size; },
  };
}

/**
 * What a directory entry is for the rail: 'dir', 'file' (a regular file) or null (leave it out). A symbolic link
 * is what it points to (stat follows it); a link to something else, or a broken one, is left out.
 * @param {FsLike} fs @param {Dirent} e @param {string} full
 * @returns {Promise<'dir'|'file'|null>}
 */
async function entryType(fs, e, full) {
  if (e.isDirectory()) return 'dir';
  if (e.isFile()) return 'file';
  if (!e.isSymbolicLink()) return null;
  try {
    const st = await fs.stat(full);
    if (st.isDirectory()) return 'dir';
    return st.isFile() ? 'file' : null;
  } catch { return null; }
}

/**
 * The playable videos of `dir` in natural order: regular files (or links to one) with a video extension.
 * Only links cost a stat; plain entries are judged by readdir's types.
 * @param {FsLike} fs @param {string} dir @param {any} [pathMod]
 */
async function playableIn(fs, dir, pathMod = nodePath) {
  const ents = await fs.readdir(dir, { withFileTypes: true });
  const cands = ents.filter((e) => isPlayable(e.name) && !e.name.startsWith('.'));
  const types = await Promise.all(cands.map((e) => entryType(fs, e, pathMod.join(dir, e.name))));
  return cands.filter((_, i) => types[i] === 'file').map((e) => e.name).sort(naturalCompare);
}

/**
 * Where `file` is among the playable videos of its folder, and its neighbour `d` (1 next, -1 previous).
 * @param {FsLike} fs
 * @param {string} file @param {number} d @param {any} [pathMod]
 * @returns {Promise<{ index: number, count: number, target: string | null }>}  index is 0-based (-1: not listed)
 */
async function neighbourOf(fs, file, d, pathMod = nodePath) {
  const dir = pathMod.dirname(file);
  const base = pathMod.basename(file);
  const vids = await playableIn(fs, dir, pathMod);
  let index = vids.indexOf(base);
  // A case-insensitive file system can report another case than the opened uri.
  if (index < 0) index = vids.findIndex((n) => n.toLowerCase() === base.toLowerCase());
  const t = index >= 0 && d ? vids[index + d] : undefined;
  return { index, count: vids.length, target: t ? pathMod.join(dir, t) : null };
}

/**
 * The rail controller of one player tab.
 * @param {object} deps
 * @param {{ readdir(dir: string, o: { withFileTypes: true }): Promise<Dirent[]>, stat(p: string): Promise<Stat> }} deps.fs
 * @param {(file: string, signal: AbortSignal) => Promise<Meta | null>} [deps.probe]  duration, size of the picture, codec
 * @param {(msg: any) => void} deps.post   to the page
 * @param {any} [deps.path]                 node's path (tests: path.posix)
 * @param {ReturnType<typeof createMetaCache>} [deps.cache]   shared by every tab
 * @param {string} [deps.authority]         the remote authority ('' locally), part of the cache key
 * @param {number} [deps.statPool]          stat calls at once
 * @param {number} [deps.probePool]         ffprobe runs at once
 * @param {number} [deps.flushMs]           metadata patches are batched this long
 * @param {(fn: () => void, ms: number) => any} [deps.setTimer]
 * @param {(h: any) => void} [deps.clearTimer]
 * @param {(msg: string) => void} [deps.log]
 * @param {() => string | null} [deps.current]  the playing file (its row is marked)
 * @param {() => string[]} [deps.members]    Compare: the files it shows (their rows are marked "in Compare")
 * @param {boolean} [deps.caseless]          paths compare case-insensitively (Windows)
 */
function createFolderRail(deps) {
  const fs = deps.fs;
  const P = deps.path || nodePath;
  const post = deps.post;
  const cache = deps.cache || createMetaCache();
  const authority = deps.authority || '';
  const STAT_POOL = deps.statPool || 4;
  const PROBE_POOL = deps.probePool || 1;
  const FLUSH_MS = deps.flushMs === undefined ? 40 : deps.flushMs;
  const setTimer = deps.setTimer || ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer || ((h) => clearTimeout(h));
  const log = deps.log || (() => {});
  const caseless = !!deps.caseless;

  let gen = 0;
  let disposed = false;
  /** @type {string|null} */ let dir = null;
  /** @type {Map<string, Entry>} */ let entries = new Map();
  /** @type {Map<string, Meta>} */ let metas = new Map();
  /** Files whose size and date are not known yet, in list order; ffprobe waits for them. */
  /** @type {Set<string>} */ let statWant = new Set();
  /** @type {Set<string>} */ let probeWant = new Set();
  /** @type {string[]} */ let visible = [];
  /** @type {string|null} */ let hovered = null;
  let statBusy = 0;
  let probeBusy = 0;
  let abort = new AbortController();
  /** @type {Map<string, Meta>} */ let patches = new Map();
  let flushTimer = null;
  // Work token: bumped by every stop (folder change, close, hide), so an answer that arrives after it is dropped.
  let work = 0;
  // Closed or hidden: nothing is queued or posted until resume(). relist: a listing was still being read then.
  let suspended = false;
  let relist = false;
  let listing = false;
  /** Metadata of files the session already knows (the playing file): never probed. path -> meta */
  /** @type {Map<string, Meta>} */ const seeded = new Map();
  const stats = { stat: 0, probe: 0, flushes: 0 };

  function stopWork() {
    work++;
    abort.abort();
    abort = new AbortController();
    statWant = new Set();
    probeWant = new Set();
    if (flushTimer !== null) { clearTimer(flushTimer); flushTimer = null; }
    patches = new Map();
  }

  /** Lists `d` (the rail's folder). Names and kinds come at once; sizes, dates and durations follow (meta). */
  async function browse(/** @type {string} */ d) {
    if (disposed) return null;
    stopWork();
    suspended = false;
    relist = false;
    listing = true;
    const w = work;
    const g = ++gen;
    const prev = dir;
    dir = d;
    entries = new Map();
    metas = new Map();
    visible = [];
    hovered = null;
    /** @type {Dirent[]} */
    let ents;
    try {
      ents = await fs.readdir(d, { withFileTypes: true });
    } catch (e) {
      if (stale(w)) return null;
      listing = false;
      log(`folder rail: cannot read ${d}: ${e && /** @type {any} */ (e).code || e}`);
      const msg = { type: 'rail', op: 'list', gen: g, crumb: crumbOf(d), entries: [], error: 'This folder cannot be read' };
      post(msg);
      return msg;
    }
    if (stale(w)) return null;
    const dirs = [];
    const files = [];
    // Hidden files and folders (.git, .DS_Store) are left out; a link is what it points to (a regular file or a
    // folder), anything else (a broken link, a device) is left out too.
    const shown = ents.filter((e) => !e.name.startsWith('.'));
    const types = await Promise.all(shown.map((e) => entryType(fs, e, P.join(d, e.name))));
    if (stale(w)) return null;
    listing = false;
    shown.forEach((e, k) => { if (types[k] === 'dir') dirs.push(e.name); else if (types[k] === 'file') files.push(e.name); });
    dirs.sort(naturalCompare);
    files.sort(naturalCompare);
    /** @type {Entry[]} */
    const list = [];
    let i = 0;
    const id = () => `${g}.${i++}`;
    const parent = P.dirname(d);
    if (parent && parent !== d) list.push({ id: id(), name: '..', kind: 'up', path: parent });
    for (const n of dirs) list.push({ id: id(), name: n, kind: 'dir', path: P.join(d, n) });
    for (const n of files) list.push({ id: id(), name: n, kind: isPlayable(n) ? 'video' : 'file', path: P.join(d, n) });
    for (const e of list) entries.set(e.id, e);
    for (const e of list) if (e.kind === 'video' || e.kind === 'file' || e.kind === 'dir') statWant.add(e.id);
    const playing = deps.current ? deps.current() : null;
    const same = (/** @type {string} */ a, /** @type {string|null|undefined} */ b) => !!b && (a === b || (caseless && a.toLowerCase() === b.toLowerCase()));
    const current = list.find((e) => e.kind === 'video' && same(e.path, playing));
    const members = memberIds(list, same);
    // Walked up out of a folder: the page puts its cursor on that folder's row.
    const from = prev ? list.find((e) => e.kind === 'dir' && same(e.path, prev)) : undefined;
    const msg = {
      type: 'rail', op: 'list', gen: g, crumb: crumbOf(d), root: !(parent && parent !== d),
      entries: list.map((e) => ({ id: e.id, name: e.name, kind: e.kind })),
      ...(current ? { current: current.id } : {}), ...(from ? { from: from.id } : {}),
      ...(deps.members ? { members, count: deps.members().length } : {}),
    };
    post(msg);
    pump();
    return msg;
  }

  /**
   * True when the work started under token w was stopped meanwhile. Stopped by a close or a hide (not by a newer
   * listing): the listing is read again on resume.
   */
  function stale(/** @type {number} */ w) {
    if (w === work && !disposed) return false;
    if (suspended) relist = true;
    return true;
  }

  /** Compare: the ids of the listed videos it shows. */
  function memberIds(/** @type {Entry[]} */ list, /** @type {(a: string, b: string) => boolean} */ same) {
    if (!deps.members) return [];
    const files = deps.members();
    return list.filter((e) => e.kind === 'video' && files.some((f) => same(e.path, f))).map((e) => e.id);
  }

  /** The folder's name and its parent's, for the header ("videos / codecs"). */
  function crumbOf(/** @type {string} */ d) {
    const base = P.basename(d) || d;
    const up = P.dirname(d);
    const upName = up && up !== d ? P.basename(up) : '';
    return upName ? `${upName} / ${base}` : base;
  }

  /** The next id to stat or probe: hovered first, then the visible rows, then (stat only) the rest in list order. */
  function next(/** @type {Set<string>} */ want, rest = true) {
    if (hovered && want.has(hovered)) return hovered;
    for (const v of visible) if (want.has(v)) return v;
    if (!rest) return null;
    const it = want.values().next();
    return it.done ? null : it.value;
  }

  function pump() {
    if (disposed || suspended) return;
    while (statBusy < STAT_POOL) {
      const id = next(statWant);
      if (!id) break;
      statWant.delete(id);
      statBusy++;
      runStat(id, work, abort.signal).finally(() => { statBusy--; pump(); });
    }
    if (!deps.probe) return;
    while (probeBusy < PROBE_POOL) {
      // Only hovered and visible videos whose size and date are known (the cache key needs them).
      let id = null;
      for (const c of [hovered, ...visible]) if (c && probeWant.has(c) && metas.get(c)?.size !== undefined) { id = c; break; }
      if (!id) break;
      probeWant.delete(id);
      probeBusy++;
      runProbe(id, work, abort.signal).finally(() => { probeBusy--; pump(); });
    }
  }

  async function runStat(/** @type {string} */ id, /** @type {number} */ w, /** @type {AbortSignal} */ signal) {
    const e = entries.get(id);
    if (!e) return;
    let st;
    try { stats.stat++; st = await fs.stat(e.path); } catch { return; }
    if (w !== work || signal.aborted || disposed) return;
    /** @type {Meta} */
    const m = { ...(metas.get(id) || {}), mtime: Math.round(st.mtimeMs) };
    if (e.kind !== 'dir') m.size = st.size;
    metas.set(id, m);
    patch(id, e.kind === 'dir' ? { mtime: m.mtime } : { size: m.size, mtime: m.mtime });
    if (e.kind !== 'video') return;
    const known = seeded.get(e.path);
    const hit = known || cache.get(cache.key(authority, e.path, st.size, st.mtimeMs));
    if (hit) { Object.assign(m, hit); patch(id, hit); return; }
    probeWant.add(id);
  }

  async function runProbe(/** @type {string} */ id, /** @type {number} */ w, /** @type {AbortSignal} */ signal) {
    const e = entries.get(id);
    const m = metas.get(id);
    if (!e || !m || !deps.probe) return;
    /** @type {Meta|null} */
    let r = null;
    try { stats.probe++; r = await deps.probe(e.path, signal); } catch { r = null; }
    if (w !== work || signal.aborted || disposed) return;
    /** @type {Meta} */
    const got = r ? pick(r) : {};
    // A file that cannot be probed is remembered as unknown too, so it is not probed again on every hover.
    cache.set(cache.key(authority, e.path, /** @type {number} */ (m.size), /** @type {number} */ (m.mtime)), got);
    Object.assign(m, got);
    patch(id, got);
  }

  const pick = (/** @type {any} */ r) => {
    /** @type {Meta} */
    const o = {};
    if (Number(r.duration) > 0) o.duration = Number(r.duration);
    if (Number(r.width) > 0 && Number(r.height) > 0) { o.width = Number(r.width); o.height = Number(r.height); }
    if (typeof r.codec === 'string' && r.codec) o.codec = r.codec.slice(0, 40);
    return o;
  };

  function patch(/** @type {string} */ id, /** @type {Meta} */ m) {
    // Suspended: the value is in metas and goes out with resume()'s republish.
    if (!Object.keys(m).length || suspended) return;
    patches.set(id, { ...(patches.get(id) || {}), ...m });
    if (flushTimer !== null) return;
    const g = gen;
    flushTimer = setTimer(() => {
      flushTimer = null;
      if (g !== gen || disposed || !patches.size) return;
      const list = [...patches].map(([pid, pm]) => ({ id: pid, ...pm }));
      patches = new Map();
      stats.flushes++;
      post({ type: 'rail', op: 'meta', gen: g, patches: list });
    }, FLUSH_MS);
  }

  /** The entry `id` of the current snapshot `g`, or null (stale or unknown: the page's view is old). */
  function entry(/** @type {any} */ g, /** @type {any} */ id) {
    if (g !== gen || typeof id !== 'string') return null;
    return entries.get(id) || null;
  }

  return {
    browse,
    /** The current browse folder (null before the first browse). */
    dir: () => dir,
    gen: () => gen,
    entry,
    /** The page shows these rows now (ids of snapshot g): their metadata first. */
    setVisible(/** @type {any} */ g, /** @type {any} */ ids) {
      if (g !== gen || !Array.isArray(ids)) return;
      visible = ids.filter((x) => typeof x === 'string' && entries.has(x)).slice(0, 200);
      pump();
    },
    /** The pointer is on row `id` (null: none): its metadata before anything else. */
    setHover(/** @type {any} */ g, /** @type {any} */ id) {
      if (g !== gen) return;
      hovered = typeof id === 'string' && entries.has(id) ? id : null;
      if (hovered) {
        const e = entries.get(hovered);
        const m = metas.get(hovered);
        // Its size and date are known but it was not probed (it was off screen): ask now.
        if (e && e.kind === 'video' && m && m.size !== undefined && m.duration === undefined && !probeWant.has(hovered)
          && !cache.get(cache.key(authority, e.path, m.size, /** @type {number} */ (m.mtime)))) probeWant.add(hovered);
      }
      pump();
    },
    /** Compare's videos changed (added, removed, reordered): the page marks the rows of the ones it now shows. */
    refreshMembers() {
      if (disposed || !deps.members || !gen || suspended) return;
      const same = (/** @type {string} */ a, /** @type {string} */ b) => a === b || (caseless && a.toLowerCase() === b.toLowerCase());
      post({ type: 'rail', op: 'members', gen, ids: memberIds([...entries.values()], same), count: deps.members().length });
    },
    /** What the session knows of a file already (the playing video's duration and size): not probed again. */
    seed(/** @type {string} */ file, /** @type {any} */ m) {
      const got = pick(m || {});
      if (!Object.keys(got).length) return;
      seeded.set(file, got);
      for (const [id, e] of entries) if (e.path === file) { metas.set(id, { ...(metas.get(id) || {}), ...got }); patch(id, got); }
    },
    /**
     * Rail closed or tab hidden: queued and running work stops and nothing is posted (a listing still being read is
     * dropped); the listing and what is known of it stay.
     */
    cancel() { if (disposed) return; if (listing) { listing = false; relist = true; } suspended = true; stopWork(); },
    /**
     * The rail is shown again: a listing that was dropped while being read is read again; else what is known is
     * posted again (patches dropped by the stop included) and what is still unknown is fetched (visible rows first).
     */
    resume() {
      if (disposed) return null;
      suspended = false;
      if (relist && dir !== null) { relist = false; return browse(dir); }
      if (!gen) return null;
      const known = [...metas].filter(([id]) => entries.has(id)).map(([id, m]) => ({ id, ...m }));
      if (known.length) post({ type: 'rail', op: 'meta', gen, patches: known });
      for (const [id, e] of entries) {
        const m = metas.get(id);
        if (e.kind === 'up') continue;
        if (!m || m.mtime === undefined) statWant.add(id);
        else if (e.kind === 'video' && m.duration === undefined && !cache.get(cache.key(authority, e.path, /** @type {number} */ (m.size), m.mtime))) probeWant.add(id);
      }
      pump();
      return null;
    },
    dispose() { disposed = true; stopWork(); entries = new Map(); },
    /** Test hook: work counters and queue sizes. */
    stats: () => ({ ...stats, statWant: statWant.size, probeWant: probeWant.size, statBusy, probeBusy, suspended, relist }),
  };
}
/**
 * A page's rail message (media/folder-rail.js), for any host: the viewer (src/unified-viewer.js) with one video or
 * several. Listing, metadata and remembered look are the same; what a row does is
 * the host's (play it in this tab, add it to this Compare, ...). Ids are checked against the current listing: the
 * page never sends a path.
 *
 * host: startDir() the folder the rail shows when opened; setBrowse(dir) the folder walked into (kept for the next
 * open, a reload, a handoff); prefs the remembered look (globalState); onVideo a click on a video row;
 * onCompareVideo a video row's Compare button (or D); onCompareFolder a folder row's "Compare all videos in folder"
 * (or D).
 * @param {{
 *   ctl: ReturnType<typeof createFolderRail>,
 *   startDir: () => string,
 *   setOpen: (open: boolean) => void,
 *   setBrowse: (dir: string) => void,
 *   prefs: { get(): any, set(v: any): any },
 *   seed?: (m: any) => void,
 *   onVideo?: (e: Entry, m: any) => any,
 *   onCompareVideo?: (e: Entry, m: any) => any,
 *   onCompareFolder?: (e: Entry, m: any) => any,
 * }} host
 * @param {any} m
 */
async function routeRailMessage(host, m) {
  const { ctl } = host;
  switch (m && m.op) {
    case 'open': host.setOpen(true); return ctl.browse(host.startDir());
    case 'close': host.setOpen(false); ctl.cancel(); return undefined;
    case 'visible': ctl.setVisible(m.gen, m.ids); return undefined;
    case 'hover': ctl.setHover(m.gen, m.id); return undefined;
    case 'self': if (host.seed) host.seed(m); return undefined;
    case 'prefs': {
      const prev = sanitizeRailPrefs(host.prefs.get());
      return host.prefs.set(sanitizeRailPrefs({
        ...prev, ...(m.width !== undefined ? { width: m.width } : {}), ...(m.column !== undefined ? { column: m.column } : {}),
        ...(m.playable !== undefined ? { playable: m.playable } : {}),
      }));
    }
    default: break;
  }
  const e = ctl.entry(m && m.gen, m && m.id);
  if (!e) return undefined; // an old listing (the folder changed meanwhile) or not an id of ours
  if (m.op === 'browse' && (e.kind === 'dir' || e.kind === 'up')) { host.setBrowse(e.path); return ctl.browse(e.path); }
  if (m.op === 'activate' && e.kind === 'video' && host.onVideo) return host.onVideo(e, m);
  if (m.op === 'compare' && e.kind === 'video' && host.onCompareVideo) return host.onCompareVideo(e, m);
  if (m.op === 'compareFolder' && e.kind === 'dir' && host.onCompareFolder) return host.onCompareFolder(e, m);
  return undefined;
}
// checkJs: end

module.exports = {
  ON_END, COLUMNS, LAYOUTS, WIDTH, RAIL_PREFS_KEY,
  naturalCompare, isPlayable, resolveOnEnd, sanitizeRailPrefs, sanitizeRailCarry, planCompareRow, planFolderCompare,
  createHandoffs, createMetaCache, playableIn, neighbourOf, createFolderRail, routeRailMessage,
};
