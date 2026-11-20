# How it compares

Other video players for VS Code, from their Marketplace READMEs as of November 2026, with install counts from the Marketplace on 17 November 2026. "Not listed" means their README doesn't mention it; the feature may still exist. Corrections are welcome as issues.

| | Video Preview Enhanced 0.6.1 | [MoviPlayer](https://marketplace.visualstudio.com/items?itemName=mrujjwalg.movi-player-vscode) 0.4.1 | [Modern Video Player](https://marketplace.visualstudio.com/items?itemName=Brodazz.mp4-player) 0.8.9 | [Video Preview (Player) – BNPL](https://marketplace.visualstudio.com/items?itemName=BatchNepal.vscode-video-preview) 0.2.0 | VS Code's built-in preview |
|---|---|---|---|---|---|
| Installs | new | 2.8k | 3.9k | 23k | built in |
| File types it opens | AVI, MKV, MOV, MP4, WebM, WMV, FLV, MPG, VOB, M2TS, MXF, OGV, 3GP, Y4M | MP4, MKV, WebM, MOV, TS, M2TS, AVI, FLV, WMV, MPG, 3GP, plus URLs | MP4, MOV, M4V, MKV, AVI, WebM, M2TS, MTS, FLV, F4V | MP4, WebM, MOV, MKV, AVI, M4V | MP4, WebM |
| HEVC, VP9 | Built-in WebAssembly showed 7.5 fps for 4K HEVC 10-bit and 12 fps for 4K VP9 on the desktop above. Optional ffmpeg showed 30 fps at full 4K for the HEVC clip | says it decodes in real time (WebAssembly or WebCodecs). VS Code only lets webviews use WebCodecs for H.264 and VP8, so we expect software decoding for these in VS Code; we did not measure it | converts to H.264 first (a one-time wait) | not listed | no |
| AV1 | yes | yes | no (per README) | not listed | no |
| ProRes, DNxHR, MXF, WMV2 | yes | no decoder in 0.4.1 (our test) | not listed | not listed | no |
| AAC sound with nothing installed | yes | yes | yes | needs ffmpeg | no |
| Frame stepping | yes, with frame counter | not listed | yes | not listed | no |
| Speed range | 0.25×–4× in 0.05 steps, pitch kept | adjustable (range not listed) | 0.25×–2× | 0.5×–2× | – |
| Subtitles | SRT, VTT, ASS files, in-file text and PGS/DVB/DVD tracks, delay | SRT, ASS, VTT, PGS, DVB, in-file tracks, delay, transcript | SRT, VTT files, delay | not listed | no |
| A-B loop / resume | yes / yes | not listed / yes | yes / yes | not listed | no |
| HDR | HDR10, HLG, Dolby Vision 8, HDR10+ as HDR10; HDR output on HDR displays, else tone-mapped to SDR | HDR10, HLG, Dolby Vision 8 | not listed | not listed | – |
| Streams from URLs (HLS, DASH) | HLS (quality menu, WebVTT subtitles, AES-128) and direct links with nothing installed; live HLS and DASH with ffmpeg; fetched by the extension, so no CORS or https needed | yes, in the webview (the server must allow CORS; https for streams) | no | no | no |
| Codec X-ray, pixel inspector, compare | yes | stats overlay | no | no | no |
| Remote (WSL, SSH) | yes, tested | not listed | not listed | not listed | yes |

Where MoviPlayer is ahead today: DASH, live HLS and alternate audio languages without installing anything (its README; we did not test whether its webview playback handles AAC in VS Code). We have not measured MoviPlayer's speed in VS Code, so there is no speed row for it here. Where this extension is ahead: ProRes, DNxHR, MXF, WMV and FLV1 decoding, a multi-core decoder pool, frame-exact tools and compare.
