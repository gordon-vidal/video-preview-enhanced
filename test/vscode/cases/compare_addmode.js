'use strict';
// The hidden desktop drives Explorer opens and context-menu selections through the extension's debug hooks.
const fs = require('fs');
const os = require('os');
const path = require('path');
const lib = require('../lib');

const CLIPS = ['h264_aac_anim_1080p.mp4', 'vp9_opus_anim_1080p.webm', 'h264_8_1080p.mp4'];
// The unified viewer grows one tab in place: the host logs "tiles: N" (and "opened, ..., N tiles" for a new panel).
const opened = (n) => new RegExp(`\\[compare [^\\]]*\\] (?:opened, .*, |tiles: )${n}(?: tiles)?\\b`);
// Add Mode is the session's Capture; any tab title (a single video's too) can carry the line.
const hint = (on) => new RegExp(`\\[[^\\]]+\\] compare: add from the Explorer ${on ? 'on' : 'off'}`);
const menuContext = (on) => new RegExp(`compare: videoPreviewEnhanced\\.compareOpen=${on}`);
// A comparison's tab: a viewer panel made for it, or a player tab grown in place (its title lists the videos).
const isCompare = (tab) => /compare/i.test(tab.viewType) || /↔| · /.test(tab.label);
// A compare opened without Add Mode (several files chosen at once): the host never turned it on.
const modeOn = /compare: add from the Explorer on/;
// The page shows its pictures (2+ tiles all presented).
const ready = /webview: first pictures shown/;

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
      await run('toolbar-toggle-stop-and-append', async () => {
        const P = await lib.open(vs, h, files[0]);
        P.pause();
        // The Compare button toggles Add Mode directly: no confirmation dialog, the tab stays one tab.
        const on = send({ name: CLIPS[0], action: 'click', sel: '#startCompareBtn' });
        await wait(hint(true), on, 'the Compare button turns Add Mode on');
        let state = await P.ask('a11y');
        assert(state.controls.startCompareBtn['aria-pressed'] === 'true', `the Compare button shows Add Mode on: ${JSON.stringify(state.controls.startCompareBtn)}`);
        let tabs = await tabList();
        assert(tabs.length === 1 && !isCompare(tabs[0]), `Add Mode on leaves the player tab alone: ${JSON.stringify(tabs)}`);
        const off = send({ name: CLIPS[0], action: 'click', sel: '#startCompareBtn' });
        await wait(hint(false), off, 'the Compare button again ends Add Mode');
        state = await P.ask('a11y');
        assert(state.controls.startCompareBtn['aria-pressed'] === 'false', `the button shows Add Mode off: ${JSON.stringify(state.controls.startCompareBtn)}`);

        const again = send({ name: CLIPS[0], action: 'click', sel: '#startCompareBtn' });
        await wait(hint(true), again, 'the Compare button turns Add Mode on again');
        const joined = open(files[1]);
        await wait(opened(2), joined, 'an Explorer open grows the player tab to two tiles');
        await onlyCompare();

        const stopped = act('click', { sel: '#startCompareBtn' });
        await wait(hint(false), stopped, 'the Compare button ends Add Mode in the comparison');
        // A player of its own adds to the open Compare from its title action, no confirmation.
        const other = await lib.open(vs, h, files[2]);
        const appended = send({ command: 'videoPreviewEnhanced.addToCompareFromPlayer', arg: files[2] });
        await wait(/\[compare [^\]]*\] add h264_8_1080p\.mp4/, appended, 'the player adds directly to the open Compare');
        tabs = await tabList();
        assert(tabs.length === 2 && tabs.filter(isCompare).length === 1, `tabs after adding: ${JSON.stringify(tabs)}`);
        await other.close();
      });

      await run('single-file-start-and-explorer-add', async () => {
        const start = startCompare([files[0]]);
        await wait(hint(true), start, 'single-video Start Compare turns Add Mode on');
        const joined = open(files[1]);
        await wait(opened(2), joined, 'second tile from an Explorer open');
        await wait(menuContext(true), joined, 'Compare menus switch to Add to Compare');
        // Add Mode stays on after a tile joins: the next open joins too.
        const third = open(files[2]);
        await wait(opened(3), third, 'a third tile from an Explorer open');
        await onlyCompare();
        const closing = vs.mark();
        await h.closeClip(vs);
        await wait(menuContext(false), closing, 'Compare menus switch back to Start Compare');
      });

      await run('multi-select-mixed-and-folder', async () => {
        const start = startCompare(files.slice(0, 2));
        await wait(opened(2), start, 'two selected files');
        await wait(ready, start, 'Compare ready');
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
        const nestedLine = await wait(/compare: video\.mp4 <-> video\.webm/, nested, 'two videos from subfolders, in order');
        assert(/video\.mp4.*video\.webm/.test(nestedLine), `subfolder order: ${nestedLine}`);
        await wait(ready, nested, 'Compare ready for subfolders');
        assert(!vs.lines.slice(nested).some((l) => modeOn.test(l)), 'a nested folder must open Compare with Add Mode off');
        await onlyCompare();
        await h.closeClip(vs);
        const folder = startCompare([dir]);
        const line = await wait(/compare: clip2\.mp4 <-> clip10\.webm <-> video\.mp4 <-> video\.webm/, folder, 'four files from folder and subfolders, in order');
        assert(/clip2\.mp4.*clip10\.webm.*video\.mp4.*video\.webm/.test(line), `folder order: ${line}`);
        await wait(ready, folder, 'Compare ready');
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
        await wait(opened(2), started, 'the picked file joins the player video in its own tab');
        await wait(menuContext(true), started, 'the title action opens a Compare session');
        await onlyCompare();

        // Compare With… picks a whole set, so Compare opens with Add Mode off.
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
        await wait(hint(true), shift, 'Shift+D turns Add Mode on');
        const joined = open(files[1]);
        await wait(opened(2), joined, 'the player tab grows to two tiles');
        await wait(ready, joined, 'Compare ready to play');
        const played = act('play');
        act('report');
        await wait(/compare report .* playing=1,1/, played, 'both tiles playing');
        act('pause');
        const scrubbed = act('scrub', { frac: 0.5 });
        act('report');
        await wait(/compare report .* frame=[1-9][0-9]+ .* playing=0,0/, scrubbed, 'paused after scrubbing');
        const added = open(files[2]);
        await wait(opened(3), added, 'a video still joins after playback and scrubbing (Add Mode survived)');
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
        await wait(ready, start, 'Compare ready');
        assert(!vs.lines.slice(start).some((l) => modeOn.test(l)), 'Compare from a multi-select starts with Add Mode off');
        const on = act('key', { key: 'D', shift: true });
        await wait(hint(true), on, 'Shift+D turns Add Mode on');
        const toggle = act('key', { key: 'D', shift: true });
        await wait(hint(false), toggle, 'Shift+D turns Add Mode off');
        act('panel', { view: 'cmp' });
        const button = act('click', { text: 'Open new videos here' });
        await wait(hint(true), button, "the Compare panel's switch turns Add Mode back on");
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
