'use strict';
// Playback continuity on a virtual clock (harness `virtualClock: true`): the clock never jumps back while
// mute, rate and pause/play change under it, then a seeded random walk over the player's actions checks the
// engine stays sane and, once settled, shows ffmpeg's frame. A failure prints the seed:
//   VPE_FUZZ_SEED=<seed> node test/run.js engine --grep continuity_fuzz
const { open, checks } = require('./harness');
const media = require('../media/make_cases_media');

const CLIP = 's_h264.mp4'; // 90 frames at 30 fps, with sound
const SEED = Number(process.env.VPE_FUZZ_SEED) || 20261123;
const ACTIONS = 70;

const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
/** mulberry32: small seeded PRNG. */
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const errors = (P) => P.logs.filter((x) => /tick error|worker error|engine start failed/.test(x));
const openClip = async () => {
  const f = media.make(CLIP);
  if (!f) throw new Error(`${CLIP} could not be made (ffmpeg with the needed encoder?)`);
  return open(f, { virtualClock: true });
};

const c = checks('engine continuity: virtual clock');

(async () => {

await c.run('mute / rate / pause continuity', async () => {
  const P = await openClip();
  try {
    P.setMuted(false);
    P.home();
    await P.expectFrame(0, 'start');
    P.play();
    const samples = [];
    // Every virtual tick: the clock a viewer sees, and whether the player is meant to be running.
    const step = async (ms, label) => {
      const end = P.clock.now() + ms;
      while (P.clock.now() < end) {
        await P.clock.advance(16, 16);
        samples.push({ t: P.time(), playing: P.playing(), label, at: P.clock.now() });
      }
    };
    const plan = [
      [300, 'play'], ['m', true], [300, 'muted'], ['m', false], [300, 'unmuted'], ['m', true], [200, 'muted'],
      ['m', false], [300, 'unmuted'], ['r', 2], [300, 'rate 2'], ['r', 1], [200, 'rate 1'],
      ['p'], [100, 'paused'], ['g'], [300, 'play again'],
    ];
    for (const [a, b] of plan) {
      if (a === 'm') P.setMuted(b); else if (a === 'r') P.setRate(b); else if (a === 'p') P.pause(); else if (a === 'g') P.play();
      else await step(a, b);
    }
    for (let i = 1; i < samples.length; i++) {
      const a = samples[i - 1]; const b = samples[i];
      assert(Number.isFinite(b.t), `t is ${b.t} (${b.label})`);
      if (a.playing && b.playing) assert(b.t >= a.t - 1e-6, `clock went back ${a.t.toFixed(3)} -> ${b.t.toFixed(3)} during "${b.label}"`);
    }
    const run = samples.filter((s) => s.playing);
    assert(run.length > 40, `only ${run.length} playing samples`);
    assert(run[run.length - 1].t - run[0].t > 0.8, `no progress: ${run[0].t.toFixed(3)} -> ${run[run.length - 1].t.toFixed(3)}`);
    // No stall: within any 300 ms virtual window of continuous play the clock moves.
    for (let i = 0; i + 19 < samples.length; i++) {
      const w = samples.slice(i, i + 20);
      if (w.every((s) => s.playing && s.label === w[0].label) && w[19].t < P.duration - 0.2) {
        assert(w[19].t - w[0].t > 0.05, `clock froze at ${w[0].t.toFixed(3)} during "${w[0].label}"`);
      }
    }
    assert(!errors(P).length, `errors: ${errors(P).join('; ')}`);
  } finally { P.close(); }
});

await c.run(`seeded action fuzz (seed ${SEED}, ${ACTIONS} actions)`, async () => {
  const P = await openClip();
  const rnd = prng(SEED);
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const log = [];
  try {
    for (let i = 0; i < ACTIONS; i++) {
      const r = rnd();
      let what;
      if (r < 0.12) { P.play(); what = 'play'; }
      else if (r < 0.22) { P.pause(); what = 'pause'; }
      else if (r < 0.37) { const k = Math.floor(rnd() * P.n); P.seekFrame(k); what = `seekFrame ${k}`; }
      else if (r < 0.52) { const d = rnd() < 0.5 ? 1 : -1; P.step(d); what = `step ${d}`; }
      else if (r < 0.64) { const m = rnd() < 0.5; P.setMuted(m); what = `setMuted ${m}`; }
      else if (r < 0.76) { const v = pick([0.5, 1, 1.5, 2]); P.setRate(v); what = `setRate ${v}`; }
      else if (r < 0.82) { P.home(); what = 'home'; }
      else if (r < 0.87) { P.end(); what = 'end'; }
      else { const ms = 50 + Math.floor(rnd() * 400); await P.clock.advance(ms); what = `advance ${ms}`; }
      log.push(what);
      const ctx = () => `after #${i} ${what} [seed ${SEED}; ${log.slice(-6).join(', ')}]`;
      await P.clock.advance(32);
      assert(!errors(P).length, `errors ${ctx()}: ${errors(P).join('; ')}`);
      assert(Number.isFinite(P.time()), `currentTime ${P.time()} ${ctx()}`);
      assert(P.frame() >= 0 && P.frame() < P.n, `frame ${P.frame()} outside 0..${P.n - 1} ${ctx()}`);
      if (i % 12 === 11) { // settled checkpoint: paused on a chosen frame shows ffmpeg's picture
        const k = Math.floor(rnd() * P.n);
        P.pause();
        P.seekFrame(k);
        try { await P.expectFrame(k, `checkpoint frame ${k}`); } catch (e) { throw new Error(`${e.message} ${ctx()}`); }
        log.push(`checkpoint ${k}`);
      }
    }
  } finally { P.close(); }
});

await c.done();
})();
