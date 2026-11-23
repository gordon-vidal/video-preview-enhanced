'use strict';
// The hidden desktop drives Explorer opens and context-menu selections through the extension's debug hooks.
const fs = require('fs');
const os = require('os');
const path = require('path');
const lib = require('../lib');

const CLIPS = ['h264_aac_anim_1080p.mp4', 'vp9_opus_anim_1080p.webm', 'h264_8_1080p.mp4'];
const opened = (n) => new RegExp(`\\[compare [^\\]]*\\] opened, .* ${n} tiles`);
const hint = (on) => new RegExp(`\\[compare [^\\]]*\\] webview: addMode ${on ? 'on' : 'off'}`);
const menuContext = (on) => new RegExp(`compare: videoPreviewEnhanced\\.compareOpen=${on}`);
const isCompare = (tab) => /compare/i.test(tab.viewType);
// A compare opened without Add Mode (several files chosen at once): neither the host nor its page ever turned it on.
const modeOn = /compare: add from the Explorer on|webview: addMode on/;

module.exports = [{
  name: 'compare_addmode',
  settings: {
    'videoPreviewEnhanced.decoder': 'builtin',
    'videoPreviewEnhanced.autoplay': false,
    'videoPreviewEnhanced.compare.openTogether': false,
  },
  async run(vs, h) {
    const results = [];
    const files = CLIPS.map((c) => path.join(h.MEDIA, c));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vpe-compare-selection-'));
    const [first, second] = files.map((f, i) => path.join(dir, `clip${[2, 10][i]}${path.extname(f)}`));
    const notes = path.join(dir, 'notes.txt');
    const tabList = async () => {
      const from = vs.mark();
      vs.send({ tabs: true });
      const line = await vs.waitLog(/ tabs \[\[/, { from, timeout: 10000 });
      return JSON.parse(/ tabs (\[\[.*\]\])/.exec(line)[1]).flat();
    };
    const wait = (re, from, what) => vs.waitLog(re, { from, timeout: 15000, what });
    const send = (message) => { const from = vs.mark(); vs.send(message); return from; };
    const act = (action, extra) => send({ compare: true, action, ...extra });
    const startCompare = (selection) => send({ startCompare: selection });
    const add = (selection) => send({ addToCompare: selection });
    const open = (openFile) => send({ openFile, preview: false, preserveFocus: false });
    const assert = (cond, problem) => { if (!cond) throw new Error(problem); };
    const onlyCompare = async () => {
      const tabs = await tabList();
      assert(tabs.length === 1 && isCompare(tabs[0]), `expected a single Compare tab, saw ${JSON.stringify(tabs)}`);
    };
    const run = async (name, fn) => {
      try {
        await fn();
        results.push({ name, ok: true, problems: [] });
      } catch (e) {
        results.push({ name, ok: false, problems: [e.message] });
      } finally {
        await h.closeClip(vs);
      }
    };
    try {
      fs.copyFileSync(files[0], first);
      fs.copyFileSync(files[1], second);
      fs.writeFileSync(notes, 'Compare tab switching test\n');
      await run('toolbar-confirm-stop-and-append', async () => {
        const P = await lib.open(vs, h, files[0]);
        P.pause();
        await P.ask('click', { sel: '#startCompareBtn' });
        let state = await P.ask('a11y');
        assert(!state.startCompare.hidden && state.active === 'cancelCompareBtn', 'Compare opens the confirmation and focuses Cancel');
        assert(state.controls.startCompareBtn['aria-expanded'] === 'true', 'Compare announces the expanded dialog');
        P.key('Tab', { target: ':focus' });
        state = await P.ask('a11y');
        assert(state.active === 'confirmCompareBtn', 'Tab moves focus to Start comparison');
        P.key('Tab', { target: ':focus' });
        assert((await P.ask('a11y')).active === 'cancelCompareBtn', 'Tab wraps back to Cancel');
        P.key('Escape', { target: ':focus' });
        state = await P.ask('a11y');
        assert(state.startCompare.hidden && state.active === 'startCompareBtn', 'Escape dismisses the dialog and returns focus');
        await P.ask('click', { sel: '#startCompareBtn' });
        await P.ask('click', { sel: '#startCompareBackdrop' });
        assert((await P.ask('a11y')).startCompare.hidden, 'click outside dismisses the dialog');
        const tabs = await tabList();
        assert(tabs.length === 1 && !isCompare(tabs[0]), 'dismissing the dialog leaves the player tab open');

        await P.ask('click', { sel: '#startCompareBtn' });
        const confirmed = send({ name: CLIPS[0], action: 'click', sel: '#confirmCompareBtn' });
        await wait(opened(1), confirmed, 'Start comparison opens one tile');
        await wait(hint(true), confirmed, 'Start comparison enters Add Mode');
        await onlyCompare();

        const stopped = act('click', { sel: '#stopAddBtn' });
        await wait(hint(false), stopped, 'the Stop button ends Add Mode');
        const other = await lib.open(vs, h, files[1]);
        state = await other.ask('a11y');
        assert(state.controls.startCompareBtn['aria-label'] === 'Add to Compare', 'a player detects the open Compare');
        const appended = send({ name: CLIPS[1], action: 'click', sel: '#startCompareBtn' });
        await wait(/\[compare [^\]]*\] add vp9_opus_anim_1080p\.webm/, appended, 'the player adds directly to the open Compare');
        assert((await other.ask('a11y')).startCompare.hidden, 'adding to Compare skips the confirmation');
      });

      await run('single-file-start-and-explorer-add', async () => {
        const start = startCompare([files[0]]);
        await wait(menuContext(true), start, 'Compare menus switch to Add to Compare');
        await wait(opened(1), start, 'single-tile Compare');
        await wait(hint(true), start, 'single-tile Add Mode');
        const joined = open(files[1]);
        await wait(opened(2), joined, 'second tile from an Explorer open');
        await wait(hint(true), joined, 'the hint after adding a tile');
        await onlyCompare();
        const closing = vs.mark();
        await h.closeClip(vs);
        await wait(menuContext(false), closing, 'Compare menus switch back to Start Compare');
      });

      await run('multi-select-mixed-and-folder', async () => {
        const start = startCompare(files.slice(0, 2));
        await wait(opened(2), start, 'two selected files');
        await wait(/webview: begin:/, start, 'Compare ready');
        assert(!vs.lines.slice(start).some((l) => modeOn.test(l)), 'a multi-select must open Compare with Add Mode off');
        const append = add([dir, first, files[0]]);
        await wait(opened(4), append, 'mixed selection appends two unique folder files');
        await onlyCompare();
        await h.closeClip(vs);
        const nestedRoot = path.join(dir, 'recording');
        fs.mkdirSync(path.join(nestedRoot, 'cam1'), { recursive: true });
        fs.mkdirSync(path.join(nestedRoot, 'cam2'), { recursive: true });
        fs.copyFileSync(files[0], path.join(nestedRoot, 'cam1', 'video.mp4'));
        fs.copyFileSync(files[1], path.join(nestedRoot, 'cam2', 'video.webm'));
        const nested = startCompare([nestedRoot]);
        const nestedLine = await wait(opened(2), nested, 'two videos from subfolders');
        assert(/video\.mp4.*video\.webm/.test(nestedLine), `subfolder order: ${nestedLine}`);
        await wait(/webview: begin:/, nested, 'Compare ready for subfolders');
        assert(!vs.lines.slice(nested).some((l) => modeOn.test(l)), 'a nested folder must open Compare with Add Mode off');
        await onlyCompare();
        await h.closeClip(vs);
        const folder = startCompare([dir]);
        const line = await wait(opened(4), folder, 'four files from folder and subfolders');
        assert(/clip2\.mp4.*clip10\.webm.*video\.mp4.*video\.webm/.test(line), `folder order: ${line}`);
        await wait(/webview: begin:/, folder, 'Compare ready');
        assert(!vs.lines.slice(folder).some((l) => modeOn.test(l)), 'a folder must open Compare with Add Mode off');
        await onlyCompare();
        // With Add Mode off, an Explorer open is a player of its own.
        const separate = open(files[2]);
        await wait(/\[h264_8_1080p\.mp4\] session resolved/, separate, 'an Explorer open after a multi-select starts a separate player');
        const tabs = await tabList();
        assert(tabs.length === 2 && tabs.some(isCompare), `tabs after the open: ${JSON.stringify(tabs)}`);
      });

      await run('player-title-start-and-add', async () => {
        const player = await h.openClip(vs, files[0]);
        await wait(/first frame shown/, player, 'the player');
        const started = send({ name: CLIPS[0], compareWith: [files[1]] });
        await wait(menuContext(true), started, 'the title action opens a Compare session');
        await wait(opened(2), started, 'the picked file and player video are compared');
        await onlyCompare();

        // Compare With… picks a whole set, so Compare opens with Add Mode off (src/addmode.js startsInAddMode).
        assert(!vs.lines.slice(started).some((l) => modeOn.test(l)), 'Compare With… must open Compare with Add Mode off');
        const secondPlayer = open(files[2]);
        await wait(/\[h264_8_1080p\.mp4\] session resolved/, secondPlayer, 'the second player opens separately');
        const added = send({ command: 'videoPreviewEnhanced.addToCompareFromPlayer', arg: files[2] });
        await wait(/\[compare [^\]]*\] add h264_8_1080p\.mp4/, added, 'the title action appends to the background Compare');
        const tabs = await tabList();
        assert(tabs.length === 2 && tabs.filter(isCompare).length === 1, `tabs after title action: ${JSON.stringify(tabs)}`);
      });

      await run('player-shift-d-and-playback', async () => {
        const player = await h.openClip(vs, files[0]);
        await wait(/first frame shown/, player, 'the player');
        const shift = send({ name: CLIPS[0], action: 'key', key: 'D', shift: true });
        await wait(/webview: addMode on/, shift, 'the player hint');
        const joined = open(files[1]);
        await wait(opened(2), joined, 'Compare replaces the player');
        await wait(hint(true), joined, 'Add Mode survives the transition');
        await wait(/webview: begin:/, joined, 'Compare ready to play');
        const played = act('play');
        act('report');
        await wait(/compare report .* playing=1,1/, played, 'both tiles playing');
        act('pause');
        const scrubbed = act('scrub', { frac: 0.5 });
        act('report');
        await wait(/compare report .* frame=[1-9][0-9]+ .* playing=0,0/, scrubbed, 'paused after scrubbing');
        const added = open(files[2]);
        await wait(opened(3), added, 'a video still joins after playback and scrubbing');
        await wait(hint(true), added, 'the hint after a third tile');
        await onlyCompare();

        const stopped = send({ command: 'videoPreviewEnhanced.stopAddFromExplorer' });
        await wait(hint(false), stopped, 'Esc hides the hint');
        const appended = add([first]);
        await wait(opened(4), appended, 'Add to Compare still works after Esc');
        const separate = open(second);
        await wait(/\[clip10\.webm\] session resolved/, separate, 'opening after Esc starts a separate player');
        const tabs = await tabList();
        assert(tabs.length === 2 && tabs.some(isCompare), `tabs after Esc: ${JSON.stringify(tabs)}`);
      });

      await run('add-video-and-switch-editor', async () => {
        const textOpened = send({ openFile: notes, preview: false, preserveFocus: false, id: 'openNotes' });
        await wait(/debug done openNotes openFile/, textOpened, 'the text tab is open');
        const start = add(files.slice(0, 2));
        await wait(opened(2), start, 'Compare opens');
        await wait(/webview: begin:/, start, 'Compare ready');
        assert(!vs.lines.slice(start).some((l) => modeOn.test(l)), 'Compare from a multi-select starts with Add Mode off');
        const on = act('key', { key: 'D', shift: true });
        await wait(hint(true), on, 'Shift+D turns Add Mode on');
        const toggle = act('key', { key: 'D', shift: true });
        await wait(hint(false), toggle, 'Shift+D turns Add Mode off');
        act('panel', { view: 'cmp' });
        const button = act('click', { text: 'Add video' });
        await wait(hint(true), button, 'Add video turns Add Mode back on');
        const switched = open(notes);
        await wait(/compare: add from the Explorer off \(switched editor\)/, switched, 'switching to a text tab ends Add Mode');
        const separate = open(files[2]);
        await wait(/\[h264_8_1080p\.mp4\] session resolved/, separate, 'opening after switching starts a separate player');
        const tabs = await tabList();
        assert(tabs.length === 3 && tabs.some(isCompare), `tabs after switching: ${JSON.stringify(tabs)}`);
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    return results;
  },
}];
