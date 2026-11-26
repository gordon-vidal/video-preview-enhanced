# Speed: presets, set-speed keys and a reset badge

**Problem.** Speed changed only in 0.05× steps (wheel over the speed button, `Shift+<` / `Shift+>`), so going
from 1× to 2× took 20 notches, and there was no quick way back to 1×. An off-normal speed was also easy to miss.

**Change** (maintainer's choices, 2026-11-26):

- **Wheel over the speed button walks a preset ladder:** 0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4×
  (`VpeControls.SPEEDS`, `presetRate`). A speed between two presets goes to the nearer one in the wheel's
  direction. **Shift+wheel keeps the 0.05× steps.** Chromium sends Shift+wheel as a horizontal scroll, so
  `deltaX` counts too. Touchpads add small deltas up to about one notch (50 px) before a preset step.
- **Compact speed overlay** while the wheel turns: a small floating box above the speed button with a mini
  slider (preset ticks, 1× stronger) and the value. It uses the ⚙ panel's surface, border and accent
  tokens and fades out 1.1 s after the last turn. It replaces the toast for wheel changes; keys still toast.
  `aria-hidden`: the speed button's name already says the speed.
- **Set-speed keys** by key position (`KeyboardEvent.code`): `Shift+1`…`Shift+4` = 1×–4×, `Shift+0` = 0.5×,
  `\` = 1× (AltGr+ß on German keyboards). On layouts where Shift types the digit itself (AZERTY), the digit
  keeps its seek meaning and these keys do nothing.
- **Reset badge (↺)** above the speed button, in the step-size badge's style. It is visible whenever the
  speed is not 1× (not only on hover), so an off-normal speed is never missed. A click goes back to 1× and
  leaves keyboard focus on the speed button. Name: "Reset speed to 1×"; tooltip names `\`.
- **Speed panel:** the slider stays. The track labels became a 5 + 4 grid of preset chips (the jump-size chip
  style) with `aria-pressed` on the current one.

Mock-up: `node tools/mockup/render.js --scenario speed-off-normal --out .tmp/mockup.html` (single video at
1.5×; scroll over the speed button for the overlay).

Files: `media/controls.js` (ladder, panel), `media/player-ui.js` (keys, wheel, badge, overlay), `src/bar.js`
(markup), `media/player.css`.
