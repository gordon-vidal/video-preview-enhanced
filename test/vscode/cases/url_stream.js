'use strict';
// Open Video URL (src/urlsource.js, docs/notes/url-stream.md) in a real VS Code, served from 127.0.0.1
// (test/urlserver.js: no internet). The streams are made from one 10 s clip by the local ffmpeg, so
// every picture can be checked against ffmpeg's decode of that clip (lib expectFrame).
//
// url_stream (no ffmpeg for the extension): a direct MP4 (range requests, WebCodecs), HLS VOD with
//   MPEG-TS and fMP4 segments and a master playlist (the built-in decoder reads the segments as one
//   file): first frame, a seek, the picture. DASH and live HLS say they need ffmpeg and offer the
//   setup; a 404 and a web page give a clear error.
// url_stream_native (ffmpeg on PATH): HLS, DASH and an HEVC MP4 play with native ffmpeg (the URL
//   goes to ffmpeg with the network whitelist): first frame, a seek, the picture.
// Parity with MoviPlayer (both): AES-128 HLS (decrypted in the extension host without ffmpeg), the Quality
//   page (Auto, a variant, back to Auto from the same moment), WebVTT subtitle renditions in the CC menu and in
//   time, DRM refused with a clear message, Open Video URL to the Side.
const fs = require('fs');
const os = require('os');
const path = require('path');
const lib = require('../lib');
const urlserver = require('../../urlserver');

const SETTINGS = { 'videoPreviewEnhanced.autoplay': false, 'videoPreviewEnhanced.loop': false };
const STREAMS = path.join(os.tmpdir(), 'vpe_url_streams');

function ffmpegExe(h) {
  const f = h.ffmpeg;
  if (!f) return null;
  return fs.existsSync(f) && fs.statSync(f).isDirectory() ? path.join(f, 'ffmpeg.exe') : f;
}

/** Opens url in a player tab (the test hook skips the input box) and returns a lib.Player named like the tab. */
async function openUrl(vs, h, url, refFile, { until, timeout = 40000 } = {}) {
  const P = new lib.Player(vs, h, refFile);
  P.name = decodeURIComponent(new URL(url).pathname.split('/').pop());
  P.tag = `\\[${lib.esc(P.name)}\\] webview: `;
  P.fromMark = vs.mark();
  vs.send({ openUrl: url });
  const t0 = Date.now();
  for (;;) {
    let s = null;
    try { s = await P.ask('state', {}, 4000); } catch { /* not up yet */ }
    if (s && (until || lib.pictureOrError)(s)) { P.first = s; break; }
    if (Date.now() - t0 > timeout) throw new Error(`${P.name}: nothing within ${timeout / 1000} s${s ? ` (${JSON.stringify(lib.brief(s))})` : ''}`);
    await lib.sleep(300);
  }
  return P;
}

const errorUp = (s) => lib.pictureOrError(s) || /needs native ffmpeg|not found|web page|HTTP \d/.test(s.message || '');

/** First frame, the decoder the log names, a seek to frame k and its picture. */
async function playsAndSeeks(vs, h, ok, url, { decoder, k = 150 }) {
  const P = await openUrl(vs, h, url, path.join(STREAMS, 'src.mp4'));
  try {
    const s0 = P.first;
    ok(s0.firstShown, `first frame shown (message: ${s0.message || '-'})`);
    const dec = lib.lines(vs, new RegExp(`\\[${lib.esc(P.name)}\\] decoder: |\\[${lib.esc(P.name)}\\] decoding with libav`), P.fromMark);
    if (decoder) ok(dec.some((l) => decoder.test(l)), `decoder ${decoder}: ${dec.join(' | ') || 'none logged'}`);
    await P.expectFrame(0, 'first picture', 15000);
    P.seek((k + 0.5) / 30);
    await P.expectFrame(k, `seek to frame ${k}`, 20000);
    P.seek((40 + 0.5) / 30);
    await P.expectFrame(40, 'seek back to frame 40', 20000);
    P.play();
    const s = await P.waitState((x) => x.playing && x.t > 2.0, { timeout: 15000, what: 'playing on' });
    ok(s.t > 2.0, `plays on after the seeks (t=${s.t})`);
    const errs = lib.lines(vs, new RegExp(`\\[${lib.esc(P.name)}\\] (error:|webview: (error:|unhandled rejection))`), P.fromMark);
    ok(!errs.length, `errors: ${errs.slice(0, 2).join(' | ')}`);
  } finally { await P.close(); }
}

async function needsFfmpeg(vs, h, ok, url, what) {
  const P = await openUrl(vs, h, url, path.join(STREAMS, 'src.mp4'), { until: errorUp });
  try {
    const s = P.first;
    ok(/needs native ffmpeg/.test(s.message || ''), `${what}: message "${s.message}"`);
    ok(/Set up ffmpeg/.test(s.action || ''), `${what}: offers the ffmpeg setup (${JSON.stringify(lib.brief(s))})`);
  } finally { await P.close(); }
}

/** Waits for a new page after a reload (quality switch): the first frame again (firstShown was reset). */
async function waitReloaded(P, pred, what, timeout = 40000) {
  return P.waitState((s) => s.firstShown && pred(s), { timeout, what });
}

/**
 * HLS quality (MoviPlayer parity): the ⚙ panel's Quality row lists Auto and the variants; picking 180p reopens
 * the stream at that variant from the same moment (frame 120 = 4.0 s) and keeps playing state; Auto again.
 */
async function quality(vs, h, ok, b, { native = false } = {}) {
  const P = await openUrl(vs, h, `${b}/media/master_full.m3u8`, path.join(STREAMS, 'src.mp4'));
  try {
    ok(P.first.firstShown, `first frame (message: ${P.first.message || '-'})`);
    let s = await P.waitState((x) => !!x.quality, { what: 'quality menu data' });
    const cur = s.quality.variants.find((v) => v.id === s.quality.current);
    ok(s.quality.pick === 'auto' && cur && cur.height === 360, `auto plays 360p in this panel: ${JSON.stringify(s.quality)}`);
    ok(lib.lines(vs, /\[master_full\.m3u8\] url .*2 variants, auto: 640x360.*3 renditions, 1 I-frame playlists/, P.fromMark).length > 0, 'log: the master playlist with its renditions and I-frame playlist');
    await P.ask('click', { sel: '#cog' });
    s = await P.waitState((x) => x.panel && x.panel.view === 'main', { what: 'the ⚙ panel' });
    const row = s.panel && s.panel.rows.find((r) => /^Quality/.test(r.label));
    ok(row && /Auto \(360p\)/.test(row.label), `⚙ row: ${row && row.label}`);
    await P.ask('click', { sel: 'button.row', text: 'Quality' });
    s = await P.waitState((x) => x.panel && x.panel.view === 'quality', { what: 'the Quality page' });
    ok(s.panel && s.panel.view === 'quality' && JSON.stringify(s.tracksMenu.items) === JSON.stringify(['*Auto', '360p', '180p']), `Quality page: ${JSON.stringify(s.tracksMenu.items)} ${s.panel && s.panel.text}`);
    P.seek(120.5 / 30);
    await P.waitState((x) => x.frame === 120, { what: 'frame 120' });
    const mark = vs.mark();
    await P.ask('click', { sel: 'button.radio', text: '180p' });
    await vs.waitLog(/\[master_full\.m3u8\] quality: 320x180 400000 b\/s, reloading/, { from: mark, timeout: 10000, what: 'reload at 180p' });
    s = await waitReloaded(P, (x) => x.quality && x.quality.pick !== 'auto', 'the 180p page');
    const now = s.quality.variants.find((v) => v.id === s.quality.current);
    ok(now && now.height === 180 && s.quality.pick === s.quality.current, `plays 180p: ${JSON.stringify(s.quality)}`);
    s = await P.waitState((x) => Math.abs(x.frame - 120) <= 1, { timeout: 20000, what: 'back at frame 120' });
    ok(Math.abs(s.frame - 120) <= 1 && !s.playing, `same moment after the switch: frame ${s.frame}, playing ${s.playing}`);
    ok(s.canvas[0] === 320 && s.canvas[1] === 180, `the 320x180 picture: ${s.canvas}`);
    if (!native) ok(lib.lines(vs, /\[master_full\.m3u8\] HLS for the built-in decoder: .*variant 320x180/, mark).length > 0, 'built-in decoder reads the 180p variant');
    else ok(lib.lines(vs, /\[master_full\.m3u8\] decoder: native ffmpeg/, mark).length > 0, 'native ffmpeg again');
    // Playing state is kept: play, then back to Auto.
    P.play();
    await P.waitState((x) => x.playing && x.t > 4.3, { what: 'playing at 180p' });
    await P.ask('click', { sel: '#cog' });
    await P.waitState((x) => x.panel && x.panel.view === 'main', { what: 'the ⚙ panel again' });
    await P.ask('click', { sel: 'button.row', text: 'Quality' });
    await P.waitState((x) => x.panel && x.panel.view === 'quality', { what: 'the Quality page again' });
    await P.ask('click', { sel: 'button.radio', text: 'Auto' });
    s = await waitReloaded(P, (x) => x.quality && x.quality.pick === 'auto', 'the Auto page');
    s = await P.waitState((x) => x.playing && x.t > 4.3, { timeout: 20000, what: 'plays on at Auto' });
    ok(s.playing && s.canvas[0] === 640, `Auto again, playing from ${s.t.toFixed(2)} s at ${s.canvas}`);
    const errs = lib.lines(vs, /\[master_full\.m3u8\] (error:|webview: (error:|unhandled rejection))/, P.fromMark);
    ok(!errs.length, `errors: ${errs.slice(0, 2).join(' | ')}`);
  } finally { await P.close(); }
}

/** HLS WebVTT renditions: in the CC menu by name and language, the default one shown in time; switching language. */
async function hlsSubs(vs, h, ok, b) {
  const P = await openUrl(vs, h, `${b}/media/master_full.m3u8`, path.join(STREAMS, 'src.mp4'));
  try {
    await P.waitState((x) => x.tracksMenu && true, { what: 'state' });
    P.seek(3.5);
    let s = await P.waitState((x) => /English cue 3/.test(x.subsText), { timeout: 20000, what: 'the English cue at 3.5 s' });
    ok(s.subsText.trim() === 'English cue 3', `default rendition at 3.5 s: ${JSON.stringify(s.subsText)}`);
    P.seek(3.95);
    s = await P.waitState((x) => Math.abs(x.t - 3.95) < 0.05, { what: 'at 3.95 s' });
    await lib.sleep(300); // a negative window: a late cue must not appear
    s = await P.state();
    ok(!s.subsText, `no cue between 3.9 and 4.1 s: ${JSON.stringify(s.subsText)}`);
    await P.ask('click', { sel: '#tracks' }); // CC: subtitles on -> off (it toggles)
    await P.waitState((x) => x.bar && x.bar.cc === 'Subtitles off', { what: 'subtitles toggled off' });
    await P.ask('click', { sel: '#cog' });
    await P.waitState((x) => x.panel && x.panel.view === 'main', { what: 'the ⚙ panel' });
    await P.ask('click', { sel: 'button.row', text: 'Subtitles' });
    s = await P.waitState((x) => x.panel && x.panel.view === 'subs' && x.tracksMenu.items.length > 1, { what: 'the Subtitles page' });
    ok(JSON.stringify(s.tracksMenu.items) === JSON.stringify(['*Off', 'English', 'Deutsch', 'Load subtitle file…']), `CC menu: ${JSON.stringify(s.tracksMenu.items)}`);
    ok(/German · stream/.test(s.panel.text), `labels name the language and the stream: ${s.panel.text}`);
    await P.ask('click', { sel: 'button.radio', text: 'Deutsch' });
    P.seek(7.5);
    s = await P.waitState((x) => /Deutscher Satz 7/.test(x.subsText), { timeout: 15000, what: 'the German cue at 7.5 s' });
    ok(true, `German at 7.5 s: ${JSON.stringify(s.subsText)}`);
  } finally { await P.close(); }
}

async function withServer(h, fn) {
  const ff = ffmpegExe(h);
  if (!ff || !urlserver.makeStreams(STREAMS, ff)) return false;
  const hevc = path.join(STREAMS, 'hevc_8_1080p.mp4');
  if (!fs.existsSync(hevc)) fs.copyFileSync(path.join(h.MEDIA, 'hevc_8_1080p.mp4'), hevc);
  const srv = await urlserver.start(STREAMS);
  try { await fn(srv); } finally { await srv.close(); }
  return true;
}

module.exports = [{
  name: 'url_stream',
  settings: SETTINGS,
  async run(vs, h) {
    const R = lib.recorder();
    const ran = await withServer(h, async (srv) => {
      const b = srv.base;
      await R.run('mp4_direct', (ok) => playsAndSeeks(vs, h, ok, `${b}/media/src.mp4`, { decoder: /libav|built-in/ }));
      // The new UI for a URL tab: ⚙ has "Open video URL…" and no Compare tool; ⓘ names the host and "stream".
      await R.run('panels', async (ok) => {
        const P = await openUrl(vs, h, `${b}/media/src.mp4`, path.join(STREAMS, 'src.mp4'));
        try {
          await P.ask('click', { sel: '#cog' });
          let s = await P.waitState((x) => x.panel && x.panel.view === 'main', { what: 'the ⚙ panel' });
          const labels = s.panel ? s.panel.rows.map((r) => r.label) : [];
          ok(labels.some((l) => l.includes('Open video URL')), `⚙ has Open video URL…: ${JSON.stringify(labels)}`);
          ok(!labels.includes('Compare') && labels.some((l) => l.includes('Inspection')) && labels.some((l) => l.includes('A–B Range')), `⚙ tools for a URL: ${JSON.stringify(labels)}`);
          // A URL has frames to export but no file to cut: no clip, no ffmpeg command.
          await P.ask('click', { sel: '#panel button', text: 'A–B Range' });
          s = await P.waitState((x) => x.panel && x.panel.view === 'ab', { what: 'the A–B Range page' });
          const ab = s.panel.rows.map((r) => r.label);
          ok(ab.includes('Export frames A–B…') && !ab.some((l) => /Clip|ffmpeg/.test(l)), `A–B Range for a URL: ${JSON.stringify(ab)}`);
          await P.ask('click', { sel: '#cog' });
          await P.ask('click', { sel: '#infoBtn' });
          s = await P.waitState((x) => x.panel && x.panel.view === 'info', { what: 'the ⓘ panel' });
          const host = new URL(b).host;
          ok(s.panel && s.panel.view === 'info' && s.panel.text.includes(`${host} · stream`) && !/MB/.test(s.panel.text.split('Picture')[0]), `ⓘ: ${s.panel && s.panel.text}`);
          await P.ask('click', { sel: '#infoBtn' });
        } finally { await P.close(); }
      });
      await R.run('hls_ts', (ok) => playsAndSeeks(vs, h, ok, `${b}/media/hls_ts/index.m3u8`, { decoder: /libav/ }));
      await R.run('hls_master', async (ok) => {
        await playsAndSeeks(vs, h, ok, `${b}/media/master.m3u8`, { decoder: /libav/ });
        ok(lib.lines(vs, /HLS for the built-in decoder: .*variant 640x360/).length > 0, 'picked the 640x360 variant');
      });
      await R.run('hls_fmp4', (ok) => playsAndSeeks(vs, h, ok, `${b}/media/hls_fmp4/index.m3u8`, { decoder: /libav/ }));
      // MoviPlayer parity: AES-128 decrypted in the extension host, the quality menu, WebVTT renditions, DRM refused, to the side.
      await R.run('hls_aes', async (ok) => {
        await playsAndSeeks(vs, h, ok, `${b}/media/hls_aes/index.m3u8`, { decoder: /libav/ });
        ok(lib.lines(vs, /\[index\.m3u8\] HLS for the built-in decoder: 5 MPEG-TS segments \(AES-128, decrypted here\)/).length > 0, 'decrypted in the host');
      });
      await R.run('hls_quality', (ok) => quality(vs, h, ok, b));
      await R.run('hls_subs', (ok) => hlsSubs(vs, h, ok, b));
      await R.run('hls_drm', async (ok) => {
        const P = await openUrl(vs, h, `${b}/media/hls_ts/fairplay.m3u8`, path.join(STREAMS, 'src.mp4'), { until: (s) => errorUp(s) || /protected/.test(s.message || '') });
        try {
          ok(/protected \(FairPlay\)/.test(P.first.message || ''), `message "${P.first.message}"`);
          ok(/content decryption module/.test(P.first.hint || '') && !P.first.action, `hint "${P.first.hint}", no ffmpeg offer`);
        } finally { await P.close(); }
      });
      await R.run('url_to_side', async (ok) => {
        const mark = vs.mark();
        const P = new lib.Player(vs, h, path.join(STREAMS, 'src.mp4'));
        P.fromMark = mark;
        vs.send({ openUrl: `${b}/media/src.mp4`, where: 'side' });
        try {
          await vs.waitLog(/\[src\.mp4\] URL tab opened \(side\)/, { from: mark, timeout: 15000, what: 'opened to the side' });
          const s = await P.waitFirstFrame(40000);
          ok(s.firstShown, `first frame to the side (message: ${s.message || '-'})`);
        } finally { await P.close(); }
      });
      await R.run('dash_needs_ffmpeg', (ok) => needsFfmpeg(vs, h, ok, `${b}/media/dash/manifest.mpd`, 'DASH'));
      await R.run('hls_live_needs_ffmpeg', (ok) => needsFfmpeg(vs, h, ok, `${b}/media/hls_ts/live.m3u8`, 'live HLS'));
      await R.run('not_found', async (ok) => {
        const P = await openUrl(vs, h, `${b}/media/missing.mp4`, path.join(STREAMS, 'src.mp4'), { until: errorUp });
        try { ok(/not found \(HTTP 404\)/.test(P.first.message || ''), `message "${P.first.message}"`); } finally { await P.close(); }
      });
      await R.run('web_page', async (ok) => {
        const P = await openUrl(vs, h, `${b}/page.html`, path.join(STREAMS, 'src.mp4'), { until: errorUp });
        try { ok(/web page/.test(P.first.message || ''), `message "${P.first.message}"`); } finally { await P.close(); }
      });
    });
    if (!ran) R.skip('all', 'no ffmpeg to make the streams');
    return R.out;
  },
}, {
  name: 'url_stream_native',
  settings: SETTINGS,
  ffmpeg: true,
  async run(vs, h) {
    const R = lib.recorder();
    const ran = await withServer(h, async (srv) => {
      const b = srv.base;
      await R.run('hls_native', (ok) => playsAndSeeks(vs, h, ok, `${b}/media/master.m3u8`, { decoder: /decoder: native ffmpeg/ }));
      await R.run('hls_aes_native', (ok) => playsAndSeeks(vs, h, ok, `${b}/media/hls_aes/index.m3u8`, { decoder: /decoder: native ffmpeg/ }));
      await R.run('hls_quality_native', (ok) => quality(vs, h, ok, b, { native: true }));
      await R.run('hls_subs_native', (ok) => hlsSubs(vs, h, ok, b));
      await R.run('dash_native', (ok) => playsAndSeeks(vs, h, ok, `${b}/media/dash/manifest.mpd`, { decoder: /decoder: native ffmpeg/ }));
      await R.run('hevc_mp4_native', async (ok) => {
        const P = await openUrl(vs, h, `${b}/media/hevc_8_1080p.mp4`, path.join(STREAMS, 'hevc_8_1080p.mp4'));
        try {
          ok(P.first.firstShown, `first frame (message: ${P.first.message || '-'})`);
          ok(lib.lines(vs, /\[hevc_8_1080p\.mp4\] decoder: native ffmpeg/, P.fromMark).length > 0, 'native ffmpeg chosen');
          P.seek(30.5 / 24);
          await P.expectFrame(30, 'seek to frame 30', 20000);
        } finally { await P.close(); }
      });
      // A playlist without #EXT-X-ENDLIST: ffmpeg starts at the live edge; no seeking, LIVE in the time.
      await R.run('hls_live_native', async (ok) => {
        const P = await openUrl(vs, h, `${b}/media/hls_ts/live.m3u8`, path.join(STREAMS, 'src.mp4'));
        try {
          const s = P.first;
          ok(s.firstShown, `first frame (message: ${s.message || '-'})`);
          ok(s.seekDisabled, 'seek bar disabled');
          ok(/LIVE/.test(s.timeText || ''), `time shows LIVE: ${s.timeText}`);
          // The time button doesn't cycle to timecode / frame number for a live stream.
          await P.ask('click', { sel: '#time' });
          await lib.sleep(300); // a negative window: the time text must stay LIVE
          const s2 = await P.state();
          ok(/LIVE/.test(s2.timeText || '') && !/frame/.test(s2.timeText || ''), `after a click on the time: ${s2.timeText}`);
          ok(lib.lines(vs, /\[live\.m3u8\] url .*\(live\)/, P.fromMark).length > 0, 'detected as live');
        } finally { await P.close(); }
      });
      await R.run('mp4_h264_stays_builtin', (ok) => playsAndSeeks(vs, h, ok, `${b}/media/src.mp4`, { decoder: /built-in/ }));
    });
    if (!ran) R.skip('all', 'no ffmpeg to make the streams');
    return R.out;
  },
}, {
  // The same MP4 with decoder "ffmpeg": native ffmpeg on a plain URL (no stream start offset).
  name: 'url_stream_native_mp4',
  settings: { ...SETTINGS, 'videoPreviewEnhanced.decoder': 'ffmpeg' },
  ffmpeg: true,
  async run(vs, h) {
    const R = lib.recorder();
    const ran = await withServer(h, async (srv) => {
      await R.run('mp4_native', (ok) => playsAndSeeks(vs, h, ok, `${srv.base}/media/src.mp4`, { decoder: /decoder: native ffmpeg/ }));
    });
    if (!ran) R.skip('all', 'no ffmpeg to make the streams');
    return R.out;
  },
}];
