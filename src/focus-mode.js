'use strict';

// Zen Mode belongs to the workbench, so the player and Compare share the toggle.
// VS Code toggles OS fullscreen asynchronously when entering/leaving Zen Mode;
// a short settle window prevents a rapid second click from racing a half-finished transition.
const DEFAULT_SETTLE_MS = 450;
const ZEN_CENTER_NOTICED_KEY = 'videoPreviewEnhanced.zenCenterNoticed';

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
 * One-time non-blocking offer when VS Code's Zen Mode still has Centered Layout on (default true):
 * never calls toggleCenteredLayout blindly (which corrupts normal VS Code layout if zenActive ever desyncs);
 * instead lets the user turn off `zenMode.centerLayout` permanently in one click.
 */
function maybeNoticeZenCenter(vscode, globalState) {
  if (!globalState || globalState.get(ZEN_CENTER_NOTICED_KEY)) return;
  if (!vscode.workspace.getConfiguration('zenMode').get('centerLayout', true)) return;
  Promise.resolve(globalState.update(ZEN_CENTER_NOTICED_KEY, true)).catch(() => {});
  const TURN_OFF = 'Turn Off Centered Layout';
  Promise.resolve(vscode.window.showInformationMessage(
    "Video Preview: VS Code's Zen Mode uses Centered Layout (side margins). Turn off zenMode.centerLayout so videos fill the screen?",
    TURN_OFF, 'Got it',
  )).then(async (pick) => {
    if (pick !== TURN_OFF) return;
    await vscode.workspace.getConfiguration('zenMode').update('centerLayout', false, vscode.ConfigurationTarget.Global);
    if (zenActive) await vscode.commands.executeCommand('workbench.action.toggleCenteredLayout');
  }).catch(() => {});
}

async function toggleFocusMode(vscode, { settleMs = DEFAULT_SETTLE_MS, globalState = null } = {}) {
  if (toggling) return undefined;
  toggling = true;
  try {
    await vscode.commands.executeCommand('workbench.action.toggleZenMode');
    zenActive = !zenActive;
    notify(zenActive);
    if (zenActive) maybeNoticeZenCenter(vscode, globalState);
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
