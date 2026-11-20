/*
 * Node tests for media/subtitles.js (no browser):  node test/subtitles/run.js
 * Parsers (SRT, WebVTT, ASS/SSA), text decoding (BOMs, UTF-16, windows-1252, CRLF),
 * embedded cues, and the overlap-safe cue index. Exit code 1 on any failure.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const S = require('../../media/subtitles.js');

let failures = 0;
const check = (ok, msg) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) failures++; };
const eq = (a, b, msg) => check(JSON.stringify(a) === JSON.stringify(b), `${msg}${JSON.stringify(a) === JSON.stringify(b) ? '' : `: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`}`);
const near = (a, b) => Math.abs(a - b) < 1e-6;
const fx = (n) => fs.readFileSync(path.join(__dirname, 'fixtures', n), 'utf8').replace(/\r\n/g, '\n');
const text = (c) => S.cueText(c);

// ---- times --------------------------------------------------------------------
check(near(S.parseTime('01:02:03,456'), 3723.456), 'SRT time');
check(near(S.parseTime('02:03.5'), 123.5), 'VTT mm:ss.t time');
check(near(S.parseTime('0:00:01.25'), 1.25), 'ASS centiseconds');
check(Number.isNaN(S.parseTime('garbage')), 'bad time is NaN');

// ---- SRT ------------------------------------------------------------------------
for (const [label, src] of [['LF', fx('overlap.srt')], ['CRLF', fx('overlap.srt').replace(/\n/g, '\r\n')], ['CR', fx('overlap.srt').replace(/\n/g, '\r')]]) {
  const { format, cues } = S.parse(src, 'x.srt');
  eq(format, 'srt', `srt ${label}: format`);
  eq(cues.length, 5, `srt ${label}: 5 valid cues (bad timing dropped)`);
  eq(text(cues[0]), 'Hello world', `srt ${label}: tags stripped`);
  check(cues[0].lines[0][1].i && !cues[0].lines[0][0].i, `srt ${label}: <i> run italic`);
  eq(cues[1].an, 8, `srt ${label}: {\\an8} moves to top`);
  eq(text(cues[1]), 'Overlapping top line\nwith red & more', `srt ${label}: two lines, entity`);
  check(cues[1].lines[1].some((r) => r.c === '#ff0000' && r.text === 'red'), `srt ${label}: font colour`);
  eq(text(cues[2]), 'Dots instead of commas\n- second line', `srt ${label}: dot decimals`);
  eq(text(cues[3]), 'Leading blank line, then text', `srt ${label}: leading blank dropped`);
  eq(text(cues[4]), 'No index line before this one', `srt ${label}: no index line`);
}

// ---- WebVTT -----------------------------------------------------------------------
{
  const { format, cues } = S.parse(fx('header.vtt'), 'x.vtt');
  eq(format, 'vtt', 'vtt: format');
  eq(cues.length, 4, 'vtt: STYLE / NOTE / REGION / header skipped');
  eq(text(cues[0]), 'Hi there <3', 'vtt: <v>, <c> dropped, entity kept as text');
  eq(cues[1].an, 7, 'vtt: line:0 align:start = top left');
  eq(text(cues[2]), 'Positioned cue\nkaraoke', 'vtt: timestamp tag dropped');
  check(cues[2].pos && near(cues[2].pos.x, 0.2) && near(cues[2].pos.y, 0.1) && cues[2].an >= 7, 'vtt: position/line percentages');
  check(near(cues[3].start, 3600) && near(cues[3].end, 3601.5), 'vtt: hour timestamps');
  eq(S.parse('WEBVTT\r\n\r\n00:01.000 --> 00:02.000\r\nCRLF cue\r\n').cues.map(text), ['CRLF cue'], 'vtt: CRLF, detected by content');
}

// ---- ASS / SSA ----------------------------------------------------------------------
{
  const { format, cues } = S.parse(fx('overrides.ass'), 'x.ass');
  eq(format, 'ass', 'ass: format');
  eq(cues.length, 5, 'ass: Comment and drawing-only events skipped');
  eq(text(cues[0]), 'First line\nSecond, with comma', 'ass: \\N and comma inside text');
  const it = cues[1].lines[0];
  check(it[0].text === 'Italic' && it[0].i && !it[1].i, 'ass: \\i1 / \\i0');
  check(it.some((r) => r.text === 'bold' && r.b), 'ass: \\b1');
  eq(text(cues[1]), 'Italic and bold text', 'ass: comment block dropped');
  const sign = cues[2];
  check(sign.an === 7 && sign.pos && near(sign.pos.x, 0.1) && near(sign.pos.y, 0.1), 'ass: \\an7 \\pos scaled by PlayRes');
  check(near(sign.scale, 2) && sign.lines[0][0].b && sign.lines[0][0].c === '#ffff00', 'ass: style size, bold and colour (BGR)');
  eq(text(cues[3]), 'After drawing', 'ass: \\p1 drawing dropped');
  eq(text(cues[4]), 'Soft break and hard space redreset', 'ass: \\n soft break, \\h');
  check(cues[4].lines[0].some((r) => r.text === 'red' && r.c === '#ff0000') && !cues[4].lines[0].find((r) => r.text === 'reset').c, 'ass: \\c colour and \\r reset');
  const legacy = S.parse(fx('legacy.ssa'), 'x.ssa').cues;
  eq(legacy.length, 1, 'ssa: v4 dialogue parsed');
  eq(legacy[0].an, 8, 'ssa: legacy alignment 6 = top centre');
  eq(S.parse(fx('overrides.ass').replace(/\n/g, '\r\n')).cues.length, 5, 'ass: CRLF, detected by content');
}

// ---- Decoding ---------------------------------------------------------------------------
{
  const s = '1\n00:00:01,000 --> 00:00:02,000\nÄpfel, Größe, café — “quotes”\n';
  const utf8 = Buffer.from(s, 'utf8');
  eq(S.decode(utf8), s, 'decode: UTF-8 without BOM');
  eq(S.decode(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), utf8])), s, 'decode: UTF-8 BOM stripped');
  eq(S.decode(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(s, 'utf16le')])), s, 'decode: UTF-16 LE BOM');
  const be = Buffer.from(s, 'utf16le');
  for (let i = 0; i < be.length; i += 2) { const x = be[i]; be[i] = be[i + 1]; be[i + 1] = x; }
  eq(S.decode(Buffer.concat([Buffer.from([0xfe, 0xff]), be])), s, 'decode: UTF-16 BE BOM');
  eq(S.decode(Buffer.from(s, 'utf16le')), s, 'decode: UTF-16 LE without BOM (heuristic)');
  // windows-1252: Ä=C4, ö=F6, ß=DF, é=E9, em dash=97, quotes=93/94
  const cp = Buffer.from('1\n00:00:01,000 --> 00:00:02,000\n\xc4pfel, Gr\xf6\xdfe, caf\xe9 \x97 \x93quotes\x94\n', 'latin1');
  eq(S.decode(cp), s, 'decode: windows-1252 fallback');
  eq(S.parse(new Uint8Array(cp)).cues.map(text), ['Äpfel, Größe, café — “quotes”'], 'parse: bytes in, cp1252 cue out');
}

// ---- Embedded cues ------------------------------------------------------------------------
{
  const a = S.embeddedCue({ start: 1, end: 2, text: '', ass: '12,0,Default,,0,0,0,,{\\an8}Top\\Nline, with comma' });
  check(a && a.an === 8 && text(a) === 'Top\nline, with comma', 'embedded: ffmpeg ASS packet (ReadOrder first)');
  const d = S.embeddedCue({ start: 1, end: 2, ass: 'Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,{\\i1}Old style' });
  check(d && text(d) === 'Old style' && d.lines[0][0].i, 'embedded: full Dialogue line');
  const t = S.embeddedCue({ start: 3, end: 4, text: '<i>plain</i>\r\nsecond' });
  check(t && text(t) === 'plain\nsecond' && t.lines[0][0].i, 'embedded: text with tags');
  eq(S.embeddedCue({ start: 4, end: 4, text: 'x' }), null, 'embedded: zero length dropped');
}

// ---- Cue index -----------------------------------------------------------------------------
{
  const mk = (start, end, t) => ({ start, end, lines: [[{ text: t }]], an: 2, pos: null, scale: 1 });
  // A long cue overlapping many short ones: the running max end must find it.
  const cues = [mk(0, 100, 'long')];
  for (let i = 0; i < 50; i++) cues.push(mk(i * 2, i * 2 + 1, `s${i}`));
  const idx = new S.CueIndex(cues.slice().reverse());
  eq(idx.at(10.5).map(text), ['long', 's5'], 'index: overlapping long + short');
  eq(idx.at(11.5).map(text), ['long'], 'index: only the long cue between shorts');
  eq(idx.at(100).map(text), [], 'index: end is exclusive');
  eq(idx.at(-1).map(text), [], 'index: before the first cue');
  check(!idx.add(mk(10, 11, 's5')), 'index: duplicate (re-delivered after a seek) ignored');
  check(idx.add(mk(10.2, 10.8, 'late')), 'index: new cue inserted');
  eq(idx.at(10.5).map(text), ['long', 's5', 'late'], 'index: inserted cue found, start order');
  // Brute-force comparison on random cues.
  let rnd = 12345;
  const r = () => ((rnd = (rnd * 1664525 + 1013904223) >>> 0) / 4294967296);
  const many = [];
  for (let i = 0; i < 2000; i++) { const s = r() * 1000; many.push(mk(s, s + r() * (r() < 0.05 ? 60 : 4), `c${i}`)); }
  const big = new S.CueIndex(many);
  let same = true;
  for (let k = 0; k < 2000 && same; k++) {
    const t = r() * 1100;
    const want = many.filter((c) => c.start <= t && c.end > t).map(text).sort();
    const got = big.at(t).map(text).sort();
    same = JSON.stringify(want) === JSON.stringify(got);
    if (!same) console.log(t, want, got);
  }
  check(same, 'index: matches brute force on 2000 random cues');
}

console.log(failures ? `\n${failures} failure(s)` : '\nall passed');
process.exit(failures ? 1 : 0);
