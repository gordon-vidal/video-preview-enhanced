'use strict';
// Deterministic HostAdapter for the mockup harness: answers media/player-ui.js the way the extension host does
// (src/folder-rail.js routeRailMessage, src/extension.js neighbour / pos), over a two-folder fake tree built from the
// FakeEngine clips. No DOM, no VS Code: test/host/player_ui_test.js drives it in Node.
//
//   const host = createFakeHost({ clips });
//   const ui = VpePlayerUi.create({ ..., host });
//   host.connect(ui.onHostMessage);
//
// Unified host protocol (page -> host, and what the fake answers): 'tileOrder' { order } and 'leaveCompare'
// { keepId, t } update the tiles and the rail's members; 'tileSize' { w, h, cols, rows, zoom } is recorded;
// 'replaceVideo' { oldId } answers { type: 'replaceTile', oldId, newId }; 'playbackPrefs' { prefs } is stored and
// broadcastPrefs() simulates another tab's change; 'toast' { text, ms? } echoes back (ms capped at 10 s);
// 'focusMode' { active } / 'focusModeExited' answer { type: 'focusMode', active }. test/host/adapter_contract_test.js
// is the contract every HostAdapter (this fake and media/player-host-adapter.js) must pass; its types are
// media/unified-contracts.d.ts (HostAdapter, PageToHostMessage, HostToPageMessage).
(() => {
  /** @typedef {import('../../media/unified-contracts').HostAdapter} HostAdapter */
  const ROOT_CRUMB = 'clips / dailies_v4';
  const SUB_CRUMB = 'clips / dailies_v4 / renders';
  const COMMAND_TOASTS = {
    copyText: 'Copied to the clipboard (mock)',
    copyFrame: null,
    copyLink: 'Frame link copied (mock)',
    saveFrame: 'Save frame as PNG… (mock)',
    external: 'Open in system player (mock)',
    openSettings: 'Open VS Code Settings (mock)',
    loadSubs: 'Load subtitles… (mock)',
    openUrl: 'Open Video URL… (mock)',
    fullscreen: 'Fullscreen (mock)',
  };
  const PREF_KEYS = ['volume', 'rate', 'timeMode', 'stepSize'];
  const MAX_TOAST_MS = 10000;

  /**
   * @param {{ clips: { id: string, name: string, fps?: number, frames?: number }[], subfolder?: number,
   *           now?: number, deliver?: (msg: any) => void }} opts
   *   subfolder: how many of the last clips live in the "renders" subfolder (default 2).
   */
  function createFakeHost(opts) {
    const clips = opts.clips || [];
    const nSub = Math.max(0, Math.min(clips.length - 1, opts.subfolder === undefined ? 2 : opts.subfolder));
    const rootClips = clips.slice(0, clips.length - nSub);
    const subClips = clips.slice(clips.length - nSub);
    const now = opts.now || Date.UTC(2026, 10, 20, 12, 0, 0);
    let deliver = opts.deliver || (() => {});
    /** Every message the page posted, in order (tests and the harness footer read it). */
    const log = [];
    let gen = 0;
    let folder = 'root';
    let railOpen = false;
    let tiles = [];
    let current = null;
    /** @type {string[]} the last display order the page reported ('tileOrder') */
    let tileOrder = [];
    /** @type {{ w: number, h: number, cols: number, rows: number, zoom: number } | null} */
    let tileSize = null;
    /** @type {{ keepId: string | null, t: number } | null} the last 'leaveCompare' */
    let leftCompare = null;
    /** Shared playback preferences (the host keeps one copy for every player tab). */
    const prefs = { volume: 0.85, rate: 1, timeMode: 'clock', stepSize: 'frame' };
    let focusMode = false;

    const metaOf = (c, i) => ({
      id: c.id,
      duration: (c.frames || 240) / (c.fps || 24) + i * 14,
      size: (18 + i * 27) * 1024 * 1024,
      mtime: now - i * 3600 * 1000 * 5,
    });
    const folderOf = (id) => (subClips.some((c) => c.id === id) ? 'sub' : 'root');
    const videosIn = (f) => (f === 'sub' ? subClips : rootClips);

    function entries(f) {
      if (f === 'sub') return [{ id: 'up:root', name: '..', kind: 'up' }, ...subClips.map((c) => ({ id: c.id, name: c.name, kind: 'video' }))];
      return [
        ...(nSub ? [{ id: 'dir:renders', name: 'renders', kind: 'dir' }] : []),
        ...rootClips.map((c) => ({ id: c.id, name: c.name, kind: 'video' })),
        { id: 'file:notes', name: 'notes.txt', kind: 'file' },
      ];
    }

    function list(from) {
      gen++;
      const es = entries(folder);
      deliver({
        type: 'rail', op: 'list', gen, crumb: folder === 'sub' ? SUB_CRUMB : ROOT_CRUMB, root: folder === 'root',
        entries: es,
        ...(current && es.some((e) => e.id === current) ? { current } : {}),
        ...(from ? { from } : {}),
        members: tiles.filter((id) => es.some((e) => e.id === id)), count: tiles.length,
      });
      const patches = videosIn(folder).map((c) => metaOf(c, clips.indexOf(c)));
      if (folder === 'root') patches.push({ id: 'file:notes', size: 2048, mtime: now - 86400000 });
      deliver({ type: 'rail', op: 'meta', gen, patches });
      pos();
    }
    function pos() {
      if (!current) return;
      const vs = videosIn(folderOf(current));
      deliver({ type: 'rail', op: 'pos', index: vs.findIndex((c) => c.id === current), count: vs.length });
    }
    const label = (id) => (clips.find((c) => c.id === id) || { name: id }).name;

    function onRail(m) {
      switch (m.op) {
        case 'open': railOpen = true; folder = current ? folderOf(current) : 'root'; list(); return;
        case 'close': railOpen = false; return;
        case 'prefs': case 'visible': case 'hover': case 'filter': case 'self': return;
        default: break;
      }
      if (m.gen !== gen) return; // an old listing: the host ignores it (src/folder-rail.js ctl.entry)
      const e = entries(folder).find((x) => x.id === m.id);
      if (!e) return;
      if (m.op === 'browse' && (e.kind === 'dir' || e.kind === 'up')) {
        const was = folder;
        folder = e.kind === 'dir' ? 'sub' : 'root';
        list(was === 'sub' && folder === 'root' ? 'dir:renders' : undefined);
      } else if ((m.op === 'activate' || m.op === 'compare') && e.kind === 'video' && tiles.length >= 2) {
        // In Compare a video row toggles membership (src/compare.js railAdd): in → out, out → in.
        deliver(tiles.includes(e.id) ? { type: 'removeVideo', clipId: e.id } : { type: 'openVideo', clipId: e.id, label: e.name, compare: true });
      } else if (m.op === 'activate' && e.kind === 'video') {
        deliver({ type: 'openVideo', clipId: e.id, label: e.name, replace: true });
      } else if (m.op === 'compare' && e.kind === 'video') {
        deliver({ type: 'openVideo', clipId: e.id, label: e.name, compare: true });
      } else if (m.op === 'compareFolder' && e.kind === 'dir') {
        for (const c of subClips) deliver({ type: 'openVideo', clipId: c.id, label: c.name, compare: true });
      }
    }

    function post(m) {
      if (!m) return;
      log.push(m);
      if (m.type === 'rail') { onRail(m); return; }
      if (m.type === 'neighbour') {
        if (!current) return;
        const vs = videosIn(folderOf(current));
        const i = vs.findIndex((c) => c.id === current);
        const next = vs[(i + (m.d < 0 ? -1 : 1) + vs.length) % vs.length];
        if (next && next.id !== current) deliver({ type: 'openVideo', clipId: next.id, label: next.name, replace: true });
        return;
      }
      if (m.type === 'tiles') {
        const was = current;
        tiles = Array.isArray(m.tiles) ? m.tiles.slice() : [];
        current = m.current || null;
        if (railOpen && was !== current) list();
        else {
          if (railOpen) deliver({ type: 'rail', op: 'members', gen, ids: tiles.filter((id) => entries(folder).some((e) => e.id === id)), count: tiles.length });
          pos();
        }
        return;
      }
      if (m.type === 'pickVideo') {
        const exclude = new Set(m.exclude || []);
        const next = clips.find((c) => !exclude.has(c.id));
        deliver(next ? { type: 'openVideo', clipId: next.id, label: next.name, compare: true } : { type: 'toast', text: 'No more videos in this folder' });
        return;
      }
      if (m.type === 'tileOrder') {
        // The page reordered its tiles (drag, swap): the rail's members follow the new display order.
        const order = Array.isArray(m.order) ? m.order : Array.isArray(m.tiles) ? m.tiles : [];
        tileOrder = order.filter((id) => typeof id === 'string');
        setTiles(tileOrder, m.current || tileOrder[0] || null);
        return;
      }
      if (m.type === 'tileSize') {
        tileSize = { w: Number(m.w) || 0, h: Number(m.h) || 0, cols: Number(m.cols) || 1, rows: Number(m.rows) || 1, zoom: Number(m.zoom) || 1 };
        return;
      }
      if (m.type === 'replaceVideo') {
        // "Replace this tile": the host picks the next video not already shown and swaps it in.
        const oldId = m.oldId || m.clipId;
        const taken = new Set([...tiles, oldId, ...(m.exclude || [])]);
        const next = clips.find((c) => !taken.has(c.id));
        if (!next) { deliver({ type: 'toast', text: 'No more videos in this folder' }); return; }
        if (tiles.includes(oldId)) setTiles(tiles.map((id) => (id === oldId ? next.id : id)), current === oldId ? next.id : current);
        deliver({ type: 'replaceTile', oldId, newId: next.id, label: next.name });
        return;
      }
      if (m.type === 'leaveCompare') {
        const keepId = m.keepId || current || tiles[0] || null;
        leftCompare = { keepId, t: Number(m.t) || 0 };
        setTiles(keepId ? [keepId] : [], keepId);
        return;
      }
      if (m.type === 'playbackPrefs') {
        const src = m.prefs && typeof m.prefs === 'object' ? m.prefs : m;
        for (const k of PREF_KEYS) if (src[k] !== undefined) prefs[k] = src[k];
        return;
      }
      if (m.type === 'toast') { toast(m.text, m.ms); return; }
      if (m.type === 'focusMode') { setFocus(m.active === undefined ? !focusMode : !!m.active); return; }
      if (m.type === 'focusModeExited') { setFocus(false); return; }
      if (Object.prototype.hasOwnProperty.call(COMMAND_TOASTS, m.type) && COMMAND_TOASTS[m.type]) {
        deliver({ type: 'toast', text: COMMAND_TOASTS[m.type] });
      }
    }

    /** Membership changed outside a 'tiles' report (order, replace, leave): keep rail members and position current. */
    function setTiles(/** @type {string[]} */ next, /** @type {string | null} */ cur) {
      tiles = next.slice();
      current = cur;
      if (railOpen) deliver({ type: 'rail', op: 'members', gen, ids: tiles.filter((id) => entries(folder).some((e) => e.id === id)), count: tiles.length });
      pos();
    }
    /** A toast to the page; `ms` (how long it stays) is optional and capped at 10 s like the real host. */
    function toast(/** @type {any} */ text, /** @type {any} */ ms) {
      const n = Number(ms);
      deliver({ type: 'toast', text: String(text || ''), ...(n > 0 ? { ms: Math.min(MAX_TOAST_MS, Math.round(n)) } : {}) });
    }
    function setFocus(/** @type {boolean} */ active) {
      focusMode = active;
      deliver({ type: 'focusMode', active });
    }

    const host = {
      post,
      log,
      connect(/** @type {(m: any) => void} */ fn) { deliver = fn; },
      /** Nothing to release: the fake holds no listener of its own. */
      dispose() { deliver = () => {}; },
      /** The simulated VS Code Explorer: a click opens the video the way the extension does. */
      explorerOpen(id) { deliver({ type: 'openVideo', clipId: id, label: label(id) }); },
      /** Another player tab changed its playback preferences: the host broadcasts them to this page. */
      broadcastPrefs(/** @type {any} */ p) {
        for (const k of PREF_KEYS) if (p && p[k] !== undefined) prefs[k] = p[k];
        deliver({ type: 'playbackPrefs', prefs: { ...prefs } });
      },
      /** The user left VS Code's Zen Mode by other means (Escape twice, the command palette). */
      exitFocusMode() { setFocus(false); },
      toast,
      snapshot: () => ({
        gen, folder, railOpen, tiles: tiles.slice(), current, tileOrder: tileOrder.slice(),
        tileSize: tileSize && { ...tileSize }, leftCompare: leftCompare && { ...leftCompare }, prefs: { ...prefs }, focusMode,
      }),
    };
    return /** @satisfies {HostAdapter} */ (host);
  }

  const api = { createFakeHost };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else globalThis.VpeFakeHost = api;
})();
