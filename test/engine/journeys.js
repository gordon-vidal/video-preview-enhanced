'use strict';
// The frame-exactness checks of test/vscode/cases/seeking.js, on the engine in Node (test/engine/harness.js).
// Each takes an opened player P; "frame k" always means the engine says k AND the picture is ffmpeg's frame k.
const { sleep } = require('./harness');
const AB = require('../../media/abloop');

const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

/** Steps go from picture to picture (a file can leave slots empty), across a GOP, and the , / . keys (= step). */
async function steps(P) {
  await P.expectFrame(0, 'start');
  const slot = await P.slots();
  assert(slot.length > 70, `reference decode gave ${slot.length} frames`);
  for (let k = 1; k <= 6; k++) { P.step(1); await P.expectFrame(slot[k], `step +1 to ${slot[k]}`); }
  for (let k = 5; k >= 2; k--) { P.step(-1); await P.expectFrame(slot[k], `step -1 to ${slot[k]}`); }
  const i = slot.filter((x) => x <= 28).length - 1;
  P.seek((slot[i] + 0.5) / P.fps);
  await P.expectFrame(slot[i], `seek to ${slot[i]}`);
  for (let k = i + 1; k <= i + 5; k++) { P.step(1); await P.expectFrame(slot[k], `step +1 to ${slot[k]} (across the keyframe)`); }
  P.step(-1); await P.expectFrame(slot[i + 4], `step -1 to ${slot[i + 4]}`);
}

/** Seeks land on the frame asked for, forward and back; a seek while playing keeps playing near the target. */
async function seeks(P) {
  for (const k of [45, 70, 10, 85, 59, 60, 0]) {
    P.seek((k + 0.5) / P.fps);
    await P.expectFrame(k, `seek to frame ${k}`);
  }
  P.play();
  await P.until(() => P.playing() && P.time() > 0.1, 'playing');
  const t0 = Date.now();
  P.seek(1.0);
  const ok = await P.until(() => P.playing() && P.time() >= 1.0, 'playing after the seek', 20000);
  assert(ok, `not playing at or after 1.0 s after the seek (t ${P.time()}, playing ${P.playing()})`);
  // Near the target: no further than the wall time since the seek allows (any machine load).
  const t = P.time(); const wall = (Date.now() - t0) / 1000;
  assert(t < 1.0 + wall + 0.2, `seek while playing went to ${t.toFixed(3)} s, ${wall.toFixed(2)} s after asking for 1.0`);
  P.pause();
}

/** Millisecond-rounded times (60 fps MKV, NTSC): every step moves exactly one frame around frame g. */
async function msRounded(P, g) {
  await P.expectFrame(0, 'start');
  for (let k = 1; k <= 12; k++) { P.step(1); await P.expectFrame(k, `step +1 to ${k}`); }
  for (let k = 11; k >= 6; k--) { P.step(-1); await P.expectFrame(k, `step -1 to ${k}`); }
  P.seek((g - 2 + 0.5) / P.fps);
  await P.expectFrame(g - 2, `seek to ${g - 2}`);
  for (let k = g - 1; k <= g + 2; k++) { P.step(1); await P.expectFrame(k, `step +1 to ${k}`); }
  for (let k = g + 1; k >= g - 1; k--) { P.step(-1); await P.expectFrame(k, `step -1 to ${k}`); }
  // The counter the bar shows is frame + 1 (media/timefmt.js frameText): "#g/".
  assert(P.frame() + 1 === g, `counter would say #${P.frame() + 1}, expected #${g}`);
}

/** End shows the last picture (even when the sound is longer) and leaves the player paused. */
async function endKey(P, last) {
  P.end();
  await P.expectFrame(last, `End (last of ${last + 1} frames)`);
  assert(!P.playing(), 'playing after End');
}

/** Seeking past the end and stepping past either end stay on the last / first frame. */
async function edges(P) {
  const last = P.n - 1;
  assert(last >= 85, `frame count ${P.n}`);
  P.seek(P.duration + 5);
  await P.expectFrame(last, 'seek past the end shows the last frame');
  P.step(1);
  await sleep(500);
  await P.expectFrame(last, 'step +1 at the last frame stays');
  P.seek((last - 1 + 0.5) / P.fps);
  await P.expectFrame(last - 1, 'seek to the second last frame');
  P.step(1); await P.expectFrame(last, 'step +1 reaches the last frame');
  P.home(); await P.expectFrame(0, 'Home');
  P.step(-1);
  await sleep(500);
  await P.expectFrame(0, 'step -1 at the first frame stays');
}

/** Playing to the end (loop off) shows the frames still in the decoder and stops on the last one. */
async function eof(P, last) {
  P.play();
  const stopped = await P.until(() => !P.playing() && P.time() > 1, 'the end', 60000);
  assert(stopped, `did not stop at the end (t ${P.time()})`);
  await P.expectFrame(last, 'last frame at the end');
}

/**
 * A-B loop (media/abloop.js, as media/player.js drives it every frame): marks at frames 30 and 60, the
 * loop plays only A..B and wraps at least twice; clearing both ends it.
 */
async function abloop(P) {
  const ab = AB.create();
  P.seek(30.5 / P.fps); await P.expectFrame(30, 'seek A');
  ab.set('a', P.time(), P.frame());
  P.seek(60.5 / P.fps); await P.expectFrame(60, 'seek B');
  ab.set('b', P.time(), P.frame());
  assert(ab.isRange(), 'A and B set');
  const r = ab.exportRange(P.fps, P.n);
  assert(r && r.fa === 30 && r.fb === 60, `export range ${JSON.stringify(r)}`);
  const ts = [];
  P.onTick = () => { const to = ab.wrapTarget(P.time(), P.playing()); if (to !== null) P.seek(to); ts.push(P.time()); };
  P.seek(1.5);
  P.play();
  let wraps = 0;
  const ok = await P.until(() => {
    wraps = 0;
    for (let i = 1; i < ts.length; i++) if (ts[i] < ts[i - 1] - 0.3) wraps++;
    return wraps >= 2;
  }, 'two wraps back to A', 60000);
  P.onTick = null;
  P.pause();
  assert(ok, `expected >= 2 wraps back to A, saw ${wraps}`);
  const played = ts.filter((x) => typeof x === 'number');
  const hi = Math.max(...played); const lo = Math.min(...played.slice(5));
  // One frame loop late at most (the wrap is checked each frame).
  assert(hi < 60.5 / P.fps + 2 / P.fps + 0.05, `played past B: max ${hi.toFixed(3)} s`);
  assert(lo > 30 / P.fps - 0.1, `went before A: min ${lo.toFixed(3)} s`);
  ab.set('a', P.time(), P.frame()); ab.set('b', P.time(), P.frame());
  assert(!ab.isRange() && ab.a === null && ab.b === null, 'pressing A and B again clears the loop');
}

module.exports = { steps, seeks, msRounded, endKey, edges, eof, abloop, assert };
