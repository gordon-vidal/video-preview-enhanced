#!/usr/bin/env node
'use strict';
// Stress clips for seeking and stepping over a slow link (Live transcode, Remote-SSH): high bitrates, long GOPs,
// B-frames, 4K60, all-intra ProRes, open GOPs, variable frame rate, a long file. Generated, never committed (several
// GB): `review.cmd --stress` makes them once into test/media/.stress/ (git-ignored) and links them into the review
// folder. Every frame carries its number, so a wrong frame shows. The picture is film-grain noise over a test pattern:
// a plain pattern compresses to nearly nothing, noise makes the bitrate real.
//
//   node test/media/make_stress_media.js [--quick] [--out <dir>] [--only <name,...>] [--list] [--ffmpeg <exe>]
//
// --quick: the same clips, shorter (about a fifth of the disk, under a minute with a GPU encoder); kept in
// <out>/quick. Hardware encoders (NVENC, Quick Sync, AMF) are tried first, each with a tiny test encode; software
// (x264, x265, SVT-AV1) otherwise, slower but the same clips. VPE_FFMPEG or --ffmpeg picks the ffmpeg.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const DEFAULT_OUT = path.join(__dirname, '.stress');

/**
 * name: the file; what: what it stresses (shown in the review checklist); w, h, fps; dur and quick: seconds;
 * enc: the encoder family; mbps; gop: frames between keyframes; bf: B-frames; grain: noise strength (more: more bits).
 */
const CLIPS = [
  { name: 'hevc10_pq_2160p25_100mbps_gop250.mp4', w: 3840, h: 2160, fps: 25, dur: 120, quick: 20, enc: 'hevc10', mbps: 100,
    gop: 250, bf: 0, grain: 24, audio: true, pq: true,
    what: '4K HDR (PQ) 10-bit HEVC at 100 Mb/s, a keyframe every 10 s: tone-mapped on the host; a seek decodes up to 250 '
      + 'frames; 64 MB of packets hold ~5 s' },
  { name: 'hevc10_pq_2160p25_gop1500.mp4', w: 3840, h: 2160, fps: 25, dur: 120, quick: 30, enc: 'hevc10', mbps: 60,
    gop: 1500, bf: 0, grain: 20, pq: true,
    what: 'HDR (PQ), one keyframe a minute: the worst case for a jump and for a step back across a keyframe' },
  { name: 'h264_2160p25_80mbps_bframes_gop300.mp4', w: 3840, h: 2160, fps: 25, dur: 120, quick: 20, enc: 'h264', mbps: 80,
    gop: 300, bf: 3, grain: 24,
    what: '4K H.264 with B-frames, 80 Mb/s, a keyframe every 12 s: host decode cost on every seek' },
  { name: 'h264_1080p15_bframes_gop50.mp4', w: 1920, h: 1080, fps: 15, dur: 300, quick: 60, enc: 'h264', mbps: 6,
    gop: 50, bf: 3, grain: 12, audio: true,
    what: '15 fps, keyframe every 50 frames, B-frames, under the cap: copied as is (Direct Stream) at its own size; '
      + 'the page keeps no packets of B-frame GOPs' },
  { name: 'h264_1080p15_gop50.mp4', w: 1920, h: 1080, fps: 15, dur: 300, quick: 60, enc: 'h264', mbps: 6,
    gop: 50, bf: 0, grain: 12, audio: true,
    what: 'the same without B-frames: Direct Stream packets are kept, steps back come from the page' },
  { name: 'hevc_2160p60_120mbps_gop120.mp4', w: 3840, h: 2160, fps: 60, dur: 60, quick: 15, enc: 'hevc', mbps: 120,
    gop: 120, bf: 0, grain: 20,
    what: '4K60 at 120 Mb/s: host decode and encode speed, frame steps at 60 fps' },
  { name: 'av1_10_2160p25_gop240.mp4', w: 3840, h: 2160, fps: 25, dur: 60, quick: 15, enc: 'av1', mbps: 40,
    gop: 240, bf: 0, grain: 20,
    what: '4K 10-bit AV1: always transcoded (WebCodecs in VS Code has no AV1), slow software decode on a GPU-less host' },
  { name: 'prores_hq_2160p25.mov', w: 3840, h: 2160, fps: 25, dur: 20, quick: 6, enc: 'prores', grain: 4, audio: true,
    what: 'ProRes 422 HQ 4K, every frame a keyframe, ~1.2 Gb/s: bitrate alone, no GOP cost, a huge file' },
  { name: 'hevc_1080p25_opengop_gop250.mkv', w: 1920, h: 1080, fps: 25, dur: 60, quick: 20, enc: 'x265open', mbps: 10,
    gop: 250, bf: 4, grain: 12,
    what: 'open GOPs (CRA, not IDR): a keyframe that is no clean entry point; frame accuracy after a jump' },
  { name: 'h264_1080p_vfr.mp4', w: 1920, h: 1080, fps: 60, dur: 120, quick: 30, enc: 'h264', mbps: 12, gop: 120, bf: 0,
    grain: 12, vfr: true,
    what: 'variable frame rate (60 Hz, every 2nd and 4th frame dropped in parts): steps follow the real frame times' },
  { name: 'h264_1080p25_20mbps_10min.mp4', w: 1920, h: 1080, fps: 25, dur: 600, quick: 120, enc: 'h264', mbps: 20,
    gop: 250, bf: 0, grain: 16, audio: true,
    what: '10 minutes at 20 Mb/s (1.5 GB): long scrubs, cache eviction, the seek bar across a big file' },
];

/** Encoders per family, best first; `args` gives the video options. */
const ENCODERS = {
  hevc10: ['hevc_nvenc', 'hevc_qsv', 'hevc_amf', 'libx265'],
  hevc: ['hevc_nvenc', 'hevc_qsv', 'hevc_amf', 'libx265'],
  h264: ['h264_nvenc', 'h264_qsv', 'h264_amf', 'libx264'],
  av1: ['av1_nvenc', 'av1_qsv', 'av1_amf', 'libsvtav1'],
  prores: ['prores', 'prores_ks'], // prores (anatoliy): ~16x faster than prores_ks at 4K, fixed quality
  x265open: ['libx265'],
};

/** @param {string} enc @param {{ mbps?: number, gop?: number, bf?: number, ten: boolean, open?: boolean }} c */
function encoderArgs(enc, c) {
  const rate = `${c.mbps}M`, max = `${Math.round(c.mbps * 1.2)}M`, buf = `${c.mbps * 2}M`;
  const gop = String(c.gop), bf = String(c.bf || 0);
  const rc = ['-b:v', rate, '-maxrate', max, '-bufsize', buf, '-g', gop];
  switch (enc) {
    case 'hevc_nvenc': return ['-c:v', enc, '-preset', 'p1', ...rc, '-bf', bf, '-no-scenecut', '1', '-forced-idr', '1',
      ...(c.ten ? ['-profile:v', 'main10', '-pix_fmt', 'p010le'] : ['-pix_fmt', 'yuv420p'])];
    case 'h264_nvenc': return ['-c:v', enc, '-preset', 'p1', ...rc, '-bf', bf, '-no-scenecut', '1', '-forced-idr', '1',
      '-profile:v', 'high', '-pix_fmt', 'yuv420p'];
    case 'av1_nvenc': return ['-c:v', enc, '-preset', 'p1', ...rc, '-bf', bf, '-pix_fmt', c.ten ? 'p010le' : 'yuv420p'];
    case 'hevc_qsv': case 'h264_qsv': case 'av1_qsv':
      return ['-c:v', enc, '-preset', 'veryfast', ...rc, '-bf', bf, '-idr_interval', '0',
        '-pix_fmt', c.ten && enc !== 'h264_qsv' ? 'p010le' : 'nv12'];
    case 'hevc_amf': case 'h264_amf': case 'av1_amf':
      return ['-c:v', enc, '-quality', 'speed', ...rc, ...(enc === 'h264_amf' ? ['-bf', bf] : []),
        ...(c.ten && enc !== 'h264_amf' ? ['-pix_fmt', 'p010le'] : ['-pix_fmt', 'nv12'])];
    case 'libx265': {
      const vbv = `vbv-maxrate=${c.mbps * 1200}:vbv-bufsize=${c.mbps * 2000}`;
      return ['-c:v', enc, '-preset', 'ultrafast', '-b:v', rate, '-x265-params',
        `keyint=${gop}:min-keyint=${gop}:scenecut=0:bframes=${bf}:open-gop=${c.open ? 1 : 0}:${vbv}:log-level=error`,
        '-pix_fmt', c.ten ? 'yuv420p10le' : 'yuv420p', '-tag:v', 'hvc1'];
    }
    case 'libx264': return ['-c:v', enc, '-preset', c.bf ? 'veryfast' : 'ultrafast', ...rc, '-bf', bf,
      '-x264-params', `keyint=${gop}:min-keyint=${gop}:scenecut=0`, '-profile:v', 'high', '-pix_fmt', 'yuv420p'];
    case 'libsvtav1': return ['-c:v', enc, '-preset', '12', '-crf', '24', '-g', gop,
      '-pix_fmt', c.ten ? 'yuv420p10le' : 'yuv420p'];
    case 'prores': case 'prores_ks': return ['-c:v', enc, '-profile:v', '3', '-vendor', 'apl0', '-pix_fmt', 'yuv422p10le'];
    default: throw new Error(`no options for ${enc}`);
  }
}

const tenBit = (clip) => clip.enc === 'hevc10' || clip.enc === 'av1';

function runFf(ffmpeg, args, quiet = false) {
  return spawnSync(ffmpeg, ['-hide_banner', '-nostdin', '-y', '-v', 'error', ...args],
    { windowsHide: true, encoding: 'utf8', stdio: quiet ? 'pipe' : ['ignore', 'inherit', 'pipe'] });
}

/** The first encoder of the family that encodes a tiny clip with the clip's own options here. */
const picked = new Map();
function pickEncoder(ffmpeg, clip, tmpDir) {
  const key = `${clip.enc}/${clip.bf || 0}`;
  if (picked.has(key)) return picked.get(key);
  let found = null;
  for (const enc of ENCODERS[clip.enc]) {
    const probe = path.join(tmpDir, `probe-${enc}.mkv`);
    const r = runFf(ffmpeg, ['-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=25:d=0.4',
      ...encoderArgs(enc, { ...clip, mbps: 2, gop: 5, ten: tenBit(clip), open: clip.enc === 'x265open' }), probe], true);
    fs.rmSync(probe, { force: true });
    if (r.status === 0) { found = enc; break; }
  }
  picked.set(key, found);
  return found;
}

/** A font for the frame number: drawtext needs a file (fontconfig is often missing on Windows builds). */
function fontFile() {
  const candidates = [
    'C:/Windows/Fonts/consola.ttf', 'C:/Windows/Fonts/arial.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf', '/usr/share/fonts/dejavu/DejaVuSansMono.ttf',
    '/usr/share/fonts/TTF/DejaVuSansMono.ttf', '/System/Library/Fonts/Menlo.ttc', '/Library/Fonts/Arial.ttf',
  ];
  return candidates.find((f) => fs.existsSync(f)) || null;
}

/** The ffmpeg arguments for one clip (without the global ones). */
function clipArgs(clip, enc, seconds, out, font) {
  const { w, h, fps } = clip;
  const filters = [`noise=alls=${clip.grain}:allf=t`];
  // Variable frame rate: 60 Hz timestamps kept, every 4th frame only in the first second of three, every 2nd in the next.
  if (clip.vfr) filters.push(String.raw`select=if(lt(mod(t\,3)\,1)\,not(mod(n\,4))\,if(lt(mod(t\,3)\,2)\,not(mod(n\,2))\,1))`);
  if (font) {
    const ff = font.replace(/\\/g, '/').replace(/:/g, '\\:');
    const size = Math.round(h / 12);
    filters.push(`drawtext=fontfile='${ff}':text='%{frame_num}  %{pts\\:hms}':start_number=1:fontsize=${size}`
      + `:fontcolor=white:box=1:boxcolor=black@0.8:boxborderw=${Math.round(size / 5)}:x=${Math.round(w / 40)}:y=${Math.round(h / 20)}`);
  }
  const args = ['-f', 'lavfi', '-i', `testsrc2=s=${w}x${h}:r=${fps}:d=${seconds}`];
  if (clip.audio) args.push('-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=48000:duration=${seconds}`);
  args.push('-vf', filters.join(','));
  if (clip.vfr) args.push('-fps_mode', 'passthrough');
  args.push(...encoderArgs(enc, { ...clip, ten: tenBit(clip), open: clip.enc === 'x265open' }));
  // HDR tags (PQ, BT.2020): the picture is the same test pattern, but the host now tone-maps it like real HDR footage.
  if (clip.pq) args.push('-color_primaries', 'bt2020', '-color_trc', 'smpte2084', '-colorspace', 'bt2020nc', '-color_range', 'tv');
  if (clip.audio) args.push('-c:a', clip.name.endsWith('.mov') ? 'pcm_s16le' : 'aac', ...(clip.name.endsWith('.mov') ? [] : ['-b:a', '192k']));
  if (clip.name.endsWith('.mp4') || clip.name.endsWith('.mov')) args.push('-movflags', '+faststart');
  args.push(out);
  return args;
}

/** Where the clips are for these options, and what each stresses. @param {{ out?: string, quick?: boolean }} o */
function list(o = {}) {
  const dir = path.join(o.out || DEFAULT_OUT, o.quick ? 'quick' : 'full');
  return CLIPS.map((c) => ({ name: c.name, what: c.what, file: path.join(dir, c.name), seconds: o.quick ? c.quick : c.dur }));
}

/**
 * Makes the clips that are missing (a finished file is kept; a half-made one never has the final name).
 * @param {{ out?: string, quick?: boolean, only?: string[], ffmpeg?: string, log?: (s: string) => void }} o
 * @returns {{ made: string[], kept: string[], failed: string[] }}
 */
function make(o = {}) {
  const log = o.log || ((s) => console.log(s));
  const ffmpeg = o.ffmpeg || process.env.VPE_FFMPEG || 'ffmpeg';
  const items = list(o).filter((x) => !o.only || o.only.some((n) => x.name.includes(n)));
  const dir = path.dirname(items[0] ? items[0].file : path.join(o.out || DEFAULT_OUT, 'x'));
  fs.mkdirSync(dir, { recursive: true });
  const tmpDir = fs.mkdtempSync(path.join(dir, '.making-'));
  const font = fontFile();
  if (!font) log('No font found for the frame numbers: the clips are made without them.');
  const res = { made: [], kept: [], failed: [] };
  try {
    for (const item of items) {
      if (fs.existsSync(item.file)) { res.kept.push(item.file); continue; }
      const clip = CLIPS.find((c) => c.name === item.name);
      const enc = pickEncoder(ffmpeg, clip, tmpDir);
      if (!enc) { log(`${item.name}: no ${clip.enc} encoder in ${ffmpeg}; skipped`); res.failed.push(item.name); continue; }
      const temp = path.join(tmpDir, item.name);
      const t0 = Date.now();
      log(`${item.name}: ${item.seconds} s with ${enc} ...`);
      const r = runFf(ffmpeg, clipArgs(clip, enc, item.seconds, temp, font));
      if (r.status !== 0 || !fs.existsSync(temp)) {
        log(`${item.name}: FAILED (${enc}): ${String(r.stderr || '').trim().split(/\r?\n/).slice(-3).join(' | ')}`);
        res.failed.push(item.name);
        continue;
      }
      fs.renameSync(temp, item.file);
      const mb = fs.statSync(item.file).size / 1e6;
      log(`${item.name}: ${mb.toFixed(0)} MB in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
      res.made.push(item.file);
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  return res;
}

function main(args) {
  const o = { quick: false, out: DEFAULT_OUT, only: undefined, ffmpeg: undefined };
  let listOnly = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--quick') o.quick = true;
    else if (a === '--list') listOnly = true;
    else if (a === '--out' && args[i + 1]) o.out = path.resolve(args[++i]);
    else if (a === '--only' && args[i + 1]) o.only = args[++i].split(',');
    else if (a === '--ffmpeg' && args[i + 1]) o.ffmpeg = args[++i];
    else throw new Error('Usage: make_stress_media.js [--quick] [--out <dir>] [--only <name,...>] [--list] [--ffmpeg <exe>]');
  }
  if (listOnly) {
    for (const x of list(o)) console.log(`${fs.existsSync(x.file) ? 'have' : 'make'}  ${x.name}  (${x.seconds} s)  ${x.what}`);
    return;
  }
  const t0 = Date.now();
  const r = make(o);
  const total = [...r.made, ...r.kept].reduce((n, f) => n + fs.statSync(f).size, 0) / 1e9;
  console.log(`made ${r.made.length}, had ${r.kept.length}, failed ${r.failed.length}; ${total.toFixed(1)} GB in `
    + `${path.dirname(list(o)[0].file)}; ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  if (r.failed.length) process.exitCode = 1;
}

if (require.main === module) {
  try { main(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exitCode = 1; }
}
module.exports = { CLIPS, list, make, encoderArgs, DEFAULT_OUT };
