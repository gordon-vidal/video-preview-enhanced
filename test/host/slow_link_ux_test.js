'use strict';
const assert = require('node:assert/strict');
const { createLinkSimulator } = require('../../src/link-sim');
const { createVirtualClock } = require('../lib/virtual-clock');

function assertDrained(clock, sim, channel) {
  assert.equal(channel.pending(), 0, 'channel has no pending deliveries');
  assert.equal(sim.stats().upPending, 0, 'upstream pipe has drained');
  assert.equal(sim.stats().downPending, 0, 'downstream pipe has drained');
  assert.equal(clock.pending(), 0, 'virtual clock has no remaining timers');
}

for (const closeBeforeDelivery of [false, true]) {
  const clock = createVirtualClock();
  const sim = createLinkSimulator('flaky-ssh', { clock });
  const tab = sim.wrapChannel('opening tab');
  clock.advance(7800);
  const requestedAt = clock.now();
  let firstFrameAt;
  // The upstream request arrives before the blackout. A 250 ms batch straddles it.
  tab.sendUp(new Uint8Array(1), () => {
    tab.sendDown(new Uint8Array(125_000), () => { firstFrameAt = clock.now(); });
  });
  clock.advance(1699);
  assert.equal(sim.stats().inBlackout, true);
  assert.equal(tab.pending(), 1, 'the initial batch is still in flight');
  assert.equal(firstFrameAt, undefined);

  if (closeBeforeDelivery) {
    tab.dispose();
    assertDrained(clock, sim, tab);
  }
  clock.advance(500);
  if (closeBeforeDelivery) {
    assert.equal(firstFrameAt, undefined, 'a closed tab never receives its first batch');
  } else {
    // RTT plus serialization plus the full blackout, with two jittered hops and timer rounding.
    const expectedMs = 120 + 250 + 1500;
    assert.ok(Math.abs(firstFrameAt - requestedAt - expectedMs) <= 42, 'first-frame RTT and blackout delay');
  }
  assertDrained(clock, sim, tab);
}

const GOP = new Uint8Array(250_000);
const SEEK_COUNT = 10;
const BURST_MS = 80;
const QUIET_MS = 40;
const seekOrder = Array.from({ length: SEEK_COUNT }, (_, i) => SEEK_COUNT - 1 - i);

function backscroll(preset, start, coalesced) {
  const clock = createVirtualClock();
  const sim = createLinkSimulator(preset, { clock });
  const tab = sim.wrapChannel('backscroll tab');
  const delivered = [];
  let lastDeliveryAt;
  let quietTimer;
  const sendGop = (gop) => tab.sendDown(GOP, () => {
    delivered.push(gop);
    lastDeliveryAt = clock.now();
  });

  clock.advance(start);
  for (const [i, gop] of seekOrder.entries()) {
    const seekAt = start + Math.floor(i * BURST_MS / (SEEK_COUNT - 1));
    clock.advance(seekAt - clock.now());
    if (coalesced) {
      clock.clearTimeout(quietTimer);
      quietTimer = clock.setTimeout(() => sendGop(gop), QUIET_MS);
    } else {
      sendGop(gop);
    }
  }
  const lastSeekAt = clock.now();
  assert.equal(tab.pending(), coalesced ? 0 : SEEK_COUNT, `${preset} backlog at burst end`);
  clock.advance(QUIET_MS);
  const expectedOrder = coalesced ? [seekOrder.at(-1)] : seekOrder;
  assert.equal(sim.stats().downMsgs, expectedOrder.length);
  assert.equal(sim.stats().downPending, expectedOrder.length);
  clock.advance(10_000);
  assert.deepEqual(delivered, expectedOrder, `${preset} delivers GOPs in FIFO order`);
  assertDrained(clock, sim, tab);
  return { bytes: sim.stats().downBytes, latency: lastDeliveryAt - lastSeekAt };
}

for (const { preset, start, serializeMs, flightMs, blackoutMs, jitterMs, minRatio, maxRatio } of [
  { preset: 'slow-ssh', start: 0, serializeMs: 800, flightMs: 40, blackoutMs: 0, jitterMs: 10, minRatio: 8, maxRatio: 10 },
  // Both the burst and its coalesced equivalent cross exactly one blackout.
  { preset: 'flaky-ssh', start: 7600, serializeMs: 500, flightMs: 60, blackoutMs: 1500, jitterMs: 20, minRatio: 3, maxRatio: 4 },
]) {
  const queued = backscroll(preset, start, false);
  const coalesced = backscroll(preset, start, true);
  assert.equal(coalesced.bytes, GOP.byteLength);
  assert.equal(queued.bytes / coalesced.bytes, SEEK_COUNT, `${preset} byte amplification`);
  const expectedQueued = SEEK_COUNT * serializeMs + flightMs + blackoutMs - BURST_MS;
  const expectedCoalesced = QUIET_MS + serializeMs + flightMs + blackoutMs;
  assert.ok(Math.abs(queued.latency - expectedQueued) <= jitterMs + 1, `${preset} queued latency`);
  assert.ok(Math.abs(coalesced.latency - expectedCoalesced) <= jitterMs + 1, `${preset} coalesced latency`);
  const ratio = queued.latency / coalesced.latency;
  assert.ok(ratio >= minRatio && ratio <= maxRatio, `${preset} latency amplification: ${ratio}x`);
}

{ // Closing one tab drops its callbacks. The shared FIFO keeps the surviving tab's scheduled delivery.
  const clock = createVirtualClock();
  const sim = createLinkSimulator('slow-ssh', { clock });
  const closing = sim.wrapChannel('closing tab');
  const staying = sim.wrapChannel('staying tab');
  const delivered = [];
  const onDelivery = (name) => () => delivered.push([name, clock.now()]);
  closing.sendDown(GOP, onDelivery('closed first GOP'));
  const survivor = staying.sendDown(GOP, onDelivery('surviving GOP'));
  closing.sendDown(GOP, onDelivery('closed last GOP'));
  closing.sendUp(new Uint8Array(1), onDelivery('closed request'));

  closing.dispose();
  assert.equal(closing.pending(), 0);
  assert.equal(sim.stats().upPending, 0);
  assert.equal(sim.stats().downPending, 1);
  assert.equal(staying.pending(), 1);
  assert.equal(clock.pending(), 1, 'only the surviving delivery has a timer');
  clock.advance(survivor.at - 1);
  assert.deepEqual(delivered, []);
  clock.advance(1);
  assert.deepEqual(delivered, [['surviving GOP', survivor.at]]);
  assertDrained(clock, sim, staying);
  clock.advance(3000);
  assert.deepEqual(delivered, [['surviving GOP', survivor.at]], 'disposed backlog cannot deliver later');
}

console.log('slow_link_ux ok');
