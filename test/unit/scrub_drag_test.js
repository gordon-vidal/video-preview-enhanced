'use strict';

const assert = require('node:assert/strict');
const { bindSeek } = require('../../media/range-drag');

const win = new EventTarget();
win.Event = Event;
const input = Object.assign(new EventTarget(), {
  ownerDocument: { defaultView: win },
  min: '0', max: '100', step: '1', value: '0',
  focus() {}, setPointerCapture() {}, hasPointerCapture: () => false,
  getBoundingClientRect: () => ({ left: 0, width: 100 }),
});
const events = [];
const emit = (target, type, clientX, pointerId = 1) => {
  const event = new Event(type, { cancelable: true });
  Object.assign(event, { pointerId, clientX, button: 0 });
  target.dispatchEvent(event);
};
const drag = bindSeek(input, {
  preview: (frame) => events.push(['preview', frame]),
  finish: () => events.push(['finish']),
  commit: (frame) => events.push(['exact', frame]),
});

emit(input, 'pointerdown', 10);
emit(win, 'pointermove', 25);
emit(win, 'pointermove', 40);
emit(win, 'pointerup', 80, 2);
assert.deepEqual(events, [['preview', 10], ['preview', 25], ['preview', 40]]);
emit(win, 'pointerup', 45);
assert.deepEqual(events.slice(3), [['preview', 45], ['finish'], ['exact', 45]]);

events.length = 0;
emit(input, 'pointerdown', 55);
emit(win, 'pointerup', 55);
assert.deepEqual(events, [['preview', 55], ['finish'], ['exact', 55]], 'click commits one exact frame');

events.length = 0;
emit(input, 'pointerdown', 55);
emit(win, 'pointerup', 55);
assert.deepEqual(events, [['preview', 55], ['finish'], ['exact', 55]], 'click on the current position commits');

events.length = 0;
input.value = '56';
input.dispatchEvent(new Event('input'));
input.dispatchEvent(new Event('change'));
assert.deepEqual(events, [['exact', 56]], 'keyboard input is exact without a duplicate change seek');

events.length = 0;
emit(input, 'pointerdown', 20);
drag.stop();
emit(win, 'pointerup', 21);
assert.deepEqual(events, [['preview', 20], ['finish']], 'hide/dispose discards the pending release');

events.length = 0;
emit(input, 'pointerdown', 70);
emit(win, 'pointercancel', 90);
assert.deepEqual(events, [['preview', 70], ['finish']], 'pointer cancellation retains the committed picture');
console.log('scrub_drag_test: ok');
