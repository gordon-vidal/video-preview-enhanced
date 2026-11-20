'use strict';
// Frame-exact stepping and seeking in the WebAssembly decoder: MPEG-2 (program stream) and ProRes (seeking.js step/ seek/).
const { runJobs, stepSeek } = require('./frames_lib');

runJobs('engine frames: MPEG-2, ProRes', stepSeek(['s_mpeg2.mpg', 's_prores.mov']));
