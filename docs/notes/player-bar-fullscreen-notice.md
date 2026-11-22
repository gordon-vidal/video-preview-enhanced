# Player bar, fullscreen and playback notice

The Compare label took up room in the bar, the Zen Mode fallback could narrow the video, and the smooth-playback notice left the effect on saved frames unclear.

```text
┌──┬──┐  Compare icon
└──┴──┘

Playing at 1920×1080 (8-bit) for smooth playback. …
[Use full resolution (this tab)] [Settings] [Don't show again] [×]
```

The split-view icon uses the Picture Size button’s outer frame. Its tooltip and accessible name are **Compare** or **Add to Compare**. Tab moves focus to the button. Enter or Space activates it. Escape dismisses the start dialog and returns focus to the button.

**F** and the **Fullscreen** button share the Zen Mode fallback in the player and Compare. The video uses the full editor width until the user exits with **F** or the button.

The banner wraps in narrow panes and announces its message through the player’s live region. The close button is named **Dismiss**. Closing the banner returns focus to **Play** when focus was inside it.
