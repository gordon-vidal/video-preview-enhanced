'use strict';

module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      from: { path: '^(src|media)/' },
      to: { circular: true },
    },
    {
      name: 'no-media-to-host',
      severity: 'error',
      from: { path: '^media/' },
      to: { path: '^src/' },
    },
    {
      name: 'no-player-to-decoder-entrypoints',
      severity: 'error',
      from: { path: '^media/', pathNot: '-worker\\.js$' },
      // The page starts these via workers and receives decoded data through messages.
      to: { path: '^media/(?:[^/]+-worker\\.js$|libav-vpe/)' },
    },
    {
      name: 'no-media-node-builtins',
      severity: 'error',
      from: { path: '^media/' },
      to: { dependencyTypes: ['core'] },
    },
    {
      name: 'pure-logic-dependencies',
      severity: 'error',
      from: {
        path: '^(src/(decide|comparepick|hwaccel|rangecmd)|media/(abloop|stepgoal|timefmt|picture|membudget|player-state))\\.js$',
      },
      // The only current imports are path manipulation and the pure GPU selection helpers.
      to: { pathNot: '^(?:(?:node:)?path(?:/(?:posix|win32))?|src/hwaccel\\.js)$' },
    },
    // The 3-way UI / State / Engine boundary (AGENTS.md "UI changes & testable 3-way separation";
    // docs/notes/player-ui-controller.md). test/host/player_ui_test.js "boundary contract" checks the globals.
    {
      name: 'player-state-imports-nothing',
      comment: 'media/player-state.js is pure state: no DOM, no VS Code, no decoder, no imports at all.',
      severity: 'error',
      from: { path: '^media/player-state\\.js$' },
      to: { path: '.' },
    },
    {
      name: 'player-state-no-core',
      severity: 'error',
      from: { path: '^media/player-state\\.js$' },
      to: { dependencyTypes: ['core'] },
    },
    {
      name: 'player-ui-not-to-host-or-engine',
      comment: 'media/player-ui.js and its tile / input / tools / lifecycle modules reach the decoders and the host only '
        + 'through the adapters.',
      severity: 'error',
      from: { path: '^media/player-ui(?:-tiles|-input|-tools|-lifecycle)?\\.js$' },
      to: {
        path: '^(?:src/|media/(?:engine|frame-player|gl-renderer|compare-compositor|decoder-[^/]*)\\.js$|media/libav-vpe/)',
      },
    },
    {
      name: 'player-ui-no-core',
      severity: 'error',
      from: { path: '^media/player-ui(?:-tiles|-input|-tools|-lifecycle)?\\.js$' },
      to: { dependencyTypes: ['core'] },
    },
  ],
  options: {
    // Keep imports into installed packages visible to the rules without scanning package contents.
    doNotFollow: '(?:^media/libav-vpe/|(^|/)node_modules/)',
  },
};
