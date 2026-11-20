'use strict';
// node test/host/probe_run_test.js: the process side of src/probe.js with node standing in for ffmpeg:
// ffSpawn (spawn failure, abort, time limit, extra pipes), ffRun (frame tags on stderr, check frames
// on pipe 3, a failing decoder, short segments, a slow segment), ffReference, plus the small helpers
// (segmentOf, segmentSpeed, decodedPerInput, loopList quoting, clipBpp, table) at their edges.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const probe = require('../../src/probe');

const node = process.execPath;
const FRAME = (640 * 360 * 3) / 2;
// node -e <script> -- <args...>: the "ffmpeg" arguments follow the script.
const prog = (script, ...extra) => ['-e', script, '--', ...extra];
const clip = (frames) => ({ res: '1080', frames, depth: 8 });

(async () => {
  // ---- ffSpawn ------------------------------------------------------------------
  let r = await probe.ffSpawn('definitely-not-a-program-xyz', []).done;
  assert.ok(r.code < 0, 'a missing program resolves with a negative code');
  assert.ok(r.stderr.length > 0 && !r.aborted && !r.killed);
  assert.deepStrictEqual(r.pipes, []);

  const out = [];
  const err = [];
  const piped = [];
  r = await probe.ffSpawn(node, prog('process.stdout.write("so"); process.stderr.write("se"); require("fs").writeSync(3, Buffer.from([1,2,3])); require("fs").writeSync(4, Buffer.from([9]));'), {
    pipes: 2, onStdout: (t) => out.push(t), onStderr: (t) => err.push(t), onPipe: (i, n) => piped.push([i, n]),
  }).done;
  assert.strictEqual(r.code, 0);
  assert.strictEqual(out.join(''), 'so');
  assert.strictEqual(err.join(''), 'se');
  assert.strictEqual(r.stderr, 'se');
  assert.deepStrictEqual(r.pipes.map((b) => [...b]), [[1, 2, 3], [9]]);
  assert.deepStrictEqual(piped.sort(), [[0, 3], [1, 1]]);

  r = await probe.ffSpawn(node, prog('process.exit(7)')).done;
  assert.strictEqual(r.code, 7);

  // The time limit kills a program that never ends.
  let t0 = Date.now();
  r = await probe.ffSpawn(node, prog('setInterval(() => {}, 1000)'), { limitMs: 300 }).done;
  assert.ok(r.killed && r.code !== 0, 'killed by the limit');
  assert.ok(Date.now() - t0 < 5000);

  // An abort signal, before and during the run.
  const ac = new AbortController();
  ac.abort();
  r = await probe.ffSpawn(node, prog('setInterval(() => {}, 1000)'), { signal: ac.signal }).done;
  assert.ok(r.aborted && r.killed, 'already aborted: killed at once');
  const ac2 = new AbortController();
  const h = probe.ffSpawn(node, prog('setInterval(() => {}, 1000)'), { signal: ac2.signal });
  setTimeout(() => ac2.abort(), 150);
  r = await h.done;
  assert.ok(r.aborted && r.killed, 'aborted while running');
  // kill() on a handle that is finished or has no process does not throw.
  h.kill();
  probe.ffSpawn('definitely-not-a-program-xyz', []).kill();

  // ---- ffReference ------------------------------------------------------------------
  const ref = await probe.ffReference(node, prog(`const fs = require('fs'); fs.writeSync(3, Buffer.alloc(${FRAME}, 7)); fs.writeSync(4, Buffer.alloc(10, 1));`), 2);
  assert.strictEqual(ref.code, 0);
  assert.strictEqual(ref.frames[0].length, FRAME);
  assert.strictEqual(ref.frames[0][0], 7);
  assert.strictEqual(ref.frames[1], null, 'a pipe with less than a frame is "no picture"');
  const refFail = await probe.ffReference('definitely-not-a-program-xyz', [], 2);
  assert.ok(refFail.code < 0);
  assert.deepStrictEqual(refFail.frames, [null, null]);

  // ---- ffRun ------------------------------------------------------------------------
  // Frame tags "vpe=i" on stderr; the check frames on pipe 3.
  const tag = (i, n, gap = 1) => `for (let k = 0; k < ${n}; k++) { process.stderr.write('frame vpe=${i}\\n'); await sleep(${gap}); }`;
  const head = `const sleep = (ms) => new Promise((r) => setTimeout(r, ms)); const fs = require('fs'); (async () => {`;
  const GPU = ['-hwaccel', 'cuda']; // want = 60 frames per clip with a hardware method

  let run = await probe.ffRun(node, prog(`${head} ${tag(0, 60)} ${tag(1, 60)} fs.writeSync(3, Buffer.alloc(${FRAME * 2}, 5)); })()`, ...GPU), [clip(60), clip(60)]);
  assert.strictEqual(run.code, 0);
  assert.deepStrictEqual(run.done, [true, true]);
  assert.strictEqual(run.bad, -1);
  assert.ok(!run.slow && !run.aborted);
  assert.ok(run.fps.every((f) => f > 0), `both segments timed: ${run.fps}`);
  assert.strictEqual(run.checks[0].length, FRAME);
  assert.strictEqual(run.checks[1].length, FRAME);

  // Frames for an input that does not exist are ignored; a final partial line without newline too.
  run = await probe.ffRun(node, prog(`${head} ${tag(5, 3)} ${tag(0, 60)} process.stderr.write('vpe=0'); })()`, ...GPU), [clip(60)]);
  assert.deepStrictEqual(run.done, [true]);
  assert.strictEqual(run.checks[0], null, 'no pipe data: no check frame');

  // A segment with fewer frames than planned shifts everything after it: not done, no check frames.
  run = await probe.ffRun(node, prog(`${head} ${tag(0, 20)} ${tag(1, 60)} fs.writeSync(3, Buffer.alloc(${FRAME * 2}, 5)); })()`, ...GPU), [clip(60), clip(60)]);
  assert.strictEqual(run.code, 0);
  assert.deepStrictEqual(run.done, [true, false]);
  assert.ok(run.checks[0] && run.checks[1] === null);

  // A decoder that fails (summary line names input 1): the run ends, clips from 1 on are not done.
  const summary = (i, frames, errors) => `Input stream #${i}:0 (video): 10 packets read (1000 bytes); ${frames} frames decoded; ${errors} decode errors (0 corrupt) (...)`;
  run = await probe.ffRun(node, prog(`${head} ${tag(0, 60)} ${tag(1, 3)} process.stderr.write(${JSON.stringify(summary(0, 60, 0))} + '\\n' + ${JSON.stringify(summary(1, 3, 4))} + '\\n'); process.exit(1); })()`, ...GPU), [clip(60), clip(60), clip(60)]);
  assert.notStrictEqual(run.code, 0);
  assert.strictEqual(run.bad, 1);
  assert.deepStrictEqual(run.done, [true, false, false]);
  // Failure without a summary: the log line of the video input names it.
  run = await probe.ffRun(node, prog(`${head} ${tag(0, 60)} process.stderr.write('[vist#1:0/hevc @ 0x1] Error while decoding\\n'); process.exit(1); })()`, ...GPU), [clip(60), clip(60)]);
  assert.strictEqual(run.bad, 1);
  // Failure that names nothing, or an input out of range: bad stays -1.
  run = await probe.ffRun(node, prog(`${head} ${tag(0, 60)} process.stderr.write('vist#9:0 error\\n'); process.exit(1); })()`, ...GPU), [clip(60)]);
  assert.strictEqual(run.bad, -1);
  run = await probe.ffRun(node, prog('process.exit(2)', ...GPU), [clip(60)]);
  assert.strictEqual(run.bad, -1);
  assert.deepStrictEqual(run.done, [false]);
  // The program cannot start at all.
  run = await probe.ffRun('definitely-not-a-program-xyz', GPU, [clip(60)]);
  assert.ok(run.code < 0);
  assert.deepStrictEqual(run.done, [false]);

  // A slow segment (more than SEGMENT_LIMIT_MS without finishing) ends the run; its speed so far is the result.
  t0 = Date.now();
  run = await probe.ffRun(node, prog(`${head} ${tag(0, 12, 40)} setInterval(() => {}, 1000); })()`, ...GPU), [clip(600)]);
  assert.ok(run.slow, 'slow');
  assert.ok(run.done[0] && run.fps[0] > 0 && run.fps[0] < 100, `speed so far: ${run.fps[0]}`);
  assert.ok(Date.now() - t0 < 8000);
  // Slow with a single frame: 0.1 fps rather than 0.
  run = await probe.ffRun(node, prog(`${head} ${tag(0, 1)} setInterval(() => {}, 1000); })()`, ...GPU), [clip(600)]);
  assert.ok(run.slow);
  assert.strictEqual(run.fps[0], 0.1);
  // Aborted run.
  const ac3 = new AbortController();
  setTimeout(() => ac3.abort(), 200);
  run = await probe.ffRun(node, prog('setInterval(() => {}, 1000)', ...GPU), [clip(60)], { signal: ac3.signal });
  assert.ok(run.aborted);

  // ---- helpers at their edges --------------------------------------------------------
  assert.deepStrictEqual(probe.segmentOf({ res: '1080', frames: 30 }, 'cuda'), { loops: 2, frames: 60 });
  assert.deepStrictEqual(probe.segmentOf({ res: '2160', frames: 15 }, 'cuda'), { loops: 2, frames: 30 });
  assert.deepStrictEqual(probe.segmentOf({ res: '1080', frames: 30 }, 'none'), { loops: 6, frames: 180 }, 'software segments are longer');
  assert.deepStrictEqual(probe.segmentOf({ res: '480' }, 'cuda'), { loops: 2, frames: 60 }, 'unknown resolution and no frame count: defaults');
  assert.deepStrictEqual(probe.segmentOf({ res: '1080', frames: 1000 }, 'cuda'), { loops: 1, frames: 1000 }, 'a clip longer than the segment: one loop');
  assert.strictEqual(probe.segmentSpeed([]), 0);
  assert.strictEqual(probe.segmentSpeed([5]), 0);
  assert.strictEqual(probe.segmentSpeed([0, 10, 20, 30, 40]), 0, 'under 6 frames: nothing to measure');
  assert.strictEqual(probe.segmentSpeed(Array(10).fill(100)), 0, 'all frames at the same instant: no span');
  assert.strictEqual(probe.segmentSpeed(Array.from({ length: 11 }, (_, i) => i * 10)), 100, '10 ms per frame is 100 fps');
  assert.strictEqual(probe.segmentSpeed(Array.from({ length: 50 }, (_, i) => (i < 6 ? i * 500 : 3000 + (i - 6) * 10))), 100, 'a slow start is skipped');
  assert.deepStrictEqual(probe.decodedPerInput(''), {});
  assert.deepStrictEqual(probe.decodedPerInput(undefined), {});
  assert.deepStrictEqual(probe.decodedPerInput('Input stream #0:0 (audio): 3 packets read (1 bytes); 3 frames decoded; 0 decode errors'), {}, 'audio inputs are not counted');
  assert.deepStrictEqual(probe.decodedPerInput('Input stream #12:0 (video): 3 packets read (1 bytes); 3 frames decoded; 1 decode errors (x)'), { 12: { frames: 3, errors: 1 } });
  assert.deepStrictEqual(probe.outSize('1080', 0), [1920, 1080]);
  assert.deepStrictEqual(probe.outSize('2160', 1080), [1920, 1080]);
  assert.deepStrictEqual(probe.outSize('2160', 2160), [3840, 2160]);
  assert.deepStrictEqual(probe.outSize('1080', 721), [1280, 720], 'odd heights are made even');
  assert.deepStrictEqual(probe.outSize('1080', 5), [6, 4], 'tiny heights stay even');
  const ow = probe.outSize('1080', 1);
  assert.ok(ow[0] % 2 === 0 && ow[1] % 2 === 0);

  // pickMethod: nothing, only failures, zero / NaN speeds, hysteresis, a comfortable first.
  assert.strictEqual(probe.pickMethod([]), null);
  assert.strictEqual(probe.pickMethod([{ method: 'a', ok: false, fps: 500 }]), null);
  assert.strictEqual(probe.pickMethod([{ method: 'a', ok: true, fps: 0 }, { method: 'b', ok: true, fps: NaN }]), null);
  assert.strictEqual(probe.pickMethod([{ method: 'a', ok: true, fps: 20 }, { method: 'b', ok: true, fps: 25 }]).method, 'a', 'less than 1.3x faster: stay');
  assert.strictEqual(probe.pickMethod([{ method: 'a', ok: true, fps: 20 }, { method: 'b', ok: true, fps: 27 }]).method, 'b');
  assert.strictEqual(probe.pickMethod([{ method: 'a', ok: true, fps: 70 }, { method: 'b', ok: true, fps: 700 }]).method, 'a', 'comfortable already');
  assert.strictEqual(probe.pickMethod([{ method: 'a', ok: true, fps: 70 }, { method: 'b', ok: true, fps: 700 }], 1000).method, 'b', 'a higher need');

  // loopList: written once; quotes and odd characters in the path.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vpe_probe_run_'));
  try {
    const f = path.join(dir, "it's a clip (1).mkv");
    const list = probe.loopList(dir, f, 3);
    assert.ok(/^[\w.-]+\.3\.ffconcat$/.test(path.basename(list)), 'file name is sanitised');
    const text = fs.readFileSync(list, 'utf8');
    assert.strictEqual(text.split('\n').filter((l) => l.startsWith('file ')).length, 3);
    assert.ok(text.includes("it'\\''s a clip (1).mkv'"), 'a quote is escaped as \'\\\'\'');
    assert.ok(!text.includes('\\\\'), 'backslashes become slashes');
    fs.writeFileSync(list, 'sentinel');
    assert.strictEqual(probe.loopList(dir, f, 3), list);
    assert.strictEqual(fs.readFileSync(list, 'utf8'), 'sentinel', 'an existing list is not rewritten');
    assert.notStrictEqual(probe.loopList(dir, f, 4), list, 'another loop count, another list');

    // runArgs without a list directory repeats with -stream_loop; with one, a concat list.
    const items = [{ path: f, res: '1080', frames: 30, depth: 8 }, { file: f, res: '1080', frames: 30, depth: 10 }];
    const noList = probe.runArgs('none', items, [1920, 1080], null, new Set());
    assert.strictEqual(noList.filter((a) => a === '-stream_loop').length, 2);
    assert.strictEqual(noList[noList.indexOf('-stream_loop') + 1], '5', 'loops - 1');
    const withList = probe.runArgs('none', items, [1920, 1080], dir, new Set());
    assert.ok(!withList.includes('-stream_loop') && withList.includes('concat'));
    assert.ok(withList.join(' ').includes('concat=n=2:v=1:a=0'));
    // Full-range 8-bit keeps the CPU path; limited-range 8-bit 4:2:0 and 10-bit 4:2:0 scale on the GPU.
    const hevc = items.map((it) => ({ ...it, codec: 'hevc', pixFmt: it.depth === 10 ? 'yuv420p10le' : 'yuvj420p' }));
    const both = probe.runArgs('cuda', hevc.map((it) => ({ ...it, pixFmt: it.depth === 10 ? it.pixFmt : 'yuv420p' })), [1920, 1080], null, new Set(['scale_cuda']));
    assert.strictEqual(both.filter((a) => a === '-hwaccel_output_format').length, 2, '8-bit 4:2:0 also through scale_cuda');
    const cuda = probe.runArgs('cuda', hevc, [1920, 1080], null, new Set(['scale_cuda']));
    const firstInput = cuda.indexOf('-i');
    assert.ok(!cuda.slice(0, firstInput).includes('-hwaccel_output_format'));
    assert.ok(cuda.slice(firstInput + 2).includes('-hwaccel_output_format'));
    const graph = cuda[cuda.indexOf('-filter_complex') + 1];
    assert.ok(graph.includes('[0:v:0]scale=1920:1080:flags=bilinear,format=yuv420p'));
    assert.ok(graph.includes('[1:v:0]scale_cuda=w=1920:h=1080:format=yuv420p:interp_algo=bilinear,hwdownload,format=yuv420p'));
    // referenceArgs: one input and one pipe per file.
    const refArgs = probe.referenceArgs(['a.mkv', 'b.mkv'], [[640, 360], [1280, 720]]);
    assert.deepStrictEqual(refArgs.filter((a) => /^pipe:/.test(a)), ['pipe:3', 'pipe:4']);
    assert.strictEqual(refArgs.filter((a) => a === '-i').length, 2);
    // clipBpp: a missing file is 0, an existing one is bits per pixel and frame.
    assert.strictEqual(probe.clipBpp(path.join(dir, 'nope.mkv'), clip(30)), 0);
    const big = path.join(dir, 'x.mkv');
    fs.writeFileSync(big, Buffer.alloc(1920 * 1080));
    assert.strictEqual(probe.clipBpp(big, { res: '1080', frames: 30 }), Math.round((8 / 30) * 10000) / 10000);
    assert.strictEqual(probe.clipBpp(big, { res: '1080' }), probe.clipBpp(big, { res: '1080', frames: 30 }), 'no frame count: 30');
    assert.ok(probe.clipBpp(big, { res: '2160', frames: 30 }) < probe.clipBpp(big, { res: '1080', frames: 30 }));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }

  // table: no ffmpeg version, no GPU, no seconds, a failed and a fallback method.
  const t = probe.table({ gpus: [], results: { 'h264 1080': { method: null, fps: 0, realtimeFactor: 0, tried: [{ method: 'cuda', ok: false }, { method: 'qsv', ok: false, fallback: true }, { method: 'none', ok: true, fps: 31 }] } } });
  assert.ok(t.startsWith('ffmpeg probe (?; no GPU found)'), t.split('\n')[0]);
  assert.ok(t.includes('cuda fail, qsv fallback, none 31'));
  assert.ok(t.includes('-'), 'no method is shown as a dash');
  const t2 = probe.table({ ffmpeg: 'ffmpeg version 7.1 Copyright (c) 2000', gpus: ['A', 'B'], secs: 4.2, results: {} });
  assert.ok(t2.startsWith('ffmpeg probe (ffmpeg version 7.1; A, B; 4.2 s)'));

  // stored / latest / save with a Map-backed state.
  const state = new Map();
  const st = { get: (k) => state.get(k), update: async (k, v) => { state.set(k, v); } };
  assert.strictEqual(probe.latest(st), null);
  assert.strictEqual(probe.stored(st, 'x'), null);
  await probe.save(st, { fp: 'x', complete: false });
  assert.strictEqual(probe.stored(st, 'x'), null, 'an incomplete record is not used');
  assert.strictEqual(probe.latest(st).fp, 'x', 'but it is the latest');
  await probe.save(st, { fp: 'x', complete: true });
  assert.strictEqual(probe.stored(st, 'x').fp, 'x');
  assert.strictEqual(probe.stored(st, 'y'), null, 'another fingerprint');

  // fingerprint: GPU order does not matter, cpu-only differs, missing hw fields are fine.
  const tools = { version: 'v', ffmpeg: 'ff' };
  const a = probe.fingerprint(tools, { gpus: [{ name: 'A', driver: '1' }, { name: 'B', driver: '2' }] });
  assert.strictEqual(a, probe.fingerprint(tools, { gpus: [{ name: 'B', driver: '2' }, { name: 'A', driver: '1' }] }));
  assert.notStrictEqual(a, probe.fingerprint(tools, { gpus: [{ name: 'A', driver: '1' }, { name: 'B', driver: '2' }] }, false));
  assert.ok(/^[0-9a-f]{16}$/.test(probe.fingerprint({}, {})));
  console.log('probe run: ok');
})().catch((e) => { console.error(e); process.exit(1); });
