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
//                        { type: 'removeVideo', clipId }  a rail click on a video already in this Compare
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
   * @property {(canvas: HTMLCanvasElement, clipId: string, frame: number, opts?: { width?: number, height?: number, splitClipRatio?: number | null }) => void} draw
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
   * The keyboard shortcuts of the single player (media/player.js), Compare (media/compare.js) and create(), as one
   * table. Each page maps the action names it supports to its own functions (runKey); a name a page lacks, or a
   * handler that returns false, is "not handled" and the key goes on to VS Code. Ctrl / Cmd / Alt keys are not player
   * keys, except with AltGr (Ctrl+Alt on Windows), which types [ ] { } # on many layouts.
   * @param {{ key: string, shiftKey?: boolean, ctrlKey?: boolean, metaKey?: boolean, altKey?: boolean }} e
   * @param {{ altGr?: boolean }} [o]
   * @returns {{ action: string, arg?: any } | null}
   */
  function keyCommand(e, o = {}) {
    if (e.metaKey || (!o.altGr && (e.ctrlKey || e.altKey))) return null;
    const a = (/** @type {string} */ action, /** @type {any} */ arg) => (arg === undefined ? { action } : { action, arg });
    const shift = !!e.shiftKey;
    switch (e.key) {
      case ' ': case 'k': case 'K': return a('playPause');
      case 'j': case 'J': return a('skip', -10);
      case 'l': case 'L': return a('skip', 10);
      case 'ArrowLeft': return a('jump', { dir: -1, shift });
      case 'ArrowRight': return a('jump', { dir: 1, shift });
      case ',': return a('prevFrame');
      case '.': return a('nextFrame');
      case '<': case '[': return a('rateStep', -1);
      case '>': case ']': return a('rateStep', 1);
      case 'ArrowUp': return a('volumeStep', 0.05);
      case 'ArrowDown': return a('volumeStep', -0.05);
      case 'Home': return a('home');
      case 'End': return a('end');
      case 'm': case 'M': return a('mute');
      case 'r': case 'R': return a('loop');
      case 'f': case 'F': return a('fullscreen');
      case 'N': return shift ? a('nextVideo') : null;
      case 'P': return shift ? a('prevVideo') : null;
      case 'a': case 'A': return a('setA');
      case 'b': case 'B': return a('setB');
      case 'Backspace': return a('clearAB');
      case 't': case 'T': return a('copyTime');
      case 'z': case 'Z': return shift ? null : a('cyclePicture');
      case '+': case '=': return a('plus');
      case '-': case '_': return a('minus');
      case 'i': case 'I': return a('info');
      case 's': case 'S': return a('saveFrame');
      case 'c': case 'C': return a('cc');
      case 'w': case 'W': return a('scopes');
      case 'x': case 'X': return a('swap');
      case 'd': return a('pickVideo');
      case 'D': return a(shift ? 'capture' : 'pickVideo');
      case '?': return a('keys');
      case 'Escape': return a('escape');
      default: return /^[0-9]$/.test(e.key) ? a('seekTenth', Number(e.key)) : null;
    }
  }

  /**
   * The action name a key runs (keyCommand without its argument).
   * @param {{ key: string, shiftKey?: boolean, ctrlKey?: boolean, metaKey?: boolean, altKey?: boolean }} e
   * @returns {string | null}
   */
  function keyAction(e) {
    const c = keyCommand(e);
    return c ? c.action : null;
  }

  /**
   * Run one keydown through keyCommand and a page's action table; a handler gets (arg, event).
   * @param {any} e KeyboardEvent
   * @param {Record<string, (arg: any, e: any) => any>} table
   * @param {{ altGr?: boolean }} [o]
   * @returns {boolean} whether the page used the key (the caller then calls preventDefault)
   */
  function runKey(e, table, o) {
    const c = keyCommand(e, o);
    if (!c || typeof table[c.action] !== 'function') return false;
    return table[c.action](c.arg, e) !== false;
  }

  /**
   * What D ("pick another video") asks of the host, per surface:
   *   'player'  production single player: { type: 'comparePick', t } (a quick pick; Compare then takes the tab)
   *   'compare' production Compare: null (plain D has no handler; Compare › Add video posts startAddMode)
   *   'unified' create() proposal, any N: { type: 'pickVideo', exclude } (the host answers with openVideo)
   * @param {'player' | 'compare' | 'unified'} surface
   * @param {{ t?: number, exclude?: string[] }} [ctx]
   * @returns {{ type: string, t?: number, exclude?: string[] } | null}
   */
  function pickVideoMessage(surface, ctx = {}) {
    if (surface === 'player') return { type: 'comparePick', t: ctx.t === undefined ? 0 : ctx.t };
    if (surface === 'unified') return { type: 'pickVideo', exclude: (ctx.exclude || []).slice() };
    return null;
  }

  /** What a click on the bar's time shows next: clock, SMPTE timecode, frame number (the toast says which). */
  const TIME_MODE_NAMES = /** @type {const} */ (['Time', 'Timecode', 'Frame number']);
  const nextTimeMode = (/** @type {number} */ m) => ((Number(m) || 0) + 1) % 3;

  /**
   * The bar's time readout (#now, #dur) in the user's time format; the same in the player, Compare and the mockup.
   * @param {{ f: number, t: number, dur: number, fps: number, nFrames: number, mode: number, live?: boolean,
   *   fmtClock: (s: number) => string, fmtTimecode: (f: number, fps: number) => string }} o
   * @returns {{ now: string, dur: string }}
   */
  function timeReadout(o) {
    if (o.live) return { now: o.fmtClock(o.t), dur: '· LIVE' };
    if (o.mode === 1 && o.fps) return { now: o.fmtTimecode(o.f, o.fps), dur: `/ ${o.fmtTimecode(o.nFrames, o.fps)}` };
    if (o.mode === 2) return { now: `frame ${o.f + 1}`, dur: `/ ${o.nFrames || '?'}` };
    return { now: o.fmtClock(o.t), dur: `/ ${o.fmtClock(o.dur)}` };
  }

  /**
   * One time as text (A–B labels, Copy time): clock (m:ss.ss), SMPTE timecode, or frame number.
   * @param {number} frame
   * @param {number} fps
   * @param {number} mode 0 | 1 | 2
   * @param {((f: number, fps: number) => string) | null} [fmtTimecode] media/timefmt.js fmtTimecode
   */
  function formatTime(frame, fps, mode, fmtTimecode) {
    const r = fps || 24;
    if (mode === 2) return `frame ${frame + 1}`;
    if (mode === 1 && fmtTimecode) return fmtTimecode(frame, r);
    const t = frame / r;
    const m = Math.floor(t / 60);
    return `${m}:${(t % 60).toFixed(2).padStart(5, '0')}`;
  }

  /**
   * Wire bar buttons. Each entry is [element, run, stop]; `stop` keeps the click from reaching the stage or the bar
   * (whose own click handlers play / pause or dismiss panels). The pages use the `onclick` property (a page can swap
   * one handler later, and Node tests call onclick()); create() passes `on` so dispose() can remove its listeners.
   * @param {[any, () => void, boolean?][]} entries
   * @param {(el: any, fn: (e?: any) => void) => void} [on]
   */
  function bindButtons(entries, on) {
    for (const [el, run, stop] of entries) {
      if (!el) continue;
      const fn = stop ? (/** @type {any} */ e) => { if (e && e.stopPropagation) e.stopPropagation(); run(); } : () => run();
      if (on) on(el, fn); else el.onclick = fn;
    }
  }

  /**
   * The buttons beside Play: the size picked with their badge, else one frame or the Ctrl+arrow jump (setting
   * stepButtons). Frames go to `step`, seconds to `skip`.
   * @param {any} VpeControls media/controls.js
   * @param {any} prefs { stepSize, stepButtons, jump }
   * @param {number} dir -1 | 1
   * @param {{ step: (frames: number) => void, skip: (seconds: number) => void }} go
   */
  function stepBy(VpeControls, prefs, dir, go) {
    const a = VpeControls.stepAmount(VpeControls.stepSizeOf(prefs));
    if (a.n) go.step(dir * a.n); else go.skip(dir * a.s);
  }

  /**
   * The badge on a step button opens the size popover above it; the click never reaches the step button or the bar.
   * @param {any[]} badges [#prevSize, #nextSize]
   * @param {(badge: any) => void} open
   * @param {(el: any, type: string, fn: (e: any) => void) => void} [listen]
   */
  function bindStepBadges(badges, open, listen) {
    for (const b of badges) {
      if (!b) continue;
      const fn = (/** @type {any} */ e) => { e.stopPropagation(); open(b); };
      if (listen) listen(b, 'click', fn); else b.addEventListener('click', fn);
    }
  }

  /**
   * Where an A–B pin sits on the seek bar for a snapped frame (percent of the bar).
   * @param {{ f: number, t: number }} snap @param {number} n frames @param {number} dur seconds
   */
  const pinPercent = (snap, n, dur) => (n > 1 ? snap.f / (n - 1) * 100 : dur ? snap.t / dur * 100 : 0);

  /**
   * Dragging an A–B pin on the seek bar moves that end to the nearest frame; the playhead stays. The tip above the
   * bar says which end and where. `src.commit` stores the end (each page's own A–B bookkeeping).
   * @param {any} VpeAbLoop media/abloop.js
   * @param {{ a: any, b: any, seek: any, tip?: any }} els
   * @param {{ ready: () => boolean, n: () => number, fps: () => number, dur: () => number,
   *   tipLabel: (snap: { f: number, t: number }) => string,
   *   commit: (which: 'a' | 'b', snap: { f: number, t: number }) => void, end: () => void }} src
   */
  function bindAbPins(VpeAbLoop, els, src) {
    for (const which of /** @type {('a' | 'b')[]} */ (['a', 'b'])) {
      const pin = els[which];
      if (!pin) continue;
      VpeAbLoop.bindPin(pin, which, {
        rect: () => els.seek.getBoundingClientRect(),
        n: () => (src.ready() ? src.n() : 0),
        fps: () => (src.ready() ? src.fps() : 0),
        dur: () => (src.ready() ? src.dur() : 0),
        move(/** @type {string} */ w, /** @type {{ f: number, t: number }} */ snap, /** @type {number} */ clientX) {
          if (!src.ready()) return;
          const n = src.n();
          pin.style.left = `${pinPercent(snap, n, src.dur())}%`;
          if (!els.tip) return;
          const r = els.seek.getBoundingClientRect();
          els.tip.textContent = `${w.toUpperCase()} ${src.tipLabel(snap)}${n ? ` · #${snap.f + 1}` : ''}`;
          els.tip.style.left = `${Math.max(30, Math.min(r.width - 30, clientX - r.left))}px`;
          els.tip.hidden = false;
        },
        commit(/** @type {'a' | 'b'} */ w, /** @type {{ f: number, t: number }} */ snap) {
          if (src.ready()) src.commit(w, snap);
        },
        end: () => src.end(),
      });
    }
  }

  /**
   * The Picture size button shows the current size and names the next one (VpePicture: media/picture.js).
   * @param {any} btn #picBtn
   * @param {any} VpePicture
   * @param {string} mode
   * @param {string} [scope] e.g. 'all videos' in Compare
   */
  function pictureButton(btn, VpePicture, mode, scope) {
    if (!btn) return;
    const nx = VpePicture.next(mode);
    btn.dataset.mode = mode;
    btn.title = `Picture size: ${VpePicture.name(mode)} (${VpePicture.WORDS[mode]})${scope ? `, ${scope}` : ''}. Click for ${VpePicture.name(nx)}  Z`;
    btn.setAttribute('aria-label', `Picture size: ${VpePicture.name(mode)}. Next: ${VpePicture.name(nx)}`);
  }

  /** ⓘ › Copy details: the facts as plain lines. @param {{ title: string, sub: string, rows: string[][] }} d */
  const copyInfoText = (d) => [d.title, d.sub, ...d.rows.map(([k, v]) => `${k}: ${v}`)].join('\n');

  /**
   * The right-click menu (media/ctxmenu.js): its items run through the page's own named actions.
   * @param {any} VpeCtxMenu
   * @param {{ menu: any, container?: any, getState: () => any, beforeOpen?: () => void, actions: Record<string, () => void> }} o
   */
  function createContextMenu(VpeCtxMenu, o) {
    /** @type {any} */
    const env = { menu: o.menu, getState: o.getState, beforeOpen: o.beforeOpen, run: (/** @type {string} */ a) => { if (o.actions[a]) o.actions[a](); } };
    if (o.container) env.container = o.container;
    return VpeCtxMenu.create(env);
  }

  /**
   * The Folder Rail (media/folder-rail.js) when the page has its markup (#rail) and the script; else null (URLs,
   * image sequences). Its own `rail` / `neighbour` messages go straight to `post`.
   * @param {any} VpeFolderRail
   * @param {any} doc
   * @param {any} opts VpeFolderRail.create options (doc is filled in)
   */
  function createFolderRail(VpeFolderRail, doc, opts) {
    if (!VpeFolderRail || !doc.getElementById('rail')) return null;
    return VpeFolderRail.create({ doc, ...opts });
  }

  /**
   * Shift+N / Shift+P and the folder capsule: the folder's next / previous video (through the rail when there is
   * one, else straight to the host).
   * @param {any} rail @param {(m: any) => void} post @param {number} d
   */
  function goNeighbour(rail, post, d) {
    if (rail) rail.go(d); else post({ type: 'neighbour', d });
  }

  /**
   * Spotlight splitter: the main tile's share for a pointer at (px, py) in a stage of w x h, by the dock edge.
   * @param {string} dock 'top' | 'bottom' | 'left' | 'right'
   * @param {number} px @param {number} py @param {number} w @param {number} h
   */
  function spotlightRatioAt(dock, px, py, w, h) {
    if (dock === 'top') return py / h;
    if (dock === 'bottom') return 1 - py / h;
    if (dock === 'left') return px / w;
    return 1 - px / w;
  }

  /**
   * Spotlight splitter keys: arrows along the dock (Shift: 10 %), Home / End; null for any other key.
   * @param {{ key: string, shiftKey?: boolean }} e @param {string} dock @param {number} ratio
   * @param {number} min @param {number} max
   * @returns {number | null}
   */
  function spotlightKeyRatio(e, dock, ratio, min, max) {
    const delta = e.shiftKey ? 0.10 : 0.05;
    const horiz = dock === 'top' || dock === 'bottom';
    if (horiz && e.key === 'ArrowDown') return ratio + (dock === 'top' ? delta : -delta);
    if (horiz && e.key === 'ArrowUp') return ratio + (dock === 'top' ? -delta : delta);
    if (!horiz && e.key === 'ArrowRight') return ratio + (dock === 'left' ? delta : -delta);
    if (!horiz && e.key === 'ArrowLeft') return ratio + (dock === 'left' ? -delta : delta);
    if (e.key === 'Home') return min;
    if (e.key === 'End') return max;
    return null;
  }

  /**
   * Split Wipe divider keys: arrows 1 % (Shift / PageUp / PageDown 10 %), Home / End; null for any other key.
   * @param {{ key: string, shiftKey?: boolean }} e @param {number} split
   * @returns {number | null}
   */
  function splitKeyRatio(e, split) {
    const big = e.shiftKey || e.key === 'PageUp' || e.key === 'PageDown' ? 0.1 : 0.01;
    switch (e.key) {
      case 'ArrowLeft': case 'ArrowDown': case 'PageDown': return split - big;
      case 'ArrowRight': case 'ArrowUp': case 'PageUp': return split + big;
      case 'Home': return 0;
      case 'End': return 1;
      default: return null;
    }
  }

  /**
   * Split Wipe: the divider's share for a pointer at clientX, over the picture as it is shown. `pic` is the displayed
   * picture rect in stage coordinates (letterboxing, Picture size): the divider tracks the picture, not the stage.
   * @param {number} clientX @param {{ left: number }} stageRect @param {{ x: number, w: number } | null} pic
   * @returns {number | null} 0..1, or null without a picture
   */
  function splitRatioAt(clientX, stageRect, pic) {
    if (!pic || !(pic.w > 0)) return null;
    return Math.max(0, Math.min(1, (clientX - stageRect.left - pic.x) / pic.w));
  }

  /**
   * The Split Wipe divider, end to end: a primary-button drag with pointer capture over the displayed picture
   * (splitRatioAt), the keys (splitKeyRatio: arrows 1 %, Shift / PageUp / PageDown 10 %, Home 0 %, End 100 %), and
   * no click through to the stage (which would play / pause). media/compare.js and create() both bind it here.
   * @param {any} el the divider (role="slider")
   * @param {{ stageRect: () => { left: number }, pictureRect: () => ({ x: number, w: number } | null),
   *   get: () => number, set: (ratio: number) => void, onDragEnd?: (moved: boolean) => void,
   *   listen?: (el: any, type: string, fn: (e: any) => void) => void }} o
   */
  function bindSplitDivider(el, o) {
    if (!el) return;
    const on = o.listen || ((/** @type {any} */ t, /** @type {string} */ type, /** @type {(e: any) => void} */ fn) => t.addEventListener(type, fn));
    /** @type {{ id: number, moved: boolean } | null} */
    let drag = null;
    const at = (/** @type {any} */ e) => { const r = splitRatioAt(e.clientX, o.stageRect(), o.pictureRect()); if (r !== null) o.set(r); };
    on(el, 'pointerdown', (/** @type {any} */ e) => {
      if (e.button !== 0 || drag) return;
      e.preventDefault();
      e.stopPropagation();
      drag = { id: e.pointerId, moved: false };
      try { el.setPointerCapture(e.pointerId); } catch { /* synthetic pointer (test hook) */ }
    });
    on(el, 'pointermove', (/** @type {any} */ e) => {
      if (!drag || e.pointerId !== drag.id) return;
      drag.moved = true;
      at(e);
    });
    const end = (/** @type {any} */ e) => {
      if (!drag || (e && e.pointerId !== undefined && e.pointerId !== drag.id)) return;
      const moved = drag.moved;
      drag = null;
      if (o.onDragEnd) o.onDragEnd(moved);
    };
    on(el, 'pointerup', end);
    on(el, 'pointercancel', end);
    on(el, 'click', (/** @type {any} */ e) => e.stopPropagation());
    on(el, 'keydown', (/** @type {any} */ e) => {
      const next = splitKeyRatio(e, o.get());
      if (next === null) return;
      o.set(Math.max(0, Math.min(1, next)));
      e.preventDefault();
      e.stopPropagation();
    });
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
    // A rail click on a video that is already in this Compare takes it out again (src/compare.js railAdd).
    if (msg && msg.type === 'removeVideo' && typeof msg.clipId === 'string') {
      const r = S.removeTile(ws, msg.clipId);
      return { state: r.state, toast: r.state === ws ? '' : (r.toast || 'Removed from Compare'), handled: true };
    }
    if (!msg || msg.type !== 'openVideo' || typeof msg.clipId !== 'string') return { state: ws, toast: '', handled: false };
    const label = msg.label || (getClip(msg.clipId) || { name: msg.clipId }).name;
    if (msg.replace) {
      const tab = S.getTab(ws);
      if (tab.tiles.length === 1 && !tab.capture) return { state: S.replaceVideo(ws, msg.clipId), toast: '', handled: true };
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
   *   widgets?: { VpeControls?: any, VpeFolderRail?: any, VpeCtxMenu?: any, VpeAbLoop?: any, VpeAutoplay?: any, VpeTime?: any, VpePicture?: any, VpeModes?: any },
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
    const W = /** @type {any} */ ({ ...{ VpeControls: win.VpeControls, VpeFolderRail: win.VpeFolderRail, VpeCtxMenu: win.VpeCtxMenu, VpeAbLoop: win.VpeAbLoop, VpeAutoplay: win.VpeAutoplay, VpeTime: win.VpeTime, VpePicture: win.VpePicture, VpeModes: win.VpeModes }, ...(env.widgets || {}) });
    for (const k of ['VpeControls', 'VpeFolderRail', 'VpeCtxMenu', 'VpeAbLoop', 'VpeAutoplay']) {
      if (!W[k]) throw new Error(`player-ui: widget ${k} is missing`);
    }
    const $ = (/** @type {string} */ id) => /** @type {any} */ (doc.getElementById(id));
    const need = (/** @type {string} */ id) => { const x = $(id); if (!x) throw new Error(`player-ui: #${id} is missing`); return x; };

    // ---- DOM: the real #bar (src/bar.js) and the stage ----
    const stageEl = need('stage'), barEl = need('bar');
    const cellsEl = $('cells') || stageEl.appendChild(Object.assign(doc.createElement('div'), { id: 'cells' }));
    const capBanner = $('capBanner'), splitterEl = $('splitter'), dividerEl = $('divider');
    const seekEl = need('seek'), nowEl = $('now'), durEl = $('dur'), timeEl = $('time'), tipEl = $('tip');
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
    const clockText = (/** @type {number} */ sec) => formatTime(Math.round(sec * fps()), fps(), 0);
    /** The arrow keys' jump sizes (settings videoPreviewEnhanced.jump.*): seconds, or 'frame'. */
    const JUMP = { arrow: 5, shift: 1, ctrl: 'frame' };
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
    const rail = createFolderRail(W.VpeFolderRail, doc, {
      toast,
      post: (/** @type {any} */ m) => postHost(m),
      cfg: env.railCfg || { layout: 'dock', width: 200, column: 'duration', playable: true },
      getOnEnd: () => prefs.onEnd,
      setOnEnd,
      label: W.VpeAutoplay.label,
      time: () => tab().frame / fps(),
    });
    if (!rail) throw new Error('player-ui: #rail is missing');

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
          jump: JUMP,
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
        copyInfo: (/** @type {any} */ d) => { postHost({ type: 'copyText', text: copyInfoText(d) }); toast('Details copied'); },
        copyLink: () => postHost({ type: 'copyLink' }),
        external: () => postHost({ type: 'external' }),
        extSettings: () => postHost({ type: 'openSettings' }),
        openUrl: () => postHost({ type: 'openUrl' }),
      },
    });

    // ---- the real right-click menu ----
    ctxMenu = createContextMenu(W.VpeCtxMenu, {
      menu: need('ctxmenu'),
      container: env.container || doc.body,
      getState: () => {
        const t = tab();
        return { ready: true, playing: t.playing, loop: prefs.onEnd === 'loop', abSet: ab.isSet(), file: true, compareOpen: t.tiles.length >= 2 };
      },
      beforeOpen: () => controls.closeAll(false),
      actions: {
        playPause: () => act.playPause(), loop: () => act.loop(), setA: () => act.setA(), setB: () => act.setB(),
        clearAB: () => act.clearAB(), copyFrame: () => act.copyFrame(), saveFrame: () => act.saveFrame(),
        copyTime: () => act.copyTime(), startCompare: () => act.capture(), addToCompare: () => act.capture(),
        keys: () => controls.openSheet(cogBtn), cog: () => controls.show('main', cogBtn),
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
    /** A jump of the arrow keys: seconds, or 'frame' (one frame, paused). */
    const jumpBy = (/** @type {number | string} */ v, /** @type {number} */ dir) => (v === 'frame' ? commit(S.stepFrame(ws, dir)) : act.skip(dir * Number(v)));
    const act = {
      playPause: () => { ws = S.togglePlay(ws); flashPlay(tab().playing); render(); },
      skip: (/** @type {number} */ sec) => commit(S.seekFrame(ws, tab().frame + Math.round(sec * fps()))),
      jump: (/** @type {{ dir: number, shift?: boolean }} */ o) => jumpBy(o.shift ? JUMP.shift : JUMP.arrow, o.dir),
      stepButton: (/** @type {number} */ dir) => stepBy(W.VpeControls, prefs, dir, { step: (n) => commit(S.stepFrame(ws, n)), skip: (sec) => act.skip(sec) }),
      home: () => commit(S.seekFrame(ws, 0)),
      end: () => { const t = tab(); commit(S.seekFrame(t.playing ? S.togglePlay(ws) : ws, t.maxFrame)); },
      seekTenth: (/** @type {number} */ n) => commit(S.seekFrame(ws, (n / 10) * tab().maxFrame)),
      rateStep: (/** @type {number} */ d) => { setRate(prefs.rate + d * W.VpeControls.SPEED_STEP); toast(W.VpeControls.speedText ? W.VpeControls.speedText(prefs.rate) : `${prefs.rate}×`); },
      volumeStep: (/** @type {number} */ d) => { act.volume(prefs.volume + d); toast(`Volume ${Math.round(prefs.volume * 100)}%`); },
      copyTime: () => { const text = fmt(tab().frame); postHost({ type: 'copyText', text }); toast(`Copied ${text}`); },
      saveFrame: () => postHost({ type: 'saveFrame' }),
      prevFrame: () => commit(S.stepFrame(ws, -1)),
      nextFrame: () => commit(S.stepFrame(ws, 1)),
      seek: (/** @type {number} */ f) => commit(S.seekFrame(ws, f)),
      mute: () => { prefs.muted = !prefs.muted; render(); },
      volume: (/** @type {number} */ v) => { prefs.volume = Math.max(0, Math.min(1, v)); prefs.muted = prefs.volume === 0; render(); },
      loop: () => { prefs.onEnd = W.VpeAutoplay.toggleLoop ? W.VpeAutoplay.toggleLoop(prefs.onEnd) : (prefs.onEnd === 'loop' ? 'off' : 'loop'); rail.refreshOnEnd(); controls.refresh(); toast(prefs.onEnd === 'loop' ? 'Loop on' : 'Loop off'); },
      setA: () => markAB('a'),
      setB: () => markAB('b'),
      clearAB: () => { ab.clear(); controls.refresh(); render(); toast('A–B range cleared'); },
      cycleTime: () => { prefs.timeMode = nextTimeMode(prefs.timeMode); render(); toast(TIME_MODE_NAMES[prefs.timeMode]); },
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
      pickVideo: () => postHost(pickVideoMessage('unified', { exclude: tab().tiles })),
      nextVideo: () => goNeighbour(rail, postHost, 1),
      prevVideo: () => goNeighbour(rail, postHost, -1),
    };
    /** @type {Record<string, (...a: any[]) => any>} */
    const dispatchTable = act;
    /** The shared key table (keyCommand) over this page's actions; a key's argument, if any, is the first one. */
    /** @type {Record<string, (arg: any, e: any) => any>} */
    const keyTable = {};
    for (const [name, f] of Object.entries(act)) {
      const fn = /** @type {(...a: any[]) => any} */ (f);
      keyTable[name] = (/** @type {any} */ arg) => (arg === undefined ? fn() : fn(arg));
    }

    // ---- the real #bar ----
    const onClick = (/** @type {any} */ el, /** @type {(e?: any) => void} */ fn) => listen(el, 'click', fn);
    bindButtons([
      [cmpBtn, act.capture, true], [splitBtn, act.split, true], [syncBtn, act.sync, true],
      [playBtn, act.playPause, true], [prevBtn, () => act.stepButton(-1), true], [nextBtn, () => act.stepButton(1), true],
      [muteBtn, act.mute, true], [timeEl, act.cycleTime, true], [setABtn, act.setA, true], [setBBtn, act.setB, true],
      [cogBtn, () => controls.toggle('main', cogBtn), true], [infoBtn, act.info, true],
      [rateBtn, () => controls.toggle('speed', rateBtn), true], [tracksBtn, () => controls.toggle('subs', tracksBtn), true],
      [picBtn, act.cyclePicture, true], [fullBtn, act.fullscreen, true],
    ], onClick);
    bindStepBadges([prevSize, nextSize], (b) => controls.toggle('step', b), (el, type, fn) => listen(el, type, fn));
    if (volEl) listen(volEl, 'input', () => act.volume(Number(volEl.value)));
    listen(seekEl, 'input', () => act.seek(Number(seekEl.value)));
    if (capBanner) {
      const stopBtn = capBanner.querySelector('[data-act="pause"]') || $('capStopBtn');
      const pickBtn = capBanner.querySelector('[data-act="pick"]') || $('capPickBtn');
      bindButtons([[stopBtn, act.capture, true], [pickBtn, () => rail.open(), true]], onClick);
    }
    // Dragging an A–B pin moves that end to the nearest frame: the same helper as media/player.js and media/compare.js.
    if (W.VpeAbLoop.bindPin) {
      bindAbPins(W.VpeAbLoop, { a: abA, b: abB, seek: seekEl, tip: tipEl }, {
        ready: () => true,
        n: () => tab().maxFrame + 1,
        fps,
        dur: () => tab().maxFrame / fps(),
        tipLabel: (snap) => clockText(snap.t),
        commit: (w, snap) => { ab.reset(w, snap.t, snap.f, snap.t, false); controls.refresh(); },
        end: () => { if (tipEl) tipEl.hidden = true; render(); },
      });
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
    drag(splitterEl, (ev, rect) => commit(S.setHeroRatio(ws, spotlightRatioAt(tab().dock, ev.clientX - rect.left, ev.clientY - rect.top, rect.width, rect.height))));
    // The Split Wipe divider: the same binding as media/compare.js. Reuses the last rendered split-a rect so drags
    // do not re-run deriveUi() on every pointermove.
    /** @type {{ x: number, w: number } | null} */
    let lastSplitPic = null;
    bindSplitDivider(dividerEl, {
      stageRect: () => stageEl.getBoundingClientRect(),
      pictureRect: () => lastSplitPic,
      get: () => tab().split,
      set: (r) => commit(S.setSplitRatio(ws, r)),
      listen: (el, type, fn) => listen(el, type, fn),
    });
    // The same keys as Compare's splitter (media/compare.js): arrows, Shift for big steps, Home / End.
    const keyDrag = (/** @type {any} */ el, /** @type {(e: KeyboardEvent) => void} */ fn) => { if (el) listen(el, 'keydown', fn); };
    keyDrag(splitterEl, (e) => {
      const next = spotlightKeyRatio(e, tab().dock, tab().heroRatio, 0.1, 0.9);
      if (next === null) return;
      e.preventDefault(); e.stopPropagation();
      commit(S.setHeroRatio(ws, next));
    });

    // ---- keyboard shortcuts ----
    listen(env.keyTarget || doc, 'keydown', (/** @type {KeyboardEvent} */ e) => {
      // Typing in a field (the rail filter), a list box, or Space / Enter on a focused button: not player keys.
      if (W.VpeModes && W.VpeModes.ownsKey) { if (W.VpeModes.ownsKey(e)) return; } else {
        const t = /** @type {any} */ (e.target);
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      }
      const altGr = !!(e.getModifierState && e.getModifierState('AltGraph'));
      if (runKey(e, keyTable, { altGr })) e.preventDefault();
    });

    // ---- the stage: one cell per tile, from deriveUi ----
    // Reuse .cell DOM nodes across frame/seek/resize ticks so pointerdown -> pointerup clicks and dblclicks
    // never drop mid-playback when the 42 ms play timer advances frames.
    let lastCellsKey = '';
    /** @type {Map<string, { cell: any, cv: any, frEl: any, offEl: any }>} */
    const cellNodes = new Map();
    /** @type {any} */
    let addSlotNode = null;
    /** The pending single click of a tile (see DBLCLICK_MS). */
    let clickTimer = 0;
    const DBLCLICK_MS = 250;
    cleanups.push(() => { if (clickTimer) win.clearTimeout(clickTimer); });
    /** When the last tile drag ended: the click that follows a drag is not a play / pause. */
    let dragEndedAt = -Infinity;
    const consumeDragClick = () => Date.now() - dragEndedAt < 300;

    function renderCells(/** @type {any} */ t, /** @type {any} */ ui) {
      stageEl.classList.toggle('sync-mode', t.syncMode && ui.isMulti);
      const key = `${ui.isMulti ? 1 : 0}|${ui.effectiveLayout}|${ui.addSlot ? 1 : 0}|${ui.cells.map((/** @type {any} */ r) => `${r.clipId}:${r.role}:${r.letter}`).join(',')}`;
      if (key !== lastCellsKey) {
        lastCellsKey = key;
        cellNodes.clear();
        addSlotNode = null;
        cellsEl.textContent = '';
        for (const r of ui.cells) {
          const cell = doc.createElement('div');
          cell.className = `cell${r.role.startsWith('split') ? ' split' : ''}`;
          cell.dataset.clip = r.clipId;
          cell.dataset.role = r.role;
          if (r.role === 'split-b') cell.style.background = 'transparent';
          const cv = doc.createElement('canvas');
          cell.appendChild(cv);
          if (ui.isMulti && ui.effectiveLayout !== 'split') cell.appendChild(Object.assign(doc.createElement('div'), { className: 'cell-border' }));
          // A tile's double-click enlarges it, so its single click waits out the double-click window: playback
          // never stutters pause → play before the enlarge. One video (and Split) play at once, as media/player.js.
          const enlargeable = ui.isMulti && ui.effectiveLayout !== 'split';
          cell.addEventListener('click', (/** @type {any} */ e) => {
            if (e.target && e.target.closest && e.target.closest('button')) return;
            if (consumeDragClick()) return;
            if (controls.anyOpen() || ctxMenu.isOpen()) { controls.closeAll(false); ctxMenu.close(false); return; }
            if (!enlargeable) { act.playPause(); return; }
            if (clickTimer) win.clearTimeout(clickTimer);
            clickTimer = win.setTimeout(() => { clickTimer = 0; act.playPause(); }, DBLCLICK_MS);
          });
          cell.addEventListener('dblclick', (/** @type {any} */ e) => {
            if (e.target && e.target.closest && e.target.closest('button')) return;
            if (clickTimer) { win.clearTimeout(clickTimer); clickTimer = 0; }
            if (enlargeable) act.enlarge(r.clipId); else if (!ui.isMulti) act.fullscreen();
          });
          /** @type {any} */
          let frEl = null;
          /** @type {any} */
          let offEl = null;
          if (ui.isMulti) {
            const ov = doc.createElement('div');
            ov.className = 'ov';
            const isHero = r.role === 'hero';
            ov.innerHTML =
              `<div class="${r.role === 'split-b' ? 'pill right' : 'pill'}"><span class="ltr">${r.letter}</span><span class="nm">${esc(clipName(r.clipId))}</span><span class="fr"></span></div>`
              + (ui.effectiveLayout !== 'split'
                ? `<div class="tile-top-acts"><button type="button" class="tbtn" data-enlarge title="${isHero ? 'Back to grid' : 'Enlarge tile'}" aria-label="${isHero ? 'Back to grid' : 'Enlarge tile'} ${r.letter}">${isHero ? ICONS.collapse : ICONS.expand}</button>`
                  + `<button type="button" class="tbtn rm" data-rm title="Remove from compare" aria-label="Remove ${r.letter} from compare">${ICONS.close}</button></div>`
                : '')
              + `<div class="sync-pill"><button type="button" data-d="-1" aria-label="${r.letter} earlier">−</button><span class="offv"></span><button type="button" data-d="1" aria-label="${r.letter} later">+</button></div>`;
            const on = (/** @type {string} */ sel, /** @type {(b: any) => void} */ fn) => ov.querySelectorAll(sel).forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); fn(b); }));
            on('[data-enlarge]', () => act.enlarge(r.clipId));
            on('[data-rm]', () => act.removeTile(r.clipId));
            on('[data-d]', (b) => act.nudge(r.clipId, Number(b.dataset.d)));
            frEl = ov.querySelector('.fr');
            offEl = ov.querySelector('.offv');
            cell.appendChild(ov);
          }
          cellsEl.appendChild(cell);
          cellNodes.set(r.clipId, { cell, cv, frEl, offEl });
        }
        if (ui.addSlot) {
          const slot = doc.createElement('div');
          slot.className = 'cell add';
          slot.innerHTML = '<button type="button" class="addcell">+ Add video</button>';
          // Clicking the empty space around the compact button still toggles play/pause like any tile.
          slot.addEventListener('click', (/** @type {any} */ e) => {
            if (e.target && e.target.closest && e.target.closest('button')) return;
            if (controls.anyOpen() || ctxMenu.isOpen()) { controls.closeAll(false); ctxMenu.close(false); return; }
            act.playPause();
          });
          const b = slot.querySelector('button');
          if (b) b.addEventListener('click', (e) => { e.stopPropagation(); rail.open(); });
          cellsEl.appendChild(slot);
          addSlotNode = slot;
        }
      }

      for (const r of ui.cells) {
        const entry = cellNodes.get(r.clipId);
        if (!entry) continue;
        Object.assign(entry.cell.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });
        const off = t.offsets[r.clipId] || 0;
        if (entry.frEl) entry.frEl.textContent = `#${t.frame + off}`;
        if (entry.offEl) entry.offEl.textContent = `${off >= 0 ? '+' : ''}${off}f`;
        engine.draw(entry.cv, r.clipId, t.frame + off, {
          width: r.w,
          height: r.h,
          splitClipRatio: r.role === 'split-b' ? t.split : null,
        });
      }
      if (ui.addSlot && addSlotNode) {
        Object.assign(addSlotNode.style, { left: `${ui.addSlot.x}px`, top: `${ui.addSlot.y}px`, width: `${ui.addSlot.w}px`, height: `${ui.addSlot.h}px` });
      }
    }

    /** The bar's own state (prefs-driven parts that do not need the stage size). */
    function drawBar() {
      const t = tab();
      if (rateBtn) rateBtn.textContent = W.VpeControls.speedText ? W.VpeControls.speedText(prefs.rate) : `${prefs.rate}×`;
      if (picBtn && W.VpePicture) pictureButton(picBtn, W.VpePicture, prefs.picMode, t.tiles.length > 1 ? 'all videos' : '');
      else if (picBtn) picBtn.dataset.mode = prefs.picMode;
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
      const splitCell = ui.cells.find((/** @type {any} */ r) => r.role === 'split-a');
      lastSplitPic = splitCell ? { x: splitCell.x, w: splitCell.w } : null;
      if (splitterEl) { splitterEl.hidden = !ui.showSplitter; if (ui.showSplitter) splitterEl.style.top = `${Math.round(height * t.heroRatio)}px`; }
      if (dividerEl) {
        dividerEl.hidden = !ui.showDivider;
        if (ui.showDivider) {
          dividerEl.style.left = `${Math.round(width * t.split)}px`;
          dividerEl.setAttribute('aria-valuenow', String(Math.round(t.split * 100)));
        }
      }
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
      const rd = timeReadout({
        f: t.frame, t: t.frame / fps(), dur: t.maxFrame / fps(), fps: fps(), nFrames: t.maxFrame + 1, mode: prefs.timeMode,
        fmtClock: clockText, fmtTimecode: W.VpeTime ? W.VpeTime.fmtTimecode : (/** @type {number} */ f) => String(f),
      });
      if (nowEl) nowEl.textContent = rd.now;
      if (durEl) durEl.textContent = rd.dur;
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

  const api = {
    HOST_COMMANDS, PICTURE_MODES, TIME_MODE_NAMES, pickVideoMessage, defaultPrefs, keyCommand, keyAction, runKey, nextTimeMode, timeReadout,
    formatTime, bindButtons, stepBy, bindStepBadges, pinPercent, bindAbPins, pictureButton, copyInfoText, createContextMenu,
    createFolderRail, goNeighbour, spotlightRatioAt, spotlightKeyRatio, splitKeyRatio, splitRatioAt,
    bindSplitDivider, applyHostMessage, compareRows, create,
  };
  // checkJs: end

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else /** @type {any} */ (globalThis).VpePlayerUi = api;
})();
