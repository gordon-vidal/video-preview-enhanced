#!/usr/bin/env node
'use strict';
// Records a short, compact (~3.5 s, <1 MB) GIF of hovering along the seek bar so the live
// thumbnail preview card is big and clear at README / Marketplace width.
//
//   node tools/hero-gif/record-seek.js [--out media/marketing] [--fps 15]
const fs = require('fs');
const os = require('os');
const path = require('path');
const { HiddenCode, findCode, run, ROOT, MEDIA, sleep } = require('../../test/vscode/hidden');
const { Driver, ZOOM } = require('./record');
const { compose } = require('./compose');

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };

const OUT = path.resolve(ROOT, opt('--out', path.join('media', 'marketing')));
const FPS = Number(opt('--fps', 15));
const WIN = { w: 860, h: 540 };
const HIDDEN = path.join(ROOT, 'test', 'vscode', 'hidden_launch.py');

function log(...a) { console.log(`[seek-gif ${new Date().toISOString().slice(11, 19)}]`, ...a); }

async function main() {
  const tmp = path.join(os.tmpdir(), 'vpe-seek');
  fs.mkdirSync(tmp, { recursive: true });
  const src = path.join(MEDIA, 'h264_aac_anim_1080p.mp4');
  const code = findCode();
  const vs = new HiddenCode({
    code,
    devPath: true,
    tag: 'vpeseek',
    settings: {
      'workbench.colorTheme': 'Default Dark Modern',
      'window.zoomLevel': Number(ZOOM.toFixed(4)),
      'workbench.activityBar.location': 'hidden',
      'workbench.secondarySideBar.defaultVisibility': 'hidden',
      'workbench.tips.enabled': false,
      'workbench.welcomePage.walkthroughs.openOnInstall': false,
      'extensions.ignoreRecommendations': true,
      'update.showReleaseNotes': false,
      'git.enabled': false,
      'breadcrumbs.enabled': false,
      'window.commandCenter': false,
    },
  });
  const clip = path.join(vs.work, 'big_buck_bunny_1080p.mp4');
  fs.copyFileSync(src, clip);
  let drv;
  try {
    log(`starting compact hidden VS Code (${WIN.w}x${WIN.h})`);
    const from = vs.mark();
    await vs.start([clip]);
    const cmd = path.join(tmp, 'driver.cmd');
    const frames = path.join(tmp, 'frames');
    fs.rmSync(frames, { recursive: true, force: true });
    for (const f of [cmd, `${cmd}.out`]) fs.writeFileSync(f, '');
    await run('python', ['-I', HIDDEN, vs.desktop, vs.envMain, 'pythonw.exe', '-I', path.join(__dirname, 'driver.py'), cmd, frames]);
    drv = new Driver(cmd);
    for (let i = 0; i < 60; i++) {
      try {
        const r = await drv.send({ op: 'size', w: WIN.w, h: WIN.h }, 3000);
        if (r.title) break;
      } catch { /* starting */ }
      await sleep(250);
    }
    await vs.waitLog(/\[big_buck_bunny_1080p\.mp4\] webview: first frame shown/, { from, timeout: 30000, what: 'player' });
    // Hide Explorer sidebar (Ctrl+B) so the player fills the compact window and the thumbnail card is big.
    await drv.send({ op: 'key', vk: 0x42, mods: ['ctrl'] });
    await sleep(400);
    vs.send({ name: 'big_buck_bunny_1080p.mp4', action: 'pause' });
    vs.send({ name: 'big_buck_bunny_1080p.mp4', action: 'seek', t: 0.1 });
    await sleep(600);

    // Seek bar sits ~93 px above the bottom of the 540 px window (y = 447).
    const yBar = WIN.h - 93;
    const cur = { x: 140, y: yBar };
    const ease = (k) => (k < 0.5 ? 2 * k * k : 1 - ((-2 * k + 2) ** 2) / 2);
    const glide = async (to, ms) => {
      const f = { ...cur }, t0 = Date.now();
      for (;;) {
        const k = Math.min(1, (Date.now() - t0) / ms), e = ease(k);
        cur.x = Math.round(f.x + (to.x - f.x) * e);
        cur.y = Math.round(f.y + (to.y - f.y) * e);
        await drv.send({ op: 'move', ...cur });
        if (k >= 1) break;
        await sleep(14);
      }
    };

    // Prime the thumbnail decoder before recording starts so the card is already visible on frame 1.
    await drv.send({ op: 'move', ...cur });
    await sleep(700);
    await drv.send({ op: 'rec', on: true });
    await sleep(250);
    await drv.send({ op: 'mark', still: '1-left' });
    await glide({ x: 740, y: yBar }, 2200);
    await sleep(300);
    await drv.send({ op: 'mark', still: '2-right' });
    await glide({ x: 430, y: yBar }, 1100);
    await sleep(350);
    await drv.send({ op: 'mark', still: '3-mid' });
    await drv.send({ op: 'rec', on: false });
    await sleep(250);
    fs.writeFileSync(path.join(tmp, 'events.json'), JSON.stringify(drv.events));
    await drv.send({ op: 'quit' }, 3000).catch(() => {});
    await vs.stop();
    drv = null;

    await compose({ tmp, frames, out: OUT, width: WIN.w, fps: FPS, name: 'seek-preview' });
  } finally {
    if (drv) try { await drv.send({ op: 'quit' }, 3000); } catch { /* gone */ }
    await vs.stop().catch(() => {});
  }
}

if (require.main === module) main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
