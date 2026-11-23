'use strict';
// node test/host/remotestream_test.js: the remote stream (src/remotestream.js) without VS Code.
//  - when a window streams (remoteStream off|auto|on), which files are worth it;
//  - the GPU encoder probe (fake ffmpeg) and its per-host cache;
//  - with ffmpeg on PATH: picture and sound stay in sync over 200 s clips whose sound track starts
//    late, whose picture starts late, or whose sound has a gap (flashes and beeps every 10 s, read
//    back from the H.264 and the PCM sent); seeks served from memory; a burst of seeks starts
//    ffmpeg only a few times; nothing runs after dispose; a failing GPU encoder falls back to libx264;
//    the GPU encoder this machine's ffmpeg has (if any) streams in sync too.
// The clips are decoded again with the ffmpeg on PATH; VPE_RS_FFMPEG=<ffmpeg> streams with another one.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const ff = require('../../src/ffmpeg');
const rsm = require('../../src/remotestream');
const { RemoteStream, enabled, wanted } = rsm;
const remoteAudio = require('../lib/remote_audio');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Waits for a state, not for a time: the deadline is only a safety net for a busy CI machine.
async function until(ready, why) {
  const end = Date.now() + 30000;
  while (!ready()) {
    assert.ok(Date.now() < end, why);
    await sleep(20);
  }
}

function unit() {
  // auto: remote windows only, and only when native ffmpeg didn't take the file.
  for (const remote of ['ssh-remote', 'wsl', 'dev-container', 'attached-container', 'tunnel', 'codespaces']) {
    assert.strictEqual(enabled({ setting: 'auto', remote, nativeChosen: false }), true, remote);
    assert.strictEqual(enabled({ setting: 'auto', remote, nativeChosen: true }), false, `${remote}, native`);
  }
  assert.strictEqual(enabled({ setting: 'auto', remote: undefined, nativeChosen: false }), false, 'local window');
  assert.strictEqual(enabled({ setting: 'on', remote: undefined, nativeChosen: true }), true);
  assert.strictEqual(enabled({ setting: 'off', remote: 'ssh-remote', nativeChosen: false }), false);
  assert.strictEqual(enabled({ setting: 'off', remote: 'wsl', nativeChosen: true }), false);
  assert.strictEqual(wanted({ video: { codec: 'h264', pixFmt: 'yuv420p' } }), false);
  assert.strictEqual(wanted({ video: { codec: 'vp8', pixFmt: 'yuv420p' } }), false);
  assert.strictEqual(wanted({ video: { codec: 'h264', pixFmt: 'yuv420p10le' } }), true);
  assert.strictEqual(wanted({ video: { codec: 'hevc', pixFmt: 'yuv420p10le' } }), true);
  assert.strictEqual(wanted({ audio: {} }), false);
  // The setting is declared, machine-scoped, auto by default.
  const pkg = require('../../package.json');
  const s = pkg.contributes.configuration.properties['videoPreviewEnhanced.remoteStream'];
  assert.ok(s && s.default === 'auto' && s.scope === 'machine' && s.enum.join() === 'auto,off,on', 'remoteStream declared');
  assert.match(s.enumDescriptions[1], /Disable remote H\.264 re-encoding\. Normal decoder selection still applies\./);
  // Encoder arguments: GPU encoders get their pixel format / upload; libx264 for anything unknown.
  assert.deepStrictEqual(rsm.encoderFrame('h264_vaapi', '/dev/dri/renderD129'), { pre: ['-vaapi_device', '/dev/dri/renderD129'], vf: 'format=nv12,hwupload' });
  assert.strictEqual(rsm.encoderFrame('h264_qsv').vf, 'format=nv12');
  assert.strictEqual(rsm.encoderFrame('libx264').vf, 'format=yuv420p');
  assert.strictEqual(rsm.encoderArgs('whatever', 30)[1], 'libx264');
  for (const e of rsm.GPU_ENCODERS) assert.ok(rsm.encoderArgs(e, 25).includes('-bf'), `${e}: no B-frames`);
}

async function probeFake() {
  const calls = [];
  const fake = (results) => async (cmd, args) => {
    calls.push(args.join(' '));
    if (args.includes('-encoders')) return { code: results.listCode ?? 0, stdout: results.list, stderr: 'listing error' };
    const enc = args[args.indexOf('-c:v') + 1];
    const dev = args.includes('-vaapi_device') ? args[args.indexOf('-vaapi_device') + 1] : '';
    const ok = results.ok.includes(dev ? `${enc} ${dev}` : enc);
    return { code: ok ? 0 : 1, stdout: '', stderr: ok ? '' : `Cannot load ${enc}` };
  };
  const list = ' V....D libx264  libx264 H.264\n V....D h264_nvenc  NVIDIA NVENC\n V....D h264_vaapi  H.264/AVC (VAAPI)\n';
  // nvenc built in but no NVIDIA driver; the second render node works.
  let r = await rsm.probeEncoder('ffmpeg', fake({ list, ok: ['h264_vaapi /dev/dri/renderD129'] }), { nodes: ['/dev/dri/renderD128', '/dev/dri/renderD129'] });
  assert.deepStrictEqual([r.encoder, r.device], ['h264_vaapi', '/dev/dri/renderD129']);
  assert.deepStrictEqual(r.tried.map((x) => x.ok), [false, false, true]);
  assert.ok(!calls.some((c) => /h264_qsv|h264_amf/.test(c)), 'encoders not built in are not tried');
  // Nothing works (or no render node): libx264.
  r = await rsm.probeEncoder('ffmpeg', fake({ list, ok: [] }), { nodes: [] });
  assert.strictEqual(r.encoder, 'libx264');
  r = await rsm.probeEncoder('ffmpeg', fake({ list: ' V....D libx264 x\n', ok: [] }), { nodes: [] });
  assert.deepStrictEqual([r.encoder, r.tried.length], ['libx264', 0]);
  // BtbN's LGPL build (src/remoteff.js) has no libx264: libopenh264, also the GPU fallback.
  r = await rsm.probeEncoder('ffmpeg', fake({ list: ' V....D libopenh264  OpenH264\n V....D h264_nvenc  NVIDIA NVENC\n', ok: [] }), { nodes: [] });
  assert.deepStrictEqual([r.encoder, r.cpu], ['libopenh264', 'libopenh264']);
  assert.strictEqual(rsm.cpuEncoder(' V....D libx264  x\n V....D libopenh264  y\n'), 'libx264', 'libx264 first');
  assert.ok(!rsm.encoderArgs('libopenh264', 30).includes('-bf'), 'OpenH264: no B-frame option');
  await assert.rejects(rsm.probeEncoder('ffmpeg', fake({ list, listCode: 1, ok: [] })), /-encoders failed.*listing error/);
  // Opus capability is an actual encode, cached per build; native Opus and s16 are fallbacks.
  for (const accepted of ['libopus', 'opus', null]) {
    const attempts = [];
    const tools = { ffmpeg: 'audio-probe', version: String(accepted) };
    const exec = async (cmd, args) => {
      const enc = args[args.indexOf('-c:a') + 1];
      attempts.push(enc);
      return { code: enc === accepted ? 0 : 1 };
    };
    assert.strictEqual(await rsm.audioEncoderFor(tools, exec), accepted);
    assert.deepStrictEqual(attempts, accepted === 'libopus' ? ['libopus'] : ['libopus', 'opus']);
    await rsm.audioEncoderFor(tools, exec);
    assert.strictEqual(attempts.length, accepted === 'libopus' ? 1 : 2, 'audio probe is cached');
  }
  // Keep a confirmed pick in the store. A stream failure prompts a new probe.
  const store = { data: {}, get(k) { return this.data[k]; }, async update(k, v) { this.data[k] = v; } };
  let runs = 0;
  const run = async (cmd, args) => { runs++; return args.includes('-encoders') ? { code: 0, stdout: ' V....D h264_nvenc x\n', stderr: '' } : { code: 0, stdout: '', stderr: '' }; };
  const tools = { ffmpeg: '/fake/ffmpeg', version: 'ffmpeg version test-1' };
  const saved = process.env.VPE_RS_ENCODER;
  delete process.env.VPE_RS_ENCODER;
  try {
    const pick = await rsm.encoderFor(tools, run, store);
    assert.strictEqual(pick.encoder, 'h264_nvenc');
    const n = runs;
    assert.strictEqual((await rsm.encoderFor(tools, run, store)).encoder, 'h264_nvenc');
    assert.strictEqual(runs, n, 'probed once');
    assert.strictEqual(Object.values(store.data[rsm.ENCODER_KEY])[0].encoder, 'h264_nvenc');
    rsm.encoderFailed(tools, pick);
    assert.strictEqual(Object.values(store.data[rsm.ENCODER_KEY])[0].encoder, 'h264_nvenc');
    assert.strictEqual((await rsm.encoderFor(tools, run, store)).encoder, 'h264_nvenc', 'GPU recovers after an input failure');
    assert.ok(runs > n);
    const recovered = await rsm.encoderFor(tools, run, store);
    rsm.encoderFailed(tools, recovered);
    const both = ' V....D h264_nvenc x\n V....D h264_qsv x\n';
    assert.strictEqual((await rsm.encoderFor(tools, fake({ list: both, ok: ['h264_qsv'] }), store, () => {}, { platform: 'win32' })).encoder, 'h264_qsv');
    // A failed listing, including partial stdout, must be retried on the next open.
    const other = { ...tools, version: 'ffmpeg version test-2' };
    assert.strictEqual((await rsm.encoderFor(other, fake({ list, listCode: 1, ok: [] }), store)).encoder, null);
    assert.strictEqual(Object.values(store.data[rsm.ENCODER_KEY]).length, 1, 'no persisted result from failed listing');
    assert.strictEqual((await rsm.encoderFor(other, run, store)).encoder, 'h264_nvenc');
    const busy = { ...tools, version: 'ffmpeg version test-3' };
    const now = Date.now;
    try {
      assert.strictEqual((await rsm.encoderFor(busy, fake({ list, ok: [] }), store)).encoder, 'libx264');
      assert.strictEqual(Object.values(store.data[rsm.ENCODER_KEY]).length, 2, 'failed test encode is temporary');
      assert.strictEqual((await rsm.encoderFor(busy, run, store)).encoder, 'libx264');
      Date.now = () => now() + 120000;
      assert.strictEqual((await rsm.encoderFor(busy, run, store)).encoder, 'h264_nvenc', 'test encode retried after expiry');
    } finally { Date.now = now; }
  } finally { if (saved !== undefined) process.env.VPE_RS_ENCODER = saved; }
}

/** Synthetic clips: MPEG-4 Part 2 (streamed: not H.264), a white flash and a 1 kHz beep at every 10 s of the timeline. */
function makeClips(dir) {
  const mk = (name, args) => {
    const out = path.join(dir, name);
    if (!fs.existsSync(out)) {
      // Made under a temporary name and renamed: a run that stops halfway (timeout) or another run at the same
      // time never leaves or reads a half-written clip under the final name.
      const part = `${out}.${process.pid}.part.mkv`;
      const r = spawnSync('ffmpeg', ['-v', 'error', '-y', ...args, '-c:v', 'mpeg4', '-q:v', '6', '-c:a', 'pcm_s16le', part], { encoding: 'utf8' });
      assert.strictEqual(r.status, 0, r.stderr);
      fs.renameSync(part, out);
    }
    return out;
  };
  const flash = (fps, shift) => `color=black:s=320x180:r=${fps}:d=200,geq=lum='if(lt(mod(T+${shift}\\,10)\\,0.039)\\,235\\,16)':cb=128:cr=128`;
  const beep = (expr, d = 200) => `aevalsrc='if(lt(mod(${expr}\\,10)\\,0.05)\\,sin(2*PI*1000*t)\\,0)':s=44100:d=${d}`;
  return {
    // The sound track starts 0.3 s after the picture (before the fix: every beep 300 ms early).
    lateAudio: mk('late_audio.mkv', ['-f', 'lavfi', '-i', flash(25, 0), '-itsoffset', '0.3', '-f', 'lavfi', '-i', beep('t+0.3'), '-map', '0', '-map', '1', '-g', '50']),
    // The picture starts 0.4 s after the sound.
    lateVideo: mk('late_video.mkv', ['-itsoffset', '0.4', '-f', 'lavfi', '-i', flash(25, 0.4), '-f', 'lavfi', '-i', beep('t'), '-map', '0', '-map', '1', '-g', '50']),
    // 29.97 fps; the sound has a 0.5 s timestamp gap at 50 s (before the fix: 500 ms early from there on).
    gapAudio: mk('gap_audio.mkv', ['-f', 'lavfi', '-i', flash('30000/1001', 0), '-f', 'lavfi', '-i', `${beep('t+if(gte(t\\,50)\\,0.5\\,0)', 199.5)},asetpts='if(gte(T\\,50)\\,PTS+0.5/TB\\,PTS)'`, '-map', '0', '-map', '1', '-g', '60']),
  };
}

/** A stream driven like the webview: a 'more' after every batch. Collects packets and sound per gen. */
function driver(tools, file, pr, opts = {}) {
  const st = { gen: 0, video: [], audio: [], seeked: [], logs: [], eof: false, fails: [], limit: 1 << 20 };
  let onEof = () => {};
  st.ended = () => new Promise((r) => { onEof = r; });
  const rs = new RemoteStream({
    tools, file, probed: pr, maxHeight: 180, log: (m) => st.logs.push(m), onFail: (e) => st.fails.push(e), ...opts,
    post: async (m) => {
      if (m.type === 'seeked') { st.seeked.push(m); if (m.gen === st.gen) setImmediate(() => st.more()); }
      if (m.type !== 'batch' || m.gen !== st.gen) return;
      const raw = m.audio;
      st.audioBytes = (st.audioBytes || 0) + raw.reduce((n, a) => n + (a.data ? a.data.byteLength : a.packets.reduce((x, p) => x + p.length, 19)), 0);
      try {
        m.audio = raw.some((a) => a.kind === 'opus') ? await remoteAudio.decode(raw) : remoteAudio.pcm(raw);
      } catch (e) { st.fails.push(e.message); onEof(); return; }
      if (m.gen !== st.gen) return;
      st.video.push(...m.video);
      st.audio.push(...m.audio);
      if (m.eof) { st.eof = true; onEof(); return; }
      // How far the sound sent runs ahead of the picture sent (capped at 2 s while ffmpeg runs).
      const lv = st.video[st.video.length - 1];
      const la = st.audio[st.audio.length - 1];
      if (lv && la && !rs.videoEnded) st.maxLead = Math.max(st.maxLead || 0, la.t + la.planes[0].length / la.sampleRate - lv.t);
      if (st.holdAt !== undefined && st.video.length && st.video[st.video.length - 1].t >= st.holdAt) { st.hold = true; st.holdAt = undefined; }
      if (!st.hold) setImmediate(() => st.more());
    },
  });
  st.rs = rs;
  st.more = () => rs.handle({ type: 'more', gen: st.gen, limit: st.limit });
  st.seek = (t) => { st.gen++; st.video = []; st.audio = []; rs.handle({ type: 'seek', gen: st.gen, t }); };
  return st;
}

function checkAudio(audio, frames, checkBatchLimit = false) {
  let n = 0;
  for (const a of audio) {
    assert.ok(Math.abs(a.t - n / 48000) < 1e-9, `PCM continuous at sample ${n}, got ${a.t} s`);
    if (checkBatchLimit) assert.ok((a.planes[0].byteLength + a.planes[1].byteLength) / 2 <= 256 * 1024, 'bounded PCM tail message');
    n += a.planes[0].length;
  }
  assert.strictEqual(n, frames, 'all PCM samples delivered');
}

/** Flash times (from the H.264, decoded again by ffmpeg) and beep onsets (from the PCM). */
function marks(video, audio) {
  const d = spawnSync('ffmpeg', ['-v', 'error', '-f', 'h264', '-i', '-', '-vf', 'scale=1:1,format=gray', '-f', 'rawvideo', '-'], { input: Buffer.concat(video.map((p) => Buffer.from(p.data))), maxBuffer: 1 << 28 });
  const lum = d.stdout;
  assert.strictEqual(lum.length, video.length, 'one decoded frame per packet');
  const flashes = [];
  for (let i = 0; i < lum.length; i++) if (lum[i] > 120 && (i === 0 || lum[i - 1] <= 120)) flashes.push(video[i].t);
  const beeps = [];
  let last = -Infinity;
  for (const a of audio) {
    const l = a.planes[0];
    for (let i = 0; i < l.length; i++) {
      if (Math.abs(l[i]) <= 0.3) continue;
      const t = a.t + i / a.sampleRate;
      if (t - last > 1) beeps.push(t);
      last = t;
    }
  }
  return { flashes, beeps };
}

function checkSync(name, video, audio, fps, from) {
  const { flashes, beeps } = marks(video, audio);
  const offsets = flashes.map((f) => { const b = beeps.find((x) => Math.abs(x - f) < 1); return b === undefined ? null : b - f; });
  const paired = offsets.filter((o) => o !== null);
  assert.ok(paired.length >= (200 - from) / 10 - 3, `${name}: ${paired.length} flash/beep pairs (${JSON.stringify({ flashes, beeps })})`);
  // Within one frame everywhere (the flash lands on the first frame at or after the beep), and no drift.
  const worst = Math.max(...paired.map(Math.abs));
  assert.ok(worst <= 1 / fps + 0.002, `${name}: sound vs picture up to ${(worst * 1000).toFixed(0)} ms (${paired.map((o) => Math.round(o * 1000)).join(' ')})`);
  // Packets are 1/fps apart from the target frame on (the stream's own timestamps).
  for (let i = 1; i < video.length; i++) assert.ok(Math.abs(video[i].t - video[i - 1].t - 1 / fps) < 1e-6, `${name}: packet ${i} spacing`);
  return { pairs: paired.length, worstMs: Math.round(worst * 1000) };
}

async function withFfmpeg(tools) {
  const dir = path.join(os.tmpdir(), 'vpe-remotestream-test');
  fs.mkdirSync(dir, { recursive: true });
  const clips = makeClips(dir);
  const out = {};
  // 1. Sync over the whole 200 s, from the start and after a seek.
  for (const [k, file] of Object.entries(clips)) {
    const pr = await ff.probe(tools, file);
    for (const from of [0, 95.5]) {
      const st = driver(tools, file, pr);
      await st.rs.handle({ type: 'open' });
      const done = st.ended();
      if (from) st.seek(from); else st.rs.handle({ type: 'more', gen: 0, limit: 1 << 20 });
      await done;
      st.rs.dispose();
      assert.deepStrictEqual(st.fails, []);
      // Says what the stream did when it ended without a picture (seen once on the Windows runner).
      assert.ok(st.video.length, `${k} from ${from} s: EOF without picture packets (${st.audio.length} sound items; ${st.logs.join(' / ')})`);
      const idx = Math.floor(from * pr.video.fps + 1e-6);
      assert.ok(Math.abs(st.video[0].t - idx / pr.video.fps) < 1e-9 && st.video[0].key, `${k}: first packet is the target frame's IDR`);
      if (st.audio.length) assert.ok(Math.abs(st.audio[0].t - idx / pr.video.fps) < 1e-9, `${k}: sound starts at the target`);
      assert.ok((st.maxLead || 0) <= 2 + 2 / pr.video.fps, `${k}: sound sent ${st.maxLead} s ahead of the picture`);
      out[`${k}@${from}`] = checkSync(`${k} from ${from} s`, st.video, st.audio, pr.video.fps, from);
    }
  }
  const audioEncoder = process.env.VPE_RS_TEST_AUDIO_ENCODER || await rsm.audioEncoderFor(tools);
  out.audioEncoder = audioEncoder;
  if (audioEncoder) for (const [k, file] of Object.entries(clips)) {
    const pr = await ff.probe(tools, file);
    for (const from of [0, 95.5]) {
      console.log(`checking Opus ${k}@${from}`);
      const st = driver(tools, file, pr, { audioEncoder });
      await st.rs.handle({ type: 'open' });
      const done = st.ended();
      if (from) st.seek(from); else st.more();
      await done;
      st.rs.dispose();
      assert.deepStrictEqual(st.fails, []);
      const sync = checkSync(`Opus ${k}@${from}`, st.video, st.audio, pr.video.fps, from);
      const duration = st.audio.reduce((n, a) => n + a.planes[0].length / a.sampleRate, 0);
      const kbps = st.audioBytes * 8 / duration / 1000;
      assert.ok(kbps < rsm.OPUS_KBPS, `Opus payload ${kbps} kb/s`);
      out[`Opus ${k}@${from}`] = { ...sync, kbps: Math.round(kbps * 10) / 10 };
    }
  }
  if (audioEncoder) {
    const file = clips.lateAudio;
    const pr = await ff.probe(tools, file);
    const st = driver(tools, file, pr, { audioEncoder });
    try {
      st.holdAt = 3;
      await st.rs.open(); st.more();
      // Opus sound is sent in >= 0.5 s chunks and comes from its own ffmpeg, so on a slow runner the picture can
      // reach holdAt before any sound is ready. The host only answers a 'more', so a webview that is short of sound
      // asks again (as in section 2 below); a driver that stops asking at holdAt would wait for ever.
      await until(() => {
        if (st.hold && !st.audio.length) st.more();
        return st.hold && st.audio.length;
      }, 'Opus picture and sound before pause');
      const spawns = st.rs.spawns;
      st.hold = false; st.seek(2.519);
      await until(() => st.audio.length, 'Opus from memory');
      assert.strictEqual(st.rs.spawns, spawns);
      assert.strictEqual(st.audio[0].t, 2.48);
      st.holdAt = 1;
      st.seek(0);
      await until(() => st.audio.length, 'Opus loop to zero');
      assert.strictEqual(st.audio[0].t, 0);
      out.opusReuse = 'pause, memory seek, loop to zero';
    } finally { st.rs.dispose(); }
    // A runtime encoder failure refreshes from the playhead with s16 PCM, never silent audio.
    const fallback = driver(tools, file, pr, { audioEncoder: 'no-such-encoder' });
    const post = fallback.rs.post;
    fallback.rs.post = (m) => {
      if (m.type === 'refresh') { fallback.seek(1.24); return; }
      return post(m);
    };
    try {
      await fallback.rs.open(); fallback.more();
      await until(() => fallback.audio.length, 's16 after failed Opus encoder');
      assert.strictEqual(fallback.rs.audioEncoder, null);
      assert.strictEqual(fallback.audio[0].t, 1.24);
      assert.deepStrictEqual(fallback.fails, []);
      out.opusFallback = 's16 at the playhead';
    } finally { fallback.rs.dispose(); }
    // Ogg pages can span arbitrary stdout chunks. The final granule must remove padding.
    const encoded = spawnSync(tools.ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i',
      'sine=sample_rate=48000:duration=1.003', '-ac', '2', '-c:a', audioEncoder,
      '-strict', '-2', '-b:a', '96k', '-f', 'opus', '-']);
    assert.strictEqual(encoded.status, 0, String(encoded.stderr));
    const packets = [];
    const ogg = new (require('../../src/remoteopus').OggOpus)((p) => packets.push(p));
    for (const byte of encoded.stdout) ogg.push(Buffer.from([byte]));
    assert.strictEqual(packets.at(-1).s + packets.at(-1).n, Math.round(1.003 * 48000));
    assert.ok(packets[0].s < 0, 'encoder delay is explicit');
    out.opusGranule = 'fragmented pages, delay and final padding';
  }
  const file = clips.lateAudio;
  const pr = await ff.probe(tools, file);
  // 2. A seek back inside the two GOPs kept is served from memory: no new ffmpeg, from the keyframe before it.
  {
    const st = driver(tools, file, pr);
    st.limit = 8 * 1024; // a few frames per batch, as 1080p frames would be
    st.holdAt = 3; // the webview stops asking at 3 s (its queue is full)
    await st.rs.handle({ type: 'open' });
    st.rs.handle({ type: 'more', gen: 0, limit: st.limit });
    while (!st.hold) await sleep(20);
    await sleep(100);
    const spawns = st.rs.spawns;
    st.hold = false;
    st.seek(2.519); // 1 ms before the next frame: picture and PCM must use the same floor.
    // Picture and sound come from separate ffmpeg processes; on a busy machine the sound can be behind the
    // picture, and then its first batches follow the picture's. Wait for both (as the cold seek below does).
    await until(() => st.video.length >= 30 && st.audio.length, 'picture and sound after the seek from memory');
    assert.strictEqual(st.rs.spawns, spawns, 'seek back from memory: no restart');
    assert.ok(st.logs.some((l) => /from memory/.test(l)));
    assert.deepStrictEqual(st.seeked.at(-1), { type: 'seeked', gen: st.gen, t: 2.48 });
    assert.ok(st.video[0].key && st.video[0].t <= 2.5 + 1e-9 && st.video[0].t > 0.5, `from the keyframe before 2.5 s: ${st.video[0].t}`);
    assert.ok(Math.abs(st.audio[0].t - 2.48) < 1e-9, `sound from frame 62 (2.48 s): ${st.audio[0].t}`);
    // Contiguous from there.
    for (let i = 1; i < st.video.length; i++) assert.ok(Math.abs(st.video[i].t - st.video[i - 1].t - 1 / 25) < 1e-6, `contiguous after a seek from memory (${i})`);
    // Far forward: a restart.
    st.seek(150.039);
    await until(() => st.video.length && st.audio.length, 'cold seek picture and PCM');
    assert.strictEqual(st.rs.spawns, spawns + 1);
    assert.ok(Math.abs(st.video[0].t - 150) < 1e-9 && st.video[0].key);
    assert.deepStrictEqual(st.seeked.at(-1), { type: 'seeked', gen: st.gen, t: 150 });
    assert.strictEqual(st.audio[0].t, 150);
    // A step back before the stream's start: one restart REMOTE_STEP_BACK_LEAD_S (2.5 s) earlier (sound from the target), then steps back from memory.
    await sleep(300);
    st.hold = false;
    st.holdAt = 157; // paused: the webview reads 7 s past the shown frame (small packets) before it stops asking
    st.seek(149.97);
    for (let i = 0; !st.hold || !st.audio.length; i++) {
      assert.ok(i < 500, 'packets and sound after the step back');
      await sleep(20);
      if (st.hold && !st.audio.length) st.rs.handle({ type: 'more', gen: st.gen, limit: st.limit });
    }
    assert.strictEqual(st.rs.spawns, spawns + 2);
    const { REMOTE_STEP_BACK_LEAD_S } = require('../../src/stream');
    const expectedStart = (Math.floor(149.97 * 25 + 1e-6) - Math.round(25 * REMOTE_STEP_BACK_LEAD_S)) / 25;
    assert.ok(Math.abs(st.video[0].t - expectedStart) < 1e-9 && st.video[0].key, `stream from ${REMOTE_STEP_BACK_LEAD_S} s before: ${st.video[0].t}`);
    assert.ok(Math.abs(st.audio[0].t - 149.96) < 1e-9, `sound from the target: ${st.audio[0].t}`);
    await sleep(300);
    for (const t of [149.93, 149.89, 149.5, 148.0]) {
      st.seek(t);
      while (!st.video.length) await sleep(20);
      assert.ok(st.video[0].t <= t && st.video[0].key, `${t}: from a keyframe before`);
    }
    assert.strictEqual(st.rs.spawns, spawns + 2, 'steps back from memory');
    st.rs.dispose();
  }
  // 3. Scrubbing: 25 seeks 25 ms apart start ffmpeg only a few times; the last target is what comes.
  {
    const st = driver(tools, file, pr);
    await st.rs.handle({ type: 'open' });
    st.rs.handle({ type: 'more', gen: 0, limit: 1 << 20 });
    await sleep(300);
    const s0 = st.rs.spawns;
    for (let i = 0; i < 25; i++) { st.seek(20 + i * 5.3); await sleep(25); }
    const target = Math.floor((20 + 24 * 5.3) * 25 + 1e-6) / 25;
    const t0 = Date.now();
    while (!st.video.length && Date.now() - t0 < 5000) await sleep(10);
    const n = st.rs.spawns - s0;
    assert.ok(n <= 5, `${n} ffmpeg starts for 25 seeks`);
    assert.strictEqual(st.seeked.length, 25, 'every seek answered');
    // The stream for the last target either starts there or, when an earlier seek's ffmpeg had already read past it
    // (a busy machine runs the 25 ms sleeps late), comes from memory from the keyframe before it (2 s GOP, or a
    // scene-cut keyframe). Either way the webview gets the target frame.
    assert.ok(st.video[0].key && st.video[0].t <= target + 1e-9 && target - st.video[0].t <= 2 + 1e-9,
      `the last target: from ${st.video[0].t} for ${target}`);
    await until(() => st.video.some((p) => Math.abs(p.t - target) < 1e-9), `the frame at the last target ${target}`);
    out.scrub = { seeks: 25, starts: n, lastFrameMs: Date.now() - t0 };
    // 4. Nothing after dispose: no seek, more or start runs ffmpeg again.
    st.rs.dispose();
    const s1 = st.rs.spawns;
    st.seek(42);
    await st.rs.handle({ type: 'more', gen: st.gen });
    st.rs.startAt(10);
    await sleep(500);
    assert.strictEqual(st.rs.spawns, s1, 'no ffmpeg after dispose');
    assert.strictEqual(st.rs.proc, null);
  }
  // 5. A GPU encoder that fails (here VAAPI with no device) falls back to libx264 and the stream goes on.
  {
    let failedEnc = null;
    const st = driver(tools, file, pr, { encoder: 'h264_vaapi', device: path.join(dir, 'no-such-device'), onEncoderFail: (e) => { failedEnc = e; } });
    await st.rs.handle({ type: 'open' });
    st.rs.handle({ type: 'more', gen: 0, limit: 1 << 20 });
    const t0 = Date.now();
    while (st.video.length < 50 && Date.now() - t0 < 30000) await sleep(20);
    st.rs.dispose();
    assert.strictEqual(failedEnc, 'h264_vaapi');
    assert.strictEqual(st.rs.encoder, 'libx264');
    assert.deepStrictEqual(st.fails, []);
    assert.ok(st.video.length >= 50 && st.video[0].t === 0 && st.video[0].key, `${st.video.length} packets after the fallback`);
  }
  const tail = path.join(dir, 'short_picture_long_pcm.mkv');
  const made = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=25:d=1',
    '-f', 'lavfi', '-i', 'sine=frequency=1000:sample_rate=48000:duration=28', '-c:v', 'mpeg4', '-c:a', 'pcm_s16le', tail], { encoding: 'utf8' });
  assert.strictEqual(made.status, 0, made.stderr);
  const tailProbe = await ff.probe(tools, tail);
  // A pending read wakes when only PCM arrives. With reads withheld, host PCM stays bounded.
  {
    const st = driver(tools, tail, tailProbe);
    await st.rs.handle({ type: 'open' });
    const pcm = st.rs.audioProc.stdout;
    pcm.pause();
    st.more();
    await until(() => st.rs.videoEnded && st.rs.waiting, 'picture EOF independently of the held PCM pipe');
    assert.strictEqual(st.video.length, 25);
    st.hold = true;
    pcm.resume();
    await until(() => st.audio.length > 0, 'PCM wakes a pending read after picture EOF');
    await until(() => pcm.isPaused(), 'PCM backpressure with no renderer reads');
    const queued = (st.rs.aEnd - st.rs.aNext) * 4;
    assert.ok(queued >= 4 * 48000 * 4 && queued <= 4 * 48000 * 4 + 128 * 1024, `${queued} PCM bytes queued`);
    assert.strictEqual(st.eof, false);
    st.hold = false;
    st.more();
    await until(() => st.eof, 'EOF after all the PCM tail batches');
    checkAudio(st.audio, 28 * 48000, true);
    assert.ok(st.rs.aStore[0].s >= 7 * 48000, 'audio history rolls forward during a long tail');
    assert.deepStrictEqual(st.fails, []);
    st.rs.dispose();
    out.audioTail = '25 frames + 28 s PCM';
  }
  // Reproduce a hardware failure after some picture has been sent and PCM has only been read.
  // Use real libx264 output for the first child too, so the regression needs no working GPU.
  {
    const st = driver(tools, file, pr);
    st.holdAt = 0.5;
    await st.rs.handle({ type: 'open' });
    const audio = st.rs.audioProc;
    audio.stdout.pause();
    st.more();
    await until(() => st.hold, 'video sent before PCM');
    assert.strictEqual(st.rs.aNext, 0);
    audio.stdout.resume();
    await until(() => st.rs.aEnd >= 48000, 'PCM buffered across video restart point');
    st.rs.encoder = 'h264_nvenc'; // exercise the hardware retry on this real child's close event
    const next = st.video.length;
    st.rs.proc.kill("SIGKILL"); // SIGTERM is ignored by an ffmpeg blocked on a full pipe (Linux)
    await until(() => st.rs.spawns === 2, 'signal-killed GPU stream retries on CPU');
    assert.strictEqual(st.rs.audioProc, audio, 'the original PCM process survives the retry');
    st.hold = false;
    st.more();
    await until(() => st.video.length >= next + 5 && st.audio.length, 'picture and PCM after fallback');
    assert.ok(st.video[next].key && Math.abs(st.video[next].t - next / 25) < 1e-9, 'CPU splice starts at first unsent frame');
    assert.strictEqual(st.audio[0].t, 0, 'unsent audio before video splice is preserved');
    checkAudio(st.audio, st.rs.aNext);
    assert.deepStrictEqual(st.fails, []);
    st.rs.dispose();
    out.splice = 'contiguous video and PCM';
  }
  {
    const st = driver(tools, file, pr, { encoder: 'libx264' });
    await st.rs.handle({ type: 'open' });
    st.rs.proc.kill("SIGKILL"); // SIGTERM is ignored by an ffmpeg blocked on a full pipe (Linux)
    st.more();
    await until(() => st.fails.length, 'signal-killed CPU stream reports a failure');
    assert.match(st.fails[0], /signal SIGKILL/);
    assert.strictEqual(st.eof, false);
    st.rs.dispose();
    out.signal = 'failure, not EOF';
  }
  // 6. This machine's own ffmpeg: what the probe picks (informational: any answer is valid).
  const pick = await rsm.probeEncoder(tools.ffmpeg, ff.run);
  out.encoderHere = `${pick.encoder}${pick.device ? ` ${pick.device}` : ''} (${pick.tried.map((x) => `${x.encoder} ${x.ok ? 'ok' : 'no'}`).join(', ') || 'no GPU encoder built in'})`;
  if (pick.encoder !== 'libx264') {
    // The GPU encoder's stream is in sync too.
    const st = driver(tools, clips.gapAudio, await ff.probe(tools, clips.gapAudio), { encoder: pick.encoder, device: pick.device });
    await st.rs.handle({ type: 'open' });
    const done = st.ended();
    st.rs.handle({ type: 'more', gen: 0, limit: 1 << 20 });
    await done;
    st.rs.dispose();
    assert.strictEqual(st.rs.encoder, pick.encoder, 'no fallback');
    out[`gapAudio@0 ${pick.encoder}`] = checkSync(`gapAudio with ${pick.encoder}`, st.video, st.audio, 30000 / 1001, 0);
  }
  return out;
}

(async () => {
  unit();
  await probeFake();
  // VPE_RS_FFMPEG: another ffmpeg for the stream (e.g. one whose GPU encoder works with this driver).
  const tools = await ff.locateTools(process.env.VPE_RS_FFMPEG || '', '');
  if (!tools) { console.log('remotestream_test: ok (unit only; no ffmpeg on PATH)'); return; }
  const out = await withFfmpeg(tools);
  console.log(JSON.stringify(out));
  console.log('remotestream_test: ok');
})().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => remoteAudio.close());
