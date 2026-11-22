#!/usr/bin/env node
'use strict';
// Records the Compare showcase GIF/MP4 (media/marketing/compare-showcase.gif and .mp4) and,
// optionally, the README stills (seek-preview.png, pro-tools.png) in a single local hidden-desktop
// VS Code session (no WSL / Remote-SSH / VSIX build needed — runs in ~20 s).
//
//   node tools/hero-gif/record-compare.js [--out media/marketing] [--width 1280] [--fps 15]
//        [--stills] [--probe] [--keep]
//
// Iterating on captions, speed, or encoding only:
//   node tools/hero-gif/compose.js --tmp <tmpdir>/vpe-compare --name compare-showcase --out media/marketing
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { HiddenCode, findCode, pathWithoutFfmpeg, run, ROOT, MEDIA, sleep } = require('../../test/vscode/hidden');
const { Driver, WIN, ZOOM } = require('./record');
const { compose } = require('./compose');

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const flag = (n) => argv.includes(n);

const OUT = path.resolve(ROOT, opt('--out', path.join('media', 'marketing')));
const WIDTH = Number(opt('--width', 1280));
const FPS = Number(opt('--fps', 15));
const HIDDEN = path.join(ROOT, 'test', 'vscode', 'hidden_launch.py');

function log(...a) { console.log(`[compare-gif ${new Date().toISOString().slice(11, 19)}]`, ...a); }

/** Prepare 4 openly licensed 1080p30 H.264 clips (from BBB, CC BY 3.0) in a neutral folder. */
function prepareClips(cacheDir, workDir) {
  const src = path.join(MEDIA, 'h264_aac_anim_1080p.mp4');
  if (!fs.existsSync(src) || fs.statSync(src).size < 10000) {
    throw new Error(`${src} missing or LFS pointer: run git lfs pull`);
  }
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.mkdirSync(workDir, { recursive: true });
  const specs = [
    ['01_source.mp4', null],
    ['02_encode_500k.mp4', ['-c:v', 'libx264', '-b:v', '500k', '-maxrate', '600k', '-bufsize', '600k', '-preset', 'veryfast', '-g', '30', '-pix_fmt', 'yuv420p', '-an']],
    ['03_warm_grade.mp4', ['-vf', 'eq=saturation=1.28:contrast=1.06,colorbalance=rs=0.10:bs=-0.08', '-c:v', 'libx264', '-crf', '18', '-preset', 'veryfast', '-g', '30', '-pix_fmt', 'yuv420p', '-an']],
    // 3 frames late at 30 fps: nudging +3f in Compare snaps it into exact sync with 01-03.
    ['04_take_b_late.mp4', ['-vf', 'tpad=start=3:start_mode=clone,trim=end_frame=90,setpts=PTS-STARTPTS', '-c:v', 'libx264', '-crf', '18', '-preset', 'veryfast', '-g', '30', '-pix_fmt', 'yuv420p', '-an']],
  ];
  for (const [name, args] of specs) {
    const cached = path.join(cacheDir, name);
    if (!fs.existsSync(cached)) {
      log(`generating ${name}`);
      if (!args) fs.copyFileSync(src, cached);
      else execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', src, ...args, cached], { windowsHide: true });
    }
    fs.copyFileSync(cached, path.join(workDir, name));
  }
}

function saveShotPng(rawFile, pngFile) {
  const b = fs.readFileSync(rawFile);
  const w = b.readInt32LE(0), h = b.readInt32LE(4);
  const tmpRaw = `${rawFile}.px`;
  fs.writeFileSync(tmpRaw, b.subarray(8));
  fs.mkdirSync(path.dirname(pngFile), { recursive: true });
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'bgra', '-s', `${w}x${h}`, '-i', tmpRaw, '-frames:v', '1', pngFile], { windowsHide: true });
  fs.rmSync(tmpRaw, { force: true });
}

// Client pixels of the 1280x800 window at effective 100 % zoom (sidebar ~240 px, Explorer rows 22 px apart).
const AT = {
  start: { x: 760, y: 420 },
  row1: { x: 140, y: 116 }, // 01_source.mp4
  row4: { x: 140, y: 182 }, // 04_take_b_late.mp4
  menuCompare: { dx: 90, dy: 174 }, // "Compare Videos" in Explorer context menu (relative to right-click on row4)
  // Compare 2x2 grid (editor area x ~ 360..1268, y ~ 70..700):
  tileA: { x: 580, y: 240 },
  tileD: { x: 1040, y: 540 },
  tileDPlus: { x: 1244, y: 406 }, // › button on bottom-right tile D (measured from 5-synced.png)
  play: { x: 426, y: 735 },
  time: { x: 705, y: 735 }, // click twice: time -> timecode -> #frame
};

async function startLocalSession(tmp) {
  const code = findCode();
  const vs = new HiddenCode({
    code,
    devPath: true,
    tag: 'vpecmp',
    keep: flag('--keep'),
    settings: {
      'workbench.colorTheme': 'Default Dark Modern',
      'window.zoomLevel': Number(ZOOM.toFixed(4)),
      'workbench.secondarySideBar.defaultVisibility': 'hidden',
      'workbench.tips.enabled': false,
      'workbench.welcomePage.walkthroughs.openOnInstall': false,
      'extensions.ignoreRecommendations': true,
      'update.showReleaseNotes': false,
      'git.enabled': false,
      'explorer.compactFolders': false,
      'workbench.tree.indent': 12,
      'workbench.list.openMode': 'doubleClick',
      'breadcrumbs.enabled': false,
      'window.commandCenter': false,
    },
  });
  // Neutral folder name shown in Explorer header (no temp random suffix or username).
  const neutralWork = path.join(vs.dir, 'render-review');
  prepareClips(path.join(tmp, 'clips'), neutralWork);
  vs.work = neutralWork;
  log(`starting local hidden VS Code (${vs.desktop})`);
  await vs.start([]);
  const cmd = path.join(tmp, 'driver.cmd');
  const frames = path.join(tmp, 'frames');
  fs.rmSync(frames, { recursive: true, force: true });
  for (const f of [cmd, `${cmd}.out`]) fs.writeFileSync(f, '');
  await run('python', ['-I', HIDDEN, vs.desktop, vs.envMain, 'pythonw.exe', '-I', path.join(__dirname, 'driver.py'), cmd, frames]);
  const drv = new Driver(cmd);
  // Wait for VS Code window to appear and resize it to 1280x800.
  for (let i = 0; i < 60; i++) {
    try {
      const r = await drv.send({ op: 'size', w: WIN.w, h: WIN.h }, 3000);
      if (r.title) break;
    } catch { /* window still starting */ }
    await sleep(300);
  }
  await sleep(3500);
  return { vs, drv, frames, tmp };
}

async function runTake(s) {
  const { vs, drv, tmp } = s;
  const cur = { ...AT.start };
  const ease = (k) => (k < 0.5 ? 2 * k * k : 1 - ((-2 * k + 2) ** 2) / 2);
  const glide = async (to, ms = 420, held) => {
    const from = { ...cur }, t0 = Date.now();
    for (;;) {
      const k = Math.min(1, (Date.now() - t0) / ms), e = ease(k);
      cur.x = Math.round(from.x + (to.x - from.x) * e);
      cur.y = Math.round(from.y + (to.y - from.y) * e);
      await drv.send({ op: 'move', ...cur, ...(held ? { held } : {}) });
      if (k >= 1) break;
      await sleep(12);
    }
  };
  const click = async (p, extra = {}) => {
    if (p) await glide(p, extra.ms || 380);
    await drv.send({ op: 'down', ...cur, ...extra });
    await sleep(45);
    await drv.send({ op: 'up', ...cur, ...extra });
  };
  const cap = (caption) => drv.send({ op: 'mark', caption });
  const mark = (still) => drv.send({ op: 'mark', still });
  const cut = async (fn) => { await drv.send({ op: 'mark', cut: 'start' }); await fn(); await drv.send({ op: 'mark', cut: 'end' }); };
  const shot = async (name) => {
    const raw = path.join(tmp, `probe-${name}.bgra`);
    const png = path.join(tmp, `probe-${name}.png`);
    await drv.send({ op: 'shot', file: raw });
    saveShotPng(raw, png);
    fs.rmSync(raw, { force: true });
    log(`probe shot: ${png}`);
  };

  if (flag('--probe')) {
    await shot('01-explorer');
    await click(AT.row1, { ms: 200 });
    await sleep(150);
    await click(AT.row4, { ms: 200, mods: ['shift'] });
    await sleep(150);
    await click(null, { button: 'right' });
    await sleep(350);
    await shot('02-menu');
    const from = vs.mark();
    await click({ x: cur.x + AT.menuCompare.dx, y: cur.y + AT.menuCompare.dy }, { ms: 200 });
    for (const k of ['A', 'B', 'C', 'D']) {
      await vs.waitLog(new RegExp(`\\[compare [^\\]]*\\] webview: \\[${k}\\] first frame shown`), { from, timeout: 30000, what: `tile ${k}` });
    }
    await sleep(800);
    await glide(AT.tileD, 150);
    await sleep(300);
    await shot('03-compare-hoverD');
    return;
  }

  await drv.send({ op: 'move', ...cur });
  await sleep(400);
  await drv.send({ op: 'rec', on: true });
  await sleep(150);

  // Beat 1: Select 4 clips -> right-click -> Compare Videos
  await cap('Select videos → Compare');
  await click(AT.row1, { ms: 420 });
  await sleep(120);
  await click(AT.row4, { ms: 320, mods: ['shift'] });
  await sleep(140);
  await click(null, { button: 'right' });
  await sleep(450);
  await mark('1-menu');
  const from = vs.mark();
  await click({ x: cur.x + AT.menuCompare.dx, y: cur.y + AT.menuCompare.dy }, { ms: 320 });
  await cut(async () => {
    for (const k of ['A', 'B', 'C', 'D']) {
      await vs.waitLog(new RegExp(`\\[compare [^\\]]*\\] webview: \\[${k}\\] first frame shown`), { from, timeout: 30000, what: `tile ${k}` });
    }
    await sleep(400);
  });

  // Beat 2: 2x2 grid playing in sync (switch time readout to #frame so stepping is unmistakable)
  await cap('Up to 16 videos, synced');
  await click(AT.time, { ms: 240 });
  await sleep(90);
  await click(null);
  await click(AT.play, { ms: 240 }); // play
  await glide(AT.tileA, 260);
  await sleep(1400);
  await mark('2-playing');

  // Beat 3: Pause, scroll wheel to step frame by frame in sync
  await cap('Step frame by frame');
  await click(AT.play, { ms: 220 }); // pause
  await glide(AT.tileA, 220);
  await sleep(180);
  for (let i = 0; i < 6; i++) {
    await drv.send({ op: 'wheel', ...cur, delta: -120 }); // forward 1 frame
    await sleep(220);
  }
  await mark('3-stepped');
  for (let i = 0; i < 2; i++) {
    await drv.send({ op: 'wheel', ...cur, delta: 120 }); // back 1 frame
    await sleep(220);
  }

  // Beat 4: Ctrl+scroll to zoom in on all tiles, then drag to pan together
  await cap('Zoom & pan all together');
  for (let i = 0; i < 5; i++) {
    await drv.send({ op: 'wheel', ...cur, delta: 120, mods: ['ctrl'] });
    await sleep(120);
  }
  await sleep(220);
  await drv.send({ op: 'down', ...cur });
  await glide({ x: cur.x - 130, y: cur.y - 60 }, 480, 'left');
  await sleep(120);
  await glide({ x: cur.x + 180, y: cur.y + 45 }, 520, 'left');
  await drv.send({ op: 'up', ...cur });
  await sleep(320);
  await mark('4-zoomed');

  // Beat 5: Reset zoom (0), hover late tile D and nudge offset +3f until frame numbers & picture match
  await cap('Sync one frame at a time');
  await drv.send({ op: 'key', vk: 0x30 }); // '0' resets zoom/fit
  await sleep(250);
  await glide(AT.tileD, 340);
  await sleep(220);
  await glide(AT.tileDPlus, 240);
  for (let i = 0; i < 3; i++) {
    await click(null);
    await sleep(420);
  }
  await sleep(650);
  await mark('5-synced');
  await sleep(250);

  await drv.send({ op: 'rec', on: false });
  await sleep(300);
  fs.writeFileSync(path.join(tmp, 'events.json'), JSON.stringify(drv.events));

  if (!flag('--no-stills')) {
    log('capturing README stills (seek-preview.png, pro-tools.png)');
    vs.send({ command: 'workbench.action.closeAllEditors' });
    await sleep(600);
    const pFrom = vs.mark();
    await glide(AT.row1, 150);
    await drv.send({ op: 'dbl', ...cur });
    await vs.waitLog(/\[01_source\.mp4\] webview: first frame shown/, { from: pFrom, timeout: 20000, what: 'single player' });
    await sleep(500);
    vs.send({ name: '01_source.mp4', action: 'pause' });
    vs.send({ name: '01_source.mp4', action: 'seek', t: 1.2 });
    await sleep(500);
    // Hover seek bar around 60% to show live thumbnail preview card.
    await glide({ x: 840, y: 707 }, 200);
    await sleep(900);
    const rawSeek = path.join(tmp, 'seek-preview.bgra');
    await drv.send({ op: 'shot', file: rawSeek });
    saveShotPng(rawSeek, path.join(OUT, 'seek-preview.png'));
    fs.rmSync(rawSeek, { force: true });
    log(`wrote ${path.join(OUT, 'seek-preview.png')}`);

    // Move off seek bar, open RGB Parade scopes (W twice) + Codec X-ray (Shift+X).
    await glide({ x: 760, y: 360 }, 150);
    await sleep(250);
    vs.send({ name: '01_source.mp4', action: 'key', key: 'w' });
    await sleep(300);
    vs.send({ name: '01_source.mp4', action: 'key', key: 'w' });
    await sleep(300);
    vs.send({ name: '01_source.mp4', action: 'key', key: 'X', shift: true });
    await sleep(1200);
    const rawPro = path.join(tmp, 'pro-tools.bgra');
    await drv.send({ op: 'shot', file: rawPro });
    saveShotPng(rawPro, path.join(OUT, 'pro-tools.png'));
    fs.rmSync(rawPro, { force: true });
    log(`wrote ${path.join(OUT, 'pro-tools.png')}`);
  }
}

async function main() {
  const tmp = path.join(os.tmpdir(), 'vpe-compare');
  fs.mkdirSync(tmp, { recursive: true });
  let s;
  try {
    s = await startLocalSession(tmp);
    await runTake(s);
    await s.drv.send({ op: 'quit' }, 3000).catch(() => {});
    await s.vs.stop();
    s = null;
    if (!flag('--probe')) {
      await compose({ tmp, frames: path.join(tmp, 'frames'), out: OUT, width: WIDTH, fps: FPS, name: 'compare-showcase' });
    }
  } finally {
    if (s) {
      try { await s.drv.send({ op: 'quit' }, 3000); } catch { /* gone */ }
      await s.vs.stop();
    }
  }
}

if (require.main === module) main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
