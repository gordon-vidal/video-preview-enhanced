'use strict';
// node test/host/probe_test.js: the ffmpeg probe's logic with a fake ffmpeg
// (src/probe.js, src/hwaccel.js): method order per platform and vendor, methods
// skipped where they can't decode, silent software fallback and wrong pictures
// detected, the method choice, and stored results invalidated by a new ffmpeg,
// GPU driver or the GPU switch.
const assert = require('assert');
const hw = require('../../src/hwaccel');
const probe = require('../../src/probe');

const intel = { vendor: 'intel', name: 'Intel(R) Graphics', driver: '31.0.101.5234' };
const nvidia = { vendor: 'nvidia', name: 'RTX 4070', driver: '581.15' };
const amd = { vendor: 'amd', name: 'Radeon 780M', driver: '32.0.1' };

// ---- order and skips ------------------------------------------------------------
assert.deepStrictEqual(hw.methodOrder({ os: 'win32', gpus: [intel] }), ['d3d11va', 'qsv', 'dxva2', 'none']);
assert.deepStrictEqual(hw.methodOrder({ os: 'win32', gpus: [intel, nvidia] }), ['d3d11va', 'qsv', 'cuda', 'dxva2', 'none']);
assert.deepStrictEqual(hw.methodOrder({ os: 'win32', gpus: [amd] }), ['d3d11va', 'dxva2', 'none'], 'no qsv/cuda without Intel/NVIDIA');
assert.deepStrictEqual(hw.methodOrder({ os: 'win32', gpus: [] }), ['d3d11va', 'dxva2', 'none'], 'detection failed: vendor-neutral only');
assert.deepStrictEqual(hw.methodOrder({ os: 'linux', gpus: [nvidia], vaapi: true }), ['vaapi', 'cuda', 'none']);
assert.deepStrictEqual(hw.methodOrder({ os: 'linux', gpus: [amd], vaapi: false }), ['none'], 'no render node: software');
assert.deepStrictEqual(hw.methodOrder({ os: 'darwin', gpus: [] }), ['videotoolbox', 'none']);
assert.strictEqual(hw.methodMayDecode('d3d11va', 'prores'), false);
assert.strictEqual(hw.methodMayDecode('videotoolbox', 'prores'), true);
assert.strictEqual(hw.methodMayDecode('none', 'prores'), true);

// ---- native output pipelines -----------------------------------------------------------
assert.deepStrictEqual(hw.inputArgs('none'), []);
assert.deepStrictEqual(hw.inputArgs('d3d11va'), ['-hwaccel', 'd3d11va']);
assert.deepStrictEqual(hw.inputArgs('qsv'), ['-hwaccel', 'qsv', '-hwaccel_output_format', 'qsv']);
assert.strictEqual(hw.videoFilter('d3d11va', 2560, 1440), 'scale=2560:1440:flags=bilinear,format=yuv420p');
assert.match(hw.videoFilter('qsv', 2560, 1440), /^vpp_qsv=w=2560:h=1440:format=nv12,hwdownload/);
const main10 = { codec: 'hevc', pixFmt: 'yuv420p10le' };
assert.strictEqual(hw.gpuFilter('cuda', new Set(['scale_cuda']), main10), 'scale_cuda');
assert.strictEqual(hw.gpuFilter('cuda', new Set(), main10), '', 'use CPU scaling without scale_cuda');
assert.strictEqual(hw.gpuFilter('cuda', new Set(['scale_cuda']), { ...main10, pixFmt: 'yuv420p' }), 'scale_cuda', '8-bit 4:2:0 too (NV12 split on the GPU)');
assert.strictEqual(hw.gpuFilter('cuda', new Set(['scale_cuda']), { ...main10, codec: 'h264', pixFmt: 'yuv420p' }), 'scale_cuda');
assert.strictEqual(hw.gpuFilter('cuda', new Set(['scale_cuda']), { ...main10, pixFmt: 'yuvj420p' }), '', 'full range keeps the CPU path');
assert.strictEqual(hw.gpuFilter('cuda', new Set(['scale_cuda']), { ...main10, codec: 'h264', pixFmt: 'yuv420p10le' }), '', 'no 10-bit H.264 on NVDEC');
assert.strictEqual(hw.gpuFilter('cuda', new Set(['scale_cuda']), { ...main10, pixFmt: 'yuv422p10le' }), '');
assert.match(hw.videoFilter('qsv', 2560, 1440, '', 10), /^hwdownload,format=p010le,scale=/);
assert.deepStrictEqual(probe.outSize('2160', 1440), [2560, 1440]);
assert.deepStrictEqual(probe.outSize('1080', 1440), [1920, 1080]);

// ---- silent fallback (lines from ffmpeg N-129000 -v verbose on an Intel iGPU) ----------
const graph = (fmt) => `[graph -1 input from stream 0:0 @ 000001b7d4ce8700] w:1920 h:1080 pixfmt:${fmt} tb:1/1000 fr:30/1 sar:1/1\n`;
assert.deepStrictEqual(hw.checkFallback('d3d11va', `[hevc @ 1] Decoder GUIDs reported as supported:\n${graph('p010le')}`), { hw: true, pixFmt: 'p010le', reason: '' });
assert.strictEqual(hw.checkFallback('qsv', graph('qsv')).hw, true);
let fb = hw.checkFallback('d3d11va', graph('yuv422p10le'));
assert.strictEqual(fb.hw, false, 'ProRes: planar frames = software');
assert.match(fb.reason, /yuv422p10le/);
fb = hw.checkFallback('dxva2', `[av1 @ 2] Failed setup for format dxva2_vld: hwaccel initialisation returned error.\n${graph('yuv420p')}`);
assert.strictEqual(fb.hw, false);
assert.match(fb.reason, /Failed setup for format dxva2_vld/);
assert.strictEqual(hw.checkFallback('cuda', '[CUDA @ 3] Cannot load nvcuda.dll\nDevice creation failed: -1.').hw, false);
assert.strictEqual(hw.checkFallback('cuda', graph('yuv444p')).hw, true, 'cuda 4:4:4 downloads as yuv444p');
assert.strictEqual(hw.checkFallback('d3d11va', '').hw, false, 'nothing decoded');

// ---- PSNR, classes ---------------------------------------------------------------------
const a = new Uint8Array(1000).fill(100);
assert.strictEqual(hw.psnr(a, a), Infinity);
assert.ok(hw.psnr(a, new Uint8Array(1000).fill(101)) > 45);
assert.ok(hw.psnr(a, new Uint8Array(1000).fill(20)) < 20, 'green frame far below');
assert.strictEqual(hw.classOf('hevc', 10, 3840, 2160), 'hevc/10/2160');
assert.strictEqual(hw.classOf('h264', 8, 1280, 720), 'h264/8/1080');
assert.strictEqual(hw.depthOf('yuv420p10le', 'hevc'), 10);
assert.strictEqual(hw.depthOf('yuv422p10le', 'prores'), 10);
assert.strictEqual(hw.depthOf('yuv420p', 'h264'), 8);

// ---- runProbe with a fake ffmpeg -------------------------------------------------------
const FRAME = 640 * 360 * 1.5;
const frame = (v) => Buffer.alloc(FRAME, v);
/**
 * A fake run: behaviour(method, file) = { fps, fallback, wrong, fail, slow }. Builds what ffRun
 * returns: per clip fps and check frame, the decoders' pixel formats in the log (one line per
 * input, rate CHECK_RATE + i), a failing decoder as `bad` (the clips after it not done).
 */
function fakeRun(behaviour, calls) {
  return async (method, items) => {
    calls.push({ method, files: items.map((it) => it.file) });
    const r = { code: 0, stderr: '', fps: [], checks: [], done: [], bad: -1, slow: false, aborted: false };
    let dead = false;
    items.forEach((it, i) => {
      const b = behaviour(method, it.file) || {};
      if (dead) { r.fps.push(0); r.checks.push(null); r.done.push(false); return; }
      if (b.fail) { r.bad = i; r.code = 69; r.stderr += `[vist#${i}:0/x @ 1] Error submitting packet to decoder: Function not implemented\n`; dead = true; r.fps.push(0); r.checks.push(null); r.done.push(false); return; }
      const fmt = method === 'none' || b.fallback ? 'yuv420p' : method === 'qsv' ? 'qsv' : 'nv12';
      r.stderr += `[graph 0 input from stream ${i}:0 @ 1] w:1920 h:1080 pixfmt:${fmt} tb:1/${probe.CHECK_RATE + i} fr:${probe.CHECK_RATE + i}/1 sar:1/1\n`;
      r.fps.push(b.fps || 0);
      r.checks.push(frame(b.wrong ? 10 : 128));
      r.done.push(true);
    });
    return r;
  };
}
const fakeRef = (calls) => async (files) => { calls.push({ method: 'reference', files }); return { code: 0, stderr: '', frames: files.map(() => frame(128)) }; };

(async () => {
  const tools = { ffmpeg: 'C:/ff/ffmpeg.exe', version: 'ffmpeg version 9.0' };
  const machine = { os: 'win32', gpus: [intel] };
  const clips = [
    { file: 'h264_8_1080.mkv', codec: 'h264', depth: 8, res: '1080', frames: 30 },
    { file: 'prores_10_1080.mkv', codec: 'prores', depth: 10, res: '1080', frames: 5 },
    { file: 'hevc_10_2160.mkv', codec: 'hevc', depth: 10, res: '2160', frames: 15 },
  ];
  const calls = [];
  const rec = await probe.runProbe({
    tools, hw: machine, clipDir: '/clips', clips, reference: fakeRef(calls),
    run: fakeRun((m, clip) => {
      if (/hevc_10_2160/.test(clip)) return { d3d11va: { fps: 40 }, qsv: { wrong: true, fps: 500 }, dxva2: { fallback: true, fps: 300 }, none: { fps: 90 } }[m];
      return { d3d11va: { fps: 100 }, qsv: { fps: 90 }, dxva2: { fps: 200 }, none: { fps: 600 } }[m];
    }, calls),
  });
  // One reference run, then one run per method and resolution (only the clips that still need it).
  assert.strictEqual(calls[0].method, 'reference');
  assert.strictEqual(calls[0].files.length, 3);
  const runsOf = (file) => calls.filter((c) => c.method !== 'reference' && c.files.includes(file)).map((c) => c.method);
  assert.deepStrictEqual(runsOf('h264_8_1080.mkv'), ['d3d11va', 'qsv', 'dxva2'], 'timed in the platform order until one reaches STOP_FPS (dxva2 200)');
  assert.deepStrictEqual(runsOf('prores_10_1080.mkv'), ['none'], 'ProRes: no GPU method tried');
  assert.ok(calls.every((c) => c.method === 'reference' || c.files.every((f) => f.includes('2160')) || c.files.every((f) => f.includes('1080'))), 'one resolution per run');
  // Choice: the first comfortable one in order, not the fastest.
  assert.strictEqual(rec.results['h264/8/1080'].method, 'd3d11va');
  assert.strictEqual(rec.results['h264/8/1080'].realtimeFactor, 3.33);
  assert.strictEqual(rec.results['h264/8/1080'].sw, 0, 'CPU not timed after dxva2 reached STOP_FPS');
  // Wrong picture and silent fallback are rejected; then the fastest that works (by HYSTERESIS).
  const h = rec.results['hevc/10/2160'];
  const qsv = h.tried.find((t) => t.method === 'qsv');
  assert.ok(!qsv.ok && /wrong picture/.test(qsv.error), 'qsv green frames rejected');
  const dx = h.tried.find((t) => t.method === 'dxva2');
  assert.ok(!dx.ok && dx.fallback, 'dxva2 software fallback rejected');
  assert.strictEqual(h.method, 'none', 'nothing comfortable: software 90 >= 1.3 x d3d11va 40');
  assert.ok(rec.complete);
  assert.ok(rec.results['hevc/10/2160'].bpp === 0, 'bpp: 0 when the clip file is missing');
  assert.match(probe.table(rec), /hevc\/10\/2160\s+none/);

  // A decoder that fails ends its run: it fails, the clips after it get another run.
  const callsF = [];
  const fl = await probe.runProbe({
    tools, hw: machine, clipDir: '/c', methods: ['dxva2', 'none'], reference: fakeRef(callsF),
    clips: [{ file: 'h264_8_2160.mkv', codec: 'h264', depth: 8, res: '2160', frames: 15 }, { file: 'av1_8_2160.mkv', codec: 'av1', depth: 8, res: '2160', frames: 15 }, { file: 'vp9_8_2160.mkv', codec: 'vp9', depth: 8, res: '2160', frames: 15 }],
    run: fakeRun((m, clip) => (m === 'dxva2' && /av1/.test(clip) ? { fail: true } : { fps: 130 }), callsF),
  });
  assert.deepStrictEqual(callsF.filter((c) => c.method === 'dxva2').map((c) => c.files), [['h264_8_2160.mkv', 'av1_8_2160.mkv', 'vp9_8_2160.mkv'], ['vp9_8_2160.mkv']]);
  assert.match(fl.results['av1/8/2160'].tried[0].error, /Function not implemented/);
  assert.strictEqual(fl.results['vp9/8/2160'].method, 'dxva2');
  assert.strictEqual(fl.results['av1/8/2160'].method, 'none');

  // 4K: GPU methods that failed or weren't comfortable at 1080p (same codec) are not tried; the CPU is.
  const calls4 = [];
  const four = await probe.runProbe({
    tools, hw: machine, clipDir: '/c', reference: fakeRef(calls4),
    clips: [{ file: 'av1_8_1080.mkv', codec: 'av1', depth: 8, res: '1080', frames: 30 }, { file: 'av1_8_2160.mkv', codec: 'av1', depth: 8, res: '2160', frames: 15 }],
    run: fakeRun((m, clip) => (/1080/.test(clip) ? { d3d11va: { fps: 110 }, qsv: { fps: 40 }, dxva2: { fail: true }, none: { fps: 100 } } : { d3d11va: { fps: 30 }, qsv: { fps: 20 }, dxva2: { fps: 20 }, none: { fps: 50 } })[m], calls4),
  });
  assert.deepStrictEqual([...new Set(calls4.filter((c) => c.files.includes('av1_8_2160.mkv')).map((c) => c.method))].sort(), ['d3d11va', 'none'], '4K skips qsv (40 fps at 1080p) and dxva2 (failed)');
  assert.strictEqual(four.results['av1/8/2160'].method, 'none');

  // pickMethod: first comfortable one in order; else a later one only when HYSTERESIS times faster.
  assert.strictEqual(probe.pickMethod([{ method: 'd3d11va', ok: true, fps: 61 }, { method: 'dxva2', ok: true, fps: 90 }]).method, 'd3d11va');
  assert.strictEqual(probe.pickMethod([{ method: 'd3d11va', ok: true, fps: 50 }, { method: 'dxva2', ok: true, fps: 61 }, { method: 'none', ok: true, fps: 300 }]).method, 'none', '61 < 1.3 x 50: no switch; 300 is');
  assert.strictEqual(probe.pickMethod([{ method: 'd3d11va', ok: true, fps: 50 }, { method: 'dxva2', ok: true, fps: 61 }]).method, 'd3d11va', 'within 30 %: the earlier one stays');
  assert.strictEqual(probe.pickMethod([{ method: 'd3d11va', ok: false, fps: 0 }]), null);

  // CPU only (gpuDecoding off): one method.
  const calls2 = [];
  const cpu = await probe.runProbe({ tools, hw: machine, clipDir: '/c', clips: clips.slice(0, 1), methods: ['none'], reference: fakeRef(calls2), run: fakeRun(() => ({ fps: 500 }), calls2) });
  assert.deepStrictEqual([...new Set(calls2.map((c) => c.method))], ['reference', 'none']);
  assert.notStrictEqual(cpu.fp, rec.fp, 'GPU switch is part of the fingerprint');

  // Cancel: stops, marked incomplete.
  const ac = new AbortController();
  const calls3 = [];
  const partial = await probe.runProbe({ tools, hw: machine, clipDir: '/c', clips, signal: ac.signal, reference: fakeRef(calls3), run: async (m, items) => { ac.abort(); return { ...(await fakeRun(() => ({ fps: 100 }), calls3)(m, items)), aborted: true }; } });
  assert.strictEqual(partial.complete, false);
  assert.strictEqual(calls3.length, 2, 'no run after the cancel');

  // ---- the run's arguments and result parsing ---------------------------------------------
  const items = [{ file: 'a.mkv', frames: 15, res: '2160' }, { file: 'b.mkv', frames: 15, res: '2160' }];
  const ra = probe.runArgs('qsv', items, [2560, 1440]).join(' ');
  assert.ok(ra.includes('-r 100 -hwaccel qsv -hwaccel_output_format qsv -stream_loop 1 -i a.mkv') && ra.includes('-r 101 '), ra);
  assert.ok(ra.includes('vpp_qsv=w=2560:h=1440') && ra.includes('concat=n=2:v=1:a=0') && ra.includes('select=eq(n\\,4)+eq(n\\,34)'), 'check frame 4 of each 30-frame segment');
  assert.ok(ra.includes('-map [out] -f null -') && ra.includes('-map [k] -f rawvideo pipe:3'));
  const os = require('os');
  const fs = require('fs');
  const dir = fs.mkdtempSync(require('path').join(os.tmpdir(), 'vpe-probe-test-'));
  const rl = probe.runArgs('none', items, [2560, 1440], dir);
  const list = rl[rl.indexOf('-i') + 1];
  assert.ok(rl.join(' ').includes('-f concat -safe 0 -i'), 'repeated by a concat list (no decoder flush)');
  assert.strictEqual(fs.readFileSync(list, 'utf8').split('\n').filter((l) => l.startsWith('file ')).length, 6, 'CPU segments 3x as long: 6 x 15 frames');
  fs.rmSync(dir, { recursive: true, force: true });
  assert.strictEqual(probe.segmentSpeed([0, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150]), 100, 'from frame SKIP_FRAMES on: 10 ms a frame');
  assert.strictEqual(probe.segmentSpeed([0, 1, 2]), 0, 'too few frames');
  const dec = probe.decodedPerInput('[in#1/concat @ 1]   Input stream #1:0 (video): 30 packets read (5 bytes); 0 frames decoded; 16 decode errors; \n[in#0/concat @ 2]   Input stream #0:0 (video): 30 packets read (5 bytes); 30 frames decoded; 0 decode errors; ');
  assert.deepStrictEqual(dec, { 0: { frames: 30, errors: 0 }, 1: { frames: 0, errors: 16 } });
  // Per input of a run with several: the pixel format line found by its rate even without its prefix.
  const lost = '[hevc @ 1]  103 106w:1920 h:1080 pixfmt:p010le tb:1/102 fr:102/1 sar:1/1\n';
  assert.strictEqual(hw.inputPixFmt(lost, 102), 'p010le');
  assert.strictEqual(hw.checkFallback('dxva2', `[av1 @ 3] Failed setup for format dxva2_vld\n${lost.replace('p010le', 'yuv420p')}`, { rate: 102, codec: 'av1' }).reason, 'Failed setup for format dxva2_vld');
  assert.strictEqual(hw.checkFallback('d3d11va', `[av1 @ 3] Failed setup for format dxva2_vld\n${lost}`, { rate: 102, codec: 'hevc' }).hw, true, "another input's warning doesn't count");
  // ---- storing and invalidation ---------------------------------------------------------
  const mem = new Map();
  const state = { get: (k) => mem.get(k), update: async (k, v) => { mem.set(k, v); } };
  await probe.save(state, rec);
  assert.ok(probe.stored(state, probe.fingerprint(tools, machine)), 'same ffmpeg and driver: reused');
  assert.strictEqual(probe.stored(state, probe.fingerprint({ ...tools, version: 'ffmpeg version 9.1' }, machine)), null, 'new ffmpeg: test again');
  assert.strictEqual(probe.stored(state, probe.fingerprint(tools, { os: 'win32', gpus: [{ ...intel, driver: '32.0.101.6000' }] })), null, 'driver update: test again');
  assert.strictEqual(probe.stored(state, probe.fingerprint({ ...tools, ffmpeg: 'D:/other/ffmpeg.exe' }, machine)), null, 'another ffmpeg: test again');
  assert.strictEqual(probe.stored(state, probe.fingerprint(tools, machine, false)), null, 'GPU decoding switched off: test again');
  await probe.save(state, partial);
  assert.strictEqual(probe.stored(state, partial.fp), null, 'an incomplete (cancelled) run is never used');
  console.log('probe: ok');
})().catch((e) => { console.error(e); process.exit(1); });
