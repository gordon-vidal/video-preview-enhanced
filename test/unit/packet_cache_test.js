'use strict';
// media/packet-cache.js: the H.264 packets a remote Live transcode page keeps for paused seeks and steps back.

const assert = require('node:assert/strict');
const { create } = require('../../media/packet-cache');

const FPS = 15;
const at = (i) => i / FPS;
/** A read of the host stream: frames [from, to), a keyframe every `gop` frames counted from `from`. */
function read(cache, gen, from, to, gop = 30, size = 1000) {
  for (let i = from; i < to; i++) {
    const key = (i - from) % gop === 0;
    cache.add(gen, { t: at(i), key, idr: key, data: new Uint8Array(key ? size * 4 : size) });
  }
}

let n = 0;
function test(name, fn) { fn(); n++; console.log(`ok - ${name}`); }

test('a step back into a received GOP is served from the packets, from its keyframe to the target', () => {
  const c = create();
  read(c, 1, 0, 90);
  // Step back from frame 50 by one: the engine seeks half a frame before 50.
  const hit = c.find(at(50) - 0.5 / FPS);
  assert.ok(hit);
  assert.equal(hit.keyT, at(30));
  assert.equal(hit.frameT, at(49));
  assert.equal(hit.packets.length, 20); // 30..49
  assert.equal(hit.packets[0].key, true);
  assert.deepEqual(c.after(hit.keyT, hit.frameT).map((p) => Math.round(p.t * FPS)), [50, 51, 52, 53, 54, 55, 56, 57, 58, 59]);
});

test("a step back from a GOP's keyframe lands on the previous GOP's last frame", () => {
  const c = create();
  read(c, 1, 0, 60);
  // On frame 30 (a keyframe), one back: the engine seeks half a frame before it, after frame 29.
  const hit = c.find(at(30) - 0.5 / FPS);
  assert.equal(hit.keyT, at(0));
  assert.equal(hit.frameT, at(29));
  // A GOP whose read stopped before its last frame does not claim the time after it.
  const d = create();
  read(d, 1, 0, 25);
  assert.equal(d.find(at(30) - 0.5 / FPS), null);
});

test('an exact frame time lands on that frame', () => {
  const c = create();
  read(c, 1, 0, 60);
  assert.equal(c.find(at(12)).frameT, at(12));
  assert.equal(c.find(at(0)).packets.length, 1);
});

test('nothing past the last packet received: the host is asked (no guessing at frames not seen)', () => {
  const c = create();
  read(c, 1, 0, 45);
  assert.equal(c.find(at(44)).frameT, at(44));
  assert.equal(c.find(at(45) + 0.01), null);
  assert.equal(c.find(-1), null);
});

test('a read that starts without a keyframe keeps nothing until one comes', () => {
  const c = create();
  for (let i = 5; i < 40; i++) c.add(1, { t: at(i), key: i === 30, idr: i === 30, data: new Uint8Array(10) });
  assert.equal(c.find(at(10)), null);
  assert.equal(c.find(at(31)).keyT, at(30));
});

test('an open-GOP I-frame (idr false) is no entry point', () => {
  const c = create();
  c.add(1, { t: at(0), key: true, idr: false, data: new Uint8Array(10) });
  c.add(1, { t: at(1), key: false, data: new Uint8Array(10) });
  assert.equal(c.find(at(1)), null);
});

test('a new read (gen) ends the GOP being appended: no packets of two reads in one run', () => {
  const c = create();
  read(c, 1, 0, 20); // GOP at 0, frames 0..19
  // gen 2 continues with non-key frames that would follow 19: not appended to gen 1's GOP
  c.add(2, { t: at(20), key: false, data: new Uint8Array(10) });
  assert.equal(c.find(at(19)).frameT, at(19));
  assert.equal(c.find(at(20)), null);
});

test('the same GOP read again replaces the older copy', () => {
  const c = create();
  read(c, 1, 0, 30);
  read(c, 2, 0, 30);
  assert.equal(c.stats().gops, 1);
  assert.equal(c.stats().bytes, 4000 + 29 * 1000);
});

test('the closest keyframe wins when reads overlap (fewest packets to decode)', () => {
  const c = create();
  read(c, 1, 0, 60, 60); // one long GOP from 0
  read(c, 2, 40, 60, 60); // a seek started a GOP at 40
  assert.equal(c.find(at(50)).keyT, at(40));
  assert.equal(c.find(at(30)).keyT, at(0));
});

test('over the budget the least recently used GOPs go, never the one being appended', () => {
  const c = create({ cap: 3 * (4000 + 9 * 1000) });
  read(c, 1, 0, 30, 10); // three GOPs, exactly the budget
  assert.ok(c.find(at(1))); // GOP 0 used: GOP 10 is now the oldest used
  read(c, 2, 30, 40, 10);
  assert.equal(c.stats().gops, 3);
  assert.ok(c.find(at(1)));
  assert.equal(c.find(at(11)), null);
  assert.ok(c.find(at(35)));
  assert.ok(c.stats().bytes <= c.stats().cap);
});

test('packets without a time end the run (no PTS: frame times would be guesses)', () => {
  const c = create();
  read(c, 1, 0, 10);
  c.add(1, { t: null, key: false, data: new Uint8Array(10) });
  c.add(1, { t: at(10), key: false, data: new Uint8Array(10) });
  assert.equal(c.find(at(10)), null);
  assert.equal(c.find(at(9)).frameT, at(9));
});

console.log(`packet_cache: ${n} passed`);
