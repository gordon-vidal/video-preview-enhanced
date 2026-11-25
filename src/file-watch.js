'use strict';

const fs = require('node:fs');
const path = require('node:path');

/** Watch one file by watching its parent, so replacing the file keeps notifications working. */
function watchFile(file, onChange, onError, io = fs) {
  const dir = path.dirname(file);
  const base = path.basename(file).toLowerCase();
  let closed = false;
  let checkedAt = -Infinity;
  const watcher = io.watch(dir, (event, name) => {
    if (closed) return;
    // On Windows, removing the directory can produce a stream of events naming the directory itself.
    if (name && path.isAbsolute(name)) {
      close();
      return;
    }
    if (event === 'rename' || !name) {
      const now = Date.now();
      if (now - checkedAt >= 1000) {
        checkedAt = now;
        try {
          if (!io.statSync(dir, { throwIfNoEntry: false })?.isDirectory()) {
            close();
            return;
          }
        } catch (e) {
          close();
          onError(e);
          return;
        }
      }
    }
    if (!name || name.toLowerCase() === base) onChange();
  });

  function close() {
    if (closed) return;
    closed = true;
    watcher.close();
  }
  watcher.on('error', (e) => {
    if (closed) return;
    close();
    onError(e);
  });
  return { close };
}

module.exports = { watchFile };
