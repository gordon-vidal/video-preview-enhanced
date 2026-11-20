'use strict';
// Every container / codec of the open-and-play set (test/media/cases/fmt, playback.js open/fmt/), damaged and
// cut files, start at PTS 3600, multichannel sound: through the engine in Node.
const path = require('path');
const { formats, MEDIA } = require('./formats_lib');

const f = (n) => path.join(MEDIA, 'cases', n);
formats('engine formats: the open-and-play set', [
  ...['h264_high10.mp4', 'h264_444.mp4', 'hevc10.mp4', 'hevc10_opus.mkv', 'vp8_vorbis.webm', 'av1_opus.mkv', 'h264_ac3.mts', 'mpeg2_ac3.vob',
    'mpeg2_interlaced.mpg', 'wmv2_wma.wmv', 'wmv2_wma.asf', 'dnxhr_pcm.mxf', 'theora_vorbis.ogv', 'flv1_mp3.flv', 'odd_853x479.mkv', 'h264_ac3_51.mkv']
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
