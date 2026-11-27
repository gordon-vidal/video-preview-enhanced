'use strict';
// node test/run.js unit --grep tonemap_fallback: Live transcode's HDR tone-mapper fallback in the per-seek path
// (src/stream.js watchVideo, Step 0a). A hardware tone-mapper that fails before any frame is dropped for every stream
// with that ffmpeg; one that has given frames in this stream is not blamed for a later failure (NVENC out of sessions,
// a driver hiccup, a read error), so it is not banned for every HDR video. Without ffmpeg (fake processes).
const assert = require('assert');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const { EncodedStream } = require('../../src/stream');
const { createGpuSessions } = require('../../src/gpu-sessions');

function fakeProc() {
  const p = new EventEmitter();
  Object.assign(p, { stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, signalCode: null, err: { text: '' } });
  p.kill = (sig) => { if (p.exitCode !== null || p.signalCode) return; p.signalCode = sig; setImmediate(() => p.emit('close', null, sig)); };
  p.exit = (code) => { p.exitCode = code; setImmediate(() => p.emit('close', code, null)); };
  return p;
}

const PQ = {
  duration: 60, audio: null, formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
  video: { index: 0, codec: 'hevc', pixFmt: 'yuv420p10le', width: 1920, height: 1080, fps: 25, colorTransfer: 'smpte2084', colorPrimaries: 'bt2020' },
};
const idr = Buffer.from([0, 0, 1, 9, 0xf0, 0, 0, 1, 0x67, 0x11, 0, 0, 1, 0x68, 0x11, 0, 0, 1, 0x65, 0x11]);
const tick = () => new Promise((r) => setTimeout(r, 10));

function make(tools) {
  const logs = [];
  const s = new EncodedStream({
    tools, file: 'in.mp4', post: () => {}, log: (m) => logs.push(m), remote: false, maxHeight: 1080, encoder: 'h264_nvenc',
    cpuEncoder: 'libx264', gpuSessions: createGpuSessions(8), probed: PQ, warm: false, allowSoftwareFallback: true,
  });
  s.fps = 25;
  s.sizeVideo();
  const launched = [];
  s.launch = (t, audio, opts) => { s.args(t, audio, opts); const p = fakeProc(); p.t = t; p.tonemap = s.tonemapKind; p.encoder = s.videoEncoder; launched.push(p); return p; };
  return { s, logs, launched };
}

(async () => {
  { // Proven in this stream, then a failure: not the tone-mapper's fault; it stays usable for this and every other video.
    const tools = { ffmpeg: 'ffmpeg', gpuFilters: new Set(['libplacebo', 'tonemap_opencl', 'hwupload', 'hwdownload', 'zscale', 'tonemap']) };
    const a = make(tools);
    a.s.handle({ type: 'open', view: { w: 1920, h: 1080 } });
    assert.strictEqual(a.launched[0].tonemap, 'libplacebo');
    a.launched[0].stdout.write(idr); // a frame: the tone-mapper works
    a.launched[0].err.text = 'OpenEncodeSessionEx failed: out of memory (10)';
    a.launched[0].exit(1);
    await tick();
    assert.ok(!a.logs.some((l) => /libplacebo HDR tone-mapping failed/.test(l)), a.logs.join('\n'));
    assert.ok(a.launched.length >= 2, `the stream restarts: ${a.logs.join('\n')}`);
    // The encoder is the suspect (src/stream.js Step 2), not the tone-mapper: no next tone-mapping path on the GPU.
    assert.ok(a.logs.some((l) => /h264_nvenc failed/.test(l)), a.logs.join('\n'));
    assert.notStrictEqual(a.launched.at(-1).tonemap, 'opencl');
    const b = make(tools);
    b.s.handle({ type: 'open', view: { w: 1920, h: 1080 } });
    assert.strictEqual(b.launched[0].tonemap, 'libplacebo', 'the next HDR video with this ffmpeg still uses it');
    a.s.dispose();
    b.s.dispose();
  }
  { // Never gave a frame: dropped, here and for the next video with this ffmpeg.
    const tools = { ffmpeg: 'ffmpeg', gpuFilters: new Set(['libplacebo', 'tonemap_opencl', 'hwupload', 'hwdownload', 'zscale', 'tonemap']) };
    const a = make(tools);
    a.s.handle({ type: 'open', view: { w: 1920, h: 1080 } });
    a.launched[0].err.text = 'Vulkan: no device';
    a.launched[0].exit(1);
    await tick();
    assert.ok(a.logs.some((l) => /libplacebo HDR tone-mapping failed/.test(l)), a.logs.join('\n'));
    assert.strictEqual(a.launched.at(-1).tonemap, 'opencl', 'the next tone-mapping path');
    const b = make(tools);
    b.s.handle({ type: 'open', view: { w: 1920, h: 1080 } });
    assert.strictEqual(b.launched[0].tonemap, 'opencl', 'the next video skips the failed one');
    a.s.dispose();
    b.s.dispose();
  }
  console.log('tonemap fallback: ok');
})().catch((e) => { console.error(e); process.exit(1); });
