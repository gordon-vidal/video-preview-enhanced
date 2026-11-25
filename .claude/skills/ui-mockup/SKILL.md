---
name: ui-mockup
description: Build, update, and preview realistic interactive UI mockups using the real CSS, bar markup, and pure PlayerState module. Use whenever proposing, changing, or reviewing player or Compare UI/UX.
---

# Realistic UI Mockups & Millisecond State Verification

Never hand-craft throwaway HTML/CSS from scratch for UI proposals. Framewise keeps **UI**, **Player State**, and **Decoder Engine** cleanly separated so mockups run on the real production styles and state transitions:

1. **Pure state (`media/player-state.js`)** — zero DOM, zero VS Code, zero decoder. Owns unified tab/compare state (`tiles`, `capture`, `layout`, `spotlightId`, `split`, `offsets`, `syncMode`, `frame`) and pure `deriveUi(tab, stage)` selectors.
2. **Real UI assets (`src/bar.js`, `media/player.css`, `media/compare.css`, `media/compare-grid.js`)** — inlined directly by the mockup harness so icons, spacing, tokens, and responsive rules never drift from production.
3. **Fake engine (`tools/mockup/fake-engine.js`)** — deterministic 2D `<canvas>` frame renderer that replaces `LibavPlayer` / ffmpeg / WebCodecs for instant startup.
4. **Harness (`tools/mockup/render.js`)** — generates a self-contained interactive HTML file with a simulated VS Code Explorer, Tab Bar, and scenario selector.

## Workflow for any UI/UX task

1. **Model the state change first in `media/player-state.js`** (and add assertions in `test/host/player_state_test.js`).
2. **Verify in milliseconds in Node:**
   ```bash
   node test/run.js unit --grep player_state
   ```
3. **Contribute your UI change / scenario to `tools/mockup/render.js`** (add or update a preset in `SCENARIOS` and wire any new bar/tile control using the real CSS classes).
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

- Always keep `media/player-state.js` pure (no DOM, no `vscode`, no Node builtins, no decoder imports) and covered by `checkJs` (`npm run typecheck`).
- When changing bar buttons, tile overlays, or Compare layouts, update `tools/mockup/render.js` in the same PR so the mockup harness stays a truthful, living prototype.
