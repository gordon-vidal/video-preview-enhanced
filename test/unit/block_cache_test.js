'use strict';

const assert = require('node:assert/strict');
const { create } = require('../../media/block-cache');

const MiB = 1 << 20;

function setup(options = {}) {
  const requests = [];
  const replies = [];
  const logs = [];
  const timers = new Map();
  let time = 0;
  let nextId = 0;
  const clock = {
    now: () => time,
    set(fn, ms) {
      const id = nextId++;
      timers.set(id, { at: time + ms, fn });
      return id;
    },
    clear: (id) => timers.delete(id),
  };
  const cache = create({
    page: 7, size: 20 * MiB, budget: 64 * MiB, largeBlocks: false, clock,
    request: (m) => requests.push(m),
    send: (rid, message, transfer) => replies.push(structuredClone(message, { transfer })),
    log: (message) => logs.push(message),
    ...options,
  });
  function advance(ms) {
    const end = time + ms;
    for (const [id, { at, fn }] of timers) {
      if (at > end) break;
      timers.delete(id);
      time = at;
      fn();
    }
    time = end;
  }
  return { cache, requests, replies, logs, timers, advance };
}

{
  const { cache, requests, replies, timers } = setup();
  cache.read(1, 1, 0);
  cache.read(2, 1, 1);
  cache.read(MiB, 1, 'thumbs');
  assert.deepEqual(requests, [0, MiB].map((pos) => ({ type: 'readBlock', page: 7, pos, len: MiB })));
  cache.receive(MiB, Uint8Array.of(9));
  assert.deepEqual(replies.map((r) => r.rid), ['thumbs']);
  const hostView = Uint8Array.of(0, 1, 2, 3, 4).subarray(1, 4);
  cache.receive(0, hostView);
  assert.deepEqual(replies.map((r) => [r.rid, ...r.data]), [['thumbs', 9], [0, 2, 3], [1, 3]]);
  assert.equal(hostView.buffer.byteLength, 5, 'the host buffer must survive worker transfers');
  hostView[1] = 99; // A subsequent hit reads from the original host view.
  cache.read(1, 1, 2);
  assert.deepEqual([...replies.at(-1).data], [99, 3]);
  assert.equal(requests.length, 2);
  assert.equal(timers.size, 0);
}

for (const budget of [MiB, 4 * MiB]) {
  const { cache, requests, replies } = setup({ budget });
  const block = new Uint8Array(MiB);
  const read = (index) => cache.read(index * MiB, 1, 'thumbs');
  for (let i = 0; i < 5; i++) {
    read(i);
    cache.receive(i * MiB, block);
  }
  read(2); // Kept by the three-block floor with one reader.
  assert.equal(replies.length, 6);
  assert.equal(requests.length, 5);
  read(budget === MiB ? 1 : 0); // Farthest from the reader when capacity was exceeded.
  assert.equal(requests.length, 6);
  assert.equal(replies.length, 6);
  cache.dispose();
}

{
  const { cache, requests, replies, logs, timers, advance } = setup({ largeBlocks: true });
  cache.read(1, 1, 'thumbs');
  cache.read(0, 1, 'side');
  assert.deepEqual(requests.map((r) => [r.pos, r.len]), [0, 4, 8, 12, 16].map((i) => [i * MiB, 4 * MiB]));
  advance(14999);
  assert.equal(requests.length, 5);
  advance(1);
  assert.deepEqual(requests.slice(5), [requests[0]]);
  advance(14999);
  assert.equal(replies.length, 0);
  advance(1);
  assert.deepEqual(replies.map((r) => [r.rid, r.pos, r.data.length]), [['thumbs', 1, 0], ['side', 0, 0]]);
  assert.deepEqual(logs, ['block 0 not read']);
  assert.equal(timers.size, 0);
}

{
  const { cache, requests, replies, logs, timers, advance } = setup();
  cache.read(-1, 1, 0);
  assert.equal(requests.length, 0);
  for (const error of ['invalid range', 'EIO']) {
    cache.read(6, 10, 'thumbs');
    cache.receive(0, new Uint8Array(0), error);
    assert.equal(replies.at(-1).pos, 6);
    assert.equal(replies.at(-1).data.length, 0);
  }
  assert.deepEqual(logs, ['block 0: invalid range', 'block 0: EIO']);
  cache.read(2, 10, 'stopped');
  cache.dropReader('stopped');
  assert.equal(timers.size, 0);
  cache.read(3, 10, 'thumbs');
  cache.dispose();
  assert.deepEqual(replies.map((r) => [r.rid, r.pos, r.data.length]),
    [[0, -1, 0], ['thumbs', 6, 0], ['thumbs', 6, 0], ['thumbs', 3, 0]]);
  assert.equal(timers.size, 0);
  const before = requests.length;
  cache.receive(0, Uint8Array.of(1, 2, 3, 4));
  cache.read(3, 1, 'thumbs');
  advance(60000);
  assert.equal(requests.length, before);
  assert.equal(replies.length, 4);
}

console.log('block cache checks passed');
