'use strict';

const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { publish } = require('../../src/clipexport');

(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vpe-publish-'));
  const staged = path.join(dir, 'staged.mp4');
  const final = path.join(dir, 'final.mp4');
  const link = fs.link;
  try {
    await fs.writeFile(staged, 'verified clip');
    const ctl = new AbortController();
    fs.link = async () => { throw Object.assign(new Error('unsupported'), { code: 'ENOTSUP' }); };
    // No hard links: publish by reserving the name, then renaming over the empty placeholder.
    await publish(staged, final, ctl.signal);
    assert.equal(await fs.readFile(final, 'utf8'), 'verified clip');
    await assert.rejects(() => fs.stat(staged), { code: 'ENOENT' });
    // Without hard links an existing file is still never replaced.
    await fs.writeFile(staged, 'verified clip');
    await assert.rejects(() => publish(staged, final, ctl.signal), { code: 'EEXIST' });
    assert.equal(await fs.readFile(final, 'utf8'), 'verified clip');
    await fs.unlink(final);
    fs.link = link;
    await fs.writeFile(final, 'existing clip');
    await assert.rejects(() => publish(staged, final, ctl.signal), { code: 'EEXIST' });
    assert.equal(await fs.readFile(final, 'utf8'), 'existing clip');
    await fs.unlink(final);
    fs.link = async (...args) => {
      await link(...args);
      ctl.abort();
    };
    await assert.rejects(() => publish(staged, final, ctl.signal), { name: 'AbortError' });
    await assert.rejects(() => fs.stat(final), { code: 'ENOENT' });
    assert.equal(await fs.readFile(staged, 'utf8'), 'verified clip');
  } finally {
    fs.link = link;
    await fs.rm(dir, { recursive: true, force: true });
  }
})().catch((e) => { console.error(e); process.exitCode = 1; });
