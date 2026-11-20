#!/usr/bin/env node
'use strict';
// Fails when a tracked text file contains personal data: a home-directory path of a real user or an
// e-mail address (GitHub noreply and obvious placeholders are fine). Run by CI; also: node tools/check-personal-data.js
// Allow a line on purpose with the marker "personal-data-ok" in it.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const PLACEHOLDER = /^(<.*>|\.\.\.|%.*%|\$.*|\{.*\}|user|users|username|you|me|name|yourname|your-name|example|runner|runneradmin|public|default|vscode|node|ubuntu|root|x|foo|bar|u|web_user)$/i;
const checks = [
  { what: 'Windows home path', re: /[A-Za-z]:[\\/]+Users[\\/]+([^\\/\s"'`)<>*:]+)/g },
  { what: 'Unix home path', re: /(?:^|[\s"'`(=:])\/(?:home|Users)\/([^/\s"'`)<>*:]+)/g },
];
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const EMAIL_OK = /(@users\.noreply\.github\.com|noreply@|@example\.(com|org|net)$|@localhost)/i;
// Not a source of text we wrote: media, binaries, lock files, third-party licence texts.
const SKIP = /\.(png|jpe?g|gif|webp|ico|mp4|mkv|mov|avi|webm|wmv|flv|mxf|mpg|ogv|vob|wasm|woff2?|ttf|vsix|zip|gz|xz|bin|sub|idx|sup|sbv)$|(^|\/)package-lock\.json$|^media\/libav-vpe\//i;

const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, maxBuffer: 1 << 26 })
  .toString('utf8').split('\0').filter((f) => f && !SKIP.test(f));
const problems = [];
for (const f of files) {
  let text;
  try { text = fs.readFileSync(path.join(root, f), 'utf8'); } catch { continue; }
  if (text.includes('\0')) continue;
  text.split(/\r?\n/).forEach((line, i) => {
    if (line.includes('personal-data-ok')) return;
    for (const { what, re } of checks) {
      for (const m of line.matchAll(re)) if (!PLACEHOLDER.test(m[1])) problems.push(`${f}:${i + 1}: ${what} "${m[0].trim()}"`);
    }
    for (const m of line.matchAll(EMAIL)) if (!EMAIL_OK.test(m[0])) problems.push(`${f}:${i + 1}: e-mail address "${m[0]}"`);
  });
}
if (problems.length) {
  console.error(`Personal data in tracked files (${problems.length}):\n${problems.join('\n')}`);
  console.error('Use a placeholder (<user>, you@example.com) or remove it. AGENTS.md: "Rules".');
  process.exit(1);
}
console.log(`personal-data check: ${files.length} files clean`);
