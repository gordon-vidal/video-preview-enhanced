'use strict';
// node test/run.js unit --grep offers: src/offers.js with fake vscode / globalState / actions (no VS Code):
// the onboarding, slow-playback hint, GPU test and remote ffmpeg offers: copy and buttons, answers stored,
// once per session, one popup at a time, untrusted / remote gating, dismissal and "Don't Show Again".
const assert = require('assert');
const decide = require('../../src/decide');
const remoteff = require('../../src/remoteff');
const probe = require('../../src/probe');
const { createOffers } = require('../../src/offers');

function make({ remote, trusted = true, tools = null, config = {}, answers = [], probeRecord = false, probeRunning = false } = {}) {
  const store = new Map();
  const globalState = { get: (k) => store.get(k), update: async (k, v) => { store.set(k, v); } };
  const shown = [];
  const calls = { off: 0, setup: 0, download: 0, probeUi: [], toolsCalls: 0 };
  const queue = [...answers];
  const gates = []; // resolvers of messages left hanging (popup "showing")
  const env = { remote, trusted, hang: false };
  const vscode = {
    env: { get remoteName() { return env.remote; } },
    workspace: { get isTrusted() { return env.trusted; } },
    window: {
      showInformationMessage: (...a) => {
        shown.push(a);
        if (env.hang) return new Promise((r) => gates.push(r));
        return Promise.resolve(queue.shift());
      },
    },
  };
  const logs = [];
  const post = [];
  const sessions = new Set([{ native: {}, disposed: false, post: (m) => post.push(['native', m]) },
    { native: null, disposed: false, post: (m) => post.push(['wasm', m]) }, { native: {}, disposed: true, post: (m) => post.push(['gone', m]) }]);
  const offers = createOffers({
    vscode, globalState, log: (m) => logs.push(m), decide, probe, remoteff,
    setup: { downloadSizeMB: (os, arch) => (os ? `${os}-${arch}-80` : '90') },
    tools: async () => { calls.toolsCalls++; return tools; },
    config: () => ({ gpuDecoding: true, decoder: 'auto', transcode: 'auto', ...config }),
    probeRecordFor: () => (probeRecord ? { complete: true } : null),
    probeRunning: () => probeRunning,
    machine: async () => ({ gpus: [] }),
    runProbeUi: async (t, hw, o) => { calls.probeUi.push(o); return 'rec'; },
    setupFfmpeg: () => { calls.setup++; },
    turnOffTranscode: async () => { calls.off++; },
    downloadRemoteFfmpeg: async () => { calls.download++; },
    hostPlatform: () => 'linux', hostArch: () => 'x64', hostname: () => 'devbox', sessions,
  });
  return { offers, store, shown, calls, logs, post, env, gates, state: globalState };
}

const sess = { name: 'a.mp4', slowRun: 5 };
const sample = { ratio: 0.4, native: false };

(async () => {
  // ---- onboarding ----
  let t = make({ answers: [decide.ONBOARD_SETUP] });
  await t.offers.maybeOnboard();
  assert.deepStrictEqual(t.shown[0].slice(1), ['Set up ffmpeg', 'Not now', "Don't Show Again"]);
  assert.strictEqual(t.shown[0][0], decide.ONBOARD_TEXT.replace('{mb}', '90'));
  assert.strictEqual(t.store.get(decide.ONBOARD_KEY).choice, 'ffmpeg');
  assert.strictEqual(t.calls.setup, 1, '"Set up ffmpeg" runs the setup flow');
  await t.offers.maybeOnboard();
  assert.strictEqual(t.shown.length, 1, 'once per session');

  t = make({ answers: [decide.ONBOARD_BUILTIN] });
  await t.offers.maybeOnboard();
  assert.strictEqual(t.store.get(decide.ONBOARD_KEY).choice, 'builtin');
  assert.strictEqual(t.calls.setup, 0);

  t = make({ answers: [undefined] });
  await t.offers.maybeOnboard();
  assert.strictEqual(t.store.get(decide.ONBOARD_KEY).choice, 'dismissed', 'dismissal is remembered but asks again next session');
  assert.match(t.logs.join('\n'), /onboarding: answer dismissed/);

  // "Don't Show Again" from an earlier session: never asked, even though no ffmpeg.
  t = make({ answers: [decide.ONBOARD_SETUP] });
  t.store.set(decide.ONBOARD_KEY, decide.afterOnboard(decide.ONBOARD_BUILTIN));
  await t.offers.maybeOnboard();
  assert.strictEqual(t.shown.length, 0);

  // ffmpeg found: recorded, not asked.
  t = make({ tools: { version: '7.0' } });
  await t.offers.maybeOnboard();
  assert.strictEqual(t.shown.length, 0);
  assert.strictEqual(t.store.get(decide.ONBOARD_KEY).choice, 'had-ffmpeg');

  // Gating: untrusted and SSH / container windows never run it (and never look for ffmpeg); WSL does.
  for (const over of [{ trusted: false }, { remote: 'ssh-remote' }, { remote: 'dev-container' }]) {
    t = make({ answers: [decide.ONBOARD_SETUP], ...over });
    await t.offers.maybeOnboard();
    assert.strictEqual(t.shown.length, 0, JSON.stringify(over));
    assert.strictEqual(t.calls.toolsCalls, 0, 'no ffmpeg -version just to learn that');
  }
  t = make({ answers: [decide.ONBOARD_LATER], remote: 'wsl' });
  await t.offers.maybeOnboard();
  assert.strictEqual(t.shown.length, 1);

  // Pending guard: a second call while the popup is up neither asks again nor blocks the first; the flag clears after.
  t = make({ answers: [decide.ONBOARD_LATER] });
  t.env.hang = true;
  const first = t.offers.maybeOnboard();
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(t.offers.popupPending(), true);
  await t.offers.maybeOnboard();
  assert.strictEqual(t.shown.length, 1);
  t.env.hang = false;
  t.gates[0](decide.ONBOARD_LATER);
  await first;
  assert.strictEqual(t.offers.popupPending(), false);

  // ---- hint ----
  t = make({ answers: ['Set up'] });
  await t.offers.maybeHint(sess, sample);
  assert.deepStrictEqual(t.shown[0].slice(1), ['Set up', 'Not now', "Don't Show Again"]);
  assert.match(t.logs[0], /\[a\.mp4\] built-in decoding at 0\.40x \(sample 5\); suggesting ffmpeg/);
  assert.strictEqual(t.calls.setup, 1);
  await t.offers.maybeHint(sess, sample);
  assert.strictEqual(t.shown.length, 1, 'at most once per session');

  t = make({ answers: ["Don't Show Again"] });
  await t.offers.maybeHint(sess, sample);
  assert.strictEqual(t.store.get(decide.HINT_KEY).never, true);
  assert.strictEqual(t.calls.setup, 0);
  t = make({ answers: ['Set up'] });
  t.store.set(decide.HINT_KEY, { never: true });
  await t.offers.maybeHint(sess, sample);
  assert.strictEqual(t.shown.length, 0);

  // Not slow enough, ffmpeg installed, untrusted, remote: nothing. Untrusted skips the tools lookup.
  t = make({ answers: ['Set up'] });
  await t.offers.maybeHint({ ...sess, slowRun: 0 }, sample);
  assert.strictEqual(t.shown.length, 0);
  t = make({ answers: ['Set up'], tools: { version: '7' } });
  await t.offers.maybeHint(sess, sample);
  assert.strictEqual(t.shown.length, 0);
  t = make({ answers: ['Set up'], trusted: false });
  await t.offers.maybeHint(sess, sample);
  assert.strictEqual(t.shown.length, 0); assert.strictEqual(t.calls.toolsCalls, 0);
  t = make({ answers: ['Set up'], remote: 'ssh-remote' });
  await t.offers.maybeHint(sess, sample);
  assert.strictEqual(t.shown.length, 0);

  // One question at a time: the hint waits while another popup shows.
  t = make({ answers: [decide.ONBOARD_LATER, 'Set up'] });
  t.env.hang = true;
  const ob = t.offers.maybeOnboard();
  await new Promise((r) => setImmediate(r));
  await t.offers.maybeHint(sess, sample);
  assert.strictEqual(t.shown.length, 1, 'only the onboarding popup');
  t.env.hang = false; t.gates[0](undefined); await ob;

  // ---- GPU test offer ----
  const ffmpeg = { version: '7.0', ffmpeg: '/x/ffmpeg' };
  t = make({ tools: ffmpeg, answers: [decide.PROBE_OFFER_RUN] });
  const r = await t.offers.maybeOfferProbe(sess, { ratio: 0.4, native: true });
  assert.strictEqual(t.shown[0][0], decide.PROBE_OFFER_TEXT);
  assert.deepStrictEqual(t.shown[0].slice(1), [decide.PROBE_OFFER_RUN, decide.PROBE_OFFER_LATER, decide.PROBE_OFFER_NEVER]);
  assert.match(t.logs[0], /\[a\.mp4\] native ffmpeg at 0\.40x \(sample 5\), no GPU test yet: offering it/);
  assert.strictEqual(r, 'rec');
  assert.deepStrictEqual(t.post, [['native', { type: 'pauseForTest' }]], 'only live native players pause');
  assert.strictEqual(t.calls.probeUi.length, 1);
  assert.strictEqual(t.calls.probeUi[0].userAsked, true);
  assert.strictEqual(t.calls.probeUi[0].reload, sess);
  assert.strictEqual(t.store.get(decide.PROBE_OFFER_KEY).answer, decide.PROBE_OFFER_RUN);
  await t.offers.maybeOfferProbe(sess, sample);
  assert.strictEqual(t.shown.length, 1, 'once per session');

  t = make({ tools: ffmpeg, answers: [undefined] });
  assert.strictEqual(await t.offers.maybeOfferProbe(sess, sample), null);
  assert.strictEqual(t.store.get(decide.PROBE_OFFER_KEY).answer, 'dismissed');
  assert.strictEqual(t.calls.probeUi.length, 0);
  assert.match(t.logs.join('\n'), /GPU test offer: dismissed/);

  t = make({ tools: ffmpeg, answers: [decide.PROBE_OFFER_NEVER] });
  await t.offers.maybeOfferProbe(sess, sample);
  assert.strictEqual(t.store.get(decide.PROBE_OFFER_KEY).never, true);
  assert.strictEqual(t.calls.probeUi.length, 0);

  // Gating: no ffmpeg, a fitting test result, GPU decoding off, a running test, remote, untrusted, earlier "never".
  const gated = [
    {}, { probeRecord: true }, { config: { gpuDecoding: false } }, { probeRunning: true }, { remote: 'wsl' }, { trusted: false },
  ];
  for (const over of gated) {
    t = make({ tools: ffmpeg, answers: [decide.PROBE_OFFER_RUN], ...over });
    if (over === gated[0]) t = make({ tools: null, answers: [decide.PROBE_OFFER_RUN] });
    await t.offers.maybeOfferProbe(sess, sample);
    assert.strictEqual(t.shown.length, 0, JSON.stringify(over));
  }
  t = make({ tools: ffmpeg, answers: [decide.PROBE_OFFER_RUN] });
  t.store.set(decide.PROBE_OFFER_KEY, { never: true });
  await t.offers.maybeOfferProbe(sess, sample);
  assert.strictEqual(t.shown.length, 0);
  // Remote or untrusted: not even an ffmpeg lookup.
  t = make({ tools: ffmpeg, remote: 'ssh-remote' });
  await t.offers.maybeOfferProbe(sess, sample);
  assert.strictEqual(t.calls.toolsCalls, 0);

  // Pending guard across offers: while the GPU offer shows, the hint and onboarding stay quiet.
  t = make({ tools: ffmpeg });
  t.env.hang = true;
  const po = t.offers.maybeOfferProbe(sess, sample);
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(t.offers.popupPending(), true);
  await t.offers.maybeHint(sess, sample);
  await t.offers.maybeOfferProbe(sess, sample);
  assert.strictEqual(t.shown.length, 1);
  t.env.hang = false; t.gates[0](decide.PROBE_OFFER_LATER); await po;
  assert.strictEqual(t.offers.popupPending(), false);

  // ---- remote ffmpeg offer ----
  const rem = { remote: 'ssh-remote' };
  t = make({ ...rem, answers: [remoteff.OFFER_DOWNLOAD] });
  await t.offers.maybeOfferRemoteFfmpeg(sess, { codec: 'hevc' });
  assert.strictEqual(t.shown[0][0], remoteff.offerText({ codec: 'hevc', host: 'devbox', mb: 'linux-x64-80' }));
  assert.deepStrictEqual(t.shown[0].slice(1), ['Download ffmpeg', 'Not now', "Don't Show Again"]);
  assert.strictEqual(t.calls.download, 1);
  assert.match(t.logs[0], /\[a\.mp4\] hevc decodes in WebAssembly and devbox has no ffmpeg: offering the download/);
  const key = remoteff.remoteKey('ssh-remote');
  assert.strictEqual(t.store.get(remoteff.OFFER_KEY)[key].answer, 'download');
  await t.offers.maybeOfferRemoteFfmpeg(sess, { codec: 'hevc' });
  assert.strictEqual(t.shown.length, 1, 'once per remote and session');

  // A codec that is not a short word is not put into the copy.
  t = make({ ...rem, answers: [remoteff.OFFER_LATER] });
  await t.offers.maybeOfferRemoteFfmpeg(sess, { codec: '<b>bad codec</b>' });
  assert.strictEqual(t.shown[0][0], remoteff.offerText({ codec: '', host: 'devbox', mb: 'linux-x64-80' }));
  assert.strictEqual(t.calls.download, 0);
  assert.strictEqual(t.store.get(remoteff.OFFER_KEY)[key].answer, 'later');

  t = make({ ...rem, answers: [remoteff.OFFER_NEVER] });
  await t.offers.maybeOfferRemoteFfmpeg(sess, {});
  assert.strictEqual(t.store.get(remoteff.OFFER_KEY)[key].never, true);
  assert.strictEqual(t.calls.download, 0);

  t = make({ ...rem, answers: [undefined] });
  await t.offers.maybeOfferRemoteFfmpeg(sess, {});
  assert.strictEqual(t.store.get(remoteff.OFFER_KEY)[key].answer, 'later', 'dismissal behaves as "Not now"');

  // Gating: local window, WSL, untrusted, stream off, built-in only, ffmpeg present, earlier "never".
  const noOffer = [{ remote: undefined }, { remote: 'wsl' }, { trusted: false }, { config: { transcode: 'off' } }, { config: { decoder: 'builtin' } }, { tools: { version: '7' } }];
  for (const over of noOffer) {
    t = make({ ...rem, answers: [remoteff.OFFER_DOWNLOAD], ...over });
    await t.offers.maybeOfferRemoteFfmpeg(sess, {});
    assert.strictEqual(t.shown.length, 0, JSON.stringify(over));
  }
  t = make({ ...rem, answers: [remoteff.OFFER_DOWNLOAD] });
  t.store.set(remoteff.OFFER_KEY, { [key]: { never: true } });
  await t.offers.maybeOfferRemoteFfmpeg(sess, {});
  assert.strictEqual(t.shown.length, 0);

  // Pending: not while onboarding shows; two tabs asking at once ask once.
  t = make({ ...rem, answers: [remoteff.OFFER_LATER] });
  t.env.hang = true;
  const p1 = t.offers.maybeOfferRemoteFfmpeg(sess, {});
  const p2 = t.offers.maybeOfferRemoteFfmpeg(sess, {});
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(t.shown.length, 1, 'the second tab asks nothing');
  t.env.hang = false; t.gates[0](remoteff.OFFER_LATER); await Promise.all([p1, p2]);
  assert.strictEqual(t.shown.length, 1);
  assert.strictEqual(t.offers.popupPending(), false);

  // ---- Live transcode: one non-blocking notice the first time it starts, never again ----
  const informed = require('../../src/transcode_policy');
  let used = 0;
  const tab = { name: 'a.mp4', disposed: false, useOriginalVideo: () => { used++; } };
  t = make({ answers: [undefined] });
  await t.offers.maybeInformTranscode(tab);
  assert.strictEqual(t.shown.length, 1);
  assert.deepStrictEqual(t.shown[0], [informed.informText(), 'Use original video', 'Turn off']);
  assert.ok(t.store.get(informed.INFORM_KEY), 'remembered in globalState');
  await t.offers.maybeInformTranscode(tab);
  assert.strictEqual(t.shown.length, 1, 'not a second time');
  assert.strictEqual(used + t.calls.off, 0, 'dismissing changes nothing');
  // A new session (flag already stored) shows nothing.
  t = make({ answers: ['Turn off'] });
  t.store.set(informed.INFORM_KEY, 1);
  await t.offers.maybeInformTranscode(tab);
  assert.strictEqual(t.shown.length, 0);
  // Two tiles starting at once show it once; the buttons act.
  t = make({ answers: ['Use original video'] });
  await Promise.all([t.offers.maybeInformTranscode(tab), t.offers.maybeInformTranscode(tab)]);
  assert.strictEqual(t.shown.length, 1);
  assert.strictEqual(used, 1, '"Use original video" is this tab only');
  assert.strictEqual(t.calls.off, 0);
  t = make({ answers: ['Turn off'] });
  await t.offers.maybeInformTranscode(tab);
  assert.strictEqual(t.calls.off, 1, '"Turn off" sets transcode to off');

  // A rejected globalState.update must clear the in-flight guard so a later start can still show the notice.
  t = make({ answers: [undefined] });
  const origUpdate = t.state.update;
  let failOnce = true;
  t.state.update = async (k, v) => {
    if (failOnce) { failOnce = false; throw new Error('disk full'); }
    return origUpdate(k, v);
  };
  await assert.rejects(() => t.offers.maybeInformTranscode(tab), /disk full/);
  assert.strictEqual(t.shown.length, 0);
  await t.offers.maybeInformTranscode(tab);
  assert.strictEqual(t.shown.length, 1, 'notice recovers after a failed state write');

  console.log('offers tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
