'use strict';
// node test/host/frame_link_test.js: frame links name the remote host and only
// open in the window connected to it (review 2 #4).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { load } = require('./mock_vscode');

/** What the URI handler receives for a copied link (VS Code decodes the query once). */
function linkUri(h, text) {
  const u = h.vscode.Uri.parse(text.replace(/\?.*$/, ''));
  u.query = decodeURIComponent(text.slice(text.indexOf('?') + 1));
  return u;
}

async function copy(h, file) {
  const s = h.open(file);
  await s.send({ type: 'copyLink', frame: 5, t: 0.2 });
  s.panel.dispose();
  return h.vscode.env.clipboard.text;
}

async function follow(h, text) {
  const warned = [];
  h.vscode.window.showWarningMessage = async (m) => { warned.push(m); };
  h.vscode.executed = [];
  await h.vscode.uriHandler.handleUri(linkUri(h, text));
  const opened = h.vscode.executed.filter((c) => c[0] === 'vscode.openWith').map((c) => c[1]);
  return { warned, opened };
}

(async () => {
  const file = path.join(os.tmpdir(), `vpe link ${process.pid}#1.mkv`);
  fs.writeFileSync(file, Buffer.alloc(1000));
  const posix = file.split(path.sep).join('/').replace(/^(?=[^/])/, '/');
  try {
    // Local window: a plain file= link that opens locally.
    let h = load();
    let text = await copy(h, file);
    assert.ok(/&file=/.test(text), `local link uses file=: ${text}`);
    let r = await follow(h, text);
    assert.strictEqual(r.opened.length, 1, 'local link opens');
    assert.strictEqual(r.opened[0].scheme, 'file');

    // Remote window with env.remoteAuthority: the link names the host.
    h = load();
    h.vscode.env.remoteName = 'ssh-remote';
    h.vscode.env.remoteAuthority = 'ssh-remote+box';
    text = await copy(h, file);
    assert.ok(text.includes(`&uri=${encodeURIComponent('vscode-remote://ssh-remote+box')}`), `remote link names the host: ${text}`);
    r = await follow(h, text);
    assert.strictEqual(r.opened.length, 1, 'same host opens');
    assert.strictEqual(r.opened[0].scheme, 'file', 'opened as a file of this host');
    assert.strictEqual(r.opened[0].path, posix, 'same path');

    // Another host, or a local window: refused with a warning.
    const other = load();
    other.vscode.env.remoteName = 'ssh-remote';
    other.vscode.env.remoteAuthority = 'ssh-remote+other';
    r = await follow(other, text);
    assert.strictEqual(r.opened.length, 0, 'other host does not open');
    assert.ok(/ssh-remote\+box/.test(r.warned[0] || ''), 'warns which host');
    r = await follow(load(), text);
    assert.strictEqual(r.opened.length, 0, 'local window does not open a remote link');

    // Stable API: env.remoteAuthority throws; the authority comes from the webview resource host.
    h = load();
    h.vscode.env.remoteName = 'ssh-remote';
    Object.defineProperty(h.vscode.env, 'remoteAuthority', { get() { throw new Error('proposed API'); } });
    h.vscode._webviewHost = 'vscode-remote+ssh-002dremote-002bbox.vscode-resource.vscode-cdn.net';
    text = await copy(h, file);
    assert.ok(text.includes(`&uri=${encodeURIComponent('vscode-remote://ssh-remote+box')}`), `derived authority: ${text}`);
    r = await follow(h, text);
    assert.strictEqual(r.opened.length, 1, 'derived authority: same host opens');

    // Hardening (review 2 #8): video files on a file system only, no UNC shares
    // (a UNC path is only one on Windows; elsewhere backslashes are part of a file name).
    h = load();
    for (const bad of [
      `vscode://x/open?frame=2&file=${encodeURIComponent(path.join(os.tmpdir(), 'notes.txt'))}`,
      ...(process.platform === 'win32' ? [`vscode://x/open?frame=2&file=${encodeURIComponent(String.raw`\\server\share\clip.mkv`)}`] : []),
      `vscode://x/open?frame=2&uri=${encodeURIComponent('untitled:clip.mkv')}`,
      `vscode://x/open?frame=2&uri=${encodeURIComponent('https://example.com/clip.mkv')}`,
    ]) {
      r = await follow(h, bad);
      assert.strictEqual(r.opened.length, 0, `refused: ${bad}`);
      assert.strictEqual(r.warned.length, 1, `warned: ${bad}`);
    }

    // A link's seek target is for the player it opens, not one opened by hand much later.
    h = load();
    text = await copy(h, file);
    await follow(h, text);
    const realNow = Date.now;
    Date.now = () => realNow() + 60e3;
    try {
      const s = h.open(file);
      await s.shown;
      assert.ok(!/"goto":\{/.test(s.panel.webview.html), 'expired link target not used');
      s.panel.dispose();
    } finally { Date.now = realNow; }
    await follow(h, text);
    const s2 = h.open(file);
    await s2.shown;
    assert.ok(/"goto":\{"frame":5/.test(s2.panel.webview.html), 'fresh link target used');
    s2.panel.dispose();

    // A reload (file changed on disk) does not jump back to the linked frame (review 2 #10).
    h = load({ settings: { 'videoPreviewEnhanced.decoder': 'builtin' } });
    const s3 = h.open(h.vscode.Uri.file(file).with({ fragment: 'frame=5' }));
    await s3.shown;
    assert.ok(/"goto":\{"frame":5/.test(s3.panel.webview.html), 'first page gets the linked frame');
    await s3.send({ type: 'ready' });
    const html0 = s3.panel.webview.html;
    fs.writeFileSync(file, Buffer.alloc(2000));
    await s3.until(() => s3.panel.webview.html !== html0, 4000);
    assert.ok(/"goto":null/.test(s3.panel.webview.html), 'reloaded page has no goto');
    s3.panel.dispose();
    console.log('frame link: ok');
  } finally {
    fs.unlinkSync(file);
  }
})().catch((e) => { console.error(e); process.exit(1); });
