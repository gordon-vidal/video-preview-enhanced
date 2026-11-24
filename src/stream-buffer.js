'use strict';
// The live transcode stream's memory (src/stream.js EncodedStream): the H.264 packets and sound read from
// ffmpeg, with the history kept for seeks back without a restart. No processes and no timers in here, so a
// Node test can drive it with plain buffers (test/host/stream_buffer_test.js).
const { OggOpus } = require('./remoteopus');
// The checked build has no Node typings: the same Buffer class, typed loosely.
const { Buffer } = /** @type {any} */ (require('node:buffer'));

// checkJs: start
const AUDIO_RATE = 48000;
const AUD = Buffer.from([0, 0, 1, 9]); // access unit delimiter (h264_metadata=aud=insert)
const AUD_PREFIX = AUD.subarray(0, 3);
// A seek this far past the last packet read, with ffmpeg still running, waits for it instead of restarting.
const REUSE_AHEAD_S = 0.5;
// Packets kept for seeks back without a restart: HISTORY_S (REMOTE_HISTORY_S on remote links, where a restart
// costs a round trip and a new encode) behind the last one sent, and from SEEK_KEEP_S before the last seek
// target, but never more than HISTORY_MAX_S behind the last sent.
const HISTORY_S = 8;
const REMOTE_HISTORY_S = 15;
const SEEK_KEEP_S = 3;
const HISTORY_MAX_S = 20;
const MAX_QUEUED_AUDIO = 4 * AUDIO_RATE * 4; // four seconds of unsent stereo s16le

/**
 * @typedef {{ kind: 'packet', t: number, key: boolean, idr: boolean, data: Uint8Array }} VideoPacket
 */

/**
 * The time before which packets (up to the keyframe at or before it) may be dropped.
 * @param {number} lastT time of the last packet sent
 * @param {number} seekT the last seek target
 * @param {boolean} [remote]
 */
function historyKeepTime(lastT, seekT, remote = false) {
  const hist = remote ? REMOTE_HISTORY_S : HISTORY_S;
  return Math.max(lastT - HISTORY_MAX_S, Math.min(lastT - hist, seekT - SEEK_KEEP_S));
}

class SeekHistoryBuffer {
  /**
   * @param {{ fps?: number, hasAudio: boolean, audioEncoder?: string | null, remote?: boolean }} o
   *   fps: the output frame rate (set once known); audioEncoder: the Opus encoder, null for s16 PCM;
   *   remote: the link is a remote one (a longer history is kept)
   */
  constructor({ fps = 0, hasAudio, audioEncoder = null, remote = false }) {
    this.remote = remote;
    this.fps = fps;
    this.hasAudio = hasAudio;
    this.audioEncoder = audioEncoder;
    this.seekT = 0; // the last seek target (trim keeps SEEK_KEEP_S before it)
    this.reset(0);
  }

  /** Forgets everything read and starts an empty stream whose first frame is at t. */
  reset(t) {
    this.base = t;
    this.vBase = t;
    this.frameIndex = 0; // video packets read from this stream
    /** @type {VideoPacket[]} */
    this.vAll = []; // packets read: history already sent, and packets not sent yet
    this.vNext = 0; // index in vAll of the next packet to send
    /** @type {any[]} */
    this.aStore = []; // sound read
    this.aEnd = 0; // samples read
    /** @type {any} */
    this.ogg = this.audioEncoder ? new OggOpus((/** @type {any} */ p) => {
      this.aStore.push(p);
      this.aEnd = Math.max(this.aEnd, p.s + p.n);
    }) : null;
    this.aRest = Buffer.alloc(0); // bytes of a partial sample
    this.aNext = 0; // next sample to send
    this.pending = Buffer.alloc(0); // video bytes not yet cut into packets
    this.resetTs();
  }

  /** Resets MPEG-TS demux state (used for Direct Stream `-c:v copy` PTS-preserving framing). */
  resetTs() {
    this.tsVideoPid = -1;
    this.tsPts = NaN;
    this.tsInUnit = false;
    /** @type {Buffer[]} */
    this.tsChunks = [];
  }

  /** Cuts complete access units (AUD to AUD) off the pending bytes; at the end, the rest too. */
  split(final) {
    const buf = this.pending;
    let start = buf.indexOf(AUD);
    if (start < 0) { if (final) this.pending = Buffer.alloc(0); return; }
    start = start > 0 && buf[start - 1] === 0 ? start - 1 : start;
    for (;;) {
      let next = buf.indexOf(AUD, start + 4);
      if (next < 0) {
        if (final && start < buf.length) this.pushPacket(buf.subarray(start));
        this.pending = final ? Buffer.alloc(0) : Buffer.from(buf.subarray(start));
        return;
      }
      if (buf[next - 1] === 0) next--;
      this.pushPacket(buf.subarray(start, next));
      start = next;
    }
  }

  /**
   * Demuxes single-video-stream MPEG-TS packets from ffmpeg Direct Stream (`-c:v copy -f mpegts`),
   * extracting each PES access unit's Annex B bytes and real 90 kHz PTS (preserving B-frame order,
   * VFR timestamps, and keyframe-aligned seek positions).
   * @param {boolean} final
   */
  splitMpegTs(final) {
    const buf = this.pending;
    let off = 0;
    while (off + 188 <= buf.length) {
      if (buf[off] !== 0x47) { off++; continue; }
      const pusi = (buf[off + 1] & 0x40) !== 0;
      const pid = ((buf[off + 1] & 0x1f) << 8) | buf[off + 2];
      const afc = (buf[off + 3] >> 4) & 3;
      if ((afc & 1) !== 0) {
        let p = off + 4;
        if ((afc & 2) !== 0) p += 1 + buf[p];
        if (p < off + 188) {
          if (pusi && p + 9 <= off + 188 && buf[p] === 0 && buf[p + 1] === 0 && buf[p + 2] === 1 && (buf[p + 3] & 0xf0) === 0xe0) {
            if (this.tsVideoPid < 0) this.tsVideoPid = pid;
            if (pid === this.tsVideoPid) {
              this.flushTsUnit();
              const flags = (buf[p + 7] >> 6) & 3;
              const hlen = buf[p + 8];
              let pts = NaN;
              if (flags >= 2 && p + 14 <= off + 188) {
                const hi = (buf[p + 9] >> 1) & 7;
                const lo = ((buf[p + 10] << 22) | ((buf[p + 11] >> 1) << 15) | (buf[p + 12] << 7) | (buf[p + 13] >> 1)) >>> 0;
                pts = (hi * 4294967296 + lo) / 90000;
              }
              this.tsPts = pts;
              this.tsInUnit = true;
              p += 9 + hlen;
              if (p < off + 188) this.tsChunks.push(Buffer.from(buf.subarray(p, off + 188)));
            }
          } else if (pid === this.tsVideoPid && this.tsInUnit) {
            this.tsChunks.push(Buffer.from(buf.subarray(p, off + 188)));
          }
        }
      }
      off += 188;
    }
    this.pending = final ? Buffer.alloc(0) : Buffer.from(buf.subarray(off));
    if (final) this.flushTsUnit();
  }

  /** Flushes the buffered MPEG-TS video access unit into vAll with its parsed PTS. */
  flushTsUnit() {
    if (!this.tsInUnit) return;
    this.tsInUnit = false;
    const chunks = this.tsChunks;
    const pts = this.tsPts;
    this.tsChunks = [];
    this.tsPts = NaN;
    if (!chunks.length) return;
    const data = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks);
    this.pushPacket(data, pts);
  }

  /**
   * @param {Buffer} data one access unit
   * @param {number} [pts] real presentation time in seconds when available (Direct Stream)
   */
  pushPacket(data, pts) {
    let key = false;
    for (let i = data.indexOf(AUD_PREFIX); i >= 0 && i + 3 < data.length; i = data.indexOf(AUD_PREFIX, i + 3)) {
      if ((data[i + 3] & 0x1f) === 5) { key = true; break; }
    }
    const t = pts !== undefined && Number.isFinite(pts) ? pts : this.vBase + this.frameIndex / this.fps;
    this.frameIndex++;
    this.vAll.push({ kind: 'packet', t, key, idr: key, data: new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.length)) });
  }

  /** Adds sound bytes from ffmpeg. True when enough is queued ahead that the caller should pause the pipe. */
  addAudio(d) {
    if (this.audioEncoder) {
      this.ogg.push(d);
      return this.aEnd - this.aNext >= 4 * AUDIO_RATE;
    }
    const all = this.aRest.length ? Buffer.concat([this.aRest, d]) : Buffer.from(d);
    const n = Math.floor(all.length / 4);
    this.aRest = Buffer.from(all.subarray(n * 4));
    if (!n) return false;
    this.aStore.push({ s: this.aEnd, b: all.subarray(0, n * 4) });
    this.aEnd += n;
    return (this.aEnd - this.aNext) * 4 >= MAX_QUEUED_AUDIO;
  }

  /**
   * The sound from the next unsent sample up to sample hi, as batch items (none when not enough yet).
   * @param {number} hi
   * @param {boolean} audioEnded the sound process finished: Opus then sends short tails too
   */
  takeAudio(hi, audioEnded) {
    const from = this.aNext;
    const n = hi - from;
    if (n < 1) return [];
    if (this.audioEncoder) {
      if (!audioEnded && n < AUDIO_RATE / 2) return [];
      const packets = this.aStore.filter((p) => p.s + p.n > from - 3840 && p.s < hi);
      if (!packets.length) return [];
      this.aNext = hi;
      return [{ kind: 'opus', t: this.base + from / AUDIO_RATE, sampleRate: AUDIO_RATE,
        head: this.ogg.head, packets: packets.map((p) => new Uint8Array(p.b)),
        skip: from - packets[0].s, samples: n }];
    }
    const data = new Uint8Array(n * 4);
    for (const c of this.aStore) {
      const lo = Math.max(from, c.s);
      const top = Math.min(hi, c.s + c.b.length / 4);
      if (top > lo) data.set(c.b.subarray((lo - c.s) * 4, (top - c.s) * 4), (lo - from) * 4);
    }
    this.aNext = hi;
    return [{ kind: 's16', t: this.base + from / AUDIO_RATE, sampleRate: AUDIO_RATE, data }];
  }

  /** Drops what is older than the history kept, from a keyframe on (the first kept packet must decode). */
  trim() {
    if (!this.vNext) return;
    const lastT = this.vAll[this.vNext - 1].t;
    const keepT = historyKeepTime(lastT, this.seekT, this.remote);
    let k = -1;
    for (let i = this.vNext - 1; i >= 0; i--) if (this.vAll[i].key && this.vAll[i].t <= keepT) { k = i; break; }
    if (k > 0) {
      this.vAll.splice(0, k);
      this.vNext -= k;
    }
    const keepFrom = this.vAll.length ? Math.round((this.vAll[0].t - this.base) * AUDIO_RATE) : this.aNext;
    const sMin = Math.max(Math.min(keepFrom, this.aNext), this.aNext - HISTORY_MAX_S * AUDIO_RATE) - (this.audioEncoder ? 4800 : 0);
    while (this.aStore.length && this.aStore[0].s + (this.aStore[0].n ?? this.aStore[0].b.length / 4) <= sMin) this.aStore.shift();
  }

  /**
   * A seek to t that memory can serve: points the send cursors at the keyframe at or before t and returns its
   * time; null when t is outside what is held (the caller restarts ffmpeg).
   * @param {number} t
   * @param {{ hasProc: boolean, running: boolean, videoEnded: boolean }} s the video process
   */
  reuse(t, { hasProc, running, videoEnded }) {
    if (!this.vAll.length || (!hasProc && !videoEnded)) return null;
    const eps = 0.25 / this.fps;
    const last = this.vAll[this.vAll.length - 1].t;
    if (t > last + eps && !(running && t <= last + REUSE_AHEAD_S)) return null;
    let k = -1;
    for (let i = this.vAll.length - 1; i >= 0; i--) if (this.vAll[i].key && this.vAll[i].t <= t + eps) { k = i; break; }
    if (k < 0) return null;
    const s = Math.max(0, Math.round((t - this.base) * AUDIO_RATE));
    const have = this.aStore.length ? this.aStore[0].s : this.aEnd;
    if (this.hasAudio && s < have) return null;
    this.vNext = k;
    this.aNext = s;
    return this.vAll[k].t;
  }

  /** Frees everything held. */
  clear() {
    this.vAll = [];
    this.aStore = [];
    this.pending = Buffer.alloc(0);
    this.aRest = Buffer.alloc(0);
    this.ogg = null;
    this.resetTs();
  }
}
// checkJs: end

module.exports = {
  SeekHistoryBuffer, AUDIO_RATE, MAX_QUEUED_AUDIO, HISTORY_S, REMOTE_HISTORY_S, SEEK_KEEP_S, HISTORY_MAX_S, historyKeepTime,
};
