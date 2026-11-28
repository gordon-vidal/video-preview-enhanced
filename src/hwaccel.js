'use strict';
// GPU decoding methods for native ffmpeg: which to try on this machine (in a
// fixed order per platform, like mpv's hwdec=auto-safe and VLC), the exact
// ffmpeg arguments real playback uses for each, and how to tell from ffmpeg's
// log that a method quietly fell back to software decoding.

/**
 * Methods to try, best first; 'none' (software) is always last. Methods that
 * can't work with the detected GPUs are left out (qsv needs Intel, cuda NVIDIA,
 * vaapi a DRM render node). An empty GPU list (detection failed) keeps the
 * vendor-neutral ones.
 */
function methodOrder(hw) {
  const v = new Set((hw.gpus || []).map((g) => g.vendor));
  const list = [];
  if (hw.os === 'win32') {
    list.push('d3d11va');
    if (v.has('intel')) list.push('qsv');
    if (v.has('nvidia')) list.push('cuda');
    list.push('dxva2');
  } else if (hw.os === 'linux') {
    if (hw.vaapi) list.push('vaapi');
    if (v.has('nvidia')) list.push('cuda');
  } else if (hw.os === 'darwin') {
    list.push('videotoolbox');
  }
  list.push('none');
  return list;
}

/**
 * Methods for the seek-bar preview pass (src/thumbhost.js), best first; empty: software only. Not playback's order:
 * the pass is measured by CPU time, and d3d11va's copies cost several times what d3d12va or cuda cost (still far
 * below software), so it comes last (docs/notes/seek-preview.md). hw: hardware.detect()'s shape, null when unknown.
 */
function previewMethods(hw) {
  if (!hw) return [];
  const v = new Set((hw.gpus || []).map((g) => g.vendor));
  if (hw.os === 'win32') return ['d3d12va', ...(v.has('nvidia') ? ['cuda'] : []), 'd3d11va'];
  if (hw.os === 'linux') return [...(hw.vaapi ? ['vaapi'] : []), ...(v.has('nvidia') ? ['cuda'] : [])];
  if (hw.os === 'darwin') return ['videotoolbox'];
  return [];
}

/** Codecs a method can decode on the GPU at all; others would only ever fall back (skipped by the probe). */
function methodMayDecode(method, codec) {
  if (method === 'none' || method === 'auto') return true;
  if (codec === 'prores') return method === 'videotoolbox';
  return true;
}

/** ffmpeg input options for a method (they go before -i). */
function inputArgs(method, filter) {
  if (!method || method === 'none') return [];
  // Keep hardware surfaces until the filter runs (QSV also needs an explicit download).
  if (method === 'qsv' || filter) return ['-hwaccel', method, '-hwaccel_output_format', method];
  return ['-hwaccel', method];
}

function gpuFilter(method, filters, v) {
  if (method === 'qsv') return !filters || filters.has('vpp_qsv') ? 'vpp_qsv' : '';
  // A 10-bit 4:2:0 surface can be reduced without changing the chroma layout; an 8-bit one (NV12) is
  // only split into planes and scaled (4K VP9 8-bit: ffmpeg 58 % -> 30 % of a core, same bytes at full size;
  // docs/notes/cpu-4k.md). Full-range (yuvj) sources keep the CPU path.
  if (method === 'cuda' && filters?.has('scale_cuda') && v &&
      ((/^(hevc|av1|vp9)$/.test(v.codec) && /^(yuv420p10le|p010le)$/.test(v.pixFmt)) ||
       (/^(hevc|av1|vp9|h264)$/.test(v.codec) && v.pixFmt === 'yuv420p'))) return 'scale_cuda';
  return '';
}

/**
 * The filter chain that turns decoded frames into what the webview draws:
 * w x h, 8-bit 4:2:0 (out: 'yuv420p10le' for HDR output). CUDA and QSV can scale before downloading. Generic hwaccels
 * download frames themselves (nv12/p010) and let swscale handle the rest.
 */
function videoFilter(method, w, h, filter = gpuFilter(method), depth = 8, out = 'yuv420p') {
  // HDR output: 10-bit planar 4:2:0 in 16-bit words, scaled on the CPU.
  if (out !== 'yuv420p') return `${method === 'qsv' ? `hwdownload,format=${depth > 8 ? 'p010le' : 'nv12'},` : ''}scale=${w}:${h}:flags=bilinear,format=${out}`;
  if (filter === 'scale_cuda') return `scale_cuda=w=${w}:h=${h}:format=yuv420p:interp_algo=bilinear,hwdownload,format=yuv420p`;
  if (filter === 'vpp_qsv') return `vpp_qsv=w=${w}:h=${h}:format=nv12,hwdownload,format=nv12,format=yuv420p`;
  const scale = `scale=${w}:${h}:flags=bilinear,format=yuv420p`;
  return method === 'qsv' ? `hwdownload,format=${depth > 8 ? 'p010le' : 'nv12'},${scale}` : scale;
}

// ffmpeg says this when a requested hwaccel can't be used and it decodes in software instead,
// or when it can't be used at all (device creation, missing driver library).
const FALLBACK_RE = /Failed setup for format|hwaccel initiali[sz]ation returned error|Your platform doesn't support hardware accelerated|hardware accelerated \S+ decoding is not supported|Failed to get hw|No device available for decoder|Device creation failed|Could not dynamically load|Cannot load \S+\.(dll|so)|unsupported (profile|pixel format|codec)|not supported by the (hardware|decoder)|Error initializing the hwaccel/i;
// Software decoders output planar YUV; hwaccel downloads arrive as nv12/p010/p016 (or stay on the GPU: d3d11, qsv, cuda…).
const SOFT_FMT_RE = /^(yuv|yuvj|gbr|gray)/;

/**
 * The pixel format of the first decoded frame reaching the filter graph (ffmpeg -v verbose).
 * rate: only frames of the input read at this frame rate (a run with several inputs gives
 * each its own: the line's "[graph ... input from stream i:0]" prefix can be missing when
 * another thread logged half a line just before).
 */
function inputPixFmt(stderr, rate) {
  const re = rate === undefined ? /graph [^\n]*input from stream[^\n]*?pixfmt:(\w+)/ : new RegExp(`pixfmt:(\\w+) [^\\n]*?fr:${Number(rate)}/1\\b`);
  const m = re.exec(stderr || '');
  return m ? m[1] : '';
}

/**
 * Did a run with `method` really decode on the GPU? Returns
 * { hw: boolean, pixFmt, reason } from ffmpeg's verbose log (stderr).
 * ffmpeg falls back to software quietly (exit code 0) when the GPU can't decode a
 * profile; the only traces are a warning and planar-YUV frames reaching the filters.
 * multi: { rate, codec } for a run with several inputs (each read at its own rate): only that input's frames decide
 * (another input's warning says nothing about this one); the warning gives the reason.
 */
function checkFallback(method, stderr, multi) {
  const pixFmt = inputPixFmt(stderr, multi ? multi.rate : undefined);
  if (!method || method === 'none') return { hw: false, pixFmt, reason: 'software' };
  const lines = String(stderr || '').split(/\r?\n/);
  const why = multi ? '' : fallbackReason(stderr);
  if (why) return { hw: false, pixFmt, reason: why };
  if (multi && pixFmt && SOFT_FMT_RE.test(pixFmt)) {
    // Log lines of a decoder start with its name: "[av1 @ 0000...] Failed setup for format dxva2_vld".
    const line = lines.find((l) => FALLBACK_RE.test(l) && l.startsWith(`[${multi.codec} @`)) || lines.find((l) => FALLBACK_RE.test(l));
    if (line && !(method === 'cuda' && /^yuv444/.test(pixFmt))) return { hw: false, pixFmt, reason: reasonOf(line) };
  }
  // CUDA downloads 4:4:4 as yuv444p, which looks like software output: trust it when nothing failed.
  if (pixFmt && SOFT_FMT_RE.test(pixFmt) && !(method === 'cuda' && /^yuv444/.test(pixFmt))) {
    return { hw: false, pixFmt, reason: `frames arrived as ${pixFmt} (software decoding)` };
  }
  if (!pixFmt) return { hw: false, pixFmt, reason: 'no frame was decoded' };
  return { hw: true, pixFmt, reason: '' };
}

const reasonOf = (l) => l.replace(/^\[[^\]]*\]\s*/g, '').trim().slice(0, 200);

/** The line of ffmpeg's log that says a hwaccel could not be used, or ''. */
function fallbackReason(stderr) {
  const err = FALLBACK_RE.exec(stderr || '');
  if (!err) return '';
  const line = String(stderr).split(/\r?\n/).find((l) => l.includes(err[0])) || err[0];
  return reasonOf(line);
}

/** PSNR (dB) of two 8-bit frames of equal size; Infinity when identical. */
function psnr(a, b) {
  if (!a || !b || a.length !== b.length || !a.length) return 0;
  let se = 0;
  for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; se += d * d; }
  if (se === 0) return Infinity;
  return 10 * Math.log10((255 * 255) / (se / a.length));
}

/** Pixel-format name -> bit depth (8 or 10+); ProRes, DNxHR and friends are 10-bit and up. */
function depthOf(pixFmt, codec) {
  if (/prores/.test(codec || '')) return 10;
  return /p(9|10|12|14|16)/.test(pixFmt || '') || /^(p010|p016|p210|p410|y210|y410)/.test(pixFmt || '') ? 10 : 8;
}

/**
 * The class a video belongs to for speed records: codec family, bit depth and a
 * resolution bucket ('1080' up to about 1080p, '2160' above). Speeds are stored
 * per class (probe results and measured built-in speeds) and scaled by pixel count.
 */
function classOf(codec, depth, width, height) {
  const fam = /^(h264|hevc|av1|vp9|vp8|prores)$/.test(codec) ? codec : String(codec || 'other');
  const res = width * height > 2560 * 1440 ? '2160' : '1080';
  return `${fam}/${depth > 8 ? 10 : 8}/${res}`;
}

const CLASS_PIXELS = { 1080: 1920 * 1080, 2160: 3840 * 2160 };

// ---- bit rate: the probe clips are light, real files are not --------------------------------
// Software decoding slows down with the bits per pixel (entropy decoding works per bit);
// GPU decoders hardly do. The probe clips carry 0.004-0.012 bits per pixel and frame
// (1-2 Mb/s, to keep them small), real files 0.04-0.1 (5-20 Mb/s) and more. Measured on an
// Intel Core Ultra 7 165U (test/perf/bitrate_model.js, test/media files against the probe
// clips, same pipeline): software fps fall about as (file bpp / clip bpp) ^ -0.4 (exponent
// per codec and size 0.24-0.57); GPU fps stay within 15 %. CPU_MARGIN covers the rest of the
// spread: the CPU estimate is the one that must not be too optimistic.
const BPP_EXPONENT = 0.4;
const CPU_MARGIN = 0.85;
// A file whose bit rate ffprobe doesn't report: about a 12 Mb/s 4K or 5 Mb/s 1080p file.
const TYPICAL_BPP = 0.06;

/** Bits per pixel and frame of a video (ffprobe'd stream with bitRate), or TYPICAL_BPP. */
function videoBpp(v) {
  const px = (v.width || 0) * (v.height || 0) * (v.fps || 30);
  return v.bitRate > 0 && px > 0 ? v.bitRate / px : TYPICAL_BPP;
}

/**
 * How much slower than on the probe clip a method decodes this video per pixel (1 or less):
 * software decoding by the bit-rate model above, GPU methods not at all. clipBpp: the probe
 * clip's (stored per class); records without it (older probes) aren't scaled.
 */
function bitrateFactor(method, clipBpp, v) {
  if (method !== 'none' || !(clipBpp > 0)) return 1;
  return CPU_MARGIN * Math.min(1, (videoBpp(v) / clipBpp) ** -BPP_EXPONENT);
}



module.exports = {
  methodOrder, previewMethods, fallbackReason, methodMayDecode, inputArgs, gpuFilter, videoFilter, checkFallback, inputPixFmt, psnr, depthOf, classOf, CLASS_PIXELS,
  videoBpp, bitrateFactor, TYPICAL_BPP,
};
