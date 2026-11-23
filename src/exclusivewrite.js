'use strict';
// Create-only file writes for the frame export. vscode.workspace.fs has no O_EXCL, so a stat followed by
// writeFile can lose a race and overwrite a file the user never approved. Local files use the OS's
// atomic exclusive create ('wx'); other schemes (virtual / remote file systems) have no such flag, so
// writes to the same URI are serialized in this process and checked with stat inside the lock.
const fs = require('fs');

/** @type {Map<string, Promise<unknown>>} URI string -> tail of the in-flight write chain. */
const inFlight = new Map();

/** Runs `task` after every earlier task for `key` has settled (success or failure). */
function serialize(key, task) {
  const prev = inFlight.get(key) || Promise.resolve();
  const run = prev.then(task, task);
  const tail = run.catch(() => {});
  inFlight.set(key, tail);
  tail.then(() => { if (inFlight.get(key) === tail) inFlight.delete(key); });
  return run;
}

const isNotFound = (e) => !!e && (e.code === 'FileNotFound' || e.code === 'ENOENT');

/**
 * Writes `data` to `uri`. Unless `overwrite` (the user approved replacing this name), an existing file is never
 * replaced: the result is 'exists' and the file is left untouched.
 * `wsFs` is vscode.workspace.fs; `nodeFs` is injectable (default fs.promises) so tests drive the real 'wx' path.
 * @returns {Promise<'written' | 'exists'>}
 */
async function writeNew(wsFs, uri, data, { overwrite = false, nodeFs = fs.promises } = {}) {
  if (overwrite) {
    await wsFs.writeFile(uri, data);
    return 'written';
  }
  if (typeof wsFs.writeFileExclusive === 'function') return wsFs.writeFileExclusive(uri, data); // injected by tests
  if (uri.scheme === 'file' && uri.fsPath) {
    try {
      await nodeFs.writeFile(uri.fsPath, data, { flag: 'wx' });
      return 'written';
    } catch (e) {
      if (e && e.code === 'EEXIST') return 'exists';
      throw e;
    }
  }
  return serialize(uri.toString(), async () => {
    if (typeof wsFs.stat === 'function') {
      try {
        await wsFs.stat(uri);
        return 'exists';
      } catch (e) {
        if (!isNotFound(e)) throw e;
      }
    }
    await wsFs.writeFile(uri, data);
    return 'written';
  });
}

module.exports = { writeNew, serialize };
