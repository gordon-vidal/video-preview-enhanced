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
const { createUnifiedViewer, prepareClip, sourceClip, isViewable, clipIdOf, ENTRY_SCRIPT } = require('../../src/unified-viewer');

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
    // ---- host feature parity (src/extension.js Session, src/compare.js) ----
    /** A vscode whose clipboard and commands record what they get. */
    const recVscode = () => {
      const copied = [];
      const commands = [];
      return {
        copied, commands,
        api: { Uri, env: { clipboard: { writeText: async (t) => { copied.push(t); } } }, commands: { executeCommand: async (...a) => { commands.push(a); } } },
      };
    };
    /** A host decoder that records its calls. */
    const fakeDecoder = (more = {}) => {
      const d = {
        handled: [], resizes: [], disposed: false, hidden: [], resolution: [], bitrate: [], outputs: [], quality: [],
        handle(m) { d.handled.push(m); },
        dispose() { d.disposed = true; },
        resize(h, mh) { const changed = d.lastH !== h; d.lastH = h; d.resizes.push([h, mh]); return changed; },
        lossy: () => true,
        setHidden(on) { d.hidden.push(on); },
        setResolution(h) { d.resolution.push(h); },
        setMaxBitrateMbps(m) { d.bitrate.push(m); },
        setCompareOutput(h, kbps) { d.outputs.push([h, kbps]); return d.outputs.length > 1; },
        setQuality(p) { d.quality.push(p); },
        ...more,
      };
      return d;
    };
    const video = { width: 1920, height: 1080, fps: 25, pixFmt: 'yuv420p' };
    const nativeDecision = { tools: { ffmpeg: 'x' }, method: 'cpu', maxHeight: 1080, messageMaxHeight: 720, probed: { video, duration: 10 }, reason: 'test' };
    const open = async (handlers, n = 1) => { await handlers.message({ type: 'ready', page: n }); };
    const settle = async () => { for (let i = 0; i < 5; i++) await tick(); };

    { // Subtitles: sidecars on ready for each file clip, "Load subtitles…" selects, and both come back for an added clip.
      const { panel, posts, handlers } = fakePanel();
      const clipA = await prepareClip(a, {});
      const asked = [];
      const sub = (name) => ({ id: `file:///${name}`, name, data: new Uint8Array([1]) });
      const viewer = createUnifiedViewer({ vscode, context, panel, clip: clipA, registry: null, deps: deps({
        findSidecars: async (uri) => { asked.push(path.basename(uri.fsPath)); return uri.fsPath.endsWith('a.mp4') ? [sub('a.srt')] : []; },
        loadSubtitles: async (c) => (c ? [sub('extra.vtt')] : []),
      }) });
      viewer.show();
      await open(handlers);
      await settle();
      const subs = posts.filter((m) => m.type === 'subs');
      assert.deepStrictEqual(subs.map((m) => [m.clipId, m.key, m.tracks.map((t) => t.name), m.files === m.tracks]),
        [[clipA.id, clipA.id, ['a.srt'], true]]);
      posts.length = 0;
      await handlers.message({ type: 'loadSubs', page: 1, clipId: clipA.id });
      assert.deepStrictEqual(posts.map((m) => [m.type, m.clipId, m.select, m.tracks[0].name]), [['subs', clipA.id, true, 'extra.vtt']]);
      posts.length = 0;
      // A new page (the document reloaded): sidecars again, the loaded file restored.
      await open(handlers);
      await settle();
      assert.deepStrictEqual(posts.filter((m) => m.type === 'subs').map((m) => [m.tracks[0].name, !!m.restore]),
        [['a.srt', false], ['extra.vtt', true]]);
      posts.length = 0;
      assert.ok(await viewer.addUri(b));
      await settle();
      assert.deepStrictEqual(asked.slice(-1), ['b.mp4'], 'an added clip is searched too');
      handlers.dispose();
    }

    { // Save frame, frame links, A-B export (range, grabbed frames, abQuery), and the page's exact frames.
      const rv = recVscode();
      const { panel, posts, handlers } = fakePanel();
      const clipA = await prepareClip(a, {});
      const calls = [];
      let decoder = null;
      const viewer = createUnifiedViewer({ vscode: rv.api, context, panel, clip: { ...clipA, native: true, decision: nativeDecision }, registry: null, deps: deps({
        saveFrame: (c, m) => { calls.push(['saveFrame', c.id, m.frame]); },
        copyLink: async (c, at) => `vscode://x/open#frame=${at.frame}`,
        exportAb: (kind, c, m) => { calls.push([kind, c && c.id, m.range]); },
        createNative: () => (decoder = fakeDecoder()),
        grabExactFrame: async ({ clip: c, decoder: d, t, isCurrent }) => {
          calls.push(['exact', c.id, d === decoder, t, isCurrent()]);
          return { png: Buffer.from([137, 80]), w: 2, h: 1, matrix: 'bt709' };
        },
      }) });
      viewer.show();
      await open(handlers);
      await settle();
      posts.length = 0;
      await handlers.message({ type: 'saveFrame', page: 1, frame: 4, data: new Uint8Array(1) });
      await handlers.message({ type: 'copyLink', page: 1, frame: 3, t: 0.12 });
      await handlers.message({ type: 'copyLink', page: 1, frame: -2 });
      assert.deepStrictEqual(rv.copied, ['vscode://x/open#frame=3']);
      assert.deepStrictEqual(posts.splice(0).map((m) => m.text), ['Link to frame 3 copied']);
      await handlers.message({ type: 'exportRange', page: 1, range: { a: 1, b: 9 } });
      await handlers.message({ type: 'clipRange', page: 1, clipId: 'c-gone', range: {} });
      await handlers.message({ type: 'ffmpegRange', page: 1, range: null });
      assert.deepStrictEqual(calls.splice(0), [['saveFrame', viewer.session.clips[0].id, 4],
        ['exportRange', clipA.id, { a: 1, b: 9 }], ['ffmpegRange', clipA.id, null]]);
      // The export asks the page for frames one by one.
      const grab = viewer.grabFrame(5);
      const ask = posts.pop();
      assert.deepStrictEqual([ask.type, ask.frame], ['exportGrab', 5]);
      await handlers.message({ type: 'exportFrame', page: 1, id: ask.id, frame: 5, data: new Uint8Array([7]) });
      assert.deepStrictEqual([...(await grab).data], [7]);
      const ac = new AbortController();
      const cancelled = viewer.grabFrame(6, ac.signal);
      ac.abort();
      assert.deepStrictEqual(await cancelled, { error: 'export cancelled' });
      const pending = viewer.grabFrame(7);
      await open(handlers); // a new document: exports in flight end
      assert.deepStrictEqual(await pending, { error: 'export cancelled' });
      viewer.queryAb('clip');
      assert.deepStrictEqual(posts.pop(), { type: 'abQuery', then: 'clip', page: 1 });
      posts.length = 0;
      // Exact frames: only when the clip plays downscaled on the host.
      await handlers.message({ type: 'grabExactFrame', page: 1, reqId: 1, t: 2 });
      assert.deepStrictEqual([posts[0].type, posts[0].reqId, posts[0].error], ['exactFrame', 1, 'exact frames are for Live transcode or downscaled native ffmpeg of a video file']);
      posts.length = 0;
      await handlers.message({ type: 'nd', page: 1, clipId: clipA.id, m: { type: 'open' } });
      await handlers.message({ type: 'grabExactFrame', page: 1, clipId: clipA.id, reqId: 2, t: 2 });
      assert.deepStrictEqual(calls.splice(0), [['exact', clipA.id, true, 2, true]]);
      const ex = posts.pop();
      assert.deepStrictEqual([ex.type, ex.clipId, ex.reqId, ex.t, [...ex.png], ex.w, ex.matrix, Buffer.isBuffer(ex.png)],
        ['exactFrame', clipA.id, 2, 2, [137, 80], 2, 'bt709', false]);
      await handlers.message({ type: 'grabExactFrame', page: 1, reqId: 'x', t: 2 });
      assert.strictEqual(posts.length, 0, 'a request without an id gets no answer');
      handlers.dispose();
      assert.strictEqual(decoder.disposed, true);
    }

    { // Resume position and frame links: the first page opens there; positions stored as the shipped player does.
      const { panel, posts, handlers } = fakePanel();
      const clipA = await prepareClip(a, {});
      const saved = [];
      const viewer = createUnifiedViewer({
        vscode, context, panel, clip: clipA, registry: null,
        openTarget: { goto: { frame: 12 }, savedPos: { t: 30, d: 100 }, railCarry: { open: true } },
        deps: deps({ savePos: (c, p) => { saved.push([c.fsPath, p.t]); } }),
      });
      viewer.show();
      const cfg = cfgOf(panel.webview.html);
      assert.deepStrictEqual([cfg.goto, cfg.savedPos, cfg.railCarry, cfg.sourceKind], [{ frame: 12 }, { t: 30, d: 100 }, { open: true }, 'file']);
      await open(handlers);
      const st = posts.shift();
      assert.deepStrictEqual([st.goto, st.savedPos], [{ frame: 12 }, { t: 30, d: 100 }]);
      viewer.show();
      assert.strictEqual(cfgOf(panel.webview.html).goto, undefined, 'a reloaded page does not jump again');
      await open(handlers, 2);
      posts.length = 0;
      assert.strictEqual(viewer.goto({ t: 4.5 }), true);
      assert.deepStrictEqual(posts.pop(), { type: 'goto', t: 4.5, page: 2 });
      for (const t of [10, 11, 50, 51]) await handlers.message({ type: 'pos', page: 2, t, d: 60 });
      assert.deepStrictEqual(saved, [[a.fsPath, 10], [a.fsPath, 50]], 'stored when it starts and jumps, not every second');
      handlers.dispose();
      assert.deepStrictEqual(saved.pop(), [a.fsPath, 51], 'and on close');
    }

    { // tileSize: native tiles get their new output size; a tile that must seek to apply it gets 'resize'.
      const { panel, posts, handlers } = fakePanel();
      const clipA = { ...(await prepareClip(a, {})), native: true, decision: nativeDecision };
      const decoders = [];
      const viewer = createUnifiedViewer({ vscode, context, panel, clip: clipA, registry: null,
        deps: deps({ createNative: (opts) => { const d = fakeDecoder(); d.opts = opts; decoders.push(d); return d; } }) });
      viewer.show();
      await open(handlers);
      await handlers.message({ type: 'tileSize', page: 1, tile: { w: 1920, h: 1080, cols: 2, rows: 1 } });
      assert.strictEqual(decoders.length, 0, 'no decoder yet: nothing to resize');
      await handlers.message({ type: 'nd', page: 1, clipId: clipA.id, m: { type: 'open' } });
      assert.strictEqual(decoders[0].opts.messageMaxHeight, 720);
      posts.length = 0;
      await handlers.message({ type: 'tileSize', page: 1, tile: { w: 1920, h: 1080, cols: 2, rows: 1 } });
      assert.deepStrictEqual(decoders[0].resizes, [[540, 540]]);
      assert.deepStrictEqual(posts.splice(0), [{ type: 'resize', clipId: clipA.id, key: clipA.id, tiles: [clipA.id], page: 1 }]);
      await handlers.message({ type: 'tileSize', page: 1, tile: { w: 1920, h: 1080, cols: 2, rows: 1, factor: 4 } });
      assert.deepStrictEqual(decoders[0].resizes.pop(), [1080, 720], 'never above the source; messages capped');
      await handlers.message({ type: 'tileSize', page: 1, clipId: clipA.id, w: 400, h: 400 });
      assert.deepStrictEqual(decoders[0].resizes.pop(), [225, 225], 'a per-tile size is the cell');
      posts.length = 0;
      await handlers.message({ type: 'tileSize', page: 1, clipId: clipA.id, w: 400, h: 400 });
      assert.strictEqual(posts.length, 0, 'the same size: no seek');
      // Pixel tools want the file's own pixels: the built-in decoder, under a new id.
      await handlers.message({ type: 'action', page: 1, id: 'fullRes' });
      const swap = posts.pop();
      assert.deepStrictEqual([swap.type, swap.oldId, swap.clip.native], ['replaceTile', clipA.id, false]);
      assert.strictEqual(decoders[0].disposed, true);
      assert.strictEqual(viewer.decoderOf(clipA.id), null);
      handlers.dispose();
    }

    { // Live transcode: an EncodedStream per clip (when the caller can start one), its settings, and "Use original".
      const rv = recVscode();
      const { panel, posts, handlers } = fakePanel();
      const decision = { ...nativeDecision, stream: { encoder: 'h264_nvenc', remote: false } };
      const clipA = await prepareClip(a, { nativeFor: async () => decision, streams: true });
      assert.deepStrictEqual([clipA.native, clipA.transcode, clipA.decision === decision], [true, true, true]);
      const created = [];
      const prefs = [];
      const viewer = createUnifiedViewer({ vscode: rv.api, context, panel, clip: clipA, registry: null, deps: deps({
        createStream: (c, opts) => { const s = fakeDecoder(); created.push({ c, opts, s }); return s; },
        transcodePrefs: () => ({ transcodeMaxBitrate: 0 }),
        setTranscodePref: (m) => { prefs.push(m); },
      }) });
      viewer.show();
      assert.strictEqual(cfgOf(panel.webview.html).clips[0].native, true);
      await open(handlers);
      posts.length = 0;
      panel.visible = false;
      await handlers.message({ type: 'nd', page: 1, clipId: clipA.id, m: { type: 'open' } });
      const { opts, s } = created[0];
      assert.deepStrictEqual([opts.decision, opts.maxHeight, opts.hidden, created[0].c.id], [decision, 1080, true, clipA.id]);
      assert.ok(opts.maxKbps > 0, 'a bitrate cap');
      assert.deepStrictEqual(s.hidden, [true], 'a hidden panel: the stream waits');
      assert.deepStrictEqual(s.handled, [{ type: 'open' }]);
      panel.visible = true;
      opts.post({ type: 'packet', n: 1 });
      opts.post({ type: 'remoteNotice', text: 'slow link' });
      assert.deepStrictEqual(posts.splice(0).map((m) => [m.type, m.clipId, m.m && m.m.n, m.text]),
        [['nd', clipA.id, 1, undefined], ['toast', undefined, undefined, 'slow link']]);
      await handlers.message({ type: 'transcodeResolution', page: 1, clipId: clipA.id, height: 720 });
      await handlers.message({ type: 'transcodePref', page: 1, maxBitrateMbps: 8 });
      assert.deepStrictEqual([s.resolution, s.bitrate, prefs.length], [[720], [8], 1]);
      handlers.view();
      assert.deepStrictEqual(s.hidden, [true, false]);
      await handlers.message({ type: 'tileSize', page: 1, tile: { w: 1280, h: 720 } });
      await handlers.message({ type: 'tileSize', page: 1, tile: { w: 2560, h: 1440 } });
      assert.deepStrictEqual(s.outputs.map((o) => o[0]), [720, 1080]);
      assert.strictEqual(posts.filter((m) => m.type === 'resize').length, 1, 'a grown stream: one seek');
      posts.length = 0;
      // ⚙ › "Use original video" (originalTile): the built-in decoder in the tile's place.
      await handlers.message({ type: 'originalTile', page: 1, clipId: clipA.id });
      assert.strictEqual(s.disposed, true);
      const swap = posts.pop();
      assert.deepStrictEqual([swap.type, swap.oldId, swap.clip.native], ['replaceTile', clipA.id, false]);
      opts.post({ type: 'packet', n: 2 });
      opts.onFail(new Error('late'));
      assert.strictEqual(posts.length, 0, 'the old stream is not heard any more');
      handlers.dispose();
    }

    { // A failing stream falls back with a notice; Live transcode off ends the others; 'always' asks again.
      const { panel, posts, handlers } = fakePanel();
      const decision = { ...nativeDecision, stream: { encoder: 'libx264' } };
      let streaming = true;
      const nativeFor = async () => (streaming ? decision : null);
      const clipA = await prepareClip(a, { nativeFor, streams: true });
      const created = [];
      const viewer = createUnifiedViewer({ vscode, context, panel, clip: clipA, registry: null, deps: deps({
        nativeFor, createStream: (c, opts) => { const s = fakeDecoder(); created.push({ c, opts, s }); return s; },
        grabExactFrame: async () => ({ cancelled: true }),
      }) });
      viewer.show();
      await open(handlers);
      await handlers.message({ type: 'nd', page: 1, clipId: clipA.id, m: { type: 'open' } });
      posts.length = 0;
      await handlers.message({ type: 'grabExactFrame', page: 1, reqId: 3, t: 1 });
      assert.strictEqual(posts.length, 0, 'a superseded grab answers nothing');
      created[0].opts.onFail(new Error('encoder died'));
      assert.deepStrictEqual(posts.splice(0).map((m) => m.type === 'toast' ? m.text : m.type),
        ['replaceTile', 'Live transcode failed. Using the original video.']);
      const builtInId = viewer.session.clips[0].id;
      // Always: asked again; it streams now, so it reloads in place under a new id.
      await handlers.message({ type: 'transcodePref', page: 1, mode: 'always' });
      const back = posts.pop();
      assert.deepStrictEqual([back.type, back.oldId, back.reload, back.clip.native], ['replaceTile', builtInId, true, true]);
      await handlers.message({ type: 'nd', page: 1, clipId: back.newId, m: { type: 'open' } });
      assert.strictEqual(created.length, 2);
      await handlers.message({ type: 'transcodePref', page: 1, mode: 'off' });
      assert.strictEqual(created[1].s.disposed, true);
      assert.strictEqual(posts.pop().clip.native, false);
      streaming = false;
      handlers.dispose();
    }

    { // File changed on disk: the clip is prepared again and reloads in its tile (new id, same webview, same place).
      const { panel, posts, handlers } = fakePanel();
      const c = write('c.mp4', [1, 2, 3]);
      const clipC = await prepareClip(c, {});
      const watched = [];
      const viewer = createUnifiedViewer({ vscode, context, panel, clip: clipC, registry: null, deps: deps({
        watchDelayMs: 0,
        watchFile: (file, onChange) => { const w = { file, onChange, closed: false, close() { w.closed = true; } }; watched.push(w); return w; },
        findSidecars: async () => [],
        loadSubtitles: async () => [{ id: 'x.srt', name: 'x.srt', data: new Uint8Array(1) }],
      }) });
      viewer.show();
      await open(handlers);
      await settle();
      assert.deepStrictEqual(watched.map((w) => w.file), [c.fsPath]);
      await handlers.message({ type: 'loadSubs', page: 1 });
      await handlers.message({ type: 'pos', page: 1, t: 1.5, d: 3 });
      posts.length = 0;
      const html = panel.webview.html;
      watched[0].onChange();
      await settle();
      assert.strictEqual(posts.length, 0, 'the same mtime: no reload');
      fs.writeFileSync(c.fsPath, Buffer.from([1, 2, 3, 4, 5]));
      const later = new Date(Date.now() + 60000);
      fs.utimesSync(c.fsPath, later, later);
      watched[0].onChange();
      await settle();
      const r = posts.find((m) => m.type === 'replaceTile');
      assert.ok(r, 'reloaded');
      assert.deepStrictEqual([r.oldId, r.reload, r.clip.size, r.clip.savedPos], [clipC.id, true, 5, { t: 1.5, d: 3 }]);
      assert.notStrictEqual(r.newId, clipC.id);
      assert.strictEqual(panel.webview.html, html, 'no new page');
      assert.deepStrictEqual(viewer.session.order, [r.newId]);
      assert.strictEqual(watched[0].closed, true);
      assert.deepStrictEqual(watched.slice(1).map((w) => [w.file, w.closed]), [[c.fsPath, false]]);
      assert.ok(posts.some((m) => m.type === 'subs' && m.clipId === r.newId && m.restore), 'loaded subtitles come back');
      await handlers.message({ type: 'readBlock', page: 1, clipId: r.newId, pos: 0, len: 16 });
      assert.deepStrictEqual([...posts.pop().data], [1, 2, 3, 4, 5]);
      handlers.dispose();
      assert.strictEqual(watched[1].closed, true);
    }

    { // Offers and settings: actions, whenSlow, notices, ffmpeg state, external player, Open URL, rail handoff.
      const rv = recVscode();
      const { panel, posts, handlers } = fakePanel();
      const clipA = await prepareClip(a, {});
      const calls = [];
      const viewer = createUnifiedViewer({ vscode: rv.api, context, panel, clip: clipA, registry: null, deps: deps({
        setupFfmpeg: async () => { calls.push('setupFfmpeg'); },
        setSetting: (k, v) => { calls.push([k, v]); },
        hiddenNotices: () => ['hideReducedResNotice', 'bogus'],
        ffmpegState: async () => ({ installed: false, offer: true, mb: 30 }),
        external: (c) => { calls.push(['external', c.id]); },
        openUrl: () => { calls.push('openUrl'); },
        onAction: (id) => { calls.push(['action', id]); },
        adoptMs: 30,
      }) });
      viewer.show();
      await open(handlers);
      await settle();
      assert.deepStrictEqual(posts.filter((m) => m.type !== 'sessionState').map((m) => [m.type, m.offer]),
        [['hideReducedResNotice', undefined], ['ffmpegState', true]]);
      posts.length = 0;
      for (const id of ['setupFfmpeg', 'transcodeSettings', 'nativeResolutionSettings', 'whenSlowSettings', 'useOriginalVideo']) {
        await handlers.message({ type: 'action', page: 1, id });
      }
      await handlers.message({ type: 'whenSlow', page: 1, value: 'skip' });
      await handlers.message({ type: 'whenSlow', page: 1, value: 'sometimes' });
      await handlers.message({ type: 'action', page: 1, id: 'hideSlowPlaybackNotice' });
      await handlers.message({ type: 'external', page: 1 });
      await handlers.message({ type: 'openUrl', page: 1 });
      assert.deepStrictEqual(calls, ['setupFfmpeg', ['action', 'useOriginalVideo'], ['whenSlow', 'skip'], ['external', clipA.id], 'openUrl']);
      assert.deepStrictEqual(rv.commands.map((c) => c[1]), ['@id:videoPreviewEnhanced.transcode',
        '@id:videoPreviewEnhanced.nativeMaxHeight', '@id:videoPreviewEnhanced.whenSlow']);
      assert.deepStrictEqual(posts.splice(0).map((m) => m.type), ['hideSlowPlaybackNotice'], 'no hideNotice dep: this page');
      // The folder rail moves to the tab that opens the next video.
      const adopted = viewer.railHandoff({ rail: { onEnd: 'next' }, fromAutoNext: true });
      const h = posts.pop();
      assert.deepStrictEqual([h.type, h.onEnd, h.fromAutoNext], ['railHandoff', 'next', true]);
      await handlers.message({ type: 'railAdopted', page: 1, id: h.id, ok: true });
      assert.strictEqual(await adopted, true);
      const timedOut = viewer.railHandoff({ rail: {} });
      assert.strictEqual(await timedOut, false);
      assert.strictEqual(posts.pop().type, 'railHandoffCancel');
      handlers.dispose();
    }

    { // URL and image-sequence clips: no file, no folder; their decoders come from the caller; HLS quality.
      const { panel, posts, handlers } = fakePanel();
      const urlClip = sourceClip('url', 'https://media.example/secret/a.m3u8', { label: 'a.m3u8', duration: 9 });
      assert.ok(/^u[0-9a-f]{16}$/.test(urlClip.id));
      const ios = [];
      let dec = null;
      const calls = [];
      const viewer = createUnifiedViewer({ vscode, context, panel, clip: urlClip, registry: null, deps: deps({
        rail: { cache: null, probe: null, prefs: { get: () => ({}), set: () => {} }, layout: () => 'side', caseless: false },
        openUrlStream: (c, io) => { ios.push(io); dec = fakeDecoder(); return dec; },
        copyLink: () => { calls.push('copyLink'); return 'never'; },
        external: (c) => { calls.push(['external', c.id]); },
        findSidecars: async () => { calls.push('sidecars'); return []; },
      }) });
      viewer.show();
      const html = panel.webview.html;
      assert.ok(!html.includes('media.example'), 'the URL stays on the host');
      const cfg = cfgOf(html);
      assert.deepStrictEqual([cfg.sourceKind, cfg.clips[0].sourceKind, cfg.clips[0].native, cfg.rail], ['url', 'url', true, null]);
      assert.strictEqual(panel.title, 'a.m3u8');
      await open(handlers);
      await settle();
      assert.strictEqual(posts.shift().sourceKind, 'url');
      posts.length = 0;
      await handlers.message({ type: 'readBlock', page: 1, clipId: urlClip.id, pos: 0, len: 4 });
      assert.strictEqual(posts.length, 0, 'no blocks for a URL');
      await handlers.message({ type: 'nd', page: 1, clipId: urlClip.id, m: { type: 'open' } });
      assert.deepStrictEqual(dec.handled, [{ type: 'open' }]);
      ios[0].post({ type: 'meta', n: 1 });
      assert.deepStrictEqual([posts[0].type, posts[0].clipId, posts[0].m.n], ['nd', urlClip.id, 1]);
      posts.length = 0;
      for (const pick of ['auto', 2, 'x', -1]) await handlers.message({ type: 'quality', page: 1, pick });
      assert.deepStrictEqual(dec.quality, ['auto', 2]);
      await handlers.message({ type: 'copyLink', page: 1, frame: 3 });
      assert.deepStrictEqual(posts.pop().text, 'Frame links work for video files only, not URLs');
      await handlers.message({ type: 'external', page: 1 });
      await handlers.message({ type: 'rail', page: 1, op: 'list' });
      assert.deepStrictEqual(calls, [['external', urlClip.id]], 'no sidecars, no link, no rail for a URL');
      ios[0].onFail(new Error('404'));
      assert.strictEqual(dec.disposed, true);
      assert.strictEqual(posts.pop().text, 'a.m3u8 cannot be played.');
      handlers.dispose();

      const seq = fakePanel();
      const seqClip = sourceClip('sequence', '/frames/img_%04d.png', { label: 'img_####.png' });
      let opened = 0;
      createUnifiedViewer({ vscode, context, panel: seq.panel, clip: seqClip, registry: null, deps: deps({
        openSequence: () => { opened++; return fakeDecoder(); },
      }) }).show();
      assert.strictEqual(cfgOf(seq.panel.webview.html).sourceKind, 'sequence');
      await open(seq.handlers);
      seq.posts.length = 0;
      await seq.handlers.message({ type: 'nd', page: 1, m: { type: 'open' } });
      assert.strictEqual(opened, 1);
      await seq.handlers.message({ type: 'copyLink', page: 1, frame: 1 });
      assert.strictEqual(seq.posts.pop().text, 'Links work for video files only');
      seq.handlers.dispose();
    }
  } finally {
    await tick(); // the file handles close
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log('unified_viewer_test OK');
})().catch((e) => { console.error(e); process.exit(1); });
