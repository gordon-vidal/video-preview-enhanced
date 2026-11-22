'use strict';
// Real source timestamps for native ffmpeg playback (docs/notes/native-source-pts.md).
//
// ffmpeg used to resample the picture to the probed frame rate (-fps_mode cfr), so the webview
// only knew "frame i is at base + i / fps". An exact A-B clip needs the file's own timestamp of
// the picture on screen (VFR, non-zero start, a seek that lands on the following picture), so
// ffmpeg now passes every decoded picture through unchanged and prints its timestamp on a side
// pipe (the metadata filter). This module pairs them and keeps the constant-rate slots the
// player paces on: a picture holds the slots up to the next one, one that falls on an already
// filled slot is dropped, exactly what cfr did. Pure functions and classes, no I/O.

/** Filter text that prints each picture's timestamp on fd 4 as soon as it passes (direct: no buffering). */
const STAMP_FD = 4;
const STAMP_FILTER = String.raw`metadata=mode=add:key=vpe:value=1,metadata=mode=print:key=vpe:file=pipe\\:${STAMP_FD}:direct=1`;

/** Lines `frame:N pts:P pts_time:T` (and `vpe=1`) from chunks of the pipe; yields {n, pts, time}. */
class StampParser {
  constructor() { this.rest = ''; }

  /** Feed a chunk; returns the stamps completed by it. */
  push(chunk) {
    const text = this.rest + chunk;
    const lines = text.split('\n');
    this.rest = lines.pop();
    const out = [];
    for (const line of lines) {
      const m = /^frame:\s*(\d+)\s+pts:\s*(-?\d+|N\/A)\s+pts_time:\s*(\S+)/.exec(line);
      if (m) out.push({ n: Number(m[1]), pts: m[2] === 'N/A' ? NaN : Number(m[2]), time: Number(m[3]) });
    }
    return out;
  }
}

/**
 * Seconds of a printed stamp. The integer tick count times the stream's time base is exact; the
 * printed pts_time has six significant digits only, so it just guards against a time base that
 * the filter graph changed (then the stamp is not trusted: NaN).
 */
function stampSeconds(stamp, timeBase) {
  const tb = Array.isArray(timeBase) ? timeBase[0] / timeBase[1] : NaN;
  const t = stamp.pts * tb;
  if (!Number.isFinite(t) || !Number.isFinite(stamp.time)) return NaN;
  return Math.abs(t - stamp.time) <= 1e-5 * Math.max(1, Math.abs(stamp.time)) ? t : NaN;
}

/** [num, den] from ffprobe's "1/90000", null when unusable. */
function parseTimeBase(text) {
  const m = /^(\d+)\/(\d+)$/.exec(String(text || ''));
  return m && Number(m[1]) > 0 && Number(m[2]) > 0 ? [Number(m[1]), Number(m[2])] : null;
}

/**
 * Maps decoded pictures onto the constant-rate slots the webview paces on. The first picture of a
 * run takes slot 0 (the start the player asked for), later ones the slot nearest their timestamp
 * relative to it. place() returns null when the picture is dropped, else {hold}: how many extra
 * slots the PREVIOUS picture must still be held (a gap), and the picture takes the next slot.
 */
class Resampler {
  constructor(fps) {
    this.fps = fps > 0 ? fps : 30;
    this.first = NaN;
    this.next = 0; // the first free slot
  }

  place(seconds) {
    if (!Number.isFinite(seconds)) { this.next++; return { hold: 0 }; } // unknown time: one slot, as before
    if (!Number.isFinite(this.first)) {
      this.first = seconds;
      this.next = 1;
      return { hold: 0 };
    }
    const slot = Math.floor((seconds - this.first) * this.fps + 0.5 + 1e-6);
    if (slot < this.next) return null;
    const hold = slot - this.next;
    this.next = slot + 1;
    return { hold };
  }
}

/** The extra header word: microseconds from the slot time to the picture's own, or unknown. */
const SRC_UNKNOWN = -0x80000000;
function encodeSrc(t, src) {
  if (!Number.isFinite(src)) return SRC_UNKNOWN;
  const d = Math.round((src - t) * 1e6);
  return d > SRC_UNKNOWN && d <= 0x7fffffff ? d : SRC_UNKNOWN;
}
function decodeSrc(t, word) {
  return word === SRC_UNKNOWN ? null : t + word / 1e6;
}

module.exports = { STAMP_FD, STAMP_FILTER, StampParser, stampSeconds, parseTimeBase, Resampler, SRC_UNKNOWN, encodeSrc, decodeSrc };
