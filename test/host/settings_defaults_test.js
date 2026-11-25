'use strict';

const assert = require('assert');
const { configuration } = require('../../package.json').contributes;
const { createSettings } = require('../../src/settings');
const transcodePolicy = require('../../src/transcode_policy');
const { makeVscode } = require('./mock_vscode');

const section = 'videoPreviewEnhanced';
const make = (vscode) => createSettings({
  vscode, transcodePolicy, getState: () => undefined, log: () => {}, sessions: [], compareSessions: [],
}).config();
const vscode = makeVscode();
const cfg = vscode.workspace.getConfiguration(section);
const resolved = make(vscode);
const fallback = make({ workspace: { getConfiguration: () => ({ get: (_key, dflt) => dflt }) } });
const manifest = Object.assign({}, ...[configuration].flat().map((c) => c.properties));

function settingValues(config) {
  const { fastWhenBehind, railLayout, jumps, nativeMaxAuto, nativeMaxHeight, ...rest } = config;
  return {
    ...rest,
    ...jumps,
    fastPreviewWhenBehind: fastWhenBehind,
    'folderRail.layout': railLayout,
    nativeMaxHeight: nativeMaxAuto ? 0 : nativeMaxHeight,
    // The deprecated loop flag is unset when autoplay stops at the end.
    loop: config.onEnd === 'loop',
  };
}

// These settings are resolved by Compare or file associations, or are deprecated and ignored.
const otherDefaults = { advancedMode: false, 'compare.openTogether': true, 'compare.maxVideos': 8, overrideFileIcons: true };
assert.deepStrictEqual(resolved, fallback, 'the host fallback and manifest-backed configuration must agree');
const expected = { ...settingValues(fallback), ...otherDefaults };
assert.deepStrictEqual(Object.keys(manifest).sort(), Object.keys(expected).map((k) => section + '.' + k).sort());
for (const [key, value] of Object.entries(expected)) {
  assert.deepStrictEqual(cfg.get(key, Symbol()), value, key);
  assert.deepStrictEqual(cfg.inspect(key), { defaultValue: value, globalValue: undefined }, key);
}
assert.strictEqual(resolved.nativeMaxHeight, 1080, 'automatic native height uses the postMessage cap');

console.log('settings defaults contract: ok');
