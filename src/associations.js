'use strict';
// The player's default-viewer and file-icon settings (workbench.editorAssociations, files.associations).
// Everything VS Code-shaped (settings reads and writes, notifications) and globalState are injected, so
// test/host/auto_default_test.js and file_icons_test.js drive it through the extension's mock, and a plain
// Node test can drive it with fakes. The commands' behaviour and the stored state formats are unchanged.

// checkJs: start
// MP4/WebM: VS Code's built-in preview also claims them, so the player is only an "option" for these
// (package.json). Every other supported format is priority "default" already. On first activation the
// player is made the default for these too, by writing workbench.editorAssociations (user settings).
const DEFAULT_PATTERNS = ['*.mp4', '*.webm', '*.MP4', '*.WEBM'];
const OURS = 'videoPreviewEnhanced.playerOptional';
const AUTO_DEFAULT_KEY = 'videoPreviewEnhanced.autoDefault';
/** @param {any} v */
const isOurs = (v) => typeof v === 'string' && v.startsWith('videoPreviewEnhanced.');

// ---- file icons ----
// Seti (VS Code's default file icon theme) gives only some video extensions its pink video icon. The manifest
// contributes a language "vpe-video" (no extensions of its own, no name, so not in the language picker) whose icon
// is a copy of Seti's; this maps the rest of the player's formats to it with files.associations (user settings).
// Not .mts (TypeScript's module extension, so a mapping would break .mts source files) and not .ts.
const FILE_ICON_EXTS = ['mkv', 'flv', 'mpeg', 'm2ts', 'wmv', '3gp', 'm4v', 'vob', 'divx', 'asf', 'mxf', 'y4m'];
const FILE_ICON_LANG = 'vpe-video';
const FILE_ICONS_KEY = 'videoPreviewEnhanced.fileIcons'; // globalState: { added: [patterns we wrote], seen: [patterns handled] }

/**
 * @param {object} deps
 * @param {any} deps.vscode  workspace.getConfiguration, window.showInformationMessage, ConfigurationTarget
 * @param {() => ({ get(key: string): any, update(key: string, value: any): PromiseLike<void> } | undefined)} deps.getState
 *   globalState; a getter because the extension builds it in activate()
 * @param {(msg: string) => void} deps.log
 */
function createAssociations(deps) {
  const { vscode, getState, log } = deps;
  /** The globalState, which activate() sets before any of this runs. */
  const state = () => /** @type {NonNullable<ReturnType<typeof getState>>} */ (getState());

  /** User-level associations only (workspace values are never copied into user settings). */
  function userAssociations() {
    const i = vscode.workspace.getConfiguration('workbench').inspect('editorAssociations') || {};
    const g = i.globalValue;
    return g && typeof g === 'object' && !Array.isArray(g) ? { ...g } : {};
  }
  /** @param {string} p */
  function effectiveAssociation(p) {
    const all = vscode.workspace.getConfiguration('workbench').get('editorAssociations');
    return all && typeof all === 'object' && !Array.isArray(all) ? all[p] : undefined;
  }

  /**
   * The command: fills every MP4/WebM pattern that is missing (an entry the user set to another editor
   * stays). on=false removes only entries pointing at this player. Returns the patterns changed.
   * @param {boolean} on
   */
  async function makeDefault(on, { silent = false } = {}) {
    const assoc = userAssociations();
    /** @type {string[]} */
    const changed = [];
    for (const p of DEFAULT_PATTERNS) {
      if (on) { if (assoc[p] === undefined) { assoc[p] = OURS; changed.push(p); } }
      else if (isOurs(assoc[p])) { delete assoc[p]; changed.push(p); }
    }
    try {
      if (changed.length) await vscode.workspace.getConfiguration('workbench').update('editorAssociations', assoc, vscode.ConfigurationTarget.Global);
    } catch (/** @type {any} */ e) {
      log(`editorAssociations: write failed: ${e && e.message || e}`);
      return [];
    }
    if (!silent) vscode.window.showInformationMessage(on
      ? 'Video Preview Enhanced now opens MP4 and WebM files. Undo with "Video Preview: Use VS Code\'s Preview for MP4/WebM".'
      : 'MP4 and WebM open in VS Code\'s own preview again.');
    return changed;
  }

  /** Undo: removes our entries and forgets what autoDefault added (patterns stay "seen": it never re-adds them). */
  async function undoDefault({ silent = false } = {}) {
    await makeDefault(false, { silent });
    const st = state().get(AUTO_DEFAULT_KEY);
    if (st) await state().update(AUTO_DEFAULT_KEY, { ...st, added: [] });
  }

  /**
   * Once per install, and again when an update adds patterns: fills workbench.editorAssociations for the
   * patterns VS Code's built-in preview claims, without asking. A pattern the user already set (to anything,
   * in any scope) is left alone. Runs in untrusted workspaces too: it only touches user settings.
   * State: { seen: patterns handled, added: patterns written by us }.
   */
  async function autoDefault() {
    try {
      const st = state().get(AUTO_DEFAULT_KEY) || { seen: [], added: [] };
      const todo = DEFAULT_PATTERNS.filter((p) => !st.seen.includes(p));
      if (!todo.length) return;
      const assoc = userAssociations();
      /** @type {string[]} */
      const added = [];
      for (const p of todo) {
        if (assoc[p] === undefined && effectiveAssociation(p) === undefined) { assoc[p] = OURS; added.push(p); }
      }
      if (added.length) await vscode.workspace.getConfiguration('workbench').update('editorAssociations', assoc, vscode.ConfigurationTarget.Global);
      await state().update(AUTO_DEFAULT_KEY, { seen: [...st.seen, ...todo], added: [...st.added, ...added] });
      // No notification: installing this extension is the request for a better video preview.
      // The command "Use VS Code's Preview for MP4/WebM" (undoDefault) still reverts it.
      if (added.length) log(`default viewer for ${added.join(', ')} (undo: the "Use VS Code's Preview for MP4/WebM" command)`);
    } catch (/** @type {any} */ e) {
      log(`autoDefault failed: ${e && e.message || e}`); // never shown; the command still works
    }
  }

  async function fileIcons({ force = false } = {}) {
    try {
      const on = vscode.workspace.getConfiguration('videoPreviewEnhanced').get('overrideFileIcons', true);
      const cfg = vscode.workspace.getConfiguration('files');
      const g = (cfg.inspect('associations') || {}).globalValue;
      const assoc = g && typeof g === 'object' && !Array.isArray(g) ? { ...g } : {};
      const eff = cfg.get('associations');
      const st = state().get(FILE_ICONS_KEY) || { added: [], seen: [] };
      let added = [...st.added];
      let seen = [...st.seen];
      let changed = false;
      if (on) {
        for (const ext of FILE_ICON_EXTS) {
          const p = `*.${ext}`;
          if (!force && seen.includes(p)) continue; // the user may have removed it on purpose
          if (!seen.includes(p)) seen.push(p);
          const other = eff && typeof eff === 'object' && !Array.isArray(eff) ? eff[p] : undefined;
          if (assoc[p] === undefined && other === undefined) { assoc[p] = FILE_ICON_LANG; if (!added.includes(p)) added.push(p); changed = true; }
        }
      } else {
        for (const p of added) if (assoc[p] === FILE_ICON_LANG) { delete assoc[p]; changed = true; }
        added = [];
        seen = [];
      }
      if (changed) await cfg.update('associations', assoc, vscode.ConfigurationTarget.Global);
      // Every window start runs this: write only when the record changed (a globalState write is a disk round trip).
      if (JSON.stringify(st) !== JSON.stringify({ added, seen })) await state().update(FILE_ICONS_KEY, { added, seen });
    } catch (/** @type {any} */ e) {
      log(`fileIcons failed: ${e && e.message || e}`); // never shown
    }
  }

  return { makeDefault, undoDefault, autoDefault, fileIcons, userAssociations, effectiveAssociation };
}
// checkJs: end

module.exports = { createAssociations, DEFAULT_PATTERNS, FILE_ICON_EXTS };
