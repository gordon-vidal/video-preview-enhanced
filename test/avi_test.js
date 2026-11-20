'use strict';
// node test/avi_test.js <file.avi>...  (also checks the standard DHT table)
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const avi = require('../src/avi');

function extractDht(jpeg) {
  let i = 2;
  const parts = [];
  while (i < jpeg.length) {
    const m = jpeg[i + 1];
    const len = jpeg.readUInt16BE(i + 2);
    if (m === 0xc4) parts.push(jpeg.subarray(i + 4, i + 2 + len));
    if (m === 0xda) break;
    i += 2 + len;
  }
  return Buffer.concat(parts);
}

function splitTables(b) {
  const map = new Map();
  let p = 0;
  while (p < b.length) {
    const n = b.subarray(p + 1, p + 17).reduce((s, x) => s + x, 0);
    map.set(b[p], b.subarray(p, p + 17 + n));
    p += 17 + n;
  }
  return map;
}

(async () => {
  let fail = 0;
  // ffmpeg's "-huffman default" writes exactly the Annex K tables.
  const tmp = path.join(os.tmpdir(), `vpe_dht_${process.pid}.jpg`);
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=64x64', '-frames:v', '1',
    '-c:v', 'mjpeg', '-huffman', 'default', tmp]);
  const ref = splitTables(extractDht(fs.readFileSync(tmp)));
  fs.unlinkSync(tmp);
  const ours = splitTables(avi.STANDARD_DHT.subarray(4));
  // Table order inside a DHT is free; compare per table class/id.
  const same = ref.size === 4 && [...ref].every(([tc, b]) => ours.get(tc) && ours.get(tc).equals(b));
  console.log(`standard DHT matches ffmpeg: ${same}`);
  if (!same) fail++;

  for (const f of process.argv.slice(2)) {
    const t0 = Date.now();
    const info = await avi.parseAvi(f);
    const ms = Date.now() - t0;
    const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-count_packets', '-select_streams', 'v:0',
      '-show_entries', 'stream=nb_read_packets', '-of', 'json', f]).toString());
    const expected = Number(probe.streams[0].nb_read_packets);
    const fh = fs.openSync(f, 'r');
    const fr = info.frames[0];
    const b = Buffer.alloc(fr.size);
    fs.readSync(fh, b, 0, fr.size, fr.offset);
    fs.closeSync(fh);
    const ok = info.frames.length === expected && b[0] === 0xff && b[1] === 0xd8;
    if (!ok) fail++;
    console.log(`${path.basename(f)}: ${info.width}x${info.height} ${info.fps}fps ${info.compression} mjpeg=${info.isMjpeg} ` +
      `frames=${info.frames.length} (ffprobe ${expected}) audio=${info.audio ? `${info.audio.sampleRate}Hz/${info.audio.channels}ch pcm=${info.audio.pcm} chunks=${info.audio.chunks.length}` : 'none'} ` +
      `firstFrameSOI=${b[0] === 0xff && b[1] === 0xd8} hasDHT=${avi.hasHuffmanTables(b)} parse=${ms}ms ${ok ? 'OK' : 'FAIL'}`);
  }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
