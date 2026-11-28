'use strict';
// node test/zoo/make_hdr.js <zoo dir>   (writes <zoo dir>/hdr/{hevc10_pq,hevc10_hlg,h264_pq}.mp4)
// The HDR test pattern for test/vscode/cases/inspect.js (hdr/*, patch centres as HDR_PATCHES there): 1920x1080, 3 rows of 8 patches
// (240x360) named as HDR_PATCHES there, each a flat colour given in linear light (nits, BT.709
// primaries unless named *2020). Needs ffmpeg with libx265 and libx264 (VPE_FFMPEG or PATH).
//
// The frame is written as 4:2:0 already (flat patches subsample exactly), so ffmpeg only
// encodes: a yuv444p10 -> yuv420p10 conversion in swscale moved luma by ~8 codes, which made
// near-peak HLG patches clip (green1000 came out 31 codes off in blue).
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const out = path.join(path.resolve(process.argv[2] || path.join(__dirname, 'data')), 'hdr');
fs.mkdirSync(out, { recursive: true });
const W = 1920;
const H = 1080;
const n = (r, g, b) => ({ c709: [r, g, b] });
const n2020 = (r, g, b) => ({ c2020: [r, g, b] });
const P = {
  white203: n(203, 203, 203), yellow: n(203, 203, 0), cyan: n(0, 203, 203), green: n(0, 203, 0),
  magenta: n(203, 0, 203), red: n(203, 0, 0), blue: n(0, 0, 203), black: n(0, 0, 0),
  g5: n(5, 5, 5), g20: n(20, 20, 20), g50: n(50, 50, 50), g100: n(100, 100, 100),
  g203: n(203, 203, 203), g400: n(400, 400, 400), g1000: n(1000, 1000, 1000), g4000: n(4000, 4000, 4000),
  red2020: n2020(203, 0, 0), green2020: n2020(0, 203, 0), blue2020: n2020(0, 0, 203),
  red1000: n(1000, 0, 0), green1000: n(0, 1000, 0), blue1000: n(0, 0, 1000),
  skin100: n(100, 62, 45), g10: n(10, 10, 10),
};
const NAMES = ['white203', 'yellow', 'cyan', 'green', 'magenta', 'red', 'blue', 'black', 'g5', 'g20', 'g50', 'g100', 'g203', 'g400', 'g1000', 'g4000',
  'red2020', 'green2020', 'blue2020', 'red1000', 'green1000', 'blue1000', 'skin100', 'g10'];
// BT.709 -> BT.2020 primaries in linear light (ITU-R BT.2087).
const M = [[0.6274, 0.3293, 0.0433], [0.0691, 0.9195, 0.0114], [0.0164, 0.0880, 0.8956]];
const lin2020 = (p) => (p.c2020 ? p.c2020 : M.map((row) => row[0] * p.c709[0] + row[1] * p.c709[1] + row[2] * p.c709[2]));

const pq = (nits) => { const p = (Math.max(0, nits) / 10000) ** 0.1593017578125; return ((0.8359375 + 18.8515625 * p) / (1 + 18.6875 * p)) ** 78.84375; };
// HLG for a 1000-nit display (system gamma 1.2): inverse OOTF on luminance, then the OETF.
const hlgOetf = (e) => { const a = 0.17883277; const b = 1 - 4 * a; const c = 0.5 - a * Math.log(4 * a); e = Math.max(0, Math.min(1, e)); return e <= 1 / 12 ? Math.sqrt(3 * e) : a * Math.log(12 * e - b) + c; };
function hlg(nits) {
  const fd = nits.map((v) => v / 1000);
  const yd = 0.2627 * fd[0] + 0.678 * fd[1] + 0.0593 * fd[2];
  if (yd <= 0) return [0, 0, 0];
  return fd.map((v) => hlgOetf(v / yd ** (0.2 / 1.2)));
}
/** Limited-range BT.2020 non-constant-luminance Y'CbCr codes at `bits`. */
function ycc([r, g, b], bits) {
  const y = 0.2627 * r + 0.678 * g + 0.0593 * b;
  const s = 1 << (bits - 8);
  const cl = (v) => Math.max(0, Math.min((1 << bits) - 1, Math.round(v)));
  return [cl((16 + 219 * y) * s), cl((128 + 224 * (b - y) / 1.8814) * s), cl((128 + 224 * (r - y) / 1.4746) * s)];
}
function frame(kind, bits) {
  const bpc = bits > 8 ? 2 : 1;
  const cw = W / 2;
  const chh = H / 2;
  const buf = Buffer.alloc((W * H + 2 * cw * chh) * bpc);
  const put = (i, v) => { if (bpc === 2) buf.writeUInt16LE(v, i * 2); else buf[i] = v; };
  NAMES.forEach((name, k) => {
    const lin = lin2020(P[name]);
    const [y, u, v] = ycc(kind === 'hlg' ? hlg(lin) : lin.map(pq), bits);
    const x0 = (k % 8) * 240;
    const y0 = Math.floor(k / 8) * 360;
    for (let yy = y0; yy < y0 + 360; yy++) for (let x = x0; x < x0 + 240; x++) put(yy * W + x, y);
    for (let yy = y0 / 2; yy < (y0 + 360) / 2; yy++) {
      for (let x = x0 / 2; x < (x0 + 240) / 2; x++) { put(W * H + yy * cw + x, u); put(W * H + cw * chh + yy * cw + x, v); }
    }
  });
  return buf;
}
const ff = process.env.VPE_FFMPEG || 'ffmpeg';
const jobs = [
  ['hevc10_pq.mp4', 'pq', 10, 'smpte2084', ['-c:v', 'libx265', '-preset', 'fast', '-crf', '12', '-tag:v', 'hvc1', '-x265-params', 'log-level=error:colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc:range=limited:master-display=G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(10000000,1):max-cll=1000,400']],
  ['hevc10_hlg.mp4', 'hlg', 10, 'arib-std-b67', ['-c:v', 'libx265', '-preset', 'fast', '-crf', '12', '-tag:v', 'hvc1', '-x265-params', 'log-level=error:colorprim=bt2020:transfer=arib-std-b67:colormatrix=bt2020nc:range=limited']],
  ['h264_pq.mp4', 'pq', 8, 'smpte2084', ['-c:v', 'libx264', '-preset', 'fast', '-crf', '10', '-x264-params', 'colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc']],
];
const requested = process.argv.slice(3);
let failed = 0;
for (const [name, kind, bits, trc, enc] of jobs) {
  if (requested.length && !requested.includes(name)) continue;
  const raw = path.join(out, `${name}.yuv`);
  fs.writeFileSync(raw, frame(kind, bits));
  const pix = bits > 8 ? 'yuv420p10le' : 'yuv420p';
  const tags = ['-color_primaries', 'bt2020', '-color_trc', trc, '-colorspace', 'bt2020nc', '-color_range', 'tv'];
  const r = spawnSync(ff, ['-hide_banner', '-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', pix, '-s', `${W}x${H}`, '-framerate', '30', '-stream_loop', '119', ...tags, '-i', raw,
    ...enc, '-pix_fmt', pix, ...tags, path.join(out, name)], { encoding: 'utf8', windowsHide: true });
  fs.unlinkSync(raw);
  if (r.status !== 0) failed++;
  console.log(name, r.status === 0 ? 'ok' : r.stderr || r.error);
}
process.exit(failed ? 1 : 0);
