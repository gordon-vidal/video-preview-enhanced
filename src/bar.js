'use strict';
// The player's bar (seek bar and buttons), shared by the player (src/extension.js html()) and compare
// (src/compare.js compareHtml), so both look and behave the same (docs/notes/ui-simple.md, docs/notes/compare-ui.md).
// Compare leaves out CC and adds the Compare button (two panes) that opens its panel.

const CMP_BTN = "    <button id=\"cmpBtn\" class=\"ib\" title=\"Compare: videos, offsets, clock, sound\" aria-label=\"Compare\" aria-expanded=\"false\" aria-controls=\"panel\"><svg width=\"21\" height=\"21\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.7\" stroke-linejoin=\"round\" aria-hidden=\"true\"><rect x=\"2.5\" y=\"5\" width=\"8.5\" height=\"14\" rx=\"1.5\"></rect><rect x=\"13\" y=\"5\" width=\"8.5\" height=\"14\" rx=\"1.5\"></rect></svg></button>\n";

/** The bar's markup; `compare`: the compare page's variant. */
function barHtml({ compare = false } = {}) {
  return `<div id="bar">
  <div id="seekRow">
    <input id="seek" type="range" min="0" max="0" value="0" step="1" aria-label="Position">
    <div id="buffered"></div>
    <div id="abMarks" hidden title="A-B loop (A / B keys)"></div>
    <div id="tip" hidden></div>
  </div>
  <div id="row">
    <button id="prev" class="ib" title="Previous frame  ," aria-label="Previous frame" aria-keyshortcuts=","><svg width="19" height="19" viewBox="0 0 24 24" fill="currentColor" stroke="none" stroke-width="0" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="5" width="2.2" height="14" rx="0.6"></rect><path d="M18.5 5.8v12.4a.8.8 0 0 1-1.25.66L9 13a1.2 1.2 0 0 1 0-2l8.25-5.86a.8.8 0 0 1 1.25.66z"></path></svg></button>
    <button id="play" class="ib wide" title="Play  Space" aria-label="Play" aria-keyshortcuts="Space K"><svg class="i-play" width="22" height="22" viewBox="0 0 24 24" fill="currentColor" stroke="none" stroke-width="0" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 4.5v15a1 1 0 0 0 1.5.86l12-7.5a1 1 0 0 0 0-1.72l-12-7.5A1 1 0 0 0 7 4.5z"></path></svg><svg class="i-pause" width="22" height="22" viewBox="0 0 24 24" fill="currentColor" stroke="none" stroke-width="0" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="6" y="4.5" width="4" height="15" rx="1"></rect><rect x="14" y="4.5" width="4" height="15" rx="1"></rect></svg></button>
    <button id="next" class="ib" title="Next frame  ." aria-label="Next frame" aria-keyshortcuts="."><svg width="19" height="19" viewBox="0 0 24 24" fill="currentColor" stroke="none" stroke-width="0" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="16.8" y="5" width="2.2" height="14" rx="0.6"></rect><path d="M5.5 5.8v12.4a.8.8 0 0 0 1.25.66L15 13a1.2 1.2 0 0 0 0-2L6.75 5.14a.8.8 0 0 0-1.25.66z"></path></svg></button>
    <button id="mute" class="ib gap" title="Mute  M" aria-label="Mute" aria-pressed="false" aria-keyshortcuts="M"><svg class="i-sound" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 9.5h3.5l5-4v13l-5-4H3.5z"></path><path d="M15.5 9a4.2 4.2 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11"></path></svg><svg class="i-muted" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 9.5h3.5l5-4v13l-5-4H3.5z"></path><path d="M15.5 9.5l5 5M20.5 9.5l-5 5"></path></svg></button>
    <input id="volume" type="range" min="0" max="1" step="0.05" value="1" title="Volume  ↑ ↓" aria-label="Volume">
    <button id="time" class="mono" title="Click: time / timecode / frames" aria-label="Position"><span id="now">0:00.000</span> <span id="dur">/ 0:00.000</span></button>
    <span class="spacer"></span>
${compare ? '' : `    <button id="tracks" class="ib" title="Subtitles  C" aria-label="Subtitles" aria-expanded="false" aria-controls="panel" aria-keyshortcuts="C"><span class="ccline"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"></rect><path d="M10.5 10h-2A1.5 1.5 0 0 0 7 11.5v1A1.5 1.5 0 0 0 8.5 14h2M17 10h-2a1.5 1.5 0 0 0-1.5 1.5v1A1.5 1.5 0 0 0 15 14h2"></path></svg></span></button>
`}
${compare ? CMP_BTN : ''}    <button id="infoBtn" class="ib" title="About this video  I" aria-label="About this video" aria-expanded="false" aria-controls="panel" aria-keyshortcuts="I"><svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="M12 11v6M12 7.5v.01"></path></svg></button>
    <button id="rate" class="ib speed mono" title="Speed: click, or scroll to change" aria-label="Speed 1×" aria-expanded="false" aria-controls="panel">1×</button>
    <button id="cog" class="ib" title="Settings" aria-label="Settings" aria-expanded="false" aria-controls="panel"><svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg></button>
    <button id="keysBtn" class="ib" title="Keyboard shortcuts  ?" aria-label="Keyboard shortcuts" aria-expanded="false" aria-keyshortcuts="?"><svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2.5" y="6" width="19" height="12" rx="2"></rect><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"></path></svg></button>
    <button id="full" class="ib" title="Fullscreen  F" aria-label="Fullscreen" aria-keyshortcuts="F"><svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"></path></svg></button>
  </div>
</div>`;
}

module.exports = { barHtml };
