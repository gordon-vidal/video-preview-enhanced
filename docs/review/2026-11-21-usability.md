# Usability and setup review: 2026-11-21

Scope: a first-time user's path through Video Preview Enhanced 0.7.2, read from the README, `docs/`, `package.json` (contributes) and the host code (`src/`), plus a contributor's first hour. This is a desk review: no screenshots were taken and nothing was run, so every "the user sees" below comes from the docs and the code, and some items are marked **verify** for a hands-on check. Findings that need a design decision from the maintainer are marked **[D]** with options, not a decision.

Severity: **High** = a new user is likely to get stuck or misled; **Medium** = friction or inconsistency; **Low** = polish.

## 1. Summary

1. **High** The `npm test` command is documented two ways (layers 1-2 in CONTRIBUTING, layers 1-3 in `package.json` and AGENTS.md). A newcomer on Linux or macOS will run the Windows-only layer 3.
2. **High** There is no first-run guidance except the ffmpeg notification: no walkthrough, no Command Palette "keyboard shortcuts" or "open video file" entry, no key rebinding. The only discovery path for about 40 keys is pressing `?` inside the player.
3. **Medium** The settings page has 19 entries, mixes everyday options with performance internals, and has obsolete text (`advancedMode`; `whenSlow` says "click the status pill", which no longer exists).
4. **Medium** Several notifications and docs contradict each other or the code (button labels "Don't ask again" vs "Don't remind me", docs/comparison.md still at 0.6.1).
5. **Medium** Remote and WSL behaviour is explained well in `docs/remote.md` but not at the moment it matters (the player does not say, in plain words, why a remote 4K file is soft or stutters).
6. **Medium** Compare has five entry points; the key `D` and drag-with-Shift are hard to discover.
7. **Low** README quick start does not mention the optional step's cost (a 77 MB download) or that MP4 opens here only after the one-time default is set.

## 2. First-time walk-through

### 2.1 Install

- README opens with the promise, one hero GIF, and a comparison table. Quick start is 4 steps and fits one screen. Good.
- Marketplace page = README. The only picture is the remote GIF (`media/marketing/hero-remote.gif`); compare, scopes and the codec X-ray, which are the differentiators, have no image on the page. `media/screenshots/` holds two PNGs that the README does not use.
- Activation: `onStartupFinished` and `onUri`; no `onCommand`/`onCustomEditor` listed, which is fine since VS Code adds those. The extension loads at every window start (about 30 ms according to the docs) so file icons are correct. This is explained only in the `overrideFileIcons` description.

### 2.2 First video

- Formats VS Code cannot play (MKV, AVI, MOV ...) open here by default (`priority: default`). MP4 and WebM are `option`, and the extension writes `workbench.editorAssociations` into the user settings on first activation, with no message (documented in `docs/commands-and-settings.md`, the section "Making it the default").
  - Consequence: a user who installs and double-clicks an MP4 sees the new player and never learns that settings were changed. A user who later wonders why their MP4 opens "differently" in another editor has to find the undo command. The FAQ covers the opposite case (MP4 opens in VS Code's own preview) but not "why did my settings.json change". **[D]** options: (a) keep silent, add a one-line note to the README quick start; (b) show a one-time, dismissible notification with an Undo button; (c) leave the association to the user and show a hint on the first MP4 only.
- Autoplay and loop default to **on**. Loop on by default is unusual for a review tool (a reviewer stepping through a short clip is looped back to the start at the end). It is a setting and it is in the ⚙ panel, so low severity. **[D]** keep, or default off.
- Sound: playback starts muted until the first click, because of VS Code's autoplay policy. This is in `docs/keys.md` and the FAQ ("Why is there no sound at first?") but the player's own UI cannot be read from the code alone. **Verify** that the muted state is visible without hovering (an icon in the bar) and that a first click on the picture both unmutes and keeps playing.

### 2.3 The ffmpeg prompt and setup flow

What the code does (`src/decide.js`, `src/extension.js`, `src/setup.js`):

- First video of each session, when no ffmpeg is found and the user has not chosen "built-in" (not in SSH, container or restricted windows): a notification "Video Preview works best with ffmpeg: 4K, HDR, HEVC, AV1 and ProRes play smoothly on your GPU. Set it up now?" with **Set up ffmpeg**, **Not now**, **Don't remind me (use built-in player)**.
- Setup first searches for an installed ffmpeg; if none, it asks "Download portable ffmpeg?" and the download has a SHA-256 check and a "Show source" button.
- Separate, later: a slow-playback hint with **Set up** / **Not now** / **Don't ask again** (`src/extension.js`, the hint at line ~368), and a GPU test offer **Run test** / **Not now** / **Don't remind me** (`src/decide.js`).

Findings:

- **Medium** Three different notifications use three different wordings for "never": "Don't remind me (use built-in player)", "Don't ask again" and "Don't remind me". They mean different things (the first also silences the slow-playback hint, per `docs/ffmpeg.md`). A user who clicked one of them has no visible way to bring the prompt back other than knowing the command **Video Preview: Set Up Optional ffmpeg**. Suggest: one wording for the same effect, and say in the button's tooltip or the FAQ how to undo. The FAQ has no ffmpeg entry at all (see 2.9).
- **Medium** The first-run text promises "4K, HDR, HEVC, AV1 and ProRes play smoothly on your GPU". The docs say HDR in native mode is tone-mapped from 8-bit frames unless the display is HDR, and that AV1/VP9 4K in the built-in decoder is slow. The claim is acceptable as a pitch, but it is a stronger statement than `docs/ffmpeg.md` makes. README claims must match a measured run (AGENTS.md); check this string against the measured table.
- **Medium** The setup command title is long for the palette: "Set Up Optional ffmpeg (GPU decoding for 4K, AV1, ProRes)". It is findable (typing "ffmpeg" works) but it is the only command title with a parenthesis, and it names formats that may change. **[D]** shorter title with the detail in the notification.
- **Low** The README says "Add optional FFmpeg from VS Code" but does not say that this is a download of about 77 MB on Windows (the size is only in `docs/ffmpeg.md`). The notification does show URL and hash, which is good.
- **Positive** No admin rights, nothing decodes in the background after install, checksums verified, a copyable link when the download is blocked by a proxy. This is better than any competitor-style "install ffmpeg yourself" instruction.
- **Verify (hands-on)**: what the user sees between clicking Set up ffmpeg and a working player (progress, cancel, whether the current video restarts automatically). The code offers "Reopen video" for the GPU test; for setup this was not checked.

### 2.4 Keyboard shortcuts

- `package.json` contributes **no** `keybindings`. All keys live in the webview, so they do not appear in VS Code's Keyboard Shortcuts editor and cannot be rebound there. Users who rebind keys (or use non-US layouts, see below) have no recourse. **[D]** options: (a) leave as is and document it; (b) a `videoPreviewEnhanced.keys` setting mapping action to key; (c) contribute real keybindings with `when: activeCustomEditorId == ...` for the main actions so they appear in the editor (webview focus decides which keys reach the page, so this needs a spike).
- Discoverability: the shortcuts sheet (`?`) and the right-click "Keyboard Shortcuts" item exist, but `videoPreviewEnhanced.ctx.keys` is hidden from the Command Palette (`when: false`). There is no palette command to show the shortcuts, to open the extension's settings, or to focus the player. Because the player's settings panel (⚙) is also the only place for jump sizes, `Video Preview: Open Settings` would be an obvious missing entry.
- Layout-dependent keys: `,` `.` `?` `{` `}` `[` `]` `+` `-` `#` and `Shift+<`/`Shift+>` are hard on many non-US keyboards (`?` needs Shift on US layouts and AltGr on some others; `{` `}` `[` `]` need AltGr on German layouts). Whether the page uses `event.key` or `event.code` was not checked. **Verify** on a German or French layout; offer `Shift+/`-independent alternatives (the bar buttons and the ⚙ panel already cover most actions).
- Conflicts and overlaps:
  - `Ctrl+C` copies the frame, not a selection (fine, no text selection exists). `Ctrl+G` is VS Code's Go to Line when focus is in the editor; in the player it means go to frame. Consistent with intent but worth one line in docs.
  - `F` fills the editor **and** switches VS Code to zen mode. This changes the user's workbench layout; docs say so, the key sheet should too. **[D]**
  - `Shift+P` is "previous video" while `P` used to be picture-in-picture (now removed). Users coming from the older version may press `P` and get nothing. The CHANGELOG records it.
  - `X` is the pixel inspector in the player and "swap sides" in compare; `+` / `-` zoom in the player and nudge offsets in compare. Documented in `keys.md`; consistent within each mode but a source of mistakes when switching.
  - `R` toggles loop in the player; `Z` cycles picture size; `A`/`B` set A-B and `Shift+A` switches audio track. Plausible but not YouTube-standard everywhere; the docs call the layout "YouTube-style", which holds for Space/K/J/L/M/F/arrows only.
  - Key chords: documented that Alt+Left/Right and Ctrl+K are left to VS Code. Good.
- Mouse: wheel while paused steps frames (documented). A user who scrolls the page with the wheel over a paused video will step frames instead. **Verify** that the wheel step is limited to the picture area and does not trap scrolling in the Compare panel.

### 2.5 Settings

19 settings under `videoPreviewEnhanced.*`, one section, no `order`, no sub-headings (`contributes.configuration` is a single object).

| Group (as a user thinks of it) | Settings | Remarks |
|---|---|---|
| Playback | `autoplay`, `loop`, `jump.arrow`, `jump.shift`, `jump.ctrl`, `stepButtons`, `pictureSize`, `sequenceFps` | Good, plain names. Dotted `jump.*` is the only nested naming. |
| Decoding | `decoder`, `ffmpegPath`, `gpuDecoding`, `whenSlow`, `fastPreviewWhenBehind`, `remoteStream` | Overlapping concepts: three settings say "which decoder", two say "what to do when slow". |
| Frame size / performance | `nativeMaxHeight`, `sizeFramesToView` | `nativeMaxHeight` description is 481 characters and references `sizeFramesToView`; the two interact. |
| Display | `hdrOutput`, `overrideFileIcons` | |
| Obsolete | `advancedMode` | Deprecated and ignored. |

Findings:

- **Medium** `advancedMode` is deprecated and ignored since 0.7.0 but still occupies a row in the Settings UI (with a deprecation note). Remove it from `contributes` (users' stored values are harmless), or keep it hidden. Docs still list it in the settings table.
- **Medium** `whenSlow` description says "Click the status pill in the player to switch". The FAQ says the status pill was removed. The text is wrong now; the docs table says the notice switches it. Fix the string.
- **Medium** `advancedMode` text says the tools are in "the settings panel (the cog) and the right-click menu", but the right-click menu holds only play, loop, A-B, copy/save frame, timestamp, compare, shortcuts, settings; scopes, inspector, X-ray, stats are not in it (`docs/keys.md`). Moot once the setting is removed.
- **Medium** Performance-internal settings (`nativeMaxHeight`, `sizeFramesToView`, `fastPreviewWhenBehind`, `gpuDecoding`, `remoteStream`) appear next to everyday ones with the same weight. VS Code supports tags (`"tags": ["advanced"]`) and `order`; neither is used. **[D]** options: (a) add `order` and `tags: ["advanced"]` so the everyday ones lead; (b) group via an array of configuration objects (VS Code lets an extension contribute several titled sections); (c) leave and document.
- **Low** Descriptions use two fields (`description` and `markdownDescription`) inconsistently; some contain backtick formatting that only renders in markdown ones. Cosmetic.
- **Low** `loop` default `true` and `autoplay` default `true` (see 2.2). `decoder` description is one short line ("Which decoder plays videos.") and the real explanation is in the enum descriptions: fine, but the same text is repeated in three docs pages and will drift.
- **Low** `whenSlow` value `every` vs `skip` are not self-explanatory names; the enum descriptions help.
- Which settings are machine-scoped is marked (`ffmpegPath`, `remoteStream`). Good. The remote doc says to set `remoteStream` "in the remote's settings", which most users will not know how to do; add the exact path (Settings > Remote [SSH: host] tab).

### 2.6 Commands in the Command Palette

All commands share the category "Video Preview" (title prefix shown as "Video Preview: ..."). Visible in the palette:

`Open Video URL…`, `Open Video URL to the Side…`, `Open Video URL in New Window…`, `Play Image Sequence`, `Show Log`, `Set Up Optional ffmpeg …`, `Re-test ffmpeg`, `Use Video Preview Enhanced for MP4/WebM`, `Use VS Code's Preview for MP4/WebM`, `Compare / Play Together`, `Compare With…`, plus context-only ones (`Load Subtitles…`, `Export Frames (A–B)…`, `Copy ffmpeg Command for A–B`) that appear only when a player is active (`when` clauses).

Findings:

- **Medium** There is no "Open Video File…" command. A user who wants to play a file outside the workspace has to use File > Open File or the compare dialog, while the URL command is first in the palette. Several comparable extensions offer a file picker, "play to the side" and "new window" variants for files. **[D]**
- **Medium** `Compare / Play Together` and `Compare With…` both appear in the palette and both open pickers. From the palette the first works without a selection (it asks for A and B), the second takes the active player as A. The titles do not say that. Suggest one palette entry, with the Explorer entries keeping both names, or rename: "Compare Videos…" (palette) and "Compare / Play Together" (Explorer multi-select).
- **Medium** "Use Video Preview Enhanced for MP4/WebM" and "Use VS Code's Preview for MP4/WebM" are both always listed. After the automatic default, the first is a no-op and the second is the undo. Hiding the inapplicable one with a context key would remove the confusion; needs state exposure. **[D]** low priority.
- **Low** "Re-test ffmpeg" says nothing about GPU or what is measured; the notification explains. Maybe "Test ffmpeg GPU Decoding".
- **Low** Ellipsis is used for commands that open a picker, but "Play Image Sequence" (which opens a folder picker from the palette) has none, and "Copy ffmpeg Command for A–B" uses an en dash where docs use a hyphen "A-B" elsewhere (the title uses "A–B", the player says "A-B"). Pick one.

### 2.7 Context menus

- Explorer: **Open with Video Preview Enhanced** only on `.mp4`/`.webm` (hidden from the palette); **Play Image Sequence** on folders and image files; **Compare / Play Together** on multi-selection of videos; **Compare With…** on a single video. Note: `Compare With…` appears for every video format, so right-clicking an MKV offers it. Good.
- Player right-click: documented in `docs/keys.md` and `docs/notes/context-menu.md`; entries vanish from the palette by design. Needs VS Code 1.82 for `webview/context`. In older versions the menu would be missing without a message (engines is `^1.82.0`, so VS Code will not install on older ones: fine).
- Editor title: **Compare With…** button on the player tab. Icon-less text button? **Verify** whether the command has an icon (`icon` not set in the contributes list I read); a title-bar entry without an icon appears under the "..." overflow menu rather than as a button, so the "button" may be hidden. If so, document or add an icon.
- **Low** No Explorer entry for "Play Image Sequence" is labelled in a way that tells users what qualifies (folder with at least two numbered images); the warning message does say it ("needs at least two files like frame_0001.png").

### 2.8 Error messages and empty states

Host messages (src): all start with "Video Preview:" and are mostly plain. Examples read in the code: "Video Preview: open a video first, then load subtitles for it." (good), "Video Preview: the link names no file." (terse), "Video Preview: no ffmpeg found to test.", "Video Preview: ffmpeg download cancelled." In the player (`media/player.js`): "The decoder could not start.", "Frame N could not be decoded.".

Findings:

- **Medium** "The decoder could not start." followed by the raw error is the generic failure state for a broken or unsupported file. It does not say what to do next. The FAQ says "Run Video Preview: Show Log and include it in an issue", but the on-screen text does not link to it. Suggest a button in that message: **Show Log** (and a **Copy details** button reusing the ⓘ text). **[D]** wording and layout.
- **Medium** Some messages mix a prefix and none: the warnings about an overwrite or an export ("Export N frames as PNG? ...", "Overwrite N existing files?") have no "Video Preview:" prefix while others do. Users cannot tell which extension raised a modal. Pick a rule.
- **Medium** Zero-state: opening the player from the palette with no video open (`Load Subtitles…`, `Export Frames…`) is guarded by `when`, so users do not see them: good. For "Open Video URL…" with an invalid URL, **verify** the message.
- **Low** Frame links (`vscode://…`) that name a missing file show "Video Preview: this frame link is for ..." variants; the wording is reasonable.
- **Low** The Compare limit message prints the cap (4) and truncates silently otherwise. If the cap is raised, the message will need updating.
- **Positive** Setup errors include the host and, on proxy failures, an offer of the next option or a copyable link.

### 2.9 Compare entry points

Documented ways in (`docs/features.md`): key `D` in the player, Shift+drag from the Explorer, ⚙ > Tools > Compare, right-click picture > Compare With…, editor-title button, palette (two commands), Explorer multi-select. Seven routes is generous; the discoverability problems are:

- **Medium** Dropping a file onto the player works only while **Shift** is held (a VS Code limitation, documented). Plain drops are handled by VS Code (opens the file as a new tab). Without a hint in the UI this feels broken. A text hint while dragging cannot be shown (the page does not receive the event); the keys sheet and the README should say it. **[D]** whether to show a one-time tip after the first video opens ("Tip: press D to compare").
- **Medium** After entering compare the player tab is replaced (compare takes the player's place); "Leave compare" is in the Compare panel. Users who close the tab lose the single-video state. Documented; acceptable. **Verify** that Back in tab history restores.
- **Low** "Compare / Play Together" is a name for two ideas (compare quality, play several together in sync). Fine for a title, but the Explorer entry only shows up when two or more videos are selected, so a user with one file selected sees "Compare With…" and may not learn the multi-select route.

### 2.10 Remote, WSL, containers

- `docs/remote.md` is short and clear. Key facts: the extension runs where the files are, decoding is on the user's machine, WSL uses the Linux ffmpeg at up to 720p, SSH uses remote ffmpeg to stream heavy formats, `remoteStream` is a machine setting set on the remote.
- **Medium** What the user sees when something is degraded is not documented in one place: 360p floor notice, "remote stream failed, using the built-in decoder, which reads the whole file over the connection" (the exact warning is in `src/remotestream.js`; that text is a long sentence in a notification; consider two lines). No user doc says what notice to expect.
- **Medium** The ffmpeg first-run prompt is intentionally not shown in SSH and container windows (`docs/ffmpeg.md`). Instead a "remote ffmpeg download offer" exists for Linux x64/arm64 (CHANGELOG, `src/remoteff.js`). The README says "Optional FFmpeg on the SSH host can stream a lighter version" but not how the user finds it. **Verify** the offer's trigger, and add one sentence to `docs/remote.md` (it does not mention the offer).
- **Low** Dev containers and Codespaces are "expected to work, not tested", and vscode.dev is "not supported" (docs). Fine and honest; make sure the README does not imply otherwise ("locally, over Remote-SSH, or in WSL": it does not).

### 2.11 Documentation findability

- README ends with a one-line link list: formats, shortcuts, commands and settings, remote, ffmpeg, FAQ, all docs, contributing, licences. Those links are relative (`docs/keys.md`). On the Marketplace page, relative links resolve against the GitHub repo via the `repository` field, which works; **verify** once on the live page.
- `docs/` has 18 top-level files, mixing user pages (keys, formats, remote, ffmpeg, faq, urls, performance, features, comparison, commands-and-settings, privacy-and-security, licences) with contributor pages (PRODUCT, TESTING, RELEASING, REVIEW, private-context) and `notes/`. There is no `docs/README.md` index, so "all docs" lands on a directory listing. Suggest an index with a "Using it" and a "Working on it" section.
- **Medium** `docs/comparison.md` is stale: its table is headed "Video Preview Enhanced 0.6.1" with counts from 17 November, while the README table is dated 20 November and the current version is 0.7.2. The two tables disagree in scope (the README table compares three Marketplace leaders, the docs page compares different rivals). Pick one source or date both.
- **Medium** The FAQ has 9 entries; missing questions a new user will have: "How do I set up or remove ffmpeg?", "What does Don't remind me do and how do I undo it?", "How do I compare two videos?", "Why does my MP4 open here / how do I switch back?" (partly covered), "Why is a file's picture soft over SSH?", "Where are the keys?" (answered in the README quick start only as "press ?"). There is a typo: "Or or run **Set Up Optional ffmpeg**".
- **Low** `docs/keys.md` says "Shift+< / Shift+> (or [ / ])" for speed. `[`/`]` are also A-B keys in some other players; here A/B are letters, so no conflict.
- **Low** Docs say the build is "no telemetry" in the README and `privacy-and-security.md` is 820 bytes; fine. A user who sees a local frame server (127.0.0.1, token protected) in a firewall prompt on Windows could wonder; mention it in `privacy-and-security.md` (**verify** whether a Windows firewall prompt can appear for a loopback listener: normally it does not).

## 3. Accessibility notes seen in passing

The repository has `docs/notes/a11y.md` (not re-reviewed). From the key docs: icon buttons need accessible names; a slider for seek; a live region for state. Not tested tonight.

## 4. Contributor view (newcomer, first hour)

What works:

- `CONTRIBUTING.md` is complete and short: report, setup, tests, hooks, style, PR. `AGENTS.md` for agents; `docs/TESTING.md` explains the four layers; PR and issue templates exist; Code of Conduct and SECURITY.md are present.
- No build step, no runtime dependencies; F5 starts the Extension Development Host.
- CI: `.github/workflows/ci.yml` runs layers 1-2 on Linux and Windows, a syntax check, a `vsce package` dry run, gitleaks and the personal-data check; Dependabot configured.
- Layer 3 is Windows-only on a hidden desktop with a pinned VS Code; the README under `test/vscode/` is thorough.

Problems:

- **High** `npm test` is inconsistent: `package.json` runs `node test/run.js unit engine vscode` (layers 1-3, Windows only, needs GPU, Python and ffmpeg), AGENTS.md says "layers 1-3 (before a merge)", but CONTRIBUTING.md says `npm test  # layer 1-2 ...`. A newcomer who follows CONTRIBUTING on macOS/Linux gets failures or skips from layer 3. Suggest making `npm test` = `unit engine` and adding `npm run test:all`, or fixing the CONTRIBUTING line. **[D]** (the maintainer may prefer `npm test` to be the full pre-merge check).
- **Medium** Git LFS is required for test media. CONTRIBUTING says to install LFS before cloning; if forgotten, tests fail with pointer files. A test-setup check ("run `node test/run.js doctor`") that reports missing LFS, ffmpeg, Python would turn many first failures into one clear message. (Not verified whether such a check exists.)
- **Medium** Prerequisites list ffmpeg and ffprobe on PATH "for the tests", and Python 3 on Windows, but not which tests need them (unit tests do not). State per layer.
- **Medium** Newcomers cannot run layer 3 without Windows, which is where PR confidence comes from; the PR template asks what you ran. Say explicitly in CONTRIBUTING what to do instead on macOS/Linux (run layers 1-2, describe manual checks).
- **Low** The repository root holds five old `.vsix` files (0.4.0 to 0.7.0) next to the sources; they are ignored by git (`*.vsix` in `.vscodeignore` refers to packaging; check `.gitignore`), but they confuse a fresh checkout reader only if committed. **Verify** `.gitignore`.
- **Low** `review.cmd` is Windows-only and for humans; mentioned in both CONTRIBUTING and AGENTS.md. Fine.
- **Low** There is no "good first issue" label guidance, no architecture overview for contributors outside `docs/review/` and `AGENTS.md`'s repo map. The architecture review from 2026-11-21 recommends splitting several large files (`src/extension.js` 2,687 lines, `media/engine.js` 2,455 lines); a newcomer will hit those first. A short `docs/ARCHITECTURE.md` (a page, drawn from the review) would help; **[D]**.

## 5. Findings table

| # | Sev | Finding | Suggestion | Needs maintainer decision |
|---|---|---|---|---|
| 1 | High | `npm test` documented as layers 1-2 in CONTRIBUTING but is layers 1-3 in `package.json`/AGENTS.md | Make them agree; consider `npm test` = unit+engine | Yes: what `npm test` should mean |
| 2 | High | No first-run tour; shortcuts only via `?`; no palette entry for shortcuts or player settings | Add `Video Preview: Keyboard Shortcuts` and `Open Settings` commands; consider a `walkthroughs` contribution | Yes: tour yes/no and content |
| 3 | High | Keys cannot be rebound and are not in VS Code's keybinding UI | Document; optionally a keys setting | Yes: options in 2.4 |
| 4 | Medium | `advancedMode` setting obsolete but still listed and documented | Remove from contributes and docs table | No |
| 5 | Medium | `whenSlow` description refers to a status pill that no longer exists | Fix text (the notification switches it) | No |
| 6 | Medium | 19 settings in one flat list, performance internals beside everyday options | `order` plus `tags: ["advanced"]`, or sections | Yes |
| 7 | Medium | Three wordings for "stop asking" with different effects | One wording; FAQ entry on undo | Yes (copy) |
| 8 | Medium | Silent change of the user's `workbench.editorAssociations` for MP4/WebM | Options in 2.2 | Yes |
| 9 | Medium | No "Open Video File…", "Open to the Side", "New Window" for files | Add, reusing the URL variants | Yes |
| 10 | Medium | Two compare palette entries; MP4 default entries both always listed | Rename or merge; context-key the pair | Yes |
| 11 | Medium | Generic "decoder could not start" with no action | Add Show Log and Copy details buttons | Yes (UI wording and layout) |
| 12 | Medium | `docs/comparison.md` stale (0.6.1, 17 Nov) and differs from README table | Update or fold into README source | No |
| 13 | Medium | FAQ lacks ffmpeg, compare, remote-soft-picture entries; typo "Or or" | Add 4 entries, fix typo | No |
| 14 | Medium | Remote degradation notices and remote ffmpeg offer not described in docs | One paragraph in `docs/remote.md` | No |
| 15 | Medium | Compare Shift+drop and `D` hard to discover | One-time tip or hint in keys sheet and README | Yes |
| 16 | Medium | Fill (`F`) also changes zen mode | Say so in the shortcut sheet; consider separate key | Yes |
| 17 | Medium | Layout-dependent keys may be unusable on non-US layouts | Verify `event.key` vs `event.code`; document alternatives | No, then maybe |
| 18 | Medium | No docs index; "all docs" is a folder listing | `docs/README.md` with two sections | No |
| 19 | Medium | Contributor prerequisites not per layer; LFS failure is opaque | Per-layer table; a doctor check | No |
| 20 | Low | Palette title of ffmpeg setup is long and names formats | Shorten | Yes (copy) |
| 21 | Low | Loop default on | Keep or off | Yes |
| 22 | Low | "A–B" vs "A-B", ellipsis use inconsistent | Style rule | No |
| 23 | Low | README page has no image of compare, scopes or X-ray | Add two stills | Yes (what to show) |
| 24 | Low | Editor-title **Compare With…** may have no icon (appears in overflow) | Verify and add an icon | Yes |
| 25 | Low | Message prefix "Video Preview:" used on some notifications and not others | Rule | No |

## 6. What was not checked

No hands-on run: no screenshots, no first-run on a clean profile, no screen reader, no non-US keyboard, no Windows firewall check, no check of the live Marketplace page rendering. The items marked **verify** are the quickest to confirm with `review.cmd` on a clean profile.
