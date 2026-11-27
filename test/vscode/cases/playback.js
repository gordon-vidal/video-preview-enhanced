'use strict';
// Playback behaviour in a real VS Code (ported from test/browser tests.js open/*, rate, neighbour, rotation, pill,
// resume, audio, and review1.js autoplay / end of sound / damaged files; docs/notes/test-migration.md).
//   playback        (autoplay off)  open/<fmt>, speed, neighbour files, rotation, pill, resume, damaged and cut files, sound
//   playback_autoplay (autoplay on, loop off)  late first time stamp, sound longer than the picture
//   playback_loop   (autoplay on, loop on)     sound-only loop point
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const lib = require('../lib');

const BASE = { 'videoPreviewEnhanced.advancedMode': true };

// Browser-specific extensions of the Node format matrix (test/engine/formats_cases.js).
// Extended H.264 profiles can use either decoder depending on WebCodecs support.
const FORMATS = [
  ['fmt/h264_high10.mp4', null, true],
  ['fmt/h264_444.mp4', null, true],
  ['fmt/odd_853x479.mkv', 'soft', true],
  ['fmt/vp8_vorbis.webm', 'webcodecs', true],
  ['fmt/h264_ac3.mts', 'webcodecs', true],
  ['fmt/h264_ac3_51.mkv', 'webcodecs', true],
  ['fmt/h264_noaudio.mp4', 'webcodecs', false],
  ['fmt/h264_vfr.mkv', 'webcodecs', false],
];

/** Media-time speed (media seconds per wall second) over samples [{t (wall ms), v (media s)}], loops unwrapped. */
function speed(smp) {
  let adv = 0;
  for (let i = 1; i < smp.length; i++) { const d = smp[i].v - smp[i - 1].v; adv += d < -0.5 ? 0 : d; }
  return adv / ((smp[smp.length - 1].t - smp[0].t) / 1000);
}

module.exports = [{
  name: 'playback',
  settings: { ...BASE, 'videoPreviewEnhanced.autoplay': false },
  async run(vs, h) {
    const R = lib.recorder();

    for (const [name, decoder, sound] of FORMATS) {
      await R.run(`open/${name}`, async (ok, result) => {
        const P = await lib.open(vs, h, lib.clip(name));
        try {
          const r = await P.waitFirstFrame();
          ok(!r.message, `overlay message: "${r.message}" ${r.hint}`);
          result.vmode = r.vmode;
          if (decoder) ok(r.vmode === decoder, `video decoded by ${r.vmode}, expected ${decoder}`);
          ok(r.canvas[0] > 0 && r.canvas[1] > 0 && !r.canvasHidden, `canvas ${r.canvas}`);
          if (r.engine) ok(r.firstShown, 'no frame shown');
          if (sound) ok(r.amode && r.amode !== 'none', `audio not decoded (amode ${r.amode})`);
          P.play();
          const a = await P.state();
          const b = await P.waitState((x) => x.shownCount > a.shownCount + 2 || (!x.engine && x.frame !== a.frame), { timeout: 8000, what: 'frames advancing' });
          ok(b.t !== a.t || b.frame !== a.frame, `frame did not change while playing (${a.frame} -> ${b.frame})`);
        } finally { await P.close(); }
      });
    }

    await R.run('open/audio-only', async (ok) => {
      // Sound plays on without restarting: time runs forward for 2.5 s (the clip is 3 s, loop on by default).
      const P = await lib.open(vs, h, lib.clip('fmt/audio_only.mkv'), { until: (s) => s.engine && s.amode && s.amode !== 'none' });
      try {
        const r0 = await P.state();
        ok(r0.amode && r0.amode !== 'none' && !/could not|failed/i.test(r0.message), `audio mode ${r0.amode}, message "${r0.message}"`);
        P.play();
        await P.waitState((x) => x.playing && x.t > 0, { what: 'sound playing' });
        const smp = await P.sample(2200);
        const back = smp.filter((x, i) => i && x.v < smp[i - 1].v - 0.1 && !(smp[i - 1].v > 2 && x.v < 1)).length;
        ok(back === 0, `time jumped back ${back} times`);
        ok(speed(smp) > 0.2, `time advanced at ${speed(smp).toFixed(2)}x`);
        ok(!smp[smp.length - 1].s.message, `overlay still says "${smp[smp.length - 1].s.message}" while the sound plays`);
      } finally { await P.close(); }
    });

    // Speed 2x / 0.5x / 1.5x: media time runs at that rate (and the sound drives the clock when the AudioContext runs).
    await R.run('rate/speed', async (ok, r) => {
      const P = await lib.open(vs, h, lib.clip('long_20s.mp4'));
      try {
        await P.waitFirstFrame();
        P.play();
        await P.waitState((x) => x.playing && x.t > 0, { what: 'playing before rate changes' });
        for (const rate of [2, 0.5, 1, 1.5]) {
          P.rate(rate);
          await P.waitState((x) => x.rate === rate && x.playing, { what: `rate ${rate} applied` });
          const smp = await P.sample(2600);
          const sp = speed(smp);
          const last = smp[smp.length - 1].s;
          ok(last.rate === rate, `engine rate ${last.rate} != ${rate}`);
          // The rate takes effect (2x runs about twice as fast as 1x). Wide on purpose: a loaded machine skews
          // wall-clock samples, and exact rates are a number for layer 4.
          ok(Math.abs(sp / rate - 1) < 0.35, `${rate}x: media time ran at ${sp.toFixed(3)}x`);
          if (last.ac === 'running') ok(smp.every((x) => x.s.audioMaster), `${rate}x: audio was not the clock for ${smp.filter((x) => !x.s.audioMaster).length}/${smp.length} samples`);
          r[`speed${rate}`] = +sp.toFixed(3);
          r.ac = last.ac;
        }
      } finally { await P.close(); }
    });

    // Shift+N / Shift+P open the next / previous file of the folder; at the ends a toast.
    await R.run('neighbour/next-prev', async (ok) => {
      let P = await lib.open(vs, h, lib.clip('neigh/n2.mp4'));
      await P.waitFirstFrame();
      let from = vs.mark();
      P.key('N', { shift: true });
      await vs.waitLog(/\[n3\.mp4\] webview: first frame shown/, { from, timeout: 30000, what: 'Shift+N opened n3.mp4' });
      await P.close();
      P = await lib.open(vs, h, lib.clip('neigh/n2.mp4'));
      await P.waitFirstFrame();
      from = vs.mark();
      P.key('P', { shift: true });
      await vs.waitLog(/\[n1\.mp4\] webview: first frame shown/, { from, timeout: 30000, what: 'Shift+P opened n1.mp4' });
      await P.close();
      P = await lib.open(vs, h, lib.clip('neigh/n1.mp4'));
      try {
        await P.waitFirstFrame();
        P.key('P', { shift: true });
        const s = await P.waitState((x) => x.toast, { timeout: 5000, what: 'toast' });
        ok(/First video/.test(s.toast), `toast "${s.toast}"`);
      } finally { await P.close(); }
    });

    await R.run('rotation/rotated.mp4', async (ok) => {
      const P = await lib.open(vs, h, lib.clip('rotated.mp4'));
      try {
        const r = await P.waitFirstFrame();
        ok(r.canvas[1] > r.canvas[0], `canvas is ${r.canvas}, expected portrait`);
        if (h.ffmpeg) await P.expectFrame(0, "the picture is ffmpeg's rotated frame 0");
      } finally { await P.close(); }
    });

    await R.run('status/fully-decoded-stable', async (ok, r) => {
      const P = await lib.open(vs, h, lib.clip('s_hevc.mp4'));
      try {
        await P.waitFirstFrame();
        await P.waitState((x) => x.status === 'Fully decoded', { timeout: 25000, what: '"Fully decoded" while paused' });
        const runs = (s) => { const out = []; for (const x of s) if (!out.length || out[out.length - 1] !== x.v) out.push(x.v); return out; };
        const paused = runs(await P.sample(2000, (s) => s.status));
        ok(paused.length === 1, `status changed while paused: ${JSON.stringify(paused)}`);
        P.play();
        const playing = runs(await P.sample(2500, (s) => s.status));
        r.playing = playing;
        ok(playing.length === 1 && playing[0] === 'Fully decoded', `status while playing (no seek): ${JSON.stringify(playing)}`);
        ok(!(await P.state()).notice, 'a notice for a file that plays fine (the bar has no status pill any more)');
      } finally { await P.close(); }
    });

    // Resume: the position is remembered per file (not within the first seconds).
    await R.run('resume/position', async (ok) => {
      const file = lib.clip('long_20s.mp4');
      // This repeated-open correctness check has exceeded the ordinary 15 s first-frame budget.
      // Keep a bounded 30 s state wait (no retry); the wrapper opts out of the ordinary first-frame clamp.
      const openResume = () => lib.open(vs, h, file, {
        until: (s) => lib.pictureOrError(s), timeout: 30000,
      });
      let P = await openResume();
      try {
        await P.waitFirstFrame();
        P.seek(12.25);
        await P.waitState((x) => Math.abs(x.t - 12.25) < 0.1, { timeout: 15000, what: 'seek to 12.25' });
        // No observable signal: the page posts its position to the host at most once a second (and only when it changed),
        // and the host keeps it on dispose. Wait out that tick plus margin.
        await lib.sleep(2500);
        await P.close();
        P = await openResume();
        const s = await P.waitState((x) => x.firstShown && Math.abs(x.t - 12.25) < 0.15, { timeout: 20000, what: 'resumed at 12.25 s' });
        ok(Math.abs(s.t - 12.25) < 0.15, `resumed at ${s.t}`);
        if (h.ffmpeg) await P.expectFrame(Math.floor(12.25 * 30), 'resumed picture');
        P.seek(3);
        await P.waitState((x) => Math.abs(x.t - 3) < 0.1, { timeout: 10000, what: 'seek to 3' });
        await lib.sleep(2500);
        await P.close();
        P = await openResume();
        const z = await P.waitFirstFrame();
        ok(z.t < 1, `resume near the start: t=${z.t}`);
      } finally { await P.close(); }
    });

    // Damaged and cut files.
    for (const name of ['damaged_h264.mkv', 'damaged_h264_b.mkv']) {
      await R.run(`damaged-h264/${name}`, async (ok, r) => {
        // One bad picture (2.5 s of 5): the picture goes on after it.
        const P = await lib.open(vs, h, lib.clip(name));
        try {
          const r0 = await P.waitFirstFrame();
          r.vmode = r0.vmode;
          P.play();
          const end = await P.waitState((x) => x.t > 4 || (!x.playing && x.t > 3), { timeout: 20000, what: 'playback past the damage at 2.5 s' });
          ok(end.shownCount > 60, `only ${end.shownCount} pictures shown by ${end.t.toFixed(2)} s (frozen after the damage?)`);
          await lib.sleep(500);
          const a = await P.state();
          ok(!a.message || !ERR.test(a.message), `error overlay "${a.message}"`);
          r.decoderLines = lib.lines(vs, /VideoDecoder|decoder error|decode error/i, P.fromMark).slice(0, 3);
        } finally { await P.close(); }
      });
    }
    await R.run('truncated/trunc_moov.mp4', async (ok) => {
      // MP4 cut before its index: a clear message, no hang.
      const P = await lib.open(vs, h, lib.clip('trunc_moov.mp4'));
      try {
        const r = await P.waitState((x) => x.message && !/^Opening|^Loading/.test(x.message), { timeout: 25000, what: 'an error message' });
        ok(/could not be opened|damaged|incomplete/i.test(r.message), `expected "could not be opened", got "${r.message}"`);
      } finally { await P.close(); }
    });
    for (const name of ['trunc_faststart.mp4', 'trunc.mkv']) {
      await R.run(`truncated/${name}`, async (ok) => {
        // Cut in the middle of the data: the first half plays.
        const P = await lib.open(vs, h, lib.clip(name));
        try {
          const r = await P.waitFirstFrame();
          ok(!r.message && r.canvas[0] > 0, `overlay "${r.message}", canvas ${r.canvas}`);
          P.play();
          const a = await P.state();
          const b = await P.waitState((x) => x.shownCount > a.shownCount + 5, { timeout: 10000, what: 'frames advancing' });
          ok(b.shownCount > a.shownCount, 'no frames while playing');
        } finally { await P.close(); }
      });
    }

    // Multichannel sound: TrueHD 5.1(side) joined into few buffers with six channels; 7.1 with sound only in the centre mixed to stereo.
    await R.run('audio/truehd-51side', async (ok, r) => {
      const P = await lib.open(vs, h, lib.clip('truehd_51side.mkv'));
      try {
        await P.waitFirstFrame();
        P.play();
        await lib.sleep(2500);
        const s = await P.state();
        r.amode = s.amode; r.ac = s.ac;
        ok(s.audioChannels === 6, `${s.audioChannels} channels`);
        ok(s.audioChunks <= s.audioSeconds * 30, `${s.audioChunks} chunks for ${s.audioSeconds.toFixed(2)} s of sound (one per 40-sample TrueHD frame?)`);
        ok(s.sources < 200, `${s.sources} sources scheduled at once`);
        if (s.ac === 'running') ok(s.audioMaster, 'sound did not drive the clock');
      } finally { await P.close(); }
    });
    await R.run('audio/71-centre-downmix', async (ok) => {
      const P = await lib.open(vs, h, lib.clip('flac_71_centre.mkv'));
      try {
        await P.waitFirstFrame();
        P.play();
        const s = await P.waitState((x) => x.audioChunks >= 3, { timeout: 15000, what: 'sound decoded' });
        ok(s.audioChannels === 2, `${s.audioChannels} channels for WebAudio`);
      } finally { await P.close(); }
    });
    // Seek-bar previews from shown frames (docs/notes/seek-preview.md) cost playback nothing: 4K H.264 plays with the
    // same dropped and late frames with capture off and on; reports what a 4K capture cost the frame loop.
    if (!h.ffmpeg) R.skip('thumbs/capture-4k', 'no ffmpeg (clip generator)');
    else await R.run('thumbs/capture-4k', async (ok, r) => {
      const file = path.join(h.MEDIA, 'cases', 'pb_4k_h264.mp4');
      if (!fs.existsSync(file)) {
        const g = spawnSync(h.ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=3840x2160:rate=30:duration=6',
          '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', file], { windowsHide: true });
        if (g.status !== 0) throw new Error(`making pb_4k_h264.mp4: ${String(g.stderr).slice(0, 300)}`);
      }
      const P = await lib.open(vs, h, file);
      try {
        await P.waitFirstFrame();
        const run = async (on) => {
          await P.ask('capture', { on });
          P.seek(0);
          await P.waitState((x) => !x.seekPending && x.t < 0.1, { timeout: 15000, what: 'at the start' });
          const a = await P.state();
          P.play();
          await P.waitState((x) => x.t >= 3.5, { timeout: 20000, what: 'played 3.5 s' });
          P.pause();
          const b = await P.state();
          return { dropped: b.dropped - a.dropped, late: b.late - a.late, shown: b.shownCount - a.shownCount, strip: b.strip };
        };
        const off = await run(false);
        const on = await run(true);
        r.off = { dropped: off.dropped, late: off.late, shown: off.shown };
        r.on = { dropped: on.dropped, late: on.late, shown: on.shown, captured: on.strip && on.strip.captured };
        r.captureMs = on.strip && on.strip.captureMs;
        ok(on.strip && on.strip.frames >= 5, `played frames became previews (${on.strip && on.strip.frames})`);
        ok(on.dropped <= off.dropped + 3, `no new dropped frames (${off.dropped} off, ${on.dropped} on)`);
        ok(on.late <= off.late + 3, `no new late frames (${off.late} off, ${on.late} on)`);
      } finally { await P.close(); }
    });
    return R.out;
  },
}, {
  name: 'playback_autoplay',
  settings: { ...BASE, 'videoPreviewEnhanced.autoplay': true, 'videoPreviewEnhanced.loop': false },
  async run(vs, h) {
    const R = lib.recorder();
    // A file starting at PTS 3600 s: autoplay starts at once (the clock once started at 0 and the first frame never came due).
    for (const name of ['start3600.mts', 'start3600_mpeg2.mts']) {
      await R.run(`autoplay-late-start/${name}`, async (ok, r) => {
        const P = await lib.open(vs, h, lib.clip(name));
        try {
          await P.waitFirstFrame();
          const smp = await P.sample(1800);
          const sp = speed(smp);
          r.speed = +sp.toFixed(2);
          // Runs (the bug: the clock started at 0 and the first frame never came due), at no absurd rate.
          ok(sp > 0.3 && sp < 3, `media time ran at ${sp.toFixed(2)}x over ${(smp[smp.length - 1].t / 1000).toFixed(1)} s (${smp.map((x) => x.v.toFixed(1))})`);
        } finally { await P.close(); }
      });
    }
    // Sound outlasting the picture plays to its end (loop off); play after the end starts over.
    await R.run('end-of-sound/audio_longer.mp4', async (ok, r) => {
      const P = await lib.open(vs, h, lib.clip('audio_longer.mp4'));
      try {
        await P.waitFirstFrame();
        // Plays until it stops by itself (generous wait, ends as soon as it stops).
        const smp = [];
        for (const w0 = Date.now(); Date.now() - w0 < 30000;) {
          const s = await P.state();
          smp.push({ v: s.t, s });
          if (!s.playing && s.t > 1) break;
        }
        const played = smp.filter((x) => x.s.playing).map((x) => x.v);
        const end = Math.max(...played, smp[smp.length - 1].v);
        r.end = +end.toFixed(2);
        ok(!smp[smp.length - 1].s.playing, 'still playing after 30 s');
        ok(end > 4.4, `stopped at ${end.toFixed(3)} s, the sound runs to 5 s`);
        P.play();
        // Playing and moving on for a moment (a re-pause right after the start must still show).
        const r2 = await P.waitState((x) => x.playing && x.t > 0.3, { timeout: 10000, what: 'play after the end moving on' });
        ok(r2.playing, 'play after the end re-paused');
        ok(r2.t < 1.5, `play after the end continued at ${r2.t.toFixed(3)} s`);
      } finally { await P.close(); }
    });
    return R.out;
  },
}, {
  name: 'playback_loop',
  settings: { ...BASE, 'videoPreviewEnhanced.autoplay': true, 'videoPreviewEnhanced.loop': true },
  async run(vs, h) {
    const R = lib.recorder();
    // Sound only, loop on: the loop comes at the end of the sound, not 1.5 s early.
    await R.run('loop-sound-only/sine_only.mkv', async (ok, r) => {
      const P = await lib.open(vs, h, lib.clip('sine_only.mkv'), { until: (s) => s.engine && s.amode && s.amode !== 'none' && s.playing });
      try {
        // Samples until the loop comes back to the start (generous: ends at the first wrap).
        const ts = [];
        for (const w0 = Date.now(); Date.now() - w0 < 30000;) {
          ts.push((await P.state()).t);
          if (ts.length > 1 && ts[ts.length - 1] < ts[ts.length - 2] - 1) break;
        }
        let wrapAt = null;
        for (let i = 1; i < ts.length; i++) if (ts[i] < ts[i - 1] - 1) { wrapAt = ts[i - 1]; break; }
        ok(wrapAt !== null, `no loop within 30 s (max ${Math.max(...ts).toFixed(2)} s)`);
        if (wrapAt !== null) ok(wrapAt > 4.3, `looped at ${wrapAt.toFixed(3)} s, the sound is 5 s long`);
        r.wrapAt = wrapAt;
      } finally { await P.close(); }
    });
    return R.out;
  },
}];

const ERR = lib.ERR;
