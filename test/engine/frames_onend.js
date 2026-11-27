'use strict';
// The end of a file with Autoplay (setting onEnd, media/autoplay.js) in the WebAssembly decoder: the matrix of
// Off / Play next in folder / Loop and an A–B range against natural playback, a seek to the end and stepping.
// The page's part (media/player.js handleEnded) is the same decision, driven here on the engine's report.
const { runJobs, J } = require('./frames_lib');
const Autoplay = require('../../media/autoplay');
const AbLoop = require('../../media/abloop');

/** The page: the decoder loops only for Loop without a range; at an end the decision runs (and A–B plays on). */
function page(P, mode, ab = AbLoop.create()) {
  const acts = [];
  P.player.setLoop(Autoplay.engineLoops(mode, ab.isSet()));
  P.onEnded = (info) => {
    const act = Autoplay.atEnd({ mode, a: ab.a, b: ab.b, natural: info.natural, file: true });
    acts.push({ ...act, natural: info.natural, ran: info.ran, stopped: !!info.stopped, at: P.time() });
    if (act.action === 'ab') { P.player.seekTime(act.to); P.player.play(); }
  };
  return acts;
}

const CLIP = 'vp8_2s.webm'; // 2 s, 60 frames, no sound: the picture is the clock
const RATE = 2;
const CUT = 'trunc.mkv'; // declares 3 s, but the data stops about halfway (the second half of the file is gone)

/** The file stops well before its declared end: reported as stopped, never as an end Loop or Autoplay acts on. */
async function earlyEnd(P, mode) {
  const acts = page(P, mode);
  P.play();
  let wrapped = false;
  let last = 0;
  J.assert(await P.until(() => {
    const t = P.time();
    if (t + 0.5 < last) wrapped = true;
    last = t;
    return acts.length || wrapped;
  }, 'the early end', 20000), 'never stopped');
  await P.until(() => false, 'settle', 500);
  J.assert(!wrapped, `${mode}: started over from the start (the early end read as the end of the file)`);
  J.assert(acts.length === 1 && acts[0].stopped && !acts[0].natural, `${mode}: ${JSON.stringify(acts)}`);
  J.assert(acts[0].at < P.duration - 0.5, `${mode}: stopped at ${acts[0].at} of ${P.duration} s`);
  J.assert(!P.playing(), `${mode}: paused`);
  J.assert(Math.abs(P.time() - acts[0].at) < 0.1, `${mode}: stays on the last frame (${P.time()} vs ${acts[0].at})`);
}

runJobs('engine frames: Autoplay at the end of the file', [
  ['onend/off', CLIP, async (P) => {
    const acts = page(P, 'off');
    P.setRate(RATE);
    P.play();
    J.assert(await P.until(() => acts.length, 'the end', 20000), 'never reached the end');
    await P.until(() => false, 'settle', 300);
    J.assert(acts.length === 1 && acts[0].action === 'stop' && acts[0].natural, `Off: ${JSON.stringify(acts)}`);
    J.assert(!P.playing(), 'Off: paused');
    J.assert(P.frame() === P.n - 1, `Off: on the last frame (${P.frame()} of ${P.n})`);
  }],
  ['onend/next', CLIP, async (P) => {
    const acts = page(P, 'next');
    P.setRate(RATE);
    P.play();
    J.assert(await P.until(() => acts.length, 'the end', 20000), 'never reached the end');
    await P.until(() => false, 'settle', 500);
    J.assert(acts.length === 1, `Play next: one report, got ${acts.length}`);
    J.assert(acts[0].action === 'next' && acts[0].natural && acts[0].ran > 1, `Play next: ${JSON.stringify(acts)}`);
    J.assert(!P.playing() && P.frame() === P.n - 1, 'Play next: paused on the last frame meanwhile');
  }],
  ['onend/next-seek-to-end', CLIP, async (P) => {
    // A seek to the very end while playing is not playback reaching it: no advance.
    const acts = page(P, 'next');
    P.setRate(RATE);
    P.play();
    await P.until(() => P.time() > 0.3, 'playing', 10000);
    P.seek(P.duration - 0.03);
    J.assert(await P.until(() => acts.length, 'the end', 20000), 'never reached the end');
    J.assert(acts[0].action === 'stop' && !acts[0].natural, `seek to the end: ${JSON.stringify(acts)}`);
  }],
  ['onend/next-step-and-end-key', CLIP, async (P) => {
    // Paused: End and frame steps at the end report nothing.
    const acts = page(P, 'next');
    P.end();
    await P.expectFrame(P.n - 1, 'End');
    P.step(1);
    await P.until(() => false, 'settle', 400);
    J.assert(acts.length === 0, `End / step: ${JSON.stringify(acts)}`);
    J.assert(!P.playing(), 'still paused');
  }],
  ['onend/next-stalled-feed', CLIP, async (P) => {
    // The feed stalls (no data, no end of file) and the clock runs past the declared end: the watchdog pauses, but
    // the report is not "played into the end", so Play next in folder stays on this file.
    const acts = page(P, 'next');
    const p = P.player;
    P.stallReads = true;
    P.onTick = () => { for (const f of p.queue.splice(0)) p.release(f); p.eof = false; };
    const end = (p.startT || 0) + P.duration;
    p.play();
    p.now = () => end + 2;
    J.assert(await P.until(() => acts.length, 'the watchdog', 10000), 'the watchdog never paused');
    J.assert(acts[0].action === 'stop' && !acts[0].natural, `stalled feed: ${JSON.stringify(acts)}`);
    J.assert(!P.playing(), 'paused');
    P.onTick = null;
  }],
  ['onend/early-end-next', CUT, (P) => earlyEnd(P, 'next')],
  ['onend/early-end-loop', CUT, (P) => earlyEnd(P, 'loop')],
  ['onend/loop', CLIP, async (P) => {
    const acts = page(P, 'loop');
    P.setRate(RATE);
    P.play();
    let wrapped = false;
    let last = 0;
    J.assert(await P.until(() => { const t = P.time(); if (t + 0.5 < last) wrapped = true; last = t; return wrapped; }, 'a wrap', 20000), 'Loop: never started over');
    J.assert(acts.length === 0, `Loop: no end report (${JSON.stringify(acts)})`);
    J.assert(P.playing(), 'Loop: still playing');
  }],
  ['onend/ab-wins', CLIP, async (P) => {
    // A set (no B): the range is A..end; at the end it goes back to A, whatever Autoplay says.
    const ab = AbLoop.create();
    ab.set('a', 1, Math.round(1 * P.fps));
    const acts = page(P, 'next', ab);
    J.assert(P.player.loop === false, 'the decoder does not loop while a range is set');
    P.setRate(RATE);
    P.seek(1.2);
    P.play();
    J.assert(await P.until(() => acts.length, 'the end', 20000), 'never reached the end');
    J.assert(acts[0].action === 'ab' && acts[0].to === 1, `A–B: ${JSON.stringify(acts)}`);
    J.assert(await P.until(() => P.playing() && P.time() >= 1 && P.time() < 1.6, 'back at A', 10000), `A–B: playing from A (t ${P.time().toFixed(2)})`);
  }],
]);
