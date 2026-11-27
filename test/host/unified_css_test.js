'use strict';
// node test/run.js unit --grep unified_css: media/player.css and media/compare.css loaded together, as the unified page
// (src/unified-html.js UNIFIED_CSS) and the mock-up harness (tools/mockup/render.js) do. One video has no body.compare;
// Compare (two or more) has. Checks: both files parse (balanced braces), the selectors the unified controller's DOM
// needs exist, and compare.css never restyles the player's own elements unless the rule is scoped to Compare.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { UNIFIED_CSS } = require('../../src/unified-html');

const MEDIA = path.join(__dirname, '..', '..', 'media');
const read = (f) => fs.readFileSync(path.join(MEDIA, f), 'utf8').replace(/^﻿/, '');
const PLAYER = read('player.css');
const COMPARE = read('compare.css');

/** Comments out, strings kept (a brace inside `content: '}'` is not a block). */
const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));

/** Brace depth never below zero and back to zero at the end, outside strings. @param {string} css */
function balanced(css) {
  let depth = 0, quote = '';
  for (const ch of stripComments(css)) {
    if (quote) { if (ch === quote) quote = ''; continue; }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth < 0) return false;
  }
  return depth === 0 && !quote;
}

/** Split at a separator outside (), [] and strings. @param {string} s @param {RegExp} sep one character */
function splitTop(s, sep) {
  const out = [];
  let depth = 0, cur = '', quote = '';
  for (const ch of s) {
    if (quote) { cur += ch; if (ch === quote) quote = ''; continue; }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    if (depth === 0 && sep.test(ch)) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

/**
 * Style rules, flattened out of @media / @supports; @keyframes skipped.
 * @param {string} css
 * @returns {{ selectors: string[], body: string, at: string }[]}
 */
function rules(css) {
  const src = stripComments(css);
  const out = [];
  let i = 0;
  const block = (from) => { // index just past the } that closes the { at `from`
    let depth = 0;
    for (let j = from; j < src.length; j++) {
      if (src[j] === '{') depth++;
      else if (src[j] === '}' && --depth === 0) return j + 1;
    }
    throw new Error('unbalanced');
  };
  const walk = (start, end, at) => {
    i = start;
    while (i < end) {
      const open = src.indexOf('{', i);
      if (open < 0 || open >= end) break;
      const prelude = src.slice(i, open).replace(/^[\s;}]+/, '').trim();
      const close = block(open);
      if (/^@(media|supports|layer|container)\b/.test(prelude)) {
        walk(open + 1, close - 1, prelude);
      } else if (!prelude.startsWith('@')) {
        out.push({ selectors: splitTop(prelude, /,/), body: src.slice(open + 1, close - 1).trim(), at });
      }
      i = close;
    }
  };
  walk(0, src.length, '');
  return out;
}

const norm = (s) => s.replace(/\s+/g, ' ').replace(/\s*([>+~])\s*/g, ' $1 ').trim();
const selectorsOf = (css) => new Set(rules(css).flatMap((r) => r.selectors.map(norm)));
/** Declarations of the first rule (outside @media) whose selector list holds `sel`. */
const declsOf = (css, sel) => {
  const r = rules(css).find((x) => !x.at && x.selectors.map(norm).includes(norm(sel)));
  assert.ok(r, `no rule for ${sel}`);
  return Object.fromEntries(splitTop(r.body, /;/).map((d) => {
    const k = d.indexOf(':');
    return [d.slice(0, k).trim(), d.slice(k + 1).trim()];
  }));
};
/** Every selector in `css` that `test` accepts (for "some rule styles X"). */
const anySelector = (css, test) => [...selectorsOf(css)].some(test);

{ // The unified page loads both, player.css first (compare.css overrides on top of it).
  assert.ok(UNIFIED_CSS.indexOf('player.css') >= 0 && UNIFIED_CSS.indexOf('player.css') < UNIFIED_CSS.indexOf('compare.css'));
}

{ // Both files parse: braces balance (an unclosed block swallows every rule after it without an error).
  assert.ok(balanced(PLAYER), 'player.css braces');
  assert.ok(balanced(COMPARE), 'compare.css braces');
  assert.ok(!balanced('a { b { }'), 'the check sees an open block');
  assert.ok(!balanced('a { } }'), 'the check sees a stray close');
  assert.ok(balanced('a::after { content: "}" }'), 'a brace in a string is text');
  assert.ok(rules(PLAYER).length > 100 && rules(COMPARE).length > 50, 'both files parse into rules');
}

{ // The selectors the unified controller's DOM needs (media/player-ui.js, player-ui-lifecycle.js, src/unified-html.js).
  const has = (css, re, what) => assert.ok(anySelector(css, (s) => re.test(s)), `${what} is styled`);
  // player.css: one video and the shared overlay, thumbnail, notice and subtitles.
  has(PLAYER, /(^|[\s>])canvas\.seek-thumb$/, 'canvas.seek-thumb');
  has(PLAYER, /\.seek-thumb\[hidden\]$/, '.seek-thumb[hidden]');
  has(PLAYER, /#overlay \.overlay-line$/, '#overlay .overlay-line');
  has(PLAYER, /^#overlay\.error$/, '#overlay.error');
  has(PLAYER, /#overlay \.overlay-action$/, '#overlay .overlay-action');
  has(PLAYER, /#overlay \.overlay-action:hover$/, '#overlay .overlay-action:hover');
  has(PLAYER, /#overlay \.overlay-action:disabled$/, '#overlay .overlay-action:disabled');
  has(PLAYER, /^#notice$/, '#notice');
  has(PLAYER, /^#subs$/, '#subs');
  // compare.css: the tiles and Compare's controls.
  has(COMPARE, /^#cells$/, '#cells');
  has(COMPARE, /^#cells\.dense\b/, '#cells.dense');
  // #splitter is <div id="splitter" class="splitter">: compare.css styles it by its class (shared with media/compare.js).
  has(COMPARE, /^(#splitter|\.splitter)$/, '#splitter (.splitter)');
  has(COMPARE, /^(#splitter|\.splitter)\[hidden\]$/, '#splitter[hidden]');
  has(COMPARE, /^#divider$/, '#divider');
  has(COMPARE, /^#menu$/, '#menu');
  has(COMPARE, /^\.tile-stats$/, '.tile-stats');
  has(COMPARE, /^\.sync-pill\b/, '.sync-pill');
  has(COMPARE, /^#stage\.tile-dragging$/, '#stage.tile-dragging');
  has(COMPARE, /\.cell > canvas$/, "a tile's canvas");
  has(COMPARE, /^\.cell-border$/, '.cell-border');
}

{ // The dynamically created overlay button looks exactly like #action (same rule, same declarations).
  assert.deepStrictEqual(declsOf(PLAYER, '#overlay .overlay-action'), declsOf(PLAYER, '#action'));
  const a = declsOf(PLAYER, '#overlay .overlay-action');
  assert.strictEqual(a['pointer-events'], 'auto', 'the button takes clicks inside the click-through overlay');
}

{ // The seek thumbnail: above #tip, ignores the pointer, hidden by [hidden], the frame of #thumb.
  const sel = [...selectorsOf(PLAYER)].find((s) => /canvas\.seek-thumb$/.test(s));
  const t = declsOf(PLAYER, sel);
  const thumb = declsOf(PLAYER, '#thumb');
  assert.strictEqual(t.position, 'absolute');
  assert.strictEqual(t['pointer-events'], 'none');
  assert.strictEqual(t.bottom, thumb.bottom, 'the same height above the seek bar as #thumb');
  assert.ok(parseFloat(t.bottom) > parseFloat(declsOf(PLAYER, '#tip').bottom), 'above the time tip');
  for (const k of ['border', 'border-radius', 'box-shadow', 'transform']) assert.strictEqual(t[k], thumb[k], k);
  const hid = [...selectorsOf(PLAYER)].find((s) => /\.seek-thumb\[hidden\]$/.test(s));
  assert.strictEqual(declsOf(PLAYER, hid).display, 'none');
}

{ // Overlay lines wrap inside the stage; an error sits above the tiles' hover controls (.ov).
  const line = declsOf(PLAYER, '#overlay .overlay-line');
  assert.strictEqual(line['overflow-wrap'], 'anywhere');
  const err = declsOf(PLAYER, '#overlay.error');
  assert.ok(Number(err['z-index']) > Number(declsOf(COMPARE, '.ov')['z-index']), '#overlay.error above .ov');
  // White text over the black picture also when the picture is a tile's canvas (the unified page), not #canvas.
  assert.ok(anySelector(PLAYER, (s) => /^#stage:has\(.*\.cell > canvas\) #overlay$/.test(s)), 'white overlay text over tiles');
}

{ // compare.css never restyles the player's own elements for one video: a rule whose subject is one of them must be
  // scoped to Compare (body.compare, a high-contrast body, a Compare-only ancestor, or a #stage state Compare sets).
  const PLAYER_OWNED = /^(html|body|:root|\*|video|canvas|\[hidden\]|#stage|#canvas|#bar|#row|#toast|#overlay|#message|#hint|#action|#seekRow|#seek|#tip|#notice|#subs|#main|#panel|#sheet|#ctxmenu)(?![\w-])/;
  const COMPARE_STATE = /#stage\.(tile-dragging|pannable|panning|zoomed|sync-mode)\b/;
  const COMPARE_ANCESTOR = /(^|[\s>+~])(\.(cell|ov|pill|tile-[\w-]+|sync-pill|nudge|splitter|skeleton|add-pop|cmp-group)\b|#(cells|divider|splitter|menu|cmpGroup)\b)/;
  const scoped = (sel) => /body\.(compare|vscode-high-contrast(-light)?)\b/.test(sel) || COMPARE_STATE.test(sel)
    || COMPARE_ANCESTOR.test(splitTop(sel, /[\s>+~]/).slice(0, -1).join(' '));
  const leaks = [];
  for (const r of rules(COMPARE)) {
    for (const s of r.selectors.map(norm)) {
      const parts = splitTop(s, /[\s>+~]/);
      const subject = parts[parts.length - 1];
      if (PLAYER_OWNED.test(subject) && !scoped(s)) leaks.push(`${r.at ? `${r.at} ` : ''}${s}`);
    }
  }
  assert.deepStrictEqual(leaks, [], `compare.css restyles player elements outside Compare:\n${leaks.join('\n')}`);
  // The checker itself: an unscoped rule on a player element is caught, Compare-scoped ones are not.
  for (const bad of ['#canvas', 'body', '#stage', '#bar #row', 'canvas', '#stage #toast']) {
    const parts = splitTop(bad, /[\s>+~]/);
    assert.ok(PLAYER_OWNED.test(parts[parts.length - 1]) && !scoped(bad), `caught: ${bad}`);
  }
  for (const ok of ['body.compare #canvas', '#stage.tile-dragging', '#stage .cell > canvas', 'body.compare #main > #stage']) {
    assert.ok(scoped(ok), `allowed: ${ok}`);
  }
}

{ // compare.css's global rules on the shared names stay where they were: no bare element or :root rules at all.
  const bare = [...selectorsOf(COMPARE)].filter((s) => /^(html|body|:root|\*|video|canvas|button|input|select|\[hidden\])$/.test(s));
  assert.deepStrictEqual(bare, []);
}

{ // One video in the unified page is a single .cell in #cells: it keeps the player's pointer (no grab hand), Compare's
  // tiles still show it. Every rule that sets cursor: grab on tiles is scoped to body.compare or to a cell with siblings.
  const grab = rules(COMPARE).filter((r) => /(^|;)\s*cursor:\s*grab\s*(;|$)/.test(r.body))
    .flatMap((r) => r.selectors.map(norm)).filter((s) => /\.cell\b/.test(s) && !/^#stage\./.test(s));
  assert.ok(grab.length > 0, 'tiles have a grab cursor in Compare');
  for (const s of grab) {
    assert.ok(/^body\.compare\b/.test(s) || /:not\(:only-child\)/.test(s), `grab cursor leaks to one video: ${s}`);
  }
  // A tile's canvas fills its cell over player.css's #stage.fit / #stage.zoom picture sizing.
  const cv = declsOf(COMPARE, '#stage .cell > canvas');
  assert.strictEqual(cv.width, '100%');
  assert.strictEqual(cv.height, '100%');
  assert.strictEqual(cv['max-width'], 'none');
  assert.strictEqual(cv['max-height'], 'none');
}

{ // Specificity: the tile canvas rule (1 id, 1 class, 1 type) is not weaker than player.css's #stage.fit canvas and
  // #stage.zoom canvas (1 id, 1 class, 1 type), and compare.css loads later, so it wins the tie.
  const spec = (sel) => {
    const s = sel.replace(/:not\(([^)]*)\)/g, ' $1');
    return [(s.match(/#[\w-]+/g) || []).length,
      (s.match(/\.[\w-]+|\[[^\]]*\]|:(?!:)[\w-]+/g) || []).length,
      (s.replace(/[#.][\w-]+|\[[^\]]*\]|::?[\w-]+(\([^)]*\))?/g, ' ').match(/(^|[\s>+~])[a-z][\w-]*/gi) || []).length];
  };
  const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
  for (const p of ['#stage.fit canvas', '#stage.zoom canvas']) {
    assert.ok(selectorsOf(PLAYER).has(p), p);
    assert.ok(cmp(spec('#stage .cell > canvas'), spec(p)) >= 0, `${p} does not beat a tile's canvas`);
  }
}

{ // The tile overlay (.ov) has a box: inset to the picture (the --pic-* letterbox insets, 0 when unset), never 0 x 0.
  const ov = declsOf(COMPARE, '.ov');
  assert.strictEqual(ov.position, 'absolute');
  assert.strictEqual(ov.inset, 'var(--pic-t, 0px) var(--pic-r, 0px) var(--pic-b, 0px) var(--pic-l, 0px)');
}

{ // Split Wipe: B's canvas is transparent (player.css paints every canvas black), or A would vanish left of the divider.
  const b = declsOf(COMPARE, '.cell.split[data-role="split-b"] > canvas');
  assert.strictEqual(b.background, 'transparent');
}

{ // An empty spare slot's "+ Add video" rests quiet but visible (0.6), full on hover and on keyboard focus.
  assert.strictEqual(declsOf(COMPARE, '.addcell').opacity, '0.6');
  assert.strictEqual(declsOf(COMPARE, '.cell.add:hover .addcell').opacity, '1');
  assert.strictEqual(declsOf(COMPARE, '.addcell:focus-visible').opacity, '1');
}

{ // What the mock-up harness used to carry on its own (tools/mockup/render.js) is the real CSS now: the capture
  // banner and toggle, and the toggled-on bar button. The Compare button keeps a gap between its icon and its label.
  for (const sel of ['.cap-banner', '.cap-pulse', '#startCompareBtn', '#startCompareBtn.cap-on', '#bar .ib.active']) {
    assert.ok(anySelector(PLAYER, (s) => s === sel), `${sel} is in player.css`);
  }
  assert.ok(/^\d/.test(declsOf(PLAYER, '#startCompareBtn').gap), 'a gap between the icon and the label');
  const render = fs.readFileSync(path.join(__dirname, '..', '..', 'tools', 'mockup', 'render.js'), 'utf8');
  for (const dup of ['.cap-banner {', '.cap-pulse {', '#startCompareBtn {', '#bar .ib.active {', '.cell.add .addcell {']) {
    assert.ok(!render.includes(dup), `render.js no longer restyles ${dup}`);
  }
}

{ // The narrow-pane collapse names the buttons of the #cmpGroup capsule (src/bar.js), in order, and
  // the Compare toggle loses its words first. Every id it names is one src/bar.js really declares.
  const bar = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'bar.js'), 'utf8');
  const hidden = (maxW) => rules(COMPARE).filter((r) => r.at.includes(`max-width: ${maxW}px`) && /display:\s*none/.test(r.body))
    .flatMap((r) => r.selectors.map(norm));
  const all = [...hidden(640), ...hidden(560), ...hidden(440)].join(' ');
  for (const id of ['swapBtn', 'syncBtn', 'splitBtn', 'spotlightBtn', 'gridBtn']) {
    assert.ok(all.includes(`#row #${id}`), `#${id} collapses`);
    assert.ok(bar.includes(`cmpButton('${id}'`), `src/bar.js declares #${id}`);
  }
  assert.ok(hidden(640).some((s) => /#startCompareBtn > span/.test(s)), 'the Compare toggle drops its label first');
}

{ // Layering contract across player.css, folder-rail.css and compare.css: floating overlays (context menu, seek tip
  // and seek thumbnail) paint above an open Folder Rail and its collapse tab; interactive/inspection overlays paint
  // above a passing toast.
  const RAIL = read('folder-rail.css');
  const z = (css, sel) => {
    const target = norm(sel);
    const matching = rules(css).filter((x) => !x.at && x.selectors.map(norm).includes(target));
    const merged = Object.assign({}, ...matching.map((r) => Object.fromEntries(splitTop(r.body, /;/).map((d) => {
      const k = d.indexOf(':');
      return [d.slice(0, k).trim(), d.slice(k + 1).trim()];
    }))));
    const v = merged['z-index'];
    assert.ok(v !== undefined && !Number.isNaN(Number(v)), `${sel} has numeric z-index (got ${v})`);
    return Number(v);
  };
  const thumbSel = [...selectorsOf(PLAYER)].find((s) => /canvas\.seek-thumb$/.test(s));
  assert.ok(z(PLAYER, '#ctxmenu') > z(PLAYER, '#tip'), '#ctxmenu above #tip');
  assert.ok(z(PLAYER, '#tip') > z(PLAYER, thumbSel), '#tip above seek-thumb');
  assert.ok(z(PLAYER, '#tip') > z(PLAYER, '#thumb'), '#tip above #thumb');
  assert.ok(z(PLAYER, thumbSel) > z(RAIL, '.rail-collapse-tab'), 'seek-thumb above .rail-collapse-tab');
  assert.ok(z(PLAYER, '#thumb') > z(RAIL, '.rail-collapse-tab'), '#thumb above .rail-collapse-tab');
  assert.ok(z(RAIL, '.rail-collapse-tab') > z(RAIL, '.rail'), '.rail-collapse-tab above .rail');
  assert.ok(z(PLAYER, '#notice') > z(PLAYER, '#toast'), '#notice above #toast');
  assert.ok(z(PLAYER, '#pxread') > z(PLAYER, '#toast'), '#pxread above #toast');
  // Panels sit strictly above the rail (no tie decided by DOM order) and its collapse tab; the modal #sheet above
  // every panel, popover, menu and the rail.
  assert.ok(z(PLAYER, '.panel') > z(RAIL, '.rail'), '.panel above .rail');
  assert.ok(z(PLAYER, '.panel') > z(RAIL, '.edge-zone'), '.panel above the rail edge tab');
  const overlays = [[PLAYER, '.panel'], [PLAYER, '#ctxmenu'], [COMPARE, '#menu'], [RAIL, '.rail'], [RAIL, '.rail-collapse-tab'],
    [RAIL, '.vpe-pop'], [RAIL, '.hover-pop'], [COMPARE, '.add-pop'], [COMPARE, '.cell.lifted'], [COMPARE, '.splitter']];
  for (const [css, sel] of overlays) assert.ok(z(PLAYER, '#sheet') > z(css, sel), `#sheet above ${sel}`);
  // One #pxread-only layer rule (besides the shared #pxread, #stats, #goto base): a duplicate drifted out of sync before.
  const pxRules = rules(PLAYER).filter((x) => !x.at && x.selectors.length === 1 && norm(x.selectors[0]) === '#pxread'
    && /z-index/.test(x.body));
  assert.strictEqual(pxRules.length, 1, '#pxread z-index is set once');
}

{ // The #notice banner reads as a message (docs/notes/notifications.md, "Banner layout"): the text on its own line
  // with the buttons on a row below it, the main action filled, × in the corner; neutral, no accent colour or icon.
  const notice = declsOf(PLAYER, '#notice');
  assert.strictEqual(notice['flex-wrap'], 'wrap', 'buttons wrap under the text');
  assert.ok(!notice['border-left'] && !anySelector(PLAYER, (sel) => /^#notice(\[[^\]]*\])?::before$/.test(sel)), 'no accent edge or icon');
  const text = declsOf(PLAYER, '#noticeText');
  assert.match(text.flex || '', /100%/, 'the text takes a whole line');
  assert.strictEqual(text['box-sizing'], 'border-box', 'and never spills out of the card');
  assert.strictEqual(declsOf(PLAYER, '#notice #noticeClose').position, 'absolute', '× in the corner');
  assert.match(declsOf(PLAYER, '#notice #noticeAction').background || '', /--vscode-button-background/, 'main action filled');
}

console.log('unified_css: ok');
