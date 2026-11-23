'use strict';

const assert = require('node:assert/strict');
const { serveBlock, isValidRange, readFileBlock } = require('../../src/read-block');

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

function validRanges() {
  for (const [pos, len] of [[0, 0], [0, 1], [5, 16], [2 ** 40, 8]]) assert.equal(isValidRange(pos, len), true, `${pos}+${len}`);
  const bad = [-1, -32, NaN, Infinity, -Infinity, 1.5, '1', null, undefined, {}];
  for (const v of bad) {
    assert.equal(isValidRange(v, 16), false, `pos ${String(v)}`);
    assert.equal(isValidRange(0, v), false, `len ${String(v)}`);
  }
}

// A fake file handle that records its reads and, like fs, throws on an unusable position.
function fakeFile(bytes) {
  const calls = [];
  return {
    calls,
    async read(buf, off, n, pos) {
      calls.push([n, pos]);
      if (!Number.isInteger(pos) || pos < 0) throw new RangeError(`bad position ${pos}`);
      const got = bytes.subarray(pos, pos + n);
      buf.set(got, off);
      return { bytesRead: got.length };
    },
  };
}

async function fileBlocks() {
  const bytes = Uint8Array.from({ length: 100 }, (_, i) => i);
  const fh = fakeFile(bytes);
  assert.deepEqual([...await readFileBlock(fh, 100, 10, 5, 1000)], [10, 11, 12, 13, 14], 'normal read');
  assert.equal((await readFileBlock(fh, 100, 95, 50, 1000)).length, 5, 'cut at the end of the file');
  assert.equal((await readFileBlock(fh, 100, 0, 50, 8)).length, 8, 'cut at the maximum block');
  assert.equal((await readFileBlock(fh, 100, 100, 8, 1000)).length, 0, 'at the end');
  assert.equal((await readFileBlock(fh, 100, 500, 8, 1000)).length, 0, 'past the end');
  assert.equal((await readFileBlock(fh, 100, 0, 0, 1000)).length, 0, 'zero length');
  const before = fh.calls.length;
  for (const [pos, len] of [[-1, 64], [-32, 64], [NaN, 8], [1.5, 8], [Infinity, 8], [0, -10], [0, NaN], [0, Infinity]]) {
    assert.equal((await readFileBlock(fh, 100, pos, len, 1000)).length, 0, `${pos}+${len}`);
  }
  assert.equal(fh.calls.length, before, 'an invalid range never reaches the file (no read at position -1, no RangeError)');
  // A short read is trimmed to the bytes read.
  const short = { async read() { return { bytesRead: 3 }; } };
  assert.equal((await readFileBlock(short, 100, 0, 10, 1000)).length, 3);
}

async function invalidRequests() {
  for (const [pos, len] of [[-1, 64], [NaN, 8], [1.5, 8], [0, -1], [0, Infinity]]) {
    const blocks = [];
    let reads = 0;
    await serveBlock({ type: 'readBlock', page: 1, pos, len }, () => true, async () => { reads++; return new Uint8Array(1); },
      (b) => blocks.push(b));
    assert.equal(reads, 0, `no read for ${pos}+${len}`);
    assert.equal(blocks.length, 1, 'the page still gets an answer');
    assert.equal(blocks[0].type, 'block');
    assert.equal(blocks[0].data.length, 0);
    assert.equal(blocks[0].error, 'invalid range');
  }
  // A stale page gets nothing, not even the error.
  const blocks = [];
  await serveBlock({ type: 'readBlock', page: 1, pos: -1, len: 8 }, () => false, async () => undefined, (b) => blocks.push(b));
  assert.deepEqual(blocks, []);
  // A read that gives up (undefined: replaced while open) posts nothing.
  await serveBlock({ type: 'readBlock', page: 1, pos: 0, len: 8 }, () => true, async () => undefined, (b) => blocks.push(b));
  assert.deepEqual(blocks, []);
}

(async () => {
  await lateRequest();
  await lateReply();
  validRanges();
  await fileBlocks();
  await invalidRequests();
  console.log('readBlock: lifecycle, range and file-block tests passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
