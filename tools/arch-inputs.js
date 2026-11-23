'use strict';

const { execFileSync } = require('node:child_process');
const { readdirSync, statSync } = require('node:fs');
const path = require('node:path');
const { files: checkedFiles } = require('../tsconfig.check.json');

const root = path.join(__dirname, '..');
const history = execFileSync('git', [
  'log', '--since-as-filter=60.days', '--no-merges', '--no-renames', '--format=%x00', '--name-only', '-z', 'HEAD', '--',
], { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });

const churn = new Map();
const coupling = new Map();

function increment(counts, key) {
  counts.set(key, (counts.get(key) || 0) + 1);
}

// The first newline belongs to Git's format. NUL delimiters preserve whitespace in paths.
for (const commit of history.split(/\0{2,}/)) {
  const files = [...new Set(commit.replace(/^\n/, '').split('\0').filter(Boolean))].sort();
  for (const [index, file] of files.entries()) {
    increment(churn, file);
    for (const other of files.slice(index + 1)) {
      increment(coupling, JSON.stringify([file, other]));
    }
  }
}

function sourceSizes(directory) {
  const result = [];
  for (const entry of readdirSync(path.join(root, directory), { withFileTypes: true })) {
    const file = `${directory}/${entry.name}`;
    if (file === 'media/libav-vpe') continue;
    if (entry.isDirectory()) result.push(...sourceSizes(file));
    if (entry.isFile()) result.push([file, statSync(path.join(root, file)).size]);
  }
  return result;
}

function ranked(heading, values, limit, label, unit) {
  console.log(`\n## ${heading}\n`);
  const rows = [...values].sort(([a, left], [b, right]) => right - left || a.localeCompare(b)).slice(0, limit);
  for (const [key, count] of rows) console.log(`- ${label(key)} — ${count} ${unit}`);
  if (!rows.length) console.log('No entries.');
}

const code = file => `\`${file}\``;

console.log('# Architecture inputs');
console.log('\nGit counts use non-merge commits reachable from HEAD in the last 60 days.');
ranked('Top 15 files by commit count', churn, 15, code, 'commits');
ranked('Top 10 files changed together', coupling, 10, pair => JSON.parse(pair).map(code).join(' + '), 'commits');
console.log(`\n## Typecheck coverage (${checkedFiles.length} files)\n`);
console.log('Files listed in tsconfig.check.json. Semantic checks generally apply to marked regions.');
for (const file of checkedFiles) console.log(`- ${code(file)}`);
ranked('Top 10 largest files in src/ and media/ (excluding libav-vpe)', [
  ...sourceSizes('src'), ...sourceSizes('media'),
], 10, code, 'bytes');
