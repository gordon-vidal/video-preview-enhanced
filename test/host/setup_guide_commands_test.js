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

  // setupFfmpeg / setupFfmpegFromGuide when ffmpeg is already installed on this computer:
  const ff = require('../../src/ffmpeg');
  const setup = require('../../src/setup');
  const hardware = require('../../src/hardware');
  const origLocate = ff.locateTools;
  const origChoose = setup.chooseBuild;
  const origDetect = hardware.detectMachine;
  const fakeBuild = { source: 'BtbN/FFmpeg-Builds', label: 'ffmpeg 8.1 (win64, LGPL)', sizeMB: 77, note: 'GPU decoding via NVIDIA NVDEC', line: { major: 8, minor: 1 } };
  try {
    h.vscode.ProgressLocation = { Notification: 15 };
    h.vscode.window.withProgress = (_o, fn) => fn({ report() {} });
    ff.locateTools = async () => ({ ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', version: 'ffmpeg version n8.1 Copyright (c) 2000-2026', legacy: false, gpuFilters: new Set(), stamp: 'x' });
    setup.chooseBuild = async () => fakeBuild;
    hardware.detectMachine = async () => ({ gpus: [{ name: 'Test GPU', driver: '581.15' }], nvidiaDriver: '581.15' });

    // From the walkthrough: confirms the existing ffmpeg and advances without opening the download picker.
    let picked = false;
    const infos = [];
    h.vscode.window.showQuickPick = async () => { picked = true; return undefined; };
    h.vscode.window.showInformationMessage = async (msg) => { infos.push(msg); return undefined; };
    ran();
    await cmd('videoPreviewEnhanced.setupFfmpegFromGuide', 'ffmpeg');
    assert.strictEqual(picked, false, 'walkthrough should not open QuickPick when ffmpeg is already working');
    assert.ok(infos.some((m) => /using ffmpeg already on this computer/i.test(m)), `expected confirmation message, got: ${infos}`);
    const guideCalls = ran();
    assert.deepStrictEqual(guideCalls[0], ['setContext', walkthrough.doneKey('ffmpeg'), true]);
    assert.strictEqual(guideCalls[1][0], 'workbench.action.openWalkthrough');

    // Direct setupFfmpeg command: Keep current setup & Re-test come before Download when ffmpeg is already fine.
    let setupItems = null;
    h.vscode.window.showQuickPick = async (it) => { setupItems = it; return undefined; };
    await cmd('videoPreviewEnhanced.setupFfmpeg');
    assert.strictEqual(setupItems[0].id, 'keep', 'Keep current setup should be first');
    assert.strictEqual(setupItems[1].id, 'retest', 'Re-test should be second');
    assert.strictEqual(setupItems[2].id, 'build', 'Download should follow Keep and Re-test');

    // When a driver-mismatch download IS recommended (ffmpeg 9.0 on driver 581), Download stays first,
    // Keep current setup is right below it explaining the NVENC trade-off, and the placeholder explains why.
    ff.locateTools = async () => ({ ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', version: 'ffmpeg version n9.0-12-gabc Copyright', legacy: false, gpuFilters: new Set(), stamp: 'y' });
    setupItems = null;
    let setupOpts = null;
    h.vscode.window.showQuickPick = async (it, o) => { setupItems = it; setupOpts = o; return undefined; };
    await cmd('videoPreviewEnhanced.setupFfmpeg');
    assert.strictEqual(setupItems[0].id, 'build', 'Recommended driver-matched download should stay first');
    assert.strictEqual(setupItems[1].id, 'keep', 'Keep current setup should be right below the recommended download');
    assert.match(setupItems[1].detail, /GPU decoding works; GPU encoding \(NVENC\) needs driver 610\+/);
    assert.match(setupOpts.placeHolder, /Found ffmpeg 9\.0 .*GPU decoding works, but NVENC needs driver 610\+ or ffmpeg 8\.1/);
  } finally {
    ff.locateTools = origLocate;
    setup.chooseBuild = origChoose;
    hardware.detectMachine = origDetect;
  }

  h.dispose();
  console.log('setup guide commands: ok');
})().catch((e) => { console.error(e); process.exit(1); });
