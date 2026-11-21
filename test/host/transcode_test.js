'use strict';
// node test/host/transcode_test.js: pure unit tests for Live transcode (ADR 0002):
// pipeline args, capped VBR, SPS profile/level parsing, hardware-first/software-last probe,
// NVIDIA driver mismatch detection, setting migration, remote H.264 rules, and local stall policy.
const assert = require('assert');
const args = require('../../src/transcode_args');
const probe = require('../../src/transcode_probe');
const policy = require('../../src/transcode_policy');
const setup = require('../../src/setup');
const controls = require('../../media/controls');

// ---- setup.nvidiaLineMax ----
assert.strictEqual(setup.nvidiaLineMax(null), null);
assert.strictEqual(setup.nvidiaLineMax('610.00'), null);
assert.strictEqual(setup.nvidiaLineMax('615.20'), null);
assert.deepStrictEqual(setup.nvidiaLineMax('581.15'), { major: 8, minor: 1 });
assert.deepStrictEqual(setup.nvidiaLineMax('570.00'), { major: 8, minor: 1 });
assert.deepStrictEqual(setup.nvidiaLineMax('566.36'), { major: 7, minor: 1 });

// ---- transcode_args: encoderArgs & capped VBR ----
{
  const nv = args.encoderArgs('h264_nvenc', 60, 12000);
  assert.ok(nv.includes('-maxrate') && nv[nv.indexOf('-maxrate') + 1] === '12000k');
  assert.ok(nv.includes('-bufsize') && nv[nv.indexOf('-bufsize') + 1] === '12000k', 'strict maxrate = bufsize cap');
  assert.ok(nv.includes('-bf') && nv[nv.indexOf('-bf') + 1] === '0');
  assert.ok(nv.includes('-g') && nv[nv.indexOf('-g') + 1] === '120');

  const mf = args.encoderArgs('h264_mf', 30, 8000);
  assert.ok(mf.includes('-hw_encoding') && mf[mf.indexOf('-hw_encoding') + 1] === '1', 'h264_mf enforces hardware encoding');

  const vt = args.encoderArgs('h264_videotoolbox', 30, 10000);
  assert.ok(vt.includes('-realtime') && vt[vt.indexOf('-realtime') + 1] === 'true');
}

// ---- transcode_args: buildVideoPipeline (GPU decode -> GPU scale -> GPU encode vs fallback) ----
{
  const cuda = args.buildVideoPipeline({
    encoder: 'h264_nvenc', decodeMethod: 'cuda', gpuFilters: new Set(['scale_cuda']),
    video: { codec: 'hevc', pixFmt: 'yuv420p10le' }, w: 3840, h: 2160, fps: 60, maxKbps: 24000,
  });
  assert.strictEqual(cuda.mode, 'gpu-full');
  assert.deepStrictEqual(cuda.pre, ['-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda']);
  assert.strictEqual(cuda.vf, 'scale_cuda=w=3840:h=2160:format=nv12:interp_algo=bilinear');

  const qsv = args.buildVideoPipeline({
    encoder: 'h264_qsv', decodeMethod: 'qsv', gpuFilters: new Set(['vpp_qsv']),
    video: { codec: 'hevc', pixFmt: 'yuv420p10le' }, w: 1920, h: 1080, fps: 30, maxKbps: 10000,
  });
  assert.strictEqual(qsv.mode, 'gpu-full');
  assert.strictEqual(qsv.vf, 'vpp_qsv=w=1920:h=1080:format=nv12');

  const vaapi = args.buildVideoPipeline({
    encoder: 'h264_vaapi', device: '/dev/dri/renderD129', decodeMethod: 'vaapi', gpuFilters: new Set(['scale_vaapi']),
    video: { codec: 'hevc', pixFmt: 'yuv420p' }, w: 1920, h: 1080, fps: 30, maxKbps: 10000,
  });
  assert.strictEqual(vaapi.mode, 'gpu-full');
  assert.deepStrictEqual(vaapi.pre, ['-hwaccel', 'vaapi', '-hwaccel_device', '/dev/dri/renderD129', '-hwaccel_output_format', 'vaapi']);

  // Codec without CUDA decode (ProRes) falls back cleanly to CPU decode -> GPU encode.
  const prores = args.buildVideoPipeline({
    encoder: 'h264_nvenc', decodeMethod: 'cuda', gpuFilters: new Set(['scale_cuda']),
    video: { codec: 'prores', pixFmt: 'yuv422p10le' }, w: 1920, h: 1080, fps: 30, maxKbps: 12000,
  });
  assert.strictEqual(prores.mode, 'gpu-encode');
  assert.deepStrictEqual(prores.pre, []);
  assert.match(prores.vf, /^scale=1920:1080:flags=bilinear,format=yuv420p$/);

  // Software fallback
  const sw = args.buildVideoPipeline({
    encoder: 'libopenh264', decodeMethod: 'none', gpuFilters: null,
    video: { codec: 'hevc', pixFmt: 'yuv420p10le' }, w: 1280, h: 720, fps: 30, maxKbps: 5000,
  });
  assert.strictEqual(sw.mode, 'cpu');
}

// ---- transcode_args: H.264 levels & SPS parser ----
assert.strictEqual(args.defaultCodecLevel(3840, 2160, 60), 52, '4K60 -> level 5.2');
assert.strictEqual(args.defaultCodecLevel(3840, 2160, 30), 51, '4K30 -> level 5.1');
assert.strictEqual(args.defaultCodecLevel(1920, 1080, 60), 42, '1080p60 -> level 4.2');
assert.strictEqual(args.defaultCodecLevel(1920, 1080, 30), 40, '1080p30 -> level 4.0');

{
  // AUD (00 00 00 01 09 10) + SPS (00 00 00 01 67 64 00 34 ...) -> High@5.2 (avc1.640034)
  const au = new Uint8Array([0, 0, 0, 1, 0x09, 0x10, 0, 0, 0, 1, 0x67, 0x64, 0x00, 0x34, 0xac, 0xd9]);
  const sps = args.parseSpsProfileLevel(au);
  assert.deepStrictEqual(sps, { profileIdc: 0x64, constraintFlags: 0x00, levelIdc: 0x34, codecString: 'avc1.640034' });
  assert.strictEqual(args.parseSpsProfileLevel(new Uint8Array([0, 0, 1, 0x65, 0x88])), null);
}

// ---- transcode_probe: platform chain & NVIDIA driver mismatch ----
assert.deepStrictEqual(probe.platformEncoders('win32'), ['h264_nvenc', 'h264_qsv', 'h264_amf', 'h264_mf']);
assert.deepStrictEqual(probe.platformEncoders('darwin'), ['h264_videotoolbox']);
assert.deepStrictEqual(probe.platformEncoders('linux'), ['h264_nvenc', 'h264_vaapi']);

{
  const err = '[h264_nvenc @ 0000] Driver does not support the required nvenc API version. Required: 13.1 Found: 13.0\n[h264_nvenc @ 0000] The minimum required Nvidia driver for nvenc is 610.00 or newer';
  assert.deepStrictEqual(probe.parseNvencDriverError(err), { requiredApi: '13.1', foundApi: '13.0', minDriver: '610.00' });
  assert.strictEqual(probe.parseNvencDriverError('No capable devices found'), null);
}

(async () => {
  // Open-probe captures driverNotice when NVENC has API mismatch and falls back to software last resort.
  const r = await probe.probeEncoder('ffmpeg', async (_cmd, a) => {
    if (a.includes('-encoders')) return { code: 0, stdout: ' V..... h264_nvenc\n V..... libopenh264\n', stderr: '' };
    return { code: 1, stdout: '', stderr: '[h264_nvenc @ 0] Driver does not support the required nvenc API version. Required: 13.1 Found: 13.0\nThe minimum required Nvidia driver for nvenc is 610.00 or newer' };
  }, { platform: 'win32', nodes: [] });
  assert.strictEqual(r.encoder, 'libopenh264');
  assert.strictEqual(r.hw, false);
  assert.strictEqual(r.driverNotice.minDriver, '610.00');

  // ---- transcode_policy: migration, open decision, remote H.264, local stall ----
  assert.strictEqual(policy.resolveSetting({ transcode: 'ask', transcodeExplicit: false, remoteStream: 'off', remoteStreamExplicit: true }), 'off');
  assert.strictEqual(policy.resolveSetting({ transcode: 'ask', transcodeExplicit: false, remoteStream: 'on', remoteStreamExplicit: true }), 'always');
  assert.strictEqual(policy.resolveSetting({ transcode: 'auto', transcodeExplicit: true, remoteStream: 'off', remoteStreamExplicit: true }), 'auto');
  assert.strictEqual(policy.resolveSetting({ transcode: 'ask', transcodeExplicit: false }), 'ask');

  // Remote SSH: high-bitrate 4K H.264 (20 Mb/s) qualifies; low-bitrate 1080p H.264 (3 Mb/s) stays direct.
  const h264High = { codec: 'h264', pixFmt: 'yuv420p', width: 3840, height: 2160, fps: 6, bitRate: 20e6 };
  const h264Low = { codec: 'h264', pixFmt: 'yuv420p', width: 1920, height: 1080, fps: 30, bitRate: 3e6 };
  assert.strictEqual(policy.shouldTranscodeOnOpen({ mode: 'auto', remote: 'ssh-remote', video: h264High }).action, 'stream');
  assert.strictEqual(policy.shouldTranscodeOnOpen({ mode: 'auto', remote: 'ssh-remote', video: h264Low }).action, 'skip');
  assert.strictEqual(policy.shouldTranscodeOnOpen({ mode: 'auto', remote: 'ssh-remote', video: h264Low, maxBitrateMbps: 2 }).action, 'stream', 'explicit cap below source bitrate triggers remote transcode');
  assert.strictEqual(policy.shouldTranscodeOnOpen({ mode: 'ask', remote: 'ssh-remote', video: h264High }).action, 'prompt_remote');
  // Locally, 8-bit H.264 always stays direct on WebCodecs.
  assert.strictEqual(policy.shouldTranscodeOnOpen({ mode: 'always', remote: undefined, video: h264High }).action, 'skip');
  // HDR stays on exact/raw path in v1.
  assert.strictEqual(policy.shouldTranscodeOnOpen({ mode: 'always', remote: 'ssh-remote', video: { codec: 'hevc', pixFmt: 'yuv420p10le', width: 3840, height: 2160, colorTrc: 16 } }).action, 'skip');

  // Local stall detector separates transfer bottleneck (hostKeepsUp=true) from decode bottleneck (hostKeepsUp=false).
  const baseStall = {
    mode: 'ask', slowWindows: 3, hostKeepsUp: true, playing: true, rate: 1, hidden: false,
    sinceEventMs: 2000, video: { codec: 'hevc', width: 3840, height: 2160, fps: 60 },
    alreadyTranscoding: false, promptedThisSession: false,
  };
  assert.strictEqual(policy.evaluateLocalStall(baseStall), 'prompt');
  assert.strictEqual(policy.evaluateLocalStall({ ...baseStall, mode: 'auto' }), 'switch');
  assert.strictEqual(policy.evaluateLocalStall({ ...baseStall, hostKeepsUp: false }), 'none', 'decode bottleneck does not trigger transcode');
  assert.strictEqual(policy.evaluateLocalStall({ ...baseStall, slowWindows: 2 }), 'none');
  assert.strictEqual(policy.evaluateLocalStall({ ...baseStall, sinceEventMs: 1000 }), 'none');

  // Controls facts() surfaces transcode pipeline label in ⓘ.
  const label = args.pipelineLabel({ encoder: 'h264_nvenc', mode: 'gpu-full', remote: true, w: 3840, h: 2160, fps: 60, maxKbps: 10000 });
  assert.match(label, /remote machine.*GPU decode → NVIDIA NVENC.*3840×2160 60 fps.*max 10 Mb\/s/);
  const f = controls.facts({ name: 'a.mkv', remoteStream: true, native: true, info: { video: { codec: 'hevc' }, transcode: { label } } });
  const playedBy = (f.rows.find((row) => row[0] === 'Played by') || [])[1];
  assert.strictEqual(playedBy, label);

  console.log('transcode_test: ok');
})().catch((e) => { console.error(e); process.exit(1); });
