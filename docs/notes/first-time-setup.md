# First-Time Setup & Popup Audit

Status: **design note for review** (2026-11-25). Builds on the notification inventory and queue proposal in
`docs/notes/notifications.md` (branch `docs/notification-ux`, commit `d58961e`) rather than duplicating its
line-by-line toast list. Does not modify `docs/PRODUCT.md` or `package.json`.

---

## 1. Problem

Video Preview Enhanced currently introduces itself through **five separate, reactive VS Code corner popups**
(`src/offers.js`) plus **two in-player notices** and **one redundant toast**:

1. **First video of every session without ffmpeg** (`offers.js:66`, local/WSL) — asks to set up ffmpeg.
2. **Built-in decoder slower than real time** (`offers.js:92`, local) — asks again with measured speed ratios.
3. **Slow playback with ffmpeg, no GPU test** (`offers.js:119`, local) — asks to run a 20-second GPU test.
4. **Remote-SSH / container without ffmpeg** (`offers.js:154`) — asks to download Linux ffmpeg on the remote host.
5. **First time Live transcode starts** (`offers.js:173`) — explains lossy H.264 re-encoding after the fact.

Meanwhile, two high-value setup topics have **no onboarding at all**:
- **Remote-SSH / WSL + Live transcode**: users don't know that Remote-SSH works automatically with Live transcode
  once ffmpeg is on the remote host, or how to tune bitrate/resolution if their connection is slow.
- **AI coding agent deep links** (`docs/agents.md`): users who use Claude Code, Codex, Cursor, or Copilot don't
  discover that agents can output clickable `vscode://` frame and Compare links.

At the same time, many existing popups violate our own standards in `.claude/skills/ui-notices/SKILL.md`
(jargon like `"native"`, `"decodes at 0.4×"`, `"slower than real time"`, missing scope labels, missing
`Settings` / `Don't show again` controls, and inconsistent prefixes/capitalization).

---

## 2. Full Popup & Notification Audit

Audited against:
- **`docs/PRODUCT.md`** (product truth: zero-config defaults, no background decoding, no status pill, one layout)
- **`AGENTS.md`** (no unsolicited UI restyling, plain English, no personal data)
- **`.claude/skills/ui-notices/SKILL.md`** (Rule 1: plain English / feature-first; Rule 2: explicit tradeoff &
  scope `this tab` vs `all videos`; Rule 3: `Settings`, `Don't show again`, `×`/`Esc`; Rule 4: eliminate popups
  when the player can do the right thing automatically; Rule 5: consistent dismissal)

### 2.1 Proactive / Periodic Popups (`src/offers.js`, `src/compare.js`, `src/extension.js`)

| Surface & Location | Trigger | Standards Audit (`ui-notices` / `PRODUCT.md`) | Proposed Fate |
|---|---|---|---|
| **First-open ffmpeg offer** (`src/offers.js:66`, `src/decide.js:379`) | First video of *every* session without ffmpeg (local/WSL) | Repeats every session until "Don't Show Again"; no `Settings` link; competes with `#notice` and toast. `PRODUCT.md` currently prescribes it. | **Demote / Replace** with Walkthrough Step 2 (see §3). Only surface an in-player `#notice` if playback actually struggles (4K/HEVC/AV1/ProRes). |
| **Slow-playback ffmpeg hint** (`src/offers.js:92`, `src/decide.js:312`) | Built-in decoder < 1×, no ffmpeg | Violates Rule 1 (`"decodes at 0.4× here"`, `"natively"`), duplicates `#notice` (`player.js:251`) and toast (`engine.js:1651`). | **Remove popup**; merge into the single in-player `#notice` (`ffmpegOffer`) as proposed in `notifications.md`. |
| **GPU test offer** (`src/offers.js:119`, `src/decide.js:341`) | Slow playback with ffmpeg, no GPU test | Violates Rule 1 (`"slower than real time"`, `"Video Preview:"` prefix); no `Settings` link. | **Keep (reworded)** as a reactive offer only when playback is actually slow; also linked from Walkthrough Step 2 as an optional check. |
| **Remote ffmpeg download offer** (`src/offers.js:154`, `src/remoteff.js:56`) | Remote-SSH/container, built-in decoder, no remote ffmpeg | Violates Rule 1 (long, jargon-heavy: `"LGPL build matched to host's GPU driver"`, `"streams a lighter H.264 version"`). | **Demote to Walkthrough Step 3** (shown automatically when connected to a remote host) + shortened reactive `#notice` only when a heavy codec opens on a remote without ffmpeg. |
| **Live transcode first-time notice** (`src/offers.js:173`, `src/transcode_policy.js:251`) | First time Live transcode starts | Violates Rule 2 (button labels lack `(this tab)` / `(all videos)` scope), Rule 1 (`"re-encoded to H.264 (lossy)"`), wrong channel (corner popup for a tab event). | **Move to in-player `#notice`** (once ever, neutral tone, clear scope labels) and explain in Walkthrough Step 3. |
| **NVENC driver notice** (`src/extension.js:468`, `src/transcode_policy.js:256`) | NVENC refuses installed NVIDIA driver | Violates Rule 1 (`"NVENC API 12.2, driver has 12.1"`). Outside `popupPending`. | **Keep (reworded)**, route through `popupPending`; plain English ("Your NVIDIA driver is older than this ffmpeg build…") with **Set up ffmpeg** button. |
| **Open Together notice** (`src/compare.js:952`) | First time multiple videos open together in Compare | Minor: `"Video Preview:"` prefix; `"Open Settings"` → `"Settings"`. | **Keep (reworded)**, once ever. |

### 2.2 In-Player Notices (`#notice`, `media/player.js`) & Dialogs

| Surface & Location | Trigger | Standards Audit | Proposed Fate |
|---|---|---|---|
| **Slow playback: `every` / `skip` / `couldn't keep up` / `fastPreview`** (`media/player.js:251`, `media/slow-notice.js`) | Playback falls behind | Passes Rules 1–3 (`all videos` scope, `Settings`, `Don't show again`, `×`/`Esc`). Needs queue (`media/notices.js`) so it doesn't wipe reduced-res notice, and `unless: liveTranscode`. | **Keep** (routed through `media/notices.js` queue). |
| **Slow playback: Set up ffmpeg** (`media/slow-notice.js:50`) | Behind < 0.5×, no ffmpeg | Shares `hideSlowPlaybackNotice` with unrelated `every`/`skip` notices (Rule 3 bug). | **Keep & merge** with `offers.js:92` under its own id (`ffmpegOffer`). |
| **Reduced resolution / Live transcode pixel-tool notice** (`media/player.js:125`, `media/reduced-res-notice.js`) | Pixel tool or 100% zoom on scaled/transcoded picture | Passes Rules 1–3 (`this tab` scope, `Settings`, `Don't show again`, `×`/`Esc`). | **Keep** (level 2 in queue). |
| **Exact A–B clip refusal** (`media/player.js:480` + host `src/extension.js:660`) | Exact clip requested on re-timed picture | Host copy (`extension.js:660`) duplicates player notice and lacks `(this tab)` scope. | **Keep in `#notice`** (level 3); unify wording across single player and Compare. |
| **Start Compare confirmation dialog** (`src/player-html.js:174`, `media/player.js:1342`) | Clicking Compare button on bar | Passes Rule 5 (`role="dialog"`, `aria-modal="true"`, `Esc` closes). | **Keep**. |
| **Settings (`⚙`), Info (`ⓘ`), Compare, Shortcuts panels** (`media/controls.js`, `src/player-html.js:182`) | User clicks bar button | Passes Rule 5 (click-outside and `Esc` dismiss without toggling play). | **Keep**. |

### 2.3 Command Responses, Modals & Errors (`src/extension.js`, `src/compare.js`, `src/clipexport.js`, `src/associations.js`)

| Group | Count | Standards Audit | Proposed Fate |
|---|---|---|---|
| **Setup / download / GPU test progress, modals & results** (`extension.js:240–619`) | 14 | Answers to explicit user commands. Inconsistent `"Video Preview:"` prefix and button labels (`"Set Up ffmpeg…"` vs `"Set up ffmpeg"`). | **Keep**, drop `"Video Preview:"` prefix, standardize button to **Set up ffmpeg**. |
| **Export modals (overwrite, large frame count, reduced-res PNG)** (`extension.js:2527–2645`, `clipexport.js:324`) | 6 | `extension.js:2533` uses jargon (`"Native ffmpeg decodes this video at…"`). | **Keep**, reword `extension.js:2533` to plain English with `(this tab)` scope. |
| **Export completion / failure / refusals** (`extension.js:635–688, 2465–2682`, `clipexport.js:310`) | 18 | `clipexport.js:309–310` fires *both* a VS Code notification and a 5 s toast; `extension.js:665/673` says `"native ffmpeg"`. | **Keep** notifications for palette commands, **drop** duplicate clip-export toast, reword `"native ffmpeg"` → `"ffmpeg"`. |
| **Compare limit / selection warnings** (`compare.js:702–1236`) | 9 | Six different wordings for the same limit; mixes toasts and corner popups. | **Keep** for Explorer/Palette commands, unify to one plain-English wording. |
| **Link / URL / sequence / subtitle errors** (`extension.js:746–1111, 2444`) | 10 | `"Video Preview:"` prefix; raw error strings. | **Keep**, drop prefix. |
| **Live transcode failed** (`extension.js:2281`, `compare.js:2534`) | 2 | Corner popup for a tab-level event; raw error string. | **Move to in-player `#notice`** (level 4), log raw error. |
| **Default-viewer command feedback** (`associations.js:69`) | 1 | Only runs on explicit command (automatic activation is already silent per `PRODUCT.md`). | **Keep**. |

### 2.4 Webview Toasts (`#toast`, ~105 call sites in `media/` + 18 from `src/`)

Full inventory is in `docs/notes/notifications.md` §3. Summary of audit findings against `ui-notices`:
- **Drop redundant / noisy toasts:**
  - `"Slower than real time here. Optional ffmpeg decodes this on the GPU."` (`media/engine.js:1705`) — violates Rule 1, ignores `offer` state, duplicates `#notice`.
  - A–B clip export toast (`src/clipexport.js:309`) — duplicates VS Code notification.
  - `"Slow connection: live transcode lowered the picture…"` (`src/stream.js:801`) — duplicates the `Live · 480p ↓` bar chip (keep screen-reader announcement).
  - Panel-click echo toasts (`player.js:563–584`, `compare.js:1401`) — the radio/button already moved.
- **Promote "news" toasts to `#notice`:**
  - `"The connection is too slow for this video…"` (`src/stream.js:810`) — user didn't cause it; 6 s toast vanishes.
  - `"No sound: <codec> is not in the built-in decoder"` (`media/engine.js:373, 2439`) — 1.5 s toast vanishes; show in Mute tooltip + `#notice` when ffmpeg would play it.
- **Reword jargon toasts:**
  - `"live-transcode pixels"` (`media/exactframe.js:24`) → `"Live transcode picture"`.
  - `"built-in decoder engine"` (`media/xray.js:612, 716`) → `"isn't available for this video"`.

---

## 3. Proposed First-Time Setup Experience

### 3.1 Mechanism: VS Code `contributes.walkthroughs`

Use VS Code's native **Get Started Walkthrough** (`contributes.walkthroughs` in `package.json`):

- **Why a Walkthrough instead of a custom webview or modal wizard:**
  - Native VS Code UI — zero custom CSS/HTML to maintain, automatic theme & accessibility support, never blocks a video tab.
  - Opens once on fresh install (VS Code handles this natively via the Get Started experience, without nagging on every session).
  - **Always re-openable** from the Command Palette (**Video Preview: Open Setup Guide** → `workbench.action.openWalkthrough`) and from the player's `⚙` panel.
  - Supports `when` clauses so Remote-SSH/WSL steps highlight automatically when connected to a remote machine, and completion events (`onCommand:...`) so steps check themselves off automatically.
  - Does **not** violate `PRODUCT.md`'s rule against background decoding: nothing runs until the user clicks a button.

### 3.2 Sensible Defaults (Zero-Config Out of the Box)

Before the user touches anything, the defaults already give the smoothest experience:

| Setting | Default | What the user gets without thinking |
|---|---|---|
| Default viewer (`workbench.editorAssociations`) | Auto-configured silently on first activation | Clicking any video (MP4, MKV, MOV, WebM, AVI, …) opens right in VS Code. |
| `videoPreviewEnhanced.decoder` | `auto` | Uses your GPU automatically for common videos (H.264/VP8), built-in decoder for others, and upgrades to ffmpeg automatically if installed. |
| `videoPreviewEnhanced.gpuDecoding` | `true` | Hardware acceleration on by default when ffmpeg is present. |
| `videoPreviewEnhanced.sizeFramesToView` | `true` | Scales 4K frames to your panel size so playback stays smooth and cool; grows automatically when you zoom or go fullscreen. |
| `videoPreviewEnhanced.transcode` | `auto` | Streams smoothly over Remote-SSH/containers and prevents local 4K60 stalls automatically. |
| `videoPreviewEnhanced.transcodeMaxBitrate` | `0` (Auto) | Picks a balanced bitrate for your window size and frame rate. |
| `videoPreviewEnhanced.transcodeResolution` | `0` (Auto) | Adapts automatically to your connection speed on remote machines. |
| `videoPreviewEnhanced.whenSlow` | `every` | Shows every frame cleanly if a heavy file is slower than normal. |

### 3.3 Walkthrough Steps (Plain English, Non-Technical)

**Walkthrough title:** `Set up Video Preview Enhanced`
**Subtitle:** `Play any video smoothly in VS Code — locally, over Remote-SSH, or with AI coding agents.`

#### Step 1 — Ready to play (no setup required)
- **Copy:**
  > Video Preview Enhanced is already set as your default viewer for MP4, MKV, MOV, WebM, AVI, and 15+ other formats. Just click any video in the Explorer to play it.
  >
  > Everything is tuned for smooth playback out of the box — you only need the optional steps below for heavy 4K/HDR files, remote servers, or AI agents.
- **Buttons:**
  - **[Open a Video…]** (`command:videoPreviewEnhanced.openVideoFile`)

#### Step 2 — Smooth 4K, HDR, HEVC, AV1 & ProRes (optional ffmpeg)
- **Copy:**
  > Common videos (H.264 and VP8) already play on your graphics card with nothing to install.
  >
  > For heavy formats like **4K, HDR, HEVC (H.265), AV1, or ProRes**, one click downloads a portable copy of **ffmpeg** (~80 MB, no admin rights needed) or links one you already have.
- **Buttons:**
  - **[Set up ffmpeg]** (`command:videoPreviewEnhanced.setupFfmpeg`) — checks off the step when done.
  - **[Test GPU speed]** (`command:videoPreviewEnhanced.retestFfmpeg`) — optional; only needed if playback still feels slow.
- **Note:** Shown on local and WSL windows (`when: "!remoteName || remoteName == 'wsl'"`).

#### Step 3 — Remote servers (Remote-SSH, WSL & containers)
- **Copy:**
  > **WSL:** Works just like a local window — set up ffmpeg in Step 2 for full speed.
  >
  > **Remote-SSH / Containers / Tunnels:** **Live transcode** is on automatically (`Auto`). When ffmpeg is on the remote machine, Video Preview Enhanced streams a lightweight, smooth version of your video over the connection — and automatically adjusts quality if your network slows down.
  >
  > Saving a frame or using the Pixel Inspector still fetches the exact full-resolution picture from the original file.
- **Buttons:**
  - **[Set up ffmpeg on this remote machine]** (`command:videoPreviewEnhanced.setupFfmpeg`, shown when `remoteName && remoteName != 'wsl'`).
  - **[Live transcode settings]** (`command:workbench.action.openSettings?%22videoPreviewEnhanced.transcode%22`) — adjust mode (`Auto` / `Always` / `Off`), max bitrate, or fixed resolution.

#### Step 4 — Clickable video links for AI coding agents (optional)
- **Copy:**
  > Using **Claude Code, Codex, Cursor, or Copilot**? Teach your AI agent to output clickable links that jump straight to a specific frame or open a side-by-side comparison in VS Code.
- **Options (one-click, plain English):**
  - **[Copy agent instructions]** (new command `videoPreviewEnhanced.copyAgentSnippet` — copies the ready-to-paste Markdown block from `docs/agents.md` for `AGENTS.md`, `CLAUDE.md`, or `.cursorrules`, and shows a brief confirmation).
  - **[Install as an Agent Skill (`npx skills add`)]** (copies or runs the `npx skills add` command once `skills/video-preview-links/SKILL.md` is published; see Open Question 4).
  - **[Read the Deep Links Guide]** (opens `docs/agents.md` / GitHub docs).

#### Step 5 — How to change anything later
- **Copy:**
  > You can change any of these settings at any time:
  > - **Inside any video:** Click **⚙** on the player bar to change Live transcode, Autoplay, Picture size, Subtitles, or open Tools (A–B Range, Scopes, Pixel Inspector).
  > - **All extension settings:** Open VS Code Settings and search **Video Preview Enhanced**.
  > - **Reopen this guide:** Open the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`) and run **Video Preview: Open Setup Guide**.
- **Buttons:**
  - **[Open Extension Settings]** (`command:workbench.action.openSettings?%22videoPreviewEnhanced%22`)

---

## 4. Maintainer Decisions & Follow-Up Plan (2026-11-26)

1. **Walkthrough ships now on this branch (`docs/first-time-setup-audit`):**
   - **Keep `maybeOnboard`** (`offers.js:56`) on the first video of a session when no ffmpeg is found, because many users will close or skip the tour. Suppress it only when the user explicitly clicks **Skip** on the ffmpeg walkthrough step (or clicks **Don't Show Again** on the popup).
   - **Keep `maybeHint`** (`offers.js:78`) when playback falls behind without ffmpeg, until explicitly declined.
   - **Never offer VS Code's built-in preview** anywhere in the guide or popups (enforced by `test/host/walkthrough_test.js`).
2. **In-player notice cleanup & visual unification — deferred until after the unified viewer (`feat/compare-ux-iteration`) merges:**
   - **Remove redundant in-player notices/toasts:** `setupFfmpeg` `#notice` variant (`media/slow-notice.js:50`, covered by `maybeHint`), slow-ffmpeg toast (`media/engine.js:1705`), duplicate clip-export toast (`src/clipexport.js:309`), and quality-lowered toast (`src/stream.js:851`).
   - **Unify all remaining in-player surfaces** (`#notice`, `#toast`, `#addHint`, `#startCompareDialog`, `#goto`, `#overlay`) onto one frosted surface (`--vpe-surface-float` + `blur(12px)` + `8px` radius + distinct primary button), one consistent top-center slot with a priority queue, shared across single-video and Compare views.
   - **Fix remaining copy/scope gaps:** `(this tab)` on exact A–B clip refusal (`media/player.js:480`), plain English in `media/exactframe.js:25` and `media/xray.js:612,716`, and consistent `Settings` / `Set up ffmpeg` button labels.

---

## 5. Open Questions for the Follow-Up (Post-Unification)

1. **Slow-playback `#notice` (`every` / `skip` / `fast`):** Keep these in-player banners once unified, or trim them too so only high-signal notices (reduced-res 1:1 zoom, exact A–B clip refusal, live-transcode failures) appear over the video?
2. **Hidden notices reset command:** From `docs/notes/notifications.md` — add **Video Preview: Show Hidden Notices Again** to clear dismissed notices, or keep "Don't show again" permanent?
