'use strict';
// The single-file player's webview page (Session.html in src/extension.js): the CSP, the decoder's early
// downloads, the DOM the scripts expect and the script load order. Pure: strings in, string out, so a Node
// test can check the CSP and the order without VS Code (compare.js's compareHtml is the same idea).
const fs = require('fs');
const path = require('path');
const { barHtml, playFlashHtml } = require('./bar');
const { folderRailHtml } = require('./folder-rail-html');

// checkJs: start
/**
 * @typedef {object} PlayerHtmlInput
 * @property {string} cspSource webview.cspSource
 * @property {(...p: string[]) => string} uri a file under media/ as a webview URI
 * @property {string} base webview URI of the decoder build's folder
 * @property {string} loader the decoder loader's file name inside `base`
 * @property {string} nonce
 * @property {unknown} cfg the page's config object (read by media/player.js from #cfg)
 * @property {boolean} sequence an image sequence: no decoder to download early
 * @property {number} [framePort] the localhost frame server's port, local windows only
 * @property {string} transport 'http' | 'ws' | 'message' (src/extension.js nativeTransport)
 * @property {boolean} debug VPE_LOG set: tests may use either frame transport
 * @property {boolean} canCompare
 * @property {boolean} compareOpen
 * @property {boolean} [folder] a file in a folder: the folder capsule and rail (not URLs or image sequences)
 * @property {string[]} [inlineCss] CSS text to inline in `<style nonce="...">` (no unstyled first paint)
 * @property {Record<string, string>} [inlineScripts] script file name -> source to inline (remote hosts)
 */

/** Small helper scripts up to this size are inlined on remote hosts: each webview resource is an SSH round trip. */
const INLINE_SCRIPT_MAX_BYTES = 16 * 1024;
/** @type {Map<string, string>} */
const mediaCache = new Map();

/** Escape `</style` so inlined CSS can never end its `<style>` element early.
 * @param {string} css
 */
function escapeStyle(css) {
  return String(css).replace(/<\/style/gi, '<\\/style');
}

/** Escape `</script` and `<!--` so inlined JS can never end its `<script>` element early.
 * @param {string} js
 */
function escapeScript(js) {
  return String(js).replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--');
}

/**
 * Reads a static text asset under `mediaDir` once and keeps it in the host's memory.
 * Null when the file cannot be read (the caller falls back to the external URI).
 * @param {string} mediaDir
 * @param {string} file
 * @returns {string | null}
 */
function readMediaAsset(mediaDir, file) {
  if (!mediaDir || !file) return null;
  const full = path.join(mediaDir, file);
  const cached = mediaCache.get(full);
  if (cached !== undefined) return cached;
  try {
    const text = fs.readFileSync(full, 'utf8');
    mediaCache.set(full, text);
    return text;
  } catch {
    return null;
  }
}

/**
 * The CSS to inline (always: no unstyled first paint) and, on remote hosts, the small helper scripts.
 * @param {string} mediaDir
 * @param {{ cssFiles?: string[], scriptFiles?: string[], inlineScripts?: boolean }} o
 * @returns {{ inlineCss: string[], inlineScripts: Record<string, string> }}
 */
function inlineAssetsFor(mediaDir, { cssFiles = [], scriptFiles = [], inlineScripts = false } = {}) {
  /** @type {string[]} */
  const inlineCss = [];
  let cssOk = cssFiles.length > 0;
  for (const f of cssFiles) {
    const text = readMediaAsset(mediaDir, f);
    if (text === null) { cssOk = false; break; }
    inlineCss.push(text);
  }
  /** @type {Record<string, string>} */
  const scripts = {};
  if (inlineScripts && mediaDir) {
    for (const f of scriptFiles) {
      const text = readMediaAsset(mediaDir, f);
      if (text !== null && text.length <= INLINE_SCRIPT_MAX_BYTES) scripts[f] = text;
    }
  }
  return { inlineCss: cssOk ? inlineCss : [], inlineScripts: scripts };
}

/**
 * The page's stylesheet tags (`<style>` when inlined, else `<link>`) and script tags (inlined where given).
 * @param {{ uri: (...p: string[]) => string, nonce: string, cssFiles: string[], scriptFiles: string[],
 *   inlineCss?: string[], inlineScripts?: Record<string, string> }} p
 */
function assetTags({ uri, nonce, cssFiles, scriptFiles, inlineCss, inlineScripts }) {
  const styles = Array.isArray(inlineCss) && inlineCss.length
    ? inlineCss.map((css) => `<style nonce="${nonce}">${escapeStyle(css)}</style>`).join('\n')
    : cssFiles.map((f) => `<link rel="stylesheet" href="${uri(f)}">`).join('\n');
  const inlined = inlineScripts || {};
  const scripts = scriptFiles.map((s) => (Object.prototype.hasOwnProperty.call(inlined, s)
    ? `<script nonce="${nonce}" data-src="${s}">${escapeScript(inlined[s])}</script>`
    : `<script nonce="${nonce}" src="${uri(s)}"></script>`)).join('\n');
  return { styles, scripts };
}

/**
 * The connect-src entries for native frames from the localhost frame server (src/frameserver.js).
 * @param {{ framePort?: number, transport: string, debug: boolean }} p
 */
function frameSourcesOf({ framePort, transport, debug }) {
  const loopback = framePort ? `127.0.0.1:${framePort}` : '';
  if (!loopback) return [];
  return [
    ...((debug || transport === 'http') ? [`http://${loopback}`] : []),
    ...((debug || transport === 'ws') ? [`ws://${loopback}`] : []),
  ];
}

/** @param {PlayerHtmlInput} p */
function playerHtml(p) {
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
    ['connect-src', cspSource, 'blob:', ...frameSourcesOf(p)].join(' '),
  ].join('; ');
  // The decoder's files (8 MB of WebAssembly) start downloading before the page's scripts load;
  // engine.js takes the responses (self.vpeEarly). Not for image sequences (no decoder).
  const stem = `${base}/${p.loader}`.replace(/\.js$/, '');
  const early = p.sequence ? [] : [uri('decoder-worker.js'), `${base}/${p.loader}`, `${stem}.wasm.js`, `${stem}.wasm.wasm`];
  const earlyJs = early.length ? `<script nonce="${nonce}">{const controller=new AbortController(), responses={};self.vpeEarly={controller,responses};for(const u of ${JSON.stringify(early).replace(/</g, '\\u003c')})responses[u]=fetch(u,{signal:controller.signal}).catch(()=>null);}</script>\n` : '';
  const { styles, scripts } = assetTags({
    uri, nonce, cssFiles: CSS, scriptFiles: SCRIPTS, inlineCss: p.inlineCss, inlineScripts: p.inlineScripts,
  });
  const cfg = JSON.stringify(p.cfg);
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp};">
<meta name="viewport" content="width=device-width, initial-scale=1">
${earlyJs}${styles}
</head><body>
<script type="application/json" id="cfg">${cfg.replace(/</g, '\\u003c')}</script>
<div id="main">
<div id="stage" class="fit">
  <canvas id="canvas" hidden role="img" aria-label="Video"></canvas>
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
${barHtml({ canCompare: p.canCompare, compareOpen: p.compareOpen, folder: !!p.folder })}
<div id="startCompareBackdrop" hidden>
  <div id="startCompareDialog" tabindex="-1" role="dialog" aria-modal="true" aria-label="Start comparison" aria-describedby="startCompareHint">
    <p id="startCompareHint">Start Compare with this video, then click videos in the Explorer to add them.</p>
    <div class="compare-actions">
      <button id="cancelCompareBtn" type="button">Cancel</button>
      <button id="confirmCompareBtn" type="button">Start comparison</button>
    </div>
  </div>
</div>
<div id="panel" class="panel" role="dialog" aria-label="Player settings" hidden></div>
<div id="sheet" hidden></div>
<div id="ctxmenu" class="ctxmenu" role="menu" aria-label="Player menu" tabindex="-1" hidden></div>
<div id="live" class="sr-only" role="status" aria-live="polite" aria-atomic="true"></div>
${scripts}
</body></html>`;
}

/** The page's scripts in load order (each reads globals the ones before it define). */
const SCRIPTS = [
  'membudget.js', 'timestretch.js', 'pool.js', 'thumbs.js', 'framestream.js', 'hdr.js', 'block-cache.js',
  'gl-renderer.js', 'codec-utils.js', 'decoder-boot.js', 'engine.js', 'picture.js', 'inspect.js', 'scopes.js', 'exactframe.js', 'reduced-res-notice.js',
  'slow-notice.js', 'subtitles.js', 'tracks-menu.js', 'xray.js', 'modes.js', 'range-drag.js', 'controls.js',
  'ctxmenu.js', 'timefmt.js', 'abloop.js', 'autoplay.js', 'folder-rail.js', 'debug-probe.js', 'frame-player.js', 'player.js',
];
/** The page's stylesheets, in order (inlined: src/extension.js inlineAssetsFor). */
const CSS = ['player.css', 'folder-rail.css'];
// checkJs: end

module.exports = {
  playerHtml, frameSourcesOf, SCRIPTS, CSS, assetTags,
  INLINE_SCRIPT_MAX_BYTES, escapeStyle, escapeScript, readMediaAsset, inlineAssetsFor,
};
