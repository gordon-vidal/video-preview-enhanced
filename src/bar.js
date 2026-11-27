'use strict';
// The player's bar (seek bar and buttons) of the unified page (src/unified-html.js, one page for 1 to N videos;
// docs/notes/ui-simple.md, docs/notes/compare-ui.md). Compare's layout, swap, sync and panel buttons are in #cmpGroup,
// hidden until the page holds two videos or more (media/player-ui.js render).
const { ICONS } = require('../media/ui-primitives.js');

// Every bar icon: an 18 px box on a 24-unit grid with 1.6 stroke (= 1.20 px rendered) and uniform ~14.4-15u vertical span.
const STROKE = '1.6';
const svg = (body, cls = '') => {
  const variant = cls ? ' class="' + cls + '"' : '';
  return '<svg' + variant + ' width="18" height="18" viewBox="0 0 24 24" fill="none"' +
    ' stroke="currentColor" stroke-width="' + STROKE + '" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    body + '</svg>';
};

const frame = '<rect x="2.5" y="4.5" width="19" height="15" rx="1.5"/>';
const icons = {
  prev: svg('<path d="M5 4.8v14.4M19 4.8v14.4L8.8 12Z"/>'),
  play: svg('<path d="M7 4.8v14.4L19 12Z"/>', 'i-play'),
  pause: svg('<rect x="5.5" y="4.8" width="4.2" height="14.4" rx="1.2"/><rect x="14.3" y="4.8" width="4.2" height="14.4" rx="1.2"/>', 'i-pause'),
  next: svg('<path d="M19 4.8v14.4M5 4.8v14.4L15.2 12Z"/>'),
  sound: svg('<path d="M3.5 9.5H7l5-4v13l-5-4H3.5ZM15.5 9a4.2 4.2 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11"/>', 'i-sound'),
  muted: svg('<path d="M3.5 9.5H7l5-4v13l-5-4H3.5ZM15.5 9.5l5 5m0-5-5 5"/>', 'i-muted'),
  cc: svg('<rect x="3" y="5" width="18" height="14" rx="2"/>' +
    '<path d="M10.5 10h-2a1.5 1.5 0 0 0-1.5 1.5v1A1.5 1.5 0 0 0 8.5 14h2m6.5-4h-2a1.5 1.5 0 0 0-1.5 1.5v1A1.5 1.5 0 0 0 15 14h2"/>'),
  compare: svg(frame + '<path d="M12 4.5v15"/>'),
  about: svg('<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-9.5v.01"/>'),
  settings: svg('<circle cx="12" cy="12" r="3"/>' +
    '<path d="M10 3h4l.7 2.6 2.1 1.2 2.6-.7 2 3.5-1.9 1.9v2.4l1.9 1.9-2 3.5-2.6-.7-2.1 1.2L14 22h-4l-.7-2.2-2.1-1.2-2.6.7-2-3.5 1.9-1.9v-2.4L2.6 9.6l2-3.5 2.6.7 2.1-1.2Z" transform="translate(0 -.5)"/>'),
  full: svg('<path d="M4 9V4h5m11 5V4h-5M4 15v5h5m11-5v5h-5"/>'),
};
// The range buttons show the letters of their keys and of the pins on the seek bar (A, B), not an icon.
const rangeLabel = (letter) => '<span class="rngl" aria-hidden="true">' + letter + '</span>';
/** A step button with its step size badge (media/controls.js drawStepBadges fills it; a click opens the size popover). */
const stepButton = (id, title, label, key, icon) => '<span class="badgew stepw">' +
  '<button id="' + id + '" class="ib" title="' + title + '" aria-label="' + label + '" aria-keyshortcuts="' + key + '">' + icon + '</button>' +
  '<button id="' + id + 'Size" class="badge stepsz mono" data-default="1" title="Step size: 1 frame. Click to change"' +
  ' aria-label="Step size: 1 frame" aria-expanded="false" aria-controls="panel">1f</button></span>';
/**
 * The speed button with its reset badge (shown while the speed is not 1×; a click goes back to 1×; media/player-ui.js
 * drawBar).
 */
const speedButton = () => '<span class="badgew ratew">' +
  '<button id="rate" class="ib speed mono" title="Speed: click, or scroll to change (Shift+scroll: fine)" aria-label="Speed 1×"' +
  ' aria-expanded="false" aria-controls="panel">1×</button>' +
  '<button id="rateReset" class="badge ratereset" title="Normal speed (1×)" aria-label="Reset speed to 1×" hidden>' +
  '<svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"' +
  ' stroke-linejoin="round" aria-hidden="true"><path d="M4 12a8 8 0 1 0 2.5-5.8"/><path d="M4 3.5V9h5.5"/></svg></button></span>';
const playFlashHtml = `<div id="playFlash" aria-hidden="true">${icons.play}${icons.pause}</div>`;
const pictures = [
  svg(frame + '<rect x="8" y="8" width="8" height="8" rx="1"/>', 'i-fit'),
  svg('<rect x="2.5" y="4.5" width="19" height="15" rx="1.5" fill="currentColor" fill-opacity="0.3"/>', 'i-fill'),
  svg(frame + '<path d="M7 12h10m-7.8-2.2L7 12l2.2 2.2m5.6-4.4L17 12l-2.2 2.2"/>', 'i-stretch'),
  svg(frame + '<path d="M9 9h6v6H9Zm3 0v6m-3-3h6"/>', 'i-actual'),
].join('');

/** The Compare button: the Capture toggle (media/player-ui.js sets aria-pressed, its title and its label). */
const playerCompareButton = (visible) => `    <button id="startCompareBtn" class="ib" title="Compare" aria-label="Compare"` +
  `${visible ? '' : ' hidden'}>${icons.compare}</button>
`;

// The folder capsule (single player of a file only): previous / next video of the playing file's folder around its
// place in it ("2/5"), which also opens and closes the folder rail. Hidden until the page knows the folder has more
// than one video (media/folder-rail.js); never for URLs, image sequences or Compare.
const chevron = (d) => '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="' + STROKE +
  '" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="' + d + '"/></svg>';
const folderCapsule = `    <div id="folderCap" class="folder-cap" role="group" aria-label="Folder" hidden>
      <button id="capPrev" class="cap-btn" title="Previous video in folder  Shift+P" aria-label="Previous video in folder" aria-keyshortcuts="Shift+P">${chevron('M15 18l-6-6 6-6')}</button>
      <button id="capCount" class="cap-btn cap-count" title="Folder rail" aria-label="Folder rail" aria-expanded="false" aria-controls="rail"></button>
      <button id="capNext" class="cap-btn" title="Next video in folder  Shift+N" aria-label="Next video in folder" aria-keyshortcuts="Shift+N">${chevron('M9 18l6-6-6-6')}</button>
    </div>
`;

/** One button of the Compare capsule: hidden until the controller shows it (media/player-ui.js render). */
const cmpButton = (id, title, icon, label = title, extra = '') => `      <button id="${id}" class="ib" title="${title}" aria-label="${label}"${extra} hidden>${icon}</button>
`;
// The Compare capsule (two videos or more): layouts, Swap, Sync and the Compare panel, right before the Compare / Capture
// toggle. Same order and names the controller used to inject; the capsule itself is hidden below two videos.
const compareCapsule = `    <div id="cmpGroup" class="cmp-group" role="group" aria-label="Compare controls" hidden>
${cmpButton('spotlightBtn', 'Spotlight', ICONS.spotlight)}${cmpButton('gridBtn', 'Equal Grid', ICONS.grid)}${
  cmpButton('splitBtn', 'Split Wipe (2 videos)', ICONS.split)}${cmpButton('swapBtn', 'Swap sides  X', ICONS.swap)}${
  cmpButton('syncBtn', 'Sync frame offsets', ICONS.sync)}${
  cmpButton('cmpBtn', 'Compare: videos, offsets, clock, sound', ICONS.cmpPanel, 'Compare', ' aria-expanded="false" aria-controls="panel"')}    </div>
`;

/**
 * The bar's markup. `canCompare`: shows the Compare button; `folder`: the player of a file (adds the folder capsule).
 */
function barHtml({ canCompare = true, folder = false } = {}) {
  return `<div id="bar">
  <div id="seekRow">
    <input id="seek" type="range" min="0" max="0" value="0" step="1" aria-label="Position">
    <div id="buffered"></div>
    <div id="abMarks" hidden title="A–B range (loop &amp; export · A / B keys)"></div>
    <div id="abA" class="ab-pin" hidden aria-hidden="true" title="Drag to move range start (A)"><span>A</span></div>
    <div id="abB" class="ab-pin" hidden aria-hidden="true" title="Drag to move range end (B)"><span>B</span></div>
    <div id="tip" hidden></div>
  </div>
  <div id="row">
    ${stepButton('prev', 'Previous frame  ,', 'Previous frame', ',', icons.prev)}
    <button id="play" class="ib wide" title="Play  Space" aria-label="Play" aria-keyshortcuts="Space K">${icons.play}${icons.pause}</button>
    ${stepButton('next', 'Next frame  .', 'Next frame', '.', icons.next)}
    <span class="vol-wrap gap"><button id="mute" class="ib" title="Mute  M" aria-label="Mute" aria-pressed="false" aria-keyshortcuts="M">${icons.sound}${icons.muted}</button><span class="vol-slide"><input id="volume" class="range" type="range" min="0" max="1" step="0.05" value="1" title="Volume  ↑ ↓" aria-label="Volume"></span></span>
    <button id="time" class="mono" title="Click: time / timecode / frames" aria-label="Position"><span id="now">0:00.000</span> <span id="dur">/ 0:00.000</span></button>
    <button id="setABtn" class="ib rng" title="Set range start (A)" aria-label="Set range start (A)" aria-pressed="false" aria-keyshortcuts="A">${rangeLabel('A')}</button>
    <button id="setBBtn" class="ib rng" title="Set range end (B)" aria-label="Set range end (B)" aria-pressed="false" aria-keyshortcuts="B">${rangeLabel('B')}</button>
    <span class="spacer"></span>
    <button id="remoteLiveBtn" class="ib live-chip mono" title="Live transcode settings" aria-label="Live transcode settings" aria-expanded="false" aria-controls="panel" hidden></button>
    <button id="tracks" class="ib" title="Subtitles  C" aria-label="Subtitles" aria-expanded="false" aria-controls="panel" aria-keyshortcuts="C" hidden><span class="ccline">${icons.cc}</span></button>
${(folder ? folderCapsule : '') + compareCapsule + playerCompareButton(canCompare)}    <button id="infoBtn" class="ib" title="About this video  I" aria-label="About this video" aria-expanded="false" aria-controls="panel" aria-keyshortcuts="I">${icons.about}</button>
    ${speedButton()}
    <button id="cog" class="ib" title="Settings" aria-label="Settings" aria-expanded="false" aria-controls="panel">${icons.settings}</button>
    <button id="picBtn" class="ib" data-mode="fit" title="Picture size: Fit. Click for Fill  Z" aria-label="Picture size: Fit. Next: Fill" aria-keyshortcuts="Z">${pictures}</button>
    <button id="full" class="ib" title="Fullscreen  F" aria-label="Fullscreen" aria-keyshortcuts="F">${icons.full}</button>
  </div>
</div>`;
}

module.exports = { barHtml, playFlashHtml };
