'use strict';
// Compatibility facade over the unified Live transcode stream engine (src/stream.js, ADR 0002).
// Keeps the existing RemoteStream exports intact for tests and remote-specific callers.

const { EncodedStream, LINK_TIERS, PCM_KBPS, OPUS_KBPS, LINK_SETTLE_MS, audioEncoderFor, opusArgs } = require('./stream');
const { encoderArgs, encoderFrame, GPU_ENCODERS, CPU_ENCODERS } = require('./transcode_args');
const { probeEncoder, encoderFor, encoderFailed, cpuEncoder, ENCODER_KEY, renderNodes } = require('./transcode_probe');

/** Formats worth streaming: everything the webview can't already decode on the GPU (8-bit 4:2:0 H.264, VP8). */
function wanted(pr) {
  const v = pr && pr.video;
  if (!v) return false;
  if (v.codec === 'vp8') return false;
  if (v.codec === 'h264' && /^(yuv420p|yuvj420p)$/.test(v.pixFmt || '')) return false;
  return true;
}

/** Legacy helper for videoPreviewEnhanced.remoteStream ('on' | 'auto' | 'off'). */
function enabled({ setting, remote, nativeChosen }) {
  if (setting === 'on') return true;
  if (setting === 'off') return false;
  return !!remote && !nativeChosen;
}

module.exports = {
  RemoteStream: EncodedStream,
  EncodedStream,
  wanted,
  enabled,
  encoderArgs,
  encoderFrame,
  renderNodes,
  probeEncoder,
  encoderFor,
  encoderFailed,
  cpuEncoder,
  GPU_ENCODERS,
  CPU_ENCODERS,
  ENCODER_KEY,
  LINK_TIERS,
  PCM_KBPS,
  OPUS_KBPS,
  audioEncoderFor,
  opusArgs,
  LINK_SETTLE_MS,
};
