'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const lib = require('../lib');

const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'vpe-clips-'));

function run(bin, args) {
  return execFileSync(bin, ['-v', 'error', ...args], { encoding: 'utf8', windowsHide: true });
}

function hashes(ffmpeg, file) {
  return run(ffmpeg, ['-i', file, '-map', '0:v:0', '-fps_mode', 'passthrough', '-f', 'framemd5', '-'])
    .split(/\r?\n/).filter((line) => /^\d+,/.test(line)).map((line) => line.split(',').at(-1).trim());
}

function checkClip(ok, h, file, ref, a, b, audioStreams = 2) {
  const ffprobe = path.join(path.dirname(h.ffmpeg), 'ffprobe.exe');
  const probe = JSON.parse(run(ffprobe, ['-count_frames', '-show_streams', '-of', 'json', file]));
  const video = probe.streams.find((s) => s.codec_type === 'video');
  ok(Number(video.nb_read_frames) === b - a + 1, `${path.basename(file)}: inclusive frame count`);
  ok(probe.streams.filter((s) => s.codec_type === 'audio').length === audioStreams, 'the audio streams were copied');
  ok(JSON.stringify(hashes(h.ffmpeg, file)) === JSON.stringify(ref.slice(a, b + 1)),
    `${path.basename(file)}: decoded pictures match the source from A to B`);
}

// Native ffmpeg reports each picture's own timestamp (src/nativepts.js), so marks set on it export exactly, also on
// variable-frame-rate video: the clip's first and last pictures are the ones on screen at A and B.
const nativeCase = {
  name: 'clip_export_native',
  ffmpeg: true,
  settings: { 'videoPreviewEnhanced.autoplay': false, 'videoPreviewEnhanced.decoder': 'ffmpeg' },
  env: { VPE_CLIP_EXPORT_DIR: folder, VPE_CLIP_EXPORT_CONFIRM: '1' },
  async run(vs, h) {
    const R = lib.recorder();
    const vfr = path.join(folder, 'vfr-native.mp4');
    for (const name of fs.readdirSync(folder)) if (/^(?:[AB]_)?vfr-native(?:-twin)?_A-B/.test(name)) fs.unlinkSync(path.join(folder, name));
    // The picture at 1.00 s is missing: a seek to 1.000 s shows the one at 1.04 s.
    run(h.ffmpeg, ['-y', '-f', 'lavfi', '-i', 'testsrc2=s=160x90:r=25:d=2', '-f', 'lavfi', '-i', 'sine=d=2',
      '-vf', String.raw`select=not(eq(n\,25))`, '-fps_mode', 'passthrough', '-c:v', 'libx264', '-g', '25', '-c:a', 'aac', vfr]);
    const stamps = run(h.ffmpeg, ['-i', vfr, '-map', '0:v:0', '-fps_mode', 'passthrough', '-f', 'framemd5', '-'])
      .split(/\r?\n/).filter((line) => /^\d+,/.test(line)).map((line) => line.split(',').map((x) => x.trim()));
    const at = (pts) => stamps.findIndex((r) => Number(r[2]) === Math.round(pts * 25)); // framemd5 counts in 1/25 s here
    await R.run('clip/native-vfr', async (ok) => {
      const P = await lib.open(vs, h, vfr);
      try {
        await P.waitFirstFrame(30000);
        P.seek(1.0);
        await lib.sleep(2500); // the picture of the accurate native seek is on screen
        P.key('a');
        P.seek(1.6); await lib.sleep(2500);
        P.key('b');
        const marks = (await P.state()).abRange;
        const from = vs.mark();
        vs.send({ command: 'videoPreviewEnhanced.exportVideoRange' });
        await vs.waitLog(/A–B export to /, { from, timeout: 45000 });
        // Marks are the file's own picture times (not the slot labels of native playback) and not flagged as estimated.
        const first = at(marks.a);
        const last = at(marks.b);
        ok(!marks.native && first >= 0 && last > first, `A and B are source pictures: ${JSON.stringify(marks)}`);
        checkClip(ok, h, path.join(folder, 'vfr-native_A-B.mp4'), stamps.map((r) => r[5]), first, last, 1);
      } finally { await P.close(); }
    });
    // A VFR clock (native, may hold its 0.96 s picture at the 1.00 s slot) next to a CFR follower: each tile's clip must
    // start and end on the picture that tile showed at A and B, not on the clock tile's source time.
    await R.run('clip/native-compare', async (ok) => {
      const cfr = path.join(folder, 'cfr-follower.mp4');
      for (const name of fs.readdirSync(folder)) if (/^[AB]_(?:vfr-native|cfr-follower)_A-B/.test(name)) fs.unlinkSync(path.join(folder, name));
      run(h.ffmpeg, ['-y', '-f', 'lavfi', '-i', 'testsrc2=s=160x90:r=25:d=2', '-f', 'lavfi', '-i', 'sine=d=2',
        '-c:v', 'libx264', '-g', '25', '-c:a', 'aac', cfr]);
      const act = (data) => vs.send({ compare: true, ...data });
      const shown = async () => {
        const mark = vs.mark();
        act({ action: 'report' });
        const line = await vs.waitLog(/webview: compare report /, { from: mark, timeout: 5000 });
        const srcs = line.match(/\bsrcs=(\S+)/)?.[1].split(',').map(Number);
        if (!srcs || srcs.some((x) => !Number.isFinite(x))) throw new Error('compare report has no source times: ' + line.slice(-300));
        return srcs;
      };
      const from = vs.mark();
      vs.send({ compareFiles: [vfr, cfr] });
      await vs.waitLog(/first pictures shown/, { from, timeout: 45000 });
      await lib.sleep(1500);
      act({ action: 'seek', t: 1.0 }); await lib.sleep(2500);
      const atA = await shown();
      act({ action: 'key', key: 'a' });
      act({ action: 'seek', t: 1.6 }); await lib.sleep(2500);
      const atB = await shown();
      act({ action: 'key', key: 'b' });
      act({ action: 'pause' });
      const mark = vs.mark();
      vs.send({ command: 'videoPreviewEnhanced.exportCompareVideoRange' });
      await vs.waitLog(/A–B export to /, { from: mark, timeout: 45000 });
      const sources = [vfr, cfr].map((file) => run(h.ffmpeg, ['-i', file, '-map', '0:v:0', '-fps_mode', 'passthrough', '-f', 'framemd5', '-'])
        .split(/\r?\n/).filter((line) => /^\d+,/.test(line)).map((line) => line.split(',').map((x) => x.trim())));
      const exported = [path.join(folder, 'A_vfr-native_A-B.mp4'), path.join(folder, 'B_cfr-follower_A-B.mp4')];
      for (let i = 0; i < 2; i++) {
        const at = (pts) => sources[i].findIndex((r) => Number(r[2]) === Math.round(pts * 25));
        const first = at(atA[i]);
        const last = at(atB[i]);
        ok(first >= 0 && last > first, 'tile ' + i + ' showed source pictures at A and B: ' + atA[i] + ', ' + atB[i]);
        if (first >= 0 && last > first && fs.existsSync(exported[i])) checkClip(ok, h, exported[i], sources[i].map((r) => r[5]), first, last, 1);
        else ok(false, 'tile ' + i + ' clip exists: ' + exported[i]);
      }
    });
    return R.out;
  },
};

module.exports = [{
  name: 'clip_export',
  ffmpeg: true,
  settings: { 'videoPreviewEnhanced.autoplay': false, 'videoPreviewEnhanced.decoder': 'builtin' },
  env: { VPE_CLIP_EXPORT_DIR: folder, VPE_CLIP_EXPORT_CONFIRM: '1' },
  async run(vs, h) {
    const R = lib.recorder();
    const mp4 = path.join(folder, 'cut-reference.mp4');
    const mov = path.join(folder, 'cut-mov.mov');
    const mkv = path.join(folder, 'cut-offset.mkv');
    const incompatible = path.join(folder, 'cut-subtitle.mkv');
    const srt = path.join(folder, 'fixture.srt');
    for (const name of fs.readdirSync(folder)) {
      if (name.includes('_A-B')) fs.unlinkSync(path.join(folder, name));
    }
    run(h.ffmpeg, ['-y', '-f', 'lavfi', '-i', 'testsrc2=s=160x90:r=25:d=4',
      '-f', 'lavfi', '-i', 'sine=d=4', '-f', 'lavfi', '-i', 'sine=f=900:d=4',
      '-map', '0:v', '-map', '1:a', '-map', '2:a', '-c:v', 'libx264', '-g', '25', '-bf', '2', '-c:a', 'aac', mp4]);
    run(h.ffmpeg, ['-y', '-i', mp4, '-map', '0', '-c', 'copy', mov]);
    run(h.ffmpeg, ['-y', '-i', mp4, '-map', '0', '-c', 'copy', mkv]);
    fs.writeFileSync(srt, '1\n00:00:01,000 --> 00:00:03,000\nTest cue\n');
    run(h.ffmpeg, ['-y', '-i', mkv, '-i', srt, '-map', '0', '-map', '1:s', '-c', 'copy', incompatible]);
    const ref = hashes(h.ffmpeg, mp4);

    for (const file of [mp4, mov]) {
      await R.run(`clip/single-${path.extname(file).slice(1)}`, async (ok) => {
        const p = path.parse(file);
        const exported = path.join(folder, p.name + '_A-B' + p.ext);
        const P = await lib.open(vs, h, file);
        try {
          P.seek(1.61); await P.expectFrame(40, 'mark A');
          P.key('a');
          P.seek(2.77); await P.expectFrame(69, 'mark B');
          P.key('b');
          const from = vs.mark();
          if (file === mp4) vs.send({ command: 'videoPreviewEnhanced.exportVideoRange' });
          else {
            await P.ask('click', { sel: '#cog' });
            await P.ask('click', { sel: '#panel button', text: 'A–B Range' });
            await P.ask('click', { sel: '#panel button[data-tool]', text: 'Export A–B Clip…' });
          }
          await vs.waitLog(/A–B export to /, { from, timeout: 45000 });
          checkClip(ok, h, exported, ref, 40, 69);
        } finally { await P.close(); }
        const clip = await lib.open(vs, h, exported);
        try {
          await clip.expectFrame(0, 'reopened clip starts at A');
          clip.key('End');
          await clip.expectFrame(29, 'reopened clip ends at B');
        } finally { await clip.close(); }
      });
    }

    await R.run('clip/compare-offset-and-ineligible', async (ok) => {
      const act = (data) => vs.send({ compare: true, ...data });
      const from = vs.mark();
      vs.send({ compareFiles: [mp4, mkv, incompatible] });
      await vs.waitLog(/first pictures shown/, { from, timeout: 45000 });
      const seek = async (t, frame) => {
        act({ action: 'seek', t });
        const deadline = Date.now() + 12000;
        do {
          const mark = vs.mark();
          act({ action: 'report' });
          const line = await vs.waitLog(/webview: compare report /, { from: mark, timeout: 5000 });
          if (line.includes('synced=true') && line.includes(`frames=${frame},${frame + 2},${frame}`)) return;
        } while (Date.now() < deadline);
        throw new Error(`Compare did not settle at frame ${frame} with the two-frame offset`);
      };
      act({ action: 'offset', tile: 1, v: 2, unit: 'f' });
      await seek(1.61, 41);
      act({ action: 'key', key: 'a' });
      await seek(2.77, 70);
      act({ action: 'key', key: 'b' });
      act({ action: 'play' });
      const deadline = Date.now() + 8000;
      let wrapped = false;
      do {
        const mark = vs.mark();
        act({ action: 'report' });
        const line = await vs.waitLog(/webview: compare report /, { from: mark, timeout: 5000 });
        const frame = Number(line.match(/\bframe=(\d+)/)?.[1]);
        wrapped = line.includes('playing=1,1,1') && frame >= 41 && frame < 62;
      } while (!wrapped && Date.now() < deadline);
      ok(wrapped, 'the shared playback clock wrapped from B to A');
      act({ action: 'pause' });
      const mark = vs.mark();
      vs.send({ command: 'videoPreviewEnhanced.exportCompareVideoRange' });
      await vs.waitLog(/Export only the eligible Compare tiles\? C .*cut-subtitle/, { from: mark, timeout: 45000 });
      await vs.waitLog(/A–B export to /, { from: mark, timeout: 45000 });
      checkClip(ok, h, path.join(folder, 'A_cut-reference_A-B.mp4'), ref, 40, 69);
      checkClip(ok, h, path.join(folder, 'B_cut-offset_A-B.mp4'), ref, 42, 71);
      ok(!fs.readdirSync(folder).some((f) => /^C_.*_A-B/.test(f)), 'the incompatible tile was skipped');
    });
    return R.out;
  },
}, nativeCase];
