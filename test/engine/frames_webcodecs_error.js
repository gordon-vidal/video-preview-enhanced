'use strict';
// A WebCodecs decoder error in the middle of a file (media/engine.js resumeAfterVideoError, decoder-worker.js
// rereadVideo): the real engine, decoder worker and clips, with a stand-in VideoDecoder (Node has none) that
// fails the way Chromium's does: asynchronously, after it was handed packets far ahead, closing itself and
// dropping every packet it still held. Playback runs on the harness's virtual clock, so every picture is shown
// (on the wall clock a late timer drops pictures, here as in a page).
//
// The regression (layer 3 playback/damaged-h264/damaged_h264_b.mkv, found when new tabs stopped looping by
// default): the 5 s clip with one damaged picture at 2.5 s is read in one batch, so the failed decoder held every
// packet to the end; the new decoder got none, the end of the file followed, and playback stopped at 2.47 s as
// "Fully decoded".
const { open, checks } = require('./harness');
const J = require('./journeys');
const media = require('../media/make_cases_media');

const W = 64;
const H = 36;
const made = []; // every decoder of the current job
let failAt = null; // (chunk) => true: the decoder fails on this packet; 'soft': no WebCodecs for this job

function videoFrame(timestamp) {
  return {
    timestamp, format: 'I420', codedWidth: W, codedHeight: H, displayWidth: W, displayHeight: H,
    colorSpace: { matrix: 'bt709', fullRange: false },
    allocationSize: () => W * H * 3 / 2,
    copyTo: async () => [{ offset: 0, stride: W }, { offset: W * H, stride: W / 2 }, { offset: W * H * 5 / 4, stride: W / 2 }],
    clone() { return videoFrame(timestamp); },
    close() { this.format = null; },
  };
}

globalThis.EncodedVideoChunk = class { constructor(init) { Object.assign(this, init); } };
globalThis.VideoDecoder = class {
  static async isConfigSupported(config) { return { supported: failAt !== 'soft', config }; }
  constructor({ output, error }) {
    Object.assign(this, { output, error, state: 'unconfigured', queue: [], flushes: [], needKey: true, decoded: 0, timer: null });
    made.push(this);
  }
  get decodeQueueSize() { return this.queue.length; }
  configure() { this.state = 'configured'; }
  decode(chunk) {
    if (this.state !== 'configured') throw new Error('InvalidStateError: decode() on a closed decoder');
    if (this.needKey && chunk.type !== 'key') throw new Error('DataError: a key frame is required after configure() or flush()');
    this.needKey = false;
    this.queue.push(chunk);
    this.run();
  }
  run() { if (!this.timer) this.timer = setImmediate(() => { this.timer = null; this.step(); }); }
  step() {
    if (this.state !== 'configured') return;
    const chunk = this.queue.shift();
    if (chunk) {
      if (this.ondequeue) this.ondequeue();
      if (typeof failAt === 'function' && failAt(chunk)) {
        // Chromium: the decoder closes, pending flushes are rejected, what it held is gone, then the callback.
        this.state = 'closed';
        this.queue = [];
        for (const f of this.flushes.splice(0)) f.rej(new Error('EncodingError'));
        this.error(new Error('Decoding error.'));
        return;
      }
      this.decoded++;
      this.output(videoFrame(chunk.timestamp));
    }
    if (this.queue.length) this.run(); else for (const f of this.flushes.splice(0)) f.res();
  }
  flush() {
    if (this.state !== 'configured') return Promise.reject(new Error('InvalidStateError'));
    this.needKey = true;
    return new Promise((res, rej) => { this.flushes.push({ res, rej }); this.run(); });
  }
  close() {
    this.state = 'closed';
    this.queue = [];
    for (const f of this.flushes.splice(0)) f.rej(new Error('AbortError'));
  }
};

/** A picture slice (AVCC packet) whose header is all ones: damaged_h264_b.mkv's 76th picture (make_cases_media.js damageH264 'header'). */
function damagedSlice(chunk) {
  const d = chunk.data;
  for (let o = 0; o + 5 <= d.length;) {
    const n = ((d[o] << 24) | (d[o + 1] << 16) | (d[o + 2] << 8) | d[o + 3]) >>> 0;
    const type = d[o + 4] & 31;
    if ((type === 1 || type === 5) && n > 9 && d.subarray(o + 5, o + 13).every((x) => x === 0xff)) return true;
    o += 4 + n;
  }
  return false;
}
/** Fails once on the packet at `t` seconds (a transient error of the decoder, the file is fine). */
const onceAt = (t) => { let done = false; return (chunk) => { if (done || Math.abs(chunk.timestamp / 2e6 - t) > 1e-3) return false; done = true; return true; }; };

/** Every picture the player shows, in order (its presentation times in ms), and the ends it reports. */
function watch(P) {
  const p = P.player;
  const shown = [];
  const ends = [];
  P.onTick = () => { const t = p.shownT === null ? null : Math.round(p.shownT * 1000); if (t !== null && shown[shown.length - 1] !== t) shown.push(t); };
  P.onEnded = (info) => ends.push({ ...info, at: p.currentTime() });
  return { shown, ends };
}
const errorsLogged = (P) => P.logs.filter((x) => /VideoDecoder error/.test(x)).length;
const frameMs = (k) => Math.round(k * 1000 / 30);
const range = (a, b) => Array.from({ length: b - a }, (_, i) => a + i);
function inOrder(shown, what) {
  for (let i = 1; i < shown.length; i++) J.assert(shown[i] > shown[i - 1], `${what}: the picture went back from ${shown[i - 1]} to ${shown[i]} ms`);
}

const c = checks('engine frames: a WebCodecs decoder error in mid-file');
/** Opens `clip` with the stand-in decoder failing on the packets `fail` picks; each job has a fresh player. */
const job = (name, clip, fail, fn) => c.run(name, async () => {
  const f = media.make(clip);
  if (!f) throw new Error(`${clip} could not be made (ffmpeg with the needed encoder?)`);
  failAt = fail;
  made.length = 0;
  const P = await open(f, { virtualClock: true });
  try { await fn(P); } finally { P.close(); failAt = null; }
});

const DAMAGED = 'damaged_h264_b.mkv'; // 5 s, 30 fps, keyframes every second, no sound; picture 75 (2.5 s) is damaged

(async () => {
  await job('webcodecs-error/damaged-plays-on', DAMAGED, damagedSlice, async (P) => {
    const p = P.player;
    J.assert(P.vmode === 'webcodecs', `the stand-in WebCodecs decoder is not in use (${P.vmode})`);
    // The whole file went into the decoder at the open; its error comes while still paused.
    J.assert(await P.until(() => errorsLogged(P) === 1 && p.vReread === undefined, 'the decoder error', 10000), 'no decoder error at the damaged picture');
    await P.clock.advance(320);
    J.assert(!p.eof, 'the damage counts as the end of the file (eof while 2.5 s of pictures are missing)');
    J.assert(p.status().text !== 'Fully decoded', 'status "Fully decoded" at the damage');
    const { shown, ends } = watch(P);
    P.play();
    J.assert(await P.until(() => ends.length, 'the end', 15000), `never reached the end (t ${P.time().toFixed(2)} s, shown to ${shown[shown.length - 1]} ms)`);
    J.assert(ends[0].natural && ends[0].at > 4.9, `ended at ${ends[0].at.toFixed(3)} s, not at the end of the 5 s file: ${JSON.stringify(ends[0])}`);
    inOrder(shown, 'playing');
    // Every picture up to the damage, none of its group (2.5 .. 3 s can't be decoded), every one from the keyframe at 3 s.
    const want = [...range(1, 75), ...range(90, 150)].map(frameMs);
    const missing = want.filter((t) => !shown.includes(t));
    J.assert(!missing.length, `pictures never shown (ms): ${missing.join(' ')}`);
    const lost = shown.filter((t) => t > frameMs(74) && t < frameMs(90));
    J.assert(!lost.length, `pictures of the damaged group shown (ms): ${lost.join(' ')}`);
    J.assert(shown[shown.length - 1] === frameMs(149), `the last picture shown is ${shown[shown.length - 1]} ms`);
    J.assert(P.vmode === 'webcodecs' && errorsLogged(P) === 1 && made.length === 2, `one error, one new decoder: ${errorsLogged(P)} errors, ${made.length} decoders, ${P.vmode}`);
    J.assert(made[1].decoded === 60, `the new decoder started at the keyframe after the damage: it decoded ${made[1].decoded} pictures, expected 60`);
  });
  await job('webcodecs-error/seek-into-damaged-group', DAMAGED, damagedSlice, async (P) => {
    const p = P.player;
    await P.until(() => errorsLogged(P) === 1 && p.vReread === undefined, 'the decoder error', 10000);
    // 2.8 s is in the group that can't be decoded: the seek settles on the last picture before it and playback goes on.
    P.seek(2.8);
    J.assert(await P.until(() => errorsLogged(P) === 2 && p.seekTarget === null && p.vReread === undefined, 'the seek', 10000), `the seek never settled (target ${p.seekTarget})`);
    await P.clock.advance(320);
    J.assert(Math.round(p.shownT * 1000) === frameMs(74), `paused on ${p.shownT} s, expected the last picture before the damage (2.467 s)`);
    // Paused this near the end the rest is decoded ahead: the end of the file is the real one.
    J.assert(await P.until(() => p.eof, 'the rest decoded', 10000) && Math.round(p.lastT * 1000) === frameMs(149), `decoded to ${p.lastT} s, eof ${p.eof}`);
    const { shown, ends } = watch(P);
    P.play();
    J.assert(await P.until(() => ends.length, 'the end', 15000), `never reached the end (t ${P.time().toFixed(2)} s)`);
    J.assert(ends[0].at > 4.9, `ended at ${ends[0].at.toFixed(3)} s`);
    inOrder(shown, 'playing after the seek');
    const missing = range(90, 150).map(frameMs).filter((t) => !shown.includes(t));
    J.assert(!missing.length, `pictures never shown after the seek (ms): ${missing.join(' ')}`);
  });
  await job('webcodecs-error/third-error-software', DAMAGED, damagedSlice, async (P) => {
    // The same damage hit three times (the open, two seeks into its group): the built-in decoder takes over and shows the rest.
    const p = P.player;
    await P.until(() => errorsLogged(P) === 1 && p.vReread === undefined, 'the decoder error', 10000);
    P.seek(2.8);
    await P.until(() => errorsLogged(P) === 2 && p.seekTarget === null && p.vReread === undefined, 'the second error', 10000);
    P.seek(0.2);
    await P.until(() => p.seekTarget === null && p.shownT !== null && p.shownT < 0.3, 'the seek back', 10000);
    P.seek(2.8);
    J.assert(await P.until(() => P.vmode === 'soft' && p.seekTarget === null, 'software video', 15000), `no software fallback after three errors (${errorsLogged(P)} errors, ${P.vmode})`);
    const { shown, ends } = watch(P);
    P.play();
    J.assert(await P.until(() => ends.length, 'the end', 15000), `never reached the end (t ${P.time().toFixed(2)} s)`);
    J.assert(ends[0].at > 4.9 && shown[shown.length - 1] === frameMs(149), `ended at ${ends[0].at.toFixed(3)} s on ${shown[shown.length - 1]} ms`);
  });
  await job('webcodecs-error/sound-unbroken', 's_h264.mp4', onceAt(1.5), async (P) => {
    // 3 s with sound, read in one batch: the picture is read again from 1.5 s, the sound is neither repeated nor cut.
    const p = P.player;
    J.assert(P.vmode === 'webcodecs', `the stand-in WebCodecs decoder is not in use (${P.vmode})`);
    J.assert(await P.until(() => errorsLogged(P) === 1 && p.vReread === undefined, 'the decoder error', 10000), 'no decoder error');
    const heard = p.audio.map((a) => [a.t, a.dur]);
    const add = p.addAudio.bind(p);
    p.addAudio = (t, rate, planes, mask) => { heard.push([t, planes[0].length / rate]); return add(t, rate, planes, mask); };
    const { shown, ends } = watch(P);
    P.play();
    J.assert(await P.until(() => ends.length, 'the end', 15000), `never reached the end (t ${P.time().toFixed(2)} s)`);
    inOrder(shown, 'playing');
    // (B-frames: the last few pictures before 1.5 s may follow the failed packet in decode order.)
    const missing = [...range(1, 40), ...range(60, 90)].map(frameMs).filter((t) => !shown.includes(t));
    J.assert(!missing.length, `pictures never shown (ms): ${missing.join(' ')}`);
    J.assert(heard.length > 10, `only ${heard.length} chunks of sound`);
    for (let i = 1; i < heard.length; i++) {
      const gap = heard[i][0] - (heard[i - 1][0] + heard[i - 1][1]);
      J.assert(Math.abs(gap) < 0.002, `sound ${gap > 0 ? 'cut' : 'repeated'} at ${heard[i][0].toFixed(3)} s (${(gap * 1000).toFixed(1)} ms)`);
    }
    const end = heard[heard.length - 1][0] + heard[heard.length - 1][1];
    J.assert(end > P.duration - 0.1, `the sound ends at ${end.toFixed(3)} s of ${P.duration} s`);
  });
  await job('webcodecs-error/no-keyframe-after', 's_h264.mp4', (chunk) => chunk.timestamp / 2e6 > 2.49, async (P) => {
    // Everything from 2.5 s fails and no keyframe follows (the last is at 2 s): the file ends where its pictures and
    // its sound end, without a hang and without failing again on the packets read a second time.
    const p = P.player;
    J.assert(await P.until(() => errorsLogged(P) === 1 && p.vReread === undefined, 'the decoder error', 10000), 'no decoder error');
    const { shown, ends } = watch(P);
    P.play();
    J.assert(await P.until(() => ends.length, 'the end', 15000), `never reached the end (t ${P.time().toFixed(2)} s, eof ${p.eof})`);
    // (The clip has B-frames: which pictures just before 2.5 s were decoded depends on its packet order.)
    J.assert(p.eof && p.lastT > 2.2 && p.lastT < 2.49, `decoded to ${p.lastT} s (eof ${p.eof}), expected the last picture before the failure`);
    J.assert(ends[0].natural && ends[0].ran > 2.9, `played for ${ends[0].ran.toFixed(3)} s: ended before the end of the sound`);
    const last = shown[shown.length - 1];
    J.assert(last > 2200 && last < 2490 && errorsLogged(P) === 1 && P.vmode === 'webcodecs', `last picture ${last} ms, ${errorsLogged(P)} errors, ${P.vmode}`);
  });
  // The built-in decoder conceals the damage itself (both kinds of it): the picture goes on to the end.
  for (const clip of ['damaged_h264.mkv', DAMAGED]) {
    await job(`software/${clip}`, clip, 'soft', async (P) => {
      J.assert(P.vmode === 'soft', `expected the built-in decoder (${P.vmode})`);
      P.seek(2.2);
      await P.until(() => P.player.seekTarget === null, 'the seek', 10000);
      const { shown, ends } = watch(P);
      P.play();
      J.assert(await P.until(() => ends.length, 'the end', 15000), `never reached the end (t ${P.time().toFixed(2)} s)`);
      inOrder(shown, 'playing');
      J.assert(ends[0].at > 4.9 && shown[shown.length - 1] === frameMs(149) && shown.length > 75, `ended at ${ends[0].at.toFixed(3)} s on ${shown[shown.length - 1]} ms after ${shown.length} pictures`);
    });
  }
  c.done();
})();
