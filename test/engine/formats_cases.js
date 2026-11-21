'use strict';
// The open-and-play format matrix, late first timestamps and multichannel sound through the engine in Node.
const path = require('path');
const { formats, MEDIA } = require('./formats_lib');

const f = (n) => path.join(MEDIA, 'cases', n);
formats('engine formats: the open-and-play set', [
  // These formats rely on this test for WASM playback as well as opening and seeking.
  ...['hevc10.mp4', 'hevc10_opus.mkv', 'av1_opus.mkv', 'mpeg2_ac3.vob', 'mpeg2_interlaced.mpg',
    'wmv2_wma.wmv', 'wmv2_wma.asf', 'dnxhr_pcm.mxf', 'theora_vorbis.ogv', 'flv1_mp3.flv']
    .map((n) => [f(`fmt/${n}`), { sound: true, play: true }]),
  ...['h264_high10.mp4', 'h264_444.mp4', 'vp8_vorbis.webm', 'h264_ac3.mts', 'odd_853x479.mkv', 'h264_ac3_51.mkv']
    .map((n) => [f(`fmt/${n}`), { sound: true }]),
  [f('fmt/h264_noaudio.mp4')],
  [f('fmt/h264_vfr.mkv')],
  [f('start3600.mts'), { sound: true }],
  [f('start3600_mpeg2.mts'), { sound: true }],
  [f('truehd_51side.mkv'), { sound: true }],
  [f('flac_71_centre.mkv'), { sound: true }],
  [f('rotated.mp4')],
  [f('gapped_30fps.mkv')],
]);
