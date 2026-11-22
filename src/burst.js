'use strict';
// "Open together" (docs/notes/compare-ui.md): VS Code opens a multi-selection of the Explorer (Open With…,
// Enter, double-click, drop) as one editor per file in quick succession. Videos that arrive close together (each
// within `windowMs` of the one before) are one gesture and become one compare. Pure (timers injected), so a
// Node test checks the rules; src/compare.js does the opening and closing.

// The opens of one gesture reach the extension host within a few ms of each other (measured: 5-8 videos, under
// 15 ms); a longer window only delays compare. Each new video restarts it; a repeat report of one does not.
const BURST_WINDOW_MS = 120;

/**
 * @typedef {{ key: string, uri: any, panels: any[], tabs: any[], changed: boolean,
 *   resume: ((taken: boolean) => void)[] }} BurstEntry
 */

/** @param {{ tabs?: any[], panels?: any[] }} entry */
function burstColumn({ tabs, panels }) {
  return tabs?.[0]?.group?.viewColumn ?? panels?.[0]?.viewColumn;
}

/**
 * @param {{ windowMs?: number, max: () => number,
 *           onBurst: (b: { items: BurstEntry[], extra: BurstEntry[], viewColumn?: number }) => Promise<boolean>|void,
 *           setTimer?: (callback: () => void, delay: number) => any, clearTimer?: (handle: any) => void }} o
 *   `max`: the most videos compare takes now. `items` (in arrival order, one per file) go into compare;
 *   `extra` (past the maximum) stay as the separate tabs they are. `onBurst` returns (a promise of) whether compare
 *   took the videos: the players that `wait` for it are told (true: never start them).
 */
function createBurst({ windowMs = BURST_WINDOW_MS, max, onBurst, setTimer = setTimeout, clearTimer = clearTimeout }) {
  /** @type {Map<string, BurstEntry>} */
  let pending = new Map();
  const closing = new Map();
  let timer = null;
  const resume = (items, taken) => { for (const item of items) for (const done of item.resume) done(taken); };
  const fire = async () => {
    timer = null;
    const candidates = [...pending.values()];
    pending = new Map();
    const opened = candidates.find((item) => !item.changed);
    if (!opened) { resume(candidates, false); return; }
    const viewColumn = burstColumn(opened);
    const all = candidates.filter((item) => {
      const col = burstColumn(item);
      if (!item.changed || viewColumn === undefined || col === undefined || col === viewColumn) return true;
      resume([item], false);
      return false;
    });
    if (all.length < 2) { resume(all, false); return; }
    const n = Math.max(2, max());
    const items = all.slice(0, n);
    const extra = all.slice(n);
    resume(extra, false);
    for (const item of items) closing.set(item.key, item);
    let taken = false;
    try {
      taken = !!(await onBurst({ items, extra, viewColumn: viewColumn ?? burstColumn(items[0]) }));
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
     * they are one entry). A reused preview tab can join new opens but cannot start a compare on its own.
     * @param {string} key  the file's uri string
     * @param {any} uri
     * @param {{panel?: any, tab?: any, changed?: boolean}} [source]
     */
    add(key, uri, { panel, tab, changed = false } = {}) {
      let e = pending.get(key) || closing.get(key);
      if (!e) {
        e = { key, uri, panels: [], tabs: [], resume: [], changed };
        pending.set(key, e);
        if (timer !== null) clearTimer(timer);
        timer = setTimer(fire, windowMs);
      }
      if (e.changed !== changed) {
        // Opening the same URI in another group must leave the reused tab in its own group.
        const col = burstColumn(e);
        const incomingCol = burstColumn({ tabs: [tab], panels: [panel] });
        if (col !== undefined && incomingCol !== undefined && col !== incomingCol) {
          if (changed) return;
          e.tabs.length = 0;
        }
        e.changed = false;
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
      if (timer !== null) clearTimer(timer);
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
