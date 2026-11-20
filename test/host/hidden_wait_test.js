'use strict';
const assert = require('assert');
const { HiddenCode } = require('../vscode/hidden');

(async () => {
  const waitLog = HiddenCode.prototype.waitLog;
  const broken = { lines: ['webview: decoder could not start: WebGL2 is not available'] };
  await assert.rejects(waitLog.call(broken, /first frame/), /no WebGL2 in this VS Code instance/);
  // An old success in the log cannot make a broken instance healthy again.
  broken.lines.unshift('first frame');
  await assert.rejects(waitLog.call(broken, /first frame/), /no WebGL2/);
  const healthy = { lines: ['first frame'] };
  assert.strictEqual(await waitLog.call(healthy, /first frame/), 'first frame');
  console.log('hidden wait: 3 checks passed');
})().catch((e) => { console.error(e); process.exitCode = 1; });
