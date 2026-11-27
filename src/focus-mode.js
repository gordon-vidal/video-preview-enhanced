'use strict';

// Zen Mode belongs to the workbench, so the player and Compare share one stateless toggle.
// VS Code toggles OS fullscreen asynchronously when entering/leaving Zen Mode;
// a short settle window prevents a rapid second click from racing a half-finished transition.
// Never mutates `zenMode.centerLayout` or calls `toggleCenteredLayout`: VS Code exposes no API to
// query whether Zen Mode is currently active, so guessing state or overriding global settings
// risks corrupting normal layouts or fighting other windows.
const DEFAULT_SETTLE_MS = 450;

let toggling = false;

async function toggleFocusMode(vscode, { settleMs = DEFAULT_SETTLE_MS } = {}) {
  if (toggling) return undefined;
  toggling = true;
  try {
    await vscode.commands.executeCommand('workbench.action.toggleZenMode');
    if (settleMs > 0) await new Promise((resolve) => setTimeout(resolve, settleMs));
    return undefined;
  } finally {
    toggling = false;
  }
}

function resetFocusMode() {
  toggling = false;
}

module.exports = {
  toggleFocusMode,
  resetFocusMode,
  DEFAULT_SETTLE_MS,
};
