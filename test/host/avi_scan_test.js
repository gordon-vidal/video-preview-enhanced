'use strict';
// node test/host/avi_scan_test.js <file.avi>...
// Times parseAvi, counts file reads and bytes read, and prints a digest of the
// frame and audio chunk lists (compare digests before and after a change to the
// scanner). Fails when a scan reads more than a sane share of the file: the
// headers plus about one small read per movi chunk.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const avi = require(process.env.AVI_MODULE || '../../src/avi');

(async () => {
  let reads = 0;
  let bytes = 0;
  const fh0 = await fs.promises.open(__filename, 'r');
  const proto = Object.getPrototypeOf(fh0);
  await fh0.close();
  const origRead = proto.read;
  proto.read = async function (...a) {
    reads++;
    const r = await origRead.apply(this, a);
    bytes += r.bytesRead;
    return r;
  };
  let failed = 0;
  for (const f of process.argv.slice(2)) {
    reads = 0;
    bytes = 0;
    const t0 = process.hrtime.bigint();
    const info = await avi.parseAvi(f);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    const digest = crypto.createHash('sha1').update(JSON.stringify({
      frames: info.isMjpeg ? info.frames : [], audio: info.isMjpeg && info.audio ? info.audio.chunks : [],
      w: info.width, h: info.height, fps: info.fps, mjpeg: info.isMjpeg, pcm: !!(info.audio && info.audio.pcm),
    })).digest('hex').slice(0, 12);
    const size = fs.statSync(f).size;
    // Headers come through one 1 MB window or two; each movi chunk costs at most
    // one small read. Anything near the file size means the scan reads the data.
    const chunks = info.frames.length + (info.audio ? info.audio.chunks.length : 0);
    const bound = 4 * (1 << 20) + chunks * 16 * 1024;
    const ok = bytes <= bound && (size < 16e6 || bytes < size / 4);
    if (!ok) failed++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${path.basename(f)}: ${(size / 1e6).toFixed(0)} MB mjpeg=${info.isMjpeg} frames=${info.frames.length} ` +
      `reads=${reads} bytes=${(bytes / 1e6).toFixed(2)} MB ${ms.toFixed(1)} ms digest=${digest}`);
  }
  if (failed) process.exit(1);
})().catch((e) => { console.error(e); process.exit(1); });
