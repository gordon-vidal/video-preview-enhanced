# The extension in a real VS Code (hidden desktop)

```
node test/vscode/run.js [--ffmpeg <ffmpeg.exe>] [--grep re] [--seconds N] [--keep] [--json file]
node test/vscode/run.js --activation
node test/benchq.js node test/vscode/run.js      # when the fps numbers should be comparable
```

```
node test/vscode/get_code.js                     # once: a pinned portable VS Code in test/vscode/.code (used by default)
node test/vscode/run.js --quick                  # ~1 min functional check; several may run at once
node test/vscode/run.js --grep '^case/mymode'    # only your cases
```

- **Portable VS Code:** with `test/vscode/.code/<PINNED>` present the runner uses it, not the user's
  install (whose background updater makes new instances stall). `--installed` uses the install.
- **Levels:** `--quick` plays 2 clips plus 1 native clip for 2 s each, then the cases; fps is
  recorded but not judged. Full runs (no flag) are the speed numbers: run them one at a time through
  `node test/benchq.js node test/vscode/run.js`.
- **Cases:** put a module in `test/vscode/cases/<name>.js` exporting
  `{ name, settings?, env?, ffmpeg?, run: async (vs, h) => [{ name, ok, problems }] }` (or an array of
  them). Each case gets
  its own fresh instance (settings merged into the profile; ffmpeg on PATH only with `ffmpeg: true`).
  `h` has `MEDIA, sleep, fwd, esc, openClip, closeClip, playClip, seconds, quick, ffmpeg`; `vs` has
  `send(json)` (test hook commands, see below), `mark()`, `lines`, `waitLog(re, { from, timeout })`
  and `cli(args)`. Results are named `case/<name>/<result name>`.

## Cases (test/vscode/cases/)

| Case | What it checks |
|---|---|
| `seeking` | frame stepping, seeks (also while playing), ms-rounded and NTSC time stamps, End / past the end, EOF flush, A-B loop; the picture is compared with ffmpeg's decode of the same file, one clip per decode path (H.264, HEVC, VP9, MPEG-2, ProRes, MPEG-4 AVI, MJPEG frame player) |
| `playback`, `playback_autoplay`, `playback_loop` | 18 codec/container clips open and play, audio-only, speed 0.5-2x, Shift+N / Shift+P, rotation, the "Fully decoded" status, resume position, damaged H.264, cut files, TrueHD 5.1 / 7.1 sound, a start at PTS 3600, sound longer than the picture, sound-only loop |
| `subtitles` | PGS / DVD / DVB picture subtitles (CC menu, seeks, zoom, playing) and embedded SRT / ASS with sound-track switching |
| `scopes_export` | waveform / parade / vectorscope / histogram on colour bars, A-B PNG export (names, right frames, gapped video, hidden player), save frame |
| `inspect` | go to frame / time, pixel inspector vs ffmpeg, zoom and pan, stats, `vscode://` frame links, HDR tone mapping vs ffmpeg, seek-bar thumbnails, X-ray |
| `seek_preview`, `seek_preview_native` | background thumbnail strip, hover picture at once, thumbnail and main picture during a synthetic drag, exact frame on release, seek and step after (WebAssembly MPEG-2 and native HEVC; docs/notes/seek-preview.md) |
| `compare_metrics` | PSNR / SSIM of two videos vs ffmpeg's filters, offsets |
| `startup` | start-up time per decoder path (GPU, WebAssembly, native), cold and warm, split into phases from the `startup host` / `webview: startup` log lines; webview and extension-host memory for 4K HEVC 10-bit, also as an 8 GB machine (`VPE_TOTALMEM`); numbers only, `docs/notes/startup-memory.md` |
| `file_icons` | `.mkv` still opens in the player with `videoPreviewEnhanced.overrideFileIcons` on, and the extension wrote `*.mkv` / `*.flv` / `*.m2ts` -> `vpe-video` (never `.ts`, `.mts`) to the user's `files.associations` |
| `file_icons_pixels` | Explorer rows of `.mkv` / `.flv` / `.m2ts` against Seti's own `.mp4` / `.avi` icon (a font glyph at font-size 150 % in a 16x22 box): the window is captured (PrintWindow), the icons found by colour and compared (size, position, ink mass and centre; pixel mean at the display scale), dark and light, window zoom -1 / 0 / 1 / 2; enlarged side-by-side crops go to `VPE_ICON_OUT`. The font has ClearType fringes, the SVG grayscale edges, so not byte-equal |
| `ui`, `ui_jumps`, `ui_jumps_settings`, `ui_info`, `ui_info_native` | the player's bar and panels (docs/notes/ui-simple.md): a11y names and states, picture click, panel toggling, CC without subtitles, speed step and clamp, time formats, jump sizes from the panel and from settings, About this video for a WebAssembly and a native file |
| `keyconflicts` | VS Code's default keybindings for the player's keys (which ones VS Code would also run) |
| `hdr_output`, `hdr_output_forced`, `hdr_output_forced_native` | HDR output (docs/notes/hdr-output.md): the page's HDR probe (`hdrcaps`), tone mapping kept on an SDR display, Dolby Vision 8.1 / 8.4 / 5 files (test/zoo/make_dv.js), and with `VPE_HDR_FORCE=1` the PQ / HLG pattern values on the extended-range WebGPU canvas (`hdrpixels`), built-in and native 10-bit |
| `cpu_4k` | only with `VPE_CPU_BENCH=1`: CPU per process (ffmpeg, extension host, network service, renderers, GPU process) while 4K HEVC 10-bit plays natively, per method (`VPE_CPU_VARIANTS`; `docs/notes/cpu-4k.md`). Hooks: `VPE_NATIVE_METHOD` holds ffmpeg's method, `VPE_THUMB_STRIP=0` leaves out the thumbnail strip; the player's `stageSize` debug action sets the picture area |
| `modes`, `multiview`, `onboarding`, `remote_stream` | see the files (`modes`: the one-layout bar and Tools grid, and compare's views) |

`--only <re>` is `--grep`; `--sub <re>` runs only the results of a case whose name matches (`--only '^case/seeking' --sub 'step/s_h264'`).
The cases make their own clips with ffmpeg (`test/media/make_cases_media.js`, into `test/media/cases/`) and need ffmpeg on PATH
for reference frames; without it they skip. Run them one instance at a time when many are started together: with
four VS Code instances rendering at once a webview can fail with "WebGL2 is not available".
That also happens now and then in a single full run (an instance whose GPU process gives no WebGL2, on a random
case): the runner then keeps that instance's logs in `out/nogl-*`, runs the case once more in a fresh instance
and marks its results `retried`. A player that never got a first frame fails with the page's message
(`waitFirstFrame`, unless `allowError`), not later with "player says -1".

**Hooks the cases use** (test only, VPE_LOG set): `{name, action}` lines in `<VPE_LOG>.cmd` go to the player as debug messages.
Existing: `seek step pause play rate key report wcprobe tool panel modesReport scrub` and for compare `mode key offset clock sound
step play pause seek sync report`. Added for the migration (observation, or the user's input as DOM events, in
`debugProbe` in media/player.js): `state` (toast, pill, message, canvas, tracks, subtitle overlay, scopes, thumbnail, X-ray ...
as one JSON line), `thumb` (the picture as 64x36 luma, for matching against ffmpeg), `pixels` (WebGL pixels), `scopesDump`,
`dom` (mouse / pointer / wheel event at a point), `hdrcaps` (HDR probe), `hdrpixels` (HDR output state and values), `gotoText` (Ctrl+G, text, Enter), `track` (select a subtitle / sound track),
`click` (an element by selector and text; the CC menu). `key` takes `ctrl` and a `target` selector. In the extension:
`VPE_EXPORT_DIR` and `VPE_SAVE_DIR` replace the folder and save dialogs of frame export and save frame, and
`videoPreviewEnhanced.exportRange` may be run by the hook. `VPE_TOTALMEM=<bytes>` sizes the decoder pool and frame
caches as for a machine with that much memory (`media/membudget.js`). Nothing here runs without VPE_LOG.

Windows only. Needs VS Code installed (or `--code <Code.exe>` / `VPE_CODE`), Python 3 on PATH
(standard library only) and no admin rights. Nothing appears on the screen.

## Host and engine unit tests

Run `node test/host/run_all.js` from the repo root with ffmpeg and ffprobe on PATH.
On Windows it uses Python 3 on PATH to put each test and its subprocesses in a job object.
It runs each host test and `test/engine/unit.js` in its own process with a 60-second timeout.
A timeout or failed test makes the command exit nonzero after running the remaining tests.
`avi_scan_test.js` is skipped because it needs AVI file arguments.

## Reviewing by hand

`review.cmd [branch|commit|file.vsix]` opens a fresh visible VS Code (the pinned portable build from `get_code.js`, a throwaway profile) with the change installed and a folder of sample videos: see [docs/REVIEW.md](../../docs/REVIEW.md).

## How it works

- `hidden_launch.py` creates a Windows desktop (`CreateDesktopW`, same session, no admin) and starts
  a program on it (`STARTUPINFO.lpDesktop = "WinSta0\<name>"`) with an environment from a JSON file
  (`null` removes a variable). Windows on that desktop are never shown, and every child process
  stays on it. Desktops are per session and vanish when their last process exits.
- `run.js` makes a temporary profile (`--user-data-dir`, `--extensions-dir`, quiet settings,
  `.mp4`/`.webm` associated with the extension's editor), starts `Code.exe` on the hidden desktop
  with this checkout as `--extensionDevelopmentPath` and `VPE_LOG` set, and removes the
  `VSCODE_*` / `ELECTRON_RUN_AS_NODE` variables an agent inside VS Code inherits (with
  `ELECTRON_RUN_AS_NODE=1`, Code.exe runs as plain Node; with `VSCODE_IPC_HOOK_CLI`, the CLI talks
  to the parent VS Code).
- Files are opened with VS Code's CLI (`Code.exe <cli.js> --reuse-window <file>`), also started on
  the hidden desktop: if it found no running instance, the one it starts is hidden too.
- The extension's test hook (only with `VPE_LOG`) reads JSON lines appended to `<VPE_LOG>.cmd`:
  `{"action":"wcprobe"|"report"|"seek"|"pause",...,"name":<file name>}` go to the players,
  `{"command":"videoPreviewEnhanced.openWith","arg":<file>}` and a few closing commands run.
  Everything the extension and its webviews log lands in `VPE_LOG`, which `run.js` tails.
- Cleanup always runs: `taskkill /T /F` on the VS Code tree, then any `Code.exe` still using the
  profile, then the profile is deleted (`--keep` keeps it).

## The suite (2-4 min)

| Test | Checks |
|---|---|
| `wcprobe` | WebCodecs / AudioDecoder / `<video>` support in the webview page and a worker. H.264 and VP8 must be there; the rest is recorded. |
| `play/<clip>` | test/media clips: opened, first frame, the expected decoder path (WebCodecs or WebAssembly), playing, `shownFps` from the 2 s status lines over `--seconds` (first window skipped), and a paused seek spot check (two frames, polled up to 10 s). |
| `native/<clip>` | a second VS Code with `videoPreviewEnhanced.ffmpegPath` set: the logged decision must be native ffmpeg, and the picture plays. Skipped without ffmpeg (`--ffmpeg`, `VPE_FFMPEG`, PATH). |

The CPU load of other processes is sampled before each clip (`test/loadmon.js`); rows taken while
it is high are marked noisy. Results are printed and written to `test/vscode/out/run-*.json`.
The seek spot check stays within the clip (the ProRes one has 24 frames; the player's report line
gives the frame count). A clip entry can carry `known: { re, why }` to report matching problems as
known instead of failures; none does now.

## Files on the first command line (activation)

`--activation` checks how a file passed when VS Code starts opens. Result on VS Code 1.146:

| Start | Opens in the extension? |
|---|---|
| Fresh profile, file on the first command line (dev path or installed copy) | No: VS Code's default (binary) editor |
| Same window, the file forwarded afterwards with the CLI | Yes |
| The same profile restarted with a file on the command line | Yes |
| Fresh profile with `workbench.editorAssociations` for the type | Yes |

Not an extension bug (the custom editors are contributed correctly; `onCustomEditor` activation is
implied). VS Code's editor resolver only waits for extensions to register when the file matches its
cached list of extension editors (`editorOverrideService.cache`, saved with the profile's state) or
a user association. A fresh profile has neither, so a file opened during startup is resolved before
the extension's editors exist. Users only meet this on the very first start after a profile is
created; the runner starts VS Code first and forwards files, and its profile has associations.
