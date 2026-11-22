'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const LOCK = path.join(os.tmpdir(), 'vpe-vscode-lock');
const LEGACY_MAX_AGE = 40 * 60_000;

function alive(pid) {
  try { process.kill(pid, 0); } catch (e) { return e.code !== 'ESRCH'; }
  return true;
}

function removeEmpty(dir) {
  try { fs.rmdirSync(dir); } catch (e) {
    if (e.code !== 'ENOENT' && e.code !== 'ENOTEMPTY' && e.code !== 'EEXIST') throw e;
  }
}

function holder() {
  try {
    const stat = fs.statSync(LOCK);
    const names = fs.readdirSync(LOCK);
    const owners = names.filter((name) => /^(vscode|perf)-[1-9]\d*-\d+$/.test(name));
    for (const owner of owners) {
      const [layer, pid, started] = owner.split('-');
      if (alive(Number(pid))) return `${layer} (PID ${pid}, since ${new Date(Number(started)).toISOString()})`;
    }
    if (owners.length) {
      for (const owner of owners) fs.unlinkSync(path.join(LOCK, owner));
      removeEmpty(LOCK);
      return null;
    }
    // A manual holder may leave a note instead of a PID. A new runner also looks like
    // a manual holder between mkdir and publishing its PID.
    const note = names.includes('owner.txt') ? fs.readFileSync(path.join(LOCK, 'owner.txt'), 'utf8').trim() : '';
    if (names.every((name) => name === 'owner.txt') && Date.now() - stat.mtimeMs > LEGACY_MAX_AGE) {
      const current = fs.statSync(LOCK);
      if (current.ino === stat.ino && current.mtimeMs === stat.mtimeMs) {
        if (names.length) fs.unlinkSync(path.join(LOCK, 'owner.txt'));
        removeEmpty(LOCK);
      }
      return null;
    }
    return note || 'the VS Code lock directory (manual holder or runner starting)';
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    return null;
  }
}

async function acquireVscodeLock(layer) {
  let waitingFor;
  for (;;) {
    try {
      fs.mkdirSync(LOCK);
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const owner = holder();
      if (!owner) continue;
      if (owner !== waitingFor) console.log(`waiting for ${owner} to release the VS Code lock`);
      waitingFor = owner;
      await new Promise((resolve) => setTimeout(resolve, 3000));
      continue;
    }
    const markers = [];
    const started = Date.now();
    const track = (pid) => {
      const marker = path.join(LOCK, `${layer}-${pid}-${started}`);
      fs.writeFileSync(marker, '', { flag: 'wx' });
      markers.push(marker);
    };
    try {
      track(process.pid);
    } catch (e) {
      removeEmpty(LOCK);
      throw e;
    }
    return {
      track,
      release() {
        for (const marker of markers) fs.unlinkSync(marker);
        removeEmpty(LOCK);
      },
    };
  }
}

module.exports = { acquireVscodeLock };
