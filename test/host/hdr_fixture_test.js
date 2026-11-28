'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vpe-hdr-test-'));
const generator = path.join(__dirname, '../zoo/make_hdr.js');
const encoder = path.join(dir, 'fake-encoder.cjs');
fs.writeFileSync(encoder, `
  const fs = require('node:fs');
  const path = require('node:path');
  const assert = require('node:assert/strict');
  require('node:child_process').spawnSync = (_, args) => {
    const input = args[args.indexOf('-i') + 1];
    const output = args.at(-1);
    assert.ok(fs.statSync(input).size > 0);
    assert.notEqual(path.basename(input), 'h264_pq.mp4.yuv');
    assert.notEqual(output, path.join(process.argv[2], 'hdr', 'h264_pq.mp4'));
    fs.writeFileSync(output, process.env.VPE_HDR_TEST_FAIL ? 'partial' : 'complete');
    return { status: process.env.VPE_HDR_TEST_FAIL ? 1 : 0 };
  };
`);

function generate(fail = false) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--require', encoder, generator, dir, 'h264_pq.mp4'], {
      stdio: 'inherit',
      env: { ...process.env, VPE_HDR_TEST_FAIL: fail ? '1' : '' },
    });
    child.on('error', reject);
    child.on('close', resolve);
  });
}

(async () => {
  const folder = path.join(dir, 'hdr');
  const final = path.join(folder, 'h264_pq.mp4');
  assert.equal(await generate(true), 1);
  assert.deepEqual(fs.readdirSync(folder), []);
  const statuses = await Promise.all([generate(), generate()]);
  assert.deepEqual(statuses, [0, 0]);
  assert.deepEqual(fs.readdirSync(folder), ['h264_pq.mp4']);
  assert.equal(fs.readFileSync(final, 'utf8'), 'complete');
})().finally(() => fs.rmSync(dir, { recursive: true, force: true })).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
