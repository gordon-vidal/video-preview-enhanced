'use strict';
// node test/run.js unit --grep native_failure: native ffmpeg failing on a viewer's clip (src/unified-viewer.js
// startNative onFail, src/extension.js nativeFailed): the clip plays in the page from then on, and only a file
// ffmpeg ran on and rejected is remembered (decide.FAILED_KEY).
const assert = require('assert');
const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PassThrough } = require('stream');
const { FAILED_KEY, failedBefore } = require('../../src/decide');
const ff = require('../../src/ffmpeg');
const { NativeDecoder } = require('../../src/native');
const { load } = require('./mock_vscode');

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vpe_native_failure_'));
  const file = path.join(dir, 'video.mkv');
  fs.writeFileSync(file, 'clip');
  const tools = { ffmpeg: 'test-ffmpeg', ffprobe: 'test-ffprobe', version: 'test' };
  ff.locateTools = async () => tools;
  ff.probe = async () => ({ video: { codec: 'hevc', width: 320, height: 180, fps: 30 }, duration: 2 });
  let proc;
  NativeDecoder.prototype.launch = function () {
    proc = Object.assign(new EventEmitter(), {
      startedAt: Date.now(), err: { text: 'Invalid input' }, stdout: new PassThrough(),
      stderr: new PassThrough(), kill() {},
    });
    return proc;
  };

  try {
    for (const code of ['ENOENT', 'EACCES', 'EMFILE', 'SIGKILL', 1]) {
      const h = load({ settings: { 'videoPreviewEnhanced.decoder': 'ffmpeg', 'videoPreviewEnhanced.gpuDecoding': false } });
      const s = h.open(file);
      try {
        await s.send({ type: 'ready' });
        assert.strictEqual(s.cfg().clips[0].native, true, 'native decoder chosen');
        await s.send({ type: 'nd', m: { type: 'open' } }); // the page's decoder starts ffmpeg
        assert.ok(proc, 'native decoder was attached');
        const opened = proc;
        for (const t of [-1, '1', undefined, Infinity, NaN]) {
          await s.send({ type: 'nd', m: { type: 'seek', t } });
          assert.strictEqual(proc, opened, 'invalid seek leaves ffmpeg running');
        }
        if (typeof code === 'number' || code === 'SIGKILL') {
          proc.pid = 1;
          proc.emit('close', typeof code === 'number' ? code : null, code === 'SIGKILL' ? code : null);
        } else {
          proc.emit('error', Object.assign(new Error(`spawn failed: ${code}`), { code }));
        }
        // The same file in its tile, decoded in the page from now on (a new clip id).
        await s.until((p) => p.some((m) => m.type === 'replaceTile'));
        const swap = s.posted.find((m) => m.type === 'replaceTile');
        assert.strictEqual(swap.clip.native, false, String(code));
        await new Promise((r) => setTimeout(r, 20)); // the failure is stored
        const cache = h.context.globalState.get(FAILED_KEY);
        assert.strictEqual(failedBefore(cache, file, fs.statSync(file)), code === 1, String(code));
        await s.send({ type: 'nd', clipId: swap.newId, m: { type: 'open' } });
        assert.strictEqual(proc, opened, 'fallback avoids retrying ffmpeg in the same tab');
        proc = null;
      } finally {
        s.panel.dispose();
        h.dispose();
      }
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log('native failure cache: ok');
})().catch((e) => { console.error(e); process.exitCode = 1; });
