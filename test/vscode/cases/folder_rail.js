'use strict';
// The folder rail in a real VS Code (media/folder-rail.js, src/folder-rail.js, docs/notes/folder-rail.md): the bar's
// ‹ 2/3 › capsule, the rail docked beside the picture (open, resize, browse up and back, the column menu), the
// fold-out tab at the right edge, a right-click on |▶ (next video in this tab's place, the rail state carried over),
// and Autoplay "Play next in folder" (once, from 0:00, and staying at the last video). Clips: test/media/cases/neigh,
// three 1 s videos without sound.
const lib = require('../lib');

const SETTINGS = { 'videoPreviewEnhanced.autoplay': false };

module.exports = [{
  name: 'folder-rail',
  settings: SETTINGS,
  async run(vs, h) {
    const R = lib.recorder();
    const clip = (n) => lib.clip(`neigh/n${n}.mp4`);
    const player = (n) => new lib.Player(vs, h, clip(n));
    const railOf = (s) => s.rail || {};
    const names = (s) => (railOf(s).rows || []).map((r) => r.name);
    /** The tab that replaced the current one (tab swap) shows its first frame. */
    const swapped = async (n, from, what) => {
      await vs.waitLog(new RegExp(`\\[n${n}\\.mp4\\] webview: first frame shown`), { from, timeout: 30000, what });
      const P = player(n);
      await P.waitFirstFrame();
      return P;
    };
    let P = await lib.open(vs, h, clip(2));
    try {
      await P.waitFirstFrame();

      await R.run('capsule/position', async (ok) => {
        const s = await P.waitState((x) => railOf(x).cap && !railOf(x).cap.hidden, { what: 'the folder capsule' });
        ok(railOf(s).cap.text === '2/3', `capsule says ${JSON.stringify(railOf(s).cap)}`);
        ok(!railOf(s).open && !railOf(s).edgeHidden, 'rail closed, the fold-out tab armed');
        ok(s.onEnd === 'off', `Autoplay starts Off: ${s.onEnd}`);
      });

      await R.run('rail/open-docked', async (ok, r) => {
        const before = (await P.state()).stageRect;
        await P.ask('click', { sel: '#capCount' });
        const s = await P.waitState((x) => names(x).length >= 4, { what: 'the rail listing' });
        ok(names(s).join() === '..,n1.mp4,n2.mp4,n3.mp4', `rows ${names(s)}`);
        ok(railOf(s).rows.find((x) => x.active).name === 'n2.mp4', 'the playing file is marked');
        ok(railOf(s).width === 218 && Math.round(railOf(s).railRect[2]) === 218, `rail ${railOf(s).width} px, drawn ${railOf(s).railRect && railOf(s).railRect[2]}`);
        // Docked: the picture area gives up the rail's width (nothing is covered).
        const after = railOf(s).stageRect;
        r.stage = [before[2], after[2]];
        ok(before[2] - after[2] > 200, `the stage shrank by ${before[2] - after[2]} px`);
        ok(railOf(s).railRect[0] >= after[0] + after[2] - 1, 'the rail sits beside the stage');
        ok(railOf(s).pos === '2/3' && railOf(s).autoplay === 'Off', `footer ${railOf(s).pos} / ${railOf(s).autoplay}`);
      });

      await R.run('rail/resize', async (ok) => {
        const s0 = await P.state();
        const x = railOf(s0).railRect[0] + 1, y = railOf(s0).railRect[1] + 100;
        P.act({ action: 'dom', ev: 'pointerdown', target: 'railResizer', x, y });
        P.act({ action: 'dom', ev: 'pointermove', target: 'railResizer', x: x - 60, y });
        P.act({ action: 'dom', ev: 'pointerup', target: 'railResizer', x: x - 60, y });
        const s = await P.waitState((v) => railOf(v).width === 278, { what: 'the wider rail', timeout: 5000 });
        ok(Math.round(railOf(s).railRect[2]) === 278, `drawn ${railOf(s).railRect[2]}`);
      });

      await R.run('rail/browse-up-and-back', async (ok) => {
        await P.ask('click', { sel: '#railList .r-row', text: '..' });
        let s = await P.waitState((v) => names(v).includes('neigh'), { what: 'the parent folder' });
        ok(/cases$/.test(railOf(s).crumb), `crumb ${railOf(s).crumb}`);
        ok(!railOf(s).rows.some((x) => x.active), 'no playing row in another folder');
        const neigh = railOf(s).rows.find((x) => x.name === 'neigh');
        ok(neigh.cmp === 'Compare all videos in folder', `folder row Compare: ${JSON.stringify(neigh.cmp)}`);
        ok(!railOf(s).rows.find((x) => x.kind === 'up').cmp, 'no Compare on ..');
        ok(railOf(s).cap.text === '2/3', 'browsing leaves the capsule (playback folder) alone');
        await P.ask('click', { sel: '#railList .r-row', text: 'neigh' });
        s = await P.waitState((v) => names(v).join() === '..,n1.mp4,n2.mp4,n3.mp4', { what: 'back in the folder' });
        ok(railOf(s).rows.find((x) => x.active).name === 'n2.mp4', 'marked again');
      });

      await R.run('rail/column-menu', async (ok) => {
        await P.ask('click', { sel: '#railColBtn' });
        let s = await P.waitState((v) => railOf(v).menus && railOf(v).menus.column, { what: 'the column menu' });
        await P.ask('click', { sel: '#railColMenu button[data-col="size"]' });
        s = await P.waitState((v) => railOf(v).column === 'size' && railOf(v).rows.filter((x) => x.kind === 'video').every((x) => /B$/.test(x.col)), { what: 'sizes in the column' });
        ok(!railOf(s).menus.column, 'the menu closed');
        await P.ask('click', { sel: '#railColBtn' });
        await P.ask('click', { sel: '#railColMenu button[data-col="duration"]' });
        s = await P.waitState((v) => railOf(v).column === 'duration', { what: 'back to Duration' });
        // Duration needs ffprobe (or the playing file's own): the playing row shows its length.
        ok(/^0:01$|^—$/.test(railOf(s).rows.find((x) => x.active).col), `duration of the playing file: ${railOf(s).rows.find((x) => x.active).col}`);
      });

      await R.run('step-right-click/next-video', async (ok) => {
        const from = vs.mark();
        P.act({ action: 'dom', ev: 'contextmenu', target: 'next', x: 10, y: 10 });
        P = await swapped(3, from, 'a right-click on |▶ opened n3.mp4');
        const s = await P.waitState((v) => railOf(v).open && names(v).length >= 4, { what: 'the rail open in the new tab' });
        ok(railOf(s).width === 278, `the rail width carried over: ${railOf(s).width}`);
        ok(railOf(s).cap.text === '3/3', `capsule ${railOf(s).cap.text}`);
        ok(!s.ctxMenu, 'the page menu did not open');
        ok(lib.lines(vs, /\[n2\.mp4\] session closed/, from).length === 1, 'the old tab closed (tab swap)');
      });

      await R.run('rail/close-and-edge-tab', async (ok) => {
        await P.ask('click', { sel: '#railClose' });
        let s = await P.waitState((v) => !railOf(v).open, { what: 'the rail closed' });
        const st = s.stageRect;
        P.act({ action: 'dom', ev: 'pointermove', x: st[0] + st[2] - 10, y: st[1] + st[3] / 2 });
        s = await P.waitState((v) => railOf(v).edgeNear, { what: 'the fold-out tab near the edge', timeout: 5000 });
        ok(!railOf(s).open, 'hover alone never opens the rail');
        ok(Math.round(railOf(s).openTabRect[2]) === 20 && Math.round(railOf(s).openTabRect[3]) === 84, `the tab is 20 x 84 px: ${railOf(s).openTabRect}`);
        ok(railOf(s).capVisible && railOf(s).openTabIndex === -1, 'with the capsule shown, the tab is not a Tab stop');
        P.act({ action: 'dom', ev: 'pointermove', x: st[0] + st[2] / 2, y: st[1] + st[3] / 2 });
        s = await P.waitState((v) => !railOf(v).edgeNear, { what: 'the tab hides away from the edge', timeout: 5000 });
        await P.ask('click', { sel: '#railOpenTab' });
        s = await P.waitState((v) => railOf(v).open, { what: 'opened by the tab' });
        ok(railOf(s).edgeHidden, 'the fold-out tab hides while the rail is open');
      });

      await R.run('autoplay/last-video-stays', async (ok) => {
        await P.ask('click', { sel: '#railEndBtn' });
        await P.ask('click', { sel: '#railEndMenu button[data-end="next"]' });
        let s = await P.waitState((v) => v.onEnd === 'next' && railOf(v).autoplay === 'Next', { what: 'Autoplay: Play next in folder' });
        const from = vs.mark();
        P.play();
        await vs.waitLog(/\[n3\.mp4\] webview: end of file: next/, { from, timeout: 15000, what: 'the end of n3' });
        s = await P.waitState((v) => /Last video/.test(v.toast || ''), { what: 'the last-video toast', timeout: 5000 });
        ok(!s.playing, 'paused on the last frame');
        ok(lib.lines(vs, /folder: open/, from).length === 0, 'no tab swap at the last video');
      });

      await R.run('autoplay/next-once-from-start', async (ok) => {
        let from = vs.mark();
        await P.ask('click', { sel: '#capPrev' });
        P = await swapped(2, from, 'the capsule opened n2.mp4');
        let s = await P.state();
        ok(s.onEnd === 'next', `Autoplay carried over: ${s.onEnd}`);
        from = vs.mark();
        P.play();
        P = await swapped(3, from, 'Autoplay opened n3.mp4');
        s = await P.waitState((v) => v.playing || v.eof, { what: 'n3 plays', timeout: 10000 });
        ok(lib.lines(vs, /\[n2\.mp4\] webview: end of file: next/, from).length === 1, 'one end report');
        ok(lib.lines(vs, /folder: open n3\.mp4 \(autoplay next\)/, from).length === 1, 'advanced once');
        ok(!lib.lines(vs, /\[n3\.mp4\] webview: .*Resumed at/, from).length, 'no resume toast: starts at 0:00');
      });

      await R.run('rail/compare-folder', async (ok) => {
        // The rail came along open; up one folder, then Compare all videos of "neigh" (three) from its row.
        await P.waitState((v) => railOf(v).open && names(v).length >= 4, { what: 'the rail in n3' });
        await P.ask('click', { sel: '#railList .r-row', text: '..' });
        await P.waitState((v) => names(v).includes('neigh'), { what: 'the parent folder' });
        const from = vs.mark();
        await P.ask('click', { sel: '#railList button.r-cmp[aria-label="Compare all videos in folder neigh"]' });
        const line = await vs.waitLog(/compare: folder rail: \S+ \(\d+ videos\) -> \w+/, { from, timeout: 15000, what: 'the folder compare' });
        ok(/\(3 videos\) -> open/.test(line), `folder compare: ${line}`);
        await vs.waitLog(/compare: .*n1\.mp4 <-> .*n2\.mp4 <-> .*n3\.mp4/, { from, timeout: 15000, what: 'a Compare of the three videos' });
      });

      await R.run('compare/rail', async (ok) => {
        // The rail in Compare: opened from the edge tab (no bar capsule), the compared clips marked, a click adds one.
        const act = (o) => vs.send({ compare: true, ...o });
        let uiId = 0;
        const ui = async () => {
          const id = ++uiId;
          const from = vs.mark();
          act({ action: 'ui', id, delay: 60 });
          const line = await vs.waitLog(new RegExp(`webview: compare ui \\{"id":${id},`), { from, timeout: 10000, what: 'compare ui' });
          return JSON.parse(/webview: compare ui (\{.*\})/.exec(line)[1]);
        };
        const until = async (pred, what, timeout = 15000) => {
          const end = Date.now() + timeout;
          let s = null;
          while (Date.now() < end) { try { s = await ui(); if (pred(s)) return s; } catch { /* page reloading */ } await h.sleep(250); }
          throw new Error(`TIMEOUT waiting for ${what}; last: ${JSON.stringify(s && s.rail)}`);
        };
        let s = await until((x) => x.rail && !x.rail.open, 'the Compare page with its rail');
        ok(s.rail.cap.hidden && s.rail.openTabIndex === 0, `no capsule; the edge tab is a Tab stop: ${JSON.stringify([s.rail.cap, s.rail.openTabIndex])}`);
        ok(!s.bar.ids.includes('capCount'), 'no capsule on the bar');
        act({ action: 'click', sel: '#railOpenTab' });
        s = await until((x) => x.rail.open && x.rail.rows.length >= 4, 'the rail listing in Compare');
        const rows = s.rail.rows;
        ok(rows.filter((x) => x.inCompare).map((x) => x.name).join() === 'n1.mp4,n2.mp4,n3.mp4', `marked: ${rows.filter((x) => x.inCompare).map((x) => x.name)}`);
        ok(s.rail.pos === '3 in Compare' && s.rail.autoplay !== undefined, `footer: ${s.rail.pos}`);
        // Up one folder, then a video of it (not in Compare): added; the page reloads with the rail open and marked.
        act({ action: 'click', sel: '#railList .r-row[title="Parent folder"]' });
        s = await until((x) => x.rail.rows.some((r) => r.name === 'neigh'), 'the parent folder in Compare');
        const extra = s.rail.rows.find((r) => r.kind === 'video' && /^s_h264\.mp4$/.test(r.name)) || s.rail.rows.find((r) => r.kind === 'video');
        const from = vs.mark();
        act({ action: 'click', sel: `#rail-${extra.id.replace('.', '-')}` });
        await vs.waitLog(new RegExp(`compare .*\\] add ${lib.esc(extra.name)}`), { from, timeout: 15000, what: `${extra.name} added` });
        s = await until((x) => x.rail && x.rail.open && x.rail.rows.some((r) => r.name === extra.name && r.inCompare), 'the added clip marked after the reload', 20000);
        ok(s.rail.pos === '4 in Compare', `footer after the add: ${s.rail.pos}`);
        // Clicking it again: removed from Compare (the page reloads with the rail open and unmarked).
        const rmFrom = vs.mark();
        act({ action: 'click', sel: `#railList .r-row.in-cmp[aria-selected="true"]` });
        await vs.waitLog(new RegExp(`compare .*\\] remove ${lib.esc(extra.name)}`), { from: rmFrom, timeout: 15000, what: `${extra.name} removed` });
        s = await until((x) => x.rail && x.rail.open && x.rail.rows.some((r) => r.name === extra.name && !r.inCompare), 'the removed clip unmarked after the reload', 20000);
        ok(s.rail.pos === '3 in Compare', `footer after the remove: ${s.rail.pos}`);
      });
    } finally { await h.closeClip(vs); }
    return R.out;
  },
}];
