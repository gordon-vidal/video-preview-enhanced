'use strict';
// node test/run.js unit --grep unified_html: the unified webview page (src/unified-html.js) without VS Code: the CSP
// (connect-src loopback ports per transport), the nonce on every script, the script load order the globals need,
// every script on disk, the escaping of the config and of inlined assets, and the DOM media/player-ui.js mounts on.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { unifiedHtml, UNIFIED_CSS, UNIFIED_SCRIPTS } = require('../../src/unified-html');
const { SCRIPTS: PLAYER_SCRIPTS } = require('../../src/player-html');
const { createDom } = require('./fake-dom');

const MEDIA = path.join(__dirname, '..', '..', 'media');
const uri = (...p) => `vsc:/media/${p.join('/')}`;
const input = (more = {}) => ({
  cspSource: 'vsc-src:', uri, base: 'vsc:/build', loader: 'libav-vpe.js', nonce: 'NONCE123', cfg: { page: 1 },
  sequence: false, framePort: 0, transport: 'message', debug: false, ...more,
});
const csp = (html) => /Content-Security-Policy" content="([^"]*);"/.exec(html)[1];
const connect = (html) => csp(html).split('; ').find((d) => d.startsWith('connect-src '));
const srcsOf = (html, nonce = 'NONCE123') => [...html.matchAll(new RegExp(`<script nonce="${nonce}" src="vsc:/media/([^"]+)"></script>`, 'g'))]
  .map((m) => m[1]);

{ // connect-src: the loopback frame server only for the transport in use, only with a port; tests allow both.
  assert.strictEqual(connect(unifiedHtml(input())), 'connect-src vsc-src: blob:');
  assert.strictEqual(connect(unifiedHtml(input({ transport: 'http' }))), 'connect-src vsc-src: blob:', 'no port: nothing');
  assert.strictEqual(connect(unifiedHtml(input({ framePort: 4321, transport: 'http' }))),
    'connect-src vsc-src: blob: http://127.0.0.1:4321');
  assert.strictEqual(connect(unifiedHtml(input({ framePort: 4321, transport: 'ws' }))),
    'connect-src vsc-src: blob: ws://127.0.0.1:4321');
  assert.strictEqual(connect(unifiedHtml(input({ framePort: 4321, transport: 'message' }))), 'connect-src vsc-src: blob:');
  assert.strictEqual(connect(unifiedHtml(input({ framePort: 4321, transport: 'message', debug: true }))),
    'connect-src vsc-src: blob: http://127.0.0.1:4321 ws://127.0.0.1:4321');
  assert.strictEqual(connect(unifiedHtml(input({ framePort: 4321, transport: undefined }))), 'connect-src vsc-src: blob:',
    'no transport means message');
}

{ // The rest of the CSP is fixed and matches the single player's page.
  const html = unifiedHtml(input());
  assert.deepStrictEqual(csp(html).split('; ').slice(0, 6), [
    "default-src 'none'",
    'img-src vsc-src: blob: data:',
    'media-src vsc-src: blob: data:',
    "style-src 'nonce-NONCE123' vsc-src:",
    "script-src 'nonce-NONCE123' vsc-src: blob: 'wasm-unsafe-eval'",
    'worker-src blob:',
  ]);
  assert.match(html, /^<!DOCTYPE html>\n<html lang="en"><head><meta charset="utf-8">\n/);
  const links = [...html.matchAll(/<link rel="stylesheet" href="vsc:\/media\/([^"]+)">/g)].map((m) => m[1]);
  assert.deepStrictEqual(links, UNIFIED_CSS);
  assert.deepStrictEqual(UNIFIED_CSS, ['player.css', 'compare.css', 'folder-rail.css']);
}

{ // Every script tag carries the nonce; the tags are exactly UNIFIED_SCRIPTS, in order, after the config.
  const html = unifiedHtml(input());
  const tags = [...html.matchAll(/<script\b[^>]*>/g)].map((m) => m[0]);
  for (const t of tags.filter((x) => !x.includes('application/json'))) assert.ok(t.includes('nonce="NONCE123"'), t);
  assert.deepStrictEqual(srcsOf(html), UNIFIED_SCRIPTS);
  assert.ok(html.indexOf('id="cfg"') < html.indexOf(`src="vsc:/media/${UNIFIED_SCRIPTS[0]}"`), 'config before the scripts');
  assert.strictEqual(new Set(UNIFIED_SCRIPTS).size, UNIFIED_SCRIPTS.length, 'no script twice');
}

{ // Every script exists under media/, and none of the old page scripts (player.js, compare.js) is loaded.
  for (const f of UNIFIED_SCRIPTS) assert.ok(fs.existsSync(path.join(MEDIA, f)), `media/${f} exists`);
  for (const f of UNIFIED_CSS) assert.ok(fs.existsSync(path.join(MEDIA, f)), `media/${f} exists`);
  assert.ok(!UNIFIED_SCRIPTS.includes('player.js') && !UNIFIED_SCRIPTS.includes('compare.js'), 'no old page script');
}

{ // Load order: each module after the globals it reads.
  const at = (f) => { const i = UNIFIED_SCRIPTS.indexOf(f); assert.ok(i >= 0, `${f} is loaded`); return i; };
  const before = (a, b) => assert.ok(at(a) < at(b), `${a} before ${b}`);
  // The single player's base keeps its own order.
  const base = PLAYER_SCRIPTS.filter((f) => f !== 'player-ui.js' && f !== 'player.js');
  assert.deepStrictEqual(UNIFIED_SCRIPTS.filter((f) => base.includes(f)), base, 'the player base order is kept');
  for (const dep of ['block-cache.js', 'gl-renderer.js', 'codec-utils.js', 'decoder-boot.js']) before(dep, 'engine.js');
  before('stepgoal.js', 'compare-sync.js');
  for (const dep of ['player-state.js', 'compare-grid.js']) before(dep, 'player-ui-tiles.js');
  for (const ui of ['player-ui-tiles.js', 'player-ui-input.js', 'player-ui-tools.js', 'player-ui-lifecycle.js']) {
    before(ui, 'player-ui.js');
  }
  // The widgets player-ui.js takes from the window (GLOBAL_WIDGETS) are loaded before it.
  for (const w of ['controls.js', 'folder-rail.js', 'ctxmenu.js', 'abloop.js', 'autoplay.js', 'timefmt.js', 'picture.js',
    'modes.js']) before(w, 'player-ui.js');
  for (const a of ['player-engine-adapter.js', 'player-host-adapter.js']) {
    before('player-ui.js', a);
    for (const core of ['engine.js', 'frame-player.js', 'compare-compositor.js']) before(core, a);
  }
  assert.deepStrictEqual(UNIFIED_SCRIPTS.slice(-2), ['player-engine-adapter.js', 'player-host-adapter.js'], 'adapters last');
}

{ // entryScript: the Phase 5 boot script loads last; without one the page ends with the adapters.
  const html = unifiedHtml(input({ entryScript: 'player-unified.js' }));
  const srcs = srcsOf(html);
  assert.deepStrictEqual(srcs, [...UNIFIED_SCRIPTS, 'player-unified.js']);
  assert.ok(!unifiedHtml(input()).includes('player-unified.js'));
}

{ // The decoder's files download before the scripts and styles load; image sequences have no decoder.
  const html = unifiedHtml(input());
  const early = /<script nonce="NONCE123">\{const controller=new AbortController\(\), responses=\{\};self\.vpeEarly=\{controller,responses\};for\(const u of (\[[^\]]*\])\)/.exec(html);
  assert.ok(early, 'early fetch script');
  assert.deepStrictEqual(JSON.parse(early[1]), [
    'vsc:/media/decoder-worker.js', 'vsc:/build/libav-vpe.js', 'vsc:/build/libav-vpe.wasm.js', 'vsc:/build/libav-vpe.wasm.wasm',
  ]);
  assert.ok(html.indexOf('self.vpeEarly') < html.indexOf('player.css'), 'before the stylesheets');
  assert.ok(!unifiedHtml(input({ sequence: true })).includes('vpeEarly'));
}

{ // The config: "<" never closes the JSON script early, and it round-trips.
  const cfg = { page: 2, goto: { frame: 120 }, names: ['</script><b>x.mp4', 'b</style>.mkv'], resume: 3.5 };
  const html = unifiedHtml(input({ cfg }));
  const m = /<script type="application\/json" id="cfg">([^]*?)<\/script>/.exec(html);
  assert.ok(!m[1].includes('<'));
  assert.deepStrictEqual(JSON.parse(m[1]), cfg);
}

{ // Inlined CSS and small scripts keep the nonce and can never close their elements early.
  const html = unifiedHtml(input({
    inlineCss: ['body{color:red}</style><script>x', '.cell{}', '.rail{}'],
    inlineScripts: { 'modes.js': 'const s="</script><!--";' },
  }));
  assert.ok(!html.includes('<link rel="stylesheet"'), 'inlined CSS replaces the link tags');
  assert.ok(html.includes('<style nonce="NONCE123">body{color:red}<\\/style><script>x</style>'));
  assert.ok(html.includes('<script nonce="NONCE123" data-src="modes.js">const s="<\\/script><\\!--";</script>'));
  assert.ok(!html.includes('src="vsc:/media/modes.js"'), 'the inlined script is not also loaded');
  assert.strictEqual(srcsOf(html).length, UNIFIED_SCRIPTS.length - 1);
}

{ // The DOM: every id VpePlayerUi.create() requires (need('...') in media/player-ui.js) and the stage parts it and
  // the tool / lifecycle controllers look up, in one parse of the rendered page (no duplicate ids).
  const src = fs.readFileSync(path.join(MEDIA, 'player-ui.js'), 'utf8');
  const required = [...new Set([...src.matchAll(/\bneed\('([\w-]+)'\)/g)].map((m) => m[1]))];
  assert.ok(required.length >= 10 && required.includes('stage') && required.includes('bar'), 'need() ids found');
  const expected = [
    'main', 'stage', 'canvas', 'cells', 'splitter', 'divider', 'subs', 'overlay', 'message', 'hint', 'action',
    'playFlash', 'toast', 'notice', 'noticeText', 'noticeAction', 'noticeSettings', 'noticeHide', 'noticeClose',
    'bar', 'seek', 'play', 'prev', 'next', 'cog', 'infoBtn', 'startCompareBtn', 'tracks',
    'panel', 'sheet', 'ctxmenu', 'menu', 'live',
  ];
  for (const folder of [false, true]) {
    const html = unifiedHtml(input({ folder }));
    const body = /<body[^>]*>([^]*)<\/body>/.exec(html)[1];
    const { $ } = createDom(body);
    for (const id of [...required, ...expected]) assert.ok($(id), `#${id} (folder: ${folder})`);
    assert.strictEqual(!!$('rail'), folder, 'the folder rail only for a file in a folder');
    assert.strictEqual(!!$('folderCap'), folder, 'the folder capsule only for a file in a folder');
    const ids = [...body.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
    assert.deepStrictEqual(ids.filter((id, i) => ids.indexOf(id) !== i), [], 'no duplicate ids');
    // The layout chrome waits hidden until a Spotlight / Split Wipe layout shows it.
    assert.strictEqual($('splitter').hidden, true);
    assert.strictEqual($('divider').hidden, true);
  }
  assert.strictEqual(createDom(/<body[^>]*>([^]*)<\/body>/.exec(unifiedHtml(input({ canCompare: false })))[1])
    .$('startCompareBtn').hidden, true, 'canCompare: false hides Compare');
}

{ // bodyClass: Compare's stage rules (media/compare.css body.compare) can be switched on; nothing unsafe gets in.
  assert.match(unifiedHtml(input()), /<\/head><body>\n/);
  assert.match(unifiedHtml(input({ bodyClass: 'compare' })), /<body class="compare">/);
  assert.match(unifiedHtml(input({ bodyClass: 'a"><script>' })), /<body class="ascript">/);
}

console.log('unified_html_test: ok');
