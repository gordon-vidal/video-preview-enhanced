'use strict';
// The single-file player's webview page (Session.html in src/extension.js): the CSP, the decoder's early
// downloads, the DOM the scripts expect and the script load order. Pure: strings in, string out, so a Node
// test can check the CSP and the order without VS Code (compare.js's compareHtml is the same idea).
const { barHtml, playFlashHtml } = require('./bar');

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
 */

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
    `style-src ${cspSource}`,
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
  const cfg = JSON.stringify(p.cfg);
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp};">
<meta name="viewport" content="width=device-width, initial-scale=1">
${earlyJs}<link rel="stylesheet" href="${uri('player.css')}">
</head><body>
<script type="application/json" id="cfg">${cfg.replace(/</g, '\\u003c')}</script>
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
${barHtml({ canCompare: p.canCompare, compareOpen: p.compareOpen })}
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
${SCRIPTS.map((s) => `<script nonce="${nonce}" src="${uri(s)}"></script>`).join('\n')}
</body></html>`;
}

/** The page's scripts in load order (each reads globals the ones before it define). */
const SCRIPTS = [
  'membudget.js', 'timestretch.js', 'pool.js', 'thumbs.js', 'framestream.js', 'hdr.js', 'block-cache.js',
  'gl-renderer.js', 'engine.js', 'picture.js', 'inspect.js', 'scopes.js', 'exactframe.js', 'reduced-res-notice.js',
  'slow-notice.js', 'subtitles.js', 'tracks-menu.js', 'xray.js', 'modes.js', 'range-drag.js', 'controls.js',
  'ctxmenu.js', 'timefmt.js', 'abloop.js', 'debug-probe.js', 'player.js',
];
// checkJs: end

module.exports = { playerHtml, frameSourcesOf, SCRIPTS };
