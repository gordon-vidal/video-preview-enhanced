'use strict';
// How a file given on VS Code's first command line opens (moved from test/vscode/run.js --activation):
//
//   node test/vscode/activation.js [--keep]
//
// Result on VS Code 1.146 (README.md here, "Files on the first command line"): a fresh profile opens it in the
// default (binary) editor; forwarded afterwards, restarted, or with an editor association it opens in the extension.
const fs = require('fs');
const path = require('path');
const { HiddenCode, findCode, MEDIA, ROOT, sleep } = require('./hidden');

const flag = (n) => process.argv.includes(n);

async function activationCheck(code) {
  const file = path.join(MEDIA, 'mpeg2_1080p.mpg');
  const out = {};
  // 1. The file on the first command line.
  let vs = new HiddenCode({ code, keep: flag('--keep'), tag: 'vpeact' });
  try {
    await vs.start([file]);
    try { await vs.waitLog(/first frame shown/, { timeout: 25000 }); out.firstCommandLine = 'opened in the extension'; } catch { out.firstCommandLine = 'not opened in the extension (no log within 25 s)'; }
    // 2. The same file forwarded to the running instance afterwards.
    const from = vs.mark();
    await vs.cli(['--reuse-window', file]);
    try { await vs.waitLog(/first frame shown/, { from, timeout: 25000 }); out.forwarded = 'opened in the extension'; } catch { out.forwarded = 'not opened (no log within 25 s)'; }
  } finally { await vs.stop(); }
  // 2b. Installed (copied into the profile's extensions dir) instead of --extensionDevelopmentPath.
  vs = new HiddenCode({ code, keep: flag('--keep'), tag: 'vpeact', devPath: false });
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const dst = path.join(vs.ext, `${pkg.publisher}.${pkg.name}-${pkg.version}`);
    for (const f of ['package.json', 'LICENSE', 'README.md', 'src', 'media', 'build']) {
      if (fs.existsSync(path.join(ROOT, f))) fs.cpSync(path.join(ROOT, f), path.join(dst, f), { recursive: true });
    }
    await vs.start([file]);
    try { await vs.waitLog(/first frame shown/, { timeout: 25000 }); out.installedFirstCommandLine = 'opened in the extension'; } catch { out.installedFirstCommandLine = 'not opened in the extension (no log within 25 s)'; }
  } finally { await vs.stop(); }
  // 3. Launched without a file, then the file forwarded once the window is up (what the suite does).
  // 4. Then the same profile restarted with the file on the first command line.
  vs = new HiddenCode({ code, keep: flag('--keep'), tag: 'vpeact' });
  try {
    await vs.start();
    await sleep(4000);
    await vs.cli(['--reuse-window', file]);
    try { await vs.waitLog(/first frame shown/, { timeout: 25000 }); out.startThenForward = 'opened in the extension'; } catch { out.startThenForward = 'not opened (no log within 25 s)'; }
    await sleep(2000);
    await vs.kill();
    const from = vs.mark();
    const other = path.join(MEDIA, 'prores_proxy_1080p.mov'); // not open before: not a restored editor
    await vs.start([other]);
    try { await vs.waitLog(/\[prores_proxy_1080p\.mov\] webview: first frame shown/, { from, timeout: 25000 }); out.secondStartFirstCommandLine = 'opened in the extension'; } catch { out.secondStartFirstCommandLine = 'not opened (no log within 25 s)'; }
  } finally { await vs.stop(); }
  // 5. A fresh profile whose settings associate the file type with the extension's editor.
  vs = new HiddenCode({ code, keep: flag('--keep'), tag: 'vpeact', settings: { 'workbench.editorAssociations': { '*.mpg': 'videoPreviewEnhanced.player' } } });
  try {
    await vs.start([file]);
    try { await vs.waitLog(/first frame shown/, { timeout: 25000 }); out.freshWithAssociation = 'opened in the extension'; } catch { out.freshWithAssociation = 'not opened (no log within 25 s)'; }
  } finally { await vs.stop(); }
  return out;
}

if (require.main === module) activationCheck(findCode()).then((o) => { console.log(JSON.stringify(o, null, 1)); process.exit(0); }, (e) => { console.error(e); process.exit(1); });
