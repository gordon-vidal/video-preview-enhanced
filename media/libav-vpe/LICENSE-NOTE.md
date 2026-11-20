# libav.js "vpe" variant: components and licences

Custom decode-only build of libav.js 6.11.9 (FFmpeg 9.0.2), non-threaded
WebAssembly (SIMD128), built with Emscripten 6.0.5. No encoders, no muxers, no CLI.
"next" build: libav.js source modified (subtitle decode API, Makefile variables); the exact
scripts, patch (`BUILD/patch_subs.js`) and flags (`BUILD-FLAGS.txt`) are in `BUILD/`.
The full licence texts are embedded as a comment header at the top of
`libav-6.11.9.0.2-vpe.wasm.js` / `.wasm.mjs` (also in `LICENSE-full.txt`).

| Component | Version | Licence | Source |
|---|---|---|---|
| libav.js (glue, loader) | 6.11.9 | ISC-style (0BSD-like permissive) | https://github.com/Yahweasel/libav.js (tag v6.11.9) |
| FFmpeg (libavutil, libavformat, libavcodec, libavfilter, libswscale, libswresample) | 9.0.2 | LGPL 2.1 or later (built without --enable-gpl / --enable-nonfree) | https://ffmpeg.org/releases/ffmpeg-9.0.2.tar.xz |
| dav1d (AV1 decoder) | 1.5.4 | BSD 2-clause | https://code.videolan.org/videolan/dav1d |
| zlib | 1.3.2 | zlib licence | https://zlib.net |
| emfiberthreads (pthread shim, non-threaded build) | 1.3 | ISC-style permissive | https://github.com/Yahweasel/emfiberthreads |
| IJG jrevdct (inside FFmpeg, used by mjpeg/prores) | - | IJG licence: "This software is based in part on the work of the Independent JPEG Group." | part of FFmpeg |

No GPL components (no x264/x265/libvpx-GPL parts, no opencore-amr). AMR-NB/WB,
Opus, Vorbis, VP8/VP9 use FFmpeg's native LGPL decoders.

LGPL obligations when distributing: ship this note and the licence texts, say
the build is FFmpeg under the LGPL, and point to the corresponding sources
(the libav.js release tarball for 6.11.9 contains all of the above under
`sources/`) plus the variant definition below so the build can be reproduced
and relinked.

## Variant definition (configs/mkconfig.js vpe '<json>')

See `vpe-fragments.json` in this folder.

## Enabled FFmpeg components

- Demuxers: mov (mp4/m4a/mov), matroska (mkv/webm), avi, flv, mpegts (ts/m2ts/mts), mpegps (mpg/vob), asf (wmv/wma/asf), ogg, mxf, wav, mp3, aac (adts), flac, ac3, eac3, dts, dv, yuv4mpegpipe, h264, hevc, gif, m4v, mpegvideo
- Video decoders: h264, hevc, mpeg4, msmpeg4v2, msmpeg4v3, wmv1, wmv2, wmv3, vc1, mpeg1video, mpeg2video, mjpeg, prores, dnxhd, vp8, vp9, libdav1d (AV1), theora, flv (FLV1/Sorenson), h263, dvvideo, rawvideo, png, gif, qtrle, huffyuv, ffv1, utvideo
- Audio decoders: aac, mp1float, mp2float, mp3float, ac3, eac3, dca, opus, vorbis, flac, alac, pcm_s16le/s24le/s32le/f32le/u8, pcm_s16be/s24be/s32be/f32be, pcm_alaw, pcm_mulaw, pcm_dvd, pcm_bluray, adpcm_ms, adpcm_ima_wav, wmav1, wmav2, wmapro, amrnb, amrwb, dvaudio
- Added in "next": video decoders vvc (H.266), apv; audio decoders truehd, mlp; subtitle decoders
  subrip, ass, ssa, webvtt, movtext (mov_text/tx3g), text, dvdsub, pgssub, dvbsub; demuxers vvc,
  apv, truehd, mlp, srt, ass, webvtt; parsers vvc, apv, mlp. FFmpeg built with --enable-small.
- Parsers: h264, hevc, mpeg4video, mpegvideo, vc1, vp8, vp9, av1, aac, mpegaudio, ac3, dca, opus, vorbis, flac, mjpeg, h263, dvaudio
- Filters: format, scale (swscale), aformat, aresample (swresample), null, anull (+ buffer/buffersink, always present)
- Bitstream filters (pulled in by libav.js fragments): extract_extradata, h264_metadata, hevc_metadata, av1_metadata, prores_metadata
- Protocols: file, data
