'use strict';
// The player's bar and panels in a real VS Code (docs/notes/ui-simple.md, docs/notes/a11y.md): names, roles
// and states of the bar's controls, the seek bar's time as aria-valuetext, the polite live region, a click
// on the picture (play / pause, or closing a panel), each panel button toggling its panel, keyboard focus
// in the panels and the shortcuts sheet, subtitle controls, speed step and clamp, jump sizes (from the
// panel and from the settings), and the "About this video" facts for a WebAssembly and a native file.
// Read through the VPE_LOG test hook: the player's `a11y` and `state` probes (media/player.js debugProbe)
// and compare's `compare a11y` line (media/compare.js).
const fs = require('fs');
const os = require('os');
const path = require('path');
const lib = require('../lib');

const CLIP = 'h264_aac_anim_1080p.mp4';
const CLIP_B = 'hevc_8_1080p.mp4';

/** The centre of the picture, for synthetic clicks. */
const centre = (s) => [s.video[0] + s.video[2] / 2, s.video[1] + s.video[3] / 2];

async function jumpChecks(P, ok, want) {
  const at = async (t) => { P.seek(t); return (await P.waitState((s) => Math.abs(s.t - t) < 0.06, { timeout: 8000, what: `seek ${t}` })).t; };
  const after = async (key, o, what) => {
    const s0 = await P.state();
    P.key(key, o);
    const s1 = await P.waitState((s) => Math.abs(s.t - s0.t) > 1e-3, { timeout: 8000, what });
    await lib.sleep(300);
    const s2 = await P.state();
    return { dt: s2.t - s0.t, df: s2.frame - s0.frame };
  };
  const fps = (await P.state()).fps || 30;
  for (const [key, o, size, name] of [['ArrowRight', {}, want.arrow, '→'], ['ArrowLeft', {}, want.arrow, '←'], ['ArrowRight', { shift: true }, want.shift, 'Shift+→'], ['ArrowLeft', { ctrl: true }, want.ctrl, 'Ctrl+←']]) {
    const dir = /Left/.test(key) ? -1 : 1;
    await at(dir > 0 ? 4 : 16); // 20 s clip: room for 10 s either way
    const r = await after(key, o, name);
    if (size === 'frame') ok(r.df === dir, `${name}: ${r.df} frames (${r.dt.toFixed(3)} s), expected one frame`);
    else ok(Math.abs(r.dt - dir * size) < 1.5 / fps + 0.02, `${name}: ${r.dt.toFixed(3)} s, expected ${dir * size} s`);
  }
}

module.exports = [{
  name: 'ui',
  async run(vs, h) {
    const R = lib.recorder();
    const P = await lib.open(vs, h, path.join(h.MEDIA, CLIP));
    const a11y = (extra = {}) => P.ask('a11y', extra);
    const settle = (ms = 400) => h.sleep(ms);
    P.pause();
    await settle(600);

    await R.run('a11y/names', async (ok) => {
      const s = await a11y();
      const c = s.controls;
      ok(s.unnamed.length === 0, `buttons without a name in words: ${JSON.stringify(s.unnamed)}`);
      const want = { play: 'Play', prev: 'Previous frame', next: 'Next frame', full: 'Fullscreen', infoBtn: 'About this video', startCompareBtn: 'Compare', cog: 'Settings', seek: 'Position', volume: 'Volume', canvas: 'Video' };
      for (const [k, v] of Object.entries(want)) ok(c[k] && c[k]['aria-label'] === v, `#${k}: aria-label ${JSON.stringify(c[k] && c[k]['aria-label'])}, expected ${v}`);
      ok(/^(Mute|Unmute)$/.test(c.mute['aria-label']) && /^Speed \d/.test(c.rate['aria-label']) && /^Subtitles/.test(c.tracks['aria-label']) && /^Position .*frame \d+/.test(c.time['aria-label']), `mute / rate / tracks / time: ${JSON.stringify([c.mute, c.rate, c.tracks, c.time])}`);
      ok(c.mute && /^(true|false)$/.test(c.mute['aria-pressed']), `#mute: no aria-pressed (${JSON.stringify(c.mute)})`);
      for (const k of ['tracks', 'infoBtn', 'rate', 'cog']) ok(c[k]['aria-expanded'] === 'false', `#${k}: ${JSON.stringify(c[k])}`);
      for (const k of ['modeBtn', 'toolsBtn', 'loop', 'pip']) ok(!c[k], `#${k} is still on the page`);
      ok(/^\d+:\d\d\.\d{3} of \d+:\d\d\.\d{3}, frame \d+$/.test(c.seek['aria-valuetext'] || ''), `seek aria-valuetext ${JSON.stringify(c.seek['aria-valuetext'])}`);
      ok(s.live && s.live.role === 'status' && s.live.polite === 'polite', `live region ${JSON.stringify(s.live)}`);
      const st = await P.state();
      ok(!('pill' in st) && st.status !== undefined, 'the status pill is gone');
    });

    await R.run('a11y/states-and-live', async (ok) => {
      let s = await a11y();
      const loop0 = s.loop;
      P.key('r');
      await settle();
      s = await a11y();
      ok(s.loop === !loop0, `R: loop ${s.loop}`);
      ok(s.live.text === (s.loop ? 'Loop on' : 'Loop off'), `R: the live region says ${JSON.stringify(s.live.text)}`);
      P.key('r');
      await settle();
      const muted0 = (await a11y()).muted;
      P.key('m');
      await settle();
      s = await a11y();
      ok(s.muted === !muted0 && s.controls.mute['aria-pressed'] === String(!muted0) && s.controls.mute['aria-label'] === (s.muted ? 'Unmute' : 'Mute'), `M: muted ${muted0} -> ${s.muted}, ${JSON.stringify(s.controls.mute)}`);
      P.key('m');
      await settle();
      P.play();
      await settle(600);
      s = await a11y();
      ok(s.playing && s.controls.play['aria-label'] === 'Pause', `playing: play button label ${s.controls.play['aria-label']}`);
      P.pause();
      await settle(600);
      s = await a11y();
      ok(!s.playing && s.controls.play['aria-label'] === 'Play', `paused: play button label ${s.controls.play['aria-label']}`);
    });

    await R.run('keys/focused-controls', async (ok) => {
      let s = await a11y({ focus: '#mute' });
      ok(s.active === 'mute' && s.focusVisible, `focus is on ${s.active} (focus-visible ${s.focusVisible})`);
      ok(s.outline && !/^none/.test(s.outline) && !/ 0px$/.test(s.outline), `no focus outline on #mute (${s.outline})`);
      P.key(' ', { target: '#mute' });
      await settle(600);
      s = await a11y();
      ok(!s.playing, 'Space on the keyboard-focused mute button started playback');
      P.key(' ');
      await settle(600);
      s = await a11y();
      ok(s.playing, 'Space on the page did not start playback');
      P.pause();
      await settle(400);
    });

    await R.run('picture/click', async (ok) => {
      let s = await P.state();
      const [x, y] = centre(s);
      P.dom('click', x, y);
      s = await P.waitState((q) => q.playing, { timeout: 4000, what: 'click on the picture plays' });
      ok(s.playing, 'click did not play');
      P.dom('click', x, y);
      s = await P.waitState((q) => !q.playing, { timeout: 4000, what: 'second click pauses' });
      ok(!s.playing, 'second click did not pause');
      // With a panel open, a click on the picture only closes it.
      await P.ask('click', { sel: '#cog' });
      await settle(300);
      s = await P.state();
      ok(s.panel && s.panel.view === 'main', `cog: panel ${JSON.stringify(s.panel && s.panel.view)}`);
      P.dom('click', x, y);
      await settle(500);
      s = await P.state();
      ok(!s.panel && !s.playing, `click with the panel open: panel ${JSON.stringify(s.panel && s.panel.view)}, playing ${s.playing}`);
    });

    await R.run('panels/toggle', async (ok) => {
      for (const [sel, view, exp] of [['#cog', 'main', 'cogExpanded'], ['#infoBtn', 'info', 'infoExpanded'], ['#rate', 'speed', 'rateExpanded']]) {
        await P.ask('click', { sel });
        await settle(300);
        let s = await P.state();
        ok(s.panel && s.panel.view === view && s.bar[exp] === 'true', `${sel}: panel ${JSON.stringify(s.panel && s.panel.view)}, ${exp} ${s.bar[exp]}`);
        await P.ask('click', { sel });
        await settle(300);
        s = await P.state();
        ok(!s.panel && s.bar[exp] === 'false', `${sel} again: panel ${JSON.stringify(s.panel && s.panel.view)}, ${exp} ${s.bar[exp]}`);
      }
      // Another button switches the page; the cog closes whatever is open.
      await P.ask('click', { sel: '#infoBtn' });
      await P.ask('click', { sel: '#rate' });
      await settle(300);
      let s = await P.state();
      ok(s.panel && s.panel.view === 'speed' && s.bar.infoExpanded === 'false', `info then speed: ${JSON.stringify(s.panel && s.panel.view)}`);
      await P.ask('click', { sel: '#cog' });
      await settle(300);
      s = await P.state();
      ok(!s.panel, 'the cog did not close the speed panel');
      // The main page: rows of the mock-up, tools grid.
      await P.ask('click', { sel: '#cog' });
      await settle(300);
      s = await P.state();
      const labels = s.panel.rows.map((r) => r.label);
      for (const want of ['Speed', 'Loop', 'A-B loop', 'Subtitles', 'Audio track', 'Copy frame', 'Keyboard shortcuts', 'Jump sizes', 'Compare', 'Scopes', 'Inspector', 'Stats', 'Codec X-ray', 'Export A-B', 'Open video URL…', 'Extension settings']) ok(labels.some((l) => l.includes(want)), `main page has no ${want}: ${JSON.stringify(labels)}`);
      ok(/Jump sizes\s*5 s · 1 s · 1 frame/.test(s.panel.text), `jump summary: ${s.panel.text}`);
      // A tool from the grid, without any mode switch: scopes.
      await P.ask('click', { sel: '#panel button.tool', text: 'Scopes' });
      await settle(1200);
      const r = await P.ask('scopesDump');
      ok(r.mode !== 'off' && !r.hidden, `Scopes from the grid: ${r.mode}`);
      ok(!(await P.state()).panel, 'running a tool leaves the panel open');
      P.key('w'); P.key('w'); P.key('w'); P.key('w');
      await settle(400);
    });

    await R.run('panels/keyboard', async (ok) => {
      P.act({ action: 'panel' });
      await settle(200);
      await P.ask('click', { sel: '#cog' });
      await settle(300);
      let s = await a11y();
      ok(s.panel.view === 'main' && s.active !== 'cog' && s.activeRole === 'button', `focus in the open panel: ${s.active} (${s.activeRole})`);
      const first = s.active;
      P.key('ArrowDown', { target: ':focus' });
      await settle(300);
      s = await a11y();
      ok(s.active !== first, `ArrowDown: focus ${first} -> ${s.active}`);
      ok(s.panel.radios.some((x) => x.role === 'switch'), `loop is a switch: ${JSON.stringify(s.panel.radios)}`);
      P.key('Escape', { target: ':focus' });
      await settle(300);
      s = await a11y();
      ok(s.panel.hidden && s.active === 'cog' && s.controls.cog['aria-expanded'] === 'false', `Escape: panel hidden=${s.panel.hidden}, focus on ${s.active}`);
      ok(!s.playing, 'Escape changed playback');
      // The shortcuts sheet: ? opens it (a modal dialog, focus on Close), Escape closes it.
      P.key('?');
      await settle(400);
      s = await a11y();
      ok(!s.sheet.hidden && s.sheet.dialog && s.sheet.dialog.modal === 'true' && s.active === 'Close', `sheet: ${JSON.stringify(s.sheet)}, focus ${s.active}`);
      for (const g of ['Playback', 'Seek', 'Frames', 'Sound', 'View', 'Files and help']) ok(s.sheet.dialog && s.sheet.dialog.groups.includes(g), `sheet group ${g} missing`);
      const st = await P.state();
      ok(/Back \/ forward 5 s/.test(st.sheet) && /Volume ±5 %/.test(st.sheet) && !/Alt\+/.test(st.sheet), `sheet text: ${String(st.sheet).slice(0, 300)}`);
      P.key('Escape', { target: ':focus' });
      await settle(300);
      s = await a11y();
      ok(s.sheet.hidden && s.active === 'cog', `Escape: sheet hidden=${s.sheet.hidden}, focus on ${s.active}`);
      await P.ask('click', { sel: '#cog' });
      await P.ask('click', { sel: '#panel button[aria-keyshortcuts="?"][aria-haspopup="dialog"]', text: 'Keyboard shortcuts' });
      s = await a11y();
      ok(!s.sheet.hidden && s.sheet.dialog?.label === 'Keyboard shortcuts' && s.panel.hidden && s.active === 'Close',
        `settings row: sheet ${JSON.stringify(s.sheet)}, panel hidden=${s.panel.hidden}, focus on ${s.active}`);
      P.key('Escape', { target: ':focus' });
      s = await a11y();
      ok(s.sheet.hidden && s.active === 'cog', `Escape: sheet hidden=${s.sheet.hidden}, focus on ${s.active}`);
    });

    await R.run('cc/hidden-until-loaded', async (ok) => {
      ok((await P.state()).bar.ccHidden, 'CC should be hidden without tracks');
      // C without subtitles opens ⚙ › Subtitles (to load a file); C again closes it.
      P.key('c');
      let s = await P.waitState((q) => q.panel?.view === 'subs', { what: 'C opens Settings › Subtitles' });
      ok(/no subtitle tracks/.test(s.panel.text), `C without subtitles: ${JSON.stringify(s.panel)}`);
      P.key('c');
      await P.waitState((q) => !q.panel, { what: 'C again closes the page' });
      await P.ask('click', { sel: '#cog' });
      await P.ask('click', { sel: '#panel button', text: 'Subtitles' });
      s = await P.state();
      ok(s.panel?.view === 'subs' && /no subtitle tracks/.test(s.panel.text), `Settings › Subtitles: ${JSON.stringify(s.panel)}`);
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vpe-ui-subtitles-'));
      const file = path.join(dir, 'loaded.srt');
      try {
        fs.writeFileSync(file, '1\n00:00:00,000 --> 00:00:02,000\nLoaded from Settings\n');
        const mark = vs.mark();
        vs.send({ name: CLIP, pickSubtitles: [file] });
        await vs.waitLog(/debug subtitles picker ready/, { from: mark, timeout: 10000 });
        await P.ask('click', { sel: '#panel button', text: 'Load subtitle file…' });
        const loaded = await P.waitState((q) => !q.bar.ccHidden, { what: 'CC visible after loading an SRT' });
        ok(/^Subtitles on: loaded\.srt/.test(loaded.bar.cc), `loaded track label: ${loaded.bar.cc}`);
        await P.ask('click', { sel: '#tracks' });
        await P.waitState((q) => q.bar.cc === 'Subtitles off', { what: 'CC turns the loaded track off' });
      } finally {
        fs.rmSync(file, { force: true });
        fs.rmdirSync(dir);
      }
    });

    await R.run('speed/step-and-clamp', async (ok) => {
      const rateNow = async () => (await P.report()).rate;
      P.rate(1);
      await settle(300);
      P.key('>');
      await settle(300);
      ok(Math.abs(await rateNow() - 1.05) < 1e-6, 'Shift+> is not +0.05');
      P.key('<'); P.key('<');
      await settle(300);
      ok(Math.abs(await rateNow() - 0.95) < 1e-6, 'Shift+< twice is not 0.95');
      let s = await P.state();
      ok(s.bar.rate === '0.95×', `bar speed label ${s.bar.rate}`);
      P.rate(3.95);
      await settle(200);
      P.key('>'); P.key('>'); P.key('>');
      await settle(300);
      ok(await rateNow() === 4, 'speed is not clamped to 4×');
      P.rate(0.3);
      await settle(200);
      P.key('<'); P.key('<'); P.key('<');
      await settle(300);
      ok(await rateNow() === 0.25, 'speed is not clamped to 0.25×');
      // Wheel over the speed button: +0.05 per notch up.
      P.act({ action: 'dom', ev: 'wheel', target: 'rate', deltaY: -100 });
      await settle(300);
      ok(Math.abs(await rateNow() - 0.3) < 1e-6, 'wheel up over the speed button is not +0.05');
      await P.ask('click', { sel: '#rate' });
      await settle(300);
      s = await P.state();
      ok(s.panel && s.panel.view === 'speed' && JSON.stringify(s.panel.slider) === '["0.25","4"]', `speed panel slider ${JSON.stringify(s.panel && s.panel.slider)}`);
      ok(['0.5×', '1×', '1.5×', '2×', '3×', '4×'].every((l) => s.panel.rows.some((r) => r.label === `Speed ${l}`)), `presets on the slider: ${JSON.stringify(s.panel.rows.map((r) => r.label))}`);
      await P.ask('click', { sel: '#panel button.mark', text: '2×' });
      await settle(300);
      ok(await rateNow() === 2, 'the 2× preset did not set 2×');
      await P.ask('click', { sel: '#panel button.big' }); // − (first big button)
      await settle(300);
      ok(Math.abs(await rateNow() - 1.95) < 1e-6, '− in the speed panel is not −0.05');
      P.act({ action: 'panel' });
      P.rate(1);
      await settle(300);
    });

    await R.run('speed/drag-outside', async (ok) => {
      await P.ask('click', { sel: '#rate' });
      const [x, y, w, h] = (await P.state()).panel.sliderRect;
      const pointer = (ev, pos, target = 'document', height = -20) => P.dom(ev, pos, height, { target });
      pointer('pointerdown', x + w / 2, 'speedSlider', y + h / 2);
      // y < 0 is outside the webview. Send the move to the document, as when capture cannot be set
      // on a synthetic pointer. The readout must change before release.
      pointer('pointermove', x + w, 'document');
      let s = await P.state();
      ok(s.bar.rate === '4×' && s.panel.text.includes('4×'), `speed while off the top edge: ${s.bar.rate}`);
      pointer('pointermove', -20, 'document');
      s = await P.state();
      ok(s.bar.rate === '0.25×', `speed while off the left edge: ${s.bar.rate}`);
      pointer('pointerup', x + w * 0.2);
      pointer('pointermove', x + w);
      s = await P.state();
      ok(s.bar.rate === '1×' && s.panel.rows.some((r) => r.label === 'Speed 1×' && r.pressed === 'true'),
        `speed and preset after release: ${s.bar.rate}`);
      const a = await a11y();
      ok(a.active === 'speedSlider', `slider focus after release: ${a.active}`);
      P.key('Escape', { target: ':focus' });
    });

    await R.run('drag/outside', async (ok) => {
      // Volume: press on the slider, move far outside (above the bar, past both ends), release; then a move does nothing.
      P.pause();
      let s = await P.state();
      const [vx, vy, vw, vh] = s.volumeRect;
      P.act({ action: 'dom', ev: 'pointerdown', target: 'volume', x: vx + vw * 0.5, y: vy + vh / 2 });
      await settle(200);
      P.dom('pointermove', vx + vw + 300, vy - 200); // over the picture, right of the slider
      await settle(200);
      s = await P.state();
      ok(s.drag.volume && s.volume === 1, `volume dragged out to the right: ${s.volume} (dragging ${s.drag.volume})`);
      P.dom('pointermove', Math.max(1, vx - 300), vy - 150); // left of it
      await settle(200);
      s = await P.state();
      ok(s.volume === 0, `volume dragged out to the left: ${s.volume}`);
      P.dom('pointermove', vx + vw * 0.6, vy - 150);
      P.dom('pointerup', vx + vw * 0.6, vy - 150);
      await settle(200);
      s = await P.state();
      const v1 = s.volume;
      ok(!s.drag.volume && Math.abs(v1 - 0.6) < 0.051, `released at 60 %: ${v1}`);
      P.dom('pointermove', vx + vw, vy - 150);
      await settle(200);
      ok((await P.state()).volume === v1, 'a move after release changed the volume');
      // Wheel over the volume: +5 %.
      P.act({ action: 'dom', ev: 'wheel', target: 'volume', deltaY: -100 });
      await settle(200);
      ok(Math.abs((await P.state()).volume - Math.min(1, v1 + 0.05)) < 1e-6, 'wheel up over the volume is not +5 %');
      P.act({ action: 'dom', ev: 'wheel', target: 'volume', deltaY: 100 });
      // Seek bar: press, move far above the bar at 75 % of its width, release there: lands on that frame.
      s = await P.state();
      const [sx, sy, sw, sh] = s.seekRect;
      P.act({ action: 'dom', ev: 'pointerdown', target: 'seek', x: sx + sw * 0.2, y: sy + sh / 2 });
      await settle(200);
      P.dom('pointermove', sx + sw * 0.75, sy - 250);
      await settle(300);
      s = await P.state();
      const want = Math.round(0.75 * s.seekMax);
      ok(s.drag.seek && Math.abs(s.seekValue - want) <= 1, `seek dragged above the bar: value ${s.seekValue}, expected ~${want}`);
      P.dom('pointerup', sx + sw * 0.75, sy - 250);
      s = await P.waitState((q) => !q.drag.seek && Math.abs(q.frame - want) <= 1, { timeout: 8000, what: `seek lands near frame ${want}` });
      ok(Math.abs(s.frame - want) <= 1, `after release: frame ${s.frame}, expected ~${want}`);
    });

    await R.run('time/formats', async (ok) => {
      P.pause();
      P.seek(1);
      await settle(800);
      let s = await P.state();
      ok(/^\d+:\d\d\.\d{3} \/ \d+:\d\d\.\d{3}$/.test(s.timeText), `time: ${s.timeText}`);
      P.play();
      await settle(500);
      s = await P.state();
      ok(/^\d+:\d\d\.\d{3} \/ \d+:\d\d\.\d{3}$/.test(s.timeText), `time while playing has the same detail: ${s.timeText}`);
      P.pause();
      await P.ask('click', { sel: '#time' });
      await settle(300);
      s = await P.state();
      ok(/^\d\d:\d\d:\d\d:\d\d \/ \d\d:\d\d:\d\d:\d\d$/.test(s.timeText), `timecode: ${s.timeText}`);
      await P.ask('click', { sel: '#time' });
      await settle(300);
      s = await P.state();
      ok(new RegExp(`^frame ${s.frame + 1} / \\d+$`).test(s.timeText), `frame number: ${s.timeText} (frame ${s.frame + 1})`);
      await P.ask('click', { sel: '#time' });
      await settle(200);
    });

    await R.run('info/wasm-and-copy', async (ok) => { // H.264 here is the GPU path: the WebAssembly file is in ui_info
      await P.ask('click', { sel: '#infoBtn' });
      await settle(300);
      const s = await P.state();
      const f = Object.fromEntries((s.panel && s.panel.facts) || []);
      ok(/^1920 × 1080 \(1080p\), \d/.test(f.Picture || ''), `Picture: ${f.Picture}`);
      ok(/^H\.264 \(AVC\)/.test(f.Video || '') && /^AAC/.test(f.Sound || '') && /GPU/.test(f['Played by'] || ''), `facts: ${JSON.stringify(f)}`);
      ok(s.panel.text.includes(CLIP) && s.panel.rows.some((r) => r.label === 'Copy details'), 'name / Copy details');
      await P.ask('click', { sel: '#panel button', text: 'Full technical details' });
      await settle(300);
      ok((await P.state()).infoShown, 'Full technical details did not show the details overlay');
      P.act({ action: 'panel' });
    });
    await P.close();

    await R.run('compare', async (ok) => {
      const from1 = vs.mark();
      vs.send({ compareFiles: [path.join(h.MEDIA, CLIP), path.join(h.MEDIA, CLIP_B)] });
      await vs.waitLog(/\[compare [^\]]*\] opened/, { from: from1, timeout: 30000, what: 'compare opened' });
      const ask = async (o = {}) => {
        const from = vs.mark();
        vs.send({ compare: true, action: 'a11y', ...o });
        const line = await vs.waitLog(/webview: compare a11y \{/, { from, timeout: 10000 });
        return JSON.parse(line.slice(line.indexOf('compare a11y {') + 13));
      };
      let s = null;
      for (let i = 0; i < 40; i++) {
        s = await ask();
        if (s.ready && s.controls.seek.valuetext) break;
        await h.sleep(1000);
      }
      const c = s.controls;
      ok(s.ready, 'compare did not finish opening its tiles');
      ok(s.unnamed.length === 0, `buttons without a name in words: ${JSON.stringify(s.unnamed)}`);
      ok(/ of .*, frame \d+$/.test(c.seek.valuetext || ''), `seek aria-valuetext ${JSON.stringify(c.seek.valuetext)}`);
      ok(/^(true|false)$/.test(c.mute.pressed || ''), `#mute: aria-pressed ${c.mute.pressed}`);
      ok(c.cmpBtn && c.cmpBtn.label === 'Compare' && c.cmpBtn.expanded === 'false', `cmpBtn ${JSON.stringify(c.cmpBtn)}`);
      ok(/^Play all|^Pause all/.test(c.play.label || ''), `play label ${c.play.label}`);
      const loop0 = s.loop;
      const announcement = loop0 ? 'Loop off' : 'Loop on';
      vs.send({ compare: true, action: 'key', key: 'r' });
      // The live region clears first and writes its announcement in a separate timer.
      for (const end = Date.now() + 5000; Date.now() < end;) {
        s = await ask();
        if (s.loop === !loop0 && s.live === announcement) break;
        await h.sleep(100);
      }
      ok(s.loop === !loop0 && s.live === announcement, `R: loop ${loop0} -> ${s.loop}, live ${JSON.stringify(s.live)}`);
      vs.send({ compare: true, action: 'key', key: 'r' });
      await h.sleep(300);
      s = await ask({ focus: '#cmpBtn', click: '#cmpBtn' });
      await h.sleep(300);
      s = await ask();
      ok(s.panel === 'cmp' && s.controls.cmpBtn.expanded === 'true' && s.active !== 'cmpBtn' && s.active !== 'BODY', `Compare panel: ${s.panel}, aria-expanded ${s.controls.cmpBtn.expanded}, focus on ${s.active}`);
      vs.send({ compare: true, action: 'key', key: 'Escape' });
      await h.sleep(400);
      s = await ask();
      ok(!s.panel && s.active === 'cmpBtn', `Esc: panel ${s.panel}, focus on ${s.active}`);
      await h.closeClip(vs);
    });
    return R.out;
  },
}, {
  // Jump sizes: the defaults, a change in the panel (saved as a setting), and values from the settings.
  name: 'ui_jumps',
  settings: { 'videoPreviewEnhanced.autoplay': false },
  async run(vs, h) {
    const R = lib.recorder();
    const P = await lib.open(vs, h, lib.clip('long_20s.mp4'));
    try {
      await R.run('defaults', async (ok) => jumpChecks(P, ok, { arrow: 5, shift: 1, ctrl: 'frame' }));
      await R.run('panel-saves-setting', async (ok) => {
        P.act({ action: 'panel', view: 'jumps' });
        await lib.sleep(300);
        let s = await P.state();
        ok(s.panel && s.panel.view === 'jumps' && s.panel.rows.filter((r) => r.checked !== null).length === 17, `jump page: ${JSON.stringify(s.panel && s.panel.rows)}`);
        await P.ask('click', { sel: '#panel [role=radiogroup] [role=radio]', text: '10 s' }); // the first group: ← →
        await lib.sleep(300);
        s = await P.state();
        ok(s.prefs.jump.arrow === 10, `prefs after the click: ${JSON.stringify(s.prefs)}`);
        const file = path.join(vs.user, 'User', 'settings.json');
        let saved = false;
        for (let i = 0; i < 20 && !saved; i++) {
          try { saved = /"videoPreviewEnhanced\.jump\.arrow":\s*10/.test(fs.readFileSync(file, 'utf8')); } catch { /* not yet */ }
          if (!saved) await lib.sleep(300);
        }
        ok(saved, 'videoPreviewEnhanced.jump.arrow was not written to the user settings');
        // Buttons beside Play: one frame by default; the chip makes them follow the Ctrl jump size (saved as a setting).
        ok(s.prefs.stepButtons === 'frame', `default stepButtons: ${JSON.stringify(s.prefs)}`);
        await P.ask('click', { sel: '#panel [role=radiogroup] [role=radio]', text: 'Ctrl jump' });
        await lib.sleep(300);
        s = await P.state();
        ok(s.prefs.stepButtons === 'jump', `prefs after the Ctrl jump chip: ${JSON.stringify(s.prefs)}`);
        let savedStep = false;
        for (let i = 0; i < 20 && !savedStep; i++) {
          try { savedStep = /"videoPreviewEnhanced\.stepButtons":\s*"jump"/.test(fs.readFileSync(file, 'utf8')); } catch { /* not yet */ }
          if (!savedStep) await lib.sleep(300);
        }
        ok(savedStep, 'videoPreviewEnhanced.stepButtons was not written to the user settings');
        P.act({ action: 'panel' });
        await jumpChecks(P, ok, { arrow: 10, shift: 1, ctrl: 'frame' });
      });
    } finally { await P.close(); }
    return R.out;
  },
}, {
  name: 'ui_jumps_settings',
  settings: { 'videoPreviewEnhanced.autoplay': false, 'videoPreviewEnhanced.jump.arrow': 'frame', 'videoPreviewEnhanced.jump.shift': 5, 'videoPreviewEnhanced.jump.ctrl': 1 },
  async run(vs, h) {
    const R = lib.recorder();
    const P = await lib.open(vs, h, lib.clip('long_20s.mp4'));
    try {
      await R.run('from-settings', async (ok) => {
        const s = await P.state();
        ok(s.prefs.jump.arrow === 'frame' && s.prefs.jump.shift === 5 && s.prefs.jump.ctrl === 1, `prefs ${JSON.stringify(s.prefs)}`);
        await jumpChecks(P, ok, { arrow: 'frame', shift: 5, ctrl: 1 });
      });
    } finally { await P.close(); }
    return R.out;
  },
}, {
  // "About this video": a WebAssembly file and, with ffmpeg, the same file through native ffmpeg.
  name: 'ui_info',
  settings: { 'videoPreviewEnhanced.autoplay': false },
  async run(vs, h) {
    const R = lib.recorder();
    await R.run('wasm', async (ok) => {
      const P = await lib.open(vs, h, path.join(h.MEDIA, CLIP_B));
      try {
        await P.waitFirstFrame();
        await P.ask('click', { sel: '#infoBtn' });
        await lib.sleep(300);
        const s = await P.state();
        const f = Object.fromEntries((s.panel && s.panel.facts) || []);
        ok(f.Picture && f.Picture.startsWith('1920 × 1080 (1080p)'), `Picture: ${f.Picture}`);
        ok(f.Quality === 'standard range (SDR), 8-bit colour', `Quality: ${f.Quality}`);
        ok(/^HEVC \(H\.265\), about [\d.]+ [Mk]b\/s/.test(f.Video || ''), `Video: ${f.Video}`);
        ok(/built-in decoder \(WebAssembly/.test(f['Played by'] || ''), `Played by: ${f['Played by']}`);
        ok(/^(1 audio|no sound) · no subtitles$/.test(f.Tracks || ''), `Tracks: ${f.Tracks}`);
        ok(new RegExp(`${CLIP_B.replace('.', '\\.')}\\s*[\\d.]+ [KM]B · \\d+ s`).test(s.panel.text), `name and size: ${s.panel.text.slice(0, 80)}`);
      } finally { await P.close(); }
    });
    return R.out;
  },
}, {
  name: 'ui_info_native',
  settings: { 'videoPreviewEnhanced.autoplay': false },
  ffmpeg: true,
  async run(vs, h) {
    const R = lib.recorder();
    if (!h.ffmpeg) return [{ name: 'skipped', ok: true, skipped: 'no ffmpeg', problems: [] }];
    await R.run('native', async (ok) => {
      const P = await lib.open(vs, h, path.join(h.MEDIA, 'hevc_10_1080p.mp4'));
      try {
        await P.waitFirstFrame();
        await P.ask('click', { sel: '#infoBtn' });
        await lib.sleep(300);
        const s = await P.state();
        const f = Object.fromEntries((s.panel && s.panel.facts) || []);
        ok(f.Picture && f.Picture.startsWith('1920 × 1080 (1080p)'), `Picture: ${f.Picture}`);
        ok(/10-bit colour$/.test(f.Quality || ''), `Quality: ${f.Quality}`);
        ok(/^HEVC \(H\.265\), about [\d.]+ [Mk]b\/s/.test(f.Video || ''), `Video: ${f.Video}`);
        ok(/through ffmpeg|ffmpeg, on the processor/.test(f['Played by'] || ''), `Played by: ${f['Played by']}`);
      } finally { await P.close(); }
    });
    return R.out;
  },
}];
