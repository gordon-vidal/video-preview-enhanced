# Deep links for AI coding agents & scripts

Video Preview Enhanced registers a VS Code URI handler so AI coding agents, terminal logs, test suites, and Markdown notes can output clickable links that jump directly to an exact frame or open a synchronized multi-video comparison.

## Link formats

### Open a single video at a frame or timestamp

```text
vscode://gordon-vidal.video-preview-enhanced/open?frame=142&file=/abs/path/render.mp4
vscode://gordon-vidal.video-preview-enhanced/open?t=4.73&file=/abs/path/render.mp4
```

- `frame` — 1-based frame number (as shown in the player).
- `t` — timestamp in seconds (`4.73`) or timecode (`1:02.5`).
- `file` — absolute local path (URL-encoded). Put `file=` last.
- `uri` — use instead of `file` for Remote-SSH or WSL files: `uri=vscode-remote%3A%2F%2Fssh-remote%2Bmyhost%2Fpath%2Frender.mp4`.

If the video is already open in VS Code, clicking the link reveals that tab and seeks to the requested frame.

### Compare two or more videos in sync

```text
vscode://gordon-vidal.video-preview-enhanced/compare?frame=142&mode=split&file=/abs/path/before.mp4&file=/abs/path/after.mp4
```

- Repeat `file=` (or `uri=` for remote files) for each video (2 up to `compare.maxVideos`, 8 by default, 16 max).
- `frame` and/or `t` — optional starting position on the shared timeline.
- `mode` (or `layout`) — optional layout: `grid` (side by side / equal grid), `spotlight`, or `split` (2-video wipe).

If a Compare panel with the exact same videos is already open, clicking the link reveals it and seeks (or switches layout) in place.

---

## Copy-paste prompt for AI coding agents

Drop this snippet into your `AGENTS.md`, `CLAUDE.md`, or `.cursorrules` so your agent automatically outputs clickable VS Code links whenever it renders videos, runs FFmpeg pipelines, or compares outputs:

````markdown
## Video inspection links (VS Code)

When you generate, transcode, or compare video files, include clickable `vscode://` links so I can inspect them directly in Video Preview Enhanced:

- Single video (optional `frame` is 1-based, `t` is seconds):
  `vscode://gordon-vidal.video-preview-enhanced/open?frame=<N>&file=<URL_ENCODED_ABS_PATH>`
- Synced comparison of 2+ videos (optional `frame`, `t`, `mode=split|grid|spotlight`):
  `vscode://gordon-vidal.video-preview-enhanced/compare?frame=<N>&mode=split&file=<URL_ENCODED_ABS_PATH_A>&file=<URL_ENCODED_ABS_PATH_B>`

URL-encode every path (spaces, `#`, `?`, `&`, and Windows backslashes/colons). In a Remote-SSH or WSL workspace, use `uri=<URL_ENCODED_vscode-remote://...>` instead of `file=`.
````

---

## Printing links from scripts & tests

In Python (for example, in a pytest failure message or a training / rendering script):

```python
from urllib.parse import quote

def vpe_compare_link(path_a, path_b, frame=1, mode="split"):
    return (
        "vscode://gordon-vidal.video-preview-enhanced/compare"
        f"?frame={frame}&mode={mode}&file={quote(str(path_a), safe='')}&file={quote(str(path_b), safe='')}"
    )
```

In VS Code's integrated terminal, `Ctrl+Click` (`Cmd+Click` on macOS) opens the link directly inside the current window.

## Security

Links only open video files on the local file system (or on the remote host the current VS Code window is connected to). Network shares (`\\server\share`), non-video files, and `http(s)` URLs are refused.
