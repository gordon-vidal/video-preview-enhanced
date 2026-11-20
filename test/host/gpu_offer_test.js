'use strict';
// node test/host/gpu_offer_test.js: the GPU test offer (src/extension.js maybeOfferProbe, decide.shouldOfferProbe)
// with the mock vscode and a real ffmpeg (on PATH, or VPE_FFMPEG). The test never runs by itself:
// playback below real time with ffmpeg installed (the built-in decoder, or native ffmpeg) and no GPU test
// record brings one notification per session; "Run test" runs the probe (withProgress), "Don't remind me"
// is kept; nothing with a fitting record, in remote or untrusted windows, or while another popup is up.
// Skipped without ffmpeg.
const assert = require('assert');
const path = require('path');
const ff = require('../../src/ffmpeg');
const decide = require('../../src/decide');
const { load } = require('./mock_vscode');

const clip = path.join(__dirname, '..', '..', 'media', 'probe', 'hevc_10_2160.mkv');
const slow = { type: 'decodeSpeed', codec: 'hevc', depth: 10, width: 3840, height: 2160, fps: 30, vmode: 'soft', realtime: false, ratio: 0.7 };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const isOffer = (a) => a[0] === decide.PROBE_OFFER_TEXT;

// The rule itself.
{
  const base = { toolsInstalled: true, trusted: true, slowRun: 2, ratio: 0.7 };
  assert.strictEqual(decide.shouldOfferProbe(base), true);
  assert.strictEqual(decide.shouldOfferProbe({ ...base, slowRun: 1 }), false, 'one mild slow sample is a blip');
  assert.strictEqual(decide.shouldOfferProbe({ ...base, slowRun: 1, ratio: 0.2 }), true, 'one hopeless sample is enough');
  for (const [k, v] of [['shownThisSession', true], ['toolsInstalled', false], ['probeRecord', true], ['gpu', false], ['remote', 'wsl'], ['trusted', false], ['pending', true], ['running', true], ['offer', { never: true }]]) {
    assert.strictEqual(decide.shouldOfferProbe({ ...base, [k]: v }), false, k);
  }
  assert.deepStrictEqual(decide.afterProbeOffer(undefined, decide.PROBE_OFFER_NEVER, 5), { shownAt: 5, answer: "Don't remind me", never: true });
  assert.strictEqual(decide.afterProbeOffer(undefined, undefined, 5).never, undefined, 'dismissed: asked again next session');
}

(async () => {
  const tools = await ff.locateTools(process.env.VPE_FFMPEG || '', '');
  if (!tools) { console.log('gpu offer: skipped (no ffmpeg)'); return; }
  const record = { fp: 'x', complete: true, ffmpeg: tools.version, ffmpegPath: tools.ffmpeg, gpus: [], at: 1, maxHeight: 1440, results: {} };

  async function session({ answer, remote, trusted = true, decoder = 'builtin', state, before } = {}) {
    const settings = { 'videoPreviewEnhanced.ffmpegPath': tools.ffmpeg, 'videoPreviewEnhanced.decoder': decoder };
    const h = load({ settings, state });
    const shown = [];
    const probes = [];
    h.vscode.window.showInformationMessage = async (...a) => { if (a.includes('Undo')) return undefined; shown.push(a); return isOffer(a) ? answer : undefined; };
    h.vscode.window.withProgress = async (o) => { probes.push(o.title); return null; }; // the probe, "cancelled"
    h.vscode.env.remoteName = remote;
    h.vscode.workspace.isTrusted = trusted;
    if (before) await before(h);
    const s = h.open(clip);
    return { h, s, shown, probes, offers: () => shown.filter(isOffer) };
  }
  // Waits for the condition, not for a time: the deadline is only a safety net. Before offering, the extension runs
  // ffmpeg -version and the GPU detection, which take seconds on a busy CI machine (3 s here flaked on Windows).
  const until = async (pred, ms = 30000) => { for (let t0 = Date.now(); !pred() && Date.now() - t0 < ms;) await wait(10); };
  const logOf = (h) => h.context.subscriptions.find((x) => x && Array.isArray(x.lines)).lines.join('\n');

  // Built-in decoder behind with ffmpeg installed, no test record: one offer, its buttons; "Not now" runs nothing.
  let x = await session({ answer: 'Not now' });
  await x.s.send(slow);
  await wait(100);
  assert.strictEqual(x.offers().length, 0, 'not after one mild slow sample');
  await x.s.send(slow);
  await until(() => x.offers().length);
  assert.strictEqual(x.offers().length, 1, 'offered after two slow samples');
  assert.deepStrictEqual(x.offers()[0].slice(1), ['Run test', 'Not now', "Don't remind me"]);
  await wait(50);
  assert.strictEqual(x.probes.length, 0, 'Not now: no test');
  assert.strictEqual(x.shown.length, 1, 'no setup hint beside it (ffmpeg is installed)');
  // At most once per session, also for another file.
  await x.s.send(slow); await x.s.send(slow);
  const s2 = x.h.open(clip);
  await s2.send(slow); await s2.send(slow);
  await wait(150);
  assert.strictEqual(x.offers().length, 1, 'once per session');
  assert.strictEqual(x.h.context.globalState.get(decide.PROBE_OFFER_KEY).never, undefined);
  x.s.panel.dispose(); s2.panel.dispose(); x.h.dispose();

  // "Run test": the probe runs (with its progress notification).
  x = await session({ answer: 'Run test' });
  await x.s.send({ ...slow, ratio: 0.2 });
  await until(() => x.probes.length);
  assert.deepStrictEqual(x.probes, ['Video Preview: testing ffmpeg on this computer'], 'Run test runs the probe');
  await wait(50);
  assert.match(logOf(x.h), /no GPU test yet: offering it[\s\S]*GPU test offer: Run test/);
  x.s.panel.dispose(); x.h.dispose();

  // A test record for this ffmpeg: no offer.
  x = await session({ answer: 'Run test', before: (h) => h.context.globalState.update('videoPreviewEnhanced.probe', record) });
  await x.s.send(slow); await x.s.send(slow); await wait(200);
  assert.strictEqual(x.offers().length + x.probes.length, 0, 'record exists: no offer');
  x.s.panel.dispose(); x.h.dispose();

  // Remote and untrusted windows: no offer.
  for (const o of [{ remote: 'ssh-remote' }, { remote: 'wsl' }, { trusted: false }]) {
    x = await session({ answer: 'Run test', ...o });
    await x.s.send(slow); await x.s.send(slow); await wait(200);
    assert.strictEqual(x.offers().length + x.probes.length, 0, `no offer: ${JSON.stringify(o)}`);
    x.s.panel.dispose(); x.h.dispose();
  }

  // "Don't remind me" is kept across sessions.
  const state = new Map();
  x = await session({ answer: "Don't remind me", state });
  await x.s.send(slow); await x.s.send(slow);
  await until(() => x.offers().length);
  await wait(50);
  assert.strictEqual(state.get(decide.PROBE_OFFER_KEY).never, true);
  assert.strictEqual(x.probes.length, 0);
  x.s.panel.dispose(); x.h.dispose();
  x = await session({ answer: 'Run test', state });
  await x.s.send(slow); await x.s.send(slow); await wait(200);
  assert.strictEqual(x.offers().length + x.probes.length, 0, "Don't remind me respected");
  x.s.panel.dispose(); x.h.dispose();

  // Native ffmpeg behind real time (no record: the vendor's method): offered too; a built-in sample
  // left over from before the switch says nothing.
  x = await session({ answer: 'Not now', decoder: 'ffmpeg' });
  await x.s.send({ type: 'ready' });
  await x.s.until((p) => p.some((m) => m.type === 'libav'), 15000);
  assert.strictEqual(x.s.posted.find((m) => m.type === 'libav').meta.native, true, 'native ffmpeg plays it');
  await x.s.send(slow); await x.s.send(slow); await wait(200);
  assert.strictEqual(x.offers().length, 0, 'a built-in sample in a native tab is ignored');
  await x.s.send({ ...slow, native: true }); await x.s.send({ ...slow, native: true });
  await until(() => x.offers().length);
  assert.strictEqual(x.offers().length, 1, 'native behind: offered');
  assert.match(logOf(x.h), /native ffmpeg below real time: 0\.70x/);
  x.s.panel.dispose(); x.h.dispose();

  console.log('gpu offer: ok');
})().catch((e) => { console.error(e); process.exit(1); });
