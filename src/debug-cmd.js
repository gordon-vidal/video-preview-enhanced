'use strict';
// The test hook (VPE_LOG only, never a setting: a workspace could point it at any file and run commands):
// JSON lines appended to <log>.cmd are sent to open viewers (debug actions) or run as commands. The Layer 3
// scenarios in test/vscode/ drive the extension through it. Everything the lines touch is injected.
// A line's "name" picks the viewers whose title contains it (src/unified-session.js titleOf); a "Compare" line goes to
// the viewers that show two videos or more.

// checkJs: start
/** Node's globals, untyped here (the check runs without @types/node). */
const node = /** @type {any} */ (globalThis);

// Commands the test hook may run: opening files and closing editors only, not the
// ones that change settings or install things (makeDefault, setupFfmpeg…).
const DEBUG_COMMANDS = new Set([
  'videoPreviewEnhanced.openWith', 'videoPreviewEnhanced.playSequence', 'videoPreviewEnhanced.compareWith',
  'videoPreviewEnhanced.addToCompareFromPlayer',
  'videoPreviewEnhanced.showLog', 'workbench.action.closeActiveEditor', 'workbench.action.closeAllEditors', 'workbench.action.reloadWindow',
  'notifications.clearAll', 'videoPreviewEnhanced.exportRange', 'videoPreviewEnhanced.addFromExplorer', 'videoPreviewEnhanced.stopAddFromExplorer', 'workbench.files.action.refreshFilesExplorer',
  'videoPreviewEnhanced.exportVideoRange', 'videoPreviewEnhanced.exportCompareVideoRange',
]);

/**
 * @param {object} deps
 * @param {any} deps.vscode
 * @param {any} deps.fs
 * @param {(msg: string) => void} deps.log
 * @param {string} deps.logFile  VPE_LOG; empty: no hook
 * @param {Set<any>} deps.viewers  the open viewers (src/unified-viewer.js createUnifiedViewer)
 * @param {any} deps.frameserver  src/frameserver.js
 * @param {any} deps.remotestream  src/remotestream.js (may be a lazy proxy)
 * @param {(hook: ((items: any[]) => Promise<any>) | null) => void} deps.setPickHook  src/comparepick.js
 * @param {(context: any, url: string, where: string) => Promise<any>} deps.openUrl
 * @param {(uri: any) => Promise<any>} deps.openLink
 * @param {() => void} deps.resetTools  forget the found ffmpeg (PATH may have changed)
 * @param {(files: any[] | undefined) => void} deps.setCompareFiles  the open dialog's result for the next Start Compare
 * @param {(viewer: any, index: number, uri: any) => Promise<any>} [deps.replaceClip]  a viewer's video at index replaced
 */
function createDebugCommands(deps) {
  const { vscode, fs, log, logFile, viewers, frameserver, remotestream, setPickHook, openUrl, openLink, resetTools, setCompareFiles } = deps;
  /** A viewer's tab title (its videos' names). @param {any} v */
  const nameOf = (v) => String(v.session && v.session.title || '');
  /** The viewers a line names (all without a name). @param {any} c */
  const named = (c) => [...viewers].filter((v) => !v.disposed && (!c.name || nameOf(v).includes(c.name)));
  /** The viewers that compare (two videos or more). */
  const comparing = () => [...viewers].filter((v) => !v.disposed && v.session.clips.length >= 2);

  /**
   * Test hook: throughput of the localhost frame server (src/frameserver.js) into the webview.
   * c: { benchFs: 'ws'|'http', size, count, name }. The webview logs "benchFs: ... MB/s".
   */
  function benchFrameServer(/** @type {any} */ c) {
    if (c.benchFs !== 'http' && c.benchFs !== 'ws') return;
    const size = c.size || 3110400;
    const count = c.count || 60;
    let data;
    for (const sess of named(c)) {
      // A viewer that exposes its frame server channel (framePort, webviewOrigin, benchChannels) takes part.
      if (!sess.framePort || !sess.webviewOrigin || !sess.benchChannels) continue;
      data ||= node.Buffer.alloc(size, 7);
      const ch = new frameserver.Channel({
        origin: sess.webviewOrigin,
        expiresIn: 60000,
        onClose: () => sess.benchChannels.delete(ch),
        onConnect: () => {
          let i = 0;
          const pump = () => {
            while (i < count && ch.connected) {
              ch.sendFrame(0, i / 30, 0, 0, 0, data);
              i++;
              if (ch.buffered > 4 * size) { ch.onDrain(pump); return; }
            }
            if (i >= count) ch.sendEnd(0);
          };
          pump();
        },
        onLost: () => ch.close(),
      });
      sess.benchChannels.add(ch);
      const urls = ch.urls();
      sess.post({ type: 'benchFs', mode: c.benchFs, url: urls[c.benchFs], count, size });
    }
  }

  /** Starts watching <log>.cmd (only with VPE_LOG). */
  function install(/** @type {any} */ context) {
    // Test hook: with VPE_LOG set, JSON lines appended to <log>.cmd are sent to
    // open players (debug actions) or run as commands.
    if (logFile) {
      const cmdFile = `${logFile}.cmd`;
      let seen = 0;
      fs.watchFile(cmdFile, { interval: 300 }, () => {
        fs.readFile(cmdFile, 'utf8', (err, text) => {
          if (err) return;
          const lines = text.split(String.fromCharCode(10)).map((l) => l.trim()).filter(Boolean);
          for (const line of lines.slice(seen)) {
            try {
              const c = JSON.parse(line);
              if (c.command) {
                if (DEBUG_COMMANDS.has(c.command)) vscode.commands.executeCommand(c.command, c.arg ? vscode.Uri.file(c.arg) : undefined);
                else log(`debug command not allowed: ${c.command}`);
                continue;
              }
              if (c.openUrl) { openUrl(context, String(c.openUrl), c.where === 'side' || c.where === 'window' ? c.where : 'active').catch((e) => log(`debug openUrl: ${e && e.stack || e}`)); continue; } // tests: skips the input box
              if (c.openLink) { openLink(vscode.Uri.parse(String(c.openLink))).catch((e) => log(`debug openLink: ${e && e.stack || e}`)); continue; } // tests: exercises the URI handler in real VS Code
              if (c.compareFiles) { // 2-4 files into compare: the command takes the selection form (uri, uris)
                const list = c.compareFiles.map((f) => vscode.Uri.file(f));
                vscode.commands.executeCommand('videoPreviewEnhanced.compare', list[0], list);
                continue;
              }
              if (c.startCompare || c.addToCompare) { // primary resource, then the selection
                const action = c.startCompare ? 'startCompare' : 'addToCompare';
                const list = c[action].map((f) => vscode.Uri.file(f));
                vscode.commands.executeCommand(`videoPreviewEnhanced.${action}`, list[0], list.length > 1 ? list : undefined)
                  .then(() => log(`debug done ${c.id || ''} ${action}`), (e) => log(`debug ${action} failed: ${e.message}`));
                continue;
              }
              if (c.pickCompare) { // tests: the next compare quick pick logs its rows and picks one (label part, or Browse…)
                setPickHook(async (items) => {
                  setPickHook(null);
                  log(`debug comparepick ${JSON.stringify(items.map((i) => i.label))}`);
                  return items.find((i) => i.uri && i.label.includes(c.pickCompare)) || undefined;
                });
                continue;
              }
              if (c.openFile) { // tests: opens a file as an Explorer click would (a preview tab in the active group)
                vscode.commands.executeCommand('vscode.open', vscode.Uri.file(c.openFile), { preview: c.preview !== false, preserveFocus: c.preserveFocus !== false })
                  .then(() => log(`debug done ${c.id || ''} openFile`), (e) => log(`debug openFile failed: ${e && e.message || e}`));
                continue;
              }
              if (c.openWithBurst) { // tests: several files opened at once through vscode.openWith, as an Explorer multi-selection does
                for (const f of c.openWithBurst) vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(f), c.viewType || 'videoPreviewEnhanced.player', { preview: false, preserveFocus: true }).then(undefined, (e) => log(`debug openWithBurst failed: ${e && e.message || e}`));
                continue;
              }
              if (c.compareAdd) {
                for (const v of comparing()) for (const f of c.compareAdd) v.addUri(vscode.Uri.file(f), { allowDuplicate: true }).catch((/** @type {any} */ e) => log(`debug compareAdd failed: ${e && e.message || e}`));
                continue;
              }
              // Scenario tests (test/vscode/scenarios.js) run many checks in one VS Code: between them they change
              // user settings, the extension host's environment (the VPE_* test switches, PATH) and clear the stored
              // state, as a fresh profile would have. Each answers "debug done <id>" once applied.
              if (c.settings) {
                const cfg = vscode.workspace.getConfiguration();
                Promise.all(Object.entries(c.settings).map(([k, v]) => cfg.update(k, v === null ? undefined : v, vscode.ConfigurationTarget.Global)))
                  .then(() => log(`debug done ${c.id} settings`), (e) => log(`debug done ${c.id} settings failed: ${e && e.message || e}`));
                continue;
              }
              if (c.env) {
                for (const [k, v] of Object.entries(c.env)) { if (v === null) delete node.process.env[k]; else node.process.env[k] = String(v); }
                resetTools(); // PATH may have gained or lost ffmpeg
                log(`debug done ${c.id} env`);
                continue;
              }
              if (c.resetState) {
                const keys = context.globalState.keys();
                Promise.all(keys.map((k) => context.globalState.update(k, undefined)))
                  .then(() => log(`debug done ${c.id} resetState ${keys.length}`), (e) => log(`debug done ${c.id} resetState failed: ${e && e.message || e}`));
                continue;
              }
              if (c.tabs) { // the editor tabs, for tests (compare takes a player's place)
                const tabs = vscode.window.tabGroups.all.map((g) => g.tabs.map((t) => ({ label: t.label, active: t.isActive, viewType: t.input && t.input.viewType ? String(t.input.viewType) : '' })));
                log(`tabs ${JSON.stringify(tabs)}`);
                continue;
              }
              if (c.compareReplace) {
                for (const v of comparing()) {
                  if (deps.replaceClip) deps.replaceClip(v, Number(c.compareReplace.index), vscode.Uri.file(c.compareReplace.file)).catch((/** @type {any} */ e) => log(`debug compareReplace failed: ${e && e.message || e}`));
                }
                continue;
              }
              if (c.compareWith) { // Start Compare from a viewer, with the open dialog's result supplied by the test
                const from = named(c).map((v) => v.session.clips.find((/** @type {any} */ x) => x.uri && (!x.kind || x.kind === 'file'))).find(Boolean);
                if (from) {
                  setCompareFiles(c.compareWith.map((/** @type {string} */ f) => vscode.Uri.file(f)));
                  vscode.commands.executeCommand('videoPreviewEnhanced.compareWith', from.uri, { t: Number(c.t) || 0 })
                    .then(undefined, (/** @type {any} */ e) => log(`debug compareWith failed: ${e.message}`));
                }
                continue;
              }
              if (c.compare) { for (const v of comparing()) v.post({ ...c, type: 'debug' }); continue; }
              if (c.pickSubtitles) {
                for (const v of viewers) if (nameOf(v) === c.name || nameOf(v).includes(c.name)) v.testPickSubtitles = c.pickSubtitles.map((/** @type {string} */ f) => vscode.Uri.file(f));
                log('debug subtitles picker ready');
                continue;
              }
              if (c.bench) {
                // Throughput of extension host -> webview messages (raw-frame transport test).
                for (const sess of named(c)) {
                  const size = c.size || 3110400;
                  sess.post({ type: 'benchStart', count: c.count || 60, size });
                  for (let i = 0; i < (c.count || 60); i++) sess.post({ type: 'bench', i, data: new Uint8Array(size) });
                }
                continue;
              }
              if (c.benchFs) { benchFrameServer(c); continue; }
              if (c.action === 'remoteStreamKill') {
                for (const v of named(c)) {
                  for (const x of v.session.clips) {
                    const d = v.decoderOf(x.id);
                    if (d instanceof remotestream.RemoteStream) d.proc?.kill('SIGKILL');
                  }
                }
                continue;
              }
              if (c.action === 'defaultKeybindings') {
                // VS Code's default keybindings for the given keys (docs/notes/ui-simple.md: which player keys a workbench command also gets).
                vscode.commands.executeCommand('workbench.action.openDefaultKeybindingsFile').then(async () => {
                  await new Promise((r) => setTimeout(r, 1500));
                  const ed = vscode.window.activeTextEditor;
                  const text = ed ? ed.document.getText() : '';
                  const want = new Set((c.keys || []).map((k) => String(k).toLowerCase()));
                  const found = [];
                  for (const m of text.matchAll(/\{\s*"key":\s*"([^"]+)",\s*"command":\s*"([^"]+)"(?:,\s*"when":\s*"((?:[^"\\]|\\.)*)")?/g)) {
                    if (want.has(m[1].toLowerCase()) || [...want].some((w) => m[1].toLowerCase().startsWith(`${w} `))) found.push({ key: m[1], command: m[2], when: m[3] || '' });
                  }
                  log(`debug keybindings ${JSON.stringify({ size: text.length, found })}`);
                  await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
                }, (e) => log(`debug keybindings failed: ${e && e.message || e}`));
                continue;
              }
              if (c.action === 'tabs') {
                const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs.map((t) => ({ label: t.label, active: t.isActive })));
                log(`debug tabs: ${JSON.stringify(tabs)}`);
                continue;
              }
              for (const v of named(c)) v.post({ ...c, type: 'debug' }); // type last: a line can't pose as another message
            } catch { log(`bad debug command: ${line}`); }
          }
          seen = lines.length;
        });
      });
      context.subscriptions.push({ dispose: () => fs.unwatchFile(cmdFile) });
    }
  }

  return { install, benchFrameServer };
}
// checkJs: end

module.exports = { createDebugCommands, DEBUG_COMMANDS };
