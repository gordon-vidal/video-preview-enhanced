'use strict';
// File icons, pixel level: the Explorer row of an .mkv (icon from our `vpe-video` language, setting
// videoPreviewEnhanced.overrideFileIcons) must be pixel-identical to Seti's own .mp4 / .avi icon (a font glyph,
// `_video` in vs-seti-icon-theme.json). A hidden VS Code window with a workspace holding a.avi, b.mkv, c.mp4
// (empty files, never opened) is captured with PrintWindow; the three icons are found by colour, cropped and
// compared. Dark and light theme at the window's own scale, dark also at window zoom -1, 1 and 2 (other device pixel
// ratios); the glyph's size, position, ink mass and centre are compared, the pixel mean only at zoom 0.
// Crops (enlarged) go to VPE_ICON_OUT (default: the run's out dir) as PNGs.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const HERE = path.join(__dirname, '..');
const MEAN_TOLERANCE = 3;  // mean absolute difference per byte over a row cell at the display's own scale (ClearType fringes of the font vs grayscale SVG edges); measured 1.7-2.4
const OUT = process.env.VPE_ICON_OUT || path.join(os.tmpdir(), 'vpe-icons');

function capture(vs) {
  const raw = path.join(vs.dir, `w-${Date.now()}.raw`);
  const r = spawnSync('python', ['-I', path.join(HERE, 'hidden_launch.py'), '--wait', vs.desktop, vs.envMain, 'python.exe', '-I',
    path.join(HERE, 'capture_window.py'), raw], { encoding: 'utf8', windowsHide: true });
  if (!fs.existsSync(raw)) throw new Error(`capture failed: ${r.stdout} ${r.stderr}`);
  const buf = fs.readFileSync(raw);
  return { w: buf.readInt32LE(0), h: buf.readInt32LE(4), px: buf.subarray(8) };
}
const at = (img, x, y) => { const o = (y * img.w + x) * 4; return [img.px[o + 2], img.px[o + 1], img.px[o]]; };
const hex = (s) => [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16));
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** Clusters of icon-coloured pixels in the Explorer column (x < 70, below the title bar), top to bottom. */
function findIcons(img, colour) {
  const target = hex(colour), rows = new Map();
  for (let y = 30; y < Math.min(img.h, 700); y++) for (let x = 0; x < 70; x++) {
    if (dist(at(img, x, y), target) < 70) { const r = rows.get(y) || []; r.push(x); rows.set(y, r); }
  }
  const clusters = [];
  for (const y of [...rows.keys()].sort((a, b) => a - b)) {
    const xs = rows.get(y), c = clusters[clusters.length - 1];
    if (c && y - c.y1 <= 2) { c.y1 = y; c.x0 = Math.min(c.x0, ...xs); c.x1 = Math.max(c.x1, ...xs); }
    else clusters.push({ y0: y, y1: y, x0: Math.min(...xs), x1: Math.max(...xs) });
  }
  return clusters;
}

function crop(img, x, y, w, h) {
  const out = Buffer.alloc(w * h * 4);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const o = ((y + j) * img.w + x + i) * 4, d = (j * w + i) * 4;
    img.px.copy(out, d, o, o + 4);
  }
  return out;
}
function writePng(file, bgra, w, h, scale) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const raw = file + '.bgra';
  fs.writeFileSync(raw, bgra);
  spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'bgra', '-video_size', `${w}x${h}`, '-i', raw,
    '-vf', `scale=${w * scale}:${h * scale}:flags=neighbor`, file], { windowsHide: true });
  fs.rmSync(raw, { force: true });
}
function side(a, b, w, h) {  // a | b with a 2 px gap
  const out = Buffer.alloc((w * 2 + 2) * h * 4, 255);
  for (let j = 0; j < h; j++) {
    a.copy(out, j * (w * 2 + 2) * 4, j * w * 4, (j + 1) * w * 4);
    b.copy(out, (j * (w * 2 + 2) + w + 2) * 4, j * w * 4, (j + 1) * w * 4);
  }
  return out;
}

function variant(tag, theme, colour, zoom) {
  return {
    name: `file_icons_pixels_${tag}`,
    ffmpeg: true,
    settings: { 'workbench.colorTheme': theme, 'window.zoomLevel': zoom, 'workbench.iconTheme': 'vs-seti',
      'workbench.activityBar.location': 'hidden', 'workbench.statusBar.visible': false },
    async run(vs, h) {
      const p = [];
      // rows 0, 2, 4, 6, 8 are the video files (same sub-pixel phase at a fractional device scale); .txt rows between
      const files = ['a.mkv', 'b.txt', 'c.mp4', 'd.txt', 'e.avi', 'f.txt', 'g.flv', 'h.txt', 'i.m2ts'];
      for (const f of files) fs.writeFileSync(path.join(vs.work, f), '');
      let res = { name: 'icons-equal-seti-mp4' };
      try {
        // the extension (onStartupFinished) writes *.mkv -> vpe-video; wait for it, then for the Explorer to repaint
        const f = path.join(vs.user, 'User', 'settings.json');
        for (let i = 0; i < 40 && !/\*\.m2ts/.test(fs.readFileSync(f, 'utf8')); i++) await h.sleep(500);
        await h.sleep(5000);
        // The files were created after the window opened and the Explorer's file watcher does not always report them
        // (a hidden desktop, a busy machine): an empty Explorer shows only the folder. Ask for a refresh, once more per retry.
        vs.send({ command: 'workbench.files.action.refreshFilesExplorer' });
        await h.sleep(2000);
        let img = capture(vs), cl0 = findIcons(img, colour);
        for (let t = 0; t < 15 && cl0.length !== 5; t++) { vs.send({ command: 'workbench.files.action.refreshFilesExplorer' }); await h.sleep(3000); img = capture(vs); cl0 = findIcons(img, colour); }
        fs.mkdirSync(OUT, { recursive: true });
        writePng(path.join(OUT, `${tag}-window.png`), img.px, img.w, img.h, 1);
        const cl = cl0;
        if (cl.length !== 5) throw new Error(`found ${cl.length} icons in the Explorer, want 5 (${JSON.stringify(cl)})`);
        const [mkv, mp4, avi, flv, m2ts] = cl;
        const bb = (c) => `${c.x1 - c.x0 + 1}x${c.y1 - c.y0 + 1}@${c.x0},${c.y0}`;
        const pitch = (avi.y0 - mp4.y0) / 2;
        const info = { mkv: bb(mkv), mp4: bb(mp4), avi: bb(avi), flv: bb(flv), m2ts: bb(m2ts), pitch };
        const W = 26, H = Math.ceil(pitch) + 1, x = mp4.x0 - 4, y = mp4.y0 - 4;
        const cell = (k) => crop(img, x, Math.round(y + k * pitch), W, H);  // k rows from the mp4 row
        const cp = cell(0), ca = cell(2);
        let worst = 0;
        const sc = 12;
        for (const [name, k] of [['mkv', -2], ['avi', 2], ['flv', 4], ['m2ts', 6]]) {
          const c = cell(k);
          let nd = 0, maxd = 0, sum = 0;
          for (let i = 0; i < cp.length; i++) { const d = Math.abs(cp[i] - c[i]); if (d) nd++; maxd = Math.max(maxd, d); sum += d; }
          const mean = sum / cp.length;
          info[`${name}Diff`] = `${nd} bytes, max ${maxd}, mean ${mean.toFixed(3)}`;
          worst = Math.max(worst, mean);
          writePng(path.join(OUT, `${tag}-mp4-vs-${name}.png`), side(cp, c, W, H), W * 2 + 2, H, sc);
        }
        const tgt = hex(colour);
        const moments = (c) => {  // coverage = share of the icon colour per pixel (all channels), its mass and centroid
          const bg = [c[2], c[1], c[0]]; let m = 0, cx = 0, cy = 0;
          for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
            const o = (j * W + i) * 4; let a = 0, n = 0;
            for (let k = 0; k < 3; k++) { const d = tgt[k] - bg[k]; if (Math.abs(d) > 40) { a += (c[o + 2 - k] - bg[k]) / d; n++; } }
            a = Math.max(0, Math.min(1, a / (n || 1))); m += a; cx += a * i; cy += a * j;
          }
          return { mass: m, cx: cx / m, cy: cy / m };
        };
        const mm = moments(cp), mk = moments(cell(-2));
        info.mp4Moments = JSON.stringify(mm); info.mkvMoments = JSON.stringify(mk);
        info.summary = `dx ${(mk.cx - mm.cx).toFixed(2)} dy ${(mk.cy - mm.cy).toFixed(2)} mass ${(mk.mass / mm.mass).toFixed(3)} mean ${worst.toFixed(2)}`;
        // The real icon is a font glyph: ClearType (LCD) edges where the display has them, grayscale in an SVG, so a
        // few edge bytes differ; the glyph's size and position must match to a fraction of a pixel.
        const wh = (c) => [c.x1 - c.x0, c.y1 - c.y0];
        if (wh(mkv).some((v, i) => Math.abs(v - wh(mp4)[i]) > 1)) p.push(`size differs: ${JSON.stringify(info)}`);
        if (Math.abs(mkv.x0 - mp4.x0) > 1 || Math.abs(mkv.y0 - (mp4.y0 - 2 * pitch)) > 1) p.push(`position differs: ${JSON.stringify(info)}`);
        if (Math.abs(mk.mass / mm.mass - 1) > 0.08 || Math.abs(mk.cx - mm.cx) > 1.2 || Math.abs(mk.cy - mm.cy) > 1.2) p.push(`ink mass / centre differ: ${JSON.stringify(info)}`);
        if (zoom === 0 && worst > MEAN_TOLERANCE) p.push(`pixels differ (mean ${worst.toFixed(3)}): ${JSON.stringify(info)}`);
        console.log(`[${tag}] ${JSON.stringify(info)}`);
        res = { name: res.name, ok: !p.length, problems: p, info, maxDiff: worst };
      } catch (e) { res = { name: res.name, ok: false, problems: [e.message] }; }
      return [res];
    },
  };
}

module.exports = [
  variant('dark-100', 'Default Dark Modern', '#f55385', 0),
  variant('light-100', 'Default Light Modern', '#dd4b78', 0),
  variant('dark-120', 'Default Dark Modern', '#f55385', 1),
  variant('dark-m1', 'Default Dark Modern', '#f55385', -1),
  variant('dark-z2', 'Default Dark Modern', '#f55385', 2),
];
