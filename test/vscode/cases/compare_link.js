'use strict';
// Layer 3 verifier for /compare deep links (vscode://gordon-vidal.video-preview-enhanced/compare?...):
// opens a synchronized Compare panel at the requested frame and layout mode, then reuses the open panel
// when a second link for the same files arrives with a new frame/timestamp and layout.
const path = require('path');

// Both clips are 30 fps, 3 s (90 frames).
const CLIPS = ['h264_aac_anim_1080p.mp4', 'vp9_opus_anim_1080p.webm'];
const kv = (line) => Object.fromEntries([...line.matchAll(/(\w+)=(\S+)/g)].map((m) => [m[1], m[2]]));
const list = (s) => String(s || '').split(',');
const nums = (s) => list(s).map(Number);
const opened = (n) => new RegExp(`\\[compare [^\\]]*\\] opened, .* ${n} tiles`);

module.exports = [{
  name: 'compare_link',
  settings: { 'videoPreviewEnhanced.decoder': 'builtin', 'videoPreviewEnhanced.autoplay': false },
  async run(vs, h) {
    const out = [];
    const t = (name) => {
      const r = { name, ok: true, problems: [] };
      out.push(r);
      return (cond, msg) => { if (!cond) { r.ok = false; r.problems.push(msg); } };
    };
    const files = CLIPS.map((c) => path.join(h.MEDIA, c));
    const enc = files.map((f) => encodeURIComponent(f));
    const link = (q) => `vscode://gordon-vidal.video-preview-enhanced/compare?${q}&file=${enc[0]}&file=${enc[1]}`;
    const act = (o) => vs.send({ compare: true, ...o });
    const report = async (delay = 200) => {
      const from = vs.mark();
      act({ action: 'report', delay });
      return kv(await vs.waitLog(/webview: compare report /, { from, timeout: 10000 }));
    };
    const until = async (pred, timeout = 25000) => {
      const end = Date.now() + timeout;
      let r = null;
      while (Date.now() < end) {
        r = await report();
        if (pred(r)) return r;
        await h.sleep(300);
      }
      return r;
    };
    const tabs = async () => {
      const from = vs.mark();
      vs.send({ tabs: true });
      const line = await vs.waitLog(/ tabs \[\[/, { from, timeout: 10000 });
      return JSON.parse(/ tabs (\[\[.*\]\])/.exec(line)[1]);
    };

    let ok = null;
    try {
      // 1. Open via /compare?frame=31&mode=split -> lands paused and synced on frame 31 in split mode.
      ok = t('open/split-frame');
      let from = vs.mark();
      vs.send({ openLink: link('frame=31&mode=split') });
      await vs.waitLog(opened(2), { from, timeout: 30000, what: 'compare opened by /compare link' });
      let r = await until((x) => x.synced === 'true' && nums(x.frames)[0] === 31 && nums(x.frames)[1] === 31, 30000);
      ok(r.synced === 'true', `not synced after open link: ${JSON.stringify(r)}`);
      ok(r.mode === 'split', `expected mode=split, got ${r.mode}`);
      ok(nums(r.frames)[0] === 31 && nums(r.frames)[1] === 31, `expected both tiles at frame 31, got ${r.frames}`);
      ok(r.playing === '0,0', `expected paused after link seek, got playing=${r.playing}`);

      // 2. Follow a second /compare link for the same pair -> reuses the panel, switches to grid, lands on frame 60.
      ok = t('reuse/grid-frame');
      vs.send({ openLink: link('frame=60&mode=grid') });
      r = await until((x) => x.synced === 'true' && x.mode === 'grid' && nums(x.frames)[0] === 60 && nums(x.frames)[1] === 60, 20000);
      ok(r.synced === 'true', `not synced after reuse link: ${JSON.stringify(r)}`);
      ok(r.mode === 'grid', `expected mode=grid, got ${r.mode}`);
      ok(nums(r.frames)[0] === 60 && nums(r.frames)[1] === 60, `expected both tiles at frame 60, got ${r.frames}`);
      const tb = (await tabs()).flat();
      ok(tb.length === 1 && /compare/i.test(tb[0].viewType), `expected 1 reused compare tab, got ${JSON.stringify(tb)}`);

      // 3. Follow a third /compare link using t=0.5&mode=spotlight -> switches to spotlight and seeks to ~0.5 s (frame 15-16).
      ok = t('reuse/spotlight-time');
      vs.send({ openLink: link('t=0.5&mode=spotlight') });
      r = await until((x) => x.synced === 'true' && x.mode === 'spotlight' && Math.abs(nums(x.frames)[0] - 16) <= 1 && Math.abs(nums(x.frames)[1] - 16) <= 1, 20000);
      ok(r.synced === 'true', `not synced after t=0.5 link: ${JSON.stringify(r)}`);
      ok(r.mode === 'spotlight', `expected mode=spotlight, got ${r.mode}`);
      ok(Math.abs(nums(r.frames)[0] - 16) <= 1 && Math.abs(nums(r.frames)[1] - 16) <= 1, `expected both tiles near frame 16 (0.5s), got ${r.frames}`);
    } catch (e) {
      if (ok) ok(false, e.message); else out.push({ name: 'error', ok: false, problems: [e.message] });
    }
    await h.closeClip(vs);
    return out;
  },
}];
