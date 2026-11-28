'use strict';
// The right-click menu in a real VS Code (media/ctxmenu.js, docs/notes/context-menu.md): an HTML menu in the page,
// so it can be opened and clicked on the hidden desktop. The test hook opens it (ctxOpen, at a point) and picks an
// item (ctxPick: a click on the item's button); the page state reports what the open menu shows.
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
    const report = async () => {
      const from = vs.mark();
      act({ action: 'modesReport', delay: 400 });
      return kv(await vs.waitLog(/webview: modes report /, { from, timeout: 10000 }));
    };
    const state = async () => {
      const from = vs.mark();
      act({ action: 'state', id: 'ctx2' });
      const line = await vs.waitLog(/webview: state {/, { from, timeout: 10000 });
      return JSON.parse(/webview: state ({.*})/.exec(line)[1]);
    };
    // Polls read() until pred(value) holds (bounded); returns the last value either way so the assertion below names the miss.
    const until = async (read, pred, timeout = 6000) => {
      const t0 = Date.now();
      let v = await read();
      while (!pred(v) && Date.now() - t0 < timeout) { await h.sleep(100); v = await read(); }
      return v;
    };
    const menuOf = async () => (await until(state, (x) => !!x.ctxMenu)).ctxMenu;
    // Opens the menu the way a right-click does (at 60,60), clicks one item.
    const run = async (id) => {
      act({ action: 'ctxOpen', x: 60, y: 60 });
      const st = await until(state, (x) => x.ctxMenu && x.ctxMenu.items.some((i) => i.id === id));
      if (!(st.ctxMenu && st.ctxMenu.items.some((i) => i.id === id))) throw new Error(`menu item ${id} not offered: ${JSON.stringify(st.ctxMenu)}`);
      act({ action: 'ctxPick', id });
    };
    act({ action: 'pause' });
    await until(report, (r) => r.playing === 'false');

    // What the menu shows: items, shortcuts on the right, a check column for Loop, one separator between groups
    let ok = t('menu/items');
    act({ action: 'ctxOpen', x: 60, y: 60 });
    let m = await menuOf();
    const ids = m.items.map((i) => i.id);
    ok(ids.join() === 'play,loop,setA,setB,copyFrame,saveFrame,copyTime,startCompare,keys,playerSettings', `items: ${ids}`);
    ok(m.seps === 4, `separators: ${m.seps}`);
    ok(m.items.find((i) => i.id === 'play').label === 'Play' && m.items.find((i) => i.id === 'play').key === 'Space', 'Play / Space');
    ok(m.items.find((i) => i.id === 'loop').role === 'menuitemcheckbox' && ['true', 'false'].includes(m.items.find((i) => i.id === 'loop').checked), 'Loop is a checkable item');
    ok(m.items.find((i) => i.id === 'playerSettings').key === '', 'Settings… has no shortcut');
    ok(m.left >= 0 && m.top >= 0 && m.left + m.width <= 4096, `placed: ${m.left},${m.top}`);
    // Viewport clamp: a click in the far corner keeps the menu inside the page
    act({ action: 'ctxOpen', x: 99999, y: 99999 });
    let st = await until(state, (x) => x.ctxMenu && x.ctxMenu.left > 0);
    ok(st.ctxMenu.left + st.ctxMenu.width <= st.viewport.w + 1 && st.ctxMenu.top + st.ctxMenu.height <= st.viewport.h + 1,
      `clamped: ${JSON.stringify([st.ctxMenu.left, st.ctxMenu.top, st.ctxMenu.width, st.ctxMenu.height, st.viewport.w, st.viewport.h])}`);
    // Opening it closes an open panel; opening a panel closes it
    act({ action: 'panel', view: 'main' });
    await until(state, (x) => !x.ctxMenu && x.panel && x.panel.view === 'main');
    act({ action: 'ctxOpen', x: 60, y: 60 });
    st = await until(state, (x) => x.ctxMenu && !(x.panel && x.panel.view));
    ok(!!st.ctxMenu && !(st.panel && st.panel.view), `menu open, panel closed: ${JSON.stringify(st.panel && st.panel.view)}`);
    act({ action: 'panel', view: 'main' });
    st = await until(state, (x) => !x.ctxMenu);
    ok(!st.ctxMenu, 'opening a panel closed the menu');
    act({ action: 'panel' });
    // Escape closes it
    act({ action: 'ctxOpen', x: 60, y: 60 });
    await menuOf();
    act({ action: 'key', key: 'Escape', target: '#ctxmenu' });
    st = await until(state, (x) => !x.ctxMenu);
    ok(!st.ctxMenu, 'Escape did not close the menu');

    ok = t('commands/transport');
    await run('play');
    ok((await until(report, (r) => r.playing === 'true')).playing === 'true', 'Play did not play');
    act({ action: 'ctxOpen', x: 60, y: 60 });
    m = await menuOf();
    ok(m.items[0].id === 'play' && m.items[0].label === 'Pause', `while playing the first item is ${m.items[0].label}`);
    act({ action: 'ctxPick', id: 'play' });
    ok((await until(report, (r) => r.playing === 'false')).playing === 'false', 'Pause did not pause');
    act({ action: 'ctxOpen', x: 60, y: 60 });
    m = await menuOf();
    const loop0 = m.items.find((i) => i.id === 'loop').checked === 'true';
    act({ action: 'ctxPick', id: 'loop' });
    act({ action: 'ctxOpen', x: 60, y: 60 });
    m = (await until(state, (x) => x.ctxMenu && (x.ctxMenu.items.find((i) => i.id === 'loop').checked === 'true') === !loop0)).ctxMenu;
    ok((m.items.find((i) => i.id === 'loop').checked === 'true') === !loop0, `loop did not flip (${loop0})`);
    act({ action: 'ctxPick', id: 'loop' }); // back

    // Keyboard shortcuts and Settings… open the player's own sheet and panel.
    ok = t('commands/help');
    await run('keys');
    st = await until(state, (x) => !!x.sheet && /Keyboard shortcuts/.test(x.sheet));
    ok(!!st.sheet && /Keyboard shortcuts/.test(st.sheet), `keys: sheet ${String(st.sheet).slice(0, 60)}`);
    await run('playerSettings');
    st = await until(state, (x) => !x.sheet && x.panel && x.panel.view === 'main');
    ok(!st.sheet && st.panel && st.panel.view === 'main', `Settings…: panel ${JSON.stringify(st.panel && st.panel.view)}, sheet ${!!st.sheet}`);
    act({ action: 'panel' });

    ok = t('commands/ab-loop');
    act({ action: 'ctxOpen', x: 60, y: 60 });
    m = await menuOf();
    ok(!m.items.some((i) => i.id === 'clearAB'), 'Clear A–B Range offered with nothing set');
    act({ action: 'ctxClose' });
    act({ action: 'seek', t: 0.5 });
    await until(state, (x) => Math.abs(x.t - 0.5) < 0.1);
    await run('setA');
    st = await until(state, (x) => !x.abMarks.hidden);
    ok(!st.abMarks.hidden, `after Set Range Start the marks show: ${JSON.stringify(st.abMarks)}`);
    act({ action: 'ctxOpen', x: 60, y: 60 });
    m = await menuOf();
    ok(m.items.some((i) => i.id === 'clearAB' && i.key === 'Backspace'), 'Clear A–B Range not offered once A is set');
    act({ action: 'ctxClose' });
    await run('setA'); // again: sets it again (the menu sets, the A key toggles)
    await h.sleep(400); // a negative window: nothing may clear it
    ok(!(await state()).abMarks.hidden, 'Set Range Start twice cleared it');
    act({ action: 'seek', t: 1.2 });
    await until(state, (x) => Math.abs(x.t - 1.2) < 0.1);
    await run('setB');
    st = await until(state, (x) => !x.abMarks.hidden && x.abRange);
    ok(!st.abMarks.hidden && !!st.abRange, `after Set Range End: marks ${JSON.stringify(st.abMarks)}, range ${JSON.stringify(st.abRange)}`);
    await run('clearAB');
    st = await until(state, (x) => x.abMarks.hidden);
    ok(st.abMarks.hidden, 'Clear A–B Range did not clear');

    ok = t('commands/frame');
    act({ action: 'seek', t: 1.0 });
    await until(state, (x) => Math.abs(x.t - 1.0) < 0.1);
    await run('copyTime');
    st = await until(state, (x) => /Timestamp copied/.test(x.toast));
    ok(/Timestamp copied/.test(st.toast), `copy timestamp toast: ${st.toast}`);

    return out;
  },
};
