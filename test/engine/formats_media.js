'use strict';
// The 1080p clips in test/media and the container set (test/media/containers: H.264 in MKV, MOV, M2TS, FLV,
// AVI; VP8 in WebM) through the engine in Node.
const path = require('path');
const { formats, MEDIA } = require('./formats_lib');

formats('engine formats: test/media 1080p and containers', [
  ...['mpeg2_1080p.mpg', 'h264_8_1080p.mp4', 'h264_10_1080p.mp4', 'hevc_8_1080p.mp4', 'hevc_10_1080p.mp4', 'av1_8_1080p.mp4', 'av1_10_1080p.mp4',
    'vp9_1080p.webm', 'prores_proxy_1080p.mov', 'dnxhr_lb_1080p.mov'].map((n) => [path.join(MEDIA, n), { pick: 12 }]),
  [path.join(MEDIA, 'h264_aac_anim_1080p.mp4'), { sound: true, pick: 12 }],
  [path.join(MEDIA, 'vp9_opus_anim_1080p.webm'), { sound: true, pick: 12 }],
  ...['h264_aac.mkv', 'h264_aac.mov', 'h264_aac.m2ts', 'h264_aac.flv', 'h264_aac.avi', 'vp8_vorbis.webm']
    .map((n) => [path.join(MEDIA, 'containers', n), { sound: true, pick: 12 }]),
]);
