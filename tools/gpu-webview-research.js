'use strict';
// Run only through: node test/benchq.js node tools/gpu-webview-research.js <scratch-dir>
// Uses the production player and hidden desktop. This measures saved H.264, not a live encoder.
const fs = require('fs');
const path = require('path');
const H = require('../test/vscode/hidden');
const lib = require('../test/vscode/lib');
const lm = require('../test/loadmon');
const dir = path.resolve(process.argv[2]);
const files = fs.readdirSync(dir).filter((f) => /^(h264_nvenc|libx264)-\d+\.mp4$/.test(f));
if (!files.length) throw new Error('no encoded MP4 controls in scratch-dir');
const rows = [];
const save = () => fs.writeFileSync(path.join(dir, 'webview.json'), JSON.stringify(rows, null, 2));
async function run(repeat, attempt = 1) {
  const code = H.findCode();
  const codeVersion = JSON.parse(fs.readFileSync(path.join(path.dirname(code.cli), '..', 'package.json'), 'utf8'))
    .version;
  const vs = new H.HiddenCode({ code, tag: 'vpe-gpu-research',
    env: { PATH: H.pathWithoutFfmpeg(), VPE_THUMB_STRIP: '0' }, settings: {
      'videoPreviewEnhanced.autoplay': false, 'videoPreviewEnhanced.loop': false,
    } });
  try {
    await vs.start();
    await vs.waitLog(/activated: module load/, { timeout: 90000 });
    for (const file of files) {
      const loadBefore = await lm.sample(1);
      const P = await lib.open(vs, H, path.join(dir, file));
      if (!P.first.firstShown) throw new Error(`no picture: ${file}`);
      const before = await P.state();
      const from = vs.mark();
      const start = performance.now();
      P.play();
      await H.sleep(8500);
      P.pause();
      const state = await P.state();
      const elapsed = (performance.now() - start) / 1000;
      vs.mark();
      const lines = vs.lines.slice(from).filter((s) => s.includes(`[${file}] webview: status`));
      const windows = lines.map((s) => {
        const m = /shownFps=([\d.]+)/.exec(s); return m ? +m[1] : null;
      }).filter((n) => n !== null).slice(1);
      const row = { file, repeat, attempt, codeVersion, loadBefore: loadBefore.load, windows,
        elapsed, presentedFps: (state.shownCount - before.shownCount) / elapsed,
        playheadRate: (state.t - before.t) / elapsed, status: lines.slice(-1), state };
      rows.push(row); save();
      console.log(JSON.stringify({ file, repeat, attempt, loadBefore: row.loadBefore, windows,
        presentedFps: row.presentedFps, playheadRate: row.playheadRate, status: row.status }));
      if (!windows.length || !lines.some((s) => / v=webcodecs\b/.test(s)) ||
          state.canvas[0] !== 3840 || state.canvas[1] !== 2160) {
        throw new Error(`missing WebCodecs or 4K canvas status: ${file}`);
      }
      await H.closeClip(vs);
    }
  } catch (e) {
    vs.mark();
    fs.writeFileSync(path.join(dir, `webview-${repeat}-${attempt}.log`), vs.lines.join('\n'));
    if ((/no WebGL2|WebGL2 is not available/.test(e.message) || vs.lines.some((s) => H.NO_WEBGL.test(s))) &&
        attempt === 1) {
      for (const row of rows) if (row.repeat === repeat && row.attempt === attempt) row.invalidInstance = true;
      save();
      console.error(`Broken WebGL2 instance in repeat ${repeat}; retrying on a fresh hidden desktop.`);
      await vs.stop();
      return run(repeat, 2);
    }
    throw e;
  } finally { await vs.stop(); }
}
(async () => { for (let r = 1; r <= 3; r++) await run(r); })()
  .catch((e) => { console.error(e.message); process.exitCode = 1; });
