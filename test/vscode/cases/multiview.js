'use strict';
// Multi-view (docs/PRODUCT.md "Multi-view (compare)") in a real VS Code: 3 then 4 videos in a 2x2 grid,
// all playing; offsets in frames and in ms after paused lockstep steps; the clock and sound choices;
// 2 videos side by side / split. A second case runs every tile on native ffmpeg and checks
// that frames come at the tile's size. The panel, menus and views are in compare_ui.js. Everything is read from compare's `compare report` line
// (media/compare.js) through the VPE_LOG test hook.
const path = require('path');

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
    const frames = nums(r.frames);
    const off = (j) => (offs[j].unit === 'ms' ? offs[j].v / 1000 : offs[j].v / fps[j]);
    const x = ((frames[c] - 1) / fps[c] - off(c) + off(i)) * fps[i] + 0.5;
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
      ok(frames[i] === e || frames[i] === alt, `${what}: tile ${'ABCD'[i]} shows #${frames[i]}, expected #${e} (clock ${'ABCD'[r.clock]} #${frames[r.clock]}, fps ${r.fps}, offsets ${r.offsets})`);
    }
  };
  const stepAndWait = async (d) => {
    const before = await report();
    act({ action: 'step', d });
    const c = Number(before.clock);
    const want = nums(before.frames)[c] + d;
    return until((r) => r.synced === 'true' && nums(r.frames)[Number(r.clock)] === want, 15000);
  };
  return { report, act, until, expect, checkFrames, stepAndWait };
}

/** The extension activates when a video opens; the test hook (compareFiles) needs it. */
async function activate(vs, h, file) {
  const from = await h.openClip(vs, file);
  const tag = path.basename(file).replace(/\./g, '\\.');
  await vs.waitLog(new RegExp(`\\[${tag}\\] webview: first frame shown`), { from, timeout: 45000, what: 'first frame (activation)' });
  await h.closeClip(vs);
}

const opened = (n) => new RegExp(`\\[compare [^\\]]*\\] opened, .* ${n} tiles`);

module.exports = [{
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
    await vs.waitLog(/webview: begin: A \S+ soft, B \S+ soft; clock A/, { from, timeout: 30000 });
    await until((r) => r.synced === 'true');
    act({ action: 'play' });

    const loops = [];
    let prev = 0;
    const end = Date.now() + 25000;
    while (Date.now() < end) {
      const r = await report(20);
      const [clock, follower] = nums(r.frames);
      if (prev - clock > 45) loops.push([]);
      prev = clock;
      if (loops.length > 3) break;
      if (loops.length && clock >= 12 && clock <= 66) {
        loops[loops.length - 1].push({ clock, follower });
        if (loops.length === 3 && clock >= 54) break;
      }
    }
    const problems = [];
    if (loops.length < 3) problems.push(`expected three clock wraps, saw ${loops.length}`);
    if (!vs.lines.slice(from).some((l) => /webview: \[A\] loop: replaying \d+ cached frames/.test(l))) {
      problems.push('the clock did not replay cached frames');
    }
    // A seek may still be settling right at the wrap. Check sync twice during each new pass.
    loops.slice(0, 3).forEach((samples, i) => {
      const early = samples.find(({ clock }) => clock <= 39);
      const later = samples.find(({ clock }) => early && clock >= early.clock + 15);
      if (!early || !later) { problems.push(`wrap ${i + 1}: missing post-wrap samples`); return; }
      if (later.follower <= early.follower || [early, later].some(({ clock, follower }) => !(Math.abs(clock - follower) <= 4))) {
        problems.push(`wrap ${i + 1}: follower did not advance in sync (${early.clock}/${early.follower} then ${later.clock}/${later.follower})`);
      }
    });
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
    ok(r.n === '3' && r.mode === 'grid' && r.modes === 'grid', `3 tiles: n=${r.n} mode=${r.mode} modes=${r.modes}`);
    ok(r.add === 'true', 'the "Add video" fourth cell is not there');
    ok(r.cells === '3', `cells=${r.cells}`);
    from = vs.mark();
    vs.send({ compareAdd: [files[3]] });
    await vs.waitLog(opened(4), { from, timeout: 30000, what: 'compare reopened with 4' });
    let firstCanvas;
    r = await until((x) => {
      if (x.n !== '4') return false;
      // The grid has a size as soon as its first tile draws, even while the other tiles settle.
      if (!firstCanvas && Number(list(x.shown)[0]) > 0) firstCanvas = x.canvas;
      return allShown(x);
    }, 45000);

    // ---- 4 videos: 2x2, all play ----
    ok = t('grid/four-play');
    ok(allShown(r), `4 tiles: not every tile shows a frame (${r && r.frames})`);
    ok(r.n === '4' && r.mode === 'grid' && r.add === 'false' && r.cells === '4', `n=${r.n} mode=${r.mode} add=${r.add} cells=${r.cells}`);
    // One canvas covers the picture area at device pixels; each tile is fitted into its quarter.
    const [cw, ch] = r.canvas.split('x').map(Number);
    const [sw0, sh0] = r.stage.split('x').map(Number);
    ok(Math.abs(cw - sw0) <= 1 && Math.abs(ch - sh0) <= 1, `grid canvas ${r.canvas}: expected the stage's ${r.stage}`);
    ok(firstCanvas === r.canvas, `grid canvas changed from ${firstCanvas} to ${r.canvas} after the first tile drew`);
    act({ action: 'seek', t: 0 });
    await until((x) => x.synced === 'true', 15000);
    const s0 = nums((await report()).shown);
    act({ action: 'play' });
    await h.sleep(1300); // C and D are 2 s long: all four are inside their clips
    r = await report();
    const s1 = nums(r.shown);
    ok(list(r.playing).every((x) => x === '1'), `playing=${r.playing}, expected all 1`);
    for (let i = 0; i < 4; i++) ok(s1[i] - s0[i] >= 10, `tile ${'ABCD'[i]} drew ${s1[i] - s0[i]} frames in 1.3 s of play`);
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

    // ---- 2 videos: side by side, split; an ms offset on B ----
    ok = t('pair/views-and-offset');
    from = vs.mark();
    vs.send({ compareFiles: [files[0], files[2]] });
    await vs.waitLog(opened(2), { from, timeout: 30000, what: 'compare opened with 2' });
    r = await until(allShown, 45000);
    ok(r.n === '2' && r.modes === 'side,split', `2 tiles: n=${r.n} modes=${r.modes}`);
    for (const mode of ['split', 'side']) {
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
    const decided = vs.lines.slice(from).filter((l) => /\] tile [A-D]: (native ffmpeg|built-in)/.test(l));
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
    await h.sleep(1300);
    r = await report();
    const s1 = nums(r.shown);
    ok(list(r.playing).every((x) => x === '1'), `playing=${r.playing}`);
    for (let i = 0; i < 4; i++) ok(s1[i] - s0[i] >= 10, `tile ${'ABCD'[i]} drew ${s1[i] - s0[i]} frames in 1.3 s of play`);
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
    const r = await until((x) => x.synced === 'true' && x.native === '1,1,1,1', 60000);
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
}];
