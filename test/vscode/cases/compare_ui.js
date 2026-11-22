'use strict';
// Compare's UI in a real VS Code (docs/notes/compare-ui.md, the approved mock-up): entering from a player
// takes its tab in place and starts at its position; the player's bar (no CC, the
// Compare button); the Compare panel and a video's page (offset in frames / ms, Reset, clock, sound);
// the hover pills and ‹ offset › nudges, − / + on the video under the pointer; side by side / split with
// a dragged divider and Swap; the tile's right-click menu; 3 videos in a 2x2 grid with an "Add video" cell;
// Remove; Leave compare back to the player at the kept video's moment, in the same tab.
// Read from the page's `compare report` / `compare ui {json}` lines and the `tabs` hook (VPE_LOG).
const path = require('path');

// A and B: 30 fps, 3 s, with sound. C: 24 fps, 2 s.
const CLIPS = ['h264_aac_anim_1080p.mp4', 'vp9_opus_anim_1080p.webm', 'h264_8_1080p.mp4'];
const kv = (line) => Object.fromEntries([...line.matchAll(/(\w+)=(\S+)/g)].map((m) => [m[1], m[2]]));
const list = (s) => String(s || '').split(',');
const nums = (s) => list(s).map(Number);
const opened = (n) => new RegExp(`\\[compare [^\\]]*\\] opened, .* ${n} tiles`);

module.exports = [{
  name: 'compare_ui',
  settings: { 'videoPreviewEnhanced.decoder': 'builtin', 'videoPreviewEnhanced.autoplay': false },
  async run(vs, h) {
    const out = [];
    const t = (name) => {
      const r = { name, ok: true, problems: [] };
      out.push(r);
      return (cond, msg) => { if (!cond) { r.ok = false; r.problems.push(msg); } };
    };
    const files = CLIPS.map((c) => path.join(h.MEDIA, c));
    const act = (o) => vs.send({ compare: true, ...o });
    const report = async (delay = 200) => {
      const from = vs.mark();
      act({ action: 'report', delay });
      return kv(await vs.waitLog(/webview: compare report /, { from, timeout: 10000 }));
    };
    const until = async (pred, timeout = 20000) => {
      const end = Date.now() + timeout;
      let r = null;
      while (Date.now() < end) {
        r = await report();
        if (pred(r)) return r;
        await h.sleep(300);
      }
      return r;
    };
    let uiId = 0;
    const ui = async (delay = 120) => {
      const id = ++uiId;
      const from = vs.mark();
      act({ action: 'ui', id, delay });
      const line = await vs.waitLog(new RegExp(`webview: compare ui \\{"id":${id},`), { from, timeout: 10000 });
      return JSON.parse(/webview: compare ui (\{.*\})/.exec(line)[1]);
    };
    const click = async (o) => { act({ action: 'click', ...o }); await h.sleep(250); };
    const tabs = async () => {
      const from = vs.mark();
      vs.send({ tabs: true });
      const line = await vs.waitLog(/ tabs \[\[/, { from, timeout: 10000 });
      return JSON.parse(/ tabs (\[\[.*\]\])/.exec(line)[1]);
    };
    const tagA = CLIPS[0].replace(/\./g, '\\.');
    const panelText = (u) => (u.panel ? u.panel.text : '');

    let ok = null;
    try {
    // ---- starting a compare: key D (quick pick) and a dropped video (docs/notes/compare-ui.md) ----
    ok = t('start/key-d');
    let from = await h.openClip(vs, files[0]);
    await vs.waitLog(new RegExp(`\\[${tagA}\\] webview: first frame shown`), { from, timeout: 45000, what: 'first frame' });
    from = vs.mark();
    vs.send({ pickCompare: CLIPS[1] });
    vs.send({ name: CLIPS[0], action: 'key', key: 'd' });
    const rows = JSON.parse(/debug comparepick (\[.*\])/.exec(await vs.waitLog(/debug comparepick \[/, { from, timeout: 20000, what: 'the quick pick' }))[1]);
    ok(rows[0] === 'Same folder' && !rows.includes(CLIPS[0]) && rows.includes(CLIPS[1]) && rows[rows.length - 1].includes('Browse'), `quick pick rows: ${rows}`);
    await vs.waitLog(opened(2), { from, timeout: 30000, what: 'compare opened by key D' });
    await vs.waitLog(new RegExp(`\\[${tagA}\\] session closed`), { from, timeout: 10000, what: 'the player tab closed' });
    let r = await until((x) => x.synced === 'true' && !list(x.frames).includes('-'), 30000);
    ok(r.synced === 'true', `compare after key D: ${JSON.stringify(r)}`);
    vs.send({ command: 'workbench.action.closeActiveEditor' });
    await h.sleep(800);
    ok = t('start/drop');
    from = await h.openClip(vs, files[0]);
    await vs.waitLog(new RegExp(`\\[${tagA}\\] webview: first frame shown`), { from, timeout: 45000, what: 'first frame' });
    from = vs.mark();
    vs.send({ name: CLIPS[0], action: 'drop', data: { 'text/uri-list': `${require('url').pathToFileURL(files[1]).href}\r\n` } });
    ok(/debug dropHint true/.test(await vs.waitLog(/debug dropHint /, { from, timeout: 10000, what: 'drop hint' })), 'no drop hint while dragging');
    await vs.waitLog(opened(2), { from, timeout: 30000, what: 'compare opened by a drop' });
    r = await until((x) => x.synced === 'true' && !list(x.frames).includes('-'), 30000);
    ok(r.synced === 'true', `compare after the drop: ${JSON.stringify(r)}`);
    vs.send({ command: 'workbench.action.closeActiveEditor' });
    await h.sleep(800);

    // ---- entering from the player: in place, at its position ----
    ok = t('enter/in-place');
    from = await h.openClip(vs, files[0]);
    await vs.waitLog(new RegExp(`\\[${tagA}\\] webview: first frame shown`), { from, timeout: 45000, what: 'first frame' });
    from = vs.mark();
    vs.send({ compareWith: [files[1]], name: CLIPS[0], t: 1.0 });
    await vs.waitLog(opened(2), { from, timeout: 30000, what: 'compare opened from the player' });
    await vs.waitLog(new RegExp(`\\[${tagA}\\] session closed`), { from, timeout: 10000, what: 'the player tab closed' });
    r = await until((x) => x.synced === 'true' && !list(x.frames).includes('-'), 30000);
    ok(Math.abs(nums(r.frames)[0] - 31) <= 1, `compare started at A #${nums(r.frames)[0]}, expected about #31 (the player's 1.0 s)`);
    const tb = await tabs();
    const all = tb.flat();
    ok(all.length === 1 && /compare/i.test(all[0].viewType), `tabs after entering: ${JSON.stringify(tb)}`);

    // ---- the bar: the player's, without CC, plus Compare ----
    ok = t('bar');
    let u = await ui();
    const ids = u.bar.ids;
    for (const id of ['prev', 'play', 'next', 'mute', 'volume', 'time', 'cmpBtn', 'infoBtn', 'rate', 'cog', 'full']) ok(ids.includes(id), `bar has no #${id} (${ids})`);
    ok(!ids.includes('keysBtn'), 'the shortcuts button still appears in the Compare toolbar');
    ok(!ids.includes('tracks'), `CC shown while comparing: ${ids}`);
    ok(/^A ?\d/.test(u.bar.time), `time does not start with the clock's letter: ${u.bar.time}`);
    ok(/sound from A/.test(u.bar.mute), `mute title: ${u.bar.mute}`);
    act({ action: 'key', key: '>', shift: true });
    r = await until((x) => x.rate === '1.05', 5000);
    ok(r.rate === '1.05', `Shift+> speed: ${r.rate}`);
    act({ action: 'rate', rate: 1 });
    act({ action: 'key', key: '.' });
    r = await until((x) => x.synced === 'true' && nums(x.frames)[0] === 32, 10000);
    ok(nums(r.frames)[0] === 32 && nums(r.frames)[1] === 32, `. stepped both to #32: ${r.frames}`);

    ok = t('panel/shortcuts');
    await click({ sel: '#cog' });
    await click({ sel: '#panel button[aria-keyshortcuts="?"][aria-haspopup="dialog"]' });
    u = await ui();
    ok(!u.panel && /^Keyboard shortcuts/.test(u.sheet) && u.active === 'Close',
      `settings row: panel ${u.panel?.view}, sheet ${String(u.sheet).slice(0, 40)}, focus on ${u.active}`);
    act({ action: 'key', key: 'Escape' });
    u = await ui();
    ok(!u.sheet && u.active === 'cog', `Escape: sheet open=${!!u.sheet}, focus on ${u.active}`);
    act({ action: 'key', key: '?' });
    u = await ui();
    ok(/^Keyboard shortcuts/.test(u.sheet), 'the ? key did not open the shortcuts sheet');
    act({ action: 'key', key: '?' });
    u = await ui();
    ok(!u.sheet && u.active === 'cog', `second ?: sheet open=${!!u.sheet}, focus on ${u.active}`);

    // ---- the Compare panel ----
    ok = t('panel/compare');
    await click({ sel: '#cmpBtn' });
    u = await ui();
    ok(u.panel && u.panel.view === 'cmp' && u.bar.cmpExpanded === 'true', `Compare button: panel ${u.panel && u.panel.view}, expanded ${u.bar.cmpExpanded}`);
    const txt = panelText(u);
    for (const want of ['Videos', CLIPS[0], CLIPS[1], 'Add video…', '2 of 8', 'View', 'Side by side', 'Split', 'Swap sides', 'Leave compare', 'keep A']) ok(txt.includes(want), `panel lacks "${want}": ${txt}`);
    for (const gone of ['PSNR', 'SSIM', 'Find first difference', 'A vs B']) ok(!txt.includes(gone), `panel shows "${gone}" (hidden for now)`);
    ok(u.panel.rows.some((x) => /^A: .*clock, sound, offset In step/.test(x.label)), `A's row: ${JSON.stringify(u.panel.rows.map((x) => x.label))}`);
    await click({ sel: '#cmpBtn' });
    u = await ui();
    ok(!u.panel, 'the Compare button did not close its panel');
    await click({ sel: '#cog' });
    u = await ui();
    ok(u.panel && u.panel.view === 'main' && /Sound/.test(panelText(u)) && /from A/.test(panelText(u)) && /Copy view/.test(panelText(u)) && /Compare/.test(panelText(u)), `⚙ panel: ${panelText(u)}`);
    ok(!/Subtitles|Audio track|A-B loop/.test(panelText(u)), `⚙ panel shows player-only rows: ${panelText(u)}`);
    await click({ text: 'Compare' }); // the Tools grid's Compare opens the Compare panel
    u = await ui();
    ok(u.panel && u.panel.view === 'cmp', `Tools › Compare: ${u.panel && u.panel.view}`);

    // ---- a video's page: offset in frames and ms, Reset, clock, sound ----
    ok = t('panel/video-page');
    await click({ text: 'B:' });
    u = await ui();
    ok(u.panel && u.panel.view === 'cmpVid', `B's page: ${u.panel && u.panel.view}`);
    for (const want of ['Offset', 'In step', 'Frames', 'Time (ms)', 'Clock', 'Sound from this video', 'Replace video…', 'Remove (back to one video)']) ok(panelText(u).includes(want), `B's page lacks "${want}": ${panelText(u)}`);
    await click({ text: 'B later' });
    r = await until((x) => x.offsets === '0f,1f', 5000);
    ok(r.offsets === '0f,1f', `+ on B's page: offsets ${r.offsets}`);
    r = await until((x) => x.synced === 'true' && nums(x.frames)[1] === nums(x.frames)[0] + 1, 10000);
    ok(nums(r.frames)[1] === nums(r.frames)[0] + 1, `B +1 frame shows #${nums(r.frames)[1]} against A #${nums(r.frames)[0]}`);
    await click({ text: 'Time (ms)' });
    r = await report();
    ok(/^0f,33\.33\dms$/.test(r.offsets), `frames → ms keeps the moment: ${r.offsets}`);
    await click({ text: 'B later' });
    r = await until((x) => /^0f,43\.33\dms$/.test(x.offsets), 5000);
    ok(/^0f,43\.33\dms$/.test(r.offsets), `+ in ms nudges 10 ms: ${r.offsets}`);
    u = await ui();
    ok(/\+43\.3 ms/.test(panelText(u)), `page shows the ms offset: ${panelText(u)}`);
    await click({ text: 'Reset' });
    await click({ text: 'Frames' });
    r = await until((x) => x.offsets === '0f,0f', 5000);
    ok(r.offsets === '0f,0f', `Reset and Frames: ${r.offsets}`);
    await click({ text: 'Clock:' });
    await click({ text: 'Sound from this video' });
    r = await until((x) => x.clock === '1' && x.sound === '1', 5000);
    ok(r.clock === '1' && r.sound === '1', `clock and sound switches: clock=${r.clock} sound=${r.sound}`);
    u = await ui();
    ok(/^B ?\d/.test(u.bar.time) && /sound from B/.test(u.bar.mute), `bar follows the clock / sound: ${u.bar.time} | ${u.bar.mute}`);
    ok(r.seekMax === String(89), `seek bar max ${r.seekMax} for B's 90 frames`);
    await click({ text: 'Back from' });
    u = await ui();
    ok(u.panel && u.panel.view === 'cmp', `Back: ${u.panel && u.panel.view}`);
    act({ action: 'clock', tile: 0 });
    act({ action: 'sound', tile: 0 });
    act({ action: 'panel' });

    // ---- hover pills and nudges; − / + on the video under the pointer ----
    ok = t('tiles/pills-and-nudge');
    r = await until((x) => x.synced === 'true', 10000);
    u = await ui();
    ok(u.cells.length === 2 && u.cells.every((c) => c.pills.length === 1 && c.nudges.length === 1), `cells: ${JSON.stringify(u.cells.map((c) => [c.tile, c.pills.length]))}`);
    ok(u.cells[0].pills[0].startsWith('A') && u.cells[0].pills[0].includes(CLIPS[0]) && /#\d+$/.test(u.cells[0].pills[0]), `A's pill: ${u.cells[0].pills[0]}`);
    ok(u.cells[1].nudges[0].replace(/\s/g, '') === '‹0›', `B's nudge: ${u.cells[1].nudges[0]}`);
    const [ax, , aw] = u.cells[0].pics[0];
    ok(aw > 0 && Math.abs(u.cells[0].pics[0][2] / u.cells[0].pics[0][3] - 16 / 9) < 0.05, `A's picture keeps 16:9 in its half: ${u.cells[0].pics[0]} (${ax})`);
    await click({ sel: '.nudge [data-act="nudge"][data-i="1"][data-d="1"]' });
    r = await until((x) => x.offsets === '0f,1f', 5000);
    ok(r.offsets === '0f,1f', `B's › nudge: ${r.offsets}`);
    act({ action: 'hover', tile: 1 });
    act({ action: 'key', key: '-' });
    r = await until((x) => x.offsets === '0f,0f', 5000);
    ok(r.offsets === '0f,0f', `− under the pointer on B: ${r.offsets}`);
    act({ action: 'hover', tile: 0 });
    act({ action: 'key', key: '+' });
    r = await until((x) => x.offsets === '1f,0f', 5000);
    ok(r.offsets === '1f,0f', `+ under the pointer on A: ${r.offsets}`);
    act({ action: 'offset', tile: 0, v: 0, unit: 'frames' });
    act({ action: 'hover', tile: null });

    // ---- side by side / split, the divider, Swap ----
    ok = t('view/split');
    act({ action: 'panel', view: 'cmp' });
    await h.sleep(200);
    await click({ text: 'Split' });
    r = await until((x) => x.mode === 'split' && x.divider === 'true', 5000);
    ok(r.mode === 'split' && r.divider === 'true' && r.cells === '1', `Split: mode=${r.mode} divider=${r.divider} cells=${r.cells}`);
    act({ action: 'panel' });
    u = await ui();
    ok(u.cells.length === 1 && u.cells[0].pills.length === 2, `split shows both pills: ${JSON.stringify(u.cells.map((c) => c.pills))}`);
    act({ action: 'drag', x: 0.25 });
    r = await until((x) => Math.abs(Number(x.split) - 0.25) < 0.01, 5000);
    ok(Math.abs(Number(r.split) - 0.25) < 0.01, `divider dragged to 25 %: split=${r.split}`);
    u = await ui();
    ok(u.divider && u.divider.value === '25', `divider aria value ${u.divider && u.divider.value}`);
    act({ action: 'key', key: 'x' });
    r = await until((x) => x.swap === 'true', 5000);
    ok(r.swap === 'true', 'X did not swap');
    u = await ui();
    ok(u.cells[0].pills[0].startsWith(`A${CLIPS[1]}`), `after Swap the left pill is ${u.cells[0].pills[0]}`);
    act({ action: 'mode', mode: 'side' });
    u = await ui();
    ok(u.cells[0].pills[0].startsWith(`A${CLIPS[1]}`), `Side by side kept ${u.cells[0].pills[0]} on the left`);
    await click({ text: `Move ${CLIPS[1]} later` });
    r = await until((x) => x.mode === 'side' && x.divider === 'false' && x.swap === 'false', 5000);
    ok(r.mode === 'side' && r.cells === '2', `back to side by side: mode=${r.mode} cells=${r.cells}`);

    // ---- a tile's right-click menu ----
    ok = t('tiles/menu');
    act({ action: 'menu', x: 0.75, y: 0.5 });
    await h.sleep(200);
    u = await ui();
    const items = u.menu ? u.menu.items : [];
    ok(u.menu && u.menu.tile === 1, `right-click on the right half: menu for ${u.menu && u.menu.tile}`);
    for (const want of ['Play', 'B sets the clock', 'Sound from B', 'Offset of B…', 'Copy frame (B)', 'Copy timestamp (B)', 'Replace B…', 'Remove B', 'Add video…', 'Leave compare', 'Keyboard shortcuts', 'Settings…']) ok(items.some((x) => x.startsWith(want)), `menu lacks "${want}": ${items}`);
    act({ action: 'menuPick', label: 'B sets the clock' });
    r = await until((x) => x.clock === '1' && x.menu === 'false', 5000);
    ok(r.clock === '1' && r.menu === 'false', `menu: B sets the clock: clock=${r.clock} menu=${r.menu}`);
    act({ action: 'menu', x: 0.75, y: 0.5 });
    await h.sleep(200);
    u = await ui();
    ok(u.menu && u.menu.items.some((x) => x.startsWith('✓ B sets the clock')), `the clock is checked: ${u.menu && u.menu.items}`);
    act({ action: 'menuPick', label: 'Offset of B' });
    await h.sleep(200);
    u = await ui();
    ok(u.panel && u.panel.view === 'cmpVid' && panelText(u).includes(CLIPS[1]), `Offset of B… opens B's page: ${u.panel && u.panel.view}`);
    act({ action: 'panel' });
    act({ action: 'clock', tile: 0 });
    await until((x) => x.clock === '0', 5000);
    await h.sleep(500); // the page saves its state (the clock) before the host reloads it with a third video

    // ---- 3 videos: 2x2 with an Add video cell; Remove ----
    ok = t('grid/three');
    from = vs.mark();
    vs.send({ compareAdd: [files[2]] });
    await vs.waitLog(opened(3), { from, timeout: 30000, what: 'compare with 3' });
    r = await until((x) => x.n === '3' && !list(x.frames).includes('-'), 30000);
    ok(r.mode === 'grid' && r.cells === '3' && r.add === 'true', `3 videos: mode=${r.mode} cells=${r.cells} add=${r.add}`);
    u = await ui();
    ok(u.cells.length === 4 && u.cells[3].tile === 'add', `the fourth cell: ${JSON.stringify(u.cells.map((c) => c.tile))}`);
    act({ action: 'panel', view: 'cmp' });
    await h.sleep(200);
    u = await ui();
    ok(panelText(u).includes('3 of 8') && !panelText(u).includes('Side by side') && !panelText(u).includes('PSNR'), `3-video panel: ${panelText(u)}`);
    act({ action: 'select', tile: 2 });
    act({ action: 'panel', view: 'cmpVid' });
    await h.sleep(200);
    from = vs.mark();
    await click({ text: 'Remove from compare' });
    await vs.waitLog(opened(2), { from, timeout: 30000, what: 'compare back to 2' });
    r = await until((x) => x.n === '2' && x.synced === 'true', 30000);
    ok(r.n === '2' && r.mode === 'side', `after Remove: n=${r.n} mode=${r.mode}`);

    // ---- Leave compare: the player in this tab, at the kept video's moment ----
    ok = t('leave');
    act({ action: 'clock', tile: 0 });
    act({ action: 'seek', t: 1.5 });
    r = await until((x) => x.synced === 'true' && x.clock === '0', 15000);
    ok(r.clock === '0', `clock before leaving: ${r.clock}`);
    act({ action: 'panel', view: 'cmp' });
    await h.sleep(200);
    from = vs.mark();
    await click({ text: 'Leave compare' });
    await vs.waitLog(new RegExp(`\\[${tagA}\\] webview: first frame shown`), { from, timeout: 45000, what: 'the player after Leave compare' });
    await h.sleep(800);
    const tb2 = (await tabs()).flat();
    ok(tb2.length === 1 && /videoPreviewEnhanced\.player/.test(tb2[0].viewType), `tabs after leaving: ${JSON.stringify(tb2)}`);
    const m0 = vs.mark();
    vs.send({ name: CLIPS[0], action: 'state', id: 'leave' });
    const st = JSON.parse(/webview: state (\{.*\})/.exec(await vs.waitLog(/webview: state \{/, { from: m0, timeout: 10000 }))[1]);
    ok(Math.abs(st.t - 1.5) < 0.1, `the player opened at ${st.t} s, expected about 1.5 s`);
    } catch (e) {
      // Keep the sections that ran; the one that threw fails with the reason.
      if (ok) ok(false, e.message); else out.push({ name: 'error', ok: false, problems: [e.message] });
    }
    await h.closeClip(vs);
    return out;
  },
}];
