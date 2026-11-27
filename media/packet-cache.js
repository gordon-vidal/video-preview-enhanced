// @ts-check
// Live transcode over a remote link: the H.264 packets the page received, kept by GOP (docs/notes/instant-seek-remote.md).
// A paused seek or step back into a GOP held here decodes from these packets instead of asking the host to send the
// GOP again over the link (1-3 MB at 1080p: seconds on a slow SSH link). Compressed, so a small budget holds minutes.
// Pure: the engine (media/engine.js) feeds it packets and asks it for runs; Node tests load it directly.
'use strict';

(function (root) {
  /**
   * @typedef {{ t: number, key: boolean, idr?: boolean, data: Uint8Array, discard?: boolean }} Packet
   * @typedef {{ keyT: number, lastT: number, endT?: number, packets: Packet[], bytes: number, used: number, open: boolean }} Gop
   */

  /** @param {{ cap?: number }} [o] cap: bytes of packets kept (oldest-used GOPs go first) */
  function create(o = {}) {
    const cap = o.cap > 0 ? o.cap : 64e6;
    /** @type {Gop[]} */
    let gops = [];
    /** @type {Gop | null} */
    let cur = null; // the GOP the current read appends to
    let curGen = NaN;
    let bytes = 0;
    let clock = 0;
    let hits = 0;
    let misses = 0;

    function drop(g) {
      const i = gops.indexOf(g);
      if (i < 0) return;
      gops.splice(i, 1);
      bytes -= g.bytes;
      if (cur === g) cur = null;
    }

    function evict() {
      while (bytes > cap && gops.length > 1) {
        let old = null;
        for (const g of gops) if (g !== cur && (!old || g.used < old.used)) old = g;
        if (!old) break;
        drop(old);
      }
    }

    /**
     * A video packet of read `gen`, in decode order. A new read (gen) or a packet without a time ends the GOP being
     * appended; packets before the read's first keyframe are not kept (nothing could decode them).
     * @param {number} gen @param {Packet} p
     */
    function add(gen, p) {
      if (gen !== curGen) { if (cur) cur.open = false; cur = null; curGen = gen; }
      if (!(Number.isFinite(p.t)) || !p.data) { if (cur) cur.open = false; cur = null; return; }
      if (p.key && p.idr !== false) {
        // Read on into the next keyframe: nothing lies between this GOP's last frame and it.
        if (cur) { cur.open = false; cur.endT = p.t; }
        // The same GOP read again (a later seek, another tier): the newer copy replaces it.
        for (const g of gops.slice()) if (Math.abs(g.keyT - p.t) < 1e-4) drop(g);
        cur = { keyT: p.t, lastT: p.t, packets: [], bytes: 0, used: ++clock, open: true };
        gops.push(cur);
      }
      if (!cur) return;
      if (!p.key && !(p.t > cur.lastT - 1e-6) && cur.packets.length) { cur.open = false; cur = null; return; } // out of order: stop
      cur.packets.push({ t: p.t, key: p.key, idr: p.idr, data: p.data, discard: p.discard });
      if (p.t > cur.lastT) cur.lastT = p.t;
      cur.bytes += p.data.byteLength;
      bytes += p.data.byteLength;
      evict();
    }

    /**
     * The packets that decode the frame shown at time t: from its GOP's keyframe through the frame at or before t.
     * The GOP must reach t (its last frame at or after t, or read on into the next keyframe after t), so no frame
     * between the found one and t is missing.
     * @param {number} t @param {number} [eps]
     * @returns {{ frameT: number, packets: Packet[], keyT: number } | null}
     */
    function find(t, eps = 1e-4) {
      let best = null;
      for (const g of gops) {
        if (g.keyT > t + eps || (g.lastT < t - eps && !(g.endT > t + eps))) continue;
        if (!best || g.keyT > best.keyT) best = g; // fewest packets to decode
      }
      if (!best) { misses++; return null; }
      let end = 0;
      while (end < best.packets.length && best.packets[end].t <= t + eps) end++;
      if (!end) { misses++; return null; }
      best.used = ++clock;
      hits++;
      const packets = best.packets.slice(0, end);
      const frameT = packets.reduce((x, p) => (p.discard ? x : Math.max(x, p.t)), -Infinity);
      return { frameT, packets, keyT: best.keyT };
    }

    /** The packets after `t` in the same GOP (read ahead after the target, for a step forward). */
    function after(keyT, t, eps = 1e-4) {
      const g = gops.find((x) => Math.abs(x.keyT - keyT) < eps);
      return g ? g.packets.filter((p) => p.t > t + eps) : [];
    }

    function clear() { gops = []; cur = null; curGen = NaN; bytes = 0; }

    return {
      add, find, after, clear,
      stats: () => ({ gops: gops.length, bytes, cap, hits, misses }),
      /** Covered spans [keyT, lastT], for the debug probe and tests. */
      spans: () => gops.map((g) => [g.keyT, g.lastT, g.packets.length]).sort((a, b) => a[0] - b[0]),
    };
  }

  const api = { create };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else /** @type {any} */ (root).VpePacketCache = api;
}(typeof self !== 'undefined' ? self : this));
