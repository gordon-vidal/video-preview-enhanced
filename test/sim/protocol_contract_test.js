'use strict';

const assert = require('node:assert/strict');
const { DECODER_TYPES } = require('../../media/player-unified');
const { createUnifiedSession } = require('../../src/unified-session');
const { serveBlock } = require('../../src/read-block');
const { withPage, CLIPS } = require('../host/unified-page-fixture');
const { arg, gop, withHost } = require('./host');
const { viewerContract } = require('./protocol-viewer');
const { engineContract } = require('./protocol-page');

const data = Uint8Array.of(1, 3, 5, 7);
const inner = { type: 'seeked', gen: 7, t: 2 };
const replies = [
  { type: 'block', pos: 4, data },
  { type: 'resize', tiles: ['B'] },
  { type: 'nd', m: inner },
  { type: 'ndv', gen: 7, t: 2, w: 2, h: 2, ys: 4, data: new Uint8Array(6) },
  { type: 'nda', gen: 7, t: 2, rate: 48000, n: 1, data: new Uint8Array(8) },
  { type: 'thumb', id: 14, w: 2, h: 2, kt: 2, fmt: 'jpeg', data },
  { type: 'exactFrame', reqId: 15, t: 2, w: 2, h: 2, png: data },
  { type: 'stream', quality: { variants: [] } },
];
const requests = [
  { type: 'readBlock', pos: 4, len: 4 },
  { type: 'nd', m: { type: 'seek', gen: 7, t: 2, playing: false, quick: true } },
  { type: 'nd', m: { type: 'more', gen: 7 } },
  { type: 'nd', m: { type: 'fill', id: 8, from: 1, to: 1.12 } },
  { type: 'nd', m: { type: 'fillMore', id: 8 } },
  { type: 'nd', m: { type: 'sharp', id: 9, t: 2 } },
  { type: 'nd', m: { type: 'sharpMore', id: 9 } },
];

function pageContract() {
  withPage(({ app, send }) => {
    send({ type: 'open' });
    send({ type: 'openVideo', clipId: 'B', clip: CLIPS[1], compare: true });
    const a = app.players.get('A');
    const b = app.players.get('B');
    assert.deepEqual([...DECODER_TYPES].sort(), replies.map((m) => m.type).sort());
    for (const reply of replies) {
      const wire = { ...reply, clipId: 'B', key: 'A' };
      const sent = b.calls.length;
      const other = a.calls.length;
      send({ ...wire, boot: 0 });
      send({ ...wire, page: 99 });
      send({ ...wire, clipId: 'removed' });
      assert.equal(b.calls.length, sent, `${reply.type} rejects stale or foreign routes`);
      assert.equal(a.calls.length, other);
      send(wire);
      const calls = b.calls.slice(sent).filter(([type]) => type === reply.type);
      const expected = {
        block: ['block', reply.pos, reply.data, undefined],
        nd: ['nd', inner],
        thumb: ['thumb', { ...wire, page: 7 }],
      }[reply.type] || [reply.type, wire];
      assert.deepEqual(calls, [expected]);
      assert.equal(a.calls.filter(([type]) => type === reply.type).length, 0);
    }
  });
}

function scriptedSession(page) {
  const wire = [];
  const session = createUnifiedSession({
    initialClip: { id: 'B' },
    onPost: (message) => wire.push(message),
    onNative(clip, message) {
      assert.equal(clip.id, 'B');
      page.send(message.m);
    },
    onReadBlock(clip, message) {
      return serveBlock(message, (pageId) => pageId === 7, async (pos, len) => {
        assert.deepEqual([pos, len], [4, 4]);
        return data;
      }, (reply) => session.post({ ...reply, key: clip.id, clipId: clip.id }));
    },
  });
  const send = (m) => session.onMessage({ clipId: 'B', key: 'B', page: 7, boot: 1, ...m });
  const nd = (m) => send({ type: 'nd', m });
  const transfer = (message) => session.postNativeReply('B', message);
  return { session, wire, send, nd, transfer };
}

async function encodedContract() {
  await withHost({}, async ({ page, processes }) => {
    const { session, wire, send, nd, transfer } = scriptedSession(page);
    try {
      await send({ type: 'ready' });
      await send(requests[0]);
      assert.deepEqual(wire.at(-1), { type: 'block', pos: 4, data, page: 7, key: 'B', clipId: 'B' });
      await nd({ type: 'open' });
      await page.advance(10);
      await send({ ...requests[1], clipId: 'removed' });
      await page.advance(800);
      assert.equal(processes.length, 1);
      await send(requests[1]);
      await send(requests[2]);
      await page.advance(50);
      assert.equal(processes.length, 3, 'live encode and quick side job');
      processes[1].output(1, gop(4));
      processes[2].output(5, gop(1));
      processes[2].exit(6);
      await page.advance(30);
      assert.equal(page.messages('batch').at(-1).video[0].t, 2);

      await send(requests[3]);
      await page.advance(10);
      assert.equal(arg(processes[3], '-frames:v'), '3');
      processes[3].output(1, gop(3));
      processes[3].exit(2);
      await page.advance(20);
      await send(requests[4]);
      await page.advance(20);
      await send(requests[5]);
      await page.advance(10);
      processes[4].output(1, gop(1));
      processes[4].exit(2);
      await page.advance(20);
      await send(requests[6]);
      await page.advance(20);
      page.received.forEach(transfer);
      const reply = (type) => wire.filter((m) => m.type === 'nd' && m.m.type === type).map((m) => m.m).at(-1);
      assert.deepEqual(reply('seeked'), inner);
      assert.equal(reply('quickFrame').gen, 7);
      assert.equal(reply('quickFrame').t, 2);
      assert.ok(reply('quickFrame').data instanceof Uint8Array);
      assert.deepEqual({ id: reply('fillBatch').id, done: reply('fillBatch').done }, { id: 8, done: true });
      assert.deepEqual({ id: reply('sharpFrame').id, t: reply('sharpFrame').t, done: reply('sharpFrame').done },
        { id: 9, t: 2, done: true });
      assert.ok(wire.filter((m) => m.type === 'nd').every((m) => m.clipId === 'B' && m.key === 'B'));
    } finally {
      session.dispose();
    }
  });
}

(async () => {
  pageContract();
  await encodedContract();
  await engineContract();
  await viewerContract();
  console.log('decoder protocol: page routing, encoded stream and native messages passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
