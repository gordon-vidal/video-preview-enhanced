'use strict';
// node test/run.js unit --grep webview_ui_build: the webview UI bundle (ADR 0004 Phase 0). media/dist/webview-ui.js is
// built from media/ui/ by tools/build-ui.js, committed, and loaded by the unified page and the mockup harness. It
// must be current, run in a bare browser-like context (no node_modules, no require) and expose VpeWebviewUi.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { spawnSync } = require('child_process');
const { unifiedHtml, UNIFIED_SCRIPTS } = require('../../src/unified-html');
const { buildMockupHtml } = require('../../tools/mockup/render');

const ROOT = path.join(__dirname, '..', '..');
const BUNDLE = path.join(ROOT, 'media', 'dist', 'webview-ui.js');

{ // The committed bundle is what a fresh build produces.
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'build-ui.js'), '--check'], { cwd: ROOT, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, `build-ui --check: ${r.stderr}${r.stdout}`);
}

{ // It runs as a classic script in a context with no module system and exposes the typed bridge.
  const context = vm.createContext({ console });
  vm.runInContext(fs.readFileSync(BUNDLE, 'utf8'), context, { filename: 'webview-ui.js' });
  const ui = context.VpeWebviewUi;
  assert.ok(ui, 'VpeWebviewUi is a global');
  assert.strictEqual(ui.ready, true);
  for (const name of ['h', 'render', 'signal', 'computed', 'effect', 'computePosition', 'flip', 'shift', 'offset', 'autoUpdate']) {
    assert.strictEqual(typeof ui[name], 'function', `${name} is exported`);
  }
  // Signals work without a DOM: a computed follows its signal and an effect re-runs on change.
  const count = ui.signal(1);
  const double = ui.computed(() => count.value * 2);
  const seen = [];
  const stop = ui.effect(() => { seen.push(double.value); });
  count.value = 5;
  stop();
  assert.deepStrictEqual(seen, [2, 10]);
  // Preact's h builds a vnode with the tag and props.
  const vnode = ui.h('button', { id: 'x' }, 'Go');
  assert.strictEqual(vnode.type, 'button');
  assert.strictEqual(vnode.props.id, 'x');
  assert.ok(!/\brequire\(|node:/.test(fs.readFileSync(BUNDLE, 'utf8')), 'no Node module references');
}

{ // Both pages load it, after the decoder base and before the scripts that may use it.
  const nonce = 'N0NCE';
  const html = unifiedHtml({
    cspSource: 'vsc-src:', uri: (...p) => `vsc:/media/${p.join('/')}`, base: 'vsc:/build', loader: 'libav-vpe.js', nonce,
    cfg: {}, sequence: false, framePort: 0, transport: 'message', debug: false,
  });
  assert.ok(UNIFIED_SCRIPTS.includes('dist/webview-ui.js'));
  assert.ok(html.includes(`<script nonce="${nonce}" src="vsc:/media/dist/webview-ui.js"></script>`));
  assert.ok(UNIFIED_SCRIPTS.indexOf('dist/webview-ui.js') > UNIFIED_SCRIPTS.indexOf('frame-player.js'));

  const mock = buildMockupHtml({});
  assert.ok(mock.includes('<script data-src="media/dist/webview-ui.js">'), 'the mockup inlines the bundle');
  assert.ok(mock.indexOf('media/dist/webview-ui.js') < mock.indexOf('media/ui-primitives.js'));
}
