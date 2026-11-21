'use strict';
// "Open together" (docs/notes/compare-ui.md): VS Code opens a multi-selection of the Explorer (Open With…,
// Enter, double-click) as one editor per file in quick succession. Videos that arrive close together (each
// within `windowMs` of the one before) are one gesture and become one compare. Pure (timers injected), so a
// Node test checks the rules; src/compare.js does the opening and closing.

/**
 * @param {{ windowMs?: number, max: () => number, onBurst: (b: { items: any[], extra: any[] }) => void,
 *           setTimer?: Function, clearTimer?: Function }} o
 *   `max`: the most videos compare takes now. `items` (in arrival order, one per file) go into compare;
 *   `extra` (past the maximum) stay as the separate tabs they are.
 */
function createBurst({ windowMs = 400, max, onBurst, setTimer = setTimeout, clearTimer = clearTimeout }) {
  /** @type {Map<string, { key: string, uri: any, panels: any[], tabs: any[] }>} */
  let pending = new Map();
  let timer = null;
  const fire = () => {
    timer = null;
    const all = [...pending.values()];
    pending = new Map();
    if (all.length < 2) return;
    const n = Math.max(2, max());
    onBurst({ items: all.slice(0, n), extra: all.slice(n) });
  };
  return {
    /**
     * A video was opened (its custom editor resolved, or its tab appeared; both may report the same file:
     * they are one entry). `panel` / `tab` are kept to close it later.
     * @param {string} key  the file's uri string
     */
    add(key, uri, { panel, tab } = {}) {
      let e = pending.get(key);
      if (!e) { e = { key, uri, panels: [], tabs: [] }; pending.set(key, e); }
      if (panel && !e.panels.includes(panel)) e.panels.push(panel);
      if (tab && !e.tabs.includes(tab)) e.tabs.push(tab);
      if (timer) clearTimer(timer);
      timer = setTimer(fire, windowMs);
    },
    /** Forget what is waiting (the mode that takes opens instead started, or the feature is off). */
    cancel() { if (timer) clearTimer(timer); timer = null; pending = new Map(); },
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

module.exports = { createBurst, leftoverTabs, togetherNotice };
