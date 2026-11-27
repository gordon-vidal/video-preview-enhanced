'use strict';

// Zen Mode belongs to the workbench, so the player and Compare share the toggle.
// VS Code toggles OS fullscreen asynchronously when entering/leaving Zen Mode;
// a short settle window prevents a rapid second click from racing a half-finished transition.
const DEFAULT_SETTLE_MS = 450;

let zenActive = false;
let toggling = false;
/** @type {((active: boolean) => void) | null} */
let listener = null;
/** Saved global `zenMode.centerLayout` while we suppressed it for Zen Mode, restored on exit. @type {{ value: any } | null} */
let savedCenterLayout = null;

function setFocusModeListener(fn) {
  listener = typeof fn === 'function' ? fn : null;
}

function notify(active) {
  if (listener) listener(active);
}

/** Restores `zenMode.centerLayout` to what the user had before we entered Zen Mode. */
async function restoreCenterLayout(vscode) {
  if (!savedCenterLayout) return;
  const { value } = savedCenterLayout;
  savedCenterLayout = null;
  if (!vscode || !vscode.workspace || typeof vscode.workspace.getConfiguration !== 'function') return;
  try {
    const zenCfg = vscode.workspace.getConfiguration('zenMode');
    if (typeof zenCfg.update === 'function') {
      await zenCfg.update('centerLayout', value, vscode.ConfigurationTarget.Global);
    }
  } catch { /* ignore */ }
}

/**
 * Toggles VS Code Zen Mode without letting Zen Mode's default `zenMode.centerLayout` shrink the video:
 * sets `zenMode.centerLayout` to false while Zen Mode is active and restores the user's previous global
 * value only when leaving Zen Mode (VS Code live-reacts to `zenMode.centerLayout` changes while inside
 * Zen Mode, so restoring it immediately after entering would shrink the video back into Centered Layout).
 * Never calls `toggleCenteredLayout` blindly (which would corrupt normal VS Code layout on desync).
 */
async function toggleFocusMode(vscode, { settleMs = DEFAULT_SETTLE_MS } = {}) {
  if (toggling) return undefined;
  toggling = true;
  try {
    const entering = !zenActive;
    if (entering) {
      const zenCfg = vscode.workspace.getConfiguration('zenMode');
      if (zenCfg.get('centerLayout', true) === true && typeof zenCfg.update === 'function') {
        const prevGlobal = typeof zenCfg.inspect === 'function'
          ? zenCfg.inspect('centerLayout')?.globalValue
          : undefined;
        try {
          await zenCfg.update('centerLayout', false, vscode.ConfigurationTarget.Global);
          if (!savedCenterLayout) savedCenterLayout = { value: prevGlobal };
        } catch { /* read-only settings: proceed with toggleZenMode anyway */ }
      }
    }
    await vscode.commands.executeCommand('workbench.action.toggleZenMode');
    zenActive = !zenActive;
    if (!zenActive) await restoreCenterLayout(vscode);
    notify(zenActive);
    if (settleMs > 0) await new Promise((resolve) => setTimeout(resolve, settleMs));
    return zenActive;
  } finally {
    toggling = false;
  }
}

/** Called when the user exits Zen Mode outside the button (e.g. Esc Esc), so the next click stays in sync. */
function noteFocusModeExited(vscode) {
  if (!zenActive) return false;
  zenActive = false;
  restoreCenterLayout(vscode);
  notify(false);
  return true;
}

function isFocusModeActive() {
  return zenActive;
}

function resetFocusMode(vscode) {
  zenActive = false;
  toggling = false;
  restoreCenterLayout(vscode);
}

module.exports = {
  toggleFocusMode,
  noteFocusModeExited,
  isFocusModeActive,
  resetFocusMode,
  setFocusModeListener,
  DEFAULT_SETTLE_MS,
};
