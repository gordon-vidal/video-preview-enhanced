'use strict';
// Compare / multi-view: up to 16 videos in one webview panel with the player's bar and panels (2: side by
// side or split; 3-4: a 2x2 grid; 5-16: a larger static grid, docs/notes/multiview-engine.md).
// Opened from a player, it takes that tab's place, and "Leave compare" puts the player back there.
// The extension host only reads file blocks, exactly as
// for a single player; each decode engine in the webview asks for blocks with
// its own key, so both files (and the background scan's own readers) are served
// from here, also in remote windows.
// The vscode API comes from extension.js (deps.vscode), so tests can run this
// module with a fake one.
let vscode = null;
/** Tests: answers the next quick pick (items) without showing it; set through setPickHook. */
let testPick = null;
const setPickHook = (fn) => { testPick = fn; };
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { rotationOf } = require('./rotation');
const { NativeDecoder } = require('./native');
const { EncodedStream } = require('./stream');
const { MODES, compareCapsKbps, compareTileSize } = require('./transcode_policy');
const { budgets } = require('../media/membudget');
const Grid = require('../media/compare-grid');
const frameserver = require('./frameserver');
const { barHtml } = require('./bar');
const { toggleFocusMode } = require('./focus-mode');
const { pickRows, pushRecent, droppedVideos, folderVideos, planAddToCompare } = require('./comparepick');
const { createAddMode, startsInAddMode, addToCompareOrigin } = require('./addmode');
const { createCompareMenu } = require('./comparemenu');
const { BURST_WINDOW_MS, createBurst, leftoverTabs, togetherNotice } = require('./burst');
const { FRAME_SERVER_BPS, TRANSPORT_BPS, FRAME_SERVER_HEIGHT } = require('./decide');

const MAX_BLOCK = 8 * 1024 * 1024;
/** Videos in one panel at most (the setting compare.maxVideos picks 2-16; 8 by default). */
const MAX_TILES = Grid.MAX_VIDEOS;
const TILE_KEYS = Grid.TILE_KEYS;
/** The setting compare.maxVideos: how many videos one compare panel takes. */
function maxVideos() {
  try { return Grid.clampMax(vscode.workspace.getConfiguration('videoPreviewEnhanced').get('compare.maxVideos')); } catch { return Grid.DEFAULT_MAX; }
}
/** The setting compare.openTogether: several videos opened at once (an Explorer multi-selection) become one compare. */
function openTogether() {
  try { return vscode.workspace.getConfiguration('videoPreviewEnhanced').get('compare.openTogether', true) !== false; } catch { return true; }
}
const VIDEO_EXT = /\.(avi|mkv|mov|wmv|flv|mpe?g|m2ts|mts|3gp|ogv|m4v|vob|divx|asf|mxf|y4m|mp4|webm)$/i;

/** Engine keys: 'A'-'P' for the tiles, 'sA' and 'sB' for the scan (of the first two). */
const fileOfKey = (key) => Math.max(0, TILE_KEYS.indexOf(String(key).slice(-1)));
// Like Session: fsPath is the real file for local files and, in SSH/WSL/container
// windows, for files on the remote machine (this is a workspace extension).
const FS_SCHEMES = new Set(['file', 'vscode-remote']);
const fileKey = (uri) => uri.with({ query: '', fragment: '' }).toString();

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
  <div id="cells"${large ? ' class="dense"' : ''}></div>
  <div id="reorderHint" hidden>Drag tiles to reorder · Esc or Done to finish</div>
  <div id="addHint" hidden>
    <span id="addHintText" role="status"></span>
    <button id="stopAddBtn" type="button" title="Stop Add Mode">Stop</button>
  </div>
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
<script nonce="${nonce}" src="${uri('range-drag.js')}"></script>
<script nonce="${nonce}" src="${uri('controls.js')}"></script>
<script nonce="${nonce}" src="${uri('abloop.js')}"></script>
<script nonce="${nonce}" src="${uri('comparerange.js')}"></script>
<script nonce="${nonce}" src="${uri('stepgoal.js')}"></script>
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
  constructor(context, uris, {
    log, engineCfg, nativeFor, nativeQueue, transport = 'message', frameSource, vscode: api, pick, viewColumn,
    start, openPlayer, setPref, prefs, copyText, addMode, setTranscodePref, offerTranscode, menu, exportClips,
  }) {
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
    this.setTranscodePref = setTranscodePref;
    this.offerTranscode = offerTranscode;
    this.exportClips = exportClips;
    this.addMode = addMode || null;
    this.menu = menu;
    this.copyText = copyText || ((t) => vscode.env.clipboard.writeText(t));
    this.start = start > 0 ? start : 0; // the player's position when it turned into compare (first page only)
    this.replaced = undefined; // the tile a "Replace video…" just changed (its offset starts at 0)
    this.noNative = new Set(); // files native ffmpeg failed on: built-in from then on
    this.originalTiles = []; // indexed by tile occurrence, including duplicate URIs
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
    panel.onDidDispose(() => this.dispose());
    panel.onDidChangeViewState(() => {
      this.post({ type: 'visible', visible: panel.visible, active: panel.active });
      if (panel.active) this.menu?.activated(this);
    });
    this.menu?.opened(this);
  }

  setFiles(uris) {
    this.uris = uris;
    this.files = uris.map((u) => u.fsPath);
    this.names = this.files.map((f) => path.basename(f));
    this.order = Grid.tileOrder(uris.length, this.order);
    this.fhs = this.files.map(() => null);
    this.log = (m) => this.logRaw(`[compare ${this.names.join(' ↔ ')}] ${m}`);
  }

  title() {
    const names = this.order.map((i) => this.names[i]);
    return names.join(names.length === 2 ? ' ↔ ' : ' · ');
  }

  /** A new set of files: the page starts again with its saved order, position, offsets, clock and sound. */
  reload(uris) {
    this.closeFiles();
    if (uris) {
      this.setFiles(uris);
      this.panel.title = this.title();
      if (this.addMode) this.addMode.sync(this);
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
    this.transcodePrefs = this.prefs();
    this.rotation = this.files.map(rotationOf);
    const cfg = {
      page: this.page = (this.page || 0) + 1,
      names: this.names,
      dirs: this.files.map((f) => path.dirname(f)),
      engine: ec,
      rotation: this.rotation,
      debug: ec.debug,
      prefs: this.transcodePrefs,
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
          Promise.all(this.files.map((f, i) => this.chooseNative(f, transport, i))),
        ]);
        if (this.disposed || epoch !== this.epoch) return undefined;
        this.decisions = decisions;
        if (!this.transcodePrompted && decisions.some((d) => d?.promptTranscode) && this.offerTranscode) {
          this.transcodePrompted = true;
          this.offerTranscode(this).catch((e) => this.log(`live transcode prompt failed: ${e.message}`));
        }
        const heights = this.tileHeights();
        const outputs = this.transcodeOutputs();
        const maxQueued = Grid.nativeQueuePerTile(this.nativeQueue(), this.files.length);
        const native = decisions.map((d, i) => outputs[i]
          ? this.startTranscode(i, d, outputs[i], epoch)
          : this.startNative(i, d, heights[i], transport, origin, epoch, maxQueued));
        this.log(`opened, ${sizes.join(' / ')} bytes, ${this.files.length} tiles`);
        this.post({ type: 'open', sizes, native, visible: this.panel.visible !== false });
        // A video added from the Explorer reloads the page: the mode's hint shows again on the new one.
        const hint = this.addMode && this.addMode.hint(this);
        if (hint) this.post(hint);
        return undefined;
      }
      case 'tileSize': {
        this.tile = m.tile;
        this.resizeTiles();
        return undefined;
      }
      case 'stop': this.closeFiles(); return undefined;
      case 'tileOrder':
        this.order = Grid.tileOrder(this.names.length, m.order);
        this.panel.title = this.title();
        return undefined;
      case 'readBlock': return this.readBlock(m.key, m.pos, m.len);
      case 'nd': {
        const i = TILE_KEYS.indexOf(m.key);
        const n = m.key?.length === 1 && this.natives[i];
        if (!n || !m.m) return undefined;
        // The panel can hide after the host sent the page its initial visibility.
        if (m.m.type === 'open' && n instanceof EncodedStream && this.panel.visible === false) n.setHidden(true);
        return n.handle(m.m);
      }
      case 'add': return this.addVideos();
      case 'clipRange': {
        if (!this.exportClips || !this.uris[m.clock]) return undefined;
        const order = Grid.tileOrder(this.uris.length, m.order);
        const jobs = order.map((i, slot) => ({ uri: this.uris[i], letter: TILE_KEYS[slot], range: m.ranges?.[i], tile: i }));
        return this.exportClips(this, m.ranges ? jobs : [], this.uris[m.clock], true);
      }
      case 'addMode': return this.addMode?.toggle(this); // Shift+D, the Compare panel's switch
      case 'startAddMode': return this.addMode?.start(this); // Add video
      case 'stopAddMode': return this.addMode?.stop(this); // Esc in the page
      case 'replace': return this.replaceVideo(Number(m.index));
      case 'leave': return this.leave(Number(m.keep), Number(m.t));
      case 'pref': return this.setPref ? this.setPref(m.key, m.value) : undefined;
      case 'transcodePref': {
        if (!this.setTranscodePref) return undefined;
        if (MODES.includes(m.mode)) return this.setTranscodePref('transcode', m.mode);
        if (Number.isFinite(m.maxBitrateMbps) && m.maxBitrateMbps >= 0) {
          return this.setTranscodePref('transcodeMaxBitrate', m.maxBitrateMbps);
        }
        if (typeof m.splitBitrate === 'boolean') return this.setTranscodePref('transcodeSplitBitrate', m.splitBitrate);
        return undefined;
      }
      case 'originalTile': return this.useOriginalTile(m.index);
      case 'copyText': return this.copyText(String(m.text || ''));
      case 'openSettings': return vscode.commands.executeCommand('workbench.action.openSettings', '@ext:gordon-vidal.video-preview-enhanced');
      case 'focusMode': return toggleFocusMode(vscode);
      case 'remove': {
        const i = Number(m.index);
        if (!Number.isInteger(i) || i < 0 || i >= this.uris.length || this.uris.length <= 2) return undefined;
        this.log(`remove ${this.names[i]}`);
        this.originalTiles.splice(i, 1);
        this.order = Grid.orderAfterRemoval(this.order, i);
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

  async chooseNative(file, transport, i) {
    if (!this.nativeFor || this.noNative.has(file) || this.originalTiles[i] === this.uris[i]) return null;
    try {
      const videoCell = { h: this.tile?.h / (this.tile?.rows || 1) };
      return await this.nativeFor(file, transport, videoCell);
    }
    catch (e) { this.log(`native check failed for ${path.basename(file)}: ${e.message}`); return null; }
  }

  /** New output sizes for every native tile (stage resized, or a tile's link changed). */
  resizeTiles() {
    if (!this.decisions) return;
    const tiles = [];
    this.tileHeights().forEach((h, i) => {
      const n = this.natives[i];
      if (n instanceof NativeDecoder && n.resize(h, Math.min(h, this.decisions[i].messageMaxHeight))) tiles.push(i);
    });
    if (tiles.length) this.post({ type: 'resize', tiles });
    this.resizeTranscodes();
  }

  updateTranscode(prefs) {
    const previous = this.transcodePrefs;
    this.transcodePrefs = prefs;
    if (previous?.transcode !== prefs.transcode) this.reload();
    else if (previous?.transcodeMaxBitrate !== prefs.transcodeMaxBitrate
      || previous?.transcodeSplitBitrate !== prefs.transcodeSplitBitrate) this.resizeTranscodes();
  }

  transcodeOutputs() {
    const outputs = this.decisions.map((d, i) => d?.stream && {
      ...compareTileSize(d.probed.video, d.maxHeight, this.tile || {}, this.rotation[i] % 180 !== 0),
      remote: d.stream.remote,
    });
    const prefs = this.transcodePrefs || {};
    const caps = compareCapsKbps(outputs.filter(Boolean), prefs.transcodeMaxBitrate, prefs.transcodeSplitBitrate);
    let index = 0;
    return outputs.map((o) => o && { height: o.h, kbps: caps[index++] });
  }

  resizeTranscodes() {
    if (!this.decisions) return;
    this.transcodeOutputs().forEach((o, i) => {
      if (o) this.natives[i]?.setCompareOutput(o.height, o.kbps);
    });
  }

  startTranscode(i, d, output, epoch) {
    const key = TILE_KEYS[i];
    const current = () => !this.disposed && epoch === this.epoch && this.natives[i] === stream;
    const stream = new EncodedStream({
      ...d.stream, tools: d.tools, file: this.files[i], probed: d.probed,
      hidden: this.panel.visible === false,
      maxHeight: output.height, maxKbps: output.kbps, fitView: false, allowLinkAdapt: d.stream.remote,
      post: (m) => { if (current()) this.post({ type: 'nd', key, m }); },
      log: (msg) => this.log(`tile ${key}: ${msg}`),
      onFail: (err) => {
        if (!current()) return;
        this.log(`tile ${key}: live transcode failed (${err}); using the original decoder`);
        this.useOriginalTile(i, 'Live transcode failed. Using the original video.');
      },
    });
    this.natives[i] = stream;
    return 'transcode';
  }

  /** Tile numbers playing through Live transcode, for the clip export's early refusal. */
  liveTranscodeTiles() { return this.natives.flatMap((n, i) => (n instanceof EncodedStream ? [i] : [])); }

  useOriginalForClips(tiles) { for (const i of tiles) this.useOriginalTile(i); }

  useOriginalTile(i, notice) {
    if (!Number.isInteger(i) || !(this.natives[i] instanceof EncodedStream)) return;
    this.natives[i].dispose();
    this.originalTiles[i] = this.uris[i];
    this.natives[i] = null;
    this.decisions[i] = null;
    this.post({ type: 'originalTile', index: i, notice });
    this.resizeTranscodes();
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
      if (d?.stream || !d?.tools || !v || !v.width || !v.height) return d?.maxHeight || FRAME_SERVER_HEIGHT;
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
      post: (msg) => { if (epoch === this.epoch) this.post({ type: 'nd', key, m: msg }); },
      postRaw: (msg) => { if (epoch === this.epoch) this.post({ ...msg, key }); },
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
    const picked = await this.pick(`Replace ${TILE_KEYS[this.order.indexOf(i)]}`, vscode.Uri.joinPath(this.uris[i], '..'), false);
    if (!picked || !picked.length || this.disposed) return;
    this.replaceUri(i, picked[0]);
  }

  /** Tile i becomes `uri` (also the test hook's `compareReplace`). */
  replaceUri(i, uri) {
    if (this.disposed || !(i >= 0 && i < this.uris.length) || !uri || !FS_SCHEMES.has(uri.scheme)) return;
    this.log(`replace ${this.names[i]} with ${path.basename(uri.fsPath)}`);
    this.replaced = i;
    delete this.originalTiles[i];
    this.reload(this.uris.map((u, j) => (j === i ? uri : u)));
  }

  /** "Leave compare": the player opens video `keep` at `t` (its own seconds) in this tab's place. */
  async leave(keep, t) {
    if (this.disposed || !Number.isInteger(keep) || keep < 0 || keep >= this.uris.length) return;
    const uri = this.uris[keep];
    const column = this.panel.viewColumn;
    this.log(`leave, keep ${this.names[keep]} at ${Number.isFinite(t) ? t.toFixed(3) : 0} s`);
    if (this.addMode) this.addMode.stop(this);
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
    this.menu?.closed(this);
    this.closeFiles();
    this.log('closed');
  }
}

/**
 * Compare commands and menu state for the current window.
 * deps: { vscode, log, sessions (open player Sessions), engineCfg(webview), nativeFor?(file, transport), nativeQueue?() }
 */
function registerCompare(context, deps) {
  vscode = deps.vscode;
  const compareSessions = deps.compareSessions || new Set();
  const menu = createCompareMenu(compareSessions, (key, open) => {
    Promise.resolve(vscode.commands.executeCommand('setContext', key, open)).then(
      () => deps.log(`compare: ${key}=${open}`), (e) => deps.log(`compare: could not set ${key}: ${e.message}`),
    );
  });
  /**
   * Opens compare; `from` (a player Session) is replaced in its tab, `t` is where it was. `origin` says how it was
   * started, which decides whether Add Mode starts on (src/addmode.js startsInAddMode: only on explicit add-more intent).
   */
  const open = async (list, { from, t, viewColumn: col, origin } = {}) => {
    for (const u of list) {
      if (!FS_SCHEMES.has(u.scheme)) {
        vscode.window.showWarningMessage(`Video Preview: can't compare ${u.toString()} (not a file).`);
        return;
      }
    }
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
    deps.log(`compare: ${list.map((u) => u.fsPath).join(' <-> ')}`);
    if (deps.recent) for (const u of [...list].reverse()) deps.recent.set(pushRecent(deps.recent.get(), u.toString()));
    const viewColumn = from && from.panel ? from.panel.viewColumn : col;
    const session = new CompareSession(context, list, {
      ...deps, transport, frameSource, pick: pickMany, viewColumn, start: t, addMode: addModeApi, menu,
    });
    if (startsInAddMode({ origin, count: list.length })) armAddMode(session);
    session.panel.onDidDispose(() => deps.compareOpenChanged?.());
    deps.compareOpenChanged?.();
    // In place: the player's tab closes once compare has opened beside it in the same group.
    if (from && from.panel && !from.disposed) from.panel.dispose();
    return session;
  };
  // ---- Add from the Explorer (src/addmode.js, docs/notes/compare-ui.md "Add mode") ----
  const addMode = createAddMode({ max: maxVideos });
  const watched = new WeakSet();
  const openingVideos = new WeakSet();
  let targetTab = null;
  const setCtx = () => Promise.resolve(vscode.commands.executeCommand('setContext', 'videoPreviewEnhanced.addMode', addMode.active)).catch(() => {});
  const isCompare = (x) => x instanceof CompareSession;
  const publishStop = (target, reason) => {
    deps.log(`compare: add from the Explorer off${reason ? ` (${reason})` : ''}`);
    if (!target.disposed) target.post({ type: 'addMode', on: false });
    targetTab = null;
    return setCtx();
  };
  const checkActiveEditor = () => {
    const target = addMode.target;
    const group = vscode.window.tabGroups?.activeTabGroup;
    const tab = group?.activeTab;
    if (!isCompare(target) || !tab) return;
    // VS Code namespaces a webview panel's view type in the Tab API.
    if (!targetTab && /^(mainThreadWebview-)?videoPreviewEnhanced\.compare$/.test(tab.input?.viewType) &&
        group.viewColumn === target.panel.viewColumn && target.panel.active) targetTab = tab;
    if (targetTab && addMode.editorChanged({ isTarget: tab === targetTab, openingVideo: openingVideos.has(tab) })) {
      publishStop(target, 'switched editor');
    }
  };
  // The tab and webview notifications can arrive in either order. A new video tab gets first refusal.
  let editorCheck;
  const scheduleEditorCheck = () => {
    if (editorCheck) return;
    editorCheck = setImmediate(() => { editorCheck = null; checkActiveEditor(); });
  };
  const armAddMode = async (target, { toggle = false, showFull = false } = {}) => {
    if (!target || target.disposed || !target.panel) return undefined;
    if (!isCompare(target) && (target.url || target.sequence || !target.uri)) return undefined;
    const prev = addMode.target;
    const uris = (isCompare(target) ? target.uris : [target.uri]).map(fileKey);
    const opts = { multi: isCompare(target), uris };
    const r = toggle ? addMode.toggle(target, opts) : addMode.start(target, opts);
    if (prev !== target || r !== 'on') targetTab = null;
    if (prev && prev !== target && !prev.disposed) prev.post({ type: 'addMode', on: false });
    deps.log(`compare: add from the Explorer ${r}`);
    if (r === 'full' && showFull) target.post({ type: 'toast', text: `Compare shows up to ${maxVideos()} videos`, ms: 2500 });
    if (r === 'on' && !watched.has(target)) {
      watched.add(target);
      target.panel.onDidDispose(() => { if (addMode.gone(target)) publishStop(target, 'tab closed'); });
      if (isCompare(target)) target.panel.onDidChangeViewState(scheduleEditorCheck);
    }
    // A player in a preview tab: the Explorer's next single click would replace that tab, so it is kept first.
    if (r === 'on' && !isCompare(target) && target.panel.active) await vscode.commands.executeCommand('workbench.action.keepEditor');
    target.post(addMode.target === target ? addMode.hint() : { type: 'addMode', on: false });
    if (isCompare(target) && r === 'on') scheduleEditorCheck();
    return setCtx();
  };
  const stopAddMode = (target) => {
    const prev = addMode.target;
    if (target && prev !== target) return undefined;
    if (!addMode.stop()) return undefined;
    return publishStop(prev);
  };
  const toggleAddMode = (target) => armAddMode(target, { toggle: true, showFull: true });
  const addModeApi = {
    toggle: toggleAddMode, stop: stopAddMode, start: (target) => armAddMode(target, { showFull: true }),
    hint: (s) => (addMode.target === s ? addMode.hint() : null),
    sync: (s) => { if (addMode.sync(s, s.uris.map(fileKey))) publishStop(s, 'full'); },
  };
  // More than one open can arrive while the frame server starts for a player turning into Compare.
  let promotion;
  /**
   * A video VS Code is opening (extension.js: the player's resolveCustomEditor, or another editor's new tab).
   * True: the mode took it; the caller closes that tab. The video goes into compare (from a player: compare
   * takes the player's tab; in compare: added to it).
   */
  const claimOpen = (uri) => {
    if (!addMode.active || !uri || !FS_SCHEMES.has(uri.scheme)) return false;
    const target = addMode.target;
    if (target.disposed) { stopAddMode(target); return false; }
    const d = addMode.claim(fileKey(uri), uri.path);
    if (!addMode.active) publishStop(target, 'full');
    if (!d) return false;
    deps.log(`compare: add from the Explorer: ${path.basename(uri.fsPath)}${d.dup ? ' (shown already)' : ''}${d.stop ? ', mode off' : ''}`);
    (async () => {
      if (d.dup) { target.post({ type: 'toast', text: `${path.basename(uri.fsPath)} is in compare already`, ms: 2000 }); return; }
      if (isCompare(target)) {
        target.addUris([uri]);
        if (d.full) target.post({ type: 'toast', text: `Compare is full (${maxVideos()} videos)`, ms: 2500 });
      } else if (promotion?.target === target) {
        promotion.files.push(uri);
      } else {
        const pending = { target, files: [target.uri, uri], done: null };
        promotion = pending;
        const t = target.pos && Number.isFinite(target.pos.t) ? target.pos.t : 0;
        try {
          pending.done = open(pending.files, { from: target, t, origin: 'armed' });
          await pending.done;
        } finally {
          if (promotion === pending) promotion = null;
        }
      }
    })().catch((e) => deps.log(`compare: add from the Explorer failed: ${e && e.stack || e}`));
    return true;
  };
  /** A player tab (a single click's preview tab, say) that still shows a compared video: closed, no duplicate left. */
  const closeLeftovers = (list, viewColumn, closingTabs = new Set()) => {
    try {
      const tabs = leftoverTabs(vscode.window.tabGroups.all || [], list.map(String), viewColumn);
      for (const tb of tabs) {
        if (!closingTabs.has(tb)) Promise.resolve(vscode.window.tabGroups.close(tb)).catch(() => {});
      }
    } catch { /* tab API missing */ }
  };
  /** The first time videos open together: say what happened and where to turn it off (never again after). */
  const NOTICED = 'videoPreviewEnhanced.openTogetherNoticed';
  const noticeTogether = (n) => {
    const gs = context.globalState;
    if (!gs || gs.get(NOTICED)) return;
    Promise.resolve(gs.update(NOTICED, true)).catch(() => {});
    Promise.resolve(vscode.window.showInformationMessage(togetherNotice(n), 'Got it', 'Open Settings')).then((c) => {
      if (c === 'Open Settings') return vscode.commands.executeCommand('workbench.action.openSettings', 'videoPreviewEnhanced.compare.openTogether');
      return undefined;
    }).catch(() => {});
  };
  // ---- Open together: videos that VS Code opens in one burst (an Explorer multi-selection: Open With…, Enter,
  // double-click) become one compare (src/burst.js). A single video, or videos opened apart, are untouched.
  const burst = createBurst({
    windowMs: Number(process.env.VPE_BURST_MS) > 0 ? Number(process.env.VPE_BURST_MS) : BURST_WINDOW_MS,
    max: maxVideos,
    onBurst: async ({ items, extra, viewColumn }) => {
      if (addMode.active || !openTogether()) return false;
      const list = items.map((i) => i.uri).filter((u) => FS_SCHEMES.has(u.scheme) && VIDEO_EXT.test(u.path));
      if (list.length < 2) return false;
      deps.log(`compare: ${list.length} videos opened together -> one compare${extra.length ? `, ${extra.length} more stay as tabs` : ''}`);
      const first = items[0];
      const from = playerOf(first.uri, viewColumn);
      try {
        // A burst never turns Add Mode on (src/addmode.js startsInAddMode): the user asked for these videos, not for more.
        await open(list, { from, t: 0, viewColumn, origin: 'burst' });
      } catch (e) {
        deps.log(`compare: open together failed: ${e && e.stack || e}`);
        return false; // the held players start as usual
      }
      const tabs = new Set(items.flatMap((it) => it.tabs));
      for (const it of items) {
        for (const pn of it.panels) {
          if (pn !== from?.panel) { try { pn.dispose(); } catch { /* gone already */ } }
        }
      }
      for (const tab of tabs) Promise.resolve(vscode.window.tabGroups.close(tab)).catch(() => {});
      closeLeftovers(list, viewColumn, tabs);
      noticeTogether(list.length);
      if (extra.length) vscode.window.showWarningMessage(`Video Preview: compare shows up to ${maxVideos()} videos; the other ${extra.length} stay open as they are.`);
      return true;
    },
  });
  /** A video opened in our player (extension.js resolveCustomEditor) or a tab of it appeared: part of a burst? */
  const noteOpen = (uri, o) => {
    if (!uri || !FS_SCHEMES.has(uri.scheme) || !VIDEO_EXT.test(uri.path) || addMode.active || !openTogether()) return false;
    burst.add(uri.toString(), uri, o);
    return true;
  };
  /**
   * Called by the player after `noteOpen`. One macrotask is waited first, so that opens VS Code delivered together are
   * all noted before looking. Settles with true once compare has taken the video (the player must never start), or
   * false at once when it is the only one pending, when no burst takes it or after HOLD_MAX_MS (start the player).
   */
  const HOLD_MAX_MS = 10000;
  const holdOpen = (uri) => {
    if (!uri || !burst.waiting) return null; // not noted: nothing to wait for
    const key = uri.toString();
    return new Promise((done) => setImmediate(done)).then(() => {
      const held = burst.wait(key);
      if (!held) return false;
      let timer;
      const cap = new Promise((r) => { timer = setTimeout(() => r(false), HOLD_MAX_MS); });
      return Promise.race([held, cap]).finally(() => clearTimeout(timer));
    });
  };
  // Videos opened in an editor that is not the player (VS Code's own preview, a text tab): their new tab closes.
  if (vscode.window.tabGroups && vscode.window.tabGroups.onDidChangeTabs) {
    const isPlayerTab = (tab) => tab.input?.uri && typeof tab.input.viewType === 'string'
      && tab.input.viewType.startsWith('videoPreviewEnhanced.');
    const previewState = new WeakMap();
    for (const group of vscode.window.tabGroups.all || []) {
      for (const tab of group.tabs) {
        if (isPlayerTab(tab)) previewState.set(tab, tab.isPreview);
      }
    }
    context.subscriptions.push(vscode.window.tabGroups.onDidChangeTabs((e) => {
      for (const tab of e.closed || []) previewState.delete(tab);
      for (const tab of e.changed || []) {
        if (!isPlayerTab(tab)) { previewState.delete(tab); continue; }
        // VS Code reuses the tab on drop. Its current state already reflects the change.
        if (previewState.get(tab) === true && tab.isPreview === false) {
          noteOpen(tab.input.uri, { tab, changed: true });
        }
        previewState.set(tab, tab.isPreview);
      }
      for (const tab of e.opened || []) {
        const inp = tab.input || {};
        if (!inp.uri) continue;
        if (addMode.active && FS_SCHEMES.has(inp.uri.scheme) && VIDEO_EXT.test(inp.uri.path)) openingVideos.add(tab);
        if (isPlayerTab(tab)) {
          previewState.set(tab, tab.isPreview);
          noteOpen(inp.uri, { tab });
          continue;
        }
        if (addMode.active && claimOpen(inp.uri)) Promise.resolve(vscode.window.tabGroups.close(tab)).catch(() => {});
      }
      scheduleEditorCheck();
    }));
    if (vscode.window.tabGroups.onDidChangeTabGroups) {
      context.subscriptions.push(vscode.window.tabGroups.onDidChangeTabGroups(scheduleEditorCheck));
    }
  }
  const pickMany = async (label, defaultUri, many) => {
    const r = await (deps.showOpenDialog || vscode.window.showOpenDialog)({
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
  /**
   * The open player showing `uri` (the active one first): compare replaces it in place.
   * @param {import('vscode').Uri} uri
   * @param {number} [viewColumn]
   */
  const playerOf = (uri, viewColumn) => {
    const key = uri.toString();
    const all = [...deps.sessions].filter((s) => s.panel && !s.sequence && !s.url && s.uri && s.uri.toString() === key
      && (viewColumn === undefined || s.panel.viewColumn === viewColumn));
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
        : { label: r.kind === 'browse' ? '$(folder-opened) Browse…' : r.kind === 'explorer' ? '$(list-tree) Click videos in the Explorer…' : r.label,
          browse: r.kind === 'browse', explorer: r.kind === 'explorer', uri: r.uri,
          description: r.uri && !folder.includes(r.uri) ? vscode.workspace.asRelativePath ? vscode.workspace.asRelativePath(vscode.Uri.parse(r.uri), false) : '' : '' }));
  };
  /** Key D in the player: quick pick of other videos (same folder first), then compare in this tab's place. */
  const comparePick = async (uri, opts) => {
    const a = (uri instanceof vscode.Uri ? uri : null) || activePlayerUri();
    if (!a) return undefined;
    const items = await pickItems(a);
    const chosen = await (testPick ? testPick(items) : vscode.window.showQuickPick(items, { placeHolder: `Compare ${path.basename(a.fsPath)} with…`, matchOnDescription: true }));
    if (!chosen) return undefined;
    if (chosen.explorer) { const from = playerOf(a); return from ? toggleAddMode(from) : undefined; }
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
  const selectionVideos = async (uri) => {
    if (!(uri instanceof vscode.Uri) || !FS_SCHEMES.has(uri.scheme)) return [];
    try {
      const dir = vscode.FileType.Directory;
      const stat = await vscode.workspace.fs.stat(uri);
      if (!(stat.type & dir)) return VIDEO_EXT.test(uri.path) ? [uri] : [];
      const entries = await vscode.workspace.fs.readDirectory(uri);
      const names = folderVideos(entries.filter(([, type]) => !(type & dir)).map(([name]) => name));
      return names.map((name) => vscode.Uri.joinPath(uri, name));
    } catch {
      return [];
    }
  };
  const addSelection = async (uri, uris, { from, t, confirmStart } = {}) => {
    const selection = Array.isArray(uris) && uris.length ? uris : [uri];
    const videos = (await Promise.all(selection.map(selectionVideos))).flat();
    if (!videos.length) {
      vscode.window.showInformationMessage('Video Preview: no videos in the selection.');
      return undefined;
    }
    if (promotion?.done) await promotion.done.catch(() => {});
    const compare = menu.latest();
    // A click on Add to Compare can race the last Compare closing. Opening a new one requires confirmation.
    if (from && (from.disposed || (!compare && !confirmStart))) return undefined;
    const players = [...deps.sessions].reverse().filter((s) => (
      !s.disposed && s.panel && !s.url && !s.sequence && s.uri && FS_SCHEMES.has(s.uri.scheme)
    ));
    const last = deps.lastActivePlayer?.();
    const player = from || players.find((s) => s.panel.active) || (players.includes(last) ? last : players[0]);
    const { target, append, files, skipped } = planAddToCompare({
      videos, compare, player, max: maxVideos(), key: fileKey,
    });
    if (skipped) {
      const label = skipped === 1 ? 'video' : 'videos';
      vscode.window.showInformationMessage(`Video Preview: skipped ${skipped} ${label} because Compare is full.`);
    }
    if (append) {
      target.addUris(files);
      // The player's Add to Compare button: say what happened, since the Compare may be in another tab.
      const text = files.length ? `Added to Compare (${target.uris.length} videos)` : skipped ? '' : 'Already in Compare';
      if (from && text) from.post({ type: 'toast', text, ms: 2500 });
      return target;
    }
    const list = target ? [target.uri, ...files] : files;
    // The toolbar's confirmed Start comparison is an explicit add-more intent; otherwise the selection decides.
    const origin = confirmStart ? 'toolbar-start' : addToCompareOrigin({
      selected: selection.length, videos: videos.length, isFile: videos.length === 1 && videos[0].toString() === String(selection[0]), count: list.length,
    });
    const session = await open(list, { from: target, t: Number.isFinite(t) ? t : target?.pos?.t, origin });
    if (session) closeLeftovers(list, session.panel.viewColumn);
    return session;
  };
  // Resolve each selection and perform its action before looking up the next command's target.
  let selected = Promise.resolve();
  const addToCompare = (uri, uris, options) => {
    const action = selected.then(() => addSelection(uri, uris, options));
    selected = action.catch(() => {});
    return action;
  };
  context.subscriptions.push(
    vscode.commands.registerCommand('videoPreviewEnhanced.comparePick', comparePick),
    vscode.commands.registerCommand('videoPreviewEnhanced.compareDrop', compareDrop),
    vscode.commands.registerCommand('videoPreviewEnhanced.startCompare', (uri, uris) => addToCompare(uri, uris)),
    vscode.commands.registerCommand('videoPreviewEnhanced.addToCompare', (uri, uris) => addToCompare(uri, uris)),
    vscode.commands.registerCommand('videoPreviewEnhanced.addToCompareFromPlayer', (uri) => {
      const video = (uri instanceof vscode.Uri ? uri : null) || activePlayerUri();
      const compare = menu.latest();
      if (!compare || !video || !FS_SCHEMES.has(video.scheme) || !VIDEO_EXT.test(video.path)) return;
      if (!compare.uris.some((uri) => fileKey(uri) === fileKey(video))) compare.addUris([video]);
    }),
    vscode.commands.registerCommand('videoPreviewEnhanced.addFromExplorer', () => {
      // The palette: the active compare or player (the page posts its own Shift+D with its Session).
      const target = [...compareSessions].find((s) => s.panel.active) || [...deps.sessions].find((s) => s.panel && s.panel.active);
      return target ? toggleAddMode(target) : undefined;
    }),
    vscode.commands.registerCommand('videoPreviewEnhanced.stopAddFromExplorer', () => stopAddMode()),
    vscode.commands.registerCommand('videoPreviewEnhanced.compareFolder', (uri, uris) => addToCompare(uri, uris)),
    vscode.commands.registerCommand('videoPreviewEnhanced.compare', async (uri, uris, opts) => {
      let list = Array.isArray(uris) && uris.length ? uris : uri ? [uri] : [];
      list = list.filter((u) => VIDEO_EXT.test(u.path));
      const max = maxVideos();
      if (list.length > max) vscode.window.showWarningMessage(`Video Preview: compare shows up to ${max} videos; showing the first ${max}.`);
      if (list.length >= 2) { // opts: the test hook's in-place open
        const shown = list.slice(0, max);
        const s = await open(shown, opts && (opts.from || opts.origin) ? opts : {});
        if (!(opts && opts.from)) closeLeftovers(shown, s && s.panel ? s.panel.viewColumn : undefined);
        return s;
      }
      const a = list[0] || activePlayerUri() || await pick('Compare: video A');
      if (!a) return undefined;
      const b = await pick(`Compare with ${path.basename(a.fsPath)} (B)`, vscode.Uri.joinPath(a, '..'));
      return b ? open([a, b]) : undefined;
    }),
    // Start Compare from the editor title, or Compare With… from the player: pick files and replace the player.
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
  return {
    claimOpen, noteOpen, holdOpen, toggleAddMode, stopAddMode,
    addFromPlayer: (player, t, confirmStart) => addToCompare(player.uri, undefined, { from: player, t, confirmStart }),
  };
}

module.exports = { registerCompare, setPickHook, compareHtml, CompareSession, fileOfKey, MAX_TILES, maxVideos };
