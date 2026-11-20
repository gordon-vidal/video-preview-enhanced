'use strict';
// node test/host/rangecmd_test.js: A-B export names, checks and the ffmpeg command line.
const assert = require('assert');
const r = require('../../src/rangecmd');

assert.strictEqual(r.frameFileName('clip', 123), 'clip_f000123.png');
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

console.log('rangecmd: ok');
