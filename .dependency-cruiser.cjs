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
      name: 'pure-logic-dependencies',
      severity: 'error',
      from: {
        path: '^(src/(decide|comparepick|hwaccel|rangecmd)|media/(abloop|stepgoal|timefmt|picture|membudget))\\.js$',
      },
      // The only current imports are path manipulation and the pure GPU selection helpers.
      to: { pathNot: '^(?:(?:node:)?path(?:/(?:posix|win32))?|src/hwaccel\\.js)$' },
    },
  ],
  options: {
    exclude: '^media/libav-vpe/',
    // Keep imports into installed packages visible to the rules without scanning package contents.
    doNotFollow: '(^|/)node_modules/',
  },
};
