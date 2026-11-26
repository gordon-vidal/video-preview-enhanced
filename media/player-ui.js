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
// so nothing here reaches for a global the caller did not choose. Optional ones switch features on: VpePlayerUiTiles
// + CompareGrid (tile glide, drag / dock, tile menu, details card, ▲ / ▼, hover) and VpePlayerUiInput (seek tip and
// thumbnail, wheel step / zoom / pan, idle bar, Zen Esc Esc, auto-pause, live region, go-to box), VpePlayerUiTools
// (#notice banners, scopes / inspector / stats / X-ray, subtitles, frame save / copy and the A–B export protocol) and
// VpePlayerUiLifecycle (shared playback prefs and saved state, frame links and resume, Autoplay next and rail
// handoffs, the #overlay status / error, tile size, pauseForTest, pagehide). Pure helpers at the top are exported for
// the millisecond Node tests (test/host/player_ui_test.js); `create(env)` is the DOM part.
//
// Host -> page messages: { type: 'rail', op, ... }      the folder rail protocol (src/folder-rail.js)
//                        { type: 'openVideo', clipId, label?, compare?, replace?, forceNewTab? }
//                        { type: 'removeVideo', clipId }  a rail click on a video already in this Compare
//                        { type: 'toast', text }
//                        { type: 'replaceTile', oldId, newId, label? }  the answer to 'replaceVideo'
//                        { type: 'focusMode', active }    Zen Mode on / off (Esc Esc then posts 'focusModeExited')
//                        { type: 'setVisible', visible, active? }  the webview panel shown / hidden (auto-pause)
//                        { type: 'subs', tracks, select? }      subtitle tracks (VpePlayerUiTools)
//                        { type: 'abQuery' | 'exportGrab' | 'exportEnd', ... }  the A–B export protocol
//                        { type: 'hideReducedResNotice' | 'hideSlowPlaybackNotice' }  a notice turned off in Settings
//                        { type: 'slowPlayback', variant, offerSetup?, mb? }  the decoder plays slowly (#notice)
//                        { type: 'playbackPrefs', prefs } | { type: 'prefs', prefs }  shared prefs / live settings
//                        { type: 'goto', mode?, frame?, t? }    a frame link opened on this tab
//                        { type: 'railHandoff' | 'railHandoffCancel', ... }  folder navigation between tabs
//                        { type: 'status', text } | { type: 'error', message, hint?, action? }  the #overlay
//                        { type: 'pauseForTest' }               the GPU test waits for playback to stop
// Page -> host messages: { type: 'rail' | 'neighbour', ... }  posted by VpeFolderRail itself
//                        { type: 'tiles', tabId, tiles, current }  after any change of the active tab's videos
//                        { type: 'pickVideo', exclude }            "+ Add video" / "Pick…" / Compare › Add video
//                        { type: 'tileOrder', order, current }    after a drag, ▲ / ▼ or Swap reordered the tiles
//                        { type: 'replaceVideo', oldId, exclude }  tile menu / Compare › video › Replace video…
//                        { type: 'leaveCompare', keepId, t }      Leave compare (keeps the clock tile)
//                        { type: 'copyFrame', clipId? }           a tile's frame (tile menu) or the view
//                        { type: 'copyText', text } and the command requests listed in HOST_COMMANDS
//                        { type: 'saveFrame', frame, data } | { type: 'copyLink', frame, t }  (VpePlayerUiTools)
//                        { type: 'exportRange' | 'clipRange' | 'ffmpegRange', range } | { type: 'exportFrame', ... }
//                        { type: 'playbackPrefs', volume, rate, timeMode, stepSize } | { type: 'tileSize', tile }
//                        { type: 'action', id, ... }              a notice or #overlay button
'use strict';

(() => {
  // checkJs: start
  /**
   * The shared contracts (media/unified-contracts.d.ts). The controller needs `clips`, `getClip` and `draw` of an
   * engine and `post` of a host; every other engine method is used only when the engine has it.
   * @typedef {import('./unified-contracts').EngineAdapter} FullEngineAdapter
   * @typedef {Pick<FullEngineAdapter, 'clips' | 'getClip' | 'draw'> & Partial<FullEngineAdapter>} EngineAdapter
   * @typedef {Pick<import('./unified-contracts').HostAdapter, 'post' | 'storage'>} HostAdapter
   * @typedef {import('./unified-contracts').ClipMeta} ClipMeta
   * @typedef {import('./unified-contracts').TransportCommand} TransportCommand
   * @typedef {import('./unified-contracts').UnifiedControllerApi} UnifiedControllerApi
   */
  /**
   * @typedef {object} Prefs
   * @property {string} onEnd       'off' | 'loop' | 'next' ... (media/autoplay.js)
   * @property {number} rate
   * @property {boolean} muted
   * @property {number} volume
   * @property {string | null} stepSize  null: the setting stepButtons decides
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
    // The host's answer to 'replaceVideo' (tile menu / panel "Replace…"): the new video takes the old one's slot.
    if (msg && msg.type === 'replaceTile' && typeof msg.oldId === 'string' && typeof msg.newId === 'string') {
      const next = S.replaceTile(ws, msg.oldId, msg.newId);
      const label = msg.label || (getClip(msg.newId) || { name: msg.newId }).name;
      return { state: next, toast: next === ws ? '' : `Replaced with ${label}`, handled: true };
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
   * What the Compare page lists (media/compare.js renderCompare, over the unified state): each tile's letter,
   * name, offset ({ unit, v }) and its short text ("0", "+3 f", "−40 ms"), and whether it sets the clock or is heard.
   * @param {any} S @param {any} tab TabState @param {(id: string) => ClipMeta} getClip
   */
  function compareRows(S, tab, getClip) {
    return tab.tiles.map((/** @type {string} */ id, /** @type {number} */ i) => {
      const off = S.getOffset(tab, id);
      const txt = S.formatOffset(off);
      return {
        id, letter: S.TILE_KEYS[i], name: (getClip(id) || { name: id }).name, offset: off,
        offText: txt.short, offLong: txt.long, clock: tab.clockId === id, sound: tab.soundId === id,
      };
    });
  }

  const SVG = (/** @type {string} */ body, size = 18, sw = 1.6) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
  const ICONS = {
    split: SVG('<rect x="4" y="5" width="16" height="14" rx="1.6"/><path d="M12 3v18"/>'),
    sync: SVG('<rect x="4" y="6" width="11.5" height="4.2" rx="1.1"/><rect x="8.5" y="13.8" width="11.5" height="4.2" rx="1.1"/><path d="M12 3.5v17" stroke-dasharray="1.8 2.2"/>'),
    spotlight: SVG('<rect x="3" y="4" width="18" height="10" rx="1.4"/><rect x="3" y="16" width="5" height="4" rx="0.8"/><rect x="9.5" y="16" width="5" height="4" rx="0.8"/><rect x="16" y="16" width="5" height="4" rx="0.8"/>'),
    grid: SVG('<rect x="3.5" y="4" width="7.5" height="7" rx="1.2"/><rect x="13" y="4" width="7.5" height="7" rx="1.2"/><rect x="3.5" y="13" width="7.5" height="7" rx="1.2"/><rect x="13" y="13" width="7.5" height="7" rx="1.2"/>'),
    swap: SVG('<path d="M7 7h12l-3-3M17 17H5l3 3"/>'),
    compare: SVG('<rect x="2.5" y="4.5" width="19" height="15" rx="1.5"/><path d="M12 4.5v15"/>', 16),
    expand: SVG('<path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>', 13, 2),
    collapse: SVG('<path d="M4 14h6v6M20 10h-6V4M14 10l7-7M10 14l-7 7"/>', 13, 2),
    close: SVG('<path d="M6 6l12 12M18 6L6 18"/>', 12, 2.1),
    plus: SVG('<path d="M12 5v14M5 12h14"/>'),
    leave: SVG('<path d="M10 17l-5-5 5-5M5 12h11a4 4 0 0 1 4 4v3"/>'),
    info: SVG('<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5M12 7.6v.2"/>', 13, 2),
    sound: SVG('<path d="M4 9.5h3.5L12 6v12l-4.5-3.5H4z"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/>', 13, 1.9),
    muted: SVG('<path d="M4 9.5h3.5L12 6v12l-4.5-3.5H4z"/><path d="M16 9.5l5 5M21 9.5l-5 5"/>', 13, 1.9),
    noAudio: SVG('<path d="M4 9.5h3.5L12 6v12l-4.5-3.5H4z"/><path d="M3 3l18 18"/>', 13, 1.9),
    up: SVG('<path d="M6 14l6-6 6 6"/>', 14, 2),
    down: SVG('<path d="M6 10l6 6 6-6"/>', 14, 2),
  };
  const esc = (/** @type {string} */ s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] || c);
  /** Compare's dense grid: from this many videos the tile chrome shrinks (media/compare-grid.js LARGE). */
  const DENSE_FROM = 5;
  /** Click guard after a splitter drag, as the tile drag's RECENT_DRAG_MS. */
  const DRAG_CLICK_MS = 300;
  /** −/+ in the single player: one zoom step. */
  const ZOOM_STEP = 1.25;

  /**
   * @param {{
   *   doc: Document,
   *   win?: Window & typeof globalThis,
   *   stateApi: any,
   *   engine: EngineAdapter,
   *   host: HostAdapter,
   *   widgets?: { VpeControls?: any, VpeFolderRail?: any, VpeCtxMenu?: any, VpeAbLoop?: any, VpeAutoplay?: any,
   *     VpeTime?: any, VpePicture?: any, VpeModes?: any, VpePlayerUiTiles?: any, VpePlayerUiInput?: any, CompareGrid?: any,
   *     VpePlayerUiTools?: any, VpePlayerUiLifecycle?: any, VpeReducedResNotice?: any, VpeSlowNotice?: any },
   *   inspectWidgets?: { scopes?: any, inspector?: any, stats?: any, xray?: any },
   *   storage?: { getState: () => any, setState: (s: any) => void },
   *   goto?: { frame?: number, t?: number, mode?: string } | null,
   *   fragment?: string | null,
   *   railCarry?: any,
   *   page?: any,
   *   initial?: any,
   *   prefs?: Partial<Prefs>,
   *   railCfg?: { layout?: string, width?: number, column?: string, playable?: boolean },
   *   container?: HTMLElement,
   *   keyTarget?: EventTarget,
   *   tickMs?: number,
   *   onChange?: (ws: any, ui: any) => void,
   *   onTransport?: (ev: TransportCommand) => void,
   * }} env
   * `tickMs: 0` hands the clock to a decoder: the page then reports what the user does through `onTransport` and
   * follows the decoder through the controller's `onDecoderFrame` / `onDecoderEnded`.
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
    const GLOBAL_WIDGETS = ['VpeControls', 'VpeFolderRail', 'VpeCtxMenu', 'VpeAbLoop', 'VpeAutoplay', 'VpeTime', 'VpePicture',
      'VpeModes', 'VpePlayerUiTiles', 'VpePlayerUiInput', 'CompareGrid', 'VpePlayerUiTools', 'VpePlayerUiLifecycle',
      'VpeReducedResNotice', 'VpeSlowNotice'];
    const W = /** @type {any} */ ({ ...Object.fromEntries(GLOBAL_WIDGETS.map((k) => [k, win[k]])), ...(env.widgets || {}) });
    for (const k of ['VpeControls', 'VpeFolderRail', 'VpeCtxMenu', 'VpeAbLoop', 'VpeAutoplay']) {
      if (!W[k]) throw new Error(`player-ui: widget ${k} is missing`);
    }
    /** Optional widgets: without them the tile gestures (Tiles + CompareGrid) or the input extras (Input) stay off. */
    const Tiles = W.VpePlayerUiTiles && W.CompareGrid ? W.VpePlayerUiTiles : null;
    const Grid = W.CompareGrid || null;
    const Input = W.VpePlayerUiInput || null;
    /** Optional too: without them the notices, inspection, subtitles, frame export (Tools) or host sync (Life) stay off. */
    const Tools = W.VpePlayerUiTools || null;
    const Life = W.VpePlayerUiLifecycle || null;
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
    /** The tiles' right-click menu (#menu, compare.css); pages without it get one. */
    const tileMenuEl = $('menu') || doc.body.appendChild(Object.assign(doc.createElement('div'), { id: 'menu', hidden: true }));

    /** Compare's layout and Swap buttons sit beside Compare; src/bar.js does not draw them yet. */
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
    const spotBtn = barButton('spotlightBtn', 'Spotlight', ICONS.spotlight);
    const gridBtn = barButton('gridBtn', 'Equal Grid', ICONS.grid);
    const splitBtn = barButton('splitBtn', 'Split Wipe (2 videos)', ICONS.split);
    const swapBtn = barButton('swapBtn', 'Swap sides  X', ICONS.swap);
    const syncBtn = barButton('syncBtn', 'Sync frame offsets', ICONS.sync);

    /** @type {(() => void)[]} */
    const cleanups = [];
    const listen = (/** @type {any} */ target, /** @type {string} */ type, /** @type {any} */ fn, /** @type {any} */ opts) => {
      target.addEventListener(type, fn, opts);
      cleanups.push(() => target.removeEventListener(type, fn, opts));
    };
    // One polite live region: emptied first, written 50 ms later, so a repeated text is read again.
    const liveEl = $('live');
    const live = Input && liveEl ? Input.createLiveAnnouncer({ liveEl, win }) : null;
    if (live) cleanups.push(live.dispose);
    const announce = (/** @type {string} */ t) => { if (live) live.announce(t); else if (liveEl) liveEl.textContent = t; };
    const toast = $('toast') ? W.VpeControls.createToast($('toast'), announce) : announce;
    const flashPlay = $('playFlash') ? W.VpeControls.createPlayFlash($('playFlash'), stageEl) : () => {};

    // ---- state ----
    let ws = env.initial && Array.isArray(env.initial.tabs) ? env.initial : S.createWorkspaceState(env.initial || {});
    /** The webview's saved state (prefs, position, dismissed notices, subtitle settings), when the page has one. */
    const storage = env.storage || host.storage || null;
    /** @type {any} */
    const saved = (() => {
      try { const s = storage && storage.getState(); return s && typeof s === 'object' ? s : {}; } catch { return {}; }
    })();
    /** @type {Prefs} */
    const prefs = { ...defaultPrefs(), ...(env.prefs || {}), ...(Life ? Life.cleanPlaybackPrefs(saved) : {}) };
    // The tool and lifecycle controllers (media/player-ui-tools.js, media/player-ui-lifecycle.js); null without them.
    /** @type {any} */ let notices = null;
    /** @type {any} */ let insp = null;
    /** @type {any} */ let subs = null;
    /** @type {any} */ let frameExport = null;
    /** @type {any} */ let prefsSync = null;
    /** @type {any} */ let gotoResume = null;
    /** @type {any} */ let railCtl = null;
    /** @type {any} */ let overlay = null;
    /** @type {any} */ let bridge = null;
    const ab = W.VpeAbLoop.create();
    let lastTilesKey = '';
    let disposed = false;
    const tab = () => S.getTab(ws);
    const fps = () => tab().fps || 24;
    const fmt = (/** @type {number} */ f) => formatTime(f, fps(), prefs.timeMode, W.VpeTime ? W.VpeTime.fmtTimecode : null);
    const clockText = (/** @type {number} */ sec) => formatTime(Math.round(sec * fps()), fps(), 0);
    const single = () => tab().tiles.length === 1;
    /** The arrow keys' jump sizes (settings videoPreviewEnhanced.jump.*): seconds, or 'frame'. Live settings update it. */
    /** @type {{ arrow: number | string, shift: number | string, ctrl: number | string }} */
    const JUMP = { arrow: 5, shift: 1, ctrl: 'frame' };
    /** The setting stepButtons: what the buttons beside Play step until a step size is picked. */
    let stepButtons = /** @type {'frame' | 'jump'} */ ('frame');
    const stepPrefs = () => ({ stepSize: prefs.stepSize, stepButtons, jump: JUMP });
    const clipName = (/** @type {string} */ id) => (engine.getClip(id) || { name: id }).name;
    const letterOf = (/** @type {any} */ t, /** @type {string} */ id) => S.TILE_KEYS[Math.max(0, t.tiles.indexOf(id))];
    const hasAudio = (/** @type {string | null} */ id) => !id || typeof engine.hasAudio !== 'function' || !!engine.hasAudio(id);
    const clipFps = (/** @type {string} */ id) => (engine.getClip(id) || {}).fps || fps();

    /** Stable video numbers for the tile modules (they key cells by `data-tile`, as Compare's video indexes). */
    /** @type {Map<string, number>} */
    const vidOf = new Map();
    /** @type {Map<number, string>} */
    const idOfVid = new Map();
    const vid = (/** @type {string} */ id) => {
      let v = vidOf.get(id);
      if (v === undefined) { v = vidOf.size; vidOf.set(id, v); idOfVid.set(v, id); }
      return v;
    };

    // ---- FLIP glide (media/player-ui-tiles.js): cells glide on reorder, swap, dock and layout switches ----
    const glide = Tiles ? Tiles.createGlide({ doc, win }) : null;
    if (glide) cleanups.push(() => glide.cancel());
    /**
     * Run a state change with the cells gliding from where they were; never to or from Split Wipe. `skip`: a clip
     * whose cell must not glide (the lifted tile follows the pointer by its own transform).
     */
    const withGlide = (/** @type {() => void} */ fn, /** @type {string | null} */ skip = null) => {
      const before = tab().layout;
      const els = () => [...cellNodes.entries()].filter(([id]) => id !== skip).map(([, e]) => e.cell);
      if (glide) glide.capture(els());
      fn();
      if (glide && before !== 'split' && tab().layout !== 'split') glide.play(els());
      else if (glide) glide.cancel();
    };

    // ---- transport: what a decoder clock (tickMs: 0) must hear, and the frames it reports back ----
    /** The transport as last seen (null before the first look): a change from it is a user's play, seek, rate or loop. */
    /** @type {{ tabId: number, frame: number, playing: boolean, rate: number, loop: boolean } | null} */
    let seen = null;
    /** True while the decoder's own frames, its end or a confirmed presentation land: those are not told back. */
    let quiet = false;
    const tell = (/** @type {TransportCommand} */ ev) => { if (env.onTransport && !disposed) env.onTransport(ev); };
    /** Compare the transport with the last look and tell `env.onTransport` what changed (seek first, then play / pause). */
    const emitTransport = () => {
      const t = tab();
      const now = { tabId: t.id, frame: t.frame, playing: t.playing, rate: prefs.rate, loop: prefs.onEnd === 'loop' };
      const was = seen;
      seen = now;
      // Another tab is another clock: it was not sought, it was switched to.
      if (!was || quiet || was.tabId !== now.tabId) return;
      if (now.frame !== was.frame) tell({ type: 'seek', frame: now.frame, playing: now.playing });
      if (now.playing !== was.playing) tell({ type: now.playing ? 'play' : 'pause', frame: now.frame, playing: now.playing });
      if (now.rate !== was.rate) tell({ type: 'rate', rate: now.rate });
      if (now.loop !== was.loop) tell({ type: 'loop', loop: now.loop });
    };
    /** Run a state change the decoder made itself (its frames, its end, a frame it confirmed): not told back. */
    const quietly = (/** @type {() => void} */ fn) => {
      const q = quiet;
      quiet = true;
      try { fn(); } finally { quiet = q; }
    };

    /**
     * The clock moved to another video (or another tab), or (prev null: ui.syncClockMeta()) its decoder learnt the
     * real frame rate / length after boot: the seek bar, readout and stepping follow that video's frame rate and
     * length, at the same moment (S.syncClockMeta). Not a seek: the transport keeps its time. A commit on the same
     * clock leaves the tab's numbers alone (the page's own maxFrame may be what the host knows better).
     */
    const syncClock = (/** @type {any} */ prev) => {
      const t = tab();
      if (!t.clockId) return;
      const c = /** @type {any} */ (engine.getClip(t.clockId) || {});
      /** @type {{ fps?: number, maxFrame?: number }} */
      const meta = {};
      if (Number(c.fps) > 0) meta.fps = Number(c.fps);
      if (Number(c.frames) > 1) meta.maxFrame = Math.floor(Number(c.frames)) - 1;
      if (prev && prev.id === t.id && prev.clockId === t.clockId) return;
      const stale = (meta.fps !== undefined && meta.fps !== t.fps) || (meta.maxFrame !== undefined && meta.maxFrame !== t.maxFrame);
      if (!prev && !stale) return;
      const before = t.frame;
      ws = S.syncClockMeta(ws, meta);
      if (seen && seen.tabId === t.id && seen.frame === before) seen.frame = tab().frame;
    };

    /** One state transition: replace the state, follow a new clock, say the toast, redraw. */
    const commit = (/** @type {any} */ next, toastText = '') => {
      const prev = tab();
      ws = next;
      syncClock(prev);
      if (toastText) toast(toastText);
      render();
    };
    const postHost = (/** @type {any} */ msg) => { if (!disposed) host.post(msg); };
    /**
     * Compare capture lives in the host's session too (src/unified-session.js 'capture'): whatever turned it on or
     * off here (the button, Shift+D, leaving Compare, a video opened into Compare), the host is told once per change.
     */
    let lastPostedCapture = !!tab().capture;
    const postCapture = () => {
      const t = tab();
      const on = !!t.capture;
      if (on === lastPostedCapture) return;
      lastPostedCapture = on;
      postHost({ type: 'capture', tabId: t.id, on });
    };

    // ---- the real Folder Rail: its own messages go straight to the host ----
    /** @type {any} */
    let controls = null;
    /** @type {any} */
    let ctxMenu = null;
    /** @type {any} */
    let tileMenu = null;
    const setOnEnd = (/** @type {string} */ m) => {
      prefs.onEnd = m;
      if (rail) rail.refreshOnEnd();
      if (controls) controls.refresh();
      toast(`Autoplay: ${W.VpeAutoplay.label(m)}`);
      emitTransport();
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
    // URLs and image sequences have no folder (unifiedHtml({ folder: false }) leaves #rail out): no rail then.

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
      const c = /** @type {Partial<ClipMeta> & { name: string }} */ (engine.getClip(id) || { id, name: id });
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
    /** The clip as compare-grid tileStatsRows reads it (size, fps, frames, codec). */
    const statsClip = (/** @type {string} */ id) => {
      const f = /** @type {any} */ (facts(id));
      const c = /** @type {any} */ (engine.getClip(id) || {});
      return { w: f.width || c.width || 0, h: f.height || c.height || 0, fps: f.fps || c.fps || 0, frames: f.frames || c.frames || 0, codec: f.codec || c.codec || '' };
    };
    /** The tile the Compare › video page shows (a clip id; falls back to the clock tile). */
    let selId = /** @type {string | null} */ (null);
    const selected = () => { const t = tab(); return selId && t.tiles.includes(selId) ? selId : (t.clockId || t.tiles[0]); };
    const switchRow = (/** @type {any} */ k, /** @type {string} */ label, /** @type {boolean} */ on, /** @type {() => void} */ run, /** @type {any} */ extra = {}) => {
      const b = k.btn('row', label, run, { ...extra, aria: { role: 'switch', 'aria-checked': String(on), ...(extra.aria || {}) } });
      b.appendChild(k.sw(on));
      return b;
    };
    const cmpViews = {
      cmp: {
        label: 'Compare', button: 'cmp',
        render: (/** @type {any} */ _s, /** @type {any} */ k) => {
          const t = tab();
          const f = doc.createDocumentFragment();
          f.appendChild(k.heading('Videos'));
          for (const r of compareRows(S, t, engine.getClip)) {
            const marks = [r.clock ? 'clock' : '', r.sound ? 'sound' : ''].filter(Boolean);
            const b = k.btn('row cvid', r.name, () => { selId = r.id; k.show('cmpVid'); }, {
              value: `${r.clock ? '⏱ ' : ''}${r.sound && !prefs.muted ? '🔊 ' : ''}${r.offText}`, chev: true,
              aria: { 'aria-label': `${r.letter}: ${r.name}, offset ${r.offLong}${marks.length ? `, ${marks.map((m) => (m === 'clock' ? 'sets the clock' : 'sound on')).join(', ')}` : ''}` },
            });
            const ltr = k.el('span', 'ltr', r.letter);
            ltr.setAttribute('aria-hidden', 'true');
            b.insertBefore(ltr, b.firstChild);
            f.appendChild(b);
          }
          if (t.tiles.length < t.maxVideos) {
            f.appendChild(k.btn('row', 'Add video…', () => { k.close(false); act.pickVideo(); }, { icon: ICONS.plus, value: `${t.tiles.length} of ${t.maxVideos}` }));
          }
          f.appendChild(switchRow(k, 'Open new videos here', t.capture, () => { act.capture(); k.render(); }, { icon: ICONS.plus, kbd: 'Shift+D' }));
          f.appendChild(k.el('div', 'sep'));
          if (t.tiles.length >= 2) {
            const row = k.el('div', 'row static');
            row.appendChild(k.el('span', 'grow', 'Layout'));
            const seg = k.el('div', 'seg');
            seg.setAttribute('role', 'group');
            seg.setAttribute('aria-label', 'Layout');
            const ui = S.deriveUi(t);
            const modes = t.tiles.length === 2 ? [['spotlight', 'Spotlight'], ['grid', 'Grid'], ['split', 'Split']] : [['spotlight', 'Spotlight'], ['grid', 'Equal Grid']];
            for (const [m, label] of modes) {
              seg.appendChild(k.btn('chip', label, () => { act.layout(m); k.render(); }, { aria: { 'aria-pressed': String(ui.effectiveLayout === m) } }));
            }
            row.appendChild(seg);
            f.appendChild(row);
            if (t.tiles.length === 2) f.appendChild(k.btn('row', 'Swap sides', () => { act.swap(); k.render(); }, { icon: ICONS.swap, kbd: 'X' }));
            f.appendChild(switchRow(k, 'Sync offsets on tiles', t.syncMode, () => { act.sync(); k.render(); }));
            f.appendChild(k.el('div', 'sep'));
            const keep = letterOf(t, t.clockId || t.tiles[0]);
            f.appendChild(k.btn('row', 'Leave compare', () => { k.close(false); act.leaveCompare(); }, { icon: ICONS.leave, value: `keep ${keep}`, aria: { 'aria-label': `Leave compare, keep ${keep}` } }));
          }
          return f;
        },
      },
      cmpVid: {
        label: () => { const t = tab(); const id = selected(); return id ? `${letterOf(t, id)}: ${clipName(id)}` : 'Video'; },
        button: 'cmp', parent: 'cmp',
        render: (/** @type {any} */ _s, /** @type {any} */ k) => {
          const t = tab();
          const id = selected();
          const r = compareRows(S, t, engine.getClip).find((x) => x.id === id) || compareRows(S, t, engine.getClip)[0];
          const f = doc.createDocumentFragment();
          f.appendChild(k.head(`${r.letter} ${r.name}`, 'cmp'));
          f.appendChild(k.heading('Offset'));
          const top = k.el('div', 'speedTop');
          const minus = k.btn('big', null, () => { act.nudge(r.id, -1); k.render(); }, { aria: { 'aria-label': `${r.letter} earlier` } });
          const plus = k.btn('big', null, () => { act.nudge(r.id, 1); k.render(); }, { aria: { 'aria-label': `${r.letter} later` } });
          minus.textContent = '−';
          plus.textContent = '+';
          const readout = k.el('div', 'readout off', r.offText);
          readout.setAttribute('aria-label', `Offset of ${r.letter}: ${r.offLong}`);
          top.append(minus, readout, plus);
          f.appendChild(top);
          // Frames or ms: the moment the offset stands for is kept (player-state setOffsetUnit).
          const unitRow = k.el('div', 'row static');
          unitRow.appendChild(k.el('span', 'grow', 'Unit'));
          const seg = k.el('div', 'seg');
          seg.setAttribute('role', 'group');
          seg.setAttribute('aria-label', `Offset unit of ${r.letter}`);
          for (const [u, label] of [['frames', 'Frames'], ['ms', 'Time ms']]) {
            seg.appendChild(k.btn('chip', label, () => { commit(S.setOffsetUnit(ws, r.id, u, clipFps(r.id))); k.render(); }, { aria: { 'aria-pressed': String(r.offset.unit === u) } }));
          }
          unitRow.appendChild(seg);
          f.appendChild(unitRow);
          if (r.offset.v) f.appendChild(k.btn('link', 'Reset offset', () => { commit(S.resetOffset(ws, r.id), `${r.letter} in step`); k.render(); }, { aria: { 'aria-label': `Reset the offset of ${r.letter}` } }));
          f.appendChild(k.el('div', 'sep'));
          f.appendChild(switchRow(k, `${r.letter} sets the clock`, r.clock, () => { act.setClock(r.id); k.render(); }));
          if (hasAudio(r.id)) f.appendChild(switchRow(k, `Sound from ${r.letter}`, r.sound, () => { act.setSound(r.id); k.render(); }));
          else f.appendChild(k.btn('row', `No audio track in ${r.letter}`, () => {}, { aria: { 'aria-disabled': 'true' } }));
          f.appendChild(k.el('div', 'sep'));
          if (t.tiles.length === 2) f.appendChild(k.btn('row', 'Swap sides', () => { act.swap(); k.render(); }, { icon: ICONS.swap, kbd: 'X' }));
          f.appendChild(k.btn('row', t.layout === 'spotlight' && t.spotlightId === r.id ? 'Back to grid' : 'Enlarge tile', () => { act.enlarge(r.id); k.render(); }));
          f.appendChild(k.btn('row', 'Replace video…', () => { k.close(false); act.replace(r.id); }));
          f.appendChild(k.btn('row', 'Remove from compare', () => { k.show('cmp'); act.removeTile(r.id); }, { icon: ICONS.close }));
          return f;
        },
      },
    };

    /** ⚙ › Inspection (media/player.js TOOLS): each tool with its key; the inspector is X only with one video. */
    const inspectTools = (/** @type {boolean} */ isMulti) => {
      const st = insp.getState();
      const tool = (/** @type {string} */ label, /** @type {string} */ title, /** @type {string} */ key, /** @type {boolean} */ on,
        /** @type {() => void} */ run) => ({ label, title, key, group: 'inspect', on, run });
      return [
        tool('Scopes', 'Scopes', 'W', !!st.scopes, () => insp.cycleScopes()),
        ...(isMulti ? [] : [tool('Inspector', 'Pixel inspector', 'X', !!st.inspector, () => insp.cycleInspector())]),
        tool('Stats', 'Stats', 'Shift+I', st.stats, () => insp.toggleStats()),
        tool('Codec X-ray', 'Codec X-ray', 'Shift+X', st.xray, () => insp.toggleXray()),
      ];
    };
    /** ⚙ › Subtitles: the subtitle controller's tracks, delay and size (else the mockup's demo list). */
    const subsPanel = () => {
      const audio = [
        { id: 'a0', main: 'English (AAC 2.0)', checked: prefs.audioId === 'a0' },
        { id: 'a1', main: 'Director Commentary', checked: prefs.audioId === 'a1' },
      ];
      if (subs) {
        const st = subs.getState();
        return {
          on: st.track >= 0, label: st.label, sel: st.track < 0 ? 'off' : String(st.track),
          subs: st.tracks.map((/** @type {string} */ name, /** @type {number} */ i) => ({ key: String(i), main: name, checked: st.track === i })),
          audio, delay: st.delayMs / 1000, size: st.sizePct / 100,
        };
      }
      return {
        on: prefs.subKey !== 'off',
        label: prefs.subKey === 'off' ? 'Off' : 'English (SRT)',
        sel: prefs.subKey,
        subs: [
          { key: 'off', main: 'Off', checked: prefs.subKey === 'off' },
          { key: 'en', main: 'English (SRT)', sub: 'Sidecar', checked: prefs.subKey === 'en' },
        ],
        audio, delay: 0, size: 1,
      };
    };

    controls = W.VpeControls.create({
      panel: need('panel'),
      sheet: need('sheet'),
      bar: barEl,
      onShow: () => { if (ctxMenu) ctxMenu.close(false); if (tileMenu) tileMenu.close(); },
      buttons: { cog: cogBtn, info: infoBtn, rate: rateBtn, tracks: tracksBtn, cmp: cmpBtn, stepPrev: prevSize, stepNext: nextSize },
      views: cmpViews,
      get: () => {
        const t = tab();
        const isMulti = t.tiles.length >= 2;
        const sel = Math.min(infoSel, t.tiles.length - 1);
        return {
          compare: isMulti ? { soundLabel: `from ${letterOf(t, t.soundId || t.tiles[0])}` } : null,
          rate: prefs.rate,
          loop: prefs.onEnd === 'loop',
          autoplay: { mode: prefs.onEnd, label: W.VpeAutoplay.label(prefs.onEnd), next: !isMulti },
          jump: JUMP,
          stepButtons,
          stepSize: prefs.stepSize,
          abLabel: abLabel(),
          picture: { mode: t.picMode, pct: Math.round(t.zoom * 100), zoomed: t.zoom !== 1 },
          tools: [
            isMulti
              ? { id: 'compare', label: 'Compare', note: `${t.tiles.length} videos`, on: true, keepOpen: true, run: () => controls.show('cmp', cmpBtn) }
              : { id: 'compare', label: t.capture ? 'Pause Compare capture' : 'Start Compare', key: 'Shift+D', on: t.capture, run: () => act.capture() },
            ...(rail ? [{ id: 'rail', label: rail.isOpen() ? 'Close Folder Rail' : 'Open Folder Rail', on: rail.isOpen(), run: () => { rail.toggle(); render(); } }] : []),
            // ⚙ › Inspection (media/player.js TOOLS): each tool with its key; the inspector is X only with one video.
            ...(insp ? inspectTools(isMulti) : []),
          ],
          ab: {
            items: [
              { label: 'Set Range Start (A)', key: 'A', run: () => act.setA() },
              { label: 'Set Range End (B)', key: 'B', run: () => act.setB() },
              { label: 'Clear A–B Range', key: 'Backspace', run: () => act.clearAB() },
              // The exports ask the host with the range (media/player.js sendRange): frames, an exact clip, an ffmpeg line.
              ...(frameExport ? [
                { label: 'Export frames A–B…', run: () => frameExport.exportAb('exportRange') },
                { label: 'Export A–B Clip…', run: () => frameExport.exportAb('clipRange') },
                { label: 'Copy ffmpeg command for A–B', run: () => frameExport.exportAb('ffmpegRange') },
              ] : []),
            ],
          },
          subsLabel: subs ? subs.getState().label : prefs.subKey === 'off' ? 'Off' : 'English (SRT)',
          audioLabel: prefs.audioId === 'a0' ? 'English (AAC 2.0)' : 'Director Commentary',
          hasSound: hasAudio(t.soundId),
          tracks: subsPanel(),
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
        stepSize: (/** @type {string} */ v) => { prefs.stepSize = v; drawBar(); controls.refresh(); toast(`Step buttons: ${W.VpeControls.stepName(v)}`); },
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
        zoomPicture: (/** @type {number} */ d) => { commit(S.setZoom(ws, Math.max(0.5, Math.min(4, +(tab().zoom + d * 0.25).toFixed(2))))); controls.refresh(); },
        resetPicture: () => { commit(S.resetView(ws)); setPicture('fit'); },
        selectSub: (/** @type {string} */ k) => {
          if (subs) {
            subs.select(k === 'off' ? -1 : Number(k));
            const st = subs.getState();
            toast(st.track < 0 ? 'Subtitles off' : `Subtitles: ${st.label}`);
            return;
          }
          prefs.subKey = k; drawBar(); controls.refresh(); toast(k === 'off' ? 'Subtitles off' : 'Subtitles: English');
        },
        selectAudio: (/** @type {string} */ id) => { prefs.audioId = id; controls.refresh(); toast('Audio track switched'); },
        loadSubs: () => postHost({ type: 'loadSubs' }),
        // The panel steps in seconds and fractions (controls.js renderSubs); null resets.
        subDelay: (/** @type {number | null} */ d) => { if (subs) { if (d === null) subs.resetDelay(); else subs.adjustDelay(d * 1000); } },
        subSize: (/** @type {number | null} */ d) => { if (subs) { if (d === null) subs.resetSize(); else subs.adjustSize(Math.round(d * 100)); } },
        copyInfo: (/** @type {any} */ d) => { postHost({ type: 'copyText', text: copyInfoText(d) }); toast('Details copied'); },
        copyLink: () => act.copyLink(),
        external: () => postHost({ type: 'external' }),
        extSettings: () => postHost({ type: 'openSettings' }),
        openUrl: () => postHost({ type: 'openUrl' }),
      },
    });

    // ---- the real right-click menu (one video); with N >= 2 the tile menu takes the right-click instead ----
    // ctxmenu.js listens on the document itself, so create() adds no second opener (it used to open twice).
    ctxMenu = createContextMenu(W.VpeCtxMenu, {
      menu: need('ctxmenu'),
      container: env.container || doc.body,
      getState: () => {
        const t = tab();
        return { ready: true, playing: t.playing, loop: prefs.onEnd === 'loop', abSet: ab.isSet(), file: true, compareOpen: t.tiles.length >= 2 };
      },
      beforeOpen: () => { controls.closeAll(false); if (tileMenu) tileMenu.close(); },
      actions: {
        playPause: () => act.playPause(), loop: () => act.loop(), setA: () => act.setA(), setB: () => act.setB(),
        clearAB: () => act.clearAB(), copyFrame: () => act.copyFrame(), saveFrame: () => act.saveFrame(),
        copyTime: () => act.copyTime(), startCompare: () => act.capture(),
        // Add to Compare never turns a running capture off: with capture on it picks the next video instead.
        addToCompare: () => { if (tab().capture) act.pickVideo(); else act.capture(); },
        keys: () => controls.openSheet(cogBtn), cog: () => controls.show('main', cogBtn),
      },
    });

    // ---- the tiles' right-click menu (media/player-ui-tiles.js createTileMenu), N >= 2 ----
    if (Tiles) {
      tileMenu = Tiles.createTileMenu({
        doc, win, menuEl: tileMenuEl,
        onAction: (/** @type {string} */ a, /** @type {any} */ c) => {
          const id = idOfVid.get(c.tile);
          if (!id || !tab().tiles.includes(id)) return;
          switch (a) {
            case 'playPause': act.playPause(); break;
            case 'setClock': act.setClock(id); break;
            case 'setSound': act.setSound(id); break;
            case 'offset': act.openTile(id); break;
            case 'copyFrame': postHost({ type: 'copyFrame', clipId: id }); toast(c.dense ? `Tile ${c.letter} copied` : `Frame ${c.letter} copied`); break;
            case 'copyTime': act.copyTileTime(id); break;
            case 'replace': act.replace(id); break;
            case 'remove': act.removeTile(id); break;
            case 'add': act.pickVideo(); break;
            case 'leave': act.leaveCompare(); break;
            case 'keys': controls.openSheet(cogBtn); break;
            case 'settings': controls.show('main', cogBtn); break;
            default: break;
          }
        },
      });
      cleanups.push(() => tileMenu.dispose());
    }
    /** The tile under a pointer event (Split Wipe: the side of the divider), or null. */
    const tileIdAt = (/** @type {any} */ e) => {
      if (!Tiles) return null;
      const v = Tiles.tileAt(e.target, e.clientX, { stageLeft: stageEl.getBoundingClientRect().left, split: splitInfo() });
      return v === null ? null : (idOfVid.get(v) || null);
    };
    const openTileMenu = (/** @type {string} */ id, /** @type {number} */ x, /** @type {number} */ y) => {
      const t = tab();
      const off = S.getOffset(t, id);
      controls.closeAll(false);
      ctxMenu.close(false);
      tileMenu.open(x, y, {
        tile: vid(id), letter: letterOf(t, id), playing: t.playing, isClock: t.clockId === id, isSound: t.soundId === id,
        offsetHint: S.formatOffset(off).short, timeHint: fmt(shownOf(t, id).frame), dense: t.tiles.length >= DENSE_FROM,
        canAdd: t.tiles.length < t.maxVideos,
      });
    };
    listen(stageEl, 'contextmenu', (/** @type {MouseEvent} */ e) => {
      if (!tileMenu || tab().tiles.length < 2) return; // one video: ctxmenu.js's own document listener opens it
      const id = tileIdAt(e);
      if (!id) return;
      e.preventDefault();
      e.stopPropagation(); // the document's player menu stays shut
      openTileMenu(id, e.clientX, e.clientY);
    });

    // ---- actions (the bar, the keys, the menus and the panels all land here) ----
    function setRate(/** @type {number} */ r) {
      prefs.rate = W.VpeControls.clampRate(r);
      drawBar();
      controls.refresh();
      emitTransport();
    }
    function setPicture(/** @type {string} */ m) {
      prefs.picMode = m;
      commit(S.setPicMode(ws, m));
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
    /** Zoom every tile by `factor` about a stage point (client coordinates); the picture under it stays put. */
    function zoomAt(/** @type {number} */ factor, /** @type {number | null} */ cx, /** @type {number | null} */ cy) {
      const t = tab();
      const z = Math.max(S.ZOOM_MIN, Math.min(S.ZOOM_MAX, t.zoom * factor));
      if (z === t.zoom) return;
      const r = stageEl.getBoundingClientRect();
      const ox = cx === null ? 0 : cx - (r.left + r.width / 2);
      const oy = cy === null ? 0 : cy - (r.top + r.height / 2);
      const k = z / t.zoom;
      commit(S.setZoom(ws, z, ox - (ox - t.panX) * k, oy - (oy - t.panY) * k));
      controls.refresh();
    }
    /** A jump of the arrow keys: seconds, or 'frame' (one frame, paused). */
    const jumpBy = (/** @type {number | string} */ v, /** @type {number} */ dir) => (v === 'frame' ? commit(S.stepFrame(ws, dir)) : act.skip(dir * Number(v)));
    /** Reorder the tiles to `ids` (each step a player-state moveTile, so offsets and clock follow their clips). */
    const reorderTo = (/** @type {any} */ state, /** @type {string[]} */ ids) => {
      let next = state;
      ids.forEach((id, i) => {
        const from = S.getTab(next).tiles.indexOf(id);
        if (from >= 0 && from !== i) next = S.moveTile(next, from, i);
      });
      return next;
    };
    const tellOrder = () => { const t = tab(); postHost({ type: 'tileOrder', order: t.tiles.slice(), current: t.tiles[0] }); };
    /** The video a − / + key nudges in Compare: the tile under the pointer, else the one the panel shows. */
    const nudgeTarget = () => {
      const h = hover ? hover.current() : null;
      const id = h !== null && h !== undefined ? idOfVid.get(h) : null;
      return id && tab().tiles.includes(id) ? id : selected();
    };
    const act = {
      playPause: () => {
        if (vis) vis.forgetResume();
        ws = S.togglePlay(ws);
        flashPlay(tab().playing);
        render();
      },
      skip: (/** @type {number} */ sec) => commit(S.seekFrame(ws, tab().frame + Math.round(sec * fps()))),
      /** J / L: ten seconds, with the toast the player shows. */
      skipKey: (/** @type {number} */ sec) => { act.skip(sec); toast(`${sec > 0 ? '+' : ''}${sec} s`); },
      jump: (/** @type {{ dir: number, shift?: boolean }} */ o) => jumpBy(o.shift ? JUMP.shift : JUMP.arrow, o.dir),
      stepButton: (/** @type {number} */ dir) => stepBy(W.VpeControls, stepPrefs(), dir, { step: (n) => commit(S.stepFrame(ws, n)), skip: (sec) => act.skip(sec) }),
      home: () => commit(S.seekFrame(ws, 0)),
      end: () => { const t = tab(); commit(S.seekFrame(t.playing ? S.togglePlay(ws) : ws, t.maxFrame)); },
      seekTenth: (/** @type {number} */ n) => commit(S.seekFrame(ws, (n / 10) * tab().maxFrame)),
      rateStep: (/** @type {number} */ d) => { setRate(prefs.rate + d * W.VpeControls.SPEED_STEP); toast(W.VpeControls.speedText ? W.VpeControls.speedText(prefs.rate) : `${prefs.rate}×`); },
      volumeStep: (/** @type {number} */ d) => { act.volume(prefs.volume + d); toast(`Volume ${Math.round(prefs.volume * 100)}%`); },
      /** T: the shown time as m:ss.mmm (VpePlayerUiTools copyTimestamp), else in the bar's time format. */
      copyTime: () => {
        if (frameExport) { frameExport.copyTimestamp(); return; }
        const text = fmt(tab().frame); postHost({ type: 'copyText', text }); toast(`Copied ${text}`);
      },
      /** Shift+C: a link to this frame (the host turns it into a vscode:// URL). */
      copyLink: () => { if (frameExport) frameExport.copyLink(); else postHost({ type: 'copyLink' }); },
      copyTileTime: (/** @type {string} */ id) => {
        const t = tab();
        const text = `${letterOf(t, id)} ${fmt(shownOf(t, id).frame)}`;
        postHost({ type: 'copyText', text });
        toast(`Copied ${text}`);
      },
      // One video: the page grabs the frame itself (VpePlayerUiTools); Compare's view is the host's to save.
      saveFrame: () => { if (frameExport && hasSnapshot && single()) void frameExport.saveFrame(); else postHost({ type: 'saveFrame' }); },
      prevFrame: () => commit(S.stepFrame(ws, -1)),
      nextFrame: () => commit(S.stepFrame(ws, 1)),
      seek: (/** @type {number} */ f) => commit(S.seekFrame(ws, f)),
      mute: () => {
        if (!hasAudio(tab().soundId)) { toast('No audio track'); return; }
        prefs.muted = !prefs.muted;
        render();
      },
      volume: (/** @type {number} */ v) => { prefs.volume = Math.max(0, Math.min(1, v)); prefs.muted = prefs.volume === 0; render(); },
      loop: () => {
        prefs.onEnd = W.VpeAutoplay.toggleLoop ? W.VpeAutoplay.toggleLoop(prefs.onEnd) : (prefs.onEnd === 'loop' ? 'off' : 'loop');
        if (rail) rail.refreshOnEnd();
        controls.refresh();
        toast(prefs.onEnd === 'loop' ? 'Loop on' : 'Loop off');
        emitTransport();
      },
      setA: () => markAB('a'),
      setB: () => markAB('b'),
      clearAB: () => { ab.clear(); controls.refresh(); render(); toast('A–B range cleared'); },
      cycleTime: () => { prefs.timeMode = nextTimeMode(prefs.timeMode); render(); toast(TIME_MODE_NAMES[prefs.timeMode]); },
      cyclePicture: () => setPicture(PICTURE_MODES[(PICTURE_MODES.indexOf(/** @type {any} */ (tab().picMode)) + 1) % PICTURE_MODES.length]),
      copyFrame: () => {
        // The page copies the PNG itself where the clipboard API is there; else the host copies it.
        if (frameExport && hasSnapshot && single() && canClip()) { void frameExport.copyFrame(); return; }
        postHost({ type: 'copyFrame' }); toast(tab().tiles.length > 1 ? 'View copied' : 'Frame copied');
      },
      /** C (one video): subtitles on / off; the CC button (ccClick) opens Settings › Subtitles when there are none. */
      cc: () => {
        if (!subs || !single()) return false;
        subs.toggle();
        return true;
      },
      /** W: the scopes (luma waveform, RGB parade, vectorscope, histogram, off). */
      scopes: () => { if (!insp) return false; insp.cycleScopes(); return true; },
      fullscreen: () => postHost({ type: 'fullscreen' }),
      info: () => controls.toggle('info', infoBtn),
      keys: () => controls.toggleSheet(),
      gotoBox: () => { if (gotoBox) gotoBox.open(); else return false; return true; },
      /**
       * Esc closes one thing, innermost first: a tile drag, a pending "Remove?", the tile menu, the panels and the
       * player menu, the notice banner, the inspection tools (inspector, scopes, X-ray), Sync offsets, the Spotlight.
       * Nothing left: false, and the key goes on (Zen Mode's Esc Esc, then VS Code).
       */
      escape: () => {
        const t = tab();
        if (tileDrag && tileDrag.isDragging()) { tileDrag.cancel(); return true; }
        if (t.removeConfirmId) { commit(S.setRemoveConfirm(ws, null)); return true; }
        if (tileMenu && tileMenu.isOpen()) { tileMenu.close(); return true; }
        if (controls.anyOpen()) { controls.closeAll(true); return true; }
        if (ctxMenu.isOpen()) { ctxMenu.close(true); return true; }
        if (notices && notices.handleEscape()) return true;
        if (insp && insp.handleEscape()) { controls.refresh(); return true; }
        if (t.syncMode) { commit(S.toggleSyncMode(ws), 'Sync offsets off'); return true; }
        if (t.layout === 'spotlight' && t.spotlightId) { withGlide(() => commit(S.toggleEnlarge(ws, t.spotlightId))); return true; }
        return false;
      },
      capture: () => { const r = S.toggleCapture(ws); commit(r.state, r.toast); },
      split: () => commit(S.toggleSplit(ws)),
      sync: () => {
        commit(S.toggleSyncMode(ws));
        toast(tab().syncMode ? 'Sync offsets: nudge each tile with − / +, Esc to finish' : 'Sync offsets off');
      },
      layout: (/** @type {string} */ m) => {
        const t = tab();
        if (S.normalizeLayout(m) === t.layout) return;
        withGlide(() => commit(S.setLayout(ws, m)));
        const ui = S.deriveUi(tab());
        if (ui.isMulti) announce(`Layout: ${ui.layoutLabel}`);
      },
      enlarge: (/** @type {string} */ id) => withGlide(() => commit(S.toggleEnlarge(ws, id))),
      swap: () => {
        const t = tab();
        if (t.tiles.length !== 2) return false;
        withGlide(() => commit(S.swapSides(ws)));
        tellOrder();
        const n = tab();
        announce(`Swapped: ${clipName(n.tiles[0])} is A, ${clipName(n.tiles[1])} is B`);
        return true;
      },
      /** Move a tile one slot earlier (-1) or later (1): the ▲ / ▼ buttons. */
      move: (/** @type {string} */ id, /** @type {number} */ d) => {
        const t = tab();
        const from = t.tiles.indexOf(id);
        const to = from + d;
        if (from < 0 || to < 0 || to >= t.tiles.length) return;
        withGlide(() => commit(S.moveTile(ws, from, to)));
        tellOrder();
        announce(`Moved ${clipName(id)} to ${S.TILE_KEYS[to]}`);
      },
      removeTile: (/** @type {string} */ id) => {
        const t = tab();
        if (t.tiles.length <= 1 || !t.tiles.includes(id)) return;
        // Leaving 2 videos for 1 is the way back to the single player: it keeps the clock (S.removeTile, unified).
        const r = S.removeTile(ws, id);
        commit(r.state, r.toast || `Removed ${clipName(id)}`);
      },
      /** The tile's remove button: from 3 videos on the first click asks "Remove?" and the second removes. */
      removeClick: (/** @type {string} */ id) => {
        const t = tab();
        if (t.tiles.length > 2 && t.removeConfirmId !== id) { commit(S.setRemoveConfirm(ws, id)); announce(`Remove ${clipName(id)}? Click again to remove`); return; }
        act.removeTile(id);
      },
      nudge: (/** @type {string} */ id, /** @type {number} */ d) => {
        commit(S.nudgeOffset(ws, id, d, clipFps(id)));
        const t = tab();
        announce(`${letterOf(t, id)} ${S.formatOffset(S.getOffset(t, id)).long}`);
      },
      setClock: (/** @type {string} */ id) => {
        const next = S.setClock(ws, id);
        if (next === ws) return;
        commit(next);
        announce(`${letterOf(tab(), id)} sets the clock`);
      },
      setSound: (/** @type {string} */ id) => {
        if (!hasAudio(id)) { toast(`No audio track in ${letterOf(tab(), id)}`); return; }
        const was = tab().soundId;
        if (was === id) { prefs.muted = !prefs.muted; render(); toast(prefs.muted ? 'Muted' : `Sound from ${letterOf(tab(), id)}`); return; }
        prefs.muted = false;
        commit(S.setSound(ws, id), `Sound from ${letterOf(tab(), id)}`);
      },
      toggleStats: (/** @type {string} */ id) => commit(S.toggleTileStats(ws, id)),
      openTile: (/** @type {string} */ id) => { selId = id; controls.show('cmpVid', cmpBtn); },
      replace: (/** @type {string} */ id) => postHost({ type: 'replaceVideo', oldId: id, exclude: tab().tiles.slice() }),
      leaveCompare: () => {
        const t = tab();
        const keepId = t.clockId || t.tiles[0];
        const r = S.leaveCompare(ws, keepId);
        if (r.state === ws) return;
        postHost({ type: 'leaveCompare', keepId, t: t.frame / fps() });
        commit(r.state, r.toast);
      },
      /** − / +: Compare nudges the hovered (else the selected) tile; the single player zooms. */
      minus: () => { if (tab().tiles.length >= 2) act.nudge(nudgeTarget(), -1); else zoomAt(1 / ZOOM_STEP, null, null); },
      plus: () => { if (tab().tiles.length >= 2) act.nudge(nudgeTarget(), 1); else zoomAt(ZOOM_STEP, null, null); },
      zoomAt: (/** @type {number} */ factor, /** @type {number} */ cx, /** @type {number} */ cy) => zoomAt(factor, cx, cy),
      resetView: () => commit(S.resetView(ws)),
      pickVideo: () => postHost(pickVideoMessage('unified', { exclude: tab().tiles })),
      nextVideo: () => goNeighbour(rail, postHost, 1),
      prevVideo: () => goNeighbour(rail, postHost, -1),
    };
    /** The capture banner's and the add slot's "pick a video": the Folder Rail, else the host's picker. */
    const openPicker = () => { if (rail) rail.open(); else act.pickVideo(); };
    /** @type {Record<string, (...a: any[]) => any>} */
    const dispatchTable = act;
    /** The shared key table (keyCommand) over this page's actions; a key's argument, if any, is the first one. */
    /** @type {Record<string, (arg: any, e: any) => any>} */
    const keyTable = {};
    for (const [name, f] of Object.entries(act)) {
      const fn = /** @type {(...a: any[]) => any} */ (f);
      keyTable[name] = (/** @type {any} */ arg) => (arg === undefined ? fn() : fn(arg));
    }
    keyTable.skip = (/** @type {number} */ sec) => act.skipKey(sec);

    // ---- the real #bar ----
    const onClick = (/** @type {any} */ el, /** @type {(e?: any) => void} */ fn) => listen(el, 'click', fn);
    bindButtons([
      [cmpBtn, act.capture, true], [splitBtn, () => act.layout(tab().layout === 'split' ? 'grid' : 'split'), true],
      [spotBtn, () => act.layout('spotlight'), true], [gridBtn, () => act.layout('grid'), true], [swapBtn, act.swap, true],
      [syncBtn, act.sync, true],
      [playBtn, act.playPause, true], [prevBtn, () => act.stepButton(-1), true], [nextBtn, () => act.stepButton(1), true],
      [muteBtn, act.mute, true], [timeEl, act.cycleTime, true], [setABtn, act.setA, true], [setBBtn, act.setB, true],
      [cogBtn, () => controls.toggle('main', cogBtn), true], [infoBtn, act.info, true],
      [rateBtn, () => controls.toggle('speed', rateBtn), true], [tracksBtn, () => ccClick(), true],
      [picBtn, act.cyclePicture, true], [fullBtn, act.fullscreen, true],
    ], onClick);
    bindStepBadges([prevSize, nextSize], (b) => controls.toggle('step', b), (el, type, fn) => listen(el, type, fn));
    if (volEl) listen(volEl, 'input', () => act.volume(Number(volEl.value)));
    listen(seekEl, 'input', () => act.seek(Number(seekEl.value)));
    if (capBanner) {
      const stopBtn = capBanner.querySelector('[data-act="pause"]') || $('capStopBtn');
      const pickBtn = capBanner.querySelector('[data-act="pick"]') || $('capPickBtn');
      bindButtons([[stopBtn, act.capture, true], [pickBtn, () => openPicker(), true]], onClick);
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

    // ---- seek bar hover tip and thumbnail (media/player-ui-input.js) ----
    /** @type {any} */
    let thumbCanvas = null;
    if (Input && tipEl && typeof engine.thumbnail === 'function') {
      thumbCanvas = doc.createElement('canvas');
      thumbCanvas.className = 'seek-thumb';
      thumbCanvas.hidden = true;
      thumbCanvas.setAttribute('aria-hidden', 'true');
      if (tipEl.parentNode) tipEl.parentNode.insertBefore(thumbCanvas, tipEl);
      cleanups.push(() => { if (thumbCanvas.parentNode) thumbCanvas.parentNode.removeChild(thumbCanvas); });
    }
    const seekHover = Input && tipEl ? Input.bindSeekHover({
      seekEl, tipEl, thumbCanvas, win,
      getInfo: () => {
        const t = tab();
        return { frames: t.maxFrame + 1, fps: fps(), duration: t.maxFrame / fps(), letter: t.tiles.length >= 2 ? letterOf(t, t.clockId) : undefined, formatTime: clockText };
      },
      onThumbnail: thumbCanvas ? (/** @type {number} */ sec, /** @type {any} */ cv, /** @type {boolean} */ scrubbing, /** @type {{ px: number }} */ place) => {
        cv.hidden = false;
        cv.style.left = `${place.px}px`;
        /** @type {any} */ (engine).thumbnail(tab().clockId || tab().tiles[0], sec, cv, scrubbing);
      } : undefined,
      onThumbnailLeave: (/** @type {boolean} */ immediate) => {
        if (thumbCanvas) thumbCanvas.hidden = true;
        if (typeof engine.thumbnailLeave === 'function') engine.thumbnailLeave(immediate);
      },
    }) : null;
    if (seekHover) cleanups.push(() => seekHover.dispose());

    // ---- Spotlight splitter (along tab.dock) and Split Wipe divider ----
    /** When a splitter drag ended: the click that follows is not a play / pause. */
    let splitterEndedAt = -Infinity;
    if (splitterEl) {
      /** @type {{ id: number } | null} */
      let sDrag = null;
      const ratioFrom = (/** @type {any} */ ev) => {
        const r = stageEl.getBoundingClientRect();
        const w = Math.max(1, r.width - S.GAP), h = Math.max(1, r.height - S.GAP);
        return spotlightRatioAt(tab().dock, ev.clientX - r.left, ev.clientY - r.top, w, h);
      };
      listen(splitterEl, 'pointerdown', (/** @type {any} */ e) => {
        if (e.button !== 0 || sDrag || tab().layout !== 'spotlight') return;
        e.preventDefault();
        e.stopPropagation();
        sDrag = { id: e.pointerId };
        splitterEl.classList.add('dragging');
        try { splitterEl.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
      });
      listen(splitterEl, 'pointermove', (/** @type {any} */ e) => {
        if (!sDrag || e.pointerId !== sDrag.id) return;
        commit(S.setHeroRatio(ws, ratioFrom(e)));
      });
      const endS = (/** @type {any} */ e) => {
        if (!sDrag || (e && e.pointerId !== undefined && e.pointerId !== sDrag.id)) return;
        const id = sDrag.id;
        sDrag = null;
        splitterEl.classList.remove('dragging');
        try { if (splitterEl.hasPointerCapture(id)) splitterEl.releasePointerCapture(id); } catch { /* synthetic pointer */ }
        splitterEndedAt = Date.now();
      };
      listen(splitterEl, 'pointerup', endS);
      listen(splitterEl, 'pointercancel', endS);
      listen(splitterEl, 'click', (/** @type {any} */ e) => e.stopPropagation());
      listen(splitterEl, 'dblclick', (/** @type {any} */ e) => { e.stopPropagation(); commit(S.setHeroRatio(ws, S.HERO_DEFAULT)); });
      // The same keys as Compare's splitter (media/compare.js): arrows along the dock, Shift for big steps, Home / End.
      listen(splitterEl, 'keydown', (/** @type {KeyboardEvent} */ e) => {
        const next = spotlightKeyRatio(e, tab().dock, tab().heroRatio, 0.1, 0.9);
        if (next === null) return;
        e.preventDefault(); e.stopPropagation();
        commit(S.setHeroRatio(ws, next));
      });
    }
    // The Split Wipe divider: the same binding as media/compare.js, over the picture as shown (letterboxing).
    /** @type {{ x: number, w: number } | null} */
    let lastSplitPic = null;
    bindSplitDivider(dividerEl, {
      stageRect: () => stageEl.getBoundingClientRect(),
      pictureRect: () => lastSplitPic,
      get: () => tab().split,
      set: (r) => commit(S.setSplitRatio(ws, r)),
      onDragEnd: (moved) => { if (moved) splitterEndedAt = Date.now(); },
      listen: (el, type, fn) => listen(el, type, fn),
    });
    /** Split Wipe for the tile modules: [A, B] video numbers and the divider over the picture. */
    const splitInfo = () => {
      const t = tab();
      if (t.layout !== 'split' || t.tiles.length !== 2 || !lastSplitPic) return null;
      return { tiles: [vid(t.tiles[0]), vid(t.tiles[1])], picX: lastSplitPic.x, picW: lastSplitPic.w, ratio: t.split };
    };

    // ---- the tile under the pointer: a pending "Remove?" is cancelled when the pointer leaves its tile ----
    const hover = Tiles ? Tiles.hoverTracker({
      cellsEl, stage: stageEl, getSplit: splitInfo,
      onChange: (/** @type {number | null} */ _next, /** @type {number | null} */ prev) => {
        const t = tab();
        if (prev !== null && t.removeConfirmId && idOfVid.get(prev) === t.removeConfirmId) commit(S.setRemoveConfirm(ws, null));
      },
    }) : null;
    if (hover) cleanups.push(() => hover.dispose());

    // ---- tile drag: reorder, Spotlight swap, Spotlight edge dock (media/player-ui-tiles.js bindTileDrag) ----
    /** @type {{ order: string[], dock: string, video: number, dx: number, dy: number } | null} */
    let preview = null;
    /** @type {any} */
    let skeletonEl = null;
    const showSkeleton = (/** @type {any} */ sk) => {
      if (!sk) { if (skeletonEl) skeletonEl.hidden = true; return; }
      if (!skeletonEl) {
        skeletonEl = doc.createElement('div');
        skeletonEl.className = 'skeleton';
        skeletonEl.innerHTML = '<span class="skeleton-label"></span>';
        stageEl.appendChild(skeletonEl);
        cleanups.push(() => { if (skeletonEl.parentNode) skeletonEl.parentNode.removeChild(skeletonEl); });
      }
      skeletonEl.hidden = false;
      Object.assign(skeletonEl.style, { left: `${sk.rect.x}px`, top: `${sk.rect.y}px`, width: `${sk.rect.w}px`, height: `${sk.rect.h}px` });
      skeletonEl.firstChild.textContent = sk.label;
    };
    /** Drag order: the Spotlight main tile first (the tile module's hero is order[0]), then the slots. */
    const dragOrder = () => {
      const t = tab();
      const ids = t.layout === 'spotlight' && t.spotlightId ? [t.spotlightId, ...t.tiles.filter((x) => x !== t.spotlightId)] : t.tiles;
      return ids.map(vid);
    };
    /** A tab drawn in `order` (video numbers) with `dock`: the state the drop would make. */
    const tabFor = (/** @type {number[]} */ order, /** @type {string} */ dock) => {
      const t = tab();
      const ids = order.map((v) => /** @type {string} */ (idOfVid.get(v)));
      return { ...t, tiles: ids, dock, spotlightId: t.layout === 'spotlight' ? ids[0] : null };
    };
    const stageSize = () => ({ width: stageEl.clientWidth || 680, height: stageEl.clientHeight || 370 });
    const tileDrag = Tiles ? Tiles.bindTileDrag({
      stage: stageEl, cellsEl, win, grid: Grid,
      getLayout: () => ({ mode: S.deriveUi(tab()).effectiveLayout, dock: tab().dock }),
      getOrder: dragOrder,
      getCells: (/** @type {number[]} */ order, /** @type {string} */ dock) => S.deriveUi(tabFor(order, dock), stageSize()).cells
        .map((/** @type {any} */ c) => ({ x: c.x, y: c.y, w: c.w, h: c.h, tiles: [vid(c.clipId)] })),
      isZoomed: () => tab().zoom !== 1,
      onBusyChange: (/** @type {boolean} */ busy) => {
        if (!busy) return;
        controls.closeAll(false);
        ctxMenu.close(false);
        if (tileMenu) tileMenu.close();
        if (tab().removeConfirmId) commit(S.setRemoveConfirm(ws, null));
      },
      onPreview: (/** @type {any} */ p) => {
        const changed = !preview || p.changed;
        preview = { order: p.order.map((/** @type {number} */ v) => /** @type {string} */ (idOfVid.get(v))), dock: p.dock, video: p.video, dx: p.dx, dy: p.dy };
        showSkeleton(p.skeleton);
        if (changed) withGlide(render, preview.order.find((id) => vid(id) === p.video) || null); else render();
      },
      onCommitOrder: (/** @type {number[]} */ order) => {
        preview = null;
        showSkeleton(null);
        const ids = order.map((v) => /** @type {string} */ (idOfVid.get(v)));
        const t = tab();
        withGlide(() => {
          let next = reorderTo(ws, ids);
          if (t.layout === 'spotlight' && S.getTab(next).spotlightId !== ids[0]) next = S.toggleEnlarge(next, ids[0]);
          commit(next);
        });
        tellOrder();
        const moved = ids.find((id, i) => t.tiles[i] !== id);
        if (t.layout === 'spotlight' && t.spotlightId !== ids[0]) announce(`${clipName(ids[0])} in Spotlight`);
        else if (moved) announce(`Moved ${clipName(moved)} to ${letterOf(tab(), moved)}`);
      },
      onCommitDock: (/** @type {string} */ edge) => {
        preview = null;
        showSkeleton(null);
        withGlide(() => commit(S.setDock(ws, edge)));
        announce(`Spotlight docked ${edge}`);
      },
      onCancel: () => { preview = null; showSkeleton(null); withGlide(render); },
    }) : null;
    if (tileDrag) cleanups.push(() => tileDrag.dispose());

    // ---- wheel: step while paused, Ctrl+wheel zoom about the pointer, drag to pan a zoomed picture ----
    let panLast = { dx: 0, dy: 0 };
    const wheelPan = Input ? Input.bindStageWheelAndPan({
      stage: stageEl, win,
      isPlaying: () => tab().playing,
      isZoomed: () => tab().zoom !== 1,
      isBlocked: () => !!(tileDrag && tileDrag.isDragging()),
      getZoom: () => tab().zoom,
      onStepWheel: (/** @type {number} */ dir, /** @type {boolean} */ shift) => (shift ? act.jump({ dir, shift: true }) : commit(S.stepFrame(ws, dir))),
      onZoomWheel: (/** @type {number} */ factor, /** @type {number} */ cx, /** @type {number} */ cy) => zoomAt(factor, cx, cy),
      onPanStart: () => { panLast = { dx: 0, dy: 0 }; return true; },
      onPanMove: (/** @type {number} */ dx, /** @type {number} */ dy) => {
        const next = S.panBy(ws, dx - panLast.dx, dy - panLast.dy);
        panLast = { dx, dy };
        commit(next);
      },
    }) : null;
    if (wheelPan) cleanups.push(() => wheelPan.dispose());
    /** The click after a tile drag, a pan or a splitter drag is its release, not a play / pause. */
    const consumeDragClick = () => (tileDrag && tileDrag.wasRecentDrag())
      || (wheelPan && wheelPan.wasRecentPan()) || Date.now() - splitterEndedAt < DRAG_CLICK_MS;

    // ---- fullscreen idle bar, Zen Mode Esc Esc, auto-pause hidden tabs, the go-to box ----
    const idle = Input ? Input.createIdleController({ doc, win, isPlaying: () => tab().playing }) : null;
    if (idle) cleanups.push(() => idle.dispose());
    const zen = Input ? Input.createZenEscTracker({ win, onExitZen: () => postHost({ type: 'focusModeExited' }) }) : null;
    const vis = Input ? Input.createVisibilityController({
      doc, win,
      isPlaying: () => tab().playing,
      onAutoPause: () => { ws = S.togglePlay(ws); render(); },
      onAutoResume: () => { if (!tab().playing) { ws = S.togglePlay(ws); render(); } },
      onHideCleanup: () => {
        if (seekHover) seekHover.cancel(true);
        if (tileDrag) tileDrag.cancel();
        if (wheelPan) wheelPan.cancel();
      },
    }) : null;
    if (vis) cleanups.push(() => vis.dispose());
    /** @type {any} */
    let gotoBox = null;
    if (Input) {
      const boxEl = doc.createElement('div');
      boxEl.id = 'goto';
      boxEl.hidden = true;
      boxEl.innerHTML = '<input id="gotoInput" type="text" autocomplete="off" spellcheck="false" aria-label="Go to frame, time or percent" placeholder="Frame, 1:23.4 or 50%">';
      stageEl.appendChild(boxEl);
      cleanups.push(() => { if (boxEl.parentNode) boxEl.parentNode.removeChild(boxEl); });
      gotoBox = Input.createGotoBox({
        doc, win, inputEl: boxEl.querySelector('input'), boxEl,
        getClipMeta: () => { const t = tab(); return { fps: fps(), duration: t.maxFrame / fps(), frames: t.maxFrame + 1, current: t.frame }; },
        onSeek: (/** @type {any} */ g) => {
          const base = tab().playing ? S.togglePlay(ws) : ws;
          commit(S.seekFrame(base, 'frame' in g ? g.frame : Math.round(g.time * fps())));
        },
        onToast: toast,
        formatTime: clockText,
      });
      cleanups.push(() => gotoBox.dispose());
    }

    // ---- tools (media/player-ui-tools.js): the notice banner, inspection, subtitles, frame save / copy / export ----
    const hostPort = { postMessage: (/** @type {any} */ m) => postHost(m) };
    const hasSnapshot = typeof engine.snapshot === 'function';
    const canClip = () => !!(win.navigator && win.navigator.clipboard && typeof win.ClipboardItem === 'function');
    /** An optional engine method as a plain function (missing ones stay undefined: the tools then say so). */
    const engineFn = (/** @type {string} */ name) => {
      const e = /** @type {any} */ (engine);
      return typeof e[name] === 'function' ? (/** @type {any[]} */ ...a) => e[name](...a) : undefined;
    };
    /** The engine as the tool controllers read it: a still of the shown frame as bytes, frame k shown paused. */
    const toolEngine = {
      statsText: engineFn('statsText'), packetIndex: engineFn('packetIndex'), chapters: engineFn('chapters'),
      pixelAt: engineFn('pixelAt'), cueAt: engineFn('cueAt'), selectSubtitle: engineFn('selectSubtitle'),
      snapshot: hasSnapshot ? (/** @type {string} */ id) => {
        const s = /** @type {any} */ (engine).snapshot(id, shownOf(tab(), id).frame);
        return s && s.data !== undefined ? s.data : s;
      } : undefined,
      /**
       * Frame k of clip `id`, paused. With a decoder (engine.showFrame) the answer waits for the frame it really
       * presented (VFR or gapped video can land on a neighbour), and the bar then shows that one.
       */
      showFrame: (/** @type {string} */ id, /** @type {number} */ k, /** @type {any} */ opts) => {
        if (typeof engine.showFrame !== 'function') {
          commit(S.seekFrame(tab().playing ? S.togglePlay(ws) : ws, k));
          return shownOf(tab(), id).frame;
        }
        if (tab().playing) commit(S.togglePlay(ws));
        const signal = opts && opts.signal;
        return Promise.resolve(/** @type {any} */ (engine).showFrame(id, k, { signal })).then((/** @type {any} */ f) => {
          if (typeof f !== 'number' || !Number.isFinite(f)) return null;
          const t = tab();
          if (!disposed && !(signal && signal.aborted) && t.tiles.includes(id)) {
            quietly(() => commit(S.seekFrame(ws, clockFrameOf(t, id, f))));
          }
          return f;
        });
      },
    };
    /** Before an exact pixel tool or a still: offer the full-resolution picture once (media/player.js exactTool). */
    const exactTool = () => {
      if (!notices || typeof engine.pictureInfo !== 'function') return;
      const info = engine.pictureInfo(tab().tiles[0]);
      if (info) notices.maybeShowReducedRes(info);
    };
    /** The saved state: debounced, and only when the page has a store (persist runs on every change). */
    const snapshotState = () => {
      const t = tab();
      return {
        ...(prefsSync ? prefsSync.loadSaved() : {}), ...playbackPrefsNow(), clipId: t.tiles[0], time: t.frame / fps(),
        dismissals: notices ? notices.getDismissals() : saved.dismissals || {},
        subs: subs ? { track: subs.getState().track, delayMs: subs.getState().delayMs, sizePct: subs.getState().sizePct } : saved.subs,
      };
    };
    const persist = () => { if (prefsSync && storage && !disposed) prefsSync.scheduleSave(snapshotState()); };
    const playbackPrefsNow = () => ({ volume: prefs.volume, rate: prefs.rate, timeMode: prefs.timeMode, stepSize: prefs.stepSize });
    const stageEls = /** @type {any[]} */ ([]);
    const ownEl = (/** @type {string} */ tag, /** @type {string} */ cls) => {
      const x = doc.createElement(tag);
      x.className = cls;
      x.hidden = true;
      stageEl.appendChild(x);
      stageEls.push(x);
      return x;
    };
    cleanups.push(() => { for (const x of stageEls.splice(0)) if (x.parentNode) x.parentNode.removeChild(x); });
    if (Tools) {
      const noticeEl = $('notice');
      if (noticeEl) {
        notices = Tools.createNoticeController({
          // create() routes Esc itself (escape: the banner after the panels), so the banner adds no key listener.
          doc: {
            createElement: (/** @type {string} */ t) => doc.createElement(t),
            get activeElement() { return doc.activeElement; },
            addEventListener() {}, removeEventListener() {},
          },
          win, noticeEl, playBtnEl: playBtn,
          reducedResHelper: W.VpeReducedResNotice || undefined, slowHelper: W.VpeSlowNotice || undefined,
          onAction: (/** @type {string} */ id, /** @type {any} */ detail) => postHost({ type: 'action', id, ...(detail || {}) }),
          onDismiss: () => persist(),
          onAnnounce: announce,
          dismissals: saved.dismissals,
        });
        cleanups.push(() => notices.dispose());
      }
      const iw = env.inspectWidgets || {};
      insp = Tools.createInspectionController({
        doc, win, engine: toolEngine, host: hostPort,
        widgets: { ...iw, stats: iw.stats || $('stats') || ownEl('pre', 'stats') },
        // Compare: the tile under the pointer, else the one the panel shows.
        getActiveClip: () => (single() ? tab().tiles[0] : nudgeTarget()),
        getFrame: () => ({ frame: tab().frame, t: tab().frame / fps() }),
        onToast: toast,
        onSeek: (/** @type {number} */ sec) => commit(S.seekFrame(ws, Math.round(sec * fps()))),
        onBeforeInspect: exactTool,
        isSingle: single,
        listen: false, // the page's key handler routes the tool keys (keyCommand has W and X, Esc has an order)
      });
      cleanups.push(() => insp.dispose());
      const subsEl = $('subs');
      if (subsEl) {
        subs = Tools.createSubtitleController({
          doc, win, subsEl, engine: toolEngine, host: hostPort,
          getClipId: () => tab().tiles[0],
          getTime: () => tab().frame / fps(),
          getPictureRect: () => {
            const t = tab();
            const { width, height } = stageSize();
            return typeof engine.pictureRect === 'function'
              ? engine.pictureRect(t.tiles[0], width, height, t.picMode, t.zoom, t.panX, t.panY) : { x: 0, y: 0, w: width, h: height };
          },
          onToast: toast,
          onUpdate: () => { drawBar(); controls.refresh(); persist(); },
          onOpenPage: (/** @type {string} */ page) => {
            if (controls.view() === page) controls.close(true); else controls.show(page, tracksBtn || cogBtn);
          },
          saved: saved.subs,
        });
        cleanups.push(() => subs.dispose());
      }
      frameExport = Tools.createFrameExportController({
        win, engine: toolEngine, host: hostPort,
        getContext: (/** @type {any} */ clipId) => {
          const t = tab();
          const id = clipId !== undefined && t.tiles.includes(clipId) ? clipId : (t.clockId || t.tiles[0]);
          if (!id) return null;
          const f = shownOf(t, id).frame;
          const r = clipFps(id);
          return { clipId: id, frame: f, t: f / r, fps: r, compare: t.tiles.length > 1, page: env.page };
        },
        onToast: toast,
        onPause: () => { if (tab().playing) { ws = S.togglePlay(ws); render(); } },
        onBeforeSnapshot: exactTool,
        getRange: (/** @type {string} */ kind) => (kind === 'clipRange' ? ab.presentationRange() : ab.exportRange(fps(), tab().maxFrame + 1)),
        onRefuse: () => { if (notices) notices.showClipRefusal({ syntheticTimes: true }); },
      });
      cleanups.push(() => frameExport.dispose());
    }
    /** The CC button: subtitles on / off, or Settings › Subtitles when there are none (media/player.js ccClick). */
    const ccClick = () => { if (subs) subs.ccClick(); else controls.toggle('subs', tracksBtn); };
    /** A click on the picture with the pixel inspector on copies the pixel under it (picture coordinates). */
    const pickPixel = (/** @type {any} */ e, /** @type {string} */ id) => {
      const t = tab();
      const sr = stageEl.getBoundingClientRect();
      const { width, height } = stageSize();
      const pic = typeof engine.pictureRect === 'function'
        ? engine.pictureRect(id, width, height, t.picMode, t.zoom, t.panX, t.panY) : { x: 0, y: 0, w: width, h: height };
      const c = /** @type {any} */ (engine.getClip(id) || {});
      const nat = typeof engine.naturalSize === 'function' ? engine.naturalSize(id) : { width: c.width || pic.w, height: c.height || pic.h };
      if (!(pic.w > 0 && pic.h > 0)) return false;
      const x = Math.floor(((e.clientX - sr.left - pic.x) / pic.w) * nat.width);
      const y = Math.floor(((e.clientY - sr.top - pic.y) / pic.h) * nat.height);
      return insp.pickAt(x, y);
    };

    // ---- lifecycle (media/player-ui-lifecycle.js): prefs sync, frame links / resume, rail handoff, overlay ----
    if (Life) {
      /** Without a store the prefs still sync between tabs; nothing is written. */
      let mem = {};
      const memStore = { getState: () => mem, setState: (/** @type {any} */ s) => { mem = s; } };
      prefsSync = Life.createPrefsSync({
        win, host: hostPort, storage: storage || memStore,
        // Another tab changed a shared pref: apply it quietly (drawBar's publish then finds nothing new).
        onApplyPlaybackPrefs: (/** @type {any} */ p) => {
          if (p.volume !== undefined) prefs.volume = p.volume;
          if (p.rate !== undefined) prefs.rate = W.VpeControls.clampRate(p.rate);
          if (p.timeMode !== undefined) prefs.timeMode = p.timeMode;
          if (p.stepSize !== undefined) prefs.stepSize = p.stepSize;
          render();
          controls.refresh();
        },
        // VS Code's settings changed: the jump sizes, what the step buttons step, Live transcode.
        onApplyLivePrefs: (/** @type {any} */ p) => {
          if (p.jump) {
            for (const k of /** @type {const} */ (['arrow', 'shift', 'ctrl'])) {
              const v = p.jump[k];
              if (v === 'frame') JUMP[k] = 'frame';
              else if (Number(v) > 0) JUMP[k] = Number(v);
            }
          }
          if (p.stepButtons) stepButtons = p.stepButtons;
          if (p.transcode) prefs.transcodeMode = p.transcode;
          if (p.transcodeMaxBitrate !== undefined) prefs.transcodeMaxBitrate = p.transcodeMaxBitrate;
          if (p.transcodeResolution !== undefined) prefs.transcodeRes = p.transcodeResolution;
          drawBar();
          controls.refresh();
        },
      });
      prefsSync.seed(playbackPrefsNow());
      cleanups.push(() => { if (storage) prefsSync.saveNow(snapshotState()); prefsSync.dispose(); });
      gotoResume = Life.createGotoAndResume({
        // A frame link opens paused on its frame (1-based in links, 0-based in the state).
        onSeek: (/** @type {any} */ g) => {
          const base = tab().playing ? S.togglePlay(ws) : ws;
          commit(S.seekFrame(base, 'frame' in g ? g.frame - 1 : Math.round(g.time * fps())));
        },
        onSetLayout: (/** @type {string} */ m) => { if (!single()) act.layout(m); },
        onToast: toast,
      });
      railCtl = Life.createRailHandoffController({
        host: hostPort, rail,
        onSetAutoplay: setOnEnd,
        onPlayFromStart: () => {
          const base = S.seekFrame(ws, 0);
          commit(S.getTab(base).playing ? base : S.togglePlay(base));
        },
      });
      if (env.railCarry) railCtl.adoptCarry(env.railCarry);
      const overlayEl = $('overlay'), messageEl = $('message'), hintEl = $('hint');
      if (overlayEl && messageEl && hintEl) {
        overlay = Life.createOverlayController({
          doc, overlayEl, messageEl, hintEl, actionEl: $('action') || undefined, host: hostPort, onAnnounce: announce,
        });
      }
      bridge = Life.createLifecycleBridge({
        win, host: hostPort,
        onPauseForTest: () => { if (!tab().playing) return false; ws = S.togglePlay(ws); render(); return true; },
        onToast: toast,
        onDispose: () => disposeAll(),
      });
      cleanups.push(() => bridge.dispose());
    }
    /** The tile size the host decodes for (native ffmpeg scales to it): the first cell, in device pixels. */
    let lastTileSizeKey = /** @type {string | null} */ (null);
    const tileNow = () => {
      const t = tab();
      const ui = S.deriveUi(t, stageSize());
      const c = ui.cells[0];
      if (!c) return null;
      const dpr = win.devicePixelRatio || 1;
      return { w: Math.round(c.w * dpr), h: Math.round(c.h * dpr), n: ui.n, layout: ui.effectiveLayout, zoom: t.zoom, rate: prefs.rate };
    };
    /** Layout, size, zoom or speed changed: tell the host after a quiet spell (the first size is the page's own). */
    const checkTileSize = () => {
      if (!bridge) return;
      const tile = tileNow();
      const key = tile ? JSON.stringify(tile) : '';
      if (key === lastTileSizeKey) return;
      const first = lastTileSizeKey === null;
      lastTileSizeKey = key;
      if (!first && tile) bridge.scheduleTileSize(tileNow, prefs.transcodeMode !== 'always');
    };
    /** The clip this single page shows: the rail learns its size once, a waiting handoff may apply, X-ray reloads. */
    let lastSeedId = /** @type {string | null} */ (null);
    const seedClip = () => {
      const t = tab();
      if (t.tiles.length !== 1 || t.tiles[0] === lastSeedId) return;
      lastSeedId = t.tiles[0];
      if (insp) insp.refresh({ clipChanged: true });
      if (!railCtl) return;
      const c = /** @type {any} */ (engine.getClip(lastSeedId) || {});
      const r = c.fps || fps();
      railCtl.resetClip();
      railCtl.seedSelf({ duration: (c.frames || t.maxFrame + 1) / r, width: c.width, height: c.height, codec: c.codec });
      railCtl.markReady();
    };

    /** Keys of the tool controllers: inspection (W, X with one video, Shift+X, Shift+I, { }, PageUp / PageDown) and subtitles. */
    const INSPECT_KEYS = new Set(['w', 'W', 'x', 'X', 'I', '{', '}', 'PageUp', 'PageDown']);
    const SUB_KEYS = new Set(['c', 'C', 'v', 'V', 'g', 'G', 'h', 'H']);
    const toolKey = (/** @type {any} */ e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) {
        // AltGr types { } on many layouts: the inspection controller accepts it.
        if (!(e.getModifierState && e.getModifierState('AltGraph'))) return false;
      }
      if (e.shiftKey && (e.key === 'C' || e.key === 'c') && !e.ctrlKey && !e.altKey) { act.copyLink(); return true; }
      if (insp && INSPECT_KEYS.has(e.key) && insp.handleKey(e)) { controls.refresh(); return true; }
      if (subs && single() && SUB_KEYS.has(e.key)) return subs.handleKey(e);
      return false;
    };

    // ---- keyboard shortcuts ----
    listen(env.keyTarget || doc, 'keydown', (/** @type {KeyboardEvent} */ e) => {
      // Typing in a field (the rail filter), a list box, or Space / Enter on a focused button: not player keys.
      if (W.VpeModes && W.VpeModes.ownsKey) { if (W.VpeModes.ownsKey(e)) return; } else {
        const t = /** @type {any} */ (e.target);
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      }
      // A tile drag took this Esc itself.
      if (e.key === 'Escape' && e.defaultPrevented) return;
      // Ctrl / Cmd keys the shared table leaves to VS Code, except the player's own: ←/→ jump, C copy, G go to.
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey) {
        const k = e.key;
        let used = false;
        if (k === 'ArrowLeft' || k === 'ArrowRight') { jumpBy(JUMP.ctrl, k === 'ArrowLeft' ? -1 : 1); used = true; }
        else if (k === 'c' || k === 'C') { act.copyFrame(); used = true; }
        else if (k === 'g' || k === 'G') used = act.gotoBox() !== false;
        if (used) { e.preventDefault(); return; }
      }
      if (toolKey(e)) { e.preventDefault(); return; }
      const altGr = !!(e.getModifierState && e.getModifierState('AltGraph'));
      if (runKey(e, keyTable, { altGr })) { e.preventDefault(); return; }
      if (zen && e.key === 'Escape') zen.onKey(e);
    });

    // ---- the stage: one cell per tile, from deriveUi ----
    // Cells are kept per clip while the structure (single / multi, Split or not) holds, so a click lands mid-playback
    // and reorder, swap, dock and layout changes glide the same elements (FLIP) instead of rebuilding them.
    let lastCellsKey = '';
    /** @type {Map<string, { cell: any, cv: any, ov: any, stats: any, move: any, frEl: any, offEl: any, ovKey: string, statsKey: string }>} */
    const cellNodes = new Map();
    /** @type {any} */
    let addSlotNode = null;
    /** The pending single click of a tile (see DBLCLICK_MS). */
    let clickTimer = 0;
    const DBLCLICK_MS = 250;
    cleanups.push(() => { if (clickTimer) win.clearTimeout(clickTimer); });
    const NOT_A_TILE_CLICK = 'button, .tile-stats, #menu';

    /** The clock frame at which tile `id` shows its frame `f` (shownOf the other way round). */
    function clockFrameOf(/** @type {any} */ t, /** @type {string} */ id, /** @type {number} */ f) {
      const off = S.getOffset(t, id);
      const r = clipFps(id);
      const offFrames = off.unit === 'ms' ? (off.v / 1000) * r : off.v;
      return Math.round(((f - offFrames) / r) * (t.fps || fps()));
    }

    /** The frame a tile shows at the clock frame (offset in frames or ms), and whether it is past either end. */
    function shownOf(/** @type {any} */ t, /** @type {string} */ id) {
      const off = S.getOffset(t, id);
      if (typeof engine.shownFrame === 'function') {
        // The clock frame counts frames of the clock tile: its rate goes along (Compare may mix 24 and 60 fps).
        const r = engine.shownFrame(id, t.frame, off, t.fps || fps());
        if (r && r.frame !== null) return { frame: r.frame, out: !!r.outOfRange };
        const f = t.frame + (off.unit === 'ms' ? Math.round((off.v / 1000) * clipFps(id)) : off.v);
        return { frame: Math.max(0, f), out: true };
      }
      const f = t.frame + (off.unit === 'ms' ? Math.round((off.v / 1000) * clipFps(id)) : off.v);
      return { frame: Math.max(0, f), out: f < 0 || f > t.maxFrame };
    }

    /** One tile's overlay markup (Compare's pill, ⓘ, sound, remove, nudge, ▲ / ▼), as media/compare.js draws it. */
    function overlayHtml(/** @type {any} */ t, /** @type {any} */ r, /** @type {any} */ ui) {
      const id = r.clipId;
      const v = vid(id);
      const k = r.letter;
      const name = esc(clipName(id));
      const n = t.tiles.length;
      const side = r.role === 'split-a' ? 'L' : r.role === 'split-b' ? 'R' : '';
      const isHero = r.role === 'hero';
      const confirming = t.removeConfirmId === id;
      const statsOn = t.statsOpen.includes(id);
      const audio = hasAudio(id);
      const heard = audio && t.soundId === id && !prefs.muted;
      const isClock = t.clockId === id;
      const off = S.formatOffset(S.getOffset(t, id));
      const enl = isHero ? 'Back to grid' : 'Enlarge tile';
      let rm = '';
      if (n > 2 && confirming) rm = `<button type="button" class="tbtn rm confirm" data-act="remove" data-rm data-i="${v}" aria-label="Confirm remove ${name} from Compare" title="Click again to remove">Remove?</button>`;
      else rm = `<button type="button" class="tbtn rm" data-act="remove" data-rm data-i="${v}" aria-label="Remove ${k} from compare" title="${n > 2 ? 'Remove from compare' : 'Remove from compare (back to one video)'}">${ICONS.close}</button>`;
      const top = side ? '' : `<div class="tile-top-acts"><button type="button" class="tbtn" data-act="enlarge" data-enlarge data-i="${v}" title="${enl}" aria-label="${enl} ${k}">${isHero ? ICONS.collapse : ICONS.expand}</button>${rm}</div>`;
      const soundBtn = !audio
        ? `<button class="mute-mini no-audio" type="button" data-act="sound" data-i="${v}" aria-label="No audio track in ${k}" aria-disabled="true" title="No audio track">${ICONS.noAudio}</button>`
        : `<button class="mute-mini${heard ? ' on' : ''}" type="button" data-act="sound" data-i="${v}" aria-label="${heard ? `Mute ${k}` : `Sound from ${k}`}" aria-pressed="${heard}" title="${heard ? 'Mute' : `Sound from ${k}`}">${heard ? ICONS.sound : ICONS.muted}</button>`;
      const pill = `<div class="tile-bottom-pill pill ${side === 'R' ? 'right' : 'left'}${isClock ? ' clock' : ''}" data-zoom-drag="1">`
        + '<span class="zoom-grip" title="Drag here to reposition while zoomed" aria-hidden="true">⋮⋮</span>'
        + `<button class="pill-open" type="button" data-act="openVid" data-i="${v}" title="${name}: offset, clock, sound, replace, remove" aria-label="${k}: ${name}${isClock ? ', sets the clock' : ''}. Offset, clock and sound"><span class="ltr">${k}</span><span class="nm">${name}</span><span class="fr mono"></span></button>`
        + (side ? '' : `<button class="mute-mini${statsOn ? ' info-on' : ''}" type="button" data-act="info" data-i="${v}" aria-label="Toggle details for ${k}" aria-pressed="${statsOn}" title="Toggle clip details (mismatch highlighted)">${ICONS.info}</button>`)
        + soundBtn
        + '</div>';
      const nudge = `<div class="sync-pill nudge${side === 'R' ? ' right below' : side === 'L' ? ' left below' : ''}" role="group" aria-label="Offset of ${k}">`
        + `<button type="button" data-act="nudge" data-i="${v}" data-d="-1" aria-label="${k} earlier" title="Earlier (−)">−</button>`
        + `<button class="offv mono" type="button" data-act="openVid" data-i="${v}" title="Offset of ${k}" aria-label="Offset of ${k}: ${off.long}">${off.short}</button>`
        + `<button type="button" data-act="nudge" data-i="${v}" data-d="1" aria-label="${k} later" title="Later (+)">+</button>`
        + '</div>';
      void ui;
      return top + pill + nudge;
    }
    function moveHtml(/** @type {any} */ t, /** @type {string} */ id) {
      const v = vid(id);
      const pos = t.tiles.indexOf(id);
      return [-1, 1].map((d) => {
        const label = `Move ${esc(clipName(id))} ${d < 0 ? 'earlier' : 'later'}`;
        const dis = pos + d < 0 || pos + d >= t.tiles.length ? ' disabled' : '';
        return `<button type="button" data-act="move" data-i="${v}" data-d="${d}" aria-label="${label}" title="${label}"${dis}>${d < 0 ? ICONS.up : ICONS.down}</button>`;
      }).join('');
    }

    // One delegated click handler for every tile button: the overlays are rebuilt when their state changes.
    listen(cellsEl, 'click', (/** @type {any} */ e) => {
      const b = e.target && e.target.closest ? e.target.closest('[data-act]') : null;
      if (!b || !cellsEl.contains(b) || b.disabled) return;
      const id = idOfVid.get(Number(b.dataset.i));
      if (!id || !tab().tiles.includes(id)) return;
      e.stopPropagation();
      switch (b.dataset.act) {
        case 'enlarge': act.enlarge(id); break;
        case 'remove': act.removeClick(id); break;
        case 'nudge': act.nudge(id, Number(b.dataset.d)); break;
        case 'openVid': act.openTile(id); break;
        case 'info': act.toggleStats(id); break;
        case 'sound': act.setSound(id); break;
        case 'move': {
          const d = Number(b.dataset.d);
          const focused = Tiles ? Tiles.moveArrowHandlers.wasFocused(doc, b) : false;
          act.move(id, d);
          if (focused && Tiles) Tiles.moveArrowHandlers.refocus(cellsEl, vid(id), d);
          break;
        }
        default: break;
      }
    });

    function buildCells(/** @type {any} */ ui) {
      cellNodes.clear();
      addSlotNode = null;
      cellsEl.textContent = '';
      for (const r of ui.cells) {
        const cell = doc.createElement('div');
        const split = r.role.startsWith('split');
        cell.className = `cell${split ? ' split' : ''}`;
        cell.dataset.clip = r.clipId;
        cell.dataset.role = r.role;
        cell.dataset.tile = split ? 'split' : String(vid(r.clipId));
        if (r.role === 'split-b') cell.style.background = 'transparent';
        const cv = doc.createElement('canvas');
        cell.appendChild(cv);
        /** @type {any} */
        let ov = null, stats = null, move = null;
        if (ui.isMulti) {
          if (!split) {
            cell.appendChild(Object.assign(doc.createElement('div'), { className: 'cell-border' }));
            const ended = doc.createElement('div');
            ended.className = 'ended-ov';
            ended.innerHTML = '<span class="ended-badge">No frame (clip ended)</span>';
            cell.appendChild(ended);
            stats = doc.createElement('div');
            stats.className = 'tile-stats';
            cell.appendChild(stats);
          } else if (r.role === 'split-b') {
            const oor = doc.createElement('div');
            oor.className = 'oor';
            oor.hidden = true;
            oor.textContent = 'One side has no picture at this moment';
            cell.appendChild(oor);
          }
          ov = doc.createElement('div');
          ov.className = 'ov';
          cell.appendChild(ov);
          if (!split) {
            move = doc.createElement('div');
            move.className = 'move';
            cell.appendChild(move);
          }
        }
        // A tile's double-click enlarges it, so its single click waits out the double-click window: playback
        // never stutters pause → play before the enlarge. One video (and Split) play at once, as media/player.js.
        const enlargeable = ui.isMulti && !split;
        cell.addEventListener('click', (/** @type {any} */ e) => {
          if (e.target && e.target.closest && e.target.closest(NOT_A_TILE_CLICK)) return;
          if (consumeDragClick()) return;
          if (controls.anyOpen() || ctxMenu.isOpen() || (tileMenu && tileMenu.isOpen())) {
            controls.closeAll(false); ctxMenu.close(false); if (tileMenu) tileMenu.close(); return;
          }
          if (insp && !ui.isMulti && insp.getState().inspector && pickPixel(e, r.clipId)) return;
          if (!enlargeable) { act.playPause(); return; }
          if (clickTimer) win.clearTimeout(clickTimer);
          clickTimer = win.setTimeout(() => { clickTimer = 0; act.playPause(); }, DBLCLICK_MS);
        });
        cell.addEventListener('dblclick', (/** @type {any} */ e) => {
          if (e.target && e.target.closest && e.target.closest(NOT_A_TILE_CLICK)) return;
          if (clickTimer) { win.clearTimeout(clickTimer); clickTimer = 0; }
          if (enlargeable) act.enlarge(r.clipId); else if (!ui.isMulti) act.fullscreen();
        });
        cellsEl.appendChild(cell);
        cellNodes.set(r.clipId, { cell, cv, ov, stats, move, frEl: null, offEl: null, ovKey: '', statsKey: '' });
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
        if (b) b.addEventListener('click', (e) => { e.stopPropagation(); openPicker(); });
        cellsEl.appendChild(slot);
        addSlotNode = slot;
      }
    }

    function renderCells(/** @type {any} */ t, /** @type {any} */ ui) {
      stageEl.classList.toggle('sync-mode', t.syncMode && ui.isMulti);
      cellsEl.classList.toggle('dense', ui.n >= DENSE_FROM);
      // The structure: which clips, single or multi, Split or not, whether there is a "+ Add video" cell.
      const key = `${ui.isMulti ? 1 : 0}|${ui.effectiveLayout === 'split' ? 1 : 0}|${ui.addSlot ? 1 : 0}|${t.tiles.slice().sort().join(',')}`;
      if (key !== lastCellsKey) { lastCellsKey = key; buildCells(ui); }
      // A drag preview lays the cells out as the drop would (the state changes only on the drop).
      const lay = preview && ui.effectiveLayout !== 'split' ? S.deriveUi({ ...t, tiles: preview.order, dock: preview.dock, spotlightId: t.layout === 'spotlight' ? preview.order[0] : null }, stageSize()) : ui;
      const baseA = t.tiles[0] ? statsClip(t.tiles[0]) : null;
      const factsA = t.tiles[0] ? facts(t.tiles[0]) : null;
      for (const r of lay.cells) {
        const entry = cellNodes.get(r.clipId);
        if (!entry) continue;
        const real = ui.cells.find((/** @type {any} */ c) => c.clipId === r.clipId) || r;
        const lifted = preview && preview.video === vid(r.clipId);
        const at = lifted ? real : r;
        Object.assign(entry.cell.style, { left: `${at.x}px`, top: `${at.y}px`, width: `${at.w}px`, height: `${at.h}px` });
        entry.cell.style.transform = lifted && preview ? `translate(${preview.dx}px, ${preview.dy}px)` : (glide && glide.isActive() ? entry.cell.style.transform : '');
        entry.cell.style.zIndex = lifted ? '5' : '';
        entry.cell.dataset.letter = real.letter;
        // Letterboxing: the tile chrome hugs the picture as shown (media/compare.js --pic-l / -r / -t / -b).
        const pic = typeof engine.pictureRect === 'function'
          ? engine.pictureRect(r.clipId, at.w, at.h, t.picMode, t.zoom, t.panX, t.panY)
          : { x: 0, y: 0, w: at.w, h: at.h };
        const inset = (/** @type {number} */ v) => `${Math.max(0, Math.round(v))}px`;
        entry.cell.style.setProperty('--pic-l', inset(pic.x));
        entry.cell.style.setProperty('--pic-t', inset(pic.y));
        entry.cell.style.setProperty('--pic-r', inset(at.w - pic.x - pic.w));
        entry.cell.style.setProperty('--pic-b', inset(at.h - pic.y - pic.h));
        if (r.role === 'split-a') lastSplitPic = { x: at.x + Math.max(0, pic.x), w: Math.min(at.w, pic.w) };
        const shown = shownOf(t, r.clipId);
        if (entry.ov) {
          const ovKey = [real.letter, real.role, t.tiles.length, t.removeConfirmId === r.clipId, t.statsOpen.includes(r.clipId),
            t.soundId === r.clipId, prefs.muted, t.clockId === r.clipId, JSON.stringify(S.getOffset(t, r.clipId)), t.tiles.indexOf(r.clipId)].join('|');
          if (ovKey !== entry.ovKey) {
            entry.ovKey = ovKey;
            entry.ov.innerHTML = overlayHtml(t, real, ui);
            if (entry.move) entry.move.innerHTML = moveHtml(t, r.clipId);
            entry.frEl = entry.ov.querySelector('.fr');
            entry.offEl = entry.ov.querySelector('.offv');
          }
          entry.cell.classList.toggle('confirming', t.removeConfirmId === r.clipId);
          if (entry.frEl) entry.frEl.textContent = shown.out ? '—' : `#${shown.frame}`;
        }
        if (entry.stats) {
          const open = t.statsOpen.includes(r.clipId);
          entry.cell.classList.toggle('show-stats', open);
          const statsKey = open ? `${real.letter}|${t.tiles[0]}` : '';
          if (statsKey !== entry.statsKey) {
            entry.statsKey = statsKey;
            if (open && Tiles && Grid) {
              const isA = t.tiles[0] === r.clipId;
              Tiles.renderTileStatsCard({
                doc, el: entry.stats, index: vid(r.clipId), clip: statsClip(r.clipId), facts: facts(r.clipId),
                baseClip: isA ? null : baseA, baseFacts: isA ? null : factsA, letter: real.letter, closeIcon: ICONS.close,
                grid: Grid, onClose: () => act.toggleStats(r.clipId), focusRoot: cellsEl,
              });
            } else entry.stats.textContent = '';
          }
        }
        if (r.role === 'split-b') {
          const oor = entry.cell.querySelector('.oor');
          if (oor) oor.hidden = !(shown.out || shownOf(t, t.tiles[0]).out);
        } else if (ui.isMulti) entry.cell.classList.toggle('ended', shown.out);
        engine.draw(entry.cv, r.clipId, shown.frame, {
          width: at.w,
          height: at.h,
          splitClipRatio: r.role === 'split-b' ? t.split : null,
          picMode: t.picMode, zoom: t.zoom, panX: t.panX, panY: t.panY,
        });
      }
      if (lay.addSlot && addSlotNode) {
        Object.assign(addSlotNode.style, { left: `${lay.addSlot.x}px`, top: `${lay.addSlot.y}px`, width: `${lay.addSlot.w}px`, height: `${lay.addSlot.h}px` });
      }
    }

    /** The bar's own state (prefs-driven parts that do not need the stage size). */
    function drawBar() {
      const t = tab();
      const multi = t.tiles.length > 1;
      if (rateBtn) {
        const sp = W.VpeControls.speedText ? W.VpeControls.speedText(prefs.rate) : `${prefs.rate}×`;
        rateBtn.textContent = sp;
        rateBtn.setAttribute('aria-label', `Speed ${sp}`);
      }
      if (picBtn && W.VpePicture) pictureButton(picBtn, W.VpePicture, t.picMode, multi ? 'all videos' : '');
      else if (picBtn) picBtn.dataset.mode = t.picMode;
      if (tracksBtn && subs) {
        const cc = subs.getCcButtonState();
        tracksBtn.classList.toggle('on', cc.on);
        tracksBtn.setAttribute('aria-label', cc.label);
        tracksBtn.title = cc.title;
      } else if (tracksBtn) tracksBtn.classList.toggle('on', prefs.subKey !== 'off');
      if (muteBtn) {
        const noAudio = !hasAudio(t.soundId);
        muteBtn.disabled = noAudio;
        if (volEl) volEl.disabled = noAudio;
        if (muteBtn.parentElement) muteBtn.parentElement.classList.toggle('no-audio', noAudio);
        if (noAudio) {
          muteBtn.classList.toggle('muted', true);
          muteBtn.removeAttribute('aria-pressed');
          muteBtn.setAttribute('aria-label', 'No audio track');
          muteBtn.title = 'No audio track';
        } else {
          muteBtn.classList.toggle('muted', prefs.muted);
          muteBtn.setAttribute('aria-pressed', String(prefs.muted));
          muteBtn.setAttribute('aria-label', prefs.muted ? 'Unmute' : 'Mute');
          muteBtn.title = prefs.muted ? 'Unmute  M' : 'Mute  M';
        }
      }
      if (volEl) volEl.value = String(prefs.muted ? 0 : prefs.volume);
      if (prevSize && nextSize) W.VpeControls.drawStepBadges([prevSize, nextSize], W.VpeControls.stepSizeOf(stepPrefs()));
      if (setABtn && setBBtn) W.VpeControls.drawRangeButtons(setABtn, setBBtn, ab);
      if (abMarks && abA && abB) W.VpeControls.drawRangeMarks(abMarks, abA, abB, ab.marks(t.maxFrame / fps()));
      // The other tabs follow a changed volume, speed, time format or step size (unchanged values post nothing).
      if (prefsSync) prefsSync.publishPlaybackPrefs(playbackPrefsNow());
      checkTileSize();
    }

    /** The folder capsule is a single-video control: hidden in Compare whatever the host's pos answer said. */
    function syncCapsule(/** @type {boolean} */ isMulti) {
      const folderCap = $('folderCap');
      if (folderCap && isMulti) folderCap.hidden = true;
    }

    /** The Spotlight splitter on the band between the main tile and the strip, along the dock. */
    function drawSplitter(/** @type {any} */ t, /** @type {any} */ ui) {
      if (!splitterEl) return;
      splitterEl.hidden = !ui.showSplitter || !ui.splitter;
      if (splitterEl.hidden) return;
      const sp = ui.splitter;
      const horiz = sp.orientation === 'horizontal';
      splitterEl.classList.toggle('h', horiz);
      splitterEl.classList.toggle('v', !horiz);
      splitterEl.setAttribute('role', 'separator');
      splitterEl.setAttribute('tabindex', '0');
      splitterEl.setAttribute('aria-label', 'Spotlight size');
      // The bar is 8 px wider than the gap so it is easy to grab (compare-grid spotlightLayout).
      Object.assign(splitterEl.style, horiz
        ? { left: `${sp.x}px`, top: `${sp.y - 4}px`, width: `${sp.w}px`, height: `${sp.h + 8}px` }
        : { left: `${sp.x - 4}px`, top: `${sp.y}px`, width: `${sp.w + 8}px`, height: `${sp.h}px` });
      const pct = Math.round(t.heroRatio * 100);
      splitterEl.setAttribute('aria-orientation', horiz ? 'horizontal' : 'vertical');
      splitterEl.setAttribute('aria-valuemin', '10');
      splitterEl.setAttribute('aria-valuemax', '90');
      splitterEl.setAttribute('aria-valuenow', String(pct));
      splitterEl.setAttribute('aria-valuetext', `Spotlight ${pct}%`);
    }

    let lastSound = '';
    function render() {
      if (disposed) return;
      postCapture();
      const t = tab();
      const { width, height } = stageSize();
      const ui = S.deriveUi(t, { width, height });

      lastSplitPic = null;
      renderCells(t, ui);
      drawSplitter(t, ui);
      if (dividerEl) {
        dividerEl.hidden = !ui.showDivider;
        if (ui.showDivider) {
          const pic = lastSplitPic || { x: 0, w: width };
          dividerEl.style.left = `${Math.round(pic.x + pic.w * t.split)}px`;
          const pct = Math.round(t.split * 100);
          dividerEl.setAttribute('aria-valuenow', String(pct));
          dividerEl.setAttribute('aria-valuetext', `A ${pct}%, B ${100 - pct}%`);
        }
      }
      if (capBanner) capBanner.hidden = !ui.showCaptureBanner;

      if (tracksBtn) tracksBtn.hidden = !ui.showCC;
      // Compare's layout buttons: Spotlight / Equal Grid (N >= 2), Split Wipe and Swap (N = 2).
      const layoutBtn = (/** @type {any} */ b, /** @type {boolean} */ show, /** @type {boolean} */ on) => {
        b.hidden = !show;
        b.classList.toggle('active', on);
        b.setAttribute('aria-pressed', String(on));
      };
      layoutBtn(spotBtn, ui.isMulti, ui.effectiveLayout === 'spotlight');
      layoutBtn(gridBtn, ui.isMulti, ui.effectiveLayout === 'grid');
      layoutBtn(splitBtn, ui.showSplitBtn, ui.effectiveLayout === 'split');
      swapBtn.hidden = ui.n !== 2;
      layoutBtn(syncBtn, ui.showSyncBtn, t.syncMode);
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
      // The seek slider speaks the clock tile's time (Compare: with its letter first).
      const letter = ui.isMulti ? letterOf(t, t.clockId) : undefined;
      const aria = Input
        ? Input.formatSeekAria({ letter, timeText: clockText(t.frame / fps()), durText: clockText(t.maxFrame / fps()), frame: t.frame })
        : `${letter ? `${letter} ` : ''}${clockText(t.frame / fps())} of ${clockText(t.maxFrame / fps())}, frame ${t.frame + 1}`;
      seekEl.setAttribute('aria-valuetext', aria);
      playBtn.classList.toggle('playing', t.playing);
      const playLabel = `${t.playing ? 'Pause' : 'Play'}${ui.isMulti ? ' all' : ''}`;
      playBtn.setAttribute('aria-label', playLabel);
      playBtn.title = `${playLabel}  Space`;
      drawBar();

      // The engine hears one tile (none while muted).
      const sound = `${prefs.muted ? '' : t.soundId}|${prefs.volume}|${prefs.muted}`;
      if (sound !== lastSound) {
        lastSound = sound;
        if (typeof engine.setSoundSource === 'function') engine.setSoundSource(prefs.muted ? null : t.soundId);
        if (typeof engine.setVolume === 'function') engine.setVolume(prefs.volume, prefs.muted);
      }

      // The host learns about every change of this tab's videos (rail members, folder position).
      const key = tilesKey(S, t);
      if (key !== lastTilesKey) {
        lastTilesKey = key;
        postHost({ type: 'tiles', tabId: t.id, tiles: t.tiles.slice(), current: t.tiles[0] });
      }
      syncCapsule(ui.isMulti);
      // Subtitles belong to the single player: the cue of the shown time over the picture.
      if (subs) { if (ui.isMulti) subs.dispose(); else subs.render(); }
      seedClip();
      persist();
      if (controls && controls.view && (controls.view() === 'cmp' || controls.view() === 'cmpVid') && !ui.isMulti) controls.close(false);
      if (tileMenu && !ui.isMulti && tileMenu.isOpen()) tileMenu.close();
      emitTransport();
      if (env.onChange) env.onChange(ws, ui);
    }

    // ---- playback clock: a decoder reports its frames and its end; without one (tickMs > 0) the page ticks ----
    /** The decoder presented `frame` (clock frames): the bar and the stage follow, nothing is told back. */
    function decoderFrame(/** @type {number} */ frame) {
      if (disposed || !Number.isFinite(frame)) return;
      quietly(() => commit(S.seekFrame(ws, frame)));
    }
    /** Play again from clock frame `f`: the decoder stopped at its end, so it hears the seek and the play. */
    function restartAt(/** @type {number} */ f) {
      quietly(() => commit(S.seekFrame(tab().playing ? ws : S.togglePlay(ws), f)));
      const t = tab();
      tell({ type: 'seek', frame: t.frame, playing: true });
      tell({ type: 'play', frame: t.frame, playing: true });
    }
    /**
     * The decoder reached its end (natural: it played there; false when it stopped short, e.g. an error). An A-B range
     * wraps to A, Loop starts again, else the page pauses on the last frame and Autoplay "Play next in folder" goes on
     * (one video, a visible tab, playing forward). Returns what it did: 'ab' | 'loop' | 'end' | 'none'.
     * @param {{ natural?: boolean }} [o]
     */
    function decoderEnded({ natural = true } = {}) {
      if (disposed) return 'none';
      const t = tab();
      const wrap = ab.wrapTarget(Infinity, true);
      if (wrap !== null) { restartAt(Math.round(wrap * fps())); return 'ab'; }
      if (prefs.onEnd === 'loop') { restartAt(0); return 'loop'; }
      quietly(() => commit(S.seekFrame(t.playing ? S.togglePlay(ws) : ws, t.maxFrame)));
      if (natural && t.tiles.length === 1) {
        if (railCtl) railCtl.onNaturalEnd({ visible: !doc.hidden, rate: prefs.rate, isFile: true, autoplayMode: prefs.onEnd });
        else if (rail && prefs.onEnd === 'next' && !doc.hidden && prefs.rate > 0) rail.go(1, true);
      }
      return 'end';
    }
    const tickMs = env.tickMs === undefined ? 42 : env.tickMs;
    if (tickMs > 0) {
      const timer = win.setInterval(() => {
        const t = tab();
        if (!t.playing) return;
        if (t.frame >= t.maxFrame || ab.wrapTarget(t.frame / fps(), true) !== null) { decoderEnded(); return; }
        decoderFrame(t.frame + 1);
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
      if (msg.type === 'rail') { if (rail) rail.onMessage(msg); syncCapsule(tab().tiles.length >= 2); return; }
      if (msg.type === 'toast') {
        // The host may say how long (ms); else the toast's own default.
        const ms = Number(msg.ms);
        const text = String(msg.text || '');
        if (Number.isFinite(ms) && ms > 0) toast(text, Math.min(10000, Math.max(1, ms))); else toast(text);
        return;
      }
      if (msg.type === 'focusMode') { if (zen) zen.setActive(!!msg.active); return; }
      if (msg.type === 'setVisible') { if (vis) vis.setVisible(msg.visible !== false, msg.active !== false); return; }
      // A notice turned off in Settings: remembered, and closed if it shows (media/player.js).
      if (msg.type === 'hideReducedResNotice' || msg.type === 'hideSlowPlaybackNotice') {
        const kind = msg.type === 'hideReducedResNotice' ? 'reducedRes' : 'slowPlayback';
        if (notices) { notices.setDismissals({ ...notices.getDismissals(), [kind]: true }); notices.hide(kind); }
        persist();
        return;
      }
      if (msg.type === 'slowPlayback') { if (notices) notices.maybeShowSlowPlayback(msg); return; }
      if (prefsSync && prefsSync.onHostMessage(msg)) return;
      if (gotoResume && gotoResume.handleGotoMessage(msg)) return;
      if (railCtl && railCtl.onHostMessage(msg)) return;
      if (overlay && overlay.onHostMessage(msg, { started: false })) return;
      if (bridge && bridge.onHostMessage(msg)) return;
      if (subs && subs.onHostMessage(msg)) return;
      if (frameExport && frameExport.onHostMessage(msg)) return;
      const r = applyHostMessage(S, ws, msg, engine.getClip);
      if (r.handled) {
        // A video arrived: an error left over from the one before is gone.
        if (overlay && overlay.isShown()) overlay.hide();
        commit(r.state, r.toast);
      }
    }

    // ---- what a newly opened page shows first: a frame link, else the saved position of this video ----
    if (gotoResume) {
      const t0 = tab();
      gotoResume.applyOpenTarget({
        gotoCfg: env.goto, fragment: env.fragment,
        savedTime: saved.clipId === t0.tiles[0] ? saved.time : undefined, duration: t0.maxFrame / fps(),
      });
    }

    function disposeAll() {
      if (disposed) return;
      disposed = true;
      for (const c of cleanups.splice(0)) c();
    }

    const controller = {
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
      getPrefs: () => ({ ...prefs, picMode: tab().picMode }),
      /** The clock video's decoder learnt its real fps / length: the seek bar, readout and stepping follow it. */
      syncClockMeta: () => {
        const before = ws;
        syncClock(null);
        if (ws !== before) render();
      },
      /** A decoder clock (tickMs: 0) presented this clock frame: the UI follows without telling onTransport. */
      onDecoderFrame: (/** @type {number} */ frame) => decoderFrame(frame),
      /** A decoder clock reached its end: A-B wrap, Loop, or pause and Autoplay next. */
      onDecoderEnded: (/** @type {{ natural?: boolean }} */ o) => decoderEnded(o),
      rail,
      controls,
      ctxMenu,
      tileMenu,
      ab,
      /** The tile gesture and input controllers (null without their widget modules), for tests and the harness. */
      parts: {
        glide, tileDrag, hover, seekHover, wheelPan, idle, zen, vis, gotoBox,
        notices, insp, subs, frameExport, prefsSync, gotoResume, railCtl, overlay, bridge,
      },
      dispose: () => disposeAll(),
    };
    // More than the contract (rail, controls, menus, ab), so checked as a value, not as a fresh literal.
    return /** @satisfies {UnifiedControllerApi} */ (controller);
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
