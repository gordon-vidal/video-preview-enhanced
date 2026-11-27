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
const HISTORY_MAX_BYTES = 64 * 1024 ** 2;
const MAX_QUEUED_AUDIO = 4 * AUDIO_RATE * 4; // four seconds of unsent stereo s16le
const MAX_REGIONS = 4;

/**
 * enc: the encode (one ffmpeg run or fill, src/stream.js) the packet came from.
 * @typedef {{ kind: 'packet', t: number, key: boolean, idr: boolean, data: Uint8Array, enc: number }} VideoPacket
 * @typedef {{ base: number, vBase: number, frameIndex: number, vAll: VideoPacket[], aStore: any[],
 *   aEnd: number, head: Uint8Array | undefined, videoEnded: boolean, audioEnded: boolean, bytes: number }} Region
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
   * @param {{ fps?: number, hasAudio: boolean, audioEncoder?: string | null, remote?: boolean, cacheBytes?: number }} o
   *   fps: the output frame rate (set once known); audioEncoder: the Opus encoder, null for s16 PCM;
   *   remote: the link is a remote one (a longer history is kept)
   */
  constructor({ fps = 0, hasAudio, audioEncoder = null, remote = false, cacheBytes = (remote ? 32 : 12) * 1024 ** 2 }) {
    this.remote = remote;
    this.fps = fps;
    this.hasAudio = hasAudio;
    this.audioEncoder = audioEncoder;
    this.cacheBytes = cacheBytes;
    /** @type {Region[]} */
    this.regions = [];
    this.regionBytes = 0;
    this.configuration = '';
    this.seekT = 0; // the last seek target (trim keeps SEEK_KEEP_S before it)
    this.enc = 0; // the encode the packets cut now come from (the stream sets it per ffmpeg run)
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
    this.aNext = 0; // next sample to send
    this.aSeg = 0;
    this.resetAudio(0);
    this.pending = Buffer.alloc(0); // video bytes not yet cut into packets
    this.resetTs();
  }

  /** Starts a fresh audio parser at a sample offset relative to base, discarding prior audio. */
  resetAudio(offset) {
    /** @type {any[]} */
    this.aStore = [];
    this.aEnd = offset;
    this.resumeAudio(offset);
  }

  /**
   * Starts a fresh audio parser at a sample offset relative to base while preserving existing
   * audio history in aStore (so backward seeks right after resuming still hit memory).
   */
  resumeAudio(offset) {
    const seg = ++this.aSeg;
    this.aEnd = Math.max(this.aEnd || 0, offset);
    /** @type {any} */
    const ogg = this.audioEncoder ? new OggOpus((/** @type {any} */ p) => {
      p.s += offset;
      p.seg = seg;
      p.head = ogg.head;
      this.aStore.push(p);
      this.aEnd = Math.max(this.aEnd, p.s + p.n);
    }) : null;
    this.ogg = ogg;
    this.aRest = Buffer.alloc(0);
  }

  setConfiguration(configuration) {
    if (configuration === this.configuration) return;
    this.invalidateRegions();
    this.configuration = configuration;
  }

  invalidateRegions() {
    this.regions.length = 0;
    this.regionBytes = 0;
  }

  archive(videoEnded, audioEnded) {
    if (!this.configuration || !this.vAll.some((p) => p.key)
      || (this.hasAudio && !this.aStore.length)) return;
    const head = this.ogg?.head;
    const bytes = this.vAll.reduce((n, p) => n + p.data.byteLength, head?.byteLength ?? 0)
      + this.aStore.reduce((n, p) => n + p.b.byteLength, 0);
    if (bytes > this.cacheBytes) return;
    const { base, vBase, frameIndex, vAll, aStore, aEnd } = this;
    this.regions.push({ base, vBase, frameIndex, vAll, aStore, aEnd, head, videoEnded, audioEnded, bytes });
    this.regionBytes += bytes;
    while (this.regions.length > MAX_REGIONS || this.regionBytes > this.cacheBytes) {
      this.regionBytes -= this.regions.shift().bytes;
    }
  }

  /** Swaps in the most recent region covering t. Parser fragments belong to the stopped processes. */
  restore(t, videoEnded, audioEnded) {
    for (let i = this.regions.length - 1; i >= 0; i--) {
      const region = this.regions[i];
      const { base, vBase, frameIndex, vAll, aStore, aEnd, head } = region;
      const k = this.seekIndex(vAll, t, false, true);
      const sample = Math.round((t - base) * AUDIO_RATE);
      if (k < 0 || (this.hasAudio && (sample < 0 || sample < aStore[0].s || sample >= aEnd))) continue;
      this.regions.splice(i, 1);
      this.regionBytes -= region.bytes;
      this.archive(videoEnded, audioEnded);
      this.reset(base);
      Object.assign(this, { vBase, frameIndex, vAll, vNext: k, aStore, aEnd, aNext: Math.max(0, sample) });
      if (this.ogg) this.ogg.head = head;
      return { at: vAll[k].t, videoEnded: region.videoEnded, audioEnded: region.audioEnded };
    }
    return null;
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
                pts = (hi * 2 ** 30 + lo) / 90000;
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
    this.vAll.push({ kind: 'packet', t, key, idr: key, data: new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.length)),
      enc: this.enc });
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
      const first = this.aStore.find((p) => p.s + p.n > from && p.s < hi);
      if (!first) return [];
      const seg = first.seg;
      const segEnd = this.aStore.reduce((m, p) => (p.seg === seg ? Math.max(m, p.s + p.n) : m), from);
      const batchHi = Math.min(hi, segEnd);
      const batchN = batchHi - from;
      if (batchN < 1) return [];
      const packets = this.aStore.filter((p) => p.seg === seg && p.s + p.n > from - 3840 && p.s < batchHi);
      if (!packets.length) return [];
      this.aNext = batchHi;
      return [{ kind: 'opus', t: this.base + from / AUDIO_RATE, sampleRate: AUDIO_RATE,
        head: first.head || this.ogg.head, packets: packets.map((p) => new Uint8Array(p.b)),
        skip: from - packets[0].s, samples: batchN }];
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
    let k = 0;
    let bytes = 0;
    let firstKey = this.vNext;
    for (let i = this.vNext - 1; i >= 0; i--) {
      const packet = this.vAll[i];
      bytes += packet.data.byteLength;
      if (bytes > HISTORY_MAX_BYTES) {
        // A GOP may itself exceed the budget. Drop its sent packets and let older seeks restart.
        k = firstKey;
        break;
      }
      if (!packet.key) continue;
      firstKey = i;
      if (packet.t <= keepT) {
        k = i;
        break;
      }
    }
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
   * @param {{ hasProc: boolean, running: boolean, videoEnded: boolean, detached?: boolean, restored?: boolean }} s
   */
  reuse(t, { hasProc, running, videoEnded, detached, restored }) {
    if (!this.vAll.length || (!hasProc && !videoEnded && !restored)) return null;
    const k = this.seekIndex(this.vAll, t, running, restored && !hasProc);
    if (k < 0) return null;
    const s = Math.max(0, Math.round((t - this.base) * AUDIO_RATE));
    const have = this.aStore.length ? this.aStore[0].s : this.aEnd;
    if (this.hasAudio && (s < have || (detached && (t < this.base || s >= this.aEnd)))) return null;
    this.vNext = k;
    this.aNext = s;
    return this.vAll[k].t;
  }

  /** @param {VideoPacket[]} packets */
  seekIndex(packets, t, running, archived = false) {
    if (!packets.length) return -1;
    const eps = archived ? 1e-9 : 0.25 / this.fps;
    const last = archived ? packets.reduce((max, p) => Math.max(max, p.t), -Infinity) : packets[packets.length - 1].t;
    if (t > last + eps && !(running && t <= last + REUSE_AHEAD_S)) return -1;
    for (let i = packets.length - 1; i >= 0; i--) if (packets[i].key && packets[i].t <= t + eps) return i;
    return -1;
  }

  /** Frees everything held. */
  clear() {
    this.setConfiguration('');
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
