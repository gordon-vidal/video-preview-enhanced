'use strict';
// node test/run.js unit --grep compare_readblock: a comparing viewer's block reads (src/unified-viewer.js over
// src/read-block.js): each clip's blocks by its id (the page never names a file), a clip id the viewer does not show
// reads nothing, a bad range answers an empty block (never a read at position -1), a request overtaken by a reload
// of its clip neither reads nor posts, and null or primitive envelopes are ignored. The legacy tile keys of
// src/comparepick.js fileOfKey still map to files only when they name one.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { load } = require('./mock_vscode');
const { fileOfKey } = require('../../src/comparepick');

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vpe_cmp_rb_'));
  const bytes = [0, 1].map((k) => Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 7 + k * 91) & 255)));
  const files = bytes.map((b, k) => { const p = path.join(dir, `c${k}.mp4`); fs.writeFileSync(p, b); return p; });
  const h = load({ settings: { 'videoPreviewEnhanced.decoder': 'builtin', 'videoPreviewEnhanced.compare.maxVideos': 4 } });
  const origOpen = fs.promises.open;
  try {
    // Engine keys: tiles 'A'-'P', scans 'sA'/'sB'; anything else names no file instead of falling back to file A.
    assert.strictEqual(fileOfKey('A'), 0);
    assert.strictEqual(fileOfKey('P'), 15);
    assert.strictEqual(fileOfKey('sA'), 0);
    assert.strictEqual(fileOfKey('sB'), 1);
    for (const bad of ['', 'Z', 'a', 'sC', 'sP', 'tile-A', 'AB', 's', null, undefined, 1, {}, ['A']]) {
      assert.strictEqual(fileOfKey(bad), -1, `fileOfKey(${JSON.stringify(bad)})`);
    }

    const s = h.nextPanel();
    const viewer = await h.vscode._commands['videoPreviewEnhanced.compare'](null, files.map(h.vscode.Uri.file));
    await s.send({ type: 'ready' });
    const [A, B] = viewer.session.clips.map((c) => c.id);
    const page = s.cfg().page;
    const blocks = () => s.posted.filter((m) => m.type === 'block');
    const read = (clipId, pos, len) => s.send({ type: 'readBlock', clipId, pos, len });

    // Normal reads, with the clip id echoed back for the page's decoder.
    await read(A, 16, 32);
    await read(B, 0, 8);
    assert.deepStrictEqual(blocks().map((b) => [b.clipId, b.pos, Buffer.from(b.data).equals(bytes[b.clipId === A ? 0 : 1].subarray(b.pos, b.pos + b.data.length))]),
      [[A, 16, true], [B, 0, true]]);
    assert.strictEqual(blocks()[0].data.length, 32);
    assert.strictEqual(blocks()[0].page, page, 'replies carry the page');
    await read(B, 4090, 100);
    assert.strictEqual(blocks().pop().data.length, 6, 'cut at the end of the file');
    await read(A, 9999, 16);
    assert.strictEqual(blocks().pop().data.length, 0, 'past the end is empty');

    // Clip ids the viewer does not show (or a tile letter) read nothing and post nothing: never file A.
    s.posted.length = 0;
    for (const clipId of ['Z', 'A', '', 'tile-A', `${A}x`]) await read(clipId, 0, 64);
    assert.strictEqual(s.posted.length, 0, 'an unknown clip posts nothing');

    // A bad range answers an empty block once: no read at fd position -1, no RangeError.
    let reads = 0;
    fs.promises.open = async (...a) => {
      const fh = await origOpen(...a);
      const orig = fh.read.bind(fh);
      fh.read = (...r) => { reads++; return orig(...r); };
      return fh;
    };
    await viewer.reloadClip(A); // a fresh file handle, counted
    const A2 = viewer.session.clips[0].id;
    for (const [pos, len] of [[-1, 64], [-32, 64], [NaN, 8], [1.5, 8], [Infinity, 8], [0, -10], [0, NaN], [0, Infinity]]) {
      s.posted.length = 0;
      await read(A2, pos, len);
      assert.strictEqual(s.posted.length, 1, `${pos}+${len}: one answer`);
      assert.deepStrictEqual([s.posted[0].type, s.posted[0].clipId, s.posted[0].data.length, s.posted[0].error], ['block', A2, 0, 'invalid range']);
    }
    assert.strictEqual(reads, 0, 'bad ranges never reach the file');
    fs.promises.open = origOpen;

    // A reload while the file opens: the request neither reads nor posts (checked after the open).
    await viewer.reloadClip(A2);
    const A3 = viewer.session.clips[0].id;
    let finishOpen;
    let reloadReads = 0;
    let openedFh;
    const gate = new Promise((r) => { finishOpen = r; });
    let first = true;
    fs.promises.open = async (...a) => {
      if (!first) return origOpen(...a);
      first = false;
      await gate;
      openedFh = await origOpen(...a);
      openedFh.read = () => { reloadReads++; throw new Error('read after a reload'); };
      return openedFh;
    };
    s.posted.length = 0;
    const pending = read(A3, 0, 64);
    await new Promise((r) => setImmediate(r));
    await viewer.reloadClip(A3);
    finishOpen();
    await pending;
    assert.strictEqual(reloadReads, 0, 'a request overtaken by a reload never calls fh.read');
    assert.strictEqual(blocks().length, 0, 'a request overtaken by a reload does not post');
    fs.promises.open = origOpen;
    if (openedFh) await openedFh.close().catch(() => {});

    // Envelopes that are not objects are ignored.
    s.posted.length = 0;
    for (const m of [null, undefined, 0, 7, 'ready', true, NaN]) await s.send(m);
    assert.strictEqual(s.posted.length, 0, 'null and primitive envelopes are ignored');
    s.panel.dispose();
  } finally {
    fs.promises.open = origOpen;
    h.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log('compare readBlock: clip id, range, reload and envelope tests passed');
})().catch((e) => { console.error(e); process.exitCode = 1; });
