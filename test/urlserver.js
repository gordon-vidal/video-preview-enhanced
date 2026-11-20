'use strict';
// A local HTTP server for the URL tests (test/host/url_stream_test.js, test/vscode/cases/url_stream.js):
// 127.0.0.1 only, no internet. Serves files from a folder with HTTP range support, plus a few
// misbehaving routes, and makes small HLS / DASH streams with the local ffmpeg.
//
//   /media/<path>            the file, with ranges (206, 416, Accept-Ranges)
//   /norange/<path>          the whole file, Range ignored (200)
//   /slow/<ms>/<path>        the file after a delay of <ms> before the headers
//   /stall/<path>            headers, then no body (a read timeout)
//   /throttle/<kbps>/<path>  the file (with ranges) sent at <kbps> kilobits per second (HLS "Auto" by rate)
//   /redirect/<n>/<path>     n redirects (302) before /media/<path>
//   /https-to-http           (not served: tests use a fake)
//   /page.html               a web page
//   anything else            404

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const crypto = require('crypto');

const TYPES = { '.mp4': 'video/mp4', '.webm': 'video/webm', '.mkv': 'video/x-matroska', '.m3u8': 'application/vnd.apple.mpegurl', '.mpd': 'application/dash+xml', '.ts': 'video/mp2t', '.m4s': 'video/iso.segment' };

/** Sends buf at kbps kilobits per second (every 50 ms a share). */
function throttled(res, buf, kbps) {
  const step = Math.max(1, Math.round((kbps * 1000) / 8 / 20));
  let off = 0;
  const tick = () => {
    if (res.destroyed) return;
    if (off >= buf.length) { res.end(); return; }
    res.write(buf.subarray(off, off + step));
    off += step;
    setTimeout(tick, 50);
  };
  tick();
}

function start(root, { log } = {}) {
  const hits = [];
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    hits.push({ method: req.method, path: u.pathname, range: req.headers.range || '' });
    if (log) log(`${req.method} ${u.pathname} ${req.headers.range || ''}`);
    const parts = u.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    const send = (rel, { ranges = true, delay = 0, stall = false, kbps = 0 } = {}) => {
      const file = path.join(root, ...rel);
      if (!path.resolve(file).startsWith(path.resolve(root)) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
        res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found'); return;
      }
      const size = fs.statSync(file).size;
      const type = TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
      setTimeout(() => {
        const m = ranges && /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
        if (m) {
          let a = m[1] === '' ? size - Number(m[2]) : Number(m[1]);
          let b = m[1] === '' || m[2] === '' ? size - 1 : Math.min(size - 1, Number(m[2]));
          if (a >= size || a > b) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); res.end(); return; }
          a = Math.max(0, a);
          res.writeHead(206, { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${a}-${b}/${size}`, 'Content-Length': b - a + 1 });
          if (stall) return;
          if (req.method === 'HEAD') { res.end(); return; }
          if (kbps) { throttled(res, fs.readFileSync(file).subarray(a, b + 1), kbps); return; }
          fs.createReadStream(file, { start: a, end: b }).pipe(res);
          return;
        }
        res.writeHead(200, { 'Content-Type': type, 'Content-Length': size, ...(ranges ? { 'Accept-Ranges': 'bytes' } : {}) });
        if (stall) return;
        if (req.method === 'HEAD') { res.end(); return; }
        if (kbps) { throttled(res, fs.readFileSync(file), kbps); return; }
        fs.createReadStream(file).pipe(res);
      }, delay);
    };
    switch (parts[0]) {
      case 'media': return send(parts.slice(1));
      case 'norange': return send(parts.slice(1), { ranges: false });
      case 'slow': return send(parts.slice(2), { delay: Number(parts[1]) || 0 });
      case 'stall': return send(parts.slice(1), { stall: true });
      case 'throttle': return send(parts.slice(2), { kbps: Number(parts[1]) || 1000 });
      case 'redirect': {
        const n = Number(parts[1]) || 0;
        const rest = parts.slice(2).map(encodeURIComponent).join('/');
        res.writeHead(302, { Location: n > 1 ? `/redirect/${n - 1}/${rest}` : `/media/${rest}` });
        res.end();
        return undefined;
      }
      case 'page.html':
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<!DOCTYPE html><html><body>not a video</body></html>');
        return undefined;
      default:
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('not found');
        return undefined;
    }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        port, base: `http://127.0.0.1:${port}`, hits, server,
        close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
      });
    });
  });
}

/**
 * Makes the test streams in dir with ffmpeg (once; kept when present):
 *   src.mp4 (10 s, 640x360 H.264 30 fps, 1 s GOP, AAC), hls_ts/index.m3u8, hls_fmp4/index.m3u8,
 *   master.m3u8 (two variants: hls_ts and a 320x180 one), dash/manifest.mpd, live.m3u8 (no ENDLIST).
 * Returns null when ffmpeg is missing or fails.
 */
function makeStreams(dir, ffmpeg = 'ffmpeg') {
  fs.mkdirSync(dir, { recursive: true });
  const run = (args, cwd = dir) => spawnSync(ffmpeg, ['-hide_banner', '-v', 'error', '-y', ...args], { cwd, windowsHide: true, encoding: 'utf8' });
  const done = path.join(dir, 'done.txt');
  if (fs.existsSync(done)) return makeParity(dir);
  const src = ['-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=10', '-f', 'lavfi', '-i', 'sine=f=440:d=10:sample_rate=48000',
    '-c:v', 'libx264', '-preset', 'veryfast', '-g', '30', '-keyint_min', '30', '-sc_threshold', '0', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '96k', '-shortest'];
  let r = run([...src, 'src.mp4']);
  if (r.status !== 0) return null;
  for (const d of ['hls_ts', 'hls_fmp4', 'hls_small', 'dash']) fs.mkdirSync(path.join(dir, d), { recursive: true });
  const steps = [
    [['-i', '../src.mp4', '-c', 'copy', '-f', 'hls', '-hls_time', '2', '-hls_playlist_type', 'vod', '-hls_segment_filename', 'seg%03d.ts', 'index.m3u8'], 'hls_ts'],
    [['-i', '../src.mp4', '-c', 'copy', '-f', 'hls', '-hls_time', '2', '-hls_playlist_type', 'vod', '-hls_segment_type', 'fmp4', '-hls_fmp4_init_filename', 'init.mp4', '-hls_segment_filename', 'seg%03d.m4s', 'index.m3u8'], 'hls_fmp4'],
    [['-i', '../src.mp4', '-vf', 'scale=320:180', '-c:v', 'libx264', '-preset', 'veryfast', '-g', '30', '-c:a', 'copy', '-f', 'hls', '-hls_time', '2', '-hls_playlist_type', 'vod', '-hls_segment_filename', 'seg%03d.ts', 'index.m3u8'], 'hls_small'],
    [['-i', '../src.mp4', '-map', '0:v', '-map', '0:a', '-c', 'copy', '-f', 'dash', '-seg_duration', '2', '-use_template', '1', '-use_timeline', '1', 'manifest.mpd'], 'dash'],
  ];
  for (const [args, sub] of steps) {
    r = run(args, path.join(dir, sub));
    if (r.status !== 0) { console.error(`makeStreams ${sub}: ${r.stderr}`); return null; }
  }
  fs.writeFileSync(path.join(dir, 'master.m3u8'), [
    '#EXTM3U', '#EXT-X-VERSION:3',
    '#EXT-X-STREAM-INF:BANDWIDTH=400000,RESOLUTION=320x180', 'hls_small/index.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=1500000,RESOLUTION=640x360', 'hls_ts/index.m3u8', '',
  ].join('\n'));
  // A "live" playlist: the VOD one without its end (only its detection is tested).
  const vod = fs.readFileSync(path.join(dir, 'hls_ts', 'index.m3u8'), 'utf8');
  fs.writeFileSync(path.join(dir, 'hls_ts', 'live.m3u8'), vod.replace(/#EXT-X-ENDLIST\s*/, '').replace(/#EXT-X-PLAYLIST-TYPE:VOD\s*/, ''));
  // A text manifest named like a video (security review #1): must still be refused for files.
  fs.copyFileSync(path.join(dir, 'dash', 'manifest.mpd'), path.join(dir, 'manifest_named.mp4'));
  fs.writeFileSync(done, new Date().toISOString());
  return makeParity(dir);
}

/** The AES-128 key of the encrypted fixtures (made here, never a secret). */
const TEST_KEYS = [
  crypto.createHash('sha256').update('vpe test key 1').digest().subarray(0, 16),
  crypto.createHash('sha256').update('vpe test key 2').digest().subarray(0, 16),
];
const TEST_IV2 = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex');

/** The subtitle cue the fixtures show at second k (0-9) of the clip, per language. */
const CUE_TEXT = { en: (k) => `English cue ${k}`, de: (k) => `Deutscher Satz ${k}` };

/**
 * The MoviPlayer-parity fixtures (docs/notes/url-stream.md), made from the HLS segments above (kept when present):
 *   master_full.m3u8   the two variants of master.m3u8 with SUBTITLES renditions (WebVTT, English default + German),
 *                      a muxed AUDIO rendition and an I-frame playlist
 *   subs/<lang>/index.m3u8 + seg<k>.vtt  2 s WebVTT segments with X-TIMESTAMP-MAP at the clip's first timestamp;
 *                      cue k from k + 0.1 s to k + 0.9 s (CUE_TEXT)
 *   hls_aes/index.m3u8 hls_ts's segments encrypted with AES-128-CBC (Node crypto): segments 0-2 with key.bin and the
 *                      IV from the media sequence (starts at 7), 3-4 with key2.bin and an explicit IV
 *   master_aes.m3u8    hls_small + hls_aes
 *   hls_ts/sample_aes.m3u8, hls_ts/fairplay.m3u8  DRM-protected playlists (only the message is tested)
 */
function makeParity(dir) {
  const mark = path.join(dir, 'parity2.txt');
  if (fs.existsSync(mark)) return dir;
  const tsDir = path.join(dir, 'hls_ts');
  const segs = fs.readdirSync(tsDir).filter((n) => /^seg\d+\.ts$/.test(n)).sort();
  const start = require('../src/urlsource').streamStart(fs.readFileSync(path.join(tsDir, segs[0])));
  const mpegts = Math.round((start || 0) * 90000);
  const stamp = (t) => `00:00:${t < 10 ? '0' : ''}${t.toFixed(3)}`;
  for (const lang of Object.keys(CUE_TEXT)) {
    const d = path.join(dir, 'subs', lang);
    fs.mkdirSync(d, { recursive: true });
    const pl = ['#EXTM3U', '#EXT-X-TARGETDURATION:2', '#EXT-X-PLAYLIST-TYPE:VOD'];
    for (let s = 0; s < 5; s++) {
      const cues = [];
      for (let k = 2 * s; k < 2 * s + 2; k++) cues.push(`${stamp(k + 0.1)} --> ${stamp(k + 0.9)}`, CUE_TEXT[lang](k), '');
      fs.writeFileSync(path.join(d, `seg${s}.vtt`), ['WEBVTT', `X-TIMESTAMP-MAP=MPEGTS:${mpegts},LOCAL:00:00:00.000`, '', ...cues].join('\n'));
      pl.push('#EXTINF:2.0,', `seg${s}.vtt`);
    }
    pl.push('#EXT-X-ENDLIST', '');
    fs.writeFileSync(path.join(d, 'index.m3u8'), pl.join('\n'));
  }
  const iframes = fs.readFileSync(path.join(tsDir, 'index.m3u8'), 'utf8').replace('#EXT-X-VERSION:3', '#EXT-X-VERSION:4\n#EXT-X-I-FRAMES-ONLY');
  fs.writeFileSync(path.join(tsDir, 'iframes.m3u8'), iframes);
  fs.writeFileSync(path.join(dir, 'master_full.m3u8'), [
    '#EXTM3U', '#EXT-X-VERSION:4',
    '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",LANGUAGE="en",DEFAULT=YES,AUTOSELECT=YES,URI="subs/en/index.m3u8"',
    '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="Deutsch",LANGUAGE="de",DEFAULT=NO,AUTOSELECT=YES,URI="subs/de/index.m3u8"',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="Main",LANGUAGE="en",DEFAULT=YES,AUTOSELECT=YES',
    '#EXT-X-STREAM-INF:BANDWIDTH=400000,RESOLUTION=320x180,CODECS="avc1.64000d,mp4a.40.2",AUDIO="aud",SUBTITLES="subs"', 'hls_small/index.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=1500000,RESOLUTION=640x360,CODECS="avc1.64001e,mp4a.40.2",AUDIO="aud",SUBTITLES="subs"', 'hls_ts/index.m3u8',
    '#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=90000,RESOLUTION=640x360,CODECS="avc1.64001e",URI="hls_ts/iframes.m3u8"', '',
  ].join('\n'));
  // AES-128.
  const aesDir = path.join(dir, 'hls_aes');
  fs.mkdirSync(aesDir, { recursive: true });
  fs.writeFileSync(path.join(aesDir, 'key.bin'), TEST_KEYS[0]);
  fs.writeFileSync(path.join(aesDir, 'key2.bin'), TEST_KEYS[1]);
  const SEQ = 7;
  const pl = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:2', `#EXT-X-MEDIA-SEQUENCE:${SEQ}`, '#EXT-X-PLAYLIST-TYPE:VOD', '#EXT-X-KEY:METHOD=AES-128,URI="key.bin"'];
  segs.forEach((n, i) => {
    let key = TEST_KEYS[0];
    let iv = Buffer.alloc(16);
    iv.writeUInt32BE(SEQ + i, 12);
    if (i === 3) pl.push(`#EXT-X-KEY:METHOD=AES-128,URI="key2.bin",IV=0x${TEST_IV2.toString('hex')}`);
    if (i >= 3) { key = TEST_KEYS[1]; iv = TEST_IV2; }
    const c = crypto.createCipheriv('aes-128-cbc', key, iv);
    fs.writeFileSync(path.join(aesDir, `seg${i}.ts`), Buffer.concat([c.update(fs.readFileSync(path.join(tsDir, n))), c.final()]));
    pl.push('#EXTINF:2.000000,', `seg${i}.ts`);
  });
  pl.push('#EXT-X-ENDLIST', '');
  fs.writeFileSync(path.join(aesDir, 'index.m3u8'), pl.join('\n'));
  fs.writeFileSync(path.join(dir, 'master_aes.m3u8'), [
    '#EXTM3U', '#EXT-X-VERSION:3',
    '#EXT-X-STREAM-INF:BANDWIDTH=400000,RESOLUTION=320x180', 'hls_small/index.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=1500000,RESOLUTION=640x360', 'hls_aes/index.m3u8', '',
  ].join('\n'));
  // DRM: only the refusal is tested.
  const one = (keyLine) => `#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-PLAYLIST-TYPE:VOD\n${keyLine}\n#EXTINF:2,\nseg000.ts\n#EXT-X-ENDLIST\n`;
  fs.writeFileSync(path.join(tsDir, 'sample_aes.m3u8'), one('#EXT-X-KEY:METHOD=SAMPLE-AES,URI="key.bin",KEYFORMAT="identity"'));
  fs.writeFileSync(path.join(tsDir, 'fairplay.m3u8'), one('#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://content-id",KEYFORMAT="com.apple.streamingkeydelivery",KEYFORMATVERSIONS="1"'));
  fs.writeFileSync(mark, new Date().toISOString());
  return dir;
}

module.exports = { start, makeStreams, makeParity, TEST_KEYS, CUE_TEXT };
