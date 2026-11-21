# Compare engine for up to 16 videos, 2026-11-20

Gordon's decision: take the engine of the old 16-video multi-view (branch `codex/multiview-layout`,
`90c9f54` and the review fixes `e381af4`, on the old history) into today's compare, not its UI. The
bar, the Compare panel, the tiles and the 2 / 3 / 4 layouts stay. Free tile placement is deferred.

The fixes that also apply to 2-4 tiles (page ids, seek through resize, clock switch and clock removal,
disposal) were already ported in `fix/compare-from-multiview`; they were not redone.

## What a user sees

- Setting `videoPreviewEnhanced.compare.maxVideos` defaults to 8 and accepts 2–16. It caps Compare
  Videos, Compare Videos in Folder, Open Together, Compare With…, dropped files and Add Mode.
- From 5 videos, cells fill a static grid left to right and top to bottom (3×2, 3×3, 4×3, 4×4).
  The first spare slot is the Add video cell while the setting allows more. When the current grid
  has no spare slot, **Add video…** in the Compare panel and Shift+D can still add videos up to the limit.

### Dense tile overlays

A narrow panel or a letterboxed picture can leave too little room for two controls side by side.
In grids of five or more, the hover controls use the full cell and stack in its upper left.

```text
┌───────────────────┐
│ [A clip…    #123] │
│ [‹    +3 f     ›] │
│                   │
└───────────────────┘
```

Hover or keyboard focus reveals the controls. Long filenames can truncate. The name pill opens
the tile page. The offset buttons retain their accessible names (“A earlier”,
“Offset of A: +3 frames”, “A later”). The Add cell is named “Add video”. The − / + keys still
nudge the tile under the pointer. Two to four videos retain their existing overlays.

## What changed (5 videos or more only)

| Part | Before (2-4, unchanged) | 5-16 | Where |
|---|---|---|---|
| WebGL | a context per engine plus the compositor | one shared renderer on a scratch canvas draws each tile's frame straight into its compositor texture: 2 contexts for any count (Chromium keeps 16 per page) | `media/compare.js` `sharedRenderer` |
| Tile texture | the engine's canvas size | all tiles together at most one 4K picture (16 tiles: 960×540 each) | `media/compare-grid.js` `texturePixels` |
| Lockstep | paused view drawn once all tiles show their frame | the same; textures fill as engines draw, the view draws only a matching set | `present()` |
| Decoded frames kept | 250 MB (2) / 120 MB (3-4) per tile at 32 GB | 480 MB shared (16: 30 MB each; 12 MB at 8 GB) | `tileMemory` |
| Engine budgets | machine budget / n, floors (1 worker, 16 MB blocks) | / n with no floors: 0 extra pool workers, blocks, batch and recycle buffers divided | `tileMemory`, `decoder-worker.js` strict recycle |
| File blocks | 4 MiB × 4 read ahead in remote windows | 1 MiB, one read ahead | `engine.js` `initBlocks` |
| Built-in decoder batches | 96 KB of packets | one packet (a batch expands to full-size frames in every tile) | `engine.js` |
| Remote window memory | the 32 GB defaults | from the client's `navigator.deviceMemory` | `media/membudget.js` |
| Native transport | HTTP streams | WebSockets on the same frame-server port (6 HTTP streams per origin) | `src/compare.js` |
| Native credits | 8 per request, 16 held | 2 per request, 4 held; no loop standby ffmpeg | `src/native.js` |
| Native sizes | stage / 2 per side | stage / cols × rows; the first tile's aspect from the page when it is built-in; room for ffmpeg's even-width rounding | `tileHeights` |

The host queue (12 frames at 32 GB) was already divided by the tile count with one frame minimum.
Copy frame in a large grid copies the tile as drawn in the view (the engine canvases hold no picture).

## Measured

Hidden-desktop VS Code 1.147.0, Windows 10, i7-9700K, RTX 4070, 32 GB, through `test/benchq.js`
(`node test/benchq.js node test/vscode/scenarios.js --grep "^multiview-large(-native)?$"`). Native
ffmpeg, n copies of a 24 s 1080p HEVC 8-bit 24 fps clip (`multiview_hevc.mp4`), a 1920×1080
device-pixel stage, presented frames per tile over 5 s after 1.5 s of play. Two runs (other processes at
about 20-35 % CPU). Under heavy load (other agents near 100 % CPU) a run gave 23.9 and 20.5.

| Videos | Grid | Native frames | Transfer (estimate) | fps per tile | Old branch |
|---|---|---|---:|---:|---:|
| 9 | 3×3 | 640×360 | 74.6 MB/s | 23.7-24.0 | 24.0 |
| 16 | 4×4 | 480×270 | 74.6 MB/s | 23.5-23.9 | 21.5-21.7 |

## Tests

- Layer 1: `test/host/compare_grid_test.js` (the setting, grids, memory for 2-16 tiles and 8-32 GB, texture
  cap, native credits and queue, native heights for 9 and 16 tiles under both budgets, the page's scripts,
  the setting capping open and add).
- Layer 3: `multiview-large` (9 GPU and built-in tiles: 2 WebGL contexts, lockstep, offsets, clock, play,
  remove to 8, add to 16, close) and `multiview-large-native` (9 and 16 native tiles over WebSockets on one
  port, cell-sized frames, offsets, playing in step, a seek through a resize; fps recorded, not judged).

## Open

- Free tile placement. For ordering within the grid, see [Tile order](compare-ui.md#tile-order).
- 16 tiles on the built-in (WebAssembly) decoder run 16 workers, each with its own heap; 1080p HEVC there
  is far below real time. With ffmpeg they play.
