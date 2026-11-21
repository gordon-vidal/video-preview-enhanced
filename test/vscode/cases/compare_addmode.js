'use strict';
// Add from the Explorer (docs/notes/compare-ui.md "Add mode") in a real VS Code. An Explorer click can't be
// driven on the hidden desktop: the `openFile` hook opens the file as a click does (vscode.open, a preview tab in
// the active group, focus kept). Shift+D in a player, then a video opened: compare takes the player's tab and no
// tab is left for the clicked video. Shift+D in compare: each opened video is added (the hint comes back on the
// reloaded page). Esc's command ends it; then videos open in their own tab again.
const path = require('path');

const CLIPS = ['h264_aac_anim_1080p.mp4', 'vp9_opus_anim_1080p.webm', 'h264_8_1080p.mp4'];
const opened = (n) => new RegExp(`\\[compare [^\\]]*\\] opened, .* ${n} tiles`);
const esc = (s) => s.replace(/\./g, '\\.');

module.exports = [{
  name: 'compare_addmode',
  settings: { 'videoPreviewEnhanced.decoder': 'builtin', 'videoPreviewEnhanced.autoplay': false },
  async run(vs, h) {
    const out = [];
    const t = (name) => {
      const r = { name, ok: true, problems: [] };
      out.push(r);
      return (cond, msg) => { if (!cond) { r.ok = false; r.problems.push(msg); } };
    };
    const files = CLIPS.map((c) => path.join(h.MEDIA, c));
    const tabs = async () => {
      const from = vs.mark();
      vs.send({ tabs: true });
      const line = await vs.waitLog(/ tabs \[\[/, { from, timeout: 10000 });
      return JSON.parse(/ tabs (\[\[.*\]\])/.exec(line)[1]).flat();
    };
    // The tab list once pred(tabs) holds (bounded), confirmed by a second read 300 ms later so that a stray extra tab
    // opening late still fails; the last list is returned either way for the assertion's message.
    const tabsWhen = async (pred, timeout = 8000) => {
      const t0 = Date.now();
      let tb = await tabs();
      for (;;) {
        if (pred(tb)) { await h.sleep(300); const again = await tabs(); if (pred(again)) return again; tb = again; }
        if (Date.now() - t0 > timeout) return tb;
        await h.sleep(100);
        tb = await tabs();
      }
    };
    let ok = null;
    try {
      ok = t('player/shift-d-then-open');
      let from = await h.openClip(vs, files[0]);
      await vs.waitLog(new RegExp(`\\[${esc(CLIPS[0])}\\] webview: first frame shown`), { from, timeout: 45000, what: 'first frame' });
      from = vs.mark();
      vs.send({ name: CLIPS[0], action: 'key', key: 'D', shift: true });
      await vs.waitLog(new RegExp(`\\[${esc(CLIPS[0])}\\] webview: addMode on`), { from, timeout: 10000, what: 'the hint in the player' });
      from = vs.mark();
      vs.send({ openFile: files[1] });
      await vs.waitLog(new RegExp(`add from the Explorer: ${esc(CLIPS[1])}, mode off`), { from, timeout: 15000, what: 'the open taken' });
      await vs.waitLog(opened(2), { from, timeout: 30000, what: 'compare opened' });
      let tb = await tabsWhen((tb) => tb.length === 1 && /compare/i.test(tb[0].viewType));
      ok(tb.length === 1 && /compare/i.test(tb[0].viewType), `tabs after the click: ${JSON.stringify(tb)}`);

      ok = t('compare/shift-d-adds');
      from = vs.mark();
      vs.send({ compare: true, action: 'key', key: 'D', shift: true });
      await vs.waitLog(/\[compare [^\]]*\] webview: addMode on/, { from, timeout: 10000, what: 'the hint in compare' });
      from = vs.mark();
      vs.send({ openFile: files[2] });
      await vs.waitLog(opened(3), { from, timeout: 30000, what: 'the third video added' });
      await vs.waitLog(/\[compare [^\]]*\] webview: addMode on/, { from, timeout: 10000, what: 'the hint back on the new page' });
      tb = await tabsWhen((tb) => tb.length === 1 && /compare/i.test(tb[0].viewType));
      ok(tb.length === 1 && /compare/i.test(tb[0].viewType), `tabs after adding: ${JSON.stringify(tb)}`);

      ok = t('compare/esc-stops');
      from = vs.mark();
      vs.send({ command: 'videoPreviewEnhanced.stopAddFromExplorer' });
      await vs.waitLog(/\[compare [^\]]*\] webview: addMode off/, { from, timeout: 10000, what: 'the hint gone' });
      from = vs.mark();
      vs.send({ openFile: files[1] });
      await vs.waitLog(new RegExp(`\\[${esc(CLIPS[1])}\\] session resolved`), { from, timeout: 15000, what: 'a player of its own' });
      tb = await tabsWhen((x) => x.length === 2);
      ok(tb.length === 2, `tabs after Esc and another open: ${JSON.stringify(tb)}`);
    } catch (e) {
      if (ok) ok(false, String(e && e.message || e)); else out.push({ name: 'error', ok: false, problems: [String(e && e.message || e)] });
    }
    await h.closeClip(vs);
    return out;
  },
}];
