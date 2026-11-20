'use strict';
// Frame-exact stepping and seeking in the WebAssembly decoder: HEVC and VP9 (seeking.js step/ seek/), and VP9
// with millisecond-rounded MKV times at 60 fps (step-ms-rounded/vp9_60fps.mkv).
const { runJobs, stepSeek, J } = require('./frames_lib');

runJobs('engine frames: HEVC, VP9', [
  ...stepSeek(['s_hevc.mp4', 's_vp9.webm']),
  ['step-ms-rounded/vp9_60fps.mkv', 'vp9_60fps.mkv', (P) => J.msRounded(P, 60)],
]);
