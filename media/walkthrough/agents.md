### Video links from AI coding tools

Skip this if you don't use an AI coding tool such as **Claude Code, Codex, Cursor or Copilot**. If you do: when it makes, converts or compares a video for you, it can give you a clickable link that opens the video at an exact frame, or two videos side by side, in sync.

**What Copy instructions puts on your clipboard** (paste into your project's `AGENTS.md`, `CLAUDE.md` or `.cursorrules`):

````markdown
## Video inspection links (VS Code)

When you generate, transcode, or compare video files, include clickable `vscode://` links so I can inspect them directly in Video Preview Enhanced:

- Single video (optional `frame` is 1-based, `t` is seconds):
  `vscode://gordon-vidal.video-preview-enhanced/open?frame=<N>&file=<URL_ENCODED_ABS_PATH>`
- Synced comparison of 2+ videos (optional `frame`, `t`, `mode=split|grid|spotlight`):
  `vscode://gordon-vidal.video-preview-enhanced/compare?frame=<N>&mode=split&file=<URL_ENCODED_ABS_PATH_A>&file=<URL_ENCODED_ABS_PATH_B>`

URL-encode every path (spaces, `#`, `?`, `&`, and Windows backslashes/colons). In a Remote-SSH or WSL workspace, use `uri=<URL_ENCODED_vscode-remote://...>` instead of `file=`.

Use `vscode://` links in terminals, Markdown reports (Markdown Preview), and external apps. If a chat panel blocks `vscode://`, link directly to the video file or folder instead.
````

**Or install with npx skills:** if you already use [npx skills](https://skills.sh) (needs Node.js), this opens a terminal with `npx skills add gordon-vidal/video-preview-enhanced --skill video-preview-links -g` typed in. Press **Enter** to install it for all your projects.
