'use strict';
// Live transcode's kept-running decoder (docs/notes/instant-seek-remote.md, "A decoder kept running behind a pipe").
//
// A paused jump outside what the host holds starts a new ffmpeg today: spawn, probe, open, hardware init (NVDEC/NVENC)
// before the first frame, 100-300 ms on a 4K HEVC source. Here one ffmpeg with the stream's own pipeline (decode,
// scale, tone-map, encode) keeps running, reading MPEG-TS on stdin. A jump spawns only a cheap copy remux of the source
// from the target's keyframe (`-c copy`, no decoder: ~25 ms) and feeds its packets in. Frame-exact by timestamps:
//
// - The remux rewrites each packet's time (setts) onto the warm clock: the target frame at S (a segment start past
//   anything fed before), the frames after it at S + n/fps, the frames before it (decoded for their references only) half
//   a frame off that grid, so a select right after the decoder drops them. A frame is chosen as in the per-seek path:
//   the source frame at the file's start + t (constant-rate sources whose frames sit on that grid only).
// - Every segment starts with an end-of-sequence NAL (H.264 / HEVC), so the decoder treats its keyframe as a fresh start
//   (an open-GOP CRA skips its leading pictures, as after a real seek) and gives up the old segment's held pictures.
// - The encoder forces an IDR on the first frame of a segment (a jump of the warm clock, force_key_frames).
// - The output is MPEG-TS: each frame's time says which segment it belongs to (older ones are dropped) and which frame
//   it is; a frame out of sequence, or a first frame that is not an IDR with SPS/PPS, fails the segment and the stream
//   goes back to ffmpeg per seek for this video.
//
// Pure helpers (arguments, MPEG-TS packets) plus WarmDecoder / WarmSegment (the process and a proc-like view of one
// jump that src/stream.js treats as its video ffmpeg). Tests: test/host/warm_decoder_test.js.

const { EventEmitter } = require('events');

const TS = 188;
// A warm process ends after this long without a segment (maintainer decision 2026-11-27).
const WARM_IDLE_MS = 60000;
// Sources whose packets go into MPEG-TS untouched and whose decoders honour an end-of-sequence NAL.
const WARM_CODECS = ['h264', 'hevc'];
// Encoders checked to force an IDR (with SPS/PPS) where asked; the others keep ffmpeg per seek.
const WARM_ENCODERS = ['libx264', 'h264_nvenc'];
// Containers whose packets carry their own presentation times (not AVI, not raw streams).
const WARM_CONTAINERS = /(^|,)(mov|mp4|m4a|3gp|3g2|mj2|matroska|webm|mpegts)(,|$)/;
// The warm clock (seconds): the first segment starts here (room for a long source GOP before it), each next one this
// far past the latest time fed, and a new process starts before MPEG-TS's 33-bit 90 kHz clock wraps.
const FIRST_S = 600;
const GAP_S = 2;
const WRAP_S = 2 ** 33 / 90000 - 600;
// No picture this long after the target was fed: the process is stuck (fails the segment). Only the frames after the
// target and the few the decoder holds are left to decode by then; the slowest first start measured is under 1 s.
const STALL_MS = 5000;
// An output frame off its grid slot by more than this share of a frame is out of sequence.
const GRID_TOLERANCE = 0.15;

/**
 * Why a source cannot use the kept-running decoder ('' when it can).
 * @param {any} probed src/ffmpeg.js probe result
 */
function warmSourceRefusal(probed) {
  const v = probed && probed.video;
  if (!v) return 'no video';
  if (!WARM_CODECS.includes(v.codec)) return `codec ${v.codec}`;
  if (!WARM_CONTAINERS.test(String(probed.formatName || ''))) return `container ${probed.formatName || '?'}`;
  if (v.cfr !== true) return 'variable frame rate';
  if (/^(tt|bb|tb|bt)$/.test(v.fieldOrder || '')) return 'interlaced';
  if (!(v.fps > 0) || !Number.isFinite(v.fileStart)) return 'no start time';
  // Frames on the grid from the file's start (src/stream.js args seeks to the file's start + t).
  const off = (Number(v.startTime) - v.fileStart) * v.fps;
  if (!Number.isFinite(off) || Math.abs(off - Math.round(off)) > 0.01) return 'frames off the file\'s time grid';
  return '';
}

/** Keeps a decoded frame only on the warm clock's grid (frames before a target are half a frame off it). */
function warmSelect(fps) {
  return `select='lt(abs(t*${fps}-round(t*${fps}))\\,0.25)'`;
}

/**
 * Encoder arguments of the warm process: an IDR at every jump of the warm clock (a new segment) and every gopS while it
 * runs; NVENC makes forced keyframes IDRs only when asked.
 * @param {string} encoder @param {number} gopS @param {number} fps
 */
function warmKeyArgs(encoder, gopS, fps) {
  const every = Math.max(0.05, gopS - 0.5 / fps);
  return ['-force_key_frames', `expr:if(isnan(prev_forced_t),1,gte(t,prev_forced_t+${every.toFixed(4)}))`,
    ...(encoder === 'h264_nvenc' ? ['-forced-idr', '1'] : [])];
}

/** The warm process's input options (MPEG-TS on stdin, times kept). */
const WARM_INPUT = ['-probesize', '1048576', '-analyzeduration', '0', '-copyts', '-f', 'mpegts', '-i', 'pipe:0'];
/** Its output: MPEG-TS (each frame's time), the PES length written when it fits so small frames complete at once. */
const WARM_OUTPUT = ['-muxdelay', '0', '-muxpreload', '0', '-omit_video_pes_length', '0', '-f', 'mpegts'];

/**
 * The remux for one segment: the source's video packets from the keyframe at or before the target, copied, their times
 * moved onto the warm clock (see the file comment).
 * @param {{ file: string, streamIndex: number, t: number, fps: number, fileStart: number, S: number }} o
 */
function remuxArgs({ file, streamIndex, t, fps, fileStart, S }) {
  const tgt = (fileStart + t).toFixed(6);
  const k = (/** @type {string} */ v) => `((${v}*TB-${tgt})*${fps})`;
  // Before the target: whole frames half a frame early (off the grid); from it on: the exact time after S.
  const map = (/** @type {string} */ v) => `(${S.toFixed(6)}+if(lt(round(${k(v)})\\,0)\\,round(${k(v)})-0.5\\,${k(v)})/${fps})/TB`;
  // Seek a quarter frame past the target: a target on a keyframe starts there, not a GOP early.
  return ['-hide_banner', '-nostdin', '-v', 'error', '-ss', Math.max(0, t + 0.25 / fps).toFixed(4), '-copyts',
    '-noautorotate', '-protocol_whitelist', 'file', '-i', file, '-map', `0:${streamIndex}`, '-c', 'copy',
    '-bsf:v', `setts=pts=${map('PTS')}:dts=${map('DTS')}`, '-muxdelay', '0', '-muxpreload', '0', '-f', 'mpegts', 'pipe:1'];
}

/** A PES's 33-bit time at b[q..q+4], in seconds. @param {Buffer} b @param {number} q */
function readPts(b, q) {
  const hi = (b[q] >> 1) & 7;
  const lo = ((b[q + 1] << 22) | ((b[q + 2] >> 1) << 15) | (b[q + 3] << 7) | (b[q + 4] >> 1)) >>> 0;
  return (hi * 2 ** 30 + lo) / 90000;
}

/**
 * Where a video PES starts in TS packet b (its payload offset), or -1.
 * @param {Buffer} b one 188-byte packet
 */
function videoPesAt(b) {
  if (!(b[1] & 0x40)) return -1;
  const afc = (b[3] >> 4) & 3;
  if (!(afc & 1)) return -1;
  const q = afc & 2 ? 5 + b[4] : 4;
  if (q + 14 > TS || b[q] !== 0 || b[q + 1] !== 0 || b[q + 2] !== 1 || (b[q + 3] & 0xf0) !== 0xe0) return -1;
  return q;
}

/** The PID of TS packet b. @param {Buffer} b */
const pidOf = (b) => ((b[1] & 31) << 8) | b[2];

/**
 * One TS packet holding a PES with just an end-of-sequence NAL (H.264 type 10, HEVC type 36), timed like the PES that
 * follows it (ptsBytes: its 5 PTS bytes).
 * @param {number} pid @param {string} codec @param {Buffer} ptsBytes
 */
function eosPacket(pid, codec, ptsBytes) {
  const nal = codec === 'hevc' ? [0, 0, 0, 1, 0x48, 0x01] : [0, 0, 0, 1, 0x0a];
  const pts = Buffer.from(ptsBytes);
  pts[0] = (pts[0] & 0x0f) | 0x20; // '0010' marker: PTS only
  const pes = Buffer.from([0, 0, 1, 0xe0, 0, 0, 0x80, 0x80, 5, ...pts, ...nal]);
  const b = Buffer.alloc(TS, 0xff);
  b[0] = 0x47;
  b[1] = 0x40 | ((pid >> 8) & 31);
  b[2] = pid & 255;
  b[3] = 0x30; // adaptation field (stuffing) and payload; the continuity counter is set when it is sent
  const af = TS - 5 - pes.length;
  b[4] = af;
  if (af > 0) b[5] = 0;
  pes.copy(b, 5 + af);
  return b;
}

/**
 * The remux's output on its way into the warm process: whole 188-byte packets, a video PES only once the next one
 * begins (a segment cut off mid-frame leaves no half frame in the pipe), continuity counters rewritten across segments,
 * an end-of-sequence NAL before a segment's first frame (`eos`), and the times fed (the next segment starts past them).
 * Pure: returns the bytes to write.
 */
class TsFeed {
  /**
   * @param {{ cc: Map<number, number>, codec: string, eos: boolean, S: number, fps: number }} o
   *   cc: continuity counters per PID, shared by every segment of one process
   */
  constructor({ cc, codec, eos, S, fps }) {
    this.cc = cc;
    this.codec = codec;
    this.eos = eos;
    this.S = S;
    this.fps = fps;
    this.rest = Buffer.alloc(0);
    /** @type {Buffer[]} the video PES being collected */
    this.hold = [];
    this.vpid = -1;
    this.maxPts = -Infinity;
    this.firstPts = NaN; // the first frame fed (the keyframe)
    this.post = 0; // frames fed at or after the target
  }

  /** @param {Buffer} chunk @returns {Buffer} */
  push(chunk) {
    const buf = this.rest.length ? Buffer.concat([this.rest, chunk]) : chunk;
    /** @type {Buffer[]} */
    const out = [];
    let o = 0;
    for (; o + TS <= buf.length; o += TS) {
      if (buf[o] !== 0x47) { // lost sync: find the next packet start
        const next = buf.indexOf(0x47, o + 1);
        if (next < 0) { o = buf.length; break; }
        o = next - TS;
        continue;
      }
      const b = Buffer.from(buf.subarray(o, o + TS));
      const pid = pidOf(b);
      const q = videoPesAt(b);
      if (q >= 0) {
        this.vpid = pid;
        out.push(...this.hold);
        this.hold = [];
        if (b[q + 7] & 0x80) {
          const pts = readPts(b, q + 9);
          if (!Number.isFinite(this.firstPts)) {
            this.firstPts = pts;
            if (this.eos) out.push(eosPacket(pid, this.codec, b.subarray(q + 9, q + 14)));
          }
          if (pts > this.maxPts) this.maxPts = pts;
          if (pts >= this.S - 0.5 / this.fps) this.post++;
        }
      }
      if (pid === this.vpid) this.hold.push(b);
      else out.push(b);
    }
    this.rest = Buffer.from(buf.subarray(Math.min(o, buf.length)));
    return this.stamp(out);
  }

  /** The source ended: its last frame too. @returns {Buffer} */
  end() {
    const out = this.hold;
    this.hold = [];
    this.rest = Buffer.alloc(0);
    return this.stamp(out);
  }

  /** @param {Buffer[]} packets */
  stamp(packets) {
    for (const b of packets) {
      if (!((b[3] >> 4) & 1)) continue; // no payload: the counter stays
      const pid = pidOf(b);
      const c = ((this.cc.get(pid) ?? -1) + 1) & 15;
      this.cc.set(pid, c);
      b[3] = (b[3] & 0xf0) | c;
    }
    return packets.length === 1 ? packets[0] : Buffer.concat(packets);
  }
}

/**
 * The warm process's output: one video PES per frame, complete when its length is reached or the next one begins.
 * Pure: push() returns the frames completed ({ pts, data }).
 */
class TsFrames {
  constructor() {
    this.rest = Buffer.alloc(0);
    this.vpid = -1;
    /** @type {{ pts: number, chunks: Buffer[], size: number, need: number } | null} */
    this.cur = null;
  }

  /** @param {Buffer} chunk */
  push(chunk) {
    const buf = this.rest.length ? Buffer.concat([this.rest, chunk]) : chunk;
    /** @type {{ pts: number, data: Buffer }[]} */
    const done = [];
    let o = 0;
    for (; o + TS <= buf.length; o += TS) {
      if (buf[o] !== 0x47) continue;
      const b = buf.subarray(o, o + TS);
      const pid = pidOf(b);
      const q = videoPesAt(b);
      if (q >= 0 && (this.vpid < 0 || pid === this.vpid)) {
        this.vpid = pid;
        this.finish(done);
        const len = (b[q + 4] << 8) | b[q + 5];
        const hlen = b[q + 8];
        const pts = b[q + 7] & 0x80 ? readPts(b, q + 9) : NaN;
        const body = Buffer.from(b.subarray(q + 9 + hlen));
        // PES_packet_length counts from after the length field: 3 header bytes + hlen + payload.
        this.cur = { pts, chunks: [body], size: body.length, need: len ? len - 3 - hlen : 0 };
      } else if (pid === this.vpid && this.cur) {
        const afc = (b[3] >> 4) & 3;
        if (!(afc & 1)) continue;
        const p = afc & 2 ? 5 + b[4] : 4;
        if (p >= TS) continue;
        const body = Buffer.from(b.subarray(p));
        this.cur.chunks.push(body);
        this.cur.size += body.length;
      } else continue;
      if (this.cur && this.cur.need > 0 && this.cur.size >= this.cur.need) this.finish(done);
    }
    this.rest = Buffer.from(buf.subarray(o));
    return done;
  }

  /** The process ended: the last frame too. */
  end() {
    /** @type {{ pts: number, data: Buffer }[]} */
    const done = [];
    this.finish(done);
    return done;
  }

  /** @param {{ pts: number, data: Buffer }[]} done */
  finish(done) {
    const c = this.cur;
    this.cur = null;
    if (!c) return;
    const data = c.chunks.length === 1 ? c.chunks[0] : Buffer.concat(c.chunks);
    done.push({ pts: c.pts, data: c.need > 0 ? data.subarray(0, c.need) : data });
  }
}

/** Whether an Annex B access unit is an IDR with SPS and PPS before it (a decoder can start there). @param {Buffer} data */
function startsDecoder(data) {
  let sps = false;
  let pps = false;
  const prefix = Buffer.from([0, 0, 1]);
  for (let i = data.indexOf(prefix); i >= 0 && i + 3 < data.length; i = data.indexOf(prefix, i + 3)) {
    const type = data[i + 3] & 31;
    if (type === 7) sps = true;
    if (type === 8) pps = true;
    if (type === 5) return sps && pps;
  }
  return false;
}

/**
 * One jump of the warm process, as src/stream.js sees a video ffmpeg: `stdout` emits the H.264 access units (Annex B,
 * AUD first, one per 'data' event) from the target on; 'exit' and 'close' when it ends (code 0: the source ended), with
 * err.text saying why on a failure; kill() ends the jump (the process keeps running).
 */
class WarmSegment extends EventEmitter {
  /** @param {WarmDecoder} dec @param {number} t @param {number} S */
  constructor(dec, t, S) {
    super();
    this.dec = dec;
    this.t = t;
    this.S = S;
    this.warm = true;
    this.directStream = false;
    this.firstKeyBits = 0;
    this.pid = dec.proc ? dec.proc.pid : undefined;
    /** @type {number | null} */
    this.exitCode = null;
    /** @type {string | null} */
    this.signalCode = null;
    this.err = { text: '' };
    this.n = 0; // frames out
    this.t0 = Date.now();
    this.firstMs = -1;
    /** @type {any} */
    this.remux = null;
    /** @type {any} */
    this.stallTimer = null;
    /** @type {TsFeed | null} */
    this.feed = null;
    const seg = this;
    /** @type {Buffer[]} */
    const queued = [];
    let paused = false;
    // The stream pauses its video pipe while it holds enough ahead: the remux stops feeding (the process keeps what it
    // holds) and frames that still come out wait here.
    const out = new EventEmitter();
    Object.assign(out, {
      destroyed: false,
      isPaused: () => paused,
      pause() { if (!paused) { paused = true; seg.dec.pauseFeed(seg); } return out; },
      resume() {
        if (!paused) return out;
        paused = false;
        while (queued.length && !paused && !out.destroyed) out.emit('data', queued.shift());
        if (!paused) seg.dec.resumeFeed(seg);
        return out;
      },
      destroy() { /** @type {any} */ (out).destroyed = true; queued.length = 0; return out; },
      /** @param {Buffer} data */
      deliver(data) {
        if (/** @type {any} */ (out).destroyed) return;
        if (paused) queued.push(data);
        else out.emit('data', data);
      },
    });
    /** @type {any} */
    this.stdout = out;
    /** @type {any} */
    this.stderr = new EventEmitter();
  }

  get closed() { return this.exitCode !== null || this.signalCode !== null; }

  /** Ends this jump (the warm process stays for the next). */
  kill(signal = 'SIGKILL') {
    if (this.closed) return true;
    this.signalCode = signal;
    this.dec.endSegment(this);
    this.emitEnd(null, signal);
    return true;
  }

  /** @param {number} code @param {string} [why] */
  finish(code, why = '') {
    if (this.closed) return;
    this.exitCode = code;
    if (why) this.err.text = why;
    this.dec.endSegment(this);
    this.emitEnd(code, null);
  }

  /** @param {number | null} code @param {string | null} signal */
  emitEnd(code, signal) {
    setImmediate(() => {
      this.emit('exit', code, signal);
      this.emit('close', code, signal);
    });
  }

  /** A frame from the process, already routed to this segment. @param {number} pts @param {Buffer} data */
  frame(pts, data) {
    if (this.closed) return;
    const fps = this.dec.fps;
    const pos = (pts - this.S) * fps;
    const n = Math.round(pos);
    if (!(Math.abs(pos - n) <= GRID_TOLERANCE) || n !== this.n) {
      this.finish(1, `frame ${this.n === 0 ? 'at the target' : this.n} came out as ${pos.toFixed(2)} (frames off a constant rate?)`);
      return;
    }
    if (this.n === 0) {
      if (!startsDecoder(data)) { this.finish(1, 'the first frame is not an IDR with SPS/PPS'); return; }
      this.firstMs = Date.now() - this.t0;
    }
    this.n++;
    this.stdout.deliver(data);
  }
}

/**
 * The kept-running ffmpeg of one Live transcode stream (src/stream.js): `argv` is the stream's own video pipeline with
 * MPEG-TS on stdin and out (stream.js args with { warm: true }), `key` names that configuration (another one needs
 * another process). segment(t) starts a jump; one at a time. Ends after WARM_IDLE_MS without a segment, when the source
 * ended (its last frames need stdin closed), or on dispose(); onEnd is told once, and `release` gives back its GPU
 * encoder session.
 */
class WarmDecoder {
  /**
   * @param {{ ffmpeg: string, argv: string[], key: string, file: string, streamIndex: number, fps: number,
   *   fileStart: number, duration: number, codec: string, spawn: (cmd: string, argv: string[]) => any,
   *   log?: (msg: string) => void, release?: () => void, onEnd?: (why: string) => void, idleMs?: number, stallMs?: number }} o
   */
  constructor(o) {
    this.ffmpeg = o.ffmpeg;
    this.key = o.key;
    this.file = o.file;
    this.streamIndex = o.streamIndex;
    this.fps = o.fps;
    this.fileStart = o.fileStart;
    this.duration = o.duration || 0;
    this.codec = o.codec;
    this.spawnFn = o.spawn;
    this.log = o.log || (() => {});
    this.release = o.release || (() => {});
    this.onEnd = o.onEnd || (() => {});
    this.idleMs = o.idleMs ?? WARM_IDLE_MS;
    this.stallMs = o.stallMs ?? STALL_MS;
    /** @type {Map<number, number>} */
    this.cc = new Map();
    this.fedUntil = -Infinity; // the latest time fed (warm clock)
    this.segments = 0;
    /** @type {WarmSegment | null} */
    this.seg = null;
    this.ended = false; // stdin closed (the source ended): no more segments
    this.dead = false;
    this.err = '';
    /** @type {any} */
    this.idleTimer = null;
    this.frames = new TsFrames();
    this.proc = this.spawnFn(this.ffmpeg, o.argv);
    const proc = this.proc;
    proc.on('error', (/** @type {any} */ e) => { this.err += String(e && e.message || e); });
    if (proc.stdin) proc.stdin.on('error', () => {}); // a dead process: its exit says why
    if (proc.stderr) proc.stderr.on('data', (/** @type {any} */ d) => { this.err = (this.err + d).slice(-2000); });
    proc.stdout.on('data', (/** @type {Buffer} */ d) => { for (const f of this.frames.push(d)) this.route(f); });
    proc.on('close', (/** @type {number | null} */ code, /** @type {string | null} */ signal) => {
      for (const f of this.frames.end()) this.route(f);
      const seg = this.seg;
      const why = this.err.trim().split(/\r?\n/).slice(-2).join(' | ');
      if (seg && !seg.closed) {
        if (this.ended && code === 0) seg.finish(0);
        else seg.finish(code || 1, `kept-running decoder ${signal ? `signal ${signal}` : `exit ${code}`}${why ? `: ${why}` : ''}`);
      }
      this.finishAll(this.ended && code === 0 ? 'the source ended' : `exit ${signal || code}${why ? `: ${why}` : ''}`);
    });
  }

  /** Whether segment() can start one now. */
  get usable() { return !this.dead && !this.ended; }

  /**
   * A jump to t (seconds from the file's start, on the stream's frame grid). null when this process cannot take it (it
   * ended, or its clock would wrap): the caller makes a new one.
   * @param {number} t
   */
  segment(t) {
    if (!this.usable) return null;
    if (this.seg) this.seg.kill();
    const S = this.segments === 0 ? FIRST_S : Math.ceil((Math.max(this.fedUntil, FIRST_S) + GAP_S) * this.fps) / this.fps;
    if (S + Math.max(0, this.duration - t) + GAP_S > WRAP_S) return null;
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
    const seg = new WarmSegment(this, t, S);
    seg.feed = new TsFeed({ cc: this.cc, codec: this.codec, eos: this.segments > 0, S, fps: this.fps });
    this.segments++;
    this.seg = seg;
    let remux;
    try {
      remux = this.spawnFn(this.ffmpeg, remuxArgs({ file: this.file, streamIndex: this.streamIndex, t, fps: this.fps, fileStart: this.fileStart, S }));
    } catch (e) {
      seg.finish(1, `remux: ${e && /** @type {any} */ (e).message || e}`);
      return seg;
    }
    seg.remux = remux;
    let rerr = '';
    remux.on('error', (/** @type {any} */ e) => { rerr += String(e && e.message || e); });
    if (remux.stderr) remux.stderr.on('data', (/** @type {any} */ d) => { rerr = (rerr + d).slice(-1000); });
    remux.stdout.on('data', (/** @type {Buffer} */ d) => {
      if (this.seg !== seg || seg.closed || !seg.feed) return;
      this.write(seg, seg.feed.push(d));
      if (seg.feed && seg.feed.post > 0 && seg.n === 0 && !seg.stallTimer) {
        seg.stallTimer = setTimeout(() => {
          if (!seg.closed && seg.n === 0) seg.finish(1, `no picture ${this.stallMs} ms after the target was fed`);
        }, this.stallMs);
      }
    });
    remux.on('close', (/** @type {number | null} */ code, /** @type {string | null} */ signal) => {
      if (this.seg !== seg || seg.closed || !seg.feed) return;
      if (code !== 0 || signal) {
        seg.finish(1, `remux ${signal ? `signal ${signal}` : `exit ${code}`}${rerr.trim() ? `: ${rerr.trim().split(/\r?\n/).pop()}` : ''}`);
        return;
      }
      // The source ended: its last frames come out only when the process sees the end of its input.
      this.write(seg, seg.feed.end());
      this.ended = true;
      if (this.proc.stdin) this.proc.stdin.end();
    });
    return seg;
  }

  /** @param {WarmSegment} seg @param {Buffer} bytes */
  write(seg, bytes) {
    if (seg.feed && seg.feed.maxPts > this.fedUntil) this.fedUntil = seg.feed.maxPts;
    if (!bytes.length || !this.proc.stdin || this.proc.stdin.destroyed) return;
    if (!this.proc.stdin.write(bytes) && seg.remux) {
      seg.remux.stdout.pause();
      this.proc.stdin.once('drain', () => { if (this.seg === seg && !seg.closed && !seg.stdout.isPaused()) seg.remux.stdout.resume(); });
    }
  }

  /** @param {WarmSegment} seg */
  pauseFeed(seg) { if (this.seg === seg && seg.remux) seg.remux.stdout.pause(); }

  /** @param {WarmSegment} seg */
  resumeFeed(seg) {
    if (this.seg !== seg || !seg.remux || seg.closed) return;
    if (this.proc.stdin && this.proc.stdin.writableNeedDrain) return; // 'drain' resumes it
    seg.remux.stdout.resume();
  }

  /** A frame out of the process: to the current segment, or dropped (an older segment's). @param {{ pts: number, data: Buffer }} f */
  route(f) {
    const seg = this.seg;
    if (!seg || seg.closed || !(f.pts >= seg.S - 0.5 / this.fps)) return;
    seg.frame(f.pts, f.data);
  }

  /** A segment ended (killed or finished): its remux stops; with none left the idle timer runs. @param {WarmSegment} seg */
  endSegment(seg) {
    if (seg.remux) {
      const r = seg.remux;
      seg.remux = null;
      if (r.stdout) r.stdout.destroy();
      if (r.exitCode === null && !r.signalCode) { try { r.kill('SIGKILL'); } catch { /* gone */ } }
    }
    seg.feed = null;
    clearTimeout(seg.stallTimer);
    if (this.seg !== seg) return;
    this.seg = null;
    if (this.dead || this.ended) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.dispose(`unused for ${Math.round(this.idleMs / 1000)} s`), this.idleMs);
    if (this.idleTimer.unref) this.idleTimer.unref();
  }

  /** Stops the process (and a segment still running). @param {string} [why] */
  dispose(why = 'stopped') {
    if (this.dead) return;
    if (this.seg && !this.seg.closed) this.seg.kill();
    const proc = this.proc;
    if (proc.stdout) proc.stdout.destroy();
    if (proc.exitCode === null && !proc.signalCode) { try { proc.kill('SIGKILL'); } catch { /* gone */ } }
    this.finishAll(why);
  }

  /** @param {string} why */
  finishAll(why) {
    if (this.dead) return;
    this.dead = true;
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
    this.release();
    this.onEnd(why);
  }
}

module.exports = {
  WarmDecoder, WarmSegment, TsFeed, TsFrames,
  warmSourceRefusal, warmSelect, warmKeyArgs, remuxArgs, eosPacket, startsDecoder, readPts,
  WARM_INPUT, WARM_OUTPUT, WARM_ENCODERS, WARM_CODECS, WARM_IDLE_MS, FIRST_S, GAP_S, WRAP_S, STALL_MS,
};
