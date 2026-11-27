'use strict';
// node test/run.js unit --grep remote_uri: URI schemes the viewer opens (review 1 #17).
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
    const warned = [];
    h.vscode.window.showWarningMessage = async (m) => { warned.push(m); };
    const git = h.vscode.Uri.file(file).with({ scheme: 'git' });
    let s = h.open(git);
    await s.shown;
    assert.ok(warned.some((m) => /git/.test(m)), 'git: refused');
    assert.strictEqual(s.panel.webview.html, '', 'git: not opened');
    s.panel.dispose();
    // A local file: "Open in the system player" opens it.
    const external = [];
    h.vscode.env.openExternal = async (u) => { external.push(u); return true; };
    s = h.open(file);
    await s.send({ type: 'ready' });
    await s.send({ type: 'external' });
    assert.deepStrictEqual(external.map((u) => u.fsPath), [file], 'local file opens in the system player');
    s.panel.dispose();

    // Remote window: files are vscode-remote: URIs; they open, are watched, and the system player says it can't.
    h = load();
    h.vscode.env.remoteName = 'ssh-remote';
    h.vscode.env.openExternal = async (u) => { external.push(u); return true; };
    s = h.open(h.vscode.Uri.file(file).with({ scheme: 'vscode-remote' }));
    await s.send({ type: 'ready' });
    assert.ok(s.posted.some((m) => m.type === 'sessionState' && m.clips.length === 1), 'vscode-remote: opened');
    await s.send({ type: 'external' });
    assert.strictEqual(external.length, 1, 'no system player on remote');
    assert.ok(s.posted.some((m) => m.type === 'toast' && /system player/.test(m.text)));
    fs.writeFileSync(file, Buffer.alloc(2000));
    await s.until((p) => p.some((m) => m.type === 'replaceTile' && m.reload), 4000).catch(() => {});
    assert.ok(s.posted.some((m) => m.type === 'replaceTile' && m.reload), 'vscode-remote: reloads on change');
    s.panel.dispose();
    console.log('remote/uri: ok');
  } finally {
    fs.unlinkSync(file);
  }
})().catch((e) => { console.error(e); process.exit(1); });
