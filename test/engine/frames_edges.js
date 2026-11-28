'use strict';
// The ends of a file and the A-B loop in the WebAssembly decoder (seeking.js edges/, eof-flush/, abloop/,
// open-gop/, step-ms-rounded/ for H.264), and the exact NTSC rate.
const { runJobs, J } = require('./frames_lib');

runJobs('engine frames: edges, end of file, A-B loop, rounded times', [
  ['edges/s_h264.mp4', 's_h264.mp4', J.edges],
  ['edges/s_hevc.mp4', 's_hevc.mp4', J.edges],
  ['eof/vp8_2s.webm', 'vp8_2s.webm', (P) => J.eof(P, 59)],
  ['eof/s_vp9.webm', 's_vp9.webm', (P) => J.eof(P, P.n - 1)],
  // MP4 states its frame count: End works at once after the first picture, without waiting for 24 timestamps.
  ['end-at-open/s_h264.mp4', 's_h264.mp4', async (P) => {
    J.assert(P.n === 90 && P.fps === 30, `right after open: ${P.n} frames at ${P.fps} fps, expected 90 at 30`);
    await J.endKey(P, 89);
  }, { waitRate: false }],
  // 10 frames, no rate in the MXF: the rate comes from the timestamps at the end of the file.
  ['short-no-rate/dnxhr_pcm.mxf', 'fmt/dnxhr_pcm.mxf', async (P) => {
    J.assert(await P.until(() => P.player.eof, 'end of file', 30000), 'never reached the end of the file');
    J.assert(P.player.fps === 25 && P.n === 10, `${P.n} frames at ${P.player.fps} fps`);
    P.step(1);
    await P.expectFrame(1, 'step +1');
    await J.endKey(P, 9);
  }, { waitRate: false }],
  // The single viewer steps with paused frame seeks to the bar's frame ± 1 (media/player-unified.js seekTo, the step's
  // direction as `land`) and the bar takes the decoder's frame: every actual picture, forward and back, over gaps of
  // 1-4 frames and a rate that drops from 60 to 15 fps.
  ...['gapped_30fps.mkv', 'gapped_wide_30fps.mkv', 'fmt/h264_vfr.mkv'].map((clip) => [`gap-steps/${clip}`, clip, async (P) => {
    const pics = [...new Set(await P.slots())].sort((a, b) => a - b);
    P.pause();
    P.seekFrame(0);
    await P.expectFrame(0, 'Home');
    for (const dir of [1, -1]) {
      const order = dir > 0 ? pics : [...pics].reverse();
      for (let i = 1; i < order.length; i++) {
        P.player.seekFrame(P.frame() + dir, false, dir);
        await P.expectFrame(order[i], `step ${dir > 0 ? 'forward' : 'back'} from ${order[i - 1]}`, 5000);
      }
    }
  }]),
  ['abloop/s_h264.mp4', 's_h264.mp4', J.abloop],
  ['abloop/s_mpeg2.mpg', 's_mpeg2.mpg', J.abloop],
  ['step-ms-rounded/h264_60fps.mkv', 'h264_60fps.mkv', (P) => J.msRounded(P, 60)],
  ['step-ms-rounded/ntsc_2997.mkv', 'ntsc_2997.mkv', async (P) => {
    J.assert(Math.abs(P.fps - 30000 / 1001) < 1e-9, `fps ${P.fps}, expected exactly 30000/1001`);
    await J.msRounded(P, 30);
  }],
  // Open-GOP H.264 (recovery points, one IDR): in VS Code the GPU decoder hands over to WebAssembly on a
  // backward seek (layer 3, open-gop/h264); here the WebAssembly side lands on the frame.
  ['open-gop/s_h264_opengop.mkv', 's_h264_opengop.mkv', async (P) => {
    P.play();
    J.assert(await P.until(() => P.frame() >= 60, 'a picture past the seek target', 30000), 'did not play past frame 60');
    P.pause();
    P.seek(45.5 / P.fps);
    await P.expectFrame(45, 'picture after the backward seek');
    P.seek(100.5 / P.fps);
    await P.expectFrame(100, 'seek into a later GOP');
  }],
]);
