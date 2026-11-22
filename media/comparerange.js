'use strict';

(function (root) {
  function offsetSeconds(offset, fps) {
    return offset.unit === 'ms' ? offset.v / 1000 : offset.v / fps;
  }

  function mapRange(a, b, offset, fps, isClock) {
    // A follower gets the seek nudge and the engine's early presentation allowance.
    return { a: a + offset, b: b + offset, early: isClock ? 0 : 0.5 / fps };
  }

  /**
   * What one tile shows when A or B is set: its own picture's time (source timestamp relative to its first
   * picture) and whether that time is only a slot count. Null when the tile is not on the clock's moment (still
   * seeking, or a picture away): the nominal mapping is used then. expectedRel: where the clock puts the tile.
   */
  function captureTile({ shownRel, markRel, expectedRel, fps, native }) {
    if (!Number.isFinite(shownRel) || !Number.isFinite(markRel) || !(Math.abs(shownRel - expectedRel) <= 1.5 / fps)) return null;
    return { rel: markRel, native: !!native };
  }

  /** A tile's clip range from what it showed at A and at B, else the nominal mapping. */
  function tileRange(capA, capB, nominal) {
    if (!capA || !capB) return nominal;
    return { a: capA.rel, b: capB.rel, early: 0, native: capA.native || capB.native };
  }

  const api = { mapRange, offsetSeconds, captureTile, tileRange };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.VpeCompareRange = api;
}(typeof self !== 'undefined' ? self : this));
