// @ts-check
// Keyboard ownership for the player and compare pages: ownsKey (which keys the focused control keeps
// from the player's shortcuts) and isToolKey (the keys of the inspection tools). The simple /
// advanced modes that used to live here are gone: the player has one layout (media/controls.js).
'use strict';
/* exported VpeModes */
const VpeModes = (() => {
  /**
   * Keys that belong to tools: in simple mode they do nothing, so a stray key can't open an overlay.
   * Transport, volume, speed, subtitle, fullscreen and picture-in-picture keys always work.
   * @param {KeyboardEvent} e
   */
  function isToolKey(e) {
    const altGr = !!(e.getModifierState && e.getModifierState('AltGraph'));
    if (e.metaKey) return false;
    if (e.ctrlKey && !altGr) return e.key === 'g' || e.key === 'G'; // go to frame
    if (e.altKey && !altGr) return false;
    switch (e.key) {
      case 'x': case 'X': case 'w': case 'W': case 'z': case 'Z': case 'i': case 'I':
      case 's': case 'S': case 'c': case 'C': case 'b': case 'B':
      case '{': case '}': case 'PageUp': case 'PageDown':
        return true;
      case 'a': return true;
      case 'A': return !e.shiftKey; // Shift+A is the next audio track
      default: return false;
    }
  }

  /**
   * Keys the focused control needs for itself: typing in a text or number field, a list box, a
   * checkbox or radio, and Space / Enter on a button reached with the keyboard (it clicks). The
   * player's shortcuts leave these alone. A button clicked with the mouse keeps focus without
   * :focus-visible, so Space there still plays and pauses.
   * @param {KeyboardEvent} e
   */
  function ownsKey(e) {
    const t = /** @type {any} */ (e.target);
    if (!t || t.nodeType !== 1) return false;
    if (t.isContentEditable || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT') return true;
    if (t.tagName === 'INPUT') {
      if (!/^(range|checkbox|radio|button|submit|reset)$/i.test(t.type)) return true;
      return e.key === ' ' && /^(checkbox|radio)$/i.test(t.type);
    }
    if (e.key !== ' ' && e.key !== 'Enter') return false;
    const button = t.tagName === 'BUTTON' || /^(button|menuitem|menuitemradio|menuitemcheckbox)$/.test(t.getAttribute('role') || '');
    let visible = false;
    try { visible = t.matches(':focus-visible'); } catch { visible = true; }
    return button && visible;
  }

  return { isToolKey, ownsKey };
})();

if (typeof module !== 'undefined') module.exports = VpeModes;
