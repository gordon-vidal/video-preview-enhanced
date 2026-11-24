'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const cp = require('node:child_process');

const children = [];
const live = new Set();
const spawn = cp.spawn;
cp.spawn = (cmd, args, { signal } = {}) => {
  const p = Object.assign(new EventEmitter(), {
    cmd, args, stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, signalCode: null,
    close(code, reason) {
      assert.ok(live.delete(this), `${cmd} closed twice`);
      signal?.removeEventListener('abort', abort);
      this.exitCode = code;
      this.signalCode = reason;
      this.stdout.destroy();
      this.stderr.destroy();
      this.emit('exit', code, reason);
      this.emit('close', code, reason);
    },
    kill(reason = 'SIGTERM') {
      assert.equal(this.signalCode, null, `${cmd} killed twice`);
      this.signalCode = reason;
      setImmediate(() => this.close(null, reason));
    },
  });
  const abort = () => { p.kill(); p.emit('error', signal.reason); };
  signal?.addEventListener('abort', abort, { once: true });
  children.push(p);
  live.add(p);
  return p;
};
const { EncodedStream } = require('../../src/stream');
const { probe, run } = require('../../src/ffmpeg');
const { nativeThumb } = require('../../src/thumbhost');
cp.spawn = spawn;

const tools = { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' };
const video = { codec: 'hevc', width: 1920, height: 1080, fps: 25 };
const stream = (post = () => {}, audio = { index: 1 }) => new EncodedStream({
  tools, file: 'test.mkv', probed: { duration: 100, video, audio }, post, log() {}, onFail: assert.fail,
});

async function verify() {
  const first = stream();
  const second = stream();
  for (const tab of [first, second]) {
    tab.fps = 25;
    tab.startAt(0);
    tab.prepareLoop();
  }
  assert.equal(live.size, 6, 'each tab owns a video, audio and prepared loop process');
  first.dispose();
  second.transitionVideo(true);
  assert.ok(second.overlap, 'second tab is starting a replacement encoder');
  second.seek({ gen: 1, t: 10 });
  assert.equal(second.overlap, null, 'seek tears down the overlapping encoder');
  second.seek({ gen: 2, t: 20 });
  assert.ok(second.startTimer, 'a replacement seek is pending');
  second.dispose();
  assert.equal(second.startTimer, null);

  const cancel = new AbortController();
  const input = { url: 'https://example.test/video.mp4' };
  const pendingProbe = assert.rejects(probe(tools, input, cancel.signal), { name: 'AbortError' });
  const pendingDecode = run(tools.ffmpeg, ['-i', input.url], 1000, cancel.signal);
  await new Promise((resolve) => setImmediate(resolve));
  const urlChildren = children.slice(-2).map((p) => p.cmd).sort();
  cancel.abort();
  await pendingProbe;
  await pendingDecode;
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(urlChildren, ['ffmpeg', 'ffprobe']);
  assert.equal(children.length, 9, 'closing tabs cancels queued starts');
  assert.deepEqual([...live], [], 'every spawned process has closed');
  assert.ok(children.every((p) => p.signalCode && p.stdout.destroyed && p.stderr.destroyed));

  const thumb = { tools, file: 'test.mkv', pr: { video } };
  for (const size of [25 * 1024 - 1, 25 * 1024, 25 * 1024 + 1]) {
    const reply = nativeThumb(thumb, { t: 0, w: 160, h: 90 });
    const child = children.at(-1);
    const jpeg = Buffer.alloc(size);
    jpeg.set([0xff, 0xd8]);
    jpeg.set([0xff, 0xd9], size - 2);
    child.stdout.write(jpeg.subarray(0, size - 1));
    child.stdout.write(jpeg.subarray(size - 1));
    child.close(0, null);
    const result = await reply;
    if (size > 25 * 1024) assert.equal(result, null, 'oversized JPEG is discarded whole');
    else {
      assert.equal(result.fmt, 'jpeg');
      assert.deepEqual(Buffer.from(result.data), jpeg, 'thumb payload is a complete JPEG within the cap');
    }
  }

  const batches = [];
  const oversized = stream((m) => batches.push(m), null);
  oversized.fps = 25;
  const cap = 128 * 1024;
  const data = Buffer.alloc(2 * cap + 7, 23);
  oversized.vAll = [{ t: 0, data, idr: true }, { t: 1, data: Buffer.alloc(10), idr: false }];
  for (let i = 0; i < 4; i++) {
    oversized.more({ gen: 0, limit: 384 * 1024 });
    assert.equal(batches.length, i + 1, 'one response per pull');
  }
  assert.deepEqual(batches.map((m) => m.video[0].data.byteLength), [cap, cap, 7, 10]);
  assert.deepEqual(batches.slice(0, 3).map((m) => m.fragment.offset), [0, cap, 2 * cap]);
  assert.deepEqual(Buffer.concat(batches.slice(0, 3).map((m) => m.video[0].data)), data);
  oversized.dispose();
}

verify().then(() => console.log('child cleanup and wire budgets: ok')).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
