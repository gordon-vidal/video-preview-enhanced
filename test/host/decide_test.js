'use strict';
// node test/host/decide_test.js: native ffmpeg or built-in, per file (src/decide.js):
// with ffmpeg everything but 8-bit H.264/VP8 goes native (docs/PRODUCT.md); remote
// windows, Restricted Mode, files native failed on, pixel tools; the method from probe
// results scaled to the file's size and frame rate; the speed records; the first-open
// popup; and the "set up ffmpeg" hint's throttling and wording.
const assert = require('assert');
const d = require('../../src/decide');
const hw = require('../../src/hwaccel');

// A probe record like this laptop's (Intel iGPU): GPU paths with download ~55-70 fps at 4K, CPU faster.
const tried = (list) => list.map(([method, fps]) => ({ method, ok: fps > 0, fps }));
const probe = {
  fp: 'x', complete: true,
  results: {
    'h264/8/1080': { method: 'd3d11va', fps: 163, tried: tried([['d3d11va', 163], ['qsv', 97], ['dxva2', 232], ['none', 586]]) },
    'hevc/10/1080': { method: 'd3d11va', fps: 110, tried: tried([['d3d11va', 110], ['qsv', 81], ['dxva2', 248], ['none', 591]]) },
    'hevc/10/2160': { method: 'dxva2', fps: 64, tried: tried([['d3d11va', 58], ['qsv', 43], ['dxva2', 64], ['none', 142]]) },
    'av1/8/2160': { method: 'none', fps: 20, tried: tried([['d3d11va', 0], ['none', 20]]) },
    'prores/10/1080': { method: 'none', fps: 293, tried: tried([['none', 293]]) },
    'vp9/8/1080': { method: 'qsv', fps: 118, tried: tried([['qsv', 118], ['none', 1262]]) },
  },
};
const v = (codec, pixFmt, width, height, fps = 30) => ({ codec, pixFmt, width, height, fps });
const base = { setting: 'auto', remote: undefined, trusted: true, tools: { ffmpeg: 'ffmpeg' }, probe, speeds: {}, failed: false, gpu: true };
const go = (over) => d.decide({ ...base, ...over });

// Reasons not to use ffmpeg.
assert.strictEqual(go({ setting: 'builtin', video: v('hevc', 'yuv420p10le', 3840, 2160) }).use, 'builtin');
assert.strictEqual(go({ tools: null, video: v('hevc', 'yuv420p10le', 3840, 2160) }).use, 'builtin');
assert.strictEqual(go({ trusted: false, video: v('hevc', 'yuv420p10le', 3840, 2160) }).use, 'builtin');
assert.match(go({ remote: 'ssh-remote', video: v('hevc', 'yuv420p10le', 3840, 2160) }).reason, /remote/);
assert.strictEqual(go({ remote: 'dev-container', video: v('hevc', 'yuv420p10le', 3840, 2160) }).use, 'builtin');
assert.strictEqual(go({ failed: true, video: v('hevc', 'yuv420p10le', 3840, 2160) }).use, 'builtin');
assert.strictEqual(go({ fullRes: true, video: v('hevc', 'yuv420p10le', 3840, 2160) }).use, 'builtin');
assert.strictEqual(go({ video: null }).use, 'builtin', 'sound only: built-in');
// WSL counts as local (frames at up to 720p); SSH never, not even with "ffmpeg".
assert.strictEqual(go({ remote: 'wsl', video: v('hevc', 'yuv420p10le', 3840, 2160) }).use, 'native', 'auto: WSL plays native');
assert.strictEqual(go({ setting: 'ffmpeg', remote: 'wsl', video: v('h264', 'yuv420p', 1920, 1080) }).use, 'native');
assert.strictEqual(go({ setting: 'ffmpeg', remote: 'ssh-remote', video: v('h264', 'yuv420p', 1920, 1080) }).use, 'builtin');

// 8-bit 4:2:0 H.264 and VP8 stay on the editor's GPU decoder; "ffmpeg" forces native for them too.
for (const [codec, pf] of [['h264', 'yuv420p'], ['h264', 'yuvj420p'], ['h264', undefined], ['vp8', 'yuv420p']]) {
  for (const [w, hgt] of [[1920, 1080], [3840, 2160]]) {
    const x = go({ video: v(codec, pf, w, hgt) });
    assert.strictEqual(x.use, 'builtin', `${codec} ${pf} ${hgt}p`);
    assert.match(x.reason, /GPU decoder \(WebCodecs\)/);
  }
}
let r = go({ setting: 'ffmpeg', video: v('h264', 'yuv420p', 1920, 1080) });
assert.deepStrictEqual([r.use, r.method], ['native', 'd3d11va']);
// Everything else: native, with the probe's method.
assert.strictEqual(go({ video: v('h264', 'yuv420p10le', 1920, 1080) }).use, 'native', 'H.264 High 10: not WebCodecs');
assert.strictEqual(go({ video: v('h264', 'yuv422p', 1920, 1080) }).use, 'native', 'H.264 4:2:2: not WebCodecs');
r = go({ video: v('hevc', 'yuv420p', 1280, 720) });
assert.strictEqual(r.use, 'native', 'light HEVC too: no size or speed rule any more');
r = go({ video: v('hevc', 'yuv420p10le', 3840, 2160) });
assert.deepStrictEqual([r.use, r.method], ['native', 'dxva2'], '4K HEVC 10-bit at 30 fps: first comfortable method (dxva2 64 >= 60)');
r = go({ video: v('hevc', 'yuv420p10le', 3840, 2160, 60) });
assert.deepStrictEqual([r.use, r.method], ['native', 'none'], '4K60: GPU paths too slow, CPU (142) is comfortable');
r = go({ video: v('hevc', 'yuv420p10le', 3840, 2160), gpu: false });
assert.deepStrictEqual([r.use, r.method], ['native', 'none'], 'gpuDecoding off: software only');
r = go({ video: v('av1', 'yuv420p', 3840, 2160), speeds: d.recordSpeed({}, { codec: 'av1', depth: 8, width: 3840, height: 2160, ratio: 0.9, realtime: false }) });
assert.strictEqual(r.use, 'native', 'no native-vs-built-in speed comparison any more');
// Before the GPU test ran: native with ffmpeg's own pick ('auto'), or the CPU with gpuDecoding off.
r = go({ probe: null, video: v('hevc', 'yuv420p', 1920, 1080) });
assert.deepStrictEqual([r.use, r.method], ['native', 'auto']);
assert.match(r.reason, /not run yet/);
assert.deepStrictEqual([go({ probe: null, gpu: false, video: v('prores', 'yuv422p10le', 1920, 1080) }).method], ['none']);
assert.strictEqual(go({ probe: null, video: v('h264', 'yuv420p', 1920, 1080) }).use, 'builtin');
assert.strictEqual(go({ probe: null, setting: 'ffmpeg', video: v('h264', 'yuv420p', 1920, 1080) }).method, 'auto');
// No GPU test, GPUs known (hardware.detect, no decoding): NVIDIA cuda (scale_cuda), Intel qsv, other Windows GPUs d3d11va, else ffmpeg's pick.
const gpus = (os, ...vendors) => ({ os, gpus: vendors.map((vendor) => ({ vendor, name: vendor })) });
r = go({ probe: null, hw: gpus('win32', 'nvidia'), video: v('hevc', 'yuv420p10le', 3840, 2160) });
assert.deepStrictEqual([r.use, r.method, r.guessed], ['native', 'cuda', true]);
assert.match(r.reason, /not run yet: cuda for this GPU/);
assert.strictEqual(go({ probe: null, hw: gpus('win32', 'intel', 'nvidia'), video: v('hevc', 'yuv420p10le', 3840, 2160) }).method, 'cuda', 'laptop with both: NVIDIA');
assert.strictEqual(go({ probe: null, hw: gpus('win32', 'intel'), video: v('hevc', 'yuv420p10le', 3840, 2160) }).method, 'qsv');
assert.strictEqual(go({ probe: null, hw: gpus('win32', 'amd'), video: v('hevc', 'yuv420p10le', 3840, 2160) }).method, 'd3d11va');
assert.strictEqual(go({ probe: null, hw: gpus('linux', 'nvidia'), video: v('av1', 'yuv420p10le', 3840, 2160) }).method, 'cuda');
assert.strictEqual(go({ probe: null, hw: gpus('linux', 'intel'), video: v('av1', 'yuv420p10le', 3840, 2160) }).method, 'auto');
assert.strictEqual(go({ probe: null, hw: gpus('darwin', 'apple'), video: v('hevc', 'yuv420p10le', 3840, 2160) }).method, 'auto');
assert.strictEqual(go({ probe: null, hw: { os: 'win32', gpus: [] }, video: v('hevc', 'yuv420p10le', 3840, 2160) }).method, 'auto', 'detection found nothing');
assert.strictEqual(go({ probe: null, hw: gpus('win32', 'nvidia'), setting: 'ffmpeg', video: v('h264', 'yuv420p', 1920, 1080) }).method, 'cuda');
assert.strictEqual(go({ probe: null, hw: gpus('win32', 'nvidia'), gpu: false, video: v('hevc', 'yuv420p10le', 3840, 2160) }).method, 'none', 'gpuDecoding off');
r = go({ hw: gpus('win32', 'nvidia'), video: v('hevc', 'yuv420p10le', 3840, 2160) });
assert.ok(!r.guessed, 'a GPU test result wins over the vendor');
assert.ok(d.webcodecsPlays(v('vp8', 'yuva420p', 640, 360)), 'VP8 with alpha: still WebCodecs');
assert.ok(!d.webcodecsPlays(v('vp9', 'yuv420p', 640, 360)));
// Sending frames to the editor caps native speed (150 MB/s): 4K60 at 1080p (3.1 MB) 48 fps, at 1440p 27.
assert.strictEqual(d.transportFps(v('hevc', 'yuv420p10le', 3840, 2160)), 48);
assert.strictEqual(d.transportFps(v('hevc', 'yuv420p10le', 3840, 2160), 1440), 27);
// The localhost frame server (400 MB/s counted, what a 4K player took): 4K at full size 32 fps, 1440p 72.
assert.strictEqual(d.transportFps(v('hevc', 'yuv420p10le', 3840, 2160), 2160, 'stream'), 32);
assert.strictEqual(d.transportFps(v('hevc', 'yuv420p10le', 3840, 2160), 1440, 'stream'), 72);
assert.strictEqual(d.FRAME_SERVER_HEIGHT, 2160);
// Automatic height over it: full size when the frame rate fits, else 1440p, at least 1080p.
assert.strictEqual(d.streamHeight(v('hevc', 'yuv420p10le', 3840, 2160, 30000 / 1001)), 2160, '4K30 in full');
assert.strictEqual(d.streamHeight(v('hevc', 'yuv420p10le', 3840, 2160, 60)), 1440, '4K60 at 1440p');
assert.strictEqual(d.streamHeight(v('hevc', 'yuv420p10le', 7680, 4320, 30)), 2160, '8K30 at 4K');
assert.strictEqual(d.streamHeight(v('hevc', 'yuv420p10le', 2560, 1440, 120)), 1080, '1440p120 at 1080p');
assert.strictEqual(d.streamHeight(v('hevc', 'yuv420p10le', 1920, 1080, 60)), 2160, '1080p60: its own size (cap above it)');
assert.strictEqual(d.streamHeight(null), 2160);
r = go({ video: v('hevc', 'yuv420p10le', 3840, 2160, 30), maxHeight: 2160, transport: 'stream' });
assert.match(r.reason, /ffmpeg \w+ ~\d+ fps \(probe hevc\/10\/2160/, `4K30 over the frame server: ${r.reason}`);
assert.ok(!/1080p/.test(r.reason), `4K30 over the frame server: ${r.reason}`);
r = go({ video: v('hevc', 'yuv420p10le', 3840, 2160, 60) });
assert.match(r.reason, /ffmpeg none ~48 fps \(probe hevc\/10\/2160, capped by sending 1080p frames/, `4K60 reason ${r.reason}`);
r = go({ video: v('hevc', 'yuv420p10le', 3840, 2160), maxHeight: 1440 });
assert.match(r.reason, /~27 fps .*capped by sending 1440p/, `4K30 at 1440p: ${r.reason}`);
// Another size: scaled by pixels (2560x1440 from the 1080p class: 110 fps x 2.07/3.69 MP).
const est = d.nativeEstimate(probe, v('hevc', 'yuv420p10le', 2560, 1440));
assert.ok(est.fps === 62 && est.method === 'd3d11va' && est.from === 'hevc/10/1080', `1440p estimate ${JSON.stringify(est)}`);
// Bit rate: software estimates scale down for a file heavier than the probe clip (bits per pixel), GPU ones don't.
const light = { fp: 'y', complete: true, results: { 'hevc/10/2160': { method: 'qsv', fps: 100, bpp: 0.004, tried: tried([['d3d11va', 55], ['qsv', 100], ['none', 250]]) } } };
const heavy4k = (bitRate, fps = 30) => ({ ...v('hevc', 'yuv420p10le', 3840, 2160, fps), bitRate });
// 12 Mb/s 4K30: 0.048 bpp, 12x the clip's: 250 x 12^-0.4 x 0.85 = 79 fps.
assert.strictEqual(hw.videoBpp(heavy4k(12e6)).toFixed(3), '0.048');
let e = d.nativeEstimate(light, heavy4k(12e6), false);
assert.ok(e.method === 'none' && e.fps === 79, `CPU estimate for a 12 Mb/s 4K file ${JSON.stringify(e)}`);
assert.strictEqual(hw.bitrateFactor('qsv', 0.004, heavy4k(12e6)), 1, 'GPU: not scaled');
assert.strictEqual(hw.bitrateFactor('none', 0.004, heavy4k(0.5e6)), 0.85, 'lighter than the clip: never faster than measured (margin only)');
assert.strictEqual(hw.bitrateFactor('none', undefined, heavy4k(12e6)), 1, 'older records without the clip bpp: not scaled');
assert.ok(Math.abs(hw.bitrateFactor('none', 0.004, { codec: 'hevc', width: 3840, height: 2160, fps: 30 }) - 0.85 * 15 ** -0.4) < 1e-9, 'unknown bit rate: TYPICAL_BPP');
// 60 Mb/s 4K60 (0.12 bpp): CPU 250 x 30^-0.4 x 0.85 = 54, far below 2x 60: qsv 100 is HYSTERESIS-better.
e = d.nativeEstimate(light, heavy4k(60e6, 60));
assert.deepStrictEqual([e.method, e.fps], ['qsv', 100]);
// Hysteresis: d3d11va 55 is not comfortable for 4K30 (needs 60); qsv 100 >= 1.3 x 55 replaces it, the CPU (79) doesn't replace qsv.
e = d.nativeEstimate(light, heavy4k(12e6));
assert.strictEqual(e.method, 'qsv');
const close = { results: { 'h264/8/2160': { method: 'd3d11va', fps: 50, bpp: 0.006, tried: tried([['d3d11va', 50], ['dxva2', 58], ['none', 150]]) } } };
e = d.nativeEstimate(close, { ...v('h264', 'yuv420p', 3840, 2160), bitRate: 18e6 });
assert.strictEqual(e.method, 'd3d11va', `dxva2 58 isn't 1.3x d3d11va 50, CPU ${JSON.stringify(e)} neither: the earlier method stays`);
// Missing class: the other resolution scaled (hevc 8-bit falls back to 10-bit numbers).
assert.ok(d.nativeEstimate(probe, v('hevc', 'yuv420p', 1920, 1080)));
// DNxHR estimated from ProRes.
assert.strictEqual(d.nativeEstimate(probe, v('dnxhd', 'yuv422p10le', 1920, 1080)).method, 'none');
// Unprobed codec: native with the common method (qsv excluded: it can't fall back).
r = go({ video: v('mpeg2video', 'yuv420p', 1920, 1080) });
assert.deepStrictEqual([r.use, r.method], ['native', 'd3d11va']);
assert.strictEqual(d.defaultMethod({ results: { 'vp9/8/1080': probe.results['vp9/8/1080'] } }), 'none', 'qsv-only class gives its next working method');

// ---- speed records ----------------------------------------------------------------
let s = d.recordSpeed({}, { codec: 'hevc', depth: 10, width: 3840, height: 2160, ratio: 0.4, realtime: false }, 1);
assert.deepStrictEqual(s['hevc/10/2160'], { ratio: 0.4, n: 1, at: 1 });
s = d.recordSpeed(s, { codec: 'hevc', depth: 10, width: 3840, height: 2160, ratio: 1, realtime: true }, 2);
assert.strictEqual(s['hevc/10/2160'].ratio, 0.58, 'exponential average');
assert.strictEqual(d.builtinSpeed(s, v('hevc', 'yuv420p10le', 3840, 2160)), 0.58);
assert.strictEqual(d.builtinSpeed(s, v('hevc', 'yuv420p', 3840, 2160)), null);

// ---- hint ---------------------------------------------------------------------------
const h = { hint: {}, now: 1000, shownThisSession: false, toolsInstalled: false, remote: undefined, trusted: true, slowRun: 2 };
assert.strictEqual(d.shouldHint(h), true);
assert.strictEqual(d.shouldHint({ ...h, slowRun: 1 }), false, 'one slow sample (a seek blip) is not enough');
assert.strictEqual(d.shouldHint({ ...h, slowRun: 1, ratio: 0.7 }), false, 'one sample near real time is not enough');
assert.strictEqual(d.shouldHint({ ...h, onboard: { choice: 'builtin', at: h.now - 1000 } }), false, 'just chose the built-in decoder');
assert.strictEqual(d.shouldHint({ ...h, onboard: { choice: 'builtin', at: h.now - d.BUILTIN_QUIET_MS - 1 } }), false, "Don't Show Again is final");
assert.strictEqual(d.shouldHint({ ...h, onboard: { choice: 'dismissed', at: h.now } }), true, 'dismissing the popup is not a choice');
assert.strictEqual(d.shouldHint({ ...h, slowRun: 1, ratio: 0.2 }), true, 'one hopeless sample is enough');
assert.strictEqual(d.shouldHint({ ...h, slowRun: 0, ratio: 0.2 }), false);
assert.strictEqual(d.shouldHint({ ...h, slowRun: 1, ratio: 0.2, hint: { never: true } }), false, "hopeless still respects Don't Show Again");
assert.strictEqual(d.shouldHint({ ...h, toolsInstalled: true }), false);
assert.strictEqual(d.shouldHint({ ...h, shownThisSession: true }), false, 'once per session');
assert.strictEqual(d.shouldHint({ ...h, remote: 'ssh-remote' }), false);
assert.strictEqual(d.shouldHint({ ...h, trusted: false }), false);
assert.strictEqual(d.shouldHint({ ...h, hint: d.afterHint({}, "Don't Show Again", 1000), now: 1e15 }), false, "Don't Show Again: never");
const later = d.afterHint({}, 'Not now', 1000);
assert.strictEqual(d.shouldHint({ ...h, hint: later, now: 2000 }), false, 'Not now: snoozed');
assert.strictEqual(d.shouldHint({ ...h, hint: later, now: 1000 + d.SNOOZE_MS + 1 }), true, 'asks again a week later');
assert.ok(d.afterHint({}, undefined, 5).snoozedUntil > 5, 'closing it counts as not now');
assert.ok(!d.afterHint({}, 'Set up', 5).snoozedUntil);
assert.strictEqual(d.describe({ codec: 'hevc', depth: 10, width: 3840, height: 2160 }), 'HEVC 10-bit 4K');
// Expected gain in the hint: the measured table without a probe; real time claimed from the CPU number only.
const slow4k = { codec: 'hevc', depth: 10, width: 3840, height: 2160, fps: 30, ratio: 0.1 };
let g = d.nativeGain(slow4k, null);
assert.deepStrictEqual([g.source, g.cpu, g.gpu], ['table', d.MEASURED_GAIN['hevc/10/2160'].cpu, d.MEASURED_GAIN['hevc/10/2160'].gpu]);
assert.match(d.hintText(slow4k, { mb: 77 }), /^HEVC 10-bit 4K plays at about 3\.0 of 30 frames per second here\. Set up ffmpeg \(≈77 MB, no admin needed\): about \d+× faster with a GPU \([\d.]+× on CPU\) on our test PC\.$/);
assert.match(d.hintText({ ...slow4k, ratio: 0.4 }, { mb: 77 }), /faster with a GPU \([\d.]+× on CPU\) on our test PC, likely smooth here\.$/);
assert.match(d.hintText({ ...slow4k, codec: 'prores', width: 1920, height: 1080, ratio: 0.7 }, { mb: 77 }), /ProRes 10-bit 1080p .*about [\d.]+× faster on our test PC, likely smooth here\.$/, 'no GPU number: CPU only');
assert.strictEqual(d.measuredGain({ codec: 'hevc', depth: 8, width: 3840, height: 2160 }).cpu, Math.min(...Object.entries(d.MEASURED_GAIN).filter(([c]) => c.startsWith('hevc/')).map(([, x]) => x.cpu)), 'unmeasured class: the lowest of the codec');
assert.match(d.hintText({ ...slow4k, codec: 'wmv3' }, { mb: 77 }), /Set up ffmpeg \(≈77 MB, no admin needed\) to play it much faster on this computer\.$/, 'not measured: no number');
// A probe from an earlier ffmpeg on this machine wins; capped at what 1080p frames can carry (48 fps).
const probed = { results: { 'hevc/10/2160': { method: 'd3d11va', bpp: 0.01, tried: [{ method: 'd3d11va', ok: true, fps: 120 }] } } };
g = d.nativeGain(slow4k, probed);
assert.deepStrictEqual([g.source, g.fps], ['probe', 48]);
assert.match(d.hintText(slow4k, { mb: 77, probeRecord: probed }), /plays smoothly here \(about 16× faster, tested on this computer\)\.$/);
assert.strictEqual(d.describe({ codec: 'h264', depth: 8, width: 1920, height: 1080 }), 'H.264 1080p');

// ---- files native failed on ------------------------------------------------------------
const st = { size: 10, mtimeMs: 5 };
let f = d.addFailed({}, 'a.mkv', st, 'Invalid data', 1);
assert.ok(d.failedBefore(f, 'a.mkv', st));
assert.ok(!d.failedBefore(f, 'a.mkv', { size: 11, mtimeMs: 5 }), 'the file changed: try native again');
for (let i = 0; i < 120; i++) f = d.addFailed(f, `f${i}`, st, '', 10 + i);
assert.strictEqual(Object.keys(f).length, 100, 'kept to 100 files');
console.log('decide: ok');
