'use strict';
// The first-open checks of the old suite (test/vscode/run.js wcprobe, play/*, native/*) as cases for the scenarios:
// WebCodecs in the real webview, each test/media clip opens on the expected decoder path (the listing's claim:
// H.264 on the GPU in MP4, MKV, MOV, M2TS, FLV, AVI; VP8 in WebM), plays, and a paused seek lands on its frame.
// Layer 3 checks playback and seeks. Layer 4 also records periodic FPS windows (test/perf).
const path = require('path');

const suite = () => require('../suite');

module.exports = [{
  name: 'open-formats',
  // Short clips (1-2 s) must keep playing for the fps windows: Autoplay no longer loops by default.
  settings: { 'videoPreviewEnhanced.onEnd': 'loop' },
  async run(vs, h) {
    const { CLIPS, wcprobe, playClip } = suite();
    const out = [];
    let probe = true;
    for (const clip of CLIPS) {
      const name = `play/${clip.file}`;
      const onShown = probe ? async (n) => {
        probe = false;
        try { out.push({ name: 'wcprobe', ...(await wcprobe(vs, n)) }); } catch (e) { out.push({ name: 'wcprobe', ok: false, problems: [e.message] }); }
      } : null;
      try {
        const r = await playClip(vs, clip, { seconds: 2, onShown, correctness: !!h.scenario });
        out.push({ name, ...r });
      } catch (e) { out.push({ name, ok: false, problems: [e.message] }); try { await h.closeClip(vs); } catch { /* gone */ } }
    }
    return out;
  },
}, {
  name: 'open-native',
  ffmpeg: true,
  // Short clips (1-2 s) must keep playing for the fps windows: Autoplay no longer loops by default.
  settings: { 'videoPreviewEnhanced.onEnd': 'loop' },
  async run(vs, h) {
    const { NATIVE_CLIPS, playClip } = suite();
    const out = [];
    for (const f of NATIVE_CLIPS) {
      const name = `native/${path.basename(f)}`;
      try {
        const r = await playClip(vs, { file: f }, { seconds: 2, native: true });
        if (!/^native ffmpeg/.test(r.decision || '')) { r.ok = false; r.problems.push(`decision: ${r.decision || 'none logged'}`); }
        out.push({ name, ...r });
      } catch (e) { out.push({ name, ok: false, problems: [e.message] }); try { await h.closeClip(vs); } catch { /* gone */ } }
    }
    return out;
  },
}];
