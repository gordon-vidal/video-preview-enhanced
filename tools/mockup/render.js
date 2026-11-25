'use strict';
// Reusable interactive UI mockup harness: inlines the REAL player.css, compare.css, folder-rail.css,
// src/bar.js, src/folder-rail-html.js, media/compare-grid.js, media/player-state.js, media/picture.js,
// media/abloop.js, media/autoplay.js, media/timefmt.js, media/controls.js, media/ctxmenu.js, and
// media/folder-rail.js over FakeEngine (tools/mockup/fake-engine.js).
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
    'media/controls.js',
    'media/ctxmenu.js',
    'media/folder-rail.js',
    'tools/mockup/fake-engine.js',
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
.cell canvas { width: 100%; height: 100%; display: block; }
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
(() => {
  const S = globalThis.VpePlayerState;
  const engine = globalThis.VpeFakeEngine.createFakeEngine();
  const SCENARIOS = ${JSON.stringify(SCENARIOS)};
  const INITIAL_KEY = ${JSON.stringify(scenarioKey)};

  const $ = (id) => document.getElementById(id);
  const stageEl = $('stage'), cellsEl = $('cells'), expList = $('expList');
  const tabsEl = $('tabs'), capBanner = $('capBanner'), splitterEl = $('splitter'), dividerEl = $('divider');
  const statePills = $('statePills'), scenarioSel = $('scenarioSel');
  const seekEl = $('seek'), nowEl = $('now'), durEl = $('dur'), barEl = $('bar');
  const tracksBtn = $('tracks'), cmpBtn = $('startCompareBtn');
  const playBtn = $('play'), prevBtn = $('prev'), nextBtn = $('next');
  const prevSize = $('prevSize'), nextSize = $('nextSize');
  const muteBtn = $('mute'), volEl = $('volume'), rateBtn = $('rate');
  const cogBtn = $('cog'), infoBtn = $('infoBtn'), picBtn = $('picBtn'), fullBtn = $('full');
  const setABtn = $('setABtn'), setBBtn = $('setBBtn'), abMarks = $('abMarks'), abA = $('abA'), abB = $('abB');

  // Inject unified Split (N===2) and Sync (N>=2) controls beside Compare inside the real #bar.
  const splitBtn = document.createElement('button');
  splitBtn.id = 'mockSplitBtn'; splitBtn.className = 'ib'; splitBtn.hidden = true;
  splitBtn.title = 'Split Wipe (2 videos)';
  splitBtn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="5" width="16" height="14" rx="1.6"/><path d="M12 3v18"/></svg>';
  const syncBtn = document.createElement('button');
  syncBtn.id = 'mockSyncBtn'; syncBtn.className = 'ib'; syncBtn.hidden = true;
  syncBtn.title = 'Sync frame offsets';
  syncBtn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="6" width="11.5" height="4.2" rx="1.1"/><rect x="8.5" y="13.8" width="11.5" height="4.2" rx="1.1"/><path d="M12 3.5v17" stroke-dasharray="1.8 2.2"/></svg>';
  cmpBtn.parentNode.insertBefore(splitBtn, cmpBtn);
  cmpBtn.parentNode.insertBefore(syncBtn, cmpBtn);

  const expandSvg = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>';
  const collapseSvg = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 14h6v6M20 10h-6V4M14 10l7-7M10 14l-7 7"/></svg>';
  const closeSvg = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';

  const announce = (t) => { const l = $('live'); if (l) l.textContent = t; };
  const toast = VpeControls.createToast($('toast'), announce);
  const flashPlay = VpeControls.createPlayFlash($('playFlash'), stageEl);

  // Additional interactive player prefs driven by the real VpeControls & VpeFolderRail widgets.
  let ws = S.createWorkspaceState(SCENARIOS[INITIAL_KEY]);
  let onEnd = 'off';
  let rate = 1;
  let muted = true;
  let volume = 0.85;
  let stepSize = 'frame';
  let picMode = 'fit';
  let picZoom = 1;
  let subKey = 'en';
  let audioId = 'a0';
  let transcodeMode = 'auto';
  let transcodeMaxBitrate = 0;
  let transcodeRes = 0;
  let timeMode = 0;
  const ab = VpeAbLoop.create();

  const fmtTime = (f, fps) => {
    const t = f / (fps || 24);
    if (timeMode === 2) return '#' + f;
    if (timeMode === 1 && globalThis.VpeTime) return VpeTime.fmtTimecode(t, fps || 24);
    const m = Math.floor(t / 60);
    return m + ':' + (t % 60).toFixed(2).padStart(5, '0');
  };

  // ---- Real VpeFolderRail (sidebar) ----
  const railEntries = engine.clips.map((c, idx) => ({
    id: c.id,
    name: c.name,
    kind: 'video',
    duration: 10 + idx * 14,
    size: (18 + idx * 27) * 1024 * 1024,
    mtime: Date.now() - idx * 3600 * 1000 * 5,
  }));
  let railGen = 1;
  const rail = VpeFolderRail.create({
    doc: document,
    toast,
    cfg: { layout: 'dock', width: 200, column: 'duration', playable: true },
    getOnEnd: () => onEnd,
    setOnEnd: (m) => { onEnd = m; rail.refreshOnEnd(); controls.refresh(); toast('Autoplay: ' + VpeAutoplay.label(m)); },
    label: VpeAutoplay.label,
    time: () => S.getTab(ws).frame / (S.getTab(ws).fps || 24),
    post: (m) => {
      if (!m) return;
      if (m.type === 'folderRail') {
        if (m.op === 'open' && m.id) {
          const c = engine.getClip(m.id);
          const res = S.openVideo(ws, c.id, { label: c.name });
          ws = res.state;
          if (res.toast) toast(res.toast);
          render();
        } else if (m.op === 'compare' && m.id) {
          const tab = S.getTab(ws);
          if (!tab.capture) ws = S.toggleCapture(ws).state;
          const c = engine.getClip(m.id);
          const res = S.openVideo(ws, c.id, { label: c.name });
          ws = res.state;
          if (res.toast) toast(res.toast);
          render();
        } else if (m.op === 'step') {
          const tab = S.getTab(ws);
          const idx = engine.clips.findIndex((c) => c.id === tab.tiles[0]);
          const next = engine.clips[(idx + m.dir + engine.clips.length) % engine.clips.length];
          ws = S.openVideo(ws, next.id, { label: next.name }).state;
          render();
        } else if (m.op === 'list') {
          pushRailList();
        }
      }
    },
  });

  function pushRailList() {
    const tab = S.getTab(ws);
    rail.onMessage({
      op: 'list',
      gen: ++railGen,
      crumb: 'clips / dailies_v4',
      entries: railEntries,
      current: tab.tiles[0],
      members: tab.tiles,
      count: tab.tiles.length,
    });
    const idx = engine.clips.findIndex((c) => c.id === tab.tiles[0]);
    rail.setPos(idx, engine.clips.length);
    for (const e of railEntries) {
      rail.onMessage({ op: 'meta', gen: railGen, id: e.id, duration: e.duration, size: e.size, mtime: e.mtime });
    }
  }

  // ---- Real VpeControls (⚙ Settings, ⓘ Info, Speed, Subtitles, Picture, Step badges, ? Sheet) ----
  const abLabel = () => {
    if (ab.a === null && ab.b === null) return 'Off';
    const tab = S.getTab(ws);
    const a = ab.a !== null ? fmtTime(Math.round(ab.a * tab.fps), tab.fps) : '—';
    const b = ab.b !== null ? fmtTime(Math.round(ab.b * tab.fps), tab.fps) : '—';
    return a + ' → ' + b;
  };
  const infoFacts = () => {
    const tab = S.getTab(ws);
    const clip = engine.getClip(tab.tiles[0]);
    return {
      title: clip.name,
      sub: clip.codec + ' · 3840×2160 · ' + (clip.fps || 24) + ' fps',
      rows: [
        ['Video', clip.codec + ', 3840×2160, ' + (clip.fps || 24) + ' fps'],
        ['Audio', 'AAC stereo, 48 kHz'],
        ['Duration', '0:10.00 (' + tab.maxFrame + ' frames)'],
        ['Decoder', 'Mock FakeEngine (2D canvas)'],
        ['View', tab.tiles.length > 1 ? 'Compare (' + tab.tiles.length + ' videos)' : 'Single video'],
      ],
    };
  };

  let ctxMenu = null;
  const controls = VpeControls.create({
    panel: $('panel'),
    sheet: $('sheet'),
    bar: barEl,
    onShow: () => { if (ctxMenu) ctxMenu.close(false); },
    buttons: { cog: cogBtn, info: infoBtn, rate: rateBtn, tracks: tracksBtn, stepPrev: prevSize, stepNext: nextSize },
    get: () => {
      const tab = S.getTab(ws);
      const isMulti = tab.tiles.length >= 2;
      return {
        compare: isMulti,
        rate,
        loop: onEnd === 'loop',
        autoplay: { mode: onEnd, label: VpeAutoplay.label(onEnd), next: !isMulti },
        jump: { arrow: 5, shift: 1, ctrl: 'frame' },
        stepButtons: 'frame',
        stepSize,
        abLabel: abLabel(),
        picture: { mode: picMode, pct: Math.round(picZoom * 100), zoomed: picZoom !== 1 },
        tools: [
          { id: 'compare', label: tab.capture ? 'Pause Compare capture' : 'Start Compare', key: 'Shift+D', on: tab.capture, run: () => cmpBtn.click() },
          { id: 'rail', label: rail.isOpen() ? 'Close Folder Rail' : 'Open Folder Rail', on: rail.isOpen(), run: () => { rail.toggle(); render(); } },
        ],
        ab: {
          items: [
            { label: 'Set Range Start (A)', key: 'A', run: () => markAB('a') },
            { label: 'Set Range End (B)', key: 'B', run: () => markAB('b') },
            { label: 'Clear A–B Range', key: 'Backspace', run: () => { ab.clear(); controls.refresh(); render(); toast('A–B range cleared'); } },
          ],
        },
        subsLabel: subKey === 'off' ? 'Off' : 'English (SRT)',
        audioLabel: audioId === 'a0' ? 'English (AAC 2.0)' : 'Director Commentary',
        hasSound: true,
        tracks: {
          on: subKey !== 'off',
          label: subKey === 'off' ? 'Off' : 'English (SRT)',
          subs: [
            { key: 'off', main: 'Off', checked: subKey === 'off' },
            { key: 'en', main: 'English (SRT)', sub: 'Sidecar', checked: subKey === 'en' },
          ],
          audio: [
            { id: 'a0', main: 'English (AAC 2.0)', checked: audioId === 'a0' },
            { id: 'a1', main: 'Director Commentary', checked: audioId === 'a1' },
          ],
          delay: 0,
          size: 100,
        },
        facts: infoFacts(),
        canExternal: false,
        canUseOriginal: false,
        transcode: {
          mode: transcodeMode,
          maxBitrateMbps: transcodeMaxBitrate,
          active: false,
          resolution: transcodeRes,
          defaultResolution: 0,
          sourceHeight: 2160,
        },
      };
    },
    act: {
      stepSize: (v) => { stepSize = v; VpeControls.drawStepBadges([prevSize, nextSize], v); controls.refresh(); toast('Step: ' + VpeControls.stepName(v)); },
      loop: () => { onEnd = onEnd === 'loop' ? 'off' : 'loop'; rail.refreshOnEnd(); controls.refresh(); toast(onEnd === 'loop' ? 'Loop on' : 'Loop off'); },
      setAutoplay: (m) => { onEnd = m; rail.refreshOnEnd(); controls.refresh(); toast('Autoplay: ' + VpeAutoplay.label(m)); },
      cycleAB: () => markAB(),
      copyFrame: () => toast('Frame copied (mock)'),
      setRate: (r) => { rate = VpeControls.clampRate(r); rateBtn.textContent = rate + '×'; controls.refresh(); },
      pickRate: (r) => { rate = VpeControls.clampRate(r); rateBtn.textContent = rate + '×'; controls.refresh(); },
      stepRate: (d) => { rate = VpeControls.clampRate(rate + d * 0.05); rateBtn.textContent = rate + '×'; controls.refresh(); },
      setTranscode: (m) => { transcodeMode = m; controls.refresh(); toast('Live transcode: ' + m); },
      setTranscodeMaxBitrate: (r) => { transcodeMaxBitrate = r; controls.refresh(); },
      setTranscodeResolution: (h) => { transcodeRes = h; controls.refresh(); },
      saveTranscodeResolution: (h) => { transcodeRes = h; controls.refresh(); toast('Saved default resolution'); },
      setPicture: (m) => { picMode = m; picBtn.dataset.mode = m; controls.refresh(); toast('Picture: ' + m); },
      zoomPicture: (d) => { picZoom = Math.max(0.5, Math.min(4, +(picZoom + d * 0.25).toFixed(2))); controls.refresh(); },
      resetPicture: () => { picZoom = 1; picMode = 'fit'; picBtn.dataset.mode = 'fit'; controls.refresh(); },
      selectSub: (k) => { subKey = k; tracksBtn.classList.toggle('on', k !== 'off'); controls.refresh(); toast(k === 'off' ? 'Subtitles off' : 'Subtitles: English'); },
      selectAudio: (id) => { audioId = id; controls.refresh(); toast('Audio track switched'); },
      loadSubs: () => toast('Load subtitles… (mock)'),
      subDelay: () => {},
      subSize: () => {},
      copyInfo: () => toast('Details copied'),
      copyLink: () => toast('Frame link copied'),
      external: () => toast('Open in system player (mock)'),
      extSettings: () => toast('Open VS Code Settings (mock)'),
      openUrl: () => toast('Open Video URL… (mock)'),
    },
  });

  // ---- Real VpeCtxMenu (right-click menu) ----
  const MENU_ACTIONS = {
    playPause: () => { ws = S.togglePlay(ws); flashPlay(S.getTab(ws).playing); render(); },
    loop: () => { onEnd = onEnd === 'loop' ? 'off' : 'loop'; rail.refreshOnEnd(); controls.refresh(); toast(onEnd === 'loop' ? 'Loop on' : 'Loop off'); },
    setA: () => markAB('a'),
    setB: () => markAB('b'),
    clearAB: () => { ab.clear(); controls.refresh(); render(); toast('A–B range cleared'); },
    copyFrame: () => toast('Frame copied (mock)'),
    saveFrame: () => toast('Save frame as PNG… (mock)'),
    copyTime: () => { const t = S.getTab(ws); toast('Copied ' + fmtTime(t.frame, t.fps)); },
    startCompare: () => cmpBtn.click(),
    addToCompare: () => cmpBtn.click(),
    keys: () => controls.openSheet(cogBtn),
    cog: () => controls.show('main', cogBtn),
  };
  ctxMenu = VpeCtxMenu.create({
    menu: $('ctxmenu'),
    container: $('wb'),
    getState: () => {
      const tab = S.getTab(ws);
      return { ready: true, playing: tab.playing, loop: onEnd === 'loop', abSet: ab.isSet(), file: true, compareOpen: tab.tiles.length >= 2 };
    },
    beforeOpen: () => controls.closeAll(false),
    run: (action) => { if (MENU_ACTIONS[action]) MENU_ACTIONS[action](); },
  });
  stageEl.addEventListener('contextmenu', (e) => { e.preventDefault(); ctxMenu.open(e.clientX, e.clientY); });

  function markAB(which) {
    const tab = S.getTab(ws);
    const t = tab.frame / (tab.fps || 24);
    if (which) ab.set(which, t, tab.frame, t, false);
    else ab.cycle(t, tab.frame, t, false);
    toast(ab.toast((sec) => fmtTime(Math.round(sec * (tab.fps || 24)), tab.fps)));
    controls.refresh();
    render();
  }

  function render() {
    const tab = S.getTab(ws);
    const W = stageEl.clientWidth || 680;
    const H = stageEl.clientHeight || 370;
    const ui = S.deriveUi(tab, { width: W, height: H });

    // Top compact Explorer clip strip
    expList.innerHTML = '';
    engine.clips.slice(0, 5).forEach((c) => {
      const idx = tab.tiles.indexOf(c.id);
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'exp-chip';
      b.innerHTML = '<span class="dot" style="background:' + c.color + '"></span>' +
        '<span>' + c.name + '</span>' +
        (idx >= 0 && ui.isMulti ? '<span class="tag">' + S.TILE_KEYS[idx] + '</span>' : '');
      b.onclick = () => {
        const res = S.openVideo(ws, c.id, { label: c.name });
        ws = res.state;
        if (res.toast) toast(res.toast);
        render();
      };
      expList.appendChild(b);
    });

    // Tabs
    tabsEl.innerHTML = '';
    ws.tabs.forEach((t) => {
      const el = document.createElement('div');
      el.className = 'tab' + (t.id === tab.id ? ' active' : '');
      const title = t.tiles.length === 1 ? engine.getClip(t.tiles[0]).name : 'Compare (' + t.tiles.length + ')';
      el.innerHTML = (t.capture ? '<span class="tab-cap-dot" title="Open new videos here"></span>' : '') +
        '<span>' + title + '</span>' +
        (ws.tabs.length > 1 ? '<span class="tab-x" data-close="' + t.id + '">×</span>' : '');
      el.onclick = (e) => {
        if (e.target.dataset && e.target.dataset.close) ws = S.closeTab(ws, t.id);
        else ws = S.selectTab(ws, t.id);
        render();
      };
      tabsEl.appendChild(el);
    });

    // Stage cells
    stageEl.classList.toggle('sync-mode', tab.syncMode && ui.isMulti);
    cellsEl.innerHTML = '';
    ui.cells.forEach((r) => {
      const clip = engine.getClip(r.clipId);
      const cell = document.createElement('div');
      cell.className = 'cell' + (r.role.startsWith('split') ? ' split' : '');
      cell.style.left = r.x + 'px';
      cell.style.top = r.y + 'px';
      cell.style.width = r.w + 'px';
      cell.style.height = r.h + 'px';
      if (r.role === 'split-b') cell.style.background = 'transparent';

      const cv = document.createElement('canvas');
      cell.appendChild(cv);
      if (ui.isMulti && ui.effectiveLayout !== 'split') {
        const b = document.createElement('div');
        b.className = 'cell-border';
        cell.appendChild(b);
      }
      cell.onclick = (e) => {
        if (e.target.closest('button')) return;
        if (controls.isOpen() || ctxMenu.isOpen()) { controls.closeAll(false); ctxMenu.close(false); return; }
        ws = S.togglePlay(ws);
        flashPlay(S.getTab(ws).playing);
        render();
      };

      if (ui.isMulti) {
        const ov = document.createElement('div');
        ov.className = 'ov';
        const isHero = r.role === 'hero';
        const off = tab.offsets[r.clipId] || 0;
        const pillCls = r.role === 'split-b' ? 'pill right' : 'pill';
        ov.innerHTML =
          '<div class="' + pillCls + '"><span class="ltr">' + r.letter + '</span><span class="nm">' + clip.name + '</span><span class="fr">#' + (tab.frame + off) + '</span></div>' +
          (ui.effectiveLayout !== 'split'
            ? '<div class="tile-top-acts"><button type="button" class="tbtn" data-enlarge="' + r.clipId + '" title="' + (isHero ? 'Back to grid' : 'Enlarge tile') + '">' + (isHero ? collapseSvg : expandSvg) + '</button>' +
              '<button type="button" class="tbtn rm" data-rm="' + r.clipId + '" title="Remove from compare">' + closeSvg + '</button></div>'
            : '') +
          '<div class="sync-pill"><button type="button" data-off="' + r.clipId + '" data-d="-1">−</button><span>' + (off >= 0 ? '+' : '') + off + 'f</span><button type="button" data-off="' + r.clipId + '" data-d="1">+</button></div>';
        ov.querySelectorAll('[data-enlarge]').forEach((b) => { b.onclick = (e) => { e.stopPropagation(); ws = S.toggleEnlarge(ws, r.clipId); render(); }; });
        ov.querySelectorAll('[data-rm]').forEach((b) => { b.onclick = (e) => { e.stopPropagation(); const res = S.removeTile(ws, r.clipId); ws = res.state; if (res.toast) toast(res.toast); render(); }; });
        ov.querySelectorAll('[data-off]').forEach((b) => { b.onclick = (e) => { e.stopPropagation(); ws = S.nudgeOffset(ws, r.clipId, Number(b.dataset.d)); render(); }; });
        cell.appendChild(ov);
      }
      cellsEl.appendChild(cell);
      engine.draw(cv, r.clipId, tab.frame + (tab.offsets[r.clipId] || 0), {
        splitClipRatio: r.role === 'split-b' ? tab.split : null,
      });
    });

    if (ui.addSlot) {
      const slot = document.createElement('div');
      slot.className = 'cell add';
      slot.style.left = ui.addSlot.x + 'px';
      slot.style.top = ui.addSlot.y + 'px';
      slot.style.width = ui.addSlot.w + 'px';
      slot.style.height = ui.addSlot.h + 'px';
      slot.innerHTML = '<button type="button" class="addcell">+ Add video</button>';
      slot.querySelector('button').onclick = () => {
        const next = engine.clips.find((c) => !tab.tiles.includes(c.id));
        if (next) { const res = S.openVideo(ws, next.id, { label: next.name }); ws = res.state; if (res.toast) toast(res.toast); render(); }
      };
      cellsEl.appendChild(slot);
    }

    splitterEl.hidden = !ui.showSplitter;
    if (!splitterEl.hidden) splitterEl.style.top = Math.round(H * tab.heroRatio) + 'px';
    dividerEl.hidden = !ui.showDivider;
    if (!dividerEl.hidden) dividerEl.style.left = Math.round(W * tab.split) + 'px';
    capBanner.hidden = !ui.showCaptureBanner;

    // Real #bar controls reacting to PlayerState
    if (tracksBtn) { tracksBtn.hidden = !ui.showCC; tracksBtn.classList.toggle('on', subKey !== 'off'); }
    const folderCapEl = $('folderCap');
    if (folderCapEl) folderCapEl.hidden = !ui.showFolderCapsule;
    splitBtn.hidden = !ui.showSplitBtn;
    splitBtn.classList.toggle('active', ui.effectiveLayout === 'split');
    syncBtn.hidden = !ui.showSyncBtn;
    syncBtn.classList.toggle('active', tab.syncMode);
    cmpBtn.classList.toggle('cap-on', tab.capture);
    cmpBtn.title = ui.captureTitle;
    cmpBtn.innerHTML = tab.capture
      ? '<span class="cap-pulse"></span><span>' + ui.captureLabel + '</span>'
      : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="4.5" width="19" height="15" rx="1.5"/><path d="M12 4.5v15"/></svg><span>' + ui.captureLabel + '</span>';

    seekEl.max = String(tab.maxFrame);
    seekEl.value = String(tab.frame);
    nowEl.textContent = fmtTime(tab.frame, tab.fps);
    durEl.textContent = '/ ' + fmtTime(tab.maxFrame, tab.fps);
    playBtn.classList.toggle('playing', tab.playing);
    muteBtn.classList.toggle('muted', muted);
    muteBtn.setAttribute('aria-pressed', String(muted));
    volEl.value = String(volume);
    VpeControls.drawStepBadges([prevSize, nextSize], stepSize);
    VpeControls.drawRangeButtons(setABtn, setBBtn, ab);
    const durS = tab.maxFrame / (tab.fps || 24);
    VpeControls.drawRangeMarks(abMarks, abA, abB, ab.marks(durS));

    pushRailList();

    statePills.innerHTML =
      '<span class="harness-pill">Videos: <strong>' + ui.n + '</strong></span>' +
      '<span class="harness-pill">Layout: <strong>' + ui.layoutLabel + '</strong></span>' +
      '<span class="harness-pill">Capture: <strong>' + (tab.capture ? 'ON' : 'OFF') + '</strong></span>';
  }

  // Wire real bar buttons
  cmpBtn.onclick = (e) => { e.stopPropagation(); const res = S.toggleCapture(ws); ws = res.state; if (res.toast) toast(res.toast); render(); };
  $('capStopBtn').onclick = cmpBtn.onclick;
  $('capPickBtn').onclick = () => {
    const tab = S.getTab(ws);
    const next = engine.clips.find((c) => !tab.tiles.includes(c.id));
    if (next) { const res = S.openVideo(ws, next.id, { label: next.name }); ws = res.state; if (res.toast) toast(res.toast); render(); }
  };
  splitBtn.onclick = (e) => { e.stopPropagation(); ws = S.toggleSplit(ws); render(); };
  syncBtn.onclick = (e) => { e.stopPropagation(); ws = S.toggleSyncMode(ws); render(); };
  playBtn.onclick = (e) => { e.stopPropagation(); ws = S.togglePlay(ws); flashPlay(S.getTab(ws).playing); render(); };
  prevBtn.onclick = (e) => { e.stopPropagation(); ws = S.stepFrame(ws, -1); render(); };
  nextBtn.onclick = (e) => { e.stopPropagation(); ws = S.stepFrame(ws, 1); render(); };
  prevSize.onclick = (e) => { e.stopPropagation(); controls.toggle('step', prevSize); };
  nextSize.onclick = (e) => { e.stopPropagation(); controls.toggle('step', nextSize); };
  muteBtn.onclick = (e) => { e.stopPropagation(); muted = !muted; render(); };
  volEl.oninput = () => { volume = Number(volEl.value); muted = volume === 0; render(); };
  $('time').onclick = (e) => { e.stopPropagation(); timeMode = (timeMode + 1) % 3; render(); };
  setABtn.onclick = (e) => { e.stopPropagation(); markAB('a'); };
  setBBtn.onclick = (e) => { e.stopPropagation(); markAB('b'); };
  cogBtn.onclick = (e) => { e.stopPropagation(); controls.toggle('main', cogBtn); };
  infoBtn.onclick = (e) => { e.stopPropagation(); controls.toggle('info', infoBtn); };
  rateBtn.onclick = (e) => { e.stopPropagation(); controls.toggle('speed', rateBtn); };
  tracksBtn.onclick = (e) => { e.stopPropagation(); controls.toggle('subs', tracksBtn); };
  picBtn.onclick = (e) => {
    e.stopPropagation();
    const modes = ['fit', 'fill', 'stretch', 'actual'];
    picMode = modes[(modes.indexOf(picMode) + 1) % modes.length];
    picBtn.dataset.mode = picMode;
    toast('Picture size: ' + picMode);
    controls.refresh();
  };
  fullBtn.onclick = (e) => { e.stopPropagation(); toast('Fullscreen (mock)'); };
  seekEl.oninput = () => { ws = S.seekFrame(ws, Number(seekEl.value)); render(); };
  $('railToggleBtn').onclick = () => { rail.toggle(); setTimeout(render, 20); };

  function loadScenario(key) {
    const sc = SCENARIOS[key] || SCENARIOS.single;
    ws = S.createWorkspaceState(sc);
    ab.clear();
    if (sc.railOpen) rail.show();
    else if (rail.isOpen()) rail.close();
    render();
  }
  scenarioSel.onchange = () => loadScenario(scenarioSel.value);
  $('resetBtn').onclick = () => loadScenario(scenarioSel.value);

  splitterEl.onpointerdown = (e) => {
    e.preventDefault();
    splitterEl.classList.add('dragging');
    const rect = stageEl.getBoundingClientRect();
    const move = (ev) => { ws = S.setHeroRatio(ws, (ev.clientY - rect.top) / rect.height); render(); };
    const up = () => { splitterEl.classList.remove('dragging'); window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  dividerEl.onpointerdown = (e) => {
    e.preventDefault();
    const rect = stageEl.getBoundingClientRect();
    const move = (ev) => { ws = S.setSplitRatio(ws, (ev.clientX - rect.left) / rect.width); render(); };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  setInterval(() => {
    const tab = S.getTab(ws);
    if (!tab.playing) return;
    ws = S.seekFrame(ws, (tab.frame + 1) % (tab.maxFrame + 1));
    render();
  }, 42);

  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(() => render()).observe(stageEl);
  }
  window.addEventListener('resize', render);
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
