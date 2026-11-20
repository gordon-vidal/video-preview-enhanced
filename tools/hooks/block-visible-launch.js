#!/usr/bin/env node
'use strict';
// Claude Code PreToolUse hook (see .claude/settings.json): blocks shell commands that would open a
// visible VS Code window or a browser during an agent run. The hidden-desktop test runner is not
// affected: agents run `node test/vscode/run.js ...`, whose first word is `node`; it launches Code.exe
// itself through test/vscode/hidden_launch.py.
// Exit 2 + stderr = block (the message goes back to the agent); exit 0 = no opinion.
// Also usable by hand: echo '{"tool_input":{"command":"code ."}}' | node tools/hooks/block-visible-launch.js

const PROGRAMS = new Set([
  'code', 'code-insiders', 'codium', 'cursor', 'windsurf', 'msedge', 'chrome', 'google-chrome', 'chromium',
  'chromium-browser', 'firefox', 'brave', 'brave-browser', 'opera', 'vivaldi', 'iexplore', 'explorer',
  'xdg-open', 'sensible-browser', 'x-www-browser', 'gio', 'open', 'wslview', 'review',
]);
// Commands that open "whatever is associated" and are only a problem with a URL or an HTML file.
const OPENERS = new Set(['start', 'start-process', 'saps', 'invoke-item', 'ii']);
const URL_OR_HTML = /(https?:\/\/|file:\/\/|\.html?\b)/i;
const WRAPPERS = new Set(['cmd', 'cmd.exe', 'powershell', 'powershell.exe', 'pwsh', 'pwsh.exe', 'sh', 'bash', 'env',
  'sudo', 'command', 'call', 'nohup', 'wsl', 'wsl.exe']);

function words(segment) {
  return (segment.match(/"[^"]*"|'[^']*'|\S+/g) || []).map((w) => w.replace(/^["'`&(]+|["')`]+$/g, ''));
}

function base(word) {
  const name = word.split(/[\\/]/).pop().toLowerCase();
  return name.replace(/\.(exe|cmd|bat|ps1)$/, '');
}

function violation(command) {
  // Split into simple commands; also look inside quoted wrapper arguments (cmd /c "start x.html").
  const segments = command.split(/&&|\|\||[;|\n]/);
  for (const seg of segments) {
    let w = words(seg).filter((x) => x && !/^[A-Za-z_]\w*=/.test(x));
    // Peel wrappers and their flags: `cmd /c start ...`, `powershell -Command Start-Process ...`.
    while (w.length && (WRAPPERS.has(w[0].toLowerCase()) || /^[-/][A-Za-z]+$/.test(w[0]))) w = w.slice(1);
    if (w.length === 1 && /\s/.test(w[0])) w = words(w[0]);
    if (!w.length) continue;
    const prog = base(w[0]);
    const rest = w.slice(1).join(' ');
    if (prog === 'node' || prog === 'python' || prog === 'python3' || prog === 'py') {
      if (!/\bwebbrowser\b|\bopen\(\s*['"]https?:/i.test(rest)) continue;
      return `${prog} opening a browser`;
    }
    if (prog === 'git' || prog === 'npm' || prog === 'npx') continue;
    if (PROGRAMS.has(prog)) return prog;
    if (OPENERS.has(prog) && (URL_OR_HTML.test(rest) || PROGRAMS.has(base(w[1] || '')))) return prog + ' ' + rest.slice(0, 60);
  }
  if (/\b(Start-Process|saps|Invoke-Item)\b[^\n]*(https?:\/\/|\.html?\b|\b(code|msedge|chrome|firefox)(\.exe)?\b)/i.test(command)) {
    return 'Start-Process / Invoke-Item on a URL, HTML file or browser';
  }
  return null;
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { input += c; });
process.stdin.on('end', () => {
  let command = '';
  try { command = String((JSON.parse(input).tool_input || {}).command || ''); } catch { process.exit(0); }
  const hit = violation(command);
  if (hit) {
    process.stderr.write(
      `Blocked (${hit}): agent runs must never open a visible VS Code window or a browser. ` +
      'Use the hidden-desktop runner (node test/vscode/run.js, node test/vscode/screenshot.js) or Node tests; ' +
      'see AGENTS.md. If a human really wants this, they run it themselves.\n');
    process.exit(2);
  }
  process.exit(0);
});
