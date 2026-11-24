'use strict';
const assert = require('node:assert/strict');
const { createLinkSimulator } = require('../../src/link-sim');
const { createVirtualClock } = require('../lib/virtual-clock');
const { EncodedStream } = require('../../src/stream');
const { LinkSessionMemory } = require('../../src/stream-adapt');

const BATCH_BYTES = 128 * 1024;
const REQUEST = new Uint8Array(64);
const FPS = 25;

function playback(preset, clock, sim, memory, duration, seekAt = Infinity) {
  const channel = sim.wrapChannel('playback');
  const started = clock.now();
  const switches = [];
  let generation = 0;
  const stream = new EncodedStream({
    tools: {}, file: 'test.mkv', log() {}, maxHeight: 2160,
    probed: { duration: 120, video: { codec: 'hevc', width: 3840, height: 2160, fps: FPS } },
    initialLink: memory.read(started), onLinkUpdate: (snapshot) => memory.update(snapshot),
    post(batch) {
      if (batch.type === 'seeked') {
        channel.sendDown(batch, pull);
        return;
      }
      if (batch.type !== 'batch') return;
      const bytes = batch.video.reduce((sum, packet) => sum + packet.data.byteLength, 0);
      assert.ok(bytes > 0 && bytes <= BATCH_BYTES, `${preset}: ${bytes} video bytes per batch`);
      channel.sendDown(batch, () => {
        if (batch.gen !== generation) return;
        pending = false;
        buffer += batch.video.length / FPS;
        windowBytes += bytes;
        windowFrames += batch.video.length;
        windowRead += clock.now() - requested;
        if (seeking) {
          seekLatency = clock.now() - seekStarted;
          seeking = false;
        }
      });
    },
  });
  const initialHeight = stream.h;
  stream.fps = FPS;
  // The encoder is an immediately available packet source. The production seek still resets it.
  stream.spawnNow = () => stream.link.noteFirstOutput(clock.now());
  stream.transitionVideo = () => {
    switches.push(clock.now() - started);
    stream.link.resetForRestart();
    stream.link.noteFirstOutput(clock.now());
    packets = makePackets();
    stream.vAll = [];
    stream.vNext = 0;
  };
  function makePackets() {
    const kbps = stream.activeCapKbps() || 9500;
    const data = Buffer.alloc(Math.ceil(kbps * 1000 / 8 / FPS));
    return Array.from({ length: 16 }, (_, i) => ({ t: i / FPS, data, idr: i === 0 }));
  }
  let packets = makePackets();
  let buffer = 0;
  let pending = false;
  let requested = 0;
  let seekStarted;
  let seekLatency;
  let seeking = false;
  let playing = false;
  let startupStalls = 0;
  let windowBytes = 0;
  let windowFrames = 0;
  let windowRead = 0;
  let lowTicks = 0;
  let bufferSum = 0;
  stream.link.noteFirstOutput(started);

  function pull() {
    pending = true;
    requested = clock.now();
    const gen = generation;
    channel.sendUp(REQUEST, () => {
      if (gen !== stream.gen) return;
      if (stream.vNext === stream.vAll.length || seeking) {
        stream.vAll = packets;
        stream.vNext = 0;
      }
      stream.more({ gen, limit: 384 * 1024 });
    });
  }

  for (let elapsed = 20; elapsed <= duration; elapsed += 20) {
    clock.advance(20);
    if (!seekStarted && elapsed >= seekAt && sim.stats().downPending) {
      seekStarted = clock.now();
      seeking = true;
      pending = true;
      buffer = 0;
      const seek = { type: 'seek', gen: ++generation, t: 75, playing: true };
      channel.sendUp(seek, () => stream.seek(seek));
    }
    if (!playing && buffer >= 0.5) playing = true;
    if (playing && !seeking) {
      if (elapsed <= 4000 && buffer < 0.02) startupStalls++;
      buffer = Math.max(0, buffer - 0.02);
    }
    if (buffer < 0.2) lowTicks++;
    bufferSum += buffer;
    if (!pending && buffer < 3.25) pull();
    if (elapsed % 2000 === 0) {
      // Deliver the same feedback as the page: throughput during reads and media delivered per window.
      const sample = { gen: generation, kbps: windowRead ? windowBytes * 8 / windowRead : 0,
        videoKbps: stream.activeCapKbps() || 9500, mediaRate: windowFrames / FPS / 2,
        buffer: bufferSum / 100, starved: lowTicks > 60, behind: false, readMs: windowRead, hostWaitMs: 0 };
      Date.now = clock.now;
      try { stream.adapt(sample); } finally { Date.now = wallNow; }
      windowBytes = windowFrames = windowRead = lowTicks = bufferSum = 0;
    }
  }
  assert.ok(playing, `${preset}: playback started`);
  channel.dispose();
  stream.dispose();
  assertDrained(clock, sim, channel);
  return { switches, initialHeight, startupStalls, seekLatency };
}

const wallNow = Date.now;
for (const preset of ['flaky-ssh', 'typical-ssh', 'slow-ssh']) {
  const clock = createVirtualClock();
  const sim = createLinkSimulator(preset, { clock });
  const memory = new LinkSessionMemory();
  const result = playback(preset, clock, sim, memory, 60_000, 31_800);
  const { downMbps, upMbps, rttMs, jitterMs, blackoutDurationMs } = sim.config;
  const ceiling = 2 * BATCH_BYTES * 8 / (downMbps * 1000) + 2 * REQUEST.byteLength * 8 / (upMbps * 1000)
    + 2 * (rttMs + jitterMs) + blackoutDurationMs + 6;
  assert.ok(result.seekLatency > 0 && result.seekLatency <= ceiling,
    `${preset}: seek took ${result.seekLatency} ms, ceiling ${ceiling} ms`);
  if (preset === 'flaky-ssh') {
    assert.ok(result.switches.length <= 2, `${preset}: switches at ${result.switches}`);
    const next = playback(preset, clock, sim, memory, 4000);
    assert.ok(next.initialHeight <= 720, `second video opened at ${next.initialHeight}p`);
    assert.equal(next.startupStalls, 0, 'second video stays buffered after first playback');
  } else {
    assert.deepEqual(result.switches.filter((at) => at > 12_000), [], `${preset}: tier holds after settling`);
  }
}

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
