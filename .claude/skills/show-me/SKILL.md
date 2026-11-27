---
name: show-me
description: Explain architectures, data flows, state transitions, or proposed changes visually using concise diagrams and focused HTML artifacts instead of walls of text. Use when explaining how a subsystem works, before implementing changes touching >2 files or a new UI surface, or when the user asks to visualize something.
---

# Show Me — Visual Architecture & Design Checks

Replace long prose explanations with a scannable visual artifact plus 3–5 short bullets. Humans spot structural smells (duplicated helpers, broken boundaries, extra state stores) in seconds on a diagram and miss them in long diffs.

## 1. Pick the right visual format

| Context | Output |
|---|---|
| **Chat in T3 Code** (architecture, data flow, state machine, design gate) | Self-contained HTML rendered inline via `html_preview` → `html_render` using T3 theme CSS variables (`--card`, `--border`, `--foreground`, `--muted`, `--accent`, `--warning`, `--success`; no page background, no outer card, fluid width). |
| **Interactive UI / UX proposal** (player bar, panels, overlays, Compare) | Use the **`ui-mockup`** skill (`node tools/mockup/render.js`) so the preview uses the real CSS and `media/player-ui.js` — never hand-craft fake player UI HTML. |
| **Repo docs** (`docs/adr/`, `docs/notes/`, PR descriptions) | Standard Mermaid (`flowchart LR/TD`, `sequenceDiagram`, `stateDiagram-v2`). |
| **Quick structural check** (dependency graph of real imports) | `npx dependency-cruiser --config .dependency-cruiser.cjs --output-type mermaid src media` (or scoped to one folder). |

## 2. Anchor diagrams to this repo's layers

Keep labels consistent across sessions so diagrams are immediately comparable:

```text
Extension Host (src/)
   ↕  typed postMessage (media/unified-contracts.d.ts)
Webview Page & UI (media/player-ui.js, src/bar.js, CSS)
   ↕  pure state & selectors (media/player-state.js)
Adapters (EngineAdapter / HostAdapter)
   ↕
Decoders (WebCodecs / WASM / Native FFmpeg)  OR  FakeEngine + FakeHost (mockup)
```

## 3. Pre-implementation Design Gate (for changes >2 files or new UI)

Before writing code on a non-trivial feature or refactor, show:

1. **Diagram:** How the change plugs into existing layers/seams (highlight **new** vs. **modified** vs. **untouched** nodes).
2. **Reuses vs. Introduces table:** Explicitly list what existing primitives/contracts are reused and what new state, messages, helpers, or overlays are introduced.
3. **Pushback / constraint check:** Flag if you are about to write a 2nd/3rd copy of a helper, add imperative DOM/CSS syncing, or work around an `AGENTS.md` constraint that should be revisited.

## 4. Keep it tight

- One diagram per concept; split if it exceeds ~12 nodes.
- Never repeat in prose what the diagram already shows — use text only for open decisions, trade-offs, and file links.
