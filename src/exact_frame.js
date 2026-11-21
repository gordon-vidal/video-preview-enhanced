// @ts-check
// One exact, full-resolution frame of the source file for the pixel tools while Live transcode is active
// (docs/adr/0002-live-transcode.md, docs/PRODUCT.md "Exact frame"): Copy Frame, Save Frame as PNG, the pixel
// inspector and the scopes ask the host for the picture at the current time instead of using the transcoded
// canvas. One short ffmpeg per request, PNG out (lossless, about a third of raw RGB, and the same bytes the
// clipboard and "save" need), so local, WSL and Remote-SSH behave alike: the extension host runs ffmpeg next to
// the file and only the PNG crosses the link.
//
//   ffmpeg -ss T-W -noautorotate -i FILE -map 0:v:0 -frames:v 1 -vf select,reverse,[transpose],scale=in_color_matrix=M -f image2pipe -c:v png -
//
// Input-side -ss seeks a little before T and the filter keeps the last frame at or before T: the source frame the
// player shows (also in a VFR hold, where an accurate seek to T alone would give the next frame). Rotation is applied like the page does (the stream is -noautorotate, the page turns it).
// Pure builders plus a small cancellable runner (ExactFrameGrabber), loadable by a Node test without VS Code.
'use strict';

const { spawn } = require('child_process');
const { lowerPriority } = require('./ffmpeg');

const TIMEOUT_MS = 20000;
const MAX_PNG_BYTES = 128 * 1024 * 1024; // 8K RGB24 PNG stays far below this
const URL_LIKE = /^[a-z][a-z0-9+.-]+:\/\//i; // two letters or more: C:\ is a drive
const HDR_TRANSFERS = new Set(['smpte2084', 'arib-std-b67']);

/** Matrix for the YUV to RGB conversion: the tag when there is one, else what players assume (HD bt709, SD bt601). */
function matrixFor(video) {
  const cs = String((video && video.colorSpace) || '');
  if (/^bt2020/.test(cs)) return 'bt2020';
  if (cs === 'bt709') return 'bt709';
  if (cs === 'bt470bg' || cs === 'smpte170m') return 'bt601';
  if (cs === 'smpte240m') return 'smpte240m';
  // Same rule as the player (media/engine.js matrixBySize): HD by either side.
  return video && (video.width >= 1280 || video.height >= 720) ? 'bt709' : 'bt601';
}

/** ffmpeg filters turning the decoded picture like the page does (rotation: degrees clockwise). */
function rotationFilters(rotation) {
  const r = (((Math.round(Number(rotation) / 90) * 90) % 360) + 360) % 360;
  if (r === 90) return ['transpose=1'];
  if (r === 180) return ['hflip', 'vflip'];
  if (r === 270) return ['transpose=2'];
  return [];
}

/** Why a source can't give an exact frame (null: it can). HDR stays on the canvas: its tone mapping is the page's. */
function unsupported(file, video) {
  if (typeof file !== 'string' || !file || URL_LIKE.test(file)) return 'only video files can give an exact frame, not URLs';
  if (!video) return 'no video stream';
  if (HDR_TRANSFERS.has(String(video.colorTransfer || ''))) return 'HDR video is shown tone mapped; the exact frame is not available for it';
  return null;
}

/**
 * ffmpeg arguments for one exact frame at `t` seconds (from the file's start): the source frame shown at `t`,
 * which is the last one with pts <= t (a VFR source holds a frame across a gap, and Live transcode repeats it
 * at the CFR times inside the gap; an accurate seek to `t` alone would return the NEXT frame there).
 * Decoding starts `window` seconds early; input timestamps then count from that seek, so the filter keeps
 * frames up to `window` and `reverse` makes the last of them the first (a few frames only, see WINDOWS).
 * @param {string} file
 * @param {number} t
 * @param {{video?: any, rotation?: number, index?: number, window?: number}} [o]
 */
function exactFrameArgs(file, t, o = {}) {
  const video = o.video || {};
  const index = Number.isInteger(video.index) ? video.index : (Number.isInteger(o.index) ? o.index : 0);
  const time = Math.max(0, Number(t) || 0) + 0.0005; // rounding of the page's time must not skip the frame
  const ss = Math.max(0, time - (o.window || 0.1));
  const vf = [`select=lte(t\\,${(time - ss).toFixed(4)})`, 'reverse', ...rotationFilters(o.rotation || 0),
    `scale=in_color_matrix=${matrixFor(video)}:flags=accurate_rnd+full_chroma_int`, 'format=rgb24'];
  return ['-hide_banner', '-loglevel', 'error', '-nostdin', '-noautorotate', '-protocol_whitelist', 'file',
    ...(ss > 0 ? ['-ss', ss.toFixed(4)] : []), '-i', file, '-map', `0:${index}`, '-an', '-sn', '-dn',
    '-frames:v', '1', '-vf', vf.join(','), '-f', 'image2pipe', '-c:v', 'png', '-compression_level', '1', '-'];
}

/** Seek-back windows to try, in seconds: about two frames, then a gap of seconds, then a long one (memory: frames held). */
function windows(video) {
  const fps = video && video.fps > 0 ? video.fps : 30;
  return [2 / fps + 0.01, 2, 30];
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Width and height from a PNG's IHDR, or null when it is not a PNG. */
function pngSize(buf) {
  if (!buf || buf.length < 24 || !buf.subarray(0, 8).equals(PNG_MAGIC)) return null;
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

/**
 * Per-player grabber: one ffmpeg at a time. A newer request, reload() and dispose() kill the running one;
 * an answer is only delivered while the page that asked is still the current page.
 */
class ExactFrameGrabber {
  /**
   * @param {{spawn?: Function, log?: (m: string) => void, timeoutMs?: number, killGraceMs?: number}} [opts] spawn: test seam
   */
  constructor(opts = {}) {
    this.spawn = opts.spawn || spawn;
    this.log = opts.log || (() => {});
    this.timeoutMs = opts.timeoutMs || TIMEOUT_MS;
    this.run = null; // { abort }
    this.seq = 0; // bumped by every request and cancel: a retry loop of an older one stops
    this.killGraceMs = opts.killGraceMs || 2000;
    this.disposed = false;
  }

  /** Kills the running grab (its promise resolves {cancelled: true}). */
  cancel() {
    this.seq++;
    if (this.run) this.run.abort();
  }

  dispose() {
    this.disposed = true;
    this.cancel();
  }

  /**
   * @param {{tools: {ffmpeg: string, legacy?: boolean}, file: string, t: number, video: any, rotation?: number,
   *   page: number, isCurrent: (page: number) => boolean}} req
   * @returns {Promise<{png?: Buffer, w?: number, h?: number, matrix?: string, error?: string, cancelled?: boolean, stale?: boolean}>}
   */
  grab(req) {
    this.cancel(); // a newer request from the same player supersedes the running one
    const token = ++this.seq;
    const bad = unsupported(req.file, req.video) || (!Number.isFinite(req.t) || req.t < 0 ? 'bad time' : null)
      || (this.disposed ? 'closed' : null);
    if (bad) return Promise.resolve({ error: bad });
    return this.attempts(req, token);
  }

  async attempts(req, token) {
    for (const window of windows(req.video)) {
      if (token !== this.seq || this.disposed) return { cancelled: true };
      const r = await this.once(req, window);
      if (!r.empty) return r.png ? { ...r, matrix: matrixFor(req.video) } : r;
    }
    return { error: 'no source frame at or before this time' };
  }

  /** One ffmpeg run; {empty: true} when it ended well without a picture (the window held no frame yet). */
  once(req, window) {
    return new Promise((resolve) => {
      const proc = lowerPriority(this.spawn(req.tools.ffmpeg, exactFrameArgs(req.file, req.t, { video: req.video, rotation: req.rotation, window }),
        { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }));
      const parts = [];
      let got = 0;
      let err = '';
      let over = false;
      let ended = false;
      let closed = false;
      let killTimer = null;
      const done = (r) => {
        if (ended) return;
        ended = true;
        clearTimeout(timer);
        if (this.run === me) this.run = null;
        // A reload replaced the page while ffmpeg ran: its picture must not reach the new one.
        resolve(r.png && !req.isCurrent(req.page) ? { stale: true } : r);
      };
      // SIGTERM first; a wedged ffmpeg (POSIX) gets SIGKILL shortly after, until it has closed.
      const kill = () => {
        try { proc.kill(); } catch { /* gone */ }
        if (closed || killTimer) return;
        killTimer = setTimeout(() => { if (!closed) { try { proc.kill('SIGKILL'); } catch { /* gone */ } } }, this.killGraceMs);
        if (killTimer.unref) killTimer.unref();
      };
      const me = { abort: () => { kill(); done({ cancelled: true }); } };
      this.run = me;
      const timer = setTimeout(() => { kill(); done({ error: 'timed out' }); }, this.timeoutMs);
      proc.stdout.on('data', (d) => {
        got += d.length;
        if (got > MAX_PNG_BYTES) { over = true; kill(); return; }
        parts.push(d);
      });
      proc.stderr.on('data', (d) => { if (err.length < 2000) err += d; });
      proc.on('error', (e) => done({ error: e.message }));
      proc.on('close', (code) => {
        closed = true;
        clearTimeout(killTimer);
        if (over) { done({ error: 'frame too large' }); return; }
        const png = Buffer.concat(parts, got);
        const size = pngSize(png);
        if (!size) {
          if (err) this.log(`exact frame at ${req.t.toFixed(3)} s: ${err.trim().slice(0, 300)}`);
          done(code === 0 && !err.trim() ? { empty: true } : { error: 'ffmpeg gave no picture at this time' });
          return;
        }
        done({ png, w: size.w, h: size.h });
      });
    });
  }
}

module.exports = { ExactFrameGrabber, exactFrameArgs, windows, rotationFilters, matrixFor, unsupported, pngSize };
