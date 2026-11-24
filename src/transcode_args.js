'use strict';
// Pure ffmpeg argument builders and H.264 SPS helpers for Live transcode (ADR 0002).
// Zero I/O, zero VS Code dependencies — fully testable in Node.

const CPU_ENCODERS = ['libx264', 'libopenh264'];
const GPU_ENCODERS = ['h264_nvenc', 'h264_qsv', 'h264_amf', 'h264_mf', 'h264_videotoolbox', 'h264_vaapi'];

/**
 * Low-latency H.264 encoder arguments, no B-frames, 2 s GOP, High profile.
 * Uses best quality (capped VBR / CQ) with strict maxrate = bufsize = cap so the stream
 * never exceeds maxKbps while staying compact on easy or low-fps scenes.
 * @param {string} enc
 * @param {number} fps
 * @param {number} [maxKbps] Strict ceiling in kb/s (0 or omitted -> default 20000 kb/s).
 * @returns {string[]}
 */
function encoderArgs(enc, fps, maxKbps) {
  const g = String(Math.max(1, Math.round((fps || 30) * 2)));
  const cap = maxKbps > 0 ? Math.round(maxKbps) : 20000;
  const capStr = `${cap}k`;
  const bufStr = `${Math.max(1, Math.round(cap))}k`;
  switch (enc) {
    case 'h264_nvenc':
      return ['-c:v', 'h264_nvenc', '-preset', 'p4', '-tune', 'll', '-rc', 'vbr', '-cq', '22', '-b:v', '0',
        '-maxrate', capStr, '-bufsize', bufStr, '-bf', '0', '-g', g, '-profile:v', 'high'];
    case 'h264_qsv':
      return ['-c:v', 'h264_qsv', '-preset', 'veryfast', '-global_quality', '22', '-look_ahead', '0', '-async_depth', '1',
        '-maxrate', capStr, '-bufsize', bufStr, '-bf', '0', '-g', g, '-profile:v', 'high'];
    case 'h264_amf':
      return ['-c:v', 'h264_amf', '-usage', 'lowlatency', '-quality', 'speed', '-rc', 'vbr_peak',
        '-b:v', capStr, '-maxrate', capStr, '-bufsize', bufStr, '-bf', '0', '-g', g, '-profile:v', 'high'];
    case 'h264_mf':
      // -hw_encoding 1 prevents Media Foundation from silently falling back to Microsoft's CPU encoder.
      return ['-c:v', 'h264_mf', '-hw_encoding', '1', '-rate_control', 'quality', '-quality', '75',
        '-b:v', capStr, '-maxrate', capStr, '-bf', '0', '-g', g, '-profile:v', 'high'];
    case 'h264_videotoolbox':
      return ['-c:v', 'h264_videotoolbox', '-realtime', 'true', '-b:v', capStr, '-maxrate', capStr,
        '-bf', '0', '-g', g, '-profile:v', 'high'];
    case 'h264_vaapi':
      return ['-c:v', 'h264_vaapi', '-qp', '22', '-maxrate', capStr, '-bufsize', bufStr,
        '-bf', '0', '-g', g, '-profile:v', 'high'];
    case 'libopenh264':
      // No B-frames in OpenH264. 4 slices on 4 threads: ~3x single-thread speed at 1080p.
      return ['-c:v', 'libopenh264', '-rc_mode', 'quality',
        '-b:v', maxKbps > 0 ? capStr : '8M', '-maxrate', capStr,
        '-allow_skip_frames', '0', '-threads', '4', '-slices', '4', '-g', g, '-profile:v', 'high'];
    default:
      return ['-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-crf', '22',
        '-maxrate', capStr, '-bufsize', bufStr, '-g', g, '-profile:v', 'high'];
  }
}

/**
 * Input pre-options and final pixel-format filter for CPU-decoded frames entering `enc`.
 * @param {string} enc
 * @param {string} [device]
 * @returns {{ pre: string[], vf: string }}
 */
function encoderFrame(enc, device) {
  if (enc === 'h264_vaapi') return { pre: ['-vaapi_device', device || '/dev/dri/renderD128'], vf: 'format=nv12,hwupload' };
  if (enc === 'h264_qsv' || enc === 'h264_amf' || enc === 'h264_mf' || enc === 'h264_videotoolbox') return { pre: [], vf: 'format=nv12' };
  return { pre: [], vf: 'format=yuv420p' };
}

/** Whether a video stream is compatible with zero-copy CUDA decode -> scale_cuda -> NVENC. */
function canCudaFullGpu(v, gpuFilters) {
  if (!v || !gpuFilters || !gpuFilters.has('scale_cuda')) return false;
  if (/^(hevc|av1|vp9)$/.test(v.codec || '') && /^(yuv420p10le|p010le)$/.test(v.pixFmt || '')) return true;
  if (/^(hevc|av1|vp9|h264)$/.test(v.codec || '') && v.pixFmt === 'yuv420p') return true;
  return false;
}

/** Whether a video stream is compatible with zero-copy QSV decode -> vpp_qsv -> h264_qsv. */
function canQsvFullGpu(v, gpuFilters) {
  if (!v || !gpuFilters || !gpuFilters.has('vpp_qsv')) return false;
  return /^(hevc|av1|vp9|h264)$/.test(v.codec || '') && /^(yuv420p|yuv420p10le|nv12|p010le)$/.test(v.pixFmt || 'yuv420p');
}

/** Whether a video stream is compatible with zero-copy VAAPI decode -> scale_vaapi -> h264_vaapi. */
function canVaapiFullGpu(v, gpuFilters) {
  if (!v || !gpuFilters || !gpuFilters.has('scale_vaapi')) return false;
  return /^(hevc|av1|vp9|h264)$/.test(v.codec || '') && /^(yuv420p|yuv420p10le|nv12|p010le)$/.test(v.pixFmt || 'yuv420p');
}

/**
 * Builds the video decode + scale + encode pipeline for ffmpeg.
 * Prefers full GPU decode -> GPU scale -> GPU encode when hardware-compatible,
 * then CPU decode -> GPU encode, then CPU decode -> software encode.
 *
 * @param {{
 *   encoder: string,
 *   device?: string,
 *   decodeMethod?: string,
 *   gpuFilters?: Set<string>|null,
 *   video: { codec?: string, pixFmt?: string },
 *   w: number,
 *   h: number,
 *   fps: number,
 *   maxKbps?: number,
 * }} o
 * @returns {{ pre: string[], vf: string, encArgs: string[], mode: 'gpu-full'|'gpu-encode'|'cpu' }}
 */
function buildVideoPipeline(o) {
  const { encoder, device, decodeMethod, gpuFilters, video, w, h, fps, maxKbps } = o;
  const encArgs = encoderArgs(encoder, fps, maxKbps);
  const isCpu = CPU_ENCODERS.includes(encoder);
  const wantGpuDec = decodeMethod && decodeMethod !== 'none';

  // Full GPU path: keep frames on GPU from decode through scale to H.264 encode.
  if (!isCpu && wantGpuDec) {
    if (encoder === 'h264_nvenc' && (decodeMethod === 'cuda' || decodeMethod === 'auto') && canCudaFullGpu(video, gpuFilters)) {
      return {
        pre: ['-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda'],
        vf: `scale_cuda=w=${w}:h=${h}:format=nv12:interp_algo=bilinear`,
        encArgs,
        mode: 'gpu-full',
      };
    }
    if (encoder === 'h264_qsv' && (decodeMethod === 'qsv' || decodeMethod === 'auto') && canQsvFullGpu(video, gpuFilters)) {
      return {
        pre: ['-hwaccel', 'qsv', '-hwaccel_output_format', 'qsv'],
        vf: `vpp_qsv=w=${w}:h=${h}:format=nv12`,
        encArgs,
        mode: 'gpu-full',
      };
    }
    if (encoder === 'h264_vaapi' && (decodeMethod === 'vaapi' || decodeMethod === 'auto') && canVaapiFullGpu(video, gpuFilters)) {
      const dev = device || '/dev/dri/renderD128';
      return {
        pre: ['-hwaccel', 'vaapi', '-hwaccel_device', dev, '-hwaccel_output_format', 'vaapi'],
        vf: `scale_vaapi=w=${w}:h=${h}:format=nv12`,
        encArgs,
        mode: 'gpu-full',
      };
    }
    if (encoder === 'h264_videotoolbox' && (decodeMethod === 'videotoolbox' || decodeMethod === 'auto')) {
      return {
        pre: ['-hwaccel', 'videotoolbox'],
        vf: `scale=${w}:${h}:flags=bilinear,format=nv12`,
        encArgs,
        mode: 'gpu-full',
      };
    }
  }

  // CPU decode (or hwaccel auto-download) -> scale -> GPU or CPU encoder.
  const fr = encoderFrame(encoder, device);
  return {
    pre: fr.pre,
    vf: `scale=${w}:${h}:flags=bilinear,${fr.vf}`,
    encArgs,
    mode: isCpu ? 'cpu' : 'gpu-encode',
  };
}

/**
 * Builds ffmpeg arguments for host-side Direct Stream (lossless H.264 bitstream copy without
 * video re-encoding). Uses `-c:v copy -bsf:v h264_mp4toannexb` inside a zero-delay MPEG-TS pipe
 * (`-f mpegts`) with `-copyts -start_at_zero -avoid_negative_ts disabled` so real source PTS
 * survive B-frame reordering, VFR timing, and keyframe-aligned seeks.
 *
 * @param {{ file: string, streamIndex?: number, startTime?: number }} o
 * @returns {string[]}
 */
function buildDirectStreamArgs({ file, streamIndex = 0, startTime = 0 }) {
  const args = ['-hide_banner', '-nostdin', '-v', 'error'];
  if (startTime > 0) args.push('-ss', Math.max(0, startTime - 0.0005).toFixed(4));
  args.push(
    '-copyts', '-start_at_zero', '-noautorotate', '-protocol_whitelist', 'file', '-i', file,
    '-map', `0:${streamIndex}`,
    '-c:v', 'copy',
    '-bsf:v', 'h264_mp4toannexb',
    '-avoid_negative_ts', 'disabled',
    '-muxdelay', '0', '-muxpreload', '0',
    '-f', 'mpegts', 'pipe:1',
  );
  return args;
}

/**
 * H.264 level_idc for a given output size and fps (ITU-T H.264 Table A-1).
 * 4K60 needs level 5.2 (52); 4K30 fits 5.1 (51); 1080p60 fits 4.2 (42); 1080p30 fits 4.0 (40).
 */
function defaultCodecLevel(w, h, fps) {
  const mbs = Math.ceil((w || 1920) / 16) * Math.ceil((h || 1080) / 16);
  const mbps = mbs * (fps || 30);
  if (mbps > 983040 || mbs > 36864) return 52; // 5.2 (4K60)
  if (mbs > 8704 || mbps > 522240) return 51; // 5.1 (4K30)
  if (mbps > 245760) return 42; // 4.2 (1080p60)
  return 40; // 4.0 (1080p30)
}

/**
 * Extracts profile_idc, constraint_set_flags and level_idc from the first SPS NAL (type 7)
 * in an Annex B access unit. Returns null if no SPS is present.
 * @param {Uint8Array|Buffer} data
 * @returns {{ profileIdc: number, constraintFlags: number, levelIdc: number, codecString: string }|null}
 */
function parseSpsProfileLevel(data) {
  if (!data || data.length < 7) return null;
  const hex2 = (n) => n.toString(16).padStart(2, '0');
  for (let i = 0; i + 6 < data.length; i++) {
    if (data[i] !== 0 || data[i + 1] !== 0) continue;
    let nalStart = -1;
    if (data[i + 2] === 1) nalStart = i + 3;
    else if (data[i + 2] === 0 && i + 7 < data.length && data[i + 3] === 1) nalStart = i + 4;
    if (nalStart < 0 || nalStart + 3 >= data.length) continue;
    if ((data[nalStart] & 0x1f) === 7) {
      const profileIdc = data[nalStart + 1];
      const constraintFlags = data[nalStart + 2];
      const levelIdc = data[nalStart + 3];
      return {
        profileIdc,
        constraintFlags,
        levelIdc,
        codecString: `avc1.${hex2(profileIdc)}${hex2(constraintFlags)}${hex2(levelIdc)}`,
      };
    }
  }
  return null;
}

const ENCODER_NAMES = {
  copy: 'Direct stream (video copy)',
  h264_nvenc: 'NVIDIA NVENC',
  h264_qsv: 'Intel Quick Sync',
  h264_amf: 'AMD AMF',
  h264_mf: 'Media Foundation GPU',
  h264_videotoolbox: 'Apple VideoToolbox',
  h264_vaapi: 'VA-API GPU',
  libx264: 'CPU (libx264)',
  libopenh264: 'CPU (libopenh264)',
};

/**
 * Human-readable pipeline description for ⓘ (About this video) and stats.
 * @param {{ encoder: string, mode?: string, remote?: boolean, w?: number, h?: number, fps?: number, maxKbps?: number }} o
 * @returns {string}
 */
function pipelineLabel(o) {
  const where = o.remote ? 'on the remote machine' : 'locally';
  const dims = o.w && o.h ? `, ${o.w}×${o.h}${o.fps ? ` ${+Number(o.fps).toFixed(Math.abs(o.fps - Math.round(o.fps)) < 0.01 ? 0 : 2)} fps` : ''}` : '';
  if (o.mode === 'direct-stream' || o.encoder === 'copy') {
    return `Direct stream (video copy) ${where} → WebCodecs${dims}, lossless`;
  }
  const enc = ENCODER_NAMES[o.encoder] || o.encoder || 'H.264';
  const stage = o.mode === 'gpu-full' ? `GPU decode → ${enc}` : o.mode === 'gpu-encode' ? `CPU decode → ${enc}` : enc;
  const cap = o.maxKbps > 0 ? `, max ${o.maxKbps >= 1000 ? `${+(o.maxKbps / 1000).toFixed(1)} Mb/s` : `${o.maxKbps} kb/s`}` : '';
  return `Live transcode ${where}: ${stage} → WebCodecs${dims}, 8-bit, lossy${cap}`;
}

module.exports = {
  CPU_ENCODERS,
  GPU_ENCODERS,
  ENCODER_NAMES,
  encoderArgs,
  encoderFrame,
  canCudaFullGpu,
  canQsvFullGpu,
  canVaapiFullGpu,
  buildVideoPipeline,
  buildDirectStreamArgs,
  defaultCodecLevel,
  parseSpsProfileLevel,
  pipelineLabel,
};
