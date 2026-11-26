'use strict';
// node test/run.js unit --grep unified_viewer: the unified viewer's host (src/unified-viewer.js) without VS Code,
// over a fake panel and real files in a temp folder: what a clip is prepared with, the page it renders (no file
// path in it), file blocks by clip id, a second video joining through the registry's capture routing (1 -> 2 -> 1
// in the same panel), duplicates, stale pages and dispose.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createUnifiedRegistry } = require('../../src/unified-session');
const { createUnifiedViewer, prepareClip, isViewable, clipIdOf, ENTRY_SCRIPT } = require('../../src/unified-viewer');

const ROOT = path.join(__dirname, '..', '..');

/** The parts of vscode.Uri the viewer uses. */
class Uri {
  constructor(scheme, p, authority = '') {
    this.scheme = scheme;
    this.path = p.replace(/\\/g, '/');
    this.fsPath = p;
    this.authority = authority;
  }
  static file(p) { return new Uri('file', p); }
  static joinPath(base, ...parts) { return new Uri(base.scheme, path.join(base.fsPath, ...parts), base.authority); }
  with(change) { return change.path !== undefined ? new Uri(this.scheme, change.path, this.authority) : this; }
  toString() { return `${this.scheme}://${this.authority}${this.path.startsWith('/') ? '' : '/'}${this.path}`; }
}

function fakePanel() {
  const posts = [];
  const handlers = { message: null, dispose: null, view: null };
  const panel = {
    title: '', active: true, visible: true,
    webview: {
      html: '', options: null, cspSource: 'vscode-webview://test',
      asWebviewUri: (u) => ({ toString: () => `https://webview.test/${path.basename(u.fsPath)}` }),
      postMessage: (m) => { posts.push(m); },
      onDidReceiveMessage: (fn) => { handlers.message = fn; },
    },
    onDidDispose: (fn) => { handlers.dispose = fn; },
    onDidChangeViewState: (fn) => { handlers.view = fn; },
  };
  return { panel, posts, handlers };
}

const vscode = {
  Uri,
  env: { clipboard: { writeText: async () => {} } },
  commands: { executeCommand: async () => {} },
};

const logs = [];
const deps = (more = {}) => ({
  log: (m) => logs.push(m),
  engineCfg: () => ({ workerUrl: 'https://webview.test/decoder-worker.js', debug: false }),
  libavBuild: () => ({ dir: Uri.file(path.join(ROOT, 'media', 'libav-vpe')), loader: 'libav.js' }),
  prefs: () => ({ jump: {} }),
  maxVideos: () => 3,
  rail: null,
  ...more,
});

const cfgOf = (html) => JSON.parse(/<script type="application\/json" id="cfg">([^]*?)<\/script>/.exec(html)[1]);
const tick = () => new Promise((resolve) => setTimeout(resolve, 20));
const context = { extensionUri: Uri.file(ROOT) };

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vpe-unified-viewer-'));
  const write = (name, bytes) => {
    const p = path.join(dir, name);
    fs.writeFileSync(p, Buffer.from(bytes));
    return Uri.file(p);
  };
  const a = write('a.mp4', [1, 2, 3, 4, 5, 6, 7, 8]);
  const b = write('b.mp4', [9, 8, 7]);

  try {
    { // Which videos the lane takes: files on disk, local or remote; never a URL or a virtual file.
      assert.strictEqual(isViewable(a), true);
      assert.strictEqual(isViewable(new Uri('vscode-remote', '/v/a.mp4', 'ssh-remote+box')), true);
      assert.strictEqual(isViewable(new Uri('https', '/v/a.mp4', 'example.org')), false);
      assert.strictEqual(isViewable(new Uri('git', '/v/a.mp4')), false);
      assert.strictEqual(isViewable(null), false);
    }

    { // A prepared clip: the file's size, a stable id that names no path, and the native decision.
      const c = await prepareClip(a, {});
      assert.strictEqual(c.size, 8);
      assert.strictEqual(c.label, 'a.mp4');
      assert.strictEqual(c.id, clipIdOf(a));
      assert.ok(/^c[0-9a-f]{16}$/.test(c.id), c.id);
      assert.strictEqual(c.native, false);
      assert.strictEqual(c.decision, null);
      assert.notStrictEqual(clipIdOf(a), clipIdOf(b));

      const asked = [];
      const probed = { video: { width: 1920, height: 1080, fps: 25 }, duration: 12 };
      const native = await prepareClip(a, {
        rotationOf: async () => 90, transport: () => 'http',
        nativeFor: async (file, transport) => {
          asked.push([file, transport]);
          return { tools: {}, method: 'cpu', maxHeight: 1080, probed };
        },
      });
      assert.deepStrictEqual(asked, [[a.fsPath, 'http']]);
      assert.strictEqual(native.native, true);
      assert.strictEqual(native.rotation, 90);
      assert.deepStrictEqual([native.width, native.height, native.fps, native.duration], [1920, 1080, 25, 12]);
      // Live transcode is not this lane's: such a file plays through the built-in decoder.
      const stream = await prepareClip(a, { nativeFor: async () => ({ tools: {}, stream: {}, probed }) });
      assert.strictEqual(stream.native, false);
      // No ffmpeg, or a failed check: the built-in decoder.
      assert.strictEqual((await prepareClip(a, { nativeFor: async () => null })).native, false);
      const failing = await prepareClip(a, { nativeFor: async () => { throw new Error('probe failed'); } });
      assert.strictEqual(failing.native, false);
      await assert.rejects(prepareClip(Uri.file(path.join(dir, 'missing.mp4')), {}));
    }

    { // One panel: the page, blocks by clip id, a captured second video, and back to one.
      const registry = createUnifiedRegistry();
      const { panel, posts, handlers } = fakePanel();
      const clipA = await prepareClip(a, {});
      const viewer = createUnifiedViewer({ vscode, context, panel, clip: clipA, registry, deps: deps() });
      assert.deepStrictEqual(registry.sessions, [viewer.session]);
      viewer.show();

      // The page: the unified shell with the boot script last, and a config that names the clip by id only.
      const html = panel.webview.html;
      assert.ok(html.includes(ENTRY_SCRIPT), 'the boot script is loaded');
      assert.ok(html.indexOf('player-ui.js') < html.indexOf(ENTRY_SCRIPT), 'after the controller');
      for (const where of [dir, dir.replace(/\\/g, '/'), JSON.stringify(dir).slice(1, -1)]) {
        assert.ok(!html.includes(where), 'the page never learns where the file is');
      }
      const cfg = cfgOf(html);
      assert.strictEqual(cfg.page, 1);
      assert.strictEqual(cfg.surface, 'unified');
      assert.deepStrictEqual(cfg.tiles, [clipA.id]);
      assert.deepStrictEqual(cfg.clips.map((c) => [c.id, c.clipId, c.name, c.size, c.native]),
        [[clipA.id, clipA.id, 'a.mp4', 8, false]]);
      assert.strictEqual(panel.title, 'a.mp4');
      assert.deepStrictEqual(panel.webview.options.localResourceRoots.map((u) => u.fsPath), [path.join(ROOT, 'media')]);

      // A message of another page (a document VS Code replaced) is not ours.
      await handlers.message({ type: 'ready', page: 7 });
      assert.strictEqual(posts.length, 0);

      await handlers.message({ type: 'ready', page: 1 });
      const state = posts.shift();
      assert.strictEqual(state.type, 'sessionState');
      assert.strictEqual(state.page, 1, 'every post carries the page');
      assert.deepStrictEqual(state.order, [clipA.id]);
      assert.strictEqual(state.maxVideos, 3);

      // The decoder's blocks: by clip id, tagged for the page's routing; an unknown clip gets no answer.
      await handlers.message({ type: 'readBlock', page: 1, clipId: clipA.id, key: clipA.id, pos: 2, len: 4 });
      const block = posts.shift();
      assert.deepStrictEqual([block.type, block.clipId, block.key, block.pos, [...block.data]],
        ['block', clipA.id, clipA.id, 2, [3, 4, 5, 6]]);
      await handlers.message({ type: 'readBlock', page: 1, clipId: 'c-not-ours', pos: 0, len: 4 });
      await handlers.message({ type: 'readBlock', page: 1, clipId: a.fsPath, pos: 0, len: 4 });
      assert.strictEqual(posts.length, 0);

      // Capture off: a newly opened video is not routed here (the caller opens a tab).
      const clipB = await prepareClip(b, {});
      assert.deepStrictEqual(registry.routeOpen(clipB), { captured: false });

      // Capture on (the page's toggle): the next video joins this panel, in place.
      await handlers.message({ type: 'capture', page: 1, on: true });
      const routed = registry.routeOpen(clipB);
      assert.strictEqual(routed.captured, true);
      assert.strictEqual(routed.added, true);
      assert.strictEqual(routed.session, viewer.session);
      const open = posts.shift();
      assert.deepStrictEqual([open.type, open.clipId, open.label, open.clip.size, open.compare],
        ['openVideo', clipB.id, 'b.mp4', 3, true]);
      assert.strictEqual(panel.title, 'a.mp4 ↔ b.mp4');
      assert.strictEqual(html, panel.webview.html, 'no new page: the panel grew in place');
      await handlers.message({ type: 'readBlock', page: 1, clipId: clipB.id, pos: 0, len: 16 });
      assert.deepStrictEqual([...posts.shift().data], [9, 8, 7]);

      // The same video again: not added, the page says so. A URL is never this lane's.
      assert.strictEqual(await viewer.addUri(b), false);
      assert.deepStrictEqual(posts.shift().text, 'b.mp4 is in compare already');
      assert.strictEqual(await viewer.addUri(new Uri('https', '/x.mp4', 'example.org')), false);

      // Back to one video: the kept clip stays, capture ends, the other clip's blocks stop.
      await handlers.message({ type: 'leaveCompare', page: 1, keepId: clipB.id });
      assert.strictEqual(panel.title, 'b.mp4');
      assert.strictEqual(viewer.session.capture, false);
      assert.deepStrictEqual(registry.routeOpen(clipA), { captured: false });
      await handlers.message({ type: 'readBlock', page: 1, clipId: clipA.id, pos: 0, len: 4 });
      assert.strictEqual(posts.length, 0);

      // The panel hides: the page is told (auto-pause), the registry follows the active panel.
      panel.visible = false;
      panel.active = false;
      handlers.view();
      assert.deepStrictEqual(posts.shift(), { type: 'setVisible', visible: false, active: false, page: 1 });
      assert.strictEqual(viewer.session.active, false);

      // Closing the tab: out of the registry, no post after it.
      let disposed = 0;
      viewer.onDispose = () => { disposed++; };
      handlers.dispose();
      handlers.dispose();
      assert.strictEqual(disposed, 1);
      assert.strictEqual(viewer.disposed, true);
      assert.deepStrictEqual(registry.sessions, []);
      viewer.post({ type: 'toast', text: 'late' });
      await handlers.message({ type: 'readBlock', page: 1, clipId: clipB.id, pos: 0, len: 4 });
      assert.strictEqual(posts.length, 0);
    }

    { // Native ffmpeg failed for a clip: the same file takes its place under a new id, decoded in the page.
      const { panel, posts, handlers } = fakePanel();
      const decision = { tools: {}, method: 'cpu', maxHeight: 720, messageMaxHeight: 720, probed: { video: {} }, reason: 'test' };
      const clipA = { ...(await prepareClip(a, {})), native: true, decision };
      const viewer = createUnifiedViewer({ vscode, context, panel, clip: clipA, registry: null, deps: deps() });
      viewer.show();
      assert.strictEqual(cfgOf(panel.webview.html).clips[0].native, true);
      await handlers.message({ type: 'ready', page: 1 });
      posts.length = 0;
      // What the decoder's onFail does, through the session it was given.
      const builtIn = { ...clipA, id: clipIdOf(a, 'b'), native: false, decision: null };
      assert.strictEqual(viewer.session.replaceClip(clipA.id, builtIn), true);
      const swap = posts.shift();
      assert.deepStrictEqual([swap.type, swap.oldId, swap.newId, swap.clip.native],
        ['replaceTile', clipA.id, clipIdOf(a, 'b'), false]);
      assert.strictEqual(panel.title, 'a.mp4');
      handlers.dispose();
    }

    { // A vanished file error stays in the host log and never discloses an absolute path in the webview toast.
      const { panel, posts, handlers } = fakePanel();
      const missingPath = path.join(dir, 'vanished-secret-dir', 'gone.mp4');
      const clipA = await prepareClip(a, {});
      const d = deps();
      d.pick = async () => [uriOf(missingPath)];
      const viewer = createUnifiedViewer({ vscode, context, panel, clip: clipA, registry: null, deps: d });
      viewer.show();
      await handlers.message({ type: 'ready', page: 1 });
      posts.length = 0;
      await handlers.message({ type: 'pickVideo', page: 1 });
      const toastMsg = posts.find((m) => m.type === 'toast');
      assert.ok(toastMsg, 'error posts a user-facing toast');
      assert.ok(!toastMsg.text.includes(dir) && !toastMsg.text.includes('vanished-secret-dir'),
        `toast must not leak filesystem path: ${toastMsg.text}`);
      handlers.dispose();
    }
  } finally {
    await tick(); // the file handles close
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log('unified_viewer_test OK');
})().catch((e) => { console.error(e); process.exit(1); });
