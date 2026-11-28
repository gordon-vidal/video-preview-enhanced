'use strict';

const fs = require('node:fs');
const path = require('node:path');

function readHistory(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((file) => /^scenarios-.*\.json$/.test(file)).sort().reverse().flatMap((file) => {
    try {
      const run = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
      return Array.isArray(run.tests) ? [run] : [];
    } catch (error) {
      console.error(`Skipping ${file}: ${error.message}`);
      return [];
    }
  });
}

function rates(history, limit = Infinity) {
  const counts = new Map();
  for (const { tests } of history) {
    const ran = new Map();
    for (const test of tests) {
      if (!test.skipped) ran.set(test.name, !test.ok || ran.get(test.name));
    }
    for (const [name, failed] of ran) {
      if (!counts.has(name)) counts.set(name, { failed: 0, total: 0 });
      const count = counts.get(name);
      if (count.total >= limit) continue;
      count.total++;
      if (failed) count.failed++;
    }
  }
  return counts;
}

function printReport(history) {
  const rows = [...rates(history)].sort(([a, x], [b, y]) =>
    y.failed / y.total - x.failed / x.total || y.total - x.total || a.localeCompare(b));
  console.log(`Layer 3 fail rates over ${history.length} saved runs`);
  for (const [name, { failed, total }] of rows) {
    console.log(`${failed}/${total} (${(100 * failed / total).toFixed(1)}%) ${name}`);
  }
}

if (require.main === module) printReport(readHistory(path.join(__dirname, '../test/vscode/out')));
module.exports = { readHistory, rates, printReport };
