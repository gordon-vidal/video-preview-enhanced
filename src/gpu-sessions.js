'use strict';
// The host's GPU video encoder sessions (NVENC, QSV, AMF, VA-API, VideoToolbox, Media Foundation): drivers allow only a
// few at once (consumer NVIDIA cards: 8 with a current driver, fewer on older ones), and an encoder opened past the limit
// fails. Every Live transcode encode on this host takes one here first: a live stream, a fill behind a paused frame
// (src/stream.js fill), a sharp paused frame (sharp). Over the budget a live stream encodes that launch on the CPU and
// the shorter jobs are skipped; short jobs leave the last free session to the streams (acquireShort). Host-wide (one
// extension host per machine), so Compare tiles and every open tab count.
// Pure: no VS Code, no ffmpeg; test/host/gpu_sessions_test.js.

const { CPU_ENCODERS } = require('./transcode_args');

const DEFAULT_GPU_SESSIONS = 8;

/** Whether an encoder name takes a GPU session (copy and the CPU encoders do not). @param {string | null | undefined} enc */
function isGpuEncoder(enc) {
  return !!enc && enc !== 'copy' && !CPU_ENCODERS.includes(enc);
}

/** A limit from a setting: a whole number of at least 1 (anything else: the default). @param {any} n */
function limitOf(n) {
  const v = Math.floor(Number(n));
  return Number.isFinite(v) && v >= 1 ? v : DEFAULT_GPU_SESSIONS;
}

/**
 * @param {number} [limit]
 */
function createGpuSessions(limit = DEFAULT_GPU_SESSIONS) {
  let max = limitOf(limit);
  /** @type {Set<{ kind: string, released: boolean }>} */
  const held = new Set();
  let noticed = false;
  return {
    get limit() { return max; },
    /** Sessions taken now. */
    get used() { return held.size; },
    /** By kind ('stream', 'fill', 'sharp' ...), for logs and tests. */
    counts() {
      /** @type {Record<string, number>} */
      const out = {};
      for (const h of held) out[h.kind] = (out[h.kind] || 0) + 1;
      return out;
    },
    /** A lower limit takes effect for new sessions; the ones running keep theirs. @param {any} n */
    setLimit(n) { max = limitOf(n); },
    /**
     * One session for `kind`, or null when the budget is used up.
     * @param {string} kind
     */
    acquire(kind) {
      if (held.size >= max) return null;
      const token = { kind, released: false };
      held.add(token);
      return token;
    },
    /**
     * One session for a short job (a fill, a sharp frame, a quick picture), or null: these never take the last free
     * one, which stays for a live stream (a stream over the budget encodes on the CPU, a short job is just skipped).
     * @param {string} kind
     */
    acquireShort(kind) {
      return held.size + 1 >= max ? null : this.acquire(kind);
    },
    /** Gives a session back; a second release (or null) does nothing. @param {{ released: boolean } | null | undefined} token */
    release(token) {
      if (!token || token.released) return;
      token.released = true;
      held.delete(/** @type {any} */ (token));
    },
    /** True once per extension host session: the "encodes on the CPU" notice is shown once. */
    firstNotice() {
      if (noticed) return false;
      noticed = true;
      return true;
    },
  };
}

/** This host's budget, shared by every stream (the extension sets its limit from the setting). */
const sessions = createGpuSessions();

module.exports = { createGpuSessions, isGpuEncoder, limitOf, sessions, DEFAULT_GPU_SESSIONS };
