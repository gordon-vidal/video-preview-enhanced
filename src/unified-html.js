// @ts-check
'use strict';
// The unified webview page (docs/notes/player-ui-controller.md, "Production wiring"): one page for one
// video and for a comparison of N, mounted by media/player-ui.js (VpePlayerUi.create) over the production engine
// and host adapters. Pure, like src/player-html.js and src/compare.js compareHtml: strings in, string out, so a Node
// test (test/host/unified_html_test.js) checks the CSP, the script order and the DOM the controller needs. Its
// host is src/unified-viewer.js (through src/unified-session.js render), which passes the boot script as `entryScript`.
const { assetTags, frameSourcesOf } = require('./page-assets');
const { barHtml, playFlashHtml } = require('./bar');
const { folderRailHtml } = require('./folder-rail-html');

// checkJs: start
/**
 * @typedef {object} UnifiedHtmlInput
 * @property {string} cspSource webview.cspSource
 * @property {(...p: string[]) => string} uri a file under media/ as a webview URI
 * @property {string} base webview URI of the decoder build's folder
 * @property {string} loader the decoder loader's file name inside `base`
 * @property {string} nonce
 * @property {unknown} cfg the page's config object (read by the boot script from #cfg)
 * @property {boolean} [sequence] an image sequence: no decoder to download early
 * @property {number} [framePort] the localhost frame server's port, local windows only
 * @property {string} [transport] 'http' | 'ws' | 'message' (src/extension.js nativeTransport)
 * @property {boolean} [debug] VPE_LOG set: tests may use either frame transport
 * @property {boolean} [canCompare]
 * @property {boolean} [compareOpen]
 * @property {boolean} [folder] the folder capsule and rail (not URLs or image sequences)
 * @property {string} [bodyClass] a class on <body> (media/compare.css scopes its stage rules to body.compare)
 * @property {string} [entryScript] the boot script under media/, loaded last (media/player-unified.js)
 * @property {string[]} [inlineCss] CSS text to inline in `<style nonce="...">` (no unstyled first paint)
 * @property {Record<string, string>} [inlineScripts] script file name -> source to inline (remote hosts)
 */

/** The page's stylesheets, in order: the player's, Compare's (tiles, splitter, divider) and the folder rail's. */
const UNIFIED_CSS = ['player.css', 'compare.css', 'folder-rail.css'];

/** The page's scripts in load order (each reads globals the ones before it define). */
const UNIFIED_SCRIPTS = [
  // Decoders and media utilities: the single player's base order (src/player-html.js SCRIPTS) ...
  'membudget.js', 'timestretch.js', 'pool.js', 'thumbs.js', 'framestream.js', 'hdr.js', 'block-cache.js',
  'gl-renderer.js', 'codec-utils.js', 'decoder-boot.js', 'engine.js', 'picture.js', 'inspect.js', 'scopes.js',
  'exactframe.js', 'reduced-res-notice.js', 'slow-notice.js', 'subtitles.js', 'tracks-menu.js', 'xray.js', 'modes.js',
  'range-drag.js', 'controls.js', 'ctxmenu.js', 'timefmt.js', 'abloop.js', 'autoplay.js', 'folder-rail.js',
  'debug-probe.js', 'frame-player.js',
  // ... plus Compare's (src/compare.js compareScripts): stepgoal.js before compare-sync.js (VpeStepGoal).
  'stepgoal.js', 'comparerange.js', 'compare-grid.js', 'compare-compositor.js', 'compare-metrics.js',
  'compare-sync.js', 'compare-debug.js',
  // Pure state and the shared UI controller: the player-ui-*.js modules before player-ui.js, which reads them.
  'player-state.js', 'player-ui-tiles.js', 'player-ui-input.js', 'player-ui-tools.js', 'player-ui-lifecycle.js',
  'player-ui.js',
  // Production adapters: the decoders and the extension host behind the controller's contracts.
  'player-engine-adapter.js', 'player-host-adapter.js',
];

/** `<` never closes a `<script>` element early (JSON in #cfg, the early-fetch URL list). @param {unknown} v */
const jsonForScript = (v) => String(JSON.stringify(v)).replace(/</g, '\\u003c');

/**
 * The unified page. One stage for 1 to N videos: #cells holds the tiles, #splitter (Spotlight) and #divider
 * (Split Wipe) stay hidden until a layout needs them.
 * @param {UnifiedHtmlInput} p
 */
function unifiedHtml(p) {
  const { cspSource, uri, base, nonce } = p;
  const csp = [
    "default-src 'none'",
    `img-src ${cspSource} blob: data:`,
    `media-src ${cspSource} blob: data:`,
    `style-src 'nonce-${nonce}' ${cspSource}`,
    // The decoder worker is created from a blob and imports libav.js and its WebAssembly.
    `script-src 'nonce-${nonce}' ${cspSource} blob: 'wasm-unsafe-eval'`,
    'worker-src blob:',
    // Native frames from the localhost frame server (src/frameserver.js), local windows only.
    ['connect-src', cspSource, 'blob:',
      ...frameSourcesOf({ framePort: p.framePort, transport: p.transport || 'message', debug: !!p.debug })].join(' '),
  ].join('; ');
  // The decoder's files start downloading before the page's scripts load (engine.js takes self.vpeEarly), as in
  // src/player-html.js. Not for image sequences (no decoder).
  const stem = `${base}/${p.loader}`.replace(/\.js$/, '');
  const early = p.sequence ? [] : [uri('decoder-worker.js'), `${base}/${p.loader}`, `${stem}.wasm.js`, `${stem}.wasm.wasm`];
  const earlyJs = early.length ? `<script nonce="${nonce}">{const controller=new AbortController(), responses={};self.vpeEarly={controller,responses};for(const u of ${jsonForScript(early)})responses[u]=fetch(u,{signal:controller.signal}).catch(()=>null);}</script>\n` : '';
  const scriptFiles = p.entryScript ? [...UNIFIED_SCRIPTS, p.entryScript] : UNIFIED_SCRIPTS;
  const { styles, scripts } = assetTags({
    uri, nonce, cssFiles: UNIFIED_CSS, scriptFiles, inlineCss: p.inlineCss, inlineScripts: p.inlineScripts,
  });
  const bodyClass = p.bodyClass ? ` class="${String(p.bodyClass).replace(/[^\w -]/g, '')}"` : '';
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp};">
<meta name="viewport" content="width=device-width, initial-scale=1">
${earlyJs}${styles}
</head><body${bodyClass}>
<script type="application/json" id="cfg">${jsonForScript(p.cfg)}</script>
<div id="main">
<div id="stage" class="fit">
  <canvas id="canvas" hidden role="img" aria-label="Video"></canvas>
  <div id="cells"></div>
  <div id="splitter" class="splitter" role="separator" tabindex="0" aria-label="Spotlight split" aria-valuemin="10" aria-valuemax="90" hidden><div class="splitter-bar"></div></div>
  <div id="divider" role="slider" tabindex="0" aria-label="Split position" aria-valuemin="0" aria-valuemax="100" aria-valuenow="50" title="Drag, or ← → (Shift: 10 %), Home / End" hidden><span class="h"></span></div>
  <div id="subs" hidden></div>
  <div id="overlay"><div id="message">Opening…</div><div id="hint"></div><button id="action" hidden></button></div>
  ${playFlashHtml}
  <div id="toast" hidden aria-hidden="true"></div>
  <div id="notice" hidden>
    <span id="noticeText"></span>
    <button id="noticeAction"></button>
    <button id="noticeSettings" class="noticeSecondary" hidden></button>
    <button id="noticeHide" class="noticeSecondary" hidden></button>
    <button id="noticeClose" title="Dismiss" aria-label="Dismiss">×</button>
  </div>
</div>
${p.folder ? folderRailHtml() : ''}
</div>
${barHtml({ canCompare: p.canCompare !== false, compareOpen: !!p.compareOpen, folder: !!p.folder })}
<div id="panel" class="panel" role="dialog" aria-label="Player settings" hidden></div>
<div id="sheet" hidden></div>
<div id="ctxmenu" class="ctxmenu" role="menu" aria-label="Player menu" tabindex="-1" hidden></div>
<div id="menu" role="menu" aria-label="Video actions" hidden></div>
<div id="live" class="sr-only" role="status" aria-live="polite" aria-atomic="true"></div>
${scripts}
</body></html>`;
}
// checkJs: end

module.exports = { unifiedHtml, UNIFIED_CSS, UNIFIED_SCRIPTS };
