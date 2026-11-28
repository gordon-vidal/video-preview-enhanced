'use strict';
// node test/run.js unit --grep player_html: the page helpers (src/page-assets.js) and the viewer's page
// (src/unified-html.js) without VS Code: frame sources per transport, the nonce on inlined assets and the escaping of
// closing tags, the disk cache of inlined assets, the early decoder downloads and the config (goto, saved position)
// the page reads. The CSP and the script order are in test/host/unified_html_test.js.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  assetTags, frameSourcesOf, INLINE_SCRIPT_MAX_BYTES, escapeStyle, escapeScript, inlineAssetsFor, readMediaAsset,
} = require('../../src/page-assets');
const { unifiedHtml, UNIFIED_SCRIPTS } = require('../../src/unified-html');

const uri = (...p) => `vsc:/media/${p.join('/')}`;
const input = (more = {}) => ({
  cspSource: 'vsc-src:', uri, base: 'vsc:/build', loader: 'libav-vpe.js', nonce: 'NONCE123', cfg: { page: 1 },
  sequence: false, framePort: 0, transport: 'message', debug: false, entryScript: 'player-unified.js', ...more,
});
const csp = (html) => /Content-Security-Policy" content="([^"]*);"/.exec(html)[1];

{ // Frame sources: the loopback frame server only for the transport in use, only with a port; tests allow both.
  assert.deepStrictEqual(frameSourcesOf({ framePort: 0, transport: 'ws', debug: true }), []);
  assert.deepStrictEqual(frameSourcesOf({ framePort: 9, transport: 'http', debug: false }), ['http://127.0.0.1:9', 'ws://127.0.0.1:9']);
  assert.deepStrictEqual(frameSourcesOf({ framePort: 9, transport: 'message', debug: false }), []);
  assert.deepStrictEqual(frameSourcesOf({ framePort: 9, transport: 'message', debug: true }), ['http://127.0.0.1:9', 'ws://127.0.0.1:9']);
}

{ // Asset tags: a link per stylesheet (or a nonce'd style when inlined), a nonce'd script per file.
  const tags = assetTags({ uri, nonce: 'N', cssFiles: ['a.css', 'b.css'], scriptFiles: ['x.js', 'y.js'] });
  assert.deepStrictEqual(tags.styles.split('\n'), ['<link rel="stylesheet" href="vsc:/media/a.css">', '<link rel="stylesheet" href="vsc:/media/b.css">']);
  assert.ok(tags.scripts.includes('<script nonce="N" src="vsc:/media/x.js"></script>'));
  assert.ok(tags.scripts.indexOf('x.js') < tags.scripts.indexOf('y.js'), 'in order');
}

{ // The page: the CSP allows the nonce'd styles; the boot script loads last.
  const html = unifiedHtml(input());
  assert.ok(csp(html).includes("style-src 'nonce-NONCE123' vsc-src:"));
  const srcs = [...html.matchAll(/<script nonce="NONCE123" src="vsc:\/media\/([^"]+)"><\/script>/g)].map((m) => m[1]);
  assert.deepStrictEqual(srcs, [...UNIFIED_SCRIPTS, 'player-unified.js']);
  assert.ok(srcs.indexOf('player-state.js') >= 0 && srcs.indexOf('player-state.js') < srcs.indexOf('player-ui.js'),
    'the pure state loads before the controller that reads it');
}

{ // The decoder's files download before the scripts load; image sequences have no decoder.
  const html = unifiedHtml(input());
  const early = /<script nonce="NONCE123">\{const controller=new AbortController\(\), responses=\{\};self\.vpeEarly=\{controller,responses\};for\(const u of (\[[^\]]*\])\)/.exec(html);
  assert.ok(early, 'early fetch script');
  assert.deepStrictEqual(JSON.parse(early[1]), [
    'vsc:/media/decoder-worker.js', 'vsc:/build/libav-vpe.js', 'vsc:/build/libav-vpe.wasm.js', 'vsc:/build/libav-vpe.wasm.wasm',
  ]);
  assert.ok(html.indexOf('self.vpeEarly') < html.indexOf('player.css'), 'before the stylesheet');
  assert.ok(!unifiedHtml(input({ sequence: true })).includes('vpeEarly'));
}

{ // The config: goto and the saved position reach the page, and "<" never closes the JSON script early.
  const cfg = { page: 2, goto: { frame: 120 }, savedPos: { t: 3.5, d: 60 }, clips: [{ id: 'c1', name: '</script><b>x.mp4' }] };
  const html = unifiedHtml(input({ cfg }));
  const m = /<script type="application\/json" id="cfg">([^]*?)<\/script>/.exec(html);
  assert.ok(!m[1].includes('<'));
  assert.deepStrictEqual(JSON.parse(m[1]), cfg);
}

{ // Zero-FOUC inlined CSS and remote inlined small scripts keep the CSP nonce and escape closing tags.
  const html = unifiedHtml(input({
    inlineCss: ['body{color:red}</style><script>x'],
    inlineScripts: { 'modes.js': 'const s="</script><!--";' },
  }));
  assert.ok(!html.includes('<link rel="stylesheet"'), 'inlined CSS replaces link tag');
  assert.ok(html.includes('<style nonce="NONCE123">body{color:red}<\\/style><script>x</style>'));
  assert.ok(html.includes('<script nonce="NONCE123" data-src="modes.js">const s="<\\/script><\\!--";</script>'));
  assert.strictEqual(escapeStyle('a</STYLE>b'), 'a<\\/style>b');
  assert.strictEqual(escapeScript('a</SCRIPT><!--b'), 'a<\\/script><\\!--b');

  // inlineAssetsFor caches disk reads and only inlines scripts <= INLINE_SCRIPT_MAX_BYTES when enabled.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vpe-inline-'));
  try {
    fs.writeFileSync(path.join(dir, 'a.css'), 'body{background:#000}');
    fs.writeFileSync(path.join(dir, 'small.js'), 'const a=1;');
    fs.writeFileSync(path.join(dir, 'big.js'), 'x'.repeat(INLINE_SCRIPT_MAX_BYTES + 16));
    const localAssets = inlineAssetsFor(dir, { cssFiles: ['a.css'], scriptFiles: ['small.js', 'big.js'], inlineScripts: false });
    assert.deepStrictEqual(localAssets.inlineCss, ['body{background:#000}']);
    assert.deepStrictEqual(localAssets.inlineScripts, {});
    const remoteAssets = inlineAssetsFor(dir, { cssFiles: ['a.css'], scriptFiles: ['small.js', 'big.js'], inlineScripts: true });
    assert.deepStrictEqual(remoteAssets.inlineCss, ['body{background:#000}']);
    assert.deepStrictEqual(remoteAssets.inlineScripts, { 'small.js': 'const a=1;' });
    // Cached in memory even if overwritten on disk.
    fs.writeFileSync(path.join(dir, 'a.css'), 'changed');
    const cached = inlineAssetsFor(dir, { cssFiles: ['a.css'], scriptFiles: [], inlineScripts: false });
    assert.deepStrictEqual(cached.inlineCss, ['body{background:#000}']);
    assert.strictEqual(typeof readMediaAsset, 'function');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

console.log('player_html_test: ok');
