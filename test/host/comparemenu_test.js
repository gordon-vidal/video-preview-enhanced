'use strict';

const assert = require('node:assert/strict');
const { COMPARE_OPEN, createCompareMenu } = require('../../src/comparemenu');
const { commands, menus } = require('../../package.json').contributes;

const events = [];
const publish = (key, value) => events.push([key, value]);
const menu = createCompareMenu(new Set(), publish);
const a = { panel: { active: false } };
const b = { panel: { active: false } };
assert.equal(menu.latest(), undefined);
menu.opened(a);
menu.opened(b);
assert.equal(menu.latest(), b);
a.panel.active = true;
assert.equal(menu.latest(), a, 'prefer the currently active Compare');
menu.activated(a);
a.panel.active = false;
assert.equal(menu.latest(), a, 'keep the most recently active Compare as target');
menu.closed(a);
assert.equal(menu.latest(), b);
assert.deepEqual(events, [[COMPARE_OPEN, false], [COMPARE_OPEN, true]], 'one remaining Compare keeps the key true');
menu.closed(b);
menu.activated(b);
assert.equal(menu.latest(), undefined, 'late focus events cannot revive a disposed Compare');
assert.deepEqual(events.pop(), [COMPARE_OPEN, false]);
createCompareMenu(new Set(), publish);
assert.deepEqual(events.pop(), [COMPARE_OPEN, false], 'fresh activation resets the window context');
createCompareMenu(new Set([a]), publish);
assert.deepEqual(events.pop(), [COMPARE_OPEN, true], 'initial state reflects any already-open sessions');

const fullId = (name) => `videoPreviewEnhanced.${name}`;
for (const [surface, start, add] of [
  ['explorer/context', 'startCompare', 'addToCompare'],
  ['editor/title', 'compareWith', 'addToCompareFromPlayer'],
]) {
  const startItem = menus[surface].find(({ command }) => command === fullId(start));
  const addItem = menus[surface].find(({ command }) => command === fullId(add));
  assert.ok(addItem.when.startsWith(`${COMPARE_OPEN} && (`));
  assert.equal(startItem.when, `!${addItem.when}`, `${surface} variants share eligibility and have opposite context`);
  assert.equal(startItem.group, addItem.group);
  for (const [command, label] of [[start, 'Start Compare'], [add, 'Add to Compare']]) {
    const entry = commands.find(({ command: id }) => id === fullId(command));
    assert.equal(entry.title, `Video Preview Enhanced: ${label}`);
    assert.equal(entry.category, undefined, 'the palette should display a single prefix');
    if (surface === 'editor/title') assert.equal(entry.icon, '$(diff)');
  }
}
const palette = Object.fromEntries(menus.commandPalette.map(({ command, when }) => [command, when]));
assert.equal(palette[fullId('startCompare')], 'false');
assert.equal(palette[fullId('addToCompare')], 'false');
assert.equal(palette[fullId('compareWith')], `!${COMPARE_OPEN}`);
assert.equal(palette[fullId('addToCompareFromPlayer')],
  menus['editor/title'].find(({ command }) => command === fullId('addToCompareFromPlayer')).when);

console.log('comparemenu: ok');
