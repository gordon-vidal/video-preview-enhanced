# SSH Adaptive Streaming, Fast-Start & Remote Status Chip (Draft)

Draft design note for review via `.\review.cmd` before maintainer sign-off.
Does **not** modify `docs/PRODUCT.md` or `docs/adr/0002-live-transcode.md` directly.

## Problems

1. **SSH startup FOUC & asset round-trips:** Loading `player.css`, `compare.css`, and 18–26 separate `<script src>` files over a Remote-SSH link causes an unstyled flash before CSS arrives and pays multiple round-trips before the player script initializes.
2. **Blurry zoomed Compare tiles over SSH:** Transcoded Compare tiles size to their grid cell (e.g. 540p in 2×2). Zooming in while inspecting details left transcoded tiles blurry, especially while paused because `setCompareOutput` restarted ffmpeg at the next unsent frame without refreshing the paused picture.
3. **Sluggish backward wheel stepping over SSH:** `EncodedStream` (history in `src/stream-buffer.js`) previously kept 5 s of compressed GOP history and restarted only 1 s earlier on step-back, causing repeated ffmpeg respawns during consecutive backward mouse-wheel notches. On the webview side, `media/engine.js`'s `this.back` cache rejected WebCodecs `VideoFrame` objects outright, so every paused backward step on a remote H.264 stream forced a round-trip seek + GOP re-decode.
4. **Visibility of remote Live transcode state:** Over SSH/WSL, users have no at-a-glance indication in the player bar that Live transcode is active, what resolution/bitrate cap is in use, or when the quality ladder is stepping down on a slow link.

## Design & Trade-offs

### 1. Zero-FOUC CSS Inlining & Remote Small-Script Inlining
- `src/player-html.js` adds an in-memory cached asset reader (`inlineAssetsFor` / `readMediaAsset`) and escaping helpers (`escapeStyle`, `escapeScript`).
- Both single-player (`src/extension.js`) and Compare (`src/compare.js`) inline `player.css` (and `compare.css`) via `<style nonce="...">` on every host (local and remote), eliminating FOUC on frame 0 and cutting 1–2 round-trips.
- CSP `style-src` is updated from `style-src ${cspSource}` to `style-src 'nonce-${nonce}' ${cspSource}` (strict nonce, no `'unsafe-inline'`).
- On remote hosts (`vscode.env.remoteName`), small helper scripts up to `16 KB` (`INLINE_SCRIPT_MAX_BYTES`) are also inlined via `<script nonce="..." data-src="...">`, eliminating ~15 additional HTTP round-trips in Player (~85 KB total) and ~14 in Compare, while keeping large core scripts (`engine.js`, `player.js`, `compare.js`, `controls.js`) and Web Workers external.

### 2. Zoom-Aware Adaptive Resolution in Compare
- `media/compare.js` includes the effective `zoom` in `tileSize` messages and uses a 300 ms debounce when any tile is transcoded (vs. 150 ms for local raw tiles) to avoid ffmpeg thrashing during smooth `Ctrl+wheel` zooming.
- `src/transcode_policy.js` (`compareTileSize`) introduces `ZOOM_UPGRADE_THRESHOLD = 1.5`:
  - Sub-threshold zoom gestures (`1 < zoom < 1.5` in Fit mode) keep the base cell size so slight zooms do not restart ffmpeg.
  - `zoom >= 1.5` scales the target output size toward source resolution (capped at `video.height` and `maxHeight`) while `compareCapsKbps` continues to enforce the shared bitrate budget.
  - Zooming back to Fit (`zoom = 1`) steps the tile back down to its cell size.
- When a transcoded tile's output height **grows**, `EncodedStream.setCompareOutput(..., { deferGrow: true })` marks `resizePending = true` instead of restarting immediately, and `CompareSession.resizeTranscodes()` posts `{ type: 'resize', tiles }`. The webview's existing `refreshNativeFrame()` seeks once to the exact paused/playing timestamp, producing a crisp higher-resolution frame on paused + zoomed tiles with a single ffmpeg spawn.

### 3. Faster SSH Backward Frame Stepping
- **Host:** `src/stream-buffer.js` expands the GOP history (`HISTORY_S = 8`, `REMOTE_HISTORY_S = 15`, `SEEK_KEEP_S = 3`, `HISTORY_MAX_S = 20`; pure `historyKeepTime`, the buffer takes `remote`). `src/stream.js` expands the step-back (`STEP_BACK_SPAN_S = 4`, `REMOTE_STEP_BACK_LEAD_S = 2.5` vs. `STEP_BACK_LEAD_S = 1`; pure `stepBackStart`). Both pure helpers are unit-tested without ffmpeg.
- **Webview (`media/engine.js`):** Increased paused `this.back` budget for remote streams (`65%` vs. `50%` of frame budget via `backBudget()`), allowed already-spilled YUV frames in `keepPassed()`, and allowed bounded-concurrency (`<= 4` in-flight) spilling of recent (`<= 3 s` before `seekTarget`) WebCodecs `VideoFrame`s during paused remote seeks into `this.back` (guarded by `backGen` / `gen`). Consecutive paused backward wheel steps hit decoded RAM frames immediately.

### 4. Remote/WSL Live Transcode Status Chip (Proposed ADR 0002 Revision)
- **Proposed narrow revision to ADR 0002 & `docs/PRODUCT.md`:** ADR 0002 currently rejects a player-bar status pill in favor of ⚙ + ⓘ (the modes are `auto | always | off`; `ask` is retired, so the chip never asks anything). On local windows, playback stays quiet with no status pill. **On remote hosts only (`cfg.remote` / `vscode.env.remoteName`) while Live transcode is active**, we propose showing a compact, clickable chip in the bar (`#remoteLiveBtn`, hidden locally and hidden when Live transcode is inactive).
- **Behavior:** Clicking the chip toggles the `Live transcode` settings page directly (`controls.toggle('transcode', ui.remoteLiveBtn)`), giving one-click access to the Auto / Always / Off mode and max bitrate controls. The page is the same one ⚙ › Live transcode opens (Esc closes it and returns focus to the chip).
- **States:**
  - Active: `Live · 1080p · 6 Mb/s` (or `Live · 720p ↓ · 3 Mb/s` when on a stepped-down link tier).
  - Adapting transition: `Live · Adapting ↓` / `Live · Adapting ↑` while ffmpeg restarts for a new tier.
- **Narrow bar:** Shed at `@media (max-width: 640px)` alongside `#infoBtn` and range buttons; Settings (⚙) remains reachable.

### Keyboard & Accessibility Names (`#remoteLiveBtn`)
- Element: `<button id="remoteLiveBtn" class="ib live-chip mono" aria-expanded="false" aria-controls="panel" hidden>`
- Keyboard: Standard focusable toolbar button (`Tab` to focus, `Enter` or `Space` to toggle the Live transcode settings panel, `Esc` closes the panel and returns focus to the chip).
- Accessible names (`aria-label`):
  - Default / active: `"Live transcode active, 1080p, max 6 Mb/s. Open Live transcode settings"`
  - Stepped-down tier: `"Live transcode active, 720p (adapted down), max 3 Mb/s. Open Live transcode settings"`
  - Adapting down/up: `"Live transcode adapting quality down. Open Live transcode settings"` / `"Live transcode adapting quality up. Open Live transcode settings"`
- Tooltip (`title`): `"<pipeline label>. Click to adjust mode or max bitrate"`
