# 0004: Webview UI Framework, Overlay Engine & Phased Migration

- **Status:** Signed off by maintainer (2026-11-27)
- **Builds on:** [0001: Pragmatic JS + scoped `checkJs` and testable seams](0001-js-checkjs-and-testable-seams.md)

## Decision

1. **Webview build & types:** Introduce a fast `esbuild` + TypeScript build step (~100 ms) for the webview UI (`media/ui/` → `media/dist/webview-ui.js`), loaded by both `src/unified-html.js` and `tools/mockup/render.js`. Keep the extension host (`src/`), pure state (`media/player-state.js`), `EngineAdapter` / `HostAdapter`, and 3-tier decoders intact.
2. **Declarative UI layer:** Adopt **Preact + `@preact/signals`** (~5.5 KB gzipped) for webview UI components. Light DOM keeps all existing `--vscode-*` / `:has()` / `body.compare` / high-contrast CSS working without Shadow DOM friction, and Signals keep 60 fps timecode/scrubbing updates free of full-tree re-renders.
3. **Overlays & positioning:** Adopt **`@floating-ui/dom`** (~3 KB gzipped) paired with the native **HTML Popover API (`popover="manual"`)** for top-layer menus, popovers, hover cards, and tooltips, wrapped in thin accessible Preact primitives (`<FloatingMenu>`, `<Popover>`, `<SwitchRow>`, `<SegmentedControl>`).
4. **VS Code engine floor:** We are open to bumping `engines.vscode` (from `^1.82.0`, e.g. to `^1.93.0` / Chromium 125+) when newer webview platform APIs (such as CSS Anchor Positioning) meaningfully simplify the UI. `@floating-ui/dom` provides full flip/shift/collision safety immediately regardless of floor.
5. **Pre-refactor testability gate:** Before each migration phase, bring the target UI surface into a high-confidence testable state (automated unit/contract tests + Before & After screenshots/mockups) so every refactor lands behind a green safety net.

## Phased Migration Plan

- **Phase 0 — Build plumbing:** Add `esbuild` + `tsconfig` for `media/ui/` → `media/dist/webview-ui.js`, wired into `src/unified-html.js` and `tools/mockup/render.js`. Existing scripts continue working side by side.
- **Phase 1 — Unified overlay engine:** Implement `<FloatingMenu>` and `<Popover>` on `@floating-ui/dom` + `popover="manual"`, replacing `ctxmenu.js`, tile `#menu`, Folder Rail `.vpe-pop`, and `controls.js` popovers (speed, step size, A–B) and retiring manual popover `z-index` juggling.
- **Phase 2 — Bar & panels:** Port `#bar` (merging `src/bar.js` + runtime-injected Compare buttons into one declarative `<PlayerBar />` with a `#cmpGroup` capsule) and the Settings/Compare/Info panels (`controls.js` + `cmpViews`) to Preact + Signals.
- **Phase 3 — Stage tile overlays & Folder Rail:** Port Compare tile overlays (`.ov`, `.tile-stats`, `.sync-pill`, `.addcell`) and Folder Rail rows, retiring `ovKey`/`statsKey` manual memoization and raw `innerHTML` templates.

## Why

- Eliminates the main UI bug class seen in history (imperative DOM/CSS drift, duplicated floating-menu logic, manual viewport clamping, and `z-index` collisions) with ~9 KB gzipped total webview overhead.
- Keeps the strongest parts of the current architecture (`player-state.js`, `EngineAdapter`/`HostAdapter`, `reconcile`, and the mockup harness) without a big-bang rewrite.

## Discussed & rejected

- **Video.js / Vidstack as the player engine:** Built around a single `<video>` element + MSE/HLS/DASH; incompatible with 1-to-N synchronized multi-view canvases, frame-exact stepping over WebCodecs/WASM/native FFmpeg, per-tile offsets, Split Wipe, and pixel inspection.
- **Lit (Shadow DOM Web Components):** Good architecture, but Shadow DOM conflicts with VS Code's cascading theme/state selectors (`body.compare`, `body.vscode-high-contrast`, `:has()`) unless Shadow DOM is disabled.
- **Full headless libraries (Radix / Base UI) right now:** Their global focus traps and keydown interceptors risk clashing with VS Code's webview keyboard forwarding and custom video shortcuts; thin primitives over `@floating-ui/dom` + `popover="manual"` give full control.
