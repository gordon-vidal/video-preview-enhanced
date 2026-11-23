# Network URLs: Open Video URL… (2026-11-20)

Closes the gap with MoviPlayer, which plays network URLs: direct http(s) video files
and HLS (`.m3u8`) / DASH (`.mpd`) streams.

## What the user does

- **Video Preview: Open Video URL…**, **Open Video URL to the Side…** (the editor group beside, as VS Code's "Open
  to the Side") and **Open Video URL in New Window…** (the tab opens, then VS Code moves it to a new window with
  `workbench.action.moveEditorToNewWindow`), all in the Command Palette with the same input box; or **Open video URL…** near the bottom of the player's
  ⚙ panel (above Extension settings). Not in the right-click menu, which keeps only quick actions on the moment (docs/notes/ui-simple.md). The player has no empty
  or drop state (it always shows a file), so those are the entry points.
- With URLs opened before, a quick pick lists them (newest first, at most 10, in `globalState`
  `videoPreviewEnhanced.recentUrls`) under **Enter a URL…**.
- The input box is pre-filled from the clipboard when the clipboard holds an http(s) URL (the "paste" path; the
  user still confirms with Enter). It validates as you type: `http://` and `https://` only, a host, no
  `user:password@`, no spaces or control characters, at most 4096 characters. The fragment is dropped.
- The URL opens in a new tab (a webview panel `videoPreviewEnhanced.url`, globe icon, titled with the last path
  segment). Tabs are not restored after a window reload (no serializer: that would replay a URL without the user).

## Playback paths

Decided in `Session.openUrlPage` (`src/extension.js`). The host first looks at the URL once
(`urlsource.inspect`: a GET with `Range: bytes=0-65535`, following up to 5 redirects): the first bytes and the
content type tell HLS (`#EXTM3U`, `mpegurl`), DASH (`<MPD`, `dash+xml`), a web page (HTML: refused with
"This URL is a web page, not a video") or media. For playlists the whole text is read and live is detected
(HLS: no `#EXT-X-ENDLIST` and not `PLAYLIST-TYPE:VOD`, checked on the variant for a master playlist;
DASH: `type="dynamic"`).

| URL | ffmpeg installed (local window or WSL, trusted) | No ffmpeg (or SSH window, Restricted Mode, `decoder: builtin`) |
|---|---|---|
| Direct file (MP4, WebM, MKV, MOV, …) | The decoder rule as for files: 8-bit H.264 and VP8 stay on the GPU decoder (WebCodecs) through range reads; everything else plays with native ffmpeg reading the URL | Built-in decoder through HTTP range requests (`HttpFile`) |
| Direct file, server without range requests | Native ffmpeg | Up to 512 MB: downloaded in the background, reads wait for their bytes; larger: "needs ffmpeg" |
| HLS VOD (MPEG-TS or fMP4 segments, clear or AES-128) | Native ffmpeg (the master playlist itself; ffprobe picks the chosen variant's streams, ffmpeg reads only those) | Built-in decoder: the segments as one file (`HlsFile`), AES-128 decrypted in the extension host |
| HLS live | Native ffmpeg | "A live HLS stream needs native ffmpeg" + **Set up ffmpeg** |
| HLS with DRM (SAMPLE-AES, FairPlay, Widevine, PlayReady) | "This stream is protected (…)": not played | Same |
| DASH (VOD or live) | Native ffmpeg | "A DASH stream needs native ffmpeg" + **Set up ffmpeg** |

After **Set up ffmpeg** in that message the tab opens the URL again once ffmpeg is found.

### Built-in decoder over HTTP (no ffmpeg)

- The decoder's block interface is the one local files use (`readBlock` → `block`). For a URL the blocks come
  from `urlsource.HttpFile.read` / `HlsFile.read` in the extension host (Node `http`/`https`, so the webview's
  CSP and CORS don't apply and the page still has no network access). The page asks for 4 MB blocks with 4 ahead
  for URLs (as in remote windows); each block is one range request on a keep-alive connection (8 sockets).
- **HLS as one file:** the media playlist's segments (after the `EXT-X-MAP` init segment for fMP4), one after
  the other. MPEG-TS concatenates by design; fMP4 is init + `moof`/`mdat` fragments, which is a fragmented MP4.
  Segment sizes come from `EXT-X-BYTERANGE` or a `HEAD` per segment (8 at a time; a 1-byte range request when
  `HEAD` is not allowed) before playback starts ("Reading the HLS playlist… n / m segments"). A master
  playlist: the variant "Auto" or the Quality page picks (below), capped at 1080p for the built-in decoder.
  Alternate audio renditions (`EXT-X-MEDIA` with a URI) are not played by the built-in path: only the
  variant's own segments (muxed audio plays).
- **Seeking** works on range-capable servers and HLS VOD: the demuxer seeks in the virtual file (MPEG-TS by
  timestamp search over byte positions; fMP4 by reading fragments). Seek-bar thumbnails are off for URLs (each
  one would be more range requests).
- No ranges: see the table. Unknown size and no ranges: "needs native ffmpeg".

### Quality, subtitles, AES-128 (MoviPlayer parity, 2026-11-20)

MoviPlayer's VS Code extension plays streams in the webview (Shaka / hls.js over MSE, then an FFmpeg-wasm segment
fallback), which needs CORS and https; the parity research recommends keeping every request in the extension host
and extending `HlsFile` instead. Done for steps 1-4 of that plan:

- **The whole master playlist** (`urlsource.hlsOpen`, `parseM3u8`): variants with bandwidth, average bandwidth,
  resolution, codecs, frame rate and their AUDIO / SUBTITLES group ids; `EXT-X-MEDIA` renditions (type, group,
  name, language, default, autoselect, forced, URI, channels); `EXT-X-I-FRAME-STREAM-INF` playlists; session keys.
  The log line of the URL lists them ("2 variants, auto: 640x360 1500000 b/s, 3 renditions, 1 I-frame playlists").
- **Quality** (⚙ panel → **Quality ›**, only for a master playlist with two or more variants, not live): **Auto**
  (default, with the variant it chose: "Auto (720p)") and each variant from the largest picture down ("720p",
  "2.5 Mb/s · 1280 × 720"; a variant without a resolution is named by its rate; identical ones once). A pick saves
  the time and play state in the page's state and posts `quality` ('auto' or the variant index); the host checks
  it against this tab's master and reloads the page, which reopens the stream at that variant (`HlsFile` for the
  built-in decoder, or ffmpeg with `variant` in its input so `ffprobe` maps that variant's streams via their
  `variant_bitrate` tag, sound included) and resumes at the same frame, playing if it was. ⓘ shows the playing
  variant ("Stream: HLS variant 640 × 360, about 1.5 Mb/s").
- **Auto** (`chooseVariant`) picks once, when the stream opens; there is no switching while playing (no ABR: a frame
  tool wants a stable picture and exact seeks). Like the frames sized to the picture (PRODUCT.md), it takes **the
  smallest variant whose picture covers the player's picture area** (device pixels, sent with `ready`; 5 %
  tolerance), else the largest; capped by the decoder (1080p built-in, none for ffmpeg) and by the **measured
  rate**: only variants whose `BANDWIDTH` is at most 80 % of it (else the lowest). The rate comes from timing the
  first segment (up to 1 MB) of the variant chosen by size, once per server (host:port) per 10 minutes; reads under
  128 KB don't count (latency, not rate). A slower variant found that way is opened instead.
- **WebVTT subtitle renditions** (`hlsSubtitles`): the renditions of the played variant's SUBTITLES group (all of
  them when it names none), at most 16; each rendition's segments are fetched (8 at a time, 20 MB of text at most)
  and joined into one WebVTT text in player time: cue + `X-TIMESTAMP-MAP` MPEGTS / 90000 − LOCAL − the stream's
  start (the first PTS of the first MPEG-TS segment, or the first `tfdt` over the `mdhd` timescale for fMP4;
  `streamStart`); without a map (or start) the cue times stay as written. Cues repeated across segments are kept
  once. They reach the page as loaded subtitle files (`subs`, `stream: true`, the rendition's NAME as title and
  LANGUAGE): the CC / Subtitles page lists them as "English · stream", "Deutsch · German · stream"; a `DEFAULT=YES`
  rendition is shown automatically unless the user chose otherwise. Fetched after the first frame (playback doesn't
  wait) and kept for the tab, so a quality switch doesn't fetch them again. Same for native ffmpeg.
- **AES-128** (`HlsFile`): `EXT-X-KEY:METHOD=AES-128` with KEYFORMAT identity (or none), per segment (key rotation
  works), the IV from the tag or the media sequence number (128-bit big-endian), also for the `EXT-X-MAP` init
  segment. The key file is fetched once per URI, only from http(s), exactly 16 bytes; it stays in the `HlsFile`
  and is never logged or sent to the page. Sizes: each encrypted segment's last two cipher blocks (one range read,
  `bytes=-32` or inside its byte range) give the PKCS#7 padding, so the plain size is known without downloading
  segments and reads stay random access: a piece is read from the cipher block before it (its IV) and decrypted
  with Node's `aes-128-cbc` without auto padding. A wrong key fails the padding check: "could not be decrypted
  (wrong key?)". Native ffmpeg decrypts AES-128 itself (`crypto` is in the whitelist).
- **DRM** (`Protected`): SAMPLE-AES (also SAMPLE-AES-CTR / CENC), FairPlay (`skd:` or the streamingkeydelivery
  format), Widevine and PlayReady key formats, in the media playlist or as session keys: "This stream is protected
  (FairPlay)" with "… needs a licence and a content decryption module, which VS Code does not have; ffmpeg can't
  play it either", before any key request, for both decoders.
- **Not done (later steps of the plan):** alternate audio renditions (a second demuxer), DASH without ffmpeg, live
  HLS without ffmpeg, I-frame playlists as seek-bar thumbnails (they are parsed and logged only), resume for URL
  tabs, throughput in ⓘ.

### Native ffmpeg

- `src/ffmpeg.js inputArgs({ url, proxy })`: `-protocol_whitelist http,https,tcp,tls,crypto,httpproxy
  -rw_timeout 20000000 [-http_proxy <proxy>] -i <url>`, only for a URL input object (built only from the
  user's URL). Files keep `-protocol_whitelist file -i <path>` and the manifest refusal (security review
  2026-11-19 #1); `ff.probe` skips the text-manifest check only for URL inputs. `NativeDecoder` takes the input
  object (`input`); everything else (frame server with token and origin, credits, seeking by `-ss`, GPU
  methods, fallback to software) is the file path.
- ffprobe over a stream lists every variant: `probe` takes the largest video for URL inputs and ffmpeg then
  reads only that one (`-map`).
- A failure of native ffmpeg on a URL is not remembered (no file to key on): the tab tries the built-in path,
  whose message names the ffmpeg error when that fails too.
- Seek-bar thumbnails by ffmpeg (`thumbhost`) are off for URLs.

### Live streams

- Native ffmpeg starts at the live edge (ffmpeg's HLS default: 3 segments from the end; DASH: the live edge).
  The duration is 0: the seek bar is disabled ("Live stream: seeking is not available"), the time shows
  `m:ss · LIVE` (a click on the time doesn't cycle to timecode / frame number: it says "Live stream"), seeks, frame
  steps and Home/End do nothing (`engine.seekTime` returns for `meta.live`). The ⓘ panel's subtitle is the host and
  "live stream" ("stream" and the length for VOD) instead of a file size.
- A player that falls behind (paused, slow decode) holds ffmpeg back through the credits; ffmpeg's HLS demuxer
  then skips segments that left the playlist window.

### Network details

- Timeouts: 20 s for the answer and between body chunks (host); `-rw_timeout` 20 s in ffmpeg.
- Redirects: at most 5, only to http/https, never from https to http.
- Errors are sentences: "not found (HTTP 404)", "access denied: the link may have expired or need a login
  (HTTP 403)", "Can't find the server <host>", "<host> refused the connection", "<host> did not answer within
  20 s", "The TLS certificate of <host> is not trusted (<code>)". The query string is never logged or shown
  (`redact`: signed URLs carry tokens there).
- Proxy: VS Code's extension host already routes Node `http`/`https` through its proxy setting
  (`http.proxySupport`). As in the ffmpeg download (`src/proxy.js`), an explicit `http.proxy` / `HTTPS_PROXY`
  (with `NO_PROXY`) is also honoured directly: https through a CONNECT tunnel (honouring `http.proxyStrictSSL`),
  http with the absolute URL to the proxy; ffmpeg gets `-http_proxy`.
- **Remote windows:** URLs are fetched where the extension host runs: on the SSH/WSL/container host, not on
  your machine (the error message says so when the connection fails). Over SSH only the built-in path runs (no
  native frames over the connection; the remote stream is not used for URLs), so live HLS and DASH need a local
  window there.

## Features that need a file

| Feature | For URLs |
|---|---|
| Compare / multi-view | Not in the ⚙ menu; the message says "Compare works with video files, not URLs" |
| Frame links (Shift+C) | Not in any menu; "Frame links work for video files only, not URLs" |
| Copy ffmpeg command for A–B | Hidden (⚙ › A–B Range); the command explains why |
| Export frames A–B, save frame | Work (the page draws the frames); default folder: the first workspace folder, else the home folder |
| Sidecar subtitles | Not searched (no folder); **Load Subtitles…** works with local files |
| Resume position, reload on change, next/previous in folder, open in system player | Off |
| Seek-bar thumbnails | Off |

## Security (threat model: URL inputs)

- A URL only comes from the user: VS Code's input box (typed, pasted, the clipboard pre-fill they confirm) or the
  recent list (URLs typed there before). The command ignores its arguments, so `command:` links and other
  extensions can't pass one; the page's `openUrl` message (the ⚙ panel row) only opens the input box; the
  test hook (`<VPE_LOG>.cmd` `openUrl`) exists only with `VPE_LOG` set. Nothing in a file or playlist opens a
  URL by itself.
- `checkUrl` runs in the input box and again in `openUrl`; redirects are checked the same way.
- ffmpeg gets the URL as one argument of an argument array (`spawn`, no shell); `inputArgs` refuses anything that
  isn't `http(s)://` without white space. The whitelist has no `file`, `concat`, `subfile` or `data`: a remote
  playlist or manifest can't make ffmpeg read local files or UNC shares (tested: a served playlist that lists
  `file:///…/src.mp4` fails in ffprobe).
- TLS: the host verifies certificates and opens every URL first. ffmpeg's own TLS does not verify by default on
  OpenSSL/GnuTLS builds (`tls_verify` 0), so `inputArgs` adds `-tls_verify 1` for URL inputs, unless the user turned
  `http.proxyStrictSSL` off (a proxy that re-signs HTTPS traffic; the player passes `strictSSL: false`). Checked
  2026-11-23 with ffmpeg 9.0.2 (Windows, schannel: verifies by default, the option changes nothing) and 8.0.1 (Linux,
  OpenSSL): valid HTTPS plays, a self-signed certificate is refused ("Peer certificate failed verification"), plain
  http URLs and local files are unaffected (the option is ignored there). Needs the system CA store: a build
  without one fails on every HTTPS URL, and the user sees ffmpeg's error (test/host/urlsource_abort_test.js).
- Cancellation: each page load has one `AbortSignal` (`pageAbort`); it goes through `inspect`, `hlsOpen`, the
  `HttpFile` / `HlsFile` reads (range, segment, key) and the subtitle fetches. An abort destroys the requests
  and rejects with an `AbortError`; the files also close themselves when the signal aborts (`linkSignal`). All
  requests of a load share one `abort` listener on the signal (`onAbort`), removed with the last request, so
  many reads never leave listeners behind.
- The frame server, its token and origin rules and the webview CSP are unchanged; the page still has no network
  access (`connect-src` is the resource origin and the loopback frame server).

## Tests

- `test/urlserver.js`: a 127.0.0.1 server (ranges, no-range, slow, stalled, throttled (`/throttle/<kbps>/`), redirect, 404 and web-page routes) and
  `makeStreams` (a 10 s 640x360 H.264/AAC clip with 1 s GOPs → HLS MPEG-TS, HLS fMP4, a 320x180 variant and a
  master playlist, DASH, a "live" playlist, a DASH manifest named `.mp4`), into `%TEMP%/vpe_url_streams`; `makeParity`
  adds `master_full.m3u8` (both variants with English (default) and German WebVTT renditions in 2 s segments with
  `X-TIMESTAMP-MAP`, a muxed audio rendition, an I-frame playlist), `hls_aes/` (hls_ts's segments encrypted with
  Node crypto: two keys, IV from the media sequence 7.. and an explicit IV), `master_aes.m3u8`, and SAMPLE-AES /
  FairPlay playlists.
- `node test/host/url_stream_test.js` (in `run_all.js`): URL checks, ffmpeg input arguments, range reads, no
  ranges, 404, redirects (3 ok, 9 too many), slow/stalled/refused, web page, HLS as one file (TS, byte ranges,
  master, fMP4 byte-exact), live/encrypted/DASH need ffmpeg, ffprobe over URLs (mp4, HLS master, DASH; the
  largest variant), a remote playlist listing a local file fails, file manifests still refused, and through the
  mocked extension: no URL from command arguments or page messages, the clipboard pre-fill, a URL panel reading
  blocks over HTTP, DASH without ffmpeg, HLS VOD without ffmpeg, HLS with ffmpeg going native. Parity: master
  parsing (variants, renditions, I-frame playlists, session keys, DRM names), `chooseVariant` (picture size, rate,
  cap), `joinVtt`, DRM refused without a key request, AES-128 byte-exact (whole file and odd ranges across key
  changes; each key fetched once; a wrong key, `data:` and `file:` key URIs refused), master renditions and
  subtitles in player time (MPEG-TS start 1.445 s), the fMP4 start, Auto on a 1200 kb/s server picks 180p (rate
  measured once), ffprobe maps the chosen variant with its own sound, AES-128 through ffprobe, and in the mocked
  extension: to the side (`ViewColumn.Beside`), new window (`moveEditorToNewWindow`), AES-128 blocks with no key or
  key URL in any message, the HTML or the log, the DRM message, `stream` and `subs` for a master playlist, bad
  quality picks ignored, a pick reloading at 180p with the subtitles kept.
- `test/vscode/cases/url_stream.js` (real VS Code, hidden desktop): `url_stream` (no ffmpeg) and
  `url_stream_native` (ffmpeg on PATH); parity cases `hls_aes`, `hls_quality`, `hls_subs`, `hls_drm`, `url_to_side`
  and `hls_aes_native`, `hls_quality_native`, `hls_subs_native`. Results below.

## Results (2026-11-20, desktop i7-9700K / RTX 4070, VS Code 1.147.0 portable, ffmpeg 9.0.2 gyan)

- `node test/host/url_stream_test.js`: 13 check groups ok.
- `node test/benchq.js node test/vscode/run.js --quick --grep "^case/url_stream"`: **14 / 14 ok** (137 s):
  - no ffmpeg: `mp4_direct` (range reads, GPU decoder), `hls_ts`, `hls_master` (picked the 640x360 variant),
    `hls_fmp4`: first frame matches ffmpeg's frame 0, seeks to frames 150 and 40 show those pictures, playback goes
    on; `dash_needs_ffmpeg` and `hls_live_needs_ffmpeg` show "… needs native ffmpeg" with **Set up ffmpeg**;
    `not_found` ("not found (HTTP 404)"), `web_page`.
  - ffmpeg on PATH: `hls_native` (master playlist), `dash_native`, `hevc_mp4_native`, `mp4_native` (decoder
    `ffmpeg`): first frame and seeks as above; `hls_live_native`: first frame, seek bar disabled, `LIVE` in the
    time; `mp4_h264_stays_builtin` (the decoder rule keeps 8-bit H.264 on the GPU decoder).
- Whole branch: `node test/host/run_all.js` 47 passed, 0 failed, 1 skipped; `node test/benchq.js node test/vscode/run.js --quick` (all clips, native and every case) **179 / 179 ok** (1857 s).
- Found on the way and fixed for files too: with native ffmpeg, a file whose sound starts before the picture
  (HLS/DASH here; MPEG-TS files in general) showed every frame one frame late: ffmpeg's constant-rate output
  repeated the first picture to fill the sound-only start. `ffprobe` now gives the picture's lead
  (`video.lead`, start of the video stream minus the file's start, 0-2 s) and native ffmpeg starts there
  (`-ss t + lead`, also for t = 0).

### Results for the MoviPlayer parity (2026-11-20, same desktop and VS Code)

- `node test/host/url_stream_test.js`: 17 check groups ok; `node test/host/run_all.js`: 52 passed, 0 failed, 1 skipped.
- `--quick --grep "^case/url_stream$"`: **14 / 14 ok** (120 s), including `hls_aes`, `hls_quality` (Auto = 360p in
  the test panel; 180p from frame 120, paused, 320x180; back to Auto playing), `hls_subs` (English cue 3 at 3.5 s,
  none at 3.95 s, Deutsch at 7.5 s), `hls_drm`, `url_to_side`. `url_stream_native`: 8 / 8 ok, including
  `hls_aes_native`, `hls_quality_native`, `hls_subs_native`.
- Whole branch after merging main, `--quick`: 205 / 213 ok (2294 s, `test/vscode/out/run-2026-11-20T10-41-09-866Z.json`);
  the 8 failures were 6 pages with "WebGL2 is not available" (remote_stream_fallback ×4, ui_info/wasm,
  url_stream_native_mp4: a GPU-process problem of that VS Code instance), compare_metrics/offset-3 and ctxmenu (first
  file opened before the default association). Rerun of those cases: 9 / 10 ok
  (`run-2026-11-20T10-44-43-117Z.json`), ctxmenu then ok on its own rerun (5 / 5).

## Not done / later

- The remote stream (SSH windows) is not used for URLs: there, live HLS and DASH need a local window.
- URL tabs are not restored after a window reload (no webview serializer on purpose).
- Alternate HLS audio renditions (`EXT-X-MEDIA` with a URI) in the built-in path; DASH in the built-in path
  (separate audio and video representations would need two demuxers); live HLS without ffmpeg; I-frame playlists
  for seek-bar thumbnails (steps 5-8 of the MoviPlayer parity plan).
- An https test server (https→http redirect refusal is covered by code review, not by a test).
