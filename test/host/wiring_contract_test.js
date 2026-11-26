'use strict';
// node test/run.js unit --grep wiring_contract: static wiring-completeness checks for the unified viewer.
// Ensures interactive elements rendered by src/unified-html.js + src/bar.js and host message handlers in
// src/unified-session.js stay wired in media/, and catches leftover mockup stubs and demo data in media/player-ui.js.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { unifiedHtml } = require('../../src/unified-html');

const ROOT = path.join(__dirname, '..', '..');
const MEDIA = path.join(ROOT, 'media');

const mediaJs = fs.readdirSync(MEDIA)
  .filter((f) => f.endsWith('.js'))
  .map((f) => fs.readFileSync(path.join(MEDIA, f), 'utf8'))
  .join('\n');

{ // Every interactive control ID (<button id="...">, <input id="...">, <select id="...">) emitted by unifiedHtml()
  // must be referenced somewhere in media/*.js (no orphaned UI controls).
  const html = unifiedHtml({
    cspSource: 'vscode-webview://x',
    uri: (p) => `https://x/${p}`,
    base: 'https://x/libav',
    loader: 'libav.js',
    nonce: 'n',
    cfg: {},
    canCompare: true,
    compareOpen: false,
    folder: true,
    entryScript: 'player-unified.js',
  });
  const ids = [...html.matchAll(/<(?:button|input|select)\b[^>]*\bid="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(ids.length >= 20, `expected >= 20 interactive controls, found ${ids.length}`);
  const missing = ids.filter((id) => !new RegExp(`['"#]${id}\\b`).test(mediaJs));
  assert.deepStrictEqual(missing, [], `unwired interactive HTML IDs in unifiedHtml(): ${missing.join(', ')}`);
}

{ // Every page-to-host message `case '...'` handled by src/unified-session.js must have a sender in media/*.js.
  const sessionSrc = fs.readFileSync(path.join(ROOT, 'src', 'unified-session.js'), 'utf8');
  const cases = [...new Set([...sessionSrc.matchAll(/case\s+'([a-zA-Z0-9_-]+)'\s*:/g)].map((m) => m[1]))];
  assert.ok(cases.length >= 20, `expected >= 20 session message cases, found ${cases.length}`);
  // 'readBlock' is sent dynamically by the libav worker bridge; every other case is posted literally from media/*.js.
  const DYNAMIC_SENDERS = new Set(['readBlock']);
  const missing = cases.filter((c) => !DYNAMIC_SENDERS.has(c) && !new RegExp(`['"]${c}['"]`).test(mediaJs));
  assert.deepStrictEqual(missing, [], `session message cases with no sender in media/*.js: ${missing.join(', ')}`);
}

{ // No mockup-era stubs or demo data left in media/player-ui.js: canExternal is not hardcoded false, and the mock-up's
  // demo tracks live in tools/mockup/, not in the production controller.
  const uiSrc = fs.readFileSync(path.join(MEDIA, 'player-ui.js'), 'utf8');
  assert.ok(!/\bcanExternal\s*:\s*false\b/.test(uiSrc), 'canExternal must not be hardcoded false');
  for (const demo of ['Director Commentary', 'English (AAC 2.0)', 'English (SRT)', 'Audio track switched']) {
    assert.ok(!uiSrc.includes(demo), `mock-up demo string in media/player-ui.js: ${demo}`);
  }
}

{ // Behaviour, not source text: the ⚙ panel's Live transcode actions post to the host (a mock-up stub would only
  // change local prefs). The real controller is mounted on the production markup with a VpeControls that records the
  // actions it is handed, and each action is run.
  const S = require('../../media/player-state');
  const PUI = require('../../media/player-ui');
  const { createFakeEngine } = require('../../tools/mockup/fake-engine');
  const { createFakeHost } = require('../../tools/mockup/fake-host');
  const { stageMarkupHtml } = require('../../tools/mockup/render');
  const { createDom, Element: FakeElement, Node: FakeNode } = require('./fake-dom');
  const dom = createDom(stageMarkupHtml());
  const GLOBALS = {
    document: dom.doc, window: dom.win, innerWidth: dom.win.innerWidth, innerHeight: dom.win.innerHeight,
    matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
    requestAnimationFrame: () => 0, cancelAnimationFrame: () => {}, Element: FakeElement, HTMLElement: FakeElement, Node: FakeNode,
  };
  const saved = Object.fromEntries(Object.keys(GLOBALS).map((k) => [k, Object.getOwnPropertyDescriptor(global, k)]));
  Object.assign(global, GLOBALS);
  try {
    const Controls = require('../../media/controls');
    /** @type {any} */ let act = null;
    const recording = { ...Controls, create: (o) => { act = o.act; return Controls.create(o); } };
    const engine = createFakeEngine();
    const host = createFakeHost({ clips: engine.clips });
    const ui = PUI.create({
      doc: dom.doc, win: dom.win, stateApi: S, engine: { ...engine, draw() {} }, host, tickMs: 0,
      widgets: {
        VpeControls: recording, VpeFolderRail: require('../../media/folder-rail'), VpeCtxMenu: require('../../media/ctxmenu'),
        VpeAbLoop: require('../../media/abloop'), VpeAutoplay: require('../../media/autoplay'), VpeTime: require('../../media/timefmt'),
      },
    });
    assert.ok(act, 'player-ui.js hands VpeControls its actions');
    const calls = { setTranscode: 'off', setTranscodeMaxBitrate: 8, setTranscodeResolution: 720, saveTranscodeResolution: 1080 };
    for (const [fn, arg] of Object.entries(calls)) {
      assert.strictEqual(typeof act[fn], 'function', `${fn} is a ⚙ panel action`);
      const before = host.log.length;
      act[fn](arg);
      const posted = host.log.slice(before).filter((m) => /^transcode/.test(m.type));
      assert.ok(posted.length > 0, `${fn} posts to the host (got ${JSON.stringify(host.log.slice(before))})`);
    }
    if (typeof ui.dispose === 'function') ui.dispose();
  } finally {
    for (const [k, d] of Object.entries(saved)) { if (d) Object.defineProperty(global, k, d); else delete global[k]; }
  }
}

console.log('wiring_contract: ok');
