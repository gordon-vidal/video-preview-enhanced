# Compare Live transcode controls

Compare needs a shared video bitrate cap for constrained connections and a way to see which tiles are re-encoded.

```text
⚙ Player settings
  Live transcode ›
    Ask | Auto | Always | Off
    Max bitrate     Auto | 2 Mb/s | 5 Mb/s | …
    Split bitrate   [On]

ⓘ About this video
  A | B | …
  Played by         Live transcode pipeline for the selected video
  Use original video
```

The existing settings and About buttons open these panels. Live transcode mode and Max bitrate use the existing
radio groups. Split bitrate is a switch in Compare with the accessible name “Split bitrate”. Tab reaches the
controls, Enter or Space activates a choice, and Escape closes the panel. Use original video applies to the selected
About tab. Compare keeps its existing player bar.
