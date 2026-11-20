#!/usr/bin/env node
'use strict';
// Rebuilds the test/benchmark clips in test/media/ and the probe clips in media/probe/
// from real footage (sources, licences and attribution: test/media/LICENSES.md).
//
//   node test/media/make_media.js --src <footage dir> [--ffmpeg <exe>] [--only <regex>]
//        [--masters] [--probe] [--bench] [--list]
//
// Steps (default: all three; heavy encodes belong in the queue: node test/benchq.js node test/media/make_media.js ...):
//   --masters  frame sequences / source cut -> lossless FFV1 masters in <src>/masters (not committed)
//   --bench    masters -> test/media/*  (the codec matrix below)
//   --probe    masters -> media/probe/* (the clips src/probe.js tests ffmpeg with; shipped)
//
// <src> holds what test/media/fetch_sources.js downloads (only the frames used, not the whole films):
//   tos/00700.tif .. 00747.tif         Tears of Steel, 4K 16-bit TIFF (4096x1714, 24 fps, sRGB grade)
//   meridian/15000.tif .. 15118.tif    Meridian, UHD 16-bit TIFF, P3-D65 PQ, 59.94 fps; every 2nd frame
//   sparks/05940.tif .. 06058.tif      Sparks, HDR10 1000-nit 16-bit TIFF, BT.2020 PQ, 4096x2160, 59.94 fps; every 2nd frame
//   bbb/bbb_sunflower_1080p_30fps_normal.mp4   Big Buck Bunny (H.264 + MP3 / AC-3 delivery)
// Needs an ffmpeg with zscale, libx264, libx265, libsvtav1, libvpx, libopus (e.g. the BtbN GPL build).
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const flag = (n) => argv.includes(n);
const SRC = path.resolve(opt('--src', process.env.VPE_FOOTAGE || '.'));
const FF = opt('--ffmpeg', process.env.VPE_FFMPEG || 'ffmpeg');
const ONLY = new RegExp(opt('--only', '.'));
const REPO = path.resolve(__dirname, '..', '..');
const OUT = __dirname;
const PROBE_OUT = path.join(REPO, 'media', 'probe');
const MASTERS = path.join(SRC, 'masters');
const steps = ['--masters', '--bench', '--probe'].filter(flag);
const doStep = (s) => !steps.length || steps.includes(s);

// ---- masters -----------------------------------------------------------------------------
// FFV1 4:4:4 12-bit, lossless after the conversion. Colour: SDR masters are BT.709 limited
// range; the Tears of Steel TIFFs carry the BT.709-style grade as-is (no transfer change).
const NTSC = '30000/1001';
const toYuv709 = 'zscale=min=gbr:rin=pc:tin=bt709:pin=bt709:m=bt709:r=tv:t=bt709:p=bt709,format=yuv444p12le';
// Meridian is graded in P3-D65 PQ (Dolby Vision master): tone-mapped to SDR BT.709 (hable,
// 100 nits = SDR white) for the SDR codec matrix.
const merSdr = 'format=gbrpf32le,zscale=tin=smpte2084:pin=smpte432:min=gbr:rin=pc:t=linear:npl=100:p=bt709:m=gbr:r=pc,' +
  'tonemap=hable:desat=0,zscale=tin=linear:pin=bt709:min=gbr:rin=pc:t=bt709:p=bt709:m=bt709:r=tv,format=yuv444p12le';
// Sparks HDR10 is BT.2020 PQ already: only cropped to UHD and converted to YCbCr. The HLG
// version converts the same display light (BT.2100, 1000-nit nominal peak) to HLG.
const sparksPq = 'crop=3840:2160:128:0,zscale=min=gbr:rin=pc:tin=smpte2084:pin=bt2020:m=bt2020nc:r=tv:t=smpte2084:p=bt2020,format=yuv444p12le';
const sparksHlg = 'crop=3840:2160:128:0,format=gbrpf32le,zscale=min=gbr:rin=pc:tin=smpte2084:pin=bt2020:t=linear:npl=1000:p=bt2020:m=gbr:r=pc,' +
  'zscale=tin=linear:npl=1000:pin=bt2020:min=gbr:rin=pc:t=arib-std-b67:p=bt2020:m=bt2020nc:r=tv,format=yuv444p12le';

const MASTER_LIST = [
  // name, frame dir, first, last, step, input rate, filter, colour tags
  { name: 'tos_1080', dir: 'tos', first: 700, last: 747, step: 1, rate: '24', vf: `crop=3040:1710:(iw-3040)/2:(ih-1710)/2,scale=1920:1080:flags=lanczos,${toYuv709}`, tags: tags709() },
  { name: 'mer_2160', dir: 'meridian', first: 15000, last: 15118, step: 2, rate: NTSC, vf: merSdr, tags: tags709() },
  { name: 'sparks_2160_pq', dir: 'sparks', first: 5940, last: 6058, step: 2, rate: NTSC, vf: sparksPq, tags: tagsHdr('smpte2084') },
  { name: 'sparks_2160_hlg', dir: 'sparks', first: 5940, last: 6058, step: 2, rate: NTSC, vf: sparksHlg, tags: tagsHdr('arib-std-b67') },
];
function tags709() { return ['-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-color_range', 'tv']; }
function tagsHdr(trc) { return ['-color_primaries', 'bt2020', '-color_trc', trc, '-colorspace', 'bt2020nc', '-color_range', 'tv']; }
const BBB = { file: path.join('bbb', 'bbb_sunflower_1080p_30fps_normal.mp4'), ss: '423', t: '3' };

function ff(args, what) {
  const t0 = Date.now();
  const r = spawnSync(FF, ['-hide_banner', '-v', 'error', '-y', ...args], { stdio: ['ignore', 'inherit', 'pipe'], encoding: 'utf8', windowsHide: true, maxBuffer: 1 << 26 });
  if (r.status !== 0) throw new Error(`${what}: ffmpeg failed (${r.status}): ${(r.stderr || '').trim().split(/\r?\n/).slice(-3).join(' | ')}`);
  return (Date.now() - t0) / 1000;
}

function makeMasters() {
  fs.mkdirSync(MASTERS, { recursive: true });
  for (const m of MASTER_LIST) {
    if (!ONLY.test(m.name)) continue;
    // image2 wants contiguous numbers: hard links 00000.tif... in a temp folder (no copies).
    const seq = path.join(MASTERS, `seq_${m.name}`);
    fs.rmSync(seq, { recursive: true, force: true });
    fs.mkdirSync(seq);
    let k = 0;
    for (let n = m.first; n <= m.last; n += m.step) {
      const f = path.join(SRC, m.dir, `${String(n).padStart(5, '0')}.tif`);
      if (!fs.existsSync(f)) throw new Error(`missing source frame ${f}`);
      fs.linkSync(f, path.join(seq, `${String(k++).padStart(5, '0')}.tif`));
    }
    const out = path.join(MASTERS, `${m.name}.mkv`);
    const s = ff(['-framerate', m.rate, '-i', path.join(seq, '%05d.tif'), '-vf', m.vf, ...m.tags, '-c:v', 'ffv1', '-level', '3', '-g', '1', '-slices', '16', out], m.name);
    fs.rmSync(seq, { recursive: true, force: true });
    console.log(`master ${m.name}: ${k} frames, ${(fs.statSync(out).size / 1e6).toFixed(0)} MB, ${s.toFixed(0)} s`);
  }
}

// ---- the codec matrix (test/media) -------------------------------------------------------
// Bitrates: typical delivery rates for the resolution (streaming / camera / mezzanine). AV1 uses
// CRF picked to land near 3 Mb/s (1080p) and 8 Mb/s (4K): SVT-AV1's VBR undershot 3-6x on 2 s clips.
// Long-GOP clips 2 s (2 s keyframe interval), intra-only ProRes / DNxHR 1 s (each frame
// decodes alone, so a 1 s loop costs the same per frame), animation with audio 3 s.
const M = (n) => path.join(MASTERS, n);
const X265 = (extra = '') => ['-x265-params', `log-level=error${extra}`];
const HDR10 = ':hdr10=1:colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc:master-display=G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(10000000,1):max-cll=1000,400';
const HLG = ':colorprim=bt2020:transfer=arib-std-b67:colormatrix=bt2020nc';
const vbr = (b, max) => ['-b:v', b, '-maxrate', max, '-bufsize', max];
const BENCH = [
  // file, master, extra input args, video filter, encoder args, frames
  ['h264_8_1080p.mp4', 'tos_1080', 'format=yuv420p', ['-c:v', 'libx264', '-preset', 'medium', ...vbr('6M', '10M'), '-g', '48', '-movflags', '+faststart'], 48],
  ['h264_10_1080p.mp4', 'tos_1080', 'format=yuv420p10le', ['-c:v', 'libx264', '-preset', 'medium', '-profile:v', 'high10', ...vbr('6M', '10M'), '-g', '48'], 48],
  ['hevc_8_1080p.mp4', 'tos_1080', 'format=yuv420p', ['-c:v', 'libx265', '-preset', 'medium', ...vbr('4M', '7M'), '-g', '48', '-tag:v', 'hvc1', ...X265()], 48],
  ['hevc_10_1080p.mp4', 'tos_1080', 'format=yuv420p10le', ['-c:v', 'libx265', '-preset', 'medium', ...vbr('4M', '7M'), '-g', '48', '-tag:v', 'hvc1', ...X265()], 48],
  ['av1_8_1080p.mp4', 'tos_1080', 'format=yuv420p', ['-c:v', 'libsvtav1', '-preset', '6', '-crf', '28', '-g', '48'], 48],
  ['av1_10_1080p.mp4', 'tos_1080', 'format=yuv420p10le', ['-c:v', 'libsvtav1', '-preset', '6', '-crf', '28', '-g', '48'], 48],
  ['vp9_1080p.webm', 'tos_1080', 'format=yuv420p', ['-c:v', 'libvpx-vp9', '-deadline', 'good', '-cpu-used', '2', '-row-mt', '1', '-b:v', '4M', '-g', '48'], 48],
  ['mpeg2_1080p.mpg', 'tos_1080', 'format=yuv420p', ['-c:v', 'mpeg2video', ...vbr('10M', '15M'), '-g', '12', '-bf', '2', '-f', 'mpeg'], 48],
  ['prores_proxy_1080p.mov', 'tos_1080', 'format=yuv422p10le', ['-c:v', 'prores_ks', '-profile:v', '0', '-vendor', 'apl0'], 24],
  ['dnxhr_lb_1080p.mov', 'tos_1080', 'format=yuv422p', ['-c:v', 'dnxhd', '-profile:v', 'dnxhr_lb'], 24],
  ['h264_8_2160p.mp4', 'mer_2160', 'format=yuv420p', ['-c:v', 'libx264', '-preset', 'medium', ...vbr('16M', '25M'), '-g', '60', '-movflags', '+faststart'], 60],
  ['hevc_10_2160p.mp4', 'mer_2160', 'format=yuv420p10le', ['-c:v', 'libx265', '-preset', 'medium', ...vbr('12M', '20M'), '-g', '60', '-tag:v', 'hvc1', ...X265()], 60],
  ['av1_10_2160p.mp4', 'mer_2160', 'format=yuv420p10le', ['-c:v', 'libsvtav1', '-preset', '7', '-crf', '23', '-g', '60'], 60],
  ['vp9_2160p.webm', 'mer_2160', 'format=yuv420p', ['-c:v', 'libvpx-vp9', '-deadline', 'good', '-cpu-used', '3', '-row-mt', '1', '-tile-columns', '2', '-b:v', '12M', '-g', '60'], 60],
  ['hevc_10_pq_2160p.mp4', 'sparks_2160_pq', 'format=yuv420p10le', ['-c:v', 'libx265', '-preset', 'medium', ...vbr('12M', '20M'), '-g', '60', '-tag:v', 'hvc1', ...X265(HDR10)], 60],
  ['hevc_10_hlg_2160p.mp4', 'sparks_2160_hlg', 'format=yuv420p10le', ['-c:v', 'libx265', '-preset', 'medium', ...vbr('12M', '20M'), '-g', '60', '-tag:v', 'hvc1', ...X265(HLG)], 60],
  ['h264_aac_anim_1080p.mp4', 'bbb', 'setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv,format=yuv420p', ['-c:v', 'libx264', '-preset', 'medium', ...vbr('5M', '8M'), '-g', '60', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart'], 90],
  ['vp9_opus_anim_1080p.webm', 'bbb', 'setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv,format=yuv420p', ['-c:v', 'libvpx-vp9', '-deadline', 'good', '-cpu-used', '2', '-row-mt', '1', '-b:v', '3M', '-g', '60', '-c:a', 'libopus', '-b:a', '128k'], 90],
];

function input(master) {
  if (master === 'bbb') return ['-ss', BBB.ss, '-t', BBB.t, '-i', path.join(SRC, BBB.file), '-map', '0:v:0', '-map', '0:a:0'];
  return ['-i', M(`${master}.mkv`), '-an'];
}
const colourOut = (master) => (/sparks/.test(master) ? [] : ['-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-color_range', 'tv']);

function encode(list, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  let total = 0;
  for (const [file, master, vf, enc, frames] of list) {
    if (!ONLY.test(file)) continue;
    const out = path.join(outDir, file);
    const s = ff([...input(master), '-vf', vf, '-frames:v', String(frames), ...colourOut(master), ...enc, '-map_metadata', '-1', '-fflags', '+bitexact', out], file);
    const size = fs.statSync(out).size;
    total += size;
    console.log(`${file.padEnd(28)} ${(size / 1e6).toFixed(2).padStart(6)} MB  ${String(frames).padStart(3)} frames  ${s.toFixed(0)} s`);
  }
  console.log(`total ${(total / 1e6).toFixed(2)} MB`);
}

// ---- probe clips (media/probe, shipped in the extension) -----------------------------------
// Meridian (live action, dark, rain): 1080p 1 s, 4K 0.5 s, low bitrates so all 11 stay under
// 1.5 MB. Names and classes: src/probe.js CLIPS.
function probeList() {
  const { CLIPS } = require('../../src/probe');
  const enc = {
    h2648: (r) => ['-c:v', 'libx264', '-preset', 'medium', '-b:v', r, '-pix_fmt', 'yuv420p'],
    hevc8: (r) => ['-c:v', 'libx265', '-preset', 'medium', '-b:v', r, '-pix_fmt', 'yuv420p', ...X265()],
    hevc10: (r) => ['-c:v', 'libx265', '-preset', 'medium', '-b:v', r, '-pix_fmt', 'yuv420p10le', ...X265()],
    av18: () => ['-c:v', 'libsvtav1', '-preset', '7', '-crf', '40', '-pix_fmt', 'yuv420p'],
    vp98: (r) => ['-c:v', 'libvpx-vp9', '-deadline', 'good', '-cpu-used', '3', '-row-mt', '1', '-b:v', r, '-pix_fmt', 'yuv420p'],
    prores10: () => ['-c:v', 'prores_ks', '-profile:v', '0', '-pix_fmt', 'yuv422p10le'],
  };
  return CLIPS.map((c) => {
    const big = c.res === '2160';
    const frames = c.frames || (big ? 15 : 30);
    const vf = big ? 'null' : 'scale=1920:1080:flags=lanczos';
    return [c.file, 'mer_2160', vf, [...enc[`${c.codec}${c.depth}`](big ? '2M' : '1M'), '-g', String(frames), '-an'], frames];
  });
}

(async () => {
  if (flag('--list')) { for (const b of BENCH) console.log(b[0]); return; }
  if (doStep('--masters')) makeMasters();
  if (doStep('--bench')) encode(BENCH, OUT);
  if (doStep('--probe')) encode(probeList(), PROBE_OUT);
})().catch((e) => { console.error(e.message); process.exit(1); });
