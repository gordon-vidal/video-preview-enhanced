'use strict';
const transcodePolicy = require('./transcode_policy');
// The popups that offer ffmpeg: first-open onboarding, the slow-playback hint, the GPU test offer and the
// remote download offer, plus the one-time notice that Live transcode is on. This holds their per-session state (shown / pending flags) so at most one is up at a
// time; the rules for whether to ask live in src/decide.js and src/remoteff.js. Everything VS Code-shaped and
// every action (set up, download, run the test) is injected: test/host/offers_test.js drives it in plain Node.

// checkJs: start
/**
 * @param {object} deps
 * @param {any} deps.vscode        env.remoteName, workspace.isTrusted, window.showInformationMessage
 * @param {{ get(key: string): any, update(key: string, value: any): PromiseLike<void> }} deps.globalState
 * @param {(msg: string) => void} deps.log
 * @param {any} deps.decide        src/decide.js (rules, keys, copy)
 * @param {any} deps.probe         src/probe.js (latest())
 * @param {any} deps.remoteff      src/remoteff.js (rules, keys, copy)
 * @param {any} deps.setup         src/setup.js (downloadSizeMB)
 * @param {() => Promise<any>} deps.tools        native ffmpeg, or null
 * @param {() => { gpuDecoding: boolean, decoder: string, transcode: string }} deps.config
 * @param {(t: any) => any} deps.probeRecordFor
 * @param {() => boolean} deps.probeRunning  a GPU test is running
 * @param {() => Promise<any>} deps.machine  detected GPUs
 * @param {(t: any, hw: any, o: any) => Promise<any>} deps.runProbeUi
 * @param {() => void} deps.setupFfmpeg
 * @param {() => Promise<void>} deps.turnOffTranscode  sets videoPreviewEnhanced.transcode to "off"
 * @param {() => Promise<void>} deps.downloadRemoteFfmpeg
 * @param {() => string} deps.hostPlatform
 * @param {() => string} deps.hostArch
 * @param {() => string} deps.hostname
 * @param {Iterable<any>} deps.sessions  open players (paused for the GPU test)
 */
function createOffers(deps) {
  const { vscode, globalState, log, decide, probe, remoteff, setup, tools, config, probeRecordFor, probeRunning, machine, runProbeUi,
    setupFfmpeg, turnOffTranscode, downloadRemoteFfmpeg, hostPlatform, hostArch, hostname, sessions } = deps;
  let hintShown = false; // the "set up ffmpeg" hint, at most once per session
  let onboardPending = false; // the first-open popup is showing (no other popup meanwhile)
  let onboardShown = false; // the first-open popup was shown in this session
  let hintPending = false; // the "set up ffmpeg" hint is showing
  let probeOfferShown = false; // the GPU test offer, at most once per session
  let probeOfferPending = false; // that offer is showing
  const remoteOfferAsked = new Set(); // remotes asked about an ffmpeg download in this session
  let remoteOfferPending = false; // that question is showing
  let informing = false; // the Live transcode notice is being stored or showing

  /** Another popup of ours is showing (onboarding, the setup hint, the remote download offer, the GPU test offer). */
  function popupPending() {
    return onboardPending || hintPending || remoteOfferPending || probeOfferPending;
  }

  /**
   * The first video of a session while no ffmpeg is found: "Set up ffmpeg",
   * "Not now" / "Don't Show Again". Once per session until "Don't Show Again"; never in SSH/container or untrusted windows.
   */
  async function maybeOnboard() {
    const base = { state: globalState.get(decide.ONBOARD_KEY), remote: vscode.env.remoteName, trusted: vscode.workspace.isTrusted, pending: onboardPending, shownThisSession: onboardShown };
    if (!decide.shouldOnboard({ ...base, toolsInstalled: false })) return;
    onboardPending = true;
    try {
      const t = await tools();
      if (t) { await globalState.update(decide.ONBOARD_KEY, decide.afterOnboard('had-ffmpeg')); return; }
      const st0 = globalState.get(decide.ONBOARD_KEY);
      if (st0 && st0.choice === 'builtin') return; // "Don't Show Again"
      onboardShown = true;
      log('onboarding: first video, asking about ffmpeg');
      const answer = await vscode.window.showInformationMessage(decide.ONBOARD_TEXT.replace('{mb}', setup.downloadSizeMB()), decide.ONBOARD_SETUP, decide.ONBOARD_LATER, decide.ONBOARD_BUILTIN);
      const st = decide.afterOnboard(answer);
      await globalState.update(decide.ONBOARD_KEY, st);
      log(`onboarding: answer ${st.choice}`);
      if (st.choice === 'ffmpeg') setupFfmpeg();
    } finally {
      onboardPending = false;
    }
  }

  /** The built-in decoder stays below real time and there's no ffmpeg: suggest it, without nagging. */
  async function maybeHint(/** @type {{ name: string, slowRun: number }} */ sess, /** @type {{ ratio: number }} */ sample) {
    if (onboardPending || hintPending || probeOfferPending) return; // one question at a time
    if (!vscode.workspace.isTrusted) return; // shouldHint says no anyway; don't run ffmpeg -version to learn it
    const t = await tools();
    const ok = decide.shouldHint({
      hint: globalState.get(decide.HINT_KEY), onboard: globalState.get(decide.ONBOARD_KEY), now: Date.now(), shownThisSession: hintShown, toolsInstalled: !!t,
      remote: vscode.env.remoteName, trusted: vscode.workspace.isTrusted, slowRun: sess.slowRun, ratio: sample.ratio,
    });
    if (!ok) return;
    hintShown = true;
    const rec = probe.latest(globalState); // an earlier ffmpeg's probe, if any
    const text = decide.hintText(sample, { mb: setup.downloadSizeMB(), probeRecord: rec && rec.complete ? rec : null });
    log(`[${sess.name}] built-in decoding at ${sample.ratio.toFixed(2)}x (sample ${sess.slowRun}); suggesting ffmpeg: ${text}`);
    hintPending = true;
    let answer;
    try { answer = await vscode.window.showInformationMessage(text, 'Set up', 'Not now', "Don't Show Again"); } finally { hintPending = false; }
    await globalState.update(decide.HINT_KEY, decide.afterHint(globalState.get(decide.HINT_KEY), answer));
    if (answer === 'Set up') setupFfmpeg();
  }

  /**
   * Playback stays below real time with ffmpeg installed (native ffmpeg, or the built-in decoder) and no GPU
   * test result fits this ffmpeg and GPU: offer the test once (decide.shouldOfferProbe). It never runs by
   * itself; "Run test" pauses the videos playing natively (the test would wait for them) and runs it with
   * its progress and Cancel; the result applies to the next open, or to this video with "Reopen video".
   */
  async function maybeOfferProbe(/** @type {any} */ sess, /** @type {{ ratio: number, native?: boolean }} */ sample) {
    if (probeOfferShown || popupPending() || probeRunning()) return;
    const remote = vscode.env.remoteName;
    if (remote || !vscode.workspace.isTrusted) return; // never run ffmpeg -version to learn what shouldOfferProbe says anyway
    const t = await tools();
    const ctx = {
      offer: globalState.get(decide.PROBE_OFFER_KEY), shownThisSession: probeOfferShown, toolsInstalled: !!t, probeRecord: !!probeRecordFor(t),
      gpu: config().gpuDecoding, remote, trusted: vscode.workspace.isTrusted, pending: popupPending(), running: probeRunning(),
      slowRun: sess.slowRun, ratio: sample.ratio,
    };
    if (!decide.shouldOfferProbe(ctx)) return;
    probeOfferShown = true;
    probeOfferPending = true;
    log(`[${sess.name}] ${sample.native ? 'native ffmpeg' : 'built-in decoder'} at ${sample.ratio.toFixed(2)}x (sample ${sess.slowRun}), no GPU test yet: offering it`);
    let answer;
    try {
      answer = await vscode.window.showInformationMessage(decide.PROBE_OFFER_TEXT, decide.PROBE_OFFER_RUN, decide.PROBE_OFFER_LATER, decide.PROBE_OFFER_NEVER);
    } finally { probeOfferPending = false; }
    await globalState.update(decide.PROBE_OFFER_KEY, decide.afterProbeOffer(globalState.get(decide.PROBE_OFFER_KEY), answer));
    log(`GPU test offer: ${answer || 'dismissed'}`);
    if (answer !== decide.PROBE_OFFER_RUN) return null;
    for (const x of sessions) if (x.native && !x.disposed) x.post({ type: 'pauseForTest' });
    return runProbeUi(t, await machine(), { userAsked: true, reload: sess });
  }

  /**
   * Remote windows (SSH, containers, tunnels): the picture of this file decodes in WebAssembly, the
   * remote stream would take it, and the remote has no ffmpeg. Offers BtbN's static Linux build
   * (x64, arm64) in the extension's folder there: once per remote and session, "Don't Show Again" per
   * remote (docs/notes/remote-stream.md).
   */
  async function maybeOfferRemoteFfmpeg(/** @type {{ name: string }} */ sess, /** @type {{ codec?: unknown }} */ m) {
    const remote = vscode.env.remoteName;
    const c = config();
    const key = remoteff.remoteKey(remote);
    const ctx = () => ({
      remote, platform: hostPlatform(), arch: hostArch(), trusted: vscode.workspace.isTrusted,
      streamOn: c.transcode !== 'off', builtinOnly: c.decoder === 'builtin',
      askedThisSession: remoteOfferAsked, state: globalState.get(remoteff.OFFER_KEY), key, pending: remoteOfferPending || onboardPending,
    });
    if (!remoteff.shouldOffer(ctx())) return;
    if (await tools()) return;
    if (!remoteff.shouldOffer(ctx())) return; // another tab asked meanwhile
    remoteOfferAsked.add(key);
    remoteOfferPending = true;
    const host = hostname();
    const codec = typeof m.codec === 'string' && /^[\w-]{1,24}$/.test(m.codec) ? m.codec : '';
    let answer;
    try {
      log(`[${sess.name}] ${codec || 'video'} decodes in WebAssembly and ${host} has no ffmpeg: offering the download`);
      answer = await vscode.window.showInformationMessage(remoteff.offerText({ codec, host, mb: setup.downloadSizeMB('linux', hostArch()) }),
        remoteff.OFFER_DOWNLOAD, remoteff.OFFER_LATER, remoteff.OFFER_NEVER);
    } finally { remoteOfferPending = false; }
    await globalState.update(remoteff.OFFER_KEY, remoteff.afterOffer(globalState.get(remoteff.OFFER_KEY), key, answer));
    if (answer === remoteff.OFFER_DOWNLOAD) await downloadRemoteFfmpeg();
  }

  /**
   * The first time Live transcode starts (2026-11-23, ADR 0002: Live transcode is automatic, nothing asks first):
   * one non-blocking notice says it is on and how to leave it. Remembered in globalState, never shown again.
   * `sess.useOriginalVideo()` is this tab's "Use original video".
   */
  async function maybeInformTranscode(/** @type {{ name?: string, disposed?: boolean, useOriginalVideo?: () => void }} */ sess) {
    if (informing || globalState.get(transcodePolicy.INFORM_KEY)) return;
    informing = true;
    await globalState.update(transcodePolicy.INFORM_KEY, Date.now());
    log(`[${sess.name || 'video'}] live transcode started for the first time: showing the one-time notice`);
    let answer;
    try {
      answer = await vscode.window.showInformationMessage(transcodePolicy.informText(), transcodePolicy.INFORM_ORIGINAL, transcodePolicy.INFORM_OFF);
    } finally { informing = false; }
    if (answer === transcodePolicy.INFORM_ORIGINAL) { if (!sess.disposed && sess.useOriginalVideo) sess.useOriginalVideo(); }
    else if (answer === transcodePolicy.INFORM_OFF) await turnOffTranscode();
  }

  return { maybeInformTranscode, maybeOnboard, maybeHint, maybeOfferProbe, maybeOfferRemoteFfmpeg, popupPending };
}
// checkJs: end

module.exports = { createOffers };
