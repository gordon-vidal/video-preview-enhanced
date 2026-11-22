'use strict';

// Zen Mode belongs to the workbench, so the player and Compare share the toggle.
let zenActive = false;
let toggling = false;

async function toggleFocusMode(vscode) {
  if (toggling) return;
  toggling = true;
  try {
    await vscode.commands.executeCommand('workbench.action.toggleZenMode');
    zenActive = !zenActive;
    if (zenActive && vscode.workspace.getConfiguration('zenMode').get('centerLayout', true)) {
      await vscode.commands.executeCommand('workbench.action.toggleCenteredLayout');
    }
  } finally {
    toggling = false;
  }
}

module.exports = { toggleFocusMode };
