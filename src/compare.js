'use strict';
// Compare / multi-view: 2-4 videos in one webview panel with the player's bar and panels (2: side by
// side or split; 3-4: a 2x2 grid; docs/notes/compare-ui.md). The experimental setting compare.maxVideos
// allows up to 16 in a plain grid (docs/notes/multiview-engine.md). Opened from a player, it takes that tab's
// place, and "Leave compare" puts the player back there. The extension host only reads file blocks, exactly as
// for a single player; each decode engine in the webview asks for blocks with
// its own key, so both files (and the background scan's own readers) are served
// from here, also in remote windows.
// The vscode API comes from extension.js (deps.vscode), so tests can run this
// module with a fake one.
let vscode = null;
/** Open panels, for the test hook and setting changes (set by registerCompare). */
let compareSessions = null;
/** Tests: answers the next quick pick (items) without showing it; set through setPickHook. */
let testPick = null;
const setPickHook = (fn) => { testPick = fn; };
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { rotationOf } = require('./rotation');
const { NativeDecoder } = require('./native');
const { budgets } = require('../media/membudget');
const Grid = require('../media/compare-grid');
const frameserver = require('./frameserver');
const { barHtml } = require('./bar');
const { pickRows, pushRecent, droppedVideos } = require('./comparepick');
const { FRAME_SERVER_BPS, TRANSPORT_BPS, FRAME_SERVER_HEIGHT } = require('./decide');

const MAX_BLOCK = 8 * 1024 * 1024;
/** Videos in one panel at most (the setting compare.maxVideos picks 2-16; 4 by default). */
const MAX_TILES = Grid.MAX_VIDEOS;
const TILE_KEYS = Grid.TILE_KEYS;
/** The setting compare.maxVideos (experimental): how many videos one compare panel takes. */
function maxVideos() {
  try { return Grid.clampMax(vscode.workspace.getConfiguration('videoPreviewEnhanced').get('compare.maxVideos')); } catch { return Grid.DEFAULT_MAX; }
}
const VIDEO_EXT = /\.(avi|mkv|mov|wmv|flv|mpe?g|m2ts|mts|3gp|ogv|m4v|vob|divx|asf|mxf|y4m|mp4|webm)$/i;

/** Engine keys: 'A'-'P' for the tiles, 'sA' and 'sB' for the scan (of the first two). */
const fileOfKey = (key) => Math.max(0, TILE_KEYS.indexOf(String(key).slice(-1)));
// Like Session: fsPath is the real file for local files and, in SSH/WSL/container
// windows, for files on the remote machine (this is a workspace extension).
const FS_SCHEMES = new Set(['file', 'vscode-remote']);

/**
 * The compare page. Pure, so tests can render it without VS Code:
 * uri(...p) maps a media/ path to a webview URL.
 */
function compareHtml({ uri, cspSource, nonce, cfg, frameSource }) {
  const large = Grid.isLarge((cfg.names || []).length);
  const csp = [
    "default-src 'none'",
    `img-src ${cspSource} blob: data:`,
    `media-src ${cspSource} blob: data:`,
    `style-src ${cspSource}`,
    `script-src 'nonce-${nonce}' ${cspSource} blob: 'wasm-unsafe-eval'`,
    'worker-src blob:',
    ['connect-src', cspSource, 'blob:', frameSource].filter(Boolean).join(' '),
  ].join('; ');
  const json = JSON.stringify(cfg).replace(/</g, '\\u003c');
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp};">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${uri('player.css')}">
<link rel="stylesheet" href="${uri('compare.css')}">
</head><body class="compare">
<script type="application/json" id="cfg">${json}</script>
<div id="stage">
  <canvas id="canvas" hidden role="img" aria-label="Videos compared"></canvas>
  <div id="cells"></div>
  <div id="overlay"><div id="message">Opening…</div><div id="hint"></div></div>
  <div id="toast" hidden aria-hidden="true"></div>
</div>
${barHtml({ compare: true })}
<div id="panel" class="panel" role="dialog" aria-label="Player settings" hidden></div>
<div id="sheet" hidden></div>
<div id="menu" role="menu" aria-label="Video actions" hidden></div>
<div id="live" class="sr-only" role="status" aria-live="polite" aria-atomic="true"></div>
<script nonce="${nonce}" src="${uri('timestretch.js')}"></script>
<script nonce="${nonce}" src="${uri('framestream.js')}"></script>
<script nonce="${nonce}" src="${uri('hdr.js')}"></script>
<script nonce="${nonce}" src="${uri('engine.js')}"></script>
<script nonce="${nonce}" src="${uri('picture.js')}"></script>
<script nonce="${nonce}" src="${uri('modes.js')}"></script>
<script nonce="${nonce}" src="${uri('controls.js')}"></script>
${large ? `<script nonce="${nonce}" src="${uri('membudget.js')}"></script>
` : ''}<script nonce="${nonce}" src="${uri('compare-grid.js')}"></script>
<script nonce="${nonce}" src="${uri('compare.js')}"></script>
</body></html>`;
}

class CompareSession {
  /**
   * @param {vscode.ExtensionContext} context
   * @param {vscode.Uri[]} uris 2-16 files (the setting compare.maxVideos), A first
   */
  constructor(context, uris, { log, engineCfg, nativeFor, nativeQueue, transport = 'message', frameSource, vscode: api, pick, viewColumn, start, openPlayer, setPref, prefs, copyText }) {
    if (api) vscode = api;
    this.logRaw = log;
    this.engineCfg = engineCfg;
    this.nativeFor = nativeFor || null;
    this.nativeQueue = nativeQueue || (() => budgets(null).nativeQueue);
    this.transport = transport;
    this.frameSource = frameSource;
    this.pick = pick || null;
    this.openPlayer = openPlayer || null; // (uri, t, viewColumn): Leave compare
    this.setPref = setPref || null; // (key, value): the jump sizes, as in the player
    this.prefs = prefs || (() => null);
    this.copyText = copyText || ((t) => vscode.env.clipboard.writeText(t));
    this.start = start > 0 ? start : 0; // the player's position when it turned into compare (first page only)
    this.replaced = undefined; // the tile a "Replace video…" just changed (its offset starts at 0)
    this.noNative = new Set(); // files native ffmpeg failed on: built-in from then on
    this.natives = [];
    this.disposed = false;
    this.setFiles(uris);
    const media = vscode.Uri.joinPath(context.extensionUri, 'media');
    this.media = media;
    const panel = vscode.window.createWebviewPanel('videoPreviewEnhanced.compare', this.title(),
      viewColumn || vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [media] });
    panel.iconPath = new vscode.ThemeIcon('diff');
    this.panel = panel;
    this.webview = panel.webview;
    this.webview.html = this.html();
    this.webview.onDidReceiveMessage((m) => {
      // A replaced page can still have messages in flight, with tile keys now assigned to other files.
      if (this.disposed || !m || m.page !== this.page) return;
      this.onMessage(m).catch((e) => { if (m.page === this.page) this.fail(e); });
    });
    if (compareSessions) compareSessions.add(this);
    panel.onDidDispose(() => this.dispose());
    panel.onDidChangeViewState(() => this.post({ type: 'visible', visible: panel.visible }));
  }

  setFiles(uris) {
    this.uris = uris;
    this.files = uris.map((u) => u.fsPath);
    this.names = this.files.map((f) => path.basename(f));
    this.fhs = this.files.map(() => null);
    this.log = (m) => this.logRaw(`[compare ${this.names.join(' ↔ ')}] ${m}`);
  }

  title() { return this.names.length === 2 ? `${this.names[0]} ↔ ${this.names[1]}` : this.names.join(' · '); }

  /** A new set of files: the page starts again (its saved state keeps position, offsets, clock and sound). */
  reload(uris) {
    this.closeFiles();
    if (uris) {
      this.setFiles(uris);
      this.panel.title = this.title();
    }
    this.webview.html = this.html();
  }

  closeFiles() {
    // A reload or a second 'ready' makes any native probe still in flight stale (review 2026-11-19 #1).
    this.epoch = (this.epoch || 0) + 1;
    for (const n of this.natives) if (n) n.dispose();
    this.natives = [];
    this.decisions = null;
    this.tile = null;
    for (const p of this.fhs) if (p) p.then((h) => h.fh.close(), () => {}).catch(() => {});
    this.fhs = this.files.map(() => null);
  }

  html() {
    const w = this.webview;
    const uri = (...p) => w.asWebviewUri(vscode.Uri.joinPath(this.media, ...p)).toString();
    const ec = this.engineCfg(w);
    this.rotation = this.files.map(rotationOf);
    const cfg = {
      page: this.page = (this.page || 0) + 1,
      names: this.names,
      dirs: this.files.map((f) => path.dirname(f)),
      engine: ec,
      rotation: this.rotation,
      debug: ec.debug,
      prefs: this.prefs(),
      start: this.start,
      replaced: this.replaced,
      maxVideos: maxVideos(),
    };
    this.start = 0;
    this.replaced = undefined;
    return compareHtml({ uri, cspSource: w.cspSource, nonce: crypto.randomBytes(16).toString('base64'), cfg, frameSource: this.frameSource });
  }

  post(msg) { if (!this.disposed) this.webview.postMessage({ ...msg, page: this.page }); }

  fail(err) {
    this.log(`error: ${err && err.stack ? err.stack : err}`);
    this.post({ type: 'error', message: String(err && err.message ? err.message : err) });
  }

  async onMessage(m) {
    switch (m.type) {
      case 'ready': {
        this.closeFiles();
        const epoch = this.epoch;
        this.tile = m.tile;
        const origin = typeof m.origin === 'string' && /^vscode-webview:\/\/[a-z0-9-]+$/.test(m.origin) ? m.origin : null;
        // Chromium keeps at most six HTTP/1.1 requests open to one origin: more native tiles use WebSockets.
        const transport = !origin ? 'message' : this.transport === 'http' && Grid.isLarge(this.files.length) ? 'ws' : this.transport;
        this.liveTransport = transport;
        const [sizes, decisions] = await Promise.all([
          Promise.all(this.files.map((f) => fs.promises.stat(f).then((s) => s.size))),
          Promise.all(this.files.map((f, i) => this.chooseNative(f, i, transport))),
        ]);
        if (this.disposed || epoch !== this.epoch) return undefined;
        this.decisions = decisions;
        const heights = this.tileHeights();
        const maxQueued = Grid.nativeQueuePerTile(this.nativeQueue(), this.files.length);
        const native = decisions.map((d, i) => this.startNative(i, d, heights[i], transport, origin, epoch, maxQueued));
        this.log(`opened, ${sizes.join(' / ')} bytes, ${this.files.length} tiles`);
        this.post({ type: 'open', sizes, native });
        return undefined;
      }
      case 'tileSize': {
        this.tile = m.tile;
        this.resizeTiles();
        return undefined;
      }
      case 'stop': this.closeFiles(); return undefined;
      case 'readBlock': return this.readBlock(m.key, m.pos, m.len);
      case 'nd': { const n = this.natives[fileOfKey(m.key)]; return n ? n.handle(m.m) : undefined; }
      case 'add': return this.addVideos();
      case 'replace': return this.replaceVideo(Number(m.index));
      case 'leave': return this.leave(Number(m.keep), Number(m.t));
      case 'pref': return this.setPref ? this.setPref(m.key, m.value) : undefined;
      case 'copyText': return this.copyText(String(m.text || ''));
      case 'openSettings': return vscode.commands.executeCommand('workbench.action.openSettings', '@ext:gordon-vidal.video-preview-enhanced');
      case 'focusMode': return vscode.commands.executeCommand('workbench.action.toggleZenMode');
      case 'remove': {
        const i = Number(m.index);
        if (!Number.isInteger(i) || i < 0 || i >= this.uris.length || this.uris.length <= 2) return undefined;
        this.log(`remove ${this.names[i]}`);
        this.reload(this.uris.filter((_, j) => j !== i));
        return undefined;
      }
      case 'fullRes': {
        // Metrics on the files' real pixels: the built-in decoder for every tile (review 2026-11-19 #2).
        if (!this.natives.some(Boolean)) return undefined;
        this.log('full resolution: built-in decoder for all tiles');
        for (const f of this.files) this.noNative.add(f);
        this.reload();
        return undefined;
      }
      case 'log': this.log(`webview: ${m.msg}`); return undefined;
      default: return undefined;
    }
  }

  async chooseNative(file, i, transport) {
    if (!this.nativeFor || this.noNative.has(file)) return null;
    try { return await this.nativeFor(file, transport); }
    catch (e) { this.log(`tile ${TILE_KEYS[i]}: native check failed: ${e.message}`); return null; }
  }

  /** New output sizes for every native tile (stage resized, or a tile's link changed). */
  resizeTiles() {
    if (!this.decisions) return;
    const tiles = [];
    this.tileHeights().forEach((h, i) => {
      const n = this.natives[i];
      if (n && n.resize(h, Math.min(h, this.decisions[i].messageMaxHeight))) tiles.push(i);
    });
    if (tiles.length) this.post({ type: 'resize', tiles });
  }

  /** Fit the composited view to the stage, then scale all native outputs together to fit the link. */
  tileHeights() {
    const { w, h, cols, rows, aspect, rate, actual } = this.tile || {};
    // Fill, Stretch, 100 % and zoom show a picture larger (or smaller) than the plain Fit: the page says by how much (media/compare.js frameFactor).
    const factor = Number(this.tile && this.tile.factor) > 0 ? Math.max(0.1, Math.min(64, Number(this.tile.factor))) : 1;
    // The page's grid (2x1, 2x2, ... 4x4); older pages sent 1 or 2.
    const nc = Math.max(1, Math.min(Grid.MAX_VIDEOS, Math.floor(Number(cols)) || 1));
    const nr = Math.max(1, Math.min(Grid.MAX_VIDEOS, Math.floor(Number(rows)) || 1));
    let tw = !actual && w > 0 ? (w / nc) * factor : Infinity;
    let th = !actual && h > 0 ? (h / nr) * factor : Infinity;
    const rotated = (i) => this.rotation[i] % 180 !== 0;
    const first = this.decisions[0]?.probed?.video;
    // The first tile's shape: from ffprobe, else (a large grid whose first tile is built-in) the page's.
    const firstAspect = first && first.width && first.height ? (rotated(0) ? first.height / first.width : first.width / first.height)
      : Number(aspect) > 0.05 && Number(aspect) < 20 ? Number(aspect) : 0;
    if (firstAspect) {
      tw = Math.min(tw, th * firstAspect);
      th = Math.min(th, tw / firstAspect);
    }
    let bytes = 0;
    let rounding = 0;
    const large = Grid.isLarge(this.decisions.length);
    const heights = this.decisions.map((d, i) => {
      const v = d?.probed?.video;
      if (!d?.tools || !v || !v.width || !v.height) return d?.maxHeight || FRAME_SERVER_HEIGHT;
      const [w, h] = rotated(i) ? [th, tw] : [tw, th];
      const height = Math.min(v.height, d.maxHeight, h, w * v.height / v.width);
      bytes += 1.5 * height * height * v.width / v.height * (v.fps || 30);
      // ffmpeg rounds each width up to even: at 16 small tiles that adds up, so leave room for it.
      if (large) rounding += 0.75 * height * (v.fps || 30);
      return height;
    });
    const speed = Number.isFinite(rate) ? Math.max(1, rate) : 1;
    // Messages carry far less than the frame server: once any tile is on them, all share that budget (review 2026-11-19-3 M2).
    const onMessages = this.liveTransport === 'message' || this.natives.some((n) => n && n.link === 'message');
    const budget = (onMessages ? TRANSPORT_BPS : FRAME_SERVER_BPS) / speed;
    const scale = Math.min(1, Math.sqrt(Math.max(0, budget - rounding) / bytes));
    return heights.map((h) => Math.max(2, Math.floor(h * scale / 2) * 2));
  }

  startNative(i, d, maxHeight, transport, origin, epoch, maxQueued) {
    if (!d || !d.tools) {
      if (d) this.log(`tile ${TILE_KEYS[i]}: built-in: ${d.reason}`);
      return false;
    }
    const file = this.files[i];
    const key = TILE_KEYS[i];
    this.log(`tile ${key}: native ffmpeg (${d.method}) at up to ${maxHeight}p: ${d.reason}`);
    this.natives[i] = new NativeDecoder({
      tools: d.tools, file, maxHeight, messageMaxHeight: Math.min(maxHeight, d.messageMaxHeight),
      method: d.method, methodGuessed: !!d.methodGuessed, probed: d.probed, transport, origin, maxQueued,
      largeGrid: Grid.isLarge(this.files.length),
      onMessages: () => { if (!this.disposed && epoch === this.epoch) this.resizeTiles(); },
      post: (msg) => this.post({ type: 'nd', key, m: msg }), postRaw: (msg) => this.post({ ...msg, key }),
      log: (msg) => this.log(`tile ${key}: ${msg}`),
      onFail: (err) => {
        if (this.disposed || epoch !== this.epoch) return;
        this.log(`tile ${key}: native ffmpeg failed (${err && err.message || err}); built-in decoder from now on`);
        this.noNative.add(file);
        this.reload();
      },
    });
    return true;
  }

  /** "Add video…" in the page: up to the setting's count (compare.maxVideos). */
  async addVideos() {
    const room = maxVideos() - this.uris.length;
    if (room <= 0 || !this.pick) return;
    const picked = await this.pick(`Add to ${this.title()}`, vscode.Uri.joinPath(this.uris[0], '..'), true);
    if (!picked || !picked.length || this.disposed) return;
    this.addUris(picked);
  }

  /** Adds files after the ones shown (up to the setting's count); also the test hook's `compareAdd`. */
  addUris(picked) {
    if (this.disposed) return;
    // The room is taken now, not before the dialog: the view can change while it is open.
    const max = maxVideos();
    const room = Math.max(0, max - this.uris.length);
    const files = picked.filter((u) => FS_SCHEMES.has(u.scheme));
    const add = files.slice(0, room);
    if (files.length > room) vscode.window.showWarningMessage(`Video Preview: compare shows up to ${max} videos; added ${add.length}.`);
    if (!add.length) return;
    this.log(`add ${add.map((u) => path.basename(u.fsPath)).join(', ')}`);
    this.reload([...this.uris, ...add]);
  }

  /** "Replace video…": tile i shows another file (picked in VS Code's open dialog). */
  async replaceVideo(i) {
    if (!Number.isInteger(i) || i < 0 || i >= this.uris.length || !this.pick) return;
    const picked = await this.pick(`Replace ${TILE_KEYS[i]}`, vscode.Uri.joinPath(this.uris[i], '..'), false);
    if (!picked || !picked.length || this.disposed) return;
    this.replaceUri(i, picked[0]);
  }

  /** Tile i becomes `uri` (also the test hook's `compareReplace`). */
  replaceUri(i, uri) {
    if (this.disposed || !(i >= 0 && i < this.uris.length) || !uri || !FS_SCHEMES.has(uri.scheme)) return;
    this.log(`replace ${this.names[i]} with ${path.basename(uri.fsPath)}`);
    this.replaced = i;
    this.reload(this.uris.map((u, j) => (j === i ? uri : u)));
  }

  /** "Leave compare": the player opens video `keep` at `t` (its own seconds) in this tab's place. */
  async leave(keep, t) {
    if (this.disposed || !Number.isInteger(keep) || keep < 0 || keep >= this.uris.length) return;
    const uri = this.uris[keep];
    const column = this.panel.viewColumn;
    this.log(`leave, keep ${this.names[keep]} at ${Number.isFinite(t) ? t.toFixed(3) : 0} s`);
    if (this.openPlayer) await this.openPlayer(uri, Number.isFinite(t) && t > 0 ? t : 0, column);
    this.panel.dispose();
  }

  /** One open per file, even when reads race; the size is taken at open. */
  blockFile(i) {
    if (!this.fhs[i]) {
      const p = fs.promises.open(this.files[i], 'r').then(async (fh) => {
        try { return { fh, size: (await fh.stat()).size }; } catch (e) { fh.close().catch(() => {}); throw e; }
      });
      p.catch(() => { if (this.fhs[i] === p) this.fhs[i] = null; });
      this.fhs[i] = p;
    }
    return this.fhs[i];
  }

  async readBlock(key, pos, len) {
    // A reply after a reload would reach the new page under a tile key now used by another file.
    const epoch = this.epoch;
    let data = new Uint8Array(0);
    try {
      const { fh, size } = await this.blockFile(fileOfKey(key));
      const n = Math.max(0, Math.min(len, MAX_BLOCK, size - pos));
      const buf = Buffer.alloc(n);
      const { bytesRead } = n ? await fh.read(buf, 0, n, pos) : { bytesRead: 0 };
      data = new Uint8Array(buf.buffer, buf.byteOffset, bytesRead);
    } catch (e) {
      if (epoch === this.epoch) this.fail(e);
    }
    // Always answer (empty on error), or the engine keeps the block in flight forever.
    if (epoch === this.epoch) this.post({ type: 'block', key, pos, data });
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (compareSessions) compareSessions.delete(this);
    this.closeFiles();
    this.log('closed');
  }
}

/**
 * Commands: Explorer "Compare / Play Together" (2-4 files selected; up to 16 with compare.maxVideos) and
 * "Compare With…" (the open player's file against one picked in a dialog).
 * deps: { vscode, log, sessions (open player Sessions), engineCfg(webview), nativeFor?(file, transport), nativeQueue?() }
 */
function registerCompare(context, deps) {
  vscode = deps.vscode;
  compareSessions = deps.compareSessions || null;
  /** Opens compare; `from` (a player Session) is replaced in its tab, `t` is where it was. */
  const open = async (list, { from, t } = {}) => {
    for (const u of list) {
      if (!FS_SCHEMES.has(u.scheme)) {
        vscode.window.showWarningMessage(`Video Preview: can't compare ${u.toString()} (not a file).`);
        return;
      }
    }
    deps.log(`compare: ${list.map((u) => u.fsPath).join(' <-> ')}`);
    if (deps.recent) for (const u of [...list].reverse()) deps.recent.set(pushRecent(deps.recent.get(), u.toString()));
    let transport = deps.nativeTransport ? deps.nativeTransport() : 'message';
    let frameSource;
    if (transport !== 'message') {
      try {
        await frameserver.start();
        frameSource = `${transport === 'ws' ? 'ws' : 'http'}://127.0.0.1:${frameserver.port}`;
        // More than 4 native tiles go over WebSockets (CompareSession 'ready'); the page may connect both ways.
        if (transport === 'http') frameSource += ` ws://127.0.0.1:${frameserver.port}`;
      } catch (e) {
        deps.log(`compare: frame server could not start: ${e.message}`);
        transport = 'message';
      }
    }
    const viewColumn = from && from.panel ? from.panel.viewColumn : undefined;
    const session = new CompareSession(context, list, { ...deps, transport, frameSource, pick: pickMany, viewColumn, start: t });
    // In place: the player's tab closes once compare has opened beside it in the same group.
    if (from && from.panel && !from.disposed) from.panel.dispose();
    return session;
  };
  const pickMany = async (label, defaultUri, many) => {
    const r = await vscode.window.showOpenDialog({
      canSelectMany: !!many, openLabel: label, defaultUri,
      filters: { Videos: ['mp4', 'mkv', 'mov', 'webm', 'avi', 'wmv', 'flv', 'mpg', 'mpeg', 'm2ts', 'mts', 'ts', '3gp', 'ogv', 'm4v', 'vob', 'mxf', 'y4m', 'asf', 'divx'], 'All files': ['*'] },
    });
    return r;
  };
  const pick = async (label, defaultUri) => { const r = await pickMany(label, defaultUri); return r && r[0]; };
  const activePlayerUri = () => {
    for (const s of deps.sessions) if (s.panel && s.panel.active && !s.sequence && !s.url) return s.uri;
    return null;
  };
  /** The open player showing `uri` (the active one first): compare replaces it in place. */
  const playerOf = (uri) => {
    const key = uri.toString();
    const all = [...deps.sessions].filter((s) => s.panel && !s.sequence && !s.url && s.uri && s.uri.toString() === key);
    return all.find((s) => s.panel.active) || all.find((s) => s.panel.visible) || null;
  };
  /** The quick pick's rows for video `a`: its folder, the workspace, Browse… (src/comparepick.js). */
  const pickItems = async (a) => {
    const folderUri = vscode.Uri.joinPath(a, '..');
    let folder = [];
    try { folder = (await vscode.workspace.fs.readDirectory(folderUri)).filter(([, ty]) => ty !== 2).map(([n]) => vscode.Uri.joinPath(folderUri, n).toString()); } catch { /* unreadable folder: workspace only */ }
    let workspace = [];
    try {
      const found = vscode.workspace.findFiles ? await vscode.workspace.findFiles('**/*.{avi,mkv,mov,wmv,flv,mpg,mpeg,m2ts,mts,3gp,ogv,m4v,vob,divx,asf,mxf,y4m,mp4,webm}', '**/node_modules/**', 300) : [];
      workspace = found.map((u) => u.toString());
    } catch { /* no workspace */ }
    return pickRows({ current: a.toString(), folder, workspace, recent: deps.recent ? deps.recent.get() : [] }).map((r) => (
      r.kind === 'sep' ? { kind: vscode.QuickPickItemKind ? vscode.QuickPickItemKind.Separator : -1, label: r.label }
        : { label: r.kind === 'browse' ? '$(folder-opened) Browse…' : r.label, browse: r.kind === 'browse', uri: r.uri,
          description: r.uri && !folder.includes(r.uri) ? vscode.workspace.asRelativePath ? vscode.workspace.asRelativePath(vscode.Uri.parse(r.uri), false) : '' : '' }));
  };
  /** Key D in the player: quick pick of other videos (same folder first), then compare in this tab's place. */
  const comparePick = async (uri, opts) => {
    const a = (uri instanceof vscode.Uri ? uri : null) || activePlayerUri();
    if (!a) return undefined;
    const items = await pickItems(a);
    const chosen = await (testPick ? testPick(items) : vscode.window.showQuickPick(items, { placeHolder: `Compare ${path.basename(a.fsPath)} with…`, matchOnDescription: true }));
    if (!chosen) return undefined;
    if (chosen.browse) return vscode.commands.executeCommand('videoPreviewEnhanced.compareWith', a, opts);
    const b = vscode.Uri.parse(chosen.uri);
    const from = playerOf(a);
    const t = opts && Number.isFinite(opts.t) ? opts.t : from && from.pos ? from.pos.t : 0;
    return open([a, b], { from, t });
  };
  /** Videos dropped on the player (uri strings from the page): compare takes the player's place. */
  const compareDrop = async (uri, dropped, opts) => {
    const a = uri instanceof vscode.Uri ? uri : null;
    if (!a) return undefined;
    const files = droppedVideos(dropped).map((s) => { try { return vscode.Uri.parse(s); } catch { return null; } })
      .filter((u) => u && FS_SCHEMES.has(u.scheme) && u.toString() !== a.toString());
    if (!files.length) return undefined;
    const max = maxVideos();
    if (files.length > max - 1) vscode.window.showWarningMessage(`Video Preview: compare shows up to ${max} videos; showing the first ${max}.`);
    const from = playerOf(a);
    const t = opts && Number.isFinite(opts.t) ? opts.t : from && from.pos ? from.pos.t : 0;
    return open([a, ...files.slice(0, max - 1)], { from, t });
  };
  context.subscriptions.push(
    vscode.commands.registerCommand('videoPreviewEnhanced.comparePick', comparePick),
    vscode.commands.registerCommand('videoPreviewEnhanced.compareDrop', compareDrop),
    vscode.commands.registerCommand('videoPreviewEnhanced.compare', async (uri, uris, opts) => {
      let list = Array.isArray(uris) && uris.length ? uris : uri ? [uri] : [];
      list = list.filter((u) => VIDEO_EXT.test(u.path));
      const max = maxVideos();
      if (list.length > max) vscode.window.showWarningMessage(`Video Preview: compare shows up to ${max} videos; showing the first ${max}.`);
      if (list.length >= 2) return open(list.slice(0, max), opts && opts.from ? opts : {}); // opts: the test hook's in-place open
      const a = list[0] || activePlayerUri() || await pick('Compare: video A');
      if (!a) return undefined;
      const b = await pick(`Compare with ${path.basename(a.fsPath)} (B)`, vscode.Uri.joinPath(a, '..'));
      return b ? open([a, b]) : undefined;
    }),
    // From a player (Tools › Compare in its settings panel, its right-click "Compare With…", the editor title
    // button): up to 3 more files (more with compare.maxVideos), and compare takes the player's place. opts (from the page): { t } its position.
    vscode.commands.registerCommand('videoPreviewEnhanced.compareWith', async (uri, opts) => {
      const a = (uri instanceof vscode.Uri ? uri : null) || activePlayerUri() || await pick('Compare: video A');
      if (!a) return undefined;
      const more = await pickMany(`Compare with ${path.basename(a.fsPath)}`, vscode.Uri.joinPath(a, '..'), true);
      if (!more || !more.length) return undefined;
      const files = more.filter((u) => FS_SCHEMES.has(u.scheme) && u.toString() !== a.toString());
      if (!files.length) return undefined;
      const max = maxVideos();
      if (files.length > max - 1) vscode.window.showWarningMessage(`Video Preview: compare shows up to ${max} videos; showing the first ${max}.`);
      const from = playerOf(a);
      const t = opts && !Array.isArray(opts) && Number.isFinite(opts.t) ? opts.t : from && from.pos ? from.pos.t : 0;
      return open([a, ...files.slice(0, max - 1)], { from, t });
    }),
  );
}

module.exports = { registerCompare, setPickHook, compareHtml, CompareSession, fileOfKey, MAX_TILES, maxVideos };
