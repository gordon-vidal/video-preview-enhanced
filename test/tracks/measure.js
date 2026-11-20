#!/usr/bin/env node
// Timings for stream discard and skip_frame=noref. Run through the benchmark queue:
//
//   node test/benchq.js node test/tracks/measure.js discard <file> [--runs=3]
//   node test/benchq.js node test/tracks/measure.js nonref <file> [--pool] [--runs=1]
//
// discard: plays the file to the end (picture as packets for WebCodecs, and decoded
//   in software) with unused streams discarded and kept; wall time and bytes read.
// nonref: decodes the file in software with every frame and with non-reference
//   frames skipped; decode speed in media seconds per second, frames kept, and a
//   real-time simulation (0.5 s pre-roll): frames that arrive before they are due.
'use strict';
const { Session } = require('./driver');

const [cmd, file] = process.argv.slice(2);
const runs = +((process.argv.find((a) => a.startsWith('--runs=')) || '').slice(7) || (cmd === 'discard' ? 3 : 1));
const pool = process.argv.includes('--pool');
const median = (a) => [...a].sort((x, y) => x - y)[a.length >> 1];

async function play(o, nonref) {
  const s = await new Session(file, o).open();
  if (nonref) s.send({ type: 'skipNonRef', on: true });
  const t0 = performance.now();
  const arrive = [];
  let pkts = 0;
  let audio = 0;
  for (;;) {
    const b = await s.more();
    for (const v of b.video) { if (v.kind === 'yuv') arrive.push([performance.now() - t0, v.t]); else pkts++; }
    audio += b.audio.length;
    if (b.eof) break;
  }
  const ms = performance.now() - t0;
  const r = { ms, readMB: s.readBytes / 1e6, reads: s.reads, frames: arrive.length, pkts, audio, arrive };
  s.close();
  return r;
}

(async () => {
  if (cmd === 'discard') {
    for (const video of ['webcodecs', 'soft']) {
      const res = { discard: [], keep: [] };
      for (let i = 0; i < runs; i++) {
        for (const keep of [false, true]) res[keep ? 'keep' : 'discard'].push(await play({ video, keepStreams: keep, pool: false }));
      }
      const fmt = (list) => `${median(list.map((x) => x.ms)).toFixed(0)} ms, read ${list[0].readMB.toFixed(1)} MB in ${list[0].reads} reads, ${list[0].pkts + list[0].frames} video, ${list[0].audio} audio items`;
      console.log(`${video.padEnd(9)} discard: ${fmt(res.discard)}`);
      console.log(`${video.padEnd(9)} keep:    ${fmt(res.keep)}`);
    }
  } else if (cmd === 'nonref') {
    for (const nonref of [false, true]) {
      const r = await play({ video: 'soft', pool, workers: pool ? 3 : undefined }, nonref);
      const a = r.arrive.filter((x) => x[1] !== null);
      const t0 = a.length ? a[0][1] : 0;
      const span = a.length ? a[a.length - 1][1] - t0 : 0;
      // Real time from the first frame, after 0.5 s of pre-roll.
      const onTime = a.filter(([ms, t]) => ms / 1000 <= a[0][0] / 1000 + 0.5 + (t - t0)).length;
      console.log(`${pool ? 'pool ' : 'single'} ${nonref ? 'noref ' : 'every '}: ${r.frames} frames in ${(r.ms / 1000).toFixed(1)} s = ${(r.frames / (r.ms / 1000)).toFixed(1)} fps; speed ${(span / (r.ms / 1000)).toFixed(2)}x real time; on time in real-time playback: ${onTime}/${a.length} (${(onTime / Math.max(1, span)).toFixed(1)} per media second)`);
    }
  } else {
    console.error('usage: measure.js discard|nonref <file>');
    process.exit(2);
  }
  process.exit(0);
})();
