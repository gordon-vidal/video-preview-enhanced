---
name: ui-notices
description: Write and review user-facing notices, banners, modals, and VS Code notifications in Video Preview Enhanced. Use whenever adding, editing, or auditing any popup, in-player notice, or warning dialog.
---

# User-Facing Notices & Popups

Every in-player notice (`#notice`), modal dialog, and VS Code notification must follow these rules.

## 1. Plain English, Feature-First
- **No internal jargon.** Never write implementation phrasing like `"not the file's own"`, `"synthetic timestamps"`, `"native"`, `"cfr"`, or `"decoding is slower than real time"`.
- **Explain the *why* as a feature, not an error.** If the player intentionally downscales, transcodes, or slows playback, say *why* (e.g., *"for smooth playback"*, *"so every frame is shown"*). Use neutral styling for informational notices — reserve warning colors for actual failures or data loss.

## 2. Explicit Tradeoff & Scope
- **Name the tradeoff.** Make clear what happens if the user switches vs. stays (e.g., full resolution may play slower; skipping frames keeps real-time speed at the cost of dropped frames).
- **Name the scope on every action.** Never silently mutate a global setting or reload a tab without saying so:
  - Tab-only action: label it `… (this tab)` (e.g. **Use full resolution (this tab)**).
  - Global/default action: label it `… (all videos)` or state that it updates the default in Settings.

## 3. Required Controls on Recurring Notices
Every recurring in-player notice must give the user full control:
1. **Primary action** (with clear scope and a tooltip stating any side effect like a tab reload or slower playback).
2. **`Settings`** button — opens VS Code Settings filtered directly to the controlling setting (`videoPreviewEnhanced.<setting>`), whenever a setting exists.
3. **`Don't show again`** button — persists dismissal in `globalState` (passed to the webview in `cfg`) so the notice never nags again.
4. **`×` (close)** button — dismisses for this tab only, keeping current behavior. Must also support `Escape` and stop click propagation so dismissing never toggles play/pause.

## 4. Prefer Eliminating Popups Over Explaining Them
Before adding or keeping a notice, ask whether the player can just do the right thing automatically (e.g., fetching an exact single frame from the host for Copy/Save/Inspector/Scopes so smooth playback never needs to warn the user at all).

## 5. Anchored Popups, Menus & Overlays (General Rules)
Every anchored panel (`ⓘ` Info, `⚙` Settings, Speed, Subtitles, Compare) and overlay (Scopes, Pixel Inspector, `#notice`) must follow consistent dismissal rules:
- **Click anywhere outside closes it:** Clicking empty space on the control bar, another control (e.g. Mute, Volume, Seek, Play), or the video stage closes any open anchored panel immediately — never require clicking specifically on the video canvas.
- **Dismissing never triggers playback:** Clicking the stage to dismiss an open panel, or clicking `×` / actions inside a notice or overlay, must not toggle play/pause.
- **`Escape` always exits:** Every panel, notice, and modal/inspection tool (Pixel Inspector, Scopes) must close cleanly on `Escape`.
- **Right-click menus show shortcuts:** Every context menu item with a keyboard shortcut displays it, and common actions should have clear, standard shortcuts.

## 6. Look
A notice or toast never gets its own styling: both use the shared card tokens in `docs/DESIGN.md` (no accent colour or
icon; the main action filled with VS Code's button colour).

## Checklist Before Shipping
- [ ] Plain English? Zero internal decoder jargon?
- [ ] Explains *why* (the user benefit) and the *tradeoff* of switching?
- [ ] Action label makes scope obvious (`this tab` vs `all videos`)?
- [ ] Includes **Settings** (when backed by a setting), **Don't show again** (persisted), and **×** (`Esc` + `stopPropagation`)?
- [ ] Neutral styling unless something actually failed?
