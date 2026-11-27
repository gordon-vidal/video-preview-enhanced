'use strict';
// node test/run.js unit --grep setup_guide: the setup guide's buttons, run as commands through the mock vscode
// (src/extension.js setupNext, chooseTranscode): Next marks the step done and opens the next step this window
// shows, Done closes the guide, and the Live transcode list saves the pick.
const assert = require('assert');
const { load } = require('./mock_vscode');
const walkthrough = require('../../src/walkthrough');

(async () => {
  const h = load({});
  const cmd = (id, ...a) => h.vscode._commands[id](...a);
  const ran = () => { const r = h.vscode.executed || []; h.vscode.executed = []; return r; };
  ran();

  // Live transcode: three plain choices, the current one marked; the pick is saved for all videos.
  let items, opts;
  h.vscode.window.showQuickPick = async (it, o) => { items = it; opts = o; return it.find((x) => x.value === 'always'); };
  await cmd('videoPreviewEnhanced.chooseTranscode');
  assert.deepStrictEqual(items.map((x) => x.label), ['Auto (recommended)', 'Always', 'Off']);
  assert.strictEqual(items[0].description, 'current');
  assert.ok(items.every((x) => x.detail && !/ADR|WebCodecs|H\.264/.test(x.detail)), 'plain one-line explanations');
  assert.ok(opts.title);
  assert.deepStrictEqual(h.vscode._updates.filter((u) => u[0] === 'videoPreviewEnhanced.transcode').map((u) => u[1]), ['always']);
  h.vscode.window.showQuickPick = async () => undefined; // Esc: nothing saved
  await cmd('videoPreviewEnhanced.chooseTranscode');
  assert.strictEqual(h.vscode._updates.filter((u) => u[0] === 'videoPreviewEnhanced.transcode').length, 1);

  // Next on step 1 (local window): marks it done, opens the ffmpeg step.
  ran();
  await cmd('videoPreviewEnhanced.setupNext', 'start');
  let r = ran();
  assert.deepStrictEqual(r[0], ['setContext', walkthrough.doneKey('start'), true]);
  assert.strictEqual(r[1][0], 'workbench.action.openWalkthrough');
  assert.strictEqual(r[1][1].step, 'ffmpeg');
  assert.match(r[1][1].category, /#videoPreviewEnhanced\.setup$/);

  // Remote-SSH window: the ffmpeg step is hidden, so Next goes to the remote step.
  h.vscode.env.remoteName = 'ssh-remote';
  await cmd('videoPreviewEnhanced.setupNext', 'start');
  assert.strictEqual(ran()[1][1].step, 'remote');
  h.vscode.env.remoteName = undefined;

  // Done on the last step closes the guide; a bad id does nothing.
  await cmd('videoPreviewEnhanced.setupNext', 'later');
  assert.deepStrictEqual(ran().map((c) => c[0]), ['setContext', 'workbench.action.closeActiveEditor']);
  await cmd('videoPreviewEnhanced.setupNext', { evil: 1 });
  assert.deepStrictEqual(ran(), []);

  // Skipping the ffmpeg step records the decline so the first-video ffmpeg popup does not nag afterwards.
  await cmd('videoPreviewEnhanced.setupNext', 'ffmpeg');
  assert.strictEqual(h.context.globalState.get('videoPreviewEnhanced.onboarding').choice, 'builtin');

  // Show AI agent instructions: opens a themed webview tab showing the exact snippet + Copy buttons, no blind copy.
  h.vscode.env.clipboard.text = '';
  const instrPanel = h.nextPanel();
  await cmd('videoPreviewEnhanced.copyAgentSnippet');
  assert.strictEqual(instrPanel.viewType, 'videoPreviewEnhanced.agentInstructions');
  assert.ok(instrPanel.panel.webview.html.includes('Video inspection links (VS Code)'), 'webview shows the snippet');
  assert.ok(instrPanel.panel.webview.html.includes(walkthrough.SKILL_COMMAND), 'webview shows the npx skills command');
  assert.strictEqual(h.vscode.env.clipboard.text, '', 'opening the tab does not touch clipboard');
  await instrPanel.send({ type: 'copy', which: 'snippet' });
  assert.strictEqual(h.vscode.env.clipboard.text, walkthrough.AGENT_SNIPPET, 'Copy button writes snippet to clipboard');
  await instrPanel.send({ type: 'copy', which: 'skill' });
  assert.strictEqual(h.vscode.env.clipboard.text, walkthrough.SKILL_COMMAND, 'Copy skill button writes command to clipboard');
  instrPanel.panel.dispose();

  // Try it out: opens the bundled real-footage sample clip in Video Preview Enhanced.
  ran();
  await cmd('videoPreviewEnhanced.openSampleVideo');
  const openCalls = ran();
  assert.strictEqual(openCalls.length, 1);
  assert.strictEqual(openCalls[0][0], 'vscode.openWith');
  assert.match(openCalls[0][1].fsPath, /media[\\/]probe[\\/]h264_8_1080\.mkv$/);
  assert.strictEqual(openCalls[0][2], 'videoPreviewEnhanced.player');
  h.dispose();
  console.log('setup guide commands: ok');
})().catch((e) => { console.error(e); process.exit(1); });
