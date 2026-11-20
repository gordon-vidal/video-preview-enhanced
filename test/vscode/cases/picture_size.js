'use strict';
// Picture size (docs/notes/ui-simple.md "Picture size") in a real VS Code: the bar button (icon, tooltip and
// label name the mode and the next one), Z cycling Fit, Fill, Stretch, 100 %, zoomed in Z going back to Fit,
// the ⚙ Picture size page (modes, zoom row), a drag that moves pans while a click still plays / pauses,
// compare (one mode and one zoom / pan for every tile), and native ffmpeg frames sized to Fill and 100 %.
// Read through the VPE_LOG test hook: the player's `state` probe (picture, canvasRect, stageClass) and
// compare's `compare ui` line (picture.tiles).
const path = require('path');
const lib = require('../lib');

const CLIP = 'h264_aac_anim_1080p.mp4'; // 1920x1080, 16:9
const CLIP_B = 'vp9_opus_anim_1080p.webm';
const near = (a, b, tol) => Math.abs(a - b) <= tol;

module.exports = [{
  name: 'picture_size',
  settings: { 'videoPreviewEnhanced.autoplay': false, 'videoPreviewEnhanced.decoder': 'builtin' },
  async run(vs, h) {
    const R = lib.recorder();
    const P = await lib.open(vs, h, path.join(h.MEDIA, CLIP));
    const AREA = [1000, 800]; // a shape that is not the picture's: Fit has bars, Fill crops
    try {
      await P.waitFirstFrame();
      P.pause();
      P.act({ action: 'stageSize', w: AREA[0], h: AREA[1] });
      await lib.sleep(700);
      const pic = async () => { await lib.sleep(450); return P.state(); };
      const click = async (sel, text) => { await P.ask('click', text ? { sel, text } : { sel }); };

      await R.run('player/button', async (ok) => {
        let s = await pic();
        ok(s.picture.mode === 'fit' && s.picture.btnMode === 'fit' && s.stageClass === 'fit', `starts in Fit: ${JSON.stringify(s.picture)} ${s.stageClass}`);
        ok(s.picture.btnLabel === 'Picture size: Fit. Next: Fill', `label: ${s.picture.btnLabel}`);
        const [, , w, hh] = s.canvasRect;
        ok(near(w, AREA[0], 2) && near(hh, AREA[0] * 9 / 16, 2) && hh < AREA[1] - 100, `Fit shows the whole picture with bars: ${s.canvasRect}`);

        await click('#picBtn');
        s = await pic();
        ok(s.picture.mode === 'fill' && s.picture.btnLabel === 'Picture size: Fill. Next: Stretch', `Fill: ${JSON.stringify(s.picture)}`);
        const r = s.canvasRect;
        ok(r[3] >= AREA[1] - 2 && r[2] > AREA[0] + 100 && near(r[2] / r[3], 16 / 9, 0.02), `Fill covers the area, shape kept, edges cropped: ${r}`);

        await click('#picBtn');
        s = await pic();
        ok(s.picture.mode === 'stretch' && s.picture.btnMode === 'stretch', `Stretch: ${JSON.stringify(s.picture)}`);
        ok(near(s.canvasRect[2], AREA[0], 2) && near(s.canvasRect[3], AREA[1], 2), `Stretch fills the area exactly: ${s.canvasRect}`);

        await click('#picBtn');
        s = await pic();
        const k = 1 / s.dpr;
        ok(s.picture.mode === 'actual' && s.picture.btnLabel === 'Picture size: 100%. Next: Fit', `100 %: ${JSON.stringify(s.picture)}`);
        ok(near(s.canvasRect[2], 1920 * k, 2) && near(s.canvasRect[3], 1080 * k, 2), `100 % is one video pixel per device pixel: ${s.canvasRect} at ratio ${s.dpr}`);
        ok(s.picture.pct === 100, `100 % reads 100: ${s.picture.pct}`);

        await click('#picBtn');
        s = await pic();
        ok(s.picture.mode === 'fit' && s.stageClass === 'fit', `back to Fit: ${JSON.stringify(s.picture)} ${s.stageClass}`);
      });

      await R.run('player/z-cycle', async (ok) => {
        const modes = [];
        for (let i = 0; i < 4; i++) { P.key('z'); modes.push((await pic()).picture.mode); }
        ok(modes.join() === 'fill,stretch,actual,fit', `Z cycles: ${modes}`);
        // Zoomed in, Z is back to Fit first (what Z always did), not the next mode.
        P.key('z'); await pic(); // Fill
        P.key('+');
        let s = await pic();
        ok(s.picture.mode === 'fill' && s.picture.zoom > 1, `+ zooms in: ${JSON.stringify(s.picture)}`);
        P.key('z');
        s = await pic();
        ok(s.picture.mode === 'fit' && s.picture.zoom === 1 && s.stageClass === 'fit', `Z when zoomed: back to Fit: ${JSON.stringify(s.picture)} ${s.stageClass}`);
        P.key('-');
        s = await pic();
        ok(s.picture.zoom === 1, `- at Fit does not zoom out past it: ${s.picture.zoom}`);
      });

      await R.run('player/ctrl-wheel-any-mode', async (ok) => {
        P.key('z'); // Fill
        let s = await pic();
        const r = s.canvasRect;
        const pt = [r[0] + r[2] * 0.5, r[1] + r[3] * 0.5];
        for (let i = 0; i < 3; i++) { P.dom('wheel', pt[0], pt[1], { ctrl: true, deltaY: -200 }); await lib.sleep(120); }
        s = await pic();
        ok(s.picture.mode === 'fill' && s.picture.zoom > 1.5 && s.canvasRect[2] > r[2] * 1.5, `Ctrl+wheel zooms from Fill: ${JSON.stringify(s.picture)} ${s.canvasRect}`);
        P.key('z'); // back to Fit
        await pic();
      });

      await R.run('player/drag-pans', async (ok) => {
        P.key('z'); P.key('z'); P.key('z'); // 100 %
        let s = await pic();
        ok(s.picture.mode === 'actual', `100 %: ${s.picture.mode}`);
        const r0 = s.canvasRect;
        ok(r0[2] > AREA[0], `the 100 % picture is larger than the area: ${r0}`);
        const playing0 = s.playing;
        const x = s.stageRect[0] + s.stageRect[2] / 2, y = s.stageRect[1] + s.stageRect[3] / 2;
        P.dom('pointerdown', x, y); P.dom('pointermove', x - 50, y - 30); P.dom('pointermove', x - 120, y - 70); P.dom('pointerup', x - 120, y - 70);
        P.dom('click', x - 120, y - 70);
        s = await pic();
        ok(Math.abs(s.canvasRect[0] - r0[0]) > 40 || Math.abs(s.canvasRect[1] - r0[1]) > 30, `the drag moved the picture: ${r0} -> ${s.canvasRect}`);
        ok(s.playing === playing0, `a drag does not play or pause (${playing0} -> ${s.playing})`);
        // A click without movement still toggles play / pause.
        P.dom('pointerdown', x, y); P.dom('pointerup', x, y); P.dom('click', x, y);
        s = await pic();
        ok(s.playing !== playing0, `a click without movement toggles play / pause (${playing0} -> ${s.playing})`);
        P.pause();
        P.key('z');
        await pic();
      });

      await R.run('player/panel-page', async (ok) => {
        await click('#cog');
        let s = await pic();
        ok(/Picture size/.test(s.panel.text) && /Fit/.test(s.panel.text), `⚙ has a Picture size row with the mode: ${s.panel.text}`);
        await P.ask('click', { sel: 'button.row', text: 'Picture size' });
        s = await pic();
        ok(s.panel.text.includes('Fit') && s.panel.text.includes('Fill') && s.panel.text.includes('Stretch') && s.panel.text.includes('100%') && s.panel.text.includes('Zoom'), `the page lists the modes and Zoom: ${s.panel.text}`);
        ok(s.panel.rows.filter((r) => r.checked !== null).length === 4 && s.panel.rows.find((r) => r.checked === 'true').label.includes('Fit'), `four radio rows, Fit checked: ${JSON.stringify(s.panel.rows)}`);
        await P.ask('click', { sel: '[role=radio]', text: 'Fill' });
        s = await pic();
        ok(s.picture.mode === 'fill', `Fill picked in the panel: ${s.picture.mode}`);
        await P.ask('click', { sel: 'button.chip', text: '+' });
        s = await pic();
        ok(s.picture.zoom > 1 && /Zoom.*1\d\d%/.test(s.panel.text), `+ in the zoom row zooms and shows it: ${JSON.stringify(s.picture)} | ${s.panel.text}`);
        await P.ask('click', { sel: 'button.chip', text: 'Reset' });
        s = await pic();
        ok(s.picture.zoom === 1 && s.picture.mode === 'fill', `Reset puts the zoom back, the mode stays: ${JSON.stringify(s.picture)}`);
        await P.ask('click', { sel: '[role=radio]', text: 'Fit' });
        await click('#cog');
      });

      await R.run('player/sheet', async (ok) => {
        P.key('?');
        const s = await P.waitState((x) => !!x.sheet, { timeout: 5000, what: 'the shortcuts sheet' });
        ok(/Picture size: Fit, Fill, Stretch, 100 %/.test(s.sheet) && /Zoom in \/ out/.test(s.sheet), `sheet: ${s.sheet}`);
        P.key('Escape');
      });
    } finally { await P.close(); }

    // ---- compare: one mode for every tile, zoom and pan in lockstep ----
    const files = [CLIP, CLIP_B].map((c) => path.join(h.MEDIA, c));
    const tagA = CLIP.replace(/\./g, '\\.');
    const act = (o) => vs.send({ compare: true, ...o });
    let uiId = 0;
    const ui = async (delay = 450) => {
      const id = ++uiId;
      const from = vs.mark();
      act({ action: 'ui', id, delay });
      const line = await vs.waitLog(new RegExp(`webview: compare ui \\{"id":${id},`), { from, timeout: 10000 });
      return JSON.parse(/webview: compare ui (\{.*\})/.exec(line)[1]);
    };
    const click = async (o) => { act({ action: 'click', ...o }); await h.sleep(300); };
    const rel = (t) => { // the picture point at the middle of the cell, as fractions of the picture
      const [bx, by, bw, bh] = t.box, [fx, fy, fw, fh] = t.full;
      return [(bx + bw / 2 - fx) / fw, (by + bh / 2 - fy) / fh];
    };
    let ok = null;
    try {
      const from = await h.openClip(vs, files[0]);
      await vs.waitLog(new RegExp(`\\[${tagA}\\] webview: first frame shown`), { from, timeout: 45000, what: 'first frame' });
      const f2 = vs.mark();
      vs.send({ compareWith: [files[1]], name: CLIP, t: 0.5 });
      await vs.waitLog(/\[compare [^\]]*\] opened, .* 2 tiles/, { from: f2, timeout: 30000, what: 'compare opened' });
      await h.sleep(1500);
      act({ action: 'stageSize', w: 1000, h: 600 });
      await h.sleep(500);

      ok = R.t('compare/button-and-mode');
      let u = await ui();
      ok(u.picture.mode === 'fit' && u.picture.btnLabel === 'Picture size: Fit. Next: Fill' && u.bar.ids.includes('picBtn'), `starts in Fit with the button: ${JSON.stringify({ ...u.picture, tiles: undefined })} ${u.bar.ids}`);
      ok(u.picture.factor === 1, `Fit asks for the plain frame size: factor ${u.picture.factor}`);
      await click({ sel: '#picBtn' });
      u = await ui();
      ok(u.picture.mode === 'fill' && /Fill/.test(u.toast + u.live) && u.picture.factor >= 1, `button: Fill for both tiles, toast "${u.toast}": ${JSON.stringify({ ...u.picture, tiles: undefined })}`);
      ok(u.picture.tiles.length === 2 && u.picture.tiles.every((t) => t.full[2] >= t.box[2] - 1 && t.full[3] >= t.box[3] - 1), `every tile fills its cell: ${JSON.stringify(u.picture.tiles)}`);
      act({ action: 'key', key: 'z' });
      u = await ui();
      ok(u.picture.mode === 'stretch' && u.picture.tiles.every((t) => near(t.full[2], t.box[2], 1) && near(t.full[3], t.box[3], 1)), `Z: Stretch fills each cell exactly: ${JSON.stringify(u.picture)}`);
      act({ action: 'key', key: 'z' });
      u = await ui();
      ok(u.picture.mode === 'actual' && u.picture.factor > 1 && u.picture.btnLabel === 'Picture size: 100%. Next: Fit', `Z: 100 % asks for larger frames (factor ${u.picture.factor}): ${u.picture.btnLabel}`);
      ok(u.picture.pct === 100 && u.picture.tiles.every((t) => t.full[2] > t.box[2]), `100 % tiles show the file's own pixels (${u.picture.pct} %), larger than their cells: ${JSON.stringify(u.picture.tiles)}`);
      act({ action: 'key', key: 'z' });
      u = await ui();
      ok(u.picture.mode === 'fit' && u.picture.factor === 1, `Z: back to Fit: ${JSON.stringify({ ...u.picture, tiles: undefined })}`);

      ok = R.t('compare/lockstep');
      act({ action: 'key', key: 'z' }); // Fill
      await h.sleep(400);
      u = await ui();
      const t0 = u.picture.tiles[0].box;
      const px = u.stage[0] + t0[0] + t0[2] * 0.75, py = u.stage[1] + t0[1] + t0[3] * 0.3;
      for (let i = 0; i < 3; i++) { act({ action: 'dom', ev: 'wheel', x: px, y: py, ctrl: true, deltaY: -200 }); await h.sleep(150); }
      u = await ui();
      ok(u.picture.zoom > 1.5, `Ctrl+wheel on tile A zooms: ${u.picture.zoom}`);
      let [a, b] = u.picture.tiles.map(rel);
      ok(near(a[0], b[0], 0.01) && near(a[1], b[1], 0.01), `both tiles show the same part of their picture: ${a} vs ${b}`);
      ok(u.picture.tiles.every((t) => t.full[2] > t.box[2] * 1.4), `both tiles are zoomed: ${JSON.stringify(u.picture.tiles)}`);
      ok(u.picture.pannable, 'a zoomed picture can be dragged');
      const before = u.picture.tiles.map((t) => t.full.slice());
      const px2 = u.stage[0] + t0[0] + t0[2] / 2, py2 = u.stage[1] + t0[1] + t0[3] / 2;
      act({ action: 'dom', ev: 'pointerdown', x: px2, y: py2 });
      act({ action: 'dom', ev: 'pointermove', x: px2 - 40, y: py2 - 20 });
      act({ action: 'dom', ev: 'pointermove', x: px2 - 90, y: py2 - 50 });
      act({ action: 'dom', ev: 'pointerup', x: px2 - 90, y: py2 - 50 });
      await h.sleep(300);
      u = await ui();
      [a, b] = u.picture.tiles.map(rel);
      ok(near(a[0], b[0], 0.01) && near(a[1], b[1], 0.01), `after a drag on A the tiles still match: ${a} vs ${b}`);
      ok(u.picture.tiles.some((t, i) => Math.abs(t.full[0] - before[i][0]) > 20), `the drag moved the pictures: ${JSON.stringify(before)} -> ${JSON.stringify(u.picture.tiles.map((t) => t.full))}`);
      act({ action: 'key', key: 'z' }); // zoomed: back to Fit
      u = await ui();
      ok(u.picture.mode === 'fit' && u.picture.zoom === 1 && u.picture.factor === 1, `Z when zoomed: back to Fit: ${JSON.stringify({ ...u.picture, tiles: undefined })}`);

      ok = R.t('compare/panel-page');
      await click({ sel: '#cog' });
      u = await ui();
      ok(/Picture size/.test(u.panel.text), `⚙ in compare has Picture size: ${u.panel.text}`);
      await click({ text: 'Picture size' });
      u = await ui();
      ok(/Fill/.test(u.panel.text) && /Stretch/.test(u.panel.text) && /Zoom/.test(u.panel.text) && /All videos follow together/.test(u.panel.text), `page: ${u.panel.text}`);
      await click({ text: 'Stretch' });
      u = await ui();
      ok(u.picture.mode === 'stretch', `Stretch from the panel: ${u.picture.mode}`);
      await click({ text: 'Fit' });
      act({ action: 'panel' });
    } catch (e) {
      if (ok) ok(false, e.message); else R.out.push({ name: 'compare/error', ok: false, problems: [e.message] });
    }
    await h.closeClip(vs);
    return R.out;
  },
}, {
  // Native ffmpeg: frames follow the picture, a crop or 100 % included (docs/PRODUCT.md "Multi-view", ui-simple.md).
  name: 'picture_size_native',
  ffmpeg: true,
  settings: { 'videoPreviewEnhanced.autoplay': false, 'videoPreviewEnhanced.decoder': 'ffmpeg' },
  async run(vs, h) {
    const file = 'hevc_10_2160p.mp4'; // 3840x2160
    const tag = `[${file}]`;
    const problems = [];
    const from = await h.openClip(vs, path.join(h.MEDIA, file));
    await vs.waitLog(new RegExp(`${h.esc(tag)} webview: first frame shown`), { from, timeout: 45000 });
    vs.send({ action: 'pause', name: file });
    const sizes = () => vs.lines.slice(from).filter((l) => l.includes(tag) && /native decode from/.test(l)).map((l) => /: (\d+x\d+) /.exec(l.replace(/^.*native decode from [\d.]+ s/, ''))?.[1]);
    // A square area: Fit needs a 450-high picture (540 p frames), Fill a 800-high one (1080 p), 100 % the file's own 2160 p.
    vs.send({ action: 'stageSize', name: file, w: 800, h: 800 });
    await h.sleep(1500);
    vs.send({ action: 'seek', name: file, t: 0.4 });
    await h.sleep(1500);
    const fit = sizes().slice(-1)[0];
    const key = (k) => vs.send({ action: 'key', name: file, key: k });
    if (!fit || Number(fit.split('x')[1]) > 720) problems.push(`Fit frames are ${fit}, expected 540p-720p for an 800x800 area`);

    let m = vs.mark();
    key('z'); // Fill
    const fill = await vs.waitLog(new RegExp(`${h.esc(tag)} native decode from [\\d.]+ s: 1920x1080`), { from: m, timeout: 30000 }).catch(() => null);
    if (!fill) problems.push(`Fill did not grow the frames to 1920x1080 (sizes ${JSON.stringify(sizes())})`);
    await h.sleep(800);
    key('z'); // Stretch: the same picture height, the whole area
    await h.sleep(1200);
    m = vs.mark();
    key('z'); // 100 %
    const actual = await vs.waitLog(new RegExp(`${h.esc(tag)} native decode from [\\d.]+ s: 3840x2160`), { from: m, timeout: 30000 }).catch(() => null);
    if (!actual) problems.push(`100 % did not grow the frames to 3840x2160 (sizes ${JSON.stringify(sizes())})`);
    await h.sleep(800);
    m = vs.mark();
    key('z'); // Fit: smaller frames wait for the next seek
    const back = await vs.waitLog(new RegExp(`${h.esc(tag)} native: picture \\d+x\\d+: frames 3840x2160 -> ${fit} at the next seek`), { from: m, timeout: 8000 }).catch(() => null);
    if (!back) problems.push('back to Fit was not noted for the next seek');
    const errs = vs.lines.slice(from).filter((l) => l.includes(tag) && /(error:|unhandled rejection)/.test(l));
    if (errs.length) problems.push(`errors: ${errs.slice(0, 2).join(' | ')}`);
    await h.closeClip(vs);
    return [{ name: `native-frames/${file}`, ok: problems.length === 0, problems, sizes: sizes() }];
  },
}];
