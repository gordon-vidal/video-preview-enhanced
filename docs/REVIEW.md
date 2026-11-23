# Reviewing a change by hand

`review.cmd` (Windows) or `review.sh` (macOS, Linux) opens a fresh, visible VS Code with the right
build of the extension installed and a folder of varied sample videos open. Both just run
`tools/review.js` (Node 20+, no dependencies), so `node tools/review.js` and `npm run review --` work
everywhere too. It works from any directory, by full path (`<repo>` is your clone):

```
<repo>/review.sh                     (main)               Windows: <repo>\review.cmd
<repo>/review.sh my-branch           (a branch)
<repo>/review.sh 91a3ce0             (a commit)
<repo>/review.sh /path/x.vsix        (a built package)
<repo>/review.sh                     in a terminal with no arguments: the menu below
```

It prints a summary (target, commit, version, VS Code version, profile path), waits until you close
the window, then deletes the temporary profile, worktree and folder.

What it does: resolves the target; builds the VSIX with `npx --yes @vscode/vsce package` from a
temporary detached worktree of that commit (the **committed** state; if another worktree has the
branch checked out and has uncommitted changes it tells you, and `--dirty` builds from that working
copy instead); starts the pinned portable VS Code (`test/vscode/.code/<version>`, fetched by
`get_code.js` when missing; Windows only, elsewhere the installed `code` is used) with a brand-new
`--user-data-dir` and `--extensions-dir` under the system temp folder as `vpe-review-<timestamp>` (so
none of your settings or extensions leak in, and your real VS Code profile is never touched), installs
the VSIX there, and opens `.../videos` with hard links to test clips grouped as `codecs`, `hdr`,
`containers`, `tracks-and-subtitles`, `subtitles` (a sidecar `.srt`) and `long-and-odd`, plus
`REVIEW.md`. Missing clips are skipped and listed. `VSCODE_*` and `ELECTRON_RUN_AS_NODE` are removed
from the environment first, so it also works from a VS Code terminal.

## The menu

With no arguments in a terminal, or with `--ui`, a small menu picks the options (`--ui` with other
flags starts with those selected). It prints the equivalent command at the bottom.

| Key | Does |
| --- | --- |
| Up / Down | move between rows |
| Left / Right, Space | change the row (on Target: next branch) |
| E, or Enter on Target | type a git ref or `.vsix` path (Enter accepts, Esc cancels) |
| Enter on `[ Launch ]` | start |
| D | dry run (print the plan, start nothing) |
| Q, Esc | quit |

Rows: Target, Mode (dev host or installed VSIX), Working copy (committed or dirty), VS Code (pinned
portable or installed), SSH / Link sim, Live transcode, FFmpeg (normal, hidden on PATH, none at all),
Keep temp profile.

## Flags

Both spellings work, in any case: `--dry-run` and `-DryRun`, `--no-ffmpeg-on-path` and `-NoFfmpegOnPath`.
`tools/review.ps1` still exists and forwards to `tools/review.js`.

| Flag | Meaning |
| --- | --- |
| `--dirty` | build from the worktree that has the branch checked out, uncommitted changes included |
| `--dev` | no packaging; `--extensionDevelopmentPath` (faster; title says Extension Development Host) |
| `--code <version>` | another portable VS Code version instead of the pinned one (Windows) |
| `--installed` | use your normally installed `code` (still with the fresh profile); the only choice off Windows |
| `--media <folder>` | open your own folder instead of the generated one |
| `--checklist <file.md>` | copy it into the folder as `REVIEW.md` and open it (for example one checklist per change) |
| `--link <preset>` | simulate a Remote-SSH link: `off`, `fast-ssh`, `typical-ssh`, `slow-ssh`, `flaky-ssh` or `remote` (below) |
| `--transcode <mode>` | `auto`, `always` or `off`: seeds `videoPreviewEnhanced.transcode` in the throwaway profile (default: not set) |
| `--ui` | open the menu |
| `--dry-run` | print every command and path; create and launch nothing |
| `--no-wait` | return once VS Code started; nothing is cleaned up |
| `--keep` | keep the temp profile, worktree and folder |
| `--no-ffmpeg-on-path` | hide ffmpeg on PATH only: the first-video popup appears, and "Set up ffmpeg" finds an installed copy in the usual places (winget, Chocolatey, Scoop, `C:\ffmpeg` ...) |
| `--no-ffmpeg` | no ffmpeg at all, as on a fresh PC: PATH hidden and the lookup in the usual places off, so "Set up ffmpeg" offers to download portable ffmpeg (it lands in the throwaway profile and is deleted afterwards) |
| `-h`, `--help` | usage |

### Simulated SSH link

`--link` sets environment variables for the launched VS Code (nothing else changes), shown in the
summary, in `--dry-run` as `ENV:` lines and in the generated `REVIEW.md`:

| Preset | Menu text | Environment |
| --- | --- | --- |
| `fast-ssh` | Fast SSH (25 Mbps, 15ms) | `VPE_SIMULATE_LINK=fast-ssh`, `VPE_SIMULATE_REMOTE=ssh-remote` |
| `typical-ssh` | Typical SSH (8 Mbps, 40ms) | `VPE_SIMULATE_LINK=typical-ssh`, `VPE_SIMULATE_REMOTE=ssh-remote` |
| `slow-ssh` | Slow SSH (2.5 Mbps, 80ms) | `VPE_SIMULATE_LINK=slow-ssh`, `VPE_SIMULATE_REMOTE=ssh-remote` |
| `flaky-ssh` | Flaky SSH (4 Mbps, 120ms + drops) | `VPE_SIMULATE_LINK=flaky-ssh`, `VPE_SIMULATE_REMOTE=ssh-remote` |
| `remote` | Remote-SSH (no throttle) | `VPE_SIMULATE_REMOTE=ssh-remote` |

The launcher only passes the variables on; the build under review has to read them.

The first package build needs network once for `npx` to fetch `@vscode/vsce` (later runs use the
npm cache). If it fails, the script says so; you can build a `.vsix` yourself and pass its path.
`test/host/review_test.js` checks the `--dry-run` output, the menu and the PowerShell wrapper.
