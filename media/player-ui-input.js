// @ts-check
// Shared webview input interactions (Phase 2 of the player UI seam, media/player-ui.js): the seek bar hover tip,
// wheel-to-step / Ctrl+wheel zoom / drag-to-pan on the stage, fullscreen idle hiding of the bar, the Zen Mode
// Esc-Esc tracker, auto-pause on hidden tabs, the polite live region, and the go-to frame / time box. Player
// (media/player.js) and Compare (media/compare.js) each had their own copy of these; this module is the one copy
// both can call, over injected `doc` / `win` so the millisecond Node tests (test/host/player_ui_input_test.js) drive
// them on the strict fake DOM (test/host/fake-dom.js). Zero VS Code, zero decoder coupling: every effect on the
// player goes out through a callback the caller passes.
'use strict';

(() => {
  // checkJs: start

  /** Middle dot between the parts of the seek tip (Compare printed `?` here: a lost character, not a design). */
  const DOT = '·';
  /** Pixels the seek tip keeps from either end of the bar so its text is never cut off. */
  const TIP_EDGE = 30;
  /** A pointer must move this far (CSS px) before a press on a zoomed picture becomes a pan. */
  const PAN_THRESHOLD = 4;
  /** A click this soon (ms) after a pan ends is the pan's release, not a play / pause click. */
  const PAN_CLICK_GUARD = 300;
  /** Things a press on the stage must not pan from: they have their own pointer handling. */
  const PAN_IGNORE = 'button, input, select, textarea, a, [role="button"], [role="slider"], [contenteditable], '
    + '#divider, #splitter, #menu, [data-zoom-drag]';

  /** @param {any} win @returns {() => number} */
  const clockOf = (win) => () => (win && win.performance && typeof win.performance.now === 'function'
    ? win.performance.now() : Date.now());
  const clamp = (/** @type {number} */ v, /** @type {number} */ lo, /** @type {number} */ hi) => Math.max(lo, Math.min(hi, v));

  /** `m:ss.mmm` (or `h:mm:ss.mmm`): the default time text when the caller passes no formatter. */
  function fmtClock(/** @type {number} */ t) {
    const ms = Math.max(0, Math.round((Number(t) || 0) * 1000));
    const h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, s = Math.floor(ms / 1000) % 60;
    const frac = String(ms % 1000).padStart(3, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${frac}` : `${m}:${String(s).padStart(2, '0')}.${frac}`;
  }

  // ---- 1. seek bar hover tip -------------------------------------------------------------------------

  /**
   * The seek tip text: `[letter ]time · #frame[ · chapter]`, or the time alone while the frame count is unknown.
   * @param {{ letter?: string, timeText: string, frame?: number, knownFrames?: boolean, chapterTitle?: string }} o
   *   `frame` is the 0-based frame index (shown 1-based, as the frame counter does).
   */
  function formatSeekTip({ letter, timeText, frame, knownFrames, chapterTitle }) {
    let s = letter ? `${letter} ${timeText}` : timeText;
    if (knownFrames && Number.isFinite(frame)) s += ` ${DOT} #${/** @type {number} */ (frame) + 1}`;
    if (chapterTitle) s += ` ${DOT} ${chapterTitle}`;
    return s;
  }

  /**
   * The seek slider's aria-valuetext: `[letter ]time of duration, frame N` (N 1-based; left out when unknown).
   * @param {{ letter?: string, timeText: string, durText: string, frame?: number }} o
   */
  function formatSeekAria({ letter, timeText, durText, frame }) {
    const head = `${letter ? `${letter} ` : ''}${timeText} of ${durText}`;
    return Number.isFinite(frame) ? `${head}, frame ${/** @type {number} */ (frame) + 1}` : head;
  }

  /**
   * @typedef {object} SeekInfo
   * @property {number} [frames]    frame count (0 / missing: unknown yet, the tip shows the time only)
   * @property {number} [fps]
   * @property {number} [duration]  seconds
   * @property {string} [letter]    Compare: the clock video's tile letter
   * @property {(t: number) => string} [formatTime]
   * @property {(t: number) => string | null | undefined} [chapterAt]
   * @property {boolean} [scrubbing] passed on to onThumbnail (a scrub asks for faster, rougher thumbnails)
   */
  /**
   * Seek bar hover tip and thumbnail. The tip follows the pointer over the bar, and the slider value while the bar
   * is being dragged (also off the bar); it hides on leave unless a drag is on.
   * @param {{ seekEl: any, tipEl: any, thumbCanvas?: any, win?: any, getInfo: () => SeekInfo | null | undefined,
   *   onThumbnail?: (seconds: number, canvas: any, scrubbing: boolean, place: { px: number, width: number }) => void,
   *   onThumbnailLeave?: (immediate: boolean) => void }} o
   */
  function bindSeekHover({ seekEl, tipEl, thumbCanvas, win, getInfo, onThumbnail, onThumbnailLeave }) {
    let dragging = false;
    let over = false;
    /** Shows the tip for a position `x` (0..1) along the bar; returns what it showed, or null. */
    function showFraction(/** @type {number} */ x) {
      const info = getInfo();
      if (!info) return null;
      const n = Math.max(0, Math.floor(info.frames || 0));
      const dur = info.duration || 0;
      if (!n && !dur) return null;
      const width = seekEl.getBoundingClientRect().width;
      x = clamp(Number.isFinite(x) ? x : 0, 0, 1);
      const frame = n ? Math.round(x * (n - 1)) : undefined;
      const t = n ? /** @type {number} */ (frame) / (info.fps || 30) : x * dur;
      const fmt = info.formatTime || fmtClock;
      const chapter = info.chapterAt ? info.chapterAt(t) : null;
      tipEl.textContent = formatSeekTip({ letter: info.letter, timeText: fmt(t), frame, knownFrames: !!n, chapterTitle: chapter || '' });
      const px = x * width;
      tipEl.style.left = `${clamp(px, TIP_EDGE, Math.max(TIP_EDGE, width - TIP_EDGE))}px`;
      tipEl.hidden = false;
      if (onThumbnail) onThumbnail(t, thumbCanvas, !!(info.scrubbing || dragging), { px, width });
      return { t, frame, px, width };
    }
    function showAt(/** @type {number} */ clientX) {
      const r = seekEl.getBoundingClientRect();
      return showFraction(r.width ? (clientX - r.left) / r.width : 0);
    }
    function showValue() {
      const max = Number(seekEl.max) || 0;
      return showFraction(max ? Number(seekEl.value) / max : 0);
    }
    function hide(immediate = false) {
      tipEl.hidden = true;
      if (onThumbnailLeave) onThumbnailLeave(!!immediate);
    }
    const onMove = (/** @type {any} */ e) => { over = true; if (!dragging) showAt(e.clientX); };
    const onLeave = () => { over = false; if (!dragging) hide(false); };
    const onDown = (/** @type {any} */ e) => { if (e.button === 0 || e.button === undefined) dragging = true; };
    const onInput = () => { if (dragging) showValue(); };
    const onUp = () => {
      if (!dragging) return;
      dragging = false;
      if (!over) hide(false);
    };
    const binds = /** @type {[any, string, any][]} */ ([
      [seekEl, 'mousemove', onMove], [seekEl, 'pointermove', onMove],
      [seekEl, 'mouseleave', onLeave], [seekEl, 'pointerleave', onLeave],
      [seekEl, 'pointerdown', onDown], [seekEl, 'input', onInput],
    ]);
    if (win) binds.push([win, 'pointerup', onUp], [win, 'pointercancel', onUp]);
    for (const [t, ev, fn] of binds) t.addEventListener(ev, fn);
    return {
      showAt, showValue, showFraction, hide,
      dragging: () => dragging,
      /** The drag ended elsewhere (Esc, the tab hidden): stop following the slider and hide. */
      cancel(immediate = true) { dragging = false; hide(immediate); },
      dispose() { for (const [t, ev, fn] of binds) t.removeEventListener(ev, fn); },
    };
  }

  // ---- 2. stage wheel (step / zoom) and drag to pan --------------------------------------------------

  /**
   * Wheel on the stage: paused, plain wheel steps (`onStepWheel(dir, false)`), Shift+wheel takes the bigger step
   * (`onStepWheel(dir, true)`; Chromium on Windows reports Shift+wheel on deltaX with deltaY 0); Ctrl / Meta+wheel
   * (and a trackpad pinch) zooms around the pointer. A press-and-drag on a zoomed picture pans it.
   * @param {{ stage: any, win?: any, isPlaying: () => boolean, isZoomed?: () => boolean, isBlocked?: () => boolean,
   *   getZoom?: () => number, onStepWheel?: (dir: number, shift: boolean) => void,
   *   onZoomWheel?: (factor: number, clientX: number, clientY: number, zoom?: number) => void,
   *   onPanStart?: (start: { clientX: number, clientY: number, target: any }) => boolean | void,
   *   onPanMove?: (dx: number, dy: number) => void, onPanEnd?: (info: { moved: boolean, cancelled: boolean }) => void,
   *   ignoreSelector?: string, now?: () => number }} o
   */
  function bindStageWheelAndPan(o) {
    const { stage, win, isPlaying, isZoomed = () => false, isBlocked = () => false, getZoom,
      onStepWheel, onZoomWheel, onPanStart, onPanMove, onPanEnd, ignoreSelector = PAN_IGNORE } = o;
    const now = o.now || clockOf(win);
    const onWheel = (/** @type {any} */ e) => {
      // A tile being dragged owns the wheel: no step, no zoom, and no page scroll under it.
      if (isBlocked()) { e.preventDefault(); return; }
      if (e.ctrlKey || e.metaKey) {
        if (!onZoomWheel) return;
        e.preventDefault();
        onZoomWheel(zoomFactor(e.deltaY), e.clientX, e.clientY, getZoom ? getZoom() : undefined);
        return;
      }
      if (isPlaying()) return;
      e.preventDefault();
      const delta = e.deltaY || (e.shiftKey ? e.deltaX : 0);
      if (delta && onStepWheel) onStepWheel(delta > 0 ? 1 : -1, !!e.shiftKey);
    };

    /** @type {{ x: number, y: number, id: number, moved: boolean } | null} */
    let drag = null;
    let panEndedAt = -Infinity;
    const end = (/** @type {boolean} */ cancelled) => {
      if (!drag) return;
      const { moved, id } = drag;
      drag = null;
      if (moved && !cancelled) panEndedAt = now();
      stage.classList.remove('panning');
      if (stage.hasPointerCapture && stage.hasPointerCapture(id)) stage.releasePointerCapture(id);
      if (onPanEnd) onPanEnd({ moved, cancelled });
    };
    const onDown = (/** @type {any} */ e) => {
      if (e.button !== 0 || drag || !isZoomed()) return;
      const target = e.target;
      if (target && target.closest && target.closest(ignoreSelector)) return; // the ⋮⋮ grip still moves the tile
      if (onPanStart && onPanStart({ clientX: e.clientX, clientY: e.clientY, target }) === false) return;
      drag = { x: e.clientX, y: e.clientY, id: e.pointerId, moved: false };
    };
    const onMove = (/** @type {any} */ e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) < PAN_THRESHOLD) return;
      if (!drag.moved) { drag.moved = true; stage.setPointerCapture(e.pointerId); stage.classList.add('panning'); }
      if (onPanMove) onPanMove(dx, dy);
    };
    const onUp = (/** @type {any} */ e) => { if (drag && e.pointerId === drag.id) end(false); };
    const onCancel = (/** @type {any} */ e) => { if (drag && e.pointerId === drag.id) end(true); };
    const onKey = (/** @type {any} */ e) => {
      if (e.key !== 'Escape' || !drag) return;
      const moved = drag.moved;
      end(true);
      if (moved) { e.preventDefault(); e.stopPropagation(); } // this Esc ended a pan; it is not also a player key
    };
    const binds = /** @type {[any, string, any, any][]} */ ([
      [stage, 'wheel', onWheel, { passive: false }],
      [stage, 'pointerdown', onDown, undefined], [stage, 'pointermove', onMove, undefined],
      [stage, 'pointerup', onUp, undefined], [stage, 'pointercancel', onCancel, undefined],
      [stage, 'lostpointercapture', onCancel, undefined],
    ]);
    if (win) binds.push([win, 'keydown', onKey, { capture: true }]);
    for (const [t, ev, fn, opts] of binds) t.addEventListener(ev, fn, opts);
    return {
      panning: () => !!(drag && drag.moved),
      /** True within 300 ms of a pan's release: the click that follows it is not a play / pause click. */
      wasRecentPan: (/** @type {number} */ t = now()) => t - panEndedAt < PAN_CLICK_GUARD,
      cancel: () => end(true),
      dispose() { end(true); for (const [t, ev, fn] of binds) t.removeEventListener(ev, fn); },
    };
  }

  /** The Ctrl+wheel zoom factor: exp(-deltaY * 0.002), with deltaY clamped to ±300 (one notch ≈ ×1.22). */
  const zoomFactor = (/** @type {number} */ deltaY) => Math.exp(-clamp(Number(deltaY) || 0, -300, 300) * 0.002);

  // ---- 3. idle bar in fullscreen ---------------------------------------------------------------------

  /**
   * Hides the bar (`body.idle`) after `timeoutMs` without input while fullscreen and playing; any mouse move,
   * focus move (a keyboard user tabbing to the hidden bar), key or fullscreen change shows it again.
   * @param {{ doc: any, win: any, isFullscreen?: () => boolean, isPlaying: () => boolean, isSuppressed?: () => boolean,
   *   timeoutMs?: number }} o
   */
  function createIdleController({ doc, win, isFullscreen = () => !!doc.fullscreenElement, isPlaying,
    isSuppressed = () => false, timeoutMs = 2500 }) {
    let timer = 0;
    const can = () => isFullscreen() && isPlaying() && !isSuppressed();
    function wake() {
      doc.body.classList.remove('idle');
      if (timer) win.clearTimeout(timer);
      timer = 0;
      if (!can()) return;
      timer = win.setTimeout(() => {
        timer = 0;
        if (can()) doc.body.classList.add('idle'); // the state may have changed while waiting
      }, timeoutMs);
    }
    const events = ['mousemove', 'focusin', 'keydown', 'fullscreenchange'];
    for (const ev of events) doc.addEventListener(ev, wake);
    return {
      wake,
      isIdle: () => doc.body.classList.contains('idle'),
      dispose() {
        for (const ev of events) doc.removeEventListener(ev, wake);
        if (timer) win.clearTimeout(timer);
        timer = 0;
        doc.body.classList.remove('idle');
      },
    };
  }

  // ---- 4. Zen Mode Esc Esc ---------------------------------------------------------------------------

  /**
   * VS Code leaves Zen Mode on Esc Esc. The page sees both keys; this tells the host when it happened so its Zen
   * flag stays in sync. The caller passes Escape keys that no earlier handler (menus, panels) consumed.
   * @param {{ win?: any, windowMs?: number, onExitZen: () => void, now?: () => number }} o
   */
  function createZenEscTracker({ win, windowMs = 1000, onExitZen, now = clockOf(win) }) {
    let active = false;
    let lastEscAt = -Infinity;
    return {
      /** Follows `body.maxi` (the host's Zen Mode / maximised state). */
      setActive(/** @type {boolean} */ on) { active = !!on; if (!active) lastEscAt = -Infinity; },
      get active() { return active; },
      /** Returns true when this key completed an Esc Esc. Never consumes the key. */
      onKey(/** @type {any} */ e) {
        if (!e || e.key !== 'Escape' || e.repeat || !active) return false;
        const t = now();
        if (t - lastEscAt <= windowMs) { lastEscAt = -Infinity; onExitZen(); return true; }
        lastEscAt = t;
        return false;
      },
      reset() { lastEscAt = -Infinity; },
    };
  }

  // ---- 5. visibility: auto-pause hidden tabs ---------------------------------------------------------

  /**
   * Background tabs keep their webview alive; they must not play unseen. Hidden (the page's visibilitychange or
   * the host's setVisible) pauses and remembers; visible again resumes only what this paused.
   * @param {{ doc: any, win?: any, isPlaying: () => boolean, onAutoPause: () => void, onAutoResume: () => void,
   *   onHideCleanup?: () => void }} o
   */
  function createVisibilityController({ doc, isPlaying, onAutoPause, onAutoResume, onHideCleanup }) {
    let docVisible = !doc.hidden;
    let hostVisible = true;
    let hostActive = true;
    let visible = docVisible && hostVisible;
    let resumeOnShow = false;
    function apply() {
      const next = docVisible && hostVisible;
      if (next === visible) return;
      visible = next;
      if (!visible) {
        if (onHideCleanup) onHideCleanup();
        if (isPlaying()) { resumeOnShow = true; onAutoPause(); }
      } else if (resumeOnShow) {
        resumeOnShow = false;
        onAutoResume();
      }
    }
    const onVis = () => { docVisible = !doc.hidden; apply(); };
    doc.addEventListener('visibilitychange', onVis);
    return {
      /** The host's view state (webview panel visible / active). */
      setVisible(/** @type {boolean} */ v, /** @type {boolean} */ active = true) { hostVisible = !!v; hostActive = !!active; apply(); },
      isVisible: () => visible,
      isActive: () => hostActive,
      willResume: () => resumeOnShow,
      /** The user played or paused while hidden: their choice wins over the auto-resume. */
      forgetResume() { resumeOnShow = false; },
      dispose() { doc.removeEventListener('visibilitychange', onVis); },
    };
  }

  // ---- 6. polite live region -------------------------------------------------------------------------

  /**
   * Toasts, messages and status changes go to one polite live region. Emptying it first and writing a moment later
   * makes a screen reader read the same text again (a second "Frame 12" after two steps).
   * @param {{ liveEl: any, win: any, delayMs?: number }} o
   */
  function createLiveAnnouncer({ liveEl, win, delayMs = 50 }) {
    let timer = 0;
    const clear = () => { if (timer) win.clearTimeout(timer); timer = 0; };
    return {
      announce(/** @type {string} */ text) {
        if (!liveEl || !text) return;
        liveEl.textContent = '';
        clear();
        timer = win.setTimeout(() => { timer = 0; liveEl.textContent = text; }, delayMs);
      },
      dispose: clear,
    };
  }

  // ---- 7. go to frame / time -------------------------------------------------------------------------

  /**
   * @typedef {{ kind: 'frame' | 'delta', frame: number } | { kind: 'time' | 'percent', time: number }} GotoTarget
   */
  /**
   * Parses the go-to box into a target: a frame number as the counter shows it (`1432`, `#1432`; 1 = first), a
   * relative step (`+10`, `-3`, needs `current`), a time (`1:23.456`, `01:02:03`, `83.5`, `83.5s`) or a
   * percentage (`50%`). Frames come back 0-based and clamped to the clip, times clamped to the duration. Null when
   * it is none of these, or a percentage of a clip with no known duration.
   * @param {string} raw
   * @param {{ fps?: number, duration?: number, frames?: number, current?: number }} [clip]
   * @returns {GotoTarget | null}
   */
  function parseGoto(raw, { duration = 0, frames = 0, current = 0 } = {}) {
    const s = String(raw == null ? '' : raw).trim().replace(/^#\s*/, '');
    const last = frames > 0 ? frames - 1 : Infinity;
    const clampFrame = (/** @type {number} */ f) => clamp(f, 0, last);
    const clampTime = (/** @type {number} */ t) => (duration > 0 ? clamp(t, 0, duration) : Math.max(0, t));
    let m;
    if ((m = /^([+-])\s*(\d+)$/.exec(s))) return { kind: 'delta', frame: clampFrame(current + (m[1] === '-' ? -1 : 1) * Number(m[2])) };
    if (/^\d+$/.test(s)) return { kind: 'frame', frame: clampFrame(Number(s) - 1) };
    if ((m = /^(\d+(?:\.\d*)?|\.\d+)\s*%$/.exec(s))) {
      if (!(duration > 0)) return null;
      return { kind: 'percent', time: clampTime(Math.min(100, Number(m[1])) / 100 * duration) };
    }
    if ((m = /^(\d+(?:\.\d*)?|\.\d+)\s*s$/i.exec(s))) return { kind: 'time', time: clampTime(Number(m[1])) };
    if ((m = /^(?:(\d+):)?(\d+):(\d+(?:\.\d*)?)$/.exec(s))) {
      if ((m[1] !== undefined && Number(m[2]) >= 60) || Number(m[3]) >= 60) return null; // 1:75 is a typo
      return { kind: 'time', time: clampTime(Number(m[1] || 0) * 3600 + Number(m[2]) * 60 + Number(m[3])) };
    }
    if ((m = /^(\d*\.\d+)$/.exec(s))) return { kind: 'time', time: clampTime(Number(m[1])) };
    return null;
  }

  /**
   * The go-to box: opens with the current frame selected; Enter parses and seeks (the caller pauses), a bad entry
   * marks the box (`.bad`, aria-invalid) and keeps it open; Esc or leaving the field closes it. Keys typed here
   * never reach the player's shortcuts.
   * @param {{ doc: any, win?: any, inputEl: any, boxEl: any,
   *   getClipMeta: () => { fps?: number, duration?: number, frames?: number, current?: number } | null | undefined,
   *   onSeek: (target: GotoTarget) => void, onToast?: (text: string) => void, formatTime?: (t: number) => string }} o
   */
  function createGotoBox({ doc, inputEl, boxEl, getClipMeta, onSeek, onToast, formatTime = fmtClock }) {
    const setBad = (/** @type {boolean} */ bad) => {
      boxEl.classList.toggle('bad', bad);
      if (bad) inputEl.setAttribute('aria-invalid', 'true'); else inputEl.removeAttribute('aria-invalid');
    };
    function open() {
      const meta = getClipMeta() || {};
      boxEl.hidden = false;
      setBad(false);
      inputEl.value = Number.isFinite(meta.current) ? String(/** @type {number} */ (meta.current) + 1) : '';
      inputEl.focus();
      if (typeof inputEl.select === 'function') inputEl.select();
    }
    function close() {
      if (boxEl.hidden) return;
      boxEl.hidden = true;
      if (doc.activeElement === inputEl) inputEl.blur();
    }
    function submit() {
      const target = parseGoto(inputEl.value, getClipMeta() || {});
      if (!target) { setBad(true); return null; }
      close();
      onSeek(target);
      if (onToast) onToast('frame' in target ? `Frame ${target.frame + 1}` : formatTime(target.time));
      return target;
    }
    const onKey = (/** @type {any} */ e) => {
      e.stopPropagation(); // the player's keys stay off while typing
      if (e.key === 'Escape') { e.preventDefault(); close(); } else if (e.key === 'Enter') { e.preventDefault(); submit(); }
    };
    const onInput = () => setBad(false);
    const onBlur = () => close();
    const onBoxClick = (/** @type {any} */ e) => e.stopPropagation(); // a click in the box is not a play / pause
    const binds = /** @type {[any, string, any][]} */ ([
      [inputEl, 'keydown', onKey], [inputEl, 'input', onInput], [inputEl, 'blur', onBlur], [boxEl, 'click', onBoxClick],
    ]);
    for (const [t, ev, fn] of binds) t.addEventListener(ev, fn);
    return {
      open, close, submit,
      isOpen: () => !boxEl.hidden,
      dispose() { for (const [t, ev, fn] of binds) t.removeEventListener(ev, fn); },
    };
  }

  const api = {
    DOT, TIP_EDGE, PAN_THRESHOLD, PAN_CLICK_GUARD, PAN_IGNORE, fmtClock, zoomFactor,
    formatSeekTip, formatSeekAria, bindSeekHover, bindStageWheelAndPan, createIdleController, createZenEscTracker,
    createVisibilityController, createLiveAnnouncer, parseGoto, createGotoBox,
  };
  // checkJs: end

  if (typeof window !== 'undefined') /** @type {any} */ (window).VpePlayerUiInput = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})();
