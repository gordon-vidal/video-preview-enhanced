'use strict';

const fs = require('fs');
const path = require('path');

// VS Code appends the target platform to platform-specific VSIX installs.
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9a-z-]+(?:\.[0-9a-z-]+)*)?(?:\+[0-9a-z-]+(?:\.[0-9a-z-]+)*)?$/i;

async function otherInstalledVersions(extensionDir, extensionId) {
  const dir = path.dirname(extensionDir);
  const mine = path.basename(extensionDir).toLowerCase();
  if (!extensionId) return [];
  const prefix = `${extensionId.toLowerCase()}-`;
  const matches = (name) => name.toLowerCase().startsWith(prefix) && VERSION.test(name.slice(prefix.length));
  if (!matches(mine)) return [];
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });
  return entries.filter((e) => e.isDirectory() && e.name.toLowerCase() !== mine && matches(e.name))
    .map((e) => e.name).sort();
}

module.exports = { otherInstalledVersions };
