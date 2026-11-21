'use strict';
// The first-open suite (layer 3 scenario open-formats, layer 4 bench play-fps): the test/media clips with the
// decoder path VS Code must take, playClip (opened, first frame, decoder path, playing, a paused seek spot check,
// FPS recorded in layer 4) and wcprobe (WebCodecs / AudioDecoder / <video> support in the real webview).
const path = require('path');
const lm = require('../loadmon');
const { openClip, closeClip, MEDIA, sleep } = require('./hidden');
const { Player } = require('./lib');

/** Clips: what decodes them in VS Code (webcodecs = H.264/VP8 WebCodecs, soft = WebAssembly). */
const CLIPS = [
  { file: 'mpeg2_1080p.mpg', expect: 'soft' },
  { file: 'h264_8_2160p.mp4', expect: 'webcodecs' },
  { file: 'hevc_10_2160p.mp4', expect: 'soft' },
  { file: 'av1_8_1080p.mp4', expect: 'soft' },
  { file: 'vp9_2160p.webm', expect: 'soft' },
  { file: 'prores_proxy_1080p.mov', expect: 'soft' },
  { file: 'h264_aac_anim_1080p.mp4', expect: 'webcodecs', sound: true },
  { file: 'hevc_8_1080p.mp4', expect: 'soft' },
  // The listing's claim: H.264 on the GPU decoder in every container, VP8 in WebM (test/media/make_containers.js).
  // (.ts is TypeScript in VS Code: the extension doesn't claim it; README "Formats".)
  ...['mkv', 'mov', 'm2ts', 'flv', 'avi'].map((x) => ({ file: `containers/h264_aac.${x}`, expect: 'webcodecs', sound: true })),
  { file: 'containers/vp8_vorbis.webm', expect: 'webcodecs', sound: true },
];
const NATIVE_CLIPS = ['hevc_10_2160p.mp4', 'av1_10_2160p.mp4'];

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : null; };

// slow: the open is slow by nature (remote re-encode, 4K software decode): keep firstFrameTimeout as given.
async function playClip(vs, clip, { seconds, native, onShown, correctness = false, firstFrameTimeout = 45000, slow = false }) {
  const file = path.join(MEDIA, clip.file);
  const name = path.basename(file);
  const tag = `\\[${esc(name)}\\]`;
  const r = { clip: name, ok: true, problems: [] };
  const bad = (m) => { r.ok = false; r.problems.push(m); };
  const t0 = Date.now();
  if (!correctness) {
    const idle = await lm.sample(1); // others' load, before our clip runs
    r.othersLoad = Math.round(idle.load);
  }
  const from = await openClip(vs, file);
  await vs.waitLog(new RegExp(`${tag} webview: first frame shown`), { from, timeout: firstFrameTimeout, what: `${name}: first frame`, slow: slow || native });
  r.openMs = Date.now() - t0; // command to first frame
  const dec = native ? await vs.waitLog(new RegExp(`${tag} decoder: `), { from, timeout: 8000 }).catch(() => null)
    : vs.lines.slice(from).find((l) => new RegExp(`${tag} decoder: `).test(l));
  if (dec) r.decision = dec.replace(/^.*?decoder: /, '');
  // The extension appends log lines asynchronously: on a busy machine they can come late or out of order.
  const streams = await vs.waitLog(new RegExp(`${tag} webview: streams: `), { from, timeout: 8000 }).catch(() => null);
  if (streams) {
    const m = /-> video (\w+), audio (\w+)/.exec(streams);
    if (m) { r.video = m[1]; r.audio = m[2]; }
  }
  if (native) r.video = 'native';
  if (clip.expect && r.video !== clip.expect) bad(`decoded by ${r.video}, expected ${clip.expect}`);
  if (onShown) await onShown(name);
  const player = correctness ? new Player(vs, null, file) : null;
  if (player) {
    const first = await player.waitState((s) => s.firstShown && s.playing, { what: 'playing after first paint' });
    const next = await player.waitState((s) => s.playing && s.shownCount > first.shownCount,
      { what: 'displayed frames advancing' });
    r.fps = Number.isFinite(next.fps) && next.fps > 0 ? next.fps : null;
    if (clip.sound) {
      r.sound = { amode: r.audio, ac: next.ac, sources: next.sources };
      if (!r.audio || r.audio === 'none') bad('no sound stream picked');
    }
  } else {
    // shownFps from the 2 s status lines; the first window after opening is skipped.
    const fromPlay = vs.mark();
    await sleep(seconds * 1000 + 2500);
    vs.mark();
    const status = vs.lines.slice(fromPlay).filter((l) => new RegExp(`${tag} webview: status `).test(l));
    const fpsList = status.map((l) => Number((/shownFps=([\d.]+)/.exec(l) || [])[1])).filter((x) => Number.isFinite(x));
    r.fps = Math.max(0, ...status.map((l) => Number((/ fps=([\d.]+)/.exec(l) || [])[1]) || 0)) || null;
    const win = fpsList.slice(1);
    r.shownFps = win.length ? med(win) : fpsList.length ? fpsList[0] : null;
    r.shownFpsWindows = fpsList;
    const playing = status.some((l) => /playing=true/.test(l));
    if (!playing) bad('not playing');
    if (!fpsList.slice(1).some((x) => x > 0)) bad(`no frames shown after the first window (${JSON.stringify(fpsList)})`);
    if (clip.sound) {
      const last = status[status.length - 1] || '';
      r.sound = { amode: r.audio, ac: (/ ac=(\S+)/.exec(last) || [])[1], clock: (/clock=(\S+)/.exec(last) || [])[1], sources: Number((/playingSources=(\d+)/.exec(last) || [])[1]) };
      if (!r.audio || r.audio === 'none') bad('no sound stream picked');
    }
  }
  // Seek spot check: paused, the middle of frame k must come to show frame k (report frame= is
  // 1-based). Polled (test/vscode/lib.js expectFrame does the same): a 4K seek in WebAssembly takes seconds.
  if (!r.fps && !native) {
    if (correctness) bad('no usable frame rate for paused seeks');
    else r.note = 'no frame rate logged: seek check skipped';
  }
  if (r.fps && !native) {
    const report = async () => {
      if (player) {
        const s = await player.state();
        return { frame: s.frame, frames: s.n || Infinity, playing: s.playing, shownCount: s.shownCount };
      }
      const m0 = vs.mark();
      vs.send({ action: 'report', name, delay: 0 });
      const rep = await vs.waitLog(new RegExp(`${tag} webview: report frame=`), { from: m0, timeout: 10000, what: `${name}: report` });
      return { frame: Number(/frame=(\d+)/.exec(rep)[1]) - 1, frames: Number((/frames=(\d+)/.exec(rep) || [])[1]) || Infinity, playing: /playing=true/.test(rep) };
    };
    vs.send({ action: 'pause', name });
    const p0 = Date.now();
    let rep0;
    while ((rep0 = await report()).playing && Date.now() - p0 < 5000) await sleep(200);
    if (correctness && rep0.playing) bad('clip did not pause before seeks');
    const seeks = [];
    // Within the clip: the ProRes one has 24 frames (a seek past the end shows the last frame).
    let shownBeforeSeek = rep0.shownCount;
    for (const k of [Math.min(Math.round(r.fps * 1.2) + 3, rep0.frames - 2), 7]) {
      vs.send({ action: 'seek', name, t: (k + 0.5) / r.fps });
      const s0 = Date.now();
      let got = null;
      try {
        for (;;) {
          await sleep(250);
          const rep = await report();
          got = rep.frame;
          const painted = !correctness || (!rep.playing && rep.shownCount > shownBeforeSeek);
          if (got === k && painted) {
            shownBeforeSeek = rep.shownCount;
            break;
          }
          if (Date.now() - s0 > 30000) { // generous: a 4K seek in WebAssembly under load
            if (!painted) got = null;
            break;
          }
        }
      } catch (e) { bad(e.message); }
      seeks.push({ want: k, got, ms: Date.now() - s0 });
      if (got !== k) bad(`seek to frame ${k} showed ${got} after ${((Date.now() - s0) / 1000).toFixed(1)} s`);
    }
    r.seeks = seeks;
  }
  const errs = vs.lines.slice(from).filter((l) => new RegExp(`${tag} (error:|webview: (error:|unhandled rejection))`).test(l));
  if (errs.length) bad(`errors: ${errs.slice(0, 2).join(' | ')}`);
  if (clip.known) {
    const k = r.problems.filter((m) => clip.known.re.test(m));
    if (k.length) { r.known = `${clip.known.why}: ${k.join('; ')}`; r.problems = r.problems.filter((m) => !k.includes(m)); r.ok = !r.problems.length; }
  }
  if (!correctness) r.noisy = lm.verdict(r.othersLoad);
  await closeClip(vs);
  return r;
}

async function wcprobe(vs, name) {
  const from = vs.mark();
  vs.send({ action: 'wcprobe', name });
  const l = await vs.waitLog(/webview: wcprobe /, { from, timeout: 15000, what: 'wcprobe' });
  const r = JSON.parse(l.replace(/^.*?webview: wcprobe /, ''));
  const problems = [];
  for (const where of ['page', 'worker']) {
    const m = r[where];
    if (!m || typeof m !== 'object') { problems.push(`${where}: ${m}`); continue; }
    if (!/Y/.test(m.h264 || '')) problems.push(`${where}: no H.264`);
    if (!/Y/.test(m.vp8 || '')) problems.push(`${where}: no VP8`);
  }
  return { ok: !problems.length, problems, ...r };
}

module.exports = { CLIPS, NATIVE_CLIPS, playClip, wcprobe };
