'use strict';

const COMPARE_OPEN = 'videoPreviewEnhanced.compareOpen';

/** Track live sessions in activation order, publishing only changes that affect the menus. */
function createCompareMenu(sessions, publish) {
  let previous;
  function update() {
    const open = sessions.size > 0;
    if (open === previous) return;
    previous = open;
    publish(COMPARE_OPEN, open);
  }
  update();
  return {
    opened(session) { sessions.add(session); update(); },
    activated(session) { if (sessions.delete(session)) sessions.add(session); },
    closed(session) { sessions.delete(session); update(); },
    latest() {
      const recent = [...sessions].reverse();
      return recent.find((session) => session.panel.active) || recent[0];
    },
  };
}

module.exports = { COMPARE_OPEN, createCompareMenu };
