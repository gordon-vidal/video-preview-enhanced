'use strict';

(function (root) {
  function offsetSeconds(offset, fps) {
    return offset.unit === 'ms' ? offset.v / 1000 : offset.v / fps;
  }

  function mapRange(a, b, offset, fps, isClock) {
    // A follower gets the seek nudge and the engine's early presentation allowance.
    return { a: a + offset, b: b + offset, early: isClock ? 0 : 0.5 / fps };
  }

  const api = { mapRange, offsetSeconds };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.VpeCompareRange = api;
}(typeof self !== 'undefined' ? self : this));
