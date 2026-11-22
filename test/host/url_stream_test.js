'use strict';
// node test/host/url_stream_test.js: Open Video URL (src/urlsource.js, docs/notes/url-stream.md) against a
// local HTTP server (test/urlserver.js, 127.0.0.1, no internet) with streams made by the local ffmpeg.
//   - URL checks (http/https only), the ffmpeg input arguments (network whitelist for URLs only)
//   - range reads, a server without ranges, 404, redirects, a slow and a stalled server
//   - HLS as one file (MPEG-TS, fMP4, byte ranges, master playlist), live / encrypted / DASH need ffmpeg
//   - ffprobe over a URL; a remote playlist can't make ffmpeg read local files; file inputs still
//     refuse manifests (security review 2026-11-19 #1)
//   - the extension: the command takes no URL from its arguments or the page, a URL panel reads its
//     blocks over HTTP, DASH without ffmpeg says so, HLS with ffmpeg goes native.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const us = require('../../src/urlsource');
const ff = require('../../src/ffmpeg');
const urlserver = require('../urlserver');
const { load, webviewConfig } = require('./mock_vscode');

const STREAMS = path.join(os.tmpdir(), 'vpe_url_streams');
const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { windowsHide: true }).status === 0;
let passed = 0;
const check = (name, fn) => Promise.resolve().then(fn).then(() => { passed++; }, (e) => { e.message = `${name}: ${e.message}`; throw e; });

async function rejects(p, re, what) {
  try { await p; } catch (e) { assert.ok(re.test(e.message), `${what}: "${e.message}" should match ${re}`); return e; }
  throw new Error(`${what}: did not fail`);
}

(async () => {
  // ---- URL checks ----
  await check('checkUrl', () => {
    for (const bad of ['', '   ', 'javascript:alert(1)', 'file:///C:/Windows/win.ini', 'ftp://x/y.mp4', 'data:video/mp4;base64,AAAA', 'vscode://x/y',
      'https://user:pw@example.com/a.mp4', 'https://exa mple.com/a.mp4', 'https://example.com/a\n.mp4', `https://example.com/${'a'.repeat(5000)}`, 'not a url', '\\\\server\\share\\a.mp4', 'smb://server/a.mp4']) {
      assert.ok(us.checkUrl(bad).error, `refused: ${JSON.stringify(bad).slice(0, 60)}`);
    }
    assert.strictEqual(us.checkUrl('  https://Example.com/v.mp4?sig=1#t=3 ').url, 'https://example.com/v.mp4?sig=1');
    assert.strictEqual(us.checkUrl('http://127.0.0.1:8080/x.m3u8').url, 'http://127.0.0.1:8080/x.m3u8');
    assert.strictEqual(us.redact('https://h.com/a/b.mp4?token=secret'), 'https://h.com/a/b.mp4?…');
    assert.strictEqual(us.displayName('https://h.com/a/my%20clip.mp4?x=1'), 'my clip.mp4');
  });

  await check('inputArgs', () => {
    assert.deepStrictEqual(ff.inputArgs('C:\\v\\a.mp4'), ['-protocol_whitelist', 'file', '-i', 'C:\\v\\a.mp4']);
    const a = ff.inputArgs({ url: 'https://h.com/a.m3u8' });
    const wl = a[a.indexOf('-protocol_whitelist') + 1].split(',');
    assert.ok(!wl.includes('file') && !wl.includes('concat') && !wl.includes('subfile') && !wl.includes('data'), `no local protocols: ${wl}`);
    for (const p of ['http', 'https', 'tcp', 'tls', 'crypto']) assert.ok(wl.includes(p), `${p} allowed`);
    assert.deepStrictEqual(a.slice(-2), ['-i', 'https://h.com/a.m3u8']);
    assert.ok(ff.inputArgs({ url: 'https://h.com/a.mp4', proxy: 'http://proxy:3128' }).join(' ').includes('-http_proxy http://proxy:3128'));
    for (const bad of ['file:///etc/passwd', 'concat:a|b', '-i', 'https://h.com/a b']) assert.throws(() => ff.inputArgs({ url: bad }), `refused url input ${bad}`);
    assert.throws(() => ff.inputArgs({}), /no input/);
  });

  await check('parseM3u8', () => {
    const pl = us.parseM3u8('#EXTM3U\n#EXT-X-MAP:URI="init.mp4",BYTERANGE="700@0"\n#EXTINF:2,\n#EXT-X-BYTERANGE:1000@700\nall.mp4\n#EXTINF:2,\n#EXT-X-BYTERANGE:500\nall.mp4\n#EXT-X-ENDLIST\n', 'https://h.com/v/x.m3u8');
    assert.deepStrictEqual(pl.map, { url: 'https://h.com/v/init.mp4', range: { len: 700, start: 0 }, key: null });
    assert.deepStrictEqual(pl.segments.map((s) => s.range), [{ len: 1000, start: 700 }, { len: 500, start: 1700 }]);
    assert.ok(!pl.live);
    assert.ok(us.parseM3u8('#EXTM3U\n#EXTINF:2,\na.ts\n', 'https://h.com/').live, 'no ENDLIST: live');
    const enc = us.parseM3u8('#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:5\n#EXT-X-KEY:METHOD=AES-128,URI="k"\n#EXTINF:2,\na.ts\n#EXT-X-KEY:METHOD=NONE\n#EXTINF:2,\nb.ts\n#EXT-X-ENDLIST\n', 'https://h.com/v/');
    assert.ok(enc.encrypted && !enc.drm, 'AES-128 is not DRM');
    assert.deepStrictEqual(enc.segments.map((x) => [x.seq, x.key && x.key.uri]), [[5, 'https://h.com/v/k'], [6, null]], 'keys and media sequence per segment');
    assert.strictEqual(us.parseM3u8('#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="k"\n#EXTINF:2,\na.ts\n', 'https://h.com/').drm, 'SAMPLE-AES');
    assert.strictEqual(us.parseM3u8('#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://x",KEYFORMAT="com.apple.streamingkeydelivery"\n#EXTINF:2,\na.ts\n', 'https://h.com/').drm, 'FairPlay');
    assert.strictEqual(us.parseM3u8('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="k",KEYFORMAT="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"\n#EXTINF:2,\na.ts\n', 'https://h.com/').drm, 'Widevine');
    const full = us.parseM3u8([
      '#EXTM3U', '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="s",NAME="English",LANGUAGE="en",DEFAULT=YES,AUTOSELECT=YES,URI="en.m3u8"',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="Deutsch",LANGUAGE="de",URI="de/a.m3u8"', '#EXT-X-SESSION-KEY:METHOD=SAMPLE-AES,URI="skd://k",KEYFORMAT="com.apple.streamingkeydelivery"',
      '#EXT-X-STREAM-INF:BANDWIDTH=800000,AVERAGE-BANDWIDTH=700000,RESOLUTION=640x360,FRAME-RATE=29.970,CODECS="avc1.4d401e,mp4a.40.2",AUDIO="a",SUBTITLES="s"', 'sd.m3u8',
      '#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=80000,RESOLUTION=640x360,URI="sd_i.m3u8"', '',
    ].join('\n'), 'https://h.com/m/');
    assert.deepStrictEqual(full.variants[0], { url: 'https://h.com/m/sd.m3u8', bandwidth: 800000, avgBandwidth: 700000, width: 640, height: 360, codecs: 'avc1.4d401e,mp4a.40.2', frameRate: 29.97, audio: 'a', subtitles: 's' });
    assert.deepStrictEqual(full.media.map((x) => [x.type, x.group, x.name, x.lang, x.default, x.url]), [['SUBTITLES', 's', 'English', 'en', true, 'https://h.com/m/en.m3u8'], ['AUDIO', 'a', 'Deutsch', 'de', false, 'https://h.com/m/de/a.m3u8']]);
    assert.deepStrictEqual(full.iframes, [{ url: 'https://h.com/m/sd_i.m3u8', bandwidth: 80000, width: 640, height: 360, codecs: '' }]);
    assert.strictEqual(full.drm, 'FairPlay', 'a session key names DRM');
    // "Auto": the picture size (smallest that covers it), the measured rate (80 %), the decoder's cap.
    const V = [[426, 240, 400e3], [640, 360, 800e3], [1280, 720, 2.5e6], [1920, 1080, 5e6], [3840, 2160, 16e6]].map(([w, h, bw]) => ({ width: w, height: h, bandwidth: bw }));
    const auto = (o) => us.chooseVariant(V, o).height;
    assert.strictEqual(auto({ maxHeight: 1080 }), 1080, 'no view: the best up to the cap');
    assert.strictEqual(auto({ maxHeight: 4320 }), 2160);
    assert.strictEqual(auto({ maxHeight: 4320, view: { w: 1280, h: 1000 } }), 720, 'a 1280 px wide player shows 720 lines');
    assert.strictEqual(auto({ maxHeight: 4320, view: { w: 1920, h: 1080 } }), 1080);
    assert.strictEqual(auto({ maxHeight: 4320, view: { w: 2200, h: 1400 } }), 2160, '1238 lines shown: 2160 covers it');
    assert.strictEqual(auto({ maxHeight: 1080, view: { w: 3840, h: 2160 } }), 1080, 'none covers it under the cap: the largest');
    assert.strictEqual(auto({ maxHeight: 4320, view: { w: 3840, h: 2160 }, throughput: 4e6 }), 720, 'rate 4 Mb/s: at most 3.2 Mb/s');
    assert.strictEqual(auto({ maxHeight: 4320, throughput: 100e3 }), 240, 'too slow for all: the lowest');
    assert.strictEqual(auto({ maxHeight: 4320, view: { w: 300, h: 200 } }), 240);
    // Subtitle segments joined in player time: cue + MPEGTS / 90000 - LOCAL - start.
    const vtt = us.joinVtt([
      'WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:900000,LOCAL:00:00:00.000\n\n00:00:01.000 --> 00:00:02.500 line:90%\nOne\n\n00:00:03.000 --> 00:00:04.000\nTwo',
      'WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:900000,LOCAL:00:00:00.000\n\n00:00:03.000 --> 00:00:04.000\nTwo\n\nNOTE skip\n\n00:01:05.250 --> 00:01:06.000\n<i>Three</i>',
    ], 10);
    assert.strictEqual(vtt, 'WEBVTT\n\n00:00:01.000 --> 00:00:02.500 line:90%\nOne\n\n00:00:03.000 --> 00:00:04.000\nTwo\n\n00:01:05.250 --> 00:01:06.000\n<i>Three</i>\n');
    assert.ok(us.joinVtt(['WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:180000,LOCAL:00:00:00.000\n\n00:00:01.000 --> 00:00:02.000\nA'], 0).includes('00:00:03.000 --> 00:00:04.000'), 'shifted by the map');
    assert.ok(us.joinVtt(['WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:180000,LOCAL:00:00:00.000\n\n00:00:01.000 --> 00:00:02.000\nA'], null).includes('00:00:01.000 --> 00:00:02.000'), 'no start: as written');
    const m = us.parseM3u8('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=9000000,RESOLUTION=3840x2160\n4k.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1920x1080\nhd.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360\nsd.m3u8\n', 'https://h.com/');
    assert.strictEqual(us.pickVariant(m.variants, 1080).url, 'https://h.com/hd.m3u8');
    assert.strictEqual(us.pickVariant(m.variants.slice(0, 1), 1080).url, 'https://h.com/4k.m3u8', 'only too-large ones: the smallest');
    assert.strictEqual(us.kindOf('https://h.com/x', 'text/html', Buffer.from('<!DOCTYPE html>')), 'html');
    assert.strictEqual(us.kindOf('https://h.com/x.mp4', 'video/mp4', Buffer.from('\0\0\0 ftypisom')), 'media');
    assert.strictEqual(us.kindOf('https://h.com/x', '', Buffer.from('<?xml version="1.0"?>\n<MPD type="static">')), 'dash');
    assert.ok(us.dashLive('<MPD type="dynamic">') && !us.dashLive('<MPD type="static">'));
  });

  if (!hasFfmpeg) { console.log(`url stream: ${passed} checks ok; server tests skipped (no ffmpeg on PATH)`); return; }
  assert.ok(urlserver.makeStreams(STREAMS), 'streams made with ffmpeg');
  // A playlist with byte ranges into one file, an encrypted one, and one that points at a local file.
  const segs = fs.readdirSync(path.join(STREAMS, 'hls_ts')).filter((n) => /^seg\d+\.ts$/.test(n)).sort();
  const segBufs = segs.map((n) => fs.readFileSync(path.join(STREAMS, 'hls_ts', n)));
  fs.writeFileSync(path.join(STREAMS, 'hls_ts', 'all.ts'), Buffer.concat(segBufs));
  let off = 0;
  const br = ['#EXTM3U', '#EXT-X-VERSION:4', '#EXT-X-TARGETDURATION:2', '#EXT-X-PLAYLIST-TYPE:VOD'];
  for (const b of segBufs) { br.push('#EXTINF:2.0,', `#EXT-X-BYTERANGE:${b.length}@${off}`, 'all.ts'); off += b.length; }
  br.push('#EXT-X-ENDLIST', '');
  fs.writeFileSync(path.join(STREAMS, 'hls_ts', 'byterange.m3u8'), br.join('\n'));
  fs.writeFileSync(path.join(STREAMS, 'hls_ts', 'enc.m3u8'), '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXTINF:2,\nseg000.ts\n#EXT-X-ENDLIST\n');
  const local = path.join(STREAMS, 'src.mp4').replace(/\\/g, '/');
  fs.writeFileSync(path.join(STREAMS, 'evil.m3u8'), `#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXTINF:10,\nfile:///${local.replace(/^\//, '')}\n#EXT-X-ENDLIST\n`);

  const srv = await urlserver.start(STREAMS);
  const b = srv.base;
  const src = fs.readFileSync(path.join(STREAMS, 'src.mp4'));
  try {
    await check('range reads', async () => {
      const info = await us.inspect(`${b}/media/src.mp4`);
      assert.strictEqual(info.kind, 'media');
      assert.strictEqual(info.size, src.length);
      assert.ok(info.rangeOk);
      const f = new us.HttpFile(info);
      for (const [pos, len] of [[0, 100], [5, 70000], [65530, 4 << 20], [src.length - 10, 100], [src.length + 5, 10]]) {
        const got = await f.read(pos, len);
        assert.ok(got.equals(src.subarray(pos, Math.min(src.length, pos + len))), `bytes ${pos}+${len}`);
      }
      const hits = srv.hits.filter((x) => x.path === '/media/src.mp4');
      assert.ok(hits.every((x) => /^bytes=\d+-\d+$/.test(x.range)), 'every request is a range request');
    });

    await check('no range support', async () => {
      const info = await us.inspect(`${b}/norange/src.mp4`);
      assert.ok(!info.rangeOk);
      const f = new us.HttpFile(info);
      const got = await f.read(300000, 500000);
      assert.ok(got.equals(src.subarray(300000, 800000)), 'bytes from the whole download');
      f.close();
      assert.throws(() => new us.HttpFile({ ...info, size: us.MAX_WHOLE + 1 }), /range requests/);
    });

    await check('404', () => rejects(us.inspect(`${b}/media/missing.mp4`), /not found \(HTTP 404\)/, '404'));
    await check('redirects', async () => {
      const info = await us.inspect(`${b}/redirect/3/src.mp4`);
      assert.strictEqual(info.url, `${b}/media/src.mp4`, 'final URL after redirects');
      await rejects(us.inspect(`${b}/redirect/9/src.mp4`), /too many redirects/, 'redirect loop');
    });
    await check('slow and stalled servers', async () => {
      const t0 = Date.now();
      const info = await us.inspect(`${b}/slow/400/src.mp4`, { timeoutMs: 3000 });
      assert.ok(info.size === src.length && Date.now() - t0 >= 380, 'a slow answer is waited for');
      await rejects(us.inspect(`${b}/slow/2000/src.mp4`, { timeoutMs: 500 }), /did not answer within/, 'no headers in time');
      await rejects(us.fetchRange(`${b}/stall/src.mp4`, 0, 999, { timeoutMs: 500 }), /did not answer within|closed/, 'no body in time');
      await rejects(us.inspect('http://127.0.0.1:1/x.mp4', { timeoutMs: 2000 }), /refused the connection/, 'nothing listening');
    });
    await check('web page', async () => assert.strictEqual((await us.inspect(`${b}/page.html`)).kind, 'html'));

    await check('HLS as one file', async () => {
      for (const [p, want] of [['hls_ts/index.m3u8', Buffer.concat(segBufs)], ['hls_ts/byterange.m3u8', Buffer.concat(segBufs)], ['master.m3u8', Buffer.concat(segBufs)]]) {
        const info = await us.inspect(`${b}/media/${p}`);
        assert.strictEqual(info.kind, 'hls', p);
        assert.strictEqual(await us.hlsLive(info), false, `${p} is VOD`);
        const h = await new us.HlsFile(info).open();
        assert.strictEqual(h.size, want.length, `${p} size`);
        assert.ok(Math.abs(h.duration - 10) < 0.5, `${p} duration ${h.duration}`);
        for (const [pos, len] of [[0, 188 * 10], [segBufs[0].length - 100, 300], [12345, 4 << 20], [want.length - 50, 100]]) {
          assert.ok((await h.read(pos, len)).equals(want.subarray(pos, Math.min(want.length, pos + len))), `${p} bytes ${pos}+${len}`);
        }
      }
      const info = await us.inspect(`${b}/media/hls_fmp4/index.m3u8`);
      const h = await new us.HlsFile(info).open();
      const dir = path.join(STREAMS, 'hls_fmp4');
      const want = Buffer.concat(['init.mp4', ...fs.readdirSync(dir).filter((n) => /\.m4s$/.test(n)).sort()].map((n) => fs.readFileSync(path.join(dir, n))));
      assert.ok(h.fmp4 && h.size === want.length, 'fMP4: init segment + fragments');
      assert.ok((await h.read(0, h.size)).equals(want), 'fMP4 bytes');
    });

    await check('needs ffmpeg', async () => {
      for (const [p, re] of [['hls_ts/live.m3u8', /live HLS/]]) {
        const info = await us.inspect(`${b}/media/${p}`);
        const e = await rejects(new us.HlsFile(info).open(), re, p);
        assert.ok(e.needsFfmpeg, `${p}: NeedsFfmpeg`);
      }
      assert.strictEqual((await us.inspect(`${b}/media/dash/manifest.mpd`)).kind, 'dash');
    });

    await check('DRM refused', async () => {
      for (const [p, re] of [['hls_ts/sample_aes.m3u8', /protected \(SAMPLE-AES\)/], ['hls_ts/fairplay.m3u8', /protected \(FairPlay\)/]]) {
        const info = await us.inspect(`${b}/media/${p}`);
        assert.ok((await us.hlsOpen(info)).drm, p);
        const e = await rejects(new us.HlsFile(info).open(), re, p);
        assert.ok(e.protected && !e.needsFfmpeg, `${p}: Protected`);
      }
      assert.ok(!srv.hits.some((x) => /hls_ts\/key\.bin$/.test(x.path)), 'no key fetched for DRM');
    });

    await check('HLS AES-128', async () => {
      const plain = Buffer.concat(segBufs);
      const before = srv.hits.length;
      const info = await us.inspect(`${b}/media/hls_aes/index.m3u8`);
      const h = await new us.HlsFile(info).open();
      assert.ok(h.encrypted, 'encrypted');
      assert.strictEqual(h.size, plain.length, 'plain size from the padding');
      assert.ok((await h.read(0, h.size)).equals(plain), 'whole file decrypted (two keys, IV from the sequence and explicit)');
      for (const [pos, len] of [[1, 15], [17, 33], [segBufs[0].length - 7, 30], [segBufs[0].length + segBufs[1].length + segBufs[2].length - 5, 100], [plain.length - 3, 10], [123457, 999999]]) {
        assert.ok((await h.read(pos, len)).equals(plain.subarray(pos, Math.min(plain.length, pos + len))), `bytes ${pos}+${len}`);
      }
      const keyHits = srv.hits.slice(before).filter((x) => /key2?\.bin$/.test(x.path));
      assert.strictEqual(keyHits.length, 2, `each key fetched once: ${keyHits.map((x) => x.path)}`);
      // Through a master playlist, chosen explicitly.
      const m = await us.inspect(`${b}/media/master_aes.m3u8`);
      const plan = await us.hlsOpen(m, {}, { pick: 1 });
      assert.ok(!plan.auto && plan.variant.height === 360 && plan.playlist.encrypted && !plan.drm);
      assert.ok((await (await new us.HlsFile(plan).open()).read(0, 4096)).equals(plain.subarray(0, 4096)));
      // A wrong key: the padding check says so; a key that isn't http(s) is not fetched.
      const dir = path.join(STREAMS, 'hls_aes');
      const pl = fs.readFileSync(path.join(dir, 'index.m3u8'), 'utf8');
      fs.writeFileSync(path.join(dir, 'wrong.m3u8'), pl.replace('URI="key.bin"', 'URI="key2.bin"'));
      await rejects(new us.HlsFile(await us.inspect(`${b}/media/hls_aes/wrong.m3u8`)).open(), /could not be decrypted|not an AES/, 'wrong key');
      fs.writeFileSync(path.join(dir, 'datakey.m3u8'), pl.replace('URI="key.bin"', 'URI="data:application/octet-stream;base64,AAAAAAAAAAAAAAAAAAAAAA=="'));
      await rejects(new us.HlsFile(await us.inspect(`${b}/media/hls_aes/datakey.m3u8`)).open(), /not an http\(s\) URL/, 'data: key');
      fs.writeFileSync(path.join(dir, 'filekey.m3u8'), pl.replace('URI="key.bin"', `URI="file:///${path.join(dir, 'key.bin').replace(/\\/g, '/')}"`));
      await rejects(new us.HlsFile(await us.inspect(`${b}/media/hls_aes/filekey.m3u8`)).open(), /not an http\(s\) URL/, 'file: key');
    });

    await check('HLS master: variants, renditions, subtitles', async () => {
      const info = await us.inspect(`${b}/media/master_full.m3u8`);
      const plan = await us.hlsOpen(info, {}, { view: { w: 1280, h: 720 } });
      assert.strictEqual(plan.variants.length, 2);
      assert.strictEqual(plan.master.media.length, 3);
      assert.strictEqual(plan.master.iframes.length, 1);
      assert.ok(plan.auto && plan.variant.height === 360, `auto: ${plan.variant.height}`);
      const small = await us.hlsOpen(info, {}, { view: { w: 320, h: 180 } });
      assert.strictEqual(small.variant.height, 180, 'a small player: the small variant');
      const h = await new us.HlsFile(plan).open();
      const start = us.streamStart(await h.read(0, 256 * 1024));
      assert.ok(Math.abs(start - 1.4453) < 0.01, `stream start ${start}`);
      const subs = await us.hlsSubtitles(plan, {}, { start });
      assert.deepStrictEqual(subs.map((x) => [x.name, x.lang, x.default, !!x.error]), [['English', 'en', true, false], ['Deutsch', 'de', false, false]]);
      const en = subs[0].text;
      for (let k = 0; k < 10; k++) assert.ok(en.includes(`00:00:0${k}.100 --> 00:00:0${k}.900\nEnglish cue ${k}`), `cue ${k} in player time: ${en.slice(0, 200)}`);
      assert.ok(subs[1].text.includes('Deutscher Satz 9'));
      // The fMP4 timeline start (tfdt / timescale).
      const f = await new us.HlsFile(await us.inspect(`${b}/media/hls_fmp4/index.m3u8`)).open();
      const fs0 = us.streamStart(await f.read(0, 256 * 1024));
      assert.ok(fs0 !== null && fs0 >= 0 && fs0 < 3, `fMP4 start ${fs0}`);
    });

    await check('HLS auto by measured rate', async () => {
      // A second server (another host:port: rates are kept per server) sending at 1200 kb/s: 1.5 Mb/s does not fit.
      const slow = await urlserver.start(STREAMS);
      try {
        const info = await us.inspect(`${slow.base}/throttle/1200/master.m3u8`);
        const t0 = Date.now();
        const plan = await us.hlsOpen(info, {});
        assert.ok(plan.throughput > 600e3 && plan.throughput < 1500e3, `measured ${plan.throughput}`);
        assert.strictEqual(plan.variant.height, 180, `slow server: the small variant (${plan.variant.height})`);
        assert.ok(Date.now() - t0 < 15000);
        // Remembered for the server: no second measurement.
        const n = slow.hits.length;
        const again = await us.hlsOpen(info, {});
        assert.strictEqual(again.variant.height, 180);
        assert.ok(slow.hits.length - n <= 1, 'the rate is reused');
        const pick = await us.hlsOpen(info, {}, { pick: 1 });
        assert.ok(!pick.auto && pick.variant.height === 360, 'a pick wins over the rate');
      } finally { await slow.close(); }
    });

    await check('ffprobe over URLs', async () => {
      const t = { ffprobe: 'ffprobe', ffmpeg: 'ffmpeg' };
      for (const [p, fmt] of [['src.mp4', /mp4/], ['master.m3u8', /hls/], ['dash/manifest.mpd', /dash/]]) {
        const pr = await ff.probe(t, { url: `${b}/media/${p}` });
        assert.ok(fmt.test(pr.formatName), `${p}: ${pr.formatName}`);
        assert.strictEqual(pr.video.width, 640, `${p}: the largest variant`);
        assert.ok(pr.audio, `${p}: sound`);
      }
      // The quality choice: ffprobe takes the streams of that variant (HLS variant_bitrate).
      const small = await ff.probe(t, { url: `${b}/media/master.m3u8`, variant: { bandwidth: 400000 } });
      assert.strictEqual(small.video.width, 320, 'the chosen variant');
      const big = await ff.probe(t, { url: `${b}/media/master.m3u8` });
      // ffprobe lists 0 video 320x180, 1 its sound, 2 video 640x360, 3 its sound.
      assert.deepStrictEqual([small.video.index, small.audio.index, big.video.index, big.audio.index], [0, 1, 2, 3], 'each variant with its own sound');
      // AES-128 HLS also plays with native ffmpeg (its crypto protocol, whitelisted).
      assert.strictEqual((await ff.probe(t, { url: `${b}/media/hls_aes/index.m3u8` })).video.width, 640, 'AES-128 with ffmpeg');
      // A remote playlist that lists a local file: the URL whitelist has no `file`.
      await rejects(ff.probe(t, { url: `${b}/media/evil.m3u8` }), /ffprobe failed/, 'remote playlist -> local file');
      // File inputs: a manifest named like a video is still refused before ffprobe runs (security #1).
      await rejects(ff.probe(t, path.join(STREAMS, 'manifest_named.mp4')), /text playlist or manifest/, 'file manifest');
      // And a local playlist given as a file can't fetch http (file-only whitelist).
      const pl = path.join(STREAMS, 'remote_named.mkv');
      fs.writeFileSync(pl, Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from(`\n#EXTM3U\n#EXTINF:2,\n${b}/media/hls_ts/seg000.ts\n`)]));
      const before = srv.hits.length;
      await ff.probe(t, pl).catch(() => null);
      assert.strictEqual(srv.hits.length, before, 'a file input never reaches the network');
    });

    // ---- the extension (mock VS Code) ----
    await check('extension', async () => {
      const panels = [];
      const setup = (vscode, inputs) => {
        vscode.window.createWebviewPanel = (viewType, title, show) => {
          const posted = [];
          const listeners = {};
          const panel = {
            viewType, title, show, visible: true, active: true, viewColumn: 1, posted,
            webview: {
              options: null, html: '', cspSource: 'vscode-resource:',
              asWebviewUri: (u) => ({ toString: () => `https://webview/${u.path}` }),
              postMessage: (m) => { posted.push(m); return Promise.resolve(true); },
              onDidReceiveMessage: (fn) => { listeners.msg = fn; },
            },
            onDidDispose: (fn) => { listeners.dispose = fn; },
            onDidChangeViewState: () => {},
            reveal() {},
            dispose() { if (listeners.dispose) listeners.dispose(); },
            send: (m) => listeners.msg(m.type === 'ready'
                ? { page: webviewConfig(panel.webview).page, boot: 'mock-document', ...m } : m),
          };
          panels.push(panel);
          return panel;
        };
        vscode.window.showInputBox = async (o) => { inputs.boxes.push(o); return inputs.next.shift(); };
        vscode.window.showQuickPick = async (items) => { inputs.picks.push(items); return inputs.pick.shift(); };
        vscode.env.clipboard.readText = async () => inputs.clipboard;
        vscode.window.createOutputChannel = () => { const ch = { lines: [], appendLine(l) { this.lines.push(l); }, show() {}, dispose() {} }; inputs.out = ch; return ch; };
      };
      const until = async (pred, ms = 15000) => { const t0 = Date.now(); while (!pred()) { if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 10)); } };

      // The command ignores arguments: nothing opens without the input box.
      let inputs = { next: [undefined], pick: [], boxes: [], picks: [], clipboard: `${b}/media/src.mp4` };
      let h = load({ settings: { 'videoPreviewEnhanced.decoder': 'builtin' }, setup: (v) => setup(v, inputs) });
      await h.vscode._commands['videoPreviewEnhanced.openUrl']('https://attacker.example/x.m3u8');
      assert.strictEqual(panels.length, 0, 'no panel from a command argument');
      assert.strictEqual(inputs.boxes[0].value, `${b}/media/src.mp4`, 'the clipboard URL pre-fills the box');
      assert.ok(inputs.boxes[0].validateInput('file:///x.mp4'), 'the box refuses file:');

      // Typed URL: a panel; blocks over HTTP with the built-in decoder.
      inputs.next.push(`${b}/media/src.mp4`);
      await h.vscode._commands['videoPreviewEnhanced.openUrl']();
      assert.strictEqual(panels.length, 1);
      const p = panels[0];
      assert.strictEqual(p.viewType, 'videoPreviewEnhanced.url');
      assert.strictEqual(p.title, 'src.mp4');
      assert.ok(/"url":{"host":"127\.0\.0\.1:\d+"}/.test(p.webview.html) && /"net":true/.test(p.webview.html), 'page config marks a URL player');
      await p.send({ type: 'ready', origin: 'vscode-webview://abc' });
      await until(() => p.posted.some((m) => m.type === 'libav' || m.type === 'error'));
      const meta = p.posted.find((m) => m.type === 'libav');
      assert.ok(meta, `libav meta posted: ${JSON.stringify(p.posted.find((m) => m.type === 'error'))}`);
      assert.strictEqual(meta.meta.size, src.length);
      const { page } = webviewConfig(p.webview);
      await p.send({ type: 'readBlock', page, pos: 4 << 20 >> 4, len: 1 << 20 });
      const blk = p.posted.find((m) => m.type === 'block');
      assert.strictEqual(blk.page, page);
      assert.ok(Buffer.from(blk.data).equals(src.subarray(262144, 262144 + (1 << 20))), 'block bytes over HTTP');
      // File-only features say so instead of acting.
      await p.send({ type: 'copyLink', frame: 3, t: 0.1 });
      assert.ok(p.posted.some((m) => m.type === 'toast' && /files only/.test(m.text)), 'frame link refused for URLs');
      // The page's "Open video URL…" only opens the input box (a URL in the message is ignored).
      inputs.pick.push(undefined); // the recent list is shown first; dismissed
      await p.send({ type: 'openUrl', url: 'https://attacker.example/x.mp4' });
      assert.strictEqual(panels.length, 1, 'no panel from a page message');
      assert.deepStrictEqual(h.context.globalState.get(us.RECENT_KEY), [`${b}/media/src.mp4`], 'recent URLs');

      // DASH with the built-in decoder: needs ffmpeg, with the reason.
      inputs.pick.push({ label: 'new' }); // "Enter a URL…" from the recent list
      inputs.next.push(`${b}/media/dash/manifest.mpd`);
      await h.vscode._commands['videoPreviewEnhanced.openUrl']();
      const d = panels[1];
      await d.send({ type: 'ready', origin: 'vscode-webview://abd' });
      await until(() => d.posted.some((m) => m.type === 'error'));
      const err = d.posted.find((m) => m.type === 'error');
      assert.ok(/DASH stream needs native ffmpeg/.test(err.message) && /builtin/.test(err.hint), JSON.stringify(err));
      // HLS VOD (MPEG-TS) with the built-in decoder: the segments as one file.
      inputs.pick.push({ label: 'new' });
      inputs.next.push(`${b}/media/hls_ts/index.m3u8`);
      await h.vscode._commands['videoPreviewEnhanced.openUrl']();
      const hp = panels[2];
      await hp.send({ type: 'ready', origin: 'vscode-webview://abe' });
      await until(() => hp.posted.some((m) => m.type === 'libav' || m.type === 'error'));
      assert.strictEqual(hp.posted.find((m) => m.type === 'libav').meta.size, Buffer.concat(segBufs).length);
      assert.ok(!hp.posted.some((m) => m.type === 'stream'), 'one media playlist: no quality menu');

      // To the side / in a new window: the same input box, then ViewColumn.Beside / moveEditorToNewWindow.
      inputs.pick.push({ label: 'new' });
      inputs.next.push(`${b}/media/hls_aes/index.m3u8`);
      await h.vscode._commands['videoPreviewEnhanced.openUrlToSide']('https://attacker.example/x.m3u8');
      const side = panels[3];
      assert.strictEqual(side.show.viewColumn, h.vscode.ViewColumn.Beside, 'to the side');
      // AES-128 HLS with the built-in decoder: decrypted bytes, the key not in any message.
      await side.send({ type: 'ready', origin: 'vscode-webview://abg' });
      await until(() => side.posted.some((m) => m.type === 'libav' || m.type === 'error'));
      assert.strictEqual((side.posted.find((m) => m.type === 'libav') || {}).meta.size, Buffer.concat(segBufs).length, JSON.stringify(side.posted.find((m) => m.type === 'error')));
      await side.send({ type: 'readBlock', page: webviewConfig(side.webview).page, pos: 0, len: 1 << 20 });
      await until(() => side.posted.some((m) => m.type === 'block'));
      assert.ok(Buffer.from(side.posted.find((m) => m.type === 'block').data).equals(Buffer.concat(segBufs).subarray(0, 1 << 20)), 'decrypted block');
      const keyHex = urlserver.TEST_KEYS.map((k) => k.toString('hex'));
      const sent = JSON.stringify(side.posted.map((m) => (m.data ? { ...m, data: Buffer.from(m.data).toString('hex') } : m))) + side.webview.html;
      assert.ok(keyHex.every((k) => !sent.includes(k)) && !/key2?\.bin/.test(sent), 'the key and its URL never reach the page');
      const logText = inputs.out.lines.join('\n');
      assert.ok(/AES-128, decrypted here/.test(logText), 'log names the decryption');
      assert.ok(keyHex.every((k) => !logText.includes(k)) && !/key2?\.bin/.test(logText), 'the key and its URL are not logged');
      inputs.pick.push({ label: 'new' });
      inputs.next.push(`${b}/media/src.mp4`);
      h.vscode.executed = [];
      await h.vscode._commands['videoPreviewEnhanced.openUrlInNewWindow']();
      assert.strictEqual(panels.length, 5);
      assert.ok(h.vscode.executed.some(([id]) => id === 'workbench.action.moveEditorToNewWindow'), `moved to a new window: ${JSON.stringify(h.vscode.executed)}`);
      // DRM: a clear message, for either decoder.
      inputs.pick.push({ label: 'new' });
      inputs.next.push(`${b}/media/hls_ts/fairplay.m3u8`);
      await h.vscode._commands['videoPreviewEnhanced.openUrl']();
      const drm = panels[5];
      await drm.send({ type: 'ready', origin: 'vscode-webview://abh' });
      await until(() => drm.posted.some((m) => m.type === 'error'));
      const de = drm.posted.find((m) => m.type === 'error');
      assert.ok(/protected \(FairPlay\)/.test(de.message) && /ffmpeg can't play it either/.test(de.hint), JSON.stringify(de));

      // A master playlist: the quality menu ('stream'), the WebVTT renditions as subtitles, a pick reloads at that variant.
      inputs.pick.push({ label: 'new' });
      inputs.next.push(`${b}/media/master_full.m3u8`);
      await h.vscode._commands['videoPreviewEnhanced.openUrl']();
      const mp = panels[6];
      await mp.send({ type: 'ready', origin: 'vscode-webview://abi', view: { w: 1280, h: 720 } });
      await until(() => mp.posted.some((m) => m.type === 'subs') || mp.posted.some((m) => m.type === 'error'));
      const q = mp.posted.find((m) => m.type === 'stream');
      assert.ok(q && q.quality.pick === 'auto' && q.quality.variants.length === 2 && q.quality.variants[q.quality.current].height === 360, JSON.stringify(q));
      const sm = mp.posted.find((m) => m.type === 'subs');
      assert.deepStrictEqual(sm.files.map((f) => [f.title, f.lang, f.auto, f.stream]), [['English', 'en', true, true], ['Deutsch', 'de', false, true]]);
      assert.ok(Buffer.from(sm.files[0].data).toString('utf8').includes('00:00:03.100 --> 00:00:03.900\nEnglish cue 3'), 'English cues in player time');
      const subHits = srv.hits.filter((x) => /\/subs\//.test(x.path)).length;
      const html0 = mp.webview.html;
      await mp.send({ type: 'quality', pick: 99 });
      await mp.send({ type: 'quality', pick: 'x' });
      assert.strictEqual(mp.webview.html, html0, 'a bad pick is ignored');
      mp.posted.length = 0;
      await mp.send({ type: 'quality', pick: 0 });
      assert.notStrictEqual(mp.webview.html, html0, 'a pick reloads the page');
      await mp.send({ type: 'ready', origin: 'vscode-webview://abi', view: { w: 1280, h: 720 } });
      await until(() => mp.posted.some((m) => m.type === 'subs') || mp.posted.some((m) => m.type === 'error'));
      const q2 = mp.posted.find((m) => m.type === 'stream');
      assert.ok(q2 && q2.quality.pick === 0 && q2.quality.variants[q2.quality.current].height === 180, JSON.stringify(q2));
      assert.ok(mp.posted.find((m) => m.type === 'libav').meta.size < Buffer.concat(segBufs).length, 'the small variant plays');
      assert.strictEqual(srv.hits.filter((x) => /\/subs\//.test(x.path)).length, subHits, 'subtitles kept, not fetched again');
      for (const x of panels) x.dispose();
      h.dispose();

      // With ffmpeg (decoder auto): HLS goes to native ffmpeg with the URL.
      inputs = { next: [`${b}/media/master.m3u8`], pick: [], boxes: [], picks: [], clipboard: '' };
      panels.length = 0;
      h = load({ settings: { 'videoPreviewEnhanced.ffmpegPath': 'ffmpeg' }, env: { VPE_LOG: '' }, setup: (v) => setup(v, inputs) });
      await h.vscode._commands['videoPreviewEnhanced.openUrl']();
      const n = panels[0];
      await n.send({ type: 'ready', origin: 'vscode-webview://abf' });
      await until(() => n.posted.some((m) => m.type === 'libav' || m.type === 'error'), 40000);
      const nm = n.posted.find((m) => m.type === 'libav');
      assert.ok(nm && nm.meta.native, `native: ${JSON.stringify(n.posted.filter((m) => m.type === 'error' || m.type === 'libav'))}`);
      n.dispose();
      h.dispose();
    });
  } finally {
    await srv.close();
  }
  console.log(`url stream: ${passed} checks ok`);
})().catch((e) => { console.error(e); process.exit(1); });
