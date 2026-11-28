# Test and benchmark media: sources and licences

The clips in this folder (and the probe clips in `media/probe/`) are short excerpts of
openly licensed films, re-encoded for the codec matrix. They are **not** covered by this
repository's MIT licence; each keeps the licence of its source, listed below. `test/**` is
excluded from the packaged extension (`.vscodeignore`); `media/probe/` ships, with its
attribution in `THIRD_PARTY_NOTICES.md`.

None of the licensors endorse this project. Logos and trademarks of the films are not part
of the licences and are not in these excerpts.

## Sources

| Short name | Film | Licence | Attribution | Source used |
|---|---|---|---|---|
| ToS | *Tears of Steel* (2012), Blender Foundation (Project Mango) | [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/) | (CC) Blender Foundation \| mango.blender.org | 4K regraded master, 16-bit TIFF, 4096x1714, 24 fps, frames 00700-00747 (0:29-0:31, the bridge scene): https://media.xiph.org/tearsofsteel/tearsofsteel-4k-tiff/ (licence: README.txt there and https://mango.blender.org/about/) |
| Meridian | *Meridian* (2016), Netflix | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | "Meridian", Netflix Open Content (opencontent.netflix.com), CC BY 4.0 | UHD 16-bit TIFF master, P3-D65 PQ, 59.94 fps, frames 15000-15118 (every 2nd; the car in the rain, 4:10): `Meridian/tiffs/` in https://s3.amazonaws.com/download.opencontent.netflix.com/ (licence: https://opencontent.netflix.com and `Meridian/creative-commons-attribution-4-intl-public-license.txt`) |
| Sparks | *Sparks* (2017), Netflix | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | "Sparks", Netflix Open Content (opencontent.netflix.com), CC BY 4.0 | HDR10 1000-nit BT.2020 PQ 16-bit TIFF, 4096x2160, 59.94 fps, frames 05940-06058 (every 2nd; welding sparks, a cut at 1.4 s): `sparks/HDR10_1000nit_PQ_2020_image_sequence/` in the same bucket (licence: https://opencontent.netflix.com, which puts all its titles under CC BY 4.0) |
| BBB | *Big Buck Bunny* (2008), Blender Foundation (Project Peach) | [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/) | (c) copyright 2008, Blender Foundation / www.bigbuckbunny.org | `bbb_sunflower_1080p_30fps_normal.mp4` (H.264 + MP3 delivery, 1080p30) from https://download.blender.org/demo/movies/BBB/, 7:03-7:06, with its stereo sound (licence: https://peach.blender.org/about/ and the film's end credits) |

Licence notes, checked 2026-11-18 at the official sources above:

- Tears of Steel: the film and its published frames are CC BY 3.0. Its separately published
  *soundtrack* (OST files) is CC BY-ND 3.0, so no Tears of Steel sound is used here.
- Big Buck Bunny: "licensed under the Creative Commons Attribution 3.0 license", covering
  "all the data we've published online"; the film's end credits say the same. The sound
  used here is the film's own mix from that release.
- Netflix Open Content: every title is "available under the Creative Commons Attribution 4.0
  International Public License" (opencontent.netflix.com; the licence text is in each title's
  folder). Meridian's end credits name Virgin Soil Pictures as producer; the licence grant
  is Netflix's.
- Not used: Xiph derf test sequences (licences differ per clip, several not redistributable)
  and anything with NC / ND terms.

## Changes (CC BY "indicate if changes were made")

All clips are shortened excerpts, re-encoded. Made by `make_media.js` with FFmpeg
(N-129000, BtbN GPL build: x264, x265, SVT-AV1, libvpx, libopus, prores_ks, dnxhd, zscale):

- ToS: centre crop to 16:9 (3040x1710), Lanczos scale to 1920x1080, BT.709 4:4:4 master.
- Meridian: every 2nd frame (59.94 -> 29.97 fps); tone-mapped from P3-D65 PQ HDR to SDR
  BT.709 (zscale, Hable curve, 100 nits = SDR white). 4K as is; 1080p probe clips scaled.
- Sparks: every 2nd frame; centre crop to 3840x2160; PQ kept (HDR10, BT.2020). The HLG clip
  converts the same picture to HLG (BT.2100, 1000-nit nominal peak).
- BBB: cut 3 s from 7:03; MP3 sound re-encoded to AAC / Opus.

## Clips (test/media)

Long-GOP clips are 2 s with a 2 s keyframe interval; ProRes / DNxHR are intra-only, so 1 s
(24 frames) costs the same per frame as a longer loop; the clips with sound are 3 s.
Bitrates are typical delivery rates (AV1: CRF, picked to land near them).

| File | Source | Codec | Res, fps | Bitrate | Size |
|---|---|---|---|---|---|
| h264_8_1080p.mp4 | ToS | H.264 High, 8-bit 4:2:0 | 1080p24 | 5.0 Mb/s | 1.25 MB |
| h264_10_1080p.mp4 | ToS | H.264 High 10 | 1080p24 | 5.0 Mb/s | 1.24 MB |
| hevc_8_1080p.mp4 | ToS | HEVC Main | 1080p24 | 3.2 Mb/s | 0.81 MB |
| hevc_10_1080p.mp4 | ToS | HEVC Main 10 | 1080p24 | 3.2 Mb/s | 0.80 MB |
| av1_8_1080p.mp4 | ToS | AV1 Main 8-bit (CRF 28) | 1080p24 | 2.9 Mb/s | 0.72 MB |
| av1_10_1080p.mp4 | ToS | AV1 Main 10-bit (CRF 28) | 1080p24 | 2.9 Mb/s | 0.73 MB |
| vp9_1080p.webm | ToS | VP9 Profile 0 | 1080p24 | 3.7 Mb/s | 0.93 MB |
| mpeg2_1080p.mpg | ToS | MPEG-2 Main, GOP 12 | 1080p24 | 10.4 Mb/s | 2.61 MB |
| prores_proxy_1080p.mov | ToS | ProRes 422 Proxy, 10-bit 4:2:2 | 1080p24, 1 s | 39 Mb/s | 4.92 MB |
| dnxhr_lb_1080p.mov | ToS | DNxHR LB, 8-bit 4:2:2 | 1080p24, 1 s | 36 Mb/s | 4.52 MB |
| h264_8_2160p.mp4 | Meridian | H.264 High | 2160p29.97 | 18.4 Mb/s | 4.61 MB |
| hevc_10_2160p.mp4 | Meridian | HEVC Main 10 | 2160p29.97 | 12.3 Mb/s | 3.08 MB |
| av1_10_2160p.mp4 | Meridian | AV1 Main 10-bit (CRF 23) | 2160p29.97 | 12.2 Mb/s | 3.06 MB |
| vp9_2160p.webm | Meridian | VP9 Profile 0 | 2160p29.97 | 10.4 Mb/s | 2.59 MB |
| hevc_10_pq_2160p.mp4 | Sparks | HEVC Main 10, HDR10 (PQ, BT.2020, mastering metadata) | 2160p29.97 | 11.4 Mb/s | 2.86 MB |
| hevc_10_hlg_2160p.mp4 | Sparks | HEVC Main 10, HLG (BT.2020) | 2160p29.97 | 11.5 Mb/s | 2.88 MB |
| h264_aac_anim_1080p.mp4 | BBB | H.264 High + AAC-LC 160 kb/s stereo | 1080p30, 3 s | 5.8 Mb/s | 2.17 MB |
| containers/*.{mkv,mov,m2ts,ts,flv,avi} | BBB | the clip above, first 3 s remuxed (make_containers.js) | 1080p30, 3 s | 5.8 Mb/s | ~2.1 MB each |
| containers/vp8_vorbis.webm | BBB | the clip above, 3 s re-encoded to VP8 + Vorbis (make_containers.js) | 720p30, 3 s | 2 Mb/s | 0.8 MB |
| vp9_opus_anim_1080p.webm | BBB | VP9 + Opus 128 kb/s stereo | 1080p30, 3 s | 3.0 Mb/s | 1.13 MB |
| **Total** | | | | | **40.9 MB** |

ProRes and DNxHR use their lightest profiles (Proxy, LB) to keep the repository small; real
mezzanines (422 / HQ, SQ / HQX) are 3-5x the bitrate and decode correspondingly slower on
the CPU. ProRes 422 HQ of this shot at 1080p24 would be about 22 MB per second.

## Probe clips (media/probe, shipped)

Meridian (same frames, tone-mapped SDR), named as in `src/probe.js` CLIPS: 1080p long-GOP
clips 30 frames (1 s), 4K clips 15 frames (0.5 s), ProRes Proxy 5 frames; 1-2 Mb/s for the
long-GOP clips (AV1 CRF 40) to keep all eleven at 1.57 MB. These bitrates are low for real
files, so the probe's CPU speeds stay somewhat optimistic for high-bitrate videos; the
pictures (dark, grainy live action) are realistic, unlike the earlier synthetic patterns.

## Rebuilding

```
node test/media/fetch_sources.js <dir>                 # ~8 GB of source frames + BBB (resumable)
node test/benchq.js node test/media/make_media.js --src <dir>   # masters (~3.6 GB FFV1), test/media, media/probe
```

`--masters`, `--bench`, `--probe` run single steps; `--only <regex>` limits to matching
masters / files. Encoder versions change the bytes, not the content.

## Self-made clips for the test cases (`test/media/cases/`)

`bars75_sd_709.mp4` and `bars75_sd_untagged.mp4` are 640×360 clips generated from FFmpeg's `pal75bars` source.

Everything in `test/media/cases/` is generated by `test/media/make_cases_media.js` (and the generators it
calls: `test/bitmapsubs/make_media.js`, `test/zoo/make_hdr.js`) with FFmpeg lavfi sources (`testsrc2`,
`pal75bars`, `sine`, `noise`), flat colour patches and hand-written subtitle events. There is no third-party
footage in them and no licence beyond this repository's MIT licence. The files are small; `node
test/media/make_cases_media.js [--force] [regex]` rebuilds them (kept when present; test cases make
missing ones on demand). Groups: `s_*` (3 s step/seek clips, one per decoder path), `*_60fps.mkv` /
`ntsc_2997.mkv`, `start3600*.mts`, `audio_longer*`, `sine_only.mkv`, `vp8_2s.webm`, `long_20s.mp4`,
`rotated.mp4`, `damaged_h264*.mkv` (one slice overwritten with noise), `trunc*.{mp4,mkv}` (cut files),
`bars75_709.mp4`, `gapped_30fps.mkv`, `gapped_wide_30fps.mkv`, `truehd_51side.mkv`, `flac_71_centre.mkv`, `tracks_multi.mkv`,
`neigh/` (three 1 s clips), `cmp/` (compare metrics), `fmt/` (1 s clips of many codecs and containers),
`bitmapsubs/` (PGS, DVD, DVB picture subtitles), `hdr/` (PQ / HLG test patches).


The A-B export and edit-list regression tests generate temporary fixtures with FFmpeg's `testsrc2`
and `sine` sources and handwritten subtitle cues. These fixtures contain no third-party media and
are covered by this repository's MIT licence.

The on-demand heavy and fault fixtures from `make_heavy_media.js` are synthetic
FFmpeg test patterns and tones with a handwritten subtitle cue. This repository's
MIT licence covers these fixtures. The default output directory is ignored by Git.

## Git LFS

The test videos under `test/media/` (86 files, about 63 MB) are stored with Git LFS
(`.gitattributes`). `media/probe/` (1.5 MB) is deliberately plain git: it ships in the
extension package, and `vsce` can't fetch LFS pointers. Install [git-lfs](https://git-lfs.com)
before cloning (`git lfs install` once); without it `test/media/*` are small text pointer files
and the tests that use them fail. After a clone without it: `git lfs pull`.
GitHub's free LFS quota is 1 GB/month of bandwidth, so CI caches the objects
(`.github/workflows/ci.yml`) instead of downloading them on every run.
