'use strict';
// Pure activation, migration, remote H.264, bitrate budget and local stall policy for Live transcode (ADR 0002).
// Zero I/O, zero VS Code dependencies — fully testable in Node.

const { webcodecsPlays, FRAME_SERVER_BPS } = require('./decide');

const MODES = ['auto', 'always', 'off'];
const BITRATE_PRESETS = [0, 2, 5, 10, 20, 40]; // 0 = Auto, else Mb/s cap
const MIN_BITRATE_KBPS = 250; // 0.25 Mb/s floor for explicit bitrate caps
const STALL_FPS_RATIO = 0.95;
const STALL_WINDOWS = 3;
const STALL_SETTLE_MS = 1500;
const REMOTE_H264_AUTO_BPS = 12e6; // 12 Mb/s: transcode high-bitrate H.264 over remote links
const REMOTE_H264_DOWNSCALE_BPS = 6e6; // 6 Mb/s when downscaling > 1.3x over remote links
const ZOOM_UPGRADE_THRESHOLD = 1.5; // Compare tiles upgrade toward the source's size when zoomed in this far

/**
 * Resolves the effective Live transcode mode (`auto | always | off`),
 * migrating the deprecated `remoteStream` setting when `transcode` is not explicitly set, and the retired
 * `ask` value (2026-11-23, ADR 0002) to `auto`.
 * @param {{ transcode?: string, transcodeExplicit?: boolean, remoteStream?: string, remoteStreamExplicit?: boolean }} o
 * @returns {'auto'|'always'|'off'}
 */
function resolveSetting(o = {}) {
  if (o.transcode === 'ask') o = { ...o, transcode: 'auto' }; // retired value: stored 'ask' behaves as 'auto'
  if (o.transcodeExplicit && MODES.includes(o.transcode)) return /** @type {any} */ (o.transcode);
  if (o.remoteStreamExplicit) {
    if (o.remoteStream === 'off') return 'off';
    if (o.remoteStream === 'on') return 'always';
    if (o.remoteStream === 'auto') return 'auto';
  }
  return MODES.includes(o.transcode) ? /** @type {any} */ (o.transcode) : 'auto';
}

/** Whether a probed video stream is HDR (PQ/HDR10, HLG, or Dolby Vision side data). Phase 1 keeps HDR on the exact/raw path. */
function isHdr(v) {
  if (!v) return false;
  if (v.dv) return true;
  if (v.colorTrc === 16 || v.colorTrc === 18) return true;
  return /^(smpte2084|arib-std-b67)$/i.test(String(v.colorTransfer || ''));
}

/**
 * Whether raw 8-bit 4:2:0 frame transfer locally exceeds the localhost frame server's comfortable capacity
 * (roughly above 4K 30 fps: 3840*2160*1.5*32 ≈ 398 MB/s).
 */
function exceedsRawTransfer(v) {
  if (!v || !(v.width > 0 && v.height > 0)) return false;
  const fps = v.fps > 0 ? v.fps : 30;
  return v.width * v.height * 1.5 * fps > FRAME_SERVER_BPS * 0.98;
}

/**
 * Whether a video stream can be direct-streamed (lossless H.264 bitstream copy via `-c:v copy`
 * without video re-encoding) into WebCodecs at the current output size, tier, and bitrate cap.
 *
 * @param {any} video Probed video stream metadata.
 * @param {{ tier?: number, h?: number, height?: number, w?: number, width?: number, maxKbps?: number, rotation?: number }} [opts]
 * @returns {boolean}
 */
function canDirectStreamVideo(video, opts = {}) {
  if (!video) return false;
  if (video.codec !== 'h264') return false;
  if ((Number(video.depth) || 8) > 8) return false;
  if (!/^(yuv420p|yuvj420p)$/.test(video.pixFmt || '')) return false;
  if (isHdr(video)) return false;
  if (Number(video.rotation) || Number(opts.rotation)) return false;
  if (Number(opts.tier) > 0) return false;
  const outH = opts.h !== undefined ? opts.h : opts.height;
  if (outH !== undefined && outH > 0 && outH !== video.height) return false;
  const outW = opts.w !== undefined ? opts.w : opts.width;
  if (outW !== undefined && outW > 0 && outW !== video.width) return false;
  const maxKbps = Number(opts.maxKbps) || 0;
  if (maxKbps > 0) {
    const srcKbps = (Number(video.bitRate) || 0) / 1000;
    if (srcKbps > maxKbps) return false;
  }
  return true;
}

/**
 * Whether a video stream qualifies for Live transcode on a remote link (SSH/container/tunnel).
 * Always includes codecs WebCodecs can't play directly; also includes high-bitrate 8-bit H.264
 * when the source bitrate exceeds the configured cap or is high relative to the displayed size.
 */
function remoteQualifies(v, { maxBitrateMbps = 0, viewHeight = 0 } = {}) {
  if (!v) return false;
  if (!webcodecsPlays(v)) return true;
  if (v.codec === 'h264') {
    const bps = Number(v.bitRate) || 0;
    if (maxBitrateMbps > 0 && bps > maxBitrateMbps * 1e6 * 1.1) return true;
    if (bps > REMOTE_H264_AUTO_BPS) return true;
    if (viewHeight > 0 && v.height > viewHeight * 1.3 && bps > REMOTE_H264_DOWNSCALE_BPS) return true;
  }
  return false;
}

/**
 * Sensible automatic max bitrate cap (in kb/s) when `transcodeMaxBitrate` is 0 (Auto).
 * @param {{ w: number, h: number, fps?: number, remote?: boolean }} o
 * @returns {number}
 */
function autoMaxKbps({ w, h, fps = 30, remote = false }) {
  const px = (w || 1920) * (h || 1080);
  const f = fps || 30;
  let kbps;
  if (px > 2560 * 1440) kbps = f > 45 ? 24000 : 16000; // 4K60 -> 24 Mb/s, 4K30 -> 16 Mb/s
  else if (px > 1920 * 1088) kbps = f > 45 ? 18000 : 12000; // 1440p
  else if (px > 1280 * 720) kbps = f > 45 ? 12000 : 8000; // 1080p
  else kbps = 4000;
  return remote ? Math.min(kbps, 20000) : kbps;
}

/**
 * Effective max bitrate cap in kb/s for a stream: explicit user cap if > 0 (clamped to MIN_BITRATE_KBPS),
 * else autoMaxKbps. Shared by initial open and live cap updates so Auto is always consistent.
 * @param {{ maxBitrateMbps?: number, w: number, h: number, fps?: number, remote?: boolean }} o
 * @returns {number}
 */
function effectiveMaxKbps(o) {
  const mbps = Number(o.maxBitrateMbps) || 0;
  if (mbps > 0) return Math.max(MIN_BITRATE_KBPS, Math.round(mbps * 1000));
  return autoMaxKbps(o);
}

/** Calculate caps for the encoded tiles only. Auto budgets each tile for its own output.
 * @param {{w: number, h: number, fps?: number, remote?: boolean}[]} tiles
 */
function compareCapsKbps(tiles, maxBitrateMbps, split = true) {
  if (!(maxBitrateMbps > 0)) return tiles.map(autoMaxKbps);
  const share = maxBitrateMbps * 1000 / (split ? tiles.length : 1);
  return tiles.map(() => Math.max(MIN_BITRATE_KBPS, Math.floor(share)));
}

/**
 * Fit an encoded tile in source orientation, independently of the raw-frame transport budget.
 * `zoom` is the page's picture zoom: below ZOOM_UPGRADE_THRESHOLD a zoom in Fit mode keeps the cell's size (a small
 * Ctrl+wheel tweak must not restart ffmpeg); from there the tile grows toward the source (capped at the video's
 * height and maxHeight), and the shared bitrate cap (compareCapsKbps) still applies. Zooming back to Fit shrinks it.
 */
function compareTileSize(video, maxHeight, { w, h, cols, rows, factor, zoom, actual } = {}, rotated = false) {
  const factorScale = Math.max(0.1, Math.min(64, Number(factor) || 1));
  const z = Number(zoom) > 0 ? Math.max(0.1, Math.min(64, Number(zoom))) : 0;
  let scale = factorScale;
  if (z >= ZOOM_UPGRADE_THRESHOLD) scale = Math.max(factorScale, z);
  else if (z > 1 && factorScale <= z + 0.05) scale = 1;
  const cellW = !actual && w > 0 ? w * scale / Math.max(1, Number(cols) || 1) : Infinity;
  const cellH = !actual && h > 0 ? h * scale / Math.max(1, Number(rows) || 1) : Infinity;
  const [width, height] = rotated ? [cellH, cellW] : [cellW, cellH];
  const hOut = Math.max(2, Math.floor(Math.min(video.height, maxHeight, height, width * video.height / video.width) / 2) * 2);
  const wOut = Math.max(2, Math.floor(Math.round(hOut * video.width / video.height) / 2) * 2);
  return { w: wOut, h: hOut, fps: video.fps };
}

/**
 * Decides what to do when a video opens.
 * Returns { action: 'stream' | 'skip', reason }.
 *
 * @param {{
 *   mode: 'auto'|'always'|'off',
 *   remote: string|undefined,
 *   video: any,
 *   maxBitrateMbps?: number,
 *   viewHeight?: number,
 *   forced?: boolean,
 *   compare?: boolean,
 * }} o
 * @returns {{ action: 'stream'|'skip', reason: string }}
 */
function shouldTranscodeOnOpen(o) {
  const { mode, remote, video, maxBitrateMbps = 0, viewHeight = 0, forced = false, compare = false } = o;
  if (!video) return { action: 'skip', reason: 'no video stream' };
  if (isHdr(video)) return { action: 'skip', reason: 'HDR stays on exact/raw path in v1' };
  if (forced) return { action: 'stream', reason: 'enabled for this session' };
  if (mode === 'off') return { action: 'skip', reason: 'transcode off' };

  const isRemoteLink = !!remote && remote !== 'wsl';
  if (isRemoteLink) {
    if (!remoteQualifies(video, { maxBitrateMbps, viewHeight })) {
      return { action: 'skip', reason: '8-bit H.264/VP8 within link budget plays directly on WebCodecs' };
    }
    return { action: 'stream', reason: `remote window (${remote}), transcode ${mode}` };
  }

  if (compare && mode === 'always') return { action: 'stream', reason: 'transcode always in Compare' };
  // Local or WSL window: 8-bit H.264 and VP8 play directly on WebCodecs at zero cost.
  if (webcodecsPlays(video)) return { action: 'skip', reason: 'WebCodecs plays this directly locally' };
  if (mode === 'always') {
    return { action: 'stream', reason: 'transcode always' };
  }
  if (compare && mode === 'auto' && exceedsRawTransfer(video)) {
    return { action: 'stream', reason: 'Compare tile exceeds the raw frame transfer threshold' };
  }
  return { action: 'skip', reason: `local ${mode}: start on native raw path` };
}

/**
 * Evaluates whether a local native playback session has stalled on raw frame transfer
 * (not on decoding itself) and should switch to Live transcode.
 *
 * @param {{
 *   mode: 'auto'|'always'|'off',
 *   slowWindows: number,
 *   hostKeepsUp: boolean,
 *   playing: boolean,
 *   rate: number,
 *   hidden: boolean,
 *   sinceEventMs: number,
 *   video: any,
 *   alreadyTranscoding: boolean,
 * }} o
 * @returns {'switch'|'none'}
 */
function evaluateLocalStall(o) {
  if (o.mode === 'off' || o.alreadyTranscoding || isHdr(o.video)) return 'none';
  if (!o.playing || o.hidden || Math.abs((o.rate || 1) - 1) > 0.01) return 'none';
  if (o.sinceEventMs < STALL_SETTLE_MS) return 'none';
  if (!o.hostKeepsUp) return 'none'; // decode bottleneck: leave to the GPU decode test
  if (o.slowWindows < STALL_WINDOWS) return 'none';
  return 'switch';
}

// The one-time, non-blocking notice the first time Live transcode starts (2026-11-23: replaces the 'ask' prompts).
const INFORM_KEY = 'videoPreviewEnhanced.transcodeInformed';
const INFORM_ORIGINAL = 'Use original video';
const INFORM_OFF = 'Turn off';

function informText() {
  return 'Live transcode is on for smooth playback: this video is re-encoded to H.264 (lossy) as you watch. '
    + 'Use original video for this tab, or turn it off for every video (also in ⚙ › Live transcode).';
}

function driverNoticeText(notice) {
  const drv = notice && notice.minDriver ? `NVIDIA driver ${notice.minDriver} or newer` : 'a newer NVIDIA driver';
  const api = notice && notice.requiredApi && notice.foundApi ? ` (ffmpeg requires NVENC API ${notice.requiredApi}, driver has ${notice.foundApi})` : '';
  return `Live transcode: hardware NVIDIA encoding needs ${drv}${api}. Update your driver or run "Set Up Optional ffmpeg" to install a driver-compatible build.`;
}

module.exports = {
  MODES,
  BITRATE_PRESETS,
  MIN_BITRATE_KBPS,
  STALL_FPS_RATIO,
  STALL_WINDOWS,
  STALL_SETTLE_MS,
  ZOOM_UPGRADE_THRESHOLD,
  resolveSetting,
  isHdr,
  canDirectStreamVideo,
  exceedsRawTransfer,
  remoteQualifies,
  autoMaxKbps,
  effectiveMaxKbps,
  compareCapsKbps,
  compareTileSize,
  shouldTranscodeOnOpen,
  evaluateLocalStall,
  INFORM_KEY,
  INFORM_ORIGINAL,
  INFORM_OFF,
  informText,
  driverNoticeText,
};
