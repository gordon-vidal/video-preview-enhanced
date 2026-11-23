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
// Packets kept for seeks back without a restart: HISTORY_S behind the last one sent, and from
// SEEK_KEEP_S before the last seek target, but never more than HISTORY_MAX_S behind the last sent.
const HISTORY_S = 5;
const SEEK_KEEP_S = 1.5;
const HISTORY_MAX_S = 20;
const MAX_QUEUED_AUDIO = 4 * AUDIO_RATE * 4; // four seconds of unsent stereo s16le

/**
 * @typedef {{ kind: 'packet', t: number, key: boolean, idr: boolean, data: Uint8Array }} VideoPacket
 */

class SeekHistoryBuffer {
  /**
   * @param {{ fps?: number, hasAudio: boolean, audioEncoder?: string | null }} o
   *   fps: the output frame rate (set once known); audioEncoder: the Opus encoder, null for s16 PCM
   */
  constructor({ fps = 0, hasAudio, audioEncoder = null }) {
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

  /** @param {Buffer} data one access unit */
  pushPacket(data) {
    let key = false;
    for (let i = data.indexOf(AUD_PREFIX); i >= 0 && i + 3 < data.length; i = data.indexOf(AUD_PREFIX, i + 3)) {
      if ((data[i + 3] & 0x1f) === 5) { key = true; break; }
    }
    const t = this.vBase + this.frameIndex / this.fps;
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
    const keepT = Math.max(lastT - HISTORY_MAX_S, Math.min(lastT - HISTORY_S, this.seekT - SEEK_KEEP_S));
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
  }
}
// checkJs: end

module.exports = { SeekHistoryBuffer, AUDIO_RATE, MAX_QUEUED_AUDIO };
