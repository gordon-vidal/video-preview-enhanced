'use strict';

const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const LOCK = path.join(os.tmpdir(), 'vpe-vscode-lock');
const HELPER = path.join(__dirname, 'vscode_lock.py');

function lockAction(action, ...args) {
  const r = spawnSync('python', ['-I', HELPER, LOCK, action, ...args], { encoding: 'utf8', windowsHide: true });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(r.stderr.trim() || `VS Code lock helper exited ${r.status}`);
  return JSON.parse(r.stdout);
}

async function acquireVscodeLock(layer) {
  if (process.platform !== 'win32') return null; // Only Windows can run the hidden desktop.
  let waitingFor;
  for (;;) {
    const { acquired, layer: heldLayer, pid, started, note } = lockAction('acquire', layer, process.pid);
    if (acquired) {
      const children = [];
      return {
        track(childPid) {
          children.push(lockAction('track', acquired, layer, childPid).tracked);
        },
        release() { lockAction('release', acquired, ...children); },
      };
    }
    const owner = heldLayer ? `${heldLayer} (PID ${pid}, since ${new Date(started).toISOString()})`
      : note || 'the VS Code lock directory (manual holder)';
    if (owner !== waitingFor) console.log(`waiting for ${owner} to release the VS Code lock`);
    waitingFor = owner;
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
}

module.exports = { acquireVscodeLock };
