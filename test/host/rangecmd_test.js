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

console.log('rangecmd: ok');
