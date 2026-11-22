'use strict';
// Inspection tools and colour in a real VS Code (ported from test/browser tests.js inspect/*, hdr/*, and
// test/thumbs/browser.js, test/xray/strip_test.js): go to a frame or time, the pixel inspector against ffmpeg's
// pixel, zoom around the cursor and pan, the stats overlay, frame links, HDR tone mapping against ffmpeg's
// reference, seek-bar thumbnails, the codec X-ray strip.
const { spawn, spawnSync } = require('child_process');
const lib = require('../lib');
const media = require('../../media/make_cases_media');

// confirmedUriHandlerExtensionIds: VS Code asks before an extension opens a link (a dialog nobody can click here).
const SETTINGS = { 'videoPreviewEnhanced.autoplay': false, 'videoPreviewEnhanced.advancedMode': true, 'extensions.confirmedUriHandlerExtensionIds': ['gordon-vidal.video-preview-enhanced'] };

/** RGB and 8-bit Y/U/V of one pixel of frame k (0-based) as ffmpeg converts it; null without ffmpeg. */
function refPixel(h, file, k, x, y, W, H) {
  const run = (fmt) => spawnSync(h.ffmpeg, ['-v', 'error', '-i', file, '-vf', `select=eq(n\\,${k})`, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', fmt, '-'], { maxBuffer: 1e8, windowsHide: true });
  const rgb = run('rgb24'); const yuv = run('yuv420p');
  if (rgb.status !== 0 || yuv.status !== 0) return null;
  const o = (y * W + x) * 3; const cw = W >> 1;
  return {
    rgb: [rgb.stdout[o], rgb.stdout[o + 1], rgb.stdout[o + 2]],
    yuv: [yuv.stdout[y * W + x], yuv.stdout[W * H + (y >> 1) * cw + (x >> 1)], yuv.stdout[W * H + ((W * H) >> 2) + (y >> 1) * cw + (x >> 1)]],
  };
}

// ---- HDR reference: ffmpeg linearises (zscale, 1.0 = 203 nits) and converts to BT.709 primaries; the same BT.2390 EETF and BT.1886 encode as the shader.
const pqSig = (n) => { const p = (Math.max(0, n) / 10000) ** 0.1593017578125; return ((0.8359375 + 18.8515625 * p) / (1 + 18.6875 * p)) ** 78.84375; };
const pqNits = (e) => { const p = Math.max(0, e) ** (1 / 78.84375); return 10000 * (Math.max(p - 0.8359375, 0) / (18.8515625 - 18.6875 * p)) ** (1 / 0.1593017578125); };
function toneMap(lin, peak = 1000) {
  let L = lin.map((v) => Math.max(0, v) * 203);
  const sig = Math.max(...L);
  if (sig > 1e-4) {
    const top = pqSig(peak); const white = pqSig(203) / top; const ks = 1.5 * white - 0.5;
    const e1 = Math.min(pqSig(sig) / top, 1);
    let e2 = e1;
    if (e1 > ks) { const t = (e1 - ks) / (1 - ks); e2 = (2 * t ** 3 - 3 * t * t + 1) * ks + (t ** 3 - 2 * t * t + t) * (1 - ks) + (-2 * t ** 3 + 3 * t * t) * white; }
    L = L.map((v) => v * pqNits(e2 * top) / sig);
  }
  return L.map((v) => Math.round(255 * Math.min(1, v / 203) ** (1 / 2.4)));
}
function hdrRef(h, file, pts, W = 1920, H = 1080) {
  return new Promise((resolve) => {
    const c = spawn(h.ffmpeg, ['-v', 'error', '-i', file, '-frames:v', '1', '-vf', 'zscale=t=linear:npl=203,format=gbrpf32le,zscale=p=bt709,format=gbrpf32le', '-f', 'rawvideo', '-'], { windowsHide: true });
    const parts = [];
    c.stdout.on('data', (d) => parts.push(d));
    c.on('error', () => resolve(null));
    c.on('close', (code) => {
      const b = Buffer.concat(parts);
      if (code !== 0 || b.length < W * H * 12) { resolve(null); return; }
      const at = (plane, x, y) => b.readFloatLE((plane * W * H + y * W + x) * 4);
      resolve(pts.map(([x, y]) => toneMap([at(2, x, y), at(0, x, y), at(1, x, y)]))); // planes G, B, R
    });
  });
}
// Patch centres of the HDR pattern (test/zoo/make_hdr.js): 3 rows of 8.
const HDR_PATCHES = ['white203', 'yellow', 'cyan', 'green', 'magenta', 'red', 'blue', 'black', 'g5', 'g20', 'g50', 'g100', 'g203', 'g400', 'g1000', 'g4000',
  'red2020', 'green2020', 'blue2020', 'red1000', 'green1000', 'blue1000', 'skin100', 'g10'].map((name, i) => ({ name, x: (i % 8) * 240 + 120, y: Math.floor(i / 8) * 360 + 180 }));

module.exports = [{
  name: 'inspect',
  settings: SETTINGS,
  async run(vs, h) {
    const R = lib.recorder();
    const noFf = !h.ffmpeg;

    await R.run('goto', async (ok) => {
      const P = await lib.open(vs, h, lib.clip('s_h264.mp4'));
      try {
        await P.waitFirstFrame();
        // The bar has no frame counter any more (docs/notes/ui-simple.md): Ctrl+G opens the go-to box.
        P.key('g', { ctrl: true });
        await lib.sleep(300);
        ok((await P.state()).goto, 'Ctrl+G opens the go-to box');
        P.key('Escape', { target: '#goto input' });
        await lib.sleep(300);
        P.goto('45'); await P.expectFrame(44, 'go to 45');
        P.goto('0:02.5'); await P.expectFrame(75, 'go to 0:02.5'); // 2.5 s at 30 fps: the 76th frame, 75 0-based
        P.goto('-6'); await P.expectFrame(69, 'go to -6');
        P.key('g'); // plain G is the subtitle delay, not go-to
        await lib.sleep(500);
        ok(!(await P.state()).goto, 'plain G opened go-to');
      } finally { await P.close(); }
    });

    await R.run('pixel', async (ok, r) => {
      if (noFf) { r.skipped = 'no ffmpeg'; return; }
      const file = lib.clip('s_h264.mp4');
      const P = await lib.open(vs, h, file);
      try {
        await P.waitFirstFrame();
        P.goto('45'); await P.expectFrame(44, 'go to 45');
        P.key('z'); P.key('z'); P.key('z'); // Fit, Fill, Stretch, 100 %
        P.key('x');
        await lib.sleep(600);
        // A pixel whose neighbourhood is flat (away from chroma edges) in ffmpeg's frame 44.
        const rgbAll = spawnSync(h.ffmpeg, ['-v', 'error', '-i', file, '-vf', 'select=eq(n\\,44)', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1e8, windowsHide: true }).stdout;
        const W = 320; const H = 180;
        let pt = null;
        for (let y = 20; y < H - 20 && !pt; y += 4) for (let x = 20; x < W - 20 && !pt; x += 4) {
          let flat = true;
          const o0 = (y * W + x) * 3;
          for (let dy = -3; dy <= 3 && flat; dy++) for (let dx = -3; dx <= 3; dx++) { const o = ((y + dy) * W + x + dx) * 3; if (Math.abs(rgbAll[o] - rgbAll[o0]) + Math.abs(rgbAll[o + 1] - rgbAll[o0 + 1]) + Math.abs(rgbAll[o + 2] - rgbAll[o0 + 2]) > 6) { flat = false; break; } }
          if (flat) pt = [x, y];
        }
        ok(!!pt, 'no flat pixel found in the reference frame');
        if (!pt) return;
        const st = await P.state();
        const rc = st.canvasRect;
        // At 100 % a video pixel is a device pixel: 1 / devicePixelRatio CSS pixels (the rectangle's own size says it).
        const cx = (v) => rc[0] + ((v[0] + 0.5) * rc[2]) / W; const cy = (v) => rc[1] + ((v[1] + 0.5) * rc[3]) / H;
        P.dom('pointermove', cx(pt), cy(pt));
        const s = await P.waitState((x) => /YUV/.test(x.pxread), { timeout: 8000, what: 'the pixel read-out' });
        const m = /x (\d+)\s+y (\d+)[\s\S]*?RGB (\d+) (\d+) (\d+)[\s\S]*?YUV (\d+) (\d+) (\d+)/.exec(s.pxread);
        ok(m && Number(m[1]) === pt[0] && Number(m[2]) === pt[1], `position: ${s.pxread}`);
        const ref = refPixel(h, file, 44, pt[0], pt[1], W, H);
        const rgb = m ? [m[3], m[4], m[5]].map(Number) : [];
        const yuv = m ? [m[6], m[7], m[8]].map(Number) : [];
        ok(ref && rgb.every((v, i) => Math.abs(v - ref.rgb[i]) <= 3), `RGB ${rgb} vs ffmpeg ${ref && ref.rgb}`);
        ok(ref && yuv.every((v, i) => Math.abs(v - ref.yuv[i]) <= 1), `YUV ${yuv} vs ffmpeg ${ref && ref.yuv}`);
        P.dom('click', cx(pt), cy(pt));
        await lib.sleep(500);
        ok(!(await P.state()).playing, 'a click on the inspector started playing');
      } finally { await P.close(); }
    });

    await R.run('pixel/sd-709', async (ok, r) => {
      if (noFf) { r.skipped = 'no ffmpeg'; return; }
      const file = lib.clip('bars75_sd_709.mp4');
      const P = await lib.open(vs, h, file);
      try {
        await P.waitFirstFrame();
        const W = 640; const H = 360;
        const x = 280; const y = 180; // green bar, where the wrong matrix changes luma most
        const st = await P.state();
        ok(st.vmode === 'webcodecs', 'expected the WebCodecs path');
        P.key('x');
        const [left, top, w, ht] = st.canvasRect;
        P.dom('pointermove', left + (x + 0.5) * w / W, top + (y + 0.5) * ht / H);
        const s = await P.waitState((state) => /YUV/.test(state.pxread), { timeout: 8000, what: 'the YUV pixel read-out' });
        const m = /x (\d+)\s+y (\d+)[\s\S]*?RGB (\d+) (\d+) (\d+)[\s\S]*?YUV (\d+) (\d+) (\d+)/.exec(s.pxread);
        if (!ok(m && Math.abs(Number(m[1]) - x) <= 1 && Math.abs(Number(m[2]) - y) <= 1, `position: ${s.pxread}`)) return;
        const ref = refPixel(h, file, 0, Number(m[1]), Number(m[2]), W, H);
        const rgb = m && m.slice(3, 6).map(Number);
        const yuv = m && m.slice(6, 9).map(Number);
        ok(ref && rgb && rgb.every((v, i) => Math.abs(v - ref.rgb[i]) <= 3), `RGB ${rgb} vs ffmpeg ${ref && ref.rgb}`);
        ok(ref && yuv && yuv.every((v, i) => Math.abs(v - ref.yuv[i]) <= 1), `YUV ${yuv} vs ffmpeg ${ref && ref.yuv}`);
        P.key('I', { shift: true });
        const stats = await P.waitState((state) => /pixels/.test(state.stats), { timeout: 8000, what: 'the pixel format in stats' });
        ok(/pixels[^\n]*709/.test(stats.stats), `expected BT.709 in stats: ${stats.stats}`);
      } finally { await P.close(); }
    });

    await R.run('zoom', async (ok) => {
      const P = await lib.open(vs, h, lib.clip('s_h264.mp4'));
      try {
        await P.waitFirstFrame();
        let st = await P.state();
        const rc0 = st.canvasRect;
        const pt = [rc0[0] + rc0[2] * 0.3, rc0[1] + rc0[3] * 0.3];
        const under = async () => { const s = await P.state(); const r = s.canvasRect; return [((pt[0] - r[0]) / r[2]) * s.canvas[0], ((pt[1] - r[1]) / r[3]) * s.canvas[1], r[2] / s.canvas[0]]; };
        const wheel = async (n) => { for (let i = 0; i < n; i++) { P.dom('wheel', pt[0], pt[1], { ctrl: true, deltaY: -200 }); await lib.sleep(120); } await lib.sleep(300); };
        await wheel(3); // past the view size first: smaller pictures stay centred
        const a = await under();
        await wheel(3);
        const c = await under();
        ok(c[2] > a[2] && Math.abs(c[0] - a[0]) < 0.6 && Math.abs(c[1] - a[1]) < 0.6, `zoom keeps the point under the cursor: ${a} -> ${c}`);
        await wheel(8);
        st = await P.state();
        ok(st.imageRendering === 'pixelated' && st.pxgrid, `nearest and grid at high zoom: ${st.imageRendering} grid ${st.pxgrid}`);
        const frame = st.frameText;
        const r = st.canvasRect;
        const sx = r[0] + r[2] / 2; const sy = r[1] + r[3] / 2;
        P.dom('pointerdown', sx, sy); P.dom('pointermove', sx - 60, sy - 40); P.dom('pointermove', sx - 100, sy - 50); P.dom('pointerup', sx - 100, sy - 50);
        await lib.sleep(500);
        const st2 = await P.state();
        ok(!st2.playing && st2.frameText === frame, `drag pans without play/pause or stepping (${frame} -> ${st2.frameText}, playing ${st2.playing})`);
        P.key('z');
        await lib.sleep(400);
        { const s = await P.state(); ok(s.picture.mode === 'fit' && s.picture.zoom === 1, `Z returns to fit (${JSON.stringify(s.picture)}, stage ${s.stageClass}: a small clip in Fit is enlarged, so the transform layout)`); }
      } finally { await P.close(); }
    });

    await R.run('stats', async (ok) => {
      const P = await lib.open(vs, h, lib.clip('s_h264.mp4'));
      try {
        await P.waitFirstFrame();
        P.key('I', { shift: true });
        const s = await P.waitState((x) => /decoder/.test(x.stats), { timeout: 8000, what: 'the stats overlay' });
        ok(/decoder/.test(s.stats) && /queue/.test(s.stats) && /shown/.test(s.stats) && !/stats:/.test(s.stats), `stats: ${s.stats}`);
        ok(!s.infoShown, 'Shift+I left the details closed');
      } finally { await P.close(); }
    });

    // Frame links: vscode://<id>/open?frame=N&t=S&file=<path> opens the file at that frame, paused.
    await R.run('links/open-url', async (ok, r) => {
      if (noFf) { r.skipped = 'no ffmpeg'; return; }
      const file = lib.clip('s_h264.mp4');
      const url = `vscode://gordon-vidal.video-preview-enhanced/open?frame=60&t=1.9833&file=${encodeURIComponent(file)}`;
      const act = await lib.open(vs, h, lib.clip('s_hevc.mp4')); // activates the extension (its URI handler)
      await act.close();
      const from = vs.mark();
      // What the OS does for a vscode:// link: Code.exe itself with --open-url (the second instance hands it to the running one).
      const runMod = require('../hidden');
      await runMod.run('python', ['-I', require('path').join(__dirname, '..', 'hidden_launch.py'), '--wait', vs.desktop, vs.envMain, vs.code.exe,
        '--user-data-dir', vs.user, '--extensions-dir', vs.ext, '--open-url', url]).catch((e) => { r.cliError = e.message.slice(0, 200); });
      const P = new lib.Player(vs, h, file);
      await vs.waitLog(/\[s_h264\.mp4\] webview: first frame shown/, { from, timeout: 30000, what: 'the link opened the file' });
      try {
        await P.expectFrame(59, 'opened from the link', 15000);
        ok(!(await P.state()).playing, 'a link opens paused');
      } finally { await P.close(); }
    });

    // HDR: PQ/HLG tone-mapped to SDR in the shader against ffmpeg's reference; SDR draws as before.
    let hdrDir = null;
    try { hdrDir = media.hdr(); } catch (e) { R.skip('hdr', `no HDR media: ${String(e.message).split('\n')[0]}`); }
    for (const [kind, clip, tol] of hdrDir ? [['pq', 'hevc10_pq.mp4', 6], ['hlg', 'hevc10_hlg.mp4', 6], ['h264-pq', 'h264_pq.mp4', 6]] : []) {
      await R.run(`hdr/${kind}`, async (ok, r) => {
        if (noFf) { r.skipped = 'no ffmpeg'; return; }
        const file = require('path').join(hdrDir, clip);
        const P = await lib.open(vs, h, file, { timeout: 60000 });
        try {
          await P.waitFirstFrame(60000);
          await lib.sleep(500);
          const pts = HDR_PATCHES.map((q) => [q.x, q.y]);
          const got = (await P.ask('pixels', { pts })).rgb;
          // HLG holds the same display light as the PQ clip, so both compare with zscale's PQ decode.
          const ref = await hdrRef(h, kind === 'hlg' ? require('path').join(hdrDir, 'hevc10_pq.mp4') : file, pts);
          if (!ref) { r.skipped = 'ffmpeg without zscale'; return; }
          const by = Object.fromEntries(HDR_PATCHES.map((q, i) => [q.name, { got: got[i], ref: ref[i] }]));
          let worst = 0; let worstAt = 'white203';
          HDR_PATCHES.forEach((q, i) => { if (kind === 'hlg' && q.name === 'blue1000') return; const d = Math.max(...got[i].map((v, k) => (v <= 16 && ref[i][k] <= 16 ? 0 : Math.abs(v - ref[i][k])))); if (d > worst) { worst = d; worstAt = q.name; } });
          r.worst = `${worst} at ${worstAt}`;
          ok(worst <= tol, `tone-mapped colours off the reference by ${worst} at ${worstAt}: ${JSON.stringify(by[worstAt])}`);
          ok(Math.min(...by.white203.got) >= 215 && Math.min(...by.g1000.got) >= 250, `white ${by.white203.got}, 1000 nits ${by.g1000.got}`);
          ok(Math.max(...by.black.got) <= 2, `black ${by.black.got}`);
          const greys = ['g5', 'g10', 'g20', 'g50', 'g100', 'g203', 'g400', 'g1000'].map((n) => by[n].got[1]);
          ok(greys.every((v, i) => !i || v > greys[i - 1]), `grey steps not rising: ${greys}`);
          ok(by.red.got[0] > 200 && by.red.got[1] < 40 && by.red.got[2] < 40, `red ${by.red.got}`);
          const st = await P.state();
          ok(new RegExp(`HDR ${kind === 'hlg' ? 'HLG' : 'PQ'}`).test(st.label) && st.vmode === 'soft', `info label: ${st.label} (${st.vmode})`);
          P.seek(2);
          await lib.sleep(1500);
          const [w2] = (await P.ask('pixels', { pts: [pts[0]] })).rgb;
          ok(Math.min(...w2) >= 215, `white after a seek: ${w2}`);
          P.key('I', { shift: true });
          const s2 = await P.waitState((x) => /HDR/.test(x.stats), { timeout: 8000, what: 'the stats overlay' });
          ok(/HDR\s+(PQ|HLG)/.test(s2.stats), `stats overlay: ${s2.stats}`);
        } finally { await P.close(); }
      });
    }
    await R.run('hdr/sdr-unchanged', async (ok, r) => {
      if (noFf) { r.skipped = 'no ffmpeg'; return; }
      // SDR keeps the plain path (tf 0) and ffmpeg's colours, 8-bit and 10-bit.
      for (const [name, W, H] of [['s_h264.mp4', 320, 180], ['fmt/hevc10.mp4', 160, 90]]) {
        const file = lib.clip(name);
        const P = await lib.open(vs, h, file);
        try {
          await P.waitFirstFrame();
          await lib.sleep(300);
          // A flat spot in frame 0.
          const all = spawnSync(h.ffmpeg, ['-v', 'error', '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1e8, windowsHide: true }).stdout;
          let pt = null;
          for (let y = 8; y < H - 8 && !pt; y += 2) for (let x = 8; x < W - 8 && !pt; x += 2) {
            const o0 = (y * W + x) * 3; let flat = true;
            for (let dy = -3; dy <= 3 && flat; dy++) for (let dx = -3; dx <= 3; dx++) { const o = ((y + dy) * W + x + dx) * 3; if (Math.abs(all[o] - all[o0]) + Math.abs(all[o + 1] - all[o0 + 1]) + Math.abs(all[o + 2] - all[o0 + 2]) > 6) { flat = false; break; } }
            if (flat) pt = [x, y];
          }
          const s = await P.state();
          ok(s.tf === 0, `${name}: HDR path selected (tf ${s.tf})`);
          if (pt) {
            const rgb = (await P.ask('pixels', { pts: [pt] })).rgb[0];
            const o = (pt[1] * W + pt[0]) * 3;
            ok(rgb.every((v, i) => Math.abs(v - all[o + i]) <= 3), `${name}: RGB ${rgb} vs ffmpeg ${[all[o], all[o + 1], all[o + 2]]}`);
          }
        } finally { await P.close(); }
      }
    });

    // Seek-bar thumbnails: a picture above the time tip, replaced at a second spot, hidden on leave.
    await R.run('thumbs/seek-bar', async (ok, r) => {
      const P = await lib.open(vs, h, lib.clip('long_20s.mp4'));
      try {
        await P.waitFirstFrame();
        // Lazy (docs/notes/seek-preview.md): no thumbnail service, request or worker before the first hover.
        await lib.sleep(3000);
        const s0 = await P.state();
        ok(!s0.strip && !lib.lines(vs, /thumbs:/, P.fromMark).length, `nothing decoded before the first hover (${JSON.stringify(s0.strip)})`);
        const [sx, sy, sw, sh] = s0.seekRect;
        const hover = async (frac) => {
          const before = (await P.state()).thumb.sig;
          P.dom('mousemove', sx + sw * frac - 3, sy + sh / 2); await lib.sleep(100);
          P.dom('mousemove', sx + sw * frac, sy + sh / 2);
          return P.waitState((x) => !x.thumb.hidden && x.thumb.w > 0 && x.thumb.sig !== before, { timeout: 20000, what: `thumbnail at ${frac}` });
        };
        const a = await hover(0.3);
        ok(a.thumb.rect[1] + a.thumb.rect[3] <= a.tip.rect[1] + 1, `thumbnail above the time tip (${a.thumb.rect} vs ${a.tip.rect})`);
        const b = await hover(0.85);
        ok(b.thumb.sig !== a.thumb.sig, 'a second position replaces the picture');
        P.dom('mouseleave', sx + sw / 2, sy - 200, { target: 'seek' });
        await lib.sleep(600);
        const c = await P.state();
        ok(c.thumb.hidden && c.tip.hidden, `leaving hides the thumbnail (${c.thumb.hidden}) and tip (${c.tip.hidden})`);
        r.worker = lib.lines(vs, /thumbs:/, P.fromMark).slice(0, 2);
      } finally { await P.close(); }
    });

    // Codec X-ray strip: index, hover tip, keyframe keys.
    await R.run('xray/strip', async (ok) => {
      const P = await lib.open(vs, h, lib.clip('long_20s.mp4'));
      try {
        await P.waitFirstFrame();
        P.key('X', { shift: true });
        const s = await P.waitState((x) => x.xray.shown && /bitrate/.test(x.xray.legend) && !/indexed \d+%/.test(x.xray.legend), { timeout: 60000, what: 'the X-ray index' });
        ok(s.xray.shown, 'strip not shown');
        P.key('Home'); await lib.sleep(1200);
        P.key('}');
        const k1 = await P.waitState((x) => x.t > 0.5, { timeout: 8000, what: 'next keyframe' });
        ok(k1.t > 0.5 && k1.t < 1.6, `} went to ${k1.t} (keyframes every 1 s)`);
        P.key('{');
        const k0 = await P.waitState((x) => x.t < 0.3, { timeout: 8000, what: 'previous keyframe' });
        ok(k0.t < 0.3, `{ went to ${k0.t}`);
      } finally { await P.close(); }
    });
    return R.out;
  },
}];
