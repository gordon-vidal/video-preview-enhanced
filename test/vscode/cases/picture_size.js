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
const toastAtTopCenter = (toast, stage) => toast && toast[2] > 0
  && near(toast[0] + toast[2] / 2, stage[0] + stage[2] / 2, 1)
  && toast[1] >= stage[1] && toast[1] - stage[1] <= 40 && toast[1] + toast[3] <= stage[1] + stage[3];

/**
 * The player's picture-size waits: reads `state` until pred(state) holds (bounded) and returns the last state either
 * way, so the assertion below names what was wrong instead of a timeout. `pred` is the layout the action must have
 * produced (mode and canvas rect), which replaces a fixed settle sleep.
 */
const picWait = (P, pred, timeout = 6000) => async () => {
  const t0 = Date.now();
  let s = await P.state();
  while (pred && !pred(s) && Date.now() - t0 < timeout) { await lib.sleep(100); s = await P.state(); }
  return s;
};

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
      const pic = (pred) => picWait(P, pred)();
      const click = async (sel, text) => { await P.ask('click', text ? { sel, text } : { sel }); };
      // What each mode looks like in AREA (the layout the action must have produced).
      const fitOk = (s) => s.picture.mode === 'fit' && s.picture.zoom === 1 && s.stageClass === 'fit' && near(s.canvasRect[2], AREA[0], 2);
      const fillOk = (s) => s.picture.mode === 'fill' && s.canvasRect[3] >= AREA[1] - 2;
      const stretchOk = (s) => s.picture.mode === 'stretch' && near(s.canvasRect[2], AREA[0], 2) && near(s.canvasRect[3], AREA[1], 2);
      const actualOk = (s) => s.picture.mode === 'actual' && near(s.canvasRect[2], 1920 / s.dpr, 2);
      const modeOk = { fit: fitOk, fill: fillOk, stretch: stretchOk, actual: actualOk };

      await R.run('player/button', async (ok) => {
        let s = await pic((x) => near(x.canvasRect[2], AREA[0], 2) && x.picture.btnMode === 'fit');
        ok(s.picture.mode === 'fit' && s.picture.btnMode === 'fit' && s.stageClass === 'fit', `starts in Fit: ${JSON.stringify(s.picture)} ${s.stageClass}`);
        ok(s.picture.btnLabel === 'Picture size: Fit. Next: Fill', `label: ${s.picture.btnLabel}`);
        const [, , w, hh] = s.canvasRect;
        ok(near(w, AREA[0], 2) && near(hh, AREA[0] * 9 / 16, 2) && hh < AREA[1] - 100, `Fit shows the whole picture with bars: ${s.canvasRect}`);

        await click('#picBtn');
        s = await pic(fillOk);
        ok(s.picture.mode === 'fill' && s.picture.btnLabel === 'Picture size: Fill. Next: Stretch', `Fill: ${JSON.stringify(s.picture)}`);
        ok(/^Fill \(\d+%\)$/.test(s.toast) && toastAtTopCenter(s.toastRect, s.stageRect), `Fill toast at the top centre: "${s.toast}", ${s.toastRect}`);
        const r = s.canvasRect;
        ok(r[3] >= AREA[1] - 2 && r[2] > AREA[0] + 100 && near(r[2] / r[3], 16 / 9, 0.02), `Fill covers the area, shape kept, edges cropped: ${r}`);

        await click('#picBtn');
        s = await pic(stretchOk);
        ok(s.picture.mode === 'stretch' && s.picture.btnMode === 'stretch', `Stretch: ${JSON.stringify(s.picture)}`);
        ok(/^Stretch \(\d+%\)$/.test(s.toast), `Stretch replaces the Fill toast: "${s.toast}"`);
        ok(near(s.canvasRect[2], AREA[0], 2) && near(s.canvasRect[3], AREA[1], 2), `Stretch fills the area exactly: ${s.canvasRect}`);

        await click('#picBtn');
        s = await pic(actualOk);
        const k = 1 / s.dpr;
        ok(s.picture.mode === 'actual' && s.picture.btnLabel === 'Picture size: 100%. Next: Fit', `100 %: ${JSON.stringify(s.picture)}`);
        ok(near(s.canvasRect[2], 1920 * k, 2) && near(s.canvasRect[3], 1080 * k, 2), `100 % is one video pixel per device pixel: ${s.canvasRect} at ratio ${s.dpr}`);
        ok(s.picture.pct === 100, `100 % reads 100: ${s.picture.pct}`);

        await click('#picBtn');
        s = await pic(fitOk);
        ok(s.picture.mode === 'fit' && s.stageClass === 'fit', `back to Fit: ${JSON.stringify(s.picture)} ${s.stageClass}`);
      });

      await R.run('player/z-cycle', async (ok) => {
        const modes = [];
        const expect = ['fill', 'stretch', 'actual', 'fit'];
        for (let i = 0; i < 4; i++) { P.key('z'); modes.push((await pic(modeOk[expect[i]])).picture.mode); }
        ok(modes.join() === 'fill,stretch,actual,fit', `Z cycles: ${modes}`);
        // Zoomed in, Z is back to Fit first (what Z always did), not the next mode.
        P.key('z'); await pic(fillOk); // Fill
        P.key('+');
        let s = await pic((x) => x.picture.mode === 'fill' && x.picture.zoom > 1);
        ok(s.picture.mode === 'fill' && s.picture.zoom > 1, `+ zooms in: ${JSON.stringify(s.picture)}`);
        P.key('z');
        s = await pic(fitOk);
        ok(s.picture.mode === 'fit' && s.picture.zoom === 1 && s.stageClass === 'fit', `Z when zoomed: back to Fit: ${JSON.stringify(s.picture)} ${s.stageClass}`);
        P.key('-');
        await lib.sleep(450); // a negative window: zoom must stay 1 (nothing changes to wait for)
        s = await P.state();
        ok(s.picture.zoom === 1, `- at Fit does not zoom out past it: ${s.picture.zoom}`);
      });

      await R.run('player/ctrl-wheel-any-mode', async (ok) => {
        P.key('z'); // Fill
        let s = await pic(fillOk);
        const r = s.canvasRect;
        const pt = [r[0] + r[2] * 0.5, r[1] + r[3] * 0.5];
        for (let i = 0; i < 3; i++) { P.dom('wheel', pt[0], pt[1], { ctrl: true, deltaY: -200 }); await lib.sleep(120); }
        s = await pic((x) => x.picture.zoom > 1.5 && x.canvasRect[2] > r[2] * 1.5);
        ok(s.picture.mode === 'fill' && s.picture.zoom > 1.5 && s.canvasRect[2] > r[2] * 1.5, `Ctrl+wheel zooms from Fill: ${JSON.stringify(s.picture)} ${s.canvasRect}`);
        P.key('z'); // back to Fit
        await pic(fitOk);
      });

      await R.run('player/drag-pans', async (ok) => {
        P.key('z'); P.key('z'); P.key('z'); // 100 %
        let s = await pic(actualOk);
        ok(s.picture.mode === 'actual', `100 %: ${s.picture.mode}`);
        const r0 = s.canvasRect;
        ok(r0[2] > AREA[0], `the 100 % picture is larger than the area: ${r0}`);
        const playing0 = s.playing;
        const x = s.stageRect[0] + s.stageRect[2] / 2, y = s.stageRect[1] + s.stageRect[3] / 2;
        P.dom('pointerdown', x, y); P.dom('pointermove', x - 50, y - 30); P.dom('pointermove', x - 120, y - 70); P.dom('pointerup', x - 120, y - 70);
        P.dom('click', x - 120, y - 70);
        s = await pic((q) => Math.abs(q.canvasRect[0] - r0[0]) > 40 || Math.abs(q.canvasRect[1] - r0[1]) > 30);
        ok(Math.abs(s.canvasRect[0] - r0[0]) > 40 || Math.abs(s.canvasRect[1] - r0[1]) > 30, `the drag moved the picture: ${r0} -> ${s.canvasRect}`);
        ok(s.playing === playing0, `a drag does not play or pause (${playing0} -> ${s.playing})`);
        // A click without movement still toggles play / pause.
        P.dom('pointerdown', x, y); P.dom('pointerup', x, y); P.dom('click', x, y);
        s = await pic((q) => q.playing !== playing0);
        ok(s.playing !== playing0, `a click without movement toggles play / pause (${playing0} -> ${s.playing})`);
        P.pause();
        P.key('z');
        await pic((q) => !q.playing && fitOk(q));
      });

      await R.run('player/panel-page', async (ok) => {
        await click('#cog');
        let s = await pic((x) => x.panel && x.panel.view === 'main');
        ok(/Picture size/.test(s.panel.text) && /Fit/.test(s.panel.text), `⚙ has a Picture size row with the mode: ${s.panel.text}`);
        await P.ask('click', { sel: 'button.row', text: 'Picture size' });
        s = await pic((x) => x.panel && /Zoom/.test(x.panel.text) && /Stretch/.test(x.panel.text));
        ok(s.panel.text.includes('Fit') && s.panel.text.includes('Fill') && s.panel.text.includes('Stretch') && s.panel.text.includes('100%') && s.panel.text.includes('Zoom'), `the page lists the modes and Zoom: ${s.panel.text}`);
        ok(s.panel.rows.filter((r) => r.checked !== null).length === 4 && s.panel.rows.find((r) => r.checked === 'true').label.includes('Fit'), `four radio rows, Fit checked: ${JSON.stringify(s.panel.rows)}`);
        await P.ask('click', { sel: '[role=radio]', text: 'Fill' });
        s = await pic((x) => x.picture.mode === 'fill');
        ok(s.picture.mode === 'fill', `Fill picked in the panel: ${s.picture.mode}`);
        await P.ask('click', { sel: 'button.chip', text: '+' });
        s = await pic((x) => x.picture.zoom > 1 && x.panel && /Zoom.*1\d\d%/.test(x.panel.text));
        ok(s.picture.zoom > 1 && /Zoom.*1\d\d%/.test(s.panel.text), `+ in the zoom row zooms and shows it: ${JSON.stringify(s.picture)} | ${s.panel.text}`);
        await P.ask('click', { sel: 'button.chip', text: 'Reset' });
        s = await pic((x) => x.picture.zoom === 1 && x.picture.mode === 'fill');
        ok(s.picture.zoom === 1 && s.picture.mode === 'fill', `Reset puts the zoom back, the mode stays: ${JSON.stringify(s.picture)}`);
        await P.ask('click', { sel: '[role=radio]', text: 'Fit' });
        await pic((x) => x.picture.mode === 'fit');
        await click('#cog');
        await pic((x) => !x.panel);
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
    const ui1 = async (delay = 60) => {
      const id = ++uiId;
      const from = vs.mark();
      act({ action: 'ui', id, delay });
      const line = await vs.waitLog(new RegExp(`webview: compare ui \\{"id":${id},`), { from, timeout: 10000 });
      return JSON.parse(/webview: compare ui (\{.*\})/.exec(line)[1]);
    };
    // Reads compare's ui until pred(u) holds (bounded) and returns the last one either way: the assertion names the miss.
    const ui = async (pred, timeout = 6000) => {
      const t0 = Date.now();
      let u = await ui1();
      while (pred && !pred(u) && Date.now() - t0 < timeout) { await h.sleep(100); u = await ui1(); }
      return u;
    };
    const click = async (o) => { act({ action: 'click', ...o }); };
    const fitU = (u) => u.picture.mode === 'fit' && u.picture.zoom === 1 && u.picture.factor === 1;
    const fillU = (u) => u.picture.mode === 'fill' && u.picture.tiles.length === 2 && u.picture.tiles.every((t) => t.full[2] >= t.box[2] - 1 && t.full[3] >= t.box[3] - 1);
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
      await ui((x) => x.picture.tiles.length === 2 && x.picture.tiles.every((t) => t.box[2] > 0));
      act({ action: 'stageSize', w: 1000, h: 600 });

      ok = R.t('compare/button-and-mode');
      let u = await ui((x) => near(x.stage[2], 1000, 2) && near(x.stage[3], 600, 2) && fitU(x));
      ok(u.picture.mode === 'fit' && u.picture.btnLabel === 'Picture size: Fit. Next: Fill' && u.bar.ids.includes('picBtn'), `starts in Fit with the button: ${JSON.stringify({ ...u.picture, tiles: undefined })} ${u.bar.ids}`);
      ok(u.picture.factor === 1, `Fit asks for the plain frame size: factor ${u.picture.factor}`);
      await click({ sel: '#picBtn' });
      u = await ui((x) => fillU(x) && /^Fill \(\d+%\)$/.test(x.toast) && /^Fill \(\d+%\)$/.test(x.live) && x.picture.factor >= 1);
      ok(u.picture.mode === 'fill' && u.picture.factor >= 1, `button: Fill for both tiles: ${JSON.stringify({ ...u.picture, tiles: undefined })}`);
      ok(/^Fill \(\d+%\)$/.test(u.toast) && /^Fill \(\d+%\)$/.test(u.live) && toastAtTopCenter(u.toastRect, u.stage),
        `Fill toast at the top centre and in the live region: "${u.toast}", "${u.live}", ${u.toastRect}`);
      ok(u.picture.tiles.length === 2 && u.picture.tiles.every((t) => t.full[2] >= t.box[2] - 1 && t.full[3] >= t.box[3] - 1), `every tile fills its cell: ${JSON.stringify(u.picture.tiles)}`);
      act({ action: 'key', key: 'z' });
      u = await ui((x) => x.picture.mode === 'stretch' && x.picture.tiles.every((t) => near(t.full[2], t.box[2], 1) && near(t.full[3], t.box[3], 1)));
      ok(u.picture.mode === 'stretch' && u.picture.tiles.every((t) => near(t.full[2], t.box[2], 1) && near(t.full[3], t.box[3], 1)), `Z: Stretch fills each cell exactly: ${JSON.stringify(u.picture)}`);
      act({ action: 'key', key: 'z' });
      u = await ui((x) => x.picture.mode === 'actual' && x.picture.factor > 1 && x.picture.tiles.every((t) => t.full[2] > t.box[2]));
      ok(u.picture.mode === 'actual' && u.picture.factor > 1 && u.picture.btnLabel === 'Picture size: 100%. Next: Fit', `Z: 100 % asks for larger frames (factor ${u.picture.factor}): ${u.picture.btnLabel}`);
      ok(u.picture.pct === 100 && u.picture.tiles.every((t) => t.full[2] > t.box[2]), `100 % tiles show the file's own pixels (${u.picture.pct} %), larger than their cells: ${JSON.stringify(u.picture.tiles)}`);
      act({ action: 'key', key: 'z' });
      u = await ui(fitU);
      ok(u.picture.mode === 'fit' && u.picture.factor === 1, `Z: back to Fit: ${JSON.stringify({ ...u.picture, tiles: undefined })}`);

      ok = R.t('compare/lockstep');
      act({ action: 'key', key: 'z' }); // Fill
      u = await ui(fillU);
      const t0 = u.picture.tiles[0].box;
      const px = u.stage[0] + t0[0] + t0[2] * 0.75, py = u.stage[1] + t0[1] + t0[3] * 0.3;
      for (let i = 0; i < 3; i++) { act({ action: 'dom', ev: 'wheel', x: px, y: py, ctrl: true, deltaY: -200 }); await h.sleep(150); }
      u = await ui((x) => x.picture.zoom > 1.5 && x.picture.tiles.every((t) => t.full[2] > t.box[2] * 1.4));
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
      u = await ui((x) => x.picture.tiles.some((t, i) => Math.abs(t.full[0] - before[i][0]) > 20));
      [a, b] = u.picture.tiles.map(rel);
      ok(near(a[0], b[0], 0.01) && near(a[1], b[1], 0.01), `after a drag on A the tiles still match: ${a} vs ${b}`);
      ok(u.picture.tiles.some((t, i) => Math.abs(t.full[0] - before[i][0]) > 20), `the drag moved the pictures: ${JSON.stringify(before)} -> ${JSON.stringify(u.picture.tiles.map((t) => t.full))}`);
      ok = R.t('compare/pan-paused');
      act({ action: 'stageSize', w: 700, h: 450 }); // inside the hidden window: elementFromPoint is null outside the viewport
      await ui((x) => near(x.stage[2], 700, 2) && near(x.stage[3], 450, 2));
      // A drag pans a zoomed picture also while paused, after a step and after a seek, at several zoom levels,
      // starting from the middle of either tile and near its corners (regression: a paused drag was sometimes ignored).
      act({ action: 'pause' });
      const dragOnce = async (tile, fx, fy, dx, dy) => {
        const t = (await ui()).picture.tiles[tile].box;
        // fx 'pill': on the tile's name pill (a button over the picture's top corner); else a fraction of the tile
        const x = u.stage[0] + t[0] + (fx === 'pill' ? (tile === 0 ? 30 : t[2] - 30) : t[2] * fx), y = u.stage[1] + t[1] + (fx === 'pill' ? 22 : t[3] * fy);
        const mark0 = vs.mark();
        act({ action: 'dom', ev: 'pointerdown', x, y });
        act({ action: 'dom', ev: 'pointermove', x: x + dx / 2, y: y + dy / 2 });
        act({ action: 'dom', ev: 'pointermove', x: x + dx, y: y + dy });
        act({ action: 'dom', ev: 'pointerup', x: x + dx, y: y + dy });
        await h.sleep(250); // a drag that hits an edge moves nothing: there is no result to wait for
        if (fx === 'pill') {
          await vs.waitLog(/webview: dom target/, { from: mark0, timeout: 5000 }).catch(() => null);
          const l = vs.lines.slice(mark0).filter((q) => /webview: dom target/.test(q))[0] || '';
          if (!/dom target (BUTTON|SPAN)/.test(l)) ok(false, `the drag did not start on the name pill: ${l.replace(/^.*webview: /, '')}`);
        }
      };
      const panWorks = async (label, tile, fx, fy) => {
        for (const sign of [-1, 1]) { // one direction can be against the edge: the other must move
          const b = (await ui()).picture.tiles.map((q) => q.full.slice());
          await dragOnce(tile, fx, fy, 60 * sign, 30 * sign);
          const n = (await ui()).picture.tiles.map((q) => q.full.slice());
          if (n.some((q, i) => Math.abs(q[0] - b[i][0]) > 10)) return true;
        }
        ok(false, `${label}: the drag did not move the pictures`);
        return false;
      };
      for (const zoomSteps of [2, 6]) {
        act({ action: 'key', key: 'z' }); // back to Fit
        u = await ui(fitU);
        const c0 = u.picture.tiles[0].box;
        for (let i = 0; i < zoomSteps; i++) { act({ action: 'dom', ev: 'wheel', x: u.stage[0] + c0[0] + c0[2] / 2, y: u.stage[1] + c0[1] + c0[3] / 2, ctrl: true, deltaY: -200 }); await h.sleep(120); }
        u = await ui((x) => x.picture.zoom > 1 && x.picture.pannable);
        ok(u.picture.zoom > 1 && u.picture.pannable, `zoomed (${zoomSteps}): ${u.picture.zoom}`);
        for (const phase of ['paused', 'after a step', 'after a seek']) {
          if (phase === 'after a step' || phase === 'after a seek') {
            const time0 = (await ui()).bar.time;
            act(phase === 'after a step' ? { action: 'step', d: 1 } : { action: 'seek', t: 0.8 });
            await ui((x) => x.bar.time !== time0, 4000);
          }
          for (const [tile, fx, fy] of [[0, 0.5, 0.5], [1, 0.5, 0.5], [0, 0.15, 0.85], [1, 0.9, 0.1], [0, 'pill', 0], [1, 'pill', 0]]) {
            await panWorks(`zoom x${u.picture.zoom.toFixed(2)} ${phase}, tile ${tile} at ${fx},${fy}`, tile, fx, fy);
          }
        }
      }
      act({ action: 'key', key: 'z' }); // zoomed: back to Fit
      u = await ui(fitU);
      ok(u.picture.mode === 'fit' && u.picture.zoom === 1 && u.picture.factor === 1, `Z when zoomed: back to Fit: ${JSON.stringify({ ...u.picture, tiles: undefined })}`);

      ok = R.t('compare/panel-page');
      await click({ sel: '#cog' });
      u = await ui((x) => x.panel && x.panel.view === 'main');
      ok(/Picture size/.test(u.panel.text), `⚙ in compare has Picture size: ${u.panel.text}`);
      await click({ text: 'Picture size' });
      u = await ui((x) => x.panel && /All videos follow together/.test(x.panel.text));
      ok(/Fill/.test(u.panel.text) && /Stretch/.test(u.panel.text) && /Zoom/.test(u.panel.text) && /All videos follow together/.test(u.panel.text), `page: ${u.panel.text}`);
      await click({ text: 'Stretch' });
      u = await ui((x) => x.picture.mode === 'stretch');
      ok(u.picture.mode === 'stretch', `Stretch from the panel: ${u.picture.mode}`);
      await click({ text: 'Fit' });
      await ui((x) => x.picture.mode === 'fit');
      act({ action: 'panel' });
    } catch (e) {
      if (ok) ok(false, e.message); else R.out.push({ name: 'compare/error', ok: false, problems: [e.message] });
    }
    await h.closeClip(vs);
    return R.out;
  },
}, {
  // Fit enlarges a small video (like object-fit: contain): 640x360 in a 1000x800 and a 400x800 area fills the width.
  name: 'picture_size_small',
  settings: { 'videoPreviewEnhanced.autoplay': false, 'videoPreviewEnhanced.decoder': 'builtin' },
  async run(vs, h) {
    const R = lib.recorder();
    const P = await lib.open(vs, h, path.join(h.MEDIA, 'cases', 'bars75_sd_709.mp4'));
    try {
      await P.waitFirstFrame();
      P.pause();
      const pic = (pred) => picWait(P, pred)();
      await R.run('small/fit-fills', async (ok) => {
        P.act({ action: 'stageSize', w: 1000, h: 800 });
        let s = await pic((x) => near(x.canvasRect[2], 1000, 2) && near(x.canvasRect[3], 562.5, 2));
        let [, , w, hh] = s.canvasRect;
        ok(s.picture.mode === 'fit' && near(w, 1000, 2) && near(hh, 562.5, 2), `a 640x360 clip in Fit fills the width of a 1000x800 area: ${s.canvasRect} ${s.stageClass}`);
        P.act({ action: 'stageSize', w: 1600, h: 400 });
        s = await pic((x) => near(x.canvasRect[3], 400, 2) && near(x.canvasRect[2], 711.1, 2));
        [, , w, hh] = s.canvasRect;
        ok(near(hh, 400, 2) && near(w, 711.1, 2), `... and the height of a wide, short area: ${s.canvasRect}`);
        ok(s.picture.pct > 100 && s.picture.zoom === 1, `Fit shows it enlarged (${s.picture.pct} %), zoom 1: ${JSON.stringify(s.picture)}`);
        P.act({ action: 'stageSize', w: 400, h: 800 });
        s = await pic((x) => near(x.canvasRect[2], 400, 2) && near(x.canvasRect[3], 225, 2));
        ok(near(s.canvasRect[2], 400, 2) && near(s.canvasRect[3], 225, 2), `a small area shrinks it as before: ${s.canvasRect}`);
      });
      await R.run('small/actual-and-zoom', async (ok) => {
        P.act({ action: 'stageSize', w: 1000, h: 800 });
        await pic((x) => near(x.canvasRect[2], 1000, 2));
        P.key('z'); P.key('z'); P.key('z'); // 100 %
        let s = await pic((x) => x.picture.mode === 'actual' && near(x.canvasRect[2], 640 / x.dpr, 2));
        const k = 1 / s.dpr;
        ok(s.picture.mode === 'actual' && near(s.canvasRect[2], 640 * k, 2) && s.picture.pct === 100, `100 % stays pixel for pixel: ${s.canvasRect} ${JSON.stringify(s.picture)}`);
        P.key('z'); // Fit
        await pic((x) => x.picture.mode === 'fit' && near(x.canvasRect[2], 1000, 2));
        P.key('+');
        s = await pic((x) => x.picture.zoom > 1 && x.canvasRect[2] > 1000);
        ok(s.picture.zoom > 1 && s.canvasRect[2] > 1000, `+ zooms the enlarged Fit further: ${JSON.stringify(s.picture)} ${s.canvasRect}`);
        P.key('z');
        s = await pic((x) => x.picture.mode === 'fit' && near(x.canvasRect[2], 1000, 2));
        ok(s.picture.mode === 'fit' && near(s.canvasRect[2], 1000, 2), `Z: back to the enlarged Fit: ${s.canvasRect}`);
      });
    } finally { await P.close(); }
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
    key('z'); // Stretch: the same picture height, the whole area
    m = vs.mark();
    key('z'); // 100 %
    const actual = await vs.waitLog(new RegExp(`${h.esc(tag)} native decode from [\\d.]+ s: 3840x2160`), { from: m, timeout: 30000 }).catch(() => null);
    if (!actual) problems.push(`100 % did not grow the frames to 3840x2160 (sizes ${JSON.stringify(sizes())})`);
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
