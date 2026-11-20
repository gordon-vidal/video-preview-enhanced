'use strict';
// node test/host/debug_hook_test.js: the VPE_LOG command hook runs only allowlisted
// commands, and its player messages always arrive as type 'debug' (review 2 #12).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { load } = require('./mock_vscode');

(async () => {
  const logFile = path.join(os.tmpdir(), `vpe_hook_${process.pid}.log`);
  const file = path.join(os.tmpdir(), `vpe_hook_${process.pid}.mkv`);
  fs.writeFileSync(file, Buffer.alloc(1000));
  const h = load({ env: { VPE_LOG: logFile } });
  try {
    const s = h.open(file);
    const lines = [
      { command: 'videoPreviewEnhanced.makeDefault' },
      { command: 'videoPreviewEnhanced.setupFfmpeg' },
      { command: 'videoPreviewEnhanced.openWith', arg: file },
      { type: 'libav', action: 'report' },
    ];
    fs.writeFileSync(`${logFile}.cmd`, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    await s.until((p) => p.some((m) => m.action === 'report'), 5000);
    const ran = (h.vscode.executed || []).map((c) => c[0]);
    assert.deepStrictEqual(ran.filter((c) => c.startsWith('videoPreviewEnhanced.')), ['videoPreviewEnhanced.openWith'], `ran: ${ran}`);
    const m = s.posted.find((x) => x.action === 'report');
    assert.strictEqual(m.type, 'debug', 'a command line cannot pose as another message type');
    s.panel.dispose();
    console.log('debug hook: ok');
  } finally {
    h.dispose();
    for (const f of [file, logFile, `${logFile}.cmd`]) try { fs.unlinkSync(f); } catch { /* not there */ }
  }
})().catch((e) => { console.error(e); process.exit(1); });
