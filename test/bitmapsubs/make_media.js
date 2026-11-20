'use strict';
// Picture-subtitle test media: a PGS .sup built byte by byte (ffmpeg has no PGS
// encoder), muxed into MKV, then transcoded by ffmpeg to DVD (MKV) and DVB (TS)
// subtitles. The video is 640x360 testsrc2 at 10 fps, 20 s, H.264.
//
//   node test/bitmapsubs/make_media.js <out dir>
//
// Needs ffmpeg (VPE_FFMPEG or PATH) with libx264. Existing files are kept. Never commit the output.
//
//   bitmap_pgs.mkv   PGS; every picture ends with an empty display set
//   bitmap_dvd.mkv   dvd_subtitle, with stop times
//   bitmap_dvb.ts    dvb_subtitle (ffmpeg writes a clearing packet after each picture)
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const W = 640;
const H = 360;
const DURATION = 20;
// Solid boxes: [start, end) in seconds, position and size in the 640x360 subtitle canvas.
// Colours as limited-range BT.601 Y, Cb, Cr.
const EVENTS = [
  { start: 1, end: 3, x: 220, y: 300, w: 200, h: 40, color: 'red', ycc: [81, 90, 240] },
  { start: 5, end: 8, x: 20, y: 20, w: 120, h: 30, color: 'green', ycc: [145, 54, 34] },
  { start: 12, end: 16, x: 400, y: 250, w: 160, h: 50, color: 'blue', ycc: [41, 240, 110] },
];

// ---- PGS (HDMV presentation graphic stream) -----------------------------------------

const u16 = (v) => [(v >> 8) & 0xff, v & 0xff];
const u24 = (v) => [(v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];
const u32 = (v) => [(v >>> 24) & 0xff, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];

/** One segment: "PG", PTS and DTS (90 kHz), type, length, payload. */
function segment(type, pts, payload) {
  return Buffer.from(['P'.charCodeAt(0), 'G'.charCodeAt(0), ...u32(Math.round(pts * 90000)), ...u32(0), type, ...u16(payload.length), ...payload]);
}

/** PGS run-length coding of rows of palette indices. */
function rle(rows) {
  const out = [];
  for (const row of rows) {
    for (let i = 0; i < row.length;) {
      const c = row[i];
      let n = 1;
      while (i + n < row.length && row[i + n] === c && n < 16383) n++;
      if (c !== 0 && n < 3) { for (let k = 0; k < n; k++) out.push(c); } else if (c === 0) {
        if (n < 64) out.push(0, n); else out.push(0, 0x40 | (n >> 8), n & 0xff);
      } else if (n < 64) out.push(0, 0x80 | n, c); else out.push(0, 0xc0 | (n >> 8), n & 0xff, c);
      i += n;
    }
    out.push(0, 0); // end of line
  }
  return out;
}

/** A display set showing box e (epoch start: needs nothing from before), or clearing the screen when e is null. */
function displaySet(t, e, num) {
  if (!e) {
    return Buffer.concat([
      segment(0x16, t, [...u16(W), ...u16(H), 0x10, ...u16(num), 0x00, 0, 0, 0]), // PCS, no objects
      segment(0x17, t, [1, 0, ...u16(0), ...u16(0), ...u16(1), ...u16(1)]),
      segment(0x80, t, []),
    ]);
  }
  const rows = [];
  for (let y = 0; y < e.h; y++) {
    const row = new Array(e.w).fill(1);
    // A 2-pixel white frame: tells the box's edges apart from its fill.
    if (y < 2 || y >= e.h - 2) row.fill(2); else { row[0] = row[1] = row[e.w - 1] = row[e.w - 2] = 2; }
    rows.push(row);
  }
  const data = rle(rows);
  const [Y, Cb, Cr] = e.ycc;
  return Buffer.concat([
    segment(0x16, t, [...u16(W), ...u16(H), 0x10, ...u16(num), 0x80, 0, 0, 1, ...u16(0), 0, 0, ...u16(e.x), ...u16(e.y)]),
    segment(0x17, t, [1, 0, ...u16(e.x), ...u16(e.y), ...u16(e.w), ...u16(e.h)]),
    // Palette: 0 transparent, 1 the colour, 2 white (entries are id, Y, Cr, Cb, alpha).
    segment(0x14, t, [0, 0, 0, 16, 128, 128, 0, 1, Y, Cr, Cb, 255, 2, 235, 128, 128, 255]),
    segment(0x15, t, [...u16(0), 0, 0xc0, ...u24(data.length + 4), ...u16(e.w), ...u16(e.h), ...data]),
    segment(0x80, t, []),
  ]);
}

/** The whole .sup: each box from its start, cleared by an empty display set at its end. */
function sup(events = EVENTS) {
  const parts = [];
  let num = 0;
  // An empty display set at 0: ffmpeg would otherwise shift the stream to start at the first box.
  parts.push(displaySet(0, null, num++));
  for (const e of events) {
    parts.push(displaySet(e.start, e, num++));
    parts.push(displaySet(e.end, null, num++));
  }
  return Buffer.concat(parts);
}

// ---- files ---------------------------------------------------------------------------

const FILES = { pgs: 'bitmap_pgs.mkv', dvd: 'bitmap_dvd.mkv', dvb: 'bitmap_dvb.ts' };

function ffmpeg(args) {
  const r = spawnSync(process.env.VPE_FFMPEG || 'ffmpeg', ['-hide_banner', '-v', 'error', '-y', ...args], { encoding: 'utf8' });
  if (r.error || r.status !== 0) throw new Error(`ffmpeg ${args.join(' ')}: ${r.error ? r.error.message : r.stderr}`);
}

/** Makes the files in dir (kept when present). Returns {pgs, dvd, dvb} paths. */
function make(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const out = Object.fromEntries(Object.entries(FILES).map(([k, n]) => [k, path.join(dir, n)]));
  const tmp = (f) => `${f}.part${path.extname(f)}`;
  if (!fs.existsSync(out.pgs)) {
    const s = path.join(dir, 'bitmap_pgs.sup');
    fs.writeFileSync(s, sup());
    ffmpeg(['-f', 'lavfi', '-i', `testsrc2=size=${W}x${H}:rate=10:duration=${DURATION}`, '-i', s, '-map', '0', '-map', '1',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '32', '-g', '20', '-pix_fmt', 'yuv420p', '-c:s', 'copy', '-metadata:s:s:0', 'language=eng', tmp(out.pgs)]);
    fs.renameSync(tmp(out.pgs), out.pgs);
    fs.rmSync(s, { force: true });
  }
  // PGS has no end times; -fix_sub_duration takes them from the next (clearing) display set.
  if (!fs.existsSync(out.dvd)) {
    ffmpeg(['-fix_sub_duration', '-i', out.pgs, '-map', '0', '-c:v', 'copy', '-c:s', 'dvdsub', '-metadata:s:s:0', 'language=ger', tmp(out.dvd)]);
    fs.renameSync(tmp(out.dvd), out.dvd);
  }
  if (!fs.existsSync(out.dvb)) {
    ffmpeg(['-fix_sub_duration', '-i', out.pgs, '-map', '0', '-c:v', 'copy', '-c:s', 'dvbsub', '-metadata:s:s:0', 'language=fre', '-f', 'mpegts', tmp(out.dvb)]);
    fs.renameSync(tmp(out.dvb), out.dvb);
  }
  return out;
}

module.exports = { W, H, DURATION, EVENTS, FILES, sup, rle, segment, make };

if (require.main === module) {
  const dir = process.argv[2];
  if (!dir) { console.error('usage: node test/bitmapsubs/make_media.js <out dir>'); process.exit(2); }
  const out = make(path.resolve(dir));
  for (const f of Object.values(out)) console.log(`${f} ${fs.statSync(f).size} bytes`);
}
