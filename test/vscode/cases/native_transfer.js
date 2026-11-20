'use strict';
// Native frame transport (src/frameserver.js, docs/notes/native-transfer.md) in a real VS Code.
//   native-transfer:          a 4K HEVC 10-bit clip with native ffmpeg, default settings: frames
//                             arrive over the localhost frame server (log "native transport: http")
//                             at the size the player's picture needs (540p, 720p, 1080p, 1440p or 2160p) and play.
//   native-transfer-fallback: the frame server refused (VPE_NATIVE_TRANSPORT=fail, test hook): the
//                             player falls back to postMessage by itself, at 1080p, and plays.
// With VPE_TRANSFER_BENCH=1 in the runner's environment, also:
//   transfer-bench:           raw throughput into the webview of postMessage, WebSocket and
//                             streaming fetch, 1080p and 4K frame sizes (no decoding).
//   native-bench-<h>-<mode>:  long clips from VPE_TRANSFER_CLIPS (a folder) at nativeMaxHeight <h> (0: automatic)
//                             (VPE_TRANSFER_HEIGHTS, default 0,1080) over each transport
//                             (VPE_TRANSFER_MODES, default auto,message): shown fps, MB/s, host stats.
// Run the bench through test/benchq.js so it doesn't share the machine with another timing job.
const fs = require('fs');
const path = require('path');

const res = (name, problems, extra = {}) => ({ name, ok: !problems.length, problems, ...extra });

/** Plays one clip (absolute path allowed) and collects the native stats and status lines. */
async function playNative(vs, h, file, seconds) {
  const name = path.basename(file);
  const rel = path.isAbsolute(file) ? path.relative(h.MEDIA, file) : file;
  const r = await h.playClip(vs, { file: rel }, { seconds, native: true });
  const tag = `[${name}]`;
  const lines = vs.lines.filter((l) => l.includes(tag));
  const transport = lines.map((l) => /native transport: (.*)$/.exec(l)).filter(Boolean).map((m) => m[1]);
  const status = lines.filter((l) => /webview: status .*ndv=/.test(l));
  const ndv = status.map((l) => /ndv=([\d.]+)fps\/(\d+)MB\/s/.exec(l)).filter(Boolean).map((m) => ({ fps: +m[1], mbs: +m[2] }));
  const stats = lines.filter((l) => /native stats:/.test(l)).map((l) => l.replace(/^.*native stats: /, ''));
  const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : null; };
  const dec = /native decode from [\d.]+ s: (\d+x\d+) \(([^),]+)/.exec([...lines].reverse().find((l) => /native decode from/.test(l)) || '') || [];
  return {
    ...r, transport, ndvFps: med(ndv.slice(1).map((x) => x.fps)), ndvMBs: med(ndv.slice(1).map((x) => x.mbs)),
    hostStats: stats.slice(-3), size: dec[1], method: dec[2], pictureLine: lines.find((l) => /native: picture \d+x\d+/.test(l)),
  };
}

const functional = [
  {
    name: 'native-transfer',
    ffmpeg: true,
    async run(vs, h) {
      const r = await playNative(vs, h, 'hevc_10_2160p.mp4', h.seconds);
      const p = [...r.problems];
      if (!r.transport.some((t) => /^(ws|http)\b/.test(t))) p.push(`transport: ${JSON.stringify(r.transport)}`);
      // Automatic size: the frame server allows 2160p for 4K30; the frames step down to the player's picture
      // (540 / 720 / 1080 / 1440 / 2160 rows: the smallest holding its device pixels, src/native.js fitView).
      const pic = /native: picture (\d+)x(\d+): frames at/.exec(r.pictureLine || '');
      const need = pic ? Math.max(Math.min(+pic[2], +pic[1] * 9 / 16), Math.min(+pic[1], +pic[2] * 9 / 16)) : Infinity;
      const ht = [540, 720, 1080, 1440, 2160].find((x) => x >= need) || 2160;
      const want = `${ht * 16 / 9}x${ht}`;
      if (r.size !== want) p.push(`decoded at ${r.size}, expected ${want} (${pic ? pic[0] : 'no picture size logged'})`);
      return [res('hevc_10_2160p.mp4', p, { shownFps: r.shownFps, transport: r.transport, ndvMBs: r.ndvMBs, size: r.size, picture: pic && pic[0] })];
    },
  },
  {
    // The picture grows (fullscreen, a larger panel): the frames grow with it at once (a seek to the
    // same moment, src/native.js setView); shrinking back waits for the next seek. Playback goes on.
    name: 'native-transfer-resize',
    ffmpeg: true,
    async run(vs, h) {
      const file = 'hevc_10_2160p.mp4';
      const tag = `[${file}]`;
      const p = [];
      const from = await h.openClip(vs, path.join(h.MEDIA, file));
      await vs.waitLog(new RegExp(`${h.esc(tag)} webview: first frame shown`), { from, timeout: 45000 });
      const sizes = () => vs.lines.slice(from).filter((l) => l.includes(tag) && /native decode from/.test(l)).map((l) => /: (\d+x\d+) /.exec(l.replace(/^.*native decode from [\d.]+ s/, ''))?.[1]);
      const first = sizes().slice(-1)[0];
      const m0 = vs.mark();
      vs.send({ action: 'stageSize', name: file, w: 3840, h: 2160 }); // CSS pixels: at least 2160 device pixels
      // A template literal drops a lone backslash (`\d` is `d`): the patterns below spell `\\d`.
      const t0 = Date.now();
      const grown = await vs.waitLog(new RegExp(`${h.esc(tag)} native decode from [\\d.]+ s: 3840x2160`), { from: m0, timeout: 10000 }).catch(() => null);
      const growMs = grown ? Date.now() - t0 : null;
      if (!grown) p.push(`frames did not grow to 3840x2160 (sizes ${JSON.stringify(sizes())})`);
      else if (growMs > 4000) p.push(`frames grew to 3840x2160 only after ${growMs} ms`);
      await h.sleep(4500);
      const fps = vs.lines.slice(m0).filter((l) => l.includes(`${tag} webview: status`)).map((l) => Number((/shownFps=([\d.]+)/.exec(l) || [])[1])).filter(Number.isFinite);
      if (!fps.slice(1).some((x) => x > 0)) p.push(`not playing after the resize (${JSON.stringify(fps)})`);
      const m1 = vs.mark();
      vs.send({ action: 'stageSize', name: file, w: 0, h: 0 });
      const lazy = await vs.waitLog(new RegExp(`${h.esc(tag)} native: picture \\d+x\\d+: frames 3840x2160 -> ${first} at the next seek`), { from: m1, timeout: 5000 }).catch(() => null);
      if (!lazy) p.push('shrinking back was not noted for the next seek');
      vs.send({ action: 'seek', name: file, t: 0.5 });
      const shrunk = await vs.waitLog(new RegExp(`${h.esc(tag)} native decode from [\\d.]+ s: ${first}`), { from: m1, timeout: 10000 }).catch(() => null);
      if (!shrunk) p.push(`the seek did not go back to ${first} (sizes ${JSON.stringify(sizes())})`);
      // Zooming in (Ctrl+wheel: through 100 % to about 330 %) is a larger picture too: the frames grow at once.
      await h.sleep(1500);
      const m2 = vs.mark();
      for (let i = 0; i < 3; i++) { vs.send({ action: 'wheel', name: file, deltaY: -300, ctrl: true }); await h.sleep(150); }
      const t2 = Date.now();
      const zoomed = await vs.waitLog(new RegExp(`${h.esc(tag)} native decode from [\\d.]+ s: 3840x2160`), { from: m2, timeout: 10000 }).catch(() => null);
      const zoomMs = zoomed ? Date.now() - t2 : null;
      if (!zoomed) p.push(`zooming in did not grow the frames to 3840x2160 (sizes ${JSON.stringify(sizes())})`);
      else if (zoomMs > 4000) p.push(`zooming in grew the frames only after ${zoomMs} ms`);
      // Back to fit (Z): smaller frames wait for the next seek, as for a smaller window.
      await h.sleep(1000);
      const m3 = vs.mark();
      vs.send({ action: 'key', name: file, key: 'z' });
      const unzoomed = await vs.waitLog(new RegExp(`${h.esc(tag)} native: picture \\d+x\\d+: frames 3840x2160 -> ${first} at the next seek`), { from: m3, timeout: 5000 }).catch(() => null);
      if (!unzoomed) p.push('zooming back out was not noted for the next seek');
      const errs = vs.lines.slice(from).filter((l) => l.includes(tag) && /(error:|unhandled rejection)/.test(l));
      if (errs.length) p.push(`errors: ${errs.slice(0, 2).join(' | ')}`);
      await h.closeClip(vs);
      return [res(file, p, { first, growMs, zoomMs, fps, sizes: sizes() })];
    },
  },
  {
    name: 'native-transfer-fallback',
    ffmpeg: true,
    env: { VPE_NATIVE_TRANSPORT: 'fail' },
    async run(vs, h) {
      const r = await playNative(vs, h, 'hevc_10_2160p.mp4', h.seconds);
      const p = [...r.problems];
      if (!r.transport.some((t) => /^message\b/.test(t))) p.push(`transport: ${JSON.stringify(r.transport)}`);
      // postMessage caps at 1080p; a smaller picture gets the smaller step (540 / 720) as over the frame server.
      const pic = /native: picture (\d+)x(\d+): frames at/.exec(r.pictureLine || '');
      const need = pic ? Math.max(Math.min(+pic[2], +pic[1] * 9 / 16), Math.min(+pic[1], +pic[2] * 9 / 16)) : Infinity;
      const ht = Math.min(1080, [540, 720, 1080].find((x) => x >= need) || 1080);
      const want = `${ht * 16 / 9}x${ht}`;
      if (r.size !== want) p.push(`decoded at ${r.size}, expected ${want} (postMessage${pic ? `, ${pic[0]}` : ''})`);
      return [res('hevc_10_2160p.mp4', p, { shownFps: r.shownFps, transport: r.transport, size: r.size, picture: pic && pic[0] })];
    },
  },
];

const bench = !process.env.VPE_TRANSFER_BENCH ? [] : [
  {
    name: 'transfer-bench',
    async run(vs, h) {
      const file = 'h264_8_1080p.mp4';
      const from = await h.openClip(vs, path.join(h.MEDIA, file));
      await vs.waitLog(new RegExp(`\\[${h.esc(file)}\\] webview: first frame shown`), { from, timeout: 45000 });
      vs.send({ action: 'pause', name: file });
      await h.sleep(1000);
      const out = [];
      for (const [label, size, count] of [['1080p', 3110400, 240], ['2160p', 12441600, 90]]) {
        for (const mode of ['message', 'ws', 'http']) {
          const p = [];
          let line = null;
          for (let rep = 0; rep < 2; rep++) { // the second run is the number (warm)
            const m0 = vs.mark();
            vs.send(mode === 'message' ? { bench: true, size, count, name: file } : { benchFs: mode, size, count, name: file });
            line = await vs.waitLog(mode === 'message' ? /webview: bench: / : /webview: benchFs: /, { from: m0, timeout: 60000 }).catch((e) => { p.push(e.message); return null; });
            await h.sleep(1500);
          }
          const mbs = line && /= (\d+) MB\/s/.exec(line);
          if (!mbs) p.push(`no result: ${line}`);
          out.push(res(`${label}/${mode}`, p, { mbs: mbs ? +mbs[1] : null, fps: mbs ? Math.round(+mbs[1] * 1e6 / size) : null, line: line && line.replace(/^.*webview: /, '') }));
        }
      }
      return out;
    },
  },
  ...(() => {
    const dir = process.env.VPE_TRANSFER_CLIPS;
    if (!dir) return [];
    const clips = fs.readdirSync(dir).filter((f) => /\.(mp4|mkv|mov|webm)$/i.test(f)).map((f) => path.join(dir, f));
    const heights = (process.env.VPE_TRANSFER_HEIGHTS || '0,1080').split(',').map(Number);
    const modes = (process.env.VPE_TRANSFER_MODES || 'auto,message').split(',');
    const secs = Number(process.env.VPE_TRANSFER_SECONDS || 8);
    return heights.flatMap((ht) => modes.map((mode) => ({
      name: `native-bench-${ht}-${mode}`,
      ffmpeg: true,
      settings: { 'videoPreviewEnhanced.nativeMaxHeight': ht },
      env: mode === 'auto' ? {} : { VPE_NATIVE_TRANSPORT: mode },
      async run(vs, h) {
        const out = [];
        // A fresh profile tests ffmpeg's GPU methods in the background (~20 s) on the first native
        // file: let it finish first, so it doesn't share the GPU with the measured clips and they
        // use the method it picked, as a user's would.
        const m0 = vs.mark();
        await playNative(vs, h, 'hevc_10_1080p.mp4', 1).catch(() => null);
        const done = await vs.waitLog(/ffmpeg probe \(|ffmpeg probe (cancelled|failed)/, { from: m0, timeout: 120000 }).catch(() => null);
        if (!done) out.push(res('probe', ['the ffmpeg probe did not finish within 120 s']));
        for (const f of clips) {
          try {
            const r = await playNative(vs, h, f, secs);
            out.push(res(path.basename(f), r.problems, { shownFps: r.shownFps, windows: r.shownFpsWindows, ndvFps: r.ndvFps, ndvMBs: r.ndvMBs, transport: r.transport, size: r.size, method: r.method, hostStats: r.hostStats, load: r.othersLoad }));
          } catch (e) { out.push(res(path.basename(f), [e.message])); try { await h.closeClip(vs); } catch { /* gone */ } }
        }
        return out;
      },
    })));
  })(),
];

module.exports = [...functional, ...bench];
