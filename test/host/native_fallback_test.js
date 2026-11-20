'use strict';
// node test/host/native_fallback_test.js: native ffmpeg's runtime fallback (src/native.js),
// mpv-style: a GPU method that produces nothing is retried in software; when software
// fails too, onFail hands the file to the built-in decoder. Also checks that a real
// GPU-method run produces frames. Needs ffmpeg on PATH (skipped otherwise).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const cp = require('child_process');
const ff = require('../../src/ffmpeg');
const hw = require('../../src/hwaccel');
const probed = { duration: 1, video: { index: 0, codec: 'h264', pixFmt: 'yuv420p', width: 320, height: 240, fps: 30 }, audio: null };
const main10 = { ...probed, video: { ...probed.video, codec: 'hevc', pixFmt: 'yuv420p10le' } };

// Capture real launch arguments without running ffmpeg for the retry and audio cases.
const realSpawn = cp.spawn;
cp.spawn = (cmd, args) => {
  const stdout = new EventEmitter();
  stdout.isPaused = () => false;
  return Object.assign(new EventEmitter(), { args, stdout, stderr: new EventEmitter(),
    stdio: [null, stdout, null, new EventEmitter()], exitCode: null, kill() {} });
};
const { NativeDecoder: FakeNativeDecoder } = require('../../src/native');
cp.spawn = realSpawn;
delete require.cache[require.resolve('../../src/native')];
const { NativeDecoder } = require('../../src/native');

function fakeDecoder(method, pr, tools = { ffmpeg: 'fake-ffmpeg', gpuFilters: new Set(['scale_cuda', 'vpp_qsv']) }, methodGuessed = false) {
  const messages = [];
  const nd = new FakeNativeDecoder({ tools, file: 'clip.mp4', probed: pr, method, methodGuessed, log() {}, post() {}, postRaw: (m) => messages.push(m) });
  nd.w = pr.video.width; nd.h = pr.video.height; nd.fps = pr.video.fps;
  nd.startAt(0.5);
  return { nd, messages };
}

function spawnErrors() {
  const children = [];
  const failures = [];
  const nd = new NativeDecoder({ probed, method: 'd3d11va', log() {}, onFail: (e) => failures.push(e) });
  nd.launch = (t) => {
    const proc = Object.assign(new EventEmitter(), { t, method: nd.method, exitCode: null, err: { text: '' },
      stdout: new EventEmitter(), kill() {} });
    children.push(proc);
    return proc;
  };
  nd.prepareLoop();
  const [standby] = children;
  standby.emit('error', new Error('spawn ENOENT'));
  assert.strictEqual(nd.standby, null, 'failed standby discarded even before close');

  nd.startAt(0);
  assert.strictEqual(children.length, 2, 'launched a replacement for the failed standby');
  const gpu = children[1];
  gpu.emit('error', new Error('spawn ENOENT'));
  gpu.emit('close', -1);
  gpu.emit('error', new Error('stale error'));
  assert.strictEqual(children.length, 3, 'one software retry');
  const cpu = children[2];
  cpu.emit('error', new Error('spawn EACCES'));
  cpu.emit('close', -1);
  assert.deepStrictEqual(failures, ['spawn EACCES'], 'error and close trigger only one fallback');
  assert.strictEqual(nd.ended, false, 'a spawn failure is not EOF');
  nd.dispose();
}

function methodError() {
  const { nd, messages } = fakeDecoder('d3d11va', probed);
  nd.more({ gen: 0 });
  nd.proc.emit('close', 1);
  assert.strictEqual(nd.proc.method, 'none', 'retry in software');
  assert.strictEqual(nd.credits, 8, 'keep outstanding frame requests on retry');
  nd.proc.stdout.emit('data', Buffer.alloc(nd.frameBytes * 2, 7));
  assert.deepStrictEqual(messages.map((m) => [m.type, m.gen, m.t, m.data[0]]),
    [['ndv', 0, 0.5, 7], ['ndv', 0, 0.5 + 1 / 30, 7]], 'software frames flow without another more');
  assert.strictEqual(nd.credits, 6);
  nd.dispose();
}

function filterError() {
  const { nd, messages } = fakeDecoder('cuda', { ...main10, audio: { index: 1 } });
  const { tools, proc } = nd;
  assert.strictEqual(proc.gpuFilter, 'scale_cuda');
  proc.stdio[3].emit('data', Buffer.alloc(8));
  nd.more({ gen: 0 });
  assert.deepStrictEqual(messages, [], 'do not send audio before the first picture');
  proc.emit('close', 1);
  assert.notStrictEqual(nd.proc, proc, 'retry the failing filter');
  assert.strictEqual(nd.proc.gpuFilter, '');
  assert.strictEqual(nd.proc.method, 'cuda', 'keep hardware decoding when only scaling failed');
  assert.strictEqual(nd.proc.t, 0.5, 'retry the same seek');
  assert.strictEqual(nd.credits, 8, 'keep outstanding frame requests on retry');
  assert.strictEqual(nd.audioBytes, 0, 'discard buffered audio from the failed run');
  nd.proc.stdio[3].emit('data', Buffer.alloc(8));
  assert.deepStrictEqual(messages.map((m) => m.type), ['nda'], 'audio flows immediately on the unfiltered retry');
  nd.dispose();

  const stream = (changes) => ({ ...main10, video: { ...main10.video, ...changes } });
  for (const [method, pr, toolset, expected] of [
    ['cuda', main10, tools, ''],
    ['cuda', stream({ codec: 'av1' }), tools, 'scale_cuda'],
    ['cuda', stream({ pixFmt: 'p010le' }), tools, 'scale_cuda'],
    ['cuda', stream({ width: 160, height: 90 }), tools, 'scale_cuda'],
    ['qsv', main10, tools, 'vpp_qsv'],
    ['cuda', main10, { ...tools }, 'scale_cuda'],
  ]) {
    const { nd: reopened } = fakeDecoder(method, pr, toolset);
    assert.strictEqual(reopened.proc.gpuFilter, expected, 'cached failure is specific to tools, filter and stream class');
    assert.strictEqual(reopened.proc.args.includes('-hwaccel_output_format'), !!expected);
    reopened.dispose();
  }
}

/** A method guessed from the GPU vendor (no GPU test): cuda -> ffmpeg's own pick -> software, remembered per tools and class. */
function guessedMethodError() {
  const tools = { ffmpeg: 'fake-ffmpeg', gpuFilters: new Set(['scale_cuda']) };
  const { nd } = fakeDecoder('cuda', main10, tools, true);
  nd.more({ gen: 0 });
  assert.strictEqual(nd.proc.gpuFilter, 'scale_cuda');
  nd.proc.emit('close', 1);
  assert.deepStrictEqual([nd.proc.method, nd.proc.gpuFilter], ['cuda', ''], 'the filter first, as before');
  nd.proc.emit('close', 1);
  assert.strictEqual(nd.proc.method, 'auto', "then ffmpeg's own pick");
  assert.deepStrictEqual(nd.proc.args.slice(nd.proc.args.indexOf('-hwaccel'), nd.proc.args.indexOf('-hwaccel') + 2), ['-hwaccel', 'auto']);
  assert.strictEqual(nd.credits, 8, 'keep outstanding frame requests');
  nd.proc.emit('close', 1);
  assert.strictEqual(nd.proc.method, 'none', 'then software');
  nd.dispose();
  const { nd: again } = fakeDecoder('cuda', main10, tools, true);
  assert.strictEqual(again.proc.method, 'auto', "the next file of this class starts with ffmpeg's pick");
  again.dispose();
  const { nd: other } = fakeDecoder('cuda', main10, { ...tools }, true);
  assert.strictEqual(other.proc.method, 'cuda', 'remembered per ffmpeg installation');
  other.dispose();
  const { nd: tested } = fakeDecoder('cuda', main10, tools, false);
  assert.strictEqual(tested.proc.method, 'cuda', "a GPU test's choice is kept");
  tested.proc.emit('close', 1);
  tested.proc.emit('close', 1);
  assert.strictEqual(tested.proc.method, 'none', 'and falls back to software directly');
  tested.dispose();
}

/** fitView: frames sized to the player's picture area (VIEW_HEIGHTS steps), resized with a seek when it changes. */
function fitView() {
  const uhd = { ...main10, video: { ...main10.video, width: 3840, height: 2160 } };
  const mk = (opts) => new FakeNativeDecoder({ tools: { ffmpeg: 'fake-ffmpeg', gpuFilters: new Set() }, file: 'clip.mp4', probed: uhd, method: 'none',
    maxHeight: 2160, log() {}, post() {}, postRaw() {}, ...opts });
  const size = (nd) => { const s = nd.videoSize('stream'); return `${s.width}x${s.height}`; };
  assert.strictEqual(size(mk({})), '3840x2160', 'without fitView: the cap only');
  assert.strictEqual(size(mk({ fitView: true })), '3840x2160', 'no picture size known yet');
  assert.strictEqual(size(mk({ fitView: true, view: { w: 1600, h: 900 } })), '1920x1080');
  assert.strictEqual(size(mk({ fitView: true, view: { w: 2560, h: 1300 } })), '2560x1440');
  assert.strictEqual(size(mk({ fitView: true, view: { w: 3840, h: 2000 } })), '3840x2160');
  assert.strictEqual(size(mk({ fitView: true, view: { w: 900, h: 1600 } })), '1920x1080', 'portrait panel');
  assert.strictEqual(size(mk({ fitView: true, view: { w: 1280, h: 720 } })), '1280x720', 'a 720 px picture');
  assert.strictEqual(size(mk({ fitView: true, view: { w: 1100, h: 650 } })), '1280x720', 'between 540 and 720');
  assert.strictEqual(size(mk({ fitView: true, view: { w: 960, h: 540 } })), '960x540', 'a 540 px picture');
  assert.strictEqual(size(mk({ fitView: true, view: { w: 400, h: 300 } })), '960x540', 'smallest step');
  assert.strictEqual(size(mk({ fitView: true, view: { w: 720, h: 1280 } })), '1280x720', 'portrait 720 panel');
  assert.strictEqual(size(mk({ maxHeight: 2160, view: { w: 960, h: 540 } })), '3840x2160', 'a number in nativeMaxHeight: no fitting');
  assert.strictEqual(size(mk({ fitView: true, view: { w: 1600, h: 900 }, maxHeight: 720 })), '1280x720', 'a smaller cap wins');
  assert.strictEqual(size(mk({ fitView: true, view: { w: 0, h: 0 } })), '3840x2160', 'a hidden page says nothing');
  const posted = [];
  const nd = mk({ fitView: true, view: { w: 1600, h: 900 }, post: (m) => posted.push(m) });
  nd.sizeVideo('stream'); nd.fps = 30; nd.link = 'stream';
  nd.startAt(0);
  nd.handle({ type: 'view', w: 1700, h: 950 });
  assert.deepStrictEqual(posted, [], 'same step: nothing to do');
  nd.handle({ type: 'view', w: 3840, h: 2100 });
  assert.deepStrictEqual(posted.map((m) => m.type), ['refresh'], 'fullscreen: the page seeks to apply the new size');
  nd.handle({ type: 'seek', gen: 1, t: 1 });
  assert.deepStrictEqual(posted.slice(1).map((m) => [m.type, m.width, m.height]), [['size', 3840, 2160], ['seeked', undefined, undefined]]);
  assert.deepStrictEqual([nd.proc.w, nd.proc.h], [3840, 2160]);
  posted.length = 0;
  nd.handle({ type: 'view', w: 1600, h: 900 });
  assert.deepStrictEqual(posted, [], 'smaller: no seek of its own');
  nd.handle({ type: 'view', w: 3800, h: 2100 });
  assert.deepStrictEqual(posted, [], 'back to the current size: nothing');
  nd.handle({ type: 'view', w: 1600, h: 900 });
  nd.handle({ type: 'seek', gen: 2, t: 2 });
  assert.deepStrictEqual(posted.map((m) => [m.type, m.height]), [['size', 1080], ['seeked', undefined]], 'the next seek takes the smaller size');
  assert.deepStrictEqual([nd.proc.w, nd.proc.h], [1920, 1080]);
  // sizeFramesToView turned off while playing: full-size frames at once; on again: smaller at the next seek.
  posted.length = 0;
  nd.setFit(false);
  assert.deepStrictEqual(posted.map((m) => m.type), ['refresh'], 'off: the page seeks to get the full size');
  nd.handle({ type: 'seek', gen: 3, t: 3 });
  assert.deepStrictEqual([nd.proc.w, nd.proc.h], [3840, 2160]);
  nd.handle({ type: 'view', w: 1600, h: 900 });
  posted.length = 0;
  nd.setFit(true);
  assert.deepStrictEqual(posted, [], 'on: no seek of its own');
  nd.handle({ type: 'seek', gen: 4, t: 4 });
  assert.deepStrictEqual([nd.proc.w, nd.proc.h], [1920, 1080], 'on: the next seek takes the picture size');
  nd.dispose();
}

function audioWithoutPicture() {
  const { nd, messages } = fakeDecoder('qsv', { ...probed, audio: { index: 1 } });
  const audio = nd.proc.stdio[3];
  nd.more({ gen: 0 });
  audio.emit('data', Buffer.alloc(2e6));
  assert.deepStrictEqual(messages, [], 'the filter trial holds audio at the cap');
  audio.emit('data', Buffer.alloc(8));
  assert.deepStrictEqual(messages.map((m) => [m.type, m.n]), [['nda', 250001]], 'release held audio before exit');
  audio.emit('data', Buffer.alloc(8));
  assert.strictEqual(messages[1].n, 1, 'keep delivering audio after the trial ends');
  assert.strictEqual(nd.audioBytes, 0);
  nd.dispose();
}

function audioRate() {
  const { nd, messages } = fakeDecoder('none', { ...probed, audio: { index: 1 } });
  const rateArg = (p) => p.args[p.args.indexOf('-ar') + 1];
  nd.handle({ type: 'audioRate', rate: 44100 });
  assert.strictEqual(rateArg(nd.proc), '48000', 'the running ffmpeg keeps its rate');
  nd.startAt(0);
  assert.strictEqual(rateArg(nd.proc), '44100', 'the next start asks for the context rate');
  nd.more({ gen: 0 });
  nd.proc.stdio[3].emit('data', Buffer.alloc(16));
  assert.deepStrictEqual([messages[0].rate, messages[0].n, messages[0].data.length], [44100, 2, 16], 'interleaved, with its rate');
  nd.handle({ type: 'audioRate', rate: 1 });
  nd.startAt(0);
  assert.strictEqual(rateArg(nd.proc), '44100', 'an implausible rate is ignored');
  nd.handle({ type: 'audioRate', rate: 48000 });
  nd.dispose();
}

function play(tools, file, method, probed) {
  return new Promise((resolve) => {
    const logs = [];
    const nd = new NativeDecoder({
      tools, file, method, probed, maxHeight: 1440, log: (m) => logs.push(m),
      post: (m) => { if (m.type === 'streams') nd.handle({ type: 'more', gen: 0 }); },
      postRaw: (m) => { if (m.type === 'ndv') { nd.dispose(); resolve({ frame: m, logs, method: nd.method }); } },
      onFail: (err) => resolve({ failed: err, logs, method: nd.method }),
    });
    nd.handle({ type: 'open' });
  });
}

(async () => {
  spawnErrors();
  methodError();
  filterError();
  guessedMethodError();
  fitView();
  audioWithoutPicture();
  audioRate();
  const tools = await ff.locateTools('', '');
  if (!tools) { console.log('native fallback: skipped (no ffmpeg on PATH)'); return; }
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'vpe_nfb_'));
  try {
    // Not a video: every method fails before the first frame.
    const bad = path.join(work, 'broken.mkv');
    fs.writeFileSync(bad, 'not a video at all');
    const r = await play(tools, bad, 'd3d11va', probed);
    assert.ok(r.failed, 'onFail called');
    assert.strictEqual(r.method, 'none', 'retried in software first');
    assert.ok(r.logs.some((l) => /d3d11va failed on this file; decoding in software/.test(l)), r.logs.join('\n'));

    // A good file with the GPU method this platform tries first: frames come out (it may fall back inside ffmpeg).
    const clip = path.join(__dirname, '..', '..', 'media', 'probe', 'h264_8_1080.mkv');
    const pr = await ff.probe(tools, clip);
    const method = hw.methodOrder({ os: process.platform, gpus: [] })[0];
    const ok = await play(tools, clip, method, pr);
    assert.ok(ok.frame && ok.frame.w === 1920 && ok.frame.h === 1080, `frame from ${method}`);
    const nd = new NativeDecoder({ tools, file: clip, probed: pr, method: 'none', post() {}, postRaw() {}, log() {} });
    nd.w = 1920; nd.h = 1080;
    assert.strictEqual(nd.lossy(), false, '1080p 8-bit 4:2:0 shown as is');
    nd.h = 720; nd.w = 1280;
    assert.strictEqual(nd.lossy(), true, 'scaled down');
    console.log(`native fallback: ok (${method} played the probe clip)`);
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
})().catch((e) => { console.error(e); process.exit(1); });
