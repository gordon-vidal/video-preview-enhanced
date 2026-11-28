'use strict';
// Layer 3 verifier for /compare deep links (vscode://gordon-vidal.video-preview-enhanced/compare?...):
// opens a synchronized Compare panel at the requested frame and layout mode, then reuses the open panel
// when a second link for the same files arrives with a new frame/timestamp and layout.
const path = require('path');

// Both clips are 30 fps, 3 s (90 frames).
const CLIPS = ['h264_aac_anim_1080p.mp4', 'vp9_opus_anim_1080p.webm'];
const lib = require('../lib');

module.exports = [{
  name: 'compare_link',
  settings: { 'videoPreviewEnhanced.decoder': 'builtin', 'videoPreviewEnhanced.autoplay': false },
  async run(vs, h) {
    const R = lib.recorder();
    const enc = CLIPS.map((clip) => encodeURIComponent(path.join(h.MEDIA, clip)));
    const open = (query) => vs.send({
      openLink: `vscode://gordon-vidal.video-preview-enhanced/compare?${query}&file=${enc[0]}&file=${enc[1]}`,
    });
    const landed = (mode, frame, tolerance = 0) => lib.waitProbe(() => lib.compareState(vs),
      (s) => s?.synced && s.mode === mode && s.tiles.length === 2 &&
        s.tiles.every((t) => t.frame !== null && Math.abs(t.frame - frame) <= tolerance && !t.playing),
      `both tiles paused at frame ${frame} in ${mode}`);

    const start = async () => { open('frame=31&mode=split'); await landed('split', 31); };
    try {
      await R.run('open/split-frame', start);
      await R.run('reuse/grid-frame', async (ok) => {
        if (!lib.selected('open/split-frame')) await start();
        open('frame=60&mode=grid');
        await landed('grid', 60);
        const from = vs.mark();
        vs.send({ tabs: true });
        const line = await vs.waitLog(/ tabs \[\[/, { from, timeout: 10000 });
        const tabs = JSON.parse(/ tabs (\[\[.*\]\])/.exec(line)[1]).flat();
        ok(tabs.length === 1 && /compare/i.test(tabs[0].viewType), `expected 1 reused compare tab, got ${JSON.stringify(tabs)}`);
      });
      await R.run('reuse/spotlight-time', async () => {
        if (!lib.selected('open/split-frame') && !lib.selected('reuse/grid-frame')) await start();
        open('t=0.5&mode=spotlight');
        await landed('spotlight', 16, 1);
      });
    } finally { await h.closeClip(vs); }
    return R.out;
  },
}];
