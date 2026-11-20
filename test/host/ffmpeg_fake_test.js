'use strict';
// node test/host/ffmpeg_fake_test.js: src/ffmpeg.js (run, locateTools, probe) against a faked child_process.spawn,
// so every ffprobe answer can be scripted: spawn that throws, a program that hangs (timeout kill), old and new
// ffmpeg versions, GPU filter detection, ffprobe next to ffmpeg, odd or hostile ffprobe JSON.
const assert = require('assert');
const cp = require('child_process');
const EventEmitter = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');

// A script: (cmd, args) -> { stdout, stderr, code, hang, error, throws }.
let script = () => ({ code: 0 });
const spawned = [];
const realSpawn = cp.spawn;
cp.spawn = (cmd, args, opts) => {
  spawned.push({ cmd, args, opts });
  const a = script(cmd, args);
  if (a.throws) throw new Error(a.throws);
  const p = new EventEmitter();
  p.stdout = new EventEmitter();
  p.stderr = new EventEmitter();
  p.killed = false;
  p.kill = () => { p.killed = true; setImmediate(() => p.emit('close', null)); };
  setImmediate(() => {
    if (a.error) { p.emit('error', new Error(a.error)); return; }
    if (a.stdout) p.stdout.emit('data', Buffer.from(a.stdout));
    if (a.stderr) p.stderr.emit('data', Buffer.from(a.stderr));
    if (!a.hang) p.emit('close', a.code === undefined ? 0 : a.code);
  });
  return p;
};
const ffPath = require.resolve('../../src/ffmpeg');
delete require.cache[ffPath];
const ff = require(ffPath);
cp.spawn = realSpawn;

const FILTERS = (names) => ` T.. split              V->N       Split\n${names.map((n) => ` .S. ${n.padEnd(20)} V->V       GPU filter`).join('\n')}\n ... scale_npp_not   V->V       other\n`;

(async () => {
  // ---- run -----------------------------------------------------------------------------
  script = () => { throw new Error('unused'); };
  script = () => ({ throws: 'EINVAL' });
  let r = await ff.run('x', []);
  assert.strictEqual(r.code, -1);
  assert.ok(/EINVAL/.test(r.stderr));
  script = () => ({ error: 'ENOENT' });
  r = await ff.run('x', []);
  assert.strictEqual(r.code, -1);
  assert.ok(/ENOENT/.test(r.stderr));
  script = () => ({ stdout: 'out', stderr: 'err', code: 3 });
  r = await ff.run('x', ['a']);
  assert.deepStrictEqual(r, { code: 3, stdout: 'out', stderr: 'err' });
  script = () => ({ hang: true });
  const t0 = Date.now();
  r = await ff.run('x', [], 100);
  assert.strictEqual(r.code, null, 'a killed program has no exit code');
  assert.ok(Date.now() - t0 < 3000);

  // ---- locateTools ---------------------------------------------------------------------
  const answers = (over = {}) => (cmd, args) => {
    const name = path.basename(cmd).replace(/\.exe$/i, '');
    if (/ffmpeg/.test(name) && args.includes('-filters')) return over.filters || { stdout: FILTERS(['scale_cuda', 'vpp_qsv']) };
    if (/ffmpeg/.test(name)) return over.ffmpeg || { stdout: 'ffmpeg version 7.1.1 Copyright (c) 2000-2025\nbuilt with gcc\n' };
    if (/ffprobe/.test(name)) return over.ffprobe || { stdout: 'ffprobe version 7.1.1\n' };
    return { code: 1 };
  };
  script = answers();
  let tools = await ff.locateTools('', '');
  assert.strictEqual(tools.ffmpeg, 'ffmpeg');
  assert.strictEqual(tools.ffprobe, 'ffprobe');
  assert.strictEqual(tools.version, 'ffmpeg version 7.1.1 Copyright (c) 2000-2025');
  assert.strictEqual(tools.legacy, false);
  assert.deepStrictEqual([...tools.gpuFilters].sort(), ['scale_cuda', 'vpp_qsv']);

  script = answers({ ffmpeg: { code: 1 } });
  assert.strictEqual(await ff.locateTools('', ''), null, 'ffmpeg does not run');
  script = answers({ ffprobe: { code: 1 } });
  assert.strictEqual(await ff.locateTools('', ''), null, 'ffprobe does not run');
  script = answers({ filters: { code: 1 } });
  assert.strictEqual((await ff.locateTools('', '')).gpuFilters.size, 0, 'a failing -filters call: no GPU filters, still usable');
  script = answers({ filters: { stdout: FILTERS(['scale_cuda_x', 'scale_npp']) } });
  assert.strictEqual((await ff.locateTools('', '')).gpuFilters.size, 0, 'only the exact filter names count');

  // Legacy detection: -vsync before ffmpeg 5.1.
  const ver = async (line) => { script = answers({ ffmpeg: { stdout: `${line}\n` } }); return (await ff.locateTools('', '')).legacy; };
  assert.strictEqual(await ver('ffmpeg version 4.4.2'), true);
  assert.strictEqual(await ver('ffmpeg version n4.4.2-1'), true);
  assert.strictEqual(await ver('ffmpeg version 5.0.1'), true);
  assert.strictEqual(await ver('ffmpeg version 5.1'), false);
  assert.strictEqual(await ver('ffmpeg version 6.0'), false);
  assert.strictEqual(await ver('ffmpeg version N-117000-gabcdef (git build)'), false, 'git builds are new');
  assert.strictEqual(await ver('ffmpeg version unknown'), false);
  assert.strictEqual(await ver(''), false);

  // Settings are used; ffprobe is taken from the folder of an absolute ffmpeg path when it is there.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vpe_ffm_'));
  try {
    const exe = process.platform === 'win32' ? '.exe' : '';
    const ffmpegAbs = path.join(dir, `ffmpeg${exe}`);
    script = answers();
    tools = await ff.locateTools(ffmpegAbs, '');
    assert.strictEqual(tools.ffprobe, 'ffprobe', 'no sibling: PATH ffprobe');
    const sibling = path.join(dir, `ffprobe${exe}`);
    fs.writeFileSync(sibling, '');
    tools = await ff.locateTools(ffmpegAbs, '');
    assert.strictEqual(tools.ffmpeg, ffmpegAbs);
    assert.strictEqual(tools.ffprobe, sibling, 'ffprobe next to ffmpeg');
    tools = await ff.locateTools(ffmpegAbs, 'my-ffprobe');
    assert.strictEqual(tools.ffprobe, 'my-ffprobe', 'an explicit ffprobe wins');
    tools = await ff.locateTools('relative-ffmpeg', '');
    assert.strictEqual(tools.ffprobe, 'ffprobe', 'a bare name is not searched for a sibling');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }

  // ---- probe ---------------------------------------------------------------------------
  const T = { ffprobe: 'ffprobe' };
  const probeWith = (json) => { script = () => ({ stdout: typeof json === 'string' ? json : JSON.stringify(json) }); return ff.probe(T, 'clip.mp4'); };
  let p = await probeWith({
    streams: [
      { index: 0, codec_type: 'video', codec_name: 'hevc', profile: 'Main 10', pix_fmt: 'yuv420p10le', width: 3840, height: 2160, avg_frame_rate: '30000/1001', nb_frames: '600', bit_rate: '20000000', color_space: 'bt2020nc', color_transfer: 'smpte2084', color_primaries: 'bt2020', field_order: 'progressive' },
      { index: 1, codec_type: 'audio', codec_name: 'aac', channels: 6, sample_rate: '48000' },
    ],
    format: { duration: '20.02', format_name: 'mov,mp4', format_long_name: 'QuickTime / MOV' },
  });
  assert.strictEqual(p.video.codec, 'hevc');
  assert.ok(Math.abs(p.video.fps - 29.97) < 0.001);
  assert.strictEqual(p.video.frames, 600);
  assert.strictEqual(p.video.bitRate, 20000000);
  assert.strictEqual(p.video.colorTransfer, 'smpte2084');
  assert.deepStrictEqual(p.audio, { index: 1, codec: 'aac', channels: 6, sampleRate: 48000, bitRate: 0 });
  assert.deepStrictEqual(p.counts, { audio: 1, sub: 0 });
  assert.strictEqual(p.duration, 20.02);
  assert.strictEqual(p.format, 'QuickTime / MOV');
  assert.strictEqual(p.formatName, 'mov,mp4');
  const call = spawned[spawned.length - 1];
  assert.ok(call.args.includes('-protocol_whitelist') && call.args[call.args.indexOf('-protocol_whitelist') + 1] === 'file', 'only local files');
  assert.strictEqual(call.args[call.args.length - 1], 'clip.mp4');

  // Frame rate: avg 0/0 falls back to r_frame_rate; absurd rates (>= 1000) and zero denominators are ignored; none: 30.
  const rate = async (s) => (await probeWith({ streams: [{ codec_type: 'video', ...s }], format: { duration: '10' } })).video.fps;
  assert.strictEqual(await rate({ avg_frame_rate: '0/0', r_frame_rate: '25/1' }), 25);
  assert.strictEqual(await rate({ avg_frame_rate: '90000/1', r_frame_rate: '24/1' }), 24, '90 kHz time base is not a frame rate');
  assert.strictEqual(await rate({ avg_frame_rate: '30/0', r_frame_rate: '24/1' }), 24, 'zero denominator');
  assert.strictEqual(await rate({ avg_frame_rate: 'x/y' }), 30, 'garbage: default 30');
  assert.strictEqual(await rate({}), 30);
  assert.strictEqual(await rate({ avg_frame_rate: '1000/1' }), 30, 'exactly 1000 is rejected');
  // Frames: nb_frames missing -> duration * fps; zero or text -> the same.
  p = await probeWith({ streams: [{ codec_type: 'video', avg_frame_rate: '25/1', nb_frames: 'N/A' }], format: { duration: '4' } });
  assert.strictEqual(p.video.frames, 100);
  // Duration from the stream when the format has none; none at all: 0 frames.
  p = await probeWith({ streams: [{ codec_type: 'video', avg_frame_rate: '25/1', duration: '2' }] });
  assert.strictEqual(p.duration, 2);
  assert.strictEqual(p.video.frames, 50);
  p = await probeWith({ streams: [{ codec_type: 'video' }] });
  assert.deepStrictEqual([p.duration, p.video.frames, p.format, p.formatName], [0, 0, '', '']);
  // Cover art (attached_pic) is not the video; the real video after it is.
  p = await probeWith({ streams: [
    { index: 0, codec_type: 'video', codec_name: 'mjpeg', disposition: { attached_pic: 1 } },
    { index: 1, codec_type: 'video', codec_name: 'h264', disposition: { attached_pic: 0 } }], format: {} });
  assert.strictEqual(p.video.codec, 'h264');
  // Audio-only file with cover art: no video.
  p = await probeWith({ streams: [{ index: 0, codec_type: 'video', codec_name: 'png', disposition: { attached_pic: 1 } }, { index: 1, codec_type: 'audio', codec_name: 'mp3', channels: 2, sample_rate: '44100' }], format: { duration: '200' } });
  assert.strictEqual(p.video, null);
  assert.strictEqual(p.audio.codec, 'mp3');
  // Bit rate: the file's minus the other streams' (Matroska gives none per stream), never negative.
  p = await probeWith({ streams: [{ index: 0, codec_type: 'video' }, { index: 1, codec_type: 'audio', bit_rate: '640000' }, { index: 2, codec_type: 'subtitle', bit_rate: 'N/A' }], format: { bit_rate: '8640000' } });
  assert.strictEqual(p.video.bitRate, 8000000);
  p = await probeWith({ streams: [{ index: 0, codec_type: 'video' }, { index: 1, codec_type: 'audio', bit_rate: '9000000' }], format: { bit_rate: '100' } });
  assert.strictEqual(p.video.bitRate, 0, 'never negative');
  p = await probeWith({ streams: [{ index: 0, codec_type: 'video', bit_rate: '-5' }], format: {} });
  assert.strictEqual(p.video.bitRate, 0);
  // Missing streams/format: nothing found, no throw. Audio sample rate missing: NaN-free? (Number(undefined) is NaN).
  p = await probeWith({});
  assert.deepStrictEqual([p.video, p.audio, p.duration], [null, null, 0]);
  p = await probeWith({ streams: [{ index: 0, codec_type: 'audio' }] });
  assert.strictEqual(p.audio.sampleRate, 0, 'a missing or N/A sample rate is 0, not NaN');
  // ffprobe failing or printing garbage.
  script = () => ({ code: 1, stderr: 'No such file\n' });
  await assert.rejects(ff.probe(T, 'x'), /ffprobe failed: No such file/);
  script = () => ({ code: 2 });
  await assert.rejects(ff.probe(T, 'x'), /ffprobe failed: 2/);
  await assert.rejects(probeWith('not json'), SyntaxError);
  await assert.rejects(probeWith(''), SyntaxError);
  console.log('ffmpeg fake: ok');
})().catch((e) => { console.error(e); process.exit(1); });
