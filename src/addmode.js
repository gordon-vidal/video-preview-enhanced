'use strict';
// "Add from the Explorer" (docs/notes/compare-ui.md "Add mode"): while it is on, the next video VS Code opens
// (an Explorer click, a drop on the editor, Quick Open ...) goes into compare instead of its own tab. Started from
// a player (Shift+D, or the quick pick's row): one video, then compare takes the player's tab. Started in compare
// (Shift+D, or the Compare panel's row): every video opened is added, until Esc, the same control again, or the
// compare is full. Pure (no VS Code), so a Node test checks the rules; src/compare.js does the opening.

const { VIDEO_EXT } = require('./comparepick');

/**
 * @param {{ max: number }} o  the most videos compare shows
 */
function createAddMode({ max }) {
  /** @type {null | { target: any, multi: boolean, uris: Set<string> }} */
  let st = null;
  const hint = () => {
    if (!st) return { type: 'addMode', on: false };
    const room = Math.max(0, max - st.uris.size);
    return { type: 'addMode', on: true, multi: st.multi, n: st.uris.size, max, room };
  };
  return {
    get active() { return !!st; },
    get target() { return st ? st.target : null; },
    /** The page's hint for the target (`{ type: 'addMode', on, multi, n, max, room }`). */
    hint,
    /**
     * Turns the mode on for `target` (a player or a compare), which shows `uris` (strings) now.
     * Already on for the same target: turns it off (the same key or control toggles).
     * @returns {'on'|'off'|'full'}
     */
    toggle(target, { multi = false, uris = [] } = {}) {
      if (st && st.target === target) { st = null; return 'off'; }
      if (new Set(uris).size >= max) { st = null; return 'full'; }
      st = { target, multi: !!multi, uris: new Set(uris) };
      return 'on';
    },
    stop() { const was = !!st; st = null; return was; },
    /** The target closed (its tab, or a player that became compare without the mode moving on). */
    gone(target) { if (st && st.target === target) { st = null; return true; } return false; },
    /** A player became compare while the mode goes on (several videos): the compare is the target now. */
    retarget(from, to, uris) { if (st && st.target === from) { st.target = to; if (uris) st.uris = new Set(uris); } },
    /**
     * A video was opened while the mode may be on. `null`: not ours, VS Code opens it as usual.
     * Else close its tab, and: `dup` it is shown already (nothing added), or add `uri` to `target`; `stop` the
     * mode ends with it (one video from a player, or compare full).
     * @param {string} uri  the opened file, as a uri string
     * @param {string} [path]  its path (the uri's), to test the extension
     */
    claim(uri, path) {
      if (!st || typeof uri !== 'string') return null;
      const p = path || uri.split(/[?#]/)[0];
      if (!VIDEO_EXT.test(p)) return null;
      const target = st.target;
      if (st.uris.has(uri)) return { target, uri, dup: true, stop: false };
      st.uris.add(uri);
      const full = st.uris.size >= max;
      const stop = full || !st.multi;
      const d = { target, uri, dup: false, stop, full, n: st.uris.size };
      if (stop) st = null;
      return d;
    },
  };
}

module.exports = { createAddMode };
