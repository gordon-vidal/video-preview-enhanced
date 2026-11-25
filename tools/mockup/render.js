'use strict';
// Reusable interactive UI mockup harness: inlines the REAL player.css, compare.css, folder-rail.css,
// src/bar.js, src/folder-rail-html.js and the real page scripts (player-state.js, controls.js, ctxmenu.js,
// folder-rail.js, ...), then mounts the shared UI controller media/player-ui.js over FakeEngine
// (tools/mockup/fake-engine.js) and FakeHost (tools/mockup/fake-host.js). The harness itself only draws the
// simulated VS Code chrome around the player (Explorer strip, tabs, scenario picker); it has no player wiring.
// Zero build step; output renders cleanly inside T3 Code's 728 px inline html_render frame.
const fs = require('fs');
const path = require('path');
const { barHtml, playFlashHtml } = require('../../src/bar');
const { folderRailHtml } = require('../../src/folder-rail-html');

const ROOT = path.join(__dirname, '..', '..');

const SCENARIOS = {
  single: { tiles: ['clip-0'], capture: false, layout: 'grid', railOpen: false, label: 'Single video (1×1)' },
  'single-rail': { tiles: ['clip-0'], capture: false, layout: 'grid', railOpen: true, label: 'Single video + Folder Rail' },
  'capture-waiting': { tiles: ['clip-0'], capture: true, layout: 'grid', railOpen: false, label: 'Compare ready (1×1, Capture ON)' },
  'grid-2': { tiles: ['clip-0', 'clip-1'], capture: true, layout: 'grid', railOpen: false, label: 'Compare 2×1 Grid' },
  'grid-3': { tiles: ['clip-0', 'clip-1', 'clip-2'], capture: true, layout: 'grid', railOpen: false, label: 'Compare 2×2 (3 videos + spare)' },
  'grid-4': { tiles: ['clip-0', 'clip-1', 'clip-2', 'clip-3'], capture: true, layout: 'grid', railOpen: false, label: 'Compare 2×2 (4 videos)' },
  spotlight: { tiles: ['clip-0', 'clip-1', 'clip-2'], capture: true, layout: 'spotlight', spotlightId: 'clip-0', railOpen: false, label: 'Spotlight (enlarged tile + strip)' },
  'split-wipe': { tiles: ['clip-0', 'clip-1'], capture: true, layout: 'split', railOpen: false, label: 'Split Wipe (2 videos)' },
};

const escapeStyle = (s) => String(s).replace(/<\/style/gi, '<\\/style');
const escapeScript = (s) => String(s).replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--');
const readRepoFile = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/**
 * Make real webview CSS safe for auto-sized inline frames (e.g. T3 html_preview/html_render):
 * strips viewport-height units (vh) and root html/body height:100% which cause resize loops.
 * @param {string} css
 */
function sanitizeCssForInlineFrame(css) {
  return css
    .replace(/(html\s*,\s*body\s*\{[^}]*?)height\s*:\s*100%\s*;/gi, '$1height: auto;')
    .replace(/\b(\d+(?:\.\d+)?)vh\b/gi, '480px');
}

/**
 * Build a self-contained HTML mockup using the real production CSS, bar/rail markup, controls,
 * context menu, folder rail, and pure state modules.
 * @param {{ scenario?: string, theme?: 'dark' | 'light', height?: number }} [opts]
 * @returns {string}
 */
function buildMockupHtml(opts = {}) {
  const scenarioKey = SCENARIOS[opts.scenario] ? opts.scenario : 'single';
  const theme = opts.theme === 'light' ? 'light' : 'dark';
  const wbHeight = Math.max(380, Math.min(900, Math.round(Number(opts.height) || 510)));

  const playerCss = sanitizeCssForInlineFrame(readRepoFile('media/player.css'));
  const compareCss = sanitizeCssForInlineFrame(readRepoFile('media/compare.css'));
  const folderRailCss = sanitizeCssForInlineFrame(readRepoFile('media/folder-rail.css'));

  // Real production UI & pure state scripts (in dependency order).
  const scriptFiles = [
    'media/compare-grid.js',
    'media/player-state.js',
    'media/picture.js',
    'media/abloop.js',
    'media/autoplay.js',
    'media/timefmt.js',
    'media/modes.js',
    'media/controls.js',
    'media/ctxmenu.js',
    'media/folder-rail.js',
    'media/player-ui.js',
    'tools/mockup/fake-engine.js',
    'tools/mockup/fake-host.js',
  ];
  const inlinedScripts = scriptFiles
    .map((rel) => `<script data-src="${rel}">\n${escapeScript(readRepoFile(rel))}\n</script>`)
    .join('\n');

  const realBarHtml = barHtml({ compare: false, canCompare: true, compareOpen: false, folder: true });
  const realRailHtml = folderRailHtml();

  const vscodeVars = theme === 'light'
    ? `--vscode-editor-background:#ffffff; --vscode-foreground:#1f2328; --vscode-editorWidget-background:#f3f3f3;
       --vscode-editorWidget-foreground:#1f2328; --vscode-editorWidget-border:rgba(0,0,0,0.14);
       --vscode-editorHoverWidget-background:#f8f8fa; --vscode-editorHoverWidget-border:rgba(0,0,0,0.14);
       --vscode-sideBar-background:#f3f3f3; --vscode-input-background:#ffffff; --vscode-input-border:rgba(0,0,0,0.18);
       --vscode-list-hoverBackground:rgba(0,0,0,0.06); --vscode-list-activeSelectionBackground:#005fb8;
       --vscode-list-activeSelectionForeground:#ffffff; --vscode-menu-background:#f8f8fa;
       --vscode-menu-foreground:#1f2328; --vscode-menu-border:rgba(0,0,0,0.14);
       --vscode-menu-selectionBackground:#005fb8; --vscode-menu-selectionForeground:#ffffff;
       --vscode-menu-separatorBackground:rgba(0,0,0,0.1); --vscode-panel-border:rgba(0,0,0,0.12);
       --vscode-focusBorder:#005fb8; --vscode-toolbar-hoverBackground:rgba(0,0,0,0.08);
       --vscode-button-background:#005fb8; --vscode-button-foreground:#fff; --vscode-button-hoverBackground:#0258a8;
       --vscode-widget-shadow:rgba(0,0,0,0.18); --vscode-descriptionForeground:#57606a;
       --vscode-disabledForeground:#8c959f; --vscode-editor-font-family:ui-monospace,Consolas,monospace;
       --vscode-font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; --vscode-font-size:13px;
       --vpe-dim:#57606a; --vpe-mono:ui-monospace,Consolas,monospace; --vpe-seek-fill:#005fb8;
       --vpe-fill-subtle:rgba(0,0,0,0.05); --vpe-bd-subtle:rgba(0,0,0,0.12); --vpe-bd-active:rgba(0,0,0,0.38);
       --vpe-hover:rgba(0,0,0,0.09); --vpe-surface-float:rgba(248,248,250,0.94); --vpe-panel-bg:rgba(248,248,250,0.96);
       --vpe-panel-border:rgba(0,0,0,0.15); --vpe-panel-fg:#1f2328; --vpe-row-hover:rgba(0,0,0,0.06);
       --vpe-sep:rgba(0,0,0,0.1); --vpe-chip-bg:rgba(0,0,0,0.05); --vpe-chip-fg:#1f2328;
       --vpe-on-bg:rgba(0,95,184,0.14); --vpe-on-fg:#005fb8; --vpe-accent:#005fb8;`
    : `--vscode-editor-background:#1e1e1e; --vscode-foreground:#e4e4e7; --vscode-editorWidget-background:#1b1b1f;
       --vscode-editorWidget-foreground:#e4e4e7; --vscode-editorWidget-border:rgba(255,255,255,0.12);
       --vscode-editorHoverWidget-background:#232329; --vscode-editorHoverWidget-border:rgba(255,255,255,0.14);
       --vscode-sideBar-background:#18181c; --vscode-input-background:#25252b; --vscode-input-border:rgba(255,255,255,0.14);
       --vscode-list-hoverBackground:rgba(255,255,255,0.07); --vscode-list-activeSelectionBackground:#04395e;
       --vscode-list-activeSelectionForeground:#ffffff; --vscode-menu-background:#1e1f24;
       --vscode-menu-foreground:#e4e4e7; --vscode-menu-border:rgba(255,255,255,0.14);
       --vscode-menu-selectionBackground:#04395e; --vscode-menu-selectionForeground:#ffffff;
       --vscode-menu-separatorBackground:rgba(255,255,255,0.1); --vscode-panel-border:rgba(255,255,255,0.1);
       --vscode-focusBorder:#38bdf8; --vscode-toolbar-hoverBackground:rgba(255,255,255,0.1);
       --vscode-button-background:#0e639c; --vscode-button-foreground:#fff; --vscode-button-hoverBackground:#1177bb;
       --vscode-widget-shadow:rgba(0,0,0,0.55); --vscode-descriptionForeground:#a1a1aa;
       --vscode-disabledForeground:#71717a; --vscode-editor-font-family:ui-monospace,Consolas,monospace;
       --vscode-font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; --vscode-font-size:13px;
       --vpe-dim:#a1a1aa; --vpe-mono:ui-monospace,Consolas,monospace; --vpe-seek-fill:#38bdf8;
       --vpe-fill-subtle:rgba(255,255,255,0.06); --vpe-bd-subtle:rgba(255,255,255,0.12);
       --vpe-bd-active:rgba(255,255,255,0.36); --vpe-hover:rgba(255,255,255,0.12);
       --vpe-surface-float:rgba(20,22,28,0.92); --vpe-panel-bg:rgba(22,24,30,0.95);
       --vpe-panel-border:rgba(255,255,255,0.14); --vpe-panel-fg:#e4e4e7; --vpe-row-hover:rgba(255,255,255,0.08);
       --vpe-sep:rgba(255,255,255,0.1); --vpe-chip-bg:rgba(255,255,255,0.07); --vpe-chip-fg:#e4e4e7;
       --vpe-on-bg:rgba(56,189,248,0.16); --vpe-on-fg:#e0f2fe; --vpe-accent:#38bdf8;`;

  const scenarioOptions = Object.entries(SCENARIOS)
    .map(([k, v]) => `<option value="${k}"${k === scenarioKey ? ' selected' : ''}>${v.label}</option>`)
    .join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<style>
${escapeStyle(playerCss)}
${escapeStyle(compareCss)}
${escapeStyle(folderRailCss)}
</style>
<style>
/* Mockup harness shell: full 728 px width for the real player, Explorer as a compact top clip-strip. */
:root { ${vscodeVars} }
html, body {
  height: auto !important;
  overflow: visible !important;
  background: transparent !important;
  color: var(--foreground, var(--vscode-foreground));
  font-family: var(--font-sans, var(--vscode-font-family));
  font-size: 12px;
}
.wb {
  position: relative;
  display: flex; flex-direction: column; height: ${wbHeight}px;
  border-radius: var(--radius, 8px); overflow: hidden;
  border: 1px solid var(--border, var(--vscode-panel-border));
  background: var(--vscode-editor-background); color: var(--vscode-foreground);
  user-select: none;
}
/* Compact simulated Explorer strip across the top so the player keeps the full 728 px width. */
.exp-strip {
  display: flex; align-items: center; gap: 5px; padding: 5px 8px;
  background: color-mix(in srgb, var(--vscode-editor-background) 82%, #000);
  border-bottom: 1px solid var(--vscode-panel-border);
  overflow-x: auto; flex: none;
}
.exp-lbl {
  font-size: 10px; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase;
  color: var(--vpe-dim); margin-right: 2px; flex: none;
}
.exp-chip {
  display: inline-flex; align-items: center; gap: 5px; padding: 3px 8px; border-radius: 999px;
  border: 1px solid var(--vpe-bd-subtle); background: var(--vpe-fill-subtle);
  color: var(--vscode-foreground); font: inherit; font-size: 11px; cursor: pointer; white-space: nowrap; flex: none;
}
.exp-chip:hover { background: var(--vpe-hover); border-color: var(--vpe-bd-active); }
.exp-chip .dot { width: 6px; height: 6px; border-radius: 50%; flex: none; }
.exp-chip .tag {
  font-size: 9.5px; font-weight: 700; padding: 0 4px; border-radius: 999px;
  background: rgba(255,255,255,0.14);
}
.tabs {
  height: 28px; background: color-mix(in srgb, var(--vscode-editor-background) 88%, #000);
  border-bottom: 1px solid var(--vscode-panel-border); display: flex; align-items: stretch; overflow-x: auto; flex: none;
}
.tab {
  display: inline-flex; align-items: center; gap: 6px; padding: 0 10px; font-size: 11.5px;
  color: var(--vpe-dim); border-right: 1px solid var(--vscode-panel-border); cursor: pointer;
  white-space: nowrap; position: relative;
}
.tab.active { background: var(--vscode-editor-background); color: var(--vscode-foreground); }
.tab.active::before { content: ''; position: absolute; left: 0; right: 0; top: 0; height: 2px; background: var(--vscode-focusBorder); }
.tab-cap-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--vscode-focusBorder); }
.tab-x { opacity: 0.55; font-size: 13px; padding: 0 2px; border-radius: 3px; }
.tab-x:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground); }

/* Real #main (stage + real Folder Rail side-by-side) and #bar fill the rest of .wb */
#main { position: relative; flex: 1; min-height: 0; display: flex; overflow: hidden; }
#stage { flex: 1; min-width: 0; min-height: 0; background: #000; position: relative; overflow: hidden; }
.cell { cursor: pointer !important; transition: left 160ms cubic-bezier(0.2,0,0,1), top 160ms cubic-bezier(0.2,0,0,1), width 160ms cubic-bezier(0.2,0,0,1), height 160ms cubic-bezier(0.2,0,0,1); }
#stage.fit .cell canvas, #stage .cell canvas { width: 100%; height: 100%; max-width: none; max-height: none; display: block; }
.cell-border { position: absolute; inset: 0; pointer-events: none; box-shadow: inset 0 0 0 1px rgba(255,255,255,0.08); }
.cell.add .addcell { opacity: 0.45; border-style: dashed; }
.cell.add:hover .addcell { opacity: 1; }

.cap-banner {
  position: absolute; top: 8px; left: 50%; transform: translateX(-50%); z-index: 12;
  display: inline-flex; align-items: center; gap: 8px; padding: 4px 8px 4px 10px; border-radius: 999px;
  background: var(--vpe-surface-float); backdrop-filter: blur(10px);
  border: 1px solid color-mix(in srgb, var(--vscode-focusBorder) 55%, transparent);
  color: var(--vpe-panel-fg); font-size: 11px; white-space: nowrap;
}
.cap-banner button {
  border: 1px solid var(--vpe-bd-subtle); background: var(--vpe-fill-subtle); color: inherit;
  border-radius: 999px; padding: 2px 8px; font: inherit; font-size: 10.5px; cursor: pointer;
}
.cap-banner button:hover { background: var(--vpe-hover); }
.cap-pulse { width: 7px; height: 7px; border-radius: 50%; background: var(--vscode-focusBorder); }

#startCompareBtn { width: auto; padding: 0 6px; gap: 5px; font-size: 11px; }
#startCompareBtn.cap-on {
  background: color-mix(in srgb, var(--vscode-focusBorder) 16%, transparent);
  border: 1px solid color-mix(in srgb, var(--vscode-focusBorder) 55%, transparent);
  color: var(--vscode-foreground); padding: 0 7px;
}
#bar .ib.active { background: var(--vpe-fill-subtle); border: 1px solid var(--vpe-bd-active); }

/* Keep real popups (#panel, #sheet, #ctxmenu, rail menus) bounded cleanly inside the 728 px inline frame */
.panel { max-height: ${wbHeight - 86}px !important; overflow-y: auto; z-index: 25; }
#sheet { position: absolute !important; inset: 0; z-index: 30; }
#ctxmenu { z-index: 32; }
.rail { width: var(--rail-w, 200px); }

.harness-foot {
  display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap;
  padding: 8px 2px 2px; font-size: 11.5px; color: var(--muted-foreground, var(--vpe-dim));
}
.harness-pills { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
.harness-pill {
  padding: 2px 8px; border-radius: 999px; border: 1px solid var(--border, var(--vscode-panel-border));
  background: var(--card, var(--vpe-fill-subtle)); font-size: 11px; color: var(--foreground, var(--vscode-foreground));
}
.harness-ctrls { display: flex; gap: 6px; align-items: center; }
.harness-ctrls select, .harness-ctrls button {
  padding: 3px 8px; border-radius: 6px; border: 1px solid var(--border, var(--vscode-panel-border));
  background: var(--card, var(--vscode-editorWidget-background)); color: var(--foreground, var(--vscode-foreground));
  font: inherit; font-size: 11px; cursor: pointer;
}
</style>
</head>
<body class="compare">
<div class="wb" id="wb">
  <div class="exp-strip" aria-label="Simulated Explorer">
    <span class="exp-lbl">Explorer:</span>
    <div id="expList" style="display:flex;gap:5px;align-items:center;"></div>
  </div>
  <div class="tabs" id="tabs"></div>
  <div id="main">
    <div id="stage" class="fit">
      <div id="cells"></div>
      ${playFlashHtml}
      <div class="cap-banner" id="capBanner" hidden>
        <span class="cap-pulse"></span>
        <span>Open new videos in this compare view</span>
        <button id="capPickBtn" type="button">Pick…</button>
        <button id="capStopBtn" type="button">Pause</button>
      </div>
      <div class="splitter h" id="splitter" hidden><div class="splitter-bar"></div></div>
      <div id="divider" hidden><div class="h">⇄</div></div>
      <div id="toast" hidden aria-hidden="true"></div>
    </div>
    ${realRailHtml}
  </div>
  ${realBarHtml}
  <div id="panel" class="panel" role="dialog" aria-label="Player settings" hidden></div>
  <div id="sheet" hidden></div>
  <div id="ctxmenu" class="ctxmenu" role="menu" aria-label="Player menu" tabindex="-1" hidden></div>
  <div id="live" class="sr-only" role="status" aria-live="polite" aria-atomic="true"></div>
</div>

<div class="harness-foot">
  <div class="harness-pills" id="statePills"></div>
  <div class="harness-ctrls">
    <button id="railToggleBtn" type="button" title="Toggle Folder Rail sidebar">Sidebar</button>
    <select id="scenarioSel" aria-label="Scenario preset">${scenarioOptions}</select>
    <button id="resetBtn" type="button">Reset</button>
  </div>
</div>

${inlinedScripts}
<script>
// Harness chrome only (simulated Explorer, tab strip, scenario picker, state pills). Everything inside the
// player is the real shared controller, media/player-ui.js, over FakeEngine + FakeHost.
(() => {
  const S = globalThis.VpePlayerState;
  const engine = globalThis.VpeFakeEngine.createFakeEngine();
  const host = globalThis.VpeFakeHost.createFakeHost({ clips: engine.clips });
  const SCENARIOS = ${JSON.stringify(SCENARIOS)};
  const INITIAL_KEY = ${JSON.stringify(scenarioKey)};
  const $ = (id) => document.getElementById(id);
  const expList = $('expList'), tabsEl = $('tabs'), statePills = $('statePills'), scenarioSel = $('scenarioSel');
  const el = (tag, cls, text) => { const x = document.createElement(tag); if (cls) x.className = cls; if (text) x.textContent = text; return x; };

  function chrome(ws, ui) {
    const tab = S.getTab(ws);
    expList.textContent = '';
    for (const c of engine.clips.slice(0, 5)) {
      const idx = tab.tiles.indexOf(c.id);
      const b = el('button', 'exp-chip');
      b.type = 'button';
      const dot = el('span', 'dot');
      dot.style.background = c.color;
      b.append(dot, el('span', '', c.name));
      if (idx >= 0 && ui.isMulti) b.appendChild(el('span', 'tag', S.TILE_KEYS[idx]));
      b.onclick = () => host.explorerOpen(c.id);
      expList.appendChild(b);
    }
    tabsEl.textContent = '';
    for (const t of ws.tabs) {
      const div = el('div', 'tab' + (t.id === tab.id ? ' active' : ''));
      if (t.capture) { const d = el('span', 'tab-cap-dot'); d.title = 'Open new videos here'; div.appendChild(d); }
      div.appendChild(el('span', '', t.tiles.length === 1 ? engine.getClip(t.tiles[0]).name : 'Compare (' + t.tiles.length + ')'));
      if (ws.tabs.length > 1) { const x = el('span', 'tab-x', '×'); x.dataset.close = String(t.id); div.appendChild(x); }
      div.onclick = (e) => {
        const close = e.target && e.target.dataset && e.target.dataset.close;
        ui$.setState(close ? S.closeTab(ui$.getState(), t.id) : S.selectTab(ui$.getState(), t.id));
      };
      tabsEl.appendChild(div);
    }
    statePills.innerHTML =
      '<span class="harness-pill">Videos: <strong>' + ui.n + '</strong></span>' +
      '<span class="harness-pill">Layout: <strong>' + ui.layoutLabel + '</strong></span>' +
      '<span class="harness-pill">Capture: <strong>' + (tab.capture ? 'ON' : 'OFF') + '</strong></span>';
  }

  const ui$ = globalThis.VpePlayerUi.create({
    doc: document,
    win: window,
    stateApi: S,
    engine,
    host,
    widgets: {
      VpeControls: typeof VpeControls !== 'undefined' ? VpeControls : globalThis.VpeControls,
      VpeFolderRail: typeof VpeFolderRail !== 'undefined' ? VpeFolderRail : globalThis.VpeFolderRail,
      VpeCtxMenu: typeof VpeCtxMenu !== 'undefined' ? VpeCtxMenu : globalThis.VpeCtxMenu,
      VpeAbLoop: typeof VpeAbLoop !== 'undefined' ? VpeAbLoop : globalThis.VpeAbLoop,
      VpeAutoplay: typeof VpeAutoplay !== 'undefined' ? VpeAutoplay : globalThis.VpeAutoplay,
      VpeTime: typeof VpeTime !== 'undefined' ? VpeTime : globalThis.VpeTime,
      VpePicture: globalThis.VpePicture,
      VpeModes: typeof VpeModes !== 'undefined' ? VpeModes : globalThis.VpeModes,
    },
    initial: SCENARIOS[INITIAL_KEY],
    container: $('wb'),
    onChange: chrome,
  });
  host.connect(ui$.onHostMessage);
  globalThis.__vpeMockup = { ui: ui$, host, engine };

  function loadScenario(key) {
    const sc = SCENARIOS[key] || SCENARIOS.single;
    ui$.setState(S.createWorkspaceState(sc));
    if (sc.railOpen) ui$.rail.show();
    else if (ui$.rail.isOpen()) ui$.rail.close();
  }
  scenarioSel.onchange = () => loadScenario(scenarioSel.value);
  $('resetBtn').onclick = () => loadScenario(scenarioSel.value);
  $('railToggleBtn').onclick = () => { ui$.rail.toggle(); setTimeout(ui$.render, 20); };
  loadScenario(INITIAL_KEY);
})();
</script>
</body>
</html>`;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  let scenario = 'single';
  let theme = 'dark';
  let out = '';
  let height = 510;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--scenario' && args[i + 1]) scenario = args[++i];
    else if (args[i] === '--theme' && args[i + 1]) theme = args[++i];
    else if (args[i] === '--height' && args[i + 1]) height = Number(args[++i]);
    else if (args[i] === '--out' && args[i + 1]) out = args[++i];
    else if (args[i] === '--list') {
      process.stdout.write(Object.keys(SCENARIOS).join('\n') + '\n');
      process.exit(0);
    }
  }
  const html = buildMockupHtml({ scenario, theme, height });
  if (out) {
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    fs.writeFileSync(out, html, 'utf8');
  } else {
    process.stdout.write(html);
  }
}

module.exports = { SCENARIOS, buildMockupHtml };
