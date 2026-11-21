'use strict';
// The right-click menu in a real VS Code (src/ctxmenu.js, docs/notes/context-menu.md): the page's
// data-vscode-context follows play/loop/mute/mode, and the menu commands, run with a context object
// as VS Code passes them, change the player. (A native popup can't be clicked hidden: the commands are run.)
const path = require('path');

const CLIP = 'h264_aac_anim_1080p.mp4';
const kv = (line) => Object.fromEntries([...line.matchAll(/(\w+)=(\S+)/g)].map((m) => [m[1], m[2]]));

module.exports = {
  name: 'ctxmenu',
  async run(vs, h) {
    const out = [];
    const t = (name) => {
      const r = { name, ok: true, problems: [] };
      out.push(r);
      return (cond, msg) => { if (!cond) { r.ok = false; r.problems.push(msg); } };
    };
    const tag = CLIP.replace(/\./g, '\\.');
    const from0 = await h.openClip(vs, path.join(h.MEDIA, CLIP));
    await vs.waitLog(new RegExp(`\\[${tag}\\] webview: first frame shown`), { from: from0, timeout: 45000, what: 'first frame' });
    const act = (o) => vs.send({ name: CLIP, ...o });
    const ctx = async () => {
      const from = vs.mark();
      act({ action: 'state', id: 'ctx' });
      const line = await vs.waitLog(/webview: state \{/, { from, timeout: 10000 });
      return JSON.parse(/webview: state (\{.*\})/.exec(line)[1]).vscodeContext;
    };
    const report = async () => {
      const from = vs.mark();
      act({ action: 'modesReport', delay: 400 });
      return kv(await vs.waitLog(/webview: modes report /, { from, timeout: 10000 }));
    };
    const run = (id, c = {}) => vs.send({ ctxCommand: `videoPreviewEnhanced.ctx.${id}`, ctx: { vpe: true, ...c } });
    // Polls read() until pred(value) holds (bounded); returns the last value either way so the assertion below names the miss.
    const until = async (read, pred, timeout = 6000) => {
      const t0 = Date.now();
      let v = await read();
      while (!pred(v) && Date.now() - t0 < timeout) { await h.sleep(100); v = await read(); }
      return v;
    };
    const ctxObj = async () => JSON.parse(await ctx() || '{}');
    act({ action: 'pause' });
    await until(report, (r) => r.playing === 'false');

    let ok = t('context/attribute');
    let c = JSON.parse(await ctx() || '{}');
    ok(c.preventDefaultContextMenuItems === true, 'default Cut/Copy/Paste not dropped');
    ok(c.vpe === true && c.vpeReady === true, `vpe/vpeReady: ${JSON.stringify(c)}`);
    ok(c.vpePlaying === false && c.vpeAdvanced === undefined && typeof c.vpeLoop === 'boolean', `state: ${JSON.stringify(c)}`);

    ok = t('commands/transport');
    run('play');
    ok((await until(report, (r) => r.playing === 'true')).playing === 'true', 'ctx.play did not play');
    c = await until(ctxObj, (o) => o.vpePlaying === true);
    ok(c.vpePlaying === true, 'vpePlaying not updated while playing');
    run('pause');
    ok((await until(report, (r) => r.playing === 'false')).playing === 'false', 'ctx.pause did not pause');
    const loop0 = c.vpeLoop;
    run(loop0 ? 'loopOff' : 'loopOn');
    c = await until(ctxObj, (o) => o.vpeLoop === !loop0);
    ok(c.vpeLoop === !loop0, `loop did not flip (${loop0} -> ${c.vpeLoop})`);
    run(loop0 ? 'loopOn' : 'loopOff');

    // Keyboard shortcuts and Settings… open the player's own sheet and panel.
    ok = t('commands/help');
    const state = async () => {
      const from = vs.mark();
      act({ action: 'state', id: 'ctx2' });
      const line = await vs.waitLog(/webview: state {/, { from, timeout: 10000 });
      return JSON.parse(/webview: state ({.*})/.exec(line)[1]);
    };
    run('keys');
    let st = await until(state, (x) => !!x.sheet && /Keyboard shortcuts/.test(x.sheet));
    ok(!!st.sheet && /Keyboard shortcuts/.test(st.sheet), `keys: sheet ${String(st.sheet).slice(0, 60)}`);
    run('playerSettings');
    st = await until(state, (x) => !x.sheet && x.panel && x.panel.view === 'main');
    ok(!st.sheet && st.panel && st.panel.view === 'main', `Settings…: panel ${JSON.stringify(st.panel && st.panel.view)}, sheet ${!!st.sheet}`);
    act({ action: 'panel' });

    ok = t('commands/ab-loop');
    c = JSON.parse(await ctx());
    ok(c.vpeABSet === false, `vpeABSet before: ${JSON.stringify(c)}`);
    act({ action: 'seek', t: 0.5 });
    await until(state, (x) => Math.abs(x.t - 0.5) < 0.1);
    run('setA');
    c = await until(ctxObj, (o) => o.vpeABSet === true);
    ok(c.vpeABSet === true && c.vpeAB === false, `after Set Loop Start: ${JSON.stringify(c)}`);
    run('setA'); // again: sets it again (the menu sets, the A key toggles)
    await h.sleep(400); // a negative window: nothing may clear it
    ok(JSON.parse(await ctx()).vpeABSet === true, 'Set Loop Start twice cleared it');
    act({ action: 'seek', t: 1.2 });
    await until(state, (x) => Math.abs(x.t - 1.2) < 0.1);
    run('setB');
    st = await until(state, (x) => /"vpeAB":true/.test(x.vscodeContext) && !x.abMarks.hidden);
    c = JSON.parse(st.vscodeContext);
    ok(c.vpeAB === true && !st.abMarks.hidden, `after Set Loop End: ${JSON.stringify(c)}, marks ${JSON.stringify(st.abMarks)}`);
    run('clearAB');
    st = await until(state, (x) => x.abMarks.hidden && /"vpeABSet":false/.test(x.vscodeContext));
    c = JSON.parse(st.vscodeContext);
    ok(c.vpeABSet === false && st.abMarks.hidden, `after Clear: ${JSON.stringify(c)}`);

    ok = t('commands/frame');
    act({ action: 'seek', t: 1.0 });
    await until(state, (x) => Math.abs(x.t - 1.0) < 0.1);
    run('copyTime');
    st = await until(state, (x) => /Timestamp copied/.test(x.toast));
    ok(/Timestamp copied/.test(st.toast), `copy timestamp toast: ${st.toast}`);
    return out;
  },
};
