'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PassThrough } = require('stream');
const { FAILED_KEY, failedBefore } = require('../../src/decide');
const ff = require('../../src/ffmpeg');
const { NativeDecoder } = require('../../src/native');
const { load, webviewConfig } = require('./mock_vscode');

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
        assert.ok(s.posted.some((m) => m.type === 'libav' && m.meta.native), 'native decoder was attached');
        const opened = proc;
        for (const t of [-1, '1', undefined, Infinity, NaN]) {
          await s.send({ type: 'nd', m: { type: 'seek', t } });
          assert.strictEqual(proc, opened, 'invalid seek leaves ffmpeg running');
        }
        const page = webviewConfig(s.panel.webview).page;
        if (typeof code === 'number' || code === 'SIGKILL') {
          proc.pid = 1;
          proc.emit('close', typeof code === 'number' ? code : null, code === 'SIGKILL' ? code : null);
        } else {
          proc.emit('error', Object.assign(new Error(`spawn failed: ${code}`), { code }));
        }
        await s.until(() => webviewConfig(s.panel.webview).page !== page);
        const cache = h.context.globalState.get(FAILED_KEY);
        assert.strictEqual(failedBefore(cache, file, fs.statSync(file)), code === 1, String(code));
        await s.send({ type: 'ready', boot: 'fallback' });
        assert.strictEqual(proc, opened, 'fallback avoids retrying ffmpeg in the same tab');
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
