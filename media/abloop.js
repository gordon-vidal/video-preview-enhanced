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
      /** Toggles end `which` ('a' | 'b') at time t (s, from the start) showing frame f (0-based). */
      set(/** @type {'a'|'b'} */ which, /** @type {number} */ t, /** @type {number} */ f) {
        if (which === 'a') { s.a = s.a === null ? t : null; s.af = s.a === null ? null : f; } else { s.b = s.b === null ? t : null; s.bf = s.b === null ? null : f; }
        if (s.a !== null && s.b !== null && s.b <= s.a) { const x = s.a; s.a = s.b; s.b = x; const y = s.af; s.af = s.bf; s.bf = y; }
      },
      /** Sets end `which` anew (the context menu's "Set Loop Start / End": never clears). */
      reset(/** @type {'a'|'b'} */ which, /** @type {number} */ t, /** @type {number} */ f) {
        if (which === 'a' && s.a !== null) { s.a = null; s.af = null; }
        if (which === 'b' && s.b !== null) { s.b = null; s.bf = null; }
        s.set(which, t, f);
      },
      clear() { s.a = s.b = s.af = s.bf = null; },
      /** The settings panel's row: start, then end, then off. */
      cycle(/** @type {number} */ t, /** @type {number} */ f) { if (s.a === null) s.set('a', t, f); else if (s.b === null) s.set('b', t, f); else s.clear(); },
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
      /** The toast after A or B. */
      toast(/** @type {(t: number) => string} */ fmtTime) {
        return s.a !== null && s.b !== null ? `Loop ${fmtTime(s.a)} – ${fmtTime(s.b)}` : s.a !== null ? `Loop start ${fmtTime(s.a)} (B sets the end)` : s.b !== null ? `Loop end ${fmtTime(s.b)} (A sets the start)` : 'A-B loop off';
      },
      /** The settings panel's label. */
      label(/** @type {(t: number, ms?: boolean) => string} */ fmtClock) {
        if (s.a === null && s.b === null) return 'Off · press A';
        if (s.b === null) return `Start ${fmtClock(s.a, false)} · press B`;
        if (s.a === null) return `End ${fmtClock(s.b, false)} · press A`;
        return `${fmtClock(s.a, false)} – ${fmtClock(s.b, false)}`;
      },
      /** The marks on the seek bar for a file of `dur` s: hidden, or left and width in percent. */
      marks(/** @type {number} */ dur) {
        if (!dur || (s.a === null && s.b === null)) return { hidden: true, left: 0, width: 0 };
        const a = s.a === null ? 0 : s.a / dur;
        const b = s.b === null ? 1 : s.b / dur;
        return { hidden: false, left: a * 100, width: Math.max(0.3, (b - a) * 100) };
      },
    };
    return s;
  }

  const api = { create };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.VpeAbLoop = api;
}(typeof self !== 'undefined' ? self : this));
