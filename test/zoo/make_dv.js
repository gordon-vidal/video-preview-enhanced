'use strict';
// Dolby Vision test files without a Dolby encoder: an HEVC MP4 (moov after mdat, as ffmpeg writes
// it) gets a Dolby Vision configuration box (dvcC for profiles up to 7, dvvC above) in its sample
// entry, renamed dvh1. That is what players read to know a file is Dolby Vision and which base
// layer it has (profile 8.1: HDR10, 8.4: HLG, 5: none). The pictures carry no RPU: these test the
// detection and the base-layer playback, not Dolby's reshaping.
//   node test/zoo/make_dv.js <in.mp4> <out.mp4> <profile> <compat id>
const fs = require('fs');

const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl']);

/** Box at [start, end) of b: { type, start, size }, children walked by the caller. */
function boxes(b, start, end) {
  const out = [];
  for (let p = start; p + 8 <= end;) {
    const size = b.readUInt32BE(p);
    const type = b.toString('latin1', p + 4, p + 8);
    if (size < 8 || p + size > end) break;
    out.push({ type, start: p, size });
    p += size;
  }
  return out;
}

/** dvcC / dvvC payload (24 bytes): version 1.0, profile, level, rpu/el/bl flags, base-layer compatibility. */
function dvConfig(profile, compat, level = 6) {
  const p = Buffer.alloc(24);
  p[0] = 1; // dv_version_major
  p[1] = 0; // dv_version_minor
  // dv_profile (7) | dv_level (6) | rpu_present (1) | el_present (1) | bl_present (1)
  const bits = (profile << 9) | (level << 3) | (1 << 2) | (0 << 1) | 1;
  p.writeUInt16BE(bits, 2);
  p[4] = compat << 4; // dv_bl_signal_compatibility_id (4) + reserved
  return p;
}

function makeDv(input, output, profile, compat) {
  const b = fs.readFileSync(input);
  const top = boxes(b, 0, b.length);
  const moov = top.find((x) => x.type === 'moov');
  const mdat = top.find((x) => x.type === 'mdat');
  if (!moov || !mdat || moov.start < mdat.start) throw new Error('needs an MP4 with moov after mdat');
  // The path to the HEVC sample entry, outermost first.
  const chain = [moov];
  let cur = moov;
  for (;;) {
    const kids = boxes(b, cur.start + 8, cur.start + cur.size);
    const next = kids.find((k) => CONTAINERS.has(k.type) && (k.type !== 'trak' || boxes(b, k.start + 8, k.start + k.size).some((m) => m.type === 'mdia' && b.indexOf('vide', m.start) > 0 && b.indexOf('vide', m.start) < m.start + m.size)));
    const stsd = kids.find((k) => k.type === 'stsd');
    if (stsd) { chain.push(stsd); break; }
    if (!next) throw new Error('no video stsd');
    chain.push(next);
    cur = next;
  }
  const stsd = chain[chain.length - 1];
  const entry = { start: stsd.start + 16, size: b.readUInt32BE(stsd.start + 16), type: b.toString('latin1', stsd.start + 20, stsd.start + 24) };
  if (!/^(hvc1|hev1)$/.test(entry.type)) throw new Error(`sample entry ${entry.type}, not HEVC`);
  chain.push(entry);
  const box = Buffer.alloc(32);
  box.writeUInt32BE(32, 0);
  box.write(profile > 7 ? 'dvvC' : 'dvcC', 4, 'latin1');
  dvConfig(profile, compat).copy(box, 8);
  const end = entry.start + entry.size;
  const out = Buffer.concat([b.subarray(0, end), box, b.subarray(end)]);
  for (const x of chain) out.writeUInt32BE(x.size + 32, x.start);
  out.write(entry.type === 'hev1' ? 'dvhe' : 'dvh1', entry.start + 4, 'latin1');
  fs.writeFileSync(output, out);
}

if (require.main === module) {
  const [input, output, profile, compat] = process.argv.slice(2);
  makeDv(input, output, Number(profile), Number(compat));
}

module.exports = { makeDv, dvConfig };
