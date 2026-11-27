'use strict';
/* exported VpeRangeDrag */

/** Keep range drags on the input even outside the webview. Native keyboard input stays enabled. */
const VpeRangeDrag = {
  bindSeek(input, { preview, finish, commit }) {
    let pending = null;
    const drag = VpeRangeDrag.bind(input, (event) => {
      const target = pending;
      pending = null;
      finish();
      if (target !== null && event?.type === 'pointerup') commit(target);
    }, () => {
      if (pending === null) {
        pending = Number(input.value);
        preview(pending);
      }
    });
    input.addEventListener('input', () => {
      const frame = Number(input.value);
      if (drag.dragging()) {
        pending = frame;
        preview(frame);
      } else {
        commit(frame);
      }
    });
    return drag;
  },

  bind(input, onEnd = () => {}, onStart = () => {}) {
    const win = input.ownerDocument.defaultView;
    const emit = (type) => input.dispatchEvent(new win.Event(type, { bubbles: true }));
    let pointerId = null;

    function move(e) {
      if (e.pointerId !== pointerId) return;
      const { left, width } = input.getBoundingClientRect();
      if (!width) return;
      const min = Number(input.min), max = Number(input.max), step = Number(input.step);
      const fraction = Math.max(0, Math.min(1, (e.clientX - left) / width));
      const old = input.value;
      input.value = String(min + Math.round(fraction * (max - min) / step) * step);
      // The native range normalizes and clamps the assigned value.
      if (input.value !== old) emit('input');
    }

    function stop(e) {
      if (pointerId === null) return;
      const id = pointerId;
      pointerId = null;
      win.removeEventListener('pointermove', move, true);
      win.removeEventListener('pointerup', finish, true);
      win.removeEventListener('pointercancel', finish, true);
      win.removeEventListener('blur', stop);
      input.removeEventListener('lostpointercapture', finish);
      if (input.hasPointerCapture(id)) input.releasePointerCapture(id);
      emit('change');
      onEnd(e);
    }

    function finish(e) {
      if (e.pointerId !== pointerId) return;
      if (e.type === 'pointerup') move(e);
      stop(e);
    }

    input.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || input.disabled || Number(input.max) <= Number(input.min)) return;
      e.preventDefault();
      if (pointerId !== null) return;
      pointerId = e.pointerId;
      input.focus({ preventScroll: true });
      try { input.setPointerCapture(pointerId); } catch { /* synthetic pointer (test hook) */ }
      win.addEventListener('pointermove', move, true);
      win.addEventListener('pointerup', finish, true);
      win.addEventListener('pointercancel', finish, true);
      win.addEventListener('blur', stop);
      input.addEventListener('lostpointercapture', finish);
      move(e);
      onStart();
    });

    return { dragging: () => pointerId !== null, stop };
  },

  /**
   * The wheel over a slider steps it: onStep(+1 up / -1 down); return false to leave the event alone (the page
   * scrolls). Returns the unbind function.
   */
  wheelStep(input, onStep) {
    const on = (e) => {
      if (!e.deltaY || onStep(e.deltaY < 0 ? 1 : -1) === false) return;
      e.preventDefault();
    };
    input.addEventListener('wheel', on, { passive: false });
    return () => input.removeEventListener('wheel', on);
  },
};

if (typeof module !== 'undefined') module.exports = VpeRangeDrag;
