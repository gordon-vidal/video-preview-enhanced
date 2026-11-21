'use strict';
// Fixture for test/host/run_limits_test.js: prints a line, then hangs (or stays silent / exits at once).
const mode = process.argv[2];
if (mode !== 'silent') console.log('first line');
if (mode === 'ok') console.log('ok done');
else setInterval(() => {}, 1000);
