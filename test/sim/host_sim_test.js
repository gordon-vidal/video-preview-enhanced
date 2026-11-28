'use strict';

const assert = require('node:assert/strict');
const { withHost, idr, inter, gop, arg } = require('./host');
const { tsPacket } = require('../lib/ts-packet');

const seek = (page, gen, t, flags = {}) => page.send({ type: 'seek', gen, t, playing: false, quick: false, ...flags });
const more = (page, gen) => page.send({ type: 'more', gen, limit: 128 * 1024 });
const pts = (packets) => packets.map(({ t }) => Number(t.toFixed(4)));
const scale = (proc) => arg(proc, '-vf').match(/scale=(\d+):(\d+)/).slice(1).map(Number);

async function heldPacketsAndFill() {
  await withHost({}, async ({ page, processes }) => {
    page.send({ type: 'open' });
    await page.advance(10);
    processes[0].output(5, gop(10));
    more(page, 0);
    await page.advance(40);
    const initial = page.messages('batch').at(-1).video;
    assert.ok(initial.length >= 2);
    const have = { keyT: initial[0].t, lastT: initial[1].t, enc: initial[0].enc };

    seek(page, 1, 0.04, { have });
    page.send({ type: 'playback', playing: true });
    more(page, 1);
    await page.advance(50);
    assert.equal(processes.length, 1, 'cached seek and play reuse ffmpeg');
    assert.deepEqual(page.messages('seeked').at(-1), { type: 'seeked', gen: 1, t: 0.04, have: true });
    const continuation = page.messages('batch').at(-1).video;
    assert.equal(continuation[0].t, 0.08);
    assert.equal(continuation[0].enc, have.enc);

    seek(page, 2, 0.04, { have: { ...have, enc: have.enc + 1 } });
    more(page, 2);
    await page.advance(50);
    assert.equal(page.messages('seeked').at(-1).have, undefined);
    assert.equal(page.messages('batch').at(-1).video[0].t, 0, 'another encode requires the keyframe');

    page.send({ type: 'playback', playing: false });
    page.send({ type: 'fill', id: 8, from: 0, to: 0.16 });
    await page.advance(10);
    assert.equal(arg(processes[1], '-frames:v'), '4');
    processes[1].output(2, gop(4));
    processes[1].exit(5);
    await page.advance(30);
    if (!page.messages('fillBatch').at(-1).done) {
      page.send({ type: 'fillMore', id: 8 });
      await page.advance(20);
    }
    const batches = page.messages('fillBatch').filter((m) => m.id === 8);
    assert.deepEqual(pts(batches.flatMap((m) => m.video)), [0, 0.04, 0.08, 0.12]);
    assert.ok(batches.every((m) => m.video.every((p) => p.enc !== have.enc)));
    assert.equal(page.messages('fillBatch').at(-1).done, true);
    assert.equal(page.messages('fillBatch').at(-1).error, undefined);

    page.send({ type: 'fill', id: 9, from: 1, to: 1.16 });
    await page.advance(10);
    processes[2].output(2, Buffer.concat([gop(2), inter.subarray(0, 7)]));
    processes[2].output(3, Buffer.from('scripted ffmpeg failure'), 2);
    processes[2].exit(5, 1);
    for (let i = 0; i < 3; i++) {
      await page.advance(20);
      if (page.messages('fillBatch').at(-1).id === 9 && page.messages('fillBatch').at(-1).done) break;
      page.send({ type: 'fillMore', id: 9 });
    }
    const failed = page.messages('fillBatch').filter((m) => m.id === 9);
    assert.deepEqual(pts(failed.flatMap((m) => m.video)), [1, 1.04]);
    assert.equal(failed.at(-1).done, true);
    assert.match(failed.at(-1).error, /scripted ffmpeg failure/);
  });
}

async function warmSeekBurst() {
  const pid = 0x100;
  const pes = (t, bytes, cc) => {
    const packet = tsPacket(pid, { pes: { pts: t }, len: 8 + bytes.length, cc });
    bytes.copy(packet, 18);
    return packet;
  };
  await withHost({
    options: { warm: true, initialLink: { fastKbps: 100_000, slowKbps: 100_000, tier: 0, timestamp: 100_000 } },
    script(proc, processes) {
      const bsf = arg(proc, '-bsf:v');
      const segmentStart = proc.args.includes('-copyts') && /\((\d+\.\d+)\+if\(/.exec(bsf);
      if (!segmentStart) return;
      const middle = Number(segmentStart[1]);
      const remux = Buffer.concat([pes(middle - 0.06, idr, 0), pes(middle, idr, 1),
        pes(middle + 0.04, inter, 2), pes(middle + 0.08, inter, 3)]);
      const warm = processes.find((p) => p.args.includes('pipe:0'));
      warm.stdin.once('data', (data) => {
        assert.equal(data[0], 0x47);
        warm.output(2, Buffer.concat([pes(middle, idr, 0), pes(middle + 0.04, inter, 1), pes(middle + 0.08, inter, 2)]));
      });
      proc.output(5, remux);
    },
  }, async ({ page, processes }) => {
    page.send({ type: 'open' });
    more(page, 0);
    await page.advance(100);
    assert.equal(processes.length, 2, 'warm encoder plus first copy remux');
    assert.equal(page.messages('batch').at(-1).video[0].t, 0);

    seek(page, 1, 7.03999999);
    seek(page, 2, 7.07999999);
    seek(page, 3, 7.11999999);
    more(page, 3);
    await page.advance(900);
    const remuxers = processes.filter((p) => arg(p, '-bsf:v')?.startsWith('setts='));
    assert.equal(processes.filter((p) => p.args.includes('pipe:0')).length, 1);
    assert.equal(remuxers.length, 2, 'the seek burst starts only one new copy remux');
    assert.ok(Math.abs(Number(arg(remuxers[1], '-ss')) - 7.13) < 1e-6, 'keyframe seek allows a quarter-frame rounding margin');
    assert.equal(page.messages('seeked').at(-1).t, 7.12);
    assert.equal(page.messages('batch').at(-1).video[0].t, 7.12, 'warm timestamps map back onto the source grid');

    seek(page, 4, 14, { playing: true });
    page.send({ type: 'playback', playing: true });
    more(page, 4);
    await page.advance(900);
    assert.equal(processes.length, 4, 'play during seek uses a fresh continuous encode');
    assert.equal(Number(arg(processes[3], '-ss')), 14.0005);
    processes[3].output(2, gop(5));
    await page.advance(20);
    assert.equal(page.messages('batch').at(-1).video[0].t, 14);
  });
}

async function pausedPictures() {
  await withHost({}, async ({ page, processes }) => {
    page.link({ downMbps: 1, upMbps: 10, rttMs: 80 });
    page.send({ type: 'open' });
    await page.advance(100);
    seek(page, 1, 12, { quick: true });
    more(page, 1);
    await page.advance(800);
    const live = processes[1];
    const quick = processes[2];
    assert.deepEqual(scale(quick), scale(live).map((n) => n / 2));
    live.output(1, gop(6));
    quick.output(30, idr);
    quick.exit(31);
    await page.advance(100);
    const q = page.messages('quickFrame').at(-1);
    const batch = page.messages('batch').at(-1);
    assert.equal(q.t, 12);
    assert.ok(page.received.indexOf(q) < page.received.indexOf(batch));

    page.send({ type: 'sharp', id: 1, t: 12 });
    await page.advance(60);
    assert.deepEqual(scale(processes[3]), scale(live));
    processes[3].output(1, idr);
    processes[3].exit(2);
    await page.advance(100);
    const sharp = page.messages('sharpFrame').at(-1);
    assert.equal(sharp.t, q.t);
    assert.equal(sharp.done, true);
    assert.ok(page.received.indexOf(q) < page.received.indexOf(sharp));

    page.send({ type: 'sharp', id: 2, t: 12.04 });
    await page.advance(60);
    processes[4].output(1, idr);
    processes[4].exit(2);
    await page.advance(3);
    page.send({ type: 'sharp', id: 3, t: 12.08 });
    await page.advance(80);
    assert.ok(page.dropped.some((m) => m.type === 'sharpFrame' && m.id === 2));

    seek(page, 2, 20, { quick: true });
    await page.advance(900);
    const [superseded, delayedQuick] = processes.slice(-2);
    assert.equal(arg(delayedQuick, '-frames:v'), '1');
    delayedQuick.output(1, idr);
    delayedQuick.exit(2);
    await page.advance(3);
    seek(page, 3, 21, { quick: true });
    await page.advance(100);
    assert.ok(page.dropped.some((m) => m.type === 'quickFrame' && m.gen === 2));
    assert.ok(superseded.signalCode, 'the superseded live encoder stopped');

    more(page, 3);
    await page.advance(80);
    const [waitingLive, waitingQuick] = processes.slice(-2);
    assert.equal(arg(waitingQuick, '-frames:v'), '1');
    waitingLive.output(1, gop(5));
    await page.advance(10);
    assert.ok(!page.messages('batch').some((m) => m.gen === 3), 'paused pull waits for the quick picture');
    page.send({ type: 'playback', playing: true });
    await page.advance(120);
    assert.ok(waitingQuick.signalCode, 'play cancels the stalled still');
    assert.equal(page.messages('batch').at(-1).video[0].t, 21);
  });
}

async function resizeAndHide(native) {
  await withHost({ native }, async ({ page, processes }) => {
    const small = { w: 320, h: 180 };
    const big = { w: 1920, h: 1080 };
    page.send({ type: 'open', view: small });
    await page.advance(100);
    const initial = scale(processes[0]);
    page.send({ type: 'view', ...big });
    await page.advance(30);
    assert.equal(page.messages('refresh').length, 1, 'grow asks the page to seek immediately');
    seek(page, 1, 3);
    await page.advance(800);
    const grown = scale(processes[1]);
    assert.deepEqual(grown, [1920, 1080]);
    assert.ok(grown[1] > initial[1]);

    page.send({ type: 'view', ...small });
    await page.advance(100);
    assert.equal(page.messages('refresh').length, 1);
    assert.equal(processes.length, 2, 'a resize down alone keeps the decoder');
    seek(page, 2, 8);
    await page.advance(800);
    assert.deepEqual(scale(processes[2]), initial);

    page.send({ type: 'hidden', on: true });
    await page.advance(100);
    assert.ok(processes[2].signalCode, 'hide stops the active decoder');
    page.send({ type: 'hidden', on: false });
    seek(page, 3, 8);
    page.send({ type: 'more', gen: 3, n: 1 });
    await page.advance(800);
    const [w, h] = initial;
    processes[3].output(2, native ? Buffer.alloc(w * h * 3 / 2, 42) : gop(4));
    await page.advance(150);
    const frame = page.messages(native ? 'ndv' : 'batch').at(-1);
    assert.equal(frame.gen, 3);
    assert.equal(native ? frame.t : frame.video[0].t, 8);
  });
}

function oggOpus() {
  const head = Buffer.alloc(19);
  head.write('OpusHead');
  head[8] = 1;
  head[9] = 2;
  head.writeUInt32LE(48000, 12);
  const audio = Array.from({ length: 40 }, () => Buffer.from([0xf8, 0xff, 0xfe]));
  const packets = [head, ...audio];
  const page = Buffer.alloc(27);
  page.write('OggS');
  page[26] = packets.length;
  return Buffer.concat([page, Buffer.from(packets.map((p) => p.length)), ...packets]);
}

async function slowLinkWithOpus() {
  const picture = (n) => Buffer.concat([idr, Buffer.alloc(24_000, 0x55),
    ...Array.from({ length: n - 1 }, () => Buffer.concat([inter, Buffer.alloc(24_000, 0x55)]))]);
  await withHost({
    audio: true,
    options: { audioEncoder: 'libopus', allowOverlap: false },
    script(proc) {
      if (proc.args.includes('opus')) {
        proc.output(10, oggOpus());
        return;
      }
      const video = picture(12);
      for (let i = 0; i < 40; i++) proc.output(10 + i * 2000, video);
    },
  }, async ({ page, processes, clock }) => {
    page.send({ type: 'open' });
    await page.advance(3000);
    assert.equal(page.messages('streams')[0].info.audio.codec, 'opus');
    more(page, 0);
    await page.advance(120);
    const starting = page.messages('batch').at(-1);
    assert.ok(starting.audio.length > 0, 'Opus packets delivered');
    const sample = async (starved) => {
      const at = clock.now();
      const count = page.messages('batch').length;
      more(page, 0);
      for (let ms = 0; ms < 4000 && page.messages('batch').length === count; ms += 10) {
        await page.advance(10);
      }
      assert.equal(page.messages('batch').length, count + 1, 'link sample received a batch');
      const readMs = clock.now() - at;
      const batch = page.messages('batch').at(-1);
      const bytes = batch.video.reduce((sum, p) => sum + p.data.byteLength, 0);
      page.send({ type: 'remoteLink', gen: 0, kbps: bytes * 8 / readMs, videoKbps: 4800,
        readMs, hostWaitMs: batch.hostWaitMs, mediaRate: starved ? 0.25 : 1.2,
        buffer: starved ? 0.01 : 3, starved, behind: false });
      await page.advance(100);
    };
    page.link({ downMbps: 1.1, upMbps: 20, rttMs: 50 });
    await sample(true);
    const info = () => page.messages('transcodeInfo').map((m) => m.transcode);
    const down = info().find((m) => m.adaptingDir === 'down');
    assert.ok(down && down.tier > 0);
    assert.equal(processes.filter((p) => p.args.includes('opus')).length, 1, 'adaptation keeps the Opus process');

    page.link({ downMbps: 100, upMbps: 100, rttMs: 2 });
    await page.advance(30_000);
    for (let i = 0; i < 30 && !info().some((m) => m.adaptingDir === 'up'); i++) {
      await sample(false);
      await page.advance(1900);
    }
    const up = info().find((m) => m.adaptingDir === 'up');
    assert.ok(up && up.tier < down.tier);
    assert.equal(processes.filter((p) => p.args.includes('opus')).length, 1);
  });
}

(async () => {
  await heldPacketsAndFill();
  await warmSeekBurst();
  await pausedPictures();
  await resizeAndHide(false);
  await resizeAndHide(true);
  await slowLinkWithOpus();
  console.log('host simulator: 6 journeys passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
