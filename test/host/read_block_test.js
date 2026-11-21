'use strict';

const assert = require('node:assert/strict');
const { serveBlock } = require('../../src/read-block');

async function lateRequest() {
  const request = { type: 'readBlock', page: 1, pos: 0, len: 16 };
  const blocks = [];
  let reads = 0;
  await serveBlock(request, (page) => page === 2, async () => {
    reads++;
    return new Uint8Array(16);
  }, (block) => blocks.push(block));
  assert.equal(reads, 0);
  assert.deepEqual(blocks, []);
}

async function lateReply() {
  const request = { type: 'readBlock', page: 1, pos: 16, len: 16 };
  const blocks = [];
  const data = new Uint8Array(16);
  let finishRead;
  const read = new Promise((resolve) => { finishRead = resolve; });
  let currentPage = 1;
  let reads = 0;
  const isCurrent = (page) => page === currentPage;
  const post = (block) => blocks.push(block);
  const pending = serveBlock(request, isCurrent, (pos, len) => {
    assert.deepEqual([pos, len], [16, 16]);
    reads++;
    return read;
  }, post);
  assert.equal(reads, 1);
  currentPage = 2;
  finishRead(data);
  await pending;
  assert.deepEqual(blocks, []);

  await serveBlock({ ...request, page: currentPage }, isCurrent, async () => data, post);
  assert.deepEqual(blocks, [{ type: 'block', page: 2, pos: 16, data }]);
}

(async () => {
  await lateRequest();
  await lateReply();
  console.log('readBlock: 2 lifecycle tests passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
