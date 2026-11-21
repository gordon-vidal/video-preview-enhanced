# Remote stream: ffmpeg on the SSH host, H.264 to the panel (track E, 2026-11-19)

Finished (2026-11-19, second pass; see "Finishing" below). Setting `videoPreviewEnhanced.remoteStream`
(package.json, `"scope": "machine"`, so it lives in the remote's settings and a workspace can't set it):

- `auto` (default): only in a remote window (`vscode.env.remoteName`: SSH, WSL, containers, tunnels,
  Codespaces), only for a file VS Code's GPU decoder can't play (`wanted()`: not 8-bit 4:2:0 H.264,
  not VP8), and only when native ffmpeg doesn't take it there: `open()` runs the decoder rule first
  (`src/decide.js`), so WSL with ffmpeg keeps native ffmpeg (raw frames are fine on WSL's link) and
  streams only if native isn't chosen; SSH/containers never get native, so they stream.
- `off`: never (remote windows use the built-in decoder). `on`: any window, before native (tests).
- Always on top: `decoder: builtin`, the failed-file list, pixel tools (`fullRes`), Restricted Mode
  and a stream that failed in this tab (`noRemoteStream`) keep the built-in decoder.
- No ffmpeg on the remote (`ffmpegPath` in the remote's settings, or PATH): built-in, silently.

**Result: it works in real VS Code over Remote-SSH.** 4K HEVC 10-bit goes from 7.5 fps (built-in WebAssembly decoder, today) to 29 fps of a 30 fps clip, at 4–5 Mb/s on the wire.

## How it fits

- **Where things run.** In a Remote-SSH window the extension host (with `extensionKind: workspace`,
  ours) runs on the remote machine; the webview runs in the local renderer. Every
  `webview.postMessage` from `src/extension.js` crosses the SSH tunnel. That's why `src/decide.js`
  keeps SSH windows on the built-in decoder: native ffmpeg (`src/native.js`) posts raw YUV
  (`ndv` messages) from the extension host, 1920×1080×1.5×30 = **93 MB/s = 746 Mb/s** at 1080p30.
- **The stream.** `src/remotestream.js` (`RemoteStream`) runs ffmpeg on the remote: decode with
  whatever it has → `scale` to `nativeMaxHeight` (1080 default) → `format=yuv420p` → H.264 →
  `-bsf:v h264_metadata=aud=insert -f h264 pipe:1` (Annex B with an AUD before every frame). The host
  cuts access units at the AUDs; a packet is a key packet when it holds an IDR slice (NAL type 5).
  SPS/PPS come in-band before every IDR (raw `h264` output has no global header).
- **The webview needs no new decoder path.** `RemoteStream` speaks `media/decoder-worker.js`'s
  protocol (`streams` → `config`/`configured` → `more` → `batch` of `{kind:'packet', t, key, data}`,
  `seek` → `seeked`). `streams` announces `codec: 'h264'` with no extradata, so `media/engine.js`
  builds its Annex B `avc1.64xxxx` config and decodes with its existing WebCodecs VideoDecoder.
  The engine sets `nativeLossy` so pixel tools offer the exact decoder.
  The extension's `tryRemoteStream()` reuses the
  `this.native` slot, so `useFullRes` (pixel tools → built-in decoder) and dispose work unchanged.
- **Sound.** Not re-encoded: float PCM 48 kHz stereo as `pcm` batch items (3.1 Mb/s; s16 would be
  1.5, FLAC ~1). If it ever needs to be smaller: mp3 or FLAC (VS Code webviews decode those with
  AudioDecoder); **not AAC or Opus**, which VS Code webviews can't decode.
- **Timestamps / A/V sync.** Raw H.264 carries no timestamps, so ffmpeg is made to emit both
  outputs *on* the stream's timestamps from the output's zero (the seek target): `-fps_mode cfr
  -r <fps>` (`-vsync cfr` before ffmpeg 5.1) duplicates/drops frames to the video timestamps (a
  picture that starts late is filled from 0), and `aresample=48000:async=1:first_pts=0` fills or
  trims the sound to its timestamps. Then frame i is exactly at `base + i/fps` and sample n at
  `base + n/48000`. No B-frames, so output order = display order. The engine's audio clock drives
  the picture as for any other file. Before (sample counting alone), a sound track starting 0.3 s
  after the picture played 300 ms early for the whole file, and a 0.5 s gap in the sound's
  timestamps shifted everything after it by 500 ms (test/host/remotestream_test.js found both).
- **Sound pacing.** ffmpeg's two outputs run in their own threads: the sound can run tens of seconds
  ahead of the picture while the H.264 pipe is paused (2 s queued). The host keeps it, but sends it
  at most `AUDIO_LEAD_S` = 2 s past the picture sent (everything at the end).
- **Seek and step.**
  - **From memory:** the host keeps what it sent from the keyframe at or before 5 s behind the last
    packet sent (`HISTORY_S`; ~3 MB at 5 Mb/s; by time, because the webview reads seconds of small
    packets ahead) and the sound from there. A seek whose target is in there (or ≤ 0.5 s past the
    last packet read, ffmpeg still running) re-sends from the keyframe before it: no restart. The
    engine skips the frames before the target as for any accurate seek; sound starts at the target.
  - **Restart:** otherwise ffmpeg restarts at the target frame (`-ss` before `-i`: the demuxer seeks
    to the source keyframe before and ffmpeg decodes up to the frame; the first packet out is an
    IDR of the target frame).
  - **Steps back:** a seek back by ≤ 2 s before the stream's start restarts 1 s before the target
    (`STEP_BACK_LEAD_S`), sound from the target, so the next steps back come from memory.
  - **Bursts (scrubbing):** `seek()` answers `seeked` at once and drops the old stream, but starts
    ffmpeg only if no seek came in the last 60 ms and none started in the last 200 ms; otherwise a
    timer starts the newest target when the burst pauses 60 ms, at most every 200 ms, and no seek
    waits more than 400 ms. 25 seeks 25 ms apart: 3 starts (host test).
  - **The seek bar** (media/player.js) already sent one seek at a time, the next once the frame
    landed or after 250 ms. For the remote stream it waits up to 1.25× the last seek's measured time
    (engine `lastSeekMs`, 250 ms..1.5 s), so each restart can show its frame while dragging instead
    of being cut off by the next one.
- **Loop.** At the end an ffmpeg for t=0 waits with unread output (as `src/native.js` does), so
  loops restart with no start-up.
- **After dispose** nothing starts ffmpeg again: `handle`, `startAt`, `seek` and `more` return early
  (review 2026-11-19 #5), and a pending scrub timer is cleared.

## Encoder choice

`probeEncoder()` (src/remotestream.js), once per extension host and ffmpeg build
(key: hostname | ffmpeg path | `-version` line; in memory and in globalState `remoteStreamEncoders`,
newest 20 kept): `ffmpeg -encoders`, then for each GPU encoder that is built in, in this order, 8
frames of `testsrc2` 320×240 with **the stream's own encoder arguments** (so an option an older
ffmpeg or driver lacks fails the test, not the stream). The first that encodes wins; else the CPU encoder: libx264, or libopenh264 when the build
has no libx264 (BtbN's LGPL builds, the one the remote download below installs).
The log line lists every try and the encoder's own error (`remote stream encoder on <host>: …`).

| Remote | Encoder | Args | Frames in |
|---|---|---|---|
| NVIDIA | h264_nvenc | `-preset p1 -tune ull -rc vbr -cq 23 -b:v 0 -maxrate 20M -bufsize 10M -bf 0` | yuv420p |
| Intel | h264_qsv | `-preset veryfast -global_quality 23 -look_ahead 0 -async_depth 1 -bf 0` | nv12 |
| AMD | h264_amf | `-usage lowlatency -quality speed -rc cqp -qp_i 23 -qp_p 23 -bf 0` | nv12 |
| VAAPI (Linux, each `/dev/dri/renderD*`) | h264_vaapi | `-vaapi_device <node>` before `-i`, `-qp 23 -bf 0` | `format=nv12,hwupload` |
| none of them (fallback) | libx264 | `-preset ultrafast -tune zerolatency -crf 23 -maxrate 20M -bufsize 10M` | yuv420p |
| none, no libx264 (LGPL build) | libopenh264 | `-rc_mode quality -b:v 8M -maxrate 20M -allow_skip_frames 0 -threads 4 -slices 4` (no B-frames in OpenH264) | yuv420p |

All: `-g 2·fps -profile:v high`, no B-frames. `VPE_RS_ENCODER` still forces one (tests).
A GPU encoder that exits with an error mid-stream (driver reset, NVENC sessions used up) is not a
stream failure: `encoderFallback()` restarts with the CPU encoder (libx264 or libopenh264) at the next frame the webview hasn't had
(sound already sent isn't sent twice) and `encoderFailed()` stores the CPU encoder for that host and ffmpeg.

At 1080p, x264 ultrafast costs about one core; the source decode is the expensive part (4K HEVC
10-bit software decode ≈ 53 fps on 8 cores here, including the scale).

## Slow links

The webview samples normal 1× playback in two-second windows. It counts H.264 and PCM payload
bytes received and divides by the elapsed time of completed `more` requests. This measures
effective stream delivery, including remote encoder wait and message round trips. Time between
requests is omitted because a full decode buffer naturally stops asking for data. The samples
also carry how much video arrived per second, decoded seconds buffered, and the engine's
behind-real-time signal. The webview excludes pauses, seeks and the audio-only tail.

- The stream starts at the configured/source height with the usual encoder. Two consecutive
  windows mostly below 0.2 s buffered, with insufficient video delivery or slow decoding,
  step down. The capped profiles use libx264 with VBV caps of **720p / 3 Mb/s**, **480p / 1.2 Mb/s**,
  and **360p / 0.45 Mb/s**. The height never exceeds the configured or source height.
- Recovery takes four consecutive healthy windows with at least 0.25 s buffered on average and 30%
  delivery headroom for the next profile, including 3.072 Mb/s for stereo PCM when present.
  The top profile uses the measured cost of its original stream for this comparison, with a
  3 Mb/s minimum. A switch discards only unsent video. The new encoder starts with an IDR at the
  first unsent frame, and the existing audio process and sample cursor continue.
- Two more starved windows at the lowest profile switch the tab to the built-in decoder and
  disable streaming for that tab, as with a terminal ffmpeg error.

The hidden-desktop VS Code cases use `remoteStream: on`. They pace batch delivery in the webview
by payload size. On the generated 1080p clip, a 4.4 Mb/s limit drops playback to 720p and holds
it there at real time. Removing the limit restores 1080p on the same timeline. A 96 kb/s limit
then forces built-in fallback at the current position. Separate cases open the pixel inspector
and accept **Use full resolution**, and terminate the stream's ffmpeg process during playback.

## Measured with a real Linux ffmpeg (BtbN static N-129046, 2026-11-18 build, in WSL)

Same setup as below, but the remote's ffmpeg is the Linux build itself (software decode, libx264).
This run is the reference: it replaces the stand-in numbers below.

| Clip | off (today) | **auto (stream)** | Seek far / near off → auto | Wire |
|---|---|---|---|---|
| hevc_10_2160p (30 fps) | WebAssembly, **7.5 fps**, open 3.0 s | WebCodecs, **29 fps**, open 2.5 s | 5.7 / 1.9 s → 1.7 / 0.9 s | 4.7 Mb/s |
| hevc_10_1080p (24 fps) | WebAssembly, 23, open 2.2 s | WebCodecs, 23.5, open 2.2 s | 1.7 / 0.9 s → 0.8 / 0.8 s | 9.1 Mb/s |
| vp9_opus_anim_1080p (30 fps, sound) | WebAssembly, 29, open 2.2 s | WebCodecs, 28–29, open 2.2 s | 0.9 / 0.9 s → 0.9 / 0.8 s | 10–11 Mb/s + 3.1 Mb/s PCM |

- Sound over SSH: the Opus track arrives as PCM (`a=soft`, the engine's PCM path). Whether it is
  audible can't be checked on the hidden desktop: the AudioContext stays `suspended` without a user
  gesture there, for every clip and decoder (the standard suite's h264_aac clip too). Needs a person
  hands-on check.
- The BtbN build also has h264_nvenc and h264_vaapi (not tried: WSL has no GPU encoder set up).
- Raw: `test/vscode/out/ssh-linux-auto.json`, `ssh-linux-off.json`, `ssh-linux-sound.json`.

## Measured with the stand-in (Windows ffmpeg through WSL interop; real VS Code 1.147.0, portable, hidden desktop; Remote-SSH to sshd in WSL2 on localhost)

Same machine: i7-9700K, RTX 4070. The remote's ffmpeg was the Windows ffmpeg 9.0.2 called through
WSL interop (see "Test setup"), software decode, libx264. 2–3 s clips loop; shownFps is the median of
the 2 s windows after the first. Seeks: paused, polled every 250 ms (so ±250 ms), frame-exact.

| Clip | Mode | Path | Open → first frame | shownFps | Seek far / near | Wire |
|---|---|---|---|---|---|---|
| hevc_10_2160p (30 fps) | off (today) | WebAssembly | 3.1 s | **7** | 6.4 s / 1.9 s | file blocks |
| | auto, no prepared loop | stream → WebCodecs | 2.7 s | 25 | 0.6 s / 1.6 s | 4.1 Mb/s |
| | **auto** | stream → WebCodecs | 2.7 s | **28.5** | 1.8 s / 0.9 s | 4.6 Mb/s |
| hevc_10_1080p (24 fps) | off | WebAssembly | 2.2 s | 23 | 1.9 s / 0.9 s | file blocks |
| | auto | stream → WebCodecs | 2.3 s | 23 | 0.9 s / 1.0 s | 8.9 Mb/s |
| h264_8_1080p (24 fps) | off and auto | WebCodecs (not streamed) | 2.2–2.4 s | 24 | 0.9 s / 0.9 s | file blocks |

- The first clip's open includes the extension's activation; connecting took 4–22 s (22 s on the
  first run, which also installed the VS Code server).
- ffmpeg start → first packet: 130–230 ms (start of file), 360–760 ms (4K seek mid-GOP); 0 ms when
  the prepared loop was taken. Over a real network, add one round trip per seek.
- Local window, `remoteStream: on`, Windows ffmpeg (`test/vscode/cases/remote_stream.js`, machine
  40–87% loaded by other sessions): hevc_10_2160p 26, hevc_10_1080p 22.5, vp9+opus 1080p 29 shownFps.
  This run was before the prepared loop.
- Raw files: `test/vscode/out/ssh-off.json`, `ssh-auto.json`, `ssh-auto2.json`, `rs-local-on.json`
  (not committed; out/ is ignored).

## Finishing (2026-11-19, second pass): what was measured

Desktop i7-9700K, RTX 4070 (driver with NVENC API 13.0), real VS Code 1.147 portable on the hidden
desktop. ffmpeg 9 (winget) on PATH; its NVENC needs API 13.1, so it falls back to libx264 there.

- **Host test** (`node test/host/remotestream_test.js`, real ffmpeg, no VS Code): 200 s synthetic
  clips with a white flash and a 1 kHz beep every 10 s, read back from the H.264 sent (decoded
  again) and the PCM sent. Before the aresample fix: sound track 0.3 s late → beeps 300 ms early
  everywhere; 0.5 s sound gap at 50 s → 500–530 ms early after it. After: late sound 0 ms, late
  picture 0 ms, gap ≤ 33 ms (one frame at 29.97, the flash's own quantisation, constant: no
  drift), from 0 and after a seek to 95.5 s; same with h264_nvenc (ffmpeg N-114833, 2024, whose
  NVENC works with this driver: `VPE_RS_FFMPEG=<that ffmpeg>`). Scrubbing: 25 seeks 25 ms apart →
  3 ffmpeg starts, first packet of the last target ~85 ms after the last seek.
- **Real VS Code, local window, `remoteStream: on`** (`run.js --quick --grep '^case/remote_stream'`),
  7/7: hevc_10_2160p 30 shownFps, hevc_10_1080p 24, vp9+opus 29.5; encoder line
  `libx264, tested in 346 ms: h264_nvenc failed (Driver does not support the required nvenc API
  version. Required: 13.1 Found: 13.0); h264_qsv failed (Error creating a MFX session: -9.);
  h264_amf failed (…)`. 2 s HEVC clip: 20 seeks + 3 steps back, 0 restarts (all from memory).
  200 s clip: 64 s of playback, position vs wall clock −0.12…+0.11 s, sound sent 1.85–2.00 s
  ahead of the picture (the cap), 0 restarts; 20 seeks across it → 5 ffmpeg starts (the test
  hook delivers commands in bunches ~300 ms apart, so this is about one start per bunch), landed
  on the last target 0.7 s after it; 3 steps back → 1 restart (1 s early), then 2 from memory.
  The first try found steps back restarting every time (history trimmed behind the paused
  webview's read-ahead); fixed by keeping history around the last seek target.
- **Same with the 2024 ffmpeg** (`--ffmpeg …N-114833…`), 5/5: the probe picked h264_nvenc in
  220 ms; hevc_10_2160p 29.5, hevc_10_1080p 24, vp9+opus 29.5 shownFps. NVENC at `-cq 23` makes
  ~13 Mb/s at 1080p (x264 crf 23: 4–16 depending on the clip). These measurements predate
  slow-link adaptation.
- **Real VS Code over Remote-SSH** (WSL sshd on localhost, BtbN Linux ffmpeg N-129046 on the
  remote, `remote_ssh.js --mode default`, i.e. the setting unset = `auto`): hevc_10_2160p 29 shownFps
  (4.0–4.7 Mb/s), hevc_10_1080p 22.5 (7–9 Mb/s), vp9+opus 27.5 (10–15 Mb/s + PCM), h264_8_1080p
  stays on WebCodecs directly (24); all paused seeks exact. Encoder probe on the remote: libx264,
  68 ms (h264_nvenc: WSL's libcuda has NVENC API 13.0, the build needs 13.1; qsv/amf: no device):
  the fallback path. `--seeks`: 20 seeks + 3 steps back on the 2 s clip, 0 restarts. `--long 150`:
  158 s of playback, position vs wall clock −0.14 s, sound sent 1.73–2.00 s ahead, 0 restarts;
  then 20 seeks across the 200 s clip → 6 starts, landed on the last target; 3 steps back → 1
  restart, 2 from memory. `--mode off` (Machine settings): hevc_10_2160p on the built-in decoder,
  7.5 fps, as before. 9/9 checks passed over the runs (ssh-default-3/-4, ssh-off-1 in
  test/vscode/out, not committed).
- The hidden desktop's AudioContext stays suspended, so the engine runs on its timer clock there:
  the end-to-end audible sync is checked in the host test (content) and by the stream's pacing
  in VS Code (position vs wall clock, sound vs picture sent); listening is still a manual check.

## Limits

- **Not the file's pixels.** Scaled, 8-bit 4:2:0, lossy. `nativeLossy` is set, so the inspector,
  scopes, 1:1 zoom and frame export offer the built-in decoder (`useFullRes`), as with native ffmpeg.
- **HDR (PQ/HLG) is not tone-mapped**: tagged as BT.709, so it looks washed out. Fix on the remote:
  `zscale=t=linear,tonemap=hable,zscale=t=bt709:m=bt709:p=bt709` (BtbN builds have zimg), or keep HDR
  files on the built-in decoder.
- Not done: audio track switching and embedded subtitles (the engine refuses them with
  `cfg.native`, like native ffmpeg); thumbnails on the seek bar; a bitrate setting for slow links;
  a GPU-decoding ffmpeg on the remote (the download below is a static CPU build).
- GPU encoders: only NVENC ran for real (locally, as if remote). QSV, AMF and VAAPI are wired up
  and probed (VAAPI with `-vaapi_device` and `hwupload` per render node) but not run on hardware
  that has them; the probe's test encode guards each, and a failure mid-stream falls back.
- A GPU *decoder* on the remote is not used (software decode; the probe of src/probe.js is local-only).
## ffmpeg on the remote: the download offer (2026-11-19)

No ffmpeg on the remote (PATH, `ffmpegPath` there, or an earlier download) means the remote stream
can't start and the file plays in the built-in decoder. src/remoteff.js and `maybeOfferRemoteFfmpeg()`
in src/extension.js offer BtbN's static **LGPL** Linux build (same source, same
`checksums.sha256` and SHA-256 check, same proxy agent, progress with cancel and "didn't get
through" fallback as the local setup command — `downloadManaged()` is now shared by both).

- **When:** the engine posts `softVideo` when a picture decodes in WebAssembly (`vmode soft`, not
  native). The host asks only if: a remote window other than WSL (WSL keeps the first-open popup,
  native ffmpeg plays there), trusted workspace, `remoteStream` lets this window stream, decoder
  not `builtin`, remote is Linux x64 or arm64, and `tools()` finds no ffmpeg. Once per remote and
  session; "Don't Show Again" is kept per remote (`remoteFfmpegOffer` in globalState, key
  `<remoteName>:<hostname>`, newest 20). "Not now" asks again next session. Not while the
  first-open popup shows.
- **Where:** `context.globalStorageUri` of the remote extension host, `ffmpeg-builds/<id>/`, new folder
  per install (the build in use stays until the switch). The record is `managedFfmpeg@<remoteName>:<hostname>`
  (globalState is synced to the client and shared by all hosts; the local `managedFfmpeg` is
  untouched; an old record under the shared key is still read if its file exists on this host).
- **What is unpacked:** `tar -tf` first; the shallowest members named exactly `ffmpeg` and `ffprobe`
  must be safe names (no `..`, no absolute or drive paths, no control/glob characters); only those
  two are extracted (`--no-same-owner`), then each must be a plain file (lstat, not a link) whose
  realpath is inside the build folder. ffplay, docs and the archive are not kept. A missing `xz`
  on the host gives a "is xz installed?" error.
- **Encoder:** the LGPL build has no libx264, so the stream's CPU encoder is libopenh264 (see the
  table). The transport encode is the documented exception to "ffmpeg only decodes" (docs/PRODUCT.md).
- **After:** `toolsPromise` reset, a "ffmpeg ready on <host>" note, open players reload.
- Downloads go over https only; plain http is allowed only to 127.0.0.1/localhost (the tests' fake
  release). Tests (with `VPE_LOG` only): `VPE_BTBN_URL`, `VPE_TEST_PLATFORM`, `VPE_TEST_ARCH`.

Checked: test/host/remote_ffmpeg_test.js (fake release on 127.0.0.1 and a fake SSH remote in
mock_vscode: x64/arm64 choice, LGPL static only, checksum failure leaves nothing, `../`, absolute
and symlink members rejected with nothing written outside, only ffmpeg/ffprobe kept, the offer's
once/never/WSL/local/builtin/off/ia32 rules). The real `ffmpeg-n9.0-latest-linux64-lgpl-9.0.tar.xz`
(137 MB, checksum ok) in WSL: `extractTools` 7 s, 2 files; `probeEncoder` → libopenh264 (NVENC
API too old, QSV/AMF none); 150 frames 1080p testsrc2 in 0.8 s, High profile, no B-frames.
Real VS Code 1.147.0 over Remote-SSH (test/vscode/remote_ssh.js, sshd in WSL, no ffmpeg on the remote,
hevc_10_1080p.mp4): the remote log shows `hevc decodes in WebAssembly and <host> has no ffmpeg: offering
the download` 2.9 s after the open; the clip played on (built-in, 24 fps). The button was not
clicked there (no notification hook in the harness), so the download itself ran only in the host
test and the WSL check above. Not run: an arm64 host.

## Test setup (no admin)

- sshd in WSL as the user: `~/vpe-e/sshd/sshd_config` with `Port 2233` (systemd's `ssh.socket`
  holds 2222), `ListenAddress 127.0.0.1`, a user-owned `HostKey`, `PidFile`, `AuthorizedKeysFile`,
  `UsePAM no`, `PasswordAuthentication no`, `AllowTcpForwarding yes`,
  `SetEnv VPE_LOG=/home/<user>/vpe-e/vpe.log` (the test hook on the remote extension host). Start:
  `wsl.exe -e /usr/sbin/sshd -D -e -f ~/vpe-e/sshd/sshd_config` (Git Bash: `MSYS_NO_PATHCONV=1`).
  Windows' `localhost:2233` reaches it (WSL localhost forwarding).
- Client: a key and an SSH config (`StrictHostKeyChecking no`, own `UserKnownHostsFile`) in a temp
  folder; `test/vscode/remote_ssh.js --ssh-config <file> --mode default|off|auto|on [--remote-ffmpeg <path>] [--seeks] [--long N]`
  (the mode goes into the test server's Machine settings: the setting is machine-scoped). From Git
  Bash run it with `MSYS_NO_PATHCONV=1`, or `--remote-ffmpeg /home/...` arrives as
  `C:/Program Files/Git/home/...` and the remote silently has no ffmpeg (built-in decoder).
  installs `ms-vscode-remote.remote-ssh` into a fresh profile, puts the server in
  `~/vpe-e/server` (`remote.SSH.serverInstallPath`, so it never touches `~/.vscode-server`), copies
  the extension and clips to `~/vpe-e`, and opens `vscode-remote://ssh-remote+<host>/...` URIs.
- **ffmpeg on the remote**: the BtbN static Linux build in `~/vpe-e` (reference run). First runs used a stand-in while running it was not yet allowed: `~/vpe-e/ffwrap/ffmpeg` and `ffprobe`, bash wrappers that call
  the Windows ffmpeg.exe through WSL interop with `wslpath -w` on path arguments. The decode, encode,
  packetisation, SSH transport and webview are all real; the CPU is the same machine either way.
  It can't pass `pipe:3`, so no sound.

## Still open

Done: the setting (registered, machine scope, `auto` default), sync, seeks, GPU encoders,
slow-link adaptation and fallback, and real-VS-Code cases for seek/step, long playback,
pixel tools and stream failure. Left:

1. Listen to the sound (hands-on), and a remote across a real network (RTT, 5–10 Mb/s).
2. ~~ffmpeg on the remote: offer a download~~ done (see "ffmpeg on the remote"); left: clicking
   the offer in real VS Code (harness hook), an arm64 host, and libopenh264's speed/quality at 4K.
3. HDR tone-mapping on the remote (or a built-in decoder rule for PQ/HLG).
