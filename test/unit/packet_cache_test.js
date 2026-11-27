'use strict';
// media/packet-cache.js: the H.264 packets a remote Live transcode page keeps for paused seeks and steps back.

const assert = require('node:assert/strict');
const { create, trimSound } = require('../../media/packet-cache');

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

test('a read of a held GOP cut off part way keeps the whole older copy for the frames it did not reach', () => {
  // Play after a seek served from the page: the host sends the next GOPs again, and the next seek cuts that read off.
  const c = create();
  read(c, 1, 0, 60); // GOPs 0 and 30, whole
  read(c, 2, 30, 35); // GOP 30 again, cut off after 5 frames
  const hit = c.find(at(40));
  assert.ok(hit, 'a frame past the cut-off read is still held');
  assert.equal(hit.keyT, at(30));
  assert.equal(hit.frameT, at(40));
  assert.equal(c.after(hit.keyT, hit.frameT).length, 19); // 41..59, from the same copy
  assert.equal(c.find(at(32)).packets.length, 3);
  // Once the new copy reaches as far, it replaces the old one.
  read(c, 3, 30, 60);
  assert.equal(c.stats().gops, 2);
  assert.equal(c.stats().bytes, 2 * (4000 + 29 * 1000));
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

test('B-frames (decode order is not frame order, a Direct Stream copy): the GOP is not kept, the host is asked', () => {
  const c = create();
  // I0 P3 B1 B2 P6 B4 B5: frame 2 needs P3 too, "the packets up to frame 2" would show frame 0.
  for (const i of [0, 3, 1, 2, 6, 4, 5]) c.add(1, { t: at(i), key: i === 0, idr: i === 0, data: new Uint8Array(10) });
  assert.equal(c.find(at(2)), null);
  assert.equal(c.find(at(0)), null);
  assert.equal(c.stats().gops, 0);
  assert.equal(c.stats().bytes, 0);
});

/** An Annex B IDR: SPS (its bytes stand for the stream's settings), PPS, slice. */
const idr = (sps) => new Uint8Array([0, 0, 0, 1, 0x67, ...sps, 0, 0, 0, 1, 0x68, 0xce, 0x38, 0x80, 0, 0, 1, 0x65, 0x88, 0x84]);

test('the host changed the stream (new size or encoder: other SPS): the GOPs of the old one go', () => {
  const c = create();
  const add = (gen, i, sps) => c.add(gen, { t: at(i), key: !!sps, idr: !!sps, data: sps ? idr(sps) : new Uint8Array(10) });
  add(1, 0, [0x64, 0, 0x28]); for (let i = 1; i < 30; i++) add(1, i);
  add(1, 30, [0x64, 0, 0x28]); for (let i = 31; i < 60; i++) add(1, i);
  assert.equal(c.stats().gops, 2); // same settings: both kept
  add(2, 90, [0x64, 0, 0x32]); for (let i = 91; i < 100; i++) add(2, i);
  assert.equal(c.stats().gops, 1);
  assert.equal(c.find(at(10)), null);
  assert.equal(c.find(at(95)).keyT, at(90));
});

test('a fill closed at the start of the next packets covers the step back into it', () => {
  const c = create();
  read(c, 1, 30, 40); // the paused jump landed at frame 30 (its own keyframe)
  read(c, 2, 0, 30, 6); // the fill behind it: frames 0..29, keyframes every 6
  assert.equal(c.find(at(30) - 0.5 / FPS), null, 'without close: frame 29 holds no time after it');
  c.close(2, at(30));
  const hit = c.find(at(30) - 0.5 / FPS);
  assert.equal(hit.frameT, at(29));
  assert.equal(hit.keyT, at(24));
  assert.equal(hit.packets.length, 6, 'a short GOP: six frames to decode');
  c.close(2, at(99)); // a read already closed: nothing changes
  assert.equal(c.find(at(31)).keyT, at(30));
});

test('a fill and the read-ahead arriving in turns each keep their own GOP', () => {
  const c = create();
  const pk = (i, key) => ({ t: at(i), key, idr: key, data: new Uint8Array(10) });
  // Read-ahead from 30 (key) and a fill from 20 (keys every 5), interleaved packet by packet.
  for (let k = 0; k < 10; k++) {
    c.add(7, pk(30 + k, k === 0));
    c.add('fill:1', pk(20 + k, k % 5 === 0));
  }
  c.close('fill:1', at(30));
  assert.equal(c.find(at(39)).keyT, at(30), 'the read-ahead GOP grew through the fill packets');
  assert.equal(c.find(at(29) + 0.01).keyT, at(25), 'the fill GOP too');
  assert.equal(c.find(at(30) - 0.5 / FPS).frameT, at(29));
});


// ---- sound (play after a seek served from the packets) ------------------------------------------------------------
const RATE = 48000;
/** Opus as src/stream-buffer.js takeAudio sends it: 20 ms packets with 80 ms of preroll, skip and samples. */
const opus = (t, sec) => ({ kind: 'opus', t, sampleRate: RATE, head: new Uint8Array(19), skip: 3840,
  samples: Math.round(sec * RATE), packets: Array.from({ length: Math.ceil(sec * 50) + 4 }, () => new Uint8Array(100)) });
/** 16-bit stereo PCM, sample i of channel 0 holding i (to see where a cut lands). */
const pcm = (t, sec) => {
  const n = Math.round(sec * RATE);
  const d = new DataView(new ArrayBuffer(n * 4));
  for (let i = 0; i < n; i++) d.setInt16(i * 4, i % 30000, true);
  return { kind: 's16', t, sampleRate: RATE, data: new Uint8Array(d.buffer) };
};

test('sound: the received batches chain from t without a gap, cut to start exactly there', () => {
  const c = create();
  for (let k = 0; k < 6; k++) c.addSound(opus(10 + k * 0.5, 0.5));
  const got = c.soundFrom(10.8);
  assert.equal(got.items.length, 5, 'the batch holding 10.8 s and the four after it');
  assert.equal(got.end, 13);
  assert.equal(got.items[0].t, 10.8);
  assert.equal(got.items[0].skip, 3840 + 0.3 * RATE, 'the cut moves the trim: Opus decodes from its first packet anyway');
  assert.equal(got.items[0].samples, 0.2 * RATE);
  assert.equal(got.items[1].t, 11, 'the next ones whole');
  assert.equal(got.items[1].skip, 3840);
  assert.equal(c.soundFrom(9.9), null, 'nothing held at 9.9 s');
  assert.equal(c.soundFrom(10.2, 11).end, 11, 'up to `until` (whole batches)');
  // A gap ends the chain.
  c.addSound(opus(14, 0.5));
  assert.equal(c.soundFrom(12).end, 13);
});

test('sound: PCM is cut by samples; batches of another read overlapping are cut where the chain is', () => {
  const c = create();
  c.addSound(pcm(5, 0.5));
  c.addSound(pcm(5.3, 0.5)); // a later read starting elsewhere
  const got = c.soundFrom(5.1);
  assert.equal(got.end, 5.8);
  assert.equal(got.items[0].t, 5.1);
  assert.equal(new DataView(got.items[0].data.buffer, got.items[0].data.byteOffset).getInt16(0, true), 0.1 * RATE);
  assert.equal(got.items[1].t, 5.5, 'the second cut where the first ends');
  assert.equal(got.items[1].data.byteLength, 0.3 * RATE * 4);
  assert.equal(new DataView(got.items[1].data.buffer, got.items[1].data.byteOffset).getInt16(0, true), 0.2 * RATE);
  assert.equal(trimSound(pcm(1, 0.1), 1.2), null, 'nothing left after the end');
});

test('sound: the same sound read again replaces the old copy; it shares the budget with the packets', () => {
  const c = create({ cap: 1e6 });
  c.addSound(pcm(0, 0.5));
  c.addSound(pcm(0, 0.5));
  assert.equal(c.stats().sound, 1);
  assert.equal(c.stats().bytes, 0.5 * RATE * 4);
  read(c, 1, 0, 30, 30, 20000); // 600 KB of packets
  c.addSound(pcm(0.5, 2)); // 384 KB: over the budget, the least recently used goes
  assert.ok(c.stats().bytes <= 1e6, JSON.stringify(c.stats()));
  assert.equal(c.soundFrom(0.1), null, 'the oldest sound went');
  assert.ok(c.find(at(10)), 'the packets used more recently stayed');
  c.clear();
  assert.deepEqual([c.stats().sound, c.stats().bytes], [0, 0]);
});

test('a GOP keeps the encode its keyframe came from (the host checks it before continuing the held packets)', () => {
  const c = create();
  for (let i = 0; i < 30; i++) c.add(1, { t: at(i), key: i === 0, idr: i === 0, data: new Uint8Array(10), enc: 3 });
  for (let i = 30; i < 45; i++) c.add('fill:1', { t: at(i), key: i === 30, idr: i === 30, data: new Uint8Array(10), enc: 8 });
  assert.equal(c.find(at(10)).enc, 3);
  assert.equal(c.find(at(40)).enc, 8);
});

test('the sound held, as joined spans (the debug state)', () => {
  const c = create();
  const s16 = (t, sec) => ({ kind: 's16', t, sampleRate: 48000, data: new Uint8Array(Math.round(sec * 48000) * 4) });
  c.addSound(s16(1, 0.5));
  c.addSound(s16(1.5, 0.5));
  c.addSound(s16(3, 0.5));
  assert.deepEqual(c.soundSpans(), [[1, 2], [3, 3.5]]);
});

console.log(`packet_cache: ${n} passed`);
