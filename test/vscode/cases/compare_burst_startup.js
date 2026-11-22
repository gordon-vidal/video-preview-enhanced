'use strict';
// Layer-4 bench (test/perf/benches.js): how fast videos opened together become pictures in one compare. For 1, 2,
// 5 and 8 videos, three runs each: `vscode.openWith` on all files at once (what an Explorer drag or Open With… on a
// selection does), timed from the first player resolve to the first picture of every tile (debug log 'first pictures
// shown'; one video: the player's first frame). Also `burstMs` (burst taken) and `openedMs` (compare page ready).
const path = require('path');
const CLIPS = [
  'h264_aac_anim_1080p.mp4', 'vp9_opus_anim_1080p.webm', 'h264_8_1080p.mp4', 'h264_10_1080p.mp4',
  'hevc_8_1080p.mp4', 'hevc_10_1080p.mp4', 'av1_8_1080p.mp4', 'vp9_1080p.webm',
];
const timestamp = (line) => Date.parse(line.split(' ')[0]);

module.exports = {
  name: 'compare-burst-startup',
  settings: {
    'videoPreviewEnhanced.decoder': 'builtin',
    'videoPreviewEnhanced.autoplay': false,
    'videoPreviewEnhanced.compare.maxVideos': 8,
  },
  async run(vs, h) {
    const results = [];
    for (const n of [1, 2, 5, 8]) {
      for (let run = 0; run < 3; run++) {
        const from = vs.mark();
        vs.send({ openWithBurst: CLIPS.slice(0, n).map((file) => path.join(h.MEDIA, file)) });
        const first = await vs.waitLog(/player resolve started/, { from });
        const pictures = await vs.waitLog(n === 1 ? /webview: first frame shown/ : /webview: first pictures shown/, {
          from, timeout: 30000, what: `first pictures for ${n} videos`,
        });
        const elapsed = (line) => timestamp(line) - timestamp(first);
        const result = { name: `${n}-videos/run-${run + 1}`, ok: true, totalMs: elapsed(pictures) };
        if (n > 1) {
          const burst = await vs.waitLog(new RegExp(`${n} videos opened together -> one compare`), { from });
          const opened = await vs.waitLog(new RegExp(`opened, .* ${n} tiles`), { from });
          result.burstMs = elapsed(burst);
          result.openedMs = elapsed(opened);
          result.playerSessions = vs.lines.slice(from).filter((line) => /session resolved:/.test(line)).length;
        }
        results.push(result);
        await h.closeClip(vs);
      }
    }
    return results;
  },
};
