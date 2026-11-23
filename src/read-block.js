'use strict';

/** @import { ReadBlockRequest, BlockReply } from '../tools/read-block-contract.js' */

// checkJs: start
/**
 * A byte range the page may ask for: whole numbers, a start at or after 0 and a length of 0 or more. A negative
 * start would otherwise reach fs as "read at the file position" (-1) and a fraction or NaN as a RangeError.
 * @param {unknown} pos
 * @param {unknown} len
 * @returns {boolean}
 */
function isValidRange(pos, len) {
  return Number.isSafeInteger(pos) && /** @type {number} */ (pos) >= 0
    && Number.isSafeInteger(len) && /** @type {number} */ (len) >= 0;
}

/**
 * The bytes of [pos, pos + len) from an open file of `size` bytes, cut at the end of the file and at `max`.
 * An invalid range or one past the end gives no bytes (never a read at a wrong position, never a throw).
 * @param {{ read(buf: Uint8Array, offset: number, length: number, position: number): Promise<{ bytesRead: number }> }} fh
 * @param {number} size
 * @param {number} pos
 * @param {number} len
 * @param {number} max
 * @returns {Promise<Uint8Array>}
 */
async function readFileBlock(fh, size, pos, len, max) {
  if (!isValidRange(pos, len)) return new Uint8Array(0);
  const n = Math.max(0, Math.min(len, max, size - pos));
  if (!n) return new Uint8Array(0);
  const buf = new Uint8Array(n);
  const { bytesRead } = await fh.read(buf, 0, n, pos);
  return buf.subarray(0, bytesRead);
}

/**
 * A replaced page can still have a request in transit or a read in progress.
 * A malformed range gets an empty block with an error, so the page does not wait for it forever.
 * @param {ReadBlockRequest} request
 * @param {(page: number) => boolean} isCurrent
 * @param {(pos: number, len: number) => Promise<Uint8Array | undefined>} read
 * @param {(reply: BlockReply) => void} post
 */
async function serveBlock(request, isCurrent, read, post) {
  const { page, pos, len } = request;
  if (!isCurrent(page)) return;
  if (!isValidRange(pos, len)) {
    post({ type: 'block', page, pos, data: new Uint8Array(0), error: 'invalid range' });
    return;
  }
  const data = await read(pos, len);
  if (data !== undefined && isCurrent(page)) post({ type: 'block', page, pos, data });
}
// checkJs: end

module.exports = { serveBlock, isValidRange, readFileBlock };
