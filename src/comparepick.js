'use strict';
// "Compare with…" quick pick (key D in the player, docs/notes/compare-ui.md "Starting a compare"): the other
// videos of this video's folder first, then the rest of the workspace, then "Browse…". Within each part the
// videos compared or opened from compare most recently come first, then natural name order. Pure, so a Node
// test can check the order without VS Code.

const VIDEO_EXT = /\.(avi|mkv|mov|wmv|flv|mpe?g|m2ts|mts|3gp|ogv|m4v|vob|divx|asf|mxf|y4m|mp4|webm)$/i;
const RECENT_MAX = 20;
const coll = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** `recent` with `uri` moved to the front (strings, newest first, at most RECENT_MAX). */
function pushRecent(recent, uri) {
  return [uri, ...(recent || []).filter((u) => u !== uri)].slice(0, RECENT_MAX);
}

/**
 * @param {{ current: string, folder: string[], workspace: string[], recent?: string[] }} o
 *   uri strings: the current video, the video files next to it, the workspace's video files, the recent list
 * @returns {{ kind: 'sep'|'file'|'browse', label: string, uri?: string }[]} quick pick rows, in order
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
  rows.push({ kind: 'sep', label: '' }, { kind: 'browse', label: 'Browse…' });
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

module.exports = { pickRows, pushRecent, droppedVideos, VIDEO_EXT, RECENT_MAX };
