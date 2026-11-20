'use strict';
// The player's one layout (docs/notes/ui-simple.md) and compare's views in a real VS Code (docs/PRODUCT.md "Multi-view").
// Everything is read through the VPE_LOG test hook: the player's `modes report` line (media/player.js)
// and compare's `compare report` line (media/compare.js).
const path = require('path');

const CLIP = 'h264_aac_anim_1080p.mp4';
const CLIP_B = 'hevc_8_1080p.mp4';

const kv = (line) => Object.fromEntries([...line.matchAll(/(\w+)=(\S+)/g)].map((m) => [m[1], m[2]]));
const flags = (s) => Object.fromEntries(String(s || '').split(',').map((x) => x.split(':')));

module.exports = {
  name: 'modes',
  async run(vs, h) {
    const out = [];
    /** Starts a result; the returned function records a problem when its condition is false. */
    const t = (name) => {
      const r = { name, ok: true, problems: [] };
      out.push(r);
      return (cond, msg) => { if (!cond) { r.ok = false; r.problems.push(msg); } };
    };

    // ---- the player ----
    const tag = CLIP.replace(/\./g, '\\.');
    const from0 = await h.openClip(vs, path.join(h.MEDIA, CLIP));
    await vs.waitLog(new RegExp(`\\[${tag}\\] webview: first frame shown`), { from: from0, timeout: 45000, what: 'first frame' });
    const report = async (delay = 500) => {
      const from = vs.mark();
      vs.send({ action: 'modesReport', name: CLIP, delay });
      return kv(await vs.waitLog(/webview: modes report /, { from, timeout: 10000 }));
    };
    const act = (o) => vs.send({ name: CLIP, ...o });
    act({ action: 'pause' });
    await h.sleep(600);

    // One layout (no simple / advanced switch): the bar of the mock-up, every button visible.
    let r = await report();
    let ok = t('layout/bar');
    ok(r.panel === 'none' && r.sheet === 'false', `panel ${r.panel}, sheet ${r.sheet} at start`);
    const bar = flags(r.bar);
    for (const k of ['play', 'prev', 'next', 'seek', 'mute', 'volume', 'time', 'tracks', 'infoBtn', 'rate', 'cog', 'keysBtn', 'full']) ok(bar[k] === '1', `${k} is not visible (${r.bar})`);
    ok(Number(r.tools) === 6, `${r.tools} tools in the grid`);

    // Tool keys work without any mode: W opens the scopes, I the file facts.
    ok = t('layout/tool-keys');
    act({ action: 'key', key: 'w' });
    await h.sleep(1200);
    r = await report();
    ok(r.scopes !== 'off' && r.scopesVisible === 'true', `W: scopes=${r.scopes} visible=${r.scopesVisible}`);
    for (let i = 0; i < 4 && r.scopes !== 'off'; i++) { act({ action: 'key', key: 'w' }); await h.sleep(300); r = await report(); }
    ok(r.scopes === 'off', `W cycles back to off (${r.scopes})`);
    act({ action: 'key', key: 'i' });
    await h.sleep(500);
    r = await report();
    ok(r.panel === 'info', `I: panel ${r.panel}`);
    act({ action: 'key', key: 'i' });
    await h.sleep(400);
    r = await report();
    ok(r.panel === 'none', `I again: panel ${r.panel}`);

    // The basic controls: step, seek, play, pause.
    ok = t('layout/controls');
    const f0 = Number(r.frame);
    act({ action: 'step', d: 1 });
    await h.sleep(900);
    r = await report();
    ok(Number(r.frame) === f0 + 1, `step +1: frame ${f0} -> ${r.frame}`);
    act({ action: 'step', d: -1 });
    await h.sleep(900);
    r = await report();
    ok(Number(r.frame) === f0, `step -1: frame -> ${r.frame}, expected ${f0}`);
    act({ action: 'seek', t: 0.5 });
    await h.sleep(1500);
    r = await report();
    ok(Number(r.t) > 0.3 && Number(r.t) < 0.8, `seek 0.5 s: t=${r.t}`);
    const tSeek = Number(r.t);
    act({ action: 'play' });
    await h.sleep(600);
    r = await report();
    ok(r.playing === 'true' && Number(r.t) > tSeek, `play: playing=${r.playing} t=${r.t} (was ${tSeek})`);
    act({ action: 'pause' });
    await h.sleep(600);
    r = await report();
    ok(r.playing === 'false', `pause: playing=${r.playing}`);

    // Tools run from the cog's grid (the test hook runs them by label), and the old details overlay.
    ok = t('layout/tools-grid');
    act({ action: 'tool', open: true });
    await h.sleep(500);
    r = await report();
    ok(r.panel === 'main', `the settings panel did not open (${r.panel})`);
    act({ action: 'tool', label: 'Scopes' });
    await h.sleep(1500);
    r = await report();
    ok(r.scopes !== 'off' && r.scopesVisible === 'true', `Scopes from the grid: scopes=${r.scopes} visible=${r.scopesVisible}`);
    act({ action: 'tool', label: 'Details' });
    await h.sleep(500);
    r = await report();
    ok(r.info === 'true', 'Details did not show');
    ok(flags(r.bar).play === '1' && flags(r.bar).full === '1', 'the basic controls went away');
    await h.closeClip(vs);

    // ---- compare: side by side, split ----
    ok = t('compare/views');
    const from1 = vs.mark();
    vs.send({ compareFiles: [path.join(h.MEDIA, CLIP), path.join(h.MEDIA, CLIP_B)] });
    await vs.waitLog(/\[compare [^\]]*\] opened/, { from: from1, timeout: 30000, what: 'compare opened' });
    const creport = async (delay = 500) => {
      const from = vs.mark();
      vs.send({ compare: true, action: 'report', delay });
      return kv(await vs.waitLog(/webview: compare report /, { from, timeout: 10000 }));
    };
    let c = null;
    for (let i = 0; i < 60; i++) {
      c = await creport(200);
      if (c.canvas && !/^0x/.test(c.canvas)) break;
      await h.sleep(1000);
    }
    ok(c && c.canvas && !/^0x/.test(c.canvas), `compare never drew a frame (${c && c.canvas})`);
    ok(c && c.modes === 'side,split', `views: ${c && c.modes}, expected side,split`);
    for (const mode of ['side', 'split', 'toggle', 'wipe']) {
      vs.send({ compare: true, action: 'mode', mode });
      await h.sleep(800);
      c = await creport(300);
      // The toggle view is gone (it keeps the view); an older 'wipe' is the split.
      const want = mode === 'toggle' ? 'split' : mode === 'wipe' ? 'split' : mode;
      ok(c.mode === want, `mode ${mode}: report says ${c.mode}, expected ${want}`);
      ok((want === 'split') === (c.divider === 'true') && c.cells === (want === 'split' ? '1' : '2'), `divider shown=${c.divider}, cells=${c.cells} in ${want}`);
    }
    // The difference view and the old view keys are gone: these keys do nothing.
    for (const key of ['4', 'g', 'y', 'h', '1', '2', '3', 't']) vs.send({ compare: true, action: 'key', key });
    await h.sleep(600);
    c = await creport(300);
    ok(c.mode === 'split', `a removed view key changed the view to ${c.mode}`);
    await h.closeClip(vs);
    return out;
  },
};
