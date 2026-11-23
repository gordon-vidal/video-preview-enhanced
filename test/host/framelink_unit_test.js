'use strict';
// node test/run.js unit --grep framelink_unit: src/framelink.js and src/associations.js with fakes, no VS Code
// (the extension-level behaviour is covered by frame_link_test.js, auto_default_test.js and file_icons_test.js).
const assert = require('assert');
const { createFrameLink, sameFile, hlsPlanText } = require('../../src/framelink');
const { createAssociations, DEFAULT_PATTERNS } = require('../../src/associations');
const { parseFragment } = require('../../media/inspect.js');

const Uri = {
  file: (p) => ({ scheme: 'file', authority: '', path: p.replace(/\\/g, '/'), fsPath: p, toString: () => `file://${p}`, with(o) { return { ...this, ...o }; } }),
  parse: (s) => { const m = /^([\w-]+):\/\/([^/]*)(\/.*)$/.exec(s); return { scheme: m[1], authority: m[2], path: m[3], fsPath: m[3], toString: () => s, with(o) { return { ...this, ...o }; } }; },
  from: (o) => ({ ...o, fsPath: o.path, toString: () => `${o.scheme}://${o.authority}${o.path}`, with(x) { return { ...this, ...x }; } }),
};
const make = (env, over = {}) => createFrameLink({
  vscode: { env: { uriScheme: 'vscode', ...env }, Uri },
  config: () => ({ nativeMaxHeight: 1080, nativeMaxAuto: false, sizeFramesToView: true }),
  decide: { streamHeight: () => 2160 }, nativeTransport: () => 'http', probe: { CLIP_FPS: 30 },
  urlsource: { displayName: (u) => u.split('/').pop() }, parseFragment, ...over,
});

const local = make({});
const ctx = { extension: { id: 'pub.name' } };
assert.deepStrictEqual(local.parseLink('frame=12&t=0.5&file=/a b/c&d.mp4').goto, { t: 0.5, frame: 12 });
assert.strictEqual(local.parseLink('frame=12&file=/a&b.mp4').target.fsPath, '/a&b.mp4', 'the file runs to the end');
assert.strictEqual(local.parseLink('frame=1'), null);
assert.strictEqual(local.gotoFrom('x=1'), null);
assert.strictEqual(local.frameLink(ctx, Uri.file('/v/a b.mp4'), 5, 1.5, null), 'vscode://pub.name/open?frame=5&t=1.5&file=%2Fv%2Fa%20b.mp4');
assert.strictEqual(local.localTarget(Uri.parse('vscode-remote://ssh-remote+h/x.mp4')), null, 'a remote link in a local window');

const remote = make({ remoteName: 'ssh-remote', remoteAuthority: 'ssh-remote+h' });
assert.strictEqual(remote.localTarget(Uri.parse('vscode-remote://ssh-remote+h/x.mp4')).scheme, 'file');
assert.strictEqual(remote.localTarget(Uri.parse('vscode-remote://ssh-remote+other/x.mp4')), null);
assert.match(remote.frameLink(ctx, Uri.file('/x.mp4'), 1, 0, null), /&uri=vscode-remote%3A%2F%2Fssh-remote%2Bh%2Fx\.mp4$/);

// Frame-size caps: automatic goes through decide.streamHeight; WSL's postMessage cap is 720 at most.
assert.deepStrictEqual(local.nativeHeights({ nativeMaxAuto: true, nativeMaxHeight: 0 }, null), { stream: 2160, message: 0 });
assert.strictEqual(make({ remoteName: 'wsl' }).nativeHeights({ nativeMaxAuto: false, nativeMaxHeight: 1080 }).message, 720);
assert.strictEqual(make({}, { nativeTransport: () => 'message' }).nativeHeight({ nativeMaxAuto: false, nativeMaxHeight: 900 }), 900);
const key = (port) => local.nativeKey({ ffmpeg: 'f', version: '7' }, { video: { index: 0, codec: 'h264', width: 1, height: 2, fps: 3 } },
  { method: 'auto' }, { nativeMaxAuto: false, nativeMaxHeight: 720, sizeFramesToView: false }, port);
assert.notStrictEqual(key(1234), key(0), 'the transport is part of the key only with a frame port');

assert.ok(sameFile({ size: 1, mtimeMs: 2 }, { size: 1, mtimeMs: 2 }) && !sameFile(null, {}) && !sameFile({ size: 1, mtimeMs: 2 }, { size: 1, mtimeMs: 3 }));
assert.strictEqual(hlsPlanText({ master: null, playlist: { encrypted: true } }), ', AES-128');
assert.strictEqual(local.urlBase('https://h/some clip.v2.mp4'), 'some_clip.v2');
assert.match(local.probeSummary({ results: { 'h264/8/1080': { fps: 90, method: 'cuda' }, 'hevc/10/2160': { fps: 10, method: 'none' } } }), /plays 1 of 2.*cuda.*Slower: hevc 10-bit 4K: 10 fps/);

// Associations with a fake settings store.
(async () => {
  let assoc = { '*.txt': 'x' };
  const st = new Map();
  const logs = [];
  const a = createAssociations({
    vscode: {
      ConfigurationTarget: { Global: 1 },
      window: { showInformationMessage: () => {} },
      workspace: { getConfiguration: () => ({ get: () => ({ ...assoc }), inspect: () => ({ globalValue: { ...assoc } }), update: async (k, v) => { assoc = { ...v }; } }) },
    },
    getState: () => ({ get: (k) => st.get(k), update: async (k, v) => { st.set(k, v); } }), log: (m) => logs.push(m),
  });
  assert.deepStrictEqual(await a.makeDefault(true, { silent: true }), DEFAULT_PATTERNS);
  assert.deepStrictEqual(await a.makeDefault(true, { silent: true }), [], 'nothing to add the second time');
  assert.deepStrictEqual(await a.makeDefault(false, { silent: true }), DEFAULT_PATTERNS);
  assert.deepStrictEqual(assoc, { '*.txt': 'x' });
  await a.autoDefault();
  assert.strictEqual(st.get('videoPreviewEnhanced.autoDefault').added.length, 4);
  await a.undoDefault({ silent: true });
  assert.deepStrictEqual(st.get('videoPreviewEnhanced.autoDefault').added, []);
  console.log('framelink_unit_test: ok');
})().catch((e) => { console.error(e); process.exit(1); });
