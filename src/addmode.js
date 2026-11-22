'use strict';
// "Add from the Explorer" (docs/notes/compare-ui.md "Add mode"): while it is on, the next video VS Code opens
// (an Explorer click, a drop on the editor, Quick Open ...) goes into compare instead of its own tab.
// A player explicitly armed with Shift+D becomes compare on the first open, and the mode carries on until Esc,
// Shift+D, capacity, or switching editor. Whether a new Compare starts in the mode: startsInAddMode. Pure state; src/compare.js handles the editors.

const { VIDEO_EXT } = require('./comparepick');

/**
 * Whether a Compare that has just been created starts in Add Mode (maintainer decision 2026-11-22): only on an
 * explicit "add more" intent. Several files chosen at once are the whole set the user wanted, so those open with the
 * mode off; the Shift+D key, the Add video… control and the Compare panel's switch turn it on later (toggle / start).
 *
 *   on   'toolbar-start'  the toolbar Compare button's "Start comparison" confirm
 *        'armed'          a player armed with Shift+D (or the D quick pick's Explorer row) took its next video
 *        'start-single'   right-click Start / Add to Compare on one video that makes a one-video Compare
 *   off  'burst' (drop, Open With… on a selection), 'selection' (several files or a folder), 'drop', 'pick',
 *        'with', and anything else
 *
 * @param {{ origin?: string, count?: number }} o  `count`: the videos the new Compare starts with
 * @returns {boolean}
 */
function startsInAddMode({ origin, count = 0 } = {}) {
  if (origin === 'toolbar-start' || origin === 'armed') return count >= 1;
  if (origin === 'start-single') return count === 1;
  return false;
}

/**
 * The origin of a Compare that Add to Compare creates: 'start-single' when exactly one file was chosen and the
 * Compare starts with just that file, else 'selection' (several files, a folder, or a file added to a player).
 * @param {{ selected: number, videos: number, isFile: boolean, count: number }} o
 *   `selected` items chosen, `videos` they hold, `isFile` the one item is a file, `count` tiles the Compare starts with
 */
function addToCompareOrigin({ selected, videos, isFile, count }) {
  return selected === 1 && videos === 1 && isFile && count === 1 ? 'start-single' : 'selection';
}

/**
 * @param {{ max: number|(() => number) }} o  the most videos compare shows (a function: read each time, the setting can change)
 */
function createAddMode({ max: maxOpt }) {
  const maxNow = () => (typeof maxOpt === 'function' ? maxOpt() : maxOpt);
  /** @type {null | { target: any, multi: boolean, uris: Set<string>, count: number }} */
  let st = null;
  const start = (target, { multi = false, uris = [] } = {}) => {
    if (uris.length >= maxNow()) { st = null; return 'full'; }
    st = { target, multi, uris: new Set(uris), count: uris.length };
    return 'on';
  };
  const hint = () => {
    if (!st) return { type: 'addMode', on: false };
    const max = maxNow();
    const room = Math.max(0, max - st.count);
    return { type: 'addMode', on: true, multi: st.multi, n: st.count, max, room };
  };
  return {
    get active() { return !!st; },
    get target() { return st ? st.target : null; },
    /** The page's hint for the target (`{ type: 'addMode', on, multi, n, max, room }`). */
    hint,
    start,
    /**
     * Turns the mode on for `target` (a player or a compare), which shows `uris` (strings) now.
     * Already on for the same target: turns it off (the same key or control toggles).
     * @returns {'on'|'off'|'full'}
     */
    toggle(target, { multi = false, uris = [] } = {}) {
      if (st && st.target === target) { st = null; return 'off'; }
      return start(target, { multi, uris });
    },
    stop() { const was = !!st; st = null; return was; },
    /** The target closed (its tab, or a player that became compare without the mode moving on). */
    gone(target) { if (st && st.target === target) { st = null; return true; } return false; },
    /** Files can also change via the Compare controls (replace, remove, or add). */
    sync(target, uris) {
      if (!st || st.target !== target) return false;
      return start(target, { multi: st.multi, uris }) === 'full';
    },
    /** A newly opened video can briefly become active before its tab closes. */
    editorChanged({ isTarget, openingVideo }) {
      if (!st || !st.multi || isTarget || openingVideo) return false;
      st = null;
      return true;
    },
    /**
     * A video was opened while the mode may be on. `null`: not ours, VS Code opens it as usual.
     * Else close its tab and add it to `target`, unless it is shown already. Capacity counts tiles.
     * @param {string} uri  the opened file, as a uri string
     * @param {string} [path]  its path (the uri's), to test the extension
     */
    claim(uri, path) {
      if (!st || typeof uri !== 'string') return null;
      const p = path || uri.split(/[?#]/)[0];
      if (!VIDEO_EXT.test(p)) return null;
      const target = st.target;
      if (st.count >= maxNow()) { st = null; return null; }
      if (st.uris.has(uri)) return { target, uri, dup: true, stop: false };
      st.uris.add(uri);
      const n = ++st.count;
      const full = n >= maxNow();
      const d = { target, uri, dup: false, stop: full, full, n };
      if (full) st = null;
      return d;
    },
  };
}

module.exports = { createAddMode, startsInAddMode, addToCompareOrigin };
