'use strict';
// node test/run.js unit --grep floating_overlay: the overlay engine of the webview UI bundle (media/ui/floating.ts,
// ADR 0004 phase 1), loaded as the page does (the built classic script in a bare context) over small stand-in elements.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const BUNDLE = path.join(__dirname, '..', '..', 'media', 'dist', 'webview-ui.js');

function load() {
  const context = vm.createContext({ console });
  vm.runInContext(fs.readFileSync(BUNDLE, 'utf8'), context, { filename: 'webview-ui.js' });
  return context.VpeWebviewUi;
}

/** An element with the members floating.ts reads. `popover` adds the Popover API (state in `open`). */
function surface({ popover = false, size = { width: 200, height: 160 }, viewport = { width: 800, height: 600 } } = {}) {
  const attrs = new Map();
  const el = {
    hidden: false,
    open: false,
    calls: [],
    style: {},
    offsetWidth: size.width,
    offsetHeight: size.height,
    ownerDocument: {
      documentElement: { clientWidth: viewport.width, clientHeight: viewport.height },
      defaultView: { innerWidth: viewport.width, innerHeight: viewport.height },
    },
    getBoundingClientRect: () => ({ x: 0, y: 0, left: 0, top: 0, right: size.width, bottom: size.height, ...size }),
    hasAttribute: (n) => attrs.has(n),
    setAttribute: (n, v) => attrs.set(n, String(v)),
    removeAttribute: (n) => attrs.delete(n),
    getAttribute: (n) => (attrs.has(n) ? attrs.get(n) : null),
    matches: (sel) => {
      if (sel !== ':popover-open') throw new Error(`unsupported ${sel}`);
      return el.open;
    },
  };
  if (popover) {
    el.showPopover = () => {
      el.calls.push('show');
      if (el.open) throw new Error('InvalidStateError: already open');
      if (!attrs.has('popover')) throw new Error('NotSupportedError: not a popover');
      el.open = true;
    };
    el.hidePopover = () => {
      el.calls.push('hide');
      if (!el.open) throw new Error('InvalidStateError: not open');
      el.open = false;
    };
  }
  return el;
}

test('showTopLayer / hideTopLayer promote with popover="manual" and never throw', () => {
  const ui = load();
  const el = surface({ popover: true });
  assert.equal(ui.showTopLayer(el), true);
  assert.equal(el.getAttribute('popover'), 'manual');
  assert.equal(el.open, true);
  assert.equal(ui.showTopLayer(el), true, 'already open: still true, no second showPopover');
  assert.deepEqual(el.calls, ['show']);
  ui.hideTopLayer(el);
  assert.equal(el.open, false);
  ui.hideTopLayer(el);
  assert.deepEqual(el.calls, ['show', 'hide'], 'already closed: no second hidePopover');
  assert.equal(ui.showTopLayer(el), true, 'it opens again');
  assert.equal(el.open, true);
});

test('showTopLayer / hideTopLayer are no-ops without the Popover API', () => {
  const ui = load();
  const el = surface();
  assert.equal(ui.showTopLayer(el), false);
  assert.equal(el.hasAttribute('popover'), false, 'no popover attribute that would hide it by UA rules');
  assert.doesNotThrow(() => ui.hideTopLayer(el));
});

test('showTopLayer falls back to a plain element when the browser refuses', () => {
  const ui = load();
  const el = surface({ popover: true });
  el.showPopover = () => { throw new Error('NotSupportedError'); };
  assert.equal(ui.showTopLayer(el), false);
  assert.equal(el.hasAttribute('popover'), false);
  el.matches = () => { throw new Error('unknown selector'); }; // an engine without :popover-open
  el.hidePopover = () => { throw new Error('boom'); };
  assert.doesNotThrow(() => ui.hideTopLayer(el));
});

test('positionAtPoint sets the clamped viewport position at once', () => {
  const ui = load();
  const el = surface();
  for (const [x, y, left, top] of [
    [40, 50, 40, 50],
    [-5, -10, 4, 4],
    [800, 600, 800 - 200 - 4, 600 - 160 - 4],
  ]) {
    ui.positionAtPoint(el, x, y);
    assert.equal(el.style.left, `${left}px`);
    assert.equal(el.style.top, `${top}px`);
  }
  ui.positionAtPoint(el, 0, 0, { padding: 10 });
  assert.equal(el.style.left, '10px');
  assert.equal(el.style.top, '10px');
});

test('positionAnchored returns a cleanup that is safe to call twice and drops late answers', async () => {
  const ui = load();
  const el = surface();
  const anchor = { getBoundingClientRect: () => ({ x: 100, y: 500, left: 100, top: 500, right: 140, bottom: 530, width: 40, height: 30 }) };
  const stop = ui.positionAnchored(anchor, el, { placement: 'top', axis: 'x', autoUpdate: false });
  assert.equal(typeof stop, 'function');
  stop();
  stop();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(el.style.left, undefined, 'a stopped placement writes nothing');
  assert.equal(el.style.top, undefined);
  // With observers unavailable in the runtime, the default (autoUpdate) still returns a working cleanup.
  const stop2 = ui.positionAnchored(anchor, surface());
  assert.doesNotThrow(() => { stop2(); stop2(); });
});
