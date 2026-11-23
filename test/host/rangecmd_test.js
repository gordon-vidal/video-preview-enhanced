'use strict';
// node test/host/rangecmd_test.js: A-B export names, checks and the ffmpeg command line.
const assert = require('assert');
const r = require('../../src/rangecmd');

assert.strictEqual(r.frameFileName('clip', 123), 'clip_f000123.png');
assert.strictEqual(r.clipFileName('clip', '.mov', 'B'), 'B_clip_A-B.mov');
assert.ok(r.rangeProblem(null));
assert.ok(r.rangeProblem({ fa: 3, fb: 9, fps: 0 }));
assert.ok(r.rangeProblem({ fa: 9, fb: 3, fps: 25 }));
assert.strictEqual(r.rangeProblem({ fa: 0, fb: 0, fps: 25 }), null);
assert.strictEqual(r.rangeProblem({ fa: 0, fb: 10, fps: 25, stride: 5 }), null);
assert.ok(r.rangeProblem({ fa: 0, fb: 10, fps: 25, stride: 0 }));
assert.ok(r.rangeProblem({ fa: 0, fb: 10, fps: 25, stride: -2 }));
assert.ok(r.rangeProblem({ fa: 0, fb: 10, fps: 25, stride: 1.5 }));
assert.ok(r.rangeProblem({ fa: 0, fb: 10, fps: 25, stride: 'abc' }));

// Stride parsing and validation.
assert.strictEqual(r.parseStride(1), 1);
assert.strictEqual(r.parseStride(5), 5);
assert.strictEqual(r.parseStride('1'), 1);
assert.strictEqual(r.parseStride(' 12 '), 12);
for (const bad of [0, -1, -10, 1.5, NaN, Infinity, -Infinity, '', '   ', '0', '-3', '2.5', 'abc', '3px', '1e2', '0x4', null, undefined, {}, []]) {
  assert.strictEqual(r.parseStride(bad), null, `expected null for ${String(bad)}`);
  assert.ok(r.strideProblem(bad), `expected problem for ${String(bad)}`);
}
assert.strictEqual(r.strideProblem('1'), null);
assert.strictEqual(r.strideProblem(4), null);

// Frame list, exported count, MAX_FRAMES & CONFIRM_FRAMES with stride, and VFR next-frame stepping.
assert.deepStrictEqual(r.rangeFrames({ fa: 0, fb: 4 }, 1), [0, 1, 2, 3, 4]);
assert.deepStrictEqual(r.rangeFrames({ fa: 0, fb: 10 }, 5), [0, 5, 10]);
assert.deepStrictEqual(r.rangeFrames({ fa: 0, fb: 9 }, 5), [0, 5]);
assert.deepStrictEqual(r.rangeFrames({ fa: 2, fb: 6, stride: 10 }), [2]); // stride > span
assert.strictEqual(r.rangeFrameCount({ fa: 0, fb: 10 }, 5), 3);
assert.strictEqual(r.rangeFrameCount({ fa: 0, fb: 9 }, 5), 2);
assert.strictEqual(r.rangeFrameCount({ fa: 2, fb: 6 }, 10), 1);
assert.strictEqual(r.rangeFrameCount({ fa: 0, fb: 4999 }, 1), 5000);
assert.ok(r.rangeFrameCount({ fa: 0, fb: 4999 }, 1) > r.MAX_FRAMES);
assert.strictEqual(r.rangeFrameCount({ fa: 0, fb: 4999 }, 5), 1000);
assert.ok(r.rangeFrameCount({ fa: 0, fb: 4999 }, 5) <= r.MAX_FRAMES);
assert.ok(r.rangeFrameCount({ fa: 0, fb: 499 }, 1) > r.CONFIRM_FRAMES);
assert.strictEqual(r.rangeFrameCount({ fa: 0, fb: 499 }, 2), 250);
assert.ok(r.rangeFrameCount({ fa: 0, fb: 499 }, 2) <= r.CONFIRM_FRAMES);
assert.strictEqual(r.nextRangeFrame(0, 0, 1), 1);
assert.strictEqual(r.nextRangeFrame(0, 3, 1), 4);
assert.strictEqual(r.nextRangeFrame(0, 0, 5), 5);
assert.strictEqual(r.nextRangeFrame(0, 2, 5), 5);
assert.strictEqual(r.nextRangeFrame(0, 5, 5), 10);
assert.strictEqual(r.nextRangeFrame(0, 7, 5), 10);
const boxOpts = r.strideInputOptions({ fa: 12, fb: 21 });
assert.strictEqual(boxOpts.value, '1');
assert.strictEqual(boxOpts.validateInput('5'), null);
assert.ok(boxOpts.validateInput('0'));
assert.ok(boxOpts.validateInput('abc'));

// Half a frame either side; never below 0.
let c = r.ffmpegRange('C:\\v\\my clip.mkv', { fa: 0, fb: 9, fps: 25 }, 'win32');
assert.strictEqual(c.ss, '0');
assert.strictEqual(c.to, '0.38');
// Windows default shell is PowerShell: single quotes, nothing expands.
assert.ok(c.exact.startsWith("ffmpeg -ss 0 -to 0.38 -i 'C:\\v\\my clip.mkv' "), c.exact);
assert.ok(c.exact.endsWith("'.\\my clip_f000001-f000010.mp4'"), c.exact);
assert.ok(/ -c copy /.test(c.copy) && c.copy.endsWith("'.\\my clip_f000001-f000010_copy.mkv'"), c.copy);
// Injection attempts stay literal in PowerShell.
c = r.ffmpegRange("C:\\v\\clip $(calc) `x` it's.mp4", { fa: 0, fb: 1, fps: 25 }, 'win32', 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
assert.ok(c.exact.includes("-i 'C:\\v\\clip $(calc) `x` it''s.mp4' "), c.exact);
// cmd: double quotes; names with % are refused.
c = r.ffmpegRange('C:\\v\\a b.mp4', { fa: 0, fb: 1, fps: 25 }, 'win32', 'C:\\Windows\\System32\\cmd.exe');
assert.ok(c.exact.includes('-i "C:\\v\\a b.mp4" '), c.exact);
assert.throws(() => r.ffmpegRange('C:\\v\\50%off.mp4', { fa: 0, fb: 1, fps: 25 }, 'win32', 'cmd.exe'));
// Git Bash on Windows: POSIX quoting; an output name starting with '-' is not an option.
c = r.ffmpegRange('C:\\v\\-y.mp4', { fa: 0, fb: 1, fps: 25 }, 'win32', 'C:\\Program Files\\Git\\bin\\bash.exe');
assert.ok(c.exact.endsWith("'./-y_f000001-f000002.mp4'"), c.exact);

c = r.ffmpegRange("/home/u/it's.mov", { fa: 12, fb: 21, fps: 30000 / 1001 }, 'linux');
assert.strictEqual(c.ss, String(Math.round((11.5 * 1001 / 30000) * 1e4) / 1e4));
assert.ok(c.exact.includes(`-i '/home/u/it'\\''s.mov' `), c.exact);

const { containerFor, fallbackFor, streamsForClip, validRange, selectRange, copyArgs } = require('../../src/cliprange');
const { offsetSeconds, mapRange } = require('../../media/comparerange');
assert.strictEqual(containerFor('clip.mov', 'mov,mp4,m4a'), '.mov');
assert.strictEqual(containerFor('clip.avi', 'avi'), '.mp4');
assert.strictEqual(fallbackFor('clip.webm', 'matroska,webm'), '.webm');
assert.strictEqual(fallbackFor('clip.mxf', 'mxf'), '.mxf');
assert.strictEqual(fallbackFor('clip.mp4', 'mov,mp4,m4a'), undefined);
const audio = [{ index: 1, codec_type: 'audio' }, { index: 2, codec_type: 'audio' }];
const video = { index: 3, codec_type: 'video' };
const subtitles = [{ index: 4, codec_type: 'subtitle' }];
assert.deepStrictEqual(streamsForClip([
  { index: 0, codec_type: 'video', disposition: { attached_pic: 1 } }, ...audio, video, ...subtitles,
]), { video, audio, subtitles });
assert(!validRange({ a: 2, b: 1, early: 0 }));
assert(!validRange({ a: 1, b: Infinity, early: 0 }));
const masterOffset = offsetSeconds({ v: 2, unit: 'frames' }, 25);
const followerOffset = offsetSeconds({ v: -50, unit: 'ms' }, 30);
const follower = mapRange(0.25 - masterOffset, 0.5 - masterOffset, followerOffset, 30, false);
assert(Math.abs(follower.a - 0.12) < 1e-9 && Math.abs(follower.b - 0.37) < 1e-9);
assert.strictEqual(follower.early, 1 / 60);
const newClock = mapRange(0.25 - masterOffset, 0.5 - masterOffset, followerOffset, 30, true);
assert.strictEqual(newClock.a, follower.a);
assert.strictEqual(newClock.early, 0);
const frames = [10, 10.04, 10.11, 10.14].map((t) => ({ t, duration: 0.04 }));
assert.deepStrictEqual(selectRange({ a: 0.04, b: 0.11, early: 0 }, frames, 10, 0.001, 10.18), {
  first: 1, last: 2, start: 10.04, end: 10.14,
  startDelta: 10.04 - 10 - 0.04, endDelta: 10.11 - 10 - 0.11,
});
assert.strictEqual(selectRange({ a: 0.14, b: 0.14, early: 0 }, frames, 10, 0.001, 10.18).end, 10.18);
assert.throws(() => selectRange({ a: -0.01, b: 0.14, early: 0 }, frames, 10, 0.001, 10.18), /outside/);
const args = copyArgs('a b.mkv', 'target.mp4', { video: 3, streams: [1, 2], start: 0.04, duration: 0.1, exact: true });
assert.deepStrictEqual(args.slice(5, 18),
  ['-ss', '0.040000', '-protocol_whitelist', 'file', '-i', 'a b.mkv', '-map', '0:3', '-map', '0:1', '-map', '0:2', '-map_chapters']);
assert.strictEqual(args[args.indexOf('-c') + 1], 'copy');
assert.strictEqual(args[args.indexOf('-use_editlist') + 1], '1');
assert.strictEqual(args.at(-1), 'target.mp4');

// End-to-end host exportRange flow with stride (default 1, > 1, > span, MAX_FRAMES/CONFIRM_FRAMES, invalid & cancelled).
(async () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { load, webviewConfig } = require('./mock_vscode');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vpe_range_'));
  const file = path.join(dir, 'clip.mp4');
  fs.writeFileSync(file, '');

  let inputReply = '5';
  let inputBoxes = [];
  let warnings = [];
  let infos = [];
  let written = [];
  let progresses = [];
  let existingFiles = [];
  let confirmReply = 'Export';
  let overwriteReply = 'Overwrite';

  const h = load({
    settings: { 'videoPreviewEnhanced.decoder': 'builtin' },
    setup(vscode) {
      vscode.window.showInputBox = async (o) => {
        inputBoxes.push(o);
        return typeof inputReply === 'function' ? inputReply(o) : inputReply;
      };
      vscode.window.showWarningMessage = async (msg) => {
        warnings.push(msg);
        if (msg.startsWith('Export ')) return confirmReply;
        if (msg.startsWith('Overwrite ')) return overwriteReply;
        return undefined;
      };
      vscode.window.showInformationMessage = async (msg) => { infos.push(msg); return undefined; };
      vscode.window.showOpenDialog = async () => [vscode.Uri.file(dir)];
      vscode.workspace.fs.readDirectory = async () => existingFiles.map((n) => [n, 1]);
      vscode.workspace.fs.writeFile = async (uri, data) => { written.push([path.basename(uri.fsPath), data[0]]); };
      vscode.workspace.fs.writeFileExclusive = async (uri, data) => { written.push([path.basename(uri.fsPath), data[0]]); return 'written'; };
      vscode.window.withProgress = async (_options, run) => run(
        { report(p) { progresses.push(p); } },
        { onCancellationRequested: () => ({ dispose() {} }) },
      );
    },
  });

  const s = h.open(file);
  try {
    await s.shown;
    const page = webviewConfig(s.panel.webview).page;
    const origPost = s.panel.webview.postMessage;
    const grabbed = [];
    s.panel.webview.postMessage = (m) => {
      const res = origPost(m);
      if (m.type === 'exportGrab') {
        grabbed.push(m.frame);
        queueMicrotask(() => {
          s.send({ type: 'exportFrame', page, id: m.id, frame: m.frame, data: Uint8Array.of(m.frame + 1) });
        });
      }
      return res;
    };

    // 1. Stride = 5 across frames 0..10 -> exports frames 0, 5, 10 as _f000001.png, _f000006.png, _f000011.png.
    inputReply = '5';
    await s.send({ type: 'exportRange', page, range: { fa: 0, fb: 10, fps: 30 } });
    assert.strictEqual(inputBoxes.length, 1);
    assert.strictEqual(inputBoxes[0].value, '1');
    assert.deepStrictEqual(grabbed, [0, 5, 10]);
    assert.deepStrictEqual(written, [
      ['clip_f000001.png', 1],
      ['clip_f000006.png', 6],
      ['clip_f000011.png', 11],
    ]);
    assert.deepStrictEqual(progresses.map((p) => p.message), ['1 / 3', '2 / 3', '3 / 3']);
    const totalInc = progresses.reduce((sum, p) => sum + (p.increment || 0), 0);
    assert.ok(Math.abs(totalInc - 100) < 1e-6, `expected total increment 100, got ${totalInc}`);

    // 2. Stride > span (fa=2, fb=6, stride=10) -> exports just frame 2 (_f000003.png).
    grabbed.length = 0; written.length = 0; progresses.length = 0;
    inputReply = '10';
    await s.send({ type: 'exportRange', page, range: { fa: 2, fb: 6, fps: 30 } });
    assert.deepStrictEqual(grabbed, [2]);
    assert.deepStrictEqual(written, [['clip_f000003.png', 3]]);
    assert.deepStrictEqual(progresses.map((p) => p.message), ['1 / 1']);

    // 3. Long span (3000 frames > MAX_FRAMES=2000) with stride 1000 -> 3 exported frames (no MAX_FRAMES or CONFIRM_FRAMES block).
    grabbed.length = 0; written.length = 0; warnings.length = 0;
    inputReply = '1000';
    await s.send({ type: 'exportRange', page, range: { fa: 0, fb: 2999, fps: 30 } });
    assert.strictEqual(warnings.length, 0);
    assert.deepStrictEqual(grabbed, [0, 1000, 2000]);
    assert.deepStrictEqual(written.map(([n]) => n), ['clip_f000001.png', 'clip_f001001.png', 'clip_f002001.png']);

    // 4. Exported count > MAX_FRAMES even with stride (fa=0, fb=5000, stride=2 -> 2501 frames) -> refused before folder pick.
    grabbed.length = 0; written.length = 0; warnings.length = 0;
    inputReply = '2';
    await s.send({ type: 'exportRange', page, range: { fa: 0, fb: 5000, fps: 30 } });
    assert.strictEqual(warnings.length, 1);
    assert.ok(/2501 frames at stride 2; export takes at most 2000/.test(warnings[0]), warnings[0]);
    assert.strictEqual(grabbed.length, 0);

    // 5. Overwrite check only counts existing files matching the strided frame indices.
    grabbed.length = 0; written.length = 0; warnings.length = 0;
    existingFiles = ['clip_f000002.png', 'clip_f000006.png']; // frame 2 is skipped by stride 5; frame 6 is hit
    inputReply = '5';
    overwriteReply = 'Cancel';
    await s.send({ type: 'exportRange', page, range: { fa: 0, fb: 10, fps: 30 } });
    assert.strictEqual(warnings.length, 1);
    assert.ok(warnings[0].startsWith('Overwrite 1 existing file?'), warnings[0]);
    assert.strictEqual(grabbed.length, 0);
    existingFiles = [];

    // 6. User cancels stride prompt (undefined) -> no warnings, no errors, no frames exported.
    grabbed.length = 0; written.length = 0; warnings.length = 0; infos.length = 0;
    inputReply = undefined;
    await s.send({ type: 'exportRange', page, range: { fa: 0, fb: 10, fps: 30 } });
    assert.strictEqual(warnings.length, 0);
    assert.strictEqual(infos.length, 0);
    assert.strictEqual(grabbed.length, 0);

    // 7. Invalid stride returned from prompt -> rejected cleanly with warning, no frames exported.
    for (const bad of ['0', '-2', '1.5', 'abc', '']) {
      grabbed.length = 0; written.length = 0; warnings.length = 0;
      inputReply = bad;
      await s.send({ type: 'exportRange', page, range: { fa: 0, fb: 10, fps: 30 } });
      assert.strictEqual(warnings.length, 1, `expected warning for ${bad}`);
      assert.strictEqual(grabbed.length, 0);
    }

    // 8. Unsafe integer frame endpoints (2 ** 53) are rejected cleanly before counting or looping.
    assert.ok(r.rangeProblem({ fa: 2 ** 53, fb: 2 ** 53, fps: 30 }));
    assert.strictEqual(r.rangeFrameCount({ fa: 2 ** 53, fb: 2 ** 53 }, 1), 0);

    // 9. CONFIRM_FRAMES boundary (300 vs 301 strided targets): 300 skips prompt, 301 prompts and honours Cancel.
    grabbed.length = 0; written.length = 0; warnings.length = 0;
    inputReply = '2';
    confirmReply = 'Cancel';
    await s.send({ type: 'exportRange', page, range: { fa: 0, fb: 598, fps: 30 } }); // 300 strided targets
    assert.strictEqual(warnings.length, 0);
    assert.strictEqual(grabbed.length, 300);

    grabbed.length = 0; written.length = 0; warnings.length = 0;
    inputReply = '2';
    confirmReply = 'Cancel';
    await s.send({ type: 'exportRange', page, range: { fa: 0, fb: 600, fps: 30 } }); // 301 strided targets
    assert.strictEqual(warnings.length, 1);
    assert.ok(warnings[0].startsWith('Export 301 frames as PNG?'), warnings[0]);
    assert.strictEqual(grabbed.length, 0);
    confirmReply = 'Export';

    // 10. VFR / gapped video settling on an off-grid frame whose PNG already exists prompts before writing.
    grabbed.length = 0; written.length = 0; warnings.length = 0;
    existingFiles = ['clip_f000007.png']; // off-grid for stride 5 (targets 0, 5, 10), but frame 5 settles on 6 -> f000007
    inputReply = '5';
    overwriteReply = 'Cancel';
    const normalPost = s.panel.webview.postMessage;
    s.panel.webview.postMessage = (m) => {
      if (m.type === 'exportGrab') {
        grabbed.push(m.frame);
        const settled = m.frame === 5 ? 6 : m.frame;
        queueMicrotask(() => {
          s.send({ type: 'exportFrame', page, id: m.id, frame: settled, data: Uint8Array.of(settled + 1) });
        });
        return origPost(m);
      }
      return normalPost(m);
    };
    try {
      await s.send({ type: 'exportRange', page, range: { fa: 0, fb: 10, fps: 30 } });
      assert.strictEqual(warnings.length, 1);
      assert.ok(warnings[0].startsWith('Overwrite existing file clip_f000007.png?'), warnings[0]);
      assert.deepStrictEqual(written, [['clip_f000001.png', 1]]);
      assert.deepStrictEqual(grabbed, [0, 5]);
    } finally {
      s.panel.webview.postMessage = normalPost;
      existingFiles = [];
    }

    // 11. Accepting preflight overwrite for clip_f000001.png does NOT authorize overwriting an unapproved off-grid clip_f000007.png.
    grabbed.length = 0; written.length = 0; warnings.length = 0;
    existingFiles = ['clip_f000001.png', 'clip_f000007.png'];
    inputReply = '5';
    let overwriteCalls = 0;
    const origWarn = h.vscode.window.showWarningMessage;
    h.vscode.window.showWarningMessage = async (msg) => {
      warnings.push(msg);
      if (msg.startsWith('Overwrite ')) {
        overwriteCalls++;
        return overwriteCalls === 1 ? 'Overwrite' : 'Cancel'; // approve preflight, decline off-grid
      }
      return origWarn(msg);
    };
    const normalPost2 = s.panel.webview.postMessage;
    s.panel.webview.postMessage = (m) => {
      if (m.type === 'exportGrab') {
        grabbed.push(m.frame);
        const settled = m.frame === 5 ? 6 : m.frame;
        queueMicrotask(() => {
          s.send({ type: 'exportFrame', page, id: m.id, frame: settled, data: Uint8Array.of(settled + 1) });
        });
        return origPost(m);
      }
      return normalPost2(m);
    };
    try {
      await s.send({ type: 'exportRange', page, range: { fa: 0, fb: 10, fps: 30 } });
      assert.strictEqual(warnings.length, 2);
      assert.ok(warnings[0].startsWith('Overwrite 1 existing file?'), warnings[0]);
      assert.ok(warnings[1].startsWith('Overwrite existing file clip_f000007.png?'), warnings[1]);
      assert.deepStrictEqual(written, [['clip_f000001.png', 1]]);
    } finally {
      h.vscode.window.showWarningMessage = origWarn;
      s.panel.webview.postMessage = normalPost2;
      existingFiles = [];
    }

    // 12. Failed readDirectory still protects existing files via stat (including case-insensitive/concurrent files).
    grabbed.length = 0; written.length = 0; warnings.length = 0;
    const origReadDir = h.vscode.workspace.fs.readDirectory;
    const origStat = h.vscode.workspace.fs.stat;
    h.vscode.workspace.fs.readDirectory = async () => { throw new Error('EACCES'); };
    h.vscode.workspace.fs.stat = async (uri) => {
      if (path.basename(uri.fsPath).toLowerCase() === 'clip_f000006.png') return { type: 1, size: 10 };
      const err = new Error('not found');
      err.code = 'FileNotFound';
      throw err;
    };
    inputReply = '5';
    overwriteReply = 'Cancel';
    try {
      await s.send({ type: 'exportRange', page, range: { fa: 0, fb: 10, fps: 30 } });
      assert.strictEqual(warnings.length, 1);
      assert.ok(warnings[0].startsWith('Overwrite existing file clip_f000006.png?'), warnings[0]);
      assert.deepStrictEqual(written, [['clip_f000001.png', 1]]);
    } finally {
      h.vscode.workspace.fs.readDirectory = origReadDir;
      h.vscode.workspace.fs.stat = origStat;
    }

    console.log('rangecmd: ok');
  } finally {
    s.panel.dispose();
    h.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

(async () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { writeNew } = require('../../src/exclusivewrite');
  const { load } = require('./mock_vscode');
  const { Uri } = load().vscode;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vpe_excl_'));
  try {
    // a) A file that appears between the stat check and the write is not overwritten (real 'wx').
    const target = path.join(dir, 'clip_f000001.png');
    const wsFs = {
      stat: async () => { const e = new Error('nf'); e.code = 'FileNotFound'; throw e; }, // the check said: free
      writeFile: async (u, d) => fs.promises.writeFile(u.fsPath, d),
    };
    fs.writeFileSync(target, 'theirs'); // ...then someone creates it
    assert.strictEqual(await writeNew(wsFs, Uri.file(target), Uint8Array.of(1)), 'exists');
    assert.strictEqual(fs.readFileSync(target, 'utf8'), 'theirs');
    // approved overwrite still replaces it; a free name is created
    assert.strictEqual(await writeNew(wsFs, Uri.file(target), Uint8Array.of(7), { overwrite: true }), 'written');
    assert.deepStrictEqual([...fs.readFileSync(target)], [7]);
    const fresh = path.join(dir, 'fresh.png');
    assert.strictEqual(await writeNew(wsFs, Uri.file(fresh), Uint8Array.of(2)), 'written');
    assert.strictEqual(await writeNew(wsFs, Uri.file(fresh), Uint8Array.of(3)), 'exists');
    assert.deepStrictEqual([...fs.readFileSync(fresh)], [2]);
    // other errors propagate
    await assert.rejects(writeNew(wsFs, Uri.file(path.join(dir, 'no', 'x.png')), Uint8Array.of(1)), /ENOENT/);

    // b) Concurrent exports to one non-file URI: exactly one writes; the stat in the lock sees it for the rest.
    const store = new Map();
    let active = 0;
    let maxActive = 0;
    const virt = {
      stat: async (u) => {
        active++; maxActive = Math.max(maxActive, active);
        await new Promise((res) => setImmediate(res));
        active--;
        if (!store.has(u.toString())) { const e = new Error('nf'); e.code = 'FileNotFound'; throw e; }
        return { type: 1 };
      },
      writeFile: async (u, d) => { await new Promise((res) => setImmediate(res)); store.set(u.toString(), d[0]); },
    };
    const vuri = Uri.from({ scheme: 'vscode-vfs', authority: 'x', path: '/a/clip_f000001.png' });
    const results = await Promise.all([1, 2, 3, 4].map((n) => writeNew(virt, vuri, Uint8Array.of(n))));
    assert.deepStrictEqual(results.filter((x) => x === 'written').length, 1);
    assert.strictEqual(results.filter((x) => x === 'exists').length, 3);
    assert.strictEqual(store.get(vuri.toString()), 1);
    assert.strictEqual(maxActive, 1, 'stat+write for one URI never overlap');
    console.log('rangecmd exclusive write: ok');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
