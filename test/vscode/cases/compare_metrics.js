'use strict';
// Compare with two videos in real VS Code: identical pictures give infinite RGB and luma PSNR,
// and the first-difference search finds the next differing frame. Both have no UI for now (kept for a later
// advanced mode, 2026-11-20): debug builds log the paused pair's metrics, the test hook starts the search.
// Read from the webview's `metrics frameA=.. psnrY=..` log line (media/compare.js, debug only).
const lib = require('../lib');

const METRICS = /webview: metrics frameA=(\d+) frameB=(\d+) psnrY=(\S+) psnrRGB=(\S+) ssimY=(\S+)/;
const num = (s) => (s === 'Infinity' ? Infinity : Number(s));

module.exports = [{
  name: 'compare_metrics',
  settings: { 'videoPreviewEnhanced.autoplay': false },
  async run(vs, h) {
    const R = lib.recorder();
    // The extension activates when a video opens; the test hook (compareFiles) needs it.
    await (await lib.open(vs, h, lib.clip('s_h264.mp4'))).close();
    const ref = lib.clip('cmp/ref.mp4');
    const act = (o) => vs.send({ compare: true, ...o });
    /** Opens the pair, returns a function that seeks A to frame k (0-based) and resolves with the metrics line for it. */
    const openPair = async (a, b) => {
      const from = vs.mark();
      vs.send({ compareFiles: [a, b] });
      await vs.waitLog(/\[compare [^\]]*\] opened/, { from, timeout: 40000, what: 'compare opened' });
      // The page's test hook takes commands once both tiles show: a seek sent before then is lost.
      await vs.waitLog(/\[compare [^\]]*\] webview: first pictures shown/, { from, timeout: 40000, what: 'both tiles shown' });
      let first = true; // frame 1's pair is measured as the page opens, before the first query's mark
      return async (k, { want = k + 1, timeout = 30000 } = {}) => {
        const m0 = first ? from : vs.mark();
        first = false;
        act({ action: 'seek', t: (k + 0.5) / 30 });
        const line = await vs.waitLog(new RegExp(`webview: metrics frameA=${k + 1} frameB=${want} `), { from: m0, timeout, what: `metrics at frame ${k + 1}` });
        const m = METRICS.exec(line);
        return { a: Number(m[1]), b: Number(m[2]), psnrY: num(m[3]), psnrRGB: num(m[4]), ssimY: num(m[5]) };
      };
    };
    try {
      await R.run('same-file', async (ok) => {
        const at = await openPair(ref, ref);
        for (const k of [0, 1, 2, 30, 59, 45]) {
          const m = await at(k);
          ok(m.psnrY === Infinity && m.psnrRGB === Infinity, `frame ${k + 1}: PSNR Y ${m.psnrY}, RGB ${m.psnrRGB}`);
        }
        await h.closeClip(vs);
      });
      await R.run('offset-3', async (ok) => {
        // B has its first 3 frames cut: with offset -3 frame B#38 sits against A#41 and the PSNR is high.
        const at = await openPair(ref, lib.clip('cmp/offset3.mp4'));
        const m1 = await at(40, { want: 41 });
        // Mark, act, wait for that action's result: the offset alone re-pairs B and is measured once (the metrics log
        // each settled pair once), so the mark goes before the offset, not between it and the seek.
        const m0 = vs.mark();
        act({ action: 'offset', tile: 1, v: -3, unit: 'f' });
        act({ action: 'seek', t: (40 + 0.5) / 30 });
        const line = await vs.waitLog(/webview: metrics frameA=41 frameB=38 /, { from: m0, timeout: 30000, what: 'metrics with offset -3' });
        const m2 = METRICS.exec(line);
        ok(m1.psnrY < 30 && num(m2[3]) > 40, `offset 0: PSNR Y ${m1.psnrY.toFixed(1)}; offset -3: ${num(m2[3]).toFixed(1)} (frames A${m2[1]} B${m2[2]})`);
        // The first-difference search (no UI for now, kept for a later advanced mode): lined up (-3), nothing
        // below 35 dB from #41 on would be found before the end; at offset 0 the next frame already differs.
        const r0 = vs.mark();
        act({ action: 'offset', tile: 1, v: 0, unit: 'frames' });
        act({ action: 'seek', t: (40 + 0.5) / 30 });
        // The scan starts from the paired frames: it must wait for the reset to land (a timeout here is a failure).
        await vs.waitLog(/webview: metrics frameA=41 frameB=41 /, { from: r0, timeout: 30000, what: 'metrics at offset 0' });
        const s0 = vs.mark();
        act({ action: 'scan', thresh: 35 });
        const found = await vs.waitLog(/webview: scan: /, { from: s0, timeout: 30000, what: 'scan result' });
        ok(/scan: #42: PSNR Y/.test(found), `scan at offset 0 from #41: ${found.replace(/^.*webview: /, '')}`);
        await h.closeClip(vs);
      });
    } finally { await h.closeClip(vs); }
    return R.out;
  },
}];
