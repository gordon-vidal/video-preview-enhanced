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
 * sets `zenMode.centerLayout` to false once per session and restores the user's previous global value
 * only on `deactivate()` (`resetFocusMode`). Never flips `zenMode.centerLayout` back mid-session or
 * calls `toggleCenteredLayout` blindly — because VS Code has no API to query Zen Mode state, any
 * mid-session restore based on a local `zenActive` guess would shrink Zen Mode back into Centered
 * Layout whenever the user previously exited Zen Mode outside the webview.
 */
async function toggleFocusMode(vscode, { settleMs = DEFAULT_SETTLE_MS } = {}) {
  if (toggling) return undefined;
  toggling = true;
  try {
    if (!savedCenterLayout) {
      const zenCfg = vscode.workspace.getConfiguration('zenMode');
      if (zenCfg.get('centerLayout', true) === true && typeof zenCfg.update === 'function') {
        const prevGlobal = typeof zenCfg.inspect === 'function'
          ? zenCfg.inspect('centerLayout')?.globalValue
          : undefined;
        try {
          await zenCfg.update('centerLayout', false, vscode.ConfigurationTarget.Global);
          savedCenterLayout = { value: prevGlobal };
        } catch { /* read-only settings: proceed with toggleZenMode anyway */ }
      }
    }
    await vscode.commands.executeCommand('workbench.action.toggleZenMode');
    zenActive = !zenActive;
    notify(zenActive);
    if (settleMs > 0) await new Promise((resolve) => setTimeout(resolve, settleMs));
    return zenActive;
  } finally {
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

function resetFocusMode(vscode) {
  zenActive = false;
  toggling = false;
  return restoreCenterLayout(vscode);
}

module.exports = {
  toggleFocusMode,
  noteFocusModeExited,
  isFocusModeActive,
  resetFocusMode,
  setFocusModeListener,
  DEFAULT_SETTLE_MS,
};
