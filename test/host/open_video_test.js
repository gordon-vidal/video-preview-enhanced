'use strict';

const assert = require('node:assert/strict');
const { load } = require('./mock_vscode');
const { contributes } = require('../../package.json');
const { videoPickerOptions, VIDEO_EXT } = require('../../src/open-video');

(async () => {
  const manifestExtensions = contributes.customEditors.flatMap(({ selector }) =>
    selector.flatMap(({ filenamePattern }) => filenamePattern.slice(3, -1).split(',')));
  const { filters } = videoPickerOptions();
  assert.deepEqual(filters['Video Files'].sort(), [...new Set(manifestExtensions.map((ext) => ext.toLowerCase()))].sort());
  assert.deepEqual(filters['All Files'], ['*']);
  assert.ok(manifestExtensions.every((ext) => VIDEO_EXT.test('clip.' + ext)));

  const { vscode } = load();
  const run = (command, ...args) => vscode._commands['videoPreviewEnhanced.' + command](...args);
  const mp4 = vscode.Uri.parse('file:///clips/A%20take.MP4');
  const mkv = vscode.Uri.parse('file:///clips/B.mkv');
  const unknown = vscode.Uri.parse('file:///clips/video.sample');
  const remote = vscode.Uri.parse('vscode-remote://test/clips/C.mkv');
  const { Active, Beside } = vscode.ViewColumn;
  const primary = 'videoPreviewEnhanced.player';
  const optional = 'videoPreviewEnhanced.playerOptional';
  const move = ['workbench.action.moveEditorToNewWindow'];
  const open = (uri, viewType, viewColumn) =>
    ['vscode.openWith', uri, viewType, { viewColumn, preview: false, preserveFocus: false }];
  const expectCalls = (...calls) => assert.deepEqual(vscode.executed.splice(0), calls);
  const dialogs = [];
  const warnings = [];
  const errors = [];
  const group = { activeTab: undefined };
  vscode.window.tabGroups = { activeTabGroup: group };
  vscode.window.showWarningMessage = async (message) => warnings.push(message);
  vscode.window.showErrorMessage = async (message) => errors.push(message);
  let picked;
  vscode.window.showOpenDialog = async (options) => { dialogs.push(options); return picked; };
  let openFailure;
  let moveFailure;
  let loseFocus = false;
  vscode.executed = [];
  vscode.commands.executeCommand = async (...args) => {
    vscode.executed.push(args);
    if (args[0] === 'vscode.openWith') {
      if (openFailure) throw openFailure;
      group.activeTab = { input: { uri: loseFocus ? mkv : args[1], viewType: args[2] } };
    } else if (moveFailure) {
      throw moveFailure;
    }
  };

  picked = [unknown];
  await run('openVideoFile', mp4);
  expectCalls(open(unknown, primary, Active));
  assert.deepEqual(dialogs, [videoPickerOptions()]);
  assert.equal(dialogs[0].canSelectFiles, true);
  assert.equal(dialogs[0].canSelectMany, false);
  assert.equal(dialogs[0].canSelectFolders, false);

  await run('playToSide', mp4, [mkv, mp4]);
  expectCalls(open(mp4, optional, Beside));
  await run('playInNewWindow');
  expectCalls(open(mp4, optional, Active), move);
  assert.equal(dialogs.length, 1, 'context and active-video calls bypass the picker');

  group.activeTab = undefined;
  vscode.window.activeTextEditor = { document: { uri: mkv } };
  await run('playToSide');
  expectCalls(open(mkv, primary, Beside));

  group.activeTab = { input: { uri: remote } };
  picked = [mkv];
  await run('playToSide');
  expectCalls(open(mkv, primary, Beside));
  assert.equal(dialogs.length, 2, 'the palette can pick a local file when the active tab is remote');
  await run('playInNewWindow', remote);
  expectCalls();
  assert.equal(dialogs.length, 2, 'an explicit non-file URI never opens a different video');
  assert.match(warnings.pop(), /local video file/);
  picked = [remote];
  await run('openVideoFile');
  expectCalls();
  assert.match(warnings.pop(), /local video file/);

  for (const selection of [undefined, []]) {
    picked = selection;
    await run('openVideoFile');
    expectCalls();
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);

  openFailure = new Error('open failed');
  await run('playInNewWindow', mp4);
  expectCalls(open(mp4, optional, Active));
  assert.match(errors.pop(), /could not open the video file: open failed/);
  openFailure = undefined;

  loseFocus = true;
  await run('playInNewWindow', mp4);
  expectCalls(open(mp4, optional, Active));
  assert.match(errors.pop(), /video tab is no longer active/);
  loseFocus = false;

  moveFailure = new Error('window unavailable');
  await run('playInNewWindow', mp4);
  expectCalls(open(mp4, optional, Active), move);
  assert.match(errors.pop(), /could not open the video in a new window: window unavailable/);

  vscode.window.showOpenDialog = async () => { throw new Error('picker unavailable'); };
  await run('openVideoFile');
  expectCalls();
  assert.match(errors.pop(), /could not open the video file: picker unavailable/);
  console.log('local video commands: filters, selection, routing, cancellation and errors passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
