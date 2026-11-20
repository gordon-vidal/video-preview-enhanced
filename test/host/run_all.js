#!/usr/bin/env node
'use strict';
// Kept for callers of the old command (CI and the publish workflow): layer 1 now runs through the one
// entry point, `node test/run.js unit` (docs/TESTING.md), which runs these host tests and the other
// unit tests in parallel. Arguments go along (e.g. --grep).
const path = require('path');
const { spawnSync } = require('child_process');

const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'run.js'), 'unit', ...process.argv.slice(2)], { stdio: 'inherit', windowsHide: true });
process.exit(r.status === null ? 1 : r.status);
