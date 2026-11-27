# 0002: Live transcode (unified local and remote H.264 stream)

- **Status:** Signed off by maintainer (2026-11-21)

## Decision
- Name the feature **Live transcode** and unify local high-rate playback (e.g. 4K60) and remote streaming (SSH, WSL, containers, tunnels) into one host-side H.264 → WebCodecs stream engine (`src/stream.js`, with small pure modules for pipeline args, encoder probing, and activation policy per ADR 0001).
- Use a **hardware-first, software-last** pipeline on both local and remote hosts: full GPU decode → GPU scale → GPU encode when available, then CPU decode → GPU encode (Windows `h264_mf` with `-hw_encoding 1`), then software encode (`libx264` or `libopenh264`) only as the last resort; open-probe encoders (~0.2 s) rather than trusting `-encoders`, and pick the highest driver-compatible BtbN LGPL ffmpeg line during setup (with a driver-update notice for existing/external installs).
- Control quality with **best quality + a strict max bitrate cap** (`Auto` or explicit Mb/s via capped VBR `maxrate = bufsize = cap`), controlled by machine-scoped settings (`videoPreviewEnhanced.transcode`: `ask | auto | always | off`, migrating `remoteStream`; `videoPreviewEnhanced.transcodeMaxBitrate`: `0` for Auto or Mb/s; and a Phase 2 toggle to split the max bitrate across Compare tiles).
- Never silently degrade pixels on first use: prompt once when transcoding is needed (locally when raw transfer falls behind while decode keeps up; over remote links on first remote use to choose live transcode vs. original quality), and allow transcoding high-bitrate 8-bit H.264 over remote links based on size and bitrate.
- Keep the player bar clean: expose Live transcode and Max bitrate in a **⚙ panel row**, show the active encoder/pipeline and **Use original video** in **ⓘ**. While Live transcode is active, exact-pixel tools (Pixel Inspector, Scopes, Copy/Export Frame) may run on transcoded pixels in v1, but warn the user and recommend **Use original video** (fetching a single exact remote frame is deferred to a follow-up).
  - **Update (2026-11-21, maintainer):** the follow-up is done as `grabExactFrame` (`src/exact_frame.js`, `media/exactframe.js`): Copy Frame, Save Frame as PNG, Pixel Inspector and Scopes fetch one exact full-resolution PNG at the shown time from the host's ffmpeg and stay in Live transcode; see `docs/PRODUCT.md`.
  - **Update (2026-11-23, maintainer):** `ask` is retired. `videoPreviewEnhanced.transcode` is `auto | always | off`, default `auto`; a stored `ask` behaves as `auto`. Nothing prompts before Live transcode starts (remote first use, local transfer stall). A one-time pop-up notice on first start was tried and dropped (2026-11-27, maintainer); the player's own UI shows when it is on. This supersedes "prompt once when transcoding is needed" above.
- Ship in two phases: **Phase 1 (v1)** unified engine, GPU decode/encode, single-player local/WSL/SSH, settings/⚙/ⓘ, and driver-aware managed ffmpeg; **Phase 2 (v1.1)** Compare multi-view tiles on the same engine with per-tile sizing and shared max-bitrate splitting.

## Why
- One stream engine eliminates drift between local 4K60 and Remote-SSH, unlocks GPU decoding on remote GPU servers, and scales to multi-video Compare over constrained links (e.g. 5 × 4K videos on a 100 Mb/s network).
- Best quality with an explicit Mb/s ceiling gives predictable bandwidth budgeting without wasting bits on low-fps or simple scenes.

## Discussed & rejected
- **"Smooth playback" name** — hides that pixels are re-encoded; **Live transcode** states what actually happens.
- **Hard-forbidding software encoding** — breaks headless SSH servers and multi-tile fallback when consumer GPUs hit concurrent NVENC session limits; software stays last resort only.
- **`High / Balanced / Saver` quality presets** — opaque to users and harder to budget against a known network speed than an explicit max bitrate cap.
- **Player bar status pill** — conflicts with `docs/PRODUCT.md` ("no status pill"); ⚙ panel + ⓘ is sufficient.
