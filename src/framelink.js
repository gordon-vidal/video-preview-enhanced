'use strict';
// Small helpers the extension host shares: frame links (vscode://<id>/open?frame=N&t=S&file=...), the native
// decoder's frame-size caps and launch key, and the one-line texts for the log and notifications. Everything
// VS Code-shaped (env, Uri) and the settings reader are injected, so a Node test can drive it with fakes;
// the wiring (sessions, pending seeks, opening the file) stays in src/extension.js openLink.

// checkJs: start
/** Same file (size and modification time) as when it was probed. */
function sameFile(/** @type {any} */ a, /** @type {any} */ b) {
  return !!a && !!b && a.size === b.size && a.mtimeMs === b.mtimeMs;
}

/** The log's words for an HLS plan: the variant and how it was chosen. */
function hlsPlanText(/** @type {any} */ plan) {
  if (!plan.master) return plan.playlist.encrypted ? ', AES-128' : '';
  const v = plan.variant;
  const rate = plan.throughput ? `, measured ${(plan.throughput / 1e6).toFixed(1)} Mb/s` : '';
  return `, ${plan.variants.length} variants, ${plan.auto ? 'auto' : 'chosen'}: ${v.width}x${v.height} ${v.bandwidth} b/s${rate}` +
    `${plan.master.media.length ? `, ${plan.master.media.length} renditions` : ''}${plan.master.iframes.length ? `, ${plan.master.iframes.length} I-frame playlists` : ''}${plan.playlist.encrypted ? ', AES-128' : ''}`;
}

/**
 * Seek target from a link query or fragment: `t` (seconds or 1:02.5) and/or `frame` (1-based, as the player shows it).
 * @param {string} text
 * @param {(text: string) => { t?: number, frame?: number }} parseFragment media/inspect.js
 */
function gotoFrom(text, parseFragment) {
  const g = parseFragment(text);
  return g.t !== undefined || g.frame !== undefined ? g : null;
}

/**
 * @param {object} deps
 * @param {any} deps.vscode  env (remoteName, remoteAuthority, uriScheme), Uri, workspace
 * @param {(...a: any[]) => any} deps.config  the settings reader (src/settings.js)
 * @param {{ streamHeight(v: any): number }} deps.decide  src/decide.js
 * @param {() => string} deps.nativeTransport  'message' | 'http' | 'ws' | 'fail'
 * @param {{ CLIP_FPS: number }} deps.probe  src/probe.js (may be a lazy proxy)
 * @param {{ displayName(url: string): string }} deps.urlsource  src/urlsource.js (may be a lazy proxy)
 * @param {(text: string) => { t?: number, frame?: number }} deps.parseFragment media/inspect.js
 */
function createFrameLink(deps) {
  const { vscode, config, decide, nativeTransport, probe, urlsource, parseFragment } = deps;

  /** @param {string} text */
  const gotoOf = (text) => gotoFrom(text, parseFragment);

  /**
   * vscode://<publisher>.<name>/open?frame=N&t=S&file=<path> (or uri=<full URI> for remote files):
   * opens the file in this player at that frame, or seeks an already open one.
   * The file comes last and runs to the end, so paths with & or + survive (VS Code has
   * already decoded the query once).
   * @param {string} query
   */
  function parseLink(query) {
    const m = /(?:^|&)(file|uri)=(.*)$/s.exec(query);
    if (!m) return null;
    const target = m[1] === 'uri' ? vscode.Uri.parse(m[2]) : vscode.Uri.file(m[2]);
    return { target, goto: gotoOf(query.slice(0, m.index)) };
  }

  /**
   * vscode://<publisher>.<name>/compare?frame=N&t=S&mode=split&file=<a.mp4>&file=<b.mp4> (or uri=<full URI>):
   * opens two or more videos in a synchronized Compare view, optionally at a frame/time and layout mode.
   * Splits on known parameter boundaries so file paths containing `&` survive.
   * @param {string} query
   */
  function parseCompareLink(query) {
    const targets = [];
    const gotoParts = [];
    let mode = null;
    for (const part of String(query || '').split(/&(?=(?:file|uri|frame|t|mode|layout)=)/)) {
      const eq = part.indexOf('=');
      if (eq <= 0) continue;
      const k = part.slice(0, eq);
      const v = part.slice(eq + 1);
      if (!v) continue;
      if (k === 'file') targets.push(vscode.Uri.file(v));
      else if (k === 'uri') {
        try { targets.push(vscode.Uri.parse(v)); } catch { /* malformed URI skipped */ }
      } else if (k === 'frame' || k === 't') gotoParts.push(part);
      else if (k === 'mode' || k === 'layout') {
        const m = v.toLowerCase();
        if (m === 'grid' || m === 'spotlight') mode = m;
        else if (m === 'split' || m === 'wipe') mode = 'split';
      }
    }
    if (!targets.length) return null;
    return { targets, goto: gotoOf(gotoParts.join('&')), mode };
  }

  // This window's remote authority (ssh-remote+host, wsl+Ubuntu), learned once.
  let windowAuthority = '';

  /**
   * The remote authority of this window, or '' in a local window or when unknown.
   * The remote extension host sees its files as file: URIs, so a frame link has to
   * name the host itself. env.remoteAuthority is proposed API (it throws for us);
   * a webview resource URI carries the same authority, encoded into its host name
   * (vscode-remote+<authority, non-alphanumerics as -xxxx>.vscode-resource...).
   * @param {any} webview
   */
  function remoteAuthority(webview) {
    const name = vscode.env.remoteName;
    if (!name) return '';
    if (windowAuthority) return windowAuthority;
    let a = '';
    try { a = vscode.env.remoteAuthority || ''; } catch { a = ''; }
    if (!a && webview) {
      try {
        const host = String(webview.asWebviewUri(vscode.Uri.file('/')).authority || '');
        const m = /^vscode-remote\+((?:[A-Za-z0-9]|-[0-9a-f]{4})+)\./.exec(host);
        if (m) a = m[1].replace(/-([0-9a-f]{4})/g, (/** @type {string} */ _, /** @type {string} */ h) => String.fromCharCode(parseInt(h, 16)));
      } catch { a = ''; }
    }
    if (a && a.startsWith(`${name}+`)) windowAuthority = a;
    return windowAuthority;
  }

  /**
   * Maps a link target to a URI this extension host can open: vscode-remote links
   * only in the window connected to that host (where they are plain files);
   * null when the link belongs to another machine.
   * @param {any} target
   */
  function localTarget(target) {
    if (target.scheme !== 'vscode-remote') return target;
    const name = vscode.env.remoteName;
    const auth = String(target.authority || '').toLowerCase();
    const here = remoteAuthority(null).toLowerCase();
    // Before any player has opened, the authority may be unknown: the remote kind must still match.
    const ok = here ? auth === here : !!name && auth.startsWith(`${name.toLowerCase()}+`);
    return ok ? target.with({ scheme: 'file', authority: '' }) : null;
  }

  /**
   * The link that reopens this file at a frame; a local path where possible, so it
   * reads well. In a remote window it names the host (uri=vscode-remote://<authority>/path).
   * @param {{ extension: { id: string } }} context
   * @param {any} uri
   * @param {number} frame
   * @param {number} t
   * @param {any} webview
   */
  function frameLink(context, uri, frame, t, webview) {
    const auth = uri.scheme === 'file' ? remoteAuthority(webview) : '';
    if (auth) uri = vscode.Uri.from({ scheme: 'vscode-remote', authority: auth, path: uri.path });
    const where = uri.scheme === 'file' ? `file=${encodeURIComponent(uri.fsPath)}` : `uri=${encodeURIComponent(uri.toString())}`;
    return `${vscode.env.uriScheme}://${context.extension.id}/open?frame=${frame}&t=${t}&${where}`;
  }

  /**
   * Builds a compare link for two or more files, optionally at a frame/time and layout mode.
   * @param {{ extension: { id: string } }} context
   * @param {any[]} uris
   * @param {{ frame?: number, t?: number, mode?: string, webview?: any }} [opts]
   */
  function compareLink(context, uris, opts = {}) {
    const parts = [];
    if (opts.frame !== undefined) parts.push(`frame=${opts.frame}`);
    if (opts.t !== undefined) parts.push(`t=${opts.t}`);
    if (opts.mode === 'grid' || opts.mode === 'spotlight' || opts.mode === 'split') parts.push(`mode=${opts.mode}`);
    const auth = remoteAuthority(opts.webview || null);
    for (let uri of uris) {
      if (uri.scheme === 'file' && auth) uri = vscode.Uri.from({ scheme: 'vscode-remote', authority: auth, path: uri.path });
      parts.push(uri.scheme === 'file' ? `file=${encodeURIComponent(uri.fsPath)}` : `uri=${encodeURIComponent(uri.toString())}`);
    }
    return `${vscode.env.uriScheme}://${context.extension.id}/compare?${parts.join('&')}`;
  }

  /**
   * Native frame size caps: { stream: over the frame server, message: by postMessage (the fallback,
   * and every remote window) }. nativeMaxHeight set: that, for both (720 at most in WSL). Automatic
   * (0, the default): over the frame server, full resolution up to 2160p when the frames fit what it
   * carries at the video's frame rate (decide.streamHeight: 4K30 in full, 4K60 at 1440p), 1080p by
   * postMessage. v: the ffprobe'd video stream, when known.
   * @param {any} [c]
   * @param {any} [v]
   */
  function nativeHeights(c = config(), v = null) {
    const message = vscode.env.remoteName === 'wsl' ? Math.min(720, c.nativeMaxHeight) : c.nativeMaxHeight;
    return { stream: c.nativeMaxAuto ? decide.streamHeight(v) : c.nativeMaxHeight, message };
  }

  /** Native frames sized to the player's picture: the automatic nativeMaxHeight with sizeFramesToView on. */
  function fitsView(/** @type {any} */ c = config()) {
    return c.nativeMaxAuto && c.sizeFramesToView;
  }

  /**
   * The launch parameters open() must confirm before keeping an early native decoder.
   * @param {any} t ffmpeg tools
   * @param {any} pr ffprobe result
   * @param {any} d decide.decide() result
   * @param {any} c settings
   * @param {any} framePort the frame server's port, when the page has one
   */
  function nativeKey(t, pr, d, c, framePort) {
    const h = nativeHeights(c, pr.video);
    return JSON.stringify([t.ffmpeg, t.version, pr.video ? [pr.video.index, pr.video.codec, pr.video.width, pr.video.height, pr.video.fps] : null, pr.audio ? pr.audio.index : null, d.method, h.stream, h.message, fitsView(c), framePort ? nativeTransport() : 'message']);
  }

  /** The frame height native playback will most likely use here (for the decision's log line). */
  function nativeHeight(/** @type {any} */ c = config(), /** @type {any} */ v = null) {
    const h = nativeHeights(c, v);
    return nativeTransport() === 'message' ? h.message : h.stream;
  }

  /** One-line result for a notification: how many formats play in real time, with what. */
  function probeSummary(/** @type {any} */ rec) {
    const all = /** @type {[string, any][]} */ (Object.entries(rec.results));
    const rt = all.filter(([, r]) => r.fps >= probe.CLIP_FPS * 1.2);
    const methods = [...new Set(all.map(([, r]) => r.method).filter((m) => m && m !== 'none'))];
    const slow = all.filter(([, r]) => r.fps < probe.CLIP_FPS * 1.2)
      .map(([c, r]) => `${c.replace(/\/(\d+)\//, ' $1-bit ').replace(/ 2160$/, ' 4K').replace(/ 1080$/, ' 1080p')}: ${r.fps} fps`);
    return `ffmpeg plays ${rt.length} of ${all.length} tested formats in real time here (30 fps)` +
      `${methods.length ? `, decoding on the GPU with ${methods.join(', ')} where that is fast enough` : ', on the CPU'}.${slow.length ? ` Slower: ${slow.join('; ')}.` : ''}`;
  }

  /** A file-name stem for frames saved from a URL player. */
  function urlBase(/** @type {string} */ url) {
    return urlsource.displayName(url).replace(/\.[^.]+$/, '').replace(/[^\w.-]+/g, '_').slice(0, 60) || 'video';
  }

  return {
    gotoFrom: gotoOf, parseLink, parseCompareLink, remoteAuthority, localTarget, frameLink, compareLink,
    nativeHeights, fitsView, nativeKey, nativeHeight, probeSummary, urlBase,
  };
}
// checkJs: end

/** A video URI already mapped to a file on this extension host. */
function isLocalVideo(uri, videoExt) {
  return uri.scheme === 'file' && !uri.authority && !/^[\\/]{2}/.test(uri.fsPath || '') && videoExt.test(uri.path);
}

module.exports = { isLocalVideo, createFrameLink, gotoFrom, sameFile, hlsPlanText };
