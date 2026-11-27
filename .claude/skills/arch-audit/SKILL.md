---
name: arch-audit
description: Run a read-only architectural health audit (dependency boundaries, dead code, code duplication, git churn/coupling, and ADR alignment) and present a visual Health Report. Use periodically, before milestones, or when checking for structural drift and anti-patterns.
metadata:
  internal: true
---

# Architectural Health Audit (Read-Only)

Zoom out from individual diffs to inspect codebase shape, duplication, hotspots, and alignment with `docs/adr/`.

**Rule:** Never edit source files during an audit. Produce findings, visuals, and concrete proposals so the maintainer decides what to act on.

## 1. Gather automated signals

Run the standard checks first:

```bash
npm run arch:check
node tools/arch-inputs.js
```

What each tool covers:
- **`typecheck` + `tools/unified-contracts-check.js`** — cross-layer adapter & `postMessage` contract drift.
- **`dependency-cruiser`** (`.dependency-cruiser.cjs`) — layer boundary violations and circular dependencies across `src/` and `media/`.
- **`knip`** (`knip.json`) — unused files, dead exports, and unused dependencies.
- **`jscpd`** (`.jscpd.json`) — copy-paste and structural duplication across `src/` and `media/`.
- **`tools/arch-inputs.js`** — 60-day git churn, co-change temporal coupling, and largest files (lightweight Node equivalent of `code-maat`).

## 2. Inspect hotspots against ADRs & anti-patterns

Cross-reference the top churn, co-changed pairs, largest files, and `jscpd` clones against `docs/adr/` and `AGENTS.md`:

- **Duplicated primitives:** Parallel menu/popover/clamp/render helpers that should share one primitive.
- **Imperative DOM/CSS drift:** Raw `innerHTML` templates, hardcoded `z-index` ladders, runtime-injected markup duplicating static HTML.
- **Temporal coupling leaks:** Two files in different layers that keep changing in the same commits without a clean contract between them.
- **Stale constraints:** Workarounds piling up because an older rule in `AGENTS.md` or an ADR no longer fits.
- **Config / doc rot:** Stale file paths or obsolete rules in `AGENTS.md` or `.claude/skills/`.

## 3. Present a `show-me`-style 1-page Health Report

Follow the **`show-me`** skill (inline HTML via `html_preview` → `html_render` in T3 Code; Mermaid + tables in markdown):

1. **Scorecard strip:** Boundary violations, unused items (`knip`), duplication % & clone count (`jscpd`), and top churn hotspot.
2. **Top 3–5 structural smells:** Ranked by leverage, with exact clickable file links and a 1-line "why it hurts" + "smallest fix or ADR".
3. **Retrospective check:** 1–2 specific suggestions to update `AGENTS.md`, a skill, or an automated check (and any obsolete rule to prune).
