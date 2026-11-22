'use strict';
// The player's bar (seek bar and buttons), shared by the player (src/extension.js html()) and compare
// (src/compare.js compareHtml), so both look and behave the same (docs/notes/ui-simple.md, docs/notes/compare-ui.md).
// Compare leaves out CC and the player's Compare button, and adds its own panel and reorder buttons.

// Every bar icon: a 20 px box on a 24-unit grid, one stroke width with round caps and joins, in the text colour.
// Transport glyphs (frame steps, play, pause) are solid: the same outline, filled, so their corners match the rest.
const STROKE = '1.7';
const svg = (body, cls = '', solid = false) => {
  const variant = cls ? ' class="' + cls + '"' : '';
  return '<svg' + variant + ' width="20" height="20" viewBox="0 0 24 24" fill="' + (solid ? 'currentColor' : 'none') + '"' +
    ' stroke="currentColor" stroke-width="' + STROKE + '" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    body + '</svg>';
};

const icons = {
  prev: svg('<path d="M6 6.5v11M18 6.5v11L9.5 12Z"/>', '', true),
  play: svg('<path d="M7.5 5v14L19 12Z"/>', 'i-play', true),
  pause: svg('<rect x="6.5" y="5.5" width="3.5" height="13" rx=".5"/><rect x="14" y="5.5" width="3.5" height="13" rx=".5"/>', 'i-pause', true),
  next: svg('<path d="M18 6.5v11M6 6.5v11L14.5 12Z"/>', '', true),
  sound: svg('<path d="M3.5 9.5H7l5-4v13l-5-4H3.5ZM15.5 9a4.2 4.2 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11"/>', 'i-sound'),
  muted: svg('<path d="M3.5 9.5H7l5-4v13l-5-4H3.5ZM15.5 9.5l5 5m0-5-5 5"/>', 'i-muted'),
  cc: svg('<rect x="3" y="5" width="18" height="14" rx="2"/>' +
    '<path d="M10.5 10h-2a1.5 1.5 0 0 0-1.5 1.5v1A1.5 1.5 0 0 0 8.5 14h2m6.5-4h-2a1.5 1.5 0 0 0-1.5 1.5v1A1.5 1.5 0 0 0 15 14h2"/>'),
  compare: svg('<rect x="2.5" y="5" width="7" height="14" rx="1.5"/><rect x="14.5" y="5" width="7" height="14" rx="1.5"/>'),
  about: svg('<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-9.5v.01"/>'),
  settings: svg('<circle cx="12" cy="12" r="3"/>' +
    '<path d="M10 3h4l.7 2.6 2.1 1.2 2.6-.7 2 3.5-1.9 1.9v2.4l1.9 1.9-2 3.5-2.6-.7-2.1 1.2L14 22h-4l-.7-2.2-2.1-1.2-2.6.7-2-3.5 1.9-1.9v-2.4L2.6 9.6l2-3.5 2.6.7 2.1-1.2Z" transform="translate(0 -.5)"/>'),
  full: svg('<path d="M4 9V4h5m11 5V4h-5M4 15v5h5m11-5v5h-5"/>'),
};
const frame = '<rect x="2.5" y="4.5" width="19" height="15" rx="1.5"/>';
const pictures = [
  svg(frame + '<rect x="8" y="8" width="8" height="8" rx="1"/>', 'i-fit'),
  svg('<rect x="2.5" y="4.5" width="19" height="15" rx="1.5" fill="currentColor" fill-opacity="0.3"/>', 'i-fill'),
  svg(frame + '<path d="M7 12h10m-7.8-2.2L7 12l2.2 2.2m5.6-4.4L17 12l-2.2 2.2"/>', 'i-stretch'),
  svg(frame + '<path d="M9 9h6v6H9Zm3 0v6m-3-3h6"/>', 'i-actual'),
].join('');

const compareButton = `    <button id="cmpBtn" class="ib" title="Compare: videos, offsets, clock, sound" aria-label="Compare" aria-expanded="false" aria-controls="panel">${icons.compare}</button>\n`;
/** The player's Compare button: starts Compare after a confirmation, or adds to an open one (`open`). */
const playerCompareButton = (visible, open) => {
  const label = open ? 'Add to Compare' : 'Compare';
  const popup = open ? '' : ' aria-haspopup="dialog" aria-controls="startCompareDialog" aria-expanded="false"';
  return `    <button id="startCompareBtn" class="ib" title="${label}" aria-label="${label}"${popup} data-open="${open ? 1 : 0}"` +
    `${visible ? '' : ' hidden'}>${icons.compare}<span id="startCompareLabel">${label}</span></button>
`;
};

/** The bar's markup; `compare`: the compare page's variant. */
function barHtml({ compare = false, canCompare = true, compareOpen = false } = {}) {
  return `<div id="bar">
  <div id="seekRow">
    <input id="seek" type="range" min="0" max="0" value="0" step="1" aria-label="Position">
    <div id="buffered"></div>
    <div id="abMarks" hidden title="A-B loop (A / B keys)"></div>
    <div id="tip" hidden></div>
  </div>
  <div id="row">
    <button id="prev" class="ib" title="Previous frame  ," aria-label="Previous frame" aria-keyshortcuts=",">${icons.prev}</button>
    <button id="play" class="ib wide" title="Play  Space" aria-label="Play" aria-keyshortcuts="Space K">${icons.play}${icons.pause}</button>
    <button id="next" class="ib" title="Next frame  ." aria-label="Next frame" aria-keyshortcuts=".">${icons.next}</button>
    <button id="mute" class="ib gap" title="Mute  M" aria-label="Mute" aria-pressed="false" aria-keyshortcuts="M">${icons.sound}${icons.muted}</button>
    <input id="volume" type="range" min="0" max="1" step="0.05" value="1" title="Volume  ↑ ↓" aria-label="Volume">
    <button id="time" class="mono" title="Click: time / timecode / frames" aria-label="Position"><span id="now">0:00.000</span> <span id="dur">/ 0:00.000</span></button>
    <span class="spacer"></span>
${compare ? '    <button id="reorderBtn" class="ib" aria-controls="cells">Reorder</button>\n' : ''}
${compare ? '' : `    <button id="tracks" class="ib" title="Subtitles  C" aria-label="Subtitles" aria-expanded="false" aria-controls="panel" aria-keyshortcuts="C" hidden><span class="ccline">${icons.cc}</span></button>
`}
${compare ? compareButton : playerCompareButton(canCompare, compareOpen)}    <button id="infoBtn" class="ib" title="About this video  I" aria-label="About this video" aria-expanded="false" aria-controls="panel" aria-keyshortcuts="I">${icons.about}</button>
    <button id="rate" class="ib speed mono" title="Speed: click, or scroll to change" aria-label="Speed 1×" aria-expanded="false" aria-controls="panel">1×</button>
    <button id="cog" class="ib" title="Settings" aria-label="Settings" aria-expanded="false" aria-controls="panel">${icons.settings}</button>
    <button id="picBtn" class="ib" data-mode="fit" title="Picture size: Fit. Click for Fill  Z" aria-label="Picture size: Fit. Next: Fill" aria-keyshortcuts="Z">${pictures}</button>
    <button id="full" class="ib" title="Fullscreen  F" aria-label="Fullscreen" aria-keyshortcuts="F">${icons.full}</button>
  </div>
</div>`;
}

module.exports = { barHtml };
