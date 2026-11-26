'use strict';
// The unified viewer's host (docs/notes/player-ui-controller.md, "Production wiring"): one webview panel that shows
// one video and grows to N and back in place. It gives src/unified-session.js (the pure coordinator) its effects:
// the page (src/unified-html.js with media/player-unified.js), each clip's file blocks, native ffmpeg decoder and
// seek-bar thumbnails by clip id, the open dialogs, the folder rail and the shared playback preferences.
//
// Opt-in (the setting unifiedViewer, off by default): src/extension.js routes a video file here only when it is on.
// The shipped player (src/extension.js Session, media/player.js) and Compare (src/compare.js) stay the default and
// keep what this lane does not have yet; the design note lists it.
//
// The vscode API and everything it reads from extension.js are injected, so a Node test drives it with a fake panel
// (test/host/unified_viewer_test.js).
const nodeFs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createUnifiedSession, clipDescriptor } = require('./unified-session');
const { UNIFIED_CSS, UNIFIED_SCRIPTS } = require('./unified-html');
const { inlineAssetsFor } = require('./player-html');
const { serveBlock, readFileBlock } = require('./read-block');
const { NativeDecoder } = require('./native');
const { nativeThumb } = require('./thumbhost');
const Grid = require('../media/compare-grid');
const folderRail = require('./folder-rail');

// checkJs: start
const MAX_BLOCK = 8 * 1024 * 1024;
/** The page's boot script (media/), loaded after UNIFIED_SCRIPTS. */
const ENTRY_SCRIPT = 'player-unified.js';
/** Schemes whose fsPath is the real file for this (workspace) extension host: local, WSL, Remote-SSH. */
const FS_SCHEMES = new Set(['file', 'vscode-remote']);
const ORIGIN = /^vscode-webview:\/\/[a-z0-9-]+$/;

/**
 * @typedef {import('./unified-session').UnifiedSession} UnifiedSession
 * @typedef {{ scheme: string, fsPath: string, authority?: string, with(change: any): any, toString(): string }} UriLike
 * @typedef {object} ViewerClip a clip of this lane: a file on disk, with what the host decided for it
 * @property {string} id
 * @property {UriLike} uri
 * @property {string} fsPath
 * @property {string} label
 * @property {number} size
 * @property {number} rotation
 * @property {boolean} native  native ffmpeg decodes it on the host
 * @property {any} decision    extension.js nativeFor()'s answer when `native` (tools, method, probed ...), else null
 * @property {number} [width]
 * @property {number} [height]
 * @property {number} [fps]
 * @property {number} [duration]
 */

/** A video the unified viewer can show: a file on a real file system (not a URL, a virtual file or a sequence). @param {any} uri */
const isViewable = (uri) => !!uri && FS_SCHEMES.has(uri.scheme);

/** The file a uri names, without query or fragment. @param {UriLike} uri */
const fileKey = (uri) => uri.with({ query: '', fragment: '' }).toString();

/**
 * A clip's id on the page: stable for the file, and no part of its path (the page never learns where a file is).
 * @param {UriLike} uri @param {string} [suffix]
 */
const clipIdOf = (uri, suffix = '') => `c${crypto.createHash('sha1').update(fileKey(uri)).digest('hex').slice(0, 16)}${suffix}`;

/** @param {unknown} v */
const positive = (v) => (Number.isFinite(v) && /** @type {number} */ (v) > 0 ? /** @type {number} */ (v) : undefined);

/**
 * Everything the host must know about a file before the page may open it: its size, rotation and whether native
 * ffmpeg decodes it (the same decision Compare asks for a tile). Live transcode streams stay with the shipped
 * player and Compare: here such a file plays through the built-in decoder.
 * @param {UriLike} uri
 * @param {{ fs?: { stat(p: string): Promise<{ size: number }> }, rotationOf?: (file: string) => Promise<number>,
 *   nativeFor?: ((file: string, transport: string, tile: any) => Promise<any>) | null, transport?: () => string,
 *   log?: (m: string) => void }} deps
 * @returns {Promise<ViewerClip>}
 */
async function prepareClip(uri, deps) {
  const file = uri.fsPath;
  const fs = deps.fs || nodeFs.promises;
  const [st, rotation] = await Promise.all([
    fs.stat(file),
    deps.rotationOf ? deps.rotationOf(file).catch(() => 0) : 0,
  ]);
  let decision = null;
  if (deps.nativeFor) {
    try { decision = await deps.nativeFor(file, deps.transport ? deps.transport() : 'message', null); }
    catch (e) { if (deps.log) deps.log(`native check failed for ${path.basename(file)}: ${e && /** @type {any} */ (e).message || e}`); }
  }
  const native = !!(decision && decision.tools && !decision.stream);
  const video = (decision && decision.probed && decision.probed.video) || {};
  return {
    id: clipIdOf(uri), uri, fsPath: file, label: path.basename(file), size: st.size, rotation: Number(rotation) || 0,
    native, decision: native ? decision : null,
    width: positive(video.width), height: positive(video.height), fps: positive(video.fps),
    duration: positive(decision && decision.probed && decision.probed.duration),
  };
}

/**
 * @param {object} o
 * @param {any} o.vscode
 * @param {{ extensionUri: any }} o.context
 * @param {any} o.panel  the WebviewPanel (a custom editor's, or one made for this viewer)
 * @param {ViewerClip} o.clip  the first video (prepareClip)
 * @param {{ add(s: UnifiedSession): () => void } | null} [o.registry]  createUnifiedRegistry(): capture routing
 * @param {object} o.deps  what src/extension.js shares with the shipped player and Compare
 * @param {(m: string) => void} o.deps.log
 * @param {(webview: any) => any} o.deps.engineCfg  the page's decoder config (as Compare's)
 * @param {() => { dir: any, loader: string }} o.deps.libavBuild
 * @param {() => any} o.deps.prefs
 * @param {() => number} [o.deps.maxVideos]
 * @param {((file: string, transport: string, tile: any) => Promise<any>) | null} [o.deps.nativeFor]
 * @param {() => string} [o.deps.nativeTransport]
 * @param {() => number} [o.deps.nativeQueue]
 * @param {number} [o.deps.framePort]  the localhost frame server's port (the CSP names it), local windows only
 * @param {(file: string) => Promise<number>} [o.deps.rotationOf]
 * @param {(label: string, defaultUri: any, many: boolean) => Promise<any[] | undefined>} [o.deps.pick]
 * @param {(m: any, from: any) => any} [o.deps.setPlaybackPrefs]
 * @param {(what: 'toggle' | 'exited') => any} [o.deps.focusMode]
 * @param {{ cache: any, probe: any, prefs: { get(): any, set(v: any): any }, layout: () => string, caseless: boolean } | null} [o.deps.rail]
 * @param {boolean} [o.deps.debug]
 * @param {boolean} [o.deps.remote]  a remote window: the page's small scripts are inlined
 */
function createUnifiedViewer({ vscode, context, panel, clip, registry, deps }) {
  const media = vscode.Uri.joinPath(context.extensionUri, 'media');
  const webview = panel.webview;
  webview.options = { enableScripts: true, localResourceRoots: [media] };
  let page = 0;
  let disposed = false;
  /** @type {string | null} the page's origin, for the frame server (null: frames go over messages) */
  let origin = null;
  /** @type {Map<string, Promise<{ fh: any, size: number }>>} one open file per clip */
  const files = new Map();
  /** @type {Map<string, any>} clip id -> NativeDecoder */
  const natives = new Map();
  /** @type {{ id: any, clipId: string, controller: AbortController } | null} */
  let thumbJob = null;
  /** @type {ReturnType<typeof folderRail.createFolderRail> | null} */
  let rail = null;
  let railOpen = false;
  /** @type {string | null} */
  let railBrowse = null;
  /** @type {UnifiedSession} set below; the helpers before it run only once it exists */
  let session = /** @type {any} */ (null);
  /** @param {string} m */
  const log = (m) => deps.log(`[unified ${session ? session.title : clip.label}] ${m}`);
  const prepDeps = () => ({
    rotationOf: deps.rotationOf, nativeFor: deps.nativeFor || null, transport: deps.nativeTransport, log,
  });
  /** @param {string} id @returns {ViewerClip | null} */
  const clipOf = (id) => /** @type {any} */ (session.clipOf(id));

  // ---- the page ----
  /** @param {UnifiedSession} s */
  function renderHtml(s) {
    const uri = (/** @type {string[]} */ ...p) => webview.asWebviewUri(vscode.Uri.joinPath(media, ...p)).toString();
    const build = deps.libavBuild();
    const ec = deps.engineCfg(webview);
    const first = /** @type {ViewerClip | undefined} */ (/** @type {any} */ (s.clips[0]));
    const cfg = {
      page: ++page, surface: 'unified', debug: !!deps.debug, engine: ec,
      clips: s.clips.map((c) => ({ ...clipDescriptor(c), id: c.id })), tiles: s.order,
      prefs: deps.prefs(),
      rail: deps.rail && first ? { ...folderRail.sanitizeRailPrefs(deps.rail.prefs.get()), layout: deps.rail.layout() } : null,
    };
    const scriptFiles = [...UNIFIED_SCRIPTS, ENTRY_SCRIPT];
    const { inlineCss, inlineScripts } = inlineAssetsFor(media.fsPath, {
      cssFiles: UNIFIED_CSS, scriptFiles, inlineScripts: !!deps.remote,
    });
    return {
      cspSource: webview.cspSource, uri, base: webview.asWebviewUri(build.dir).toString(), loader: build.loader,
      nonce: crypto.randomBytes(16).toString('base64'), cfg,
      framePort: deps.framePort, transport: deps.nativeTransport ? deps.nativeTransport() : 'message', debug: !!deps.debug,
      canCompare: true, compareOpen: false, folder: !!deps.rail, inlineCss, inlineScripts,
    };
  }

  // ---- file blocks, by clip id ----
  /** One open per file, even when reads race; the size is taken at open. @param {ViewerClip} c */
  function blockFile(c) {
    let p = files.get(c.id);
    if (!p) {
      p = nodeFs.promises.open(c.fsPath, 'r').then(async (fh) => {
        try { return { fh, size: (await fh.stat()).size }; } catch (e) { fh.close().catch(() => {}); throw e; }
      });
      const opened = p;
      opened.catch(() => { if (files.get(c.id) === opened) files.delete(c.id); });
      files.set(c.id, p);
    }
    return p;
  }
  /** @param {string} id */
  function closeFile(id) {
    const p = files.get(id);
    files.delete(id);
    if (p) p.then((h) => h.fh.close(), () => {}).catch(() => {});
  }
  /** @param {ViewerClip} c @param {any} m */
  function readBlock(c, m) {
    const at = page;
    // A reply for a clip the panel dropped, or for the page before a reload, is not sent.
    const isCurrent = () => !disposed && at === page && !!session.clipOf(c.id);
    return serveBlock({ type: 'readBlock', page: m.page, pos: m.pos, len: m.len }, isCurrent, async (pos, len) => {
      try {
        const { fh, size } = await blockFile(c);
        if (!isCurrent()) return undefined;
        return await readFileBlock(fh, size, pos, len, MAX_BLOCK);
      } catch (e) {
        log(`${c.label}: read failed: ${e && /** @type {any} */ (e).message || e}`);
        // Always answer (empty on error), or the decoder keeps the block in flight forever.
        return new Uint8Array(0);
      }
    }, (reply) => session.post(/** @type {any} */ ({ ...reply, key: c.id, clipId: c.id })));
  }

  // ---- native ffmpeg, by clip id ----
  /** @param {ViewerClip} c */
  function startNative(c) {
    const d = c.decision;
    const transport = origin && deps.nativeTransport ? deps.nativeTransport() : 'message';
    const n = Math.max(1, session.clips.length);
    log(`${c.label}: native ffmpeg (${d.method}) at up to ${d.maxHeight}p: ${d.reason}`);
    const decoder = new NativeDecoder({
      tools: d.tools, file: c.fsPath, maxHeight: d.maxHeight, messageMaxHeight: Math.min(d.maxHeight, d.messageMaxHeight),
      method: d.method, methodGuessed: !!d.methodGuessed, probed: d.probed, transport, origin,
      maxQueued: Grid.nativeQueuePerTile(deps.nativeQueue ? deps.nativeQueue() : 8, n), largeGrid: Grid.isLarge(n),
      post: (/** @type {any} */ msg) => { if (natives.get(c.id) === decoder) session.postNativeReply(c.id, msg); },
      postRaw: (/** @type {any} */ msg) => { if (natives.get(c.id) === decoder) session.post({ ...msg, key: c.id, clipId: c.id }); },
      log: (/** @type {string} */ msg) => log(`${c.label}: ${msg}`),
      onFail: (/** @type {any} */ err) => {
        if (disposed || natives.get(c.id) !== decoder) return;
        log(`${c.label}: native ffmpeg failed (${err && err.message || err}); built-in decoder from now on`);
        // The same file in the tile's place, decoded in the page: a new clip id, so the page starts a new decoder.
        session.replaceClip(c.id, /** @type {any} */ ({ ...c, id: clipIdOf(c.uri, 'b'), native: false, decision: null }));
      },
    });
    natives.set(c.id, decoder);
    return decoder;
  }
  /** @param {string} id */
  function closeNative(id) {
    const n = natives.get(id);
    natives.delete(id);
    if (n) n.dispose();
  }
  /** @param {ViewerClip} c @param {any} m */
  function onNative(c, m) {
    if (!m.m || (m.m.type === 'seek' && !(Number.isFinite(m.m.t) && m.m.t >= 0))) return undefined;
    const decoder = natives.get(c.id) || (c.native && c.decision ? startNative(c) : null);
    return decoder ? decoder.handle(m.m) : undefined;
  }
  /** A native clip's seek-bar thumbnail; one at a time. @param {ViewerClip} c @param {any} m */
  async function onThumb(c, m) {
    if (m.cancel) {
      if (thumbJob && thumbJob.clipId === c.id && thumbJob.id === m.id) thumbJob.controller.abort();
      return;
    }
    if (thumbJob) thumbJob.controller.abort();
    const job = { id: m.id, clipId: c.id, controller: new AbortController() };
    thumbJob = job;
    const decoder = natives.get(c.id);
    let result = null;
    try {
      if (decoder && panel.visible !== false) result = await nativeThumb(decoder, m, log, job.controller.signal);
    } catch (e) {
      log(`thumbnail: ${e && /** @type {any} */ (e).message || e}`);
    } finally {
      if (thumbJob === job) {
        thumbJob = null;
        if (!job.controller.signal.aborted) session.post({ type: 'thumb', key: c.id, clipId: c.id, id: m.id, .../** @type {any} */ (result) });
      }
    }
  }

  // ---- adding and replacing videos ----
  /** @param {any[] | undefined} picked @returns {Promise<ViewerClip[]>} */
  async function prepareAll(picked) {
    const uris = (picked || []).filter(isViewable);
    /** @type {ViewerClip[]} */
    const out = [];
    for (const u of uris) {
      try { out.push(await prepareClip(u, prepDeps())); }
      catch (e) { log(`cannot open ${path.basename(u.fsPath)}: ${e && /** @type {any} */ (e).message || e}`); }
    }
    return out;
  }
  const firstDir = () => { const c = session.clips[0]; return c && c.uri ? vscode.Uri.joinPath(c.uri, '..') : undefined; };
  /** A file of the clips' file system as a uri with their scheme and authority (remote windows too). @param {string} p */
  const uriOf = (p) => /** @type {UriLike} */ (clip.uri).with({ path: vscode.Uri.file(p).path, fragment: '', query: '' });
  /**
   * Adds a file to this panel (the page shows it beside the others). False: not added (a duplicate or a full panel
   * says so in the page).
   * @param {UriLike} uri
   */
  async function addUri(uri) {
    if (disposed || !isViewable(uri)) return false;
    const c = await prepareClip(uri, prepDeps());
    return !disposed && session.addClip(c);
  }
  /** One video shown: `file` plays in its place. Several: it joins them. @param {string} file */
  async function showFile(file) {
    const uri = uriOf(file);
    const only = session.clips.length === 1 ? session.clips[0] : null;
    if (!only) return addUri(uri);
    if (fileKey(uri) === fileKey(/** @type {any} */ (only.uri))) return false;
    const c = await prepareClip(uri, prepDeps());
    return !disposed && session.replaceClip(only.id, c);
  }

  // ---- the folder rail ----
  function railCtl() {
    if (rail || disposed || !deps.rail) return rail;
    rail = folderRail.createFolderRail({
      fs: nodeFs.promises, post: (m) => session.post(m), cache: deps.rail.cache, probe: deps.rail.probe,
      authority: clip.uri.authority || '', caseless: !!deps.rail.caseless, log,
      members: () => session.members(),
      current: () => { const c = session.clips; return c.length === 1 ? c[0].fsPath || null : null; },
    });
    session.setRail(rail);
    return rail;
  }
  /** The single video's place in its folder, for the bar's capsule and the rail's footer. */
  async function sendRailPos() {
    const c = session.clips;
    if (!deps.rail || c.length !== 1 || !c[0].fsPath) return;
    const at = await folderRail.neighbourOf(nodeFs.promises, c[0].fsPath, 0);
    if (!disposed) session.post({ type: 'rail', op: 'pos', index: at.index, count: at.count });
  }
  /** @param {any} m */
  async function onRailMessage(m) {
    if (m.type === 'neighbour') {
      const c = session.clips;
      if (c.length !== 1 || !c[0].fsPath || (m.d !== 1 && m.d !== -1)) return undefined;
      const at = await folderRail.neighbourOf(nodeFs.promises, c[0].fsPath, m.d);
      if (disposed) return undefined;
      if (!at.target) { session.post({ type: 'toast', text: m.d > 0 ? 'Last video in this folder' : 'First video in this folder' }); return undefined; }
      await showFile(at.target);
      return sendRailPos();
    }
    const ctl = railCtl();
    if (!ctl || !deps.rail) return undefined;
    return folderRail.routeRailMessage({
      ctl, prefs: deps.rail.prefs,
      startDir: () => railBrowse || ctl.dir() || path.dirname(clip.fsPath),
      setOpen: (open) => { railOpen = open; },
      setBrowse: (dir) => { railBrowse = dir; },
      // A row plays in the single video's place (or joins a comparison); its Compare button always joins.
      onVideo: async (e) => { await showFile(e.path); return sendRailPos(); },
      onCompareVideo: (e) => addUri(uriOf(e.path)),
    }, m);
  }

  session = createUnifiedSession({
    panel, initialClip: clip, maxVideos: deps.maxVideos ? deps.maxVideos() : undefined, renderHtml,
    onPost: (m) => { if (!disposed) webview.postMessage({ ...m, page }); },
    onPickVideo: async () => prepareAll(deps.pick ? await deps.pick(`Add to ${session.title}`, firstDir(), true) : undefined),
    onReplacePick: async (oldId) => {
      const old = clipOf(oldId);
      const picked = deps.pick ? await deps.pick(`Replace ${old ? old.label : 'video'}`, firstDir(), false) : undefined;
      return (await prepareAll(picked && picked.slice(0, 1)))[0];
    },
    onReadBlock: (c, m) => readBlock(/** @type {any} */ (c), m),
    onThumb: (c, m) => onThumb(/** @type {any} */ (c), m),
    onNative: (c, m) => onNative(/** @type {any} */ (c), m),
    onCopyText: (text) => vscode.env.clipboard.writeText(text),
    onOpenSettings: () => vscode.commands.executeCommand('workbench.action.openSettings', '@ext:gordon-vidal.video-preview-enhanced'),
    onFocusMode: (what) => (deps.focusMode ? deps.focusMode(what) : undefined),
    onPlaybackPrefs: (m) => (deps.setPlaybackPrefs ? deps.setPlaybackPrefs(m, viewer) : undefined),
    onRailMessage,
  });
  // A clip the panel no longer shows: its file and its ffmpeg close.
  session.onChange((e) => {
    if (e !== 'clips') return;
    const shown = new Set(session.clips.map((c) => c.id));
    for (const id of [...files.keys()]) if (!shown.has(id)) closeFile(id);
    for (const id of [...natives.keys()]) if (!shown.has(id)) closeNative(id);
  });
  const unregister = registry ? registry.add(session) : () => {};

  /** A message from the page. @param {any} m */
  function receive(m) {
    if (disposed || !m || typeof m !== 'object' || m.page !== page) return undefined;
    if (m.type === 'ready') {
      // A new document (VS Code can recreate one from the same HTML): its decoders start over.
      origin = typeof m.origin === 'string' && ORIGIN.test(m.origin) ? m.origin : null;
      for (const id of [...natives.keys()]) closeNative(id);
    }
    if (m.type === 'log') { log(`webview: ${m.msg}`); return undefined; }
    const done = Promise.resolve(session.onMessage(m)).catch((e) => {
      log(`${m.type} failed: ${e && e.stack || e}`);
      if (!disposed) session.post({ type: 'toast', text: `Video Preview action failed. ${e && e.message || e}` });
    });
    if (m.type === 'ready') sendRailPos().catch((e) => log(`folder: ${e && e.code || e}`));
    return done;
  }
  webview.onDidReceiveMessage(receive);

  function dispose() {
    if (disposed) return;
    disposed = true;
    if (thumbJob) thumbJob.controller.abort();
    if (rail) { rail.dispose(); rail = null; }
    for (const id of [...natives.keys()]) closeNative(id);
    for (const id of [...files.keys()]) closeFile(id);
    unregister();
    session.dispose();
    if (viewer.onDispose) viewer.onDispose();
    log('closed');
  }
  panel.onDidDispose(dispose);
  panel.onDidChangeViewState(() => {
    if (disposed) return;
    session.setActive(!!panel.active);
    if (rail) { if (!panel.visible) rail.cancel(); else if (railOpen) rail.resume(); }
    if (!panel.visible && thumbJob) thumbJob.controller.abort();
    session.post({ type: 'setVisible', visible: !!panel.visible, active: !!panel.active });
  });
  session.setActive(!!panel.active);

  const viewer = {
    session, panel, addUri, receive, dispose,
    /** Host -> page, for the broadcasts every open page gets (playback prefs, Zen Mode, live settings). @param {any} m */
    post: (m) => session.post(m),
    /** @type {(() => void) | null} */
    onDispose: null,
    get disposed() { return disposed; },
    /** Sets the page (the caller awaits what the page config needs first). */
    show() { if (!disposed) session.render(); log(`opened, ${clip.size} bytes${clip.native ? ', native ffmpeg' : ''}`); },
  };
  return viewer;
}
// checkJs: end

module.exports = { createUnifiedViewer, prepareClip, isViewable, clipIdOf, ENTRY_SCRIPT };
