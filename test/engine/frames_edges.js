'use strict';
// The ends of a file and the A-B loop in the WebAssembly decoder (seeking.js edges/, eof-flush/, abloop/,
// open-gop/, step-ms-rounded/ for H.264), and the exact NTSC rate.
const { runJobs, J } = require('./frames_lib');

runJobs('engine frames: edges, end of file, A-B loop, rounded times', [
  ['edges/s_h264.mp4', 's_h264.mp4', J.edges],
  ['edges/s_hevc.mp4', 's_hevc.mp4', J.edges],
  ['eof/vp8_2s.webm', 'vp8_2s.webm', (P) => J.eof(P, 59)],
  ['eof/s_vp9.webm', 's_vp9.webm', (P) => J.eof(P, P.n - 1)],
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
