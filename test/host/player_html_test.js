'use strict';
// node test/host/player_html_test.js: the single-file player's page (src/player-html.js) without VS Code:
// the CSP (connect-src loopback ports per transport), the nonce on every script, the load order of the
// scripts, the early decoder downloads and the config (goto, resume) that media/player.js reads.
const assert = require('assert');
const { playerHtml, frameSourcesOf, SCRIPTS } = require('../../src/player-html');

const uri = (...p) => `vsc:/media/${p.join('/')}`;
const input = (more = {}) => ({
  cspSource: 'vsc-src:', uri, base: 'vsc:/build', loader: 'libav-vpe.js', nonce: 'NONCE123', cfg: { page: 1 },
  sequence: false, framePort: 0, transport: 'message', debug: false, canCompare: true, compareOpen: false, ...more,
});
const csp = (html) => /Content-Security-Policy" content="([^"]*);"/.exec(html)[1];
const connect = (html) => csp(html).split('; ').find((d) => d.startsWith('connect-src '));

{ // connect-src: the loopback frame server only for the transport in use, only with a port.
  assert.strictEqual(connect(playerHtml(input())), 'connect-src vsc-src: blob:');
  assert.strictEqual(connect(playerHtml(input({ transport: 'http' }))), 'connect-src vsc-src: blob:', 'no port: nothing');
  assert.strictEqual(connect(playerHtml(input({ framePort: 4321, transport: 'http' }))),
    'connect-src vsc-src: blob: http://127.0.0.1:4321');
  assert.strictEqual(connect(playerHtml(input({ framePort: 4321, transport: 'ws' }))),
    'connect-src vsc-src: blob: ws://127.0.0.1:4321');
  assert.strictEqual(connect(playerHtml(input({ framePort: 4321, transport: 'message' }))), 'connect-src vsc-src: blob:');
  assert.strictEqual(connect(playerHtml(input({ framePort: 4321, transport: 'message', debug: true }))),
    'connect-src vsc-src: blob: http://127.0.0.1:4321 ws://127.0.0.1:4321', 'tests (VPE_LOG) allow both');
  assert.deepStrictEqual(frameSourcesOf({ framePort: 0, transport: 'ws', debug: true }), []);
}

{ // The rest of the CSP is fixed: nothing but the webview's own files, blobs and the nonce'd scripts.
  const html = playerHtml(input());
  assert.deepStrictEqual(csp(html).split('; ').slice(0, 6), [
    "default-src 'none'",
    'img-src vsc-src: blob: data:',
    'media-src vsc-src: blob: data:',
    'style-src vsc-src:',
    "script-src 'nonce-NONCE123' vsc-src: blob: 'wasm-unsafe-eval'",
    'worker-src blob:',
  ]);
  assert.match(html, /^<!DOCTYPE html>\n<html lang="en"><head><meta charset="utf-8">\n/);
  assert.match(html, /<link rel="stylesheet" href="vsc:\/media\/player\.css">/);
}

{ // Every script tag carries the nonce, and the scripts load in the order the globals depend on.
  const html = playerHtml(input());
  const tags = [...html.matchAll(/<script\b[^>]*>/g)].map((m) => m[0]);
  assert.ok(tags.length > 20);
  for (const t of tags.filter((x) => !x.includes('application/json'))) assert.ok(t.includes('nonce="NONCE123"'), t);
  const srcs = [...html.matchAll(/<script nonce="NONCE123" src="vsc:\/media\/([^"]+)"><\/script>/g)].map((m) => m[1]);
  assert.deepStrictEqual(srcs, SCRIPTS);
  const at = (f) => srcs.indexOf(f);
  assert.ok(at('membudget.js') === 0 && at('player.js') === srcs.length - 1, 'player.js is last');
  assert.ok(at('block-cache.js') < at('engine.js') && at('gl-renderer.js') < at('engine.js'));
  assert.ok(at('codec-utils.js') < at('engine.js') && at('decoder-boot.js') < at('engine.js'));
  assert.ok(at('engine.js') < at('controls.js') && at('timefmt.js') < at('debug-probe.js'));
  assert.ok(html.indexOf('id="cfg"') < html.indexOf('membudget.js'), 'config before the scripts');
}

{ // The decoder's files download before the scripts load; image sequences have no decoder.
  const html = playerHtml(input());
  const early = /<script nonce="NONCE123">\{const controller=new AbortController\(\), responses=\{\};self\.vpeEarly=\{controller,responses\};for\(const u of (\[[^\]]*\])\)/.exec(html);
  assert.ok(early, 'early fetch script');
  assert.deepStrictEqual(JSON.parse(early[1]), [
    'vsc:/media/decoder-worker.js', 'vsc:/build/libav-vpe.js', 'vsc:/build/libav-vpe.wasm.js', 'vsc:/build/libav-vpe.wasm.wasm',
  ]);
  assert.ok(html.indexOf('self.vpeEarly') < html.indexOf('player.css'), 'before the stylesheet');
  assert.ok(!playerHtml(input({ sequence: true })).includes('vpeEarly'));
}

{ // The config: goto and resume reach the page, and "<" never closes the JSON script early.
  const cfg = { page: 2, goto: { frame: 120 }, resume: 3.5, name: '</script><b>x.mp4' };
  const html = playerHtml(input({ cfg }));
  const m = /<script type="application\/json" id="cfg">([^]*?)<\/script>/.exec(html);
  assert.ok(!m[1].includes('<'));
  assert.deepStrictEqual(JSON.parse(m[1]), cfg);
  assert.deepStrictEqual(JSON.parse(/id="cfg">([^]*?)<\/script>/.exec(playerHtml(input({ cfg: { goto: null } })))[1]), { goto: null });
}

{ // The Compare button state reaches the bar.
  assert.notStrictEqual(playerHtml(input({ canCompare: true })), playerHtml(input({ canCompare: false })));
}

console.log('player_html_test: ok');
