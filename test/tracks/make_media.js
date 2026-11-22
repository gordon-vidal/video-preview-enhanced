'use strict';
// node test/tracks/make_media.js [media dir]   (default test/media/tracks)
// Makes the multi-track and open-GOP test files (native ffmpeg with libx264/libx265
// on PATH, e.g. the gyan.dev build). A completed set is kept. Never commit the output.
//
//   tracks_multi.mkv   1080p H.264, 60 s; audio: eng aac 440 Hz (default), ger ac3 5.1 660 Hz,
//                      jpn opus 880 Hz; subs: eng srt (default), ger ass (forced)
//   tracks_multi.mp4   same picture, 30 s; audio: eng aac 440 Hz, fre aac 660 Hz; sub: eng mov_text
//   tracks_vtt.webm    VP9 + opus + a WebVTT track
//   opengop_hevc.mkv / opengop_hevc.mp4   x265 --open-gop, CRA every 1 s, 4 B-frames (RASL pictures)
//   opengop_h264.mkv   x264 open GOP (non-IDR I-frames with recovery points)
//   tracks_lossless.mkv  720p H.264 + three 5.1 PCM tracks (stream discard timing)
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const DEFAULT_DIR = path.join(__dirname, '..', 'media', 'tracks');

// Cues every 2 s (each 1.5 s long), plus a long one (8 s) every 20 s that starts 4 s
// before a round number, so a seek to a round number lands inside it.
function cues(dur, label) {
  const out = [];
  for (let t = 0; t < dur - 2; t += 2) {
    if (t % 20 === 16) { out.push([t, t + 8, `${label} long cue ${t}`]); continue; }
    if (t % 20 === 18 || t % 20 === 0 && t > 0 || t % 20 === 2) continue; // inside the long cue
    out.push([t, t + 1.5, `${label} cue ${t}\nsecond line`]);
  }
  return out;
}
const ts = (s, sep) => {
  const ms = Math.round(s * 1000);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)}${sep}${p(ms % 1000, 3)}`;
};
function srt(file, list) {
  fs.writeFileSync(file, list.map(([a, b, x], i) => `${i + 1}\n${ts(a, ',')} --> ${ts(b, ',')}\n${x.replace('second line', '<i>second</i> line')}\n`).join('\n'));
}
function vtt(file, list) {
  fs.writeFileSync(file, `WEBVTT\n\n${list.map(([a, b, x]) => `${ts(a, '.')} --> ${ts(b, '.')}\n${x}\n`).join('\n')}`);
}
function ass(file, list) {
  const t = (s) => { const cs = Math.round(s * 100); return `${Math.floor(cs / 360000)}:${String(Math.floor(cs / 6000) % 60).padStart(2, '0')}:${String(Math.floor(cs / 100) % 60).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`; };
  fs.writeFileSync(file, `[Script Info]\nScriptType: v4.00+\nPlayResX: 1920\nPlayResY: 1080\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,Arial,60,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,10,10,40,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n${list.map(([a, b, x]) => `Dialogue: 0,${t(a)},${t(b)},Default,,0,0,0,,{\\i1}${x.replace('\n', '\\N')}{\\i0}`).join('\n')}\n`);
}

function ff(args) {
  const r = spawnSync(process.env.VPE_FFMPEG || 'ffmpeg', ['-hide_banner', '-v', 'error', '-y', ...args], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error((r.stderr || r.error?.message || `ffmpeg exit ${r.status}`).trim());
}
const pic = (size, dur, rate = 30) => ['-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=${rate}:duration=${dur}`];
const tone = (hz, dur) => ['-f', 'lavfi', '-i', `sine=frequency=${hz}:sample_rate=48000:duration=${dur}`];

// Bump the marker when the recipes change. Sizes also detect a missing or truncated file after generation.
const STAMP = '.tracks-v1.json';
const NAMES = ['tracks_multi.mkv', 'tracks_multi.mp4', 'tracks_vtt.webm', 'tracks_lossless.mkv',
  'opengop_hevc.mkv', 'opengop_hevc.mp4', 'opengop_h264.mkv', 'h264_aac.mkv', 'h264_aac.m2ts'];

function complete(dir) {
  try {
    const sizes = JSON.parse(fs.readFileSync(path.join(dir, STAMP), 'utf8'));
    return NAMES.every((name) => sizes[name] > 0 && fs.statSync(path.join(dir, name)).size === sizes[name]);
  } catch (e) {
    if (e.code !== 'ENOENT' && !(e instanceof SyntaxError)) throw e;
    return false;
  }
}

/** Find a complete set or generate one inside the calling test worker's timeout. */
function ensure(folder = DEFAULT_DIR) {
  if (complete(folder)) return folder; // A set generated explicitly into this folder.
  fs.mkdirSync(folder, { recursive: true });
  const cached = () => fs.readdirSync(folder).filter((name) => name.startsWith('.ready-'))
    .map((name) => path.join(folder, name)).find(complete);
  const existing = cached();
  if (existing) return existing;

  // Parallel workers never overwrite a set another worker may already be reading.
  const tmp = fs.mkdtempSync(path.join(folder, '.pending-'));
  try {
    const r = spawnSync(process.execPath, [__filename, tmp], { stdio: 'inherit', windowsHide: true });
    if (r.status !== 0) {
      throw new Error('track fixture generation failed (ffmpeg needs libx264, libx265, libvpx-vp9, libopus and ac3)');
    }
    const published = cached();
    if (published) return published;
    const ready = path.join(folder, path.basename(tmp).replace('.pending-', '.ready-'));
    fs.renameSync(tmp, ready);
    return ready;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

module.exports = { cues, ensure };
if (require.main !== module) return;
const dir = path.resolve(process.argv[2] || DEFAULT_DIR);
if (complete(dir)) return;
fs.mkdirSync(dir, { recursive: true });
const tmp = fs.mkdtempSync(path.join(dir, '.generating-'));
const jobs = [];
{
  const D = 60;
  const en = path.join(tmp, 'en.srt');
  const de = path.join(tmp, 'de.ass');
  srt(en, cues(D, 'EN'));
  ass(de, cues(D, 'DE'));
  jobs.push(['tracks_multi.mkv', [
    ...pic('1920x1080', D), ...tone(440, D), ...tone(660, D), ...tone(880, D), '-i', en, '-i', de,
    '-map', '0:v', '-map', '1:a', '-map', '2:a', '-map', '3:a', '-map', '4:s', '-map', '5:s',
    '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-g', '60',
    '-c:a:0', 'aac', '-c:a:1', 'ac3', '-ac:a:1', '6', '-c:a:2', 'libopus', '-c:s:0', 'srt', '-c:s:1', 'ass',
    '-metadata:s:a:0', 'language=eng', '-metadata:s:a:0', 'title=English stereo',
    '-metadata:s:a:1', 'language=ger', '-metadata:s:a:1', 'title=Deutsch 5.1',
    '-metadata:s:a:2', 'language=jpn',
    '-metadata:s:s:0', 'language=eng', '-metadata:s:s:1', 'language=ger', '-metadata:s:s:1', 'title=Signs',
    '-disposition:a:0', 'default', '-disposition:a:1', '0', '-disposition:a:2', '0',
    '-disposition:s:0', 'default', '-disposition:s:1', 'forced',
  ]]);
}
{
  const D = 30;
  const en = path.join(tmp, 'en30.srt');
  srt(en, cues(D, 'EN'));
  jobs.push(['tracks_multi.mp4', [
    ...pic('1920x1080', D), ...tone(440, D), ...tone(660, D), '-i', en,
    '-map', '0:v', '-map', '1:a', '-map', '2:a', '-map', '3:s',
    '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-g', '60', '-c:a', 'aac', '-c:s', 'mov_text',
    '-metadata:s:a:0', 'language=eng', '-metadata:s:a:1', 'language=fre', '-metadata:s:s:0', 'language=eng',
    '-disposition:a:0', 'default', '-disposition:a:1', '0',
  ]]);
}
{
  const D = 20;
  const en = path.join(tmp, 'en.vtt');
  vtt(en, cues(D, 'VTT'));
  jobs.push(['tracks_vtt.webm', [
    ...pic('640x360', D), ...tone(440, D), '-i', en, '-map', '0:v', '-map', '1:a', '-map', '2:s',
    '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-b:v', '1M', '-c:a', 'libopus', '-c:s', 'webvtt',
    '-metadata:s:s:0', 'language=eng',
  ]]);
}
// A remux-like file where unused streams weigh a lot: 720p H.264 and three 5.1 PCM tracks.
jobs.push(['tracks_lossless.mkv', [
  ...pic('1280x720', 30), ...tone(440, 30), ...tone(660, 30), ...tone(880, 30), '-map', '0:v', '-map', '1:a', '-map', '2:a', '-map', '3:a',
  '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'pcm_s24le', '-ac', '6',
]]);
const x265og =['-c:v', 'libx265', '-preset', 'fast', '-pix_fmt', 'yuv420p', '-x265-params', 'log-level=error:open-gop=1:keyint=30:min-keyint=30:scenecut=0:bframes=4:b-pyramid=1:radl=0'];
jobs.push(['opengop_hevc.mkv', [...pic('640x360', 10), ...tone(440, 10), ...x265og, '-c:a', 'aac']]);
jobs.push(['opengop_hevc.mp4', [...pic('640x360', 10), ...tone(440, 10), ...x265og, '-tag:v', 'hvc1', '-c:a', 'aac']]);
jobs.push(['opengop_h264.mkv', [...pic('640x360', 10), ...tone(440, 10), '-c:v', 'libx264', '-preset', 'fast', '-pix_fmt', 'yuv420p',
  '-x264-params', 'open-gop=1:keyint=30:min-keyint=30:scenecut=0:bframes=3', '-c:a', 'aac']]);
// Plain H.264 + AAC in MKV and MPEG-TS (run.js: the WebCodecs path with its own stream setup).
for (const [name, extra] of [['h264_aac.mkv', []], ['h264_aac.m2ts', ['-f', 'mpegts']]]) {
  jobs.push([name, [...pic('640x360', 6), ...tone(440, 6), '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', ...extra]]);
}

try {
  const sizes = {};
  for (const [name, args] of jobs) {
    const out = path.join(tmp, name);
    console.log(`making  ${name}`);
    ff([...args, out]);
    sizes[name] = fs.statSync(out).size;
    if (!sizes[name]) throw new Error(`ffmpeg produced an empty ${name}`);
  }
  fs.writeFileSync(path.join(tmp, STAMP), JSON.stringify(sizes));
  for (const name of NAMES) fs.renameSync(path.join(tmp, name), path.join(dir, name));
  fs.renameSync(path.join(tmp, STAMP), path.join(dir, STAMP));
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
