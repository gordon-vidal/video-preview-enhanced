'use strict';
const assert = require('node:assert/strict');
const { bind } = require('../../media/range-drag');

function target() {
  const target = new EventTarget();
  // Node's EventTarget uses the options object when removing capture listeners.
  const remove = target.removeEventListener.bind(target);
  target.removeEventListener = (type, listener, capture) => remove(type, listener, { capture });
  return target;
}

const win = Object.assign(target(), { Event });
const input = Object.assign(target(), {
  ownerDocument: { defaultView: win },
  min: '0.25', max: '4', step: '0.05', value: '1',
  getBoundingClientRect: () => ({ left: 20, width: 150 }),
  focus() { this.focused = true; },
  setPointerCapture(id) { this.captured = id; },
  hasPointerCapture(id) { return id === this.captured; },
  releasePointerCapture() { this.captured = null; },
});

const send = (target, type, clientX, pointerId = 1, button = 0) => {
  const event = Object.assign(new Event(type, { cancelable: true }), { clientX, pointerId, button });
  target.dispatchEvent(event);
  return event.defaultPrevented;
};
let changes = 0;
let inputs = 0;
input.addEventListener('change', () => changes++);
input.addEventListener('input', () => inputs++);
const drag = bind(input);

assert.equal(send(input, 'pointerdown', 50, 1, 2), false);
assert.equal(drag.dragging(), false);
assert.equal(send(input, 'pointerdown', 50), true);
assert.equal(input.focused, true);
assert.equal(input.captured, 1);
assert.equal(input.value, '1');
assert.equal(inputs, 0);
send(win, 'pointermove', 300, 2);
send(win, 'pointerup', 300, 2);
assert.equal(input.value, '1');
assert.equal(drag.dragging(), true);
send(win, 'pointermove', 300);
assert.equal(input.value, '4');
send(win, 'pointermove', -20);
assert.equal(input.value, '0.25');
send(win, 'pointerup', 90);
assert.equal(input.value, '2');
assert.equal(inputs, 3);
assert.equal(changes, 1);
assert.equal(input.captured, null);
assert.equal(drag.dragging(), false);
send(win, 'pointermove', 300);
assert.equal(input.value, '2');

for (const [type, target] of [
  ['pointercancel', win], ['lostpointercapture', input], ['blur', win],
]) {
  const before = changes;
  send(input, 'pointerdown', 50);
  send(target, type, 300);
  assert.equal(input.value, '1', type);
  assert.equal(drag.dragging(), false, type);
  assert.equal(input.captured, null, type);
  assert.equal(changes, before + 1, type);
}

send(input, 'pointerdown', 50);
drag.stop(); // the speed panel closes or replaces its slider mid-drag
assert.equal(drag.dragging(), false);
assert.equal(input.captured, null);
send(win, 'pointermove', 300);
assert.equal(input.value, '1');
input.disabled = true;
assert.equal(send(input, 'pointerdown', 90), false);
assert.equal(input.value, '1');
console.log('Range drag passed');
