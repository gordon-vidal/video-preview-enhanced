'use strict';
// node test/host/onboarding_test.js: the first-open popup (src/extension.js maybeOnboard, with
// the mock vscode): the first video of each session without ffmpeg; "Set up ffmpeg" runs the setup
// flow, "Not now" asks again next session, "Don't Show Again" is final; never in
// SSH or untrusted windows, nor when ffmpeg is found (VPE_FFMPEG or PATH; that part is skipped without one).
const assert = require('assert');
const path = require('path');
const ff = require('../../src/ffmpeg');
const d = require('../../src/decide');
const { load } = require('./mock_vscode');

const clip = path.join(__dirname, '..', '..', 'media', 'probe', 'hevc_10_2160.mkv');
const none = { 'videoPreviewEnhanced.ffmpegPath': path.join(__dirname, 'no-such-ffmpeg.exe') }; // ffmpeg "not installed"
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const isOnboard = (a) => a[1] === d.ONBOARD_SETUP;

async function start({ answer, remote, trusted = true, settings = none, state } = {}) {
  const h = load({ settings, ...(state ? { state: new Map(Object.entries(state)) } : {}) });
  const shown = [];
  let setupRan = false;
  h.vscode.window.showInformationMessage = async (...a) => { shown.push(a); return isOnboard(a) ? answer : undefined; };
  h.vscode.window.withProgress = (o) => { if (/checking this computer/.test(o.title)) setupRan = true; return new Promise(() => {}); };
  h.vscode.env.remoteName = remote;
  h.vscode.workspace.isTrusted = trusted;
  const openOne = async () => {
    const s = h.open(clip);
    await s.send({ type: 'ready' });
    await s.until((p) => p.some((m) => m.type === 'libav'), 15000);
    await wait(50);
    return s;
  };
  return { h, shown, openOne, setupRan: () => setupRan };
}

(async () => {
  // Pure rule.
  const base = { state: undefined, toolsInstalled: false, remote: undefined, trusted: true, pending: false };
  assert.strictEqual(d.shouldOnboard(base), true);
  assert.strictEqual(d.shouldOnboard({ ...base, remote: 'wsl' }), true, 'WSL: native ffmpeg works there');
  for (const c of ['dismissed', 'later', 'ffmpeg', 'had-ffmpeg']) assert.strictEqual(d.shouldOnboard({ ...base, state: { choice: c } }), true, `asked again after ${c}`);
  for (const over of [{ state: { choice: 'builtin' } }, { shownThisSession: true }, { toolsInstalled: true }, { remote: 'ssh-remote' }, { remote: 'dev-container' }, { trusted: false }, { pending: true }]) {
    assert.strictEqual(d.shouldOnboard({ ...base, ...over }), false, JSON.stringify(over));
  }
  assert.strictEqual(d.afterOnboard(d.ONBOARD_SETUP, 1).choice, 'ffmpeg');
  assert.strictEqual(d.afterOnboard(d.ONBOARD_BUILTIN, 1).choice, 'builtin');
  assert.strictEqual(d.afterOnboard(d.ONBOARD_LATER, 1).choice, 'later');
  assert.strictEqual(d.afterOnboard(undefined, 1).choice, 'dismissed');

  // First video: asked, with the three choices; "Don't Show Again" is final.
  let x = await start({ answer: d.ONBOARD_BUILTIN });
  let s = await x.openOne();
  assert.strictEqual(x.shown.filter(isOnboard).length, 1);
  const q = x.shown.find(isOnboard);
  assert.match(q[0], /^Video Preview works best with ffmpeg: .*Set it up now\?$/);
  assert.doesNotMatch(q[0], /download|MB/i, 'the first popup never mentions a download');
  assert.deepStrictEqual(q.slice(1), ['Set up ffmpeg', 'Not now', "Don't Show Again"]);
  assert.strictEqual(x.h.context.globalState.get(d.ONBOARD_KEY).choice, 'builtin');
  s.panel.dispose();
  s = await x.openOne();
  assert.strictEqual(x.shown.filter(isOnboard).length, 1, 'second video: not again');
  assert.ok(!x.setupRan());
  s.panel.dispose(); x.h.dispose();

  // "Not now": not again this session, asked again in the next one.
  x = await start({ answer: d.ONBOARD_LATER });
  s = await x.openOne();
  s.panel.dispose();
  s = await x.openOne();
  assert.strictEqual(x.shown.filter(isOnboard).length, 1, 'Not now: once per session');
  assert.strictEqual(x.h.context.globalState.get(d.ONBOARD_KEY).choice, 'later');
  s.panel.dispose(); x.h.dispose();
  x = await start({ answer: d.ONBOARD_LATER, state: { [d.ONBOARD_KEY]: { at: 1, choice: 'later' } } });
  s = await x.openOne();
  assert.strictEqual(x.shown.filter(isOnboard).length, 1, 'Not now: asked again next session');
  s.panel.dispose(); x.h.dispose();

  // "Set up ffmpeg" runs the setup flow.
  x = await start({ answer: d.ONBOARD_SETUP });
  s = await x.openOne();
  assert.ok(x.setupRan(), 'Set up: the setup flow');
  assert.strictEqual(x.h.context.globalState.get(d.ONBOARD_KEY).choice, 'ffmpeg');
  s.panel.dispose(); x.h.dispose();

  // Never in SSH or untrusted windows.
  for (const o of [{ remote: 'ssh-remote' }, { trusted: false }]) {
    x = await start(o);
    s = await x.openOne();
    assert.strictEqual(x.shown.filter(isOnboard).length, 0, JSON.stringify(o));
    s.panel.dispose(); x.h.dispose();
  }

  // ffmpeg found: not asked.
  const tools = await ff.locateTools(process.env.VPE_FFMPEG || '', '');
  if (tools) {
    x = await start({ settings: { 'videoPreviewEnhanced.ffmpegPath': tools.ffmpeg } });
    s = await x.openOne();
    assert.strictEqual(x.shown.filter(isOnboard).length, 0, 'ffmpeg found');
    assert.strictEqual(x.h.context.globalState.get(d.ONBOARD_KEY).choice, 'had-ffmpeg');
    s.panel.dispose(); x.h.dispose();
  }
  await wait(10);
  console.log(`onboarding: ok${tools ? '' : ' (ffmpeg-found part skipped)'}`);
})().catch((e) => { console.error(e); process.exit(1); });
