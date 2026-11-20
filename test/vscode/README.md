# The extension in a real VS Code (hidden desktop): layers 3 and 4

```
node test/run.js vscode                             # layer 3: every scenario (docs/TESTING.md)
node test/run.js vscode --changed                   # the scenarios that cover your changes (scenario_map.js)
node test/vscode/scenarios.js --grep '^seeking$'    # one scenario; --list shows them
node test/vscode/scenarios.js --parallel 2          # instances side by side (see "Parallel" below)
node test/run.js perf                               # layer 4: start-up, CPU, memory, fps (test/perf/run.js)
node test/vscode/get_code.js                        # once: a pinned portable VS Code in test/vscode/.code
```

- **Portable VS Code:** with `test/vscode/.code/<PINNED>` present it is used, not the user's install (whose
  background updater makes new instances stall). `VPE_CODE=<Code.exe>` picks another one.
- Windows only. Needs Python 3 on PATH (standard library only), ffmpeg on PATH (reference frames, test clips,
  and the native-ffmpeg scenarios), no admin rights. Nothing appears on the screen.

## Scenarios (layer 3)

`scenarios.js` runs the scenarios of `scenario_list.js`. A scenario is one VS Code instance (fresh profile, own
hidden desktop) that runs several cases from `cases/` one after another, grouped by user journey. Before each
case the runner closes all editors and, through the extension's test hook, sets that case's settings
(`settings` hook), the extension host's environment (`env` hook: the `VPE_*` test switches, PATH with or
without ffmpeg) and clears the stored state (`resetState`), so every case starts as on a fresh profile. A
step's `only` / `skip` (regex on the case's result names) leave out results that live in layer 2 or 4
(`lib.setFilter`: they are not run at all). Results are named `<scenario>/<case>/<result>`; the JSON goes to
`out/scenarios-<time>.json`.

Correctness only: no case judges fps or how long something takes. Waits are generous and end as soon as the
condition holds; a page error (uncaught error, unhandled rejection) ends a wait at once (`lib.pageError`), and
a page without WebGL2 ends every wait of that instance at once (`hidden.js`). Such an instance is broken, not
failing: its VS Code logs go to `out/nogl-*`, and the scenario runs once more in a fresh instance (its
results say `retried`); twice in a row is a failure.

| Scenario | Cases | Journey | Time, results |
|---|---|---|---|
| `open-formats` | open-formats | A user without ffmpeg opens each kind of file: the right decoder (GPU for H.264 / VP8 in every container, WebAssembly for the rest), it plays, a paused seek lands | 146 s, 15 |
| `playback` | playback | Opening every container and codec, sound-only files, speed, next / previous file, rotation, resume, damaged and cut files, multichannel sound | 167 s, 31 |
| `autoplay-loop` | playback_autoplay, playback_loop, short_loop | Autoplay and loop: a file starting at PTS 3600, sound longer than the picture, a sound-only loop, short loops replayed from memory | 62 s, 6 |
| `seeking` | seeking | Frame stepping, seeking, the ends of a file and the A-B loop on the GPU decoder, the frame player and the WebGL picture | 176 s, 12 |
| `inspect` | inspect, keyconflicts | Go to frame / time, pixel inspector, zoom, stats, frame links, HDR tone mapping, seek-bar thumbnails, X-ray; VS Code keybindings that collide with the player keys | 94 s, 15 |
| `scopes-export` | scopes_export | Waveform, parade, vectorscope and histogram; A-B frame export and Save Frame | 77 s, 11 |
| `subtitles` | subtitles | Picture subtitles (PGS, DVD, DVB) and embedded text subtitles with sound-track switching | 59 s, 4 |
| `ui` | ui, ui_jumps, ui_jumps_settings, ui_info, ctxmenu | The bar and panels: accessibility, keys, panels, speed, time formats, jump sizes (panel and settings), About this video, the context menu | 132 s, 21 |
| `compare` | modes, compare_ui, compare_metrics | Compare mode: entering and leaving, the bar, tiles, views, the Tools grid, PSNR / SSIM against ffmpeg | 90 s, 17 |
| `multiview` | multiview, multiview-short-loop | Play together: grids of 2-4, lockstep, offsets, the sync clock and sound, a short loop | 68 s, 11 |
| `multiview-native` | multiview-native, multiview-native-fallback | Play together with native ffmpeg: tile sizes, the frame server and its budget, resizing, the message fallback | 38 s, 7 |
| `native` | open-native, native-transfer, native-transfer-resize, native-transfer-fallback, ui_info_native | With ffmpeg: native decoding plays, frames sized to the picture and grown on resize / zoom, the message fallback, About this video | 102 s, 6 |
| `invisible` | perf-invisible | Work a user never notices: a hidden native tab stops ffmpeg, paused players read only about 1 s ahead, the frame loop rests while paused | 83 s, 4 |
| `restore` | perf-invisible, startup-restore | A window reload restores the player tabs; a background tab doesn't decode until it is shown | 102 s, 2 |
| `seek-preview` | seek_preview, seek_preview_native | The seek-bar picture: hover, drag, release on the exact frame (WebAssembly and native) | 73 s, 2 |
| `hdr` | hdr_output, hdr_output_forced, hdr_output_forced_native | HDR output: the display probe, tone mapping on SDR, Dolby Vision, PQ / HLG on an HDR canvas (built-in and native 10-bit) | 95 s, 15 |
| `onboarding` | onboarding-ffmpeg, onboarding | First video: the ffmpeg recommendation once (none with ffmpeg), the reminder for a slow 4K file, the decoder rule | 30 s, 5 |
| `url` | url_stream | Open Video URL: MP4, HLS (TS, fMP4, AES, qualities, subtitles), DRM and web pages refused, DASH and live need ffmpeg | 111 s, 14 |
| `url-native` | url_stream_native, url_stream_native_mp4 | Open Video URL with ffmpeg: HLS, DASH, live, HEVC MP4 natively; H.264 MP4 stays on the GPU | 97 s, 9 |
| `remote-stream` | remote_stream, remote_stream_long, remote_stream_fallback | Remote windows: formats the GPU decoder can't play are re-encoded to H.264 by ffmpeg; seeks, scrubbing, the quality ladder, pixel tools | 139 s, 11 |
| `file-icons` | file_icons, file_icons_pixels_dark-100, file_icons_pixels_light-100, file_icons_pixels_dark-120, file_icons_pixels_dark-m1, file_icons_pixels_dark-z2 | Explorer icons for the formats VS Code has none for, as Seti draws .mp4 / .avi (dark, light, zoom -1..2); .mkv still opens in the player | 46 s, 7 |

Times and result counts: the full run of 2026-11-20 (3 instances at once, while other processes used about 40 % of the CPU and a game the GPU; `docs/TESTING.md` has the totals).

**--changed:** `scenario_map.js` picks the scenarios whose `sources` (in `scenario_list.js`) contain a changed
file, or that run a changed case file. A changed file under `src/` or `media/` that no scenario names, or the
layer-3 machinery itself (`scenarios.js`, `lib.js`, `hidden.js`, ...), runs every scenario.

**Parallel:** `--parallel N` (or `VPE_PARALLEL`) runs N instances at once, each with its own profile and
hidden desktop. The default is **1** (serial): a full run with 3 instances (2026-11-20, under load from a
game: 12.7 min instead of about 33 serial) had 2 of 21 scenarios start in an instance without WebGL2 (both passed
in their fresh instance), and the rule is to keep parallel only after a full run with none. The cause is open: a
single instance lost WebGL2 the same day too (1 of 2 scenarios), so the game's GPU use may be the cause rather
than parallel instances. Measure again on an idle machine (`node test/run.js vscode --parallel 3`); with no
WebGL2 losses, make 3 the default (`VPE_PARALLEL`, or the default in `scenarios.js`).

### Writing a case

A module in `cases/<name>.js` exports `{ name, settings?, env?, ffmpeg?, run: async (vs, h) => [{ name, ok,
problems }] }` (or an array of them); add it as a step to a scenario in `scenario_list.js` (and its sources).
`ffmpeg: true` gives the extension native ffmpeg (`videoPreviewEnhanced.ffmpegPath` and PATH); otherwise the
extension has none. `h` has `MEDIA, sleep, fwd, esc, openClip, closeClip, playClip, seconds, quick, ffmpeg,
scenario` (`h.scenario` is set in layer 3, unset in layer 4: measure only when it is unset); `vs` has
`send(json)` (test hook commands, below), `mark()`, `lines`, `waitLog(re, { from, timeout })` and `cli(args)`.
`lib.js` has the player handle: `lib.open(vs, h, lib.clip('s_h264.mp4'))`, `P.state()`, `P.seek(t)`,
`P.expectFrame(k)` (the player says k and the picture is ffmpeg's frame k: `test/lib/frames.js`), `P.waitState`.
Record results with `lib.recorder()` (`R.run(name, fn)`) so a scenario can leave some out. Clips come from
`test/media/make_cases_media.js` (into `test/media/cases/`). A case leaves no editor open and doesn't rely on
state another case left (the runner resets settings and stored state, not the files a case writes).

**Hooks the cases use** (test only, VPE_LOG set): `{name, action}` lines in `<VPE_LOG>.cmd` go to the player as
debug messages: `seek step pause play rate key report wcprobe tool panel modesReport scrub`, for compare `mode key
offset clock sound step play pause seek sync report`, and the probes in `debugProbe` (media/player.js): `state`
(toast, pill, message, canvas, tracks, subtitle overlay, scopes, thumbnail, X-ray ... as one JSON line), `thumb`
(the picture as 64x36 luma), `pixels`, `scopesDump`, `dom` (mouse / pointer / wheel event at a point), `hdrcaps`,
`hdrpixels`, `gotoText`, `track`, `click`. `key` takes `ctrl` and a `target` selector. In the extension
(src/extension.js): allowed `command`s, `ctxCommand`, `openUrl`, `compareFiles` / `compareAdd` / `compareReplace` /
`compareWith`, `tabs`, and for the scenarios `settings` / `env` / `resetState` (each answers `debug done <id>`).
`VPE_EXPORT_DIR` and `VPE_SAVE_DIR` replace the folder and save dialogs of frame export and save frame;
`VPE_TOTALMEM=<bytes>` sizes the decoder pool and frame caches as for a machine with that much memory;
`VPE_HDR_FORCE=1` takes the HDR output path on an SDR display; `VPE_NATIVE_TRANSPORT=fail` refuses the frame
server; `VPE_RS_ENCODER` picks the remote-stream encoder. Nothing here runs without VPE_LOG.

## Performance (layer 4)

`test/perf/run.js` runs the benches of `test/perf/benches.js`: VS Code benches are scenarios run with the full
measurements (`h.scenario` unset), each in a fresh instance (start-up per decoder path, memory, play fps, loop fps,
native transfer, the invisible optimisations, cpu-4k per ffmpeg method, remote-stream soak, transfer benches);
Node benches are the decode-route benchmark, the thumbnail worker and the ffmpeg probe. Every number is printed
with its change against the previous result of the same bench on the same machine (`test/perf/results/`);
worse by more than 50 % is flagged GROSS. The run holds the benchmark lock of `test/benchq.js`, so nothing else
measures meanwhile, and `test/run.js` waits for it before layers 2 and 3. Run it on a quiet machine: a bench
started while other processes use more than 25 % CPU is marked "under load" and not counted.

## Tools

- `activation.js`: how a file passed when VS Code starts opens (below).
- `remote_ssh.js`: the remote-stream cases against a real SSH host.
- `screenshot.js`, `capture_window.py`: window captures (the file-icon cases use them).
- `review.cmd [branch|commit|file.vsix]` (repo root) opens a fresh visible VS Code with the change installed:
  see [docs/REVIEW.md](../../docs/REVIEW.md).

## How it works

- `hidden_launch.py` creates a Windows desktop (`CreateDesktopW`, same session, no admin) and starts
  a program on it (`STARTUPINFO.lpDesktop = "WinSta0\<name>"`) with an environment from a JSON file
  (`null` removes a variable). Windows on that desktop are never shown, and every child process
  stays on it. Desktops are per session and vanish when their last process exits.
- `hidden.js` makes a temporary profile (`--user-data-dir`, `--extensions-dir`, quiet settings,
  `.mp4`/`.webm` associated with the extension's editor), starts `Code.exe` on the hidden desktop
  with this checkout as `--extensionDevelopmentPath` and `VPE_LOG` set, and removes the
  `VSCODE_*` / `ELECTRON_RUN_AS_NODE` variables an agent inside VS Code inherits (with
  `ELECTRON_RUN_AS_NODE=1`, Code.exe runs as plain Node; with `VSCODE_IPC_HOOK_CLI`, the CLI talks
  to the parent VS Code).
- Files are opened with VS Code's CLI (`Code.exe <cli.js> --reuse-window <file>`), also started on
  the hidden desktop: if it found no running instance, the one it starts is hidden too.
- The extension's test hook (only with `VPE_LOG`) reads JSON lines appended to `<VPE_LOG>.cmd` once
  it has logged `activated:`. Everything the extension and its webviews log lands in `VPE_LOG`, which
  the runner tails.
- Cleanup always runs: `taskkill /T /F` on the VS Code tree, then any `Code.exe` still using the
  profile, then the profile is deleted (`--keep` keeps it).

## Files on the first command line (activation)

`node test/vscode/activation.js` checks how a file passed when VS Code starts opens. Result on VS Code 1.146:

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
