'use strict';
// The notice shown when this ffmpeg's NVENC refuses the installed NVIDIA driver (transcode_probe.parseNvencDriverError).
// Maintainer decision 2026-11-27: lead with what failed and what it costs, offer a matching ffmpeg first, then a driver
// update, then keeping the slower encoder. Only encoding fails: GPU decoding still works, so the text never says it.

const DRIVER_PAGE = 'https://www.nvidia.com/Download/index.aspx';
const SETUP = 'Set up matching ffmpeg';
const DRIVER = 'Update NVIDIA driver';
const KEEP_CPU = 'Keep CPU encoding';
const KEEP_OTHER = 'Keep current encoder';

/** '610.00' -> '610'; '570.65' stays. */
function version(v) {
  return String(v).replace(/\.0+$/, '');
}

/**
 * @param {{ notice?: { minDriver?: string|null }|null, installedDriver?: string|null, host?: string|null,
 *   otherGpuEncoder?: boolean }} o host: the remote machine's name in a remote window (its ffmpeg and driver);
 *   otherGpuEncoder: another GPU encoder (Quick Sync, AMF ...) works, so Live transcode does not fall to the CPU.
 * @returns {{ text: string, severity: 'warning', actions: Array<{ id: 'setup'|'driver'|'keep', label: string }> }}
 */
function driverNotice(o = {}) {
  const min = o.notice && o.notice.minDriver ? version(o.notice.minDriver) : null;
  const have = o.installedDriver || null;
  const where = o.host ? o.host : 'this computer';
  let cause;
  if (min) cause = `this ffmpeg needs NVIDIA driver ${min} or newer${have ? `, and ${where} has ${have}` : ''}`;
  else cause = `this ffmpeg needs a newer NVIDIA driver${have ? ` than ${o.host ? `${o.host}'s` : 'this computer\'s'} ${have}` : ''}`;
  const effect = o.otherGpuEncoder
    ? 'Live transcode uses another GPU encoder instead, which may be slower.'
    : 'Live transcode encodes on the CPU instead, which is slower, uses more CPU and can stutter at 4K.';
  return {
    text: `GPU video encoding (NVENC) isn't available${o.host ? ` on ${o.host}` : ''}: ${cause}. ${effect}`,
    severity: 'warning',
    actions: [
      { id: 'setup', label: SETUP },
      { id: 'driver', label: DRIVER },
      { id: 'keep', label: o.otherGpuEncoder ? KEEP_OTHER : KEEP_CPU },
    ],
  };
}

/**
 * Shows the notice and carries out the choice. 'keep' and closing do nothing more: the caller has already recorded
 * this ffmpeg + driver pair, so the notice does not come back for it.
 * @param {any} vscode the VS Code API (window, env, Uri)
 * @param {ReturnType<typeof driverNotice>} model
 * @param {{ setupFfmpeg: () => any }} deps
 * @returns {Promise<'setup'|'driver'|'keep'|null>}
 */
async function showDriverNotice(vscode, model, deps) {
  const labels = model.actions.map((a) => a.label);
  const answer = await vscode.window.showWarningMessage(model.text, ...labels);
  const action = model.actions.find((a) => a.label === answer);
  if (!action) return null;
  if (action.id === 'setup') await deps.setupFfmpeg();
  else if (action.id === 'driver') await vscode.env.openExternal(vscode.Uri.parse(DRIVER_PAGE));
  return action.id;
}

module.exports = { DRIVER_PAGE, driverNotice, showDriverNotice };
