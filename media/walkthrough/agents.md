### Video links from AI coding tools

Skip this if you don't use an AI coding tool such as **Claude Code, Codex, Cursor or Copilot**. If you do: when it makes, converts or compares a video for you, it can give you a link like this. One click opens the video at that exact frame, or two videos side by side, in sync:

```text
vscode://gordon-vidal.video-preview-enhanced/open?frame=142&file=/abs/path/render.mp4
vscode://gordon-vidal.video-preview-enhanced/compare?frame=142&mode=split&file=/a.mp4&file=/b.mp4
```

**Two ways to tell it how:**

- **Copy instructions:** paste them into your project's `AGENTS.md`, `CLAUDE.md` or `.cursorrules`. Works with any AI tool.
- **Install with npx skills:** if you already use [npx skills](https://skills.sh) (needs Node.js), this opens a terminal with `npx skills add gordon-vidal/video-preview-enhanced -g` typed in. Press **Enter** to install it for all your projects.
