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

function checkClip(ok, h, file, ref, a, b) {
  const ffprobe = path.join(path.dirname(h.ffmpeg), 'ffprobe.exe');
  const probe = JSON.parse(run(ffprobe, ['-count_frames', '-show_streams', '-of', 'json', file]));
  const video = probe.streams.find((s) => s.codec_type === 'video');
  ok(Number(video.nb_read_frames) === b - a + 1, `${path.basename(file)}: inclusive frame count`);
  ok(probe.streams.filter((s) => s.codec_type === 'audio').length === 2, 'both audio streams copied');
  ok(JSON.stringify(hashes(h.ffmpeg, file)) === JSON.stringify(ref.slice(a, b + 1)),
    `${path.basename(file)}: decoded pictures match the source from A to B`);
}

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
            await P.ask('click', { sel: '#panel button.tool', text: 'Export A–B Clip…' });
          }
          await vs.waitLog(/A–B export to /, { from, timeout: 45000 });
          const p = path.parse(file);
          checkClip(ok, h, path.join(folder, p.name + '_A-B' + p.ext), ref, 40, 69);
        } finally { await P.close(); }
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
}];
