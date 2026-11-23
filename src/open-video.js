'use strict';

// checkJs: start
/** @typedef {'active' | 'side' | 'window'} OpenTarget */
/** @typedef {{scheme: string, path: string, toString(): string}} FileUri */

const optionalExtensions = ['mp4', 'webm'];
const videoExtensions = [
  'avi', 'mkv', 'mov', 'wmv', 'flv', 'mpg', 'mpeg', 'm2ts', 'mts', '3gp', 'ogv', 'm4v', 'vob', 'divx',
  'asf', 'mxf', 'y4m', ...optionalExtensions,
];
const VIDEO_EXT = new RegExp('\\.(' + videoExtensions.join('|') + ')$', 'i');
const optionalVideo = new RegExp('\\.(' + optionalExtensions.join('|') + ')$', 'i');
const MOVE_TO_NEW_WINDOW = 'workbench.action.moveEditorToNewWindow';

function videoPickerOptions() {
  return {
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: false,
    openLabel: 'Open Video File',
    filters: { 'Video Files': [...videoExtensions], 'All Files': ['*'] },
  };
}

/** @param {unknown} uri @returns {uri is FileUri} */
function isLocalFile(uri) {
  return !!uri && typeof uri === 'object' && 'scheme' in uri && uri.scheme === 'file' &&
    'path' in uri && typeof uri.path === 'string' && uri.path.length > 0;
}

/** @param {OpenTarget} where @param {{Active: number, Beside: number}} columns */
function videoColumn(where, columns) {
  return where === 'side' ? columns.Beside : columns.Active;
}

/**
 * Palette calls use the active video when choosing a destination. Context calls
 * use the clicked resource, even if Explorer also supplies a multi-selection.
 * @param {OpenTarget} where
 * @param {unknown} clicked
 * @param {unknown} active
 */
function localVideoTarget(where, clicked, active) {
  if (where === 'active') return undefined;
  if (clicked !== undefined) return clicked;
  return isLocalFile(active) && VIDEO_EXT.test(active.path) ? active : undefined;
}

/** @param {FileUri} uri */
function playerViewType(uri) {
  return optionalVideo.test(uri.path) ? 'videoPreviewEnhanced.playerOptional' : 'videoPreviewEnhanced.player';
}
// checkJs: end

module.exports = { VIDEO_EXT, MOVE_TO_NEW_WINDOW, videoPickerOptions, isLocalFile, videoColumn, localVideoTarget, playerViewType };
