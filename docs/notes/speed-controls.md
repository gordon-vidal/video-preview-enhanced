# Speed: presets, a compact popover and a reset badge

**Problem.** Speed changed only in 0.05× steps (wheel over the speed button, `Shift+<` / `Shift+>`), so going
from 1× to 2× took 20 notches, and there was no quick way back to 1×. An off-normal speed was also easy to miss.
The speed panel was large: a title, a big readout, a slider and a paragraph of keys.

**Change** (maintainer's choices, 2026-11-26 and 2026-11-27):

- **Wheel over the speed button walks a preset ladder:** 0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4×
  (`VpeControls.SPEEDS`, `presetRate`). A speed between two presets goes to the nearer one in the wheel's
  direction. **Shift+wheel keeps the 0.05× steps.** Chromium sends Shift+wheel as a horizontal scroll, so
  `deltaX` counts too. Touchpads add small deltas up to about one notch (50 px) before a preset step.
- **One speed UI: the popover** (pick "A2" of four sketches). `− speed +` on top, the slider in the volume bar's
  look (and, like it, the wheel over it steps it), then one row of the most used speeds as chips: 0.5 · 1 · 1.5 · 2×
  (`PANEL_SPEEDS`, `aria-pressed` on the current one). A click on the speed button opens it right above the button
  without a title, focus on the slider; ⚙ › Speed shows it as a page with a title to go back. No key list in it: the
  shortcut sheet has the keys.
- **Wheel peek.** The wheel over the speed button opens that same popover without taking focus and fades it out
  1.5 s after the last turn (`player-ui.js` `peekSpeed`, `.panel.fading`). Pointing into it, pressing in it or
  focusing it keeps it open, as a click on the speed button does; a popover a click opened is left alone. There is no
  separate wheel overlay: one view of the speed at a time.
- **Reset badge (↺)** above the speed button, in the step-size badge's style, spanning nearly the button's width.
  It is visible whenever the speed is not 1× (not only on hover), so an off-normal speed is never missed. A click
  goes back to 1× and leaves keyboard focus on the speed button. Name: "Reset speed to 1×".
- **Wider step-size badges** on ◀| / |▶: at least the button's width minus 8 px, so they are easier to hit.
- **No set-speed keys.** `Shift+1`…`4`, `Shift+0` and `\` were tried and dropped: they depend on the keyboard
  layout, are hard to discover, and the popover's presets and ↺ do the same in one click. The speed keys stay
  `Shift+<` / `Shift+>` and `[` / `]`.

Mock-up: `node tools/mockup/render.js --scenario speed-off-normal --out .tmp/mockup.html` (single video at
1.5×; scroll over or click the speed button).

Files: `media/controls.js` (ladder, panel), `media/player-ui.js` (wheel, peek, badge), `src/bar.js` (markup),
`media/player.css`.
