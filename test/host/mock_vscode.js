'use strict';
// A minimal `vscode` module for loading src/extension.js in plain Node.
// load() returns { ext, vscode, open(file) -> viewer handle with posted messages }. A handle's send() waits until
// the viewer's page exists and stamps each message with that page's number (src/unified-viewer.js drops others).
const Module = require('module');
const path = require('path');
const { configuration } = require('../../package.json').contributes;
const defaults = new Map([configuration].flat().flatMap(({ properties }) =>
  Object.entries(properties).map(([key, spec]) => [key, spec.default])));

function makeVscode(settings = {}) {
  class Uri {
    constructor(scheme, fsPath) {
      this.scheme = scheme; this.authority = ''; this.fsPath = fsPath; this.path = fsPath.split(path.sep).join('/').replace(/^(?=[^/])(?=.)/, '/');
      this.query = ''; this.fragment = '';
    }
    static file(p) { return new Uri('file', path.resolve(p)); }
    static joinPath(u, ...p) { return new Uri(u.scheme, path.join(u.fsPath, ...p)); }
    static from(c) { return Object.assign(new Uri(c.scheme, ''), { path: '', ...c }); }
    /** scheme://authority/path?query#fragment, path percent-decoded (like vscode.Uri.parse). */
    static parse(s) {
      const m = /^([a-z][\w+.-]*):(?:\/\/([^/?#]*))?([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/i.exec(s);
      if (!m) throw new Error(`bad uri ${s}`);
      const p = decodeURIComponent(m[3]);
      const u = Object.assign(new Uri(m[1], p), { authority: m[2] || '', path: p, query: m[4] || '', fragment: m[5] || '' });
      // A file URI's fsPath is the local path ('/C:/x' -> 'C:\x' on Windows), as in VS Code.
      if (m[1] === 'file' && !m[2]) u.fsPath = path.normalize(process.platform === 'win32' ? p.replace(/^\/(?=[a-zA-Z]:)/, '') : p);
      return u;
    }
    toString() {
      const enc = (x) => x.split('/').map(encodeURIComponent).join('/');
      return `${this.scheme}://${this.authority}${enc(this.path)}${this.query ? `?${this.query}` : ''}${this.fragment ? `#${this.fragment}` : ''}`;
    }
    with(c) {
      const u = Object.assign(Object.assign(new Uri(this.scheme, this.fsPath), this), c);
      // A new path is a new file (as in VS Code): its fsPath follows ('/C:/x' -> 'C:\x' on Windows).
      if (c && c.path !== undefined && c.path !== this.path) u.fsPath = path.normalize(process.platform === 'win32' ? c.path.replace(/^\/(?=[a-zA-Z]:)/, '') : c.path);
      return u;
    }
  }
  const providers = {};
  const commands = {};
  const updates = [];
  const vscode = {
    Uri,
    ExtensionMode: { Production: 1, Development: 2, Test: 3 },
    ConfigurationTarget: { Global: 1 },
    ProgressLocation: { Notification: 15 },
    ViewColumn: { Active: -1, Beside: -2 },
    ThemeIcon: class {},
    QuickPickItemKind: { Separator: -1 },
    FileType: { File: 1, Directory: 2, SymbolicLink: 64 },
    env: { remoteName: undefined, uriScheme: 'vscode', clipboard: { text: '', async writeText(t) { this.text = t; }, async readText() { return this.text; } }, openExternal: async () => true },
    window: {
      createOutputChannel: () => ({ lines: [], appendLine(l) { this.lines.push(l); }, show() {}, dispose() {} }),
      registerUriHandler: (h) => { vscode.uriHandler = h; return { dispose() {} }; },
      registerCustomEditorProvider: (t, p) => { providers[t] = p; return { dispose() {} }; },
      showInformationMessage: async () => undefined,
      showWarningMessage: async () => undefined,
      showErrorMessage: async () => undefined,
      showInputBox: async (o) => (o && o.value !== undefined ? o.value : undefined),
    },
    commands: {
      registerCommand: (id, fn) => {
        // As VS Code: a second registration of one id throws, and the extension then fails to activate.
        if (Object.prototype.hasOwnProperty.call(commands, id)) throw new Error(`command '${id}' already exists`);
        commands[id] = fn;
        return { dispose() { if (commands[id] === fn) delete commands[id]; } };
      },
      executeCommand: async (id, ...a) => { (vscode.executed = vscode.executed || []).push([id, ...a]); },
    },
    workspace: {
      isTrusted: true,
      getConfiguration: (sec) => {
        const full = (k) => sec ? `${sec}.${k}` : k;
        return {
          get: (k, d) => settings[full(k)] !== undefined ? settings[full(k)]
            : defaults.has(full(k)) ? defaults.get(full(k)) : d,
          update: async (k, v) => { updates.push([full(k), v]); },
          inspect: (k) => defaults.has(full(k)) || settings[full(k)] !== undefined
            ? { defaultValue: defaults.get(full(k)), globalValue: settings[full(k)] } : undefined,
        };
      },
      onDidChangeConfiguration: () => ({ dispose() {} }),
      fs: { writeFile: async () => {} },
    },
    _providers: providers, _commands: commands, _updates: updates,
  };
  return vscode;
}

/** What a page's decoder sends for its own clip. */
const DECODER_MESSAGES = new Set(['readBlock', 'thumb', 'nd', 'frames', 'grabExactFrame', 'exportFrame', 'decodeSpeed', 'wcFailed', 'softVideo']);

function load({ settings, env, setup, state: sharedState } = {}) {
  // As in the real-VS-Code test profiles: the setup guide does not open by itself unless a test asks for it.
  // Set on the caller's object (tests change their settings object later and expect the mock to see it).
  settings = settings || {};
  if (!('workbench.welcomePage.walkthroughs.openOnInstall' in settings)) settings['workbench.welcomePage.walkthroughs.openOnInstall'] = false;
  const vscode = makeVscode(settings);
  if (setup) setup(vscode);
  const origLoad = Module._load;
  Module._load = function (req, ...a) { return req === 'vscode' ? vscode : origLoad.call(this, req, ...a); };
  const extPath = require.resolve('../../src/extension.js');
  delete require.cache[extPath];
  const saved = {};
  for (const [k, v] of Object.entries(env || {})) { saved[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  let ext;
  try { ext = require(extPath); } finally {
    Module._load = origLoad;
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
  const state = sharedState || new Map();
  const subs = [];
  const context = {
    subscriptions: subs,
    extensionUri: vscode.Uri.file(path.join(__dirname, '..', '..')),
    extension: { id: 'gordon-vidal.video-preview-enhanced', packageJSON: require('../../package.json') },
    globalStorageUri: vscode.Uri.file(path.join(require('os').tmpdir(), 'vpe_host_test_storage')),
    extensionMode: vscode.ExtensionMode.Production,
    globalState: {
      state,
    get: (k) => state.get(k),
      update: async (k, v) => { state.set(k, v); context.stateWrites = (context.stateWrites || 0) + 1; },
    },
  };
  ext.activate(context);

  /** A mock WebviewPanel and its handle; `resolve(panel)` makes the viewer in it (the custom editor, or a command). */
  function handle(resolve, { visible = true } = {}) {
    const posted = [];
    const listeners = {};
    const panel = {
      visible, active: true, viewColumn: 1,
      webview: {
        options: null, html: '', cspSource: 'vscode-resource:',
        asWebviewUri: (u) => ({ authority: vscode._webviewHost || 'file+.vscode-resource.vscode-cdn.net', toString: () => `https://webview/${u.path}` }),
        postMessage: (m) => { posted.push(m); return Promise.resolve(true); },
        onDidReceiveMessage: (fn) => { listeners.msg = fn; },
      },
      onDidDispose: (fn) => { (listeners.dispose = listeners.dispose || []).push(fn); },
      onDidChangeViewState: (fn) => { listeners.viewState = fn; },
      reveal() {},
      dispose() { const fns = listeners.dispose || []; listeners.dispose = []; for (const fn of fns) fn(); },
    };
    const h = {
      panel, posted, shown: Promise.resolve(),
      setVisible: (v) => { panel.visible = v; if (listeners.viewState) listeners.viewState(); },
      send: async (m) => {
        await h.shown;
        if (!listeners.msg) return undefined; // no viewer (the tab closed, or another viewer took the video)
        const hasCfg = Boolean(panel.webview.html && panel.webview.html.includes('id="cfg"'));
        if (m && typeof m === 'object' && m.page === undefined && hasCfg) {
          m = { page: webviewConfig(panel.webview).page, ...(m.type === 'ready' ? { boot: 'mock-document' } : {}), ...m };
        }
        // The page's decoders tag what they send with their clip (media/player-unified.js defaultCreatePlayer).
        const clips = hasCfg ? webviewConfig(panel.webview).clips || [] : [];
        if (m && typeof m === 'object' && DECODER_MESSAGES.has(m.type) && m.clipId === undefined && clips.length === 1) {
          m = { ...m, clipId: clips[0].id, key: clips[0].id };
        }
        return listeners.msg(m);
      },
      /** The page's config (#cfg). */
      cfg: () => webviewConfig(panel.webview),
      /** Waits until pred(posted) is true. */
      until: async (pred, ms = 5000) => {
        const t0 = Date.now();
        while (!pred(posted)) {
          if (Date.now() - t0 > ms) throw new Error('timeout');
          await new Promise((r) => setTimeout(r, 5));
        }
      },
    };
    h.shown = Promise.resolve(resolve ? resolve(panel) : undefined);
    return h;
  }

  /** A video file opened in our custom editor. */
  function open(file, opts) {
    const uri = typeof file === 'string' ? vscode.Uri.file(file) : file;
    return handle((panel) => vscode._providers['videoPreviewEnhanced.player'].resolveCustomEditor({ uri }, panel), opts);
  }

  /** The handle of the next panel a command creates (vscode.window.createWebviewPanel), e.g. a sequence or a URL. */
  function nextPanel(opts) {
    const h = handle(null, opts);
    vscode.window.createWebviewPanel = (viewType, title) => { h.viewType = viewType; h.title = title; return h.panel; };
    return h;
  }
  /** Every panel a command creates from now on, as handles (Compare commands, URLs, sequences). */
  function autoPanels(opts) {
    const list = [];
    vscode.window.createWebviewPanel = (viewType, title, show) => {
      const h = handle(null, opts);
      Object.assign(h, { viewType, title, show });
      list.push(h);
      return h.panel;
    };
    return list;
  }
  return { ext, vscode, context, open, nextPanel, autoPanels, dispose: () => { for (const s of subs) if (s && s.dispose) s.dispose(); } };
}

function webviewConfig(webview) {
  return JSON.parse(/<script type="application\/json" id="cfg">([^<]*)<\/script>/.exec(webview.html)[1]);
}

module.exports = { load, makeVscode, webviewConfig };
