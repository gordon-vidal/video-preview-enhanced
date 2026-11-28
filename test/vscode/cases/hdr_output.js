'use strict';
// HDR output (docs/notes/hdr-output.md) in a real VS Code:
// - probe: what the webview reports (dynamic range, WebGL / WebGPU HDR canvases), logged as JSON;
// - sdr: on this (SDR) display HDR video stays tone-mapped exactly as before: no HDR canvas, the
//   label says "HDR tone-mapped to SDR" (inspect's hdr/* cases check the colours against ffmpeg);
// - forced/*: with VPE_HDR_FORCE=1 the HDR path runs on the SDR display: the PQ and HLG test
//   patterns (test/zoo/make_hdr.js, known nits per patch) reach the extended-range WebGPU canvas
//   with the values the maths gives (media/hdr.js), in the built-in
//   decoder and through native ffmpeg (10-bit frames); the 4K PQ / HLG clips play without errors.
const path = require('path');
const lib = require('../lib');
const H = require('../../../media/hdr');

const MEDIA = path.join(__dirname, '..', '..', 'media');

// The pattern's patches (make_hdr.js): name, linear light in nits (BT.709 primaries unless *2020).
const n = (r, g, b) => ({ c709: [r, g, b] });
const n2020 = (r, g, b) => ({ c2020: [r, g, b] });
const P = {
  white203: n(203, 203, 203), yellow: n(203, 203, 0), cyan: n(0, 203, 203), green: n(0, 203, 0),
  magenta: n(203, 0, 203), red: n(203, 0, 0), blue: n(0, 0, 203), black: n(0, 0, 0),
  g5: n(5, 5, 5), g20: n(20, 20, 20), g50: n(50, 50, 50), g100: n(100, 100, 100),
  g203: n(203, 203, 203), g400: n(400, 400, 400), g1000: n(1000, 1000, 1000), g4000: n(4000, 4000, 4000),
  red2020: n2020(203, 0, 0), green2020: n2020(0, 203, 0), blue2020: n2020(0, 0, 203),
  red1000: n(1000, 0, 0), green1000: n(0, 1000, 0), blue1000: n(0, 0, 1000),
  skin100: n(100, 62, 45), g10: n(10, 10, 10),
};
const NAMES = Object.keys(P);
const PATCHES = ['white203', 'yellow', 'cyan', 'green', 'magenta', 'red', 'blue', 'black', 'g5', 'g20', 'g50', 'g100', 'g203', 'g400', 'g1000', 'g4000',
  'red2020', 'green2020', 'blue2020', 'red1000', 'green1000', 'blue1000', 'skin100', 'g10'].map((name, i) => ({ name, x: (i % 8) * 240 + 120, y: Math.floor(i / 8) * 360 + 180 }));
const M709to2020 = [[0.6274, 0.3293, 0.0433], [0.0691, 0.9195, 0.0114], [0.0164, 0.0880, 0.8956]];
const lin2020 = (p) => (p.c2020 ? p.c2020 : H.mul(M709to2020, p.c709));
// HLG holds at most 1000 nits per channel on the 1000-nit display: patches beyond that clip.
const hlgClips = (name) => /g4000|blue1000|green1000|red1000/.test(name);

/** The extended sRGB curve undone (canvas value -> linear, 1.0 = 203 nits). */
const lin = (v) => { const a = Math.abs(v); const y = a <= 0.04045 ? a / 12.92 : ((a + 0.055) / 1.055) ** 2.4; return v < 0 ? -y : y; };

/**
 * Expected canvas values per patch. The error is measured in linear light, relative to the
 * patch's brightest channel (a near-zero channel of a 1000-nit blue is steep on the sRGB curve:
 * 0.17 nits shows as 0.011 there), and in the encoded values for the grey ramp.
 */
function compare(got, kind) {
  let worst = 0;
  let at = '';
  let worstEnc = 0;
  const by = {};
  PATCHES.forEach((q, i) => {
    if (kind === 'hlg' && hlgClips(q.name)) return;
    const want = H.nitsToCanvas(lin2020(P[q.name]));
    by[q.name] = { got: got[i], want: want.map((v) => +v.toFixed(4)) };
    const peak = Math.max(0.01, ...want.map((w) => Math.abs(lin(w))));
    const d = Math.max(...want.map((w, k) => Math.abs(lin(got[i][k]) - lin(w)) / peak));
    if (d > worst) { worst = d; at = q.name; }
    if (/^g\d|white|black/.test(q.name)) worstEnc = Math.max(worstEnc, ...want.map((w, k) => Math.abs(got[i][k] - w)));
  });
  return { worst, at, by, worstEnc };
}

/** The HDR pattern with a Dolby Vision configuration (made once, next to the pattern). */
function dvClip(dir, name, src, profile, compat) {
  const out = path.join(dir, `${name}.mp4`);
  if (!require('fs').existsSync(out)) require('../../zoo/make_dv').makeDv(path.join(dir, src), out, profile, compat);
  return out;
}

const ERRORS = /HDR output failed|uncaught|TypeError|ReferenceError|shader|WebGL2 is not available/i;

function forcedCase({ name, ffmpeg }) {
  return {
    name,
    ffmpeg,
    env: { VPE_HDR_FORCE: '1' },
    settings: { 'videoPreviewEnhanced.autoplay': false, 'videoPreviewEnhanced.advancedMode': true },
    async run(vs, h) {
      const R = lib.recorder();
      if (ffmpeg && !h.ffmpeg) { R.skip('pattern', 'no ffmpeg'); return R.out; }
      for (const [kind, clip] of [['pq', 'hevc10_pq.mp4'], ['hlg', 'hevc10_hlg.mp4'], ['pq', 'dv81.mp4']]) {
        await R.run(`pattern/${clip === 'dv81.mp4' ? 'dv81' : kind}`, async (ok, r) => {
          const dir = lib.media.hdr([clip === 'dv81.mp4' ? 'hevc10_pq.mp4' : clip]);
          if (clip === 'dv81.mp4') dvClip(dir, 'dv81', 'hevc10_pq.mp4', 8, 1);
          const from = vs.mark();
          const P0 = await lib.open(vs, h, path.join(dir, clip), { timeout: 60000 });
          try {
            await P0.waitFirstFrame(60000);
            const s = await P0.waitState((x) => /HDR (PQ|HLG) \(/.test(x.label || ''), { timeout: 15000, what: 'the HDR decision in the label' });
            ok(/\(HDR output\)/.test(s.label), `label: ${s.label}`);
            ok(ffmpeg ? /native ffmpeg/.test(s.label) : s.vmode === 'soft', `decoder: ${s.label} (${s.vmode})`);
            const [cw, ch] = s.canvas;
            const pts = PATCHES.map((q) => [Math.round(q.x * cw / 1920), Math.round(q.y * ch / 1080)]);
            const px = await lib.waitProbe(() => P0.ask('hdrpixels', { pts }, 20000),
              (x) => x.state?.on && x.state.frames > 0 && !x.state.hidden, 'HDR pixels presented');
            r.state = px.state;
            r.canvas = s.canvas;
            ok(px.state && px.state.on && px.state.frames > 0 && !px.state.hidden, `HDR output state: ${JSON.stringify(px.state)}`);
            ok(px.size && px.size[0] === cw && px.size[1] === ch, `output canvas size ${px.size} vs ${s.canvas}`);
            const o = compare(px.out, kind);
            r.worstOut = `${(o.worst * 100).toFixed(2)} % at ${o.at}`;
            r.worstGrey = o.worstEnc.toFixed(4);
            ok(o.worst <= 0.02, `output canvas off the expected light by ${(o.worst * 100).toFixed(2)} % at ${o.at}: ${JSON.stringify(o.by[o.at])}`);
            ok(o.worstEnc <= 0.01, `grey ramp off by ${o.worstEnc.toFixed(4)} (encoded)`);
            r.samples = { g5: o.by.g5, g203: o.by.g203, g1000: o.by.g1000, red2020: o.by.red2020, skin100: o.by.skin100 };
            // Above SDR white: 1000 nits is ~2.0 (sRGB-encoded 4.93x), not clipped to 1.
            ok(px.out[PATCHES.findIndex((q) => q.name === 'g1000')].every((v) => v > 1.9), 'the output canvas clips 1000 nits');
            // The page's canvas keeps the tone-mapped SDR picture (the pixel tools read it).
            const sdr = (await P0.ask('pixels', { pts: [pts[0]] })).rgb[0];
            ok(Math.min(...sdr) >= 215 && Math.max(...sdr) <= 255, `tone-mapped white on the page's canvas: ${sdr}`);
            if (ffmpeg) ok(s.playback?.nativeDepth === 10, `native depth: ${s.playback?.nativeDepth}`);
            const bad = lib.lines(vs, ERRORS, from);
            ok(!bad.length, `errors: ${bad.slice(0, 3).join(' | ')}`);
          } finally { await P0.close(); }
        });
      }
      // The 4K clips in test/media: play 3 s in HDR output without errors; frames keep coming.
      for (const clip of ['hevc_10_pq_2160p.mp4', 'hevc_10_hlg_2160p.mp4']) {
        await R.run(`play/${clip.replace(/\.mp4$/, '')}`, async (ok, r) => {
          const from = vs.mark();
          const P0 = await lib.open(vs, h, path.join(MEDIA, clip), { timeout: 60000 });
          try {
            await P0.waitFirstFrame(60000);
            await P0.waitState((x) => /HDR (PQ|HLG) \(/.test(x.label || ''), { timeout: 15000, what: 'the HDR decision in the label' });
            const a = await P0.ask('hdrpixels', { pts: [[100, 100]] }, 20000);
            P0.act({ action: 'play' });
            await lib.sleep(3000);
            P0.act({ action: 'pause' });
            await lib.sleep(300);
            const s = await P0.state();
            const pts = [[s.canvas[0] >> 2, s.canvas[1] >> 2], [s.canvas[0] >> 1, s.canvas[1] >> 1], [(3 * s.canvas[0]) >> 2, (3 * s.canvas[1]) >> 2]];
            const b = await P0.ask('hdrpixels', { pts }, 20000);
            r.frames = [a.state && a.state.frames, b.state && b.state.frames];
            r.label = s.label;
            r.values = b.out;
            ok(b.state && b.state.on, `HDR output: ${JSON.stringify(b.state)}`);
            // Correctness: the HDR canvas presents new frames while playing (how many in 3 s is speed: layer 4).
            ok(b.state && a.state && b.state.frames - a.state.frames >= 2, `frames presented in 3 s of play: ${r.frames}`);
            const flat = (b.out || []).flat();
            ok(flat.length === 9 && flat.every((v) => Number.isFinite(v) && v > -1 && v < 6), `values: ${JSON.stringify(b.out)}`);
            const bad = lib.lines(vs, ERRORS, from);
            ok(!bad.length, `errors: ${bad.slice(0, 3).join(' | ')}`);
          } finally { await P0.close(); }
        });
      }
      return R.out;
    },
  };
}

module.exports = [{
  name: 'hdr_output',
  settings: { 'videoPreviewEnhanced.autoplay': false, 'videoPreviewEnhanced.advancedMode': true },
  async run(vs, h) {
    const R = lib.recorder();
    await R.run('probe', async (ok, r) => {
      const P0 = await lib.open(vs, h, lib.clip('s_h264.mp4'));
      try {
        await P0.waitFirstFrame();
        const caps = await P0.ask('hdrcaps', {}, 30000);
        delete caps.id;
        r.caps = caps;
        console.log(`hdrcaps ${JSON.stringify(caps)}`);
        ok(typeof caps.displayHdr === 'boolean', 'probe answered');
      } finally { await P0.close(); }
    });
    // This display is SDR (the hidden desktop): HDR video stays tone-mapped, no HDR canvas.
    await R.run('sdr', async (ok, r) => {
      const from = vs.mark();
      const P0 = await lib.open(vs, h, path.join(MEDIA, 'hevc_10_pq_2160p.mp4'), { timeout: 60000 });
      try {
        await P0.waitFirstFrame(60000);
        const s = await P0.waitState((x) => /HDR PQ \(/.test(x.label || ''), { timeout: 15000, what: 'the HDR decision in the label' });
        r.label = s.label;
        ok(/\(HDR tone-mapped to SDR\)/.test(s.label), `label: ${s.label}`);
        ok(s.tf === 1, `tone mapping in the shader (tf ${s.tf})`);
        const px = await P0.ask('hdrpixels', { pts: [[10, 10]] });
        ok(px.state && !px.state.on && /SDR/.test(px.state.why), `HDR output state: ${JSON.stringify(px.state)}`);
        ok(lib.lines(vs, /HDR: HDR tone-mapped to SDR \(the display is SDR\)/, from).length === 1, 'no "tone-mapped (the display is SDR)" log line');
      } finally { await P0.close(); }
    });
    // Dolby Vision (test/zoo/make_dv.js: the pattern with a DV configuration box): 8.1 plays as
    // HDR10, 8.4 as HLG, profile 5 (no compatible base layer) shows a message instead of a picture.
    let dir = null;
    try { dir = lib.media.hdr(); } catch (e) { R.skip('dv', `no HDR media: ${String(e.message).split('\n')[0]}`); }
    for (const [name, src, profile, compat, want] of dir ? [['dv81', 'hevc10_pq.mp4', 8, 1, /HDR PQ \(HDR tone-mapped to SDR\) · Dolby Vision 8\.1 \(HDR10 base layer\)/], ['dv84', 'hevc10_hlg.mp4', 8, 4, /HDR HLG \(HDR tone-mapped to SDR\) · Dolby Vision 8\.4 \(HLG base layer\)/], ['dv5', 'hevc10_pq.mp4', 5, 0, null]] : []) {
      await R.run(`dv/${name}`, async (ok, r) => {
        const file = dvClip(dir, name, src, profile, compat);
        const until = want ? lib.pictureOrError : (x) => /Dolby Vision/.test(x.message || '') || lib.pictureOrError(x);
        const P0 = await lib.open(vs, h, file, { timeout: 60000, until });
        try {
          if (!want) {
            const s = await P0.waitState((x) => /Dolby Vision/.test(x.message || ''), { timeout: 30000, what: 'the profile 5 message' });
            r.message = `${s.message} | ${s.hint}`;
            ok(/Dolby Vision profile 5 isn.t supported/.test(s.message) && /HDR10/.test(s.hint), `message: ${r.message}`);
            return;
          }
          await P0.waitFirstFrame(60000);
          const s = await P0.waitState((x) => want.test(x.label || ''), { timeout: 15000, what: 'the Dolby Vision label' });
          r.label = s.label;
          ok(s.tf === 1 || s.tf === 2, `tone mapping (tf ${s.tf})`);
          const [w] = (await P0.ask('pixels', { pts: [[120, 180]] })).rgb;
          ok(Math.min(...w) >= 215, `white patch ${w}`);
        } finally { await P0.close(); }
      });
    }
    return R.out;
  },
}, forcedCase({ name: 'hdr_output_forced', ffmpeg: false }), forcedCase({ name: 'hdr_output_forced_native', ffmpeg: true })];
