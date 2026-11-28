'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { withPage, CLIPS } = require('../host/unified-page-fixture');
const { createVirtualClock } = require('../lib/virtual-clock');

async function engineContract() {
  const clock = createVirtualClock();
  const chunks = [];
  const drawn = [];
  const env = {
    performance: { timeOrigin: 0, now: clock.now },
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    VideoDecoder: class {
      constructor({ output }) { this.output = output; }
      configure() { this.state = 'configured'; }
      decode(chunk) { chunks.push({ chunk, output: this.output }); }
      flush() { return Promise.resolve(); }
      close() { this.state = 'closed'; }
    },
    VideoFrame: class { close() {} },
    EncodedVideoChunk: class { constructor(fields) { Object.assign(this, fields); } },
  };
  env.self = env;
  vm.createContext(env);
  for (const file of ['block-cache.js', 'gl-renderer.js', 'codec-utils.js', 'decoder-boot.js', 'packet-cache.js', 'engine.js']) {
    const filename = path.join(__dirname, '..', '..', 'media', file);
    vm.runInContext(fs.readFileSync(filename, 'utf8'), env, { filename });
  }

  await withPage(async ({ app, posted, send }) => {
    send({ type: 'open' });
    const player = app.players.get('A');
    await player.started;
    const bytes = Uint8Array.of(1, 2);
    const reply = (m) => send({ type: 'nd', clipId: 'A', m });
    const complete = () => {
      const { chunk, output } = chunks.shift();
      const frame = { timestamp: chunk.timestamp, close() { this.closed = true; } };
      output(frame);
      assert.equal(frame.closed, true);
    };
    const asks = (type) => posted.filter((m) => m.type === 'nd' && m.m.type === type);
    const ask = (type, m) => assert.deepEqual(structuredClone(asks(type).at(-1)),
      { type: 'nd', page: 7, boot: 1, key: 'A', clipId: 'A', m });

    reply({ type: 'read', pos: 4, len: 2, rid: 1 });
    assert.deepEqual(posted.find((m) => m.type === 'readBlock'),
      { type: 'readBlock', page: 7, boot: 1, key: 'A', clipId: 'A', pos: 0, len: 1 << 20 });
    send({ type: 'block', clipId: 'A', pos: 0, data: Uint8Array.of(0, 0, 0, 0, 1, 2) });

    // A paused remote decoder with a configured video path, before its next picture is drawn.
    Object.assign(player, { remoteStream: true, nativeLossy: true, vmode: 'webcodecs', amode: 'none',
      vconf: { codec: 'avc1.64001f' }, fps: 25, quickHook: true });
    player.seekAbs(2);
    ask('seek', { type: 'seek', gen: 1, t: 2, playing: false, warm: true, quick: true });
    player.seekAbs(4);
    ask('seek', { type: 'seek', gen: 2, t: 4, playing: false, warm: true, quick: true });
    reply({ type: 'seeked', gen: 2, t: 4 });
    ask('more', { type: 'more', gen: 2, limit: 384 * 1024, videoUntil: 14 });
    reply({ type: 'quickFrame', gen: 1, t: 4, w: 640, h: 360, data: bytes });
    assert.equal(chunks.length, 0, 'old generation never reaches the side decoder, even at the current target');
    reply({ type: 'quickFrame', gen: 2, t: 4, w: 640, h: 360, data: bytes });
    assert.equal(chunks.length, 1, 'current quick picture reaches the side decoder');
    player.seekAbs(4);
    complete();
    assert.equal(drawn.length, 0, 'the previous generation cannot draw after an asynchronous decoder output');
    reply({ type: 'quickFrame', gen: 3, t: 4, w: 640, h: 360, data: bytes });
    complete();
    assert.equal(drawn.length, 1, 'the current quick picture can draw');

    Object.assign(player, { shownT: 4, seekTarget: null, packetCache: env.VpePacketCache.create() });
    player.scheduleFill();
    player.scheduleSharp();
    clock.advance(250);
    ask('fill', { type: 'fill', id: 1, from: 2, to: 4 });
    ask('sharp', { type: 'sharp', id: 1, t: 4 });
    reply({ type: 'fillBatch', id: 0, video: [], done: false });
    assert.equal(asks('fillMore').length, 0);
    reply({ type: 'fillBatch', id: 1, video: [], done: false });
    ask('fillMore', { type: 'fillMore', id: 1 });

    player.scheduleSharp();
    clock.advance(150);
    ask('sharp', { type: 'sharp', id: 2, t: 4 });
    reply({ type: 'sharpFrame', id: 1, t: 4, data: bytes, done: true });
    assert.equal(chunks.length, 0, 'superseded sharp reply never reaches the side decoder');
    reply({ type: 'sharpFrame', id: 2, t: 4, data: bytes, done: false });
    ask('sharpMore', { type: 'sharpMore', id: 2 });
    reply({ type: 'sharpFrame', id: 2, t: 4, data: bytes, done: true });
    assert.equal(chunks.length, 1);
    player.scheduleSharp();
    clock.advance(150);
    ask('sharp', { type: 'sharp', id: 3, t: 4 });
    complete();
    assert.equal(drawn.length, 1, 'a superseded sharp decode cannot draw');
    reply({ type: 'sharpFrame', id: 3, t: 4, data: bytes, done: true });
    complete();
    assert.equal(drawn.length, 2, 'the current sharp picture can draw');
  }, {
    cfg: { clips: [{ ...CLIPS[0], size: 6, native: true }] },
    defaultFactory: true,
    createEngine: (options) => env.createEngine({ ...options, createRenderer: () => ({ setRotation() {}, drawFrame: (frame) => drawn.push(frame) }) }),
  });
  assert.equal(clock.pending(), 0, 'page disposal clears virtual timers');
}

module.exports = { engineContract };
