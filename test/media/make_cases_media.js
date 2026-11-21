#!/usr/bin/env node
'use strict';
// Small self-made clips for test/vscode/cases (ffmpeg lavfi sources, no third-party footage;
// see test/media/LICENSES.md). Written to test/media/cases/, kept when present.
//
//   node test/media/make_cases_media.js [--force] [regex]     make all (or the names matching)
//   require('./make_cases_media').ensure(['s_h264.mp4', ...]) -> the folder, files made on demand
//
// Needs ffmpeg (VPE_FFMPEG or PATH) with libx264, libx265, libvpx, libvpx-vp9, libopus, libmp3lame,
// libtheora, prores_ks and a few more (the gyan.dev / BtbN builds have them). A clip whose encoder
// is missing is skipped and reported.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const DIR = path.join(__dirname, 'cases');
const FF = () => process.env.VPE_FFMPEG || 'ffmpeg';

const pic = (size, dur, rate = 30) => ['-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=${rate}:duration=${dur}`];
const tone = (dur, hz = 440, extra = '') => ['-f', 'lavfi', '-i', `sine=frequency=${hz}:sample_rate=48000:duration=${dur}${extra}`];
const X264 = ['-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-g', '30', '-bf', '2'];
const S = '320x180';

/** name -> ffmpeg arguments (without -y and the output), or a function(outPath) for the special ones. */
const JOBS = {
  // WebM timestamps are in milliseconds. Remux to uniform 40 ms deltas.
  'startup_vp9_cfr.mp4': (out) => ff(['-i', path.join(__dirname, 'vp9_2160p.webm'), '-c', 'copy',
    '-bsf:v', 'setts=pts=N*40:dts=N*40:duration=40', out]),
  'startup_h264_422.mov': (out) => ff(['-i', path.join(__dirname, 'h264_8_1080p.mp4'), '-c:v', 'libx264',
    '-preset', 'veryfast', '-pix_fmt', 'yuv422p', out]),
  'startup_hevc.mkv': (out) => ff(['-i', path.join(__dirname, 'hevc_10_2160p.mp4'), '-c', 'copy', out]),
  'startup_av1.mkv': (out) => ff(['-i', path.join(__dirname, 'av1_10_2160p.mp4'), '-c', 'copy', out]),
  // Step / seek set: 3 s, 30 fps, 90 frames, keyframes every 30, with sound. One per decode path.
  's_h264.mp4': [...pic(S, 3), ...tone(3), ...X264, '-c:a', 'aac'],
  // x264 marks the one-second recovery points as keys, but only the first is an IDR.
  's_h264_opengop.mkv': [...pic(S, 4), ...X264, '-x264-params', 'open-gop=1:scenecut=0'],
  's_hevc.mp4': [...pic(S, 3), ...tone(3), '-c:v', 'libx265', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-tag:v', 'hvc1', '-c:a', 'aac', '-x265-params', 'log-level=error:keyint=30:min-keyint=30'],
  's_vp9.webm': [...pic(S, 3), ...tone(3), '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-b:v', '300k', '-g', '30', '-c:a', 'libopus'],
  's_mpeg2.mpg': [...pic(S, 3), ...tone(3), '-c:v', 'mpeg2video', '-q:v', '4', '-g', '15', '-c:a', 'mp2', '-f', 'mpeg'],
  's_xvid.avi': [...pic(S, 3), ...tone(3), '-c:v', 'mpeg4', '-vtag', 'XVID', '-q:v', '5', '-g', '30', '-c:a', 'libmp3lame'],
  's_prores.mov': [...pic(S, 3), ...tone(3), '-c:v', 'prores_ks', '-profile:v', '0', '-c:a', 'pcm_s16le'],
  's_mjpeg.avi': [...pic(S, 3), ...tone(3), '-c:v', 'mjpeg', '-q:v', '6', '-pix_fmt', 'yuvj420p', '-c:a', 'pcm_s16le'],
  // Time stamps rounded to milliseconds (60 fps, NTSC 30000/1001).
  'vp9_60fps.mkv': [...pic(S, 2, 60), '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-b:v', '300k', '-g', '60'],
  'h264_60fps.mkv': [...pic(S, 2, 60), ...X264, '-g', '60'],
  'ntsc_2997.mkv': [...pic(S, 3, '30000/1001'), ...X264],
  // Starts at PTS 3600 s (autoplay with a late first time stamp). .mts: VS Code's own .ts is TypeScript.
  'start3600.mts': [...pic(S, 4), ...tone(4), ...X264, '-c:a', 'aac', '-output_ts_offset', '3600', '-f', 'mpegts'],
  'start3600_mpeg2.mts': [...pic(S, 4), ...tone(4), '-c:v', 'mpeg2video', '-q:v', '5', '-c:a', 'mp2', '-output_ts_offset', '3600', '-f', 'mpegts'],
  // Sound longer than the picture (2 s of 60 frames, 5 s of sound).
  'audio_longer.mp4': [...pic(S, 2), ...tone(5), ...X264, '-c:a', 'aac'],
  'audio_longer_soft.mkv': [...pic(S, 2), ...tone(5), '-c:v', 'mpeg4', '-q:v', '5', '-c:a', 'libopus'],
  'sine_only.mkv': [...tone(5, 1000), '-c:a', 'aac'],
  'vp8_2s.webm': [...pic(S, 2), '-c:v', 'libvpx', '-deadline', 'realtime', '-cpu-used', '8', '-b:v', '300k', '-g', '30'],
  'long_20s.mp4': [...pic(S, 20), ...tone(20), ...X264, '-crf', '34', '-c:a', 'aac'],
  // 24 s of the 1080p clips (copied 12 times, no re-encode) for the 9- and 16-video grids (test/vscode/cases/multiview.js).
  'multiview_hevc.mp4': ['-stream_loop', '11', '-i', path.join(__dirname, 'hevc_8_1080p.mp4'), '-an', '-c:v', 'copy'],
  'multiview_h264.mp4': ['-stream_loop', '11', '-i', path.join(__dirname, 'h264_8_1080p.mp4'), '-an', '-c:v', 'copy'],
  'rotated.mp4': (out) => ff(['-display_rotation', '90', '-i', clip('s_h264.mp4'), '-c', 'copy', out]),
  // Damaged and cut files.
  'damaged_h264.mkv': (out) => damageH264(out, 'garbage'),
  'damaged_h264_b.mkv': (out) => damageH264(out, 'header'),
  'trunc_moov.mp4': (out) => truncate('s_h264.mp4', out),
  'trunc_faststart.mp4': (out) => { const t = tmpName('.mp4'); try { ff(['-i', clip('s_h264.mp4'), '-c', 'copy', '-movflags', '+faststart', t]); truncate(t, out, true); } finally { fs.rmSync(t, { force: true }); } },
  'trunc.mkv': (out) => { const t = tmpName('.mkv'); try { ff(['-i', clip('s_h264.mp4'), '-c', 'copy', t]); truncate(t, out, true); } finally { fs.rmSync(t, { force: true }); } },
  // Scopes: 75 % colour bars, BT.709 tagged; export: 30 fps with every 5th frame missing.
  'bars75_709.mp4': ['-f', 'lavfi', '-i', 'pal75bars=size=1280x720:rate=25:duration=2', '-vf', 'scale=out_color_matrix=bt709:out_range=tv,format=yuv420p',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '12', '-g', '25', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709'],
  'bars75_sd_709.mp4': ['-f', 'lavfi', '-i', 'pal75bars=size=640x360:rate=25:duration=1', '-vf', 'scale=out_color_matrix=bt709:out_range=tv,format=yuv420p',
    ...X264, '-crf', '12', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709'],
  // pal75bars tags its input BT.470BG. Strip the tags to exercise the player's SD fallback.
  'bars75_sd_untagged.mp4': ['-f', 'lavfi', '-i', 'pal75bars=size=640x360:rate=25:duration=1',
    '-vf', 'setparams=colorspace=unknown:color_primaries=unknown:color_trc=unknown', ...X264, '-crf', '12'],
  'gapped_30fps.mkv': [...pic(S, 3), '-vf', "select='not(eq(mod(n,5),2))'", '-fps_mode', 'passthrough', '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p'],
  // Sound.
  'truehd_51side.mkv': [...pic('320x180', 6), ...tone(6), '-filter_complex', '[1:a]aformat=channel_layouts=5.1(side)[a]', '-map', '0:v', '-map', '[a]',
    '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'truehd', '-strict', '-2'],
  'flac_71_centre.mkv': [...pic('320x180', 4), ...tone(4), '-filter_complex', '[1:a]pan=7.1|FC=c0[a]', '-map', '0:v', '-map', '[a]',
    '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'flac'],
  // Tracks: three sounds (440/660/880 Hz), SRT (default) and ASS subtitles.
  'tracks_multi.mkv': (out) => tracksMulti(out),
  // Neighbour files (Shift+N / Shift+P): a folder of three.
  'neigh/n1.mp4': [...pic('160x90', 1), ...X264, '-an'],
  'neigh/n2.mp4': [...pic('160x90', 1), ...X264, '-an'],
  'neigh/n3.mp4': [...pic('160x90', 1), ...X264, '-an'],
};

// Compare metrics (PSNR / SSIM against ffmpeg's): a noisy reference, a copy, a low-quality re-encode, and one with 3 frames cut from the start.
const CMP = ['-c:v', 'libx264', '-preset', 'fast', '-pix_fmt', 'yuv420p', '-g', '30'];
Object.assign(JOBS, {
  'cmp/ref.mp4': ['-f', 'lavfi', '-i', 'testsrc2=s=480x270:r=30:d=2,noise=alls=5:allf=t', ...CMP, '-crf', '27'],
  'cmp/lowq.mp4': (out) => ff(['-i', clip('cmp/ref.mp4'), ...CMP, '-crf', '38', out]),
  'cmp/offset3.mp4': (out) => ff(['-i', clip('cmp/ref.mp4'), '-vf', 'trim=start_frame=3,setpts=PTS-STARTPTS', ...CMP, '-crf', '27', out]),
});

// Open-and-play set (one second each): the codecs and containers VS Code opens through the
// extension, so a regression in any demuxer or decoder shows up as "no picture".
const FMT_S = '160x90';
const fmt = (ext, v, a, extra = []) => [...pic(FMT_S, 1), ...(a ? tone(1) : []), ...v, ...(a ? a : ['-an']), ...extra];
Object.assign(JOBS, {
  'fmt/h264_high10.mp4': fmt('mp4', ['-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p10le'], ['-c:a', 'aac']),
  'fmt/h264_444.mp4': fmt('mp4', ['-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv444p'], ['-c:a', 'aac']),
  'fmt/hevc10.mp4': fmt('mp4', ['-c:v', 'libx265', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p10le', '-tag:v', 'hvc1', '-x265-params', 'log-level=error'], ['-c:a', 'aac']),
  'fmt/hevc10_opus.mkv': fmt('mkv', ['-c:v', 'libx265', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p10le', '-x265-params', 'log-level=error'], ['-c:a', 'libopus']),
  'fmt/vp8_vorbis.webm': fmt('webm', ['-c:v', 'libvpx', '-deadline', 'realtime', '-cpu-used', '8', '-b:v', '300k'], ['-c:a', 'libvorbis']),
  'fmt/av1_opus.mkv': fmt('mkv', ['-c:v', 'libsvtav1', '-preset', '12', '-crf', '40'], ['-c:a', 'libopus']),
  'fmt/h264_ac3.mts': fmt('mts', ['-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p'], ['-c:a', 'ac3'], ['-f', 'mpegts']),
  'fmt/mpeg2_ac3.vob': [...pic('720x480', 1, '30000/1001'), ...tone(1), '-c:v', 'mpeg2video', '-q:v', '6', '-c:a', 'ac3', '-f', 'vob'],
  'fmt/mpeg2_interlaced.mpg': [...pic('720x480', 1, '30000/1001'), ...tone(1), '-c:v', 'mpeg2video', '-q:v', '6', '-vf', 'setfield=tff', '-flags', '+ilme+ildct', '-c:a', 'mp2', '-f', 'mpeg'],
  'fmt/wmv2_wma.wmv': fmt('wmv', ['-c:v', 'wmv2', '-q:v', '5'], ['-c:a', 'wmav2', '-b:a', '128k']),
  'fmt/wmv2_wma.asf': fmt('asf', ['-c:v', 'wmv2', '-q:v', '5'], ['-c:a', 'wmav2', '-b:a', '128k'], ['-f', 'asf']),
  'fmt/dnxhr_pcm.mxf': [...pic('1280x720', 0.4, 25), ...tone(0.4), '-c:v', 'dnxhd', '-profile:v', 'dnxhr_lb', '-pix_fmt', 'yuv422p', '-c:a', 'pcm_s16le'],
  'fmt/theora_vorbis.ogv': fmt('ogv', ['-c:v', 'libtheora', '-q:v', '6'], ['-c:a', 'libvorbis']),
  'fmt/flv1_mp3.flv': fmt('flv', ['-c:v', 'flv', '-q:v', '5'], ['-c:a', 'libmp3lame', '-ar', '44100']),
  'fmt/odd_853x479.mkv': [...pic('853x479', 1), ...tone(1), '-c:v', 'mpeg4', '-q:v', '5', '-c:a', 'aac'],
  'fmt/h264_ac3_51.mkv': [...pic(FMT_S, 1), ...tone(1), ...X264, '-c:a', 'ac3', '-ac', '6', '-channel_layout', '5.1'],
  'fmt/h264_noaudio.mp4': [...pic(FMT_S, 1), ...X264, '-an'],
  'fmt/h264_vfr.mkv': [...pic(FMT_S, 2, 60), '-vf', "select='lt(n,60)+not(mod(n,4))'", '-fps_mode', 'vfr', ...X264, '-an'],
  'fmt/audio_only.mkv': [...tone(3), '-c:a', 'aac'],
});

// ---- helpers -----------------------------------------------------------------------------

const clip = (n) => path.join(DIR, n);
const tmpName = (ext) => path.join(os.tmpdir(), `vpe-cases-${process.pid}-${Math.random().toString(36).slice(2)}${ext}`);

function ff(args, throwOnError = true) {
  const r = spawnSync(FF(), ['-hide_banner', '-v', 'error', '-y', ...args], { encoding: 'utf8', windowsHide: true });
  if (throwOnError && (r.error || r.status !== 0)) throw new Error(`ffmpeg ${args.slice(-1)[0]}: ${r.error ? r.error.message : (r.stderr || `exit ${r.status}`).trim().split('\n').slice(-2).join(' | ')}`);
  return r.status === 0;
}

/** The first `half` of a file's bytes (a download that stopped; an MP4 written moov-last loses its index). */
function truncate(srcName, out, absolute = false) {
  const buf = fs.readFileSync(absolute ? srcName : clip(srcName));
  fs.writeFileSync(out, buf.subarray(0, Math.floor(buf.length / 2)));
}

/**
 * H.264 with one damaged picture: x264 writes Annex B, the body of the 75th slice is overwritten
 * ('garbage': noise after the slice header; 'header': 0xFF over the first bytes, so even the
 * header is wrong), and the stream is remuxed to MKV. The picture should go on after it.
 */
function damageH264(out, kind) {
  const raw = tmpName('.h264');
  try {
    ff([...pic(S, 5), '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-g', '30', '-bf', '0', '-f', 'h264', raw]);
    const b = fs.readFileSync(raw);
    const starts = [];
    for (let i = 0; i + 3 < b.length; i++) if (b[i] === 0 && b[i + 1] === 0 && b[i + 2] === 1) { starts.push(i + 3); i += 2; }
    const slices = starts.filter((s) => { const t = b[s] & 31; return t === 1 || t === 5; });
    const k = Math.min(75, slices.length - 1);
    const s = slices[k];
    const end = (starts.find((x) => x > s) || b.length + 3) - 3;
    let seed = 12345;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return (seed >> 8) & 0xff; };
    const from = kind === 'header' ? s + 1 : s + 6;
    for (let i = from; i < end; i++) {
      let v = kind === 'header' && i < s + 12 ? 0xff : rnd();
      if (i > from + 1 && b[i - 1] === 0 && b[i - 2] === 0 && v < 4) v = 0x55; // no accidental start codes
      b[i] = v;
    }
    fs.writeFileSync(raw, b);
    ff(['-f', 'h264', '-framerate', '30', '-i', raw, '-c', 'copy', out]);
  } finally { fs.rmSync(raw, { force: true }); }
}

function tracksMulti(out) {
  const D = 20;
  const ts = (s, sep) => { const ms = Math.round(s * 1000); const p = (n, w = 2) => String(n).padStart(w, '0'); return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)}${sep}${p(ms % 1000, 3)}`; };
  const cues = [];
  for (let t = 1; t < D - 2; t += 3) cues.push([t, t + 1.5, `cue ${t}`]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vpe-tracks-'));
  try {
    const srt = path.join(dir, 'en.srt');
    fs.writeFileSync(srt, cues.map(([a, b, x], i) => `${i + 1}\n${ts(a, ',')} --> ${ts(b, ',')}\nEN ${x}\n`).join('\n'));
    const ass = path.join(dir, 'de.ass');
    const t = (s) => { const cs = Math.round(s * 100); return `${Math.floor(cs / 360000)}:${String(Math.floor(cs / 6000) % 60).padStart(2, '0')}:${String(Math.floor(cs / 100) % 60).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`; };
    fs.writeFileSync(ass, `[Script Info]\nScriptType: v4.00+\nPlayResX: 640\nPlayResY: 360\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,Arial,30,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,10,10,20,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n${cues.map(([a, b, x]) => `Dialogue: 0,${t(a)},${t(b)},Default,,0,0,0,,DE ${x}`).join('\n')}\n`);
    ff([...pic('320x180', D), ...tone(D, 440), ...tone(D, 660), ...tone(D, 880), '-i', srt, '-i', ass,
      '-map', '0:v', '-map', '1:a', '-map', '2:a', '-map', '3:a', '-map', '4:s', '-map', '5:s',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '38', '-pix_fmt', 'yuv420p', '-g', '30',
      '-c:a:0', 'aac', '-c:a:1', 'ac3', '-ac:a:1', '6', '-c:a:2', 'libopus', '-c:s:0', 'srt', '-c:s:1', 'ass',
      '-metadata:s:a:0', 'language=eng', '-metadata:s:a:0', 'title=English stereo', '-metadata:s:a:1', 'language=ger', '-metadata:s:a:1', 'title=Deutsch 5.1', '-metadata:s:a:2', 'language=jpn',
      '-metadata:s:s:0', 'language=eng', '-metadata:s:s:1', 'language=ger', '-metadata:s:s:1', 'title=Signs',
      '-disposition:a:0', 'default', '-disposition:a:1', '0', '-disposition:a:2', '0', '-disposition:s:0', 'default', '-disposition:s:1', '0', out]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

/** The picture-subtitle clips (test/bitmapsubs/make_media.js) in cases/bitmapsubs; DVB as .mts. */
function bitmapSubs() {
  const dir = path.join(DIR, 'bitmapsubs');
  const M = require('../bitmapsubs/make_media');
  const f = M.make(dir);
  const dvb = path.join(dir, 'bitmap_dvb.mts');
  if (!fs.existsSync(dvb)) fs.copyFileSync(f.dvb, dvb);
  return { pgs: f.pgs, dvd: f.dvd, dvb };
}

/** The HDR pattern (test/zoo/make_hdr.js) in cases/hdr. */
function hdr() {
  const dir = path.join(DIR, 'hdr');
  if (['hevc10_pq.mp4', 'hevc10_hlg.mp4', 'h264_pq.mp4'].every((n) => fs.existsSync(path.join(dir, n)))) return dir;
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'zoo', 'make_hdr.js'), DIR], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`make_hdr.js: ${r.stderr || r.stdout}`);
  return dir;
}

/** Makes one clip when missing. Returns its path, or null (with a note on stderr) when ffmpeg cannot. */
function make(name, { force = false } = {}) {
  const out = clip(name);
  if (!force && fs.existsSync(out) && fs.statSync(out).size > 0) return out;
  const job = JOBS[name];
  if (!job) throw new Error(`no such case clip: ${name}`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const part = `${out}.part${path.extname(out)}`;
  try {
    if (typeof job === 'function') job(part);
    else ff([...job, part]);
    fs.renameSync(part, out);
    return out;
  } catch (e) {
    fs.rmSync(part, { force: true });
    console.error(`could not make ${name}: ${e.message}`);
    return null;
  }
}

/** Makes the named clips (default: all) and returns the folder. Failures are reported by make(). */
function ensure(names, opt) {
  for (const n of names || Object.keys(JOBS)) make(n, opt);
  return DIR;
}

module.exports = { DIR, JOBS, make, ensure, bitmapSubs, hdr };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const force = argv.includes('--force');
  const re = new RegExp(argv.find((a) => !a.startsWith('--')) || '.');
  let n = 0;
  let failed = 0;
  for (const name of Object.keys(JOBS).filter((k) => re.test(k))) {
    const f = make(name, { force });
    if (f) { n++; console.log(`ok   ${name} ${fs.statSync(f).size}`); } else failed++;
  }
  if (re.test('bitmapsubs')) { try { bitmapSubs(); console.log('ok   bitmapsubs/*'); } catch (e) { failed++; console.error(`bitmapsubs: ${e.message}`); } }
  if (re.test('hdr')) { try { hdr(); console.log('ok   hdr/*'); } catch (e) { failed++; console.error(`hdr: ${e.message}`); } }
  console.log(`${n} clips, ${failed} failed, in ${DIR}`);
  process.exit(failed ? 1 : 0);
}
