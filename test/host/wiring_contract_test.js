'use strict';
// node test/run.js unit --grep wiring_contract: static wiring-completeness checks for the unified viewer.
// Ensures interactive elements rendered by src/unified-html.js + src/bar.js and host message handlers in
// src/unified-session.js stay wired in media/, and catches leftover mockup stubs in media/player-ui.js.
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
  // Legacy Compare bar buttons emitted by src/bar.js when compareOpen=true are unused in the unified page
  // (which creates its own Compare buttons in media/player-ui.js). Everything else must be wired.
  const LEGACY_BAR = new Set(['addPopBtn', 'layoutGridBtn', 'layoutSplitBtn', 'layoutSpotlightBtn', 'syncModeBtn']);
  const missing = ids.filter((id) => !LEGACY_BAR.has(id) && !new RegExp(`['"#]${id}\\b`).test(mediaJs));
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

{ // No mockup-era stubs left in media/player-ui.js: canExternal must not be hardcoded false, and transcode
  // actions must post to the host rather than only mutating local prefs.
  const uiSrc = fs.readFileSync(path.join(MEDIA, 'player-ui.js'), 'utf8');
  assert.ok(!/\bcanExternal\s*:\s*false\b/.test(uiSrc), 'canExternal must not be hardcoded false');
  for (const fn of ['setTranscode', 'setTranscodeMaxBitrate', 'setTranscodeResolution', 'saveTranscodeResolution']) {
    const m = new RegExp(`${fn}\\s*:\\s*\\([^)]*\\)\\s*=>\\s*\\{([^}]*)\\}`).exec(uiSrc);
    assert.ok(m, `${fn} handler exists in media/player-ui.js`);
    assert.ok(/postHost\s*\(/.test(m[1]), `${fn} posts to host (not a mockup-only stub)`);
  }
}

console.log('wiring_contract: ok');
