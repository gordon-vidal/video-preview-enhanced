# Reviewing a change by hand

`review.cmd` opens a fresh, visible VS Code with the right build of the extension installed and a
folder of varied sample videos open. Windows only (PowerShell). It works from any directory, by
full path (`<repo>` is your clone):

```
<repo>\review.cmd                    (main)
<repo>\review.cmd my-branch          (a branch)
<repo>\review.cmd 91a3ce0            (a commit)
<repo>\review.cmd C:\path\x.vsix     (a built package)
```

It prints a summary (target, commit, version, VS Code version, profile path), waits until you close
the window, then deletes the temporary profile, worktree and folder.

What it does: resolves the target; builds the VSIX with `npx --yes @vscode/vsce package` from a
temporary detached worktree of that commit (the **committed** state; if another worktree has the
branch checked out and has uncommitted changes it tells you, and `-Dirty` builds from that working
copy instead); starts the pinned portable VS Code (`test/vscode/.code/<version>`, fetched by
`get_code.js` when missing) with a brand-new `--user-data-dir` and `--extensions-dir` under
`%TEMP%\vpe-review-<timestamp>` (so none of your settings or extensions leak in, and your real
`%APPDATA%\Code` is never touched), installs the VSIX there, and opens `...\videos` with hard links
to test clips grouped as `codecs`, `hdr`, `containers`, `tracks-and-subtitles`, `subtitles` (a
sidecar `.srt`) and `long-and-odd`, plus `REVIEW.md`. Missing clips are skipped and listed.

## Flags

| Flag | Meaning |
| --- | --- |
| `-Dirty` | build from the worktree that has the branch checked out, uncommitted changes included |
| `-Dev` | no packaging; `--extensionDevelopmentPath` (faster; title says Extension Development Host) |
| `-Code <version>` | another portable VS Code version instead of the pinned one |
| `-Installed` | use your normally installed `code` (still with the fresh profile) |
| `-Media <folder>` | open your own folder instead of the generated one |
| `-Checklist <file.md>` | copy it into the folder as `REVIEW.md` and open it (for example one checklist per change) |
| `-DryRun` | print every command and path; create and launch nothing |
| `-NoWait` | return once VS Code started; nothing is cleaned up |
| `-Keep` | keep the temp profile, worktree and folder |
| `-NoFfmpegOnPath` | hide ffmpeg on PATH only: the first-video popup appears, and "Set up ffmpeg" finds an installed copy in the usual places (winget, Chocolatey, Scoop, `C:\ffmpeg` ...) |
| `-NoFfmpeg` | no ffmpeg at all, as on a fresh PC: PATH hidden and the lookup in the usual places off, so "Set up ffmpeg" offers to download portable ffmpeg (it lands in the throwaway profile and is deleted afterwards) |

The first package build needs network once for `npx` to fetch `@vscode/vsce` (later runs use the
npm cache). If it fails, the script says so; you can build a `.vsix` yourself and pass its path.
`test/host/review_test.js` checks the `-DryRun` output.
