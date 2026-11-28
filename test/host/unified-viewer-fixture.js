'use strict';

const path = require('node:path');
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
const context = { extensionUri: Uri.file(ROOT) };

module.exports = { Uri, fakePanel, vscode, deps, logs, cfgOf, context };
