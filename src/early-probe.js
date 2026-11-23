'use strict';
// The speculative start of a session's first page (ADR 0001): while the webview loads, the host already looks up
// ffmpeg, runs ffprobe and, when the decision is native ffmpeg, starts that process (a header sniff guesses the codec
// first, ffprobe confirms or replaces it). open() then claims what was prepared. Every process, file read and timer
// is injected, so a Node test drives the race with fakes (test/host/early_probe_test.js); src/extension.js wires it.
const { sameFile } = require('./framelink');

// checkJs: start
/** How long an ffmpeg started before the page waits for it. */
const EARLY_NATIVE_MS = 15000;

/**
 * @typedef {any} NativeDecoderLike a NativeDecoder (src/native.js): pr, method, decided, guessed, failed, disposed, dispose()
 * @typedef {{ native: boolean, allowed: boolean, method?: string, key?: string, make?: () => NativeDecoderLike }} NativePlan
 *   what Session.decideNative chose for a probe; nothing starts unless native and allowed (settings, trust, live transcode)
 * @typedef {{
 *   name: string,
 *   log: (msg: string) => void,
 *   verbose: boolean,
 *   stat: (file: string) => Promise<any>,
 *   isAvi: (file: string) => boolean,
 *   scanAvi: (signal: AbortSignal) => Promise<any>,
 *   tools: () => Promise<any>,
 *   gpus: (t: any) => Promise<any>,
 *   failedBefore: (stat: any) => boolean,
 *   eligible: () => boolean,
 *   sniff: (file: string, stat: any, signal: AbortSignal) => Promise<any>,
 *   probe: (t: any, file: string, signal: AbortSignal) => Promise<any>,
 *   decide: (t: any, pr: any, stat: any) => NativePlan,
 *   mark: (what: 'probeStart' | 'probeDone') => void,
 *   onAbort?: (c: EarlyProbeController) => void,
 *   setTimer?: (fn: () => void, ms: number) => any,
 *   clearTimer?: (h: any) => void,
 * }} EarlyDeps
 * @typedef {'idle' | 'probing' | 'guessed_running' | 'probed_running' | 'claimed' | 'aborted'} EarlyState
 */

class EarlyProbeController {
  /** @param {EarlyDeps} deps */
  constructor(deps) {
    this.d = deps;
    /** @type {EarlyState} */
    this.state = 'idle';
    this.file = '';
    this.ms = EARLY_NATIVE_MS;
    /** @type {AbortController | null} */
    this.ctl = null;
    /** @type {NativeDecoderLike | null} */
    this.nd = null; // the early ffmpeg, until a page claims it
    this.timer = null;
    /** @type {Promise<any>} */
    this.stat = Promise.resolve(null);
    /** @type {Promise<any> | null} */
    this.avi = null;
    /** @type {Promise<any>} */
    this.result = Promise.resolve(null);
    this.settled = null; // result, once known
  }

  /** Starts stat, the AVI scan, the tools lookup, the header sniff and ffprobe under one AbortController. */
  start(/** @type {string} */ file, /** @type {{ timeoutMs?: number }} */ opts = {}) {
    if (this.state !== 'idle') return this;
    const d = this.d;
    this.file = file;
    this.ms = opts.timeoutMs || EARLY_NATIVE_MS;
    const ctl = this.ctl = new AbortController();
    const { signal } = ctl;
    this.state = 'probing';
    const stat = this.stat = d.stat(file).catch(() => null);
    // The page reuses this scan, unless the file changed. Only probe AVI after ruling out the frame player.
    const scan = this.avi = d.isAvi(file) ? stat.then((st) => st && !signal.aborted ? d.scanAvi(signal) : null) : null;
    this.result = Promise.all([stat, scan, scan ? null : d.tools()]).then(async ([st, info, found]) => {
      if (signal.aborted || !st || (info && info.isMjpeg)) return null;
      if (d.failedBefore(st)) return null;
      const t = scan ? await d.tools() : found;
      if (signal.aborted || !d.eligible()) return null;
      if (!t) return { t };
      let probing = true;
      const gpus = d.gpus(t); // the method depends on them before any GPU test (no decoding)
      if (this.state === 'probing') {
        // The header is tentative. Run both reads at once so a slow sniff never delays ffprobe.
        Promise.all([d.sniff(file, st, signal), gpus]).then(([pr]) => {
          if (pr && probing && this.state === 'probing' && !signal.aborted) this.spawn(t, pr, st, true);
        }).catch((e) => d.log(`[${d.name}] early native start: ${e && e.stack || e}`));
      }
      d.mark('probeStart');
      if (d.verbose) d.log(`[${d.name}] early ffprobe started`);
      try {
        const [pr] = await Promise.all([d.probe(t, file, signal), gpus]);
        if (signal.aborted) return null;
        d.mark('probeDone');
        return { t, pr, stat: st };
      } catch (err) { return signal.aborted ? null : { t, err }; } finally { probing = false; }
    }).then((e) => { this.settled = e; return e; });
    this.result.then((e) => this.adopt(e)).catch((e) => d.log(`[${d.name}] early native start: ${e && e.stack || e}`));
    return this;
  }

  /** Native ffmpeg as soon as the probe chooses it: replaces a header guess the probe disagrees with. */
  async adopt(/** @type {any} */ e) {
    const d = this.d;
    const usable = () => this.state === 'probing' || this.state === 'guessed_running';
    if (!e || !e.t || !e.pr || e.err || !e.stat || !usable()) return;
    const stat = await d.stat(this.file).catch(() => null);
    if (!usable() || !sameFile(e.stat, stat)) return;
    // A decoder started from the header guess: keep it when the probe agrees, else replace it now
    // instead of letting the wrong one run until the page opens (review 2026-11-19-5 #1).
    const nd = this.nd;
    if (nd) {
      const plan = d.decide(e.t, e.pr, stat);
      if (plan.native && !nd.disposed && !nd.failed && nd.decided === plan.key &&
          nd.method === plan.method && nd.pr.video?.pixFmt === e.pr.video?.pixFmt) return;
      this.nd = null;
      this.clearTimer();
      this.state = 'probing';
      d.log(`[${d.name}] native: early ffmpeg stopped: the probe disagrees with the header guess`);
      nd.dispose();
    }
    this.spawn(e.t, e.pr, stat, false);
  }

  spawn(/** @type {any} */ t, /** @type {any} */ pr, /** @type {any} */ stat, /** @type {boolean} */ guessed) {
    const d = this.d;
    const plan = d.decide(t, pr, stat);
    if (!plan.native || !plan.allowed || !plan.make) return;
    const nd = plan.make();
    nd.guessed = guessed;
    this.nd = nd;
    this.state = guessed ? 'guessed_running' : 'probed_running';
    if (guessed && d.verbose) d.log(`[${d.name}] native: guessed ${pr.video.codec} from the header`);
    this.clearTimer();
    this.timer = (d.setTimer || setTimeout)(() => this.abort(`no page within ${this.ms / 1000} s`), this.ms);
  }

  clearTimer() {
    if (this.timer !== null) (this.d.clearTimer || clearTimeout)(this.timer);
    this.timer = null;
  }

  /** Cancels the pending probes and stops the early ffmpeg nobody claimed (why: logged). */
  abort(/** @type {string} */ why) {
    if (this.ctl) this.ctl.abort();
    this.clearTimer();
    this.state = 'aborted';
    const nd = this.nd;
    this.nd = null;
    if (nd) { this.d.log(`[${this.d.name}] native: early ffmpeg stopped: ${why}`); nd.dispose(); }
    if (this.d.onAbort) this.d.onAbort(this);
  }

  /**
   * The page posted 'ready' (first page only): it takes over the probe's results and the early ffmpeg.
   * An early ffmpeg stays owned by the claim until claimNative takes it; whatever is left (or when
   * signal aborts, the page closing) is stopped, so none outlives the page.
   */
  claim(/** @type {AbortSignal} */ signal) {
    const self = this;
    const ctl = /** @type {AbortController} */ (this.ctl || new AbortController());
    let owned = this.nd;
    this.nd = null;
    this.clearTimer();
    if (this.state !== 'aborted') this.state = 'claimed';
    const discard = () => {
      const nd = owned;
      owned = null;
      if (nd) { self.d.log(`[${self.d.name}] native: early ffmpeg stopped: not used`); nd.dispose(); }
    };
    signal.addEventListener('abort', discard, { once: true });
    return {
      stat: this.stat,
      aviInfo: this.avi,
      probed: this.result,
      /** The ffmpeg lookup of the early run (null: none). */
      tools: this.result.then((e) => e ? e.t || null : null, () => null),
      signal: ctl.signal,
      get aborted() { return ctl.signal.aborted; },
      /** The file changed or the early run does not apply: stop probing, keep the claim. */
      cancelProbe: () => ctl.abort(),
      /**
       * The early ffmpeg when it was started for this very decision (key = nativeKey); else it is stopped
       * and null comes back.
       */
      claimNative(/** @type {string} */ key, /** @type {{ pr: any, method?: string, stat: any }} */ o) {
        const nd = owned;
        owned = null;
        if (!nd) return null;
        const e = ctl.signal.aborted ? null : self.settled;
        const { pr } = o;
        const sameProbe = nd.pr === pr || (nd.guessed && e && e.pr === pr && sameFile(e.stat, o.stat));
        if (sameProbe && !nd.disposed && !nd.failed && nd.decided === key &&
            (!nd.guessed || (nd.method === o.method && nd.pr.video?.pixFmt === pr.video?.pixFmt))) {
          nd.pr = pr;
          return nd;
        }
        self.d.log(`[${self.d.name}] native: early ffmpeg stopped: ${nd.failed ? 'it failed' : 'the decision changed'}`);
        nd.dispose();
        return null;
      },
      /** The page's open() is over: cancel what is left and stop an unused early ffmpeg. */
      release() {
        ctl.abort();
        signal.removeEventListener('abort', discard);
        discard();
      },
    };
  }
}
// checkJs: end

module.exports = { EarlyProbeController, EARLY_NATIVE_MS };
