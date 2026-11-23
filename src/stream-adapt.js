'use strict';
// The Live transcode stream's quality ladder (EncodedStream.adapt in src/stream.js), without ffmpeg or the
// webview: it takes the webview's 2 s link samples and decides when the picture steps down or back up.
// Down after two bad windows in a row (skipping tiers the link cannot carry), up after four good ones.
// EncodedStream applies what it decides (resize, restart ffmpeg, notices).

// checkJs: start
/** Capped slow-link tiers (used when allowLinkAdapt is enabled on remote links). Index 0 is "no cap". */
const LINK_TIERS = [null, { height: 720, kbps: 3000 }, { height: 480, kbps: 1200 }, { height: 360, kbps: 450 }];
// Link samples (2 s windows from the webview) are ignored until this long after ffmpeg's first
// output following a start, restart or seek, so its start-up stall is not taken for a slow link.
const LINK_SETTLE_MS = 2500;
// A window counts as link-limited only when the host waited for ffmpeg less than this share of the read time.
const ENCODER_WAIT_SHARE = 0.5;
// Windows in a row: this many bad ones step down, this many good ones step up.
const DOWN_RUN = 2;
const UP_RUN = 4;
// A gap longer than this between samples ends the run (the player was paused or hidden).
const SAMPLE_GAP_MS = 3500;

/**
 * @typedef {object} LinkSample a window from media/engine.js sampleRemoteLink
 * @property {number} kbps delivered in the window
 * @property {number} [videoKbps] the video's own rate at the top tier
 * @property {number} mediaRate
 * @property {number} buffer seconds of picture buffered
 * @property {boolean} starved
 * @property {boolean} behind
 * @property {number} [readMs]
 * @property {number} [hostWaitMs] of readMs, how long the host waited for ffmpeg
 */

/**
 * @typedef {object} LinkDecision
 * @property {boolean} down the window was bad (true) rather than good (false)
 * @property {number} nextCap kb/s of the profile above the current tier (the top rate at tier 0)
 * @property {boolean} linkLimited
 * @property {string} detail the window in words, for logs and notices
 * @property {'none' | 'tier' | 'floor'} change 'tier': `tier` was changed; 'floor': a step down was due at the lowest tier
 */

class LinkAdaptController {
  constructor() {
    this.tier = 0;
    this.topKbps = 0;
    this.topPeak = 0;
    this.linkRun = 0; // + bad windows in a row, - good ones
    this.lastLinkSample = 0;
    this.settleAt = Infinity; // when link samples count again (see LINK_SETTLE_MS)
    /** Notices the user got already: 'quality', 'slow'. */
    this.noticed = new Set();
  }

  /** ffmpeg is (re)starting: no sample counts until its first output. */
  waitForOutput() { this.settleAt = Infinity; }

  /** ffmpeg restarted for a new tier or after a stall: the run so far is void. */
  resetForRestart() {
    this.settleAt = Infinity;
    this.linkRun = 0;
  }

  /** A seek: the buffer refills from memory or not, so the next windows are not the link's. */
  resetForSeek(now) {
    this.linkRun = 0;
    this.settleAt = now + LINK_SETTLE_MS;
  }

  /** ffmpeg's first bytes after a start: samples count again after the settle window. */
  noteFirstOutput(now) { this.settleAt = now + LINK_SETTLE_MS; }

  /** True the first time per kind (a notice is shown once per stream). */
  firstNotice(kind) {
    if (this.noticed.has(kind)) return false;
    this.noticed.add(kind);
    return true;
  }

  state() {
    return {
      tier: this.tier, topKbps: this.topKbps, topPeak: this.topPeak, linkRun: this.linkRun,
      lastLinkSample: this.lastLinkSample, settleAt: this.settleAt, noticed: [...this.noticed],
    };
  }

  /**
   * One window from the link. Returns null while ffmpeg's start-up is in the settle window, else what was seen
   * and whether the tier changed (this.tier is already the new tier then).
   * @param {LinkSample} m
   * @param {number} now ms
   * @param {number} pcm kb/s the sound adds to the stream (0 without sound)
   * @returns {LinkDecision | null}
   */
  onSample(m, now, pcm) {
    if (now - this.lastLinkSample > SAMPLE_GAP_MS) this.linkRun = 0;
    this.lastLinkSample = now;
    if (now < this.settleAt) return null; // ffmpeg start-up is in this window
    const videoKbps = m.videoKbps ?? 0;
    if (!this.tier && videoKbps > 0) {
      this.topKbps = this.topKbps ? 0.75 * this.topKbps + 0.25 * videoKbps : videoKbps;
      this.topPeak = Math.max(videoKbps, 0.9 * this.topPeak);
    }
    const nextCap = LINK_TIERS[this.tier - 1]?.kbps ?? Math.max(3000, this.topKbps, this.topPeak);
    const readMs = m.readMs ?? 0;
    const linkLimited = !(readMs > 0) || (m.hostWaitMs || 0) < ENCODER_WAIT_SHARE * readMs;
    const down = linkLimited && m.starved && (m.mediaRate < 0.95 || m.behind);
    const up = this.tier > 0 && m.buffer >= 0.25 && !m.starved && !m.behind && m.kbps > 1.3 * (nextCap + pcm);
    const step = down ? 1 : up ? -1 : 0;
    const detail = `${Math.round(m.kbps)} kb/s delivered, ${m.buffer.toFixed(2)} s buffered${m.hostWaitMs ? `, ${Math.round(m.hostWaitMs)} of ${Math.round(readMs)} ms waiting for ffmpeg` : ''}`;
    /** @type {LinkDecision} */
    const decision = { down, nextCap, linkLimited, detail, change: 'none' };
    const run = this.linkRun;
    this.linkRun = step && (Math.sign(run) === step ? run + step : step);
    if (this.linkRun < DOWN_RUN && this.linkRun > -UP_RUN) return decision;
    this.linkRun = 0;
    const last = LINK_TIERS.length - 1;
    if (down && this.tier === last) { decision.change = 'floor'; return decision; }
    let tier = this.tier + step;
    if (down) while (tier < last && LINK_TIERS[tier].kbps + pcm > m.kbps) tier++;
    this.tier = tier;
    decision.change = 'tier';
    return decision;
  }
}
// checkJs: end

module.exports = { LinkAdaptController, LINK_TIERS, LINK_SETTLE_MS, ENCODER_WAIT_SHARE };
