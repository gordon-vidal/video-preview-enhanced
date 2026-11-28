'use strict';
// Open together (docs/notes/compare-ui.md "Open together") in a real VS Code. An Explorer multi-selection can't be
// driven on the hidden desktop: the `openWithBurst` hook runs vscode.openWith for several files at once, which is
// what "Open With…" on a selection does. They become one compare and no tab of theirs is left. One video, or two
// opened apart (past the window), stay separate players; the setting turns it off.
const path = require('path');

const CLIPS = ['h264_aac_anim_1080p.mp4', 'vp9_opus_anim_1080p.webm', 'h264_8_1080p.mp4'];
const opened = (n) => new RegExp(`\\[compare [^\\]]*\\] (?:opened, .*, |tiles: )${n}(?: tiles)?\\b`);
const isCompare = (tab) => /compare/i.test(tab.viewType) || /↔| · /.test(tab.label);
const esc = (s) => s.replace(/\./g, '\\.');

module.exports = [{
  name: 'compare_burst',
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
    const closeAll = async () => {
      vs.send({ command: 'workbench.action.closeAllEditors' });
      const t0 = Date.now();
      while ((await tabs()).length && Date.now() - t0 < 8000) await h.sleep(100);
    };
    // The tab list once pred(tabs) holds (bounded), confirmed by a second read 300 ms later; the last list is returned either way.
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
    // A negative window: a second open within the openTogether window (src/burst.js, 120 ms) would still turn into a
    // compare, so wait well past it before asserting that none appeared.
    const NO_COMPARE_MS = 800;
    let ok = null;
    try {
      await closeAll();
      ok = t('three-at-once');
      let from = vs.mark();
      vs.send({ openWithBurst: files });
      await vs.waitLog(/3 videos opened together -> one compare/, { from, timeout: 30000, what: 'the burst taken' });
      await vs.waitLog(opened(3), { from, timeout: 30000, what: 'compare opened with 3 tiles' });
      let tb = await tabsWhen((tb) => tb.length === 1 && isCompare(tb[0]));
      ok(tb.length === 1 && isCompare(tb[0]), `tabs after the burst: ${JSON.stringify(tb)}`);
      // A burst is the whole set the user asked for: Add Mode stays off, so the next
      // video opens as a player of its own instead of joining the compare.
      await vs.waitLog(/webview: (?:begin:|first pictures shown)/, { from, timeout: 30000, what: 'compare ready' });
      ok(!vs.lines.slice(from).some((l) => /compare: add from the Explorer on|webview: addMode on/.test(l)), 'a burst must open Compare with Add Mode off');
      const after = vs.mark();
      vs.send({ openWithBurst: [files[2]] });
      // (files[2] is one of the compared videos: opened alone it is a player of its own, not added or deduplicated away.)
      await vs.waitLog(new RegExp(`\\[${esc(CLIPS[2])}\\] session resolved`), { from: after, timeout: 15000, what: 'a player after the burst' });
      await h.sleep(NO_COMPARE_MS);
      tb = await tabs();
      ok(tb.length === 2 && tb.some(isCompare) && tb.some((x) => !isCompare(x)),
        `a video opened after the burst is a player beside the compare: ${JSON.stringify(tb)}`);

    } catch (e) {
      if (ok) ok(false, String(e && e.message || e)); else out.push({ name: 'error', ok: false, problems: [String(e && e.message || e)] });
    }
    await h.closeClip(vs);
    return out;
  },
}];
