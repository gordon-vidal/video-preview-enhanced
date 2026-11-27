'use strict';
// node test/run.js unit --grep driver_notice: the notice shown when this ffmpeg's NVENC needs a newer NVIDIA
// driver (maintainer decision 2026-11-27): its text, its buttons in order, and what each button does.
const assert = require('assert');
const dn = require('../../src/driver_notice');

const notice = { requiredApi: '13.1', foundApi: '13.0', minDriver: '610.00' };

// ---- text: problem, cause, consequence ----
{
  const m = dn.driverNotice({ notice, installedDriver: '581.15' });
  assert.strictEqual(m.text, 'GPU video encoding (NVENC) isn\'t available: this ffmpeg needs NVIDIA driver 610 or newer, '
    + 'and this computer has 581.15. Live transcode encodes on the CPU instead, which is slower, uses more CPU and can stutter at 4K.');
  assert.ok(!/decod/i.test(m.text), 'GPU decoding still works: the text must not say decoding fails');
  assert.strictEqual(m.severity, 'warning');
}
{
  // Installed driver unknown: no "has" clause.
  const m = dn.driverNotice({ notice, installedDriver: null });
  assert.ok(m.text.startsWith('GPU video encoding (NVENC) isn\'t available: this ffmpeg needs NVIDIA driver 610 or newer. Live'), m.text);
}
{
  // Required driver unknown (only the API mismatch line was printed).
  const m = dn.driverNotice({ notice: { requiredApi: '13.1', foundApi: '13.0', minDriver: null }, installedDriver: '581.15' });
  assert.ok(m.text.startsWith('GPU video encoding (NVENC) isn\'t available: this ffmpeg needs a newer NVIDIA driver than '
    + 'this computer\'s 581.15. Live'), m.text);
}
{
  const m = dn.driverNotice({ notice: null });
  assert.ok(m.text.startsWith('GPU video encoding (NVENC) isn\'t available: this ffmpeg needs a newer NVIDIA driver. Live'), m.text);
}
{
  // A minimum with a real fractional part is kept as printed.
  const m = dn.driverNotice({ notice: { minDriver: '570.65' }, installedDriver: '566.36' });
  assert.ok(m.text.includes('NVIDIA driver 570.65 or newer, and this computer has 566.36.'), m.text);
}
{
  // Remote window: names the remote host, whose ffmpeg and driver these are.
  const m = dn.driverNotice({ notice, installedDriver: '581.15', host: 'gpu-box' });
  assert.ok(m.text.startsWith('GPU video encoding (NVENC) isn\'t available on gpu-box: this ffmpeg needs NVIDIA driver 610 '
    + 'or newer, and gpu-box has 581.15.'), m.text);
}
{
  // Another GPU encoder took over: the consequence is not the CPU.
  const m = dn.driverNotice({ notice, installedDriver: '581.15', otherGpuEncoder: true });
  assert.ok(m.text.endsWith('Live transcode uses another GPU encoder instead, which may be slower.'), m.text);
  assert.ok(!/CPU/.test(m.text), m.text);
  assert.strictEqual(m.actions[2].label, 'Keep current encoder');
}

// ---- buttons: matching ffmpeg first (never "Got it"), then driver, then keep the CPU ----
{
  const m = dn.driverNotice({ notice, installedDriver: '581.15' });
  assert.deepStrictEqual(m.actions.map((a) => [a.id, a.label]), [
    ['setup', 'Set up matching ffmpeg'],
    ['driver', 'Update NVIDIA driver'],
    ['keep', 'Keep CPU encoding'],
  ]);
  assert.ok(!m.actions.some((a) => /got it/i.test(a.label)));
}

// ---- what each choice does, through a stand-in for the VS Code API ----
function fakeVscode(answerLabel) {
  const calls = { warning: [], info: [], opened: [], setup: 0 };
  const vscode = {
    window: {
      showWarningMessage: async (text, ...items) => { calls.warning.push({ text, items }); return answerLabel; },
      showInformationMessage: async (text, ...items) => { calls.info.push({ text, items }); return answerLabel; },
    },
    env: { openExternal: async (uri) => { calls.opened.push(String(uri)); return true; } },
    Uri: { parse: (s) => ({ toString: () => s }) },
  };
  return { vscode, calls };
}

(async () => {
  const model = dn.driverNotice({ notice, installedDriver: '581.15' });
  {
    const { vscode, calls } = fakeVscode('Set up matching ffmpeg');
    const id = await dn.showDriverNotice(vscode, model, { setupFfmpeg: () => { calls.setup++; } });
    assert.strictEqual(id, 'setup');
    assert.strictEqual(calls.warning.length, 1, 'a warning: something failed');
    assert.strictEqual(calls.info.length, 0);
    assert.deepStrictEqual(calls.warning[0].items, ['Set up matching ffmpeg', 'Update NVIDIA driver', 'Keep CPU encoding']);
    assert.strictEqual(calls.setup, 1);
    assert.deepStrictEqual(calls.opened, []);
  }
  {
    const { vscode, calls } = fakeVscode('Update NVIDIA driver');
    const id = await dn.showDriverNotice(vscode, model, { setupFfmpeg: () => { calls.setup++; } });
    assert.strictEqual(id, 'driver');
    assert.deepStrictEqual(calls.opened, ['https://www.nvidia.com/Download/index.aspx']);
    assert.strictEqual(calls.setup, 0);
  }
  for (const answer of ['Keep CPU encoding', undefined]) {
    const { vscode, calls } = fakeVscode(answer);
    const id = await dn.showDriverNotice(vscode, model, { setupFfmpeg: () => { calls.setup++; } });
    assert.strictEqual(id, answer ? 'keep' : null);
    assert.strictEqual(calls.setup, 0);
    assert.deepStrictEqual(calls.opened, []);
  }
  console.log('driver_notice_test: ok');
})().catch((e) => { console.error(e); process.exit(1); });
