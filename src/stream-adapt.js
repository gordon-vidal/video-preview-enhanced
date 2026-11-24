'use strict';
// The Live transcode stream's quality ladder (EncodedStream.adapt in src/stream.js), without ffmpeg or the
// webview: it takes the webview's 2 s link samples and decides when the picture steps down or back up.
// Uses dual fast/slow EWMA bandwidth estimates (hls.js style), a 1-window panic step-down on severe
// starvation, an upgrade buffer guard, a cooldown after drops, and exponential oscillation backoff.
// EncodedStream applies what it decides (resize, restart ffmpeg, notices).

// checkJs: start
/** Capped slow-link tiers (used when allowLinkAdapt is enabled on remote links). Index 0 is "no cap". */
const LINK_TIERS = [
  null,
  { height: 1080, kbps: 5500 },
  { height: 720, kbps: 3000 },
  { height: 480, kbps: 1200 },
  { height: 360, kbps: 450 },
];
const TOP_TIER_CAP_KBPS = 5500;
// Link samples (2 s windows from the webview) are ignored until this long after ffmpeg's first
// output following a start, restart or seek, so its start-up stall is not taken for a slow link.
const LINK_SETTLE_MS = 2500;
// A window counts as link-limited only when the host waited for ffmpeg less than this share of the read time.
const ENCODER_WAIT_SHARE = 0.5;
// Dual EWMA smoothing factors (fast tracks drops quickly; slow resists brief SSH throughput bursts).
const EWMA_FAST_ALPHA = 0.5;
const EWMA_SLOW_ALPHA = 0.35;
// Windows in a row: this many bad ones step down (1 on panic starvation), this many good ones step up.
const DOWN_RUN = 2;
const UP_RUN = 4;
const MAX_UP_RUN = 16;
// Severe starvation: step down after 1 window instead of waiting for DOWN_RUN.
const PANIC_BUFFER_S = 0.1;
const PANIC_MEDIA_RATE = 0.5;
// Require enough buffer before stepping up so restart latency does not immediately rebuffer
// even when the decoded-frame budget limits how far ahead WebCodecs can buffer.
const UP_BUFFER_S = 0.35;
// A step-down within this window after a step-up doubles `upRun` (up to MAX_UP_RUN) to damp oscillation.
const OSCILLATION_WINDOW_MS = 45000;
const UP_COOLDOWN_MS = 28000;
const LINK_MEMORY_TTL_MS = 10 * 60 * 1000;
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
 * @typedef {{fastKbps: number, slowKbps: number, tier: number, timestamp: number, upAfter?: number}} LinkSnapshot
 */

/** One record per extension host session, which serves one VS Code window and remote authority. */
class LinkSessionMemory {
  constructor() {
    /** @type {LinkSnapshot | undefined} */
    this.latest = undefined;
  }

  /** @param {number} [now] */
  read(now = Date.now()) {
    if (this.latest && now - this.latest.timestamp >= LINK_MEMORY_TTL_MS) this.latest = undefined;
    return this.latest;
  }

  /** @param {LinkSnapshot} snapshot */
  update(snapshot) { this.latest = snapshot; }
}

/**
 * @typedef {object} LinkDecision
 * @property {boolean} down the window was bad (true) rather than good (false)
 * @property {boolean} panic 1-window panic step-down triggered on severe starvation
 * @property {number} nextCap kb/s of the profile above the current tier (the top rate at tier 0)
 * @property {number} fastKbps fast EWMA link throughput estimate in kb/s
 * @property {number} slowKbps slow EWMA link throughput estimate in kb/s
 * @property {boolean} linkLimited
 * @property {string} detail the window in words, for logs and notices
 * @property {'none' | 'tier' | 'floor'} change 'tier': `tier` was changed; 'floor': a step down was due at the lowest tier
 */

class LinkAdaptController {
  /** @param {LinkSnapshot} [initialLink] */
  constructor(initialLink) {
    this.tier = initialLink?.tier ?? 0;
    this.topKbps = 0;
    this.topPeak = 0;
    this.fastKbps = initialLink?.fastKbps ?? 0;
    this.slowKbps = initialLink?.slowKbps ?? 0;
    this.bwSamples = initialLink ? 1 : 0;
    this.linkRun = 0; // + bad windows in a row, - good ones
    this.upRun = UP_RUN; // consecutive good windows required to step up (backs off on oscillation)
    this.lastUpgradeAt = -Infinity; // ms timestamp of last step-up
    this.upAfter = this.tier && initialLink
      ? (initialLink.upAfter !== undefined ? initialLink.upAfter : initialLink.timestamp + UP_COOLDOWN_MS)
      : -Infinity;
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
      tier: this.tier, topKbps: this.topKbps, topPeak: this.topPeak,
      fastKbps: this.fastKbps, slowKbps: this.slowKbps,
      linkRun: this.linkRun, upRun: this.upRun, lastUpgradeAt: this.lastUpgradeAt,
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
    const readMs = m.readMs ?? 0;
    const linkLimited = !(readMs > 0) || (m.hostWaitMs || 0) < ENCODER_WAIT_SHARE * readMs;
    // A healthy window with no delivery may just have a full buffer. Count zero only during
    // link starvation, and skip encoder-limited stalls so a slow CPU doesn't pollute estimates.
    if ((linkLimited && (m.kbps > 0 || m.starved)) || (m.kbps > 0 && !m.starved && !m.behind)) {
      if (this.bwSamples === 0) {
        this.fastKbps = m.kbps;
        this.slowKbps = m.kbps;
      } else {
        this.fastKbps = EWMA_FAST_ALPHA * m.kbps + (1 - EWMA_FAST_ALPHA) * this.fastKbps;
        this.slowKbps = EWMA_SLOW_ALPHA * m.kbps + (1 - EWMA_SLOW_ALPHA) * this.slowKbps;
      }
      this.bwSamples++;
    }
    const nextCap = LINK_TIERS[this.tier - 1]?.kbps ?? Math.max(TOP_TIER_CAP_KBPS, this.topKbps, this.topPeak);
    const down = linkLimited && m.starved && (m.mediaRate < 0.95 || m.behind);
    const panic = down && m.buffer < PANIC_BUFFER_S && m.mediaRate < PANIC_MEDIA_RATE;
    const upKbps = Math.min(this.fastKbps, this.slowKbps);
    const up = this.tier > 0 && now >= this.upAfter && m.kbps > 0
      && m.buffer >= UP_BUFFER_S && !m.starved && !m.behind
      && upKbps > 1.3 * (nextCap + pcm);
    if (!down && this.lastUpgradeAt !== -Infinity && now - this.lastUpgradeAt > OSCILLATION_WINDOW_MS) {
      this.upRun = UP_RUN;
      this.lastUpgradeAt = -Infinity;
    }
    const step = down ? 1 : up ? -1 : 0;
    const healthyIdle = !down && this.tier > 0 && m.kbps === 0 && !m.starved && !m.behind
      && m.mediaRate >= 0.95 && m.buffer >= UP_BUFFER_S;
    const detail = `${Math.round(m.kbps)} kb/s delivered, ${m.buffer.toFixed(2)} s buffered${m.hostWaitMs ? `, ${Math.round(m.hostWaitMs)} of ${Math.round(readMs)} ms waiting for ffmpeg` : ''}`;
    /** @type {LinkDecision} */
    const decision = {
      down, panic, nextCap, fastKbps: this.fastKbps, slowKbps: this.slowKbps,
      linkLimited, detail, change: 'none',
    };
    const run = this.linkRun;
    if (!healthyIdle) this.linkRun = step && (Math.sign(run) === step ? run + step : step);
    const downNeed = panic ? 1 : DOWN_RUN;
    if (this.linkRun < downNeed && this.linkRun > -this.upRun) return decision;
    this.linkRun = 0;
    const last = LINK_TIERS.length - 1;
    if (down) {
      this.upAfter = now + UP_COOLDOWN_MS;
      if (now - this.lastUpgradeAt <= OSCILLATION_WINDOW_MS) {
        this.upRun = Math.min(MAX_UP_RUN, this.upRun * 2);
        this.lastUpgradeAt = -Infinity;
      }
      if (this.tier === last) { decision.change = 'floor'; return decision; }
      let tier = this.tier + 1;
      while (tier < last && (LINK_TIERS[tier]?.kbps ?? 0) + pcm > this.fastKbps) tier++;
      this.tier = tier;
      decision.change = 'tier';
      return decision;
    }
    this.tier = Math.max(0, this.tier - 1);
    this.lastUpgradeAt = now;
    decision.change = 'tier';
    return decision;
  }
}
// checkJs: end

module.exports = { LinkAdaptController, LinkSessionMemory, LINK_TIERS, LINK_SETTLE_MS, ENCODER_WAIT_SHARE };
