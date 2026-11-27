'use strict';
// node test/host/membudget_test.js: memory budgets from the machine's memory (media/membudget.js):
// the 32 GB values are the old fixed sizes, 8 GB gets less, a busy machine sizes from what is free;
// the player's page gets them (cfg.engine.mem), VPE_TOTALMEM (tests, VPE_LOG only) emulates a machine,
// and native ffmpeg's lookup + ffprobe start with the session (before the page's 'ready').
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const mb = require('../../media/membudget.js');
const { load } = require('./mock_vscode');

const GB = mb.GB;
const b32 = mb.budgets(32);
assert.deepStrictEqual({ frames: b32.frames, pool: b32.pool, workers: b32.workers, blocks: b32.blocks, nativeQueue: b32.nativeQueue },
  { frames: 400e6, pool: 600e6, workers: 6, blocks: 64e6, nativeQueue: 12 }, '32 GB: the old fixed sizes');
assert.deepStrictEqual(mb.budgets(null).frames, 400e6, 'unknown: the old sizes');
assert.deepStrictEqual(mb.budgets(128).pool, 600e6, 'never above the 32 GB values');
const b8 = mb.budgets(8);
assert.strictEqual(b8.frames, 160e6);
assert.strictEqual(b8.pool, 240e6);
assert.strictEqual(b8.workers, 3);
assert.deepStrictEqual(mb.fromDeviceMemory(8), mb.budgets(null), 'the browser caps its report at 8 GB');
assert.deepStrictEqual(mb.fromDeviceMemory(4), mb.budgets(4), 'reports below the cap can size the webview');
assert.deepStrictEqual(mb.fromDeviceMemory(undefined), mb.budgets(null), 'missing browser report uses defaults');
const b4 = mb.budgets(4);
assert.ok(b4.frames >= 96e6 && b4.frames < b8.frames && b4.workers >= 1, '4 GB: less, not below the floor');
for (const k of Object.keys(mb.TABLE)) assert.ok(mb.budgets(16)[k] <= b32[k] && mb.budgets(16)[k] >= b8[k], `16 GB between 8 and 32 (${k})`);
// A "32 GB" machine reports a little under 32 GiB; a busy one sizes from four times what is free.
assert.strictEqual(mb.basisGB(34272169984, 15e9), 32);
assert.strictEqual(mb.basisGB(32 * GB, 3 * GB), 12);
assert.strictEqual(mb.basisGB(8 * GB, 0.5 * GB), 2);
assert.strictEqual(mb.basisGB(8 * GB), 8);
assert.strictEqual(mb.basisGB(0), null);

(async () => {
  const file = path.join(os.tmpdir(), `vpe_mem_${process.pid}.mkv`);
  fs.writeFileSync(file, Buffer.alloc(1000));
  try {
    // The page is made after the frame server has its port (an await before the viewer is created).
    const pageOf = async (s) => { for (let i = 0; i < 200 && !s.panel.webview.html; i++) await new Promise((r) => setTimeout(r, 10)); return s; };
    const cfgOf = (s) => JSON.parse(/<script type="application\/json" id="cfg">([^<]*)<\/script>/.exec(s.panel.webview.html)[1].replace(/\\u003c/g, '<'));
    const logOf = (h) => h.context.subscriptions.find((x) => x && Array.isArray(x.lines)).lines.join('\n');
    process.env.VPE_TOTALMEM = String(8 * GB); // read when the page is made
    let h = load({ settings: { 'videoPreviewEnhanced.decoder': 'builtin' }, env: { VPE_LOG: path.join(os.tmpdir(), `vpe_mem_${process.pid}.log`) } });
    let s = h.open(file);
    let mem = cfgOf(await pageOf(s)).engine.mem;
    assert.strictEqual(mem.gb, 8, 'VPE_TOTALMEM emulates 8 GB');
    assert.strictEqual(mem.frames, 160e6);
    assert.ok(/membudget\.js/.test(s.panel.webview.html), 'the page loads membudget.js');
    h = load({ settings: { 'videoPreviewEnhanced.decoder': 'builtin' }, env: { VPE_LOG: undefined } });
    s = h.open(file);
    mem = cfgOf(await pageOf(s)).engine.mem;
    assert.strictEqual(mem.gb, mb.basisGB(os.totalmem(), os.freemem()), 'without VPE_LOG the override does nothing');
    delete process.env.VPE_TOTALMEM;
    assert.ok(!/native ffmpeg:/.test(logOf(h)), 'decoder builtin: no ffmpeg lookup');
    // Remote windows: no host numbers (the page uses navigator.deviceMemory).
    h.vscode.env.remoteName = 'ssh-remote';
    s = h.open(file);
    assert.strictEqual(cfgOf(await pageOf(s)).engine.mem, null, 'remote: sized in the webview');
    h.vscode.env.remoteName = undefined;
    // decoder auto: the ffmpeg lookup (and ffprobe when there is one) runs while the clip is prepared, before 'ready'.
    h = load({ settings: {}, env: { VPE_LOG: undefined } });
    h.vscode.window.withProgress = async () => null; // no background GPU test here
    s = h.open(file);
    const t0 = Date.now();
    while (!/native ffmpeg:/.test(logOf(h)) && Date.now() - t0 < 10000) await new Promise((r) => setTimeout(r, 10));
    assert.ok(/native ffmpeg:/.test(logOf(h)), 'auto: ffmpeg looked up with the session');
    await s.send({ type: 'ready' });
    await s.until((p) => p.some((m) => m.type === 'sessionState'), 15000);
    console.log('membudget: ok');
  } finally {
    fs.rmSync(file, { force: true });
  }
  process.exit(0); // the sessions' file watchers keep Node running
})().catch((e) => { console.error(e); process.exit(1); });
