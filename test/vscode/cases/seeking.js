'use strict';
// Frame stepping, seeking and the end of a file in a real VS Code (ported from test/browser step/*, seek/*,
// abloop, review1 step-ms-rounded / end-key / eof-flush; docs/notes/test-migration.md). The picture is
// compared with ffmpeg's decode of the same file (test/vscode/lib.js expectFrame), so "frame 45" means the
// picture of frame 45, not just a counter.
const lib = require('../lib');

// One clip per decode path in VS Code: H.264 (WebCodecs, GPU), HEVC / VP9 / MPEG-2 / ProRes / MPEG-4 (WebAssembly),
// MJPEG AVI (the frame player: JPEG pictures, no engine).
const CLIPS = ['s_h264.mp4', 's_hevc.mp4', 's_vp9.webm', 's_mpeg2.mpg', 's_prores.mov', 's_xvid.avi', 's_mjpeg.avi'];
const SETTINGS = { 'videoPreviewEnhanced.autoplay': false, 'videoPreviewEnhanced.loop': false, 'videoPreviewEnhanced.advancedMode': true };

module.exports = [{
  name: 'seeking',
  settings: SETTINGS,
  async run(vs, h) {
    const R = lib.recorder();
    if (!h.ffmpeg) { R.skip('all', 'no ffmpeg for the reference frames'); return R.out; }

    // Steps go from picture to picture; slot[i] is the frame number of picture i.
    for (const name of CLIPS) {
      await R.run(`step/${name}`, async (ok) => {
        const P = await lib.open(vs, h, lib.clip(name));
        try {
          await P.waitFirstFrame();
          const s0 = await P.expectFrame(0, 'start');
          const slot = await P.slots();
          ok(slot && slot.length > 70, `reference decode gave ${slot && slot.length} frames`);
          const at = (i) => slot[i];
          for (let k = 1; k <= 6; k++) { P.step(1); await P.expectFrame(at(k), `step +1 to ${at(k)}`); }
          for (let k = 5; k >= 2; k--) { P.step(-1); await P.expectFrame(at(k), `step -1 to ${at(k)}`); }
          // Across a GOP (keyframes every 30 frames): seek to slot 28 and step over the mark (a file can leave slots empty).
          const i = slot.filter((x) => x <= 28).length - 1;
          P.seek((slot[i] + 0.5) / (await P.cachedFps()));
          await P.expectFrame(at(i), `seek to ${at(i)}`);
          for (let k = i + 1; k <= i + 5; k++) { P.step(1); await P.expectFrame(at(k), `step +1 to ${at(k)}`); }
          P.step(-1); await P.expectFrame(at(i + 4), `step -1 to ${at(i + 4)}`);
          // Keys too: '.' and ','.
          P.key('.'); await P.expectFrame(at(i + 5), `key . to ${at(i + 5)}`);
          P.key(','); await P.expectFrame(at(i + 4), `key , to ${at(i + 4)}`);
          void s0;
        } finally { await P.close(); }
      });
    }

    // Seeks land on the frame asked for, forward and back, in every decoder; a seek while playing keeps playing.
    for (const name of CLIPS) {
      await R.run(`seek/${name}`, async (ok) => {
        const P = await lib.open(vs, h, lib.clip(name));
        try {
          const s0 = await P.waitFirstFrame();
          const fps = s0.fps || 30;
          for (const k of [45, 70, 10, 85, 59, 60, 0]) {
            P.seek((k + 0.5) / fps);
            await P.expectFrame(k, `seek to frame ${k}`, 15000);
          }
          // Seek while playing: lands near the target and plays on (the clip is 3 s: go to 1.0).
          P.play();
          await P.waitState((x) => x.playing, { what: 'playing' });
          P.seek(1.0);
          const s = await P.waitState((x) => x.playing && x.t >= 1.0, { timeout: 10000, what: 'playing after the seek' });
          ok(s.t < 1.9, `seek while playing went to ${s.t}`);
        } finally { await P.close(); }
      });
    }

    await R.run('open-gop/h264', async (ok) => {
      const P = await lib.open(vs, h, lib.clip('s_h264_opengop.mkv'));
      try {
        const first = await P.waitFirstFrame();
        ok(first.vmode === 'webcodecs', `starts in ${first.vmode}, expected WebCodecs`);
        ok((await P.slots())?.includes(45), 'ffmpeg decoded the target frame');
        // A backward seek has to restart the decoder even when read-ahead has filled the queue.
        P.play();
        const before = await P.waitState((s) => s.frame >= 60, { what: 'a picture past the seek target' });
        ok(before.vmode === 'webcodecs', `played to frame ${before.frame} in ${before.vmode}, expected WebCodecs`);
        P.pause();
        await P.waitState((s) => !s.playing, { what: 'paused' });
        const from = vs.mark();
        P.seek(45.5 / first.fps);
        await vs.waitLog(/\[s_h264_opengop\.mkv\] webview: open-GOP H\.264: no IDR/, { from, timeout: 10000 });
        await P.expectFrame(45, 'picture after the open-GOP seek');
        const after = await P.state();
        ok(after.vmode === 'soft', `seek landed in ${after.vmode}, expected software`);
      } finally { await P.close(); }
    });

    // Millisecond-rounded times (60 fps MKV, NTSC 30000/1001): every step moves exactly one frame, the counter matches the picture.
    for (const [name, g] of [['vp9_60fps.mkv', 60], ['h264_60fps.mkv', 60], ['ntsc_2997.mkv', 30]]) {
      await R.run(`step-ms-rounded/${name}`, async (ok) => {
        const P = await lib.open(vs, h, lib.clip(name));
        try {
          const r0 = await P.waitFirstFrame();
          if (name === 'ntsc_2997.mkv') ok(Math.abs(r0.fps - 30000 / 1001) < 1e-9, `fps ${r0.fps}, expected exactly 30000/1001`);
          await P.expectFrame(0, 'start');
          for (let k = 1; k <= 12; k++) { P.step(1); await P.expectFrame(k, `step +1 to ${k}`); }
          for (let k = 11; k >= 6; k--) { P.step(-1); await P.expectFrame(k, `step -1 to ${k}`); }
          P.seek((g - 2 + 0.5) / r0.fps);
          await P.expectFrame(g - 2, `seek to ${g - 2}`);
          for (let k = g - 1; k <= g + 2; k++) { P.step(1); await P.expectFrame(k, `step +1 to ${k}`); }
          for (let k = g + 1; k >= g - 2; k--) { P.step(-1); await P.expectFrame(k, `step -1 to ${k}`); }
          const s = await P.state();
          ok(s.frameText.startsWith(`#${g - 1}/`), `frame counter "${s.frameText}", expected #${g - 1}/...`);
        } finally { await P.close(); }
      });
    }

    // The end of the file: End shows the last picture even when the sound is longer; seeking past the end and
    // stepping past either end stay on the last / first frame.
    for (const name of ['audio_longer.mp4', 'audio_longer_soft.mkv']) {
      await R.run(`end-key/${name}`, async (ok) => {
        const P = await lib.open(vs, h, lib.clip(name));
        try {
          await P.waitFirstFrame();
          P.key('End');
          await P.expectFrame(59, 'End (last of 60 frames)');
          ok(!(await P.state()).playing, 'playing after End');
        } finally { await P.close(); }
      });
    }
    await R.run('edges/s_h264.mp4', async (ok) => {
      const P = await lib.open(vs, h, lib.clip('s_h264.mp4'));
      try {
        const s0 = await P.waitFirstFrame();
        const last = s0.n - 1;
        ok(last >= 85, `frame count ${s0.n}`);
        P.seek(s0.duration + 5);
        await P.expectFrame(last, 'seek past the end shows the last frame');
        P.step(1);
        await lib.sleep(1000);
        await P.expectFrame(last, 'step +1 at the last frame stays');
        P.seek(((last - 1) + 0.5) / s0.fps);
        await P.expectFrame(last - 1, 'seek to the second last frame');
        P.step(1); await P.expectFrame(last, 'step +1 reaches the last frame');
        P.key('Home'); await P.expectFrame(0, 'Home');
        P.step(-1);
        await lib.sleep(1000);
        await P.expectFrame(0, 'step -1 at the first frame stays');
      } finally { await P.close(); }
    });

    // WebCodecs (VP8 here): the frames still in the decoder at the end are shown; playing to the end stops (loop off).
    await R.run('eof-flush/vp8_2s.webm', async (ok) => {
      const P = await lib.open(vs, h, lib.clip('vp8_2s.webm'));
      try {
        const r0 = await P.waitFirstFrame();
        ok(r0.vmode === 'webcodecs', `VP8 decoded by ${r0.vmode}, expected webcodecs`);
        P.play();
        await P.waitState((x) => !x.playing && x.t > 1, { timeout: 15000, what: 'the end' });
        await P.expectFrame(59, 'last frame at the end');
      } finally { await P.close(); }
    });

    // A-B loop: marks, the loop plays only A..B, clearing both ends it.
    await R.run('abloop/s_h264.mp4', async (ok) => {
      const P = await lib.open(vs, h, lib.clip('s_h264.mp4'));
      try {
        await P.waitFirstFrame();
        P.seek(30.5 / 30); await P.expectFrame(30, 'seek A');
        P.key('a');
        P.seek(60.5 / 30); await P.expectFrame(60, 'seek B');
        P.key('b');
        const s = await P.state();
        ok(/^Loop 0:01\.\d{3} – 0:02\.\d{3}$/.test(s.toast), `toast "${s.toast}"`);
        ok(!s.abMarks.hidden, 'A-B marks hidden');
        P.seek(1.5);
        P.play();
        await P.waitState((x) => x.playing, { what: 'playing' });
        const smp = await P.sample(4500);
        const ts = smp.map((x) => x.v).filter((v) => typeof v === 'number');
        const lo = Math.min(...ts); const hi = Math.max(...ts);
        let wraps = 0;
        for (let i = 1; i < ts.length; i++) if (ts[i] < ts[i - 1] - 0.3) wraps++;
        ok(wraps >= 2, `expected >= 2 wraps back to A in 4.5 s, saw ${wraps} (${ts.map((x) => x.toFixed(2)).join(' ')})`);
        ok(hi < 2.0 + 0.15, `played past B: max ${hi.toFixed(3)} s`);
        ok(lo > 1.0 - 0.1, `went before A: min ${lo.toFixed(3)} s`);
        P.key('a'); P.key('b');
        await lib.sleep(500);
        const s2 = await P.state();
        ok(/A-B loop off/.test(s2.toast), `toast after clearing "${s2.toast}"`);
      } finally { await P.close(); }
    });
    return R.out;
  },
}];
