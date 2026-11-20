'use strict';

module.exports = {
  name: 'short_loop',
  settings: { 'videoPreviewEnhanced.autoplay': true, 'videoPreviewEnhanced.loop': true },
  async run(vs, h) {
    const results = [];
    for (const clip of [
      { file: 'av1_8_1080p.mp4', expect: 'soft', fps: 24 },
      { file: 'h264_8_1080p.mp4', expect: 'webcodecs', fps: 24 },
    ]) {
      const from = vs.mark();
      const r = await h.playClip(vs, clip, { seconds: 8 });
      // Sample several wraps after startup, allowing for timing at the sample edges.
      if (r.shownFpsWindows.length < 4 || Math.abs(r.shownFps - clip.fps) > 1) {
        r.ok = false;
        r.problems.push(`expected ${clip.fps} shown fps across loops, got ${JSON.stringify(r.shownFpsWindows)}`);
      }
      if (!vs.lines.slice(from).some((line) => line.includes(`[${clip.file}] webview: loop: replaying 48 cached frames`))) {
        r.ok = false;
        r.problems.push('the player did not reuse the full decode across the loop point');
      }
      results.push({ name: clip.expect, ...r });
    }
    return results;
  },
};
