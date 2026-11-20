'use strict';
// The native recovery handshake, with a dropped HTTP reader and fake ffmpeg pipes.
const assert = require('assert');
const { EventEmitter, once } = require('events');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { PassThrough } = require('stream');
const vm = require('vm');
const { NativeDecoder } = require('../../src/native');
const frameserver = require('../../src/frameserver');

const noop = () => {};
const origin = 'vscode-webview://owner';
const probed = { duration: 90, video: { index: 0, codec: 'hevc', pixFmt: 'yuv420p', width: 3840, height: 2160, fps: 30 } };

async function droppedStream(outstandingSeek) {
  let callbacks, connect, acknowledge;
  const children = [];
  const messages = [];
  const raw = [];
  const ctx = { performance, FrameStream: { open(opts) { callbacks = opts; return { close: noop }; } } };
  const engine = vm.runInNewContext(`${fs.readFileSync(path.join(__dirname, '../../media/engine.js'), 'utf8')}\ncreateEngine`, ctx);
  const player = Object.assign(Object.create(engine({ log: noop, onMeta: noop }).LibavPlayer.prototype), {
    info: { video: { ...probed.video, sourceWidth: 3840, sourceHeight: 2160 } },
    meta: { duration: 90 }, gen: 0, startT: 0, fps: 30, pauseT: 10, shownT: 10, seekTarget: null,
    playing: false, vmode: 'soft', amode: 'none', queue: [{ t: 10 }, { t: 11 }], audio: [], sources: new Set(),
    onNativeVideo: () => assert.fail('a stale socket record reached the player'),
    worker: { postMessage(m) { messages.push(m); return nd.handle(m); } },
  });
  const ack = new Promise((r) => { acknowledge = r; });
  const reader = new Promise((resolve, reject) => { connect = (url) => http.get(url, { headers: { Origin: origin } }, resolve).on('error', reject); });
  const nd = new NativeDecoder({ origin, probed, transport: 'http', maxHeight: 2160, messageMaxHeight: 1080, log: noop,
    post(m) {
      if (m.type === 'link') { player.openFrameStream(m); connect(m.url); }
      if (m.type === 'transport') acknowledge(m);
    },
    postRaw: (m) => raw.push(m),
  });
  nd.launch = (t) => {
    const child = Object.assign(new EventEmitter(), { t, w: nd.w, h: nd.h, err: { text: '' }, exitCode: null, stdout: new PassThrough(), kill() { this.killed = true; } });
    children.push(child);
    return child;
  };
  try {
    await nd.open();
    const res = await reader;
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(nd.h, 2160);
    if (outstandingSeek) player.seekAbs(60);
    const old = nd.proc;
    const oldGen = nd.gen;
    nd.more({ gen: oldGen });
    old.stdout.write(Buffer.alloc(nd.frameBytes));
    assert.strictEqual(nd.credits, 7, 'a socket write consumed a credit');
    old.emit('close', 0);
    assert.strictEqual(nd.eofSent, true, 'EOF was written to the socket');
    const closed = once(res, 'close');
    res.destroy();
    await closed;
    const change = await ack;
    assert.strictEqual(old.killed, true);
    assert.strictEqual(nd.standby, null, 'old-size standby discarded');
    assert.strictEqual(raw.length, 0, 'socket frames are never resent by message');
    const before = children.length;
    nd.more({ gen: oldGen });
    assert.strictEqual(nd.credits, 0, 'old requests cannot grant credits during recovery');
    player.eof = true;
    if (outstandingSeek) player.seekAbs(61); // arrives at the host while the acknowledgement is in flight
    assert.strictEqual(children.length, before, 'waiting for the one recovery seek');
    const target = outstandingSeek ? 61 : 10;
    await player.onWorker(change);
    assert.strictEqual(children.length, before + 1);
    assert.strictEqual(player.gen, oldGen + (outstandingSeek ? 2 : 1));
    assert.strictEqual(player.seekTarget, target);
    assert.strictEqual(player.queue.length, 0, 'even a playhead in the decoded queue must restart');
    assert.strictEqual(player.eof, false);
    assert.strictEqual(player.info.video.height, 1080);
    assert.strictEqual(player.nativeLossy, true);
    assert.deepStrictEqual([nd.proc.t, nd.proc.w, nd.proc.h], [target, 1920, 1080]);
    assert.strictEqual(nd.eofSent, false);
    assert.strictEqual(nd.ended, false);
    assert.strictEqual(nd.credits, 0);

    const n = messages.length;
    callbacks.onRecord({ kind: 1, gen: nd.gen }, Buffer.alloc(0), false);
    callbacks.onClose(new Error('late socket callback'));
    old.emit('error', new Error('late ffmpeg callback'));
    assert.strictEqual(messages.length, n);
    nd.more({ gen: nd.gen });
    nd.proc.stdout.write(Buffer.alloc(nd.frameBytes));
    assert.deepStrictEqual(raw.map((m) => [m.gen, m.t, m.w, m.h, m.data.length]), [[nd.gen, target, 1920, 1080, 3110400]]);
  } finally { nd.dispose(); }
}

(async () => {
  try {
    await droppedStream(true);
    await droppedStream(false);
    console.log('native transport recovery: ok');
  } finally { frameserver.stop(); }
})().catch((e) => { console.error(e); process.exit(1); });
