// @ts-check
// Memory budgets from the machine's memory (docs/notes/startup-memory.md).
// The fixed sizes the player had until 0.5 are the budgets of a 32 GB machine; smaller
// machines get proportionally less, down to a floor that still plays 4K. Used by the
// extension host (os.totalmem / os.freemem, local windows) and by the webview (remote windows:
// navigator.deviceMemory, which browsers report as at most 8 GB).
'use strict';

(function (root) {
  const GB = 1024 ** 3;
  // [value at 32 GB and above (the old fixed size), value at 8 GB, floor]
  const TABLE = {
    frames: [400e6, 160e6, 96e6], // engine: decoded pictures held ahead (the "Fully decoded" cache when paused)
    pool: [600e6, 240e6, 128e6], // decoder pool: decoded pictures across its segments
    batch: [100e6, 50e6, 32e6], // decoder pool: bytes per answer to 'more'
    blocks: [64e6, 32e6, 16e6], // engine: file blocks cached for the readers
    freeBufs: [64e6, 32e6, 16e6], // each decoder worker: frame buffers kept for reuse
    thumbs: [30e6, 15e6, 8e6], // seek-bar thumbnails
    workers: [6, 3, 1], // decoder pool: extra video workers at most (each has its own WebAssembly heap)
    nativeQueue: [12, 6, 4], // extension host: native frames queued before ffmpeg is paused
  };

  /**
   * The memory to size for, in GB: the total, less when little of it is free (other programs),
   * since a machine that is short now pages as much as a small one. Null: unknown (old defaults).
   * @param {number} total bytes
   * @param {number} [free] bytes available now
   */
  function basisGB(total, free) {
    if (!(total > 0)) return null;
    let b = total;
    // A quarter free or less: size as if the machine had four times what is free (not below a quarter of it).
    if (free && free > 0) b = Math.min(total, Math.max(total / 4, free * 4));
    // Whole GB: a "32 GB" machine reports a little under 32 GiB (memory reserved by the hardware).
    return Math.max(1, Math.round(b / GB));
  }

  /**
   * Budgets for a machine with `gb` GB (null: the 32 GB values). Linear between 8 and 32 GB,
   * proportional below 8 GB, never below the floor; never above the 32 GB value.
   * @param {number | null | undefined} gb
   */
  function budgets(gb) {
    /** @type {Record<string, number>} */
    const out = { gb: gb && gb > 0 ? Math.round(gb * 10) / 10 : 0 };
    for (const [k, [hi, lo, floor]] of Object.entries(TABLE)) {
      let v;
      if (!(gb && gb > 0) || gb >= 32) v = hi;
      else if (gb >= 8) v = lo + ((hi - lo) * (gb - 8)) / 24;
      else v = Math.max(floor, (lo * gb) / 8);
      out[k] = k === 'workers' || k === 'nativeQueue' ? Math.max(floor, Math.round(v)) : Math.round(v);
    }
    return out;
  }

  /** `deviceMemory` reports 8 for any client with 8 GB or more. Use the defaults at that cap. */
  function fromDeviceMemory(gb) { return budgets(gb > 0 && gb < 8 ? gb : null); }

  const api = { budgets, basisGB, fromDeviceMemory, TABLE, GB };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MemBudget = api;
}(typeof self !== 'undefined' ? self : this));
