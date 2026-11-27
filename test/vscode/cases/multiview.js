'use strict';
// Multi-view (docs/PRODUCT.md "Multi-view (compare)") in a real VS Code: 3 then 4 videos in a 2x2 grid,
// all playing; offsets in frames and in ms after paused lockstep steps; the clock and sound choices;
// 2 videos side by side / split. A second case runs every tile on native ffmpeg and checks
// that frames come at the tile's size. The panel, menus and views are in compare_ui.js. Everything is read from compare's `compare report` line
// (media/compare.js) through the VPE_LOG test hook.
const path = require('path');
const { TILE_KEYS } = require('../../../media/compare-grid');
const { make } = require('../../media/make_cases_media');

// A and B: 30 fps, 3 s, with sound (AAC, Opus). C and D: 24 fps, 2 s, no sound.
const CLIPS = ['h264_aac_anim_1080p.mp4', 'vp9_opus_anim_1080p.webm', 'h264_8_1080p.mp4', 'vp9_1080p.webm'];
const NATIVE_CLIPS = ['hevc_8_1080p.mp4', 'vp9_1080p.webm', 'h264_8_1080p.mp4', 'av1_8_1080p.mp4'];

const kv = (line) => Object.fromEntries([...line.matchAll(/(\w+)=(\S+)/g)].map((m) => [m[1], m[2]]));
const list = (s) => String(s || '').split(',');
const nums = (s) => list(s).map(Number);

/** Shared steps: report, wait for a condition, step and check the frames every tile shows. */
function helpers(vs, h, t) {
  const report = async (delay = 200) => {
    const from = vs.mark();
    vs.send({ compare: true, action: 'report', delay });
    return kv(await vs.waitLog(/webview: compare report /, { from, timeout: 10000 }));
  };
  const act = (o) => vs.send({ compare: true, ...o });
  const until = async (pred, timeout = 20000) => {
    const end = Date.now() + timeout;
    let r = null;
    while (Date.now() < end) {
      r = await report();
      if (pred(r)) return r;
      await h.sleep(400);
    }
    return r;
  };
  /**
   * The frame (1-based) tile i must show for the clock's shown frame: the same moment plus the
   * offsets (ms, or frames of that tile), nearest frame. Mirrors relFor() and the engine's quarter-frame rule.
   * Returns [frame, alt] (alt: the other neighbour when the moment falls on a half frame).
   */
  const expect = (r, offs, i) => {
    const fps = nums(r.fps);
    const c = Number(r.clock);
    const clockPts = nums(r.pts)[c];
    const off = (j) => (offs[j].unit === 'ms' ? offs[j].v / 1000 : offs[j].v / fps[j]);
    const x = (clockPts - off(c) + off(i)) * fps[i] + 0.5;
    const k = Math.floor(x);
    const alt = Math.abs(x - Math.round(x)) < 0.02 ? (x - k < 0.5 ? k - 1 : k + 1) : k;
    return [k + 1, alt + 1];
  };
  /** After a paused step: every tile shows its frame (synced), each the expected one. */
  const checkFrames = (ok, r, offs, what) => {
    ok(r.synced === 'true', `${what}: never synced (frames ${r.frames})`);
    const frames = nums(r.frames);
    for (let i = 0; i < frames.length; i++) {
      const [e, alt] = expect(r, offs, i);
      ok(frames[i] === e || frames[i] === alt, `${what}: tile ${TILE_KEYS[i]} shows #${frames[i]}, expected #${e} `
        + `(clock ${TILE_KEYS[r.clock]} #${frames[r.clock]}, fps ${r.fps}, offsets ${r.offsets}, PTS ${r.pts}, targets ${r.targets})`);
    }
  };
  /** While playing: every tile near its frame for the clock's (followers may trail a few frames; the clock holds beyond 120 ms). */
  const checkPlaying = (ok, r, offs, what) => {
    const fps = nums(r.fps);
    const frames = nums(r.frames);
    for (let i = 0; i < offs.length; i++) {
      const [want] = expect(r, offs, i);
      ok(Math.abs(frames[i] - want) <= Math.ceil(0.2 * fps[i]), `${what}: playing tile ${TILE_KEYS[i]} shows #${frames[i]}, expected near #${want} (frames ${r.frames})`);
    }
  };
  const stepAndWait = async (d) => {
    const before = await report();
    act({ action: 'step', d });
    const c = Number(before.clock);
    const fps = nums(before.fps)[c];
    const want = nums(before.pts)[c] + d / fps;
    const arrived = (r) => r.synced === 'true' && Number(r.clock) === c && Math.abs(nums(r.pts)[c] - want) < 0.1 / fps;
    const after = await until(arrived, 15000);
    if (!arrived(after)) throw new Error(`clock step ${d}: expected PTS near ${want}, got ${after.pts}`);
    return after;
  };
  return { report, act, until, expect, checkFrames, checkPlaying, stepAndWait };
}

/** The extension activates when a video opens; the test hook (compareFiles) needs it. */
async function activate(vs, h, file) {
  const from = await h.openClip(vs, file);
  const tag = path.basename(file).replace(/\./g, '\\.');
  await vs.waitLog(new RegExp(`\\[${tag}\\] webview: first frame shown`), { from, timeout: 45000, what: 'first frame (activation)' });
  await h.closeClip(vs);
}

const opened = (n) => new RegExp(`\\[compare [^\\]]*\\] (?:opened, .*, |tiles: )${n}(?: tiles)?\\b`);

module.exports = [{
  name: 'multiview-transcode',
  ffmpeg: true,
  settings: {
    'videoPreviewEnhanced.transcode': 'always',
    'videoPreviewEnhanced.transcodeMaxBitrate': 6,
    'videoPreviewEnhanced.transcodeSplitBitrate': true,
  },
  async run(vs, h) {
    const problems = [];
    const ok = (condition, message) => { if (!condition) problems.push(message); };
    const { act, until } = helpers(vs, h);
    const from = vs.mark();
    vs.send({ compareFiles: CLIPS.slice(0, 2).map((clip) => path.join(h.MEDIA, clip)) });
    await vs.waitLog(opened(2), { from, timeout: 45000 });
    const ready = (r) => r?.synced === 'true' && list(r.frames).length === 2 && !list(r.frames).includes('-');
    const shown = await until(ready, 45000);
    ok(ready(shown), `expected both tiles to show a synced picture, got ${JSON.stringify(shown)}`);
    const decisions = vs.lines.slice(from).filter((line) => /\] tile [AB]:/.test(line));
    const active = list(shown?.native);
    ok(active.includes('1'), 'expected at least one tile to keep streaming');
    for (const key of 'AB') {
      const start = new RegExp(`tile ${key}: remote stream from .*3000 kb/s cap`);
      ok(decisions.some((line) => start.test(line)), `tile ${key} did not start with half the cap`);
      if (active['AB'.indexOf(key)] === '0') {
        ok(decisions.some((line) => line.includes(`tile ${key}: live transcode failed`)),
          `tile ${key} fell back without reporting an encoder failure`);
      }
    }
    if (ready(shown) && shown.native === '1,1') {
      const check = vs.mark();
      act({ action: 'click', sel: '#infoBtn' });
      act({ action: 'ui', id: 1 });
      const info = await vs.waitLog(/compare ui \{"id":1,/, { from: check, timeout: 10000 });
      ok(/Live transcode/i.test(info) && /Use original video/.test(info), 'About lacks the active pipeline or original action');
      act({ action: 'click', text: 'Use original video' });
      const original = await until((r) => ready(r) && r.native === '0,1', 30000);
      ok(ready(original) && original.native === '0,1', 'switching the clock to original video disturbed the other tile');
    }
    return [{ name: 'tile-streams-and-original', ok: !problems.length, problems }];
  },
}, {
  // Live transcode in Compare: each tile's engine keeps the packets it received (media/packet-cache.js). A paused seek
  // back into what played comes from them in every tile, frame-exact and in step, with no seek sent to the host.
  name: 'multiview-transcode-packets',
  ffmpeg: true,
  settings: { 'videoPreviewEnhanced.transcode': 'always', 'videoPreviewEnhanced.loop': false },
  async run(vs, h) {
    const problems = [];
    const ok = (condition, message) => { if (!condition) problems.push(message); };
    const { act, until } = helpers(vs, h);
    const from = vs.mark();
    vs.send({ compareFiles: CLIPS.slice(0, 2).map((clip) => path.join(h.MEDIA, clip)) });
    await vs.waitLog(opened(2), { from, timeout: 45000 });
    const ready = (r) => r?.synced === 'true' && list(r.frames).length === 2 && !list(r.frames).includes('-');
    const shown = await until(ready, 45000);
    ok(ready(shown) && shown.native === '1,1', `expected both tiles on Live transcode, got ${JSON.stringify(shown)}`);
    const result = { name: 'seek-back-from-packets', problems, steps: [] };
    if (ready(shown)) {
      const at = (r) => nums(r.frames);
      const seekTo = async (frame) => {
        act({ action: 'seek', t: (frame + 0.25) / 30 }); // A and B are 30 fps
        return until((r) => ready(r) && at(r).every((f) => f === frame + 1), 15000);
      };
      await seekTo(5);
      act({ action: 'play' });
      await h.sleep(1500);
      act({ action: 'pause' });
      await until((r) => ready(r) && !list(r.playing).includes('1'), 10000);
      await seekTo(80);
      await h.sleep(800);
      const measure = async (what, fn) => {
        const mark = vs.mark();
        const t0 = Date.now();
        const r = await fn();
        const lines = vs.lines.slice(mark);
        const step = {
          what, ms: Date.now() - t0, frames: r && r.frames,
          local: [...'AB'].filter((k) => lines.some((l) => l.includes(`[${k}]`) && l.includes("from the page's packets"))),
          memory: [...'AB'].filter((k) => lines.some((l) => l.includes(`[${k}]`) && l.includes('step back from memory'))),
          hostSeeks: lines.filter((l) => /tile [AB]: .*(seek to|remote stream from )/.test(l) || /remote stream.*seek to/.test(l)).length,
        };
        result.steps.push(step);
        return { r, step };
      };
      const back = await measure('seek back to #21', () => seekTo(20));
      ok(back.r && at(back.r).every((f) => f === 21), `seek back: tiles show ${back.r && back.r.frames}, expected #21 in both`);
      ok(back.step.local.length === 2, `seek back: only tiles [${back.step.local}] were served from their packets`);
      ok(back.step.hostSeeks === 0, `seek back: ${back.step.hostSeeks} seeks went to the host`);
      for (let i = 0; i < 3; i++) {
        const want = 20 - i; // 1-based frame after the step
        const s = await measure(`step back to #${want}`, async () => {
          act({ action: 'step', d: -1 });
          return until((r) => ready(r) && at(r).every((f) => f === want), 15000);
        });
        ok(s.r && at(s.r).every((f) => f === want), `step ${i + 1}: tiles show ${s.r && s.r.frames}, expected #${want}`);
        ok(s.step.hostSeeks === 0, `step ${i + 1}: ${s.step.hostSeeks} seeks went to the host`);
      }
      result.notes = vs.lines.slice(from).filter((l) => /page's packets|step back from memory|tile [AB]: /.test(l)).slice(-30);
    }
    result.ok = !problems.length;
    return [result];
  },
}, {
  name: 'multiview-short-loop',
  settings: { 'videoPreviewEnhanced.decoder': 'builtin', 'videoPreviewEnhanced.loop': true },
  async run(vs, h) {
    const dir = require('../../media/make_cases_media').ensure(['s_hevc.mp4', 's_vp9.webm']);
    const files = ['s_hevc.mp4', 's_vp9.webm'].map((c) => path.join(dir, c));
    const { report, act, until } = helpers(vs, h);
    await activate(vs, h, files[0]);
    const from = vs.mark();
    vs.send({ compareFiles: files });
    await vs.waitLog(opened(2), { from, timeout: 30000 });
    // Both tiles on the built-in decoder, A the clock, in step (media/compare.js said "begin: A ... soft, B ... soft").
    await until((r) => r.native === '0,0' && r.clock === '0' && r.synced === 'true', 30000);
    act({ action: 'play' });

    const loops = [];
    let prev = 0;
    const end = Date.now() + 60000; // generous: ends after 3 loops
    while (Date.now() < end) {
      const r = await report(20);
      const [clock, follower] = nums(r.frames);
      if (prev - clock > 45) loops.push([]);
      prev = clock;
      if (loops.length && clock >= 12 && clock <= 66) loops[loops.length - 1].push({ clock, follower });
      // Three passes sampled early and later (a busy machine answers reports slowly and can miss a pass's window).
      const full = loops.filter((p) => { const e = p.find(({ clock: c }) => c <= 39); return e && p.some(({ clock: c }) => c >= e.clock + 15); });
      if (full.length >= 3 && clock >= 54) break;
    }
    const problems = [];
    if (loops.length < 3) problems.push(`expected three clock wraps, saw ${loops.length}`);
    // Compare loops as one: every decoder runs with its own loop off and the clock's end wraps them all together (media/
    // player-unified.js onPlayerEnded: "end of file: loop", then the controller seeks to 0 and plays on). One such end per
    // wrap; a decoder that wrapped on its own would show as a wrap without one.
    const ends = vs.lines.slice(from).filter((l) => /\[compare [^\]]*\] webview: end of file: loop/.test(l)).length;
    if (ends < 3 || ends < loops.length) problems.push(`the clock's end drove ${ends} shared wraps, the report saw ${loops.length}`);
    if (vs.lines.slice(from).some((l) => /webview: \[[AB]\] loop: replaying/.test(l))) problems.push('a decoder looped on its own in Compare');
    // A seek may still be settling right at the wrap. Check sync twice during each new pass that was sampled twice.
    let checked = 0;
    loops.forEach((samples, i) => {
      const early = samples.find(({ clock }) => clock <= 39);
      const later = samples.find(({ clock }) => early && clock >= early.clock + 15);
      if (!early || !later) return;
      checked++;
      if (later.follower <= early.follower || [early, later].some(({ clock, follower }) => !(Math.abs(clock - follower) <= 4))) {
        problems.push(`wrap ${i + 1}: follower did not advance in sync (${early.clock}/${early.follower} then ${later.clock}/${later.follower})`);
      }
    });
    if (checked < 3) problems.push(`only ${checked} of ${loops.length} passes were sampled early and later (want 3)`);
    return [{ name: 'follower', ok: !problems.length, problems, loops }];
  },
}, {
  name: 'multiview',
  async run(vs, h) {
    const out = [];
    const t = (name) => {
      const r = { name, ok: true, problems: [] };
      out.push(r);
      return (cond, msg) => { if (!cond) { r.ok = false; r.problems.push(msg); } };
    };
    const { report, act, until, checkFrames, stepAndWait } = helpers(vs, h, t);
    const files = CLIPS.map((c) => path.join(h.MEDIA, c));
    const allShown = (r) => r && list(r.frames).length === Number(r.n) && !list(r.frames).includes('-');

    // ---- 3 videos: a grid with an empty fourth tile; then a fourth added in the panel ----
    await activate(vs, h, files[0]);
    let ok = t('grid/three-then-add');
    let from = vs.mark();
    vs.send({ compareFiles: files.slice(0, 3) });
    await vs.waitLog(opened(3), { from, timeout: 30000, what: 'compare opened with 3' });
    let r = await until(allShown, 45000);
    ok(allShown(r), `3 tiles: not every tile shows a frame (${r && r.frames})`);
    ok(r.n === '3' && r.mode === 'grid' && r.modes === 'spotlight,grid', `3 tiles: n=${r.n} mode=${r.mode} modes=${r.modes}`);
    ok(r.add === 'true', 'the "Add video" fourth cell is not there');
    ok(r.cells === '3', `cells=${r.cells}`);
    from = vs.mark();
    vs.send({ compareAdd: [files[3]] });
    await vs.waitLog(opened(4), { from, timeout: 30000, what: 'compare reopened with 4' });
    let firstPic;
    r = await until((x) => {
      if (x.n !== '4') return false;
      // The grid has its layout as soon as its first tile draws, even while the other tiles settle.
      if (!firstPic && Number(list(x.shown)[0]) > 0) firstPic = String(x.fulls).split(';')[0];
      return allShown(x);
    }, 45000);

    // ---- 4 videos: 2x2, all play ----
    ok = t('grid/four-play');
    ok(allShown(r), `4 tiles: not every tile shows a frame (${r && r.frames})`);
    ok(r.n === '4' && r.mode === 'grid' && r.add === 'false' && r.cells === '4', `n=${r.n} mode=${r.mode} add=${r.add} cells=${r.cells}`);
    // Each tile draws on its own canvas (the unified page), fitted into its quarter of the picture area: a 2x2 grid of
    // equal pictures (the four clips are all 1080p) that do not overlap, laid out once the first tile drew.
    const pics = String(r.fulls).split(';').map((q) => q.split('/').map(Number));
    const cols = [...new Set(pics.map(([x, , w]) => Math.round(x + w / 2)))].sort((a, b) => a - b);
    const rows = [...new Set(pics.map(([, y, , h]) => Math.round(y + h / 2)))].sort((a, b) => a - b);
    ok(r.grid === '2x2' && pics.length === 4 && cols.length === 2 && rows.length === 2, `grid ${r.grid}, tile pictures ${r.fulls}`);
    ok(pics.every(([, , w, h]) => w > 0 && h > 0 && Math.abs(w - pics[0][2]) <= 1 && Math.abs(h - pics[0][3]) <= 1), `tile pictures differ in size: ${r.fulls}`);
    ok(pics.every(([x, y, w, h]) => pics.every(([x2, y2, w2, h2]) => (x === x2 && y === y2)
      || x + w <= x2 + 1 || x2 + w2 <= x + 1 || y + h <= y2 + 1 || y2 + h2 <= y + 1)), `tile pictures overlap: ${r.fulls}`);
    ok(firstPic === pics[0].join('/'), `A's picture moved from ${firstPic} to ${pics[0].join('/')} after the first tile drew`);
    act({ action: 'seek', t: 0 });
    await until((x) => x.synced === 'true', 15000);
    const s0 = nums((await report()).shown);
    act({ action: 'play' });
    // Every tile draws while playing (a few frames: how many per second is speed, layer 4). Ends as soon as they do.
    let s1 = s0;
    for (const w0 = Date.now(); Date.now() - w0 < 20000;) {
      await h.sleep(200);
      r = await report();
      s1 = nums(r.shown);
      if ([0, 1, 2, 3].every((i) => s1[i] - s0[i] >= 3)) break;
    }
    ok(list(r.playing).every((x) => x === '1'), `playing=${r.playing}, expected all 1`);
    for (let i = 0; i < 4; i++) ok(s1[i] - s0[i] >= 3, `tile ${'ABCD'[i]} drew ${s1[i] - s0[i]} frames while playing`);
    act({ action: 'pause' });

    // ---- lockstep, then offsets in frames and in ms ----
    ok = t('sync/lockstep');
    const offs = CLIPS.map(() => ({ unit: 'frames', v: 0 }));
    act({ action: 'seek', t: 0.5 });
    r = await until((x) => x.synced === 'true' && list(x.playing).every((p) => p === '0'), 15000);
    checkFrames(ok, r, offs, 'paused seek');
    r = await stepAndWait(1);
    checkFrames(ok, r, offs, 'step +1');
    r = await stepAndWait(-1);
    checkFrames(ok, r, offs, 'step -1');

    ok = t('sync/offsets');
    offs[1] = { unit: 'frames', v: 3 };
    offs[2] = { unit: 'ms', v: 200 };
    offs[3] = { unit: 'frames', v: -2 };
    const before = nums(r.frames);
    for (let i = 1; i < 4; i++) act({ action: 'offset', tile: i, v: offs[i].v, unit: offs[i].unit });
    r = await stepAndWait(1);
    ok(r.offsets === '0f,3f,200ms,-2f', `offsets=${r.offsets}`);
    checkFrames(ok, r, offs, 'step +1 with offsets');
    const fr = nums(r.frames);
    ok(fr[1] === fr[0] + 3, `B (+3 frames, same fps as A) shows #${fr[1]}, A #${fr[0]}`);
    ok(fr[2] - (before[2] + 1) >= 4, `C (+200 ms at 24 fps) moved from #${before[2]} to #${fr[2]} for one step`);
    r = await stepAndWait(1);
    checkFrames(ok, r, offs, 'second step with offsets');

    // ---- the clock: C (24 fps) drives the steps and the seek bar ----
    ok = t('sync/clock');
    act({ action: 'clock', tile: 2 });
    r = await until((x) => x.clock === '2' && x.synced === 'true', 10000);
    ok(r.clock === '2', `clock=${r.clock}`);
    ok(r.seekMax === '47', `seek bar max ${r.seekMax}, expected C's 48 frames - 1`);
    const cBefore = nums(r.frames)[2];
    r = await stepAndWait(1);
    ok(nums(r.frames)[2] === cBefore + 1, `step moved C from #${cBefore} to #${nums(r.frames)[2]}`);
    checkFrames(ok, r, offs, 'step with clock C');
    r = await stepAndWait(1);
    checkFrames(ok, r, offs, 'second step with clock C');
    act({ action: 'clock', tile: 0 });
    for (let i = 1; i < 4; i++) act({ action: 'offset', tile: i, v: 0, unit: 'frames' });
    await until((x) => x.clock === '0', 5000);

    // ---- the sound: one video at a time ----
    ok = t('sync/sound');
    r = await report();
    // Play without a user gesture leaves the page's audio suspended, which shows as muted (as in the
    // player): unmute first.
    if (r.muted === 'true') { act({ action: 'key', key: 'm' }); r = await until((x) => x.muted === 'false', 5000); }
    ok(r.muted === 'false', 'M did not unmute');
    ok(r.sound === '0', `sound=${r.sound}, expected the first by default`);
    ok(list(r.audio).slice(0, 2).join(',') === '1,1', `A and B should have sound (audio=${r.audio})`);
    let g = list(r.gains);
    ok(Number(g[0]) > 0 && Number(g[1]) === 0, `sound from A: gains=${r.gains}`);
    act({ action: 'sound', tile: 1 });
    r = await until((x) => x.sound === '1', 5000);
    g = list(r.gains);
    ok(Number(g[0]) === 0 && Number(g[1]) > 0, `sound from B: gains=${r.gains}`);
    act({ action: 'play' });
    await h.sleep(800);
    r = await report();
    if (r.muted === 'true') { act({ action: 'key', key: 'm' }); r = await until((x) => x.muted === 'false', 5000); } // suspended audio again
    g = list(r.gains);
    ok(r.playing.startsWith('1,1') && Number(g[0]) === 0 && Number(g[1]) > 0, `playing, sound from B: playing=${r.playing} gains=${r.gains}`);
    act({ action: 'pause' });
    act({ action: 'sound', tile: 0 });

    // ---- the Compare panel (bar button), Esc closes it ----
    ok = t('sync/panel');
    act({ action: 'click', sel: '#cmpBtn' });
    r = await until((x) => x.panel === 'cmp', 5000);
    ok(r.panel === 'cmp', `Compare button: panel=${r.panel}`);
    act({ action: 'key', key: 'Escape' });
    r = await until((x) => x.panel === '-', 5000);
    ok(r.panel === '-', 'Esc did not close the Compare panel');

    // ---- switching the clock while playing: the new clock keeps its own position (its offset) ----
    ok = t('sync/clock-while-playing');
    const moving = CLIPS.map(() => ({ unit: 'frames', v: 0 }));
    moving[1] = { unit: 'ms', v: 1500 };
    act({ action: 'offset', tile: 1, v: 1500, unit: 'ms' });
    act({ action: 'seek', t: 0 });
    await until((x) => x.synced === 'true' && x.offsets === '0f,1500ms,0f,0f', 15000);
    act({ action: 'play' });
    await h.sleep(300);
    act({ action: 'clock', tile: 1 });
    act({ action: 'pause' });
    r = await until((x) => x.clock === '1' && x.synced === 'true' && list(x.playing).every((p) => p === '0'), 15000);
    // B runs 1.5 s ahead of A: had B paused on A's position (the old clock's offset dropped), A would
    // need a frame 1.5 s before its start.
    ok(nums(r.frames)[1] >= 46, `B jumped back to #${nums(r.frames)[1]} when it became the clock while playing (frames ${r.frames})`);
    checkFrames(ok, r, moving, 'paused after a clock switch while playing');

    // ---- removing the clock: the next clock resumes at the same picture, in its own timeline ----
    ok = t('sync/remove-clock');
    act({ action: 'offset', tile: 1, v: 0, unit: 'frames' });
    act({ action: 'clock', tile: 2 });
    act({ action: 'offset', tile: 2, v: -500, unit: 'ms' });
    act({ action: 'seek', t: 0.5 });
    r = await until((x) => x.clock === '2' && x.synced === 'true' && x.offsets === '0f,0f,-500ms,0f', 15000);
    const aFrame = nums(r.frames)[0];
    ok(Math.abs(aFrame - 31) <= 1, `before removing C: A shows #${aFrame}, expected about #31 (frames ${r.frames})`);
    from = vs.mark();
    act({ action: 'remove', tile: 2 });
    await vs.waitLog(opened(3), { from, timeout: 30000, what: 'compare reopened with 3' });
    r = await until((x) => x.n === '3' && allShown(x) && x.synced === 'true' && x.clock === '0', 30000);
    ok(r.n === '3' && r.clock === '0', `after removing the clock: n=${r.n} clock=${r.clock}`);
    ok(Math.abs(nums(r.frames)[0] - aFrame) <= 1, `A (the new clock) shows #${nums(r.frames)[0]}, was #${aFrame} before its clock C was removed`);
    await h.closeClip(vs);

    // ---- 2 videos: spotlight, grid, split; an ms offset on B ----
    ok = t('pair/views-and-offset');
    from = vs.mark();
    vs.send({ compareFiles: [files[0], files[2]] });
    await vs.waitLog(opened(2), { from, timeout: 30000, what: 'compare opened with 2' });
    r = await until(allShown, 45000);
    ok(r.n === '2' && r.modes === 'spotlight,grid,split', `2 tiles: n=${r.n} modes=${r.modes}`);
    for (const mode of ['spotlight', 'split', 'grid']) {
      act({ action: 'mode', mode });
      await h.sleep(500);
      r = await report();
      ok(r.mode === mode && (mode === 'split') === (r.divider === 'true'), `mode ${mode}: mode=${r.mode} divider=${r.divider}`);
    }
    const pair = [{ unit: 'frames', v: 0 }, { unit: 'ms', v: 250 }];
    act({ action: 'offset', tile: 1, v: 250, unit: 'ms' });
    act({ action: 'seek', t: 0.4 });
    await until((x) => x.synced === 'true', 15000);
    r = await stepAndWait(1);
    checkFrames(ok, r, pair, '2 tiles, B +250 ms');
    // Shorter clock (B = 2 s, 24 fps) playing to natural EOF must pause the longer follower (A = 3 s, 30 fps) too,
    // and seeking backwards while paused must keep both tiles paused.
    ok = t('pair/short-clock-eof');
    act({ action: 'offset', tile: 1, v: 0, unit: 'frames' });
    act({ action: 'clock', tile: 1 });
    await until((x) => x.clock === '1' && x.synced === 'true', 10000);
    act({ action: 'seek', t: 1.7 });
    await until((x) => x.synced === 'true' && nums(x.frames)[1] >= 38, 10000);
    act({ action: 'play' });
    r = await until((x) => x.playing === '0,0' && nums(x.frames)[1] >= 46, 15000);
    ok(r && r.playing === '0,0', `shorter clock EOF left a tile playing: playing=${r && r.playing} frames=${r && r.frames}`);
    act({ action: 'seek', t: 0.5 });
    r = await until((x) => x.synced === 'true' && nums(x.frames)[1] <= 15, 10000);
    ok(r && r.playing === '0,0', `seeking backwards after EOF resumed a tile: playing=${r && r.playing}`);
    await h.closeClip(vs);
    return out;
  },
}, {
  name: 'multiview-native',
  ffmpeg: true,
  settings: { 'videoPreviewEnhanced.decoder': 'ffmpeg' },
  async run(vs, h) {
    const out = [];
    const t = (name) => {
      const r = { name, ok: true, problems: [] };
      out.push(r);
      return (cond, msg) => { if (!cond) { r.ok = false; r.problems.push(msg); } };
    };
    const { report, act, until, checkFrames, stepAndWait } = helpers(vs, h, t);
    const allShown = (r) => r && list(r.frames).length === Number(r.n) && !list(r.frames).includes('-');
    await activate(vs, h, path.join(h.MEDIA, CLIPS[0]));
    let ok = t('native/tile-size');
    const from = vs.mark();
    vs.send({ compareFiles: NATIVE_CLIPS.map((c) => path.join(h.MEDIA, c)) });
    await vs.waitLog(opened(4), { from, timeout: 60000, what: 'compare opened with 4' });
    const decided = vs.lines.slice(from).filter((l) => /\] (?:tile [A-D]: )?(?:native ffmpeg|built-in)/.test(l));
    ok(decided.length === 4 && decided.every((l) => /native ffmpeg/.test(l)), `decisions: ${decided.map((l) => l.replace(/^.*\] tile/, 'tile')).join(' | ') || 'none'}`);
    let r = await until(allShown, 60000);
    ok(allShown(r), `not every tile shows a frame (${r && r.frames})`);
    ok(r.native === '1,1,1,1', `native=${r.native}`);
    const [sw, sh] = r.stage.split('x').map(Number);
    const fit = Math.min(1080, sh / 2, sw / 2 * 9 / 16);
    ok(nums(r.heights).every((x) => x > 0 && Math.abs(x - fit) < 2), `frame heights ${r.heights} for stage ${r.stage}`);

    ok = t('native/frame-server');
    ok(r.transport === 'stream,stream,stream,stream', `transport=${r.transport}`);
    for (const key of 'ABCD') {
      ok(vs.lines.slice(from).some((l) => l.includes(`[${key}] engine: native frames over http`)), `tile ${key} did not open an HTTP stream`);
    }

    ok = t('native/play');
    act({ action: 'seek', t: 0 });
    await until((x) => x.synced === 'true', 20000);
    const s0 = nums((await report()).shown);
    act({ action: 'play' });
    // Every tile draws while playing (a few frames: how many per second is speed, layer 4). Ends as soon as they do.
    let s1 = s0;
    for (const w0 = Date.now(); Date.now() - w0 < 20000;) {
      await h.sleep(200);
      r = await report();
      s1 = nums(r.shown);
      if ([0, 1, 2, 3].every((i) => s1[i] - s0[i] >= 3)) break;
    }
    ok(list(r.playing).every((x) => x === '1'), `playing=${r.playing}`);
    for (let i = 0; i < 4; i++) ok(s1[i] - s0[i] >= 3, `tile ${'ABCD'[i]} drew ${s1[i] - s0[i]} frames while playing`);
    act({ action: 'pause' });

    ok = t('native/lockstep');
    const offs = NATIVE_CLIPS.map(() => ({ unit: 'frames', v: 0 }));
    act({ action: 'seek', t: 0.5 });
    r = await until((x) => x.synced === 'true' && list(x.playing).every((p) => p === '0'), 20000);
    r = await stepAndWait(1);
    checkFrames(ok, r, offs, 'step +1');
    offs[1] = { unit: 'frames', v: 2 };
    offs[3] = { unit: 'ms', v: 125 };
    act({ action: 'offset', tile: 1, v: 2, unit: 'frames' });
    act({ action: 'offset', tile: 3, v: 125, unit: 'ms' });
    r = await stepAndWait(1);
    checkFrames(ok, r, offs, 'step +1 with offsets');

    ok = t('native/resize-and-budget');
    act({ action: 'stageSize', w: 640, h: 360 });
    r = await until((x) => x.synced === 'true' && nums(x.heights).every((v) => v > 0 && v <= 360), 20000);
    const small = nums(r.heights);
    const frames = r.frames;
    ok(r.synced === 'true' && small.every((v) => v > 0 && v <= 360), `small stage ${r.stage}: heights=${r.heights}`);
    act({ action: 'stageSize', w: 3840, h: 2160 });
    r = await until((x) => x.synced === 'true' && x.heights === '1080,1080,1080,1080', 20000);
    ok(r.heights === '1080,1080,1080,1080', `large stage ${r.stage}: heights=${r.heights}`);
    ok(r.synced === 'true' && r.frames === frames, `resize moved the paused grid from ${frames} to ${r.frames}`);
    act({ action: 'rate', rate: 2 });
    r = await until((x) => x.synced === 'true' && nums(x.heights).every((v) => v > 0 && v < 1080), 20000);
    const bytes = nums(r.heights).reduce((sum, height, i) => sum + height * nums(r.widths)[i] * nums(r.fps)[i] * 1.5 * 2, 0);
    ok(bytes >= 390e6 && bytes <= 400e6, `2× grid uses ${bytes / 1e6} MB/s at heights ${r.heights}`);
    ok(r.transport === 'stream,stream,stream,stream', `after resize: transport=${r.transport}`);
    ok(vs.lines.slice(from).filter((l) => /tile [A-D]: native transport: http/.test(l)).length === 4, 'resizing reopened a frame channel');
    checkFrames(ok, r, offs, 'after resize');

    // A native resize that lands while a seek is in flight must not send the tiles back to the old position.
    ok = t('native/seek-through-resize');
    const prev = r.heights;
    act({ action: 'stageSize', w: 1280, h: 720 });
    act({ action: 'seek', t: 1 });
    r = await until((x) => x.synced === 'true' && x.heights !== prev && nums(x.frames)[0] === Math.floor(nums(x.fps)[0] + 1e-6) + 1, 30000);
    ok(r.heights !== prev && nums(r.heights).every((v, i) => v > 0 && v < nums(prev)[i]), `heights after resize: ${prev} -> ${r.heights}`);
    ok(nums(r.frames)[0] === Math.floor(nums(r.fps)[0] + 1e-6) + 1, `seek to 1 s through a resize: clock shows #${nums(r.frames)[0]} (frames ${r.frames})`);
    checkFrames(ok, r, offs, 'seek through resize');
    await h.closeClip(vs);
    return out;
  },
}, {
  name: 'multiview-native-fallback',
  ffmpeg: true,
  env: { VPE_NATIVE_TRANSPORT: 'fail' }, // Each tile gets an invalid token, which the server rejects with 403.
  settings: { 'videoPreviewEnhanced.decoder': 'ffmpeg' },
  async run(vs, h) {
    const { act, until } = helpers(vs, h);
    await activate(vs, h, path.join(h.MEDIA, CLIPS[0]));
    const from = vs.mark();
    vs.send({ compareFiles: NATIVE_CLIPS.map((c) => path.join(h.MEDIA, c)) });
    await vs.waitLog(opened(4), { from, timeout: 60000 });
    const r = await until((x) => x.synced === 'true' && x.native === '1,1,1,1' && !list(x.frames).includes('-'), 60000);
    const problems = [];
    if (r.transport !== 'message,message,message,message' || r.synced !== 'true' || list(r.frames).includes('-')) {
      problems.push(`transport=${r.transport} synced=${r.synced} frames=${r.frames}`);
    }
    for (const key of 'ABCD') {
      if (!vs.lines.slice(from).some((l) => l.includes(`tile ${key}: native transport: message (webview:`))) problems.push(`tile ${key} did not report a failed connection`);
    }
    const shown = nums(r.shown);
    act({ action: 'play' });
    const played = await until((x) => nums(x.shown).every((n, i) => n > shown[i] + 2), 20000);
    if (nums(played.shown).some((n, i) => n <= shown[i] + 2)) problems.push(`fallback playback stalled: ${shown} → ${played.shown}`);
    await h.closeClip(vs);
    return [{ name: 'native/frame-server-403', ok: !problems.length, problems }];
  },
}, {
  // More than 4 videos (docs/notes/multiview-engine.md): 9 tiles on the
  // GPU and built-in decoders in a 3x3 grid with one shared renderer; lockstep, offsets, another clock, play, remove,
  // add up to 16 (4x4), close.
  name: 'multiview-large',
  settings: { 'videoPreviewEnhanced.compare.maxVideos': 16 },
  async run(vs, h) {
    const out = [];
    const t = (name) => {
      const r = { name, ok: true, problems: [] };
      out.push(r);
      return (cond, msg) => { if (!cond) { r.ok = false; r.problems.push(msg); } };
    };
    const { report, act, until, checkFrames, checkPlaying, stepAndWait } = helpers(vs, h);
    const ui = async (id) => {
      const from = vs.mark();
      act({ action: 'ui', id });
      const line = await vs.waitLog(new RegExp(`compare ui \\{"id":${id},`), { from, timeout: 10000 });
      return JSON.parse(line.slice(line.indexOf('compare ui ') + 'compare ui '.length));
    };
    const gpu = make('multiview_h264.mp4'); // H.264 1080p, 24 fps, 24 s: the GPU decoder
    const soft = make('s_vp9.webm'); // VP9 320x180, 30 fps, 3 s: the built-in decoder
    if (!gpu || !soft) throw new Error('missing multi-view clips (test/media/make_cases_media.js)');
    // A B D E G H: GPU; C F I: built-in, so every row mixes both decoders and frame rates.
    const nine = Array.from({ length: 9 }, (_, i) => (i % 3 === 2 ? soft : gpu));
    const allShown = (r) => r && list(r.frames).length === Number(r.n) && !list(r.frames).includes('-');
    await activate(vs, h, gpu);

    let ok = t('large/nine-open');
    let from = vs.mark();
    vs.send({ compareFiles: nine });
    await vs.waitLog(opened(9), { from, timeout: 45000, what: 'compare opened with 9' });
    let r = await until(allShown, 60000);
    ok(allShown(r), `9 tiles: not every tile shows a frame (${r && r.frames})`);
    ok(r.n === '9' && r.grid === '3x3' && r.cells === '9' && r.add === 'false' && r.max === '16', `n=${r.n} grid=${r.grid} cells=${r.cells} add=${r.add} max=${r.max}`);
    // One compositor and one shared renderer, not a WebGL context per tile (Chromium keeps 16 per page).
    ok(r.contexts === '2', `WebGL contexts: ${r.contexts}`);
    const [cw, ch] = r.canvas.split('x').map(Number);
    const [sw, sh] = r.stage.split('x').map(Number);
    ok(Math.abs(cw - sw) <= 1 && Math.abs(ch - sh) <= 1, `canvas ${r.canvas}, stage ${r.stage}`);
    // Each tile's picture is at most a ninth of a 4K picture.
    ok(nums(r.widths).every((w, i) => w > 0 && w * nums(r.heights)[i] <= 3840 * 2160 / 9), `tile pictures ${r.widths} x ${r.heights}`);

    ok = t('large/lockstep-offsets');
    const offs = nine.map(() => ({ unit: 'frames', v: 0 }));
    act({ action: 'seek', t: 1 });
    r = await until((x) => x.synced === 'true' && list(x.playing).every((p) => p === '0'), 20000);
    checkFrames(ok, r, offs, 'paused seek');
    r = await stepAndWait(1);
    checkFrames(ok, r, offs, 'step +1');
    offs[1] = { unit: 'frames', v: 3 };
    offs[2] = { unit: 'ms', v: 200 };
    offs[7] = { unit: 'frames', v: -2 };
    for (const i of [1, 2, 7]) act({ action: 'offset', tile: i, v: offs[i].v, unit: offs[i].unit });
    r = await stepAndWait(1);
    checkFrames(ok, r, offs, 'step +1 with offsets');
    r = await stepAndWait(-1);
    checkFrames(ok, r, offs, 'step -1 with offsets');

    ok = t('large/clock');
    act({ action: 'clock', tile: 6 });
    r = await until((x) => x.clock === '6' && x.synced === 'true', 15000);
    ok(r.clock === '6' && r.seekMax === '575', `clock=${r.clock} seekMax=${r.seekMax} (G: 576 frames)`);
    r = await stepAndWait(1);
    checkFrames(ok, r, offs, 'step with clock G');

    ok = t('large/play');
    act({ action: 'seek', t: 0.2 });
    r = await until((x) => x.synced === 'true', 20000);
    const s0 = nums(r.shown);
    act({ action: 'play' });
    for (const w0 = Date.now(); Date.now() - w0 < 20000;) {
      await h.sleep(300);
      r = await report(20);
      if (nums(r.shown).every((n, i) => n - s0[i] >= 5)) break;
    }
    // The 3 s built-in clips end before the clock: only those still in range must be playing.
    ok(nums(r.shown).every((n, i) => n - s0[i] >= 5), `every tile draws while playing: ${s0} -> ${r.shown}`);
    ok(list(r.playing)[6] === '1', `the clock plays: playing=${r.playing}`);
    checkPlaying(ok, r, offs, 'nine playing');
    act({ action: 'pause' });
    r = await until((x) => x.synced === 'true' && list(x.playing).every((p) => p === '0'), 20000);
    checkFrames(ok, r, offs, 'paused after playing');

    ok = t('large/remove-add');
    from = vs.mark();
    act({ action: 'remove', tile: 4 });
    await vs.waitLog(opened(8), { from, timeout: 45000, what: 'compare reopened with 8' });
    r = await until((x) => x.n === '8' && allShown(x) && x.synced === 'true', 45000);
    ok(r.n === '8' && r.grid === '3x3' && r.add === 'true' && r.cells === '8', `8 tiles: grid=${r.grid} add=${r.add} cells=${r.cells}`);
    const eight = (await ui(1)).cells;
    ok(eight.length === 9 && eight[8].tile === 'add' && eight[8].rect[0] === eight[2].rect[0]
      && eight[8].rect[1] === eight[6].rect[1], 'Add video belongs in the last slot of the 3x3 grid');
    ok(r.clock === '5' && r.offsets === '0f,3f,200ms,0f,0f,0f,-2f,0f', `clock and offsets move with their videos: clock=${r.clock} offsets=${r.offsets}`);
    from = vs.mark();
    vs.send({ compareAdd: Array(10).fill(gpu) });
    await vs.waitLog(opened(16), { from, timeout: 45000, what: 'compare reopened with 16' });
    r = await until((x) => x.n === '16' && allShown(x) && x.synced === 'true', 60000);
    ok(r.n === '16' && r.grid === '4x4' && r.add === 'false' && r.contexts === '2', `16 tiles: grid=${r.grid} add=${r.add} contexts=${r.contexts}`);
    const offs16 = list(r.offsets).map((o) => (o.endsWith('ms') ? { unit: 'ms', v: Number(o.slice(0, -2)) } : { unit: 'frames', v: Number(o.slice(0, -1)) }));
    // (The test hook adds files from the host, without the page saving its position first.)
    act({ action: 'seek', t: 1 });
    r = await until((x) => x.synced === 'true', 20000);
    checkFrames(ok, r, offs16, '16 tiles: paused seek');
    r = await stepAndWait(1);
    checkFrames(ok, r, offs16, '16 tiles: step +1');

    ok = t('large/compact-overlays');
    act({ action: 'stageSize', w: 400, h: 240 });
    act({ action: 'syncMode', on: true });
    const compact = await ui(2);
    ok(compact.stage[2] === 400 && compact.stage[3] === 240, `compact stage: ${compact.stage}`);
    for (const cell of compact.cells) {
      const [x, y, w, h] = cell.rect;
      const inside = ([left, top, width, height]) => width > 0 && height > 0
        && left >= x && top >= y && left + width <= x + w && top + height <= y + h;
      const [pill] = cell.pillRects, [nudge] = cell.nudgeRects;
      ok(pill && nudge && inside(pill) && inside(nudge),
        `tile ${cell.tile}: pill ${pill} and sync nudge ${nudge} must fit inside ${cell.rect}`);
    }

    ok = t('large/close');
    from = vs.mark();
    await h.closeClip(vs);
    await vs.waitLog(/\[[^\]]+\] (?:session )?closed/, { from, timeout: 15000, what: 'compare closed' });
    ok(!vs.lines.slice(from).some((l) => /\[compare [^\]]*\] (error|webview: error)/.test(l)), 'errors while closing');
    return out;
  },
}, {
  // 9 and 16 native ffmpeg tiles (1080p HEVC) in a 1920x1080 device-pixel stage: frames at the cell size, WebSockets
  // on one frame-server port (Chromium opens 6 HTTP streams per origin), the shared transfer budget, offsets with
  // the last tile as the clock, playing in step, a seek through a resize. The frame rate is recorded, not judged.
  name: 'multiview-large-native',
  ffmpeg: true,
  settings: { 'videoPreviewEnhanced.decoder': 'ffmpeg', 'videoPreviewEnhanced.compare.maxVideos': 16 },
  async run(vs, h) {
    const { report, act, until, checkFrames, checkPlaying } = helpers(vs, h);
    const file = make('multiview_hevc.mp4');
    if (!file) throw new Error('missing multiview_hevc.mp4 (test/media/make_cases_media.js)');
    await activate(vs, h, path.join(h.MEDIA, CLIPS[0]));
    const out = [];
    for (const n of [9, 16]) {
      const problems = [];
      const ok = (cond, msg) => { if (!cond) problems.push(msg); };
      const from = vs.mark();
      vs.send({ compareFiles: Array(n).fill(file) });
      await vs.waitLog(opened(n), { from, timeout: 60000, what: `compare opened with ${n}` });
      act({ action: 'stageSize', w: 1920, h: 1080, physical: true });
      const side = Math.sqrt(n);
      const height = 1080 / side;
      let r = await until((x) => x.synced === 'true' && list(x.frames).length === n && !list(x.frames).includes('-')
        && nums(x.heights).every((v) => v === height), 60000);
      ok(r.grid === `${side}x${side}` && r.contexts === '2', `grid=${r.grid} contexts=${r.contexts}`);
      ok(nums(r.heights).length === n && nums(r.heights).every((v) => v === height), `native heights at ${r.stage}: ${r.heights}, want ${height}`);
      ok(list(r.transport).every((v) => v === 'stream'), `transport=${r.transport}`);
      const ports = vs.lines.slice(from).map((l) => /tile [A-P]: native transport: ws \(127\.0\.0\.1:(\d+)/.exec(l)?.[1]).filter(Boolean);
      ok(ports.length === n && new Set(ports).size === 1, `expected ${n} WebSockets on one port, got ${ports.join(',') || 'none'}`);
      const mbps = nums(r.heights).reduce((sum, v, i) => sum + 1.5 * v * nums(r.widths)[i] * nums(r.fps)[i], 0) / 1e6;

      const offs = Array.from({ length: n }, (_, i) => ({ unit: i % 2 ? 'frames' : 'ms', v: i % 2 ? i % 7 : 25 * (i % 7) }));
      act({ action: 'clock', tile: n - 1 });
      offs.forEach((o, tile) => act({ action: 'offset', tile, v: o.v, unit: o.unit }));
      act({ action: 'seek', t: 1 });
      r = await until((x) => x.synced === 'true' && Number(x.clock) === n - 1 && nums(x.frames)[n - 1] === 25, 30000);
      ok(Number(r.clock) === n - 1 && nums(r.frames)[n - 1] === 25, `seek: clock=${r.clock} frames=${r.frames}`);
      checkFrames(ok, r, offs, `${n} native: seek`);

      act({ action: 'play' });
      await h.sleep(1500);
      const before = await report(20);
      await h.sleep(5000);
      const after = await report(20);
      const secs = (Number(after.now) - Number(before.now)) / 1000;
      const fps = nums(after.shown).map((v, i) => Math.round((v - nums(before.shown)[i]) / secs * 10) / 10);
      ok(list(after.playing).every((v) => v === '1') && fps.every((v) => v > 1), `${n} native play: playing=${after.playing} fps=${fps}`);
      checkPlaying(ok, after, offs, `${n} native playing`);
      act({ action: 'pause' });

      if (n === 16) {
        // A resize (new ffmpeg sizes) that lands while a seek is in flight must not send the tiles back.
        act({ action: 'stageSize', w: 1280, h: 720, physical: true });
        act({ action: 'seek', t: 2 });
        r = await until((x) => x.synced === 'true' && nums(x.frames)[n - 1] === 49 && nums(x.heights).every((v) => v === 180), 30000);
        ok(nums(r.heights).every((v) => v === 180) && nums(r.frames)[n - 1] === 49, `seek through resize: heights=${r.heights} frames=${r.frames}`);
        checkFrames(ok, r, offs, '16 native: seek through resize');
      }
      const closing = vs.mark();
      await h.closeClip(vs);
      await vs.waitLog(/\[[^\]]+\] (?:session )?closed/, { from: closing, timeout: 15000, what: 'compare closed' });
      out.push({ name: `large-native/${n}`, ok: !problems.length, problems, info: { fps, mbps: Math.round(mbps * 10) / 10, height } });
    }
    return out;
  },
}, {
  name: 'multiview-reorder',
  settings: { 'videoPreviewEnhanced.autoplay': false },
  async run(vs, h) {
    const { act, until } = helpers(vs, h);
    const results = require('../lib').recorder();
    const files = CLIPS.map((clip) => path.join(h.MEDIA, clip));
    let id = 0;
    const ui = async () => {
      const from = vs.mark(), next = ++id;
      act({ action: 'ui', id: next });
      const line = await vs.waitLog(new RegExp(`compare ui \\{"id":${next},`), { from, timeout: 10000 });
      return JSON.parse(line.slice(line.indexOf('compare ui ') + 'compare ui '.length));
    };
    const order = (u) => u.cells.map((c) => c.tile).join(',');
    const click = (sel) => act({ action: 'click', sel });
    const pointer = (ev, [x, y, w, height]) => act({ action: 'dom', ev, x: x + w / 2, y: y + height / 2 });
    await activate(vs, h, files[0]);
    try {
      let from = vs.mark();
      vs.send({ compareFiles: files.slice(0, 3) });
      await vs.waitLog(opened(3), { from, timeout: 30000 });
      await until((x) => list(x.frames).length === 3 && !list(x.frames).includes('-'), 30000);
      act({ action: 'offset', tile: 1, v: 3, unit: 'frames' });
      act({ action: 'clock', tile: 2 });
      act({ action: 'sound', tile: 1 });
      act({ action: 'seek', t: 0.5 });
      let u = await ui();
      await results.run('reorder/arrows', (ok) => {
        ok(order(u) === '0,1,2,add', `initial order: ${order(u)}`);
        ok(u.cells[0].moves[0].disabled && u.cells[2].moves[1].disabled, 'the end arrows are disabled');
      });
      const earlier = '[data-act="move"][data-i="2"][data-d="-1"]';
      act({ action: 'a11y', focus: earlier, click: earlier });
      u = await ui();
      await results.run('reorder/arrow-result', (ok) => {
        ok(order(u) === '0,2,1,add', `after the arrow: ${order(u)}`);
        const arrow = u.cells[1].moves.find((b) => b.focused);
        ok(arrow?.label === `Move ${CLIPS[2]} earlier`, `focus did not follow the video: ${JSON.stringify(arrow)}`);
      });
      // Direct drag (always-on, no Reorder mode toggle needed).
      const grid = u.cells;
      pointer('pointerdown', grid[1].rect);
      pointer('pointermove', grid[0].rect);
      u = await ui();
      await results.run('reorder/drag-preview', (ok) => {
        ok(order(u) === '2,0,1,add', `preview order: ${order(u)}`);
      });
      pointer('pointerup', grid[0].rect);
      act({ action: 'panel', view: 'cmp' });
      u = await ui();
      await results.run('reorder/commit', (ok) => {
        ok(order(u) === '2,0,1,add', `committed order: ${order(u)}`);
        const rows = (u.panel?.rows || []).map((r) => r.label).filter((label) => /^[A-C]:/.test(label));
        ok(rows[0] === `A: ${CLIPS[2]}, offset In step, sets the clock` && rows[1]?.startsWith(`B: ${CLIPS[0]}`),
          `clock or panel order changed: ${rows}`);
        ok(rows[2] === `C: ${CLIPS[1]}, offset +3 frames, sound on`, `sound or offset changed: ${rows}`);
      });
      act({ action: 'panel' });
      pointer('pointerdown', grid[0].rect);
      pointer('pointermove', grid[2].rect);
      act({ action: 'key', key: 'Escape' });
      u = await ui();
      await results.run('reorder/esc-cancels-drag', (ok) => {
        ok(order(u) === '2,0,1,add', `Esc during drag: ${order(u)}`);
      });
      from = vs.mark();
      vs.send({ compareAdd: [files[3]] });
      await vs.waitLog(opened(4), { from, timeout: 30000 });
      u = await ui();
      const addedOrder = order(u);
      from = vs.mark();
      // Tiles are numbered as shown (C, A, B, D): remove A, the second. The report's per-tile values follow the shown
      // order; a cell's `tile` is its video's own number (A 0, B 1, C 2, D 3), which does not change.
      act({ action: 'remove', tile: 1 });
      await vs.waitLog(opened(3), { from, timeout: 30000 });
      const r = await until((x) => x.synced === 'true');
      u = await ui();
      await results.run('reorder/restore', (ok) => {
        ok(addedOrder === '2,0,1,3', `added video should go last: ${addedOrder}`);
        ok(order(u) === '2,1,3,add', `removal should keep the other videos' order: ${order(u)}`);
        ok(r.synced === 'true' && r.clock === '0' && r.sound === '1' && r.offsets === '0f,3f,0f',
          `kept sync, clock (C), sound (B) and B's offset: ${JSON.stringify(r)}`);
      });
      // A letterboxed grid (5 tiles, 3x2): each tile's arrows sit on its own picture, not in the black bars of the cell.
      // Two videos not shown yet (Compare declines a video it shows already): the removed one and a fifth.
      from = vs.mark();
      vs.send({ compareAdd: [files[0], path.join(h.MEDIA, 'av1_8_1080p.mp4')] });
      await vs.waitLog(opened(5), { from, timeout: 30000 });
      act({ action: 'stageSize', w: 1000, h: 700 });
      await until((x) => x.n === '5' && x.grid === '3x2', 20000);
      u = await ui();
      await results.run('reorder/arrows-on-picture', (ok) => {
        const tiles = u.cells.filter((c) => c.tile !== 'add');
        ok(tiles.length === 5 && u.cells.length === 6, `5 tiles and the Add cell: ${order(u)}`);
        for (const cell of tiles) {
          const pic = cell.picRect;
          const [cx, cy, cw, ch] = cell.rect;
          ok(pic && pic[3] < ch - 20, `tile ${cell.tile} is letterboxed (picture ${pic}, cell ${cell.rect})`);
          if (!pic || cell.moveRects.length !== 2) { ok(false, `tile ${cell.tile}: moves ${JSON.stringify(cell.moveRects)}`); continue; }
          const [px, py, pw, ph] = pic;
          // The keyboard reorder arrows sit inside the picture's bottom-left corner.
          const left = Math.min(...cell.moveRects.map((r) => r[0])), top = Math.min(...cell.moveRects.map((r) => r[1]));
          const right = Math.max(...cell.moveRects.map((r) => r[0] + r[2])), bottom = Math.max(...cell.moveRects.map((r) => r[1] + r[3]));
          ok(left >= px - 1 && top >= py - 1 && right <= px + pw + 1 && bottom <= py + ph + 1,
            `tile ${cell.tile}: arrows ${[left, top, right, bottom]} leave their picture ${pic}`);
          ok(py + ph - bottom <= 10 && left - px <= 10,
            `tile ${cell.tile}: arrows ${[left, top, right, bottom]} are far from their picture's bottom-left corner ${pic}`);
          ok(cx <= px + 1 && cy <= py + 1 && cw >= pw - 1, `tile ${cell.tile}: picture ${pic} sits inside its cell ${cell.rect}`);
        }
      });
    } finally {
      await h.closeClip(vs);
    }
    return results.out;
  },
}];

