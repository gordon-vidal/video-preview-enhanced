'use strict';
// node test/host/avi_synth_test.js: src/avi.js on hand-built AVI files (no ffmpeg, no sample files):
// MJPEG with PCM sound, drop frames, OpenDML (RIFF AVIX), rec lists, odd chunk sizes, a crashed recorder's
// truncated file, non-MJPEG movi skipped, hostile sizes, the JPEG Huffman table fix, and the WAV readers.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const avi = require('../../src/avi');

const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const chunk = (id, data, declared) => {
  const d = Buffer.from(data);
  return Buffer.concat([Buffer.from(id, 'latin1'), u32(declared === undefined ? d.length : declared), d, d.length & 1 ? Buffer.alloc(1) : Buffer.alloc(0)]);
};
const list = (type, ...kids) => { const body = Buffer.concat([Buffer.from(type, 'latin1'), ...kids]); return chunk('LIST', body); };
const riff = (type, ...kids) => chunk('RIFF', Buffer.concat([Buffer.from(type, 'latin1'), ...kids]));

const avih = (w, h, usPerFrame) => {
  const b = Buffer.alloc(56);
  b.writeUInt32LE(usPerFrame, 0); b.writeUInt32LE(w, 32); b.writeUInt32LE(h, 36);
  return chunk('avih', b);
};
const strh = (type, handler, scale, rate) => {
  const b = Buffer.alloc(56);
  b.write(type, 0, 'latin1'); b.write(handler, 4, 'latin1'); b.writeUInt32LE(scale, 20); b.writeUInt32LE(rate, 24);
  return chunk('strh', b);
};
const strfV = (w, h, comp) => {
  const b = Buffer.alloc(40);
  b.writeUInt32LE(40, 0); b.writeInt32LE(w, 4); b.writeInt32LE(h, 8); b.write(comp, 16, 'latin1');
  return chunk('strf', b);
};
const strfA = (ch, rate, bits, tag = 1) => {
  const b = Buffer.alloc(16);
  b.writeUInt16LE(tag, 0); b.writeUInt16LE(ch, 2); b.writeUInt32LE(rate, 4); b.writeUInt32LE((rate * ch * bits) / 8, 8); b.writeUInt16LE((ch * bits) / 8, 12); b.writeUInt16LE(bits, 14);
  return chunk('strf', b);
};
const hdrl = (...strls) => list('hdrl', avih(640, 480, 40000), ...strls.map((s) => list('strl', ...s)));
const VIDEO = (comp = 'MJPG', handler = 'MJPG', h = 480) => [strh('vids', handler, 1, 25), strfV(640, h, comp)];
const AUDIO = [strh('auds', '\0\0\0\0', 1, 8000), strfA(1, 8000, 8)];

const jpegNoDht = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x04, 0x01, 0x02, 0xff, 0xda, 0x00, 0x02, 0x11, 0x22, 0xff, 0xd9]);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vpe_avi_'));
let n = 0;
const write = (buf) => { const f = path.join(dir, `a${n++}.avi`); fs.writeFileSync(f, buf); return f; };

(async () => {
  try {
    // ---- a normal MJPEG file with PCM sound -----------------------------------------
    const f1 = write(riff('AVI ', hdrl(VIDEO(), AUDIO), list('movi',
      chunk('00dc', jpegNoDht), chunk('01wb', Buffer.alloc(100, 1)), chunk('00dc', Buffer.alloc(0)), chunk('00dc', jpegNoDht.subarray(0, 11)),
      chunk('01wb', Buffer.alloc(50, 2)), chunk('junk', Buffer.alloc(8)), chunk('07dc', Buffer.alloc(8)))));
    const a = await avi.parseAvi(f1);
    assert.strictEqual(a.width, 640);
    assert.strictEqual(a.height, 480);
    assert.strictEqual(a.fps, 25);
    assert.ok(a.isMjpeg);
    assert.strictEqual(a.compression, 'MJPG');
    assert.strictEqual(a.frames.length, 3, 'three video chunks, the stream-7 chunk is ignored');
    assert.strictEqual(a.frames[1], a.frames[0], 'a zero-size chunk repeats the previous frame (drop frame)');
    assert.ok(a.audio.pcm && a.audio.channels === 1 && a.audio.sampleRate === 8000 && a.audio.chunks.length === 2);
    const wav = await avi.readPcmAsWav(f1, a.audio);
    assert.strictEqual(wav.length, 44 + 150);
    assert.strictEqual(wav.toString('latin1', 0, 4), 'RIFF');
    assert.strictEqual(wav.readUInt32LE(40), 150);
    assert.strictEqual(wav[44], 1);
    assert.strictEqual(wav[44 + 100], 2);
    for (const size of [1, 7, 44, 45, 100, 1 << 20]) {
      const parts = [];
      for await (const p of avi.pcmWavParts(f1, a.audio, size)) parts.push(Buffer.from(p));
      assert.ok(Buffer.concat(parts).equals(wav), `parts of ${size} bytes join to the WAV`);
      assert.ok(size < 64 || parts.every((p) => p.length <= size), `parts of ${size} stay within size`);
    }
    // A frame's bytes can be read back and fixed.
    const first = a.frames[0];
    const raw = fs.readFileSync(f1).subarray(first.offset, first.offset + first.size);
    assert.ok(raw.equals(jpegNoDht));

    // Sound with no samples: a WAV with only the header.
    const empty = { channels: 1, sampleRate: 8000, byteRate: 8000, blockAlign: 1, bits: 8, chunks: [] };
    assert.strictEqual((await avi.readPcmAsWav(f1, empty)).length, 44);
    const eparts = [];
    for await (const p of avi.pcmWavParts(f1, empty, 1000)) eparts.push(p);
    assert.strictEqual(eparts.length, 1);
    assert.strictEqual(eparts[0].length, 44);

    // ---- truncated sound: reading past the file end gives silence, not garbage or a throw ----
    const cut = { ...empty, chunks: [{ offset: fs.statSync(f1).size - 10, size: 40 }] };
    const wcut = await avi.readPcmAsWav(f1, cut);
    assert.strictEqual(wcut.length, 44 + 40);
    const pcut = [];
    for await (const p of avi.pcmWavParts(f1, cut, 16)) pcut.push(Buffer.from(p));
    const joined = Buffer.concat(pcut);
    assert.strictEqual(joined.length, 84);
    assert.ok(joined.subarray(44 + 10).every((x) => x === 0), 'the missing tail of the last chunk is zero');

    // ---- an odd-size chunk is padded; rec lists nest ---------------------------------
    const f2 = write(riff('AVI ', hdrl(VIDEO(), AUDIO), list('movi',
      chunk('00dc', Buffer.alloc(5, 9)), list('rec ', chunk('00dc', Buffer.alloc(7, 8)), chunk('01wb', Buffer.alloc(3, 1))), chunk('00dc', Buffer.alloc(2, 7)))));
    const b2 = await avi.parseAvi(f2);
    assert.deepStrictEqual(b2.frames.map((x) => x.size), [5, 7, 2]);
    assert.strictEqual(b2.audio.chunks.length, 1);

    // ---- OpenDML: a second RIFF AVIX with more chunks, plus an odml list ---------------
    const f3 = write(Buffer.concat([
      riff('AVI ', list('hdrl', avih(320, 240, 33333), list('strl', ...VIDEO('MJPG', 'MJPG', -240)), list('odml', chunk('dmlh', Buffer.alloc(248)))), list('movi', chunk('00dc', Buffer.alloc(4, 1)))),
      riff('AVIX', list('movi', chunk('00dc', Buffer.alloc(6, 2)), chunk('00dc', Buffer.alloc(8, 3)))),
    ]));
    const b3 = await avi.parseAvi(f3);
    assert.strictEqual(b3.frames.length, 3, 'chunks of every RIFF segment');
    assert.strictEqual(b3.height, 240, 'a top-down bitmap (negative height) is still positive');
    assert.ok(Math.abs(b3.fps - 25) < 1e-9);

    // ---- not MJPEG: movi is skipped, but headers still read; fps falls back to avih ------
    const f4 = write(riff('AVI ', list('hdrl', avih(1920, 1080, 20000), list('strl', strh('vids', 'H264', 0, 0), strfV(1920, 1080, 'H264'))), list('movi', chunk('00dc', Buffer.alloc(30)))));
    const b4 = await avi.parseAvi(f4);
    assert.ok(!b4.isMjpeg);
    assert.strictEqual(b4.frames.length, 0);
    assert.strictEqual(b4.fps, 50, '1e6 / usPerFrame when the stream has no scale/rate');
    assert.strictEqual(b4.audio, null);
    // MJPEG named only by the handler, or only by the compression.
    assert.ok((await avi.parseAvi(write(riff('AVI ', hdrl(VIDEO('XXXX', 'MJPG')), list('movi', chunk('00dc', Buffer.alloc(4))))))).isMjpeg);
    assert.ok((await avi.parseAvi(write(riff('AVI ', hdrl(VIDEO('mjpg', 'xxxx')), list('movi', chunk('00dc', Buffer.alloc(4))))))).isMjpeg, 'case-insensitive');
    // No video at all (audio only) and no headers at all.
    const noVid = await avi.parseAvi(write(riff('AVI ', hdrl(AUDIO), list('movi', chunk('00wb', Buffer.alloc(4))))));
    assert.deepStrictEqual([noVid.frames.length, noVid.fps > 0, noVid.isMjpeg], [0, true, false]);
    assert.ok(noVid.audio);
    const bare = await avi.parseAvi(write(riff('AVI ')));
    assert.deepStrictEqual([bare.width, bare.height, bare.fps, bare.frames.length, bare.audio], [0, 0, 0, 0, null]);
    // Compressed audio (not PCM) has no pcm flag.
    const mp3 = await avi.parseAvi(write(riff('AVI ', hdrl(VIDEO(), [strh('auds', '\0\0\0\0', 1, 44100), strfA(2, 44100, 16, 0x55)]), list('movi', chunk('00dc', Buffer.alloc(4))))));
    assert.strictEqual(mp3.audio.pcm, false);

    // ---- a crashed recorder's file: the last chunk and list are cut off ----------------
    const full = riff('AVI ', hdrl(VIDEO()), list('movi', chunk('00dc', Buffer.alloc(100, 1)), chunk('00dc', Buffer.alloc(100, 2)), chunk('00dc', Buffer.alloc(100, 3))));
    const trunc = await avi.parseAvi(write(full.subarray(0, full.length - 150)));
    assert.strictEqual(trunc.frames.length, 1, 'only the whole chunks count');
    // RIFF length 0 (recorder never finished): read to the end of file.
    const unfinished = Buffer.from(full);
    unfinished.writeUInt32LE(0, 4);
    assert.strictEqual((await avi.parseAvi(write(unfinished))).frames.length, 3);
    // RIFF length larger than the file.
    const lying = Buffer.from(full);
    lying.writeUInt32LE(0x7ffffff0, 4);
    assert.strictEqual((await avi.parseAvi(write(lying))).frames.length, 3);

    // ---- hostile input ------------------------------------------------------------------
    await assert.rejects(avi.parseAvi(write(Buffer.alloc(0))), /not a RIFF AVI/);
    await assert.rejects(avi.parseAvi(write(Buffer.from('RIFF\0\0\0\0WAVE'))), /not a RIFF AVI/);
    await assert.rejects(avi.parseAvi(write(Buffer.from('RIFF'))), /not a RIFF AVI/);
    await assert.rejects(avi.parseAvi(path.join(dir, 'missing.avi')), /ENOENT/);
    // A chunk claiming 4 GB, a LIST shorter than its type tag, a strh that is too short, a strf with no strh,
    // avih shorter than 40 bytes: nothing throws, nothing is invented.
    const evil = riff('AVI ', list('hdrl', chunk('avih', Buffer.alloc(8)), chunk('strf', Buffer.alloc(40)), list('strl', chunk('strh', Buffer.alloc(10)), strfV(10, 10, 'MJPG'))),
      Buffer.concat([Buffer.from('LIST'), u32(2), Buffer.from('mo')]), chunk('JUNK', Buffer.alloc(3), 0xfffffff0));
    const e = await avi.parseAvi(write(evil));
    assert.deepStrictEqual([e.width, e.height, e.fps, e.frames.length], [0, 0, 0, 0]);
    // Sizes that put the next chunk before the current one cannot loop forever (declared sizes only grow).
    const zeroLoop = riff('AVI ', Buffer.concat([Buffer.from('LIST'), u32(0), Buffer.alloc(12)]));
    await avi.parseAvi(write(zeroLoop));
    // Many streams: chunk for stream 99 without a stream is skipped.
    const manyStreams = await avi.parseAvi(write(riff('AVI ', hdrl(VIDEO()), list('movi', chunk('99dc', Buffer.alloc(4)), chunk('00dc', Buffer.alloc(4))))));
    assert.strictEqual(manyStreams.frames.length, 1);

    // ---- JPEG Huffman tables ---------------------------------------------------------------
    assert.ok(!avi.hasHuffmanTables(jpegNoDht));
    const fixed = avi.fixJpeg(jpegNoDht);
    assert.ok(fixed.length === jpegNoDht.length + avi.STANDARD_DHT.length);
    assert.ok(avi.hasHuffmanTables(fixed));
    assert.ok(avi.fixJpeg(fixed).equals(fixed), 'fixing twice changes nothing');
    assert.ok(fixed.subarray(0, 2).equals(Buffer.from([0xff, 0xd8])) && fixed.subarray(fixed.length - 4).equals(jpegNoDht.subarray(jpegNoDht.length - 4)));
    assert.strictEqual(avi.STANDARD_DHT.readUInt16BE(2), avi.STANDARD_DHT.length - 2, 'the DHT segment length is right');
    assert.strictEqual(avi.STANDARD_DHT.length, 420, 'marker + length + four standard tables (4*17 + 12+162+12+162 bytes)');
    assert.ok(avi.fixJpeg(Buffer.alloc(0)).length === 0);
    const notJpeg = Buffer.from([1, 2, 3, 4, 5]);
    assert.strictEqual(avi.fixJpeg(notJpeg), notJpeg, 'not a JPEG: untouched');
    const tiny = Buffer.from([0xff, 0xd8, 0xff]);
    assert.strictEqual(avi.fixJpeg(tiny), tiny);
    // Fill bytes (0xFF 0xFF) before a marker, an early malformed marker, a DHT present.
    const fill = Buffer.from([0xff, 0xd8, 0xff, 0xff, 0xff, 0xdb, 0x00, 0x04, 0x01, 0x02, 0xff, 0xda, 0x00, 0x02, 0x11, 0x22]);
    assert.ok(!avi.hasHuffmanTables(fill));
    assert.ok(avi.hasHuffmanTables(Buffer.from([0xff, 0xd8, 0x12, 0x34, 0x56, 0x78])), 'malformed: leave it to the decoder');
    assert.ok(avi.hasHuffmanTables(Buffer.from([0xff, 0xd8, 0xff, 0xc4, 0x00, 0x04, 0, 0])));
    assert.ok(avi.hasHuffmanTables(Buffer.from([0xff, 0xd8])), 'nothing to scan');
    console.log('avi synth: ok');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
})().catch((e) => { console.error(e); process.exit(1); });
