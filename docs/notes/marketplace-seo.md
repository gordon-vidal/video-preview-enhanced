# Marketplace and Open VSX search: what to put where (2026-11-19)

Method: the Marketplace gallery API (`extensionquery`, text filter, default sort = relevance) with
"video", "mkv", "video player", "mkv player", "play mkv", "avi player", "media preview", "video preview",
"hevc", "ffmpeg video", "video viewer", read 2026-11-19. Install counts are as shown then.
Plus the 2026-11-17 notes that were in LISTING.md (kept below).

## How search ranks

- The text filter matches word prefixes in displayName, extension name, short description, `keywords`
  (tags) and publisher. Ranking is not documented; in practice an exact or strong name match comes
  first, then matches in other fields, with installs and ratings breaking ties.
- `keywords`: at most 30 (vsce fails above that). Categories only filter, they add no ranking.
- Open VSX (Eclipse, Elasticsearch based): name/displayName weighted x5, tags x3, description x1,
  fuzzy; unverified publishers get half the score. Claim and verify the namespace before the first
  `ovsx publish`.
- README text is not searched, only shown on the page. Install count matters once there are some.

## What the market looks like

| Extension | Installs | Name pattern |
|---|---|---|
| MPEG-4 Preview (analytic-signal) | 173k | format in name, tiny feature set |
| video (kangping) / video player (VMASPAD) | 33k / 30k | generic one or two words |
| Video Preview (Player) - BNPL | 23k | no format in the name; "Play MP4, WebM, MOV, MKV, and AVI…" in the description |
| Video Player (with Audio) — MP4/MOV/WebM | 9.4k | formats in the name |
| Modern Video Player — with Audio (MP4, MKV, HEVC, WebM) | 4k | formats in the name |
| MoviPlayer | 2.8k | brand name only, "formats VS Code can't play" in the description |
| Any Format Video Player / MP4, MOV, MKV & WebM Viewer… | 370 / 109 | descriptive, long |

Findings:

1. **Metadata is enough for format searches.** "mkv player", "play mkv", "avi player": BNPL (no format
   in its name) ranks first or second on its description and tags alone, ahead of extensions that have
   the formats in the name. MoviPlayer and Any Format Video Player appear too.
2. **A bare format word ("mkv", "avi") is not a fair test.** The results are filled by spam extensions
   named after pirated films ("…720p Mkv…") and unrelated names ("Avi Codes theme"). Nobody gets to the
   top of "mkv" legitimately by name, and it is not what people type (they type "mkv player", "video
   player", "play avi in vscode").
3. **The biggest installs go to short names** (analytic-signal 173k, VMASPAD 30k, BNPL 23k). Names with
   format lists exist but belong to the smaller extensions, and they read as keyword stuffing.
4. **Short words collide:** "avi" and "mov" prefix-match Aviation, Avif, Move, so they are weak in a
   name and cost nothing as tags.

## Recommendation

**Keep `Video Preview Enhanced`.** The research does not clearly favour format names in the display
name: description + tags rank for "mkv player"-style queries, and the name is what people remember and
search for after the first install. Drop the format list currently in `displayName`.

- **displayName:** `Video Preview Enhanced`
- **description (≤ 200 chars, shown on the result card; formats first):**
  `Play MKV, AVI, MOV, MP4, WebM, WMV, FLV, MPEG, HEVC, AV1 and ProRes videos in VS Code, with sound. No install needed; frame-exact tools; optional one-click ffmpeg.`
- **keywords (≤ 30; formats and phrases people type):** video, video player, video preview,
  video viewer, media player, mkv, avi, mov, mp4, webm, wmv, flv, mpeg, m2ts, mxf, hevc, h265, h264,
  av1, vp9, prores, ffmpeg, frame by frame, subtitles, compare, codec, remote ssh, wsl, audio.
- **categories:** Visualization, Other (same as the direct competitors; "Other" is where most
  video extensions sit).
- The first lines of the page (LISTING.md) should repeat the format names: the page is what people
  read after the search card, and it is indexed by web search engines.
- Revisit after the first 100 installs: if "mkv player" does not find it on page 1, add
  `(MKV, AVI, MOV)` as a suffix to the display name. That is a cheap change; the name is not part of
  the extension ID.

## Notes from 2026-11-17 (kept)

- displayName must be unique on the Marketplace; no documented length limit.
- Nobody owns "wmv", "flv", "mxf", "prores" or "image sequence" as tags yet.
- The gallery API answers 503 when queried quickly; space queries about 1.5 s apart.
