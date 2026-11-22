// @ts-check
// A-B loop state of the player (media/player.js): A sets the start, B the end, the same key again
// clears that end; B before A swaps them. While playing, reaching B goes back to A (start of the file
// without A). The frames shown when A and B were set are the range the frame export uses.
// Pure state, also driven by the unit tests (test/unit/abloop_test.js) and the engine tests in Node.
'use strict';

(function (root) {
  function create() {
    const s = {
      /** @type {number|null} */ a: null,
      /** @type {number|null} */ b: null,
      /** @type {number|null} */ af: null,
      /** @type {number|null} */ bf: null,
      /** @type {number|null} */ aPts: null,
      /** @type {number|null} */ bPts: null,
      aNative: false,
      bNative: false,
      /** Toggles end `which` ('a' | 'b') at time t (s, from the start) showing frame f (0-based). */
      set(/** @type {'a'|'b'} */ which, /** @type {number} */ t, /** @type {number} */ f, pts = t, native = false) {
        if (which === 'a') {
          s.a = s.a === null ? t : null;
          s.af = s.a === null ? null : f;
          s.aNative = s.a !== null && native;
          s.aPts = s.a === null ? null : pts;
        } else {
          s.b = s.b === null ? t : null;
          s.bf = s.b === null ? null : f;
          s.bNative = s.b !== null && native;
          s.bPts = s.b === null ? null : pts;
        }
        if (s.a !== null && s.b !== null && s.b <= s.a) {
          [s.a, s.b] = [s.b, s.a];
          [s.af, s.bf] = [s.bf, s.af];
          [s.aNative, s.bNative] = [s.bNative, s.aNative];
          [s.aPts, s.bPts] = [s.bPts, s.aPts];
        }
      },
      /** Sets end `which` anew (the context menu's "Set Loop Start / End": never clears). */
      reset(/** @type {'a'|'b'} */ which, /** @type {number} */ t, /** @type {number} */ f, pts = t, native = false) {
        s[which] = null;
        s.set(which, t, f, pts, native);
      },
      clear() { s.a = s.b = s.af = s.bf = s.aPts = s.bPts = null; s.aNative = s.bNative = false; },
      /** The settings panel's row: start, then end, then off. */
      cycle(/** @type {number} */ t, /** @type {number} */ f, pts = t, native = false) {
        if (s.a === null) s.set('a', t, f, pts, native);
        else if (s.b === null) s.set('b', t, f, pts, native);
        else s.clear();
      },
      isSet() { return s.a !== null || s.b !== null; },
      /** Both frames known: the export range exists. */
      isRange() { return s.af !== null && s.bf !== null; },
      /** Where to seek now (playing at time t): A (or 0) once B is reached, else null. */
      wrapTarget(/** @type {number} */ t, /** @type {boolean} */ playing) { return s.b !== null && playing && t >= s.b ? (s.a === null ? 0 : s.a) : null; },
      /** The frame range for the A-B export, or null. */
      exportRange(/** @type {number} */ fps, /** @type {number} */ n) {
        if (s.af === null || s.bf === null) return null;
        return { fa: Math.min(s.af, s.bf), fb: Math.max(s.af, s.bf), fps, n: n || 0, a: s.a, b: s.b };
      },
      presentationRange() {
        if (s.aPts === null || s.bPts === null) return null;
        return { a: Math.min(s.aPts, s.bPts), b: Math.max(s.aPts, s.bPts), early: 0, ...(s.aNative || s.bNative ? { native: true } : {}) };
      },
      /** The toast after A or B. */
      toast(/** @type {(t: number) => string} */ fmtTime) {
        if (s.a !== null && s.b !== null) return `A–B range ${fmtTime(s.a)} – ${fmtTime(s.b)} (loop and export)`;
        if (s.a !== null) return `Range start ${fmtTime(s.a)} (B sets the end)`;
        if (s.b !== null) return `Range end ${fmtTime(s.b)} (A sets the start)`;
        return 'A–B range cleared';
      },
      /** The settings panel's label. */
      label(/** @type {(t: number, ms?: boolean) => string} */ fmtClock) {
        if (s.a === null && s.b === null) return 'Off · press A';
        if (s.b === null) return `Start ${fmtClock(s.a, false)} · press B`;
        if (s.a === null) return `End ${fmtClock(s.b, false)} · press A`;
        return `${fmtClock(s.a, false)} – ${fmtClock(s.b, false)}`;
      },
      /** Seek-bar span and individual endpoints in percent. An unset endpoint is null. */
      marks(/** @type {number} */ dur, offset = 0) {
        if (!dur || (s.a === null && s.b === null)) {
          return { hidden: true, left: 0, width: 0, aPct: null, bPct: null };
        }
        const a = s.a === null ? 0 : Math.max(0, Math.min(1, (s.a + offset) / dur));
        const b = s.b === null ? 1 : Math.max(0, Math.min(1, (s.b + offset) / dur));
        return {
          hidden: false, left: a * 100, width: Math.max(0.3, (b - a) * 100),
          aPct: s.a === null ? null : a * 100, bPct: s.b === null ? null : b * 100,
        };
      },
    };
    return s;
  }

  /**
   * A pin dragged to x (0..1 along the seek bar) of a clip with n frames at fps: the nearest frame and its time,
   * the same snapping the seek bar uses (Math.round(x * (n - 1))). Without a frame count: the plain time.
   */
  function snapPin(/** @type {number} */ x, /** @type {number} */ n, /** @type {number} */ fps, dur = 0) {
    const c = Math.max(0, Math.min(1, Number.isFinite(x) ? x : 0));
    if (!(n > 1) || !(fps > 0)) return { f: 0, t: c * dur };
    const f = Math.round(c * (n - 1));
    return { f, t: f / fps };
  }

  /**
   * Makes a pin (#abA / #abB) draggable along the seek bar. o.rect(): the bar's client rectangle; o.n(), o.fps(),
   * o.dur(): the clip; o.move(which, snap, clientX) while dragging; o.commit(which, snap) on release; o.end() after
   * either release or cancel (Escape, lost capture). The drag never reaches the seek bar or the stage.
   */
  function bindPin(/** @type {any} */ pin, /** @type {'a'|'b'} */ which, /** @type {any} */ o) {
    let active = false;
    const at = (/** @type {any} */ e) => {
      const r = o.rect();
      return snapPin(r.width > 0 ? (e.clientX - r.left) / r.width : 0, o.n(), o.fps(), o.dur());
    };
    const stop = (/** @type {any} */ e) => { e.stopPropagation(); };
    const finish = (/** @type {any} */ e, commit) => {
      if (!active) return;
      active = false;
      try { pin.releasePointerCapture?.(e.pointerId); } catch { /* already released */ }
      pin.classList?.toggle('dragging', false);
      if (commit) o.commit(which, at(e));
      o.end();
    };
    pin.addEventListener('pointerdown', (/** @type {any} */ e) => {
      if (e.button !== undefined && e.button !== 0) return;
      stop(e); e.preventDefault();
      active = true;
      try { pin.setPointerCapture?.(e.pointerId); } catch { /* synthetic pointer */ }
      pin.classList?.toggle('dragging', true);
      o.move(which, at(e), e.clientX);
    });
    pin.addEventListener('pointermove', (/** @type {any} */ e) => { if (!active) return; stop(e); o.move(which, at(e), e.clientX); });
    pin.addEventListener('pointerup', (/** @type {any} */ e) => { stop(e); finish(e, true); });
    pin.addEventListener('pointercancel', (/** @type {any} */ e) => finish(e, false));
    pin.addEventListener('lostpointercapture', (/** @type {any} */ e) => finish(e, false));
    pin.addEventListener('keydown', (/** @type {any} */ e) => { if (active && e.key === 'Escape') { e.stopPropagation(); finish(e, false); } });
    pin.addEventListener('click', stop);
    return { dragging: () => active };
  }

  const api = { create, snapPin, bindPin };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.VpeAbLoop = api;
}(typeof self !== 'undefined' ? self : this));
