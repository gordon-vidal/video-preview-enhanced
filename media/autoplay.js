// @ts-check
// Autoplay (setting videoPreviewEnhanced.onEnd): what the player does when a video plays to its end. Off stops on the
// last frame, Loop starts over, Play next in folder opens the next video of the playing file's folder once. An A–B
// range always wins. Pure, so the page (media/player-ui.js), the engine tests (test/engine/frames_onend.js) and the
// unit tests share one decision.
'use strict';

(function (root) {
  // checkJs: start
  const MODES = /** @type {const} */ (['off', 'next', 'loop']);
  const LABEL = { off: 'Off', next: 'Play next in folder', loop: 'Loop' };
  /** A run shorter than this (media seconds from the last play or seek) is a seek to the end, not playback reaching it. */
  const MIN_RUN = 0.25;

  /** @param {any} m @returns {'off'|'next'|'loop'} */
  const parse = (m) => (MODES.includes(m) ? m : 'off');
  /** @param {any} m */
  const label = (m) => LABEL[parse(m)];
  /** R and the right-click menu's Loop: Loop and Off swap; Play next in folder becomes Loop. @param {any} m */
  const toggleLoop = (m) => (parse(m) === 'loop' ? 'off' : 'loop');
  /** Whether the decoder itself should start over at the end: Loop with no A–B range (the range wraps instead). */
  const engineLoops = (/** @type {any} */ m, /** @type {boolean} */ abSet) => parse(m) === 'loop' && !abSet;

  /**
   * The end of the file was reached and the decoder paused there. What now?
   * - 'ab': an A–B range is set: back to A (or the start) and play on; it wins over everything.
   * - 'next': Play next in folder, and playback really ran into the end (forward, visible, not a seek to the end).
   * - 'stop': stay paused on the last frame.
   * @param {{ mode: any, a: number|null, b: number|null, natural: boolean, hidden?: boolean, rate?: number, file?: boolean }} s
   * @returns {{ action: 'ab', to: number } | { action: 'next' | 'stop' }}
   */
  function atEnd(s) {
    if (s.a !== null && s.a !== undefined) return { action: 'ab', to: s.a };
    if (s.b !== null && s.b !== undefined) return { action: 'ab', to: 0 };
    if (parse(s.mode) === 'next' && s.natural && !s.hidden && (s.rate === undefined || s.rate > 0) && s.file !== false) return { action: 'next' };
    return { action: 'stop' };
  }

  /** Whether a pause at the end came from playback running into it: `ran` media seconds since the last play or seek. */
  const natural = (/** @type {{ playing: boolean, ran: number, hidden?: boolean }} */ s) => !!s.playing && !s.hidden && s.ran >= MIN_RUN;

  // checkJs: end
  const api = { MODES, LABEL, MIN_RUN, parse, label, toggleLoop, engineLoops, atEnd, natural };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else /** @type {any} */ (root).VpeAutoplay = api;
}(typeof self !== 'undefined' ? self : this));
