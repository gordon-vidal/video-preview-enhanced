'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const Controls = require('../../media/controls');
const Scopes = require('../../media/scopes');

const source = fs.readFileSync(path.join(__dirname, '../../media/player.js'), 'utf8');
// Run the real handlers with a delayed decoder and just the elements they update.
function script(from, to) {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start);
  assert.ok(start >= 0 && end > start, from);
  return source.slice(start, end);
}
const noop = () => {};
function element(parent) {
  const listeners = {};
  const attributes = {};
  return {
    attributes, hidden: true, dataset: {}, style: {}, children: [], classList: { toggle: noop },
    addEventListener(type, fn) { listeners[type] = fn; },
    dispatch(type, event = {}) {
      let stopped = false;
      listeners[type]?.({ preventDefault: noop, ...event, stopPropagation() { stopped = true; } });
      if (!stopped) parent?.dispatch(type, event);
    },
    click() { this.onclick?.(); this.dispatch('click'); },
    setAttribute(name, value) { attributes[name] = value; },
    append(...children) { this.children.push(...children); },
    appendChild(child) { this.append(child); },
    get firstChild() { return this.children[0]; },
    insertBefore(child, before) { this.children.splice(this.children.indexOf(before), 0, child); },
    querySelectorAll() { return []; },
    querySelector() { return null; },
    insertAdjacentHTML: noop,
    getBoundingClientRect: () => ({ top: 200 }),
    getContext: () => ({ clearRect: noop }),
  };
}

{
  let stageClicks = 0;
  const posted = [];
  const stage = element();
  stage.addEventListener('click', () => { stageClicks++; });
  const notice = element(stage);
  const noticeClose = element(notice);
  const elements = { notice, noticeClose };
  const ui = Object.fromEntries(['seek', 'now', 'dur', 'play', 'time', 'buffered'].map((id) => [id, element()]));
  ui.play.focus = noop;
  notice.contains = () => false;
  const player = {
    meta: { duration: 20 }, fps: 10, shownT: 9, remoteStream: true,
    rel: (t) => t, isPlaying: () => false, currentFrame: () => 90, currentTime: () => 9,
    seekFrame(frame) { this.seekTarget = frame / this.fps; },
    bufferedRanges: () => [],
  };
  let scopesOpen = true;
  let inspectorOpen = true;
  const document = element();
  const ctx = vm.createContext({
    ui, player, document, performance, timeMode: 0, pendingSeekFrame: null, lastSeekAt: 0, wakeLoop: noop,
    fmtClock: String, fmtTime: String, toast: noop, announce: noop, drawAB: noop,
    vscode: { postMessage: (m) => posted.push(m.type), getState: () => ({}), setState: noop },
    $: (id) => (elements[id] ||= element(notice)), self: { VpeAbLoop: require('../../media/abloop') },
    saved: {}, VpeSlowNotice: require('../../media/slow-notice'),
    controls: { anyOpen: () => false, refresh: noop }, cfg: {},
    VpeModes: { ownsKey: () => false },
    scopes: { mode: () => scopesOpen, close() { scopesOpen = false; } },
    insp: { onKey(e) { if (e.key !== 'Escape' || !inspectorOpen) return false; inspectorOpen = false; return true; } },
    addHint: { hidden: true },
  });
  vm.runInContext([
    script('  function showNotice(n)', '  /**\n   * Pixel tools'),
    script('  let scrubbing = false;', '  // Decoder status'),
    script('  // Decoder status', '  let wake ='),
    script("  ui.seek.addEventListener('input'", '  // Hover tip:'),
    script('  const ab = ', '  function abLabel()'),
    script('  function sendRange(', '  /**\n   * Shows frame'),
    script("  document.addEventListener('keydown'", "    if (e.key === '?'") + '\n  });',
  ].join('\n'), ctx);
  for (const sentDuringDrag of [false, true]) {
    ui.seek.value = '20';
    ui.seek.dispatch('input');
    if (sentDuringDrag) vm.runInContext('player.seekFrame(pendingSeekFrame); pendingSeekFrame = null;', ctx);
    ui.seek.dispatch('change');
    vm.runInContext('updateUi()', ctx);
    assert.strictEqual(ui.seek.value, '20');
    assert.strictEqual(ui.now.textContent, '2');
    player.seekTarget = null;
    vm.runInContext('updateUi()', ctx);
    assert.strictEqual(player.seekGoalFrame, null);
    assert.strictEqual(ui.seek.value, '90', 'the readout returns to the decoded frame when the seek settles');
  }
  ui.seek.value = '10';
  ui.seek.dispatch('input');
  ui.seek.dispatch('change');
  vm.runInContext("setAB('a')", ctx);
  player.shownT = 11;
  vm.runInContext("setAB('b')", ctx);
  assert.strictEqual(notice.hidden, true, 'marking a transcoded range is quiet');
  assert.strictEqual(vm.runInContext('ab.presentationRange().a', ctx), 9, 'marks use the shown frame during a seek');
  vm.runInContext("sendRange('clipRange')", ctx);
  assert.strictEqual(notice.hidden, false, 'the refusal appears on export');
  elements.noticeAction.click();
  assert.deepStrictEqual(posted, ['action']);
  assert.strictEqual(notice.hidden, true);
  assert.strictEqual(stageClicks, 0);
  vm.runInContext("sendRange('clipRange')", ctx);
  document.dispatch('keydown', { key: 'Escape' });
  assert.strictEqual(notice.hidden, true);
  assert.strictEqual(stageClicks, 0);
  document.dispatch('keydown', { key: 'Escape' });
  assert.strictEqual(inspectorOpen, false);
  document.dispatch('keydown', { key: 'Escape' });
  assert.strictEqual(scopesOpen, false);

  player.status = () => ({ slowNotice: 'every' });
  const updateStatus = () => vm.runInContext('updateStatus()', ctx);
  ctx.cfg.hideSlowPlaybackNotice = true;
  updateStatus();
  assert.strictEqual(notice.hidden, true);
  ctx.cfg.hideSlowPlaybackNotice = false;
  updateStatus();
  assert.strictEqual(elements.noticeAction.textContent, 'Skip frames (all videos)');
  assert.strictEqual(elements.noticeSettings.textContent, 'Settings');
  assert.strictEqual(elements.noticeHide.textContent, "Don't show again");
  document.dispatch('keydown', { key: 'Escape' });
  assert.strictEqual(notice.hidden, true);
  player.status = () => ({ slowNotice: 'setupFfmpeg' });
  updateStatus();
  assert.strictEqual(notice.hidden, true, 'Escape dismisses slow-playback notices for the tab');
  assert.strictEqual(stageClicks, 0);
}

{
  const events = [];
  const stage = element();
  stage.addEventListener('click', () => events.push('stage click'));
  const originals = { document: globalThis.document, window: globalThis.window };
  try {
    globalThis.document = { createElement: () => element(), createDocumentFragment: () => element() };
    globalThis.window = { innerHeight: 400, addEventListener: noop };
    const scopes = Scopes.create({ stage, canvas: element(), getPlayer: () => null, toast: (t) => events.push(t),
      log: noop, returnFocus: () => events.push('focus') });
    const [overlay] = stage.children;
    const close = overlay.children[0].children[1];
    assert.strictEqual(close.attributes['aria-label'], 'Close scopes');
    scopes.cycle();
    globalThis.document.activeElement = close;
    close.dispatch('click');
    assert.strictEqual(scopes.mode(), null);
    assert.ok(overlay.hidden);
    assert.deepStrictEqual(events.slice(1), ['Scopes off', 'focus']);

    const panel = element();
    const buttons = Object.fromEntries(['cog', 'info', 'rate', 'tracks', 'cmp'].map((key) => [key, element()]));
    const views = Object.fromEntries(['info', 'speed', 'subs', 'cmp'].map((view) => [
      view, { label: view, render: () => element() },
    ]));
    const controls = Controls.create({
      panel, sheet: element(), bar: element(), buttons, views, act: {},
      get: () => ({ rate: 1, jump: {}, tools: [], transcode: { mode: 'ask', maxBitrateMbps: 0 } }),
    });
    for (const [view, button] of [['info', 'info'], ['speed', 'rate'], ['subs', 'tracks'], ['cmp', 'cmp']]) {
      controls.toggle(view, buttons[button]);
      controls.toggle('main', buttons.cog);
      assert.strictEqual(controls.view(), 'main', `Settings opens directly from ${view}`);
      assert.strictEqual(buttons.cog.attributes['aria-expanded'], 'true');
    }
    controls.show('transcode');
    const notes = panel.children.at(-1).children.filter((child) => child.className === 'pnote');
    assert.match(notes[0].textContent, /Default for all videos on this machine.*reload/);
    assert.match(notes[1].textContent, /automatically fetch full-resolution source frames/);
  } finally {
    Object.assign(globalThis, originals);
  }
}
