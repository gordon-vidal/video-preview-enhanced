'use strict';
// node test/host/wav_parts_test.js <mjpeg_pcm.avi>...: the MJPEG AVI sound sent in
// parts (pcmWavParts) joins up to exactly readPcmAsWav's WAV, and the host sends
// it as 'wavPart' messages before 'frames' (review 1 #18).
const assert = require('assert');
const path = require('path');
const avi = require('../../src/avi');
const { load } = require('./mock_vscode');

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
    const h = load();
    const s = h.open(f);
    await s.send({ type: 'ready' });
    // Ignore unrelated async state messages (e.g. ffmpegState) that can race with WAV I/O.
    const media = s.posted.filter((m) => m.type === 'wavPart' || m.type === 'frames');
    const types = media.map((m) => m.type);
    const fr = types.indexOf('frames');
    assert.ok(fr > 0 && fr === types.length - 1 && types.slice(0, fr).every((t) => t === 'wavPart'), 'wavPart messages, then frames');
    assert.strictEqual(media[fr].wav, null);
    const sent = Buffer.concat(media.slice(0, fr).map((m) => Buffer.from(m.data)));
    assert.ok(sent.equals(whole), 'host sends the whole WAV');
    s.panel.dispose();
    console.log(`${path.basename(f)}: ${(whole.length / 1e6).toFixed(1)} MB WAV in ${fr} part(s): ok`);
  }
})().catch((e) => { console.error(e); process.exit(1); });
