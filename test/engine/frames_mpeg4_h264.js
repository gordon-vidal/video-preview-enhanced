'use strict';
// Frame-exact stepping and seeking in the WebAssembly decoder: MPEG-4 Part 2 in AVI and H.264 (in VS Code
// H.264 plays on the GPU; here it takes the WebAssembly path, as after an open-GOP fallback or for
// 10-bit / 4:2:2 H.264). End shows the last picture when the sound runs longer (end-key/).
const { runJobs, stepSeek, J } = require('./frames_lib');

runJobs('engine frames: MPEG-4 Part 2, H.264', [
  ...stepSeek(['s_xvid.avi', 's_h264.mp4']),
  ['end-key/audio_longer_soft.mkv', 'audio_longer_soft.mkv', (P) => J.endKey(P, 59)],
  ['end-key/audio_longer.mp4', 'audio_longer.mp4', (P) => J.endKey(P, 59)],
]);
