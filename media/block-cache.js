// @ts-check
'use strict';

/** @import { ReadBlockRequest, BlockReply } from '../tools/read-block-contract.js' */

// checkJs: start
(() => {
  /** @typedef {number | string} ReaderId */
  /** @typedef {Pick<BlockReply, 'type' | 'pos' | 'data'> & {rid: ReaderId}} WorkerBlock */
  /**
   * Cache host blocks for one player. Readers share host requests but each owns its worker transfer.
   * @param {{
   *   page: number, size: number, budget: number, largeBlocks: boolean,
   *   request: (message: ReadBlockRequest) => void,
   *   send: (rid: ReaderId, message: WorkerBlock, transfer?: Transferable[]) => void,
   *   log: (message: string) => void,
   *   clock?: { now: () => number, set: (fn: () => void, ms: number) => number, clear: (id: number) => void }
   * }} options
   */
  function create({ page, size, budget, largeBlocks, request, send, log, clock = {
    now: () => performance.now(), set: (fn, ms) => setTimeout(fn, ms), clear: (id) => clearTimeout(id),
  } }) {
    // Remote reads cost a round trip. Large compare grids keep each tile on the smaller cache geometry.
    const blockSize = largeBlocks ? 4 << 20 : 1 << 20;
    const readAhead = largeBlocks ? 4 : 1;
    const floor = readAhead + 2;
    const align = (/** @type {number} */ pos) => Math.floor(pos / blockSize) * blockSize;
    const blocks = new Map(/** @type {[number, Uint8Array][]} */ ([]));
    const inflight = new Map(/** @type {[number, {at: number, retry: boolean}][]} */ ([]));
    const waiting = new Map(/** @type {[ReaderId, number][]} */ ([]));
    const readers = new Map(/** @type {[ReaderId, number][]} */ ([]));
    let bytes = 0;
    let disposed = false;
    /** @type {number | null} */
    let timer = null;

    function requestBlock(/** @type {number} */ pos, retry = false) {
      if (pos >= size || blocks.has(pos) || inflight.has(pos)) return;
      inflight.set(pos, { at: clock.now(), retry });
      request({ type: 'readBlock', page, pos, len: blockSize });
    }

    function stopTimerIfIdle() {
      if (waiting.size || timer === null) return;
      clock.clear(timer);
      timer = null;
    }

    function fail(/** @type {ReaderId} */ rid, /** @type {number} */ pos) {
      waiting.delete(rid);
      send(rid, { type: 'block', pos, data: new Uint8Array(0), rid });
    }

    function failBlock(/** @type {number} */ bpos) {
      for (const [rid, pos] of waiting) if (align(pos) === bpos) fail(rid, pos);
      stopTimerIfIdle();
    }

    function armTimer() {
      if (waiting.size && timer === null) timer = clock.set(retryReads, 5000);
    }

    function retryReads() {
      timer = null;
      for (const bpos of new Set(Array.from(waiting.values(), align))) {
        const pending = inflight.get(bpos);
        if (!pending) { requestBlock(bpos); continue; }
        if (clock.now() - pending.at < 15000) continue;
        inflight.delete(bpos);
        if (pending.retry) { log(`block ${bpos} not read`); failBlock(bpos); }
        else requestBlock(bpos, true);
      }
      armTimer();
    }

    function answerReads() {
      for (const [rid, pos] of waiting) {
        const bpos = align(pos);
        const block = blocks.get(bpos);
        if (!block) continue;
        waiting.delete(rid);
        // Transferring the cached buffer would detach it for all other readers.
        const data = block.slice(pos - bpos);
        send(rid, { type: 'block', pos, data, rid }, [data.buffer]);
        if (rid !== 'thumbs') for (let k = 1; k <= readAhead; k++) requestBlock(bpos + k * blockSize);
      }
      stopTimerIfIdle();
    }

    /** @param {number} pos @param {number} len @param {ReaderId} rid */
    function read(pos, len, rid) {
      if (disposed) return;
      if (!Number.isSafeInteger(pos) || pos < 0 || pos >= size || !Number.isSafeInteger(len) || len < 0) {
        fail(rid, pos);
        stopTimerIfIdle();
        return;
      }
      waiting.set(rid, pos);
      readers.set(rid, pos);
      const ahead = rid === 'thumbs' ? 0 : readAhead;
      for (let k = 0; k <= ahead; k++) requestBlock(align(pos) + k * blockSize);
      answerReads();
      armTimer();
    }

    /** @param {number} pos @param {Uint8Array | null | undefined} data @param {string} [error] */
    function receive(pos, data, error) {
      if (disposed) return;
      inflight.delete(pos);
      if (error || !data?.byteLength) {
        log(`block ${pos}: ${error || 'no data'}`);
        failBlock(pos);
        return;
      }
      bytes -= blocks.get(pos)?.byteLength ?? 0; // a retry may answer twice
      blocks.set(pos, data);
      bytes += data.byteLength;
      // Keep the blocks nearest to any reader. Insertion order breaks ties.
      const limit = Math.max(budget, readers.size * floor * blockSize);
      while (bytes > limit && blocks.size > floor) {
        let far = pos;
        let farDistance = -1;
        for (const offset of blocks.keys()) {
          let distance = Infinity;
          for (const reader of readers.values()) distance = Math.min(distance, Math.abs(offset - reader));
          if (distance > farDistance) { far = offset; farDistance = distance; }
        }
        bytes -= blocks.get(far).byteLength;
        blocks.delete(far);
      }
      answerReads();
    }

    /** @param {ReaderId} rid */
    function forgetPosition(rid) { readers.delete(rid); }

    /** The worker is already stopping, so discard its wait without sending a reply. @param {ReaderId} rid */
    function dropReader(rid) {
      forgetPosition(rid);
      waiting.delete(rid);
      stopTimerIfIdle();
    }

    function dispose() {
      disposed = true;
      for (const [rid, pos] of waiting) fail(rid, pos);
      stopTimerIfIdle();
      inflight.clear();
      readers.clear();
      blocks.clear();
      bytes = 0;
    }

    return { read, receive, forgetPosition, dropReader, dispose };
  }

  const api = { create };
  // @ts-ignore The webview has no CommonJS globals.
  if (typeof module === 'object' && module.exports) module.exports = api;
  else /** @type {typeof globalThis & { VpeBlockCache?: typeof api }} */ (globalThis).VpeBlockCache = api;
})();
// checkJs: end
