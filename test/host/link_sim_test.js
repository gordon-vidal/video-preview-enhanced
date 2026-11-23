'use strict';
// node test/run.js unit --grep link_sim: the SSH / flaky-link simulator (src/link-sim.js) on a virtual clock (no real
// waiting): presets and specs, message sizes, RTT, FIFO byte budget, jitter, blackouts, Compare tiles sharing one
// link, dispose, the env hooks, and the Live transcode ladder (src/stream-adapt.js) reacting to a slow link.
const assert = require('assert');
const {
  LINK_PRESETS, parseLinkSpec, estimateMessageBytes, createLinkSimulator, linkSimulatorFromEnv, effectiveRemoteName,
} = require('../../src/link-sim');
const { LinkAdaptController, LINK_TIERS } = require('../../src/stream-adapt');
const { createVirtualClock } = require('../lib/virtual-clock');

const bytes = (n) => new Uint8Array(n);
/** A simulator on its own virtual clock; log collects [direction, name, time]. */
function rig(spec, opts = {}) {
  const clock = createVirtualClock();
  const sim = createLinkSimulator(spec, { clock, ...opts });
  const log = [];
  const down = (name, msg, via = sim) => via.sendDown(msg, () => log.push(['down', name, clock.now()]));
  const up = (name, msg, via = sim) => via.sendUp(msg, () => log.push(['up', name, clock.now()]));
  return { clock, sim, log, down, up };
}

{ // Presets: the four documented links, any case, with defaults filled in.
  assert.deepStrictEqual(Object.keys(LINK_PRESETS), ['fast-ssh', 'typical-ssh', 'slow-ssh', 'flaky-ssh']);
  assert.deepStrictEqual(LINK_PRESETS['fast-ssh'], { label: 'Fast SSH', downMbps: 25, upMbps: 25, rttMs: 15, jitterMs: 3 });
  assert.deepStrictEqual(LINK_PRESETS['flaky-ssh'], {
    label: 'Flaky SSH', downMbps: 4, upMbps: 4, rttMs: 120, jitterMs: 40, blackoutEveryMs: 8000, blackoutDurationMs: 1500,
  });
  assert.deepStrictEqual(parseLinkSpec('Typical-SSH'), {
    label: 'Typical SSH', downMbps: 8, upMbps: 8, rttMs: 40, jitterMs: 10, blackoutEveryMs: 0, blackoutDurationMs: 0, seed: 1,
  });
  assert.strictEqual(parseLinkSpec('SLOW-SSH').downMbps, 2.5);
  assert.strictEqual(parseLinkSpec('flaky-ssh').blackoutDurationMs, 1500);
  for (const off of ['off', 'OFF', 'none', '', '  ', undefined, null]) assert.strictEqual(parseLinkSpec(off), null, `${off}`);
}

{ // key=val specs.
  const c = parseLinkSpec('mbps=5,rtt=60,jitter=15,blackout=1500/8000,seed=42');
  assert.deepStrictEqual(
    { ...c, label: '' },
    { label: '', downMbps: 5, upMbps: 5, rttMs: 60, jitterMs: 15, blackoutEveryMs: 8000, blackoutDurationMs: 1500, seed: 42 },
  );
  const asym = parseLinkSpec(' Down=20 , up=1.5 , rtt=30 ');
  assert.strictEqual(asym.downMbps, 20);
  assert.strictEqual(asym.upMbps, 1.5);
  assert.strictEqual(asym.jitterMs, 0);
  const one = parseLinkSpec('down=3');
  assert.strictEqual(one.upMbps, 3, 'a single direction given applies to both');
  const based = parseLinkSpec('rtt=5,preset=slow-ssh');
  assert.strictEqual(based.downMbps, 2.5, 'a preset is the base whatever its place');
  assert.strictEqual(based.rttMs, 5, 'and the other keys override it');
}

{ // Specs that cannot work say why.
  for (const [spec, re] of [
    ['carrier-pigeon', /unknown spec "carrier-pigeon".*fast-ssh/],
    ['mbps=abc', /mbps must be a positive number/],
    ['mbps=0', /mbps must be a positive number/],
    ['rtt=-5,mbps=1', /rtt must be a non-negative number/],
    ['rtt=50', /no bandwidth/],
    ['mbps=1,speed=9', /unknown key "speed"/],
    ['mbps=1,blackout=1500', /blackout needs/],
    ['mbps=1,blackout=9000/8000', /needs a period longer/],
    ['mbps=1,,x', /expected key=val/],
    ['preset=nope', /unknown preset/],
  ]) assert.throws(() => parseLinkSpec(spec), re, spec);
  assert.throws(() => createLinkSimulator('off'), /nothing to simulate/);
  assert.throws(() => createLinkSimulator({ downMbps: 0, upMbps: 1 }), /downMbps/);
}

{ // Message sizes: binary at its length, strings as UTF-8, structure as JSON would be.
  assert.strictEqual(estimateMessageBytes(new Uint8Array(1000)), 1000);
  assert.strictEqual(estimateMessageBytes(new ArrayBuffer(4096)), 4096);
  assert.strictEqual(estimateMessageBytes(Buffer.alloc(2048)), 2048);
  assert.strictEqual(estimateMessageBytes(new Float32Array(10)), 40);
  assert.strictEqual(estimateMessageBytes(new DataView(new ArrayBuffer(12))), 12);
  const b64 = Buffer.alloc(30000, 7).toString('base64');
  assert.strictEqual(estimateMessageBytes(b64), b64.length + 2, 'base64 text costs its characters');
  assert.strictEqual(estimateMessageBytes('é'), 2 + 2);
  assert.strictEqual(estimateMessageBytes('日本'), 6 + 2);
  assert.strictEqual(estimateMessageBytes('😀'), 4 + 2, 'a surrogate pair is one 4-byte character');
  const frame = { type: 'nd', m: { type: 'frame', index: 7, data: new Uint8Array(5000), parts: [new ArrayBuffer(100)] } };
  const n = estimateMessageBytes(frame);
  assert.ok(n >= 5100 && n < 5300, `nested binary ${n}`);
  const plain = { type: 'toast', text: 'hello', ms: 2500, on: true, none: null, skip: undefined, f() {} };
  const json = JSON.stringify(plain).length;
  assert.ok(Math.abs(estimateMessageBytes(plain) - json) <= 12, `${estimateMessageBytes(plain)} vs JSON ${json}`);
  assert.strictEqual(estimateMessageBytes(null), 4);
  assert.strictEqual(estimateMessageBytes(undefined), 0);
  const loop = { name: 'loop', data: new Uint8Array(10) };
  loop.self = loop;
  assert.ok(estimateMessageBytes(loop) >= 10, 'a cycle counts once and does not throw');
  const shared = new Uint8Array(100);
  assert.ok(estimateMessageBytes({ a: shared, b: shared }) >= 200, 'the same buffer twice is sent twice');
  assert.doesNotThrow(() => estimateMessageBytes({ get boom() { throw new Error('no'); }, ok: 1 }));
  assert.ok(estimateMessageBytes(new Map([['k', new Uint8Array(50)]])) >= 50);
  assert.ok(estimateMessageBytes(new Set([1, 2, 3])) > 0);
  assert.ok(estimateMessageBytes(10n ** 30n) > 0);
  let deep = {};
  for (let i = 0; i < 5000; i++) deep = { deep };
  assert.doesNotThrow(() => estimateMessageBytes(deep), 'absurd nesting is cut off, not a stack overflow');
}

{ // A request up and its reply down pay a full RTT; a message that carries bytes pays its serialization too.
  const { clock, sim, log, up, down } = rig('mbps=8,rtt=40'); // 8 Mb/s = 1000 bytes per ms
  up('request', bytes(0));
  clock.advance(19);
  assert.deepStrictEqual(log, [], 'half the RTT is not enough');
  clock.advance(1);
  assert.deepStrictEqual(log, [['up', 'request', 20]]);
  down('reply', bytes(0)); // sent when the request arrived
  clock.advance(19);
  assert.strictEqual(log.length, 1);
  clock.advance(1);
  assert.deepStrictEqual(log[1], ['down', 'reply', 40], 'the round trip took the RTT');
  down('block', bytes(250000)); // 250 ms to serialize, then 20 ms of flight
  clock.runAll();
  assert.deepStrictEqual(log[2], ['down', 'block', 40 + 250 + 20]);
  assert.deepStrictEqual(
    { ...sim.stats(), downPending: 0 },
    { downBytes: 250000, upBytes: 0, downMsgs: 2, upMsgs: 1, downPending: 0, upPending: 0, inBlackout: false },
  );
  assert.strictEqual(clock.pending(), 0, 'nothing is left armed when the queue is empty');
}

{ // FIFO byte budget: one big batch holds back everything behind it in its direction, not the other one.
  const { clock, log, up, down } = rig('mbps=8,rtt=40');
  down('big', bytes(1000000)); // 1000 ms on the wire
  down('small', bytes(1000)); // queued behind it
  up('ask', bytes(0)); // the other direction is free
  clock.runAll();
  assert.deepStrictEqual(log, [
    ['up', 'ask', 20],
    ['down', 'big', 1020],
    ['down', 'small', 1021],
  ]);
}

{ // Asymmetric rates: the up pipe is slower.
  const { clock, log, up, down } = rig('down=8,up=1,rtt=0');
  down('d', bytes(8000)); // 8 ms
  up('u', bytes(8000)); // 64 ms
  clock.runAll();
  assert.deepStrictEqual(log, [['down', 'd', 8], ['up', 'u', 64]]);
}

{ // Jitter: seeded, so a run repeats; within +-jitter/2 of the half RTT; a different seed differs; never reorders.
  const times = (seed) => {
    const { clock, sim, log, down } = rig('mbps=100,rtt=100,jitter=40', { seed });
    for (let i = 0; i < 40; i++) { down(`m${i}`, bytes(0)); clock.advance(1); }
    clock.runAll();
    sim.dispose();
    return log;
  };
  const a = times(7);
  assert.deepStrictEqual(times(7), a, 'same seed, same delivery times');
  assert.notDeepStrictEqual(times(8).map((e) => e[2]), a.map((e) => e[2]), 'another seed, other jitter');
  assert.deepStrictEqual(a.map((e) => e[1]), Array.from({ length: 40 }, (_, i) => `m${i}`), 'order kept');
  const flights = a.map((e, i) => e[2] - i);
  assert.ok(flights.every((f) => f >= 50 - 20 - 1 && f <= 50 + 20 + 40), `flight times ${Math.min(...flights)}..${Math.max(...flights)}`);
  assert.ok(new Set(flights).size > 5, 'the delay actually varies');
  const noJitter = rig('mbps=100,rtt=100');
  for (let i = 0; i < 5; i++) noJitter.down(`m${i}`, bytes(0));
  noJitter.clock.runAll();
  assert.ok(noJitter.log.every((e) => e[2] === 50), 'no jitter, no variation');
}

{ // Blackouts [8000, 9500), [16000, 17500) ...: nothing moves inside one, and the backlog drains in order after it.
  const { clock, sim, log, down } = rig('mbps=8,rtt=40,blackout=1500/8000');
  assert.strictEqual(sim.stats().inBlackout, false);
  clock.advance(7990);
  down('spans', bytes(20000)); // 20 ms of sending: 10 ms before the blackout, 10 ms after it
  down('during', bytes(1000));
  clock.advance(510);
  assert.strictEqual(sim.stats().inBlackout, true);
  down('late', bytes(1000)); // sent inside the blackout
  clock.advance(1000);
  assert.strictEqual(sim.stats().inBlackout, false, 'over at 9500');
  assert.deepStrictEqual(log, [], 'nothing arrived: the stalled message needs 10 ms after the link returns, plus the flight');
  clock.runAll();
  assert.deepStrictEqual(log, [
    ['down', 'spans', 9500 + 10 + 20],
    ['down', 'during', 9500 + 10 + 1 + 20],
    ['down', 'late', 9500 + 10 + 2 + 20],
  ], 'all there, in the order sent');
  assert.strictEqual(sim.stats().downMsgs, 3);
}

{ // A message that finishes sending just before a blackout but would land inside it waits for the link to come back.
  const { clock, log, down, sim } = rig('mbps=8,rtt=40,blackout=1500/8000');
  clock.advance(7990);
  down('edge', bytes(1000)); // sent at 7991, 20 ms flight: lands at 8011, inside the blackout
  clock.advance(1000);
  assert.deepStrictEqual(log, []);
  assert.strictEqual(sim.stats().inBlackout, true);
  clock.advance(510);
  assert.deepStrictEqual(log, [['down', 'edge', 9500]]);
  // The next blackout comes on schedule.
  clock.advance(16000 - 9500 + 10);
  assert.strictEqual(sim.stats().inBlackout, true, 'second blackout at 16000');
  clock.advance(1500);
  assert.strictEqual(sim.stats().inBlackout, false);
}

{ // Two Compare tiles on one link share its bytes: each alone would need 1 s, together each takes about 2 s.
  const alone = rig('mbps=8,rtt=0');
  const aloneTile = alone.sim.wrapChannel('A');
  for (let i = 0; i < 10; i++) alone.down(`A${i}`, bytes(100000), aloneTile); // 100 ms each
  alone.clock.runAll();
  assert.strictEqual(alone.log[9][2], 1000);

  const shared = rig('mbps=8,rtt=0');
  const a = shared.sim.wrapChannel('A');
  const b = shared.sim.wrapChannel('B');
  for (let i = 0; i < 10; i++) {
    shared.down(`A${i}`, bytes(100000), a);
    shared.down(`B${i}`, bytes(100000), b);
  }
  shared.clock.runAll();
  const done = (tile) => shared.log.filter((e) => e[1].startsWith(tile)).pop()[2];
  assert.strictEqual(done('A'), 1900, 'tile A: slower than alone');
  assert.strictEqual(done('B'), 2000, 'tile B: waits for the whole link');
  assert.deepStrictEqual(shared.log.slice(0, 4).map((e) => e[1]), ['A0', 'B0', 'A1', 'B1'], 'they interleave in send order');
  assert.strictEqual(shared.sim.stats().downBytes, 2000000);
  // A request from a third user is stuck behind the same queue, too.
  const third = rig('mbps=8,rtt=40');
  third.down('A', bytes(500000));
  third.down('B', bytes(500000));
  third.down('probe', bytes(1000));
  third.clock.runAll();
  assert.strictEqual(third.log[2][2], 1000 + 1 + 20);
}

{ // dispose(): pending messages never arrive, timers are cleared, no more messages are taken.
  const { clock, sim, log, down, up } = rig('mbps=8,rtt=40');
  down('a', bytes(100000));
  down('b', bytes(0));
  up('c', bytes(0));
  clock.advance(10);
  assert.ok(clock.pending() > 0);
  sim.dispose();
  assert.strictEqual(clock.pending(), 0, 'its timers are gone');
  clock.advance(10000);
  assert.deepStrictEqual(log, [], 'no late callbacks');
  assert.strictEqual(down('d', bytes(1)), null);
  assert.strictEqual(sim.sendUp({}, () => assert.fail('delivered after dispose')), null);
  sim.dispose(); // twice is fine
  clock.advance(1000);
}

{ // A channel's dispose drops its own messages only; the other tile's still arrive, in order.
  const { clock, sim, log, down } = rig('mbps=8,rtt=0');
  const a = sim.wrapChannel('A');
  const b = sim.wrapChannel('B');
  down('A0', bytes(1000), a);
  down('B0', bytes(1000), b);
  down('A1', bytes(1000), a);
  down('B1', bytes(1000), b);
  a.dispose();
  assert.strictEqual(a.sendDown({}, () => assert.fail('closed channel')), null);
  clock.runAll();
  assert.deepStrictEqual(log.map((e) => e[1]), ['B0', 'B1']);
  assert.strictEqual(sim.stats().downPending, 0);
}

{ // Rounding a deadline up to a whole millisecond must not put it on the first millisecond of a blackout.
  const { clock, sim, log, down } = rig('mbps=8,rtt=0,blackout=1500/8000'); // blackout [8000, 9500)
  clock.advance(7992);
  down('edge', bytes(7500)); // 7.5 ms of sending: due at 7999.5, which rounds to 8000
  clock.advance(8);
  assert.strictEqual(clock.now(), 8000);
  assert.strictEqual(sim.stats().inBlackout, true);
  assert.deepStrictEqual(log, [], 'not delivered as the blackout opens');
  clock.runAll();
  assert.deepStrictEqual(log, [['down', 'edge', 9500]], 'delivered when the link is back');
}

{ // A timer that fires late, inside a blackout, delivers nothing until the blackout is over (order kept).
  const real = createVirtualClock();
  const late = { now: real.now, setTimeout: (fn, ms) => real.setTimeout(fn, ms + 5), clearTimeout: real.clearTimeout };
  const sim = createLinkSimulator('mbps=8,rtt=0,blackout=1500/8000', { clock: late });
  const log = [];
  real.advance(7990);
  sim.sendDown(bytes(7000), () => log.push(['first', real.now()])); // due at 7997, but the timer fires at 8002
  sim.sendDown(bytes(1000), () => log.push(['second', real.now()]));
  real.advance(1400); // 9390: inside the blackout
  assert.deepStrictEqual(log, [], 'nothing arrives while the link is down');
  real.runAll();
  assert.deepStrictEqual(log.map((e) => e[0]), ['first', 'second']);
  assert.ok(log.every((e) => e[1] >= 9500), `after the blackout: ${JSON.stringify(log)}`);
}

{ // A transfer far longer than any iteration cap still counts every blackout: 0.125 bytes/ms, 1 ms dark every 2 ms.
  const { clock, log, down } = rig('mbps=0.001,rtt=0,blackout=1/2');
  down('long', bytes(100000)); // 800000 ms of sending: open [0, 2), then 1 ms in every 2
  clock.runAll();
  // The last open ms ends at 1599998, a blackout's first ms: delivery waits for it to end.
  assert.deepStrictEqual(log, [['down', 'long', 3 + 799997 * 2 + 1 + 1]], 'one dark ms for every open ms');
}

{ // The closed form matches stepping a millisecond at a time, for starts and sizes around the blackouts.
  for (const [dark, every] of [[3, 10], [1, 2], [5, 6]]) {
    const inDark = (t) => t >= every && t % every < dark;
    for (let start = 0; start < 25; start += 1) {
      for (let need = 1; need <= 40; need += 1) {
        let t = start;
        for (let left = need; left > 0; t++) if (!inDark(t)) left--;
        while (inDark(t)) t++; // a message that would land in a blackout waits for its end
        const { clock, log, down } = rig(`mbps=8,rtt=0,blackout=${dark}/${every}`);
        clock.advance(start);
        down('m', bytes(need * 1000));
        clock.runAll();
        assert.strictEqual(log[0][2], t, `blackout ${dark}/${every}, start ${start}, ${need} ms of sending`);
      }
    }
  }
}

{ // Cancelling one send frees it at once: no pending entry, and no timer waiting for it.
  const { clock, sim, log, down } = rig('mbps=8,rtt=40');
  const ch = sim.wrapChannel('A');
  const first = ch.sendDown(bytes(1000), () => log.push(['down', 'first', clock.now()]));
  ch.sendDown(bytes(1000), () => log.push(['down', 'second', clock.now()]));
  down('other', bytes(1000));
  assert.strictEqual(ch.pending(), 2);
  assert.strictEqual(sim.stats().downPending, 3);
  first.cancel(); // the head of the queue: the timer moves on to the next message
  first.cancel(); // twice is fine
  assert.strictEqual(ch.pending(), 1, 'it left the channel at once');
  assert.strictEqual(sim.stats().downPending, 2, 'and the queue');
  clock.runAll();
  assert.deepStrictEqual(log, [['down', 'second', 22], ['down', 'other', 23]], 'the rest arrive on time, in order');
  assert.strictEqual(ch.pending(), 0, 'a delivered message leaves the channel too');
  assert.strictEqual(clock.pending(), 0);
  const lone = sim.sendDown(bytes(0), () => assert.fail('cancelled'));
  lone.cancel();
  assert.strictEqual(clock.pending(), 0, 'cancelling the only message clears the timer');
}

{ // Disposing a channel releases everything it had in flight now, not at the deadlines.
  const { clock, sim, log, down } = rig('mbps=8,rtt=40');
  const a = sim.wrapChannel('A');
  const b = sim.wrapChannel('B');
  for (let i = 0; i < 3; i++) down(`A${i}`, bytes(500000), a);
  assert.strictEqual(a.pending(), 3);
  down('B0', bytes(1000), b);
  a.dispose();
  assert.strictEqual(a.pending(), 0, 'nothing left to run for A');
  assert.strictEqual(sim.stats().downPending, 1, 'only B is queued');
  assert.strictEqual(clock.pending(), 1, 'one timer, for B');
  b.dispose();
  assert.strictEqual(clock.pending(), 0, 'no timer once nothing is waiting');
  clock.runAll();
  assert.deepStrictEqual(log, []);
}

{ // Blackouts are whole milliseconds with at least 1 ms open per period, so a deadline always has a way out
  // (0.5/1 once left none: every rounded deadline fell inside a blackout and the search never ended).
  assert.throws(() => parseLinkSpec('mbps=1,blackout=0.5/1'), /whole milliseconds/);
  assert.throws(() => parseLinkSpec('mbps=1,blackout=1/2.5'), /whole milliseconds/);
  assert.throws(() => createLinkSimulator({ downMbps: 1, blackoutDurationMs: 0.5, blackoutEveryMs: 1 }), /whole milliseconds/);
  assert.throws(() => createLinkSimulator({ downMbps: 1, blackoutDurationMs: 1, blackoutEveryMs: 1 }), /needs a period longer/);
  assert.deepStrictEqual(
    (({ blackoutDurationMs, blackoutEveryMs }) => [blackoutDurationMs, blackoutEveryMs])(parseLinkSpec('mbps=1,blackout=1/2')),
    [1, 2],
  );
  // The tightest allowed blackout: every message sent at any moment arrives, in order, outside a blackout.
  const { clock, sim, log, down } = rig('mbps=8,rtt=0,jitter=0,blackout=1/2');
  for (let i = 0; i < 30; i++) { down(`m${i}`, bytes(i % 3 * 400)); clock.advance(1); }
  clock.runAll();
  assert.strictEqual(log.length, 30);
  assert.deepStrictEqual(log.map((e) => e[1]), Array.from({ length: 30 }, (_, i) => `m${i}`));
  assert.ok(log.every((e) => e[2] < 2 || e[2] % 2 === 1), `none lands inside a blackout: ${log.map((e) => e[2])}`);
  sim.dispose();
}

{ // sim.dispose() closes its channels too: their handles are released at once, without a channel.dispose().
  const { clock, sim, log, down, up } = rig('mbps=8,rtt=40');
  const a = sim.wrapChannel('A');
  const b = sim.wrapChannel('B');
  down('A0', bytes(500000), a);
  up('B0', bytes(1000), b);
  down('B1', bytes(1000), b);
  assert.deepStrictEqual([a.pending(), b.pending()], [1, 2]);
  sim.dispose();
  assert.deepStrictEqual([a.pending(), b.pending()], [0, 0], 'no channel keeps a handle');
  assert.strictEqual(a.sendDown({}, () => assert.fail('after dispose')), null);
  const late = sim.wrapChannel('late');
  assert.strictEqual(late.sendUp({}, () => assert.fail('after dispose')), null, 'a channel made afterwards is closed');
  assert.strictEqual(late.pending(), 0);
  a.dispose(); // still fine on its own
  clock.advance(5000);
  assert.deepStrictEqual(log, []);
  assert.strictEqual(clock.pending(), 0);
}

{ // A callback that throws does not stop the messages behind it (the host's own handler reports its errors).
  const errors = [];
  const { clock, sim, log, down } = rig('mbps=8,rtt=0', { onError: (e) => errors.push(e.message) });
  sim.sendDown(bytes(0), () => { throw new Error('boom'); });
  down('next', bytes(0));
  clock.runAll();
  assert.deepStrictEqual(errors, ['boom']);
  assert.strictEqual(log.length, 1);
}

{ // The env hooks: unset costs nothing; a bad spec logs and simulates nothing; the window kind follows.
  const lines = [];
  const log = (m) => lines.push(m);
  const clock = createVirtualClock();
  assert.strictEqual(linkSimulatorFromEnv({}, log), null);
  assert.strictEqual(linkSimulatorFromEnv({ VPE_SIMULATE_LINK: 'off' }, log), null);
  assert.strictEqual(linkSimulatorFromEnv({ VPE_SIMULATE_LINK: 'None' }, log), null);
  assert.deepStrictEqual(lines, []);
  const sim = linkSimulatorFromEnv({ VPE_SIMULATE_LINK: 'flaky-ssh' }, log, { clock });
  assert.ok(sim);
  assert.match(lines[0], /^\[link-sim\] active: Flaky SSH: 4 Mb\/s, 120 ms RTT, 40 ms jitter, 1500 ms blackout every 8000 ms/);
  sim.dispose();
  assert.strictEqual(linkSimulatorFromEnv({ VPE_SIMULATE_LINK: 'dialup' }, log), null);
  assert.match(lines[1], /ignored VPE_SIMULATE_LINK: .*unknown spec "dialup"/);

  const real = (remoteName) => ({ env: { remoteName } });
  assert.strictEqual(effectiveRemoteName(real(undefined), {}), undefined, 'nothing set: the real window');
  assert.strictEqual(effectiveRemoteName(real('wsl'), {}), 'wsl');
  assert.strictEqual(effectiveRemoteName(real(undefined), { VPE_SIMULATE_LINK: 'slow-ssh' }), 'ssh-remote', 'a link implies SSH');
  assert.strictEqual(effectiveRemoteName(real(undefined), { VPE_SIMULATE_LINK: 'mbps=2' }), 'ssh-remote');
  assert.strictEqual(effectiveRemoteName(real(undefined), { VPE_SIMULATE_LINK: 'off' }), undefined);
  assert.strictEqual(effectiveRemoteName(real(undefined), { VPE_SIMULATE_LINK: 'dialup' }), undefined, 'a bad spec simulates nothing');
  assert.strictEqual(effectiveRemoteName(real(undefined), { VPE_SIMULATE_LINK: 'slow-ssh', VPE_SIMULATE_REMOTE: 'wsl' }), 'wsl');
  assert.strictEqual(effectiveRemoteName(real(undefined), { VPE_SIMULATE_REMOTE: 'dev-container' }), 'dev-container');
  assert.strictEqual(effectiveRemoteName(real('wsl'), { VPE_SIMULATE_LINK: 'slow-ssh', VPE_SIMULATE_REMOTE: 'off' }), 'wsl', 'off: the real one');
  assert.strictEqual(effectiveRemoteName(real('ssh-remote'), { VPE_SIMULATE_REMOTE: 'off' }), 'ssh-remote');
}

// ---- Live transcode ladder over the simulated link --------------------------------------------------------------------
// A host sending the stream at the current tier's rate in 100 ms slices, a "webview" counting what arrives, and the
// ladder (src/stream-adapt.js) judging each 2 s window as media/engine.js sampleRemoteLink would.
const TIER_KBPS = [8000, ...LINK_TIERS.slice(1).map((t) => t.kbps)];

function playThrough(spec, seconds) {
  const clock = createVirtualClock();
  const sim = createLinkSimulator(parseLinkSpec(spec), { clock });
  const ladder = new LinkAdaptController();
  ladder.noteFirstOutput(0);
  let channel = sim.wrapChannel('stream');
  let delivered = 0;
  let offered = 0;
  const steps = [];
  for (let ms = 100; ms <= seconds * 1000; ms += 100) {
    const kbps = TIER_KBPS[ladder.tier];
    const n = Math.round(kbps * 100 / 8);
    offered += n;
    channel.sendDown(bytes(n), () => { delivered += n; });
    clock.advance(100);
    if (ms % 2000) continue;
    const kbpsGot = delivered * 8 / 2000;
    const starved = delivered < 0.9 * offered;
    const before = ladder.tier;
    const d = ladder.onSample({
      kbps: kbpsGot, videoKbps: TIER_KBPS[0], mediaRate: Math.min(1, offered ? delivered / offered : 1),
      buffer: starved ? 0.05 : 1, starved, behind: false, readMs: 2000, hostWaitMs: 0,
    }, ms, 0);
    delivered = 0;
    offered = 0;
    if (d && ladder.tier !== before) {
      steps.push({ at: ms, from: before, to: ladder.tier });
      // ffmpeg restarts at the new tier: what was in flight is dropped, and the next samples wait for its first output.
      channel.dispose();
      channel = sim.wrapChannel('stream');
      ladder.resetForRestart();
      ladder.noteFirstOutput(ms);
    }
  }
  sim.dispose();
  return { tier: ladder.tier, steps };
}

{ // Fast SSH carries the original quality; Slow and Flaky SSH make the ladder step down; it never climbs on a link that
  // cannot carry the tier above.
  const fast = playThrough('fast-ssh', 60);
  assert.strictEqual(fast.tier, 0, 'fast-ssh: full quality');
  assert.deepStrictEqual(fast.steps, []);
  const slow = playThrough('slow-ssh', 60);
  assert.ok(slow.tier >= 2, `slow-ssh: 2.5 Mb/s cannot carry 720p, ended at tier ${slow.tier}`);
  assert.ok(slow.steps.length >= 1 && slow.steps.every((s) => s.to > s.from), 'only steps down');
  assert.ok(slow.steps[0].at <= 12000, `first step down by 12 s (${slow.steps[0].at})`);
  const flaky = playThrough('flaky-ssh', 90);
  assert.ok(flaky.tier >= 1, `flaky-ssh ended at tier ${flaky.tier}`);
  assert.ok(flaky.steps.length >= 1);
  assert.ok(slow.tier >= flaky.tier && flaky.tier >= fast.tier, 'the worse the link, the lower the quality');
}

{ // One short blackout on a fast link is not a slow link: two bad windows in a row are needed to step down.
  const blip = playThrough('mbps=25,rtt=15,blackout=1500/31000', 60);
  assert.deepStrictEqual(blip.steps, [], 'a single stall is ridden out');
  assert.strictEqual(blip.tier, 0);
}

console.log('link_sim ok');
