# Seek-pending feedback

**Problem.** Over a slow Remote-SSH link a seek can take a second or more to land. The bar keeps showing the old
position and the click feels lost.

**Change.** While `seekTarget` is set for more than 200 ms, `#seekRow` gets the class `seeking`; it is removed the
moment the seek lands. The seek slider's opacity eases between 1 and 0.55 (1.1 s loop). Nothing else changes:
no colour, no size, no layout shift, no new element, no new focus stop.

**Accessibility.** Under `prefers-reduced-motion` the animation is off and the slider is held at 0.7 opacity.
The slider's name and value text are unchanged.

**Why not a spinner.** The player theme is frosted monochrome; a dimmed bar is the smallest signal that fits it.
