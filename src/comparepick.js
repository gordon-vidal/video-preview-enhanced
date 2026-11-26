'use strict';
// "Compare with…" quick pick (key D in the player, docs/notes/compare-ui.md "Starting a compare"): the other
// videos of this video's folder first, then the rest of the workspace, then "Browse…". Within each part the
// videos compared or opened from compare most recently come first, then natural name order. Pure, so a Node
// test can check the order without VS Code.

const VIDEO_EXT = /\.(avi|mkv|mov|wmv|flv|mpe?g|m2ts|mts|3gp|ogv|m4v|vob|divx|asf|mxf|y4m|mp4|webm)$/i;
const RECENT_MAX = 20;
const FOLDER_MAX_DEPTH = 16;
const FOLDER_MAX_DIRS = 1000;
const coll = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/**
 * The tile letters, 'A'-'P', in order: media/compare-grid.js TILE_KEYS, repeated because this module imports
 * nothing (.dependency-cruiser.cjs pure-logic-dependencies); test/host/unified_viewer_test.js holds them equal.
 */
const TILE_KEYS = 'ABCDEFGHIJKLMNOP';
/** Videos in one panel at most (the setting compare.maxVideos picks 2-16; 8 by default). */
const MAX_TILES = TILE_KEYS.length;
/** Engine keys: 'A'-'P' for the tiles, 'sA' and 'sB' for the scan (of the first two). */
const SCAN_KEY = /^s[AB]$/;
/**
 * The file index of an engine key, or -1 for anything else (a malformed key never means file A).
 * @param {unknown} key
 * @returns {number}
 */
function fileOfKey(key) {
  if (typeof key !== 'string' || !(key.length === 1 || SCAN_KEY.test(key))) return -1;
  return TILE_KEYS.indexOf(key.slice(-1));
}

/**
 * Tests: answers the next "Compare with…" quick pick (its items) without showing it. Kept here, with no vscode
 * dependency, so the quick pick's owner reads it through getPickHook and src/debug-cmd.js sets it.
 * @type {((items: any[]) => Promise<any>) | null}
 */
let pickHook = null;
/** @param {((items: any[]) => Promise<any>) | null} fn */
function setPickHook(fn) { pickHook = typeof fn === 'function' ? fn : null; }
function getPickHook() { return pickHook; }

/** `recent` with `uri` moved to the front (strings, newest first, at most RECENT_MAX). */
function pushRecent(recent, uri) {
  return [uri, ...(recent || []).filter((u) => u !== uri)].slice(0, RECENT_MAX);
}

/**
 * @param {{ current: string, folder: string[], workspace: string[], recent?: string[] }} o
 *   uri strings: the current video, the video files next to it, the workspace's video files, the recent list
 * @returns {{ kind: 'sep'|'file'|'explorer'|'browse', label: string, uri?: string }[]} quick pick rows, in order
 */
function pickRows({ current, folder, workspace, recent = [] }) {
  const rank = (u) => { const i = recent.indexOf(u); return i < 0 ? Infinity : i; };
  const nameOf = (u) => decodeURIComponent(u.slice(u.lastIndexOf('/') + 1));
  const order = (list) => [...new Set(list)].filter((u) => u !== current && VIDEO_EXT.test(nameOf(u)))
    .sort((a, b) => rank(a) - rank(b) || coll.compare(nameOf(a), nameOf(b)) || (a < b ? -1 : a > b ? 1 : 0));
  const inFolder = order(folder);
  const taken = new Set(inFolder);
  const rest = order(workspace).filter((u) => !taken.has(u));
  const rows = [];
  if (inFolder.length) rows.push({ kind: 'sep', label: 'Same folder' }, ...inFolder.map((uri) => ({ kind: 'file', label: nameOf(uri), uri })));
  if (rest.length) rows.push({ kind: 'sep', label: 'Workspace' }, ...rest.map((uri) => ({ kind: 'file', label: nameOf(uri), uri })));
  // "Click videos in the Explorer…" turns on add mode; Browse… opens the file dialog.
  rows.push({ kind: 'sep', label: '' }, { kind: 'explorer', label: 'Click videos in the Explorer…' }, { kind: 'browse', label: 'Browse…' });
  return rows;
}

/** Video file URIs (strings) in a drop's data: text/uri-list, application/vnd.code.uri-list, resourceurls (JSON). */
function droppedVideos(values) {
  const out = [];
  for (const v of values || []) {
    let parts = [];
    if (typeof v !== 'string') continue;
    if (v.trim().startsWith('[')) { try { parts = JSON.parse(v); } catch { parts = []; } } else parts = v.split(/\r?\n/);
    for (const p of parts) if (typeof p === 'string' && p.trim() && !p.startsWith('#') && VIDEO_EXT.test(p.split(/[?#]/)[0])) out.push(p.trim());
  }
  return [...new Set(out)];
}

/**
 * The video files among a folder's entry names, in natural name order (Explorer "Add to Compare").
 */
function folderVideos(names) {
  return [...new Set(names.filter((n) => VIDEO_EXT.test(n)))]
    .sort((a, b) => coll.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Recursively collect video URIs under `rootUri`, level by level (breadth first; natural name order within a
 * folder: its videos first, then its subfolders queued in natural order), so one huge empty subtree cannot use
 * up the directory budget before sibling folders are looked at. Symlinked directories are followed; each
 * canonical directory (`realPath`, else the uri's own key) is walked once, so loops like `a -> root` end and
 * no video is listed twice. Entries a remote / FUSE / Docker mount reports as a bare symlink or unknown
 * (type 0) are resolved with `stat` when given. Depth and directory count are bounded.
 * @template T
 * @param {T} rootUri
 * @param {(dir: T) => Promise<[string, number][]>} readDirectory
 * @param {(dir: T, name: string) => T} joinPath
 * @param {{ dir?: number, symlink?: number, maxDepth?: number, maxDirs?: number,
 *   stat?: (uri: T) => Promise<{ type: number }>, realPath?: (uri: T) => Promise<string>,
 *   key?: (uri: T) => string, log?: (msg: string) => void }} [opts]
 * @returns {Promise<T[]>}
 */
async function collectFolderVideos(rootUri, readDirectory, joinPath, opts = {}) {
  const dir = opts.dir ?? 2;
  const symlink = opts.symlink ?? 64;
  const maxDepth = opts.maxDepth ?? FOLDER_MAX_DEPTH;
  const maxDirs = opts.maxDirs ?? FOLDER_MAX_DIRS;
  const { stat, realPath, log } = opts;
  const keyOf = opts.key || String;
  const out = [];
  const seenDirs = new Set();
  const seenFiles = new Set();
  const canonical = async (uri) => {
    if (realPath) {
      try { return 'real:' + await realPath(uri); } catch (e) { if (log) log(`realpath ${keyOf(uri)}: ${e && e.message || e}`); }
    }
    return 'uri:' + keyOf(uri);
  };
  let visited = 0;
  let level = [rootUri];
  for (let depth = 0; level.length && visited < maxDirs; depth++) {
    const next = [];
    for (const folder of level) {
      if (visited >= maxDirs) break;
      const id = await canonical(folder);
      if (seenDirs.has(id)) continue;
      seenDirs.add(id);
      visited++;
      let entries;
      try { entries = await readDirectory(folder); } catch (e) {
        if (log) log(`readDirectory ${keyOf(folder)}: ${e && e.message || e}`);
        continue;
      }
      const fileNames = [];
      const subDirs = [];
      for (const [name, type] of entries || []) {
        if (type & dir) { subDirs.push(name); continue; }
        if (!(type === 0 || (type & symlink))) { fileNames.push(name); continue; }
        if (VIDEO_EXT.test(name)) { fileNames.push(name); continue; }
        if (!stat) continue;
        try {
          const st = await stat(joinPath(folder, name));
          if (st && (st.type & dir)) subDirs.push(name);
        } catch (e) {
          if (log) log(`stat ${keyOf(joinPath(folder, name))}: ${e && e.message || e}`);
        }
      }
      for (const name of folderVideos(fileNames)) {
        const uri = joinPath(folder, name);
        const k = keyOf(uri);
        if (seenFiles.has(k)) continue;
        seenFiles.add(k);
        out.push(uri);
      }
      if (depth >= maxDepth) continue;
      subDirs.sort((x, y) => coll.compare(x, y) || (x < y ? -1 : x > y ? 1 : 0));
      for (const name of new Set(subDirs)) next.push(joinPath(folder, name));
    }
    level = next;
  }
  return out;
}

/**
 * What a Start / Add to Compare command acts on. Explorer passes (clicked, selectedArray); the editor tab menu passes
 * (clicked, { groupId, editorIndex }), so the selection comes from the tab strip: when the clicked tab is one of
 * several selected tabs of its group, all selected video tabs in tab order, otherwise just the clicked one.
 * @param {*} uri clicked resource
 * @param {*} second Explorer selection (array) or the tab menu's group info
 * @param {{ tabs: { isSelected?: boolean, input?: { uri?: * } }[] }[]} groups vscode.window.tabGroups.all
 * @param {(uri: *) => boolean} isVideo
 * @param {(uri: *) => string} key identity of a resource
 */
function compareTargets(uri, second, groups, isVideo, key = String) {
  if (Array.isArray(second) && second.length) return second;
  const clicked = uri ? key(uri) : '';
  for (const group of groups || []) {
    const tabs = group.tabs || [];
    const selected = tabs.filter((t) => t.isSelected && t.input && t.input.uri && isVideo(t.input.uri));
    if (selected.length > 1 && selected.some((t) => key(t.input.uri) === clicked)) {
      return selected.map((t) => t.input.uri);
    }
  }
  return [uri];
}

/** Candidates go after the existing tiles, in selection order. Count overflow after removing duplicates. */
function planAddToCompare({ videos, compare, player, max, key }) {
  const target = compare || player;
  const existing = compare ? compare.uris : player ? [player.uri] : [];
  const seen = new Set(existing.map(key));
  const unique = videos.filter((uri) => {
    const id = key(uri);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  const room = Math.max(0, max - existing.length);
  return {
    target,
    append: !!compare,
    files: unique.slice(0, room),
    skipped: Math.max(0, unique.length - room),
  };
}

module.exports = {
  pickRows, pushRecent, droppedVideos, folderVideos, collectFolderVideos,
  planAddToCompare, compareTargets, VIDEO_EXT, RECENT_MAX,
  fileOfKey, MAX_TILES, TILE_KEYS, setPickHook, getPickHook,
};
