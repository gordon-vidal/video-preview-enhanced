'use strict';
// Optimisations a user should never notice (docs/notes/perf-invisible.md), in a real VS Code:
//   perf-invisible: a hidden native tab stops its ffmpeg and comes back at the same frame when shown;
//     the AudioContext rests a few seconds after a pause and play resumes it with the sound as the clock
//     and little drift; a paused native or WebCodecs player reads ~1 s ahead, not to the memory budget;
//     a paused page's frame loop rests (few animation frames), and stepping, the time label and the
//     right-click context still follow while it rests.
// With VPE_PERF_BENCH=1 in the runner's environment, also perf-invisible-bench: CPU per process of the
// instance (Win32_Process kernel + user time) and private bytes for a paused player (WebCodecs with sound,
// native), the 10 s after a pause, a hidden native tab, and native 4K / 1080p in a 1280x720 picture.
// Run the bench through test/benchq.js. Clips: 20-30 s stream copies of test/media clips in the temp folder.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');
const lib = require('../lib');

const res = (name, problems, extra = {}) => ({ name, ok: !problems.length, problems, ...extra });
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : null; };

/** A long copy of a test clip (stream copy, looped), made once in the temp folder. */
function longClip(h, name, loops) {
  const dir = path.join(os.tmpdir(), 'vpe-perf-invisible-clips');
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, name.replace(/(\.\w+)$/, `_x${loops + 1}$1`));
  if (!fs.existsSync(out)) {
    spawnSync('ffmpeg', ['-hide_banner', '-v', 'error', '-y', '-stream_loop', String(loops), '-i', path.join(h.MEDIA, name), '-c', 'copy', out], { windowsHide: true });
  }
  if (!fs.existsSync(out)) throw new Error(`could not make ${out}`);
  return out;
}

/** This instance's processes (command line names the profile folder, and their descendants): CPU seconds and private bytes. */
function sample(profileDir) {
  const key = path.basename(profileDir);
  const ps = `Get-CimInstance Win32_Process -Filter "Name='Code.exe' OR Name='ffmpeg.exe'" | ForEach-Object { [pscustomobject]@{ pid = $_.ProcessId; ppid = $_.ParentProcessId; name = $_.Name;
 mine = [bool]($_.CommandLine -and $_.CommandLine.Contains('${key}'));
 type = if ($_.CommandLine -match '--type=([a-z-]+)') { $matches[1] } else { '' };
 sub = if ($_.CommandLine -match '--utility-sub-type=([a-zA-Z.]+)') { $matches[1] } else { '' };
 cpu = ($_.KernelModeTime + $_.UserModeTime) / 1e7; priv = $_.PrivatePageCount } } | ConvertTo-Json -Compress`;
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  let all = JSON.parse(out || '[]');
  if (!Array.isArray(all)) all = [all];
  const ours = new Set(all.filter((p) => p.mine).map((p) => p.pid));
  for (let grew = true; grew;) {
    grew = false;
    for (const p of all) if (!ours.has(p.pid) && ours.has(p.ppid)) { ours.add(p.pid); grew = true; }
  }
  return { at: Date.now(), list: all.filter((p) => ours.has(p.pid)) };
}

function roleOf(list) {
  const parents = new Set(list.filter((p) => p.name === 'ffmpeg.exe').map((p) => p.ppid));
  // The extension host is a utility process (node.mojom.NodeService) in recent VS Code: also the parent of ffmpeg.
  return (p) => p.name === 'ffmpeg.exe' ? 'ffmpeg' : parents.has(p.pid) || p.sub === 'node.mojom.NodeService' ? 'exthost' : p.type === 'renderer' ? 'renderer'
    : p.type === 'gpu-process' ? 'gpu' : !p.type ? 'main' : p.sub === 'audio.mojom.AudioService' ? 'audio' : p.sub === 'network.mojom.NetworkService' ? 'network' : 'other';
}

/** % of one core per role between two samples, and CPU seconds in all. */
function cpuBetween(a, b) {
  const dt = (b.at - a.at) / 1000;
  const before = new Map(a.list.map((p) => [p.pid, p]));
  const role = roleOf(b.list);
  const out = { ffmpeg: 0, exthost: 0, renderer: 0, gpu: 0, network: 0, audio: 0, main: 0, other: 0 };
  let secs = 0;
  for (const p of b.list) {
    const p0 = before.get(p.pid);
    if (!p0 && p.name !== 'ffmpeg.exe') continue;
    const s = p.cpu - (p0 ? p0.cpu : 0);
    secs += s;
    out[role(p)] += (s / dt) * 100;
  }
  for (const k of Object.keys(out)) out[k] = Math.round(out[k] * 10) / 10;
  out.total = Math.round((secs / dt) * 1000) / 10;
  out.cpuSeconds = Math.round(secs * 100) / 100;
  return out;
}

/** Private MB per role, and the ffmpeg process count. */
function memOf(s) {
  const role = roleOf(s.list);
  const out = { ffmpegCount: s.list.filter((p) => p.name === 'ffmpeg.exe').length };
  for (const p of s.list) out[role(p)] = Math.round(((out[role(p)] || 0) + p.priv / 1048576) * 10) / 10;
  return out;
}

/** The last 'status' log line's playhead and decoded range (queued=N(a-b)). */
function statusOf(vs, name, from) {
  const l = vs.lines.slice(from).filter((x) => x.includes(`[${name}] webview: status`)).pop() || '';
  const t = Number((/ t=([\d.]+)/.exec(l) || [])[1]);
  const q = /queued=(\d+)(?:\(([\d.]+)-([\d.]+)\))?/.exec(l);
  return { t, n: q ? Number(q[1]) : null, ahead: q && q[3] ? Number(q[3]) - t : 0, ac: (/ ac=(\w+)/.exec(l) || [])[1], line: l };
}

const functional = {
  name: 'perf-invisible',
  ffmpeg: true,
  async run(vs, h) {
    const { out, run } = lib.recorder();
    if (!h.ffmpeg) return [res('skipped', [], { note: 'no ffmpeg on PATH' })];

    // Hidden native tab: ffmpeg stops; shown again: the same frame, and it plays.
    await run('hidden-native', async (ok, x) => {
      const A = await lib.open(vs, h, longClip(h, 'hevc_10_2160p.mp4', 9));
      try {
        await A.waitFirstFrame(45000);
        A.pause();
        await lib.sleep(1500);
        const s0 = await A.state();
        x.before = memOf(sample(vs.dir));
        if (!x.before.ffmpegCount) ok(false, 'no ffmpeg running for the shown native tab');
        const m = vs.mark();
        const B = await lib.open(vs, h, longClip(h, 'h264_aac_anim_1080p.mp4', 9)); // in front: A is hidden
        const hid = await vs.waitLog(new RegExp(`\\[${lib.esc(A.name)}\\] native: tab hidden, ffmpeg stopped`), { from: m, timeout: 8000 }).catch(() => null);
        if (!hid) ok(false, 'the hidden tab did not stop ffmpeg');
        B.pause();
        await lib.sleep(1500);
        x.hidden = memOf(sample(vs.dir));
        if (x.hidden.ffmpegCount) ok(false, `${x.hidden.ffmpegCount} ffmpeg still running with the native tab hidden`);
        const m2 = vs.mark();
        vs.send({ command: 'workbench.action.closeActiveEditor' }); // A is shown again
        const back = await vs.waitLog(new RegExp(`\\[${lib.esc(A.name)}\\] native decode from`), { from: m2, timeout: 10000 }).catch(() => null);
        if (!back) ok(false, 'showing the tab again did not restart ffmpeg');
        const s1 = await A.waitState((s) => s.firstShown && s.frame === s0.frame, { timeout: 8000, what: `frame ${s0.frame} again` }).catch((e) => { ok(false, e.message); return null; });
        x.frames = [s0.frame, s1 && s1.frame];
        A.play();
        await A.waitState((s) => s.playing && s.frame > s0.frame + 5, { timeout: 8000, what: 'playing after showing' }).catch((e) => ok(false, e.message));
      } finally { await A.close(); }
    });

    // The AudioContext rests while paused; play brings the sound back as the clock, in sync.
    await run('audio-rest', async (ok, x) => {
      const P = await lib.open(vs, h, longClip(h, 'h264_aac_anim_1080p.mp4', 9));
      try {
        await P.waitFirstFrame(30000);
        P.play();
        const ran = await P.waitState((s) => s.playing && s.ac === 'running' && s.audioMaster, { timeout: 6000, what: 'sound playing' }).catch(() => null);
        if (!ran) {
          // The hidden desktop gives the page no user gesture: Chromium keeps the AudioContext suspended
          // (autoplay policy). Then only check that pausing and playing still work; test/engine/unit.js
          // covers the rest and resume with a fake context.
          const q = await P.state();
          x.note = `AudioContext never ran here (ac=${q.ac}): rest/resume covered by test/engine/unit.js`;
          P.pause();
          await lib.sleep(3500);
          P.play();
          await P.waitState((s) => s.playing && s.frame > q.frame + 10, { timeout: 6000, what: 'playing after a pause' }).catch((e) => ok(false, e.message));
          P.pause();
          return;
        }
        await lib.sleep(1000);
        P.pause();
        const r = await P.waitState((s) => !s.playing && s.ac === 'suspended', { timeout: 8000, what: 'AudioContext suspended after the pause', interval: 500 }).catch((e) => { ok(false, e.message); return null; });
        x.restedAfterMs = r ? 'yes' : 'no';
        const t0 = Date.now();
        P.play();
        const s = await P.waitState((q) => q.playing && q.ac === 'running' && q.audioMaster, { timeout: 5000, what: 'the sound as the clock after play', interval: 50 }).catch((e) => { ok(false, e.message); return null; });
        x.resumeMs = s ? Date.now() - t0 : null;
        await lib.sleep(1500);
        const d = await P.sample(1500, (q) => q.drift);
        const drifts = d.map((q) => q.v).filter((v) => typeof v === 'number');
        x.driftMs = drifts.map((v) => Math.round(v * 1000));
        if (!drifts.length) ok(false, 'no drift readings (the sound is not the clock)');
        // Layer 3 (h.scenario): only gross drift; the 100 ms figure is judged by layer 4 on a quiet machine.
        else if (Math.max(...drifts.map(Math.abs)) > (h.scenario ? 0.5 : 0.1)) ok(false, `picture and sound apart by up to ${Math.round(Math.max(...drifts.map(Math.abs)) * 1000)} ms after resuming`);
        P.pause();
      } finally { await P.close(); }
    });

    // Paused read-ahead: ~1 s for native ffmpeg and WebCodecs.
    for (const [label, file] of [['native', 'hevc_10_2160p.mp4'], ['webcodecs', 'h264_8_2160p.mp4']]) {
      await run(`paused-readahead/${label}`, async (ok, x) => {
        const P = await lib.open(vs, h, longClip(h, file, 9));
        try {
          shown(await P.waitFirstFrame(45000));
          P.pause();
          await lib.sleep(1000);
          P.seek(8);
          await P.waitState((s) => !s.playing && Math.abs(s.t - 8) < 0.2, { timeout: 10000, what: 'paused at 8 s' });
          const m = vs.mark();
          await lib.sleep(4500);
          const st = statusOf(vs, P.name, m);
          x.ahead = Math.round(st.ahead * 100) / 100;
          x.queued = st.n;
          if (st.n === null) ok(false, `no status line (${st.line})`);
          // WebCodecs after a seek: the hardware decoder outputs frames only some packets later, and the reader
          // can't stop before the frames come out (a paused step would stall): ~3 s at 4K here; native ~1.5 s.
          else if (st.ahead > (label === 'native' ? 2.2 : 4.5)) ok(false, `paused read-ahead ${st.ahead.toFixed(2)} s (expected about ${label === 'native' ? 1 : 3} s)`);
          else if (st.n < 1) ok(false, 'nothing decoded ahead');
          // Steps forward past the read-ahead still land on each frame.
          const f0 = (await P.state()).frame;
          // (One at a time: two steps in one hook poll would both start from the same shown frame.)
          for (let i = 1; i <= 3 && x.ok; i++) {
            P.step(1);
            await P.waitState((s) => s.frame === f0 + i, { timeout: 5000, what: `frame ${f0 + i} after ${i} steps` }).catch((e) => ok(false, e.message));
          }
        } finally { await P.close(); }
      });
    }

    // The frame loop rests while paused; stepping, the time label and the right-click context still follow.
    await run('loop-rest', async (ok, x) => {
      const P = await lib.open(vs, h, longClip(h, 'h264_aac_anim_1080p.mp4', 9));
      try {
        await P.waitFirstFrame(30000);
        P.play();
        await P.waitState((s) => s.playing, { timeout: 5000, what: 'playing' });
        const a = await P.state();
        await lib.sleep(2000);
        const b = await P.state();
        const rate = (b.loop.frames - a.loop.frames) / 2;
        x.framesPerSecondPlaying = rate;
        P.pause();
        await lib.sleep(2500);
        const c = await P.state();
        await lib.sleep(4000);
        const d = await P.state();
        x.framesIn4sPaused = d.loop.frames - c.loop.frames;
        x.rests = d.loop.rests;
        x.busy = [c.loop.busy, d.loop.busy];
        if (!(d.loop.rests > c.loop.rests || d.loop.rests > 0)) ok(false, 'the frame loop never rested while paused');
        if (x.framesIn4sPaused > 0.5 * rate * 4) ok(false, `${x.framesIn4sPaused} animation frames in 4 s paused (playing: ${rate}/s)`);
        if (d.playing !== false) ok(false, `player state while paused: ${d.playing}`);
        // Stepping while resting: the frame, the time label and the bar follow.
        P.step(1);
        const e = await P.waitState((s) => s.frame === d.frame + 1, { timeout: 4000, what: 'a step while resting' }).catch((err) => { ok(false, err.message); return null; });
        if (e && e.timeText === d.timeText) ok(false, `the time label did not follow the step (${e.timeText})`);
        await lib.sleep(2500);
        P.play();
        const f = await P.waitState((s) => s.playing, { timeout: 4000, what: 'playing after resting' }).catch((err) => { ok(false, err.message); return null; });
        if (f) await P.waitState((s) => s.frame > f.frame + 10, { timeout: 4000, what: 'frames advance after resting' }).catch((err) => ok(false, err.message));
        P.pause();
      } finally { await P.close(); }
    });
    return out;
  },
};

/** A state with the picture up, else throws (a page whose WebGL failed measures nothing). */
const shown = (s) => { if (!s.firstShown) throw new Error(`no picture: ${s.message} ${s.hint}`); return s; };

const bench = {
  name: 'perf-invisible-bench',
  ffmpeg: true,
  env: { VPE_THUMB_PASS: '0' },
  async run(vs, h) {
    const out = [];
    const secs = Number(process.env.VPE_PERF_SECONDS || 15);
    const sound = longClip(h, 'h264_aac_anim_1080p.mp4', 9);
    const nat = longClip(h, 'hevc_10_2160p.mp4', 9);
    const nat1080 = longClip(h, 'hevc_8_1080p.mp4', 9);
    const wc = longClip(h, 'h264_8_2160p.mp4', 9);
    const only = process.env.VPE_PERF_ONLY ? new RegExp(process.env.VPE_PERF_ONLY) : null;
    const measure = async (name, fn) => {
      if (only && !only.test(name)) return;
      try { out.push(res(name, [], await fn())); } catch (e) { out.push(res(name, [e.message])); }
      try { await h.closeClip(vs); } catch { /* gone */ }
      await lib.sleep(2000);
      console.log(`  ${name}: ${JSON.stringify(out[out.length - 1])}`);
    };
    // Idle: nothing open (baseline of the instance).
    await measure('idle-empty', async () => {
      await lib.sleep(3000);
      const a = sample(vs.dir); await lib.sleep(secs * 1000); const b = sample(vs.dir);
      return { cpu: cpuBetween(a, b), mem: memOf(b) };
    });
    // A paused player in front, settled (6 s after the pause): CPU and memory.
    for (const [label, file] of [['webcodecs-sound', sound], ['native-4k', nat]]) {
      await measure(`paused-${label}`, async () => {
        const P = await lib.open(vs, h, file);
        shown(await P.waitFirstFrame(45000));
        await lib.sleep(1500);
        P.pause();
        await lib.sleep(6000);
        const st = await P.state();
        const a = sample(vs.dir); await lib.sleep(secs * 1000); const b = sample(vs.dir);
        return { cpu: cpuBetween(a, b), mem: memOf(b), ac: st.ac, loop: st.loop };
      });
    }
    // The 10 s after a pause (and the memory then): decoding ahead while paused.
    for (const [label, file] of [['native-4k', nat], ['webcodecs-4k', wc]]) {
      await measure(`after-pause-${label}`, async () => {
        const P = await lib.open(vs, h, file);
        shown(await P.waitFirstFrame(45000));
        await lib.sleep(2500);
        P.pause();
        const a = sample(vs.dir); await lib.sleep(10000); const b = sample(vs.dir);
        const st = statusOf(vs, P.name, 0);
        return { cpu: cpuBetween(a, b), mem: memOf(b), queued: st.n, ahead: Math.round(st.ahead * 100) / 100 };
      });
    }
    // A paused native tab, then hidden behind a paused WebCodecs one.
    await measure('hidden-native', async () => {
      const A = await lib.open(vs, h, nat);
      shown(await A.waitFirstFrame(45000));
      A.pause();
      await lib.sleep(3000);
      const shownMem = memOf(sample(vs.dir));
      const B = await lib.open(vs, h, sound);
      shown(await B.waitFirstFrame(30000));
      B.pause();
      await lib.sleep(4000);
      const a = sample(vs.dir); await lib.sleep(10000); const b = sample(vs.dir);
      return { shown: shownMem, hidden: memOf(b), hiddenCpu: cpuBetween(a, b) };
    });
    // Native playback in a picture 1280x720 device pixels large (CSS pixels from the page's scale): frames sized to it.
    for (const [label, file] of [['4k', nat], ['1080p', nat1080]]) {
      await measure(`native-720-picture-${label}`, async () => {
        const P = await lib.open(vs, h, file);
        const s0 = shown(await P.waitFirstFrame(45000));
        const dpr = s0.dpr || Number(process.env.VPE_PERF_DPR) || 1; // (a build without the state hook's dpr: VPE_PERF_DPR)
        vs.send({ action: 'stageSize', name: P.name, w: Math.floor(1280 / dpr), h: Math.floor(720 / dpr) });
        await lib.sleep(1000);
        P.seek(1); // smaller frames apply at the next seek
        await lib.sleep(3000);
        const m0 = vs.mark();
        const a = sample(vs.dir); await lib.sleep(12000); const b = sample(vs.dir);
        const lines = vs.lines.filter((l) => l.includes(`[${P.name}]`));
        const dec = [...lines].reverse().find((l) => /native decode from/.test(l)) || '';
        const fps = vs.lines.slice(m0).filter((l) => l.includes(`[${P.name}] webview: status`)).map((l) => Number((/shownFps=([\d.]+)/.exec(l) || [])[1])).filter(Number.isFinite);
        const pic = lines.filter((l) => /native: picture \d+x\d+/.test(l)).pop() || '';
        return { cpu: cpuBetween(a, b), frames: (/: (\d+x\d+) /.exec(dec.replace(/^.*native decode from [\d.]+ s/, '')) || [])[1], shownFps: med(fps), dpr, picture: pic.replace(/^.*native: /, '') };
      });
    }
    return out;
  },
};

module.exports = process.env.VPE_PERF_BENCH ? [functional, bench] : [functional];
