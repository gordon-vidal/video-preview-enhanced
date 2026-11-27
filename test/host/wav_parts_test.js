'use strict';
// node test/host/wav_parts_test.js <mjpeg_pcm.avi>...: the MJPEG AVI sound read in parts (src/avi.js pcmWavParts)
// joins up to exactly readPcmAsWav's WAV (review 1 #18). The viewer plays MJPEG AVI through the built-in decoder.
const assert = require('assert');
const path = require('path');
const avi = require('../../src/avi');

(async () => {
  for (const f of process.argv.slice(2)) {
    const info = await avi.parseAvi(f);
    assert.ok(info.audio && info.audio.pcm, `${f} has PCM sound`);
    const whole = await avi.readPcmAsWav(f, info.audio);
    for (const size of [4096, 100000, 8 << 20]) {
      const parts = [];
      for await (const p of avi.pcmWavParts(f, info.audio, size)) parts.push(Buffer.from(p));
      assert.ok(parts.every((p) => p.length <= size), 'parts within size');
      assert.ok(Buffer.concat(parts).equals(whole), `parts of ${size} join to the same WAV`);
    }
    console.log(`${path.basename(f)}: ${(whole.length / 1e6).toFixed(1)} MB WAV joins up from its parts: ok`);
  }
})().catch((e) => { console.error(e); process.exit(1); });
