'use strict';

// Zen Mode belongs to the workbench, so the player and Compare share the toggle.
// VS Code toggles OS fullscreen asynchronously when entering/leaving Zen Mode;
// a short settle window prevents a rapid second click from racing a half-finished transition.
const DEFAULT_SETTLE_MS = 450;

let zenActive = false;
let toggling = false;
/** @type {((active: boolean) => void) | null} */
let listener = null;

function setFocusModeListener(fn) {
  listener = typeof fn === 'function' ? fn : null;
}

function notify(active) {
  if (listener) listener(active);
}

/**
 * Toggles VS Code Zen Mode without letting Zen Mode's default `zenMode.centerLayout` shrink the video:
 * temporarily sets `zenMode.centerLayout` to false around `toggleZenMode` and restores the user's previous
 * global value in `finally`. Never calls `toggleCenteredLayout` blindly (which would turn Centered Layout on
 * in normal VS Code whenever `zenActive` gets out of sync).
 */
async function toggleFocusMode(vscode, { settleMs = DEFAULT_SETTLE_MS } = {}) {
  if (toggling) return undefined;
  toggling = true;
  const zenCfg = vscode.workspace.getConfiguration('zenMode');
  const needOverride = zenCfg.get('centerLayout', true) === true;
  const prevGlobal = needOverride && typeof zenCfg.inspect === 'function'
    ? zenCfg.inspect('centerLayout')?.globalValue
    : undefined;
  let overridden = false;
  try {
    if (needOverride && typeof zenCfg.update === 'function') {
      try {
        await zenCfg.update('centerLayout', false, vscode.ConfigurationTarget.Global);
        overridden = true;
      } catch { /* read-only settings: proceed with toggleZenMode anyway */ }
    }
    await vscode.commands.executeCommand('workbench.action.toggleZenMode');
    zenActive = !zenActive;
    notify(zenActive);
    if (settleMs > 0) await new Promise((resolve) => setTimeout(resolve, settleMs));
    return zenActive;
  } finally {
    if (overridden) {
      try { await zenCfg.update('centerLayout', prevGlobal, vscode.ConfigurationTarget.Global); } catch { /* ignore */ }
    }
    toggling = false;
  }
}

/** Called when the user exits Zen Mode outside the button (e.g. Esc Esc), so the next click stays in sync. */
function noteFocusModeExited() {
  if (!zenActive) return false;
  zenActive = false;
  notify(false);
  return true;
}

function isFocusModeActive() {
  return zenActive;
}

function resetFocusMode() {
  zenActive = false;
  toggling = false;
}

module.exports = {
  toggleFocusMode,
  noteFocusModeExited,
  isFocusModeActive,
  resetFocusMode,
  setFocusModeListener,
  DEFAULT_SETTLE_MS,
};
