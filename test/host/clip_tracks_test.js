'use strict';

const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { inspectSource, makeClip } = require('../../src/clipexport');

const ffmpeg = process.env.VPE_FFMPEG || 'ffmpeg';
const ffprobe = ffmpeg === 'ffmpeg' ? 'ffprobe' : path.join(path.dirname(ffmpeg), 'ffprobe' + path.extname(ffmpeg));
const tools = { ffmpeg, ffprobe };
const run = (bin, args) => execFileSync(bin, ['-v', 'error', ...args], { encoding: 'utf8', windowsHide: true });
const probe = (file, args) => JSON.parse(run(ffprobe, [...args, '-of', 'json', file]));

(async () => {
  if (spawnSync(ffmpeg, ['-version'], { windowsHide: true }).status !== 0) {
    console.log('clip tracks: ffmpeg unavailable, skipping generated media');
    return;
  }
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vpe-clip-tracks-'));
  try {
    const file = path.join(dir, 'source.mov');
    const out = path.join(dir, 'clip.mov');
    const srt = path.join(dir, 'cues.srt');
    await fs.writeFile(srt, [
      '1', '00:00:00,800 --> 00:00:01,400', 'Active at A', '',
      '2', '00:00:01,600 --> 00:00:02,600', 'Active at B', '',
    ].join('\n'));
    run(ffmpeg, ['-f', 'lavfi', '-i', 'testsrc2=s=160x90:r=25:d=4',
      '-f', 'lavfi', '-i', 'sine=r=48000:d=4', '-i', srt, '-map', '0:v', '-map', '1:a', '-map', '2:s',
      '-c:v', 'libx264', '-g', '25', '-bf', '2', '-c:a', 'pcm_s16le', '-c:s', 'mov_text', file]);
    const source = await inspectSource(tools, file, { a: 1.2, b: 2, early: 0 });
    await makeClip(tools, file, out, source, { exact: true });
    const { frames } = probe(out, ['-select_streams', 'a:0', '-show_frames',
      '-show_entries', 'frame=best_effort_timestamp_time,nb_samples']);
    assert.equal(frames.reduce((total, frame) => total + frame.nb_samples, 0), 40320, 'PCM sample count');
    assert.equal(Number(frames[0].best_effort_timestamp_time), 0);
    const hash = (file, ...args) => run(ffmpeg, ['-i', file, '-map', '0:a:0', ...args, '-c:a', 'pcm_s16le', '-f', 'hash', '-']);
    assert.equal(hash(out), hash(file, '-af', 'atrim=start=1.2:end=2.04'), 'PCM samples are bit identical');
    const { packets } = probe(out, ['-select_streams', 's', '-show_packets', '-show_entries',
      'packet=pts_time,duration_time,flags,size']);
    assert.deepEqual(packets.filter((p) => Number(p.size) > 2)
      .map((p) => [Number(p.pts_time), Number(p.duration_time), p.flags.includes('D')]),
    [[0, 0.2, false], [0.4, 0.44, false]]);

    // Contiguous cues: one ends exactly at A, one starts exactly at B's end. Float sums (0.8 + 0.4) must not make the
    // verifier expect the zero-length cues the muxer correctly drops.
    await fs.writeFile(srt, [
      '1', '00:00:00,800 --> 00:00:01,200', 'Ends at A', '',
      '2', '00:00:01,200 --> 00:00:01,500', 'Starts at A', '',
      '3', '00:00:01,500 --> 00:00:02,040', 'Ends after B', '',
      '4', '00:00:02,040 --> 00:00:02,300', 'After the clip', '',
    ].join('\n'));
    const touching = path.join(dir, 'touching.mp4');
    const touchingOut = path.join(dir, 'touching-clip.mp4');
    run(ffmpeg, ['-f', 'lavfi', '-i', 'testsrc2=s=160x90:r=25:d=4', '-i', srt, '-map', '0:v', '-map', '1:s',
      '-c:v', 'libx264', '-g', '25', '-bf', '2', '-c:s', 'mov_text', touching]);
    await makeClip(tools, touching, touchingOut, await inspectSource(tools, touching, { a: 1.2, b: 2, early: 0 }), { exact: true });
    const cues = probe(touchingOut, ['-select_streams', 's', '-show_packets', '-show_entries', 'packet=pts_time,size'])
      .packets.filter((p) => Number(p.size) > 2).map((p) => Number(p.pts_time));
    assert.deepEqual(cues, [0, 0.3], 'only the two cues inside the clip are kept');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
})().catch((e) => { console.error(e); process.exitCode = 1; });
