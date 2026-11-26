'use strict';
// The unified viewer's host (docs/notes/player-ui-controller.md, "Production wiring"): one webview panel that shows
// one video and grows to N and back in place. It gives src/unified-session.js (the pure coordinator) its effects:
// the page (src/unified-html.js with media/player-unified.js), each clip's file blocks, native ffmpeg decoder, Live
// transcode stream and seek-bar thumbnails by clip id, subtitles, frame export and links, the resume position, the
// file watcher, the open dialogs, the folder rail and the shared playback preferences.
//
// It is the extension's only viewer: src/extension.js opens every video here (a file, a URL, an image sequence, a
// frame link, Compare's commands), one panel per tab.
//
// The vscode API and everything it reads from extension.js are injected (o.deps), so a Node test drives it with a
// fake panel (test/host/unified_viewer_test.js). Every dep beyond the first few is optional: without it the feature
// is off (no sidecar search, no resume saving ...), never an error.
const nodeFs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createUnifiedSession, clipDescriptor, sourceKindOf } = require('./unified-session');
const { UNIFIED_CSS, UNIFIED_SCRIPTS } = require('./unified-html');
const { inlineAssetsFor } = require('./page-assets');
const { serveBlock, readFileBlock } = require('./read-block');
const { NativeDecoder } = require('./native');
const thumbhost = require('./thumbhost'); // through the module: a test can stand in for nativeThumb
const { compareCapsKbps, compareTileSize, resolutionOf } = require('./transcode_policy');
const Grid = require('../media/compare-grid');
const folderRail = require('./folder-rail');

// checkJs: start
const MAX_BLOCK = 8 * 1024 * 1024;
/** The page's boot script (media/), loaded after UNIFIED_SCRIPTS. */
const ENTRY_SCRIPT = 'player-unified.js';
/** Schemes whose fsPath is the real file for this (workspace) extension host: local, WSL, Remote-SSH. */
const FS_SCHEMES = new Set(['file', 'vscode-remote']);
const ORIGIN = /^vscode-webview:\/\/[a-z0-9-]+$/;
/** A file rewritten on disk (render or capture loops) settles this long before its clip reloads. */
const WATCH_DELAY_MS = 800;
/** An A-B export frame the page does not answer while shown: given up. */
const EXPORT_FRAME_MS = 30000;
/** A rail handoff the page does not adopt in this time: cancelled (src/extension.js ADOPT_MS). */
const ADOPT_MS = 20000;
/** The resume position is stored when it stops moving, jumps, or this often while playing (src/extension.js). */
const SAVE_POS_MS = 30000;
const EXACT_NOT_ELIGIBLE = 'exact frames are for Live transcode or downscaled native ffmpeg of a video file';
/** ⚙ rows that open VS Code's Settings at one setting. */
const SETTING_ACTIONS = /** @type {Record<string, string>} */ ({
  nativeResolutionSettings: '@id:videoPreviewEnhanced.nativeMaxHeight',
  transcodeSettings: '@id:videoPreviewEnhanced.transcode',
  whenSlowSettings: '@id:videoPreviewEnhanced.whenSlow',
  fastPreviewSettings: '@id:videoPreviewEnhanced.fastPreviewWhenBehind',
});
const NOTICES = new Set(['hideSlowPlaybackNotice', 'hideReducedResNotice']);

/**
 * @typedef {import('./unified-session').UnifiedSession} UnifiedSession
 * @typedef {import('./unified-session').SavedPos} SavedPos
 * @typedef {{ scheme: string, fsPath: string, authority?: string, path?: string, with(change: any): any, toString(): string }} UriLike
 * @typedef {object} ViewerClip a clip of this lane: a file on disk (or a URL / image sequence the caller prepared)
 * @property {string} id
 * @property {UriLike} uri
 * @property {string} fsPath
 * @property {string} label
 * @property {number} size
 * @property {number} rotation
 * @property {boolean} native  decoded on the host ('nd'): native ffmpeg, Live transcode, or the URL / sequence source
 * @property {boolean} [transcode]  Live transcode (EncodedStream) rather than raw native frames
 * @property {any} decision    extension.js nativeFor()'s answer when `native` (tools, method, probed, stream ...), else null
 * @property {'file' | 'url' | 'sequence'} [kind]  default 'file'
 * @property {number} [width]
 * @property {number} [height]
 * @property {number} [fps]
 * @property {number} [duration]
 * @property {any} [goto]
 * @property {SavedPos} [savedPos]
 * @property {any} [source]  a URL or sequence clip's own data for its opener (never sent to the page)
 *
 * A host-side decoder for one clip: NativeDecoder, EncodedStream, or what openUrlStream / openSequence return.
 * @typedef {{ handle(m: any): any, dispose(): void, resize?: Function, lossy?: () => boolean, setHidden?: (on: boolean) => void,
 *   setCompareOutput?: Function, setView?: (v: { w: number, h: number }, playing?: boolean) => void,
 *   setMaxBitrateMbps?: (mbps: number) => void, setResolution?: (h: number) => void,
 *   setQuality?: (pick: 'auto' | number) => any, readBlock?: (pos: number, len: number) => Promise<Uint8Array | null>,
 *   busy?: () => boolean, w?: number, h?: number, videoSize?: () => { width: number, height: number } }} HostDecoder
 * @typedef {{ post(m: any): void, postRaw(m: any): void, log(m: string): void, onFail(err: any): void, hidden: boolean,
 *   origin?: string | null, transport?: string }} DecoderIo
 */

/** A video the unified viewer can open from disk: a file on a real file system (not a URL or a virtual file). @param {any} uri */
const isViewable = (uri) => !!uri && FS_SCHEMES.has(uri.scheme);

/** The file a uri names, without query or fragment. @param {UriLike} uri */
const fileKey = (uri) => uri.with({ query: '', fragment: '' }).toString();

/** @param {string} s */
const sha = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);

/**
 * A clip's id on the page: stable for the file, and no part of its path (the page never learns where a file is).
 * @param {UriLike} uri @param {string} [suffix]
 */
const clipIdOf = (uri, suffix = '') => `c${sha(fileKey(uri))}${suffix}`;

/** @param {unknown} v */
const positive = (v) => (Number.isFinite(v) && /** @type {number} */ (v) > 0 ? /** @type {number} */ (v) : undefined);

/** @param {any} e */
const errText = (e) => (e && e.message) || String(e);

/** A clip that plays from a file on disk (not a URL or a sequence). @param {any} c */
const isFileClip = (c) => !!c && sourceKindOf(c) === 'file' && !!c.fsPath && !!c.uri;

/**
 * Everything the host must know about a file before the page may open it: its size, rotation and whether native
 * ffmpeg decodes it (the same decision Compare asks for a tile). A Live transcode decision (decision.stream) is this
 * lane's only when the caller can start streams (deps.streams); else such a file plays through the built-in decoder.
 * @param {UriLike} uri
 * @param {{ fs?: { stat(p: string): Promise<{ size: number }> }, rotationOf?: (file: string) => Promise<number>,
 *   nativeFor?: ((file: string, transport: string, tile: any, o?: { compare: boolean }) => Promise<any>) | null,
 *   transport?: () => string, log?: (m: string) => void, streams?: boolean, skipNative?: boolean, compare?: boolean }} deps
 *   compare: the clip shows in a Compare (several videos), whose transcode policy differs from a single video's
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
  if (deps.nativeFor && !deps.skipNative) {
    try {
      const transport = deps.transport ? deps.transport() : 'message';
      decision = await deps.nativeFor(file, transport, null, { compare: !!deps.compare });
    } catch (e) { if (deps.log) deps.log(`native check failed for ${path.basename(file)}: ${errText(e)}`); }
  }
  const native = !!(decision && decision.tools && !decision.stream);
  const transcode = !!(decision && decision.tools && decision.stream && deps.streams);
  const video = (decision && decision.probed && decision.probed.video) || {};
  return {
    id: clipIdOf(uri), uri, fsPath: file, label: path.basename(file), size: st.size, rotation: Number(rotation) || 0,
    native: native || transcode, transcode, decision: native || transcode ? decision : null,
    width: positive(video.width), height: positive(video.height), fps: positive(video.fps),
    duration: positive(decision && decision.probed && decision.probed.duration),
  };
}

/**
 * A URL or image-sequence clip: decoded on the host by deps.openUrlStream / deps.openSequence, never read in blocks.
 * `key` (the URL, or the sequence's pattern) only makes the id; it is not sent to the page.
 * @param {'url' | 'sequence'} kind @param {string} key @param {Partial<ViewerClip>} [more] label, probed facts, source
 * @returns {ViewerClip}
 */
function sourceClip(kind, key, more = {}) {
  return /** @type {ViewerClip} */ (/** @type {any} */ ({
    size: 0, rotation: 0, native: true, decision: null, label: kind === 'url' ? 'video' : 'sequence', ...more,
    id: `${kind === 'url' ? 'u' : 's'}${sha(`${kind}:${key}`)}`, kind, sourceKind: kind, fsPath: '', uri: undefined,
  }));
}

/**
 * The output height for a native ffmpeg tile: the tile's picture (per tile, or the page's stage split by its grid,
 * times its fit factor), never above the source or the decision's cap.
 * @param {ViewerClip} c @param {any} size TileSizePayload @param {boolean} perTile
 */
function nativeHeightFor(c, size, perTile) {
  const d = c.decision;
  const v = d && d.probed && d.probed.video;
  if (!v || !v.width || !v.height) return d && d.maxHeight > 0 ? d.maxHeight : 0;
  const factor = Number(size.factor) > 0 ? Math.max(0.1, Math.min(64, Number(size.factor))) : 1;
  const cols = perTile ? 1 : Math.max(1, Math.floor(Number(size.cols)) || 1);
  const rows = perTile ? 1 : Math.max(1, Math.floor(Number(size.rows)) || 1);
  const tw = !size.actual && size.w > 0 ? (size.w / cols) * factor : Infinity;
  const th = !size.actual && size.h > 0 ? (size.h / rows) * factor : Infinity;
  const [w, h] = c.rotation % 180 !== 0 ? [th, tw] : [tw, th];
  const height = Math.min(v.height, d.maxHeight > 0 ? d.maxHeight : Infinity, h, w * v.height / v.width);
  return Math.max(2, Math.round(height));
}

/**
 * @param {object} o
 * @param {any} o.vscode
 * @param {{ extensionUri: any }} o.context
 * @param {any} o.panel  the WebviewPanel (a custom editor's, or one made for this viewer)
 * @param {ViewerClip} o.clip  the first video (prepareClip, or sourceClip for a URL / sequence)
 * @param {{ add(s: UnifiedSession): () => void } | null} [o.registry]  createUnifiedRegistry(): capture routing
 * @param {{ goto?: any, savedPos?: SavedPos | null, railCarry?: any, railBrowse?: string | null, fromAutoNext?: boolean } | null} [o.openTarget]
 *   what the page shows first: a frame link, the saved position (resume), the rail carried over a tab swap or reload
 * @param {object} o.deps  what src/extension.js shares with the shipped player and Compare
 * @param {(m: string) => void} o.deps.log
 * @param {(webview: any) => any} o.deps.engineCfg  the page's decoder config (as Compare's)
 * @param {() => { dir: any, loader: string }} o.deps.libavBuild
 * @param {() => any} o.deps.prefs
 * @param {() => number} [o.deps.maxVideos]
 * @param {((file: string, transport: string, tile: any, o?: { compare: boolean }) => Promise<any>) | null} [o.deps.nativeFor]
 * @param {() => string} [o.deps.nativeTransport]
 * @param {() => number} [o.deps.nativeQueue]
 * @param {() => boolean} [o.deps.fitTiles]  native ffmpeg frames sized to the tile (sizeFramesToView with the automatic
 *   nativeMaxHeight); false: the decision's full size. Default true.
 * @param {(opts: any) => HostDecoder} [o.deps.createNative]  default: new NativeDecoder(opts)
 * @param {(c: ViewerClip, err: any, rejectedMedia: boolean) => any} [o.deps.nativeFailed]  native ffmpeg failed on a
 *   clip (it plays in the page from now on): `rejectedMedia` when ffmpeg ran and refused the file
 * @param {(c: ViewerClip, opts: any) => HostDecoder} [o.deps.createStream]  a Live transcode EncodedStream for a clip
 *   whose decision has a stream (opts: decision, maxHeight, maxKbps, resolution, rotation, hidden, post, log, onFail)
 * @param {() => { transcodeMaxBitrate?: number, transcodeSplitBitrate?: boolean }} [o.deps.transcodePrefs]
 * @param {(c: ViewerClip, io: DecoderIo) => HostDecoder | null} [o.deps.openUrlStream]  a URL clip's decoder
 * @param {(c: ViewerClip, io: DecoderIo) => HostDecoder | null} [o.deps.openSequence]  an image sequence's decoder
 * @param {(c: ViewerClip, pick: 'auto' | number, viewer: any) => any} [o.deps.setQuality]  when the decoder has none
 * @param {number} [o.deps.framePort]  the localhost frame server's port (the CSP names it), local windows only
 * @param {(file: string) => Promise<number>} [o.deps.rotationOf]
 * @param {(label: string, defaultUri: any, many: boolean) => Promise<any[] | undefined>} [o.deps.pick]
 * @param {(m: any, from: any) => any} [o.deps.setPlaybackPrefs]
 * @param {(what: 'toggle' | 'exited') => any} [o.deps.focusMode]
 * @param {(uri: UriLike, log: (m: string) => void) => Promise<any[]>} [o.deps.findSidecars]  sidecar subtitles
 * @param {(c: ViewerClip | null, viewer: any) => Promise<any[] | undefined>} [o.deps.loadSubtitles]
 *   "Load subtitles…": the picked files as { id, name, data }
 * @param {(c: ViewerClip, m: any, viewer: any) => any} [o.deps.saveFrame]
 * @param {(c: ViewerClip, at: { frame: number, t: number }, viewer: any) => Promise<string | undefined> | string | undefined} [o.deps.copyLink]
 *   the frame link's text (the viewer copies it and says so)
 * @param {(kind: string, c: ViewerClip | null, m: any, viewer: any) => any} [o.deps.exportAb]
 *   an A-B export with the page's range (exportRange, clipRange, ffmpegRange); grabFrame() serves its frames
 * @param {(a: { clip: ViewerClip, decoder: HostDecoder, t: number, reqId: number, isCurrent: () => boolean }) => Promise<any>} [o.deps.grabExactFrame]
 *   one full-resolution PNG ({ png, w, h, matrix } | { error } | { cancelled } | { stale })
 * @param {(c: ViewerClip, pos: SavedPos) => any} [o.deps.savePos]  the resume position of a file
 * @param {(file: string, onChange: () => void, onError: (e: any) => void) => { close(): void }} [o.deps.watchFile]
 * @param {number} [o.deps.watchDelayMs]
 * @param {(c: ViewerClip | null, viewer: any) => any} [o.deps.external]  open in the system player
 * @param {() => any} [o.deps.openUrl]  "Open video URL…"
 * @param {() => Promise<any> | any} [o.deps.setupFfmpeg]
 * @param {(key: string, value: any) => any} [o.deps.setSetting]  whenSlow (validated here)
 * @param {(id: string) => any} [o.deps.hideNotice]  "Don't show again": stored and broadcast by the caller
 * @param {() => string[]} [o.deps.hiddenNotices]  the notices hidden for good, sent to each new page
 * @param {() => Promise<any> | any} [o.deps.ffmpegState]  { installed, offer, mb } for the page's ffmpeg pill
 * @param {(m: any, viewer: any) => any} [o.deps.setTranscodePref]  writes the Live transcode settings
 * @param {(id: string, m: any, viewer: any) => any} [o.deps.onAction]  any other 'action' id
 * @param {(viewer: any) => any} [o.deps.onReady]  the page is ready (each new page; the first-run offers wait for it)
 * @param {(m: any, viewer: any) => any} [o.deps.onPageMessage]  a page message neither the session nor the viewer
 *   handles (decode speed samples, WebCodecs failures, Compare's quick pick ...)
 * @param {{ cache: any, probe: any, prefs: { get(): any, set(v: any): any }, layout: () => string, caseless: boolean } | null} [o.deps.rail]
 * @param {(folder: UriLike, viewer: any) => any} [o.deps.compareFolder]  the rail's "Compare all videos in folder"
 * @param {(viewer: any, targetPath: string, opts: { rail?: any, fromAutoNext?: boolean }) => any} [o.deps.openFolderFile]
 *   folder navigation from a single-video tab (tab swap via railHandoff); omitted: replaces the clip in place
 * @param {number} [o.deps.adoptMs]
 * @param {(name: string) => ({ sendDown(m: any, deliver: () => void): any, sendUp(m: any, deliver: () => void): any,
 *   dispose(): void } | null)} [o.deps.link]  tests (VPE_SIMULATE_LINK): this panel's slice of a simulated slow link,
 *   which the native decoders' 'nd' messages take both ways (src/link-sim.js wrapChannel)
 * @param {boolean} [o.deps.debug]
 * @param {boolean} [o.deps.remote]  a remote window: the page's small scripts are inlined
 */
function createUnifiedViewer({ vscode, context, panel, clip, registry, openTarget, deps }) {
  const media = vscode.Uri.joinPath(context.extensionUri, 'media');
  const webview = panel.webview;
  webview.options = { enableScripts: true, localResourceRoots: [media] };
  let page = 0;
  let disposed = false;
  /** @type {string | null} the page's origin, for the frame server (null: frames go over messages) */
  let origin = null;
  /** @type {Map<string, Promise<{ fh: any, size: number }>>} one open file per clip */
  const files = new Map();
  /** @type {Map<string, HostDecoder>} clip id -> its host decoder */
  const natives = new Map();
  /** @type {Map<string, 'native' | 'stream' | 'source'>} what each host decoder is */
  const kinds = new Map();
  /** @type {Set<string>} files (fileKey) the user switched to the built-in decoder: a reload keeps it */
  const builtIn = new Set();
  /** @type {Map<string, number>} a clip's Live transcode resolution (⚙ › Live transcode › Resolution) */
  const resolutions = new Map();
  /** @type {Map<string, any[]>} subtitles loaded with "Load subtitles…", by file: restored for a reloaded clip */
  const extraSubs = new Map();
  /** @type {Set<string>} clips whose sidecar subtitles this page has */
  const subsSent = new Set();
  /** @type {Map<string, { close(): void }>} clip id -> its file watcher */
  const watchers = new Map();
  /** @type {Map<string, number>} file -> mtime of the last load (a change event without a new mtime is no change) */
  const stamps = new Map();
  /** @type {Map<string, any>} clip id -> its pending reload timer */
  const watchTimers = new Map();
  /** @typedef {{ clip: ViewerClip, pos?: SavedPos, saved?: SavedPos, savedAt?: number }} PosState */
  /** @type {Map<string, PosState>} the resume position per clip */
  const positions = new Map();
  /** @type {Map<number, (reply: any) => void>} A-B export frames the page was asked for */
  const exportWait = new Map();
  let exportSeq = 0;
  /** @type {{ id: number, done: (ok: boolean) => void } | null} */
  let adoptWait = null;
  let adoptSeq = 0;
  let reloads = 0;
  /** @type {{ id: any, clipId: string, controller: AbortController } | null} */
  let thumbJob = null;
  /** @type {Set<{ close(): void }>} tests (VPE_LOG benchFs): frame server benchmark channels of this page */
  const benchChannels = new Set();
  const closeBenches = () => { for (const ch of [...benchChannels]) ch.close(); };
  /** @type {ReturnType<typeof folderRail.createFolderRail> | null} */
  let rail = null;
  let railOpen = false;
  /** @type {string | null} */
  let railBrowse = openTarget && typeof openTarget.railBrowse === 'string' && openTarget.railBrowse ? openTarget.railBrowse : null;
  const link = deps.link ? deps.link(clip.label) : null;
  /** @type {UnifiedSession} set below; the helpers before it run only once it exists */
  let session = /** @type {any} */ (null);
  /** @param {string} m */
  const log = (m) => {
    const t = session ? session.title : clip.label;
    const tag = session && session.clips.length >= 2 ? `compare ${t}` : t;
    deps.log(`[${tag}] ${m}`);
  };
  /**
   * A decoder's log line. One video: "[name] native decode from ..." (what the tests and a bug report read); beside
   * others the clip's name leads, so the lines of a comparison's tiles stay apart.
   * @param {ViewerClip} c @param {string} m
   */
  const clipLog = (c, m) => {
    if (session && session.clips.length >= 2) {
      const i = session.order.indexOf(c.id);
      const key = i >= 0 && Grid.TILE_KEYS[i] ? `tile ${Grid.TILE_KEYS[i]}` : c.label;
      log(`${key}: ${m}`);
    } else log(m);
  };
  /** @param {UriLike} [uri] @param {boolean} [compare] the clip will show beside others (Compare's transcode policy) */
  const prepDeps = (uri, compare = false) => ({
    rotationOf: deps.rotationOf, nativeFor: deps.nativeFor || null, transport: deps.nativeTransport, log,
    streams: !!deps.createStream, skipNative: !!uri && builtIn.has(fileKey(uri)), compare,
  });
  const fitTiles = () => (deps.fitTiles ? deps.fitTiles() !== false : true);
  /** @param {string} id @returns {ViewerClip | null} */
  const clipOf = (id) => /** @type {any} */ (session.clipOf(id));
  /** Host -> page with fields the shared contract does not list yet. @param {Record<string, any>} m */
  const postAny = (m) => session.post(/** @type {any} */ (m));
  /** @param {string} text @param {number} [ms] */
  const toast = (text, ms) => postAny(ms ? { type: 'toast', text, ms } : { type: 'toast', text });
  const fileClipOf = () => (isFileClip(clip) ? clip : null);

  // ---- the page ----
  /** @param {UnifiedSession} s */
  function renderHtml(s) {
    const uri = (/** @type {string[]} */ ...p) => webview.asWebviewUri(vscode.Uri.joinPath(media, ...p)).toString();
    const build = deps.libavBuild();
    const ec = deps.engineCfg(webview);
    const first = /** @type {ViewerClip | undefined} */ (/** @type {any} */ (s.clips[0]));
    const folder = !!deps.rail && isFileClip(first);
    const target = s.openTarget;
    /** @type {Record<string, any>} */
    const cfg = {
      page: ++page, debug: !!deps.debug, engine: ec,
      clips: s.clips.map((c) => ({ ...clipDescriptor(c), id: c.id })), tiles: s.order,
      prefs: deps.prefs(),
      rail: deps.rail && folder ? { ...folderRail.sanitizeRailPrefs(deps.rail.prefs.get()), layout: deps.rail.layout() } : null,
      sourceKind: first ? sourceKindOf(first) : 'file',
    };
    // The page reads these at boot (media/player-ui-lifecycle.js applyOpenTarget, the rail's adoptCarry).
    if (target && target.goto) cfg.goto = target.goto;
    if (target && target.savedPos) cfg.savedPos = target.savedPos;
    if (target && target.railCarry) cfg.railCarry = target.railCarry;
    if (target && target.fromAutoNext) cfg.fromAutoNext = true;
    const scriptFiles = [...UNIFIED_SCRIPTS, ENTRY_SCRIPT];
    const { inlineCss, inlineScripts } = inlineAssetsFor(media.fsPath, {
      cssFiles: UNIFIED_CSS, scriptFiles, inlineScripts: !!deps.remote,
    });
    return {
      cspSource: webview.cspSource, uri, base: webview.asWebviewUri(build.dir).toString(), loader: build.loader,
      nonce: crypto.randomBytes(16).toString('base64'), cfg,
      framePort: deps.framePort, transport: deps.nativeTransport ? deps.nativeTransport() : 'message', debug: !!deps.debug,
      canCompare: true, compareOpen: false, folder, inlineCss, inlineScripts,
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
    // A URL read by the page's built-in decoder: its host decoder fetches the blocks; a sequence has none.
    if (!isFileClip(c)) return readSourceBlock(c, m);
    const at = page;
    // A reply for a clip the panel dropped, or for the page before a reload, is not sent.
    const isCurrent = () => !disposed && at === page && !!session.clipOf(c.id);
    return serveBlock({ type: 'readBlock', page: m.page, pos: m.pos, len: m.len }, isCurrent, async (pos, len) => {
      try {
        const { fh, size } = await blockFile(c);
        if (!isCurrent()) return undefined;
        return await readFileBlock(fh, size, pos, len, MAX_BLOCK);
      } catch (e) {
        log(`${c.label}: read failed: ${errText(e)}`);
        // Always answer (empty on error), or the decoder keeps the block in flight forever.
        return new Uint8Array(0);
      }
    }, (reply) => postAny({ ...reply, key: c.id, clipId: c.id }));
  }

  /** @param {ViewerClip} c @param {any} m */
  function readSourceBlock(c, m) {
    const d = natives.get(c.id);
    if (!d || typeof d.readBlock !== 'function') return undefined;
    const at = page;
    const isCurrent = () => !disposed && at === page && natives.get(c.id) === d;
    const read = /** @type {(pos: number, len: number) => Promise<Uint8Array | null>} */ (d.readBlock);
    return serveBlock({ type: 'readBlock', page: m.page, pos: m.pos, len: m.len }, isCurrent,
      async (pos, len) => (await read(pos, len)) || new Uint8Array(0),
      (reply) => postAny({ ...reply, key: c.id, clipId: c.id }));
  }

  // ---- host decoders (native ffmpeg, Live transcode, URL / sequence), by clip id ----
  /**
   * The same file in the tile's place, decoded in the page: a new clip id, so the page starts a new decoder.
   * @param {string} id @param {string} [notice] a toast saying why
   * @returns {boolean} switched
   */
  function toBuiltIn(id, notice) {
    const c = clipOf(id);
    if (disposed || !c || !c.native || !isFileClip(c)) return false;
    builtIn.add(fileKey(c.uri));
    closeNative(c.id);
    const done = session.replaceClip(c.id, /** @type {any} */ ({
      ...c, id: clipIdOf(c.uri, `b${++reloads}`), native: false, transcode: false, decision: null,
    }));
    if (done && notice) toast(notice, 4000);
    return done;
  }
  /** @param {ViewerClip} c */
  function startNative(c) {
    const d = c.decision;
    const transport = origin && deps.nativeTransport ? deps.nativeTransport() : 'message';
    const n = Math.max(1, session.clips.length);
    // A tile size the page already reported: ffmpeg starts at it (no restart once the first frames show).
    const own = session.tileSize(c.id);
    const size = /** @type {any} */ (fitTiles() ? own || session.lastTileSize : null);
    const singleReal = n < 2 && !deps.createNative && !(size && (Number(size.cols) > 1 || Number(size.rows) > 1));
    const fit = !singleReal && size ? nativeHeightFor(c, size, !!own) : 0;
    const maxHeight = fit > 0 ? Math.min(d.maxHeight, fit) : d.maxHeight;
    clipLog(c, `native ffmpeg (${d.method}) at up to ${maxHeight}p: ${d.reason}`);
    /** @type {HostDecoder} */
    let decoder;
    const opts = {
      tools: d.tools, file: c.fsPath, maxHeight, messageMaxHeight: Math.min(maxHeight, d.messageMaxHeight),
      method: d.method, methodGuessed: !!d.methodGuessed, probed: d.probed, transport, origin,
      fitView: singleReal && fitTiles(),
      view: singleReal && size ? { w: size.actual ? 16384 : size.w, h: size.actual ? 16384 : size.h } : undefined,
      maxQueued: Grid.nativeQueuePerTile(deps.nativeQueue ? deps.nativeQueue() : 8, n), largeGrid: Grid.isLarge(n),
      post: (/** @type {any} */ msg) => { if (natives.get(c.id) === decoder) session.postNativeReply(c.id, msg); },
      postRaw: (/** @type {any} */ msg) => { if (natives.get(c.id) === decoder) postAny({ ...msg, key: c.id, clipId: c.id }); },
      log: (/** @type {string} */ msg) => clipLog(c, msg),
      onFail: (/** @type {any} */ err, /** @type {boolean} */ rejectedMedia) => {
        if (disposed || natives.get(c.id) !== decoder) return;
        clipLog(c, `native ffmpeg failed (${errText(err)}); built-in decoder from now on`);
        if (deps.nativeFailed) {
          try { deps.nativeFailed(c, err, !!rejectedMedia); } catch (e) { log(`${c.label}: ${errText(e)}`); }
        }
        toBuiltIn(c.id);
      },
    };
    decoder = deps.createNative ? deps.createNative(opts) : /** @type {any} */ (new NativeDecoder(opts));
    natives.set(c.id, decoder);
    kinds.set(c.id, 'native');
    return decoder;
  }
  /**
   * A Live transcode clip's output (height, bitrate cap) for its tile, with the bitrate shared by the streams shown
   * (src/transcode_policy.js compareCapsKbps). Null: not known yet (the page has not sent its size).
   * @param {ViewerClip} c
   */
  function streamOutput(c) {
    const shown = session.clips.map((x) => /** @type {ViewerClip} */ (/** @type {any} */ (x)))
      .filter((x) => x.transcode && x.decision && x.decision.probed && x.decision.probed.video);
    if (!shown.some((x) => x.id === c.id)) return null;
    const outputs = shown.map((x) => {
      const own = session.tileSize(x.id);
      const size = own ? { ...own, cols: 1, rows: 1 } : session.lastTileSize || {};
      return compareTileSize(x.decision.probed.video, x.decision.maxHeight, size, x.rotation % 180 !== 0);
    });
    const prefs = deps.transcodePrefs ? deps.transcodePrefs() || {} : {};
    const caps = compareCapsKbps(outputs, Number(prefs.transcodeMaxBitrate) || 0, prefs.transcodeSplitBitrate !== false);
    const i = shown.findIndex((x) => x.id === c.id);
    return { height: outputs[i].h, kbps: caps[i] };
  }
  /** @param {ViewerClip} c */
  function startStream(c) {
    const d = c.decision;
    const multi = session.clips.length >= 2;
    const out = streamOutput(c);
    clipLog(c, `live transcode (${d.stream && d.stream.encoder || 'stream'})`);
    /** @type {HostDecoder} */
    let stream;
    const current = () => !disposed && natives.get(c.id) === stream;
    const create = /** @type {(c: ViewerClip, opts: any) => HostDecoder} */ (deps.createStream);
    stream = create(c, {
      decision: d,
      maxHeight: multi ? (out ? out.height : d.maxHeight) : (d.stream && d.stream.maxHeight > 0 ? d.stream.maxHeight : (out ? out.height : d.maxHeight)),
      maxKbps: out ? out.kbps : undefined,
      fitView: !multi && fitTiles(),
      resolution: resolutions.get(c.id), rotation: c.rotation || 0, hidden: panel.visible === false,
      post: (/** @type {any} */ msg) => {
        if (!current()) return;
        if (msg && msg.type === 'remoteNotice') toast(String(msg.text || ''), 6000);
        else session.postNativeReply(c.id, msg);
      },
      log: (/** @type {string} */ msg) => clipLog(c, msg),
      onFail: (/** @type {any} */ err) => {
        if (!current()) return;
        clipLog(c, `remote stream failed (${errText(err)}); using the built-in decoder`);
        toBuiltIn(c.id, 'Live transcode failed. Using the original video.');
      },
    });
    natives.set(c.id, stream);
    kinds.set(c.id, 'stream');
    return stream;
  }
  /** A URL or sequence clip's decoder, from the caller's opener. @param {ViewerClip} c */
  function startSource(c) {
    const open = sourceKindOf(c) === 'url' ? deps.openUrlStream : deps.openSequence;
    if (!open) return null;
    /** @type {HostDecoder | null} */
    let decoder = null;
    const current = () => !disposed && !!decoder && natives.get(c.id) === decoder;
    decoder = open(c, {
      hidden: panel.visible === false, origin,
      transport: origin && deps.nativeTransport ? deps.nativeTransport() : 'message',
      post: (msg) => { if (current()) session.postNativeReply(c.id, msg); },
      postRaw: (msg) => { if (current()) postAny({ ...msg, key: c.id, clipId: c.id }); },
      log: (msg) => clipLog(c, msg),
      onFail: (err) => {
        if (!current()) return;
        clipLog(c, `cannot play (${errText(err)})`);
        closeNative(c.id);
        toast(`${c.label} cannot be played.`, 4000);
      },
    });
    if (!decoder) return null;
    natives.set(c.id, decoder);
    kinds.set(c.id, 'source');
    return decoder;
  }
  /** @param {ViewerClip} c @returns {HostDecoder | null} */
  function startDecoder(c) {
    if (!c.native) return null;
    if (!isFileClip(c)) return startSource(c);
    if (!c.decision) return null;
    if (c.transcode) return deps.createStream ? startStream(c) : null;
    return startNative(c);
  }
  /** @param {string} id */
  function closeNative(id) {
    const n = natives.get(id);
    natives.delete(id);
    kinds.delete(id);
    if (n) n.dispose();
  }
  /** @param {ViewerClip} c @param {any} m */
  function onNative(c, m) {
    if (!m.m || (m.m.type === 'seek' && !(Number.isFinite(m.m.t) && m.m.t >= 0))) return undefined;
    const decoder = natives.get(c.id) || startDecoder(c);
    if (!decoder) return undefined;
    // The panel can hide after the page was told it is visible.
    if (m.m.type === 'open' && kinds.get(c.id) === 'stream' && panel.visible === false && decoder.setHidden) decoder.setHidden(true);
    return decoder.handle(m.m);
  }
  /** @type {Set<string>} native clips whose smaller frame size waits for the next seek (resizeDecoders) */
  const lazyShrink = new Set();
  /**
   * The frame size a native decoder sends now (`pending`: the size it will send once a seek applies the caps).
   * Null for a decoder that does not say (a test double).
   * @param {HostDecoder} dec @param {boolean} [pending]
   * @returns {{ width: number, height: number } | null}
   */
  function frameSizeOf(dec, pending = false) {
    if (typeof dec.videoSize !== 'function' || !(Number(dec.w) > 0) || !(Number(dec.h) > 0)) return null;
    if (pending) return dec.videoSize();
    return { width: Number(dec.w), height: Number(dec.h) };
  }
  /**
   * The page's decode size changed (layout, zoom, rate): every native tile gets its new output size, every Live
   * transcode its new size and bitrate share; a tile that must seek to apply it gets 'resize' (by clip id).
   */
  function resizeDecoders() {
    if (disposed) return;
    const fit = fitTiles();
    /** @type {string[]} */
    const resized = [];
    for (const x of session.clips) {
      const c = /** @type {ViewerClip} */ (/** @type {any} */ (x));
      const dec = natives.get(c.id);
      const kind = kinds.get(c.id);
      if (!dec || !c.decision) continue;
      const own = session.tileSize(c.id);
      const size = /** @type {any} */ (own || session.lastTileSize);
      if (!size) continue;
      if (kind === 'native' && fit && session.clips.length < 2 && typeof dec.setView === 'function') {
        dec.setView({ w: size.actual ? 16384 : size.w, h: size.actual ? 16384 : size.h });
      } else if (kind === 'native' && fit && typeof dec.resize === 'function') {
        const h = nativeHeightFor(c, size, !!own);
        const mmh = c.decision.messageMaxHeight > 0 ? c.decision.messageMaxHeight : h;
        if (!h) continue;
        const had = frameSizeOf(dec);
        let changed = dec.resize(h, Math.min(h, mmh));
        const now = frameSizeOf(dec, true);
        // A smaller size waiting for the next seek (below) is not applied again; a larger one meanwhile is.
        if (!changed && lazyShrink.has(c.id) && had && now) {
          if (now.height > had.height) changed = true;
          else if (now.height === had.height) lazyShrink.delete(c.id);
        }
        if (!changed) continue;
        const view = `native: picture ${Math.round(Number(size.w) || 0)}x${Math.round(Number(size.h) || 0)}`;
        if (had && now && had.height > now.height && session.clips.length < 2) {
          // One video alone: smaller frames wait for the next seek or loop (a picture resized back and forth across a
          // step does not restart ffmpeg each time); larger ones apply at once, below.
          lazyShrink.add(c.id);
          clipLog(c, `${view}: frames ${had.width}x${had.height} -> ${now.width}x${now.height} at the next seek`);
          continue;
        }
        lazyShrink.delete(c.id);
        if (had && now && had.height !== now.height) clipLog(c, `${view}: frames ${had.width}x${had.height} -> ${now.width}x${now.height}`);
        resized.push(c.id);
      } else if (kind === 'stream') {
        if (session.clips.length < 2 && fit && typeof dec.setView === 'function') {
          dec.setView({ w: size.w, h: size.h });
        } else if (typeof dec.setCompareOutput === 'function') {
          const out = streamOutput(c);
          // A grown picture (zoomed in) is not restarted at once: the page seeks it once ('resize').
          if (out && dec.setCompareOutput(out.height, out.kbps, { deferGrow: true })) resized.push(c.id);
        }
      }
    }
    for (const id of resized) postAny({ type: 'resize', clipId: id, key: id, tiles: [id] });
  }
  /** A host-decoded file clip's seek-bar thumbnail; one at a time. @param {ViewerClip} c @param {any} m */
  async function onThumb(c, m) {
    if (m.cancel) {
      if (thumbJob && thumbJob.clipId === c.id && thumbJob.id === m.id) thumbJob.controller.abort();
      return;
    }
    if (thumbJob) thumbJob.controller.abort();
    const job = { id: m.id, clipId: c.id, controller: new AbortController() };
    thumbJob = job;
    // Native ffmpeg and Live transcode both decode keyframes of the source file on this host; a URL has no file.
    const kind = kinds.get(c.id);
    const decoder = isFileClip(c) && (kind === 'native' || kind === 'stream') ? natives.get(c.id) : null;
    let result = null;
    try {
      if (decoder && panel.visible !== false) result = await thumbhost.nativeThumb(/** @type {any} */ (decoder), m, log, job.controller.signal);
    } catch (e) {
      log(`thumbnail: ${errText(e)}`);
    } finally {
      if (thumbJob === job) {
        thumbJob = null;
        if (!job.controller.signal.aborted) postAny({ type: 'thumb', key: c.id, clipId: c.id, id: m.id, .../** @type {any} */ (result) });
      }
    }
  }
  /** One full-resolution PNG of a clip's source for the pixel tools (src/exact_frame.js). @param {ViewerClip} c @param {any} m */
  async function onExactFrame(c, m) {
    const reqId = Number(m.reqId);
    const t = Number(m.t);
    if (!Number.isSafeInteger(reqId)) return undefined;
    const at = page;
    const isCurrent = () => !disposed && at === page && !!session.clipOf(c.id);
    /** @param {any} r */
    const reply = (r) => { if (isCurrent()) postAny({ type: 'exactFrame', clipId: c.id, key: c.id, reqId, t, ...r }); };
    const decoder = natives.get(c.id);
    const kind = kinds.get(c.id);
    const eligible = !!decoder && isFileClip(c)
      && (kind === 'stream' || (kind === 'native' && typeof decoder.lossy === 'function' && decoder.lossy()));
    if (!eligible || !deps.grabExactFrame || !(t >= 0)) { reply({ error: EXACT_NOT_ELIGIBLE }); return undefined; }
    const r = await deps.grabExactFrame({ clip: c, decoder: /** @type {HostDecoder} */ (decoder), t, reqId, isCurrent });
    if (!r || r.cancelled || r.stale) return undefined; // superseded or replaced: the newer request answers
    reply(r.png ? { png: new Uint8Array(r.png.buffer, r.png.byteOffset, r.png.length), w: r.w, h: r.h, matrix: r.matrix }
      : { error: r.error || 'failed' });
    return undefined;
  }

  // ---- subtitles ----
  /** A clip's sidecar subtitles, plus files loaded earlier for its file. @param {ViewerClip} c */
  async function sendSubs(c) {
    if (!isFileClip(c) || subsSent.has(c.id)) return;
    subsSent.add(c.id);
    const at = page;
    const found = deps.findSidecars ? await deps.findSidecars(c.uri, log) : [];
    if (disposed || at !== page || !session.clipOf(c.id)) return;
    if (found && found.length) {
      log(`${c.label}: subtitles found: ${found.map((f) => f && f.name).join(', ')}`);
      postAny({ type: 'subs', clipId: c.id, key: c.id, tracks: found, files: found });
    }
    const extra = extraSubs.get(fileKey(c.uri));
    if (extra && extra.length) postAny({ type: 'subs', clipId: c.id, key: c.id, tracks: extra, files: extra, restore: true });
  }
  /** @param {ViewerClip | null} c */
  async function loadSubs(c) {
    if (!deps.loadSubtitles) return;
    const picked = await deps.loadSubtitles(c, viewer);
    const got = (picked || []).filter((f) => f && typeof f === 'object');
    if (disposed || !got.length || (c && !session.clipOf(c.id))) return;
    if (c && isFileClip(c)) {
      const key = fileKey(c.uri);
      const had = extraSubs.get(key) || [];
      extraSubs.set(key, [...had.filter((f) => !got.some((g) => g.id === f.id)), ...got]);
    }
    postAny(c ? { type: 'subs', clipId: c.id, key: c.id, tracks: got, files: got, select: true }
      : { type: 'subs', tracks: got, files: got, select: true });
  }

  // ---- frame links, A-B export, positions ----
  /** @param {ViewerClip} c @param {any} m */
  async function copyLink(c, m) {
    if (!Number.isSafeInteger(m.frame) || m.frame < 0) return;
    const kind = sourceKindOf(c);
    if (kind === 'url') { toast('Frame links work for video files only, not URLs', 3000); return; }
    if (kind === 'sequence') { toast('Links work for video files only'); return; }
    if (!deps.copyLink) return;
    const text = await deps.copyLink(c, { frame: m.frame, t: Number(m.t) || 0 }, viewer);
    if (disposed || typeof text !== 'string' || !text) return;
    await vscode.env.clipboard.writeText(text);
    toast(`Link to frame ${m.frame} copied`);
  }
  /** @param {string} kind @param {ViewerClip | null} c @param {any} m */
  function exportAb(kind, c, m) {
    if (kind === 'exportFrame') {
      const finish = exportWait.get(Number(m.id));
      if (finish) { finish(m); return undefined; }
      return deps.exportAb ? deps.exportAb(kind, c, m, viewer) : undefined;
    }
    if (!c) return undefined;
    return deps.exportAb ? deps.exportAb(kind, c, m, viewer) : undefined;
  }
  /**
   * Asks the page for frame k (0-based) of an A-B export as PNG bytes; resolves with { data, frame } or { error }.
   * Only time the panel is shown counts toward the timeout (a hidden page draws nothing).
   * @param {number} frame @param {AbortSignal} [signal] @param {string} [clipId]
   * @returns {Promise<any>}
   */
  function grabFrame(frame, signal, clipId) {
    if (disposed || (signal && signal.aborted)) return Promise.resolve({ error: 'export cancelled' });
    const id = ++exportSeq;
    return new Promise((resolve) => {
      /** @type {any} */
      let timer;
      /** @param {any} reply */
      const finish = (reply) => {
        if (!exportWait.delete(id)) return;
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', cancel);
        resolve(reply);
      };
      const cancel = () => finish({ error: 'export cancelled' });
      const arm = () => {
        timer = setTimeout(() => {
          if (panel.visible === false) { arm(); return; }
          finish({ error: 'the player did not answer within 30 s' });
        }, EXPORT_FRAME_MS);
      };
      exportWait.set(id, finish);
      if (signal) signal.addEventListener('abort', cancel, { once: true });
      arm();
      postAny(clipId ? { type: 'exportGrab', id, frame, clipId } : { type: 'exportGrab', id, frame });
    });
  }
  const cancelExports = () => { for (const finish of [...exportWait.values()]) finish({ error: 'export cancelled' }); };
  /**
   * The page reports the position every second; a file's resume position is stored when it stops moving (pause,
   * end), jumps (seek), every 30 s while playing, and on close (src/extension.js rememberPos).
   * @param {ViewerClip} c @param {SavedPos} p
   */
  function onPos(c, p) {
    if (!isFileClip(c) || !deps.savePos) return;
    const st = positions.get(c.id) || { clip: c };
    const prev = st.pos;
    st.pos = p;
    positions.set(c.id, st);
    if (st.saved && st.saved.t === p.t) return;
    const playing = !!prev && p.t > prev.t && p.t - prev.t < 5;
    if (playing && Date.now() - (st.savedAt || 0) < SAVE_POS_MS) return;
    savePos(c, st);
  }
  /** @param {ViewerClip} c @param {PosState} st */
  function savePos(c, st) {
    if (!st.pos || !deps.savePos) return;
    st.saved = st.pos;
    st.savedAt = Date.now();
    try { deps.savePos(c, st.pos); } catch (e) { log(`${c.label}: cannot save the position: ${errText(e)}`); }
  }

  // ---- the file watcher: a rewritten file reloads its tile in place ----
  /** @param {ViewerClip} c */
  function watch(c) {
    if (!deps.watchFile || watchers.has(c.id) || !isFileClip(c)) return;
    const file = c.fsPath;
    nodeFs.promises.stat(file).then((st) => { if (!stamps.has(file)) stamps.set(file, st.mtimeMs); }, () => {});
    try {
      const w = deps.watchFile(file, () => {
        if (disposed || !session.clipOf(c.id)) return;
        clearTimeout(watchTimers.get(c.id));
        watchTimers.set(c.id, setTimeout(() => {
          watchTimers.delete(c.id);
          nodeFs.promises.stat(file).then((st) => {
            if (disposed || !session.clipOf(c.id) || st.mtimeMs === stamps.get(file)) return undefined;
            stamps.set(file, st.mtimeMs);
            return reprepare(c.id, 'file changed');
          }, () => {}).catch((e) => log(`${c.label}: reload failed: ${errText(e)}`));
        }, deps.watchDelayMs !== undefined ? deps.watchDelayMs : WATCH_DELAY_MS));
      }, (e) => log(`${c.label}: cannot watch for changes: ${errText(e)}`));
      watchers.set(c.id, w);
    } catch (e) {
      log(`${c.label}: cannot watch for changes: ${errText(e)}`);
    }
  }
  /** @param {string} id */
  function unwatch(id) {
    const w = watchers.get(id);
    watchers.delete(id);
    clearTimeout(watchTimers.get(id));
    watchTimers.delete(id);
    if (w) { try { w.close(); } catch { /* closed */ } }
  }
  /**
   * A clip prepared again (its file changed, or its decoding may have: Live transcode on) and shown in its tile's
   * place at its position, under a new id; the webview stays. `onlyIf`: reload only when the new preparation says so.
   * @param {string} id @param {string} why @param {(fresh: ViewerClip, old: ViewerClip) => boolean} [onlyIf]
   * @returns {Promise<string | null>} the new clip id
   */
  async function reprepare(id, why, onlyIf) {
    const c = clipOf(id);
    if (disposed || !c || !isFileClip(c)) return null;
    let fresh;
    try { fresh = await prepareClip(c.uri, prepDeps(c.uri, session.clips.length >= 2)); }
    catch (e) { log(`${c.label}: cannot reload (${why}): ${errText(e)}`); return null; }
    if (disposed || !session.clipOf(id) || (onlyIf && !onlyIf(fresh, c))) return null;
    log(`${c.label}: reload (${why})`);
    // The same file under a new id keeps the Live transcode resolution the user picked for it: moved before the old
    // id leaves (onChange below drops the entries of ids no longer shown; a replaced or removed tile's goes with it).
    const newId = clipIdOf(c.uri, `r${++reloads}`);
    const res = resolutions.get(id);
    if (res !== undefined) resolutions.set(newId, res);
    // The old tile's file handle and decoder close when it leaves the session (see onChange below).
    const done = session.reloadClip(id, { ...fresh, id: newId });
    if (done !== newId) resolutions.delete(newId);
    return done;
  }

  // ---- offers, settings, Live transcode ----
  /** Pixel tools asked for the files' own pixels: the built-in decoder for every host-decoded file tile. */
  function useFullRes() {
    let n = 0;
    for (const c of session.clips) if (toBuiltIn(c.id)) n++;
    if (n) log('full resolution: built-in decoder');
  }
  /** @param {string} id @param {any} m */
  async function onAction(id, m) {
    if (id === 'fullRes') return useFullRes();
    if (id === 'setupFfmpeg') return deps.setupFfmpeg ? deps.setupFfmpeg() : undefined;
    if (id === 'whenSlow') {
      return (m.value === 'every' || m.value === 'skip') && deps.setSetting ? deps.setSetting('whenSlow', m.value) : undefined;
    }
    if (SETTING_ACTIONS[id]) return vscode.commands.executeCommand('workbench.action.openSettings', SETTING_ACTIONS[id]);
    if (NOTICES.has(id)) {
      // The caller stores it and tells every open page (this one too); alone, at least this page hides it.
      if (deps.hideNotice) return deps.hideNotice(id);
      postAny({ type: id });
      return undefined;
    }
    return deps.onAction ? deps.onAction(id, m, viewer) : undefined;
  }
  /** Live transcode mode, max bitrate or default resolution from the ⚙ panel. @param {any} m */
  async function onTranscodePref(m) {
    if (deps.setTranscodePref) await deps.setTranscodePref(m, viewer);
    if (disposed) return;
    if (m.mode === 'off') {
      for (const c of session.clips) if (kinds.get(c.id) === 'stream') toBuiltIn(c.id);
    } else if (m.mode === 'always') {
      // Files that play some other way are asked again; one that now streams reloads in place.
      for (const c of session.clips) {
        if (kinds.get(c.id) === 'stream' || !isFileClip(c)) continue;
        builtIn.delete(fileKey(/** @type {any} */ (c).uri));
        await reprepare(c.id, 'live transcode enabled', (fresh, old) => !!fresh.transcode && !old.transcode);
      }
    }
    if (m.maxBitrateMbps !== undefined) {
      const mbps = Math.max(0, Number(m.maxBitrateMbps) || 0);
      const streams = session.clips.filter((c) => kinds.get(c.id) === 'stream');
      if (streams.length === 1) {
        const s = natives.get(streams[0].id);
        if (s && s.setMaxBitrateMbps) s.setMaxBitrateMbps(mbps);
      } else if (streams.length > 1) resizeDecoders();
    }
  }
  /** This tab's Live transcode resolution: kept for the clip across its reloads. @param {ViewerClip | null} c @param {any} m */
  function onTranscodeResolution(c, m) {
    const h = resolutionOf(m.height);
    for (const x of c ? [c] : session.clips) {
      resolutions.set(x.id, h);
      const s = kinds.get(x.id) === 'stream' ? natives.get(x.id) : null;
      if (s && s.setResolution) s.setResolution(h);
    }
  }
  /** A URL clip's HLS quality: 'auto' or a variant index. @param {ViewerClip} c @param {any} m */
  function onQuality(c, m) {
    if (sourceKindOf(c) !== 'url') return undefined;
    const pick = m.pick === 'auto' ? 'auto' : Number(m.pick);
    if (pick !== 'auto' && !(Number.isSafeInteger(pick) && pick >= 0)) return undefined;
    const dec = natives.get(c.id);
    if (dec && dec.setQuality) return dec.setQuality(pick);
    return deps.setQuality ? deps.setQuality(c, pick, viewer) : undefined;
  }
  /**
   * The folder rail moves to the tab that opens the next video (auto-next, a rail row in another tab): the page
   * hands its rail over. Resolves true when the page adopted it, false after ADOPT_MS or a newer handoff.
   * @param {{ rail: any, fromAutoNext?: boolean, browse?: string | null }} intent @returns {Promise<boolean>}
   */
  function railHandoff(intent) {
    if (adoptWait) adoptWait.done(false);
    if (disposed || !intent || !intent.rail) return Promise.resolve(false);
    if (intent.browse) {
      railBrowse = intent.browse;
      if (rail && railOpen) rail.open(intent.browse);
    }
    const id = ++adoptSeq;
    return new Promise((resolve) => {
      const timer = setTimeout(() => { postAny({ type: 'railHandoffCancel', id }); done(false); }, deps.adoptMs || ADOPT_MS);
      /** @param {boolean} ok */
      const done = (ok) => {
        clearTimeout(timer);
        if (adoptWait && adoptWait.id === id) adoptWait = null;
        resolve(ok);
      };
      adoptWait = { id, done };
      postAny({ type: 'railHandoff', id, rail: intent.rail, onEnd: intent.rail.onEnd, fromAutoNext: !!intent.fromAutoNext });
    });
  }

  // ---- adding and replacing videos ----
  /**
   * @param {any[] | undefined} picked @param {boolean} compare they show beside others (prepDeps)
   * @returns {Promise<ViewerClip[]>}
   */
  async function prepareAll(picked, compare) {
    const uris = (picked || []).filter(isViewable);
    /** @type {ViewerClip[]} */
    const out = [];
    /** @type {string[]} */
    const failed = [];
    for (const u of uris) {
      try { out.push(await prepareClip(u, prepDeps(u, compare))); }
      catch (e) {
        // The full error (an ENOENT names the path) stays in the host log; the page hears only the file's name.
        log(`cannot open ${path.basename(u.fsPath)}: ${errText(e)}`);
        failed.push(path.basename(u.fsPath));
      }
    }
    if (failed.length && !disposed) {
      toast(failed.length === 1 ? `${failed[0]} cannot be opened.` : `${failed.length} videos cannot be opened.`, 4000);
    }
    return out;
  }
  const firstDir = () => {
    const c = session.clips.find(isFileClip);
    return c && c.uri ? vscode.Uri.joinPath(c.uri, '..') : undefined;
  };
  /** A file of the clips' file system as a uri with their scheme and authority (remote windows too). @param {string} p */
  const uriOf = (p) => {
    const f = fileClipOf();
    const local = vscode.Uri.file(p);
    return /** @type {UriLike} */ (f ? f.uri.with({ path: local.path, fragment: '', query: '' }) : local);
  };
  /**
   * Adds a file to this panel (the page shows it beside the others). False: not added (a duplicate or a full panel
   * says so in the page).
   * @param {UriLike} uri
   */
  async function addUri(uri) {
    if (disposed || !isViewable(uri)) return false;
    const c = await prepareClip(uri, prepDeps(uri, true));
    const added = !disposed && session.addClip(c);
    if (added) log(`add ${c.label}`);
    return added;
  }
  /**
   * One video shown: `file` plays in its place. Several: it joins them.
   * @param {string} file @param {{ autoPlay?: boolean }} [opts] autoPlay: Autoplay went on (the page plays it from 0)
   */
  async function showFile(file, opts = {}) {
    const uri = uriOf(file);
    const only = session.clips.length === 1 ? session.clips[0] : null;
    if (!only) return addUri(uri);
    if (only.uri && fileKey(uri) === fileKey(/** @type {any} */ (only.uri))) return false;
    const c = await prepareClip(uri, prepDeps(uri, false));
    return !disposed && session.replaceClip(only.id, c, { autoPlay: !!opts.autoPlay });
  }

  // ---- the folder rail (a file on disk only) ----
  function railCtl() {
    const f = fileClipOf();
    if (rail || disposed || !deps.rail || !f) return rail;
    rail = folderRail.createFolderRail({
      fs: nodeFs.promises, post: (m) => session.post(m), cache: deps.rail.cache, probe: deps.rail.probe,
      authority: f.uri.authority || '', caseless: !!deps.rail.caseless, log,
      members: () => session.members(),
      current: () => { const c = session.clips; return c.length === 1 ? c[0].fsPath || null : null; },
    });
    session.setRail(rail);
    return rail;
  }
  /** The single video's place in its folder, for the bar's capsule and the rail's footer. */
  async function sendRailPos() {
    const c = session.clips;
    if (!deps.rail || c.length !== 1 || !c[0].fsPath || !isFileClip(c[0])) return;
    const id = c[0].id;
    const at = await folderRail.neighbourOf(nodeFs.promises, c[0].fsPath, 0);
    // The folder was read meanwhile: another video (or a second one) may show by now, and this answer is not its.
    const now = session.clips;
    if (disposed || now.length !== 1 || now[0].id !== id) return;
    session.post({ type: 'rail', op: 'pos', index: at.index, count: at.count });
  }
  /** @param {any} m */
  async function onRailMessage(m) {
    if (m.type === 'neighbour') {
      const c = session.clips;
      if (c.length !== 1 || !c[0].fsPath || (m.d !== 1 && m.d !== -1)) return undefined;
      const at = await folderRail.neighbourOf(nodeFs.promises, c[0].fsPath, m.d);
      if (disposed) return undefined;
      if (!at.target) { toast(m.d > 0 ? 'Last video in this folder' : 'First video in this folder'); return undefined; }
      // `auto`: Autoplay "Play next in folder" at the end of the video (media/folder-rail.js go): the next one plays.
      if (deps.openFolderFile) return deps.openFolderFile(viewer, at.target, { rail: m.rail, fromAutoNext: m.auto === true });
      await showFile(at.target, { autoPlay: m.auto === true });
      return sendRailPos();
    }
    const ctl = railCtl();
    const f = fileClipOf();
    if (!ctl || !deps.rail || !f) return undefined;
    return folderRail.routeRailMessage({
      ctl, prefs: deps.rail.prefs,
      startDir: () => railBrowse || ctl.dir() || path.dirname(f.fsPath),
      setOpen: (open) => { railOpen = open; },
      setBrowse: (dir) => { railBrowse = dir; },
      // Single video: opens the file in its own tab (tab swap) when the host provides openFolderFile, else in place.
      // Compare (2+): clicking a listed video toggles it in Compare (add if absent, remove if present).
      onVideo: async (e) => {
        if (session.clips.length === 1) {
          if (deps.openFolderFile) return deps.openFolderFile(viewer, e.path, { rail: m.rail, fromAutoNext: false });
          await showFile(e.path);
          return sendRailPos();
        }
        const uri = uriOf(e.path);
        const key = fileKey(uri);
        const existing = session.clips.find((c) => c.uri && fileKey(/** @type {any} */ (c.uri)) === key);
        if (existing) {
          log(`remove ${existing.label}`);
          return session.removeClip(existing.id);
        }
        return addUri(uri);
      },
      onCompareVideo: (e) => addUri(uriOf(e.path)),
      onCompareFolder: (e) => (deps.compareFolder ? deps.compareFolder(uriOf(e.path), viewer) : undefined),
    }, m);
  }

  session = createUnifiedSession({
    panel, initialClip: clip, maxVideos: deps.maxVideos ? deps.maxVideos() : undefined, renderHtml,
    openTarget: openTarget || null,
    onPost: (m) => {
      if (disposed) return;
      const msg = { ...m, page };
      if (link && m.type === 'nd') {
        // Over the simulated link; a page that was replaced or a panel that closed meanwhile never gets it.
        const at = page;
        link.sendDown(msg, () => { if (!disposed && at === page) webview.postMessage(msg); });
        return;
      }
      webview.postMessage(msg);
    },
    onPickVideo: async () => prepareAll(
      deps.pick ? await deps.pick(`Add to ${session.title}`, firstDir(), true) : undefined, true),
    onReplacePick: async (oldId) => {
      const old = clipOf(oldId);
      const picked = deps.pick ? await deps.pick(`Replace ${old ? old.label : 'video'}`, firstDir(), false) : undefined;
      return (await prepareAll(picked && picked.slice(0, 1), session.clips.length >= 2))[0];
    },
    onReadBlock: (c, m) => readBlock(/** @type {any} */ (c), m),
    onThumb: (c, m) => onThumb(/** @type {any} */ (c), m),
    onNative: (c, m) => onNative(/** @type {any} */ (c), m),
    onTileSize: () => resizeDecoders(),
    onCopyText: (text) => vscode.env.clipboard.writeText(text),
    onOpenSettings: () => vscode.commands.executeCommand('workbench.action.openSettings', '@ext:gordon-vidal.video-preview-enhanced'),
    onFocusMode: (what) => (deps.focusMode ? deps.focusMode(what) : undefined),
    onPlaybackPrefs: (m) => (deps.setPlaybackPrefs ? deps.setPlaybackPrefs(m, viewer) : undefined),
    onRailMessage,
    onLoadSubs: (c) => loadSubs(/** @type {any} */ (c)),
    onSaveFrame: (m, s) => {
      const c = /** @type {ViewerClip | null} */ (/** @type {any} */ (s.clipFor(m)));
      return c && deps.saveFrame ? deps.saveFrame(c, m, viewer) : undefined;
    },
    onCopyLink: (c, m) => copyLink(/** @type {any} */ (c), m),
    onExportAb: (kind, c, m) => exportAb(kind, /** @type {any} */ (c), m),
    onExactFrame: (c, m) => onExactFrame(/** @type {any} */ (c), m),
    onPos: (c, p) => onPos(/** @type {any} */ (c), p),
    onAction: (id, m) => onAction(id, m),
    onTranscodePref: (m) => onTranscodePref(m),
    onTranscodeResolution: (c, m) => onTranscodeResolution(/** @type {any} */ (c), m),
    onOriginalTile: (c) => (kinds.get(c.id) === 'stream' ? toBuiltIn(c.id) : undefined),
    onQuality: (c, m) => onQuality(/** @type {any} */ (c), m),
    onRailAdopted: (m) => { if (adoptWait && adoptWait.id === m.id) adoptWait.done(m.ok === true); },
    onExternal: (m) => {
      if (!deps.external) return undefined;
      return deps.external(/** @type {any} */ (session.clipFor(m)), viewer);
    },
    onOpenUrl: () => (deps.openUrl ? deps.openUrl() : undefined),
    onOther: (m) => (deps.onPageMessage ? deps.onPageMessage(m, viewer) : undefined),
  });
  // A clip the panel no longer shows: its file, decoder, watcher and saved position close; a new one is watched
  // and (on a ready page) gets its subtitles.
  session.onChange((e) => {
    if (e !== 'clips') return;
    // The tile count of a comparison, as it grows and shrinks in place (the tests read it; the tab title follows).
    if (!disposed && session.clips.length >= 2) log(`tiles: ${session.clips.length}`);
    const shown = new Set(session.clips.map((c) => c.id));
    for (const id of [...files.keys()]) if (!shown.has(id)) closeFile(id);
    for (const id of [...natives.keys()]) if (!shown.has(id)) closeNative(id);
    for (const id of [...watchers.keys()]) if (!shown.has(id)) unwatch(id);
    for (const id of [...resolutions.keys()]) if (!shown.has(id)) resolutions.delete(id);
    for (const id of [...subsSent]) if (!shown.has(id)) subsSent.delete(id);
    for (const [id, st] of [...positions]) {
      if (shown.has(id)) continue;
      positions.delete(id);
      // A closed (or reloaded) tile's last position is stored once more.
      if (st.pos && st.pos !== st.saved) savePos(st.clip, st);
    }
    for (const c of session.clips) {
      watch(/** @type {any} */ (c));
      if (session.ready) sendSubs(/** @type {any} */ (c)).catch((err) => log(`subtitles: ${errText(err)}`));
    }
  });
  watch(clip);
  const unregister = registry ? registry.add(session) : () => {};

  /** What the page is told once it is ready: subtitles, hidden notices, the ffmpeg pill, the folder position. */
  function onPageReady() {
    subsSent.clear();
    for (const c of session.clips) sendSubs(/** @type {any} */ (c)).catch((e) => log(`subtitles: ${errText(e)}`));
    if (deps.hiddenNotices) for (const id of deps.hiddenNotices() || []) if (NOTICES.has(id)) postAny({ type: id });
    if (deps.ffmpegState) {
      const at = page;
      Promise.resolve(deps.ffmpegState()).then((st) => {
        if (st && !disposed && at === page) postAny({ type: 'ffmpegState', installed: !!st.installed, offer: !!st.offer, mb: st.mb });
      }, () => {});
    }
    sendRailPos().catch((e) => log(`folder: ${e && e.code || e}`));
    if (deps.onReady) {
      try { deps.onReady(viewer); } catch (e) { log(`ready: ${errText(e)}`); }
    }
  }

  /** A message from the page. @param {any} m */
  function receive(m) {
    if (disposed || !m || typeof m !== 'object' || m.page !== page) return undefined;
    if (m.type === 'ready') {
      // A new document (VS Code can recreate one from the same HTML): its decoders and exports start over.
      origin = typeof m.origin === 'string' && ORIGIN.test(m.origin) ? m.origin : null;
      for (const id of [...natives.keys()]) closeNative(id);
      cancelExports();
      closeBenches();
    }
    if (m.type === 'log') { log(`webview: ${m.msg}`); return undefined; }
    const done = Promise.resolve(session.onMessage(m)).catch((e) => {
      log(`${m.type} failed: ${e && e.stack || e}`);
      // Never leak raw OS error messages (e.g. fs.stat ENOENT paths) into the webview toast.
      if (!disposed) toast('Video Preview action failed.');
    });
    if (m.type === 'ready') onPageReady();
    return done;
  }
  webview.onDidReceiveMessage((/** @type {any} */ m) => {
    if (link && m && m.type === 'nd') { link.sendUp(m, () => { receive(m); }); return undefined; }
    return receive(m);
  });

  function dispose() {
    if (disposed) return;
    // The last positions are stored on close.
    for (const c of session.clips) {
      const st = positions.get(c.id);
      if (st && st.pos && st.pos !== st.saved) savePos(/** @type {any} */ (c), st);
    }
    disposed = true;
    if (thumbJob) thumbJob.controller.abort();
    if (adoptWait) adoptWait.done(false);
    cancelExports();
    closeBenches();
    if (rail) { rail.dispose(); rail = null; }
    for (const id of [...watchers.keys()]) unwatch(id);
    for (const id of [...natives.keys()]) closeNative(id);
    for (const id of [...files.keys()]) closeFile(id);
    unregister();
    if (link) link.dispose();
    session.dispose();
    if (viewer.onDispose) viewer.onDispose();
    log('session closed');
  }
  panel.onDidDispose(dispose);
  panel.onDidChangeViewState(() => {
    if (disposed) return;
    session.setActive(!!panel.active);
    if (rail) { if (!panel.visible) rail.cancel(); else if (railOpen) rail.resume(); }
    if (!panel.visible && thumbJob) thumbJob.controller.abort();
    for (const [id, kind] of kinds) {
      const d = natives.get(id);
      if ((kind === 'stream' || kind === 'native') && d && d.setHidden) d.setHidden(!panel.visible);
    }
    session.post({ type: 'setVisible', visible: !!panel.visible, active: !!panel.active });
  });
  session.setActive(!!panel.active);

  const viewer = {
    session, panel, addUri, receive, dispose, grabFrame, railHandoff, useFullRes,
    /** The folder the rail is currently browsing, or null. */
    railDir: () => (rail ? rail.dir() : railBrowse),
    /** Host -> page, for the broadcasts every open page gets (playback prefs, Zen Mode, live settings). @param {any} m */
    post: (m) => session.post(m),
    /** An A-B export from a command: the page answers with its range (then: 'export' | 'clip' | 'ffmpeg'). @param {string} [then] */
    queryAb: (then) => postAny(then ? { type: 'abQuery', then } : { type: 'abQuery' }),
    /** A frame link opened on this panel: the page seeks there, paused. @param {any} target @param {string} [clipId] */
    goto: (target, clipId) => session.goto(target, clipId),
    /** A clip's file changed (or must be asked again): it reloads in its tile. @param {string} clipId */
    reloadClip: (clipId) => reprepare(clipId, 'reload'),
    /** The host decoder a clip plays through, or null (tests, the exact-frame grabber). @param {string} clipId */
    decoderOf: (clipId) => natives.get(clipId) || null,
    /** What a clip's host decoder is ('native', 'stream', 'source'), or null (decoded in the page). @param {string} clipId */
    decoderKind: (clipId) => kinds.get(clipId) || null,
    /** Native ffmpeg is decoding for this panel right now (the GPU test waits for it). */
    busy: () => [...natives.values()].some((d) => typeof d.busy === 'function' && d.busy()),
    /** Every file clip prepared again (ffmpeg was set up or changed): each reloads in its tile. @param {string} why */
    reloadAll: (why) => Promise.all(session.clips.map((c) => reprepare(c.id, why))),
    /** Live transcode tiles to the built-in decoder ("Use original video"); true when one switched. */
    useOriginalVideo: () => session.clips.filter((c) => kinds.get(c.id) === 'stream').map((c) => toBuiltIn(c.id)).some(Boolean),
    /** Native ffmpeg tiles of this panel play at a reduced size (the frame export warns). */
    lossyTiles: () => session.clips.filter((c) => { const d = natives.get(c.id); return !!d && typeof d.lossy === 'function' && d.lossy(); }),
    /** @type {(() => void) | null} */
    onDispose: null,
    /** Tests (src/debug-cmd.js benchFs): the frame server's port, the page's origin and the open benchmark channels. */
    framePort: deps.framePort,
    get webviewOrigin() { return origin; },
    benchChannels,
    get disposed() { return disposed; },
    /** Sets the page (the caller awaits what the page config needs first). */
    show() {
      if (!disposed) session.render();
      const n = session.clips.length;
      log(`opened, ${clip.size} bytes${clip.transcode ? ', live transcode' : clip.native ? ', native ffmpeg' : ''}${n >= 2 ? `, ${n} tiles` : ''}`);
    },
  };
  return viewer;
}
// checkJs: end

module.exports = { createUnifiedViewer, prepareClip, sourceClip, isViewable, clipIdOf, nativeHeightFor, ENTRY_SCRIPT };
