'use strict';
// node test/host/remote_uri_test.js: URI schemes (review 1 #17).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { load } = require('./mock_vscode');

(async () => {
  const file = path.join(os.tmpdir(), `vpe_uri_${process.pid}.mkv`);
  fs.writeFileSync(file, Buffer.alloc(1000));
  try {
    // git: URIs carry the working-tree path in fsPath; they must not play that file.
    let h = load();
    const git = h.vscode.Uri.file(file).with({ scheme: 'git' });
    let s = h.open(git);
    await s.send({ type: 'ready' });
    assert.ok(s.posted.some((m) => m.type === 'error' && /git/.test(m.message)), 'git: refused');
    assert.ok(!s.posted.some((m) => m.type === 'libav'), 'git: not opened');
    s.panel.dispose();
    s = h.open(file);
    await s.shown;
    assert.ok(/"canOpenExternal":true/.test(s.panel.webview.html), 'local file keeps "Open in the system player" (About this video panel)');
    s.panel.dispose();

    // Remote window: files are vscode-remote: URIs; they open, are watched, and hide the system-player button.
    h = load();
    h.vscode.env.remoteName = 'ssh-remote';
    s = h.open(h.vscode.Uri.file(file).with({ scheme: 'vscode-remote' }));
    await s.send({ type: 'ready' });
    assert.ok(s.posted.some((m) => m.type === 'libav'), 'vscode-remote: opened');
    assert.ok(/"canOpenExternal":false/.test(s.panel.webview.html), 'no system player on remote');
    await s.send({ type: 'external' });
    const before = s.panel.webview.html;
    fs.writeFileSync(file, Buffer.alloc(2000));
    await s.until(() => s.panel.webview.html !== before, 4000).catch(() => {});
    assert.notStrictEqual(s.panel.webview.html, before, 'vscode-remote: reloads on change');
    s.panel.dispose();
    console.log('remote/uri: ok');
  } finally {
    fs.unlinkSync(file);
  }
})().catch((e) => { console.error(e); process.exit(1); });
