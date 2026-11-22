'use strict';
// "Open together" (docs/notes/compare-ui.md): VS Code opens a multi-selection of the Explorer (Open With…,
// Enter, double-click, drop) as one editor per file in quick succession. Videos that arrive close together (each
// within `windowMs` of the one before) are one gesture and become one compare. Pure (timers injected), so a
// Node test checks the rules; src/compare.js does the opening and closing.

// The opens of one gesture reach the extension host within a few ms of each other (measured: 5-8 videos, under
// 15 ms); a longer window only delays compare. Each new video restarts it; a repeat report of one does not.
const BURST_WINDOW_MS = 120;

/**
 * @param {{ windowMs?: number, max: () => number, onBurst: (b: { items: any[], extra: any[] }) => Promise<boolean>|void,
 *           setTimer?: Function, clearTimer?: Function }} o
 *   `max`: the most videos compare takes now. `items` (in arrival order, one per file) go into compare;
 *   `extra` (past the maximum) stay as the separate tabs they are. `onBurst` returns (a promise of) whether compare
 *   took the videos: the players that `wait` for it are told (true: never start them).
 */
function createBurst({ windowMs = BURST_WINDOW_MS, max, onBurst, setTimer = setTimeout, clearTimer = clearTimeout }) {
  /** @type {Map<string, { key: string, uri: any, panels: any[], tabs: any[], resume: Function[] }>} */
  let pending = new Map();
  const closing = new Map();
  let timer = null;
  const resume = (items, taken) => { for (const item of items) for (const done of item.resume) done(taken); };
  const fire = async () => {
    timer = null;
    const all = [...pending.values()];
    pending = new Map();
    if (all.length < 2) { resume(all, false); return; }
    const n = Math.max(2, max());
    const items = all.slice(0, n);
    const extra = all.slice(n);
    resume(extra, false);
    for (const item of items) closing.set(item.key, item);
    let taken = false;
    try {
      taken = !!(await onBurst({ items, extra }));
    } catch {
      taken = false; // compare could not open: the held players start as usual
    } finally {
      for (const item of items) closing.delete(item.key);
      resume(items, taken);
    }
  };
  return {
    /**
     * A video was opened (its custom editor resolved, or its tab appeared; both may report the same file:
     * they are one entry). `panel` / `tab` are kept to close it later.
     * @param {string} key  the file's uri string
     */
    add(key, uri, { panel, tab } = {}) {
      let e = pending.get(key) || closing.get(key);
      if (!e) {
        e = { key, uri, panels: [], tabs: [], resume: [] };
        pending.set(key, e);
        if (timer) clearTimer(timer);
        timer = setTimer(fire, windowMs);
      }
      if (panel && !e.panels.includes(panel)) e.panels.push(panel);
      if (tab && !e.tabs.includes(tab)) e.tabs.push(tab);
    },
    /** A single open can start immediately. Confirmed bursts hold the players until Compare takes them. */
    wait(key) {
      const entry = closing.get(key) || (pending.size > 1 && pending.get(key));
      return entry ? new Promise((done) => entry.resume.push(done)) : false;
    },
    /** Forget what is waiting (the mode that takes opens instead started, or the feature is off). */
    cancel() {
      if (timer) clearTimer(timer);
      timer = null;
      resume(pending.values(), false);
      pending = new Map();
    },
    get waiting() { return pending.size; },
  };
}

/**
 * Tabs of our player (a single click's preview tab, say) that still show one of `uris` (strings): once those
 * videos are in a compare they are duplicates. `groups` is vscode.window.tabGroups.all; with `viewColumn`
 * only that editor group is looked at.
 */
function leftoverTabs(groups, uris, viewColumn) {
  const want = new Set(uris);
  const out = [];
  for (const g of groups || []) {
    if (viewColumn !== undefined && g.viewColumn !== undefined && g.viewColumn !== viewColumn) continue;
    for (const tab of g.tabs || []) {
      const inp = tab.input || {};
      if (!inp.uri || typeof inp.viewType !== 'string' || !inp.viewType.startsWith('videoPreviewEnhanced.')) continue;
      if (want.has(inp.uri.toString())) out.push(tab);
    }
  }
  return out;
}

/** The one-time message after the first "open together". */
function togetherNotice(n) {
  return `Video Preview: opened ${n} videos together in Compare. You can turn this off in Settings (compare.openTogether).`;
}

module.exports = { BURST_WINDOW_MS, createBurst, leftoverTabs, togetherNotice };
