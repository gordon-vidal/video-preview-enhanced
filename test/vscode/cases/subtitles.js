'use strict';
// Subtitles and tracks in a real VS Code (ported from test/browser/bitmapsubs.js and test/tracks/browser.js):
//   bitmap/<pgs|dvd|dvb>  picture subtitles chosen in the CC menu, drawn at the right times and places (also
//                         zoomed), cleared at their end, right after seeks and while playing
//   tracks/*              the CC menu lists the file's sound and subtitle tracks, switching the sound keeps the
//                         picture going, embedded SRT and ASS cues show on the overlay, also after seeks
const lib = require('../lib');
const M = require('../../bitmapsubs/make_media');
const media = require('../../media/make_cases_media');

const SETTINGS = { 'videoPreviewEnhanced.autoplay': false, 'videoPreviewEnhanced.advancedMode': true };
const COLORS = { red: [1, 0, 0], green: [0, 1, 0], blue: [0, 0, 1] };

/** The one bitmap of `s` is box e (canvas coordinates) on the displayed video, in its colour; '' when it is. */
function matches(s, e) {
  const rects = s.subpic;
  if (rects.length !== 1) return `${rects.length} bitmaps`;
  const r = rects[0];
  const [vx, vy, vw, vh] = s.video;
  const want = [vx + (e.x / M.W) * vw, vy + (e.y / M.H) * vh, (e.w / M.W) * vw, (e.h / M.H) * vh];
  const off = Math.max(...want.map((v, i) => Math.abs(v - r.box[i])));
  const colour = COLORS[e.color].every((on, k) => (on ? r.mid[k] > 180 : r.mid[k] < 70)) && r.mid[3] === 255;
  if (off > 1.5 || !colour || r.size.join('x') !== `${e.w}x${e.h}`) {
    return `box ${r.box.map((v) => v.toFixed(1))} want ${want.map((v) => v.toFixed(1))}, ${r.size.join('x')}, centre ${r.mid}`;
  }
  return '';
}

module.exports = [{
  name: 'subtitles',
  settings: SETTINGS,
  async run(vs, h) {
    const R = lib.recorder();
    let files;
    try { files = media.bitmapSubs(); } catch (e) { R.skip('bitmap', `no media: ${String(e.message).split('\n')[0]}`); files = null; }

    for (const [kind, codec] of files ? [['pgs', 'hdmv_pgs_subtitle'], ['dvd', 'dvd_subtitle'], ['dvb', 'dvb_subtitle']] : []) {
      await R.run(`bitmap/${kind}`, async (ok) => {
        const P = await lib.open(vs, h, files[kind]);
        try {
          await P.waitFirstFrame();
          const clickMenu = async (sel, text) => {
            const r = await P.ask('click', { sel, text });
            return r;
          };
          P.act({ action: 'panel', view: 'subs' });
          await lib.sleep(300);
          const item = await clickMenu('#panel [role=radio]', codec);
          ok(item.found && !item.disabled, `the picture track ${codec} can be chosen in the Subtitles panel (${JSON.stringify(item)})`);
          P.key('Escape');
          await P.waitState((s) => s.tracks && s.tracks.subId !== null && s.tracks.subId !== undefined, { timeout: 8000, what: 'subtitle track selected' });

          const settle = (want, what) => P.waitState(want, { timeout: 10000, what, interval: 100 });
          // Paused seeks: each box at its time, nothing after its end.
          for (const e of M.EVENTS) {
            P.seek(e.start + 0.5);
            const s = await settle((x) => Math.abs(x.t - (e.start + 0.5)) < 0.15 && x.subpic.length > 0, `${e.color} box after a seek to ${e.start + 0.5}`);
            const bad = matches(s, e);
            ok(!bad, `${e.color} at ${e.start + 0.5} s: ${bad}`);
            P.seek(e.end + 0.3);
            await settle((x) => Math.abs(x.t - (e.end + 0.3)) < 0.15 && !x.subpic.length, `cleared after a seek to ${e.end + 0.3}`);
          }
          // Between two pictures, after a seek backwards across both.
          P.seek(10);
          await settle((x) => Math.abs(x.t - 10) < 0.15, 'seek to 10');
          await lib.sleep(500);
          ok(!(await P.state()).subpic.length, 'nothing at 10 s');

          // Zoomed in: the picture stays on the same part of the video.
          P.seek(13);
          await settle((x) => x.subpic.length > 0, 'blue box at 13 s');
          const blue = M.EVENTS[2];
          const v0 = (await P.state()).video;
          for (let i = 0; i < 4; i++) { P.dom('wheel', v0[0] + v0[2] * 0.7, v0[1] + v0[3] * 0.7, { ctrl: true, deltaY: -200 }); await lib.sleep(120); }
          await settle((x) => x.video[2] > v0[2] * 1.3 && !matches(x, blue), 'blue box follows the zoom');
          P.key('z');
          await settle((x) => Math.abs(x.video[2] - v0[2]) < 1 && !matches(x, blue), 'back to fit');

          // Playing through the end of a picture clears it.
          P.seek(15.2);
          await settle((x) => x.subpic.length > 0, 'blue box at 15.2 s');
          P.play();
          const s = await settle((x) => x.t > 16.25, 'playing past 16 s');
          ok(!s.subpic.length, `cleared while playing (at ${s.t.toFixed(2)} s)`);
          P.pause();
        } finally { await P.close(); }
      });
    }

    // Embedded text subtitles and several sound tracks (tracks_multi.mkv: sound 440 / 660 / 880 Hz, SRT default, ASS "Signs").
    await R.run('tracks/menu-and-cues', async (ok) => {
      const P = await lib.open(vs, h, lib.clip('tracks_multi.mkv'));
      try {
        const r0 = await P.waitFirstFrame();
        ok(r0.firstShown, `first frame (${r0.label})`);
        const tr = (await P.waitState((s) => s.tracks && s.tracks.subId !== null && s.tracks.subId !== undefined, { timeout: 10000, what: 'default subtitle chosen' })).tracks;
        ok(tr.audio.length === 3 && tr.sub.length === 2 && tr.audioId === 1 && tr.subId === 4, `tracks(): audio ${tr.audio.map((a) => a.id)} (on ${tr.audioId}), subs ${tr.sub.map((x) => x.id)} (default ${tr.subId} picked by the UI)`);

        // The Audio track and Subtitles pages of the settings panel.
        P.act({ action: 'panel', view: 'audio' });
        await lib.sleep(300);
        let items = (await P.state()).tracksMenu.items;
        ok(items.some((x) => /^\*\W*English stereo/.test(x)) && items.some((x) => /Deutsch 5\.1/.test(x)), `Audio track panel: ${items.join(' | ')}`);
        P.act({ action: 'panel', view: 'subs' });
        await lib.sleep(300);
        items = (await P.state()).tracksMenu.items;
        ok(items.some((x) => /Signs/.test(x)) && items.some((x) => /^\*/.test(x)), `Subtitles panel: ${items.join(' | ')}`);
        // CC with subtitles: off and on again, no panel.
        P.act({ action: 'panel' });
        await P.ask('click', { sel: '#tracks' });
        let cc = await P.waitState((s) => s.tracks.subId === null, { timeout: 5000, what: 'CC turns subtitles off' });
        ok(cc.panel === null && /Subtitles off/.test(cc.bar.cc), `CC off: panel ${JSON.stringify(cc.panel && cc.panel.view)}, ${cc.bar.cc}`);
        await P.ask('click', { sel: '#tracks' });
        cc = await P.waitState((s) => s.tracks.subId === 4, { timeout: 5000, what: 'CC turns them on again' });
        ok(/Subtitles on/.test(cc.bar.cc), `CC on: ${cc.bar.cc}`);

        // Embedded SRT on the overlay.
        P.pause();
        P.seek(4.6);
        const s1 = await P.waitState((s) => /EN cue 4/.test(s.subsText), { timeout: 10000, what: 'SRT cue at 4.6 s on the overlay' });
        ok(/EN cue 4/.test(s1.subsText), `overlay at 4.6 s: ${JSON.stringify(s1.subsText)}`);

        // Switch the sound through the menu while playing.
        P.play();
        await lib.sleep(800);
        P.act({ action: 'panel', view: 'audio' });
        await lib.sleep(300);
        const before = await P.state();
        await P.ask('click', { sel: '#panel [role=radio]', text: 'Deutsch 5.1' });
        const sw = await P.waitState((s) => s.tracks && s.tracks.audioId === 2 && s.audioChunks > 0, { timeout: 12000, what: 'audio track 2 decoded' });
        ok(sw.audioChannels === 6, `audio switched: ${sw.audioChannels} channels (amode ${sw.amode})`);
        await lib.sleep(1500);
        const after = await P.state();
        ok(after.shownCount - before.shownCount > 20 && after.t > before.t + 1, `picture kept playing: ${after.shownCount - before.shownCount} frames, ${before.t.toFixed(2)} -> ${after.t.toFixed(2)} s`);

        // ASS track via the menu, then seeks to cues (every 3 s from 1 s, 1.5 s long: DE cue 4 at 4-5.5, DE cue 13 at 13-14.5).
        P.act({ action: 'panel', view: 'subs' });
        await lib.sleep(300);
        await P.ask('click', { sel: '#panel [role=radio]', text: 'Signs' });
        P.key('Escape');
        P.pause();
        for (const [t, want] of [[4.6, 'DE cue 4'], [13.5, 'DE cue 13'], [7.2, 'DE cue 7']]) {
          P.seek(t);
          const s = await P.waitState((x) => x.subsText.includes(want), { timeout: 10000, what: `${want} at ${t} s` });
          ok(s.subsText.includes(want), `overlay at ${t} s: ${JSON.stringify(s.subsText)}`);
        }
        const rep = await P.state();
        ok(Math.abs(rep.t - 7.2) < 0.15, `picture at 7.2 s after the seeks (${rep.t})`);
        const bad = lib.lines(vs, /\[tracks_multi\.mkv\] .*(error|exception|failed)/i, P.fromMark).filter((l) => !/Error submitting/.test(l));
        ok(!bad.length, `no error log lines (${bad.slice(0, 3).join(' | ')})`);
        items = null;
      } finally { await P.close(); }
    });
    return R.out;
  },
}];
