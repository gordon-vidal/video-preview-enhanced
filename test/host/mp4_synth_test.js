'use strict';
// node test/host/mp4_synth_test.js: src/rotation.js (rotationOf, sniffNativeMp4) and src/sniff-codecs.js on
// hand-built MP4 files, so no ffmpeg is needed: every rotation, 64-bit and v1 headers, fragmented files,
// B-frame (ctts) timing, truncated and hostile boxes, odd sizes and pixel formats.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { rotationOf, sniffNativeMp4 } = require('../../src/rotation');
const codecs = require('../../src/sniff-codecs');

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
const sniff = async (buf, ext) => { const f = write(buf, ext); return sniffNativeMp4(f, fs.statSync(f)); };

(async () => {
  try {
    // ---- rotationOf ---------------------------------------------------------------
    for (const deg of [0, 90, 180, 270]) {
      assert.strictEqual(rotationOf(write(mp4(track({ rot: deg, codec: 'hvc1' })))), deg, `${deg} degrees`);
      assert.strictEqual(rotationOf(write(mp4(track({ rot: deg, codec: 'hvc1', v1: true })))), deg, `${deg} degrees, 64-bit tkhd`);
    }
    assert.strictEqual(rotationOf(write(mp4(track({ rot: 270, codec: 'hvc1' })), '.MOV')), 270, 'extension is case-insensitive');
    assert.strictEqual(rotationOf(write(mp4(track({ rot: 90, codec: 'hvc1' })), '.mkv')), 0, 'not an MP4 extension');
    assert.strictEqual(rotationOf(write(mp4(track({ rot: 90, codec: 'hvc1' })), '')), 0);
    assert.strictEqual(rotationOf(path.join(dir, 'missing.mp4')), 0, 'missing file');
    assert.strictEqual(rotationOf(write(Buffer.alloc(0))), 0, 'empty file');
    assert.strictEqual(rotationOf(write(Buffer.from('not an mp4 at all, just text'))), 0);
    // An audio track first, rotated video second: the video track decides.
    assert.strictEqual(rotationOf(write(mp4(track({ kind: 'soun', rot: 180 }), track({ rot: 90, codec: 'hvc1' })))), 90);
    // Audio only: no video track, no rotation.
    assert.strictEqual(rotationOf(write(mp4(track({ kind: 'soun', rot: 90 })))), 0);
    // A matrix that is not a multiple of 90 is rounded to the nearest quarter turn.
    assert.strictEqual(rotationOf(write(mp4(track({ rot: 80, codec: 'hvc1' })))), 90);
    assert.strictEqual(rotationOf(write(mp4(track({ rot: 44, codec: 'hvc1' })))), 0);
    // moov after mdat (the usual non-faststart layout).
    const late = Buffer.concat([box('ftyp', Buffer.from('isom', 'latin1'), zeros(8)), box('mdat', zeros(4096)), box('moov', track({ rot: 90, codec: 'hvc1' }))]);
    assert.strictEqual(rotationOf(write(late)), 90);
    // 64-bit mdat size (size field 1) before moov, and size 0 (to end of file) for the last box.
    const mdat64 = Buffer.concat([u32(1), Buffer.from('mdat'), Buffer.from([0, 0, 0, 0, 0, 0, 0, 16 + 8]), zeros(8)]);
    assert.strictEqual(rotationOf(write(Buffer.concat([box('ftyp', zeros(8)), mdat64, box('moov', track({ rot: 270, codec: 'hvc1' }))]))), 270);
    assert.strictEqual(rotationOf(write(Buffer.concat([box('ftyp', zeros(8)), Buffer.concat([u32(0), Buffer.from('free'), zeros(8)])]))), 0, 'size 0 box that is not moov');
    // Hostile: a size smaller than the header, larger than the file, a 64-bit size below 16, a huge moov.
    assert.strictEqual(rotationOf(write(Buffer.concat([u32(4), Buffer.from('moov'), zeros(64)]))), 0);
    assert.strictEqual(rotationOf(write(Buffer.concat([u32(0x7fffffff), Buffer.from('moov'), zeros(64)]))), 0);
    assert.strictEqual(rotationOf(write(Buffer.concat([u32(1), Buffer.from('moov'), Buffer.from([0, 0, 0, 0, 0, 0, 0, 8]), zeros(16)]))), 0);
    assert.strictEqual(rotationOf(write(Buffer.concat([u32(1), Buffer.from('moov'), zeros(3)]))), 0, 'truncated 64-bit header');
    // tkhd cut short (matrix would lie outside it).
    const shortTkhd = box('trak', box('tkhd', zeros(20)), box('mdia', mdhd(1000), hdlr('vide')));
    assert.strictEqual(rotationOf(write(mp4(shortTkhd))), 0);
    // A trak without tkhd / a truncated trak inside moov.
    assert.strictEqual(rotationOf(write(mp4(box('trak', box('mdia', hdlr('vide')))))), 0);
    const cut = mp4(track({ rot: 90, codec: 'hvc1' }));
    assert.strictEqual(rotationOf(write(cut.subarray(0, cut.length - 40))), 0, 'file cut inside moov/mdat');

    // ---- sniffNativeMp4 -----------------------------------------------------------
    const good = await sniff(mp4(track({ codec: 'hvc1', c: hvcC(10), fps: 25, scale: 25000 })));
    assert.deepStrictEqual(good.video, { index: 0, codec: 'hevc', width: 1280, height: 720, fps: 25, pixFmt: 'yuv420p10le' });
    assert.strictEqual(good.audio, null);
    const withAudio = await sniff(mp4(track({ kind: 'soun' }), track({ codec: 'hev1', c: hvcC(8) })));
    assert.strictEqual(withAudio.video.index, 1);
    assert.deepStrictEqual(withAudio.audio, { index: 0 });
    assert.strictEqual(withAudio.video.pixFmt, 'yuv420p');
    // 12-bit, VP9, AV1 and H.264 entries.
    assert.strictEqual((await sniff(mp4(track({ codec: 'hvc1', c: hvcC(12) })))).video.pixFmt, 'yuv420p12le');
    assert.strictEqual((await sniff(mp4(track({ codec: 'avc1', c: avcC(122, 2, 10) })))).video.pixFmt, 'yuv422p10le');
    assert.strictEqual((await sniff(mp4(track({ codec: 'avc1', c: avcC(100, 2, 8) })))).video.codec, 'h264');
    for (const prores of ['apco', 'apcs', 'apcn', 'apch']) assert.strictEqual((await sniff(mp4(track({ codec: prores })))).video.pixFmt, 'yuv422p10le', prores);
    // Unknown / 4444 ProRes / plain 8-bit H.264 (no pixfmt can be decided) are not sniffed.
    assert.strictEqual(await sniff(mp4(track({ codec: 'ap4h' }))), null);
    assert.strictEqual(await sniff(mp4(track({ codec: 'avc1', c: avcC(66, 1, 8) }))), null, 'baseline H.264: ffprobe decides');
    assert.strictEqual(await sniff(mp4(track({ codec: 'hvc1', c: hvcC(9) }))), null, '9-bit HEVC does not exist');
    assert.strictEqual(await sniff(mp4(track({ codec: 'hvc1', c: hvcC(10, { chroma: 3 }) }))), null, 'HEVC 4:4:4');
    assert.strictEqual(await sniff(mp4(track({ codec: 'hvc1', c: hvcC(10, { ver: 2 }) }))), null);
    assert.strictEqual(await sniff(mp4(track({ codec: 'hvc1', c: box('free', zeros(4)) }))), null, 'no config box');
    // Extension and stat guards.
    const f = write(mp4(track({ codec: 'hvc1' })));
    assert.strictEqual(await sniffNativeMp4(f, { size: fs.statSync(f).size + 1, mtimeMs: fs.statSync(f).mtimeMs }), null, 'size changed');
    assert.strictEqual(await sniffNativeMp4(f, { size: fs.statSync(f).size, mtimeMs: fs.statSync(f).mtimeMs + 5 }), null, 'mtime changed');
    assert.strictEqual(await sniff(mp4(track({ codec: 'hvc1' })), '.mkv'), null);
    assert.strictEqual(await sniffNativeMp4(path.join(dir, 'missing.mp4'), { size: 1, mtimeMs: 1 }), null);
    assert.strictEqual(await sniff(Buffer.alloc(0)), null);
    assert.strictEqual(await sniff(Buffer.from('garbage garbage garbage garbage')), null);
    // Structure: fragmented (mvex), no / three tracks, two video tracks, two sample entries.
    assert.strictEqual(await sniff(mp4(track({ codec: 'hvc1' }), box('mvex', box('trex', zeros(24))))), null, 'fragmented: later fragments may change the rate');
    assert.strictEqual(await sniff(mp4()), null, 'no tracks');
    assert.strictEqual(await sniff(mp4(track({ kind: 'soun' }), track({ kind: 'soun' }), track({ codec: 'hvc1' }))), null, 'three tracks');
    assert.strictEqual(await sniff(mp4(track({ codec: 'hvc1' }), track({ codec: 'hvc1' }))), null, 'two video tracks');
    assert.strictEqual(await sniff(mp4(track({ kind: 'subt' }))), null, 'text track only');
    assert.strictEqual(await sniff(mp4(track({ kind: 'soun' }))), null, 'audio only: no video');
    assert.strictEqual(await sniff(mp4(track({ codec: 'hvc1', stsdCount: 2 }))), null, 'two sample entries');
    // Timing: variable (two stts runs), zero count, huge fps, v1 mdhd, wrong mdhd version.
    const stts2 = box('stts', zeros(4), u32(2), u32(10), u32(1000), u32(10), u32(1001));
    assert.strictEqual(await sniff(mp4(track({ codec: 'hvc1', sttsBox: stts2 }))), null, 'VFR (several stts runs)');
    assert.strictEqual(await sniff(mp4(track({ codec: 'hvc1', count: 0 }))), null, 'no samples');
    assert.strictEqual(await sniff(mp4(track({ codec: 'hvc1', sttsBox: stts(10, 0) }))), null, 'zero sample delta (fps = Infinity)');
    assert.strictEqual(await sniff(mp4(track({ codec: 'hvc1', fps: 5000, scale: 5000 * 1000 }))), null, 'fps over 1000');
    assert.strictEqual(await sniff(mp4(track({ codec: 'hvc1', mdhdBox: mdhd(0) }))), null, 'zero timescale');
    const v1 = await sniff(mp4(track({ codec: 'hvc1', mdhdBox: mdhd(60000, true), fps: 60, scale: 60000 })));
    assert.ok(v1 && v1.video.fps === 60, '64-bit mdhd');
    const v2 = box('mdhd', Buffer.from([2, 0, 0, 0]), zeros(24));
    assert.strictEqual(await sniff(mp4(track({ codec: 'hvc1', mdhdBox: v2 }))), null, 'unknown mdhd version');
    // Sizes: odd and tiny and zero.
    assert.strictEqual(await sniff(mp4(track({ codec: 'hvc1', w: 1281 }))), null, 'odd width');
    assert.strictEqual(await sniff(mp4(track({ codec: 'hvc1', h: 721 }))), null, 'odd height');
    assert.strictEqual(await sniff(mp4(track({ codec: 'hvc1', w: 0, h: 0 }))), null, 'zero size');
    assert.strictEqual(await sniff(mp4(track({ codec: 'hvc1', w: 1, h: 1 }))), null, 'one pixel');
    assert.ok(await sniff(mp4(track({ codec: 'hvc1', w: 2, h: 2 }))), '2x2 is fine');
    assert.ok(await sniff(mp4(track({ codec: 'hvc1', w: 65534, h: 65534 }))), 'the largest even size');
    // ctts: B-frame reordering that is a permutation of one-per-frame is fine, anything else is not.
    const cnt = 8;
    const none = await sniff(mp4(track({ codec: 'hvc1', count: cnt, scale: 30000, fps: 30, cttsBox: ctts(0, [[cnt, 0]]) })));
    assert.ok(none, 'ctts with all-zero offsets');
    const shifted = await sniff(mp4(track({ codec: 'hvc1', count: cnt, cttsBox: ctts(0, [[cnt, 3000]]) })));
    assert.ok(shifted, 'a constant offset is still one frame per tick');
    assert.strictEqual(await sniff(mp4(track({ codec: 'hvc1', count: cnt, cttsBox: ctts(0, [[cnt / 2, 0], [cnt / 2, 500]]) }))), null, 'offset not a multiple of the delta');
    assert.strictEqual(await sniff(mp4(track({ codec: 'hvc1', count: 4, cttsBox: ctts(1, [[1, 0], [2, -1000], [1, 0]]) }))), null, 'two samples with the same presentation time');
    assert.ok(await sniff(mp4(track({ codec: 'hvc1', count: 6, cttsBox: ctts(1, [[2, 0], [2, 2000], [2, -2000]]) }))), 'reordered but one frame per tick (version 1, negative offset)');
    assert.strictEqual(await sniff(mp4(track({ codec: 'hvc1', count: cnt, cttsBox: ctts(0, [[cnt - 1, 0]]) }))), null, 'runs do not add up to the frame count');
    assert.strictEqual(await sniff(mp4(track({ codec: 'hvc1', count: cnt, cttsBox: ctts(0, [[cnt + 1, 0]]) }))), null, 'runs exceed the frame count');
    assert.strictEqual(await sniff(mp4(track({ codec: 'hvc1', count: cnt, cttsBox: ctts(0, [[0, 0], [cnt, 0]]) }))), null, 'a zero-length run');
    assert.strictEqual(await sniff(mp4(track({ codec: 'hvc1', count: cnt, cttsBox: ctts(2, [[cnt, 0]]) }))), null, 'unknown ctts version');
    assert.strictEqual(await sniff(mp4(track({ codec: 'hvc1', count: 40000, cttsBox: ctts(0, [[40000, 0]]) }))), null, 'ctts over 32768 frames is not checked');
    // ctts runs that claim more entries than the box holds.
    const lying = box('ctts', zeros(4), u32(1000), u32(cnt), u32(0));
    assert.strictEqual(await sniff(mp4(track({ codec: 'hvc1', count: cnt, cttsBox: lying }))), null, 'entry count larger than the box');
    // Truncated moov (stsd/stts cut) never throws.
    const whole = mp4(track({ codec: 'hvc1' }));
    for (const cutAt of [20, 60, 100, 160, 200, whole.length - 30]) assert.strictEqual(await sniff(whole.subarray(0, cutAt)), null, `cut at ${cutAt}`);

    // ---- sniff-codecs on its own: short and hostile config records ----------------
    const { hevcFormat, av1Format, h264Format, vp9Format, pixelFormat } = codecs;
    assert.strictEqual(pixelFormat(420, 8), 'yuv420p');
    assert.strictEqual(pixelFormat(422, 10), 'yuv422p10le');
    for (const fn of [hevcFormat, av1Format, h264Format, vp9Format]) {
      assert.strictEqual(fn(Buffer.alloc(0)), null, `${fn.name}: empty`);
      assert.strictEqual(fn(Buffer.alloc(3)), null, `${fn.name}: tiny`);
      assert.strictEqual(fn(Buffer.alloc(64, 0xff)), null, `${fn.name}: all ones`);
      assert.strictEqual(fn(Buffer.alloc(64)), null, `${fn.name}: all zeros`);
    }
    // AV1: main profile, 4:2:0 flags, high bitdepth bit; monochrome / profile 1 / 4:4:4 rejected.
    assert.strictEqual(av1Format(Buffer.from([0x81, 0x00, 0x0c, 0])), 'yuv420p');
    assert.strictEqual(av1Format(Buffer.from([0x81, 0x00, 0x4c, 0])), 'yuv420p10le');
    assert.strictEqual(av1Format(Buffer.from([0x81, 0x00, 0x1c, 0])), null, 'monochrome flag set');
    assert.strictEqual(av1Format(Buffer.from([0x81, 0x20, 0x0c, 0])), null, 'profile 1');
    assert.strictEqual(av1Format(Buffer.from([0x81, 0x00, 0x00, 0])), null, '4:4:4');
    assert.strictEqual(av1Format(Buffer.from([0x01, 0x00, 0x0c, 0])), null, 'marker bit missing');
    // VP9 vpcC: 12 bytes, version 1, profile 0 8-bit and profile 2 10/12-bit are 4:2:0.
    const vpc = (profile, depth, chroma = 1) => { const b = Buffer.alloc(12); b.writeUInt32BE(0x01000000, 0); b[4] = profile; b[6] = (depth << 4) | (chroma << 1); return b; };
    assert.strictEqual(vp9Format(vpc(0, 8)), 'yuv420p');
    assert.strictEqual(vp9Format(vpc(2, 10)), 'yuv420p10le');
    assert.strictEqual(vp9Format(vpc(2, 12)), 'yuv420p12le');
    assert.strictEqual(vp9Format(vpc(1, 8)), null, 'profile 1 is 4:4:4 / 4:2:2');
    assert.strictEqual(vp9Format(vpc(0, 10)), null, 'profile 0 with 10 bit');
    assert.strictEqual(vp9Format(vpc(0, 8, 2)), null, 'chroma 4:4:0');
    assert.strictEqual(vp9Format(Buffer.concat([vpc(0, 8), zeros(1)])), null, 'wrong length');
    // H.264 high profiles: 4:2:2 8/10-bit and 4:2:0 10-bit, a truncated SPS list, zero-length NALs, bad reserved bits.
    const ok264 = avcC(110, 1, 10).subarray(8);
    assert.strictEqual(h264Format(ok264), 'yuv420p10le');
    assert.strictEqual(h264Format(avcC(122, 2, 8).subarray(8)), 'yuv422p');
    assert.strictEqual(h264Format(avcC(100, 1, 8).subarray(8)), null, '4:2:0 8-bit is plain H.264: no sniff');
    assert.strictEqual(h264Format(avcC(244, 3, 10).subarray(8)), null, 'profile 244');
    assert.strictEqual(h264Format(ok264.subarray(0, ok264.length - 1)), null, 'extension cut short');
    assert.strictEqual(h264Format(ok264.subarray(0, 9)), null, 'SPS cut short');
    const noSps = Buffer.from(ok264); noSps[5] = 0xe0;
    assert.strictEqual(h264Format(noSps), null, 'zero SPS entries');
    const zeroLen = Buffer.from(ok264); zeroLen.writeUInt16BE(0, 6);
    assert.strictEqual(h264Format(zeroLen), null, 'zero-length SPS');
    const badRes = Buffer.from(ok264); badRes[badRes.length - 4] = 0;
    assert.strictEqual(h264Format(badRes), null, 'reserved bits not set');
    const mismatch = Buffer.from(ok264); mismatch[mismatch.length - 2] ^= 1;
    assert.strictEqual(h264Format(mismatch), null, 'luma and chroma depth differ');
    // HEVC: wrong version, wrong chroma, differing luma/chroma depth.
    const hv = (depth, mod) => { const b = hvcC(depth).subarray(8); if (mod) mod(b); return b; };
    assert.strictEqual(hevcFormat(hv(10)), 'yuv420p10le');
    assert.strictEqual(hevcFormat(hv(10, (b) => { b[18] = 0xf8; })), null, 'chroma depth differs');
    assert.strictEqual(hevcFormat(hv(8, (b) => { b[16] = 0xfc | 2; })), null, '4:2:2');
    assert.strictEqual(hevcFormat(hv(8, (b) => { b[17] = 0xff; b[18] = 0xff; })), null, '15 bit');
    console.log('mp4 synth: ok');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
})().catch((e) => { console.error(e); process.exit(1); });
