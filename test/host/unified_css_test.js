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
/** Every declaration for `sel` outside @media, later rules winning (as the cascade at equal specificity). */
const merged = (css, sel) => Object.assign({}, ...rules(css).filter((x) => !x.at && x.selectors.map(norm).includes(norm(sel)))
  .map((x) => Object.fromEntries(splitTop(x.body, /;/).map((d) => [d.slice(0, d.indexOf(':')).trim(), d.slice(d.indexOf(':') + 1).trim()]))));

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
  // Its hover and disabled looks are the shared button's (docs/DESIGN.md): .vpe-btn-main:hover, .vpe-btn:disabled.
  has(PLAYER, /^\.vpe-btn-main:hover$/, '.vpe-btn-main:hover');
  has(PLAYER, /^\.vpe-btn:disabled$/, '.vpe-btn:disabled');
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
  const err = merged(PLAYER, '#overlay.error');
  assert.ok(Number(err['z-index']) > Number(declsOf(COMPARE, '.ov')['z-index']), '#overlay.error above .ov');
  // White text over the black picture also when the picture is a tile's canvas (the unified page), not #canvas; an
  // error is a card with the theme's text colour instead.
  assert.ok(anySelector(PLAYER, (s) => /^#stage:has\(.*\.cell > canvas\) #overlay:not\(\.error\)$/.test(s)), 'white overlay text over tiles');
}

{ // compare.css never restyles the player's own elements for one video: a rule whose subject is one of them must be
  // scoped to Compare (body.compare, a high-contrast body, a Compare-only ancestor, or a #stage state Compare sets).
  const PLAYER_OWNED = /^(html|body|:root|\*|video|canvas|\[hidden\]|#stage|#canvas|#bar|#row|#toast|#overlay|#message|#hint|#action|#seekRow|#seek|#tip|#notice|#subs|#main|#panel|#sheet|#ctxmenu)(?![\w-])/;
  const COMPARE_STATE = /#stage\.(tile-dragging|pannable|panning|zoomed|sync-mode)\b/;
  const COMPARE_ANCESTOR = /(^|[\s>+~])(\.(cell|ov|pill|tile-[\w-]+|sync-pill|nudge|splitter|skeleton|cmp-group)\b|#(cells|divider|splitter|menu|cmpGroup)\b)/;
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
  // B's cell passes pointer events through so A's overlay buttons stay clickable; hovering the stage reveals both pills,
  // and #divider has vertical bounds so it never collapses to 0 px height.
  const b = declsOf(COMPARE, '.cell.split[data-role="split-b"] > canvas');
  assert.strictEqual(b.background, 'transparent');
  assert.strictEqual(declsOf(COMPARE, '.cell.split[data-role="split-b"]')['pointer-events'], 'none');
  assert.strictEqual(declsOf(COMPARE, '#cells:hover .cell.split .ov').opacity, '1');
  const div = declsOf(COMPARE, '#divider');
  assert.strictEqual(div.top, '0');
  assert.strictEqual(div.bottom, '0');
}

{ // An empty spare slot's "+ Add video" rests quiet but visible (0.6), full on hover and on keyboard focus.
  assert.strictEqual(declsOf(COMPARE, '.addcell').opacity, '0.6');
  assert.strictEqual(declsOf(COMPARE, '.cell.add:hover .addcell').opacity, '1');
  assert.strictEqual(declsOf(COMPARE, '.addcell:focus-visible').opacity, '1');
}

{ // What the mock-up harness used to carry on its own (tools/mockup/render.js) is the real CSS now: the capture
  // toggle's pulse and the toggled-on bar button. The Compare button keeps a gap between its icon and its label.
  for (const sel of ['.cap-pulse', '#startCompareBtn', '#startCompareBtn.cap-on', '#bar .ib.active']) {
    assert.ok(anySelector(PLAYER, (s) => s === sel), `${sel} is in player.css`);
  }
  assert.ok(/^\d/.test(declsOf(PLAYER, '#startCompareBtn').gap), 'a gap between the icon and the label');
  const render = fs.readFileSync(path.join(__dirname, '..', '..', 'tools', 'mockup', 'render.js'), 'utf8');
  for (const dup of ['.cap-banner {', '.cap-pulse {', '#startCompareBtn {', '#bar .ib.active {', '.cell.add .addcell {']) {
    assert.ok(!render.includes(dup), `render.js no longer restyles ${dup}`);
  }
  // The harness stands in for VS Code only (--vscode-* theme colours); the player's own tokens (--vpe-*) come from
  // player.css, or a mock-up shows a look the product does not have (a blue accent, another card background).
  const ownTokens = [...render.matchAll(/(--vpe-[\w-]+)\s*:/g)].map((m) => m[1]);
  assert.deepStrictEqual(ownTokens, [], 'render.js sets no --vpe-* token');
}

{ // The narrow-pane collapse names the buttons of the #cmpGroup capsule (src/bar.js), in order, and
  // the Compare toggle loses its words first. Every id it names is one src/bar.js really declares.
  const bar = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'bar.js'), 'utf8');
  const hidden = (maxW) => rules(COMPARE).filter((r) => r.at.includes(`max-width: ${maxW}px`) && /display:\s*none/.test(r.body))
    .flatMap((r) => r.selectors.map(norm));
  // Compare's bar needs about 824 px with every button: its words, Swap and Sync go at 840 px and the range buttons,
  // ⓘ and the duration at 680 px, scoped to Compare so the single player keeps them (maintainer, 2026-11-27).
  const all = [...hidden(840), ...hidden(560), ...hidden(440)].join(' ');
  for (const sel of [...hidden(840), ...hidden(680)].filter((x) => /#startCompareBtn|button\.rng|#infoBtn|#dur/.test(x))) {
    assert.match(sel, /^body\.compare /, `${sel}: only in Compare`);
  }
  const at680 = hidden(680).join(' ');
  for (const id of ['button.rng', '#infoBtn', '#dur']) assert.ok(at680.includes(id), `${id} goes at 680 px in Compare`);
  for (const id of ['swapBtn', 'syncBtn', 'splitBtn', 'spotlightBtn', 'gridBtn']) {
    assert.ok(all.includes(`#row #${id}`), `#${id} collapses`);
    assert.ok(bar.includes(`cmpButton('${id}'`), `src/bar.js declares #${id}`);
  }
  assert.ok(hidden(840).some((s) => /#startCompareBtn > span/.test(s)), 'the Compare toggle drops its label first');
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
    [RAIL, '.vpe-pop'], [RAIL, '.hover-pop'], [COMPARE, '.cell.lifted'], [COMPARE, '.splitter']];
  for (const [css, sel] of overlays) assert.ok(z(PLAYER, '#sheet') > z(css, sel), `#sheet above ${sel}`);
  // One #pxread-only layer rule (besides the shared #pxread, #stats, #goto base): a duplicate drifted out of sync before.
  const pxRules = rules(PLAYER).filter((x) => !x.at && x.selectors.length === 1 && norm(x.selectors[0]) === '#pxread'
    && /z-index/.test(x.body));
  assert.strictEqual(pxRules.length, 1, '#pxread z-index is set once');
}

{ // The #notice banner reads as a message (docs/notes/notifications.md, "Banner layout"): the text on its own line
  // with the buttons on a row below it, × in the corner; neutral, no accent colour or icon. Its buttons are the shared
  // .vpe-btn (no notice-only button look).
  const notice = merged(PLAYER, '#notice');
  assert.strictEqual(notice['flex-wrap'], 'wrap', 'buttons wrap under the text');
  assert.ok(!notice['border-left'] && !anySelector(PLAYER, (sel) => /^#notice(\[[^\]]*\])?::before$/.test(sel)), 'no accent edge or icon');
  const text = merged(PLAYER, '#noticeText');
  assert.match(text.flex || '', /100%/, 'the text takes a whole line');
  assert.strictEqual(text['box-sizing'], 'border-box', 'and never spills out of the card');
  assert.strictEqual(merged(PLAYER, '.vpe-close').position, 'absolute', '× in the corner (shared with the callout)');
  for (const own of ['#notice button', '#notice #noticeAction', '#notice .noticeSecondary']) {
    assert.ok(!anySelector(PLAYER, (s) => s === own), `${own}: no notice-only button style (the shared .vpe-btn)`);
  }
}

{ // The toast is the notice card without buttons: the same card, 12 px, not bold; no capture pill or #addHint left.
  const toast = merged(PLAYER, '#toast');
  assert.strictEqual(toast['font-size'], merged(PLAYER, '#notice')['font-size'], 'the notice text size');
  assert.ok(!toast['font-weight'] || Number(toast['font-weight']) < 600, 'not bold');
  // ... in every layout: no scoped rule (a dense Compare) gives it another size.
  for (const r of rules(COMPARE).concat(rules(PLAYER))) {
    if (r.selectors.some((x) => /#toast$/.test(norm(x))) && /font-size/.test(r.body)) {
      assert.match(r.body, /font-size:\s*12px/, `${r.selectors.join(', ')}: the toast stays 12 px`);
    }
  }
  assert.ok(!anySelector(PLAYER, (s) => /\.cap-banner|#addHint/.test(s)), 'no capture pill or #addHint rules left');
}

{ // One card look (docs/DESIGN.md): ONE rule in player.css gives every floating card its background, blur, border,
  // corners and text colour from the :root tokens; a card's own rule may only add a shadow level, pill corners or a
  // border colour. A surface that styles itself fails here: join the card rule instead.
  const RAIL = read('folder-rail.css');
  const root = merged(PLAYER, ':root');
  assert.match(root['--vpe-surface-float'], /var\(--vscode-menu-background\b.*\) 90%, transparent\)$/, '90% opacity');
  assert.strictEqual(root['--vpe-card-blur'], 'blur(2px)', '2 px blur');
  assert.strictEqual(root['--vpe-card-radius'], '8px');
  for (const k of ['--vpe-shadow-low', '--vpe-shadow-high']) assert.match(root[k] || '', /var\(--vscode-widget-shadow\b/, k);
  const MEMBERS = ['#notice', '#toast', '#overlay.error', '#pxread', '#stats', '#goto', '#scopes', '.panel', '#sheet .sheet',
    '#ctxmenu', '#menu', '.vpe-pop', '.hover-pop', '.tile-stats', '.sync-pill', '.nudge', '.pill',
    '.tile-bottom-pill', '.tbtn', '.addcell', '.skeleton-label', '.ended-badge', '.edge-shelf', '.rail-collapse-tab'];
  // Side panels share the card background but are not cards (full height, no corners): their own rule.
  const SIDE_PANELS = new Set(['.rail.overlay', '.rail.dock']);
  const SHADOW_EXCEPTIONS = new Set(['.rail.overlay']); // a side panel: its shadow falls to one side only
  const declsOfRule = (r) => Object.fromEntries(splitTop(r.body, /;/).map((x) => [x.slice(0, x.indexOf(':')).trim(), x.slice(x.indexOf(':') + 1).trim()]));
  const isSide = (r) => r.selectors.every((x) => SIDE_PANELS.has(norm(x)));
  const cardRules = rules(PLAYER).filter((r) => !r.at && /var\(--vpe-surface-float\)/.test(declsOfRule(r).background || '') && !isSide(r));
  assert.strictEqual(cardRules.length, 1, `one card rule (${cardRules.map((r) => r.selectors.join(', ')).join(' | ')})`);
  const card = declsOfRule(cardRules[0]);
  const members = cardRules[0].selectors.map(norm);
  for (const m of MEMBERS) assert.ok(members.includes(m), `${m} is in the card rule`);
  assert.deepStrictEqual([card['backdrop-filter'], card['-webkit-backdrop-filter'], card.border, card['border-radius'], card.color],
    ['var(--vpe-card-blur)', 'var(--vpe-card-blur)', '1px solid var(--vpe-panel-border)', 'var(--vpe-card-radius)', 'var(--vpe-panel-fg)']);
  for (const [name, css] of [['player.css', PLAYER], ['compare.css', COMPARE], ['folder-rail.css', RAIL]]) {
    const src = stripComments(css);
    assert.ok(!/backdrop-filter:\s*blur\(/.test(src), `${name}: blur only through var(--vpe-card-blur)`);
    const mixes = src.match(/color-mix\([^;]*--vscode-(menu|editorWidget)-background[^;]*;/g) || [];
    assert.ok(mixes.every((m) => /^color-mix\(in srgb, var\(--vscode-menu-background, #1e1f23\) 90%/.test(m)) && (name !== 'player.css' || mixes.length === 1),
      `${name}: no translucent surface besides --vpe-surface-float (${mixes.join(' | ')})`);
    for (const r of rules(css)) {
      if (r.body === cardRules[0].body && css === PLAYER) continue;
      const d = declsOfRule(r);
      const sel = r.selectors.join(', ');
      if (!isSide(r)) {
        assert.ok(!/var\(--vpe-(surface-float|panel-bg)\)/.test(d.background || ''), `${name} ${sel}: the card background only in the card rule`);
        assert.ok(!d['backdrop-filter'], `${name} ${sel}: the card blur only in the card rule`);
      }
      if (!r.selectors.some((x) => MEMBERS.includes(norm(x)))) continue;
      if (d['box-shadow'] && !r.selectors.some((x) => SHADOW_EXCEPTIONS.has(norm(x)))) {
        assert.match(d['box-shadow'], /^var\(--vpe-shadow-(low|high)\)$/, `${name} ${sel}: a shadow token`);
      }
      if (d['border-radius']) {
        assert.match(d['border-radius'], /^(var\(--vpe-card-radius\)|var\(--vpe-btn-radius\)|999px|var\(--vpe-card-radius\) 0 0 var\(--vpe-card-radius\))$/,
          `${name} ${sel}: card corners (${d['border-radius']})`);
      }
    }
  }
}

{ // One button (docs/DESIGN.md, Buttons): .vpe-btn with its tokens; the main action (.vpe-btn-main) is the only place
  // that uses VS Code's button colour; chips, steppers and tile buttons follow the same corners and heights.
  const root = merged(PLAYER, ':root');
  assert.deepStrictEqual([root['--vpe-btn-radius'], root['--vpe-btn-h'], root['--vpe-btn-h-panel']], ['4px', '24px', '28px']);
  const btn = merged(PLAYER, '.vpe-btn');
  assert.deepStrictEqual([btn['border-radius'], btn.height, btn['font-size']], ['var(--vpe-btn-radius)', 'var(--vpe-btn-h)', '12px']);
  assert.strictEqual(merged(PLAYER, '.panel .vpe-btn').height, 'var(--vpe-btn-h-panel)');
  assert.match(merged(PLAYER, '.vpe-btn-main').background || '', /^var\(--vscode-button-background\b/);
  // High Contrast leaves the button fill unset and draws buttons with --vscode-button-border: without it the main
  // action is bare text on the card.
  assert.match(merged(PLAYER, '.vpe-btn-main')['border-color'] || '', /^var\(--vscode-button-border\b/,
    "the main action keeps VS Code's button border");
  const RAIL = read('folder-rail.css');
  for (const [name, css] of [['player.css', PLAYER], ['compare.css', COMPARE], ['folder-rail.css', RAIL]]) {
    for (const r of rules(css)) {
      if (!/--vscode-button-background/.test(r.body)) continue;
      assert.ok(r.selectors.every((x) => /\.vpe-btn-main\b/.test(x)), `${name} ${r.selectors.join(', ')}: VS Code's button colour only on .vpe-btn-main`);
    }
  }
  // A container that can hold shared buttons never restyles "all its buttons": its generic rule skips .vpe-btn and
  // .vpe-close (the rail's popover menu rows turned the Add mode callout's buttons into menu rows once).
  for (const [name, css] of [['player.css', PLAYER], ['compare.css', COMPARE], ['folder-rail.css', RAIL]]) {
    for (const r of rules(css)) {
      for (const x of r.selectors.map(norm)) {
        if (!/^(\.vpe-pop|\.panel|#notice|#overlay|\.callout) button\b/.test(x)) continue;
        assert.ok(/:not\(\.vpe-btn\)/.test(x) && (!/^\.vpe-pop/.test(x) || /:not\(\.vpe-close\)/.test(x)),
          `${name} ${x}: a generic button rule skips the shared buttons`);
      }
    }
  }
  // The bar's capsules (Compare layouts, folder previous / next) are on the button scale too (maintainer, 2026-11-27).
  for (const [css, sel, h] of [[PLAYER, '.panel .chip', '--vpe-btn-h-panel'], [PLAYER, '.panel .big', '--vpe-btn-h-panel'], [COMPARE, '.tbtn', '--vpe-btn-h'],
    [COMPARE, '#row #cmpGroup .ib', '--vpe-btn-h'], [RAIL, '#row .folder-cap button.cap-btn', '--vpe-btn-h']]) {
    const d = merged(css, sel);
    assert.deepStrictEqual([d['border-radius'], d.height], ['var(--vpe-btn-radius)', `var(${h})`], `${sel}: the button scale`);
  }
}

{ // No dead surfaces (the unified page never builds the old Start Compare dialog), and the Compare tile buttons take
  // the theme's hover and error colours instead of fixed white / red (docs/DESIGN.md, Colour).
  for (const dead of ['#startCompareDialog', '#startCompareBackdrop', '#confirmCompareBtn', '.compare-actions']) {
    assert.ok(!anySelector(PLAYER, (s) => s.includes(dead)), `${dead} is gone from player.css`);
  }
  assert.strictEqual(declsOf(COMPARE, '.tbtn:hover').background, 'var(--vpe-hover)');
  for (const sel of ['.tbtn.rm:hover', '.tbtn.rm.confirm']) {
    const d = declsOf(COMPARE, sel);
    assert.match(d.background, /^var\(--vscode-/, `${sel}: a VS Code colour`);
    assert.ok(!/#[0-9a-f]{3,6}|rgba?\(/i.test(`${d.background} ${d['border-color'] || ''} ${d.color || ''}`.replace(/var\([^)]*\)/g, '')),
      `${sel}: no fixed colours outside a var() fallback`);
  }
}

{ // No dead rules: every class and id the three style sheets name is still made by the page's code (media/, src/).
  // The Start Compare dialog, the Add popover and the Add mode Stop button lingered in the CSS after their markup went.
  const RAIL = read('folder-rail.css');
  const files = [];
  const walk = (d) => {
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, f.name);
      if (f.isDirectory()) { if (!/^(dist|libav-vpe|probe|vendor)$/.test(f.name)) walk(p); } else if (/\.(js|ts|tsx)$/.test(f.name)) files.push(p);
    }
  };
  walk(MEDIA);
  walk(path.join(__dirname, '..', '..', 'src'));
  const code = files.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
  const FROM_VS_CODE = new Set(['vscode-high-contrast', 'vscode-high-contrast-light', 'vscode-light', 'vscode-dark']);
  const dead = [];
  for (const [name, css] of [['player.css', PLAYER], ['compare.css', COMPARE], ['folder-rail.css', RAIL]]) {
    const names = new Set(rules(css).flatMap((r) => r.selectors).flatMap((sel) => [...sel.replace(/\[[^\]]*\]/g, '')
      .matchAll(/[.#]([a-zA-Z][\w-]*)/g)].map((m) => m[1])));
    for (const n of names) {
      if (FROM_VS_CODE.has(n)) continue;
      if (!new RegExp(`(^|[^\w-])${n.replace(/-/g, '\-')}(?![\w-])`).test(code)) dead.push(`${name}: ${n}`);
    }
  }
  assert.deepStrictEqual(dead, [], `selectors no code makes:\n${dead.join('\n')}`);
}

{ // Card text colour comes from the card rule only (--vpe-panel-fg): a member's own rule does not repaint it with
  // --vscode-foreground or a fixed colour (docs/DESIGN.md, The card rule).
  const RAIL = read('folder-rail.css');
  const card = rules(PLAYER).find((r) => !r.at && /var\(--vpe-surface-float\)/.test(r.body));
  const members = new Set(card.selectors.map(norm));
  const own = [];
  for (const [name, css] of [['player.css', PLAYER], ['compare.css', COMPARE], ['folder-rail.css', RAIL]]) {
    for (const r of rules(css)) {
      if ((css === PLAYER && r.body === card.body) || r.at) continue;
      const hit = r.selectors.map(norm).filter((x) => members.has(x));
      if (hit.length && /(^|;)\s*color\s*:/.test(r.body)) own.push(`${name}: ${hit.join(', ')}`);
    }
  }
  assert.deepStrictEqual(own, [], `card members that set their own text colour:\n${own.join('\n')}`);
}

{ // Fixed colours (outside a var() fallback) only on the picture itself, never on a card or the bar (docs/DESIGN.md,
  // Colour): the picture's black, dimmers over it, and marks drawn on it.
  const RAIL = read('folder-rail.css');
  const stripVars = (s) => {
    let out = '', i = 0;
    while (i < s.length) {
      if (s.startsWith('var(', i)) {
        let depth = 0, j = i + 3;
        for (; j < s.length; j++) { if (s[j] === '(') depth++; else if (s[j] === ')' && --depth === 0) break; }
        i = j + 1;
      } else out += s[i++];
    }
    return out;
  };
  const ON_PICTURE = /^(video|canvas|:root:fullscreen body|body:fullscreen|body\.maxi|body\.compare #stage|#playFlash|#overlay|#stage:has\(.*\) #overlay:not\(\.error\)|#dropHint|\.ab-pin\b.*|#ab[AB] span|#pxgrid|#subs|#thumb\b.*|#seekRow canvas\.seek-thumb|#stage #scopes canvas|#sheet|\.cell-border|\.cell\.lifted|\.cell\.loading::after|\.ended-ov|\.oor|\.splitter-bar|#divider\b.*)$/;
  const fixed = [];
  for (const [name, css] of [['player.css', PLAYER], ['compare.css', COMPARE], ['folder-rail.css', RAIL]]) {
    for (const r of rules(css)) {
      if (!/#[0-9a-f]{3,8}\b|rgba?\(/i.test(stripVars(r.body))) continue;
      const off = r.selectors.map(norm).filter((x) => !ON_PICTURE.test(x));
      if (off.length) fixed.push(`${name}: ${off.join(', ')}`);
    }
  }
  assert.deepStrictEqual(fixed, [], `fixed colours off the picture:\n${fixed.join('\n')}`);
}

{ // The tiles' keyboard reorder arrows are tile buttons (.tbtn), not a look-alike with its own colours and size.
  const ui = fs.readFileSync(path.join(MEDIA, 'player-ui.js'), 'utf8');
  assert.match(ui, /<button type="button" class="tbtn" data-act="move"/, 'the arrows are .tbtn');
  for (const r of rules(COMPARE)) {
    if (r.selectors.some((x) => /^\.move button\b/.test(norm(x)))) {
      assert.ok(!/(^|;)\s*(background|color|border-radius|height|width)\s*:/.test(r.body), `${r.selectors.join(', ')}: no own button look`);
    }
  }
}

{ // Motion (docs/DESIGN.md): every transition and animation has a prefers-reduced-motion rule: off, or slower where a
  // mark standing still would read as broken (the loading ring).
  const RAIL = read('folder-rail.css');
  const missing = [];
  for (const [name, css] of [['player.css', PLAYER], ['compare.css', COMPARE], ['folder-rail.css', RAIL]]) {
    const all = rules(css);
    const off = new Set(all.filter((r) => /prefers-reduced-motion:\s*reduce/.test(r.at)
      && /(transition|animation)\s*:/.test(r.body)).flatMap((r) => r.selectors.map(norm)));
    for (const r of all) {
      if (r.at || !/(^|;)\s*(transition|animation)\s*:\s*(?!none)/.test(r.body)) continue;
      for (const x of r.selectors.map(norm)) if (!off.has(x)) missing.push(`${name}: ${x}`);
    }
  }
  assert.deepStrictEqual(missing, [], `moves without a reduced-motion off switch:\n${missing.join('\n')}`);
}

{ // One menu row (docs/DESIGN.md, Menus): the right-click menu, the tile menu and the rail's menus are built from
  // VpeUi.menuItem (media/ui-primitives.js) and styled by the .vpe-mi rules only: 13 px, a check column, the shortcut
  // on the right, the row fill on hover and focus, the focus ring on keyboard focus.
  const RAIL = read('folder-rail.css');
  const row = merged(PLAYER, '.vpe-mi');
  assert.strictEqual(row.display, 'flex');
  assert.strictEqual(row['font-size'], '13px');
  assert.match(declsOf(PLAYER, '.vpe-mi:hover').background || '', /^var\(--vpe-row-hover\)$/);
  assert.match(merged(PLAYER, '.vpe-mi:focus-visible').outline || '', /var\(--vscode-focusBorder\)/);
  for (const sel of ['.vpe-mi-check', '.vpe-mi-key', '.vpe-msep']) assert.ok(anySelector(PLAYER, (x) => x === sel), `${sel} is styled`);
  const old = [];
  for (const [name, css] of [['player.css', PLAYER], ['compare.css', COMPARE], ['folder-rail.css', RAIL]]) {
    for (const x of rules(css).flatMap((r) => r.selectors.map(norm))) {
      if (/\.ctx-(item|check|label|key|sep)\b|#menu \.(mi|msep)\b|^\.vpe-pop button\b/.test(x)) old.push(`${name}: ${x}`);
    }
  }
  assert.deepStrictEqual(old, [], `menu rows styled outside .vpe-mi:\n${old.join('\n')}`);
  for (const f of ['ctxmenu.js', 'player-ui-tiles.js']) {
    assert.match(fs.readFileSync(path.join(MEDIA, f), 'utf8'), /\.menuItem\(/, `${f} builds its rows with VpeUi.menuItem`);
  }
}

{ // Type scale (docs/DESIGN.md, Type): 11 / 12 / 13 px. Outside it only: 9-10 px inside a badge or letter mark (and a
  // dense grid's pills and card, 10 px), 14 / 16 px titles, glyph buttons (×, ±) and the big offset readout, and em
  // sizes on the picture's own overlay text.
  const RAIL = read('folder-rail.css');
  const MARKS = /^(\.ab-pin span|#row button\.badge|\.rngl|\.panel \.row \.mark|\.panel \.abicon|\.ltr|#cells\.dense \.ltr|#cells\.dense \.sync-pill|#cells\.dense \.nudge|#cells\.dense \.sync-pill \.offv|#cells\.dense \.nudge \.offv|#cells\.dense \.tile-stats)$/;
  const TITLES = /^(\.panel \.iname|#sheet \.stitle)$/;
  const GLYPHS = /^(\.vpe-close|\.tile-stats-close|#cells\.dense \.tile-stats-close|\.scopesHeader button|\.panel \.big|\.panel \.readout\.off)$/;
  const off = [];
  for (const [name, css] of [['player.css', PLAYER], ['compare.css', COMPARE], ['folder-rail.css', RAIL]]) {
    for (const r of rules(css)) {
      const m = /(?:^|;)\s*font-size:\s*([^;]+)/.exec(r.body) || /(?:^|;)\s*font:\s*(?:\d+\s+)?(\d+(?:\.\d+)?px)/.exec(r.body);
      if (!m) continue;
      const v = m[1].trim();
      if (/^(11|12|13)px$/.test(v) || /^var\(--vscode-font-size\)$|em$/.test(v)) continue;
      for (const x of r.selectors.map(norm)) {
        const ok = (/^(9|10)px$/.test(v) && MARKS.test(x)) || (/^(14|16)px$/.test(v) && TITLES.test(x)) || GLYPHS.test(x);
        if (!ok) off.push(`${name}: ${x} ${v}`);
      }
    }
  }
  assert.deepStrictEqual(off, [], `font sizes off the scale:\n${off.join('\n')}`);
  // The bar's readouts are on it too (12 px, maintainer 2026-11-27).
  assert.strictEqual(merged(PLAYER, '#row #time')['font-size'], '12px');
  assert.strictEqual(merged(PLAYER, '#row #rate')['font-size'], '12px');
}

console.log('unified_css: ok');
