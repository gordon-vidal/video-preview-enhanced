---
name: video-preview-links
description: Print clickable vscode:// deep links that open a video at an exact frame, or several videos in a synced comparison, in the Video Preview Enhanced VS Code extension. Use whenever you render, transcode, or compare video files and want the user to inspect them.
---

# Video Preview deep links

Requires the VS Code extension `gordon-vidal.video-preview-enhanced`. Add a link after any video you produce.

## One video

```text
vscode://gordon-vidal.video-preview-enhanced/open?frame=<N>&file=<URL_ENCODED_ABS_PATH>
```

- `frame`: 1-based frame number, as the player shows it. Or use `t=<seconds>` (e.g. `t=4.73`).
- Both are optional; without them the video opens at the start.

## Compare 2+ videos in sync

```text
vscode://gordon-vidal.video-preview-enhanced/compare?frame=<N>&mode=split&file=<URL_ENCODED_ABS_PATH_A>&file=<URL_ENCODED_ABS_PATH_B>
```

- Repeat `file=` once per video.
- `frame` or `t`: optional shared start position.
- `mode`: `split` (2-video wipe), `grid` or `spotlight`.

## Where `vscode://` links work

- **VS Code integrated terminal, Markdown files (Markdown Preview), and external apps** (browser, Slack, Linear): `vscode://` links open directly in VS Code. Put each link on its own line in a terminal, or use Markdown `[label](link)` in `.md` files.
- **Chat sidebars that block `vscode://`** (such as some webview chat panels): don't print shell commands to work around it. Link directly to the video file or folder instead — or, for a multi-clip / frame-exact report, write a short `.md` file with the `vscode://` links so the user can click them in Markdown Preview.

## Rules

- Use absolute paths and URL-encode every one (spaces, `#`, `?`, `&`, Windows backslashes and colons), e.g. in Python `urllib.parse.quote(path, safe='')`.
- In a Remote-SSH or WSL workspace, use `uri=<URL_ENCODED_vscode-remote://...>` instead of `file=`.
- Only local or remote-host video files open; network shares, non-video files and `http(s)` URLs are refused.
