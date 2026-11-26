'use strict';
// node test/run.js unit --grep native_choice: the viewer's decoder choice per file (src/extension.js nativeFor) end
// to end with the mock vscode and a real ffmpeg (on PATH, or VPE_FFMPEG): with stored probe results the file goes to
// native ffmpeg with the probed method; WSL plays native, SSH and containers stream (remoteStream auto) or stay
// built-in (off); "Use full resolution" (pixel tools) switches the clip to the built-in decoder. Skipped without ffmpeg.
const assert = require('assert');
const path = require('path');
const ff = require('../../src/ffmpeg');
const { load } = require('./mock_vscode');

const clip = path.join(__dirname, '..', '..', 'media', 'probe', 'hevc_10_2160.mkv');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const tools = await ff.locateTools(process.env.VPE_FFMPEG || '', '');
  if (!tools) { console.log('native choice: skipped (no ffmpeg)'); return; }
  const settings = { 'videoPreviewEnhanced.ffmpegPath': tools.ffmpeg };
  const record = {
    fp: 'whatever', complete: true, ffmpeg: tools.version, ffmpegPath: tools.ffmpeg, gpus: [], at: 1, maxHeight: 1440,
    results: { 'hevc/10/2160': { method: 'dxva2', fps: 64, realtimeFactor: 2.1, sw: 142, tried: [{ method: 'd3d11va', ok: true, fps: 58 }, { method: 'dxva2', ok: true, fps: 64 }, { method: 'none', ok: true, fps: 142 }] } },
  };
  const start = async (remote) => {
    const h = load({ settings });
    h.vscode.window.withProgress = async () => null; // no background probe in this test
    h.vscode.env.remoteName = remote;
    await h.context.globalState.update('videoPreviewEnhanced.probe', record);
    const s = h.open(clip);
    await s.send({ type: 'ready' });
    await s.until((p) => p.some((m) => m.type === 'sessionState'), 15000);
    return { h, s };
  };
  const logOf = (h) => h.context.subscriptions.find((x) => x && Array.isArray(x.lines)).lines.join('\n');

  let { h, s } = await start(undefined);
  let meta = s.cfg().clips[0];
  assert.strictEqual(meta.native, true, 'local: native ffmpeg');
  assert.match(logOf(h), /decoder: native ffmpeg \(dxva2\): hevc\/10\/2160: ffmpeg dxva2 ~32 fps .*capped by sending 2160p frames/, "local: full size over the frame server");
  // Pixel tools: switch to the built-in decoder, kept for this tab.
  s.posted.length = 0;
  await s.send({ type: 'action', id: 'fullRes' });
  await s.until((p) => p.some((m) => m.type === 'replaceTile'), 15000);
  meta = s.posted.find((m) => m.type === 'replaceTile').clip;
  assert.ok(!meta.native, 'full resolution: built-in');
  assert.match(logOf(h), /full resolution: built-in decoder/);
  s.panel.dispose(); h.dispose();

  // Live transcode (ADR 0002): WSL plays native ffmpeg (no stream); with transcode: auto,
  // SSH and containers stream; remoteStream off (migrated) keeps SSH built-in.
  for (const [remote, want, tc, rs] of [
    ['wsl', 'native', 'auto', undefined],
    ['ssh-remote', 'stream', 'auto', undefined],
    ['dev-container', 'stream', 'auto', undefined],
    ['ssh-remote', 'builtin', undefined, 'off'],
  ]) {
    if (tc) settings['videoPreviewEnhanced.transcode'] = tc; else delete settings['videoPreviewEnhanced.transcode'];
    if (rs) settings['videoPreviewEnhanced.remoteStream'] = rs; else delete settings['videoPreviewEnhanced.remoteStream'];
    ({ h, s } = await start(remote));
    meta = s.cfg().clips[0];
    const log = logOf(h);
    const got = !meta.native ? 'builtin' : /live transcode on/.test(log) ? 'stream' : 'native';
    assert.strictEqual(got, want, `${remote}${rs ? ` (remoteStream ${rs})` : ''}: ${want}
${log}`);
    s.panel.dispose(); h.dispose();
  }
  delete settings['videoPreviewEnhanced.transcode'];
  delete settings['videoPreviewEnhanced.remoteStream'];
  await wait(10);
  console.log('native choice: ok');
})().catch((e) => { console.error(e); process.exit(1); });
