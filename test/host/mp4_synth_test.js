'use strict';
// node test/host/mp4_synth_test.js: src/rotation.js (rotationOf) on
// hand-built MP4 files, so no ffmpeg is needed: every rotation, 64-bit and v1 headers,
// truncated and hostile boxes, moov position and the top-level box cap.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { rotationOf } = require('../../src/rotation');

const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b; };
const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; };
const box = (type, ...parts) => { const body = Buffer.concat(parts); return Buffer.concat([u32(8 + body.length), Buffer.from(type, 'latin1'), body]); };
const zeros = (n) => Buffer.alloc(n);

// Matrix for a rotation (16.16 fixed point a, b; c, d; the rest does not matter here).
function matrix(deg) {
  const r = (deg * Math.PI) / 180;
  const fx = (x) => { const b = Buffer.alloc(4); b.writeInt32BE(Math.round(x * 65536)); return b; };
  return Buffer.concat([fx(Math.cos(r)), fx(Math.sin(r)), zeros(4), fx(-Math.sin(r)), fx(Math.cos(r)), zeros(4), zeros(12)]);
}
function tkhd(deg, v1 = false) {
  return v1
    ? box('tkhd', Buffer.from([1, 0, 0, 3]), zeros(8 + 8 + 4 + 4 + 8 + 8 + 2 + 2 + 2 + 2), matrix(deg), zeros(8))
    : box('tkhd', Buffer.from([0, 0, 0, 3]), zeros(4 + 4 + 4 + 4 + 4 + 8 + 2 + 2 + 2 + 2), matrix(deg), zeros(8));
}
const hdlr = (kind) => box('hdlr', zeros(8), Buffer.from(kind, 'latin1'), zeros(13));
const mdhd = (scale, v1 = false) => (v1
  ? box('mdhd', Buffer.from([1, 0, 0, 0]), zeros(16), u32(scale), zeros(12))
  : box('mdhd', zeros(4), zeros(8), u32(scale), zeros(8)));
const stts = (count, delta) => box('stts', zeros(4), u32(1), u32(count), u32(delta));
const ctts = (version, runs) => box('ctts', Buffer.from([version, 0, 0, 0]), u32(runs.length), ...runs.map(([n, o]) => Buffer.concat([u32(n), u32(o)])));

// Visual sample entry: 78 bytes of header, then config boxes.
function entry(type, w, h, ...children) {
  const head = Buffer.concat([zeros(6), u16(1), zeros(16), u16(w), u16(h), zeros(78 - 24 - 4)]);
  assert.strictEqual(head.length, 78);
  return box(type, head, ...children);
}
const hvcC = (depth, { chroma = 1, ver = 1 } = {}) => {
  const b = Buffer.alloc(23);
  b[0] = ver; b[16] = 0xfc | chroma; b[17] = 0xf8 | (depth - 8); b[18] = 0xf8 | (depth - 8);
  return box('hvcC', b);
};
const avcC = (profile, chroma, depth) => {
  const sps = Buffer.from([0x67, 1, 2, 3]);
  const pps = Buffer.from([0x68, 4]);
  return box('avcC', Buffer.from([1, profile, 0, 31, 0xff, 0xe1]), u16(sps.length), sps, Buffer.from([1]), u16(pps.length), pps,
    Buffer.from([0xfc | chroma, 0xf8 | (depth - 8), 0xf8 | (depth - 8), 0]));
};

function track({ kind = 'vide', rot = 0, v1 = false, w = 1280, h = 720, codec, fps = 30, count = 90, scale = 30000, c, stsdCount = 1, sttsBox, cttsBox, mdhdBox } = {}) {
  const ent = codec ? entry(codec, w, h, c || hvcC(8)) : null;
  const stbl = kind === 'vide' && ent
    ? box('stbl', box('stsd', zeros(4), u32(stsdCount), ent), sttsBox || stts(count, scale / fps), ...(cttsBox ? [cttsBox] : []))
    : box('stbl', box('stsd', zeros(4), u32(0)));
  return box('trak', tkhd(rot, v1), box('mdia', mdhdBox || mdhd(scale), hdlr(kind), box('minf', stbl)));
}
const mp4 = (...moovParts) => Buffer.concat([box('ftyp', Buffer.from('isom', 'latin1'), zeros(8)), box('moov', ...moovParts), box('mdat', zeros(16))]);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vpe_mp4s_'));
let n = 0;
const write = (buf, ext = '.mp4') => { const f = path.join(dir, `f${n++}${ext}`); fs.writeFileSync(f, buf); return f; };

(async () => {
  try {
    const changing = write(mp4(track({ rot: 90, codec: 'hvc1' })));
    const open = fs.promises.open;
    let opens = 0;
    fs.promises.open = (...args) => { opens++; return open(...args); };
    try {
      assert.deepStrictEqual(await Promise.all([rotationOf(changing), rotationOf(changing)]), [90, 90]);
      assert.strictEqual(await rotationOf(changing), 90);
      assert.strictEqual(opens, 1, 'concurrent and repeated lookups share one read');
      fs.writeFileSync(changing, mp4(track({ rot: 270, codec: 'hvc1' })));
      fs.utimesSync(changing, new Date(0), new Date(0));
      assert.strictEqual(await rotationOf(changing), 270, 'same-size rewrite invalidates rotation');
      assert.strictEqual(opens, 2);
    } finally { fs.promises.open = open; }

    // ---- rotationOf ---------------------------------------------------------------
    for (const deg of [0, 90, 180, 270]) {
      assert.strictEqual(await rotationOf(write(mp4(track({ rot: deg, codec: 'hvc1' })))), deg, `${deg} degrees`);
      assert.strictEqual(await rotationOf(write(mp4(track({ rot: deg, codec: 'hvc1', v1: true })))), deg, `${deg} degrees, 64-bit tkhd`);
    }
    assert.strictEqual(await rotationOf(write(mp4(track({ rot: 270, codec: 'hvc1' })), '.MOV')), 270, 'extension is case-insensitive');
    assert.strictEqual(await rotationOf(write(mp4(track({ rot: 90, codec: 'hvc1' })), '.mkv')), 0, 'not an MP4 extension');
    assert.strictEqual(await rotationOf(write(mp4(track({ rot: 90, codec: 'hvc1' })), '')), 0);
    assert.strictEqual(await rotationOf(path.join(dir, 'missing.mp4')), 0, 'missing file');
    assert.strictEqual(await rotationOf(write(Buffer.alloc(0))), 0, 'empty file');
    assert.strictEqual(await rotationOf(write(Buffer.from('not an mp4 at all, just text'))), 0);
    // An audio track first, rotated video second: the video track decides.
    assert.strictEqual(await rotationOf(write(mp4(track({ kind: 'soun', rot: 180 }), track({ rot: 90, codec: 'hvc1' })))), 90);
    // Audio only: no video track, no rotation.
    assert.strictEqual(await rotationOf(write(mp4(track({ kind: 'soun', rot: 90 })))), 0);
    // A matrix that is not a multiple of 90 is rounded to the nearest quarter turn.
    assert.strictEqual(await rotationOf(write(mp4(track({ rot: 80, codec: 'hvc1' })))), 90);
    assert.strictEqual(await rotationOf(write(mp4(track({ rot: 44, codec: 'hvc1' })))), 0);
    // moov after mdat (the usual non-faststart layout).
    const late = Buffer.concat([box('ftyp', Buffer.from('isom', 'latin1'), zeros(8)), box('mdat', zeros(4096)), box('moov', track({ rot: 90, codec: 'hvc1' }))]);
    assert.strictEqual(await rotationOf(write(late)), 90);
    // 64-bit mdat size (size field 1) before moov, and size 0 (to end of file) for the last box.
    const mdat64 = Buffer.concat([u32(1), Buffer.from('mdat'), Buffer.from([0, 0, 0, 0, 0, 0, 0, 16 + 8]), zeros(8)]);
    assert.strictEqual(await rotationOf(write(Buffer.concat([box('ftyp', zeros(8)), mdat64, box('moov', track({ rot: 270, codec: 'hvc1' }))]))), 270);
    assert.strictEqual(await rotationOf(write(Buffer.concat([box('ftyp', zeros(8)), Buffer.concat([u32(0), Buffer.from('free'), zeros(8)])]))), 0, 'size 0 box that is not moov');
    // Hostile: a size smaller than the header, larger than the file, a 64-bit size below 16, a huge moov.
    assert.strictEqual(await rotationOf(write(Buffer.concat([u32(4), Buffer.from('moov'), zeros(64)]))), 0);
    assert.strictEqual(await rotationOf(write(Buffer.concat([u32(0x7fffffff), Buffer.from('moov'), zeros(64)]))), 0);
    assert.strictEqual(await rotationOf(write(Buffer.concat([u32(1), Buffer.from('moov'), Buffer.from([0, 0, 0, 0, 0, 0, 0, 8]), zeros(16)]))), 0);
    assert.strictEqual(await rotationOf(write(Buffer.concat([u32(1), Buffer.from('moov'), zeros(3)]))), 0, 'truncated 64-bit header');
    // tkhd cut short (matrix would lie outside it).
    const shortTkhd = box('trak', box('tkhd', zeros(20)), box('mdia', mdhd(1000), hdlr('vide')));
    assert.strictEqual(await rotationOf(write(mp4(shortTkhd))), 0);
    // A trak without tkhd / a truncated trak inside moov.
    assert.strictEqual(await rotationOf(write(mp4(box('trak', box('mdia', hdlr('vide')))))), 0);
    const cut = mp4(track({ rot: 90, codec: 'hvc1' }));
    assert.strictEqual(await rotationOf(write(cut.subarray(0, cut.length - 40))), 0, 'file cut inside moov/mdat');

    console.log('mp4 synth: ok');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
})().catch((e) => { console.error(e); process.exit(1); });
