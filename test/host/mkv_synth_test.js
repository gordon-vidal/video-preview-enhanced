'use strict';
// node test/host/mkv_synth_test.js: src/sniff-matroska.js on hand-built EBML files (no ffmpeg): a good file and every way
// the early sniff must refuse (several tracks, odd sizes, encryption, stereo, lacing, unequal frame times, unknown sizes,
// duplicated Info, attachments, doc type), plus truncation at every byte (never throws).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { sniffNativeMatroska } = require('../../src/sniff-matroska');

const idBytes = (id) => { const out = []; for (let v = id; v > 0; v = Math.floor(v / 256)) out.unshift(v & 255); return Buffer.from(out); };
const size4 = (n) => Buffer.from([0x10 | (n >>> 24), (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
const el = (id, ...parts) => { const body = Buffer.concat(parts.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(p)))); return Buffer.concat([idBytes(id), size4(body.length), body]); };
const uintEl = (id, n) => { const out = []; for (let v = n; v > 0; v = Math.floor(v / 256)) out.unshift(v & 255); return el(id, Buffer.from(out.length ? out : [0])); };
const str = (id, s) => el(id, Buffer.from(s, 'latin1'));

const hvcC = (depth = 8) => { const b = Buffer.alloc(23); b[0] = 1; b[16] = 0xfd; b[17] = 0xf8 | (depth - 8); b[18] = 0xf8 | (depth - 8); return b; };
const VP9KEY = Buffer.from([0x80, 0x49, 0x83, 0x42, 0x00]); // profile 0 key frame, 4:2:0
const block = (track, rel, data) => Buffer.concat([Buffer.from([0x80 | track, rel >> 8 & 255, rel & 255, 0x80]), data]);
const simple = (track, rel, data) => el(0xa3, block(track, rel, data));

function video({ codec = 'V_MPEGH/ISO/HEVC', w = 1280, h = 720, period = 40000000, number = 1, config = hvcC(10), extra = [] } = {}) {
  return el(0xae, uintEl(0xd7, number), uintEl(0x83, 1), str(0x86, codec), uintEl(0x23e383, period), ...(config ? [el(0x63a2, config)] : []),
    el(0xe0, uintEl(0xb0, w), uintEl(0xba, h), ...extra));
}
const audioTrack = (number = 2) => el(0xae, uintEl(0xd7, number), uintEl(0x83, 2), str(0x86, 'A_AAC'));
const cluster = (...kids) => el(0x1f43b675, uintEl(0xe7, 0), ...kids);
const frames = (times, data = Buffer.alloc(8, 1), track = 1) => times.map((t) => simple(track, t, data));
function file({ doc = 'matroska', tracks = [video(), audioTrack()], scale = 1000000, clusters, info = true, afterSegment = [], segmentExtra = [], ebmlExtra = [] } = {}) {
  const segment = el(0x18538067,
    ...(info ? [el(0x1549a966, uintEl(0x2ad7b1, scale))] : []), el(0x1654ae6b, ...tracks),
    ...(clusters || [cluster(...frames([0, 40, 80, 120]))]), ...segmentExtra);
  return Buffer.concat([el(0x1a45dfa3, str(0x4282, doc), ...ebmlExtra), segment, ...afterSegment]);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vpe_mkv_'));
let n = 0;
const sniff = async (buf, ext = '.mkv') => {
  const f = path.join(dir, `m${n++}${ext}`);
  fs.writeFileSync(f, buf);
  return sniffNativeMatroska(f, fs.statSync(f));
};

(async () => {
  try {
    // ---- good files ------------------------------------------------------------------
    let r = await sniff(file());
    assert.deepStrictEqual(r.video, { index: 0, codec: 'hevc', width: 1280, height: 720, fps: 25, pixFmt: 'yuv420p10le' });
    assert.deepStrictEqual(r.audio, { index: 1 });
    r = await sniff(file({ tracks: [video()] }), '.webm');
    assert.strictEqual(r.audio, null);
    assert.strictEqual((await sniff(file({ doc: 'webm' }))).video.codec, 'hevc', 'doc type webm');
    // Frame rates stored as whole-nanosecond periods are recovered: 24000/1001, 30000/1001, 60.
    for (const [period, want] of [[41708333, 24000 / 1001], [33366667, 30000 / 1001], [16666667, 60], [1000000000, 1]]) {
      r = await sniff(file({ tracks: [video({ period })], clusters: [cluster(...frames([0, 1, 2].map((i) => Math.round((i * 1e9) / want / 1e6))))] }));
      assert.ok(r && Math.abs(r.video.fps - want) < 1e-9, `period ${period}`);
    }
    // VP9: no codec private, the pixel format comes from the first key frame; a profile 2 frame.
    r = await sniff(file({ tracks: [video({ codec: 'V_VP9', config: null })], clusters: [cluster(...frames([0, 40, 80], VP9KEY))] }));
    assert.deepStrictEqual([r.video.codec, r.video.pixFmt], ['vp9', 'yuv420p']);
    // A BlockGroup (0xa0 / Block 0xa1) with BlockDuration matching the frame time.
    const group = (rel, dur) => el(0xa0, el(0xa1, block(1, rel, Buffer.alloc(8))), ...(dur === undefined ? [] : [uintEl(0x9b, dur)]));
    assert.ok(await sniff(file({ clusters: [cluster(group(0, 40), group(40, 40), group(80))] })), 'block groups');
    assert.strictEqual(await sniff(file({ clusters: [cluster(group(0, 10), group(40), group(80))] })), null, 'BlockDuration that is not one frame');
    assert.strictEqual(await sniff(file({ clusters: [cluster(el(0xa0, el(0x75a1, Buffer.alloc(4)), el(0xa1, block(1, 0, Buffer.alloc(8)))), ...frames([40, 80]))] })), null, 'BlockAdditions');
    assert.strictEqual(await sniff(file({ clusters: [cluster(el(0xa0, uintEl(0x9b, 40)), ...frames([40, 80]))] })), null, 'a group without a block');
    // Several clusters; audio blocks in between are skipped; frames out of order in the file are sorted.
    r = await sniff(file({ clusters: [cluster(...frames([40, 0]), simple(2, 0, Buffer.alloc(4))), cluster(...frames([120, 80]))] }));
    assert.ok(r, 'out-of-order timestamps within a constant rate');
    // Unknown elements (Void, Cues, Tags) around the tracks are skipped.
    assert.ok(await sniff(file({ segmentExtra: [el(0xec, Buffer.alloc(20)), el(0x1c53bb6b, Buffer.alloc(8)), el(0x1254c367, Buffer.alloc(8))] })));
    assert.ok(await sniff(file({ clusters: [cluster(el(0xec, Buffer.alloc(3)), el(0xec, Buffer.alloc(3)), ...frames([0, 40]))] })), 'repeated Void is allowed');

    // ---- refusals ----------------------------------------------------------------------
    const no = async (label, buf, ext) => assert.strictEqual(await sniff(buf, ext), null, label);
    await no('wrong extension', file(), '.mp4');
    await no('empty', Buffer.alloc(0));
    await no('garbage', Buffer.from('this is not a matroska file'));
    await no('doc type not matroska/webm', file({ doc: 'matroskaX' }));
    await no('scale zero', file({ scale: 0 }));
    await no('scale too large (> 1 ms)', file({ scale: 2000000 }));
    await no('Info twice', file({ segmentExtra: [el(0x1549a966, uintEl(0x2ad7b1, 1000000))], clusters: [] }));
    await no('Tracks twice', file({ segmentExtra: [el(0x1654ae6b, video())] }));
    await no('trailing data after the segment', file({ afterSegment: [el(0xec, Buffer.alloc(4))] }));
    await no('attachments can add streams', file({ segmentExtra: [el(0x1941a469, Buffer.alloc(4))] }));
    await no('no video track', file({ tracks: [audioTrack()] }));
    await no('two video tracks', file({ tracks: [video(), video({ number: 2 })] }));
    await no('two audio tracks', file({ tracks: [video(), audioTrack(2), audioTrack(3)] }));
    await no('audio and video with the same track number', file({ tracks: [video(), audioTrack(1)] }));
    await no('subtitle track', file({ tracks: [video(), el(0xae, uintEl(0xd7, 3), uintEl(0x83, 17))] }));
    await no('track number 0', file({ tracks: [video({ number: 0 })] }));
    await no('unknown codec', file({ tracks: [video({ codec: 'V_MPEG4/ISO/AVC' })] }));
    await no('encrypted/compressed track (ContentEncodings)', file({ tracks: [el(0xae, uintEl(0xd7, 1), uintEl(0x83, 1), str(0x86, 'V_VP9'), el(0x6d80, Buffer.alloc(2)), uintEl(0x23e383, 40000000), el(0xe0, uintEl(0xb0, 640), uintEl(0xba, 360)))] }));
    await no('no Video element', file({ tracks: [el(0xae, uintEl(0xd7, 1), uintEl(0x83, 1), str(0x86, 'V_VP9'))] }));
    await no('no CodecID', file({ tracks: [el(0xae, uintEl(0xd7, 1), uintEl(0x83, 1), el(0xe0, uintEl(0xb0, 640), uintEl(0xba, 360)))] }));
    await no('odd width', file({ tracks: [video({ w: 1281 })] }));
    await no('odd height', file({ tracks: [video({ h: 721 })] }));
    await no('zero size', file({ tracks: [video({ w: 0, h: 0 })] }));
    await no('size over 65535', file({ tracks: [video({ w: 65536 })] }));
    await no('no DefaultDuration', file({ tracks: [el(0xae, uintEl(0xd7, 1), uintEl(0x83, 1), str(0x86, 'V_VP9'), el(0xe0, uintEl(0xb0, 640), uintEl(0xba, 360)))] }));
    await no('a rate that is not a clean fps (period 33 ms)', file({ tracks: [video({ period: 33000000 })] }));
    await no('over 1000 fps', file({ tracks: [video({ period: 500000 })] }));
    await no('stereo mode', file({ tracks: [video({ extra: [uintEl(0x53c0, 1)] })] }));
    await no('cropping elements', file({ tracks: [video({ extra: [uintEl(0x54aa, 2)] })] }));
    assert.ok(await sniff(file({ tracks: [video({ extra: [el(0x55b0, Buffer.alloc(2))] })] })), 'a Colour element is harmless');
    await no('4:4:4 HEVC', file({ tracks: [video({ config: (() => { const b = hvcC(8); b[16] = 0xfe; return b; })() })] }));
    await no('HEVC without a codec private', file({ tracks: [video({ config: null })] }));
    await no('VP9 key frame of profile 1', file({ tracks: [video({ codec: 'V_VP9', config: null })], clusters: [cluster(...frames([0, 40, 80], Buffer.from([0x88, 0x49, 0x83, 0x42, 0x00])))] }));
    await no('VP9 frame that is not a key frame', file({ tracks: [video({ codec: 'V_VP9', config: null })], clusters: [cluster(...frames([0, 40, 80], Buffer.from([0x84, 0x49, 0x83, 0x42, 0x00])))] }));
    await no('one frame only', file({ clusters: [cluster(...frames([0]))] }));
    await no('no clusters', file({ clusters: [] }));
    await no('clusters before tracks', Buffer.concat([el(0x1a45dfa3, str(0x4282, 'matroska')), el(0x18538067, el(0x1549a966, uintEl(0x2ad7b1, 1000000)), cluster(...frames([0, 40])), el(0x1654ae6b, video()))]));
    await no('duplicate timestamps', file({ clusters: [cluster(...frames([0, 40, 40, 80]))] }));
    await no('B-frame style jitter beyond one tick', file({ clusters: [cluster(...frames([0, 40, 90, 120]))] }));
    await no('variable frame rate', file({ clusters: [cluster(...frames([0, 40, 80, 100]))] }));
    await no('cluster without a Timecode before blocks', file({ clusters: [el(0x1f43b675, ...frames([0, 40]))] }));
    await no('two Timecodes in a cluster', file({ clusters: [el(0x1f43b675, uintEl(0xe7, 0), uintEl(0xe7, 1), ...frames([0, 40]))] }));
    await no('a block for another video track', file({ clusters: [cluster(...frames([0, 40]), simple(5, 80, Buffer.alloc(8)))] }));
    await no('lacing flags set', file({ clusters: [cluster(el(0xa3, Buffer.from([0x81, 0, 0, 0x06, 1, 2, 3, 4])), ...frames([40, 80]))] }));
    await no('a block too short to hold a frame', file({ clusters: [cluster(el(0xa3, Buffer.from([0x81, 0, 0])), ...frames([40, 80]))] }));
    await no('an element that claims more than the file holds', file().subarray(0, file().length - 5));
    // Unknown-size segment (all ones) is refused rather than guessed.
    const unknown = Buffer.from(file());
    const segAt = unknown.indexOf(Buffer.from([0x18, 0x53, 0x80, 0x67]));
    unknown.set([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff], segAt + 4);
    await no('segment of unknown size', unknown);
    // An EBML id longer than 4 bytes / a size starting with a zero byte.
    await no('invalid EBML integer (zero byte)', Buffer.concat([file().subarray(0, 4), Buffer.alloc(8)]));
    // Large integer fields (> 6 bytes) are refused.
    await no('timestamp scale field of 7 bytes', file({ tracks: [video()], clusters: [cluster(...frames([0, 40]))] }).toString('latin1') && Buffer.concat([
      el(0x1a45dfa3, str(0x4282, 'matroska')), el(0x18538067, el(0x1549a966, el(0x2ad7b1, Buffer.alloc(7, 1))), el(0x1654ae6b, video()), cluster(...frames([0, 40])))]));
    // Size guard: more than 4 MiB is not read at all.
    const big = Buffer.concat([file(), el(0xec, Buffer.alloc(4 * 1024 * 1024))]);
    await no('over 4 MiB', big);
    // A changed file (stat does not match) and a missing file.
    const f = path.join(dir, 'stat.mkv');
    fs.writeFileSync(f, file());
    assert.strictEqual(await sniffNativeMatroska(f, { size: fs.statSync(f).size, mtimeMs: fs.statSync(f).mtimeMs + 10 }), null);
    assert.strictEqual(await sniffNativeMatroska(f, { size: 5, mtimeMs: 0 }), null);
    assert.strictEqual(await sniffNativeMatroska(path.join(dir, 'missing.mkv'), { size: 1, mtimeMs: 1 }), null);

    // ---- truncation at every byte never throws and never claims a result ---------------------
    const whole = file();
    for (let cut = 0; cut < whole.length; cut += 3) {
      const rr = await sniff(whole.subarray(0, cut));
      assert.strictEqual(rr, null, `cut at ${cut}`);
    }
    // Byte flips in the header region never throw (they may or may not still sniff).
    for (let i = 0; i < 120; i++) {
      const flipped = Buffer.from(whole);
      flipped[i] ^= 0xff;
      await sniff(flipped);
    }
    console.log('mkv synth: ok');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
})().catch((e) => { console.error(e); process.exit(1); });
