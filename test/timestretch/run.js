/*
 * Node tests for media/timestretch.js (no browser):  node test/timestretch/run.js [wavDir]
 * Checks length, pitch, chunk-boundary continuity, rate-1 pass-through, shared channel
 * alignment, odd sample rates / channel counts, and speed. Writes a few WAVs to wavDir
 * (default: $TS_WAV_DIR or skip) for listening. Exit code 1 on any failure.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const TimeStretch = require('../../media/timestretch.js');

const RATES = [0.25, 0.5, 0.75, 1.25, 1.5, 2, 4];
const wavDir = process.argv[2] || process.env.TS_WAV_DIR || null;
let failures = 0;
const check = (ok, msg) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) failures++; };

// ---- signals ---------------------------------------------------------------------

function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

function sine(sr, secs, f, amp = 0.5) {
  const n = Math.round(sr * secs), x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = amp * Math.sin((2 * Math.PI * f * i) / sr);
  return x;
}

function sweep(sr, secs, f0, f1, amp = 0.5) {
  const n = Math.round(sr * secs), x = new Float32Array(n), k = Math.log(f1 / f0);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    x[i] = amp * Math.sin(((2 * Math.PI * f0 * secs) / k) * (Math.exp((k * t) / secs) - 1));
  }
  return x;
}

/** Speech-like: glottal pulses (F0 gliding 100..180 Hz) through 3 formant resonators,
 *  4 Hz syllable envelope, short noise "consonants" between syllables. */
function speech(sr, secs, seed = 1, f0Fixed = 0) { // f0Fixed: sustained vowel at that F0
  const n = Math.round(sr * secs), x = new Float32Array(n), r = rng(seed);
  const formants = [[700, 110], [1220, 120], [2600, 160]];
  const res = formants.map(([f, bw]) => {
    const R = Math.exp((-Math.PI * bw) / sr), th = (2 * Math.PI * f) / sr;
    return { a1: 2 * R * Math.cos(th), a2: -R * R, g: 1 - R, y1: 0, y2: 0 };
  });
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const f0 = f0Fixed || 140 + 40 * Math.sin(2 * Math.PI * 0.7 * t);
    phase += f0 / sr;
    let src = 0;
    if (phase >= 1) { phase -= 1; src = 1; }
    const syl = f0Fixed ? 1 : Math.max(0, Math.sin(2 * Math.PI * 4 * t));
    let v = 0;
    for (const q of res) { const y = q.g * src * 8 + q.a1 * q.y1 + q.a2 * q.y2; q.y2 = q.y1; q.y1 = y; v += y; }
    const cons = syl < 0.05 ? (r() * 2 - 1) * 0.08 : 0;
    x[i] = 0.25 * v * Math.pow(syl, 0.5) + cons;
  }
  let peak = 0;
  for (const v of x) peak = Math.max(peak, Math.abs(v));
  for (let i = 0; i < n; i++) x[i] *= 0.7 / peak;
  return x;
}

// ---- helpers -----------------------------------------------------------------------

/** Push planes in chunks (sizes from `sizes()`), flush, concatenate. */
function stretch(planes, sr, rate, sizes = () => 1024) {
  const ts = new TimeStretch({ channels: planes.length, sampleRate: sr });
  ts.setRate(rate);
  const outs = [];
  let firstTime = null;
  for (let i = 0; i < planes[0].length;) {
    const n = Math.min(sizes(), planes[0].length - i);
    const o = ts.push(planes.map((p) => p.subarray(i, i + n)), 10 + i / sr);
    if (o.time !== null && firstTime === null) firstTime = o.time;
    outs.push(o.planes);
    i += n;
  }
  outs.push(ts.flush().planes);
  const len = outs.reduce((s, o) => s + o[0].length, 0);
  const res = planes.map(() => new Float32Array(len));
  let off = 0;
  for (const o of outs) { o.forEach((p, c) => res[c].set(p, off)); off += o[0].length; }
  return { planes: res, firstTime, ts };
}

/** Frequency of the strongest spectral peak in [lo, hi] Hz (Goertzel scan, 0.5 Hz steps). */
function peakFreq(x, sr, lo, hi) {
  let best = 0, bestP = -1;
  const n = x.length;
  for (let f = lo; f <= hi; f += 0.5) {
    const w = (2 * Math.PI * f) / sr, cw = 2 * Math.cos(w);
    let s1 = 0, s2 = 0;
    for (let i = 0; i < n; i++) {
      const win = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
      const s0 = x[i] * win + cw * s1 - s2; s2 = s1; s1 = s0;
    }
    const p = s1 * s1 + s2 * s2 - cw * s1 * s2;
    if (p > bestP) { bestP = p; best = f; }
  }
  return best;
}

/** Fundamental by autocorrelation (lag range for 60..400 Hz). */
function autocorrF0(x, sr) {
  let best = 0, bestLag = 0;
  for (let lag = Math.floor(sr / 400); lag <= Math.ceil(sr / 60); lag++) {
    let s = 0, e = 0;
    for (let i = 0; i + lag < x.length; i++) { s += x[i] * x[i + lag]; e += x[i + lag] * x[i + lag]; }
    const v = s / Math.sqrt(e + 1e-12);
    if (v > best) { best = v; bestLag = lag; }
  }
  return sr / bestLag;
}

function maxDelta(x, from = 0, to = x.length) {
  let m = 0;
  for (let i = from + 1; i < to; i++) m = Math.max(m, Math.abs(x[i] - x[i - 1]));
  return m;
}

function writeWav(file, planes, sr) {
  const C = planes.length, n = planes[0].length, b = Buffer.alloc(44 + n * C * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * C * 2, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(C, 22);
  b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr * C * 2, 28); b.writeUInt16LE(C * 2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(n * C * 2, 40);
  let o = 44;
  for (let i = 0; i < n; i++) for (let c = 0; c < C; c++) {
    b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(planes[c][i] * 32767))), o); o += 2;
  }
  fs.writeFileSync(file, b);
}

// ---- tests -------------------------------------------------------------------------

const SR = 48000;

console.log('# length, pitch, continuity (48 kHz)');
{
  const tone = sine(SR, 4, 440);
  const sw = sweep(SR, 4, 100, 4000);
  const sp = speech(SR, 4, 7);
  const spFixed = speech(SR, 3, 3, 150);
  const r = rng(42);
  const randomChunks = () => 64 + Math.floor(r() * 4000);
  const toneDelta = maxDelta(tone);
  for (const rate of RATES) {
    for (const [name, sig] of [['sine440', tone], ['sweep', sw], ['speech', sp]]) {
      const { planes } = stretch([sig], SR, rate, randomChunks);
      const want = sig.length / rate, got = planes[0].length;
      check(Math.abs(got - want) / want < 0.01, `${name} @${rate}: length ${got} vs ${Math.round(want)} (${(((got - want) / want) * 100).toFixed(3)} %)`);
      if (name === 'sine440') {
        const mid = planes[0].subarray(Math.floor(got * 0.25), Math.floor(got * 0.25) + SR);
        const f = peakFreq(mid, SR, 400, 480);
        check(Math.abs(f - 440) <= 2, `sine440 @${rate}: peak ${f} Hz`);
        const d = maxDelta(planes[0], 0, got);
        check(d <= toneDelta * 1.25, `sine440 @${rate}: max sample delta ${d.toFixed(4)} (input ${toneDelta.toFixed(4)})`);
      }
      if (name === 'sweep') {
        // The input stops abruptly at the end (jump to silence): skip the output that
        // maps to its last 20 ms.
        const d = maxDelta(planes[0], 0, got - Math.round((SR * 0.02) / rate));
        check(d <= maxDelta(sig) * 1.25, `sweep @${rate}: max sample delta ${d.toFixed(4)} (input ${maxDelta(sig).toFixed(4)})`);
      }
    }
    const { planes } = stretch([spFixed], SR, rate);
    const seg = planes[0].subarray(Math.floor(planes[0].length * 0.3), Math.floor(planes[0].length * 0.3) + 4096);
    const f0 = autocorrF0(seg, SR);
    check(Math.abs(f0 - 150) / 150 < 0.03, `speech F0 150 @${rate}: ${f0.toFixed(1)} Hz`);
  }
}

console.log('# chunking does not matter (bit-identical output)');
{
  const sp = speech(SR, 3, 11);
  for (const rate of [0.5, 1.5, 4]) {
    const a = stretch([sp], SR, rate, () => 1 << 20).planes[0];
    const r = rng(rate * 100);
    const b = stretch([sp], SR, rate, () => 1 + Math.floor(r() * 3000)).planes[0];
    let d = a.length === b.length ? 0 : Infinity;
    for (let i = 0; i < a.length && d !== Infinity; i++) d = Math.max(d, Math.abs(a[i] - b[i]));
    check(d < 1e-6, `rate ${rate}: one-shot vs random chunks max diff ${d}`);
  }
}

console.log('# rate 1 passes through');
{
  const sp = speech(SR, 2, 5);
  const { planes, firstTime } = stretch([sp, sp.map((v) => -v)], SR, 1, () => 777);
  let d = planes[0].length === sp.length ? 0 : Infinity;
  for (let i = 0; i < sp.length && d !== Infinity; i++) d = Math.max(d, Math.abs(planes[0][i] - sp[i]), Math.abs(planes[1][i] + sp[i]));
  check(d < 1e-6, `rate 1: length ${planes[0].length}/${sp.length}, max diff ${d}`);
  check(Math.abs(firstTime - 10) < 1e-9, `rate 1: first output time ${firstTime} (input started at 10)`);
}

console.log('# time mapping');
{
  // Output time of each push = media time of its first sample; check against a click track.
  const n = SR * 4, x = new Float32Array(n);
  for (let k = 1; k < 8; k++) x[k * SR / 2] = 1; // impulses every 0.5 s
  // WSOLA copies frames 1:1, so inside a frame time runs at 1x: the inherent error is
  // up to the seek window D plus Hs/2 * |rate - 1| (the stronger copy of an impulse).
  for (const rate of [0.25, 0.5, 2, 4]) {
    const ts = new TimeStretch({ channels: 1, sampleRate: SR });
    const bound = (ts.seek + (ts.hop / 2) * Math.abs(rate - 1)) / SR + 0.001;
    ts.setRate(rate);
    const map = []; // [outIndex, mediaTime]
    let outN = 0;
    const out = [];
    for (let i = 0; i < n; i += 2048) {
      const o = ts.push([x.subarray(i, i + 2048)], 3 + i / SR);
      if (o.time !== null && o.planes[0].length) { map.push([outN, o.time]); out.push(o.planes[0]); outN += o.planes[0].length; }
    }
    const y = new Float32Array(outN); let off = 0; for (const p of out) { y.set(p, off); off += p.length; }
    // Media time of output sample i from the mapping, compared with where the impulses land.
    const timeOf = (i) => { let m = map[0]; for (const e of map) if (e[0] <= i) m = e; return m[1] + ((i - m[0]) * rate) / SR; };
    let worst = 0;
    for (let k = 1; k < 7; k++) {
      const expect = 3 + k * 0.5;
      // Strongest output sample near the expected position.
      let bi = -1, bv = 0;
      for (let i = 0; i < y.length; i++) if (Math.abs(timeOf(i) - expect) < 0.05 && Math.abs(y[i]) > bv) { bv = Math.abs(y[i]); bi = i; }
      // At 4x frames read only half the input, so some clicks are dropped (by design).
      if (bi >= 0 && bv > 0.3) worst = Math.max(worst, Math.abs(timeOf(bi) - expect));
    }
    check(worst <= bound, `rate ${rate}: impulse media-time error ${(worst * 1000).toFixed(2)} ms (bound ${(bound * 1000).toFixed(1)} ms)`);
  }
}

console.log('# channels share alignment, odd rates / layouts');
{
  const sp = speech(SR, 2, 9);
  const { planes } = stretch([sp, sp], SR, 0.75, () => 1500);
  let d = 0;
  for (let i = 0; i < planes[0].length; i++) d = Math.max(d, Math.abs(planes[0][i] - planes[1][i]));
  check(d === 0, `stereo L==R stays L==R at 0.75 (max diff ${d})`);
  for (const [sr, ch] of [[8000, 1], [22050, 2], [44100, 6], [96000, 8]]) {
    const sig = speech(sr, 2, 4);
    const pl = [];
    for (let c = 0; c < ch; c++) pl.push(sig.map((v) => v * (1 - c * 0.1)));
    for (const rate of [0.5, 2]) {
      const out = stretch(pl, sr, rate, () => 997).planes;
      const want = sig.length / rate;
      check(out.length === ch && Math.abs(out[0].length - want) / want < 0.01, `${sr} Hz x${ch} @${rate}: length ${out[0].length} vs ${Math.round(want)}`);
    }
  }
}

console.log('# speed (48 kHz stereo, 1024-sample chunks)');
{
  const secs = 30;
  const l = speech(SR, secs, 21), r = sweep(SR, secs, 80, 8000, 0.3);
  for (let i = 0; i < l.length; i++) r[i] += 0.5 * l[i];
  for (const rate of [0.25, 0.5, 1, 1.5, 2, 4]) {
    stretch([l.subarray(0, SR), r.subarray(0, SR)], SR, rate); // warm up
    const t0 = process.hrtime.bigint();
    stretch([l, r], SR, rate);
    const wall = Number(process.hrtime.bigint() - t0) / 1e9;
    const x = secs / wall;
    console.log(`     rate ${rate}: ${x.toFixed(0)}x real time (input seconds per wall second)`);
    // Timing depends on machine load: report, warn below the 50x target, don't fail.
    if (x < 50) console.log(`warn rate ${rate}: below the 50x target (machine busy?)`);
  }
}

if (wavDir) {
  fs.mkdirSync(wavDir, { recursive: true });
  const sp = speech(SR, 4, 7), sw = sweep(SR, 4, 100, 4000);
  writeWav(path.join(wavDir, 'speech_orig.wav'), [sp], SR);
  for (const rate of [0.25, 0.5, 2, 4]) writeWav(path.join(wavDir, `speech_x${rate}.wav`), stretch([sp], SR, rate, () => 1024).planes, SR);
  writeWav(path.join(wavDir, 'sweep_orig.wav'), [sw], SR);
  for (const rate of [0.5, 2]) writeWav(path.join(wavDir, `sweep_x${rate}.wav`), stretch([sw], SR, rate, () => 1024).planes, SR);
  console.log(`wrote WAVs to ${wavDir}`);
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
