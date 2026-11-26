# YouTube playback in VS Code (2026-11-24)

Design evaluation for playing YouTube URLs through **Video Preview: Open Video URL…**
([`docs/notes/url-stream.md`](url-stream.md)).

## Verdict

**Viable, via an optional user-installed `yt-dlp` binary (Option A).**

- **Recommended:** Option A — detect an optional, user-installed `yt-dlp` on `PATH` (or via a
  machine-scoped setting `videoPreviewEnhanced.ytdlpPath`, never bundled and never auto-downloaded).
  Pair its resolved stream URLs with the existing [`src/urlsource.js`](../../src/urlsource.js) and
  native [`src/ffmpeg.js`](../../src/ffmpeg.js) pipeline. This preserves every Video Preview Enhanced
  feature (frame-exact stepping, scopes, pixel inspector, A–B range, zoom/pan, copy/save frame,
  subtitles, zero webview network access) with zero npm dependencies and zero site-scraper maintenance.
- **Not recommended as primary:** Option B (`<iframe>` embed) strips away every frame-accurate tool
  that defines the product ([`docs/PRODUCT.md`](../PRODUCT.md)), breaks the webview's zero-network
  CSP ([`src/unified-html.js`](../../src/unified-html.js)), and hits VS Code webview `Referer` /
  origin walls (YouTube Error 153).
- **Rejected:** Option C (built-in JS extractor) is a weekly maintenance trap and creates direct
  Marketplace / ToS exposure inside the VSIX.

---

## 1. Current gap: why `src/urlsource.js` cannot play YouTube today

`Session.openUrlPage` ([`src/extension.js`](../../src/extension.js)) inspects every URL with
`urlsource.inspect` (a single HTTP `GET` with `Range: bytes=0-65535`, up to 5 redirects) and
classifies it with `urlsource.kindOf` into `'media'`, `'hls'`, `'dash'`, or `'html'`.

When a user pastes `https://www.youtube.com/watch?v=…`, `youtu.be/…`, `/shorts/…`, or `/live/…`:

1. **HTML page rejection:** `urlsource.inspect` receives `text/html`, sets `kind: 'html'`, and
   `openUrlPage` immediately stops with *"This URL is a web page, not a video — Video sites such as
   YouTube are not supported."*
2. **Signature deciphering & rotating player JS:** Even if the host parsed `ytInitialPlayerResponse`
   or queried YouTube's Innertube `/youtubei/v1/player` endpoint, usable stream URLs are gated behind
   obfuscated `signatureCipher` (`s` parameter) transforms and the **`n`-parameter throttling
   challenge** embedded in YouTube's rotating `base.js` player script. Without solving the `n`
   challenge, `googlevideo.com` throttles transfers to ~50–100 KB/s (unplayable even at 360p).
3. **PO tokens and client attestation:** YouTube increasingly requires Proof-of-Origin (`pot`) tokens
   and JS challenge execution (modern `yt-dlp` delegates player JS challenges to a JS runtime such as
   Node or Deno) for web/mobile/TV clients, especially from cloud, VPN, or rate-limited IPs.
4. **Split adaptive video + audio streams:** Progressive muxed MP4 (`itag 18`, 360p H.264+AAC) is
   low resolution and increasingly restricted. All 720p, 1080p, 4K, 60 fps, and HDR streams (VP9,
   AV1, H.264) are delivered as **separate** video-only and audio-only adaptive URLs. Today:
   - `ff.inputArgs` ([`src/ffmpeg.js`](../../src/ffmpeg.js)) and `NativeDecoder`
     ([`src/native.js`](../../src/native.js)) accept only a **single** URL input (`-i <url>`).
   - `urlsource.HttpFile` and `HlsFile` expose a single virtual byte stream to `libav.js` (no
     dual-demuxer yet, as noted in [`docs/notes/url-stream.md`](url-stream.md)).
5. **Expiring, IP- and header-bound CDN URLs:** Resolved `googlevideo.com` URLs embed a signed
   `expire=<unix_ts>` parameter (typically ~6 hours, sometimes shorter) and expect matching client
   headers (`User-Agent`, etc.). Pausing a tab for hours and seeking later returns HTTP 403 unless
   the URLs are refreshed.
6. **Live, DRM, and gated content:** Live streams use rolling HLS/DASH manifests; movies/rentals use
   Widevine DRM (which VS Code cannot decrypt — already handled by `urlsource.Protected`); age-gated,
   members-only, or bot-checked videos require account cookies.

---

## 2. Options evaluated

### Option A — Optional user-installed `yt-dlp` (same pattern as optional `ffmpeg`)

Treat [`yt-dlp`](https://github.com/yt-dlp/yt-dlp) (Unlicense / public domain) as an optional,
user-installed resolver binary in the extension host, discovered via `videoPreviewEnhanced.ytdlpPath`
or `PATH` (reusing `ff.whichFile` / `ff.resolveTool` from [`src/ffmpeg.js`](../../src/ffmpeg.js)).

#### How it works

1. `urlsource.inspect` still runs first so direct media, HLS, and DASH URLs pay **zero** overhead.
2. Only when `info.kind === 'html'` (and workspace trust + settings allow it) does the host invoke
   `yt-dlp` via `child_process.spawn` (never a shell):
   ```text
   yt-dlp --dump-single-json --no-playlist --no-warnings --skip-download --no-exec -- <url>
   ```
   Using `--dump-single-json` (`-J`) instead of `--get-url` avoids multiple spawns and returns one
   structured JSON document containing:
   - `title`, `duration`, `is_live`, `webpage_url`, `extractor`
   - `formats[]`: `format_id`, `url`, `vcodec`, `acodec`, `width`, `height`, `fps`, `tbr`,
     `protocol`, `http_headers`, `manifest_url`
   - `requested_formats`: the default best video + best audio pair when adaptive streams are split
   - `subtitles` and `automatic_captions` (WebVTT URLs)
3. Pairing with the existing pipeline:
   - **Single muxed stream or HLS `manifest_url`** (e.g. YouTube Live, or 360p progressive fallback
     when `ffmpeg` is absent): feeds directly into the existing `openUrlPage` flow (`HttpFile` /
     `HlsFile` / single-input `ff.inputArgs`).
   - **Split adaptive video + audio (720p–4K, native `ffmpeg`):** extend `ff.inputArgs` and
     `NativeDecoder` to accept `{ url, audioUrl, headers, proxy, strictSSL }` and launch:
     ```text
     ffmpeg [-ss T] <net-args> -i <videoUrl> [-ss T] <net-args> -i <audioUrl> -map 0:v:0 -map 1:a:0 ...
     ```
     Placing `-ss` before **both** `-i` inputs keeps seeking fast and A/V synchronised.
   - **Quality menu & subtitles:** `formats[]` maps onto the existing ⚙ → **Quality ›** menu
     (`postStream` / `setQuality` in [`src/extension.js`](../../src/extension.js)), and WebVTT
     caption tracks feed the existing `subs` message path (`sendHlsSubs`).
   - **Expiring URLs:** parse `expire=` from resolved `googlevideo.com` URLs; if a seek or read fails
     with HTTP 403/410 (or when `expire` is within a few minutes), re-run `yt-dlp -J` once and
     re-seek to the current timestamp.

#### Trade-offs

| Pros | Cons |
|---|---|
| Externally maintained against YouTube's weekly player JS, `n`-param, and PO-token changes; users update with `yt-dlp -U` without waiting for a VPE release | Requires the user to install `yt-dlp` themselves (and for YouTube, a JS runtime like Node — already common in VS Code — or Deno) |
| Unlocks YouTube **plus 1,000+ other video sites** (Vimeo, Twitch, Bilibili, Mastodon, etc.) with one generic integration | Adds ~1–3 s to initial URL open while `yt-dlp` resolves metadata |
| Preserves **all** VPE features: frame-exact stepping, scopes, pixel inspector, A–B range, zoom/pan, copy/save frame, speed 0.25×–4×, GPU decode, Live transcode | HD adaptive streams (720p+) require native `ffmpeg` for dual-input video+audio decoding; without `ffmpeg`, built-in playback is limited to progressive muxed streams (typically 360p) |
| Zero npm dependencies, MIT extension, no GPL/non-free binaries bundled, webview keeps zero external network access | Expiring CDN URLs need a 403 refresh path for long-open tabs; bot-check / sign-in walls still fail without cookies |

---

### Option B — Embedded YouTube `<iframe>` fallback

Detect YouTube URLs by hostname/path, extract the 11-character video ID, and render an `<iframe>`
pointing at `https://www.youtube-nocookie.com/embed/<id>`.

#### Trade-offs

| Pros | Cons |
|---|---|
| Zero scraping / cipher / ToS risk (official YouTube embed player) | **Loses VPE's entire feature set:** no frame-exact stepping, no Compare, no scopes, no pixel inspector, no codec X-ray, no copy/save frame, no A–B range/export, no zoom/pan/picture-size modes, no shared speed/volume/shortcuts |
| Works without `yt-dlp` or `ffmpeg` | **CSP regression:** [`src/unified-html.js`](../../src/unified-html.js) locks the webview to `default-src 'none'` with zero external network access; embedding requires opening `frame-src` (and `script-src` for the IFrame API) to YouTube/Google domains |
| Handles adaptive bitrate, live streams, and embeds natively | **VS Code webview origin / `Referer` wall (Error 153):** VS Code webviews run on an opaque `vscode-webview://` origin. YouTube's embed player enforces a valid `http(s)` `Referer` header and rejects missing/non-HTTP referers with **Error 153 (Video player configuration error)** unless wrapped in a localhost `http://127.0.0.1` proxy page — which adds a local HTTP server purely to host a third-party iframe |
| | Uploader-disabled embeds still fail (Error 101/150); VS Code's Electron build lacks Widevine CDM so DRM rentals still fail; cross-origin iframe traps keyboard focus away from VS Code |

**Assessment:** An `<iframe>` turns VPE into a degraded browser tab inside VS Code. If a user has no
`yt-dlp` installed, a plain **Open in Browser** button on the error overlay is cleaner, honest,
respects the zero-network webview CSP, and avoids Error 153 altogether.

---

### Option C — Built-in JS extractor

Implement Innertube API calls, `base.js` signature deciphering, `n`-parameter JS evaluation, and PO
token generation inside `src/` (or bundle a JS library such as `ytdl-core` / `youtubei.js`).

**Why this is a maintenance and policy trap:**

- **Breaks weekly:** YouTube rotates `base.js` obfuscation, client versions, and PO-token checks
  frequently. Every break leaves VPE broken until a new VSIX is built, tested, and published.
- **Violates project constraints:** Bundling a third-party extractor violates VPE's zero runtime
  dependencies rule ([`AGENTS.md`](../../AGENTS.md)); hand-rolling one adds thousands of lines of
  brittle scraping code that cannot be meaningfully tested in CI without hitting live YouTube.
- **Direct Marketplace / ToS liability:** Shipping YouTube cipher-bypass code directly in the VSIX
  creates a much higher risk of Marketplace takedown or legal notice than shelling out to a
  user-installed general-purpose CLI tool.

---

## 3. Recommended architecture & phased plan

### Architecture overview

Keep the design small, testable in Node without VS Code, and symmetric with [`src/ffmpeg.js`](../../src/ffmpeg.js):

1. **New module `src/ytdlp.js`** (pure Node, unit-testable with mocked `spawn` / fixture JSON):
   - `locate(setting, cache)` — finds `yt-dlp` from `videoPreviewEnhanced.ytdlpPath` or `PATH`
     (reusing `ff.whichFile` / `ff.resolveTool`), caches `(path, size, mtime) -> version` like
     `ff.locateTools`.
   - `resolve(bin, url, opts)` — runs `yt-dlp --dump-single-json --no-playlist --no-warnings --skip-download --no-exec [--proxy <p>] -- <url>`
     with an `AbortSignal` and timeout (e.g. 30 s), parses stdout JSON, and returns a normalized
     `ResolvedMedia` object:
     - `title`, `duration`, `live`, `extractor`
     - `variants[]` (video+audio pairs and/or muxed formats, deduplicated by resolution/codec/fps,
       suitable for `chooseVariant` and the existing Quality menu)
     - `subtitles[]` (WebVTT URLs by language/name, capped like `hlsSubtitles`)
     - `expiresAt` (earliest `expire=` timestamp found in resolved URLs, if any)
   - `pickFormat(resolved, { hasFfmpeg, maxHeight, view, pick })` — selects a muxed format when
     `!hasFfmpeg` (or throws `urlsource.NeedsFfmpeg` when only split adaptive formats exist), or the
     best `(videoUrl, audioUrl)` pair matching the player's view size and decoder cap when `hasFfmpeg`.
2. **Dual-input URL support in `src/ffmpeg.js` and `src/native.js`:**
   - Extend `ff.isUrlInput` / `ff.inputArgs` to accept an optional `audioUrl` and sanitized `headers`
     object on the URL input:
     - Single URL: existing `-protocol_whitelist ... -i <url>` unchanged.
     - Dual URL: `-protocol_whitelist ... [-headers ...] -i <videoUrl>` plus second input
       `-protocol_whitelist ... [-headers ...] -i <audioUrl>`, with `-map 0:v:0 -map 1:a:0` and
       `-ss` placed before **both** inputs in `NativeDecoder`.
   - `ff.probe`: probe video and audio URLs (in parallel) when `audioUrl` is present and merge the
     `video` + `audio` stream descriptors into the standard probe result.
3. **Hook in `Session.openUrlPage` (`src/extension.js`):**
   - Only when `info.kind === 'html'`:
     - If `vscode.workspace.isTrusted` is false (Restricted Mode): do **not** run `yt-dlp`; explain
       that external URL resolvers are disabled in Restricted Mode and offer **Open in Browser**.
     - If `yt-dlp` is not found: show the existing "web page, not a video" message with a concise
       hint that installing `yt-dlp` on `PATH` enables YouTube and other video sites, plus **Open in
       Browser**.
     - If `yt-dlp` resolves the URL: update the tab title to `resolved.title`, validate every
       returned stream URL through `urlsource.checkUrl`, and hand off to the existing native /
       built-in URL playback path.
4. **URL expiry refresh:**
   - Store the original `pageUrl` and selected `formatId` on the `Session`.
   - On HTTP 403/410 from `NativeDecoder` or `HttpFile` (at most once per 60 s to prevent loops),
     re-run `ytdlp.resolve` for `pageUrl`, swap in the fresh signed URLs, and re-seek to the current
     time.

### Phased plan

- **Phase 0 — Maintainer decision:** Confirm Option A, no auto-download policy, and Restricted Mode
  policy (and whether `docs/PRODUCT.md` should mention optional `yt-dlp` under URL playback).
- **Phase 1 — MVP (`yt-dlp` + dual-input native `ffmpeg`):**
  - Add `src/ytdlp.js` + Node unit tests (`test/host/ytdlp_test.js`, no live YouTube calls in CI).
  - Add `videoPreviewEnhanced.ytdlpPath` (`scope: "machine"`, in `restrictedConfigurations`).
  - Extend `ff.inputArgs`, `ff.probe`, and `NativeDecoder` for dual-input `{ url, audioUrl, headers }`
    with `-ss` before both inputs.
  - Wire `info.kind === 'html'` fallback in `Session.openUrlPage` (progressive fallback for
    `HttpFile`, dual-input for native `ffmpeg`, tab title from metadata, **Open in Browser** on
    missing `yt-dlp` / DRM / login-required).
- **Phase 2 — Quality, Subtitles, Live & Expiry Refresh:**
  - Map `yt-dlp` formats into the existing ⚙ → **Quality ›** menu (`postStream` / `setQuality`).
  - Feed WebVTT `subtitles` into the existing `subs` pipeline.
  - Support YouTube Live via `manifest_url` (HLS) → existing `LIVE` mode.
  - Add automatic one-shot URL refresh on HTTP 403/410 for long-open tabs.
- **Phase 3 — Optional (only if user demand warrants):**
  - Explicit opt-in cookie file setting (`--cookies <path>`) for age-gated/members-only content
    (never `--cookies-from-browser` by default).
  - Remote-SSH URL playback through Live transcode when `yt-dlp` + `ffmpeg` are installed on the
    remote host.

---

## 4. Marketplace, ToS, and security considerations

1. **No bundling, no auto-downloading of `yt-dlp`:**
   - Unlike `ffmpeg` (a general-purpose codec library where one-click portable setup is standard),
     auto-downloading a YouTube extractor from inside a VS Code extension risks VS Code Marketplace
     review/policy issues and ToS complaints.
   - `yt-dlp` must be strictly **bring-your-own** (installed by the user via `winget`, `brew`,
     `pipx`, distro package manager, etc.). The extension only invokes it if the user has it on
     `PATH` or explicitly sets `videoPreviewEnhanced.ytdlpPath`.
   - Keep Marketplace copy (`README.md`, `package.json`) focused on *"network URLs and streams"*
     rather than marketing YouTube downloading.
2. **Command injection & argument hygiene:**
   - Always `spawn(bin, args, { shell: false, windowsHide: true })` — never a shell.
   - Validate the input URL with `urlsource.checkUrl` (`http:` / `https:` only, no whitespace or
     control characters) and always place `--` immediately before the URL so no URL can be parsed as
     a CLI flag.
   - Always pass `--no-exec --skip-download --no-playlist` (and consider `--ignore-config` so a
     compromised or unexpected config file cannot inject `--exec` hooks or write files to disk; pass
     VS Code's `http.proxy` explicitly via `--proxy`).
3. **Output URL & header validation:**
   - Re-validate every `url` / `audioUrl` / `manifest_url` / subtitle URL returned by `yt-dlp` with
     `urlsource.checkUrl` (`http:` / `https:` only). Never allow `file://`, `data:`, or `rtmp://`
     to reach `HttpFile` or `ffmpeg`.
   - Keep `ffmpeg`'s `-protocol_whitelist http,https,tcp,tls,crypto,httpproxy` and `-tls_verify 1`
     intact (never add `file` or `concat`).
   - Sanitize any `http_headers` forwarded to `ffmpeg -headers`: allowlist safe headers
     (`User-Agent`, `Accept`, `Accept-Language`, `Referer`) and reject any header key/value
     containing `\r` or `\n` (CRLF header injection).
   - Redact all resolved signed URLs with `urlsource.redact` in logs and UI; never log headers or
     cookies.
4. **Workspace Trust & privacy:**
   - Add `videoPreviewEnhanced.ytdlpPath` to `capabilities.untrustedWorkspaces.restrictedConfigurations`
     in [`package.json`](../../package.json) (same as `ffmpegPath`). Never spawn `yt-dlp` in
     Restricted Mode.
   - Never invoke `--cookies-from-browser` automatically: accessing a user's browser cookie store
     without explicit opt-in triggers OS keychain prompts and is a serious privacy boundary violation.
   - Keep the webview CSP unchanged (`default-src 'none'`, no external origins): all network traffic
     stays in the extension host and native `ffmpeg`.
