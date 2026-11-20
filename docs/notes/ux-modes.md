# Simple and advanced mode: how other players do it (2026-11-19)

From what these players do, not from fresh measurements.

## Patterns

| Player | Default bar | Where the rest lives |
|---|---|---|
| **YouTube** | play, volume, time, subtitles, settings, fullscreen | One ⚙ popup with a short list (quality, speed, subtitles); "Stats for nerds" is a right-click item. The popup is a stack of pages with a back arrow. |
| **VLC** | transport + volume | Everything else in the menu bar. *Advanced Controls* (View menu) adds a second row: record, snapshot, **frame by frame**, A-B loop. A toggle, remembered. |
| **mpv (OSC)** | seek bar, play, playlist, tracks, volume, fullscreen | Keys and the console for the rest. Stats is a key (`i`, repeat for pages). Nothing on screen for tools. |
| **QuickTime** | play, scrubber, share | Menus only; frame step and speed are keys. Trim is its own mode (a separate bar). |
| **Frame.io / review players** | play, scrub, frame-accurate timecode | Tools (compare, annotate, loop, zoom) in a toolbar above or below the picture; a single "compare" entry opens the multi-view. Frame step is always visible, because reviewers live on it. |
| **VS Code media preview** | the browser's own controls | Nothing extra. |

## What we copy

1. **VLC's one toggle for "advanced controls", remembered.** The button is the same in both modes; the choice sticks per user (`videoPreviewEnhanced.advancedMode`, default off). It is a visible, labelled switch (not a hidden key), so people who never need it never see it and people who do find it in one click.
2. **YouTube's single ⚙/⋯ popup for the long tail.** In advanced mode one ⋯ button opens one menu. Sections with a heading (View, Navigate, Loop and export, Frame, Window); each row shows its shortcut at the right, so the menu teaches the keys. No nested pages: the list is about 20 rows and fits.
3. **mpv's rule that keys stay.** Menus never replace keys. Every tool keeps its key; the menu is for discovery.
4. **Frame.io's frame step in the default bar.** Frame step (⏮ ⏭, `,` `.`) stays in simple mode: it is one of the three things people open a video preview for.
5. **Compare as a menu entry, not a bar button** (older research): "Compare with…" is a row in the ⋯ menu, plus the existing Explorer and editor-title entries.
6. **Tracks stay on the bar** (CC), as on YouTube: subtitles are a basic need, not an advanced tool.

## What we don't copy

- YouTube's paged popup and quality picker: our list is flat and short.
- QuickTime's hidden-everything bar: too many people need seek-by-frame without learning keys.
- A second toolbar row (VLC): the bar is narrow in a split editor. A menu costs one button.
- Hiding the keys in simple mode entirely: only keys of tools that show UI are ignored in simple mode (so a stray `X` does not open the inspector); transport, volume, speed, subtitle and fullscreen keys always work.

## Layout

- **Simple:** ▶ ⏮ ⏭ time · frame | 🔊 volume speed CC ⛶ **[Advanced]**.
- **Advanced:** the same, plus the **⋯ Tools** menu; the Advanced button shows as on.
- Switching back to simple closes the tools' overlays (scopes, inspector, stats, X-ray, details, zoom).
