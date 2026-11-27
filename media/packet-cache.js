// @ts-check
// Live transcode over a remote link: the H.264 packets the page received, kept by GOP (docs/notes/instant-seek-remote.md).
// A paused seek or step back into a GOP held here decodes from these packets instead of asking the host to send the
// GOP again over the link (1-3 MB at 1080p: seconds on a slow SSH link). Compressed, so a small budget holds minutes.
// The sound received is kept too, as it came (Opus batches or 16-bit PCM), within the same budget: play after a seek
// served from here starts at once with the picture and sound held, while the host sends what follows (engine takeHeld).
// Pure: the engine (media/engine.js) feeds it packets and asks it for runs; Node tests load it directly.
'use strict';

(function (root) {
  /**
   * @typedef {{ t: number, key: boolean, idr?: boolean, data: Uint8Array, discard?: boolean }} Packet
   * @typedef {{ keyT: number, lastT: number, endT?: number, packets: Packet[], bytes: number, used: number, open: boolean,
   *   params: string }} Gop
   * A remote stream's sound item as src/stream-buffer.js takeAudio sends it: Opus (packets with 80 ms of preroll; skip
   * and samples trim the decoded output) or interleaved 16-bit stereo PCM.
   * @typedef {{ kind: 'opus', t: number, sampleRate: number, head: Uint8Array, packets: Uint8Array[], skip: number,
   *   samples: number } | { kind: 's16', t: number, sampleRate: number, data: Uint8Array }} Sound
   * @typedef {{ t: number, end: number, item: Sound, bytes: number, used: number }} SoundChunk
   */

  /** @param {Sound} it */
  const soundSamples = (it) => (it.kind === 'opus' ? it.samples : Math.floor(it.data.byteLength / 4));

  /**
   * The item from time `from` on (the samples before it cut off), or null when nothing is left. Opus decodes from its
   * first packet anyway: only the trim moves.
   * @param {Sound} it @param {number} from
   * @returns {Sound | null}
   */
  function trimSound(it, from) {
    const k = Math.max(0, Math.round((from - it.t) * it.sampleRate));
    const n = soundSamples(it);
    if (k >= n) return null;
    if (!k) return it;
    const t = it.t + k / it.sampleRate;
    if (it.kind === 'opus') return { ...it, t, skip: it.skip + k, samples: it.samples - k };
    return { ...it, t, data: it.data.subarray(k * 4) };
  }

  /**
   * The SPS and PPS of an Annex B keyframe (the host puts them on every IDR: src/stream.js spliceKeyframe), as a string
   * to compare: they change with the picture size, profile and encoder. '' when the packet carries none.
   * @param {Uint8Array} d
   */
  function paramSets(d) {
    let out = '';
    for (let i = 0; i + 3 < d.length; i++) {
      if (d[i] !== 0 || d[i + 1] !== 0 || d[i + 2] !== 1) continue;
      const type = d[i + 3] & 31;
      if (type !== 7 && type !== 8) { if (type === 5 || type === 1) break; continue; }
      let j = i + 3;
      while (j + 2 < d.length && !(d[j] === 0 && d[j + 1] === 0 && (d[j + 2] === 1 || d[j + 2] === 0))) j++;
      if (j + 2 >= d.length) j = d.length;
      for (let k = i + 3; k < j; k++) out += String.fromCharCode(d[k]);
      out += '|';
      i = j - 1;
    }
    return out;
  }

  /** @param {{ cap?: number }} [o] cap: bytes of packets kept (oldest-used GOPs go first) */
  function create(o = {}) {
    const cap = o.cap > 0 ? o.cap : 64e6;
    /** @type {Gop[]} */
    let gops = [];
    /**
     * The GOP each read appends to, by read (gen). Reads interleave: the page's read-ahead and a fill behind the paused
     * frame (media/engine.js fillBehind) arrive in turns, and each keeps its own run. The last few reads only.
     * @type {Map<any, Gop | null>}
     */
    const runs = new Map();
    const MAX_RUNS = 4;
    /** @type {SoundChunk[]} in time order */
    let sound = [];
    let bytes = 0;
    let clock = 0;
    let hits = 0;
    let misses = 0;

    function drop(g) {
      const i = gops.indexOf(g);
      if (i < 0) return;
      gops.splice(i, 1);
      bytes -= g.bytes;
      for (const [gen, r] of runs) if (r === g) runs.set(gen, null);
    }
    const appending = (g) => { for (const r of runs.values()) if (r === g) return true; return false; };

    function dropSound(c) {
      const i = sound.indexOf(c);
      if (i < 0) return;
      sound.splice(i, 1);
      bytes -= c.bytes;
    }

    /** Over the budget: the least recently used GOP or sound chunk goes first (never the GOP a read appends to). */
    function evict() {
      while (bytes > cap && gops.length + sound.length > 1) {
        let old = null;
        for (const g of gops) if (!appending(g) && (!old || g.used < old.used)) old = g;
        let oldSound = null;
        for (const c of sound) if (!oldSound || c.used < oldSound.used) oldSound = c;
        if (oldSound && (!old || oldSound.used < old.used)) { dropSound(oldSound); continue; }
        if (!old) break;
        drop(old);
      }
    }

    /**
     * A sound item as received (src/stream-buffer.js takeAudio). One the new item covers whole (the same sound read
     * again) goes.
     * @param {Sound} it
     */
    function addSound(it) {
      if (!it || (it.kind !== 'opus' && it.kind !== 's16') || !Number.isFinite(it.t) || !(it.sampleRate > 0)) return;
      const n = soundSamples(it);
      if (!(n > 0)) return;
      const end = it.t + n / it.sampleRate;
      const eps = 0.5 / it.sampleRate;
      for (const c of sound.slice()) if (c.t >= it.t - eps && c.end <= end + eps) dropSound(c);
      const size = it.kind === 'opus' ? it.packets.reduce((x, p) => x + p.byteLength, it.head ? it.head.byteLength : 0) : it.data.byteLength;
      const c = { t: it.t, end, item: it, bytes: size, used: ++clock };
      let i = sound.length;
      while (i > 0 && sound[i - 1].t > c.t) i--;
      sound.splice(i, 0, c);
      bytes += size;
      evict();
    }

    /**
     * The sound held from t on without a gap, up to `until`: items trimmed to start exactly at t (each next one cut
     * where the previous ends), and where they end. Null when nothing held starts at or before t.
     * @param {number} t @param {number} [until] @param {number} [eps]
     * @returns {{ items: Sound[], end: number } | null}
     */
    function soundFrom(t, until = Infinity, eps = 0.002) {
      const items = [];
      let x = t;
      while (x < until - 1e-6) {
        let best = null;
        for (const c of sound) if (c.t <= x + eps && c.end > x + 1e-6 && (!best || c.end > best.end)) best = c;
        if (!best) break;
        const it = trimSound(best.item, x);
        if (!it) break;
        best.used = ++clock;
        items.push(it);
        x = best.end;
      }
      return items.length ? { items, end: x } : null;
    }

    /**
     * A video packet of read `gen`, in decode order. Each read appends to its own GOP: a packet never joins another
     * read's run. A packet without a time ends the read's run; packets before the read's first keyframe are not kept
     * (nothing could decode them).
     * @param {any} gen @param {Packet} p
     */
    function add(gen, p) {
      if (!runs.has(gen)) {
        runs.set(gen, null);
        if (runs.size > MAX_RUNS) {
          const [oldest, r] = runs.entries().next().value;
          if (r) r.open = false;
          runs.delete(oldest);
        }
      }
      let cur = runs.get(gen) || null;
      if (!(Number.isFinite(p.t)) || !p.data) { if (cur) cur.open = false; runs.set(gen, null); return; }
      if (p.key && p.idr !== false) {
        // Read on into the next keyframe: nothing lies between this GOP's last frame and it.
        if (cur) { cur.open = false; cur.endT = p.t; }
        const params = paramSets(p.data);
        for (const g of gops.slice()) {
          // The same GOP read again (a later seek, another tier): the newer copy replaces it.
          if (Math.abs(g.keyT - p.t) < 1e-4) drop(g);
          // The host changed the stream (picture size, encoder, profile): what it sends now is what a seek would get.
          else if (params && g.params && g.params !== params) drop(g);
        }
        cur = { keyT: p.t, lastT: p.t, packets: [], bytes: 0, used: ++clock, open: true, params };
        gops.push(cur);
        runs.set(gen, cur);
      }
      if (!cur) return;
      // Out of order: B-frames (a Direct Stream copy of the source). Decode order then differs from frame order, so
      // "the packets up to t" would not be the frames up to t: the GOP is not kept at all (the host is asked).
      if (!p.key && !(p.t > cur.lastT - 1e-6) && cur.packets.length) { drop(cur); return; }
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

    /**
     * Read `gen` ended at `endT` with nothing between its last frame and endT (a fill from the host ends exactly where
     * the packets it was asked for begin): its last GOP then covers the time up to endT, as if a keyframe followed.
     * @param {any} gen @param {number} endT
     */
    function close(gen, endT) {
      const cur = runs.get(gen);
      if (!cur) return;
      cur.open = false;
      if (endT > cur.lastT) cur.endT = endT;
      runs.set(gen, null);
    }

    /** The packets after `t` in the same GOP (read ahead after the target, for a step forward). */
    function after(keyT, t, eps = 1e-4) {
      const g = gops.find((x) => Math.abs(x.keyT - keyT) < eps);
      return g ? g.packets.filter((p) => p.t > t + eps) : [];
    }

    function clear() { gops = []; sound = []; runs.clear(); bytes = 0; }

    return {
      add, find, after, close, clear, addSound, soundFrom,
      stats: () => ({ gops: gops.length, sound: sound.length, bytes, cap, hits, misses }),
      /** Covered spans [keyT, lastT], for the debug probe and tests. */
      spans: () => gops.map((g) => [g.keyT, g.lastT, g.packets.length]).sort((a, b) => a[0] - b[0]),
    };
  }

  const api = { create, trimSound };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else /** @type {any} */ (root).VpePacketCache = api;
}(typeof self !== 'undefined' ? self : this));
