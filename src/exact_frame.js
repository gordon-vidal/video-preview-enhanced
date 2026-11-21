// @ts-check
// One exact, full-resolution frame of the source file for the pixel tools while Live transcode is active
// (docs/adr/0002-live-transcode.md, docs/PRODUCT.md "Exact frame"): Copy Frame, Save Frame as PNG, the pixel
// inspector and the scopes ask the host for the picture at the current time instead of using the transcoded
// canvas. One short ffmpeg per request, PNG out (lossless, about a third of raw RGB, and the same bytes the
// clipboard and "save" need), so local, WSL and Remote-SSH behave alike: the extension host runs ffmpeg next to
// the file and only the PNG crosses the link.
//
//   ffmpeg -ss T -noautorotate -i FILE -map 0:v:0 -frames:v 1 -vf [transpose],scale=in_color_matrix=M -f image2pipe -c:v png -
//
// Input-side -ss seeks to the keyframe before T and (default) accurate seek decodes up to T, so the frame is the
// one the player shows. Rotation is applied like the page does (the stream is -noautorotate, the page turns it).
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
  return video && video.height >= 720 ? 'bt709' : 'bt601';
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
 * ffmpeg arguments for one exact frame at `t` seconds (from the file's start).
 * @param {string} file
 * @param {number} t
 * @param {{video?: any, rotation?: number, legacy?: boolean, index?: number}} [o]
 */
function exactFrameArgs(file, t, o = {}) {
  const video = o.video || {};
  const index = Number.isInteger(video.index) ? video.index : (Number.isInteger(o.index) ? o.index : 0);
  const vf = [...rotationFilters(o.rotation || 0), `scale=in_color_matrix=${matrixFor(video)}:flags=accurate_rnd+full_chroma_int`, 'format=rgb24'];
  // The seek lands 0.5 ms before the frame's own time, as the stream does (src/stream.js): rounding must not skip it.
  const ss = Math.max(0, (Number(t) || 0) - 0.0005);
  return ['-hide_banner', '-loglevel', 'error', '-nostdin', '-noautorotate', '-protocol_whitelist', 'file',
    ...(ss > 0 ? ['-ss', ss.toFixed(4)] : []), '-i', file, '-map', `0:${index}`, '-an', '-sn', '-dn',
    '-frames:v', '1', '-vf', vf.join(','), '-f', 'image2pipe', '-c:v', 'png', '-compression_level', '1', '-'];
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
   * @param {{spawn?: Function, log?: (m: string) => void, timeoutMs?: number}} [opts] spawn: test seam
   */
  constructor(opts = {}) {
    this.spawn = opts.spawn || spawn;
    this.log = opts.log || (() => {});
    this.timeoutMs = opts.timeoutMs || TIMEOUT_MS;
    this.run = null; // { abort }
    this.disposed = false;
  }

  /** Kills the running grab (its promise resolves {cancelled: true}). */
  cancel() {
    if (this.run) this.run.abort();
  }

  dispose() {
    this.disposed = true;
    this.cancel();
  }

  /**
   * @param {{tools: {ffmpeg: string, legacy?: boolean}, file: string, t: number, video: any, rotation?: number,
   *   page: number, isCurrent: (page: number) => boolean}} req
   * @returns {Promise<{png?: Buffer, w?: number, h?: number, error?: string, cancelled?: boolean, stale?: boolean}>}
   */
  grab(req) {
    this.cancel(); // a newer request from the same player supersedes the running one
    const bad = unsupported(req.file, req.video) || (!Number.isFinite(req.t) || req.t < 0 ? 'bad time' : null)
      || (this.disposed ? 'closed' : null);
    if (bad) return Promise.resolve({ error: bad });
    return new Promise((resolve) => {
      const proc = lowerPriority(this.spawn(req.tools.ffmpeg, exactFrameArgs(req.file, req.t, { video: req.video, rotation: req.rotation }),
        { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }));
      const parts = [];
      let got = 0;
      let err = '';
      let over = false;
      let ended = false;
      const done = (r) => {
        if (ended) return;
        ended = true;
        clearTimeout(timer);
        if (this.run === me) this.run = null;
        // A reload replaced the page while ffmpeg ran: its picture must not reach the new one.
        resolve(r.png && !req.isCurrent(req.page) ? { stale: true } : r);
      };
      const kill = () => { try { proc.kill(); } catch { /* gone */ } };
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
      proc.on('close', () => {
        if (over) { done({ error: 'frame too large' }); return; }
        const png = Buffer.concat(parts, got);
        const size = pngSize(png);
        if (!size) {
          if (err) this.log(`exact frame at ${req.t.toFixed(3)} s: ${err.trim().slice(0, 300)}`);
          done({ error: 'ffmpeg gave no picture at this time' });
          return;
        }
        done({ png, w: size.w, h: size.h });
      });
    });
  }
}

module.exports = { ExactFrameGrabber, exactFrameArgs, rotationFilters, matrixFor, unsupported, pngSize };
