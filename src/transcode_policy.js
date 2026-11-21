'use strict';
// Pure activation, migration, remote H.264, bitrate budget and local stall policy for Live transcode (ADR 0002).
// Zero I/O, zero VS Code dependencies — fully testable in Node.

const { webcodecsPlays, FRAME_SERVER_BPS } = require('./decide');

const MODES = ['ask', 'auto', 'always', 'off'];
const BITRATE_PRESETS = [0, 2, 5, 10, 20, 40]; // 0 = Auto, else Mb/s cap
const MIN_BITRATE_KBPS = 250; // 0.25 Mb/s floor for explicit bitrate caps
const STALL_FPS_RATIO = 0.95;
const STALL_WINDOWS = 3;
const STALL_SETTLE_MS = 1500;
const REMOTE_H264_AUTO_BPS = 12e6; // 12 Mb/s: transcode high-bitrate H.264 over remote links
const REMOTE_H264_DOWNSCALE_BPS = 6e6; // 6 Mb/s when downscaling > 1.3x over remote links

/**
 * Resolves the effective Live transcode mode (`ask | auto | always | off`),
 * migrating the deprecated `remoteStream` setting when `transcode` is not explicitly set.
 * @param {{ transcode?: string, transcodeExplicit?: boolean, remoteStream?: string, remoteStreamExplicit?: boolean }} o
 * @returns {'ask'|'auto'|'always'|'off'}
 */
function resolveSetting(o = {}) {
  if (o.transcodeExplicit && MODES.includes(o.transcode)) return /** @type {any} */ (o.transcode);
  if (o.remoteStreamExplicit) {
    if (o.remoteStream === 'off') return 'off';
    if (o.remoteStream === 'on') return 'always';
    if (o.remoteStream === 'auto') return 'auto';
  }
  return MODES.includes(o.transcode) ? /** @type {any} */ (o.transcode) : 'ask';
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

/**
 * Decides what to do when a video opens.
 * Returns { action: 'stream' | 'prompt_remote' | 'skip', reason }.
 *
 * @param {{
 *   mode: 'ask'|'auto'|'always'|'off',
 *   remote: string|undefined,
 *   video: any,
 *   maxBitrateMbps?: number,
 *   viewHeight?: number,
 *   forced?: boolean,
 *   remotePrompted?: boolean,
 * }} o
 * @returns {{ action: 'stream'|'prompt_remote'|'skip', reason: string }}
 */
function shouldTranscodeOnOpen(o) {
  const { mode, remote, video, maxBitrateMbps = 0, viewHeight = 0, forced = false, remotePrompted = false } = o;
  if (!video) return { action: 'skip', reason: 'no video stream' };
  if (isHdr(video)) return { action: 'skip', reason: 'HDR stays on exact/raw path in v1' };
  if (forced) return { action: 'stream', reason: 'enabled for this session' };
  if (mode === 'off') return { action: 'skip', reason: 'transcode off' };

  const isRemoteLink = !!remote && remote !== 'wsl';
  if (isRemoteLink) {
    if (!remoteQualifies(video, { maxBitrateMbps, viewHeight })) {
      return { action: 'skip', reason: '8-bit H.264/VP8 within link budget plays directly on WebCodecs' };
    }
    if (mode === 'always' || mode === 'auto') return { action: 'stream', reason: `remote window (${remote}), transcode ${mode}` };
    // mode === 'ask': first remote use prompts the user to pick Live transcode vs original quality.
    if (remotePrompted) return { action: 'skip', reason: 'remote transcode prompt already handled this session' };
    return { action: 'prompt_remote', reason: `first remote video (${remote}): ask user` };
  }

  // Local or WSL window: 8-bit H.264 and VP8 play directly on WebCodecs at zero cost.
  if (webcodecsPlays(video)) return { action: 'skip', reason: 'WebCodecs plays this directly locally' };
  if (mode === 'always') {
    return { action: 'stream', reason: 'transcode always' };
  }
  return { action: 'skip', reason: `local ${mode}: start on native raw path` };
}

/**
 * Evaluates whether a local native playback session has stalled on raw frame transfer
 * (not on decoding itself) and should offer or switch to Live transcode.
 *
 * @param {{
 *   mode: 'ask'|'auto'|'always'|'off',
 *   slowWindows: number,
 *   hostKeepsUp: boolean,
 *   playing: boolean,
 *   rate: number,
 *   hidden: boolean,
 *   sinceEventMs: number,
 *   video: any,
 *   alreadyTranscoding: boolean,
 *   promptedThisSession: boolean,
 * }} o
 * @returns {'switch'|'prompt'|'none'}
 */
function evaluateLocalStall(o) {
  if (o.mode === 'off' || o.alreadyTranscoding || isHdr(o.video)) return 'none';
  if (!o.playing || o.hidden || Math.abs((o.rate || 1) - 1) > 0.01) return 'none';
  if (o.sinceEventMs < STALL_SETTLE_MS) return 'none';
  if (!o.hostKeepsUp) return 'none'; // decode bottleneck: leave to the GPU decode test
  if (o.slowWindows < STALL_WINDOWS) return 'none';
  if (o.mode === 'auto' || o.mode === 'always') return 'switch';
  if (o.mode === 'ask' && !o.promptedThisSession) return 'prompt';
  return 'none';
}

const REMOTE_PROMPT_YES = 'Use live transcode';
const REMOTE_PROMPT_NO = 'Keep original quality';

function remotePromptText(remoteName) {
  return `Remote video (${remoteName || 'SSH'}): use Live transcode on the remote machine (H.264 stream, fast playback) or keep original quality (built-in decoder, reads the full file)? You can change this anytime in ⚙ › Live transcode.`;
}

const LOCAL_OFFER_YES = 'Use live transcode';
const LOCAL_OFFER_KEEP = 'Keep current path';
const LOCAL_OFFER_NEVER = "Don't Show Again";

function localOfferText() {
  return 'Playback is falling behind while sending raw frames. Use Live transcode? The video is re-encoded locally to H.264 (8-bit, lossy); pixel tools will warn and offer Use original video.';
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
  resolveSetting,
  isHdr,
  exceedsRawTransfer,
  remoteQualifies,
  autoMaxKbps,
  effectiveMaxKbps,
  shouldTranscodeOnOpen,
  evaluateLocalStall,
  REMOTE_PROMPT_YES,
  REMOTE_PROMPT_NO,
  remotePromptText,
  LOCAL_OFFER_YES,
  LOCAL_OFFER_KEEP,
  LOCAL_OFFER_NEVER,
  localOfferText,
  driverNoticeText,
};
