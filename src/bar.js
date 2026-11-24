'use strict';
// The player's bar (seek bar and buttons), shared by the player (src/extension.js html()) and compare
// (src/compare.js compareHtml), so both look and behave the same (docs/notes/ui-simple.md, docs/notes/compare-ui.md).
// Compare leaves out CC and the player's Compare button, and adds its own panel and reorder buttons.

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
  cmpPanel: svg('<path d="M9.5 6.5h10M9.5 12h10M9.5 17.5h10"/>' +
    '<circle cx="5.2" cy="6.5" r="0.9" fill="currentColor" stroke="none"/>' +
    '<circle cx="5.2" cy="12" r="0.9" fill="currentColor" stroke="none"/>' +
    '<circle cx="5.2" cy="17.5" r="0.9" fill="currentColor" stroke="none"/>'),
  spotlight: svg('<rect x="4" y="4.5" width="16" height="9.5" rx="1.6"/>' +
    '<rect x="4" y="16.5" width="6.8" height="3.2" rx="0.9"/>' +
    '<rect x="13.2" y="16.5" width="6.8" height="3.2" rx="0.9"/>'),
  grid: svg('<rect x="4" y="4" width="6.8" height="6.8" rx="1.3"/>' +
    '<rect x="13.2" y="4" width="6.8" height="6.8" rx="1.3"/>' +
    '<rect x="4" y="13.2" width="6.8" height="6.8" rx="1.3"/>' +
    '<rect x="13.2" y="13.2" width="6.8" height="6.8" rx="1.3"/>'),
  split: svg('<rect x="4" y="5" width="16" height="14" rx="1.6"/><path d="M12 3v18"/>'),
  plus: svg('<path d="M12 5.5v13M5.5 12h13"/>'),
  sync: svg('<rect x="4" y="6" width="11.5" height="4.2" rx="1.1"/>' +
    '<rect x="8.5" y="13.8" width="11.5" height="4.2" rx="1.1"/>' +
    '<path d="M12 3.5v17" stroke-dasharray="1.8 2.2"/>'),
  about: svg('<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-9.5v.01"/>'),
  settings: svg('<circle cx="12" cy="12" r="3"/>' +
    '<path d="M10 3h4l.7 2.6 2.1 1.2 2.6-.7 2 3.5-1.9 1.9v2.4l1.9 1.9-2 3.5-2.6-.7-2.1 1.2L14 22h-4l-.7-2.2-2.1-1.2-2.6.7-2-3.5 1.9-1.9v-2.4L2.6 9.6l2-3.5 2.6.7 2.1-1.2Z" transform="translate(0 -.5)"/>'),
  full: svg('<path d="M4 9V4h5m11 5V4h-5M4 15v5h5m11-5v5h-5"/>'),
};
// The range buttons show the letters of their keys and of the pins on the seek bar (A, B), not an icon.
const rangeLabel = (letter) => '<span class="rngl" aria-hidden="true">' + letter + '</span>';
/** A step button with its step size badge (media/controls.js drawStepBadges fills it; a click opens the size popover). */
const stepButton = (id, title, label, key, icon) => '<span class="stepw">' +
  '<button id="' + id + '" class="ib" title="' + title + '" aria-label="' + label + '" aria-keyshortcuts="' + key + '">' + icon + '</button>' +
  '<button id="' + id + 'Size" class="stepsz mono" data-default="1" title="Step size: 1 frame. Click to change"' +
  ' aria-label="Step size: 1 frame" aria-expanded="false" aria-controls="panel">1f</button></span>';
const playFlashHtml = `<div id="playFlash" aria-hidden="true">${icons.play}${icons.pause}</div>`;
const pictures = [
  svg(frame + '<rect x="8" y="8" width="8" height="8" rx="1"/>', 'i-fit'),
  svg('<rect x="2.5" y="4.5" width="19" height="15" rx="1.5" fill="currentColor" fill-opacity="0.3"/>', 'i-fill'),
  svg(frame + '<path d="M7 12h10m-7.8-2.2L7 12l2.2 2.2m5.6-4.4L17 12l-2.2 2.2"/>', 'i-stretch'),
  svg(frame + '<path d="M9 9h6v6H9Zm3 0v6m-3-3h6"/>', 'i-actual'),
].join('');

const compareCapsule = `    <div id="cmpGroup" class="cmp-group" role="group" aria-label="Compare controls">
      <button id="layoutSpotlightBtn" class="ib" data-layout="spotlight" title="Spotlight layout" aria-label="Spotlight layout" aria-pressed="false">${icons.spotlight}</button>
      <button id="layoutGridBtn" class="ib" data-layout="grid" title="Equal Grid layout" aria-label="Equal Grid layout" aria-pressed="true">${icons.grid}</button>
      <button id="layoutSplitBtn" class="ib" data-layout="split" title="Split Wipe (2 videos)" aria-label="Split Wipe layout" aria-pressed="false" hidden>${icons.split}</button>
      <span class="cmp-sep" aria-hidden="true"></span>
      <button id="addPopBtn" class="ib" title="Add video to Compare" aria-label="Add video to Compare" aria-expanded="false" aria-controls="addPop">${icons.plus}</button>
      <button id="syncModeBtn" class="ib" title="Sync mode: adjust per-clip frame offsets" aria-label="Sync mode" aria-pressed="false">${icons.sync}</button>
      <button id="cmpBtn" class="ib" title="Compare: videos, offsets, clock, sound" aria-label="Compare" aria-expanded="false" aria-controls="panel">${icons.cmpPanel}</button>
    </div>\n`;
/** The player's Compare button: starts Compare after a confirmation, or adds to an open one (`open`). */
const playerCompareButton = (visible, open) => {
  const label = open ? 'Add to Compare' : 'Compare';
  const popup = open ? '' : ' aria-haspopup="dialog" aria-controls="startCompareDialog" aria-expanded="false"';
  return `    <button id="startCompareBtn" class="ib" title="${label}" aria-label="${label}"${popup} data-open="${open ? 1 : 0}"` +
    `${visible ? '' : ' hidden'}>${icons.compare}</button>
`;
};

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

/** The bar's markup; `compare`: the compare page's variant; `folder`: the player of a file (adds the folder capsule). */
function barHtml({ compare = false, canCompare = true, compareOpen = false, folder = false } = {}) {
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
    <span class="vol-wrap gap"><button id="mute" class="ib" title="Mute  M" aria-label="Mute" aria-pressed="false" aria-keyshortcuts="M">${icons.sound}${icons.muted}</button><span class="vol-slide"><input id="volume" type="range" min="0" max="1" step="0.05" value="1" title="Volume  ↑ ↓" aria-label="Volume"></span></span>
    <button id="time" class="mono" title="Click: time / timecode / frames" aria-label="Position"><span id="now">0:00.000</span> <span id="dur">/ 0:00.000</span></button>
    <button id="setABtn" class="ib rng" title="Set range start (A)" aria-label="Set range start (A)" aria-pressed="false" aria-keyshortcuts="A">${rangeLabel('A')}</button>
    <button id="setBBtn" class="ib rng" title="Set range end (B)" aria-label="Set range end (B)" aria-pressed="false" aria-keyshortcuts="B">${rangeLabel('B')}</button>
    <span class="spacer"></span>
    <button id="remoteLiveBtn" class="ib live-chip mono" title="Live transcode settings" aria-label="Live transcode settings" aria-expanded="false" aria-controls="panel" hidden></button>
${compare ? '' : `    <button id="tracks" class="ib" title="Subtitles  C" aria-label="Subtitles" aria-expanded="false" aria-controls="panel" aria-keyshortcuts="C" hidden><span class="ccline">${icons.cc}</span></button>
`}
${compare ? compareCapsule : (folder ? folderCapsule : '') + playerCompareButton(canCompare, compareOpen)}    <button id="infoBtn" class="ib" title="About this video  I" aria-label="About this video" aria-expanded="false" aria-controls="panel" aria-keyshortcuts="I">${icons.about}</button>
    <button id="rate" class="ib speed mono" title="Speed: click, or scroll to change" aria-label="Speed 1×" aria-expanded="false" aria-controls="panel">1×</button>
    <button id="cog" class="ib" title="Settings" aria-label="Settings" aria-expanded="false" aria-controls="panel">${icons.settings}</button>
    <button id="picBtn" class="ib" data-mode="fit" title="Picture size: Fit. Click for Fill  Z" aria-label="Picture size: Fit. Next: Fill" aria-keyshortcuts="Z">${pictures}</button>
    <button id="full" class="ib" title="Fullscreen  F" aria-label="Fullscreen" aria-keyshortcuts="F">${icons.full}</button>
  </div>
</div>`;
}

module.exports = { barHtml, playFlashHtml };
