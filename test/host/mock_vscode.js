'use strict';
// A minimal `vscode` module for loading src/extension.js in plain Node.
// load() returns { ext, vscode, open(file) -> session handle with posted messages }.
const Module = require('module');
const path = require('path');

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
      return Object.assign(new Uri(m[1], p), { authority: m[2] || '', path: p, query: m[4] || '', fragment: m[5] || '' });
    }
    toString() {
      const enc = (x) => x.split('/').map(encodeURIComponent).join('/');
      return `${this.scheme}://${this.authority}${enc(this.path)}${this.query ? `?${this.query}` : ''}${this.fragment ? `#${this.fragment}` : ''}`;
    }
    with(c) { return Object.assign(Object.assign(new Uri(this.scheme, this.fsPath), this), c); }
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
    env: { remoteName: undefined, uriScheme: 'vscode', clipboard: { text: '', async writeText(t) { this.text = t; }, async readText() { return this.text; } }, openExternal: async () => true },
    window: {
      createOutputChannel: () => ({ lines: [], appendLine(l) { this.lines.push(l); }, show() {}, dispose() {} }),
      registerUriHandler: (h) => { vscode.uriHandler = h; return { dispose() {} }; },
      registerCustomEditorProvider: (t, p) => { providers[t] = p; return { dispose() {} }; },
      showInformationMessage: async () => undefined,
      showWarningMessage: async () => undefined,
      showErrorMessage: async () => undefined,
    },
    commands: {
      registerCommand: (id, fn) => { commands[id] = fn; return { dispose() {} }; },
      executeCommand: async (id, ...a) => { (vscode.executed = vscode.executed || []).push([id, ...a]); },
    },
    workspace: {
      isTrusted: true,
      getConfiguration: (sec) => ({
        get: (k, d) => (settings[`${sec}.${k}`] !== undefined ? settings[`${sec}.${k}`] : d),
        update: async (k, v) => { updates.push([`${sec}.${k}`, v]); },
        inspect: () => ({}),
      }),
      onDidChangeConfiguration: () => ({ dispose() {} }),
      fs: { writeFile: async () => {} },
    },
    _providers: providers, _commands: commands, _updates: updates,
  };
  return vscode;
}

function load({ settings, env, setup, state: sharedState } = {}) {
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
    extension: { id: 'gordon-vidal.video-preview-enhanced' },
    globalStorageUri: vscode.Uri.file(path.join(require('os').tmpdir(), 'vpe_host_test_storage')),
    extensionMode: vscode.ExtensionMode.Production,
    globalState: {
      state,
    get: (k) => state.get(k),
      update: async (k, v) => { state.set(k, v); context.stateWrites = (context.stateWrites || 0) + 1; },
    },
  };
  ext.activate(context);

  function open(file, { visible = true } = {}) {
    const posted = [];
    const listeners = {};
    const panel = {
      visible, viewColumn: 1,
      webview: {
        options: null, html: '', cspSource: 'vscode-resource:',
        asWebviewUri: (u) => ({ authority: vscode._webviewHost || 'file+.vscode-resource.vscode-cdn.net', toString: () => `https://webview/${u.path}` }),
        postMessage: (m) => { posted.push(m); return Promise.resolve(true); },
        onDidReceiveMessage: (fn) => { listeners.msg = fn; },
      },
      onDidDispose: (fn) => { (listeners.dispose = listeners.dispose || []).push(fn); },
      onDidChangeViewState: (fn) => { listeners.viewState = fn; },
      reveal() {},
      dispose() { for (const fn of listeners.dispose || []) fn(); },
    };
    const uri = typeof file === 'string' ? vscode.Uri.file(file) : file;
    const shown = vscode._providers['videoPreviewEnhanced.player'].resolveCustomEditor({ uri }, panel);
    return {
      panel, posted, shown,
      setVisible: (v) => { panel.visible = v; if (listeners.viewState) listeners.viewState(); },
      send: async (m) => {
        if (m.type === 'ready' && m.page === undefined) {
          if (!panel.webview.html) await shown;
          m = { ...m, page: webviewConfig(panel.webview).page };
        }
        return listeners.msg(m);
      },
      /** Waits until pred(posted) is true. */
      until: async (pred, ms = 5000) => {
        const t0 = Date.now();
        while (!pred(posted)) {
          if (Date.now() - t0 > ms) throw new Error('timeout');
          await new Promise((r) => setTimeout(r, 5));
        }
      },
    };
  }
  return { ext, vscode, context, open, dispose: () => { for (const s of subs) if (s && s.dispose) s.dispose(); } };
}

function webviewConfig(webview) {
  return JSON.parse(/<script type="application\/json" id="cfg">([^<]*)<\/script>/.exec(webview.html)[1]);
}

module.exports = { load, webviewConfig };
