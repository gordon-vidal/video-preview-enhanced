# Network URLs (http, HLS, DASH)

**Video Preview: Open Video URL…** (Command Palette, or **Open video URL…** near the bottom of the player's ⚙ panel) asks for a URL and plays it in a new tab; **Open Video URL to the Side…** and **Open Video URL in New Window…** do the same beside the current editor or in a new window. An http(s) URL on the clipboard is filled in for you to confirm; URLs you opened before are offered first (the last 10).

| URL | Without ffmpeg | With native ffmpeg |
|---|---|---|
| Direct link to a file (MP4, WebM, MKV, MOV, …) | Built-in decoder, read with HTTP range requests (seeking works when the server supports ranges; a server without them works for files up to 512 MB) | Same decoder rule as for files: 8-bit H.264 and VP8 on the GPU decoder, the rest with ffmpeg reading the URL |
| HLS VOD (`.m3u8`, MPEG-TS or fMP4 segments, also AES-128 encrypted) | Built-in decoder: the chosen variant (up to 1080p), its segments read as one file and decrypted by the extension; seeking works | ffmpeg (the chosen variant) |
| HLS live, DASH (`.mpd`) | Not played: the player says it needs ffmpeg and offers **Set up ffmpeg** | ffmpeg |
| DRM-protected HLS (SAMPLE-AES, FairPlay, Widevine, PlayReady) | Not played: "This stream is protected" (VS Code has no content decryption module) | Same |

- **Quality (HLS):** for a stream with several variants the ⚙ panel has **Quality ›**: **Auto** (the default) or a variant ("1080p", "720p", …). Auto picks once when the stream opens: the smallest picture that fills the player, at most 80 % of the download rate measured on the first segment. Picking a quality reopens the stream at that variant from the same moment. There is no switching while it plays.
- **Subtitles from the stream (HLS):** WebVTT subtitle renditions are listed in the CC / Subtitles panel by name and language (marked "stream"); the default one is shown automatically.
- Closing the URL tab cancels pending requests. Changing HLS quality cancels requests for the previous variant.
- **Live streams** play from the live edge; the seek bar is off and the time shows `LIVE` (clicking it doesn't switch to timecode or frames). The ⓘ panel shows the host and "stream" instead of a file size.
- Video pages (YouTube and similar) are not video URLs: the player says "This URL is a web page, not a video".
- Errors are plain: not found (HTTP 404), access denied or an expired link (401/403), no answer within 20 s, an untrusted TLS certificate, a refused connection.
- `http.proxy` / `HTTPS_PROXY` are honoured (as for the ffmpeg download), and VS Code's own proxy routing applies too.
- **Remote windows:** the URL is fetched by the extension host, which runs on the remote machine (SSH, WSL, containers), not on your computer. Over SSH only the built-in decoder plays URLs, so live HLS and DASH need a local window.
- Features that need a file are off for URLs: compare (not in the ⚙ menu), frame links (`Shift+C` says why), the ffmpeg command for A–B, sidecar subtitles (Load Subtitles… still works), resume position, seek-bar thumbnails. Saving and exporting frames work.
- A URL only ever comes from what you type or paste into VS Code's input box: never from a file, a playlist or a link in a page. ffmpeg gets network access only for that URL; files keep the local-only rules ([Privacy and security](privacy-and-security.md)). Details: [docs/notes/url-stream.md](notes/url-stream.md).
