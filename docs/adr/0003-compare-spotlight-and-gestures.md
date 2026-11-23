# 0003: Compare Spotlight Layout, Grouped Bar Capsule & Direct Gestures

- **Status:** Draft

## Decision
- **Layouts:** Compare offers two primary layouts — **Spotlight** (universal 4-sided docking `top`/`bottom`/`left`/`right` with a resizable 10%–90% splitter) and **Equal Grid** — plus **Split Wipe** when 2 clips are loaded. Layout switching is explicit via the grouped Compare capsule in the bottom bar (and in the Compare panel).
- **Direct gestures & rect-FLIP:** Reordering is always-on (no separate Reorder mode). At 1×, dragging any tile past 6 px lifts and repositions/swaps it (or docks the Spotlight Main tile to any of the 4 edges) with dashed drop-zone skeletons and full `(x, y, w, h)` FLIP gliding across both WebGL textures and DOM overlays. When zoomed (`> 1×`), dragging the video body pans in lockstep while a `⋮⋮` grip in the top-left name pill still drags/docks tiles.
- **Minimal monochrome tile chrome & on-demand Sync:** Hover-revealed top-left identity pill (badge, name, monochrome `ⓘ` stats HUD below it with slot-A mismatch highlighting, monochrome mute), top-right Make Spotlight (non-main tiles in Spotlight only) and two-click `Remove?` (3+ clips), and on-demand per-tile offset steppers revealed only in Sync mode.

## Why
- Eliminates floating overlays on the video stage and mode-switching friction (no Reorder button), while keeping per-tile chrome minimal and uncluttered until hovered or toggled.
- Preserves lockstep zoom/pan without losing direct tile manipulation, and makes resolution/FPS/codec mismatches immediately visible via the per-tile `ⓘ` HUD.

## Discussed & rejected
- **"Make Spotlight" button on Equal Grid tiles** — rejected to keep layout switching explicit and avoid accidental mode switches while inspecting a grid.
- **Always-visible per-tile offset nudges** — rejected as visual clutter during normal comparison; moved to on-demand Sync mode (plus `-`/`+` shortcuts and the Compare panel).
