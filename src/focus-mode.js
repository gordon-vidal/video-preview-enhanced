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

async function toggleFocusMode(vscode, { settleMs = DEFAULT_SETTLE_MS } = {}) {
  if (toggling) return undefined;
  toggling = true;
  try {
    await vscode.commands.executeCommand('workbench.action.toggleZenMode');
    zenActive = !zenActive;
    if (zenActive && vscode.workspace.getConfiguration('zenMode').get('centerLayout', true)) {
      await vscode.commands.executeCommand('workbench.action.toggleCenteredLayout');
    }
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
