// @ts-check
// Shared webview UI controller: connects the real DOM (#bar from src/bar.js, VpeControls, VpeFolderRail,
// VpeCtxMenu, the stage cells, keyboard shortcuts) to the pure unified state (media/player-state.js) through two
// swappable adapters, so the real webview and the mockup harness (tools/mockup/render.js) run the same code:
//
//   EngineAdapter  draws a tile's frame and describes a clip (tools/mockup/fake-engine.js; production: the decoders).
//   HostAdapter    `post(msg)` is everything the page asks of the extension host (production: vscode.postMessage;
//                  mockup: tools/mockup/fake-host.js). The host answers through the returned `onHostMessage(msg)`.
//
// Zero VS Code, zero decoder coupling. The widget modules come in through `env.widgets` (default: the page globals)
// so nothing here reaches for a global the caller did not choose. Pure helpers at the top are exported for the
// millisecond Node tests (test/host/player_ui_test.js); `create(env)` is the DOM part.
//
// Host -> page messages: { type: 'rail', op, ... }      the folder rail protocol (src/folder-rail.js)
//                        { type: 'openVideo', clipId, label?, compare?, replace?, forceNewTab? }
//                        { type: 'toast', text }
// Page -> host messages: { type: 'rail' | 'neighbour', ... }  posted by VpeFolderRail itself
//                        { type: 'tiles', tabId, tiles, current }  after any change of the active tab's videos
//                        { type: 'pickVideo', exclude }            "+ Add video" / "Pick…" / Compare › Add video
//                        { type: 'copyText', text } and the command requests listed in HOST_COMMANDS
'use strict';

(() => {
  // checkJs: start
  /**
   * @typedef {object} ClipMeta
   * @property {string} id
   * @property {string} name
   * @property {string} [codec]
   * @property {number} [fps]
   * @property {number} [frames]
   * @property {string} [color]
   */
  /**
   * @typedef {object} EngineAdapter
   * @property {ClipMeta[]} clips
   * @property {(id: string) => ClipMeta} getClip
   * @property {(canvas: HTMLCanvasElement, clipId: string, frame: number, opts?: { splitClipRatio?: number | null }) => void} draw
   * @property {(clipId: string) => { title: string, sub: string, rows: string[][] }} [facts]
   */
  /**
   * @typedef {object} HostAdapter
   * @property {(msg: any) => void} post
   */
  /**
   * @typedef {object} Prefs
   * @property {string} onEnd       'off' | 'loop' | 'next' ... (media/autoplay.js)
   * @property {number} rate
   * @property {boolean} muted
   * @property {number} volume
   * @property {string} stepSize
   * @property {string} picMode     'fit' | 'fill' | 'stretch' | 'actual'
   * @property {number} picZoom
   * @property {string} subKey
   * @property {string} audioId
   * @property {string} transcodeMode
   * @property {number} transcodeMaxBitrate
   * @property {number} transcodeRes
   * @property {number} timeMode    0 = clock, 1 = timecode, 2 = frame number
   */

  /** Bar commands the page cannot carry out itself: posted to the host as { type }. */
  const HOST_COMMANDS = /** @type {const} */ ([
    'saveFrame', 'copyFrame', 'copyLink', 'external', 'openSettings', 'loadSubs', 'openUrl', 'fullscreen',
  ]);
  const PICTURE_MODES = /** @type {const} */ (['fit', 'fill', 'stretch', 'actual']);

  /** @returns {Prefs} */
  function defaultPrefs() {
    return {
      onEnd: 'off', rate: 1, muted: true, volume: 0.85, stepSize: 'frame', picMode: 'fit', picZoom: 1,
      subKey: 'en', audioId: 'a0', transcodeMode: 'auto', transcodeMaxBitrate: 0, transcodeRes: 0, timeMode: 0,
    };
  }

  /**
   * The page's keyboard shortcuts (a subset of media/player.js / media/compare.js keydown, same keys) as data.
   * @param {{ key: string, shiftKey?: boolean, ctrlKey?: boolean, metaKey?: boolean, altKey?: boolean }} e
   * @returns {string | null} an action name of `create()`'s dispatch table
   */
  function keyAction(e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return null;
    switch (e.key) {
      case ' ': case 'k': case 'K': return 'playPause';
      case ',': return 'prevFrame';
      case '.': return 'nextFrame';
      case 'm': case 'M': return 'mute';
      case 'r': case 'R': return 'loop';
      case 'a': return 'setA';
      case 'A': return e.shiftKey ? null : 'setA';
      case 'b': case 'B': return 'setB';
      case 'Backspace': return 'clearAB';
      case 'z': case 'Z': return e.shiftKey ? null : 'cyclePicture';
      case 'i': case 'I': return 'info';
      case '?': return 'keys';
      case 'Escape': return 'escape';
      case 'D': return e.shiftKey ? 'capture' : null;
      case 'N': return e.shiftKey ? 'nextVideo' : null;
      case 'P': return e.shiftKey ? 'prevVideo' : null;
      case 'f': case 'F': return 'fullscreen';
      default: return null;
    }
  }

  /**
   * The bar's time readout: clock (m:ss.ss), SMPTE timecode, or frame number (click the time to cycle).
   * @param {number} frame
   * @param {number} fps
   * @param {number} mode 0 | 1 | 2
   * @param {((f: number, fps: number) => string) | null} [fmtTimecode] media/timefmt.js fmtTimecode
   */
  function formatTime(frame, fps, mode, fmtTimecode) {
    const r = fps || 24;
    if (mode === 2) return `#${frame}`;
    if (mode === 1 && fmtTimecode) return fmtTimecode(frame, r);
    const t = frame / r;
    const m = Math.floor(t / 60);
    return `${m}:${(t % 60).toFixed(2).padStart(5, '0')}`;
  }

  /** @param {any} stateApi @param {any} tab */
  function tilesKey(stateApi, tab) { return `${tab.id}|${tab.tiles.join(',')}`; }

  /**
   * Apply one host -> page message to the workspace state (pure: the DOM side lives in `create`).
   * @param {any} S media/player-state.js
   * @param {any} ws WorkspaceState
   * @param {any} msg
   * @param {(id: string) => ClipMeta} getClip
   * @returns {{ state: any, toast: string, handled: boolean }}
   */
  function applyHostMessage(S, ws, msg, getClip) {
    if (!msg || msg.type !== 'openVideo' || typeof msg.clipId !== 'string') return { state: ws, toast: '', handled: false };
    const label = msg.label || (getClip(msg.clipId) || { name: msg.clipId }).name;
    if (msg.replace) {
      const tab = S.getTab(ws);
      if (tab.tiles.length === 1) return { state: S.replaceVideo(ws, msg.clipId), toast: '', handled: true };
    }
    let state = ws;
    if (msg.compare && !S.getTab(state).capture) state = S.toggleCapture(state).state;
    const res = S.openVideo(state, msg.clipId, { label, forceNewTab: !!msg.forceNewTab });
    return { state: res.state, toast: res.toast, handled: true };
  }

  /**
   * What the Compare page lists (media/compare.js renderCompare, over the unified state).
   * @param {any} S @param {any} tab TabState @param {(id: string) => ClipMeta} getClip
   */
  function compareRows(S, tab, getClip) {
    return tab.tiles.map((/** @type {string} */ id, /** @type {number} */ i) => {
      const off = tab.offsets[id] || 0;
      return { id, letter: S.TILE_KEYS[i], name: (getClip(id) || { name: id }).name, offset: off, offText: `${off >= 0 ? '+' : ''}${off} f` };
    });
  }

  const SVG = (/** @type {string} */ body, size = 18, sw = 1.6) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
  const ICONS = {
    split: SVG('<rect x="4" y="5" width="16" height="14" rx="1.6"/><path d="M12 3v18"/>'),
    sync: SVG('<rect x="4" y="6" width="11.5" height="4.2" rx="1.1"/><rect x="8.5" y="13.8" width="11.5" height="4.2" rx="1.1"/><path d="M12 3.5v17" stroke-dasharray="1.8 2.2"/>'),
    compare: SVG('<rect x="2.5" y="4.5" width="19" height="15" rx="1.5"/><path d="M12 4.5v15"/>', 16),
    expand: SVG('<path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>', 13, 2),
    collapse: SVG('<path d="M4 14h6v6M20 10h-6V4M14 10l7-7M10 14l-7 7"/>', 13, 2),
    close: SVG('<path d="M6 6l12 12M18 6L6 18"/>', 12, 2.1),
    plus: SVG('<path d="M12 5v14M5 12h14"/>'),
    leave: SVG('<path d="M10 17l-5-5 5-5M5 12h11a4 4 0 0 1 4 4v3"/>'),
  };
  const esc = (/** @type {string} */ s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] || c);

  /**
   * @param {{
   *   doc: Document,
   *   win?: Window & typeof globalThis,
   *   stateApi: any,
   *   engine: EngineAdapter,
   *   host: HostAdapter,
   *   widgets?: { VpeControls?: any, VpeFolderRail?: any, VpeCtxMenu?: any, VpeAbLoop?: any, VpeAutoplay?: any, VpeTime?: any },
   *   initial?: any,
   *   prefs?: Partial<Prefs>,
   *   railCfg?: { layout?: string, width?: number, column?: string, playable?: boolean },
   *   container?: HTMLElement,
   *   keyTarget?: EventTarget,
   *   tickMs?: number,
   *   onChange?: (ws: any, ui: any) => void,
   * }} env
   */
  function create(env) {
    if (!env || !env.doc) throw new Error('player-ui: env.doc is required');
    const S = env.stateApi;
    if (!S || typeof S.deriveUi !== 'function' || typeof S.getTab !== 'function') throw new Error('player-ui: env.stateApi must be media/player-state.js');
    const engine = env.engine;
    if (!engine || typeof engine.getClip !== 'function' || typeof engine.draw !== 'function') throw new Error('player-ui: env.engine must implement getClip() and draw()');
    const host = env.host;
    if (!host || typeof host.post !== 'function') throw new Error('player-ui: env.host must implement post()');

    const doc = env.doc;
    const win = /** @type {any} */ (env.win || doc.defaultView || globalThis);
    const W = /** @type {any} */ ({ ...{ VpeControls: win.VpeControls, VpeFolderRail: win.VpeFolderRail, VpeCtxMenu: win.VpeCtxMenu, VpeAbLoop: win.VpeAbLoop, VpeAutoplay: win.VpeAutoplay, VpeTime: win.VpeTime }, ...(env.widgets || {}) });
    for (const k of ['VpeControls', 'VpeFolderRail', 'VpeCtxMenu', 'VpeAbLoop', 'VpeAutoplay']) {
      if (!W[k]) throw new Error(`player-ui: widget ${k} is missing`);
    }
    const $ = (/** @type {string} */ id) => /** @type {any} */ (doc.getElementById(id));
    const need = (/** @type {string} */ id) => { const x = $(id); if (!x) throw new Error(`player-ui: #${id} is missing`); return x; };

    // ---- DOM: the real #bar (src/bar.js) and the stage ----
    const stageEl = need('stage'), barEl = need('bar');
    const cellsEl = $('cells') || stageEl.appendChild(Object.assign(doc.createElement('div'), { id: 'cells' }));
    const capBanner = $('capBanner'), splitterEl = $('splitter'), dividerEl = $('divider');
    const seekEl = need('seek'), nowEl = $('now'), durEl = $('dur'), timeEl = $('time');
    const tracksBtn = $('tracks'), cmpBtn = need('startCompareBtn');
    const playBtn = need('play'), prevBtn = need('prev'), nextBtn = need('next');
    const prevSize = $('prevSize'), nextSize = $('nextSize');
    const muteBtn = $('mute'), volEl = $('volume'), rateBtn = $('rate');
    const cogBtn = need('cog'), infoBtn = need('infoBtn'), picBtn = $('picBtn'), fullBtn = $('full');
    const setABtn = $('setABtn'), setBBtn = $('setBBtn'), abMarks = $('abMarks'), abA = $('abA'), abB = $('abB');

    /** Unified Split (N = 2) and Sync (N >= 2) buttons sit beside Compare; src/bar.js does not draw them yet. */
    const barButton = (/** @type {string} */ id, /** @type {string} */ title, /** @type {string} */ icon) => {
      let b = $(id);
      if (!b) {
        b = doc.createElement('button');
        b.id = id; b.type = 'button'; b.className = 'ib'; b.hidden = true; b.title = title;
        b.setAttribute('aria-label', title);
        b.innerHTML = icon;
        cmpBtn.parentNode.insertBefore(b, cmpBtn);
      }
      return b;
    };
    const splitBtn = barButton('splitBtn', 'Split Wipe (2 videos)', ICONS.split);
    const syncBtn = barButton('syncBtn', 'Sync frame offsets', ICONS.sync);

    const announce = (/** @type {string} */ t) => { const l = $('live'); if (l) l.textContent = t; };
    const toast = $('toast') ? W.VpeControls.createToast($('toast'), announce) : announce;
    const flashPlay = $('playFlash') ? W.VpeControls.createPlayFlash($('playFlash'), stageEl) : () => {};

    // ---- state ----
    let ws = env.initial && Array.isArray(env.initial.tabs) ? env.initial : S.createWorkspaceState(env.initial || {});
    /** @type {Prefs} */
    const prefs = { ...defaultPrefs(), ...(env.prefs || {}) };
    const ab = W.VpeAbLoop.create();
    let lastTilesKey = '';
    let disposed = false;
    /** @type {(() => void)[]} */
    const cleanups = [];
    const listen = (/** @type {any} */ target, /** @type {string} */ type, /** @type {any} */ fn, /** @type {any} */ opts) => {
      target.addEventListener(type, fn, opts);
      cleanups.push(() => target.removeEventListener(type, fn, opts));
    };
    const tab = () => S.getTab(ws);
    const fps = () => tab().fps || 24;
    const fmt = (/** @type {number} */ f) => formatTime(f, fps(), prefs.timeMode, W.VpeTime ? W.VpeTime.fmtTimecode : null);
    const clipName = (/** @type {string} */ id) => (engine.getClip(id) || { name: id }).name;

    /** One state transition: replace the state, say the toast, redraw. */
    const commit = (/** @type {any} */ next, toastText = '') => {
      ws = next;
      if (toastText) toast(toastText);
      render();
    };
    const postHost = (/** @type {any} */ msg) => { if (!disposed) host.post(msg); };

    // ---- the real Folder Rail: its own messages go straight to the host ----
    /** @type {any} */
    let controls = null;
    /** @type {any} */
    let ctxMenu = null;
    const setOnEnd = (/** @type {string} */ m) => {
      prefs.onEnd = m;
      rail.refreshOnEnd();
      if (controls) controls.refresh();
      toast(`Autoplay: ${W.VpeAutoplay.label(m)}`);
    };
    const rail = W.VpeFolderRail.create({
      doc,
      toast,
      post: (/** @type {any} */ m) => postHost(m),
      cfg: env.railCfg || { layout: 'dock', width: 200, column: 'duration', playable: true },
      getOnEnd: () => prefs.onEnd,
      setOnEnd,
      label: W.VpeAutoplay.label,
      time: () => tab().frame / fps(),
    });

    // ---- the real VpeControls: every sub-page, plus the Compare pages over the unified state ----
    const abLabel = () => {
      if (ab.a === null && ab.b === null) return 'Off';
      const a = ab.a !== null ? fmt(Math.round(ab.a * fps())) : '—';
      const b = ab.b !== null ? fmt(Math.round(ab.b * fps())) : '—';
      return `${a} → ${b}`;
    };
    let infoSel = 0;
    const facts = (/** @type {string} */ id) => {
      if (engine.facts) return engine.facts(id);
      const c = engine.getClip(id) || { id, name: id };
      const t = tab();
      return {
        title: c.name,
        sub: [c.codec, `${c.fps || 24} fps`].filter(Boolean).join(' · '),
        rows: [
          ['Video', [c.codec, `${c.fps || 24} fps`].filter(Boolean).join(', ')],
          ['Duration', `${fmt(t.maxFrame)} (${t.maxFrame} frames)`],
          ['View', t.tiles.length > 1 ? `Compare (${t.tiles.length} videos)` : 'Single video'],
        ],
      };
    };
    let selTile = 0;
    const cmpViews = {
      cmp: {
        label: 'Compare', button: 'cmp',
        render: (/** @type {any} */ _s, /** @type {any} */ k) => {
          const t = tab();
          const f = doc.createDocumentFragment();
          f.appendChild(k.heading('Videos'));
          compareRows(S, t, engine.getClip).forEach((r, i) => {
            const b = k.btn('row cvid', r.name, () => { selTile = i; k.show('cmpVid'); }, { value: r.offText, chev: true, aria: { 'aria-label': `${r.letter}: ${r.name}, offset ${r.offText}` } });
            const ltr = k.el('span', 'ltr', r.letter);
            ltr.setAttribute('aria-hidden', 'true');
            b.insertBefore(ltr, b.firstChild);
            f.appendChild(b);
          });
          if (t.tiles.length < t.maxVideos) {
            f.appendChild(k.btn('row', 'Add video…', () => { k.close(false); act.pickVideo(); }, { icon: ICONS.plus, value: `${t.tiles.length} of ${t.maxVideos}` }));
          }
          const cap = k.btn('row', 'Open new videos here', () => { act.capture(); k.render(); }, { icon: ICONS.plus, kbd: 'Shift+D', aria: { role: 'switch', 'aria-checked': String(t.capture) } });
          cap.appendChild(k.sw(t.capture));
          f.appendChild(cap);
          f.appendChild(k.el('div', 'sep'));
          if (t.tiles.length >= 2) {
            const row = k.el('div', 'row static');
            row.appendChild(k.el('span', 'grow', 'Layout'));
            const seg = k.el('div', 'seg');
            seg.setAttribute('role', 'group');
            seg.setAttribute('aria-label', 'Layout');
            const ui = S.deriveUi(t, { width: 1, height: 1 });
            const modes = t.tiles.length === 2 ? [['spotlight', 'Spotlight'], ['grid', 'Grid'], ['split', 'Split']] : [['spotlight', 'Spotlight'], ['grid', 'Equal Grid']];
            for (const [m, label] of modes) {
              seg.appendChild(k.btn('chip', label, () => { act.layout(m); k.render(); }, { aria: { 'aria-pressed': String(ui.effectiveLayout === m) } }));
            }
            row.appendChild(seg);
            f.appendChild(row);
            const sync = k.btn('row', 'Sync offsets on tiles', () => { act.sync(); k.render(); }, { aria: { role: 'switch', 'aria-checked': String(t.syncMode) } });
            sync.appendChild(k.sw(t.syncMode));
            f.appendChild(sync);
            f.appendChild(k.el('div', 'sep'));
            f.appendChild(k.btn('row', 'Leave compare', () => { k.close(false); act.leaveCompare(); }, { icon: ICONS.leave, value: `keep ${S.TILE_KEYS[0]}`, aria: { 'aria-label': `Leave compare, keep ${S.TILE_KEYS[0]}` } }));
          }
          return f;
        },
      },
      cmpVid: {
        label: () => { const r = compareRows(S, tab(), engine.getClip)[selTile]; return r ? `${r.letter}: ${r.name}` : 'Video'; },
        button: 'cmp', parent: 'cmp',
        render: (/** @type {any} */ _s, /** @type {any} */ k) => {
          const t = tab();
          const rows = compareRows(S, t, engine.getClip);
          const r = rows[Math.min(selTile, rows.length - 1)];
          const f = doc.createDocumentFragment();
          f.appendChild(k.head(`${r.letter} ${r.name}`, 'cmp'));
          f.appendChild(k.heading('Offset'));
          const top = k.el('div', 'speedTop');
          const minus = k.btn('big', null, () => { commit(S.nudgeOffset(ws, r.id, -1)); k.render(); }, { aria: { 'aria-label': `${r.letter} earlier` } });
          const plus = k.btn('big', null, () => { commit(S.nudgeOffset(ws, r.id, 1)); k.render(); }, { aria: { 'aria-label': `${r.letter} later` } });
          minus.textContent = '−';
          plus.textContent = '+';
          top.append(minus, k.el('div', 'readout off', r.offText), plus);
          f.appendChild(top);
          if (r.offset) f.appendChild(k.btn('link', 'Reset', () => { commit(S.nudgeOffset(ws, r.id, -r.offset), `${r.letter} in step`); k.render(); }, { aria: { 'aria-label': `Reset the offset of ${r.letter}` } }));
          f.appendChild(k.el('div', 'sep'));
          f.appendChild(k.btn('row', t.layout === 'spotlight' && t.spotlightId === r.id ? 'Back to grid' : 'Enlarge tile', () => { commit(S.toggleEnlarge(ws, r.id)); k.render(); }));
          f.appendChild(k.btn('row', 'Remove from compare', () => { k.show('cmp'); act.removeTile(r.id); }, { icon: ICONS.close }));
          return f;
        },
      },
    };

    controls = W.VpeControls.create({
      panel: need('panel'),
      sheet: need('sheet'),
      bar: barEl,
      onShow: () => { if (ctxMenu) ctxMenu.close(false); },
      buttons: { cog: cogBtn, info: infoBtn, rate: rateBtn, tracks: tracksBtn, cmp: cmpBtn, stepPrev: prevSize, stepNext: nextSize },
      views: cmpViews,
      get: () => {
        const t = tab();
        const isMulti = t.tiles.length >= 2;
        const sel = Math.min(infoSel, t.tiles.length - 1);
        return {
          compare: isMulti ? { soundLabel: `from ${S.TILE_KEYS[0]}` } : null,
          rate: prefs.rate,
          loop: prefs.onEnd === 'loop',
          autoplay: { mode: prefs.onEnd, label: W.VpeAutoplay.label(prefs.onEnd), next: !isMulti },
          jump: { arrow: 5, shift: 1, ctrl: 'frame' },
          stepButtons: 'frame',
          stepSize: prefs.stepSize,
          abLabel: abLabel(),
          picture: { mode: prefs.picMode, pct: Math.round(prefs.picZoom * 100), zoomed: prefs.picZoom !== 1 },
          tools: [
            isMulti
              ? { id: 'compare', label: 'Compare', note: `${t.tiles.length} videos`, on: true, keepOpen: true, run: () => controls.show('cmp', cmpBtn) }
              : { id: 'compare', label: t.capture ? 'Pause Compare capture' : 'Start Compare', key: 'Shift+D', on: t.capture, run: () => act.capture() },
            { id: 'rail', label: rail.isOpen() ? 'Close Folder Rail' : 'Open Folder Rail', on: rail.isOpen(), run: () => { rail.toggle(); render(); } },
          ],
          ab: {
            items: [
              { label: 'Set Range Start (A)', key: 'A', run: () => act.setA() },
              { label: 'Set Range End (B)', key: 'B', run: () => act.setB() },
              { label: 'Clear A–B Range', key: 'Backspace', run: () => act.clearAB() },
            ],
          },
          subsLabel: prefs.subKey === 'off' ? 'Off' : 'English (SRT)',
          audioLabel: prefs.audioId === 'a0' ? 'English (AAC 2.0)' : 'Director Commentary',
          hasSound: true,
          tracks: {
            on: prefs.subKey !== 'off',
            label: prefs.subKey === 'off' ? 'Off' : 'English (SRT)',
            subs: [
              { key: 'off', main: 'Off', checked: prefs.subKey === 'off' },
              { key: 'en', main: 'English (SRT)', sub: 'Sidecar', checked: prefs.subKey === 'en' },
            ],
            audio: [
              { id: 'a0', main: 'English (AAC 2.0)', checked: prefs.audioId === 'a0' },
              { id: 'a1', main: 'Director Commentary', checked: prefs.audioId === 'a1' },
            ],
            delay: 0,
            size: 100,
          },
          facts: facts(t.tiles[sel]),
          infoTabs: isMulti ? { keys: t.tiles.map((/** @type {string} */ _id, /** @type {number} */ i) => S.TILE_KEYS[i]), sel, pick: (/** @type {number} */ i) => { infoSel = i; } } : null,
          canExternal: false,
          canUseOriginal: false,
          transcode: {
            mode: prefs.transcodeMode, maxBitrateMbps: prefs.transcodeMaxBitrate, active: false,
            resolution: prefs.transcodeRes, defaultResolution: 0, sourceHeight: 2160,
          },
        };
      },
      act: {
        stepSize: (/** @type {string} */ v) => { prefs.stepSize = v; drawBar(); controls.refresh(); toast(`Step: ${W.VpeControls.stepName(v)}`); },
        loop: () => act.loop(),
        setAutoplay: (/** @type {string} */ m) => setOnEnd(m),
        cycleAB: () => markAB(null),
        copyFrame: () => act.copyFrame(),
        setRate: (/** @type {number} */ r) => setRate(r),
        pickRate: (/** @type {number} */ r) => setRate(r),
        stepRate: (/** @type {number} */ d) => setRate(prefs.rate + d * W.VpeControls.SPEED_STEP),
        setTranscode: (/** @type {string} */ m) => { prefs.transcodeMode = m; controls.refresh(); toast(`Live transcode: ${m}`); },
        setTranscodeMaxBitrate: (/** @type {number} */ r) => { prefs.transcodeMaxBitrate = r; controls.refresh(); },
        setTranscodeResolution: (/** @type {number} */ h) => { prefs.transcodeRes = h; controls.refresh(); },
        saveTranscodeResolution: (/** @type {number} */ h) => { prefs.transcodeRes = h; controls.refresh(); toast('Saved default resolution'); },
        setPicture: (/** @type {string} */ m) => setPicture(m),
        zoomPicture: (/** @type {number} */ d) => { prefs.picZoom = Math.max(0.5, Math.min(4, +(prefs.picZoom + d * 0.25).toFixed(2))); controls.refresh(); },
        resetPicture: () => { prefs.picZoom = 1; setPicture('fit'); },
        selectSub: (/** @type {string} */ k) => { prefs.subKey = k; drawBar(); controls.refresh(); toast(k === 'off' ? 'Subtitles off' : 'Subtitles: English'); },
        selectAudio: (/** @type {string} */ id) => { prefs.audioId = id; controls.refresh(); toast('Audio track switched'); },
        loadSubs: () => postHost({ type: 'loadSubs' }),
        subDelay: () => {},
        subSize: () => {},
        copyInfo: (/** @type {any} */ d) => { postHost({ type: 'copyText', text: [d.title, d.sub, ...d.rows.map((/** @type {string[]} */ [a, b]) => `${a}: ${b}`)].join('\n') }); toast('Details copied'); },
        copyLink: () => postHost({ type: 'copyLink' }),
        external: () => postHost({ type: 'external' }),
        extSettings: () => postHost({ type: 'openSettings' }),
        openUrl: () => postHost({ type: 'openUrl' }),
      },
    });

    // ---- the real right-click menu ----
    ctxMenu = W.VpeCtxMenu.create({
      menu: need('ctxmenu'),
      container: env.container || doc.body,
      getState: () => {
        const t = tab();
        return { ready: true, playing: t.playing, loop: prefs.onEnd === 'loop', abSet: ab.isSet(), file: true, compareOpen: t.tiles.length >= 2 };
      },
      beforeOpen: () => controls.closeAll(false),
      run: (/** @type {string} */ action) => {
        /** @type {Record<string, () => void>} */
        const MENU = {
          playPause: act.playPause, loop: act.loop, setA: act.setA, setB: act.setB, clearAB: act.clearAB,
          copyFrame: act.copyFrame, saveFrame: () => postHost({ type: 'saveFrame' }),
          copyTime: () => { const text = fmt(tab().frame); postHost({ type: 'copyText', text }); toast(`Copied ${text}`); },
          startCompare: act.capture, addToCompare: act.capture,
          keys: () => controls.openSheet(cogBtn), cog: () => controls.show('main', cogBtn),
        };
        if (MENU[action]) MENU[action]();
      },
    });
    listen(stageEl, 'contextmenu', (/** @type {MouseEvent} */ e) => { e.preventDefault(); ctxMenu.open(e.clientX, e.clientY); });

    // ---- actions (the bar, the keys, the menus and the panels all land here) ----
    function setRate(/** @type {number} */ r) {
      prefs.rate = W.VpeControls.clampRate(r);
      drawBar();
      controls.refresh();
    }
    function setPicture(/** @type {string} */ m) {
      prefs.picMode = m;
      drawBar();
      controls.refresh();
      toast(`Picture size: ${m}`);
    }
    function markAB(/** @type {'a' | 'b' | null} */ which) {
      const t = tab();
      const sec = t.frame / fps();
      if (which) ab.set(which, sec, t.frame, sec, false);
      else ab.cycle(sec, t.frame, sec, false);
      toast(ab.toast((/** @type {number} */ s) => fmt(Math.round(s * fps()))));
      controls.refresh();
      render();
    }
    const act = {
      playPause: () => { ws = S.togglePlay(ws); flashPlay(tab().playing); render(); },
      prevFrame: () => commit(S.stepFrame(ws, -1)),
      nextFrame: () => commit(S.stepFrame(ws, 1)),
      seek: (/** @type {number} */ f) => commit(S.seekFrame(ws, f)),
      mute: () => { prefs.muted = !prefs.muted; render(); },
      volume: (/** @type {number} */ v) => { prefs.volume = Math.max(0, Math.min(1, v)); prefs.muted = prefs.volume === 0; render(); },
      loop: () => { prefs.onEnd = W.VpeAutoplay.toggleLoop ? W.VpeAutoplay.toggleLoop(prefs.onEnd) : (prefs.onEnd === 'loop' ? 'off' : 'loop'); rail.refreshOnEnd(); controls.refresh(); toast(prefs.onEnd === 'loop' ? 'Loop on' : 'Loop off'); },
      setA: () => markAB('a'),
      setB: () => markAB('b'),
      clearAB: () => { ab.clear(); controls.refresh(); render(); toast('A–B range cleared'); },
      cycleTime: () => { prefs.timeMode = (prefs.timeMode + 1) % 3; render(); },
      cyclePicture: () => setPicture(PICTURE_MODES[(PICTURE_MODES.indexOf(/** @type {any} */ (prefs.picMode)) + 1) % PICTURE_MODES.length]),
      copyFrame: () => { postHost({ type: 'copyFrame' }); toast(tab().tiles.length > 1 ? 'View copied' : 'Frame copied'); },
      fullscreen: () => postHost({ type: 'fullscreen' }),
      info: () => controls.toggle('info', infoBtn),
      keys: () => controls.toggleSheet(),
      escape: () => {
        if (controls.anyOpen()) { controls.closeAll(true); return true; }
        if (ctxMenu.isOpen()) { ctxMenu.close(true); return true; }
        if (tab().layout === 'spotlight' && tab().spotlightId) { commit(S.toggleEnlarge(ws, tab().spotlightId)); return true; }
        return false;
      },
      capture: () => { const r = S.toggleCapture(ws); commit(r.state, r.toast); },
      split: () => commit(S.toggleSplit(ws)),
      sync: () => commit(S.toggleSyncMode(ws)),
      layout: (/** @type {string} */ m) => {
        const t = tab();
        if (m === 'split') { if (t.layout !== 'split') commit(S.toggleSplit(ws)); return; }
        if (m === 'spotlight') { if (t.layout !== 'spotlight') commit(S.toggleEnlarge(ws, t.spotlightId || t.tiles[0])); return; }
        if (t.layout === 'split') commit(S.toggleSplit(ws));
        else if (t.layout === 'spotlight' && t.spotlightId) commit(S.toggleEnlarge(ws, t.spotlightId));
      },
      enlarge: (/** @type {string} */ id) => commit(S.toggleEnlarge(ws, id)),
      removeTile: (/** @type {string} */ id) => { const r = S.removeTile(ws, id); commit(r.state, r.toast); },
      nudge: (/** @type {string} */ id, /** @type {number} */ d) => commit(S.nudgeOffset(ws, id, d)),
      leaveCompare: () => {
        let next = ws;
        let text = '';
        for (const id of tab().tiles.slice(1)) { const r = S.removeTile(next, id); next = r.state; text = r.toast || text; }
        commit(next, text);
      },
      pickVideo: () => postHost({ type: 'pickVideo', exclude: tab().tiles.slice() }),
      nextVideo: () => rail.go(1),
      prevVideo: () => rail.go(-1),
    };
    /** @type {Record<string, (...a: any[]) => any>} */
    const dispatchTable = act;

    // ---- the real #bar ----
    const click = (/** @type {any} */ el, /** @type {() => void} */ fn) => {
      if (el) listen(el, 'click', (/** @type {Event} */ e) => { e.stopPropagation(); fn(); });
    };
    click(cmpBtn, act.capture);
    click(splitBtn, act.split);
    click(syncBtn, act.sync);
    click(playBtn, act.playPause);
    click(prevBtn, act.prevFrame);
    click(nextBtn, act.nextFrame);
    click(prevSize, () => controls.toggle('step', prevSize));
    click(nextSize, () => controls.toggle('step', nextSize));
    click(muteBtn, act.mute);
    click(timeEl, act.cycleTime);
    click(setABtn, act.setA);
    click(setBBtn, act.setB);
    click(cogBtn, () => controls.toggle('main', cogBtn));
    click(infoBtn, act.info);
    click(rateBtn, () => controls.toggle('speed', rateBtn));
    click(tracksBtn, () => controls.toggle('subs', tracksBtn));
    click(picBtn, act.cyclePicture);
    click(fullBtn, act.fullscreen);
    if (volEl) listen(volEl, 'input', () => act.volume(Number(volEl.value)));
    listen(seekEl, 'input', () => act.seek(Number(seekEl.value)));
    if (capBanner) {
      const stopBtn = capBanner.querySelector('[data-act="pause"]') || $('capStopBtn');
      const pickBtn = capBanner.querySelector('[data-act="pick"]') || $('capPickBtn');
      click(stopBtn, act.capture);
      click(pickBtn, act.pickVideo);
    }
    // Dragging an A–B pin moves that end to the nearest frame (media/player.js does the same over the decoder).
    if (W.VpeAbLoop.bindPin && abA && abB) {
      for (const [which, pin] of /** @type {[('a'|'b'), any][]} */ ([['a', abA], ['b', abB]])) {
        W.VpeAbLoop.bindPin(pin, which, {
          rect: () => seekEl.getBoundingClientRect(),
          n: () => tab().maxFrame + 1,
          fps,
          dur: () => tab().maxFrame / fps(),
          move: (/** @type {string} */ _w, /** @type {{ f: number }} */ snap) => { pin.style.left = `${tab().maxFrame ? snap.f / tab().maxFrame * 100 : 0}%`; },
          commit: (/** @type {'a'|'b'} */ w, /** @type {{ f: number, t: number }} */ snap) => { ab.reset(w, snap.t, snap.f, snap.t, false); controls.refresh(); },
          end: () => render(),
        });
      }
    }

    // ---- Spotlight splitter and Split Wipe divider drags ----
    const drag = (/** @type {any} */ el, /** @type {(ev: PointerEvent, rect: DOMRect) => void} */ onMove) => {
      if (!el) return;
      listen(el, 'pointerdown', (/** @type {PointerEvent} */ e) => {
        e.preventDefault();
        el.classList.add('dragging');
        const rect = stageEl.getBoundingClientRect();
        const move = (/** @type {PointerEvent} */ ev) => onMove(ev, rect);
        const up = () => { el.classList.remove('dragging'); win.removeEventListener('pointermove', move); win.removeEventListener('pointerup', up); };
        win.addEventListener('pointermove', move);
        win.addEventListener('pointerup', up);
      });
    };
    drag(splitterEl, (ev, rect) => commit(S.setHeroRatio(ws, (ev.clientY - rect.top) / rect.height)));
    drag(dividerEl, (ev, rect) => commit(S.setSplitRatio(ws, (ev.clientX - rect.left) / rect.width)));

    // ---- keyboard shortcuts ----
    listen(env.keyTarget || doc, 'keydown', (/** @type {KeyboardEvent} */ e) => {
      const t = /** @type {any} */ (e.target);
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      const a = keyAction(e);
      if (!a || !dispatchTable[a]) return;
      const handled = dispatchTable[a]();
      if (a === 'escape' && handled === false) return;
      e.preventDefault();
    });

    // ---- the stage: one cell per tile, from deriveUi ----
    function renderCells(/** @type {any} */ t, /** @type {any} */ ui) {
      stageEl.classList.toggle('sync-mode', t.syncMode && ui.isMulti);
      cellsEl.textContent = '';
      for (const r of ui.cells) {
        const cell = doc.createElement('div');
        cell.className = `cell${r.role.startsWith('split') ? ' split' : ''}`;
        cell.dataset.clip = r.clipId;
        cell.dataset.role = r.role;
        Object.assign(cell.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });
        if (r.role === 'split-b') cell.style.background = 'transparent';
        const cv = doc.createElement('canvas');
        cell.appendChild(cv);
        if (ui.isMulti && ui.effectiveLayout !== 'split') cell.appendChild(Object.assign(doc.createElement('div'), { className: 'cell-border' }));
        cell.addEventListener('click', (e) => {
          if (/** @type {any} */ (e.target).closest('button')) return;
          if (controls.anyOpen() || ctxMenu.isOpen()) { controls.closeAll(false); ctxMenu.close(false); return; }
          act.playPause();
        });
        cell.addEventListener('dblclick', (e) => {
          if (!ui.isMulti || ui.effectiveLayout === 'split' || /** @type {any} */ (e.target).closest('button')) return;
          act.enlarge(r.clipId);
        });
        if (ui.isMulti) {
          const ov = doc.createElement('div');
          ov.className = 'ov';
          const isHero = r.role === 'hero';
          const off = t.offsets[r.clipId] || 0;
          ov.innerHTML =
            `<div class="${r.role === 'split-b' ? 'pill right' : 'pill'}"><span class="ltr">${r.letter}</span><span class="nm">${esc(clipName(r.clipId))}</span><span class="fr">#${t.frame + off}</span></div>`
            + (ui.effectiveLayout !== 'split'
              ? `<div class="tile-top-acts"><button type="button" class="tbtn" data-enlarge title="${isHero ? 'Back to grid' : 'Enlarge tile'}" aria-label="${isHero ? 'Back to grid' : 'Enlarge tile'} ${r.letter}">${isHero ? ICONS.collapse : ICONS.expand}</button>`
                + `<button type="button" class="tbtn rm" data-rm title="Remove from compare" aria-label="Remove ${r.letter} from compare">${ICONS.close}</button></div>`
              : '')
            + `<div class="sync-pill"><button type="button" data-d="-1" aria-label="${r.letter} earlier">−</button><span>${off >= 0 ? '+' : ''}${off}f</span><button type="button" data-d="1" aria-label="${r.letter} later">+</button></div>`;
          const on = (/** @type {string} */ sel, /** @type {(b: any) => void} */ fn) => ov.querySelectorAll(sel).forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); fn(b); }));
          on('[data-enlarge]', () => act.enlarge(r.clipId));
          on('[data-rm]', () => act.removeTile(r.clipId));
          on('[data-d]', (b) => act.nudge(r.clipId, Number(b.dataset.d)));
          cell.appendChild(ov);
        }
        cellsEl.appendChild(cell);
        engine.draw(cv, r.clipId, t.frame + (t.offsets[r.clipId] || 0), { splitClipRatio: r.role === 'split-b' ? t.split : null });
      }
      if (ui.addSlot) {
        const slot = doc.createElement('div');
        slot.className = 'cell add';
        Object.assign(slot.style, { left: `${ui.addSlot.x}px`, top: `${ui.addSlot.y}px`, width: `${ui.addSlot.w}px`, height: `${ui.addSlot.h}px` });
        slot.innerHTML = '<button type="button" class="addcell">+ Add video</button>';
        const b = slot.querySelector('button');
        if (b) b.addEventListener('click', (e) => { e.stopPropagation(); act.pickVideo(); });
        cellsEl.appendChild(slot);
      }
    }

    /** The bar's own state (prefs-driven parts that do not need the stage size). */
    function drawBar() {
      const t = tab();
      if (rateBtn) rateBtn.textContent = W.VpeControls.speedText ? W.VpeControls.speedText(prefs.rate) : `${prefs.rate}×`;
      if (picBtn) picBtn.dataset.mode = prefs.picMode;
      if (tracksBtn) tracksBtn.classList.toggle('on', prefs.subKey !== 'off');
      if (muteBtn) { muteBtn.classList.toggle('muted', prefs.muted); muteBtn.setAttribute('aria-pressed', String(prefs.muted)); }
      if (volEl) volEl.value = String(prefs.muted ? 0 : prefs.volume);
      if (prevSize && nextSize) W.VpeControls.drawStepBadges([prevSize, nextSize], prefs.stepSize);
      if (setABtn && setBBtn) W.VpeControls.drawRangeButtons(setABtn, setBBtn, ab);
      if (abMarks && abA && abB) W.VpeControls.drawRangeMarks(abMarks, abA, abB, ab.marks(t.maxFrame / fps()));
    }

    /** The folder capsule is a single-video control: hidden in Compare whatever the host's pos answer said. */
    function syncCapsule(/** @type {boolean} */ isMulti) {
      const folderCap = $('folderCap');
      if (folderCap && isMulti) folderCap.hidden = true;
    }

    function render() {
      if (disposed) return;
      const t = tab();
      const width = stageEl.clientWidth || 680;
      const height = stageEl.clientHeight || 370;
      const ui = S.deriveUi(t, { width, height });

      renderCells(t, ui);
      if (splitterEl) { splitterEl.hidden = !ui.showSplitter; if (ui.showSplitter) splitterEl.style.top = `${Math.round(height * t.heroRatio)}px`; }
      if (dividerEl) { dividerEl.hidden = !ui.showDivider; if (ui.showDivider) dividerEl.style.left = `${Math.round(width * t.split)}px`; }
      if (capBanner) capBanner.hidden = !ui.showCaptureBanner;

      if (tracksBtn) tracksBtn.hidden = !ui.showCC;
      splitBtn.hidden = !ui.showSplitBtn;
      splitBtn.classList.toggle('active', ui.effectiveLayout === 'split');
      splitBtn.setAttribute('aria-pressed', String(ui.effectiveLayout === 'split'));
      syncBtn.hidden = !ui.showSyncBtn;
      syncBtn.classList.toggle('active', t.syncMode);
      syncBtn.setAttribute('aria-pressed', String(t.syncMode));
      cmpBtn.classList.toggle('cap-on', t.capture);
      cmpBtn.title = ui.captureTitle;
      cmpBtn.setAttribute('aria-pressed', String(t.capture));
      cmpBtn.innerHTML = t.capture
        ? `<span class="cap-pulse"></span><span>${esc(ui.captureLabel)}</span>`
        : `${ICONS.compare}<span>${esc(ui.captureLabel)}</span>`;

      seekEl.max = String(t.maxFrame);
      seekEl.value = String(t.frame);
      if (nowEl) nowEl.textContent = fmt(t.frame);
      if (durEl) durEl.textContent = `/ ${fmt(t.maxFrame)}`;
      playBtn.classList.toggle('playing', t.playing);
      drawBar();

      // The host learns about every change of this tab's videos (rail members, folder position).
      const key = tilesKey(S, t);
      if (key !== lastTilesKey) {
        lastTilesKey = key;
        postHost({ type: 'tiles', tabId: t.id, tiles: t.tiles.slice(), current: t.tiles[0] });
      }
      syncCapsule(ui.isMulti);
      if (controls && controls.view && (controls.view() === 'cmp' || controls.view() === 'cmpVid') && !ui.isMulti) controls.close(false);
      if (env.onChange) env.onChange(ws, ui);
    }

    // ---- playback clock: the fake engine has no decoder clock, so the page advances the frame ----
    const tickMs = env.tickMs === undefined ? 42 : env.tickMs;
    if (tickMs > 0) {
      const timer = win.setInterval(() => {
        const t = tab();
        if (!t.playing) return;
        if (t.frame >= t.maxFrame && prefs.onEnd !== 'loop') { commit(S.togglePlay(S.seekFrame(ws, t.maxFrame))); return; }
        commit(S.seekFrame(ws, t.frame >= t.maxFrame ? 0 : t.frame + 1));
      }, tickMs);
      cleanups.push(() => win.clearInterval(timer));
    }
    if (typeof win.ResizeObserver === 'function') {
      const ro = new win.ResizeObserver(() => render());
      ro.observe(stageEl);
      cleanups.push(() => ro.disconnect());
    }
    listen(win, 'resize', render);

    // ---- host -> page ----
    function onHostMessage(/** @type {any} */ msg) {
      if (!msg || disposed) return;
      if (msg.type === 'rail') { rail.onMessage(msg); syncCapsule(tab().tiles.length >= 2); return; }
      if (msg.type === 'toast') { toast(String(msg.text || '')); return; }
      const r = applyHostMessage(S, ws, msg, engine.getClip);
      if (r.handled) commit(r.state, r.toast);
    }

    return {
      render,
      onHostMessage,
      /** Run one action by name (the same table the keys, bar and menus use). */
      dispatch: (/** @type {string} */ name, /** @type {any[]} */ ...args) => {
        if (!dispatchTable[name]) throw new Error(`player-ui: unknown action ${name}`);
        return dispatchTable[name](...args);
      },
      actions: () => Object.keys(dispatchTable),
      getState: () => ws,
      setState: (/** @type {any} */ next) => { ws = next; ab.clear(); render(); },
      getPrefs: () => ({ ...prefs }),
      rail,
      controls,
      ctxMenu,
      ab,
      dispose: () => { disposed = true; for (const c of cleanups.splice(0)) c(); },
    };
  }

  const api = { HOST_COMMANDS, PICTURE_MODES, defaultPrefs, keyAction, formatTime, applyHostMessage, compareRows, create };
  // checkJs: end

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else /** @type {any} */ (globalThis).VpePlayerUi = api;
})();
