'use strict';

/** @import { ReadBlockRequest, BlockReply } from '../tools/read-block-contract.js' */

// checkJs: start
/**
 * A replaced page can still have a request in transit or a read in progress.
 * @param {ReadBlockRequest} request
 * @param {(page: number) => boolean} isCurrent
 * @param {(pos: number, len: number) => Promise<Uint8Array | undefined>} read
 * @param {(reply: BlockReply) => void} post
 */
async function serveBlock(request, isCurrent, read, post) {
  const { page, pos, len } = request;
  if (!isCurrent(page)) return;
  const data = await read(pos, len);
  if (data !== undefined && isCurrent(page)) post({ type: 'block', page, pos, data });
}
// checkJs: end

module.exports = { serveBlock };
