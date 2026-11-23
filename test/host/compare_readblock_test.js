'use strict';
// node test/host/compare_readblock_test.js: Compare's host block reads share src/read-block.js: tile keys that name
// no file are rejected, a bad range answers an empty block (never a read at position -1), and a request that was
// overtaken by a reload while the file opened neither reads nor posts. Both session classes ignore null and
// primitive envelopes.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { load, webviewConfig } = require('./mock_vscode');
const { fileOfKey } = require('../../src/compare');

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vpe_cmp_rb_'));
  const bytes = [0, 1].map((k) => Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 7 + k * 91) & 255)));
  const files = bytes.map((b, k) => { const p = path.join(dir, `c${k}.mp4`); fs.writeFileSync(p, b); return p; });
  const h = load({ settings: { 'videoPreviewEnhanced.decoder': 'builtin', 'videoPreviewEnhanced.compare.maxVideos': 4 } });
  const origOpen = fs.promises.open;
  let compare;
  try {
    // Engine keys: tiles 'A'-'P', scans 'sA'/'sB'; anything else names no file instead of falling back to file A.
    assert.strictEqual(fileOfKey('A'), 0);
    assert.strictEqual(fileOfKey('P'), 15);
    assert.strictEqual(fileOfKey('sA'), 0);
    assert.strictEqual(fileOfKey('sB'), 1);
    for (const bad of ['', 'Z', 'a', 'sC', 'sP', 'tile-A', 'AB', 's', null, undefined, 1, {}, ['A']]) {
      assert.strictEqual(fileOfKey(bad), -1, `fileOfKey(${JSON.stringify(bad)})`);
    }

    const posts = [];
    let receive = null;
    const webview = {
      cspSource: 'vscode-resource:', asWebviewUri: (u) => u,
      postMessage(m) { posts.push(m); }, onDidReceiveMessage(fn) { receive = fn; },
    };
    h.vscode.window.createWebviewPanel = () => ({ webview, onDidDispose() {}, onDidChangeViewState() {} });
    compare = await h.vscode._commands['videoPreviewEnhanced.compare'](null, files.map(h.vscode.Uri.file));
    const blocks = () => posts.filter((m) => m.type === 'block');
    const errors = () => posts.filter((m) => m.type === 'error');

    // Normal reads, with the tile key echoed back for the engine.
    await compare.readBlock('A', 16, 32);
    await compare.readBlock('sB', 0, 8);
    assert.deepStrictEqual(blocks().map((b) => [b.key, b.pos, Buffer.from(b.data).equals(bytes[b.key === 'A' ? 0 : 1].subarray(b.pos, b.pos + b.data.length))]),
      [['A', 16, true], ['sB', 0, true]]);
    assert.strictEqual(blocks()[0].data.length, 32);
    assert.strictEqual(blocks()[0].page, compare.page, 'replies carry the page');
    await compare.readBlock('B', 4090, 100);
    assert.strictEqual(blocks().pop().data.length, 6, 'cut at the end of the file');
    await compare.readBlock('A', 9999, 16);
    assert.strictEqual(blocks().pop().data.length, 0, 'past the end is empty');

    // Keys naming no file reject, and nothing is posted.
    posts.length = 0;
    for (const key of ['Z', 'C', 'D', 'P', '', null, undefined, 123, 'tile-A', {}]) {
      await assert.rejects(() => compare.readBlock(key, 0, 64), /no file for tile key/, `key ${JSON.stringify(key)}`);
    }
    assert.strictEqual(posts.length, 0, 'a bad key posts nothing');
    // ... also from the page: reported as an error, never as a read of file A.
    receive({ type: 'readBlock', page: compare.page, key: 'tile-A', pos: 0, len: 64 });
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(blocks().length, 0);
    assert.strictEqual(errors().length, 1, 'the page learns about the bad key');

    // A bad range answers an empty block once: no read at fd position -1, no RangeError.
    posts.length = 0;
    let reads = 0;
    const real = await compare.blockFile(0);
    const origRead = real.fh.read.bind(real.fh);
    real.fh.read = (...a) => { reads++; return origRead(...a); };
    for (const [pos, len] of [[-1, 64], [-32, 64], [NaN, 8], [1.5, 8], [Infinity, 8], [0, -10], [0, NaN], [0, Infinity]]) {
      posts.length = 0;
      await compare.readBlock('A', pos, len);
      assert.strictEqual(posts.length, 1, `${pos}+${len}: one answer`);
      assert.strictEqual(posts[0].type, 'block');
      assert.strictEqual(posts[0].key, 'A');
      assert.strictEqual(posts[0].data.length, 0);
      assert.strictEqual(posts[0].error, 'invalid range');
    }
    assert.strictEqual(reads, 0, 'bad ranges never reach the file');
    assert.strictEqual(errors().length, 0);

    // A reload while the file opens: the request neither reads nor posts (checked after blockFile()).
    compare.closeFiles();
    let openedFh;
    let finishOpen;
    let reloadReads = 0;
    const gate = new Promise((r) => { finishOpen = r; });
    fs.promises.open = async (...a) => {
      await gate;
      openedFh = await origOpen(...a);
      openedFh.read = () => { reloadReads++; throw new Error('read after a reload'); };
      return openedFh;
    };
    posts.length = 0;
    const pending = compare.readBlock('A', 0, 64);
    await new Promise((r) => setImmediate(r));
    compare.reload();
    finishOpen();
    await pending;
    assert.strictEqual(reloadReads, 0, 'a request overtaken by a reload never calls fh.read');
    assert.strictEqual(posts.filter((m) => m.type === 'block' || m.type === 'error').length, 0,
      'a request overtaken by a reload does not read or post');
    fs.promises.open = origOpen;
    if (openedFh) await openedFh.close().catch(() => {});

    // Envelopes that are not objects are ignored by Compare ...
    for (const m of [null, undefined, 0, 7, 'ready', true, NaN]) {
      await compare.onMessage(m);
      receive(m);
    }
    assert.strictEqual(errors().length, 0, 'Compare ignores null and primitive envelopes');
  } finally {
    fs.promises.open = origOpen;
    if (compare) compare.dispose();
    h.dispose();
  }

  // ... and by the single-file Session.
  const h2 = load();
  const s = h2.open(files[0]);
  try {
    await s.shown;
    const { page } = webviewConfig(s.panel.webview);
    const before = s.posted.length;
    for (const m of [null, undefined, 0, 7, 'readBlock', true, NaN]) await s.send(m);
    await s.send({ type: 'readBlock', page, pos: -1, len: 64 });
    const added = s.posted.slice(before);
    assert.ok(!added.some((m) => m.type === 'error'), `no error for junk envelopes: ${JSON.stringify(added)}`);
    const bad = added.filter((m) => m.type === 'block');
    assert.strictEqual(bad.length, 1, 'a negative position answers once');
    assert.strictEqual(bad[0].data.length, 0);
    await s.send({ type: 'readBlock', page, pos: 4, len: 8 });
    assert.ok(Buffer.from(s.posted.filter((m) => m.type === 'block').pop().data).equals(bytes[0].subarray(4, 12)));
  } finally {
    s.panel.dispose();
    h2.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log('compare readBlock: key, range, epoch and envelope tests passed');
})().catch((e) => { console.error(e); process.exitCode = 1; });
