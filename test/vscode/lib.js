'use strict';
// Helpers for the cases in test/vscode/cases: a player handle that talks to the webview through the
// extension's test hook (VPE_LOG), result bookkeeping, and ffmpeg reference frames.
//
//   const lib = require('../lib');
//   const P = await lib.open(vs, h, lib.clip('s_h264.mp4'));     // opened in the real editor, first frame shown
//   await P.seek(1.5); const s = await P.state();                // the page's state (media/player.js debugProbe)
//   await P.expectFrame(45, 'seek');                             // the picture is frame 45 of the file (ffmpeg reference)
//
// Everything here only observes the page or sends the keys/mouse events a user would; the hook actions are
// in media/player.js (debug messages) and src/extension.js (the .cmd file).
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const media = require('../media/make_cases_media');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const kv = (line) => Object.fromEntries([...line.matchAll(/(\w+)=(\S+)/g)].map((m) => [m[1], m[2]]));

/** Results a scenario keeps (test/vscode/scenarios.js); the others are not run. */
let FILTER = null;
const setFilter = (fn) => { FILTER = fn; };
const SUB = (() => { const i = process.argv.indexOf('--sub'); return i >= 0 && process.argv[i + 1] ? new RegExp(process.argv[i + 1]) : null; })();

// ---- results ------------------------------------------------------------------------------

/**
 * Result bookkeeping: `t(name)` starts a result and returns `ok(cond, msg)`; `run(name, fn)` runs
 * `fn(ok, result)` and turns an exception into a problem (the other results go on).
 */
function recorder() {
  const out = [];
  const t = (name, extra) => {
    const r = { name, ok: true, problems: [], ...extra };
    out.push(r);
    const ok = (cond, msg) => { if (!cond) { r.ok = false; r.problems.push(msg); } return !!cond; };
    ok.r = r;
    return ok;
  };
  const run = async (name, fn) => {
    if (SUB && !SUB.test(name)) return null; // --sub <re>: only the results whose name matches
    if (FILTER && !FILTER(name)) return null; // moved to another layer
    const ok = t(name);
    try { await fn(ok, ok.r); } catch (e) { ok(false, e && e.message ? e.message : String(e)); }
    return ok.r;
  };
  const skip = (name, why) => out.push({ name, ok: true, skipped: why, problems: [] });
  return { out, t, run, skip };
}

// ---- media --------------------------------------------------------------------------------

/** Path of a clip from test/media/cases (made with ffmpeg when missing). Throws when it cannot be made. */
function clip(name) {
  const f = media.make(name);
  if (!f) throw new Error(`test clip ${name} could not be made (ffmpeg with the needed encoder?)`);
  return f;
}

// ---- reference frames (ffmpeg): test/lib/frames.js ---------------------------------------

const frames = require('../lib/frames');
const refFrames = (h, file) => frames.refFrames(file, h.ffmpeg);
const { refSlots, ncc } = frames;

// ---- the player handle --------------------------------------------------------------------

class Player {
  constructor(vs, h, file) {
    this.vs = vs;
    this.h = h;
    this.file = path.resolve(file);
    this.name = path.basename(file);
    this.tag = `\\[${esc(this.name)}\\] webview: `;
    this.seq = 0;
    this.fromMark = 0;
  }

  act(o) { this.vs.send({ name: this.name, ...o }); }

  /** Sends a probe action and waits for its reply line `<action> {json}` (matched by id). */
  async ask(action, extra = {}, timeout = 15000) {
    const id = ++this.seq;
    const from = this.vs.mark();
    this.act({ action, id, ...extra });
    const re = new RegExp(`${this.tag}${action} \\{"id":${id}[,}]`);
    const line = await this.vs.waitLog(re, { from, timeout, what: `${this.name}: ${action}` });
    const r = JSON.parse(line.slice(line.indexOf(`${action} {`) + action.length + 1));
    if (r.error) throw new Error(`${this.name}: ${action}: ${r.error}`);
    return r;
  }

  state() { return this.ask('state'); }

  /** The `report` line as numbers (frame is 1-based there; frame0 is 0-based). */
  async report() {
    const from = this.vs.mark();
    this.act({ action: 'report', delay: 0 });
    const line = await this.vs.waitLog(new RegExp(`${this.tag}report frame=`), { from, timeout: 15000, what: `${this.name}: report` });
    const r = {};
    for (const [k, v] of Object.entries(kv(line))) r[k] = v === 'true' ? true : v === 'false' ? false : v !== '-' && !Number.isNaN(Number(v)) ? Number(v) : v;
    r.frame0 = r.frame - 1;
    return r;
  }

  /** The picture as 64x36 luma plus the frame number the player says it shows (0-based). */
  async thumb() {
    const r = await this.ask('thumb');
    return { frame: r.frame, y: Buffer.from(r.y, 'base64') };
  }

  /** Polls state() until pred(state) is truthy; returns that state, or throws with the last one. */
  async waitState(pred, { timeout = 15000, what = 'condition', interval = 200, allowErrors = false } = {}) {
    const t0 = Date.now();
    const from = this.vs.mark();
    let s;
    for (;;) {
      s = await this.state();
      if (await pred(s)) return s;
      if (!allowErrors) { const e = pageError(this.vs, from, this.name); if (e) throw new Error(`${this.name}: page error while waiting for ${what}: ${e}`); }
      if (Date.now() - t0 > timeout) throw new Error(`${this.name}: timeout (${timeout / 1000} s) waiting for ${what}; last: ${JSON.stringify(brief(s))}`);
      await sleep(interval);
    }
  }

  /** The picture is on screen (engine's first frame, a frame player's canvas) or an error message is up. */
  /**
   * Waits for the first picture. An error message instead (the decoder could not start, a damaged file)
   * throws with that message unless allowError: the steps after it would only fail on missing numbers
   * ("player says -1", "reading 'toFixed'") and hide why.
   */
  async waitFirstFrame(timeout = 30000, { allowError = false } = {}) {
    const s = await this.waitState(pictureOrError, { timeout, what: 'first frame' });
    if (!allowError && !s.firstShown && ERR.test(s.message || '')) throw new Error(`${this.name}: no first frame; page says "${s.message}"${s.hint ? ` (${s.hint})` : ''}`);
    return s;
  }

  seek(t) { this.act({ action: 'seek', t }); }
  step(d) { this.act({ action: 'step', d }); }
  play() { this.act({ action: 'play' }); }
  pause() { this.act({ action: 'pause' }); }
  rate(r) { this.act({ action: 'rate', r }); }
  key(key, o = {}) { this.act({ action: 'key', key, shift: !!o.shift, ctrl: !!o.ctrl, target: o.target }); }
  goto(text) { this.act({ action: 'gotoText', text }); }
  dom(ev, x, y, o = {}) { this.act({ action: 'dom', ev, x, y, ...o }); }

  /**
   * Waits until the player reports frame k (0-based, a slot of the file) and the canvas shows frame k
   * of the file (normalised cross-correlation against ffmpeg's decode). Without ffmpeg only the counter counts.
   */
  async expectFrame(k, what, timeout = 12000) {
    const refs = this.h.ffmpeg ? await refFrames(this.h, this.file) : null;
    const t0 = Date.now();
    const from = this.vs.mark();
    let last = '';
    for (;;) {
      const pe = pageError(this.vs, from, this.name);
      if (pe) throw new Error(`${what}: expected frame ${k}; page error: ${pe}`);
      const th = await this.thumb();
      let slot = null; let score = 0;
      if (refs && refs.length) {
        const fps = (await this.cachedFps()) || 30;
        const slots = refSlots(refs, fps);
        const lo = Math.max(0, k - 15); const hi = Math.min(refs.length - 1, k + 15);
        let best = -1; let bs = -2;
        for (let i = lo; i <= hi; i++) { const s = ncc(th.y, refs[i]); if (s > bs) { bs = s; best = i; } }
        slot = best >= 0 ? slots[best] : null; score = bs;
      }
      if (th.frame === k && (!refs || slot === k)) return { frame: th.frame, slot, score };
      last = `player says ${th.frame}${refs ? `, picture matches ${slot} (ncc ${score.toFixed(4)})` : ''}`;
      if (Date.now() - t0 > timeout) break;
      await sleep(120);
    }
    // A decoder that never started (e.g. "WebGL2 is not available" when the GPU process failed) shows as
    // "player says -1" above: name the page's message too.
    let why = '';
    try { const s = await this.state(); if (s.message) why = `; page says "${s.message}"${s.hint ? ` (${s.hint})` : ''}`; } catch { /* no answer */ }
    throw new Error(`${what}: expected frame ${k}; ${last}${why}`);
  }

  async cachedFps() {
    if (this.fps) return this.fps;
    const s = await this.state();
    this.fps = s.fps || 0;
    return this.fps;
  }

  /** ffmpeg's slot numbers for the pictures (see refSlots), or null. */
  async slots() {
    const refs = this.h.ffmpeg ? await refFrames(this.h, this.file) : null;
    return refs ? refSlots(refs, (await this.cachedFps()) || 30) : null;
  }

  /** Samples `fn(state)` every `every` ms for `ms` ms (a state request takes ~0.3 s: the hook polls its file at that rate). */
  async sample(ms, fn = (s) => s.t, every = 0) {
    const t0 = Date.now();
    const out = [];
    while (Date.now() - t0 < ms) {
      const s = await this.state();
      out.push({ t: Date.now() - t0, v: fn(s), s });
      if (every) await sleep(every);
    }
    return out;
  }

  close() { return this.h.closeClip(this.vs); }
}

/**
 * A page error (uncaught error, unhandled rejection, no WebGL2) logged since line `from` by this file's page (or any
 * page without a name): waits end at once on one instead of running into their timeout (docs/TESTING.md rules).
 */
function pageError(vs, from, name) {
  vs.mark();
  const tag = name ? `[${name}] ` : '';
  const hit = vs.lines.slice(from).find((l) => (!tag || l.includes(tag)) && /webview: (error:|unhandled rejection)|WebGL2 is not available/.test(l));
  return hit ? hit.replace(/^.*?webview: /, '').slice(0, 300) : null;
}

const brief = (s) => { const o = {}; for (const k of ['message', 'hint', 'frame', 't', 'playing', 'firstShown', 'vmode', 'amode', 'toast', 'status', 'notice', 'eof', 'stageClass', 'video', 'canvas']) if (s && s[k] !== undefined && s[k] !== '') o[k] = s[k]; return o; };

const ERR = /could not|failed|damaged|incomplete|not include|cannot|unsupported/i;
/** The picture is on screen (engine's first frame, a frame player's canvas) or an error message is up. */
const pictureOrError = (s) => s.firstShown || (!s.engine && s.canvas[0] > 0 && !/^Opening|^Loading/.test(s.message)) || ERR.test(s.message);

/**
 * Opens a file in the editor (as `code <file>`) and waits until `until(state)` (default: the picture or an
 * error message is up; `until: null` does not wait). Returns a Player; P.first is that state.
 */
async function open(vs, h, file, { until = pictureOrError, timeout = 40000 } = {}) {
  const P = new Player(vs, h, file);
  P.fromMark = await h.openClip(vs, P.file);
  if (until) {
    // The page answers `state` once its script runs; until then nothing comes back, so just poll.
    const t0 = Date.now();
    for (;;) {
      let s = null;
      try { s = await P.ask('state', {}, 4000); } catch { /* not up yet */ }
      if (s && until(s)) { P.first = s; break; }
      if (Date.now() - t0 > timeout) throw new Error(`${P.name}: nothing to wait for within ${timeout / 1000} s${s ? ` (${JSON.stringify(brief(s))})` : ''}`);
      await sleep(300);
    }
  }
  return P;
}

/** The log lines of this instance from `from` on that match re. */
const lines = (vs, re, from = 0) => { vs.mark(); return vs.lines.slice(from).filter((l) => re.test(l)); };

module.exports = { setFilter, pageError, frames, pictureOrError, ERR, sleep, esc, kv, recorder, clip, media, refFrames, refSlots, ncc, Player, open, lines, brief };
