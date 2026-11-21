'use strict';
// Scopes (W: waveform, parade, vectorscope, histogram) and A-B frame export / save frame in a real VS Code
// (ported from test/browser/scopes_export.js and the saveFrame test).
//   scopes/*   a 75 % colour-bar clip (BT.709): luma and RGB levels of each bar, vectorscope targets, W cycle
//   export/*   A-B frames to a folder (the test hook replaces the folder dialog with VPE_EXPORT_DIR): names, that
//              each PNG is the right frame, gapped video, a player hidden behind another tab
//   saveFrame  S writes a PNG of the shown frame (VPE_SAVE_DIR replaces the save dialog)
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const lib = require('../lib');

const EXPORT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vpe-export-'));
const SAVE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vpe-save-'));
const SETTINGS = { 'videoPreviewEnhanced.autoplay': false, 'videoPreviewEnhanced.advancedMode': true };
const BAR_NAMES = ['white', 'yellow', 'cyan', 'green', 'magenta', 'red', 'blue', 'black'];

const pngSize = (f) => { const b = fs.readFileSync(f); return [b.readUInt32BE(16), b.readUInt32BE(20)]; };
const emptyDir = (d) => { for (const f of fs.readdirSync(d)) fs.rmSync(path.join(d, f), { force: true, recursive: true }); };

module.exports = [{
  name: 'scopes_export',
  settings: SETTINGS,
  env: { VPE_EXPORT_DIR: EXPORT_DIR, VPE_SAVE_DIR: SAVE_DIR },
  async run(vs, h) {
    const R = lib.recorder();
    const dump = (P) => P.ask('scopesDump');
    const waitDump = async (P, pred, what) => {
      const t0 = Date.now();
      for (;;) {
        const d = await dump(P);
        if (pred(d)) return d;
        if (Date.now() - t0 > 10000) throw new Error(`timeout: ${what}; last ${JSON.stringify({ mode: d.mode, w: d.w })}`);
        await lib.sleep(250);
      }
    };
    const checkVector = (ok, r) => {
      for (const tg of r.vec.targets) ok(tg.share > 0.1, `${tg.name} target (${tg.x.toFixed(0)}, ${tg.y.toFixed(0)}) holds ${(tg.share * 100).toFixed(1)} % of the samples`);
      ok(r.vec.centre > 0.2, `centre holds ${(r.vec.centre * 100).toFixed(1)} %`);
      const sum = r.vec.targets.reduce((s, x) => s + x.share, 0) + r.vec.centre;
      ok(sum > 0.9, `targets and centre hold ${(sum * 100).toFixed(1)} %`);
    };

    await R.run('scopes/waveform-bars', async (ok) => {
      const P = await lib.open(vs, h, lib.clip('bars75_709.mp4'));
      try {
        await P.waitFirstFrame();
        await lib.sleep(300);
        P.key('w');
        const a = await waitDump(P, (d) => d.wave, 'waveform analysis');
        ok(a.mode === 'waveform' && !a.hidden, `W did not open the waveform (${a.mode}, hidden ${a.hidden})`);
        ok(a.w === 256 && a.h === 144 && a.matrix === 709, `sample grid ${a.w}x${a.h}, BT.${a.matrix}`);
        const code = (v) => Math.round(16 + 219 * v);
        const nominal = [[1, 1, 1], [0.75, 0.75, 0], [0, 0.75, 0.75], [0, 0.75, 0], [0.75, 0, 0.75], [0.75, 0, 0], [0, 0, 0.75], [0, 0, 0]]
          .map(([r, g, b]) => code(0.2126 * r + 0.7152 * g + 0.0722 * b));
        const got = a.wave.map((l) => (l.length === 1 ? l[0] : NaN));
        got.forEach((v, i) => ok(Math.abs(v - nominal[i]) <= 5, `${BAR_NAMES[i]} bar at ${v}, nominal ${nominal[i]} (levels ${a.wave[i]})`));
        // Parade (W again): R, G, B of each bar at 16 or near 75 % (180) / 100 % (235).
        P.key('w');
        const b = await waitDump(P, (d) => d.parade, 'parade analysis');
        const want = [[1, 1, 1], [1, 1, 0], [0, 1, 1], [0, 1, 0], [1, 0, 1], [1, 0, 0], [0, 0, 1], [0, 0, 0]];
        for (let ch = 0; ch < 3; ch++) {
          b.parade[ch].forEach((l, i) => {
            const hi = i === 0 ? 235 : 180;
            ok(l.length === 1 && Math.abs(l[0] - (want[i][ch] ? hi : 16)) <= 6, `parade ${'RGB'[ch]} of ${BAR_NAMES[i]}: ${l}`);
          });
        }
        // W cycles on: vectorscope, histogram, off (panel hidden), waveform.
        const modes = [];
        for (let i = 0; i < 4; i++) { P.key('w'); await lib.sleep(500); const d = await dump(P); modes.push(`${d.mode}${d.hidden ? '(hidden)' : ''}`); }
        ok(modes.join(',') === 'vector,histogram,off(hidden),waveform', `W cycle: ${modes}`);
      } finally { await P.close(); }
    });

    for (const [kind, matrix] of [['709', 709], ['untagged', 601]]) {
      await R.run(`scopes/sd-${kind}`, async (ok, r) => {
        if (!h.ffmpeg) { r.skipped = 'no ffmpeg for the reference frame'; return; }
        const file = lib.clip(`bars75_sd_${kind}.mp4`);
        const ref = spawnSync(h.ffmpeg, ['-v', 'error', '-i', file, '-frames:v', '1', '-pix_fmt', 'yuv420p', '-f', 'rawvideo', '-'],
          { windowsHide: true });
        if (ref.status !== 0 || ref.stdout.length !== 640 * 360 * 1.5) throw new Error('ffmpeg did not decode the reference frame');
        const P = await lib.open(vs, h, file);
        try {
          await P.waitFirstFrame();
          ok((await P.state()).vmode === 'webcodecs', 'expected the WebCodecs path');
          P.key('w');
          const a = await waitDump(P, (d) => d.wave, 'waveform analysis');
          ok(a.matrix === matrix, `BT.${a.matrix}, expected BT.${matrix}`);
          a.wave.forEach((levels, i) => {
            const want = ref.stdout[180 * 640 + i * 80 + 40];
            ok(levels.length === 1 && Math.abs(levels[0] - want) <= 5, `${BAR_NAMES[i]} bar at ${levels}, ffmpeg ${want}`);
          });
          if (matrix === 709) {
            // Fixed limited-range BT.709 levels also catch a wrong reference clip or matrix guess.
            const nominal = [235, 168, 145, 133, 63, 51, 28, 16];
            a.wave.forEach((levels, i) => ok(levels.length === 1 && Math.abs(levels[0] - nominal[i]) <= 5,
              `${BAR_NAMES[i]} bar at ${levels}, nominal BT.709 ${nominal[i]}`));
          }
          P.key('w'); P.key('w');
          const v = await waitDump(P, (d) => d.vec, 'vectorscope analysis');
          ok(v.matrix === matrix, `vectorscope BT.${v.matrix}, expected BT.${matrix}`);
          checkVector(ok, v);
        } finally { await P.close(); }
      });
    }

    await R.run('scopes/vectorscope-bars', async (ok) => {
      const P = await lib.open(vs, h, lib.clip('bars75_709.mp4'));
      try {
        await P.waitFirstFrame();
        P.key('w'); P.key('w'); P.key('w');
        const r = await waitDump(P, (d) => d.vec, 'vectorscope analysis');
        ok(r.matrix === 709, `BT.${r.matrix}, expected BT.709`);
        checkVector(ok, r);
        P.key('w'); // histogram draws without errors
        await lib.sleep(500);
        ok(!lib.lines(vs, /\[bars75_709\.mp4\] .*(error:|unhandled)/i, P.fromMark).length, 'page errors while drawing the histogram');
      } finally { await P.close(); }
    });

    await R.run('scopes/updates-when-stepping', async (ok) => {
      const P = await lib.open(vs, h, lib.clip('s_h264.mp4'));
      try {
        await P.waitFirstFrame();
        P.key('w');
        await lib.sleep(600);
        const n0 = (await dump(P)).perf.updates;
        P.step(1);
        await lib.sleep(900);
        const n1 = (await dump(P)).perf.updates;
        ok(n1 > n0, `no scope update after a paused step (${n0} -> ${n1})`);
        P.play();
        await lib.sleep(2500);
        const n2 = (await dump(P)).perf.updates;
        const rate = (n2 - n1) / 2.5;
        // Updates while playing, at most about 10 a second (the throttle); how many a loaded machine manages is not judged.
        ok(rate >= 0.4 && rate <= 14, `${rate.toFixed(1)} updates/s while playing (want some, at most about 10)`);
      } finally { await P.close(); }
    });

    await R.run('scopes/frame-player', async (ok) => {
      // MJPEG AVI plays through the 2D-canvas frame player: scopes sample with drawImage there.
      const P = await lib.open(vs, h, lib.clip('s_mjpeg.avi'));
      try {
        await P.waitFirstFrame();
        P.key('w');
        const a = await waitDump(P, (d) => d.wave, 'waveform analysis');
        ok(a.waveN === a.w * a.h && a.w > 0, `waveform holds ${a.waveN} samples for ${a.w}x${a.h}`);
      } finally { await P.close(); }
    });

    /** Sets A at frame a and B at frame b (1-based go-to), then runs the export command. */
    const markRange = async (P, a, b) => {
      P.goto(String(a)); await P.expectFrame(a - 1, 'go to A');
      P.key('a');
      P.goto(String(b)); await P.expectFrame(b - 1, 'go to B');
      P.key('b');
    };
    const exported = (n, total, from) => vs.waitLog(new RegExp(`exported ${n}/${total} frames`), { from, timeout: 60000, what: `exported ${n}/${total}` });

    await R.run('export/range', async (ok, r) => {
      if (!h.ffmpeg) { r.skipped = 'no ffmpeg for the reference frames'; return; }
      emptyDir(EXPORT_DIR);
      const file = lib.clip('s_h264.mp4');
      const P = await lib.open(vs, h, file);
      try {
        await P.waitFirstFrame();
        const A = 12; const B = 21; // 0-based: frames #13..#22 as shown
        await markRange(P, A + 1, B + 1);
        const from = vs.mark();
        vs.send({ command: 'videoPreviewEnhanced.exportRange' });
        await exported(10, 10, from);
        const files = fs.readdirSync(EXPORT_DIR).sort();
        const base = path.parse(file).name;
        const want = Array.from({ length: 10 }, (_, i) => `${base}_f${String(A + i + 1).padStart(6, '0')}.png`);
        ok(files.join(',') === want.join(','), `files ${files.join(',')}`);
        ok(files.length && pngSize(path.join(EXPORT_DIR, files[0])).join('x') === '320x180', `PNG size ${files.length ? pngSize(path.join(EXPORT_DIR, files[0])) : 'none'}`);
        // Each PNG is the right frame: decode the PNGs with ffmpeg to 64x36 luma and match against the file's frames.
        const refs = await lib.refFrames(h, path.resolve(file));
        const slots = refs ? lib.refSlots(refs, (await P.state()).fps) : null;
        const bad = [];
        for (let i = 0; i < files.length && refs; i++) {
          const k = A + i;
          const r2 = spawnSync(h.ffmpeg, ['-v', 'error', '-i', path.join(EXPORT_DIR, files[i]), '-vf', 'scale=64:36:flags=area,format=gray', '-f', 'rawvideo', '-'], { maxBuffer: 1e7, windowsHide: true });
          let best = -1; let bs = -2;
          for (let j = Math.max(0, k - 15); j <= Math.min(refs.length - 1, k + 15); j++) { const s = lib.ncc(r2.stdout, refs[j]); if (s > bs) { bs = s; best = j; } }
          if (slots[best] !== k) bad.push(`${files[i]} looks like frame ${slots[best]} (ncc ${bs.toFixed(4)}), want ${k}`);
        }
        ok(!bad.length, bad.join('; '));
      } finally { await P.close(); }
    });

    await R.run('export/vfr', async (ok) => {
      // On gapped video some frame indices never show; the export goes on and names files from the frame shown.
      emptyDir(EXPORT_DIR);
      const P = await lib.open(vs, h, lib.clip('gapped_30fps.mkv'));
      try {
        await P.waitFirstFrame();
        P.goto('1'); await lib.sleep(800); P.key('a');
        P.goto('40'); await lib.sleep(1200); P.key('b');
        const from = vs.mark();
        vs.send({ command: 'videoPreviewEnhanced.exportRange' });
        const line = await vs.waitLog(/exported \d+\/40 frames/, { from, timeout: 90000, what: 'export finished' });
        const files = fs.readdirSync(EXPORT_DIR);
        ok(files.length >= 25 && files.length <= 40, `${files.length} files; ${line.replace(/^.*\] /, '')}`);
      } finally { await P.close(); }
    });

    await R.run('export/hidden', async (ok) => {
      // The player is hidden behind another tab during the export: the export waits, and goes on when the player is shown again.
      emptyDir(EXPORT_DIR);
      const P = await lib.open(vs, h, lib.clip('long_20s.mp4'));
      try {
        await P.waitFirstFrame();
        await markRange(P, 1, 280);
        const from = vs.mark();
        vs.send({ command: 'videoPreviewEnhanced.exportRange' });
        await lib.sleep(1200);
        const Q = await lib.open(vs, h, lib.clip('s_hevc.mp4')); // in front now: the first player is hidden
        void Q;
        await lib.sleep(3500);
        const early = lib.lines(vs, /exported \d+\/280 frames/, from);
        const n1 = fs.readdirSync(EXPORT_DIR).length;
        await lib.sleep(1500);
        const n2 = fs.readdirSync(EXPORT_DIR).length;
        ok(!early.length && n1 === n2 && n2 < 280, `the export went on while the player was hidden (${n1} -> ${n2} files; ${early.join('')})`);
        vs.send({ command: 'workbench.action.closeActiveEditor' }); // the first player is shown again
        try { await vs.waitLog(/exported \d+\/280 frames/, { from, timeout: 90000, what: 'the export to finish after the player is shown' }); } catch (e) {
          throw new Error(`${e.message}; ${fs.readdirSync(EXPORT_DIR).length} files; log: ${lib.lines(vs, /export|error|failed/i, from).slice(-4).join(' | ')}`);
        }
        const done = lib.lines(vs, /exported \d+\/280 frames/, from)[0];
        const n = fs.readdirSync(EXPORT_DIR).length;
        ok(n === 280 && /exported 280\/280 frames/.test(done), `${n} files; ${done}`);
        const files = fs.readdirSync(EXPORT_DIR).sort();
        const want = Array.from({ length: 280 }, (_, i) => `long_20s_f${String(i + 1).padStart(6, '0')}.png`);
        ok(files.join(',') === want.join(','), 'hidden export did not write every frame from 1 through 280');
      } finally { await P.close(); }
    });

    await R.run('export/no-range', async (ok) => {
      // No A-B yet: nothing is written (the command only tells the user to set the loop).
      emptyDir(EXPORT_DIR);
      const P = await lib.open(vs, h, lib.clip('s_h264.mp4'));
      try {
        await P.waitFirstFrame();
        const from = vs.mark();
        vs.send({ command: 'videoPreviewEnhanced.exportRange' });
        await lib.sleep(2500);
        ok(!lib.lines(vs, /exported \d+\/\d+ frames/, from).length && !fs.readdirSync(EXPORT_DIR).length, 'frames were written without an A-B range');
      } finally { await P.close(); }
    });

    await R.run('saveFrame/png', async (ok) => {
      emptyDir(SAVE_DIR);
      const P = await lib.open(vs, h, lib.clip('s_h264.mp4'));
      try {
        await P.waitFirstFrame();
        P.seek(10.5 / 30); await P.expectFrame(10, 'seek');
        P.key('s');
        const target = path.join(SAVE_DIR, 's_h264_frame00011.png');
        const t0 = Date.now();
        while (!(fs.existsSync(target) && fs.statSync(target).size > 500) && Date.now() - t0 < 10000) await lib.sleep(200);
        ok(fs.existsSync(target), `${target} not written (${fs.readdirSync(SAVE_DIR)})`);
        if (fs.existsSync(target)) ok(pngSize(target).join('x') === '320x180', `PNG is ${pngSize(target)}`);
      } finally { await P.close(); }
    });
    return R.out;
  },
}];
