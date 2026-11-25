'use strict';
// Reusable interactive UI mockup harness: inlines the REAL player.css, compare.css, compare-grid.js,
// player-state.js, and bar.js markup inside a lightweight VS Code Explorer + Tab Bar shell driven by
// FakeEngine (tools/mockup/fake-engine.js). Zero build step; output works directly with html_preview / html_render.
const fs = require('fs');
const path = require('path');
const { barHtml } = require('../../src/bar');

const ROOT = path.join(__dirname, '..', '..');

const SCENARIOS = {
  single: { tiles: ['clip-0'], capture: false, layout: 'grid', label: 'Single video (1×1)' },
  'capture-waiting': { tiles: ['clip-0'], capture: true, layout: 'grid', label: 'Compare ready (1×1, Capture ON)' },
  'grid-2': { tiles: ['clip-0', 'clip-1'], capture: true, layout: 'grid', label: 'Compare 2×1 Grid' },
  'grid-3': { tiles: ['clip-0', 'clip-1', 'clip-2'], capture: true, layout: 'grid', label: 'Compare 2×2 (3 videos + spare slot)' },
  'grid-4': { tiles: ['clip-0', 'clip-1', 'clip-2', 'clip-3'], capture: true, layout: 'grid', label: 'Compare 2×2 (4 videos)' },
  spotlight: { tiles: ['clip-0', 'clip-1', 'clip-2'], capture: true, layout: 'spotlight', spotlightId: 'clip-0', label: 'Spotlight (enlarged tile + strip)' },
  'split-wipe': { tiles: ['clip-0', 'clip-1'], capture: true, layout: 'split', label: 'Split Wipe (2 videos)' },
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
 * Build a self-contained HTML mockup using the real production CSS, bar markup, and pure state modules.
 * @param {{ scenario?: string, theme?: 'dark' | 'light', height?: number }} [opts]
 * @returns {string}
 */
function buildMockupHtml(opts = {}) {
  const scenarioKey = SCENARIOS[opts.scenario] ? opts.scenario : 'single';
  const scenario = SCENARIOS[scenarioKey];
  const theme = opts.theme === 'light' ? 'light' : 'dark';
  const wbHeight = Math.max(360, Math.min(900, Math.round(Number(opts.height) || 496)));

  const playerCss = sanitizeCssForInlineFrame(readRepoFile('media/player.css'));
  const compareCss = sanitizeCssForInlineFrame(readRepoFile('media/compare.css'));
  const gridJs = readRepoFile('media/compare-grid.js');
  const stateJs = readRepoFile('media/player-state.js');
  const fakeEngineJs = readRepoFile('tools/mockup/fake-engine.js');
  // Reuse the real bar markup from src/bar.js so icons and control structure never drift from production.
  const realBarHtml = barHtml({ compare: false, canCompare: true, compareOpen: false, folder: true });

  const vscodeVars = theme === 'light'
    ? `--vscode-editor-background:#ffffff; --vscode-foreground:#1f2328; --vscode-editorWidget-background:#f3f3f3;
       --vscode-panel-border:rgba(0,0,0,0.12); --vscode-focusBorder:#005fb8; --vscode-toolbar-hoverBackground:rgba(0,0,0,0.08);
       --vscode-button-background:#005fb8; --vscode-button-foreground:#fff; --vscode-button-hoverBackground:#0258a8;
       --vscode-widget-shadow:rgba(0,0,0,0.2); --vpe-dim:#57606a; --vpe-mono:ui-monospace,Consolas,monospace;
       --vpe-seek-fill:#005fb8; --vpe-fill-subtle:rgba(0,0,0,0.05); --vpe-bd-subtle:rgba(0,0,0,0.12);
       --vpe-bd-active:rgba(0,0,0,0.38); --vpe-hover:rgba(0,0,0,0.09); --vpe-surface-float:rgba(248,248,250,0.92);
       --vpe-panel-border:rgba(0,0,0,0.15); --vpe-panel-fg:#1f2328;`
    : `--vscode-editor-background:#1e1e1e; --vscode-foreground:#e4e4e7; --vscode-editorWidget-background:#1b1b1f;
       --vscode-panel-border:rgba(255,255,255,0.1); --vscode-focusBorder:#38bdf8; --vscode-toolbar-hoverBackground:rgba(255,255,255,0.1);
       --vscode-button-background:#0e639c; --vscode-button-foreground:#fff; --vscode-button-hoverBackground:#1177bb;
       --vscode-widget-shadow:rgba(0,0,0,0.55); --vpe-dim:#a1a1aa; --vpe-mono:ui-monospace,Consolas,monospace;
       --vpe-seek-fill:#38bdf8; --vpe-fill-subtle:rgba(255,255,255,0.06); --vpe-bd-subtle:rgba(255,255,255,0.12);
       --vpe-bd-active:rgba(255,255,255,0.36); --vpe-hover:rgba(255,255,255,0.12); --vpe-surface-float:rgba(20,22,28,0.88);
       --vpe-panel-border:rgba(255,255,255,0.14); --vpe-panel-fg:#e4e4e7;`;

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
</style>
<style>
/* Mockup harness overrides: keep html/body transparent & content-sized for inline html_render. */
:root { ${vscodeVars} }
html, body {
  height: auto !important;
  overflow: visible !important;
  background: transparent !important;
  color: var(--foreground, var(--vscode-foreground));
  font-family: var(--font-sans, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
  font-size: 12px;
}
.wb {
  display: flex; flex-direction: column; height: ${wbHeight}px;
  border-radius: var(--radius, 8px); overflow: hidden;
  border: 1px solid var(--border, var(--vscode-panel-border));
  background: var(--vscode-editor-background); color: var(--vscode-foreground);
  user-select: none;
}
.wb-main { display: flex; flex: 1; min-height: 0; }
.explorer {
  width: 172px; flex: none; background: color-mix(in srgb, var(--vscode-editor-background) 85%, #000);
  border-right: 1px solid var(--vscode-panel-border); display: flex; flex-direction: column; min-height: 0;
}
.exp-hd {
  padding: 8px 10px 6px; font-size: 10px; font-weight: 600; letter-spacing: 0.06em;
  text-transform: uppercase; color: var(--vpe-dim); display: flex; justify-content: space-between;
}
.exp-folder { padding: 4px 8px; font-size: 11px; font-weight: 600; opacity: 0.85; }
.exp-list { flex: 1; overflow-y: auto; padding: 2px 4px; display: flex; flex-direction: column; gap: 1px; }
.exp-item {
  display: flex; align-items: center; gap: 6px; width: 100%; padding: 5px 8px 5px 16px;
  border: 0; border-radius: 4px; background: transparent; color: inherit; font: inherit;
  font-size: 11.5px; text-align: left; cursor: pointer;
}
.exp-item:hover { background: var(--vscode-toolbar-hoverBackground); }
.exp-dot { width: 6px; height: 6px; border-radius: 50%; flex: none; }
.exp-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
.exp-badge {
  font-size: 9.5px; font-weight: 700; padding: 0 4px; height: 15px; line-height: 15px;
  border-radius: 999px; background: var(--vpe-fill-subtle); border: 1px solid var(--vpe-bd-subtle); flex: none;
}
.exp-tip { padding: 8px 10px; border-top: 1px solid var(--vscode-panel-border); font-size: 10.5px; line-height: 1.4; color: var(--vpe-dim); }
.editor { flex: 1; min-width: 0; display: flex; flex-direction: column; background: #000; }
.tabs {
  height: 30px; background: color-mix(in srgb, var(--vscode-editor-background) 85%, #000);
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
#stage { flex: 1; min-height: 0; background: #000; position: relative; overflow: hidden; }
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
#startCompareBtn.cap-on {
  background: color-mix(in srgb, var(--vscode-focusBorder) 16%, transparent);
  border: 1px solid color-mix(in srgb, var(--vscode-focusBorder) 55%, transparent);
  color: var(--vscode-foreground); padding: 0 7px; width: auto; gap: 5px; font-size: 11px;
}
#startCompareBtn { width: auto; padding: 0 6px; gap: 5px; font-size: 11px; }
#bar .ib.active { background: var(--vpe-fill-subtle); border: 1px solid var(--vpe-bd-active); }
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
<div class="wb">
  <div class="wb-main">
    <aside class="explorer" aria-label="Simulated Explorer">
      <div class="exp-hd"><span>Explorer</span><span>clips/</span></div>
      <div class="exp-folder">▾ dailies_v4</div>
      <div class="exp-list" id="expList"></div>
      <div class="exp-tip" id="expTip"></div>
    </aside>
    <section class="editor">
      <div class="tabs" id="tabs"></div>
      <div id="stage">
        <div id="cells"></div>
        <div class="cap-banner" id="capBanner" hidden>
          <span class="cap-pulse"></span>
          <span>Open new videos in this compare view</span>
          <button id="capPickBtn">Pick…</button>
          <button id="capStopBtn">Pause</button>
        </div>
        <div class="splitter h" id="splitter" hidden><div class="splitter-bar"></div></div>
        <div id="divider" hidden><div class="h">⇄</div></div>
        <div id="toast" hidden></div>
      </div>
      ${realBarHtml}
    </section>
  </div>
</div>
<div class="harness-foot">
  <div class="harness-pills" id="statePills"></div>
  <div class="harness-ctrls">
    <select id="scenarioSel" aria-label="Scenario preset">${scenarioOptions}</select>
    <button id="resetBtn">Reset</button>
  </div>
</div>

<script>${escapeScript(gridJs)}</script>
<script>${escapeScript(stateJs)}</script>
<script>${escapeScript(fakeEngineJs)}</script>
<script>
(() => {
  const S = globalThis.VpePlayerState;
  const engine = globalThis.VpeFakeEngine.createFakeEngine();
  const SCENARIOS = ${JSON.stringify(SCENARIOS)};
  const INITIAL_KEY = ${JSON.stringify(scenarioKey)};

  const $ = (id) => document.getElementById(id);
  const stageEl = $('stage'), cellsEl = $('cells'), expList = $('expList'), expTip = $('expTip');
  const tabsEl = $('tabs'), capBanner = $('capBanner'), splitterEl = $('splitter'), dividerEl = $('divider');
  const toastEl = $('toast'), statePills = $('statePills'), scenarioSel = $('scenarioSel');
  const seekEl = $('seek'), nowEl = $('now'), durEl = $('dur');
  const tracksBtn = $('tracks'), folderCap = $('folderCap'), capCount = $('capCount');
  const cmpBtn = $('startCompareBtn');

  // Inject unified Split (N===2) and Sync (N>=2) buttons right beside Compare inside the real #bar.
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

  let ws = S.createWorkspaceState(SCENARIOS[INITIAL_KEY]);
  let toastTimer = 0;

  function showToast(msg) {
    if (!msg) return;
    toastEl.textContent = msg;
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.hidden = true; }, 1800);
  }

  function fmtTime(f, fps) {
    const s = f / (fps || 24);
    const m = Math.floor(s / 60);
    return m + ':' + (s % 60).toFixed(2).padStart(5, '0');
  }

  function render() {
    const tab = S.getTab(ws);
    const W = stageEl.clientWidth || 540;
    const H = stageEl.clientHeight || 380;
    const ui = S.deriveUi(tab, { width: W, height: H });

    // Explorer
    expList.innerHTML = '';
    engine.clips.forEach((c) => {
      const idx = tab.tiles.indexOf(c.id);
      const btn = document.createElement('button');
      btn.className = 'exp-item';
      btn.innerHTML = '<span class="exp-dot" style="background:' + c.color + '"></span>' +
        '<span class="exp-name">' + c.name + '</span>' +
        (idx >= 0 && ui.isMulti ? '<span class="exp-badge">' + S.TILE_KEYS[idx] + '</span>' : '');
      btn.onclick = () => {
        const res = S.openVideo(ws, c.id, { label: c.name });
        ws = res.state;
        showToast(res.toast);
        render();
      };
      expList.appendChild(btn);
    });
    const anyCap = ws.tabs.some((t) => t.capture);
    expTip.textContent = anyCap
      ? 'Capture ON: clicking a clip joins Compare.'
      : (ui.isMulti ? 'Capture paused: clicking opens a new tab.' : 'Click Compare, then click clips above.');

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
        if (e.target.dataset && e.target.dataset.close) {
          ws = S.closeTab(ws, t.id);
        } else {
          ws = S.selectTab(ws, t.id);
        }
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
      cell.onclick = (e) => { if (!e.target.closest('button')) { ws = S.togglePlay(ws); render(); } };

      if (ui.isMulti) {
        const ov = document.createElement('div');
        ov.className = 'ov';
        const isHero = r.role === 'hero';
        const off = tab.offsets[r.clipId] || 0;
        const pillCls = r.role === 'split-b' ? 'pill right' : 'pill';
        ov.innerHTML =
          '<div class="' + pillCls + '"><span class="ltr">' + r.letter + '</span><span class="nm">' + clip.name + '</span><span class="fr">#' + (tab.frame + off) + '</span></div>' +
          (ui.effectiveLayout !== 'split'
            ? '<div class="tile-top-acts"><button class="tbtn" data-enlarge="' + r.clipId + '" title="' + (isHero ? 'Back to grid' : 'Enlarge tile') + '">' + (isHero ? collapseSvg : expandSvg) + '</button>' +
              '<button class="tbtn rm" data-rm="' + r.clipId + '" title="Remove from compare">' + closeSvg + '</button></div>'
            : '') +
          '<div class="sync-pill"><button data-off="' + r.clipId + '" data-d="-1">−</button><span>' + (off >= 0 ? '+' : '') + off + 'f</span><button data-off="' + r.clipId + '" data-d="1">+</button></div>';
        ov.querySelectorAll('[data-enlarge]').forEach((b) => { b.onclick = (e) => { e.stopPropagation(); ws = S.toggleEnlarge(ws, r.clipId); render(); }; });
        ov.querySelectorAll('[data-rm]').forEach((b) => { b.onclick = (e) => { e.stopPropagation(); const res = S.removeTile(ws, r.clipId); ws = res.state; showToast(res.toast); render(); }; });
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
      slot.innerHTML = '<button class="addcell">+ Add video</button>';
      slot.querySelector('button').onclick = () => {
        const next = engine.clips.find((c) => !tab.tiles.includes(c.id));
        if (next) { const res = S.openVideo(ws, next.id, { label: next.name }); ws = res.state; showToast(res.toast); render(); }
      };
      cellsEl.appendChild(slot);
    }

    splitterEl.hidden = !ui.showSplitter;
    if (!splitterEl.hidden) splitterEl.style.top = Math.round(H * tab.heroRatio) + 'px';
    dividerEl.hidden = !ui.showDivider;
    if (!dividerEl.hidden) dividerEl.style.left = Math.round(W * tab.split) + 'px';
    capBanner.hidden = !ui.showCaptureBanner;

    // Real #bar controls reacting to PlayerState
    if (tracksBtn) tracksBtn.hidden = !ui.showCC;
    if (folderCap) {
      folderCap.hidden = !ui.showFolderCapsule;
      if (ui.showFolderCapsule && capCount) {
        const idx = engine.clips.findIndex((c) => c.id === tab.tiles[0]);
        capCount.textContent = (idx + 1) + '/' + engine.clips.length;
      }
    }
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
    $('play').classList.toggle('playing', tab.playing);

    statePills.innerHTML =
      '<span class="harness-pill">Videos: <strong>' + ui.n + '</strong></span>' +
      '<span class="harness-pill">Layout: <strong>' + ui.layoutLabel + '</strong></span>' +
      '<span class="harness-pill">Capture: <strong>' + (tab.capture ? 'ON' : 'OFF') + '</strong></span>';
  }

  cmpBtn.onclick = () => { const res = S.toggleCapture(ws); ws = res.state; showToast(res.toast); render(); };
  $('capStopBtn').onclick = cmpBtn.onclick;
  $('capPickBtn').onclick = () => {
    const tab = S.getTab(ws);
    const next = engine.clips.find((c) => !tab.tiles.includes(c.id));
    if (next) { const res = S.openVideo(ws, next.id, { label: next.name }); ws = res.state; showToast(res.toast); render(); }
  };
  splitBtn.onclick = () => { ws = S.toggleSplit(ws); render(); };
  syncBtn.onclick = () => { ws = S.toggleSyncMode(ws); render(); };
  $('play').onclick = () => { ws = S.togglePlay(ws); render(); };
  $('prev').onclick = () => { ws = S.stepFrame(ws, -1); render(); };
  $('next').onclick = () => { ws = S.stepFrame(ws, 1); render(); };
  seekEl.oninput = () => { ws = S.seekFrame(ws, Number(seekEl.value)); render(); };
  $('capPrev').onclick = () => {
    const tab = S.getTab(ws);
    const idx = engine.clips.findIndex((c) => c.id === tab.tiles[0]);
    const prev = engine.clips[(idx + engine.clips.length - 1) % engine.clips.length];
    ws = S.openVideo(ws, prev.id, { label: prev.name }).state;
    render();
  };
  $('capNext').onclick = () => {
    const tab = S.getTab(ws);
    const idx = engine.clips.findIndex((c) => c.id === tab.tiles[0]);
    const next = engine.clips[(idx + 1) % engine.clips.length];
    ws = S.openVideo(ws, next.id, { label: next.name }).state;
    render();
  };
  scenarioSel.onchange = () => { ws = S.createWorkspaceState(SCENARIOS[scenarioSel.value]); render(); };
  $('resetBtn').onclick = () => { ws = S.createWorkspaceState(SCENARIOS[scenarioSel.value]); render(); };

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

  window.addEventListener('resize', render);
  render();
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
  let height = 496;
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
