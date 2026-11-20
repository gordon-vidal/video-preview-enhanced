#!/usr/bin/env node
'use strict';
// Checks relative links and #anchors in tracked Markdown files (no network, no dependencies).
// Run by CI; also: node tools/check-links.js
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const files = execFileSync('git', ['ls-files', '-z', '*.md'], { cwd: root }).toString('utf8').split('\0').filter(Boolean)
  .filter((f) => !f.startsWith('test/media/') && !f.startsWith('.claude/worktrees/'));
const slug = (h) => h.toLowerCase().replace(/<[^>]+>/g, '').replace(/[`*_~]/g, '').replace(/[^\p{L}\p{N}\s-]/gu, '').trim().replace(/\s/g, '-');
const anchorCache = new Map();
function anchors(file) {
  if (!anchorCache.has(file)) {
    const set = new Set();
    let fence = false;
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      if (/^\s*(```|~~~)/.test(line)) { fence = !fence; continue; }
      const m = !fence && /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
      if (m) set.add(slug(m[1]));
    }
    anchorCache.set(file, set);
  }
  return anchorCache.get(file);
}

const problems = [];
for (const f of files) {
  let fence = false;
  fs.readFileSync(path.join(root, f), 'utf8').split(/\r?\n/).forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) { fence = !fence; return; }
    if (fence) return;
    const text = line.replace(/`[^`]*`/g, '');
    for (const m of text.matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) {
      const target = m[1];
      if (/^(https?:|mailto:|vscode:|command:|data:|\/\/)/i.test(target)) continue;
      const [rel, hash] = target.split('#');
      const abs = rel ? path.resolve(root, path.dirname(f), decodeURI(rel)) : path.join(root, f);
      if (rel && !fs.existsSync(abs)) { problems.push(`${f}:${i + 1}: missing file ${target}`); continue; }
      if (hash && abs.endsWith('.md') && fs.statSync(abs).isFile() && !anchors(abs).has(hash.toLowerCase()))
        problems.push(`${f}:${i + 1}: missing anchor ${target}`);
    }
  });
}
if (problems.length) {
  console.error(`Broken Markdown links (${problems.length}):\n${problems.join('\n')}`);
  process.exit(1);
}
console.log(`link check: ${files.length} Markdown files ok`);
