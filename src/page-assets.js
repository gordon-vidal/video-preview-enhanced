// @ts-check
'use strict';
// The webview pages' asset helpers (the unified viewer's src/unified-html.js and src/unified-viewer.js): stylesheet and
// script tags, the CSS and small scripts to inline, the frame server's connect-src entries. Pure apart from reading
// media/ files once, so a Node test can check them without VS Code.
const fs = require('fs');
const path = require('path');

// checkJs: start
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
    // 'http' too: a Compare that grows to a large grid moves its new tiles to WebSockets.
    ...((debug || transport === 'ws' || transport === 'http') ? [`ws://${loopback}`] : []),
  ];
}
// checkJs: end

module.exports = {
  assetTags, inlineAssetsFor, frameSourcesOf, escapeStyle, escapeScript, readMediaAsset, INLINE_SCRIPT_MAX_BYTES,
};
