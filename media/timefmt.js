// @ts-check
// Time and frame labels of the player (media/player.js): the clock, timecode, file size and the
// frame counter. Pure functions, also loaded by the unit tests (test/unit/timefmt_test.js).
'use strict';

(function (root) {
  /** m:ss.mmm (h:mm:ss.mmm), rounded to milliseconds: tooltips, toasts, the info panel. */
  const fmtTime = (/** @type {number} */ t) => {
    if (!isFinite(t) || t < 0) t = 0;
    const h = Math.floor(t / 3600);
    const m = Math.floor((t % 3600) / 60);
    const s = t - h * 3600 - m * 60;
    return `${h ? `${h}:${String(m).padStart(2, '0')}` : m}:${s.toFixed(3).padStart(6, '0')}`;
  };
  /** m:ss.mmm (h:mm:ss.mmm), milliseconds cut (never rounded up to the next second); without them when asked. */
  const fmtClock = (/** @type {number} */ t, ms = true) => {
    if (!isFinite(t) || t < 0) t = 0;
    const h = Math.floor(t / 3600);
    const m = Math.floor((t % 3600) / 60);
    const sec = t - h * 3600 - m * 60;
    const whole = Math.floor(sec + 1e-6);
    return `${h ? `${h}:${String(m).padStart(2, '0')}` : m}:${String(whole).padStart(2, '0')}${ms ? `.${String(Math.min(999, Math.floor((sec - whole) * 1000 + 1e-6))).padStart(3, '0')}` : ''}`;
  };
  /** SMPTE timecode hh:mm:ss:ff of frame index f (non-drop, at the rounded frame rate). */
  const fmtTimecode = (/** @type {number} */ f, /** @type {number} */ fps) => {
    const r = Math.max(1, Math.round(fps || 30));
    const secs = Math.floor(f / r);
    const pad = (/** @type {number} */ n) => String(n).padStart(2, '0');
    return `${pad(Math.floor(secs / 3600))}:${pad(Math.floor(secs / 60) % 60)}:${pad(secs % 60)}:${pad(f % r)}`;
  };
  const fmtSize = (/** @type {number} */ b) => (b > 1e9 ? `${(b / 1e9).toFixed(2)} GB` : `${(b / 1e6).toFixed(1)} MB`);
  /** The frame counter: "#<1-based frame>/<frames>" ("?" while the count is unknown). */
  const frameText = (/** @type {number} */ f, /** @type {number} */ n) => `#${f + 1}/${n || '?'}`;

  const api = { fmtTime, fmtClock, fmtTimecode, fmtSize, frameText };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.VpeTime = api;
}(typeof self !== 'undefined' ? self : this));
