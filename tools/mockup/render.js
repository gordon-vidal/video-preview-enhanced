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
  // The speed off 1×: the reset badge above the speed button; scroll over it for the compact speed overlay.
  'speed-off-normal': { tiles: ['clip-0'], capture: false, layout: 'grid', railOpen: false, rate: 1.5, label: 'Single video at 1.5× (speed reset badge)' },
  // Every #notice banner the player has, built by its production helper (docs/notes/notifications.md): `host` arrives as
  // the host sends it, `slow` / `reducedRes` go through media/slow-notice.js / media/reduced-res-notice.js, `clipRefusal`
  // through the notice controller.
  notice: {
    tiles: ['clip-0'], capture: false, layout: 'grid', railOpen: false, notice: { host: { type: 'zenLayoutOffer' } },
    label: 'Notice: Zen Mode full width (F)',
  },
  'notice-reduced-res': {
    tiles: ['clip-0'], capture: false, layout: 'grid', railOpen: false,
    notice: { reducedRes: { width: 1920, height: 1080, sourceWidth: 3840, sourceHeight: 2160, pixFmt: 'yuv420p10le' } },
    label: 'Notice: reduced picture (W / X on a 4K 10-bit video)',
  },
  'notice-slow': {
    tiles: ['clip-0'], capture: false, layout: 'grid', railOpen: false, notice: { slow: 'every' },
    label: 'Notice: slow playback (every frame shown)',
  },
  'notice-ffmpeg': {
    tiles: ['clip-0'], capture: false, layout: 'grid', railOpen: false, notice: { slow: 'setupFfmpeg' },
    label: 'Notice: set up optional ffmpeg',
  },
  'notice-clip-refusal': {
    tiles: ['clip-0'], capture: false, layout: 'grid', railOpen: false, notice: { clipRefusal: { transcoded: true } },
    label: 'Notice: A–B clip refused (Live transcode)',
  },
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
 * Shared stage + rail + bar + popup markup used by both the rendered mockup harness and the strict Node DOM
 * fixture (test/host/player_ui_test.js), so the test fixture can never drift from the rendered harness. The stage
 * carries src/unified-html.js's #subs cue layer, #overlay (status / error; hidden here, the fake engine opens at once)
 * and #notice banner, so the tool and lifecycle controllers run against the same elements as production.
 */
function stageMarkupHtml() {
  const realBarHtml = barHtml({ canCompare: true, folder: true });
  const realRailHtml = folderRailHtml();
  return `<div id="main">
    <div id="stage" class="fit">
      <div id="cells"></div>
      <div id="subs" hidden></div>
      <div id="overlay" hidden><div id="message"></div><div id="hint"></div><button id="action" class="vpe-btn vpe-btn-main" type="button" hidden></button></div>
      <div id="dropHint" hidden aria-hidden="true">Drop to compare</div>
      ${playFlashHtml}
      <div class="splitter h" id="splitter" hidden><div class="splitter-bar"></div></div>
      <div id="divider" role="slider" tabindex="0" aria-label="Split position" aria-valuemin="0" aria-valuemax="100" aria-valuenow="50" hidden><div class="h">⇄</div></div>
      <div id="toast" hidden aria-hidden="true"></div>
      <div id="notice" hidden>
        <span id="noticeText"></span>
        <button id="noticeAction" class="vpe-btn vpe-btn-main" type="button"></button>
        <button id="noticeSettings" class="vpe-btn noticeSecondary" type="button" hidden></button>
        <button id="noticeHide" class="vpe-btn noticeSecondary" type="button" hidden></button>
        <button id="noticeClose" class="vpe-close" type="button" title="Dismiss" aria-label="Dismiss">×</button>
      </div>
      <div id="capCallout" class="vpe-pop callout" role="dialog" hidden></div>
    </div>
    ${realRailHtml}
  </div>
  ${realBarHtml}
  <div id="panel" class="panel" role="dialog" aria-label="Player settings" hidden></div>
  <div id="sheet" hidden></div>
  <div id="ctxmenu" class="ctxmenu" role="menu" aria-label="Player menu" tabindex="-1" hidden></div>
  <div id="menu" role="menu" aria-label="Tile menu" hidden></div>
  <div id="live" class="sr-only" role="status" aria-live="polite" aria-atomic="true"></div>`;
}

/**
 * Build a self-contained HTML mockup using the real production CSS, bar/rail markup, controls,
 * context menu, folder rail, and pure state modules.
 * @param {{ scenario?: string, theme?: 'dark' | 'light' | 'hc', height?: number }} [opts]
 * @returns {string}
 */
function buildMockupHtml(opts = {}) {
  const scenarioKey = SCENARIOS[opts.scenario] ? opts.scenario : 'single';
  const theme = ['light', 'hc'].includes(String(opts.theme)) ? opts.theme : 'dark';
  const wbHeight = Math.max(380, Math.min(900, Math.round(Number(opts.height) || 510)));

  const playerCss = sanitizeCssForInlineFrame(readRepoFile('media/player.css'));
  const compareCss = sanitizeCssForInlineFrame(readRepoFile('media/compare.css'));
  const folderRailCss = sanitizeCssForInlineFrame(readRepoFile('media/folder-rail.css'));

  // Real production UI & pure state scripts (in dependency order).
  const scriptFiles = [
    'media/dist/webview-ui.js',
    'media/compare-grid.js',
    'media/player-state.js',
    'media/picture.js',
    'media/abloop.js',
    'media/autoplay.js',
    'media/timefmt.js',
    'media/modes.js',
    'media/range-drag.js',
    'media/ui-primitives.js',
    'media/controls.js',
    'media/ctxmenu.js',
    'media/folder-rail.js',
    'media/player-ui-tiles.js',
    'media/player-ui-input.js',
    'media/reduced-res-notice.js',
    'media/slow-notice.js',
    'media/player-ui-tools.js',
    'media/player-ui-lifecycle.js',
    'media/player-ui.js',
    'tools/mockup/fake-engine.js',
    'tools/mockup/fake-host.js',
  ];
  const inlinedScripts = scriptFiles
    .map((rel) => `<script data-src="${rel}">\n${escapeScript(readRepoFile(rel))}\n</script>`)
    .join('\n');

  // VS Code's theme colours only (the player derives its --vpe-* tokens from them in player.css). 'hc' is High
  // Contrast Dark: no button fill (VS Code leaves it unset), borders in the contrast colours, body.vscode-high-contrast.
  const THEME_VARS = {
    light: `--vscode-editor-background:#ffffff; --vscode-foreground:#1f2328; --vscode-editorWidget-background:#f3f3f3;
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
       --vscode-font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; --vscode-font-size:13px;`,
    dark: `--vscode-editor-background:#1e1e1e; --vscode-foreground:#e4e4e7; --vscode-editorWidget-background:#1b1b1f;
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
       --vscode-font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; --vscode-font-size:13px;`,
    hc: `--vscode-editor-background:#000000; --vscode-foreground:#ffffff; --vscode-editorWidget-background:#0c141f;
       --vscode-editorWidget-foreground:#ffffff; --vscode-editorWidget-border:#6fc3df;
       --vscode-editorHoverWidget-background:#0c141f; --vscode-editorHoverWidget-border:#6fc3df;
       --vscode-sideBar-background:#000000; --vscode-input-background:#000000; --vscode-input-border:#6fc3df;
       --vscode-list-activeSelectionForeground:#ffffff; --vscode-menu-background:#000000;
       --vscode-menu-foreground:#ffffff; --vscode-menu-border:#6fc3df; --vscode-menu-selectionBorder:#f38518;
       --vscode-menu-separatorBackground:#6fc3df; --vscode-panel-border:#6fc3df;
       --vscode-focusBorder:#f38518; --vscode-contrastBorder:#6fc3df; --vscode-contrastActiveBorder:#f38518;
       --vscode-button-foreground:#ffffff; --vscode-button-border:#6fc3df;
       --vscode-widget-shadow:transparent; --vscode-descriptionForeground:rgba(255,255,255,0.7);
       --vscode-disabledForeground:#a5a5a5; --vscode-editor-font-family:ui-monospace,Consolas,monospace;
       --vscode-font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; --vscode-font-size:13px;`,
  };
  const vscodeVars = THEME_VARS[theme];

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
/* No CSS transition on the cells: media/player-ui-tiles.js createGlide (FLIP) glides them, as in Compare. */
.cell { cursor: pointer !important; }
/* The tile canvases (#stage .cell > canvas), .cell-border and .addcell are styled by the real media/compare.css. */
.cell.add { cursor: pointer !important; }

/* Keep real popups (#panel, #sheet, #ctxmenu, rail menus) bounded cleanly inside the 728 px inline frame */
.panel { max-height: ${wbHeight - 86}px !important; overflow-y: auto; z-index: 25; }
#sheet { position: absolute !important; inset: 0; z-index: 30; }
#ctxmenu, #menu { z-index: 32; }
.rail { width: var(--rail-w, 200px); }

.code-tab-view {
  position: absolute; inset: 0; z-index: 20;
  background: var(--vscode-editor-background); color: var(--vscode-foreground);
  padding: 20px 24px; font-family: var(--vpe-mono); font-size: 12px; line-height: 1.65;
  display: flex; flex-direction: column; gap: 12px;
}
.code-tab-banner {
  padding: 8px 12px; border-radius: 6px; font-family: var(--vscode-font-family); font-size: 11.5px;
  background: var(--vpe-fill-subtle); border: 1px solid var(--vpe-bd-subtle); color: var(--vpe-dim);
}
.code-tab-banner strong { color: var(--vscode-foreground); }
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
<body class="compare${theme === 'hc' ? ' vscode-high-contrast' : (theme === 'light' ? ' vscode-light' : ' vscode-dark')}">
<div class="wb" id="wb">
  <div class="exp-strip" aria-label="Simulated Explorer">
    <span class="exp-lbl">Explorer:</span>
    <div id="expList" style="display:flex;gap:5px;align-items:center;"></div>
  </div>
  <div class="tabs" id="tabs"></div>
  <div id="codeView" class="code-tab-view" hidden>
    <div class="code-tab-banner"><strong>Other editor active (app.js):</strong> Compare capture is paused while you work here. Clicking a video in Explorer above opens it in its own tab; switch back to your Compare tab to resume capture.</div>
    <pre style="margin:0;opacity:0.85;">// Simulated non-video editor tab\nexport function exportSequence(clips) {\n  return clips.filter(Boolean).map((c) => c.name);\n}</pre>
  </div>
  ${stageMarkupHtml()}
</div>

<div class="harness-foot">
  <div class="harness-pills" id="statePills"></div>
  <div class="harness-ctrls">
    <button id="railToggleBtn" type="button" title="Toggle Folder Rail sidebar">Sidebar</button>
    <select id="scenarioSel" aria-label="Scenario preset">${scenarioOptions}</select>
    <button id="resetBtn" type="button">Reset</button>
    <select id="latencySel" aria-label="Simulated seek latency" title="How long a paused seek or step takes to show its frame (the loading spinner shows after 150 ms)">
      <option value="0">Seek: instant</option><option value="600">Seek: 0.6 s (remote)</option><option value="2500" selected>Seek: 2.5 s (slow link)</option>
    </select>
    <select id="motionSel" aria-label="Motion preference" title="The real CSS's prefers-reduced-motion rules: full motion, reduced, or what this system reports (Windows: Animation effects off = reduced)">
      <option value="full" selected>Motion: full</option><option value="reduced">Motion: reduced</option><option value="system">Motion: system</option>
    </select>
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
  const codeView = $('codeView');
  let inOtherEditor = false;
  const el = (tag, cls, text) => { const x = document.createElement(tag); if (cls) x.className = cls; if (text) x.textContent = text; return x; };

  function chrome(ws, ui) {
    const tab = S.getTab(ws);
    if (codeView) codeView.hidden = !inOtherEditor;
    expList.textContent = '';
    for (const c of engine.clips.slice(0, 5)) {
      const idx = tab.tiles.indexOf(c.id);
      const b = el('button', 'exp-chip');
      b.type = 'button';
      const dot = el('span', 'dot');
      dot.style.background = c.color;
      b.append(dot, el('span', '', c.name));
      if (!inOtherEditor && idx >= 0 && ui.isMulti) b.appendChild(el('span', 'tag', S.TILE_KEYS[idx]));
      b.onclick = () => {
        if (inOtherEditor) {
          inOtherEditor = false;
          // Other editor active: capture is paused, so opening a video opens a new tab instead of hijacking Compare.
          const res = S.openVideo(ui$.getState(), c.id, { forceNewTab: true, label: c.name });
          ui$.setState(res.state);
          return;
        }
        host.explorerOpen(c.id);
      };
      expList.appendChild(b);
    }
    tabsEl.textContent = '';
    for (const t of ws.tabs) {
      const div = el('div', 'tab' + (!inOtherEditor && t.id === tab.id ? ' active' : ''));
      if (t.capture) { const d = el('span', 'tab-cap-dot'); d.title = inOtherEditor ? 'Capture paused (other editor active)' : 'Open new videos here'; if (inOtherEditor) d.style.opacity = '0.35'; div.appendChild(d); }
      div.appendChild(el('span', '', t.tiles.length === 1 ? engine.getClip(t.tiles[0]).name : 'Compare (' + t.tiles.length + ')'));
      if (ws.tabs.length > 1) { const x = el('span', 'tab-x', '×'); x.dataset.close = String(t.id); div.appendChild(x); }
      div.onclick = (e) => {
        inOtherEditor = false;
        const close = e.target && e.target.dataset && e.target.dataset.close;
        ui$.setState(close ? S.closeTab(ui$.getState(), t.id) : S.selectTab(ui$.getState(), t.id));
      };
      tabsEl.appendChild(div);
    }
    // Simulated non-video editor tab so you can test capture pausing while in another editor.
    const codeTab = el('div', 'tab' + (inOtherEditor ? ' active' : ''));
    codeTab.appendChild(el('span', '', 'app.js'));
    codeTab.title = 'Switch to a code editor tab (pauses Compare capture while active)';
    codeTab.onclick = () => { inOtherEditor = true; chrome(ui$.getState(), S.deriveUi(S.getTab(ui$.getState()), { width: 680, height: 370 })); };
    tabsEl.appendChild(codeTab);

    statePills.innerHTML =
      '<span class="harness-pill">Videos: <strong>' + ui.n + '</strong></span>' +
      '<span class="harness-pill">Layout: <strong>' + ui.layoutLabel + '</strong></span>' +
      '<span class="harness-pill">Capture: <strong>' + (tab.capture ? (inOtherEditor ? 'PAUSED (other tab)' : 'ON') : 'OFF') + '</strong></span>';
  }

  // The mock-up's demo sound and subtitle tracks: media/player-ui.js shows none without a decoder, so the harness wraps
  // VpeControls the way media/player-unified.js wrapControls does with the decoder's real streams.
  const demoTracks = { audio: 'a0', sub: 'en' };
  const DEMO_AUDIO = [{ id: 'a0', main: 'English (AAC 2.0)' }, { id: 'a1', main: 'Director Commentary' }];
  const DEMO_SUBS = [{ key: 'en', main: 'English (SRT)', sub: 'Sidecar' }];
  function demoControls(C) {
    if (!C || typeof C.create !== 'function') return C;
    return Object.assign({}, C, {
      create(o) {
        let inst = null;
        const act = Object.assign({}, o.act, {
          selectAudio(id) { demoTracks.audio = id; inst.refresh(); },
          selectSub(k) { demoTracks.sub = k; inst.refresh(); },
        });
        const get = () => {
          const s = o.get();
          const sub = DEMO_SUBS.find((x) => x.key === demoTracks.sub);
          const audio = DEMO_AUDIO.map((a) => Object.assign({}, a, { checked: a.id === demoTracks.audio }));
          return Object.assign({}, s, {
            subsLabel: sub ? sub.main : 'Off',
            audioLabel: (DEMO_AUDIO.find((a) => a.id === demoTracks.audio) || DEMO_AUDIO[0]).main,
            tracks: Object.assign({}, s.tracks, {
              on: !!sub, label: sub ? sub.main : 'Off', sel: demoTracks.sub, audio,
              subs: DEMO_SUBS.map((x) => Object.assign({}, x, { checked: x.key === demoTracks.sub })),
            }),
          });
        };
        inst = C.create(Object.assign({}, o, { get, act }));
        return inst;
      },
    });
  }

  let lastFrame = null, waitUntil = 0, waitTiles = [], waitRaf = 0;
  let harnessReady = false; // onChange may fire inside create(), before ui$ exists
  const ui$ = globalThis.VpePlayerUi.create({
    doc: document,
    win: window,
    stateApi: S,
    engine,
    host,
    widgets: {
      VpeControls: demoControls(typeof VpeControls !== 'undefined' ? VpeControls : globalThis.VpeControls),
      VpeFolderRail: typeof VpeFolderRail !== 'undefined' ? VpeFolderRail : globalThis.VpeFolderRail,
      VpeCtxMenu: typeof VpeCtxMenu !== 'undefined' ? VpeCtxMenu : globalThis.VpeCtxMenu,
      VpeAbLoop: typeof VpeAbLoop !== 'undefined' ? VpeAbLoop : globalThis.VpeAbLoop,
      VpeAutoplay: typeof VpeAutoplay !== 'undefined' ? VpeAutoplay : globalThis.VpeAutoplay,
      VpeTime: typeof VpeTime !== 'undefined' ? VpeTime : globalThis.VpeTime,
      VpePicture: globalThis.VpePicture,
      VpeModes: typeof VpeModes !== 'undefined' ? VpeModes : globalThis.VpeModes,
      VpePlayerUiTiles: globalThis.VpePlayerUiTiles,
      VpePlayerUiInput: globalThis.VpePlayerUiInput,
      CompareGrid: globalThis.CompareGrid,
      VpePlayerUiTools: globalThis.VpePlayerUiTools,
      VpePlayerUiLifecycle: globalThis.VpePlayerUiLifecycle,
      VpeReducedResNotice: globalThis.VpeReducedResNotice,
      VpeSlowNotice: globalThis.VpeSlowNotice,
    },
    initial: SCENARIOS[INITIAL_KEY],
    container: $('wb'),
    // No decoder here: the page's own clock plays the fake engine (the production default, 0, waits for a decoder).
    tickMs: 42,
    onChange: (ws, ui) => { chrome(ws, ui); simulateSeekLatency(ws); },
  });
  host.connect(ui$.onHostMessage);
  harnessReady = true;
  globalThis.__vpeMockup = { ui: ui$, host, engine };

  // A paused seek or step that takes latencySel ms to show its frame, as on a slow remote link: the controller gets
  // setLoading() every animation frame like media/player-unified.js does, so the real spinner and bar pulse show.
  // The fake engine keeps drawing each tile's previous frame until then (engine.fake.hold), as a decoder keeps its
  // last picture until the new one is decoded; when it passes, the new frame is drawn and the spinner goes.
  function simulateSeekLatency(ws) {
    const t = S.getTab(ws);
    const moved = lastFrame !== null && t.frame !== lastFrame;
    lastFrame = t.frame;
    const ms = Number($('latencySel').value) || 0;
    if (!moved || t.playing || !ms || !harnessReady) return;
    waitUntil = performance.now() + ms;
    waitTiles = t.tiles.slice();
    // This runs at the end of the render that already drew the new frame: hold, then repaint the old one before the
    // browser paints (a microtask, outside the render that called us).
    engine.fake.hold(waitTiles, waitUntil);
    queueMicrotask(() => ui$.render());
    if (!waitRaf) waitRaf = requestAnimationFrame(waitFrame);
  }
  function waitFrame(now) {
    waitRaf = 0;
    const waiting = now < waitUntil;
    ui$.setLoading(waiting ? waitTiles : []);
    if (waiting) waitRaf = requestAnimationFrame(waitFrame);
    else { engine.fake.release(); ui$.render(); } // the frame "lands"
  }

  // Motion: an embedded preview inherits the OS setting (Windows "Animation effects" off reports
  // prefers-reduced-motion: reduce, and the real CSS then turns the loading ring slowly). The picker rewrites the
  // media lists of those rules so both looks can be reviewed on any machine.
  const motionRules = [];
  for (const sheet of document.styleSheets) {
    let rules;
    try { rules = sheet.cssRules; } catch { continue; }
    for (const r of rules) if (r.media && /prefers-reduced-motion/.test(r.media.mediaText)) motionRules.push({ r, text: r.media.mediaText });
  }
  const systemReduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  $('motionSel').querySelector('option[value="system"]').textContent = 'Motion: system (' + (systemReduced ? 'reduced' : 'full') + ')';
  function applyMotion(mode) {
    for (const m of motionRules) m.r.media.mediaText = mode === 'full' ? 'not all' : mode === 'reduced' ? 'all' : m.text;
  }
  $('motionSel').onchange = () => applyMotion($('motionSel').value);
  applyMotion($('motionSel').value);

  function loadScenario(key) {
    const sc = SCENARIOS[key] || SCENARIOS.single;
    ui$.setState(S.createWorkspaceState(sc));
    if (sc.railOpen) ui$.rail.show();
    else if (ui$.rail.isOpen()) ui$.rail.close();
    if ((sc.rate || 1) !== ui$.getPrefs().rate) ui$.dispatch('rateSet', sc.rate || 1);
    // A scenario's notice, built as production builds it; switching away clears the banner.
    const notices = ui$.parts && ui$.parts.notices;
    if (notices) notices.hide();
    const n = sc.notice;
    if (n && notices) {
      if (n.host) ui$.onHostMessage(n.host);
      else if (n.slow) notices.show({ kind: 'slowPlayback', ...globalThis.VpeSlowNotice(n.slow) });
      else if (n.reducedRes) notices.show({ kind: 'reducedRes', ...globalThis.VpeReducedResNotice(n.reducedRes) });
      else if (n.clipRefusal) notices.showClipRefusal(n.clipRefusal);
    }
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

module.exports = { SCENARIOS, stageMarkupHtml, buildMockupHtml };
