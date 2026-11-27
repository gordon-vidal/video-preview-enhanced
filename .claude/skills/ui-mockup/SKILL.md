---
name: ui-mockup
description: Build, update, and preview realistic interactive UI mockups using the real CSS, bar markup, and pure PlayerState module. Use whenever proposing, changing, or reviewing player or Compare UI/UX.
---

# Realistic UI Mockups & Millisecond State Verification

Never hand-craft throwaway HTML/CSS from scratch for UI proposals. Framewise keeps **UI**, **Player State**, and **Decoder Engine** cleanly separated so mockups run on the real production styles and state transitions:

1. **Pure state (`media/player-state.js`)** — zero DOM, zero VS Code, zero decoder. Owns unified tab/compare state (`tiles`, `capture`, `layout`, `spotlightId`, `split`, `offsets`, `syncMode`, `frame`) and pure `deriveUi(tab, stage)` selectors.
2. **Real UI assets (`src/bar.js`, `media/player.css`, `media/compare.css`, `media/compare-grid.js`)** — inlined directly by the mockup harness so icons, spacing, tokens, and responsive rules never drift from production.
3. **Shared UI controller (`media/player-ui.js`)** — wires the real `#bar`, `VpeControls`, `VpeFolderRail`, `VpeCtxMenu`, stage cells and keys to the state through an `EngineAdapter` and a `HostAdapter` (contract: `docs/notes/player-ui-controller.md`).
4. **Fake engine + fake host (`tools/mockup/fake-engine.js`, `tools/mockup/fake-host.js`)** — deterministic 2D `<canvas>` frames instead of the decoders, and the folder-rail / neighbour / Compare host protocol over a fake folder tree.
5. **Harness (`tools/mockup/render.js`)** — generates a self-contained interactive HTML file that mounts `media/player-ui.js` and draws only the simulated VS Code chrome (Explorer strip, tab bar, scenario selector).

## Workflow for any UI/UX task

1. **Model the state change first in `media/player-state.js`** (and add assertions in `test/host/player_state_test.js`).
2. **Verify in milliseconds in Node:**
   ```bash
   node test/run.js unit --grep "player_(state|ui)"
   ```
3. **Wire new bar / tile / panel behaviour in `media/player-ui.js`** (an action in its dispatch table, plus an assertion in `test/host/player_ui_test.js`), never as harness-only glue. Add or update a preset in `SCENARIOS` in `tools/mockup/render.js`; extend `fake-host.js` when the UI needs a new host answer.
4. **Generate and preview inline in T3 Code:**
   ```bash
   node tools/mockup/render.js --scenario capture-waiting --out .tmp/mockup.html
   ```
   Then call `html_preview` → `html_render` with the generated HTML so the maintainer can interact with the real CSS and state transitions before any VS Code host or decoder wiring is touched. (Delete any temporary `.tmp/` file before committing.)

## Available CLI flags

```bash
node tools/mockup/render.js --list
node tools/mockup/render.js --scenario spotlight --theme dark --height 496 --out path/to/out.html
```

## Rules

- Follow `docs/DESIGN.md`: cards use the shared tokens (background, blur, radius, shadow), messages are a toast or a notice.

- Always keep `media/player-state.js` pure (no DOM, no `vscode`, no Node builtins, no decoder imports) and covered by `checkJs` (`npm run typecheck`).
- Keep `media/player-ui.js` free of VS Code and decoder code: everything outside the page goes through `host.post` / `onHostMessage`, every picture through the engine adapter.
- When changing bar buttons, tile overlays, or Compare layouts, change `media/player-ui.js` (and a scenario in `tools/mockup/render.js` if useful) in the same PR so the mockup stays a truthful, living prototype.
