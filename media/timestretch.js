/*
 * timestretch.js: pitch-preserving audio time stretch (WSOLA), streaming, pure JS.
 *
 * Plays audio slower or faster without changing its pitch (like YouTube at 0.25x-4x).
 * Works on Float32 planar PCM, any sample rate, 1..8 channels. All channels share one
 * alignment search (on a mono downmix), so stereo images do not drift apart.
 *
 * Usable as a classic <script> (sets globalThis.TimeStretch) and with require() in Node.
 *
 * ---------------------------------------------------------------------------------
 * Algorithm (WSOLA, waveform-similarity overlap-add)
 *   - Frames of N = 2*Hs samples (Hs ~ 16 ms) under a periodic Hann window are
 *     overlap-added every Hs output samples (50 % overlap, windows sum to exactly 1).
 *   - Frame k nominally reads input at P_k, with P_{k+1} = P_k + rate*Hs.
 *   - The actual read position is searched within P_k +- D (D ~ 7.5 ms) to best match
 *     (normalised cross-correlation) the natural continuation of the previous frame,
 *     so overlapping waveforms line up and pitch is kept. Search is coarse (box-filtered
 *     copy decimated to ~6 kHz, every `step`-th lag, sliding energy) then fine
 *     (+-(step-1) lags at full rate).
 *   - At rate exactly 1 the search is skipped and the natural continuation is used:
 *     the output equals the input bit for bit (apart from float rounding).
 *   - The input is processed as one continuous stream; chunk boundaries do not exist
 *     for the algorithm, so splitting the input differently gives identical output.
 *
 * API
 *   const ts = new TimeStretch({ channels, sampleRate });   // optional: frameMs, seekMs
 *   ts.setRate(r);                 // 0.1..8; takes effect from the next frame (~16 ms)
 *   const out = ts.push(planes, t) // planes: Float32Array[] (one per channel), t: media
 *                                  // time (s) of planes[*][0]. Only the first t after
 *                                  // construction/reset is used (the stream is assumed
 *                                  // contiguous; call reset() on seek or gaps).
 *   // out = { planes: Float32Array[], time: number|null }
 *   //   time = media time of out.planes[*][0] (null when nothing was produced).
 *   //   Output sample i maps to media time  time + i * rate / sampleRate
 *   //   (for the rate in force; frames are at most +-D = 7.5 ms off this mapping).
 *   const tail = ts.flush();       // end of stream: returns the remaining output
 *   ts.reset();                    // drop all state (seek, rate change if you want a clean cut)
 *   ts.latencySeconds              // input that must be buffered beyond the last output
 *                                  // sample's media time (~40 ms at 1x, 48 kHz)
 *   ts.inputTime / ts.outputTime   // media time just after the last input sample pushed /
 *                                  // of the next output sample to be produced
 *
 * ---------------------------------------------------------------------------------
 * Integration into media/engine.js (the main developer does this; sketch):
 *
 * 1. Load the script before engine.js in the webview HTML: <script src=".../timestretch.js">.
 *
 * 2. Clock: audio is the master at any rate it can stretch.
 *      audioMaster() { return !!(this.ac && this.ac.state === 'running' && this.amode !== 'none'
 *                      && (this.rate === 1 || (this.rate >= 0.25 && this.rate <= 4 && globalThis.TimeStretch))); }
 *      now(): if (this.audioMaster()) return this.anchorMedia + (this.ac.currentTime - this.anchorAc) * this.rate;
 *    setRate(): drop the 'Sound plays at 1x only' toast (keep it for rates outside 0.25..4).
 *
 * 3. Keep addAudio() as is (this.audio holds input chunks {t, dur, buf}; buf.getChannelData(c)
 *    gives the planes back). At rate 1 keep the existing scheduleAudio() path.
 *
 * 4. At rate !== 1, scheduleAudio(now) feeds input chunks through one TimeStretch and
 *    schedules its output back to back:
 *
 *      scheduleStretched(now) {
 *        const ac = this.ac, r = this.rate;
 *        for (;;) {
 *          // Enough output scheduled (0.5 s of wall time ahead)? Stop.
 *          if (this.ts && this.tsWhen !== null && this.tsWhen > ac.currentTime + 0.5) break;
 *          // Next input chunk not fed yet (this.tsCursor = media time fed up to).
 *          const a = this.audio.find((x) => x.t + x.dur > this.tsCursor + 1e-6);
 *          if (!a) break;                                   // wait for decoding
 *          const sr = a.buf.sampleRate, ch = a.buf.numberOfChannels;
 *          if (!this.ts || this.ts.sampleRate !== sr || this.ts.channels !== ch) {
 *            this.ts = new TimeStretch({ channels: ch, sampleRate: sr }); this.tsWhen = null;
 *          }
 *          this.ts.setRate(r);
 *          // First chunk after a reset: start at the playhead, not the chunk start.
 *          const skip = Math.max(0, Math.round((this.tsCursor - a.t) * sr));
 *          const planes = [];
 *          for (let c = 0; c < ch; c++) planes.push(a.buf.getChannelData(c).subarray(skip));
 *          const out = this.ts.push(planes, a.t + skip / sr);
 *          this.tsCursor = a.t + a.dur;
 *          if (!out.planes[0].length) continue;
 *          const n = out.planes[0].length;
 *          const buf = ac.createBuffer(ch, n, sr);
 *          out.planes.forEach((p, c) => buf.copyToChannel(p, c));
 *          // First output: place it by the media clock; afterwards strictly back to back
 *          // (no gaps or overlaps, so no clicks; the clock follows the audio anyway).
 *          let when = this.tsWhen !== null ? this.tsWhen : this.anchorAc + (out.time - this.anchorMedia) / r;
 *          const src = ac.createBufferSource();
 *          src.buffer = buf; src.connect(this.gain);
 *          if (when < ac.currentTime) src.start(ac.currentTime, Math.min(buf.duration, ac.currentTime - when));
 *          else src.start(when);
 *          src.onended = () => this.sources.delete(src);
 *          this.sources.add(src);
 *          this.tsWhen = when + n / sr;
 *        }
 *      }
 *      In scheduleAudio(now): if (this.rate !== 1) return this.scheduleStretched(now);
 *
 * 5. Reset points: in stopAudio() (called by pause, seek, skipTo, setRate, slow-decode
 *    re-anchor) add:  if (this.ts) this.ts.reset(); this.tsWhen = null; this.tsCursor = this.now();
 *    (for pause() set tsCursor after pauseT is known, i.e. tsCursor = pauseT; for seeks use t).
 *    Simplest: set this.tsCursor = this.anchorMedia inside anchor() and reset there too,
 *    since every stopAudio() is followed by an anchor().
 *
 * 6. The trimming loop `while (this.audio[0].t + dur < now - 0.5 && !src) shift()` keeps
 *    working because stretched input chunks are only read, never given a .src. Make the
 *    read-ahead in pump() rate aware so 4x does not starve: needA = aEnd - now < 1.5 * Math.max(1, this.rate).
 *
 * Cost (Node, 48 kHz stereo, input seconds per wall second): ~78x at 0.25x (worst case,
 * ~13 ms of work per media second = ~3 ms per wall second of playback), ~160x at 0.5x,
 * ~400x at 1.5x, 500x+ at 2x and 4x, ~900x at 1x. Tests: node test/timestretch/run.js [wavDir].
 */
(function (root) {
  'use strict';

  class TimeStretch {
    constructor({ channels = 2, sampleRate = 48000, frameMs = 32, seekMs = 7.5 } = {}) {
      if (!(channels >= 1 && channels <= 32)) throw new Error('TimeStretch: channels must be 1..32');
      this.channels = channels | 0;
      this.sampleRate = sampleRate;
      // Coarse search works on a box-filtered copy decimated to ~6 kHz: step 8 at 48 kHz,
      // 7 at 44.1 kHz, 1 at 8 kHz.
      const step = Math.max(1, Math.round(sampleRate / 6000));
      this.step = step;
      this.hop = Math.max(8 * step, Math.round((sampleRate * frameMs) / 2000 / step) * step); // Hs
      this.frame = 2 * this.hop; // N
      this.seek = Math.max(step, Math.round((sampleRate * seekMs) / 1000 / step) * step); // D
      const N = this.frame;
      this.win = new Float32Array(N);
      for (let i = 0; i < N; i++) this.win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
      this.rate = 1;
      // Scratch for the coarse search (decimated natural continuation and candidates).
      const Ld = Math.floor(this.hop / step);
      this.natDec = new Float32Array(Ld);
      this.candDec = new Float32Array(Ld + Math.floor((2 * this.seek) / step) + 2);
      this.acc = [];
      for (let c = 0; c < this.channels; c++) this.acc.push(new Float32Array(N));
      this.reset();
    }

    /** Drop all buffered audio and start a new stream (next push() sets the time base). */
    reset() {
      const pad = this.hop + this.seek; // virtual zeros before input sample 0
      const cap = Math.max(1 << 14, 4 * (this.frame + 2 * this.seek));
      this.buf = [];
      for (let c = 0; c < this.channels; c++) this.buf.push(new Float32Array(cap));
      this.mono = new Float32Array(cap);
      this.bufStart = -pad; // absolute input index of buf[*][0]
      this.bufLen = pad; // zeros
      this.totalIn = 0; // real input samples pushed
      for (const a of this.acc) a.fill(0);
      this.k = 0; // frames processed
      this.P = -this.hop; // nominal start of the next frame (float, absolute input index)
      this.prevP = 0; // nominal start of the previous frame
      this.A = 0; // actual start of the previous frame
      this.t0 = null; // media time of absolute input index 0
      this.outCount = 0;
      this.nextOutIn = 0; // input index (float) the next output sample maps to
    }

    setRate(r) {
      r = +r;
      if (!(r > 0)) return;
      this.rate = Math.min(8, Math.max(0.1, r));
    }

    get latencySeconds() {
      return (this.hop + this.seek + this.rate * this.hop) / this.sampleRate;
    }

    get inputTime() {
      return (this.t0 || 0) + this.totalIn / this.sampleRate;
    }

    get outputTime() {
      return (this.t0 || 0) + this.nextOutIn / this.sampleRate;
    }

    /** Append input and return all output that is complete. */
    push(planes, t) {
      if (this.t0 === null) this.t0 = typeof t === 'number' && isFinite(t) ? t : 0;
      const n = planes && planes.length ? planes[0].length : 0;
      if (n) this._append(planes, n);
      return this._run(false);
    }

    /** End of stream: process what is left (zero padded) and return the rest of the output. */
    flush() {
      if (this.t0 === null) return { planes: this._empty(), time: null };
      return this._run(true);
    }

    // ---- internals -------------------------------------------------------------

    _empty() {
      const e = [];
      for (let c = 0; c < this.channels; c++) e.push(new Float32Array(0));
      return e;
    }

    _ensure(extra) {
      const need = this.bufLen + extra;
      if (need <= this.mono.length) return;
      let cap = this.mono.length;
      while (cap < need) cap *= 2;
      const grow = (a) => { const b = new Float32Array(cap); b.set(a.subarray(0, this.bufLen)); return b; };
      this.buf = this.buf.map(grow);
      this.mono = grow(this.mono);
    }

    _append(planes, n) {
      // Drop what no future frame can read: below min(natural continuation, P - D).
      const keepFrom = Math.min(this.k === 0 ? this.bufStart : this.A + this.hop, Math.round(this.P) - this.seek);
      const drop = Math.min(this.bufLen, Math.max(0, keepFrom - this.bufStart));
      if (drop > 0 && drop > this.mono.length / 4) {
        for (const b of this.buf) b.copyWithin(0, drop, this.bufLen);
        this.mono.copyWithin(0, drop, this.bufLen);
        this.bufStart += drop;
        this.bufLen -= drop;
      }
      this._ensure(n);
      const C = this.channels, o = this.bufLen, m = this.mono;
      const pc = Math.min(C, planes.length);
      for (let c = 0; c < C; c++) {
        const src = planes[c < pc ? c : pc - 1]; // missing channels: repeat the last one
        this.buf[c].set(src.length === n ? src : src.subarray(0, n), o);
      }
      const inv = 1 / C;
      m.fill(0, o, o + n);
      for (let c = 0; c < C; c++) {
        const b = this.buf[c];
        for (let i = 0; i < n; i++) m[o + i] += b[o + i];
      }
      if (C > 1) for (let i = 0; i < n; i++) m[o + i] *= inv;
      this.bufLen += n;
      this.totalIn += n;
    }

    _appendZeros(n) {
      this._ensure(n);
      const o = this.bufLen;
      for (const b of this.buf) b.fill(0, o, o + n);
      this.mono.fill(0, o, o + n);
      this.bufLen += n;
    }

    /** Frames that can run with the input buffered now. */
    _countFrames() {
      const end = this.bufStart + this.bufLen;
      const N = this.frame, D = this.seek, hop = this.hop;
      let P = this.P, k = this.k, count = 0;
      for (;;) {
        // Frame k reads [A, A + N) with A within Pk +- D (the natural continuation of
        // the previous frame lies inside the buffer already).
        const Pk = Math.round(P);
        if ((k === 0 ? Pk + N : Pk + D + N) > end) break;
        count++;
        P += this.rate * hop;
        k++;
      }
      return count;
    }

    _run(final) {
      const hop = this.hop, C = this.channels;
      const endIn = this.totalIn; // absolute index just past the real input
      if (final) {
        // Enough zeros to finish every block that maps before endIn.
        const blocks = Math.ceil(Math.max(0, endIn - this.nextOutIn) / (this.rate * hop)) + 2;
        this._appendZeros(Math.ceil(blocks * this.rate * hop) + this.frame + 2 * this.seek + hop);
      }
      let frames = this._countFrames();
      if (final) {
        // Only the frames whose emitted block starts before the end of the input.
        let P = this.P, prevP = this.prevP, k = this.k, f = 0;
        while (f < frames) {
          if (k >= 1 && prevP + hop >= endIn) break;
          prevP = P; P += this.rate * hop; k++; f++;
        }
        frames = f;
      }
      const emitting = Math.max(0, frames - (this.k === 0 ? 1 : 0));
      const out = [];
      for (let c = 0; c < C; c++) out.push(new Float32Array(emitting * hop));
      let o = 0, time = null;
      for (let f = 0; f < frames; f++) {
        const blockIn = this._frame();
        if (blockIn === null) continue;
        if (time === null) time = this.t0 + blockIn / this.sampleRate;
        for (let c = 0; c < C; c++) {
          const a = this.acc[c];
          out[c].set(a.subarray(0, hop), o);
        }
        o += hop;
        this._shiftAcc();
      }
      if (this.k >= 1) this.nextOutIn = this.prevP + hop;
      let planes = out;
      if (final && time !== null) {
        // Trim the tail to the output that maps before endIn.
        const startIn = (time - this.t0) * this.sampleRate;
        const keep = Math.max(0, Math.min(o, Math.ceil((endIn - startIn) / this.rate - 1e-9)));
        planes = out.map((p) => p.subarray(0, keep));
        this.nextOutIn = endIn;
      }
      this.outCount += planes[0].length;
      return { planes, time };
    }

    _shiftAcc() {
      const hop = this.hop;
      for (const a of this.acc) { a.copyWithin(0, hop); a.fill(0, hop); }
    }

    /** Process one frame. Returns the input index the emitted block maps to, or null. */
    _frame() {
      const hop = this.hop, N = this.frame, C = this.channels, w = this.win;
      const Pk = Math.round(this.P);
      let A;
      if (this.k === 0) A = Pk;
      else {
        const natural = this.A + hop;
        if (this.rate === 1 && Math.abs(natural - Pk) <= this.seek) A = natural;
        else A = this._search(natural, Pk);
      }
      const off = A - this.bufStart;
      for (let c = 0; c < C; c++) {
        const a = this.acc[c], b = this.buf[c];
        for (let i = 0; i < N; i++) a[i] += b[off + i] * w[i];
      }
      const blockIn = this.k >= 1 ? this.prevP + hop : null;
      if (this.k === 0) this._shiftAcc(); // first half maps before input 0: discard
      this.A = A;
      this.prevP = this.P;
      this.P += this.rate * hop;
      this.k++;
      return blockIn;
    }

    /** Best start in [Pk - D, Pk + D] matching the natural continuation (normalised xcorr).
     *  Coarse: lags on a grid of `step` through Pk, correlating box-filtered, decimated
     *  copies (contiguous, sliding energy). Fine: +-(step-1) lags at full resolution.
     *  Ties keep the lag nearest Pk, which keeps the time mapping tight. */
    _search(natural, Pk) {
      const m = this.mono, base = this.bufStart, L = this.hop, s = this.step, D = this.seek;
      const lo = Math.max(Pk - D, base), hi = Pk + D;
      const nat = natural - base;
      const g0 = Pk - Math.floor((Pk - lo) / s) * s; // first grid lag (Pk is on the grid)
      const J = Math.floor((hi - g0) / s) + 1; // grid lags
      const jP = (Pk - g0) / s;
      const Ld = Math.floor(L / s);
      const nd = this.natDec, cd = this.candDec;
      for (let i = 0, o = nat; i < Ld; i++, o += s) {
        let v = 0;
        for (let q = 0; q < s; q++) v += m[o + q];
        nd[i] = v;
      }
      const cl = J - 1 + Ld;
      for (let i = 0, o = g0 - base; i < cl; i++, o += s) {
        let v = 0;
        for (let q = 0; q < s; q++) v += m[o + q];
        cd[i] = v;
      }
      let yy = 0;
      for (let i = 0; i < Ld; i++) yy += cd[i] * cd[i];
      let best = jP, bestScore = -Infinity, bestDist = Infinity;
      for (let j = 0; j < J; j++) {
        if (j > 0) { const a = cd[j - 1], b = cd[j + Ld - 1]; yy += b * b - a * a; }
        let xy = 0;
        for (let i = 0; i < Ld; i++) xy += nd[i] * cd[j + i];
        const sc = xy / Math.sqrt(Math.max(yy, 1e-12));
        const dist = Math.abs(j - jP);
        if (sc > bestScore || (sc === bestScore && dist < bestDist)) { bestScore = sc; best = j; bestDist = dist; }
      }
      const c0 = g0 + best * s;
      if (s === 1) return c0;
      const f0 = Math.max(lo, c0 - s + 1), f1 = Math.min(hi, c0 + s - 1);
      let e = 0;
      for (let i = 0, o = f0 - base; i < L; i++) e += m[o + i] * m[o + i];
      let fBest = c0, fScore = -Infinity, fDist = Infinity;
      for (let c = f0; c <= f1; c++) {
        const co = c - base;
        if (c > f0) { const a = m[co - 1], b = m[co + L - 1]; e += b * b - a * a; }
        let xy = 0;
        for (let i = 0; i < L; i++) xy += m[nat + i] * m[co + i];
        const sc = xy / Math.sqrt(Math.max(e, 1e-12));
        const dist = Math.abs(c - Pk);
        if (sc > fScore || (sc === fScore && dist < fDist)) { fScore = sc; fBest = c; fDist = dist; }
      }
      return fBest;
    }
  }

  root.TimeStretch = TimeStretch;
  if (typeof module !== 'undefined' && module.exports) module.exports = TimeStretch;
})(typeof globalThis !== 'undefined' ? globalThis : this);
