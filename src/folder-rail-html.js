'use strict';
// The folder rail's static markup (src/player-html.js puts it beside #stage): the right-edge fold-out tab, the
// rail with its header, filter, column header, list and footer, its two menus and the hover card. No file or
// folder name is in it: the list comes from the host as data (src/folder-rail.js) and media/folder-rail.js
// builds the rows with textContent. The look is media/folder-rail.css; docs/notes/folder-rail.md has the design.

// checkJs: start
// Icons on the bar's 24-unit grid with the bar's 1.6 stroke (src/bar.js).
const icon = (size, body, sw = '1.6') => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const ICONS = {
  // The fold-out edge tab's chevron: 12 px on a 20 x 84 px ribbon, large enough to grab on purpose.
  open: icon(12, '<path d="M15 18l-6-6 6-6"/>', '2'),
  close: icon(12, '<path d="M18 6L6 18M6 6l12 12"/>'),
  check: icon(9, '<path d="M20 6L9 17l-5-5"/>', '2.6'),
};

/** The column picker's and the Autoplay menu's choices (labels the page shows; values the host checks). */
const COLUMN_ITEMS = [['duration', 'Duration'], ['size', 'Size'], ['modified', 'Modified'], ['none', 'None']];
const ON_END_ITEMS = [['off', 'Off'], ['next', 'Play next in folder'], ['loop', 'Loop']];

const menu = (id, label, attr, items) => `<div id="${id}" class="vpe-pop" role="menu" aria-label="${label}" hidden>` +
  items.map(([v, l]) => `<button type="button" role="menuitemradio" aria-checked="false" data-${attr}="${v}"><span>${l}</span><span class="chk" aria-hidden="true"></span></button>`).join('') +
  '</div>';

/** The rail's markup (inside #main, after #stage). */
function folderRailHtml() {
  return `<div id="railEdge" class="edge-zone" hidden><button id="railOpenTab" class="edge-shelf" type="button" title="Open folder rail" aria-label="Open folder rail" tabindex="-1">${ICONS.open}</button></div>
<aside id="rail" class="rail dock" aria-label="Folder" hidden>
  <div id="railResizer" class="resizer" title="Drag to resize" aria-hidden="true"></div>
  <div class="r-head">
    <div id="railCrumb" class="r-crumb"></div>
    <button id="railClose" class="r-btn r-close" type="button" title="Close (Esc)" aria-label="Close folder rail">${ICONS.close}</button>
  </div>
  <div class="r-sub">
    <input id="railFilter" class="r-search" type="text" placeholder="Filter…" aria-label="Filter files" spellcheck="false" autocomplete="off">
    <button id="railPlayable" class="r-playable on" type="button" role="checkbox" aria-checked="true"><span class="r-chk-box">${ICONS.check}</span><span>Playable formats</span></button>
  </div>
  <div id="railColHead" class="col-head" title="Right-click to choose the column">
    <span>Name</span>
    <button id="railColBtn" class="col-pick" type="button" aria-haspopup="menu" aria-expanded="false" aria-controls="railColMenu">Duration ▾</button>
  </div>
  <div id="railList" class="r-list" role="listbox" aria-label="Files" tabindex="0"></div>
  <div class="r-foot">
    <button id="railEndBtn" class="end-btn" type="button" title="What happens when a video ends (also in ⚙ Settings)" aria-haspopup="menu" aria-expanded="false" aria-controls="railEndMenu"><span class="lbl">Autoplay:</span> <span id="railEndVal">Off</span> ▾</button>
    <span id="railPos" class="r-pos"></span>
  </div>
</aside>
${menu('railColMenu', 'Column', 'col', COLUMN_ITEMS)}
${menu('railEndMenu', 'Autoplay', 'end', ON_END_ITEMS)}
<div id="railHover" class="hover-pop" hidden aria-hidden="true"><div class="hover-body"><div id="railHoverName" class="hover-title"></div><div id="railHoverLine1" class="hover-meta"></div><div id="railHoverLine2" class="hover-meta"></div></div></div>`;
}

// checkJs: end

module.exports = { folderRailHtml, COLUMN_ITEMS, ON_END_ITEMS };
