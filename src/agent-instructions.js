'use strict';
// Pure HTML builder for the "AI Tool Video-Link Instructions" webview tab.
// Uses VS Code's built-in theme CSS variables so it matches dark, light, and high-contrast themes at any width.

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Render the themed instructions webview HTML.
 * @param {{ snippet: string, skillCommand: string, nonce: string }} opts
 */
function renderHtml({ snippet, skillCommand, nonce }) {
  const escSnippet = escapeHtml(snippet);
  const escSkill = escapeHtml(skillCommand);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>AI Tool Video-Link Instructions</title>
  <style nonce="${nonce}">
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 24px 28px 40px;
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size, 13px);
      line-height: 1.55;
    }
    main { max-width: 760px; margin: 0 auto; }
    h1 { font-size: 20px; font-weight: 600; margin: 0 0 6px; }
    .subtitle { color: var(--vscode-descriptionForeground); margin: 0 0 20px; }
    section { margin-bottom: 22px; }
    h2 { font-size: 14px; font-weight: 600; margin: 0 0 6px; }
    .hint { color: var(--vscode-descriptionForeground); margin: 0 0 10px; }
    .code-card {
      border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.3));
      border-radius: 6px;
      background: var(--vscode-textCodeBlock-background, rgba(128,128,128,0.1));
      overflow: hidden;
    }
    .code-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 6px 10px 6px 12px;
      border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.22));
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
    }
    .code-actions { display: flex; gap: 6px; align-items: center; }
    button {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 4px 10px;
      border-radius: 4px;
      border: 1px solid transparent;
      font-family: inherit;
      font-size: 12px;
      cursor: pointer;
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
    }
    button:hover { background: var(--vscode-button-hoverBackground); }
    button.secondary {
      color: var(--vscode-button-secondaryForeground);
      background: var(--vscode-button-secondaryBackground);
    }
    button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
    button svg { width: 14px; height: 14px; fill: currentColor; flex: none; }
    pre {
      margin: 0;
      padding: 12px 14px;
      overflow-x: auto;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: var(--vscode-editor-font-size, 12.5px);
      line-height: 1.5;
      white-space: pre-wrap;
      word-break: break-word;
    }
    code { font-family: inherit; }
  </style>
</head>
<body>
  <main>
    <h1>AI tool video links</h1>
    <p class="subtitle">Teach Claude Code, Codex, Cursor, or Copilot to print clickable <code>vscode://</code> links that open a video at an exact frame or compare two videos in sync.</p>
    <section>
      <h2>Option 1: Paste into AGENTS.md, CLAUDE.md, or .cursorrules</h2>
      <p class="hint">Works with any AI coding tool. Review the exact instructions below, then click Copy.</p>
      <div class="code-card">
        <div class="code-head">
          <span>Markdown</span>
          <div class="code-actions">
            <button type="button" id="copy-snippet" data-copy="snippet" aria-label="Copy instructions">
              <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l1-1h5.414L14 6.586V14l-1 1H5l-1-1V4zm9 3l-3-3H5v10h8V7z"/><path d="M3 1L2 2v10l1 1V2h6.414l-1-1H3z"/></svg>
              <span>Copy</span>
            </button>
          </div>
        </div>
        <pre><code id="snippet-code">${escSnippet}</code></pre>
      </div>
    </section>

    <section>
      <h2>Option 2: Install globally with npx skills</h2>
      <p class="hint">Installs only the <code>video-preview-links</code> skill across your projects (requires Node.js).</p>
      <div class="code-card">
        <div class="code-head">
          <span>Terminal</span>
          <div class="code-actions">
            <button type="button" class="secondary" id="copy-skill" data-copy="skill" aria-label="Copy npx skills command">
              <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l1-1h5.414L14 6.586V14l-1 1H5l-1-1V4zm9 3l-3-3H5v10h8V7z"/><path d="M3 1L2 2v10l1 1V2h6.414l-1-1H3z"/></svg>
              <span>Copy</span>
            </button>
            <button type="button" id="run-skill" aria-label="Open command in terminal">Run in terminal</button>
          </div>
        </div>
        <pre><code id="skill-code">${escSkill}</code></pre>
      </div>
    </section>
  </main>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const copyButtons = document.querySelectorAll('[data-copy]');
    for (const btn of copyButtons) {
      btn.addEventListener('click', () => {
        const which = btn.getAttribute('data-copy');
        vscode.postMessage({ type: 'copy', which });
        const label = btn.querySelector('span');
        if (!label) return;
        const orig = label.textContent;
        label.textContent = 'Copied';
        setTimeout(() => { label.textContent = orig; }, 1800);
      });
    }
    const runBtn = document.getElementById('run-skill');
    if (runBtn) {
      runBtn.addEventListener('click', () => vscode.postMessage({ type: 'runSkill' }));
    }
  </script>
</body>
</html>`;
}

module.exports = { renderHtml, escapeHtml };
