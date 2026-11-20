# Building the libav.js "vpe" variants

Reproduces `media/libav-vpe` (first build) and `media/libav-vpe-next` (this folder's parent).
Build host: Linux or WSL Ubuntu, bash. Paths at the top of each script can be overridden:
`VPE_LIBAV_SCRATCH` (default `~/vpe-scratch`; holds `libav_pkgs/libav.js-6.11.9/package`, the unpacked
npm package with its `sources/`), `VPE_LIBAV_BUILD` (default: this folder; `dist_<name>/` outputs land
here and are git-ignored) and `VPE_LIBAV_OUT` (default: `media/libav-vpe` or `media/libav-vpe-next` in this
repository). Work trees go to `~/vpe-libav` and `~/vpe-v/<name>`, emsdk to `~/emsdk`.

## Inputs

| What | Version | Where |
|---|---|---|
| libav.js | 6.11.9 (npm `libav.js@6.11.9`, `sources/libav.js.tar.xz` inside the package) | https://github.com/Yahweasel/libav.js tag v6.11.9 |
| FFmpeg | 9.0.2 (`sources/ffmpeg-9.0.2.tar.xz`) | https://ffmpeg.org/releases/ffmpeg-9.0.2.tar.xz |
| dav1d | 1.5.4 | https://code.videolan.org/videolan/dav1d |
| zlib | 1.3.2 | https://zlib.net |
| emfiberthreads | 1.3 | https://github.com/Yahweasel/emfiberthreads |
| Emscripten (emsdk) | 6.0.5 | https://github.com/emscripten-core/emsdk |

All source tarballs ship in the libav.js 6.11.9 npm package under `sources/`.
libav.js applies its own FFmpeg/dav1d patches (`patches/` in the libav.js tree) unchanged.

## media/libav-vpe (first build)

1. `00_extract.sh` – unpack libav.js into `~/vpe-libav`
2. `02_emsdk.sh` – install/activate emsdk 6.0.5
3. `03_prep.sh` – copy source tarballs into `build/`
4. `04_config.sh` – `node configs/mkconfig.js vpe "$(cat vpe-fragments.json)"`
5. `05_build.sh` – `make dist/libav-6.11.9.0.2-vpe.wasm.js .wasm.mjs libav-vpe.js libav-vpe.mjs`
   (stock Makefile: `OPTFLAGS=-Oz`, `--arch=emscripten`)
6. `09_copy.sh` – copy dist files + licence header

## media/libav-vpe-next

Changes against stock libav.js 6.11.9 (all in `20_mktree.sh`, `patch_subs.js`, `24_mix_setup.sh`):

- **Subtitle API** (`patch_subs.js`, source change, LGPL: shared here): adds to `funcs.json`,
  `src/b-avcodec.c`, `src/p-avcodec.in.js`: `ff_decode_subtitle_multi`, `ff_decode_subtitle_js`,
  `ff_subtitle_alloc/free`, `avsubtitle_free`, `AVCodecContext_subtitle_header(_size)`,
  `AVSubtitle_*` and `AVSubtitleRect_*` accessors.
- **Makefile variables** (build-system only): `FFARCH` (FFmpeg `--arch`, here `wasm` so
  `ARCH_WASM`/`HAVE_SIMD128` turn on FFmpeg's wasm SIMD128 HEVC idct/SAO), `FFXCFLAGS`
  (extra FFmpeg configure cflags, here `-msimd128`), `DAV1DOPT` (dav1d cflags), `LINKXTRA`
  (extra emcc link flags).
- **Fragments**: `BUILD/vpe-fragments.json` (v1 list) + `subs-fragments.json` + vvc, apv, truehd/mlp
  groups; the resulting list is `../vpe-fragments.json`; `--enable-small` appended to
  `ffmpeg-config.txt`.
- **Flags** (see `../BUILD-FLAGS.txt` for the exact values used):
  FFmpeg/zlib/link `-O3 -msimd128 -fno-vectorize -fno-slp-vectorize` (SIMD intrinsics on,
  auto-vectorisation off: it made swscale and several decoders slower);
  dav1d `-O3 -msimd128` (auto-vectorisation pays off there).
- **Asyncify trim**: `30_asyncify_list.sh` relinks once with `--profiling-funcs`, takes every
  function defined in libavcodec/libswscale/libswresample/libavfilter/dav1d/zlib that is not also
  defined in libavformat/libavutil, and passes it as `-sASYNCIFY_REMOVE=@asyncify-remove.json`.
  Those functions are never on the stack while `file_read` waits in `libavjs_wait_reader`, so they
  need no Asyncify instrumentation (smaller and faster). The list is in `../asyncify-remove.json`.

Steps (after steps 1-3 above):

```
bash 24_mix_setup.sh mixS small          # tree ~/vpe-v/mixS, patches, config (+ --enable-small)
bash 25_mix_build.sh mixS "-O3 -msimd128 -fno-vectorize -fno-slp-vectorize" "-O3 -msimd128" "-msimd128" ""
bash 30_asyncify_list.sh mixS            # -> ~/vpe-v/mixS/asyncify-remove.json
bash 50_final.sh mixS                    # final link with the list, copy to media/libav-vpe-next
```

`24_mix_setup.sh` reads `vpe-next-fragments.json`. Builds use `taskset -c 0-3 make -j4`.
Test harnesses: `vpe-test.js` (demux/decode/convert/seek), `subtest.js` (subtitles),
`wbench.js` (speed, run through `test/benchq.js`).
