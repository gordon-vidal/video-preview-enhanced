'use strict';
// Exact frames for the pixel tools under Live transcode: src/exact_frame.js (host: ffmpeg arguments, one
// cancellable run, stale-page check) and media/exactframe.js (page: one request at a time, cache per frame).
// A real ffmpeg is used for the picture itself when it is on PATH (the test skips that part otherwise).
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { EventEmitter } = require('events');
const { spawnSync } = require('child_process');
const { ExactFrameGrabber, exactFrameArgs, windows, rotationFilters, matrixFor, unsupported, pngSize } = require('../../src/exact_frame');
const { exactPixel } = require('../../media/inspect.js');

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/** A fake ffmpeg process: the test decides when and what it writes. */
function fakeProc() {
  const p = new EventEmitter();
  p.stdout = new EventEmitter();
  p.stderr = new EventEmitter();
  p.killed = false;
  p.signals = [];
  p.kill = (sig) => { p.killed = true; p.signals.push(sig || 'SIGTERM'); if (!p.wedged || sig === 'SIGKILL') setImmediate(() => p.emit('close', null)); };
  return p;
}
const PNG_1x1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const opts = (over = {}) => ({ tools: { ffmpeg: 'ffmpeg' }, file: 'clip.mp4', t: 1.5, video: { index: 0, width: 1920, height: 1080 }, page: 1, isCurrent: () => true, ...over });

function args() {
  const a = exactFrameArgs('a b.mp4', 12.3456, { video: { index: 2, height: 1080, colorSpace: 'bt709' }, rotation: 0 });
  assert.deepEqual(a.slice(a.indexOf('-ss'), a.indexOf('-ss') + 4), ['-ss', '12.2461', '-i', 'a b.mp4'], 'seek 0.1 s + 0.5 ms before, file as one argument');
  assert.ok(a[a.indexOf('-vf') + 1].startsWith('select=lte(t\\,0.1000),reverse,'), 'the last frame at or before t');
  assert.deepEqual(windows({ fps: 50 }).map((w) => +w.toFixed(2)), [0.05, 2, 30]);
  assert.ok(a.includes('-noautorotate') && a.includes('0:2') && a.includes('png'), 'noautorotate, the video stream, PNG');
  assert.equal(a[a.length - 1], '-', 'PNG on stdout');
  assert.ok(a[a.indexOf('-vf') + 1].includes('in_color_matrix=bt709') && a[a.indexOf('-vf') + 1].endsWith('format=rgb24'));
  assert.ok(!exactFrameArgs('f.mp4', 0).includes('-ss'), 't = 0: no seek');
  assert.ok(exactFrameArgs('f.mp4', 0).includes('-vf'));
  assert.deepEqual(rotationFilters(90), ['transpose=1']);
  assert.deepEqual(rotationFilters(180), ['hflip', 'vflip']);
  assert.deepEqual(rotationFilters(270), ['transpose=2']);
  assert.deepEqual(rotationFilters(0), []);
  assert.deepEqual(rotationFilters(-90), ['transpose=2']);
  assert.equal(matrixFor({ colorSpace: 'smpte170m', height: 1080 }), 'bt601');
  assert.equal(matrixFor({ colorSpace: 'bt2020nc', height: 2160 }), 'bt2020');
  assert.equal(matrixFor({ colorSpace: '', height: 1080 }), 'bt709');
  assert.equal(matrixFor({ colorSpace: '', height: 480 }), 'bt601');
  assert.equal(matrixFor({ colorSpace: '', width: 1920, height: 600 }), 'bt709', 'wide and short is HD, like the player');
  assert.equal(matrixFor({ colorSpace: '', width: 640, height: 480 }), 'bt601');
  assert.ok(unsupported('https://x/y.mp4', { height: 10 }), 'URLs have no exact frame');
  assert.equal(unsupported('C:\\v\\a.mp4', { height: 10 }), null, 'a Windows drive is no URL');
  assert.ok(unsupported('/v/a.mp4', { colorTransfer: 'smpte2084' }), 'HDR stays on the canvas');
  assert.ok(unsupported('/v/a.mp4', null));
}

async function runs() {
  // Success: the PNG and its size.
  let proc;
  let g = new ExactFrameGrabber({ spawn: () => (proc = fakeProc()) });
  let r = g.grab(opts());
  proc.stdout.emit('data', PNG_1x1);
  proc.emit('close', 0);
  r = await r;
  assert.equal(r.w, 1);
  assert.equal(r.h, 1);
  assert.ok(r.png.equals(PNG_1x1));
  assert.deepEqual(pngSize(Buffer.from('nope')), null);

  // No picture (ffmpeg wrote nothing): an error, not a hang.
  g = new ExactFrameGrabber({ spawn: () => (proc = fakeProc()) });
  r = g.grab(opts());
  proc.stderr.emit('data', 'boom');
  proc.emit('close', 1);
  assert.ok((await r).error);

  // A newer request from the same player kills the running one; only the newer answers.
  const procs = [];
  g = new ExactFrameGrabber({ spawn: () => { const p = fakeProc(); procs.push(p); return p; } });
  const first = g.grab(opts({ t: 1 }));
  const second = g.grab(opts({ t: 2 }));
  assert.equal(procs[0].killed, true, 'superseded ffmpeg is killed');
  assert.equal((await first).cancelled, true);
  procs[1].stdout.emit('data', PNG_1x1);
  procs[1].emit('close', 0);
  assert.equal((await second).w, 1);

  // cancel() (a reload) and dispose() (tab closed) kill the run; a closed grabber refuses new ones.
  g = new ExactFrameGrabber({ spawn: () => (proc = fakeProc()) });
  let p1 = g.grab(opts());
  g.cancel();
  assert.equal(proc.killed, true);
  assert.equal((await p1).cancelled, true);
  p1 = g.grab(opts());
  g.dispose();
  assert.equal((await p1).cancelled, true);
  assert.ok((await g.grab(opts())).error, 'closed');

  // Stale page: the picture arrives after the page was replaced; it is dropped.
  let cur = 1;
  g = new ExactFrameGrabber({ spawn: () => (proc = fakeProc()) });
  p1 = g.grab(opts({ page: 1, isCurrent: (pg) => pg === cur }));
  cur = 2;
  proc.stdout.emit('data', PNG_1x1);
  proc.emit('close', 0);
  const stale = await p1;
  assert.equal(stale.stale, true);
  assert.equal(stale.png, undefined);

  // An empty window (no frame at or before t yet) retries with a wider one; the answer carries the matrix.
  const runsArgs = [];
  g = new ExactFrameGrabber({ spawn: (_c, a) => { runsArgs.push(a); proc = fakeProc(); if (runsArgs.length === 2) setImmediate(() => { proc.stdout.emit('data', PNG_1x1); proc.emit('close', 0); }); else setImmediate(() => proc.emit('close', 0)); return proc; } });
  r = await g.grab(opts());
  assert.equal(runsArgs.length, 2);
  assert.notEqual(runsArgs[0][runsArgs[0].indexOf('-ss') + 1], runsArgs[1][runsArgs[1].indexOf('-ss') + 1], 'wider window');
  assert.equal(r.matrix, 'bt709');
  // Every window empty: an error, after exactly the three tries.
  let n = 0;
  g = new ExactFrameGrabber({ spawn: () => { n++; proc = fakeProc(); setImmediate(() => proc.emit('close', 0)); return proc; } });
  assert.ok((await g.grab(opts())).error);
  assert.equal(n, 3);
  // A newer request stops the older one's retries.
  n = 0;
  const olds = [];
  g = new ExactFrameGrabber({ spawn: () => { n++; const p = fakeProc(); olds.push(p); return p; } });
  const older = g.grab(opts({ t: 1 }));
  olds[0].emit('close', 0); // empty: would retry
  g.cancel();
  assert.equal((await older).cancelled, true);
  assert.equal(n, 1, 'no further window after cancel');

  // A wedged ffmpeg (ignores SIGTERM) gets SIGKILL after the grace time, once, and the timer is dropped on close.
  g = new ExactFrameGrabber({ spawn: () => { proc = fakeProc(); proc.wedged = true; return proc; }, killGraceMs: 30 });
  const wedged = g.grab(opts());
  g.cancel();
  assert.equal((await wedged).cancelled, true);
  assert.deepEqual(proc.signals, ['SIGTERM']);
  await tick(80);
  assert.deepEqual(proc.signals, ['SIGTERM', 'SIGKILL']);
  g = new ExactFrameGrabber({ spawn: () => (proc = fakeProc()), killGraceMs: 30 });
  g.grab(opts());
  g.cancel();
  await tick(80);
  assert.deepEqual(proc.signals, ['SIGTERM'], 'closed in time: no SIGKILL');

  // Timeout kills ffmpeg.
  g = new ExactFrameGrabber({ spawn: () => (proc = fakeProc()), timeoutMs: 20 });
  r = await g.grab(opts());
  assert.equal(proc.killed, true);
  assert.match(r.error, /timed out/);

  // Not a video file / bad time: nothing is spawned.
  let spawned = 0;
  g = new ExactFrameGrabber({ spawn: () => { spawned++; return fakeProc(); } });
  assert.ok((await g.grab(opts({ file: 'https://x/v.mp4' }))).error);
  assert.ok((await g.grab(opts({ t: NaN }))).error);
  assert.equal(spawned, 0);
}

function haveFfmpeg() {
  const r = spawnSync('ffmpeg', ['-version'], { windowsHide: true });
  return !r.error && r.status === 0;
}

async function real() {
  if (!haveFfmpeg()) { console.log('exact_frame: ffmpeg not on PATH, real extraction skipped'); return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vpe-exact-'));
  try {
    const file = path.join(dir, 'clip.mp4');
    // 3 s of a counting test picture, 96x64, 10 fps: the frame at 1.0 s is frame 10 (0-based).
    const mk = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=96x64:rate=10:duration=3', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-g', '30', file], { windowsHide: true });
    if (mk.status !== 0) { console.log('exact_frame: no libx264 to make the clip, real extraction skipped'); return; }
    const video = { index: 0, width: 96, height: 64, colorSpace: '' };
    const g = new ExactFrameGrabber();
    const a = await g.grab(opts({ tools: { ffmpeg: 'ffmpeg' }, file, t: 1.0, video }));
    assert.ok(a.png && a.png.length > 100, a.error);
    assert.deepEqual([a.w, a.h], [96, 64]);
    const b = await g.grab(opts({ tools: { ffmpeg: 'ffmpeg' }, file, t: 2.0, video }));
    assert.ok(!a.png.equals(b.png), 'another time gives another picture');
    const again = await g.grab(opts({ tools: { ffmpeg: 'ffmpeg' }, file, t: 1.0, video }));
    assert.ok(again.png.equals(a.png), 'the same time gives the same picture');
    // VFR hold: frames at 0, .1, .2 then a gap to .7. Live transcode shows frame .2 at .3 to .6; not the one at .7.
    const vfr = path.join(dir, 'vfr.mp4');
    const mv = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=96x64:rate=10:duration=3', '-vf', "select='not(between(n,3,6))'", '-fps_mode', 'passthrough', '-c:v', 'libx264', '-g', '30', vfr], { windowsHide: true });
    assert.equal(mv.status, 0);
    const at = (t) => g.grab(opts({ tools: { ffmpeg: 'ffmpeg' }, file: vfr, t, video }));
    const held = await at(0.2);
    for (const t of [0.3, 0.45, 0.6]) assert.ok((await at(t)).png.equals(held.png), `the held frame at ${t} s`);
    const next = await at(0.7);
    assert.ok(!next.png.equals(held.png), 'the frame after the gap is another one');
    assert.ok(!(await at(0.1)).png.equals(held.png));
    assert.ok((await at(0.2 + 0.0004)).png.equals(held.png));
    // Turned 90°: the picture is 64x96.
    const r90 = await g.grab(opts({ tools: { ffmpeg: 'ffmpeg' }, file, t: 1.0, video, rotation: 90 }));
    assert.deepEqual([r90.w, r90.h], [64, 96]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** The page half: media/exactframe.js in a bare context. */
async function page() {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'media', 'exactframe.js'), 'utf8');
  const ctx = { setTimeout, clearTimeout, console, module: undefined };
  vm.createContext(ctx);
  vm.runInContext(`${src}\nthis.out = VpeExact;`, ctx);
  const { create } = ctx.out;
  const posted = [];
  const toasts = [];
  let closed = 0;
  const x = create({
    page: 7, post: (m) => posted.push(m), toast: (t) => toasts.push(t),
    decode: async (png) => ({ width: 1, height: 1, close() { closed++; } }),
  });
  const reply = (m) => x.onReply({ page: 7, w: 1, h: 1, png: PNG_1x1, ...m });

  const g1 = x.grab('a', 1.5, { notify: false });
  assert.equal(JSON.stringify(posted[0]), JSON.stringify({ type: 'grabExactFrame', page: 7, reqId: 1, t: 1.5 }));
  assert.ok(x.inflight('a'));
  await reply({ reqId: 99 }); // another request's answer: ignored
  await x.onReply({ page: 6, reqId: 1, png: PNG_1x1 }); // another page's answer: ignored
  assert.ok(x.inflight('a'));
  await reply({ reqId: 1 });
  const a = await g1;
  assert.equal(a.w, 1);
  assert.equal(x.peek('a'), a, 'cached for the paused frame');
  assert.equal(await x.grab('a', 1.5), a, 'no second request for the same frame');
  assert.equal(posted.length, 1);
  assert.equal(x.peek('b'), null);

  // A newer frame supersedes a request in flight (the older promise resolves null).
  const gb = x.grab('b', 2, { notify: false });
  const gc = x.grab('c', 3, { notify: false });
  assert.equal(await gb, null);
  await reply({ reqId: 3 });
  assert.equal((await gc).w, 1);
  assert.equal(closed, 1, 'the replaced picture is released');

  // Failure is remembered for that frame; the host's error text is returned.
  const gd = x.grab('d', 4, { notify: false });
  await x.onReply({ page: 7, reqId: 4, error: 'HDR' });
  assert.equal((await gd).error, 'HDR');
  assert.ok(x.failed('d'));
  assert.ok(!x.failed('c'));

  // invalidate (play, seek, close): picture gone, request dropped.
  x.invalidate();
  assert.equal(x.peek('c'), null);
  assert.ok(!x.failed('d'));
  const ge = x.grab('e', 5, { notify: false });
  x.invalidate();
  assert.equal(await ge, null);

  // The host's error and a page-side timeout both record the failed frame (no retry loop) and say so once.
  const fails = [];
  const timers = [];
  const z = create({
    page: 3, post: () => {}, onFail: (k, e) => fails.push([k, e]), decode: async () => ({ width: 1, height: 1 }),
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout: () => {},
  });
  const gz = z.grab('k', 1, { notify: false });
  timers.find((t) => t.ms === ctx.out.GIVE_UP_MS).fn();
  assert.equal((await gz).error, 'no answer from the extension host');
  assert.ok(z.failed('k'));
  assert.ok(!z.inflight('k'));
  assert.equal(JSON.stringify(fails), JSON.stringify([['k', 'no answer from the extension host']]));
  const gz2 = z.grab('m', 2, { notify: false });
  await z.onReply({ page: 3, reqId: 2, error: 'HDR' });
  await gz2;
  assert.equal(fails.length, 2);
  assert.equal(fails[1][1], 'HDR');
  // The source's matrix rides along for the scopes.
  const gz3 = z.grab('n', 3, { notify: false });
  await z.onReply({ page: 3, reqId: 3, png: PNG_1x1, w: 1, h: 1, matrix: 'bt2020' });
  assert.equal((await gz3).matrix, 2020);

  // The inspector maps the fractional pointer place straight into the exact picture (one rounding).
  assert.deepEqual(exactPixel(480.75 / 1920, 10.5 / 1080, 3840, 2160), [961, 21], 'odd columns of a 4K source are reachable');
  assert.deepEqual(exactPixel(1, 1, 3840, 2160), [3839, 2159]);
  assert.deepEqual(exactPixel(-0.1, 0, 10, 10), [0, 0]);

  // A slow grab says so once; a fast one does not.
  const y = create({ page: 1, post: () => {}, toast: (t) => toasts.push(t), decode: async () => ({ width: 1, height: 1 }) });
  const gs = y.grab('s', 1);
  await tick(320);
  assert.equal(JSON.stringify(toasts), JSON.stringify(['Fetching exact frame…']));
  await y.onReply({ page: 1, reqId: 1, png: PNG_1x1, w: 1, h: 1 });
  await gs;
  toasts.length = 0;
  const gf = y.grab('f', 2);
  await y.onReply({ page: 1, reqId: 2, png: PNG_1x1, w: 1, h: 1 });
  await gf;
  await tick(320);
  assert.equal(JSON.stringify(toasts), JSON.stringify([]));
}

(async () => {
  args();
  await runs();
  await real();
  await page();
  console.log('exact_frame_test: ok');
})().catch((e) => { console.error(e); process.exit(1); });
