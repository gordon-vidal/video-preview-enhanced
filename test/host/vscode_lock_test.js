'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { pathToFileURL } = require('url');

const lib = path.join(__dirname, '..', 'lib');
const helper = path.join(lib, 'vscode_lock.py');
const gate = pathToFileURL(path.join(lib, 'vscode_gate.mjs')).href;

function action(lock, ...args) {
  return new Promise((resolve, reject) => {
    const child = spawn('python', ['-I', helper, lock, ...args], { windowsHide: true });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(err || `lock helper exited ${code}`));
      else resolve(JSON.parse(out));
    });
  });
}

async function testTakeover(lock) {
  fs.mkdirSync(lock);
  const expired = new Date(Date.now() - 41 * 60_000);
  fs.utimesSync(lock, expired, expired);
  const contenders = await Promise.all(Array.from({ length: 4 }, () => action(lock, 'acquire', 'vscode', process.pid)));
  const winners = contenders.filter((result) => result.acquired);
  assert.strictEqual(winners.length, 1);
  const own = winners[0].acquired;
  assert.deepStrictEqual(fs.readdirSync(lock), [own]);

  // The PID is ours and still live, but the recorded creation time refers to a different process.
  fs.writeFileSync(path.join(lock, own), '0');
  const replacement = await action(lock, 'acquire', 'vscode', process.pid);
  assert.ok(replacement.acquired, 'a reused PID must not hold the lock');
  await action(lock, 'release', replacement.acquired);
  assert.ok(!fs.existsSync(lock));
}

async function testGate(lock, script) {
  fs.writeFileSync(script, "process.stdout.write('started');");
  async function run(authorize) {
    const child = spawn(process.execPath, ['--import', gate, script], {
      stdio: ['ignore', 'pipe', 'inherit', 'ipc'], windowsHide: true,
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    const ended = new Promise((resolve) => child.stdout.once('end', resolve));
    const exited = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', resolve);
    });
    const done = Promise.all([exited, ended]).then(([code]) => code);
    if (!authorize) {
      child.disconnect();
      assert.strictEqual(await done, 1);
      assert.strictEqual(out, '');
      return;
    }
    const { acquired } = await action(lock, 'acquire', 'vscode', process.pid);
    const { tracked } = await action(lock, 'track', acquired, 'vscode', child.pid);
    assert.deepStrictEqual(fs.readdirSync(lock).sort(), [acquired, tracked].sort());
    assert.strictEqual(out, '');
    fs.writeFileSync(path.join(lock, acquired), '0'); // Simulate a stale runner marker while its layer is live.
    const held = await action(lock, 'acquire', 'perf', process.pid);
    assert.strictEqual(held.pid, String(child.pid));
    child.send('start');
    assert.strictEqual(await done, 0);
    assert.strictEqual(out, 'started');
    await action(lock, 'release', acquired, tracked);
  }
  await run(false);
  await run(true);
}

async function main() {
  if (process.platform !== 'win32' || spawnSync('python', ['-V'], { windowsHide: true }).status !== 0) {
    console.log('SKIP requires Windows and Python 3');
    return;
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vpe-lock-test-'));
  try {
    const lock = path.join(tmp, 'lock');
    await testTakeover(lock);
    await testGate(lock, path.join(tmp, 'layer.js'));
    console.log('VS Code lock takeover, process identity and launch gate: ok');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

process.exitCode = 1;
main().then(() => { process.exitCode = 0; }, (err) => { console.error(err); });
