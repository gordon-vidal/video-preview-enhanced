'use strict';
// The 2160p clips in test/media (HEVC 10-bit incl. PQ and HLG, AV1 10-bit, VP9, H.264) through the engine
// in Node: the first picture only (4K in WebAssembly in Node takes minutes per seek; 4K seeks are checked in
// VS Code, scenario open-formats).
const path = require('path');
const { formats, MEDIA } = require('./formats_lib');

formats('engine formats: test/media 2160p', ['h264_8_2160p.mp4', 'hevc_10_2160p.mp4', 'hevc_10_pq_2160p.mp4', 'hevc_10_hlg_2160p.mp4', 'av1_10_2160p.mp4', 'vp9_2160p.webm']
  .map((n) => [path.join(MEDIA, n), { pick: -1, timeout: 120000 }]));
