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
    contains(node) { return node === this; },
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

// The [ ] buttons and pin drags: wired in both pages, and the pressed state follows the range.
{
  const attrs = () => { const a = {}; return { a, setAttribute: (k, v) => { a[k] = v; } }; };
  const btnA = attrs(), btnB = attrs();
  const ab = require('../../media/abloop').create();
  const pressedNow = () => { Controls.drawRangeButtons(btnA, btnB, ab); return [btnA.a['aria-pressed'], btnB.a['aria-pressed']]; };
  assert.deepStrictEqual(pressedNow(), ['false', 'false']);
  ab.set('a', 1, 10);
  assert.deepStrictEqual(pressedNow(), ['true', 'false']);
  ab.set('b', 2, 20);
  assert.deepStrictEqual(pressedNow(), ['true', 'true']);
  ab.set('a', 5, 50); // the same end again clears it
  assert.deepStrictEqual(pressedNow(), ['false', 'true']);

  const compareSource = fs.readFileSync(path.join(__dirname, '../../media/compare.js'), 'utf8');
  for (const [name, src] of [['player', source], ['compare', compareSource]]) {
    assert.match(src, /ui\.setABtn\.onclick = \(\) => (setAB|markAB)\('a'\)/, `${name}: [ sets A`);
    assert.match(src, /ui\.setBBtn\.onclick = \(\) => (setAB|markAB)\('b'\)/, `${name}: ] sets B`);
    assert.match(src, /VpeAbLoop\.bindPin\(pin, which,/, `${name}: the pins can be dragged`);
    assert.match(src, /ab\.reset\(w, [^)]*snap\.f,/, `${name}: a drag commits the snapped frame`);
    assert.match(src, /drawRangeButtons\(ui\.setABtn, ui\.setBBtn, ab\)/, `${name}: the buttons follow the range`);
  }
  const css = fs.readFileSync(path.join(__dirname, '../../media/player.css'), 'utf8');
  assert.match(css, /\.ab-pin \{[^}]*pointer-events: auto;[^}]*cursor: ew-resize;/, 'pins take the mouse');
  assert.match(css, /@media \(max-width: 640px\) \{\s*#row button\.rng, #row #infoBtn, #row #time #dur \{ display: none; \}/, 'range buttons hide on narrow panes');
  // The A / B buttons show their key letters (like the seek bar's pins), not an icon.
  const bar = fs.readFileSync(path.join(__dirname, '../../src/bar.js'), 'utf8');
  assert.match(bar, /aria-keyshortcuts="A">\$\{rangeLabel\('A'\)\}<\/button>/);
  assert.match(bar, /aria-keyshortcuts="B">\$\{rangeLabel\('B'\)\}<\/button>/);
}

{
  let stageClicks = 0;
  const posted = [];
  const stage = element();
  stage.addEventListener('click', () => { stageClicks++; });
  const notice = element(stage);
  const noticeClose = element(notice);
  const elements = { notice, noticeClose };
  const ui = Object.fromEntries(['seek', 'now', 'dur', 'play', 'time', 'buffered', 'setABtn', 'setBBtn', 'abA', 'abB', 'tip'].map((id) => [id, element()]));
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
    ui, player, document, performance, timeMode: 0, wakeLoop: noop,
    VpeRangeDrag: { bindSeek: (_input, handlers) => { ctx.seekHandlers = handlers; } },
    showTip: noop, hideTip: noop,
    fmtClock: String, fmtTime: String, toast: noop, announce: noop, drawAB: noop,
    vscode: { postMessage: (m) => posted.push(m.type), getState: () => ({}), setState: noop },
    $: (id) => (elements[id] ||= element(notice)), self: { VpeAbLoop: require('../../media/abloop') },
    saved: {}, VpeSlowNotice: require('../../media/slow-notice'),
    controls: { anyOpen: () => false, refresh: noop }, cfg: {},
    VpeModes: { ownsKey: () => false },
    scopes: { mode: () => scopesOpen, close() { scopesOpen = false; } },
    insp: { onKey(e) { if (e.key !== 'Escape' || !inspectorOpen) return false; inspectorOpen = false; return true; } },
    addHint: { hidden: true },
    syncEngineLoop: noop,
  });
  vm.runInContext([
    script('  function showNotice(n)', '  /**\n   * Pixel tools'),
    script('  let scrubbing = false;', '  // Decoder status'),
    script('  // Decoder status', '  let wake ='),
    script('  const seekDragger =', '  const volumeDragger ='),
    script('  const ab = ', '  function abLabel()'),
    script('  function sendRange(', '  /**\n   * Shows frame'),
    script("  document.addEventListener('keydown'", "    if (e.key === '?'") + '\n  });',
  ].join('\n'), ctx);
  ui.seek.value = '20';
  ctx.seekHandlers.preview(20);
  assert.strictEqual(ui.seek.value, '20');
  assert.strictEqual(ui.now.textContent, '2');
  assert.strictEqual(player.seekTarget, undefined, 'the drag leaves the decoder alone');
  ctx.seekHandlers.finish();
  ctx.seekHandlers.commit(20);
  assert.strictEqual(ui.seek.value, '20');
  assert.strictEqual(ui.now.textContent, '2');
  player.seekTarget = null;
  vm.runInContext('updateUi()', ctx);
  assert.strictEqual(player.seekGoalFrame, null);
  assert.strictEqual(ui.seek.value, '90', 'the readout returns to the decoded frame when the seek settles');
  ctx.seekHandlers.commit(10);
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
    const docListeners = {};
    globalThis.document = { createElement: () => element(), createDocumentFragment: () => element(), addEventListener: (t, fn) => { docListeners[t] = fn; } };
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
    const bar = element();
    const controls = Controls.create({
      panel, sheet: element(), bar, buttons, views, act: {},
      get: () => ({ rate: 1, jump: {}, tools: [], transcode: { mode: 'auto', maxBitrateMbps: 0 } }),
    });
    for (const [view, button] of [['info', 'info'], ['speed', 'rate'], ['subs', 'tracks'], ['cmp', 'cmp']]) {
      controls.toggle(view, buttons[button]);
      controls.toggle('main', buttons.cog);
      assert.strictEqual(controls.view(), 'main', `Settings opens directly from ${view}`);
      assert.strictEqual(buttons.cog.attributes['aria-expanded'], 'true');
    }
    // Click outside (media/controls.js) with the player's own stage click handler (media/player.js): pressing the
    // picture only dismisses the open panel (no play / pause); pressing a bar control closes it and the control still works.
    {
      const barControl = element(), pic = element();
      bar.contains = (n) => n === barControl;
      let toggles = 0;
      const pstage = element();
      vm.runInContext(script("stage.addEventListener('click', () => { if (controls", '\n'), vm.createContext({
        stage: pstage, controls, ctxMenu: { consumeDismiss: () => false }, togglePlay: () => { toggles++; },
      }));
      const press = (target) => docListeners.pointerdown({ target });
      for (const view of ['info', 'main']) {
        controls.show(view, buttons.info);
        press(barControl);
        assert.strictEqual(controls.anyOpen(), false, `a press on #mute / #bar closes the ${view} panel`);
        assert.strictEqual(toggles, 0);
        controls.show(view, buttons.info);
        press(pic);
        pstage.dispatch('click');
        assert.strictEqual(controls.anyOpen(), false, `a press on the picture closes the ${view} panel`);
        assert.strictEqual(toggles, 0, 'that click does not play / pause');
      }
      press(pic); pstage.dispatch('click');
      assert.strictEqual(toggles, 1, 'with nothing open a click on the picture plays / pauses');
    }
    controls.show('transcode');
    const notes = panel.children.at(-1).children.filter((child) => child.className === 'pnote');
    assert.match(notes[0].textContent, /Default for all videos on this machine.*reload/);
    assert.match(notes[1].textContent, /automatically fetch full-resolution source frames/);

    // The main page: Playback rows, then two sub-pages (A–B Range, Inspection), then the footer links.
    // No Jump sizes row or page (those are VS Code settings), no tool grid, no "Open in system player" in ⓘ.
    const ran = [];
    const tool = (label, title, key) => ({ label, title, key, group: 'inspect', run: () => ran.push(label) });
    const state = {
      rate: 1, loop: false, jump: { arrow: 5, shift: 1, ctrl: 'frame' }, abLabel: 'Off', canExternal: true,
      subsLabel: 'None in file', audioLabel: 'Only one', picture: { mode: 'fit', pct: null }, transcode: null,
      tracks: { subs: [], audio: [] }, facts: { title: 'a.mp4', sub: '', rows: [] },
      tools: [{ label: 'Compare', key: 'Shift+D', run: noop }, tool('Scopes', 'Scopes', 'W'), tool('Inspector', 'Pixel inspector', 'X'),
        tool('Stats', 'Stats', 'Shift+I'), tool('Codec X-ray', 'Codec X-ray', 'Shift+X')],
      ab: { items: [{ label: 'Export frames A–B…', run: () => ran.push('frames') }, { label: 'Export A–B Clip…', run: () => ran.push('clip') },
        { label: 'Copy ffmpeg command for A–B', run: () => ran.push('ffmpeg') }] },
    };
    const full = Controls.create({
      panel, sheet: element(), bar: element(), buttons: Object.fromEntries(['cog', 'info', 'rate', 'tracks'].map((k) => [k, element()])),
      act: { loop: noop, cycleAB: noop, copyFrame: noop, openUrl: noop, extSettings: noop, external: () => ran.push('external'), copyInfo: noop, copyLink: noop },
      get: () => state,
    });
    const labelOf = (b) => { const g = (b.children || []).find((c) => c.className === 'grow'); return g ? g.textContent : b.textContent; };
    const labels = () => panel.children.at(-1).children.map(labelOf).filter(Boolean);
    const rows = () => panel.children.at(-1).children;
    full.show('main');
    assert.deepStrictEqual(labels(), ['Playback', 'Repeat video', 'Speed', 'Subtitles', 'Audio track', 'Picture size', 'Compare', 'Copy frame',
      'Tools', 'A–B Range', 'Inspection', 'Open video URL…', 'Open in system player', 'Keyboard shortcuts', 'Extension settings']);
    // The player of a file: Autoplay (Off / Play next in folder / Loop) instead of the Repeat video switch.
    const picked = [];
    full.close?.(false);
    const auto = Controls.create({
      panel, sheet: element(), bar: element(), buttons: Object.fromEntries(['cog', 'info', 'rate', 'tracks'].map((k) => [k, element()])),
      act: { loop: noop, setAutoplay: (m) => picked.push(m), cycleAB: noop, copyFrame: noop, openUrl: noop, extSettings: noop, copyInfo: noop, copyLink: noop },
      get: () => ({ ...state, autoplay: { mode: 'next', label: 'Play next in folder', next: true } }),
    });
    auto.show('main');
    assert.deepStrictEqual(labels().slice(0, 3), ['Playback', 'Autoplay', 'Speed']);
    assert.ok(!labels().includes('Repeat video'));
    auto.show('autoplay');
    const flatten = (e) => [e, ...(e.children || []).flatMap(flatten)];
    const radios = flatten(panel.children.at(-1)).filter((b) => b.attributes && b.attributes.role === 'radio');
    assert.deepStrictEqual(radios.map(labelOf), ['Off', 'Play next in folder', 'Loop']);
    assert.deepStrictEqual(radios.map((b) => b.attributes['aria-checked']), ['false', 'true', 'false']);
    radios[2].dispatch('click');
    assert.deepStrictEqual(picked, ['loop']);
    auto.close(false);
    full.show('ab');
    assert.deepStrictEqual(labels().slice(0, 6), ['A–B Range', 'Set A / B / clear', 'Export frames A–B…', 'Export A–B Clip…', 'Copy ffmpeg command for A–B']);
    rows().find((b) => labelOf(b) === 'Export A–B Clip…').dispatch('click');
    assert.deepStrictEqual(ran.splice(0), ['clip']);
    full.show('inspect');
    assert.deepStrictEqual(labels(), ['Inspection', 'Scopes', 'Pixel inspector', 'Stats', 'Codec X-ray']);
    rows().find((b) => labelOf(b) === 'Pixel inspector').dispatch('click');
    assert.deepStrictEqual(ran.splice(0), ['Inspector'], 'the row runs the tool under its stable name');
    full.show('info');
    const flat = (e) => [e, ...(e.children || []).flatMap(flat)];
    const info = flat(panel.children.at(-1)).map(labelOf).filter(Boolean).join('|');
    assert.ok(!/Open in system player|Full technical details/.test(info), `ⓘ keeps to information: ${info}`);
    assert.ok(/Copy details/.test(info) && /Copy link to this frame/.test(info), info);
  } finally {
    Object.assign(globalThis, originals);
  }
}
