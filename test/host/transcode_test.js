'use strict';
// node test/host/transcode_test.js: pure unit tests for Live transcode (ADR 0002):
// pipeline args, capped VBR, SPS profile/level parsing, hardware-first/software-last probe,
// NVIDIA driver mismatch detection, setting migration, remote H.264 rules, and local stall policy.
const assert = require('assert');
const { EventEmitter } = require('events');
const path = require('path');
const args = require('../../src/transcode_args');
const probe = require('../../src/transcode_probe');
const policy = require('../../src/transcode_policy');
const setup = require('../../src/setup');
const ff = require('../../src/ffmpeg');
const { EncodedStream, stepBackStart, REMOTE_STEP_BACK_LEAD_S, STEP_BACK_LEAD_S } = require('../../src/stream');
const { historyKeepTime, REMOTE_HISTORY_S, HISTORY_S } = require('../../src/stream-buffer');
const { NativeDecoder } = require('../../src/native');
const controls = require('../../media/controls');
const { load: loadMockVscode } = require('./mock_vscode');

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
  assert.strictEqual(policy.resolveSetting({ transcode: 'auto', transcodeExplicit: false }), 'auto');
  assert.strictEqual(policy.resolveSetting({}), 'auto', 'the default is auto');
  // The retired 'ask' (stored by older versions) behaves as 'auto'; 'off' and 'always' stay as set.
  assert.strictEqual(policy.resolveSetting({ transcode: 'ask', transcodeExplicit: true }), 'auto');
  assert.strictEqual(policy.resolveSetting({ transcode: 'ask', transcodeExplicit: false }), 'auto');
  assert.strictEqual(policy.resolveSetting({ transcode: 'off', transcodeExplicit: true }), 'off');
  assert.deepStrictEqual(policy.MODES, ['auto', 'always', 'off']);

  // Remote SSH: high-bitrate 4K H.264 (20 Mb/s) qualifies; low-bitrate 1080p H.264 (3 Mb/s) stays direct.
  const h264High = { codec: 'h264', pixFmt: 'yuv420p', width: 3840, height: 2160, fps: 6, bitRate: 20e6 };
  const h264Low = { codec: 'h264', pixFmt: 'yuv420p', width: 1920, height: 1080, fps: 30, bitRate: 3e6 };
  assert.strictEqual(policy.shouldTranscodeOnOpen({ mode: 'auto', remote: 'ssh-remote', video: h264High }).action, 'stream');
  assert.strictEqual(policy.shouldTranscodeOnOpen({ mode: 'auto', remote: 'ssh-remote', video: h264Low }).action, 'skip');
  assert.strictEqual(policy.shouldTranscodeOnOpen({ mode: 'auto', remote: 'ssh-remote', video: h264Low, maxBitrateMbps: 2 }).action, 'stream', 'explicit cap below source bitrate triggers remote transcode');
  // No blocking ask step: a qualifying remote video streams at once; off never does.
  assert.strictEqual(policy.shouldTranscodeOnOpen({ mode: 'auto', remote: 'ssh-remote', video: h264High }).action, 'stream');
  assert.strictEqual(policy.shouldTranscodeOnOpen({ mode: 'off', remote: 'ssh-remote', video: h264High }).action, 'skip');
  // Locally, 8-bit H.264 always stays direct on WebCodecs.
  assert.strictEqual(policy.shouldTranscodeOnOpen({ mode: 'always', remote: undefined, video: h264High }).action, 'skip');
  // HDR -> SDR tone-mapping (research note Rank 2): remote links and `always` stream it when ffmpeg can tone-map;
  // a local or WSL window in auto keeps HDR on the exact native/WebGPU path.
  {
    const pq = { codec: 'hevc', pixFmt: 'yuv420p10le', width: 3840, height: 2160, fps: 30, colorTransfer: 'smpte2084' };
    const hlg = { ...pq, colorTransfer: 'arib-std-b67' };
    const dv81 = { ...pq, colorTransfer: '', dv: { profile: 8, compat: 1 } };
    const dv84 = { ...pq, colorTransfer: '', dv: { profile: 8, compat: 4 } };
    const dv5 = { ...pq, colorTransfer: '', colorSpace: 'ipt-c2', dv: { profile: 5, compat: 0 } };
    const cpu = { cpu: true, any: true };
    const act = (o) => policy.shouldTranscodeOnOpen({ mode: 'auto', toneMap: cpu, ...o });
    for (const v of [pq, hlg, dv81, dv84]) {
      const d = act({ remote: 'ssh-remote', video: v });
      assert.strictEqual(d.action, 'stream', `remote ${JSON.stringify(v)}`);
      assert.strictEqual(d.hdrTonemap, true);
      assert.strictEqual(act({ remote: 'ssh-remote', mode: 'always', video: v }).action, 'stream');
      assert.strictEqual(act({ remote: undefined, mode: 'always', video: v }).action, 'stream', 'always tone-maps locally too');
      assert.strictEqual(act({ remote: undefined, video: v }).action, 'skip', 'local auto keeps exact HDR');
      assert.strictEqual(act({ remote: 'wsl', video: v }).action, 'skip', 'WSL window counts as local');
      assert.strictEqual(act({ remote: 'ssh-remote', mode: 'off', video: v }).action, 'skip', 'off never streams');
      assert.strictEqual(act({ remote: 'ssh-remote', toneMap: { cpu: false, any: false }, video: v }).action, 'skip', 'no filter: no stream');
      assert.strictEqual(act({ remote: 'ssh-remote', toneMap: undefined, video: v }).action, 'skip');
      assert.strictEqual(act({ remote: 'ssh-remote', compare: true, video: v }).action, 'stream', 'Compare tone-maps remote HDR too');
    }
    assert.strictEqual(act({ remote: 'ssh-remote', mode: 'always', video: dv5 }).action, 'skip', 'Dolby Vision profile 5 stays skipped');
    assert.strictEqual(policy.isDvProfile5(dv5), true);
    assert.strictEqual(policy.isDvProfile5(dv81), false);
    // Local HDR is never moved to Live transcode by the stall detector.
    assert.strictEqual(policy.evaluateLocalStall({ mode: 'auto', slowWindows: 3, hostKeepsUp: true, playing: true, rate: 1, hidden: false, sinceEventMs: 2000, video: pq, alreadyTranscoding: false }), 'none');
  }

  // Local stall detector separates transfer bottleneck (hostKeepsUp=true) from decode bottleneck (hostKeepsUp=false).
  const baseStall = {
    mode: 'auto', slowWindows: 3, hostKeepsUp: true, playing: true, rate: 1, hidden: false,
    sinceEventMs: 2000, video: { codec: 'hevc', width: 3840, height: 2160, fps: 60 },
    alreadyTranscoding: false,
  };
  assert.strictEqual(policy.evaluateLocalStall(baseStall), 'switch', 'auto switches without asking');
  assert.strictEqual(policy.evaluateLocalStall({ ...baseStall, mode: 'off' }), 'none');
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

  // ---- Finding #4: Linux VA-API scale_vaapi filter discovery -> buildVideoPipeline ----
  {
    const sampleFilters = [
      'Filters:',
      ' ... scale_cuda        V->V       GPU accelerated video resizer',
      ' ... scale_vaapi       V->V       Scale to/from VAAPI surfaces.',
      ' ... vpp_qsv           V->V       Quick Sync Video "VPP"',
      ' ... volume            A->A       Change input volume.',
    ].join('\n');
    const found = ff.parseGpuFilters(sampleFilters);
    assert.ok(found.has('scale_vaapi') && found.has('scale_cuda') && found.has('vpp_qsv'));
    assert.ok(ff.TOOLS_CACHE_VER >= 2, 'tools cache version bumped to invalidate stale filter inventories');
    const pipe = args.buildVideoPipeline({
      encoder: 'h264_vaapi', device: '/dev/dri/renderD128', decodeMethod: 'vaapi', gpuFilters: found,
      video: { codec: 'hevc', pixFmt: 'yuv420p10le' }, w: 1920, h: 1080, fps: 30, maxKbps: 8000,
    });
    assert.strictEqual(pipe.mode, 'gpu-full');
    assert.strictEqual(pipe.vf, 'scale_vaapi=w=1920:h=1080:format=nv12');
  }

  // ---- Finding #5 & #9: LGPL no-CPU-encoder fallback + preserve NVENC driverNotice on fallback GPU ----
  assert.strictEqual(probe.cpuEncoder(' V..... mpeg4\n'), null, 'cpuEncoder returns null when neither libx264 nor libopenh264 is present');
  {
    const none = await probe.probeEncoder('ffmpeg', async (_cmd, a) => {
      if (a.includes('-encoders')) return { code: 0, stdout: ' V..... h264_nvenc\n', stderr: '' };
      return { code: 1, stdout: '', stderr: '[h264_nvenc @ 0] No capable devices found' };
    }, { platform: 'win32', nodes: [] });
    assert.strictEqual(none.encoder, null);
    assert.strictEqual(none.cpu, null);
  }
  {
    const fallbackGpu = await probe.probeEncoder('ffmpeg', async (_cmd, a) => {
      if (a.includes('-encoders')) return { code: 0, stdout: ' V..... h264_nvenc\n V..... h264_qsv\n', stderr: '' };
      if (a.includes('h264_nvenc')) {
        return { code: 1, stdout: '', stderr: '[h264_nvenc @ 0] Driver does not support the required nvenc API version. Required: 13.1 Found: 13.0\nThe minimum required Nvidia driver for nvenc is 610.00 or newer' };
      }
      return { code: 0, stdout: '', stderr: '' };
    }, { platform: 'win32', nodes: [] });
    assert.strictEqual(fallbackGpu.encoder, 'h264_qsv');
    assert.strictEqual(fallbackGpu.hw, true);
    assert.strictEqual(fallbackGpu.driverNotice && fallbackGpu.driverNotice.minDriver, '610.00', 'driverNotice preserved when fallback GPU succeeds');
  }

  // ---- Finding #7: Dolby Vision HDR exclusion even without PQ/HLG transfer tags ----
  {
    const dvNoTrc = { codec: 'hevc', pixFmt: 'yuv420p10le', width: 3840, height: 2160, fps: 30, colorTransfer: '', colorTrc: 0, dv: { profile: 5 } };
    assert.strictEqual(policy.isHdr(dvNoTrc), true);
    assert.strictEqual(policy.shouldTranscodeOnOpen({ mode: 'always', remote: 'ssh-remote', video: dvNoTrc }).action, 'skip');
    assert.strictEqual(policy.shouldTranscodeOnOpen({ mode: 'always', remote: undefined, video: dvNoTrc }).action, 'skip');
  }

  // ---- Finding #6: Bitrate Auto consistency & 250 kb/s floor ----
  {
    const source = { width: 3840, height: 2160, fps: 60 };
    const highRate = { ...source, codec: 'hevc', pixFmt: 'yuv420p' };
    const direct = { ...highRate, codec: 'h264' };
    assert.strictEqual(policy.shouldTranscodeOnOpen({ compare: true, mode: 'auto', video: highRate }).action, 'stream');
    assert.strictEqual(policy.shouldTranscodeOnOpen({ compare: true, mode: 'off', video: highRate }).action, 'skip');
    assert.strictEqual(policy.shouldTranscodeOnOpen({ compare: true, mode: 'auto', video: direct }).action, 'skip');
    assert.strictEqual(policy.shouldTranscodeOnOpen({ compare: true, mode: 'always', video: direct }).action, 'stream');
    const tile = { w: 1920, h: 1080, cols: 2, rows: 2 };
    const small = policy.compareTileSize(source, 2160, tile);
    assert.deepStrictEqual(small, { w: 960, h: 540, fps: 60 });
    assert.deepStrictEqual(policy.compareTileSize({ ...source, width: 2160, height: 3840 }, 3840, tile, true),
      { w: 540, h: 960, fps: 60 });
    const tiles = [small, { w: 3840, h: 2160, fps: 60, remote: true }];
    assert.deepStrictEqual(policy.compareCapsKbps(tiles, 10), [5000, 5000]);
    assert.deepStrictEqual(policy.compareCapsKbps(tiles, 10, false), [10000, 10000]);
    assert.deepStrictEqual(policy.compareCapsKbps(tiles, 0.3), [250, 250]);
    assert.deepStrictEqual(policy.compareCapsKbps(tiles, 0.1, false), [250, 250]);
    assert.deepStrictEqual(policy.compareCapsKbps(tiles, 0, true), [4000, 20000]);
    assert.deepStrictEqual(policy.compareCapsKbps(tiles, 0, false), [4000, 20000]);
    assert.deepStrictEqual(policy.compareCapsKbps([], 10), []);
    assert.strictEqual(policy.effectiveMaxKbps({ maxBitrateMbps: 0.1, w: 1280, h: 720, fps: 30, remote: false }), 250, 'floor 250 kb/s');
    const s = new EncodedStream({
      tools: {}, file: 'x.mkv', post: () => {}, log: () => {}, remote: false, encoder: 'h264_nvenc', cpuEncoder: null,
      probed: { duration: 10, video: { codec: 'hevc', width: 1280, height: 720, fps: 30 }, audio: null },
    });
    s.fps = 30;
    s.sizeVideo();
    assert.strictEqual(s.activeCapKbps(), 4000, 'local 720p30 Auto cap = 4000 kb/s');
    s.setMaxBitrateMbps(10);
    assert.strictEqual(s.activeCapKbps(), 10000);
    s.setMaxBitrateMbps(0);
    assert.strictEqual(s.activeCapKbps(), 4000, 'returning to Auto restores 4000 kb/s, not 20000');
    // Hardware encoder stays active across capped quality tiers (Finding #5).
    s.tier = 2;
    assert.strictEqual(s.videoEncoder, 'h264_nvenc');
    s.dispose();
  }

  // ---- Finding #2 & #8: setMaxKbps during deferred seek & while hidden, plus transcodeInfo refresh ----
  {
    const posts = [];
    let launches = [];
    const mkFakeProc = () => {
      const p = new EventEmitter();
      p.stdout = new EventEmitter();
      p.stdout.pause = () => {};
      p.stdout.resume = () => {};
      p.stdout.isPaused = () => false;
      p.stdout.destroy = () => {};
      p.stderr = new EventEmitter();
      p.err = { text: '' };
      p.kill = () => {};
      p.exitCode = null;
      p.signalCode = null;
      return p;
    };
    const hiddenPosts = [];
    const initiallyHidden = new EncodedStream({
      tools: {}, file: 'x.mkv', post: (m) => hiddenPosts.push(m), log: () => {}, hidden: true,
      encoder: 'h264_nvenc', cpuEncoder: null,
      probed: { duration: 30, video: { width: 1920, height: 1080, fps: 30 }, audio: { index: 1 } },
    });
    const starts = [];
    initiallyHidden.launch = (_, audio) => { starts.push(!!audio); return mkFakeProc(); };
    initiallyHidden.open();
    initiallyHidden.seek({ gen: 1, t: 0 });
    assert.ok(hiddenPosts.some((m) => m.type === 'streams'), 'hidden open still sends metadata');
    assert.deepStrictEqual(starts, [], 'hidden open launches neither video nor audio');
    initiallyHidden.setHidden(false);
    initiallyHidden.setHidden(false);
    initiallyHidden.seek({ gen: 2, t: 0 });
    assert.deepStrictEqual(starts, [false, true], 'first reveal starts video and audio once');
    initiallyHidden.dispose();

    const s = new EncodedStream({
      tools: {}, file: 'x.mkv', post: (m) => posts.push(m), log: () => {}, remote: false,
      encoder: 'h264_nvenc', cpuEncoder: null,
      probed: { duration: 30, video: { index: 0, codec: 'hevc', width: 1920, height: 1080, fps: 30 }, audio: { index: 1, codec: 'aac' } },
    });
    s.launch = (t, audio) => {
      const p = mkFakeProc();
      launches.push({ t, audio, cap: s.activeCapKbps(), proc: p });
      return p;
    };
    s.open();
    assert.strictEqual(launches.length, 2, 'open starts video + audio');

    // Deferred seek: rapid seek schedules startTimer; setMaxBitrateMbps must NOT spawn video alone.
    launches = [];
    s.lastSpawnAt = Date.now();
    s.lastSeekAt = Date.now();
    s.seek({ gen: 1, t: 10 });
    assert.ok(s.startTimer, 'seek is deferred');
    assert.strictEqual(s.proc, null);
    s.setMaxBitrateMbps(5);
    s.setCompareOutput(540, 5000);
    assert.strictEqual(launches.length, 0, 'setMaxBitrateMbps does not spawn video during deferred seek');
    assert.strictEqual(s.proc, null);
    // Fire deferred seek: both video (at new 5 Mb/s cap) and audio spawn together.
    clearTimeout(s.startTimer);
    s.startTimer = null;
    s.spawnNow();
    assert.strictEqual(launches.length, 2, 'deferred seek spawns both video and audio');
    assert.strictEqual(Boolean(launches[0].audio), false);
    assert.strictEqual(launches[0].cap, 5000);
    assert.strictEqual(launches[1].audio, true);
    assert.strictEqual(s.h, 540);

    // Finding #8: first output after restart emits refreshed transcodeInfo for ⓘ.
    posts.length = 0;
    launches[0].proc.stdout.emit('data', Buffer.from([0, 0, 1, 9, 0x10]));
    const ti = posts.find((m) => m.type === 'transcodeInfo');
    assert.ok(ti && ti.transcode && ti.transcode.maxKbps === 5000, 'transcodeInfo emitted on restart output');

    // Hidden tab: setMaxBitrateMbps must NOT restart video while hidden.
    launches = [];
    s.setHidden(true);
    s.setMaxBitrateMbps(10);
    s.setCompareOutput(360, 10000);
    assert.strictEqual(launches.length, 0, 'setMaxBitrateMbps does not restart while hidden');
    assert.strictEqual(s.activeCapKbps(), 10000, 'new cap stored for next unhide/seek');

    // Finding #5: when GPU encoder fails and cpuEncoder is null, stream fails cleanly to original decoder.
    let failedWhy = null;
    s.onFail = (w) => { failedWhy = w; };
    s.spawnNow();
    assert.strictEqual(s.h, 360);
    launches[0].proc.emit('close', 1, null);
    assert.ok(failedWhy, 'falls back via onFail when no CPU encoder is available');
    s.dispose();

    // The GPU accepts one stream but refuses a concurrent session. Only that tile retries on CPU.
    const live = [];
    const makeTile = () => {
      const tile = new EncodedStream({
        tools: {}, file: 'x.mkv', post: () => {}, log: () => {}, probed: { ...s.pr, audio: null },
        encoder: 'h264_nvenc', cpuEncoder: 'libx264',
      });
      tile.launch = () => {
        const proc = mkFakeProc();
        live.push({ encoder: tile.videoEncoder, proc });
        return proc;
      };
      tile.open();
      return tile;
    };
    const first = makeTile();
    const second = makeTile();
    live[1].proc.err.text = 'OpenEncodeSessionEx failed: out of memory';
    live[1].proc.emit('close', 1, null);
    assert.deepStrictEqual(live.map((p) => p.encoder), ['h264_nvenc', 'h264_nvenc', 'libx264']);
    assert.strictEqual(first.proc, live[0].proc);
    assert.strictEqual(second.proc, live[2].proc);
    first.dispose();
    second.dispose();
  }

  // ---- Finding #3: NativeDecoder.hostKeepsUp separates decode-bound 4K from transfer-limited 4K ----
  {
    const decodeBound = { frames: [], draining: false, proc: { stdout: { isPaused: () => false } }, lastBackpressureAt: 0 };
    assert.strictEqual(NativeDecoder.prototype.hostKeepsUp.call(decodeBound, 10000), false, 'decode-bound 4K is not transfer-limited');
    assert.strictEqual(policy.evaluateLocalStall({
      mode: 'auto', slowWindows: 3, hostKeepsUp: false, playing: true, rate: 1, hidden: false,
      sinceEventMs: 2000, video: { codec: 'hevc', width: 3840, height: 2160, fps: 60 },
      alreadyTranscoding: false,
    }), 'none');

    const transferLimited = { frames: [[], []], draining: false, proc: { stdout: { isPaused: () => false } }, lastBackpressureAt: 0 };
    assert.strictEqual(NativeDecoder.prototype.hostKeepsUp.call(transferLimited, 10000), true, 'queued frames => host keeps up');
    const recentBp = { frames: [], draining: false, proc: { stdout: { isPaused: () => false } }, lastBackpressureAt: 9000 };
    assert.strictEqual(NativeDecoder.prototype.hostKeepsUp.call(recentBp, 10000), true, 'recent backpressure => host keeps up');
  }

  // ---- Finding #10: Dispose during encoder probing installs no stream and posts nothing ----
  {
    const clip = path.join(__dirname, '..', '..', 'media', 'probe', 'hevc_10_2160.mkv');
    const tools = await ff.locateTools(process.env.VPE_FFMPEG || '', '');
    if (tools) {
      const hwMod = require('../../src/hardware');
      const origDetect = hwMod.detect;
      const origEncoderFor = probe.encoderFor;
      let resolveProbe;
      let probeCalled = false;
      hwMod.detect = async () => ({ os: process.platform, arch: process.arch, gpus: [], nvidiaDriver: null, vaapi: false });
      probe.encoderFor = () => new Promise((res) => { probeCalled = true; resolveProbe = res; });
      try {
        const h = loadMockVscode({ settings: { 'videoPreviewEnhanced.ffmpegPath': tools.ffmpeg, 'videoPreviewEnhanced.transcode': 'always' } });
        h.vscode.window.withProgress = async () => null;
        const s = h.open(clip);
        // Do not await s.send('ready') yet: it awaits our deferred encoderFor promise.
        const readyP = s.send({ type: 'ready' });
        for (let i = 0; i < 500 && !probeCalled; i++) await new Promise((r) => setTimeout(r, 20));
        assert.ok(probeCalled, 'encoderFor was invoked');
        const beforeDispose = s.posted.length;
        s.panel.dispose();
        resolveProbe({ encoder: 'libx264', hw: false, cpu: 'libx264', driverNotice: null });
        await readyP;
        await new Promise((r) => setTimeout(r, 40));
        assert.strictEqual(s.posted.length, beforeDispose, 'no messages posted after dispose');
        h.dispose();
      } finally {
        hwMod.detect = origDetect;
        probe.encoderFor = origEncoderFor;
      }
    }
  }

  // ---- Failed -encoders enumeration & legacy cached noGpu record invalidation ----
  {
    const fakeToolsFail = { ffmpeg: 'fake-fail-enum-ffmpeg', version: 'v-fail-1' };
    let calls = 0;
    const failRun = async () => { calls++; return { code: 1, stdout: '', stderr: 'boom' }; };
    const r1 = await probe.encoderFor(fakeToolsFail, failRun, null, () => {}, { platform: 'win32', nodes: [] });
    assert.strictEqual(r1.encoder, null, 'failed enumeration returns unavailable encoder (null), not libx264');
    assert.strictEqual(r1.hw, false);
    // Retry behavior retained: next call probes again rather than returning a permanent cached entry.
    const r2 = await probe.encoderFor(fakeToolsFail, async (_c, a) => {
      calls++;
      if (a.includes('-encoders')) return { code: 0, stdout: ' V..... libopenh264\n', stderr: '' };
      return { code: 1, stdout: '', stderr: '' };
    }, null, () => {}, { platform: 'win32', nodes: [] });
    assert.strictEqual(calls, 2, 'retried after failed enumeration');
    assert.strictEqual(r2.encoder, 'libopenh264');
  }
  {
    const fakeToolsLegacy = { ffmpeg: 'fake-legacy-nogpu-ffmpeg', version: 'v-legacy-1' };
    const key = probe.encoderCacheKey(fakeToolsLegacy);
    const bag = { [probe.ENCODER_KEY]: { [key]: { encoder: 'libx264', noGpu: true, at: 1 } } };
    const store = { get: (k) => bag[k], update: async (k, v) => { bag[k] = v; } };
    let probed = false;
    const r = await probe.encoderFor(fakeToolsLegacy, async (_c, a) => {
      probed = true;
      if (a.includes('-encoders')) return { code: 0, stdout: ' V..... mpeg4\n', stderr: '' };
      return { code: 1, stdout: '', stderr: '' };
    }, store, () => {}, { platform: 'win32', nodes: [] });
    assert.strictEqual(probed, true, 'legacy unversioned noGpu record is ignored and re-probed');
    assert.strictEqual(r.encoder, null);
    assert.strictEqual(bag[probe.ENCODER_KEY][key].v, probe.ENCODER_CACHE_VER, 'new cache record carries ENCODER_CACHE_VER');
  }

  // ---- Zoom-aware Compare tile sizing, SSH step-back lead/history, and Remote status chip ----
  {
    const src4k = { width: 3840, height: 2160, fps: 30 };
    const baseCell = { w: 1920, h: 1080, cols: 2, rows: 2 };
    assert.deepStrictEqual(policy.compareTileSize(src4k, 2160, { ...baseCell, factor: 1, zoom: 1 }), { w: 960, h: 540, fps: 30 });
    // Sub-threshold zoom (< 1.5) in Fit mode stays at cell size to avoid ffmpeg restarts.
    assert.deepStrictEqual(policy.compareTileSize(src4k, 2160, { ...baseCell, factor: 1.2, zoom: 1.2 }), { w: 960, h: 540, fps: 30 });
    // Zoom >= 1.5 upgrades resolution toward source, capped at source/maxHeight, while bitrate budget stays shared.
    const z2 = policy.compareTileSize(src4k, 2160, { ...baseCell, factor: 2, zoom: 2 });
    assert.deepStrictEqual(z2, { w: 1920, h: 1080, fps: 30 });
    const z4 = policy.compareTileSize(src4k, 2160, { ...baseCell, factor: 4, zoom: 4 });
    assert.deepStrictEqual(z4, { w: 3840, h: 2160, fps: 30 });
    assert.deepStrictEqual(policy.compareCapsKbps([z2, z2], 10, true), [5000, 5000], 'zoomed tiles stay within shared cap');
    // Zooming back to Fit steps down to base cell size.
    assert.deepStrictEqual(policy.compareTileSize(src4k, 2160, { ...baseCell, factor: 1, zoom: 1 }), { w: 960, h: 540, fps: 30 });

    // setCompareOutput with deferGrow returns true on height growth without spawning early.
    const s = new EncodedStream({
      tools: {}, file: 'x.mkv', post: () => {}, log: () => {}, remote: true, maxHeight: 540,
      encoder: 'h264_nvenc', cpuEncoder: null,
      probed: { duration: 30, video: { index: 0, codec: 'hevc', width: 3840, height: 2160, fps: 30 }, audio: null },
    });
    s.fps = 30;
    s.sizeVideo();
    assert.strictEqual(s.h, 540);
    let restarted = 0;
    s.restartVideo = () => { restarted++; };
    assert.strictEqual(s.setCompareOutput(1080, 5000, { deferGrow: true }), true, 'growth deferred for crisp refresh');
    assert.strictEqual(s.resizePending, true);
    assert.strictEqual(restarted, 0, 'no double restart on deferred growth');
    s.sizeVideo();
    assert.strictEqual(s.h, 1080);
    assert.strictEqual(s.setCompareOutput(540, 5000, { deferGrow: true }), false, 'shrink is not a deferred grow');
    s.dispose();

    // Host step-back lead & GOP history retention.
    assert.strictEqual(stepBackStart(9.5, { from: 10, base: 10, hasPackets: true, fps: 30, remote: false }), 9.5 - STEP_BACK_LEAD_S);
    assert.strictEqual(stepBackStart(9.5, { from: 10, base: 10, hasPackets: true, fps: 30, remote: true }), 9.5 - REMOTE_STEP_BACK_LEAD_S);
    assert.strictEqual(stepBackStart(2.0, { from: 10, base: 10, hasPackets: true, fps: 30, remote: true }), 2.0, 'far seek has no step-back lead');
    assert.strictEqual(historyKeepTime(40, 40, false), 40 - HISTORY_S);
    assert.strictEqual(historyKeepTime(40, 40, true), 40 - REMOTE_HISTORY_S);

    // Remote status chip state: remote-only, active-only, shows resolution/cap or adapting direction.
    assert.strictEqual(controls.remoteChipState({ remote: false, active: true, transcode: { h: 1080, maxKbps: 6000 } }).visible, false);
    assert.strictEqual(controls.remoteChipState({ remote: true, active: false }).visible, false);
    const activeChip = controls.remoteChipState({ remote: true, active: true, transcode: { h: 1080, maxKbps: 6000, tier: 0, label: 'NVENC' } });
    assert.strictEqual(activeChip.visible, true);
    assert.strictEqual(activeChip.text, 'Live · 1080p · 6 Mb/s');
    assert.strictEqual(activeChip.adapting, false);
    const adaptChip = controls.remoteChipState({ remote: true, active: true, transcode: { h: 720, maxKbps: 3000, tier: 1, adaptingDir: 'down' } });
    assert.strictEqual(adaptChip.text, 'Live · Adapting ↓');
    assert.strictEqual(adaptChip.adapting, true);
    const tieredChip = controls.remoteChipState({ remote: true, active: true, transcode: { h: 720, maxKbps: 3000, tier: 1 } });
    assert.strictEqual(tieredChip.text, 'Live · 720p ↓ · 3 Mb/s');
    assert.strictEqual(tieredChip.adapting, true);
  }

  // ---- HDR -> SDR tone-mapping: filter inventory, pipeline choice, label, info ----
  {
    const sample = [
      'Filters:',
      ' ... libplacebo        N->V       Apply various GPU filters from libplacebo',
      ' .S. tonemap           V->V       Conversion to/from different dynamic ranges.',
      ' ... tonemap_opencl    V->V       Perform HDR to SDR conversion with tonemapping.',
      ' ... tonemap_vaapi     V->V       VAAPI VPP for tone-mapping',
      ' .S. zscale            V->V       Apply resizing, colorspace and bit depth conversion.',
      ' ... hwupload          V->V       Upload a normal frame to a hardware frame',
      ' ... tonemap_cuda_x    V->V       not a known filter',
    ].join('\n');
    assert.deepStrictEqual([...ff.parseGpuFilters(sample)].sort(),
      ['hwupload', 'libplacebo', 'tonemap', 'tonemap_opencl', 'tonemap_vaapi', 'zscale']);
    assert.ok(ff.TOOLS_CACHE_VER >= 3, 'tools cache version bumped so old inventories re-probe for tone-mapping filters');
    assert.deepStrictEqual(args.toneMapSupport(new Set(['zscale', 'tonemap'])), { cpu: true, any: true });
    assert.deepStrictEqual(args.toneMapSupport(new Set(['zscale'])), { cpu: false, any: false }, 'zscale alone cannot tone-map');
    assert.deepStrictEqual(args.toneMapSupport(new Set(['tonemap_opencl'])), { cpu: false, any: false }, 'OpenCL needs hwupload and hwdownload');
    assert.strictEqual(args.toneMapSupport(new Set(['vpp_qsv'])).any, true);
    assert.strictEqual(args.toneMapSupport(new Set(['tonemap_vaapi'])).any, true);
    assert.strictEqual(args.toneMapSupport(new Set(['libplacebo'])).any, true);
    assert.strictEqual(args.toneMapSupport(null).any, false);

    const pq = { codec: 'hevc', pixFmt: 'yuv420p10le', colorTransfer: 'smpte2084', colorSpace: 'bt2020nc', width: 3840, height: 2160 };
    const hlg = { ...pq, colorTransfer: 'arib-std-b67' };
    const dv84 = { ...pq, colorTransfer: '', dv: { profile: 8, compat: 4 } };
    const sdr = { codec: 'hevc', pixFmt: 'yuv420p10le', colorTransfer: 'bt709', width: 3840, height: 2160 };
    const mk = (video, o) => args.buildVideoPipeline({ video, w: 1920, h: 1080, fps: 30, maxKbps: 8000, decodeMethod: 'none', ...o });
    const cpuSet = new Set(['zscale', 'tonemap', 'scale_cuda']);

    // CPU path: scale first, explicit BT.2020 input tags, hable, BT.709 limited out, pixel format for the encoder.
    const cpu = mk(pq, { encoder: 'libx264', gpuFilters: cpuSet });
    assert.strictEqual(cpu.tonemap, 'cpu');
    assert.strictEqual(cpu.mode, 'cpu');
    assert.ok(cpu.vf.startsWith('scale=1920:1080:flags=bilinear,zscale=tin=smpte2084:min=bt2020nc:pin=bt2020:rin=tv:t=linear:npl=100,format=gbrpf32le,'));
    assert.ok(cpu.vf.endsWith('zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p'), cpu.vf);
    assert.ok(mk(hlg, { encoder: 'libx264', gpuFilters: cpuSet }).vf.includes('zscale=tin=arib-std-b67:'), 'HLG input transfer');
    assert.ok(mk(dv84, { encoder: 'libx264', gpuFilters: cpuSet }).vf.includes('zscale=tin=arib-std-b67:'), 'DV 8.4 has an HLG base');
    // NVENC without tonemap_cuda (stock LGPL builds): CPU tone-map, never scale_cuda on HDR.
    const nv = mk(pq, { encoder: 'h264_nvenc', decodeMethod: 'cuda', gpuFilters: cpuSet });
    assert.strictEqual(nv.tonemap, 'cpu');
    assert.strictEqual(nv.mode, 'gpu-encode');
    assert.deepStrictEqual(nv.pre, []);
    assert.ok(!/scale_cuda/.test(nv.vf));
    assert.ok(mk(pq, { encoder: 'h264_amf', gpuFilters: cpuSet }).vf.endsWith(',format=nv12'), 'GPU encoders that want nv12');
    const vaCpu = mk(pq, { encoder: 'h264_vaapi', device: '/dev/dri/renderD129', gpuFilters: cpuSet });
    assert.deepStrictEqual(vaCpu.pre, ['-vaapi_device', '/dev/dri/renderD129']);
    assert.ok(vaCpu.vf.endsWith(',format=nv12,hwupload'), vaCpu.vf);
    // Hardware first, matched to the device.
    const qsvSet = new Set(['vpp_qsv', 'zscale', 'tonemap']);
    const qsv = mk(pq, { encoder: 'h264_qsv', decodeMethod: 'qsv', gpuFilters: qsvSet });
    assert.strictEqual(qsv.mode, 'gpu-full');
    assert.strictEqual(qsv.tonemap, 'qsv');
    assert.strictEqual(qsv.vf, 'vpp_qsv=w=1920:h=1080:format=nv12:tonemap=1');
    assert.strictEqual(mk(pq, { encoder: 'h264_qsv', decodeMethod: 'qsv', gpuFilters: qsvSet, badTonemap: new Set(['qsv']) }).tonemap, 'cpu', 'a failed path is skipped');
    const va = mk(pq, { encoder: 'h264_vaapi', decodeMethod: 'vaapi', gpuFilters: new Set(['scale_vaapi', 'tonemap_vaapi']) });
    assert.strictEqual(va.mode, 'gpu-full');
    assert.strictEqual(va.tonemap, 'vaapi');
    assert.strictEqual(va.vf, 'scale_vaapi=w=1920:h=1080,tonemap_vaapi=format=nv12:p=bt709:t=bt709:m=bt709');
    assert.strictEqual(mk(pq, { encoder: 'h264_vaapi', decodeMethod: 'vaapi', gpuFilters: new Set(['scale_vaapi', 'zscale', 'tonemap']) }).tonemap, 'cpu',
      'scale_vaapi without tonemap_vaapi must not ship un-mapped HDR');
    const lpSet = new Set(['libplacebo', 'zscale', 'tonemap']);
    const lp = mk(pq, { encoder: 'h264_nvenc', gpuFilters: lpSet });
    assert.strictEqual(lp.tonemap, 'libplacebo');
    assert.match(lp.vf, /^libplacebo=w=1920:h=1080:tonemapping=bt\.2390:colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv:format=yuv420p$/);
    assert.strictEqual(mk(pq, { encoder: 'libx264', gpuFilters: lpSet }).tonemap, 'cpu', 'software encode stays on the CPU path');
    const oclSet = new Set(['tonemap_opencl', 'hwupload', 'hwdownload', 'zscale', 'tonemap']);
    const ocl = mk(pq, { encoder: 'h264_nvenc', gpuFilters: oclSet });
    assert.strictEqual(ocl.tonemap, 'opencl');
    assert.deepStrictEqual(ocl.pre, ['-init_hw_device', 'opencl=ocl', '-filter_hw_device', 'ocl']);
    assert.match(ocl.vf, /hwupload,tonemap_opencl=tonemap=hable.*hwdownload,format=nv12,format=yuv420p$/);
    assert.strictEqual(mk(pq, { encoder: 'h264_nvenc', gpuFilters: new Set([...lpSet, ...oclSet]), badTonemap: new Set(['libplacebo']) }).tonemap, 'opencl');
    // Nothing available: refuse instead of shipping HDR code values as SDR.
    assert.throws(() => mk(pq, { encoder: 'libx264', gpuFilters: new Set(['scale_cuda']) }), /tone-mapping/);
    // SDR is unchanged.
    const plain = mk(sdr, { encoder: 'libx264', gpuFilters: cpuSet });
    assert.strictEqual(plain.tonemap, null);
    assert.strictEqual(plain.vf, 'scale=1920:1080:flags=bilinear,format=yuv420p');

    // Label and ⓘ info.
    assert.match(args.pipelineLabel({ encoder: 'libx264', mode: 'cpu', remote: true, w: 1920, h: 1080, fps: 30, hdrTonemap: true }), /8-bit, HDR → SDR tone-mapped, lossy/);
    assert.doesNotMatch(args.pipelineLabel({ encoder: 'libx264', mode: 'cpu', remote: true }), /tone-mapped/);
    const mkProc = () => {
      const p = new EventEmitter();
      p.stdout = new EventEmitter();
      p.stdout.pause = () => {};
      p.stdout.isPaused = () => false;
      p.stdout.destroy = () => {};
      p.stderr = new EventEmitter();
      p.err = { text: 'Error: tonemap failed' };
      p.kill = () => {};
      return p;
    };
    const posts = [];
    const hs = new EncodedStream({
      tools: { gpuFilters: new Set(['zscale', 'tonemap']) }, file: 'x.mp4', post: (m) => posts.push(m), log: () => {}, remote: true,
      encoder: 'libx264', cpuEncoder: 'libx264', probed: { duration: 5, video: { index: 0, ...pq, fps: 30 }, audio: null },
    });
    hs.launch = mkProc;
    hs.open();
    const info = posts.find((m) => m.type === 'streams').info.transcode;
    assert.strictEqual(info.hdrTonemap, true);
    assert.match(info.label, /HDR → SDR tone-mapped/);
    const full = hs.args(0, false);
    assert.strictEqual(full[full.indexOf('-color_trc') + 1], 'bt709');
    assert.strictEqual(full[full.indexOf('-color_primaries') + 1], 'bt709');
    assert.strictEqual(full[full.indexOf('-colorspace') + 1], 'bt709');
    assert.strictEqual(hs.transcodeInfo().tonemap, 'cpu');
    hs.dispose();
    // SDR streams carry no tone-map label.
    const sdrStream = new EncodedStream({
      tools: {}, file: 'x.mp4', post: () => {}, log: () => {}, remote: true, encoder: 'libx264', cpuEncoder: 'libx264',
      probed: { duration: 5, video: { index: 0, ...sdr, fps: 30 }, audio: null },
    });
    assert.strictEqual(sdrStream.transcodeInfo().hdrTonemap, false);
    assert.doesNotMatch(sdrStream.transcodeInfo().label, /tone-mapped/);
    sdrStream.dispose();
    // No tone-mapping filter at all: fails cleanly before any ffmpeg starts.
    let failed = null;
    let spawned = 0;
    const noTm = new EncodedStream({
      tools: { gpuFilters: new Set(['scale_cuda']) }, file: 'x.mp4', post: () => {}, log: () => {}, remote: true, encoder: 'libx264',
      cpuEncoder: 'libx264', onFail: (w) => { failed = w; }, probed: { duration: 5, video: { index: 0, ...pq, fps: 30 }, audio: null },
    });
    noTm.launch = () => { spawned++; return mkProc(); };
    noTm.open();
    assert.match(failed || '', /zscale and tonemap/);
    assert.strictEqual(spawned, 0);
    noTm.dispose();
    // A failing hardware tone-mapper drops to the next path (here QSV -> CPU) on the restart.
    const procs = [];
    const fb = new EncodedStream({
      tools: { gpuFilters: qsvSet }, file: 'x.mp4', post: () => {}, log: () => {}, remote: true, encoder: 'h264_qsv', cpuEncoder: 'libx264',
      decodeMethod: 'qsv', probed: { duration: 5, video: { index: 0, ...pq, fps: 30 }, audio: null },
    });
    fb.launch = (t, audio) => {
      const p = mkProc();
      procs.push(p);
      if (!audio) fb.args(t, false); // the real launch builds the arguments, which pick the path
      return p;
    };
    fb.open();
    assert.strictEqual(fb.tonemapKind, 'qsv');
    procs[0].emit('close', 1, null);
    assert.ok(fb.badTonemap.has('qsv'), 'the failed QSV tone-mapper is not tried again');
    assert.strictEqual(procs.length, 2, 'restarted once');
    assert.strictEqual(fb.tonemapKind, 'cpu');
    fb.dispose();
  }

  // ---- Real ffmpeg: the tone-map filtergraphs are accepted and give valid SDR H.264 (skipped without ffmpeg / LFS clips) ----
  {
    const { spawnSync } = require('child_process');
    const fs = require('fs');
    const os = require('os');
    const tools = await ff.locateTools(process.env.VPE_FFMPEG || '', '');
    const encs = tools ? spawnSync(tools.ffmpeg, ['-hide_banner', '-encoders'], { encoding: 'utf8' }).stdout || '' : '';
    const enc = /\blibx264\b/.test(encs) ? 'libx264' : /\blibopenh264\b/.test(encs) ? 'libopenh264' : null;
    const hasCpuTm = !!tools && tools.gpuFilters.has('zscale') && tools.gpuFilters.has('tonemap');
    if (!hasCpuTm || !enc) console.log('transcode_test: tone-map ffmpeg smoke skipped (needs ffmpeg with zscale, tonemap and an H.264 encoder)');
    else {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vpe-tm-'));
      try {
        for (const [name, trc] of [['hevc_10_pq_2160p.mp4', 'smpte2084'], ['hevc_10_hlg_2160p.mp4', 'arib-std-b67']]) {
          const clip = path.join(__dirname, '..', 'media', name);
          if (!fs.existsSync(clip) || fs.statSync(clip).size < 4096) { console.log(`transcode_test: ${name} not available (Git LFS), smoke skipped`); continue; }
          const pr = await ff.probe(tools, clip);
          assert.strictEqual(pr.video.colorTransfer, trc);
          assert.strictEqual(policy.isHdr(pr.video), true);
          const s = new EncodedStream({
            tools: { ffmpeg: tools.ffmpeg, gpuFilters: new Set(['zscale', 'tonemap']), legacy: tools.legacy }, file: clip, post: () => {}, log: () => {},
            remote: true, maxHeight: 540, encoder: enc, cpuEncoder: enc, probed: pr,
          });
          s.fps = pr.video.fps || 30;
          s.sizeVideo();
          // The real arguments, with the pipe replaced by a file and a few frames (the SDR tags are part of them).
          const a = s.args(0, false);
          assert.strictEqual(s.tonemapKind, 'cpu');
          const out = path.join(dir, `${name}.h264`);
          const r = spawnSync(tools.ffmpeg, [...a.slice(0, a.indexOf('pipe:1')), '-frames:v', '6', '-y', out], { encoding: 'utf8', timeout: 120000 });
          assert.strictEqual(r.status, 0, `${name}: ${r.stderr}`);
          const p = spawnSync(tools.ffprobe, ['-v', 'error', '-count_frames', '-select_streams', 'v:0',
            '-show_entries', 'stream=codec_name,pix_fmt,height,nb_read_frames', '-of', 'json', out], { encoding: 'utf8' });
          const st = JSON.parse(p.stdout).streams[0];
          assert.strictEqual(st.codec_name, 'h264', name);
          assert.strictEqual(st.pix_fmt, 'yuv420p');
          assert.strictEqual(st.height, 540);
          assert.strictEqual(Number(st.nb_read_frames), 6);
          s.dispose();
          // Hardware-matched paths (libplacebo, OpenCL) only where this host's ffmpeg has the filter and a device: a
          // host without the device must not fail the suite (the stream falls back at run time), so only report.
          const hwSet = [['libplacebo', ['libplacebo']], ['opencl', ['tonemap_opencl', 'hwupload', 'hwdownload']]];
          for (const [kind, need] of hwSet) {
            if (!need.every((f) => tools.gpuFilters.has(f))) continue;
            const pipe = args.buildVideoPipeline({ video: pr.video, encoder: 'h264_nvenc', decodeMethod: 'none', w: 960, h: 540, fps: 30, maxKbps: 4000,
              gpuFilters: new Set(need), badTonemap: new Set(kind === 'opencl' ? ['libplacebo'] : []) });
            assert.strictEqual(pipe.tonemap, kind);
            const hr = spawnSync(tools.ffmpeg, ['-hide_banner', '-v', 'error', ...pipe.pre, '-i', clip, '-frames:v', '3', '-vf', pipe.vf, '-c:v', enc, '-f', 'null', '-'],
              { encoding: 'utf8', timeout: 120000 });
            console.log(`transcode_test: ${kind} tone-map ${name}: ${hr.status === 0 ? 'accepted by this ffmpeg' : `not usable on this host (${(hr.stderr || '').trim().split('\n').pop()})`}`);
          }
        }
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    }
  }

  // ---- Direct Stream (Rank #4): eligibility, args, EncodedStream wiring, ABR fallback, real ffmpeg smoke ----
  {
    const baseH264 = { index: 0, codec: 'h264', pixFmt: 'yuv420p', depth: 8, width: 1920, height: 1080, fps: 30, bitRate: 5e6, rotation: 0 };
    assert.strictEqual(policy.canDirectStreamVideo(baseH264, { tier: 0, h: 1080, maxKbps: 0 }), true, '8-bit 4:2:0 SDR H.264 fits uncapped');
    assert.strictEqual(policy.canDirectStreamVideo({ ...baseH264, pixFmt: 'yuvj420p' }, { tier: 0, h: 1080, maxKbps: 8000 }), true, 'yuvj420p within cap');
    assert.strictEqual(policy.canDirectStreamVideo(baseH264, { tier: 0, h: 1080, maxKbps: 4000 }), false, 'source bitrate exceeds cap');
    assert.strictEqual(policy.canDirectStreamVideo(baseH264, { tier: 1, h: 1080, maxKbps: 0 }), false, 'ABR stepped-down tier');
    assert.strictEqual(policy.canDirectStreamVideo(baseH264, { tier: 0, h: 720, maxKbps: 0 }), false, 'downscale needed');
    assert.strictEqual(policy.canDirectStreamVideo({ ...baseH264, depth: 10 }, { tier: 0, h: 1080 }), false, '10-bit depth');
    assert.strictEqual(policy.canDirectStreamVideo({ ...baseH264, pixFmt: 'yuv420p10le' }, { tier: 0, h: 1080 }), false, '10-bit pixFmt');
    assert.strictEqual(policy.canDirectStreamVideo({ ...baseH264, pixFmt: 'yuv422p' }, { tier: 0, h: 1080 }), false, '4:2:2 chroma');
    assert.strictEqual(policy.canDirectStreamVideo({ ...baseH264, colorTrc: 16 }, { tier: 0, h: 1080 }), false, 'HDR PQ');
    assert.strictEqual(policy.canDirectStreamVideo({ ...baseH264, colorTransfer: 'arib-std-b67' }, { tier: 0, h: 1080 }), false, 'HDR HLG');
    assert.strictEqual(policy.canDirectStreamVideo({ ...baseH264, dv: { profile: 8 } }, { tier: 0, h: 1080 }), false, 'Dolby Vision');
    assert.strictEqual(policy.canDirectStreamVideo({ ...baseH264, codec: 'hevc' }, { tier: 0, h: 1080 }), false, 'HEVC');
    assert.strictEqual(policy.canDirectStreamVideo({ ...baseH264, rotation: 90 }, { tier: 0, h: 1080 }), false, 'rotated video');
    assert.strictEqual(policy.canDirectStreamVideo(baseH264, { tier: 0, h: 1080, rotation: 180 }), false, 'rotated opts');
    assert.strictEqual(policy.canDirectStreamVideo(null, {}), false, 'null video');

    // buildDirectStreamArgs & pipelineLabel
    const dsArgs0 = args.buildDirectStreamArgs({ file: 'clip.mp4', streamIndex: 0, startTime: 0 });
    assert.ok(dsArgs0.includes('-c:v') && dsArgs0[dsArgs0.indexOf('-c:v') + 1] === 'copy');
    assert.ok(dsArgs0.includes('-bsf:v') && dsArgs0[dsArgs0.indexOf('-bsf:v') + 1] === 'h264_mp4toannexb');
    assert.ok(dsArgs0.includes('-f') && dsArgs0[dsArgs0.indexOf('-f') + 1] === 'mpegts');
    assert.ok(dsArgs0.includes('-copyts') && dsArgs0.includes('-start_at_zero'));
    assert.ok(!dsArgs0.includes('-ss'), 'no -ss at startTime 0');
    const dsArgsSeek = args.buildDirectStreamArgs({ file: 'clip.mkv', streamIndex: 2, startTime: 5.5 });
    assert.ok(dsArgsSeek.includes('-ss'));
    assert.strictEqual(dsArgsSeek[dsArgsSeek.indexOf('-map') + 1], '0:2');
    const dsLabel = args.pipelineLabel({ encoder: 'copy', mode: 'direct-stream', remote: true, w: 1920, h: 1080, fps: 30 });
    assert.match(dsLabel, /Direct stream \(video copy\).*1920×1080 30 fps.*lossless/);
    assert.ok(!/lossy/i.test(dsLabel), 'Direct Stream label is not lossy');

    // EncodedStream wiring: Direct Stream at tier 0 -> re-encode on ABR step-down or tight cap -> runtime fallback
    const ds = new EncodedStream({
      tools: {}, file: 'clip.mp4', post: () => {}, log: () => {}, remote: true, maxHeight: 1080,
      encoder: 'h264_nvenc', cpuEncoder: 'libx264',
      probed: { duration: 10, video: baseH264, audio: { index: 1, codec: 'aac' } },
    });
    assert.strictEqual(ds.pipelineMode, 'direct-stream');
    assert.strictEqual(ds.videoEncoder, 'copy');
    assert.strictEqual(ds.lossy(), false, 'Direct Stream is lossless (suppresses lossy notice)');
    const info0 = ds.transcodeInfo();
    assert.strictEqual(info0.mode, 'direct-stream');
    assert.strictEqual(info0.encoder, 'copy');
    assert.strictEqual(info0.lossy, false);
    assert.match(info0.label, /Direct stream \(video copy\)/);
    const a0 = ds.args(0, false);
    assert.strictEqual(a0[a0.indexOf('-c:v') + 1], 'copy');
    // ABR step-down switches seamlessly to re-encoding.
    ds.tier = 1;
    ds.sizeVideo();
    const a1 = ds.args(0, false);
    assert.strictEqual(a1[a1.indexOf('-c:v') + 1], 'h264_nvenc');
    assert.strictEqual(ds.videoEncoder, 'h264_nvenc');
    assert.strictEqual(ds.lossy(), true);
    // Returning to tier 0 restores Direct Stream; tightening bitrate cap below source switches back to re-encoding.
    ds.tier = 0;
    ds.sizeVideo();
    assert.strictEqual(ds.args(0, false)[ds.args(0, false).indexOf('-c:v') + 1], 'copy');
    assert.strictEqual(ds.lossy(), false);
    ds.setMaxBitrateMbps(2);
    assert.strictEqual(ds.args(0, false)[ds.args(0, false).indexOf('-c:v') + 1], 'h264_nvenc');
    assert.strictEqual(ds.lossy(), true);
    ds.dispose();

    // Real-ffmpeg smoke test on test/media/h264_8_1080p.mp4 and test/media/containers/h264_aac.mkv (both have B-frames).
    const tools = await ff.locateTools(process.env.VPE_FFMPEG || '', '');
    if (tools) {
      const clips = [
        path.join(__dirname, '..', 'media', 'h264_8_1080p.mp4'),
        path.join(__dirname, '..', 'media', 'containers', 'h264_aac.mkv'),
      ];
      for (const clip of clips) {
        const pr = await ff.probe(tools, clip);
        const packets = [];
        const fails = [];
        let done;
        const ended = new Promise((r) => { done = r; });
        const st = new EncodedStream({
          tools, file: clip, probed: pr, remote: true, maxHeight: 1080,
          encoder: 'libx264', cpuEncoder: 'libx264',
          log: () => {}, onFail: (e) => { fails.push(e); done(); },
          post: (m) => {
            if (m.type === 'batch') {
              packets.push(...m.video);
              if (m.eof) done();
              else setImmediate(() => st.handle({ type: 'more', gen: 0, limit: 1 << 20 }));
            }
          },
        });
        assert.strictEqual(st.pipelineMode, 'direct-stream', `${path.basename(clip)} uses direct-stream`);
        assert.strictEqual(st.videoEncoder, 'copy');
        assert.strictEqual(st.lossy(), false);
        st.open();
        st.handle({ type: 'more', gen: 0, limit: 1 << 20 });
        await ended;
        st.dispose();
        assert.deepStrictEqual(fails, [], `${path.basename(clip)} no failures`);
        assert.ok(packets.length >= 24, `${path.basename(clip)} delivered ${packets.length} packets`);
        assert.strictEqual(packets[0].key, true, `${path.basename(clip)} starts on IDR keyframe`);
        assert.ok(Math.abs(packets[0].t) < 0.01, `${path.basename(clip)} first packet PTS near 0 (got ${packets[0].t})`);
        assert.ok(args.parseSpsProfileLevel(packets[0].data), `${path.basename(clip)} keyframe carries in-band SPS`);
        // Verify B-frame PTS are preserved (non-monotonic decode order, distinct timestamps).
        const hasReorder = packets.some((p, i) => i > 0 && p.t < packets[i - 1].t);
        assert.strictEqual(hasReorder, true, `${path.basename(clip)} preserves real B-frame PTS order`);
      }
    }
  }

  console.log('transcode_test: ok');
})().catch((e) => { console.error(e); process.exit(1); });
