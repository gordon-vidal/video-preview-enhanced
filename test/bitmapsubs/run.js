#!/usr/bin/env node
// Picture subtitles (PGS, DVD, DVB): the overlay's cue index and palette conversion
// (subtitles.js), and media/decoder-worker.js decoding real files with libav.js in
// Node (test/tracks/driver.js): pictures, positions, colours, clearing, seeks.
//
//   node test/bitmapsubs/run.js [media dir] [--log]
//
// The media (test/bitmapsubs/make_media.js) is made in the media dir when missing
// (default: <tmp>/vpe-bitmapsubs); that needs ffmpeg with libx264 (VPE_FFMPEG or PATH).
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const Sub = require('../../media/subtitles.js');
const M = require('./make_media');

const args = process.argv.slice(2);
const dir = path.resolve(args.find((a) => !a.startsWith('--')) || process.env.VPE_BITMAPSUBS || path.join(os.tmpdir(), 'vpe-bitmapsubs'));
const LOG = args.includes('--log');
let failed = 0;
let passed = 0;
const check = (ok, what) => { if (ok) passed++; else failed++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}`); return ok; };
const near = (a, b, eps = 0.06) => typeof a === 'number' && Math.abs(a - b) <= eps;

// ---- pure: palette conversion, boxes, the cue index ------------------------------------

function pure() {
  console.log('subtitles.js picture helpers');
  const rgba = Sub.bitmapRgba({ w: 3, h: 1, bitmap: new Uint8Array([0, 1, 7]), palette: new Uint32Array([0x00000000, 0x80ff2010]) });
  check([...rgba].join(',') === '0,0,0,0,255,32,16,128,0,0,0,0', `bitmapRgba: 0xAARRGGBB to RGBA, indices past the palette transparent (${[...rgba]})`);
  const b = Sub.bitmapBox({ x: 160, y: 270, w: 320, h: 45 }, [640, 360]);
  check(b.left === 25 && b.top === 75 && b.width === 50 && b.height === 12.5, `bitmapBox in percent of the picture: ${JSON.stringify(b)}`);

  const rect = (w = 10, h = 10) => ({ x: 0, y: 0, w, h });
  const cue = (span, start, end, rects = [rect()]) => ({ span, gen: 1, start, end, rects, frame: [640, 360] });
  const ix = new Sub.BitmapCueIndex();
  ix.add({ span: 1, gen: 1, rects: null });
  ix.add(cue(1, 1, null));
  ix.add(cue(1, 3, null, [])); // PGS: an empty display set
  ix.add(cue(1, 5, 7.5)); // DVD: a stop time
  ix.add(cue(1, 9, 39)); // DVB: a 30 s time-out ...
  ix.add(cue(1, 10, 40, [])); // ... and a clearing page
  ix.add(cue(1, 12, null));
  const shown = (t) => ix.at(t).map((c) => c.start).join(',') || '-';
  const got = [0.5, 1, 2.9, 3, 4, 5, 7.4, 7.5, 8, 9.5, 10, 11, 12, 100].map(shown).join(' ');
  check(got === '- 1 1 - - 5 5 - - 9 - - 12 12', `shown over time (open end, empty cue, stop time, time-out + clear, open last): ${got}`);
  check(!ix.add(cue(1, 5, 7.5)) && ix.size === 6, 'the same picture again (prescan, then reading on) is ignored');
  check(!ix.add(cue(0, 13, null)) && ix.size === 6, 'a picture of an older span is ignored');
  ix.add({ span: 2, gen: 2, rects: null });
  check(ix.size === 0 && ix.gen === 2 && shown(12.5) === '-', 'a new span (seek, track switch) drops the pictures before it');
  ix.add(cue(2, 50, null));
  ix.add(cue(2, 20, null, [])); // read out of order (prescan, then from the keyframe): sorted by start
  check(shown(30) === '-' && shown(55) === '50', `pictures are ordered by start: ${shown(30)} ${shown(55)}`);

  // Memory: past pictures go after 30 s, and the oldest beyond 64 MB.
  const big = new Sub.BitmapCueIndex();
  for (let i = 0; i < 200; i++) { big.add(cue(1, i * 2, null, [rect(1000, 500)])); big.add(cue(1, i * 2 + 1, null, [])); }
  big.prune(200);
  check(big.cues[0].start >= 168 && big.at(399.5).length === 0 && big.at(398.5).length === 1, `prune keeps the last 30 s: first ${big.cues[0].start}, ${big.size} cues`);
  const huge = new Sub.BitmapCueIndex();
  for (let i = 0; i < 100; i++) huge.add(cue(1, i, null, [rect(1920, 1080)]));
  huge.prune(0);
  check(huge.bytes <= 64 << 20 && huge.at(99.5).length === 1, `prune keeps at most 64 MB: ${(huge.bytes / 1048576).toFixed(1)} MB in ${huge.size} cues`);
  check(huge.keys.size === huge.size, 'pruned pictures can be read again (their keys go too)');
}

// ---- the worker, decoding the files ------------------------------------------------------

const COLORS = { red: [1, 0, 0], green: [0, 1, 0], blue: [0, 0, 1] };
function colourOk(cue, e) {
  const r = cue.rects[0];
  const px = Sub.bitmapRgba(r);
  const at = (x, y) => [...px.subarray((y * r.w + x) * 4, (y * r.w + x) * 4 + 4)];
  const mid = at(r.w >> 1, r.h >> 1);
  const edge = at(0, 0);
  const want = COLORS[e.color];
  const fill = want.every((on, k) => (on ? mid[k] > 180 : mid[k] < 70)) && mid[3] === 255;
  return { ok: fill && edge[0] > 200 && edge[1] > 200 && edge[2] > 200 && edge[3] === 255, mid, edge };
}

async function worker(kind, file) {
  const { Session } = require('../tracks/driver');
  console.log(`${kind}: ${path.basename(file)}`);
  const s = await new Session(file, { log: LOG }).open();
  try {
    const tr = s.info.tracks.sub[0];
    check(tr && tr.kind === 'bitmap', `track list: ${JSON.stringify(tr)}`);
    s.send({ type: 'selectSub', id: tr.id, t: 0 });
    const sel = await s.wait((m) => m.type === 'subSelected');
    check(sel.kind === 'bitmap' && !sel.error, `selectSub: ${JSON.stringify(sel)}`);
    // Messages in arrival order into one index, as the overlay does.
    const ix = new Sub.BitmapCueIndex();
    let used = 0;
    const feed = () => { for (; used < s.subs.length; used++) { const m = s.subs[used]; ix.add({ span: m.span, gen: m.gen, rects: null }); for (const c of m.cues) ix.add({ ...c, span: m.span, gen: m.gen }); } };
    let v0 = Infinity;
    let vt = -Infinity;
    const pullTo = async (t) => {
      for (let n = 0; n < 500 && vt < t; n++) {
        const b = await s.more();
        for (const v of b.video) if (v.t !== null) { v0 = Math.min(v0, v.t); vt = Math.max(vt, v.t); }
        if (b.eof) break;
      }
      feed();
    };
    await pullTo(Infinity);
    const off = v0; // MPEG-TS starts at 1.4 s
    check(s.subs.every((m) => m.bitmap === true && m.id === tr.id), `${s.subs.length} 'subs' messages, all pictures of track ${tr.id}`);
    for (const e of M.EVENTS) {
      const c = ix.at(off + e.start + 0.2)[0];
      const r = c && c.rects[0];
      check(r && c.rects.length === 1 && r.x === e.x && r.y === e.y && r.w === e.w && r.h === e.h && c.frame.join('x') === `${M.W}x${M.H}`,
        `${e.color} box at ${e.start} s: ${r ? `${r.x},${r.y} ${r.w}x${r.h} in ${c.frame.join('x')}` : 'none'}`);
      if (!c) continue;
      check(near(c.start, off + e.start), `starts at ${(c.start - off).toFixed(3)} s (want ${e.start})`);
      const end = ix.endOf(ix.cues.indexOf(c));
      check(near(end, off + e.end), `ends at ${(end - off).toFixed(3)} s (want ${e.end}; ${c.end === null ? 'next cue' : 'its end time'})`);
      const col = colourOk(c, e);
      check(col.ok, `palette to RGBA: fill ${col.mid}, frame ${col.edge}`);
      check(ix.at(off + e.start - 0.2).length === 0 && ix.at(off + e.end + 0.2).length === 0, 'nothing just before and just after');
    }

    // Seeks: the prescan finds the picture showing at the target; later clears arrive by reading on.
    for (const [t, want, endAt] of [[13.5, 'blue', 16], [6, 'green', 8], [10, null, null], [1.5, 'red', 3]]) {
      const span = ix.span;
      await s.seek(off + t);
      vt = -Infinity;
      feed();
      check(ix.span > span, `seek to ${t}: a new span (${span} -> ${ix.span})`);
      const c = ix.at(off + t)[0];
      const e = M.EVENTS.find((x) => x.color === want);
      check(want ? c && c.rects[0].x === e.x && colourOk(c, e).ok : !c, `seek to ${t}: shows ${c ? `${c.rects[0].x},${c.rects[0].y}` : 'nothing'} (want ${want || 'nothing'})`);
      if (endAt) {
        await pullTo(off + endAt + 1);
        check(ix.at(off + endAt - 0.1).length === 1 && ix.at(off + endAt + 0.1).length === 0, `after the seek: cleared at ${endAt} s`);
      }
    }
    check(!s.errors.length, `no worker errors ${s.errors.join('; ')}`);
  } finally { s.close(); }
}

(async () => {
  pure();
  let files = null;
  try { files = M.make(dir); } catch (e) { console.log(`  SKIP worker tests: no media in ${dir} and could not make it (${e.message.split('\n')[0]})`); }
  if (files) for (const k of ['pgs', 'dvd', 'dvb']) await worker(k, files[k]);
  console.log(failed ? `\nBITMAPSUBS FAIL: ${failed} failed, ${passed} passed` : `\nBITMAPSUBS OK: ${passed} checks`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.log('EXC', e && e.stack || e); process.exit(1); });
