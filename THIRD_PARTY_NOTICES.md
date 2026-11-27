# Third-party notices

Video Preview Enhanced is MIT-licensed (see `LICENSE`). It bundles one third-party
component: a decode-only WebAssembly build of FFmpeg, made with libav.js. Everything
else in the package (`src/`, `media/*.js`, `media/*.css`) is this project's own code
under the MIT licence, with no runtime npm dependencies.

## Webview UI libraries (bundled into `media/dist/webview-ui.js`)

`media/dist/webview-ui.js` is built by `npm run build:ui` from `media/ui/` and bundles the following
MIT-licensed libraries (including their bundled transitive dependencies). They are declared as
`devDependencies` in `package.json` so `node_modules` is not shipped in the VSIX; their full
upstream copyright notices and MIT licence texts are included below.

| Package | Version | Licence | Source |
|---|---|---|---|
| `preact` | 11.2.0 | MIT | https://github.com/preactjs/preact |
| `@preact/signals` | 2.11.4 | MIT | https://github.com/preactjs/signals |
| `@preact/signals-core` | 1.14.5 | MIT | https://github.com/preactjs/signals |
| `@floating-ui/dom` | 1.8.0 | MIT | https://github.com/floating-ui/floating-ui |
| `@floating-ui/core` | 1.8.0 | MIT | https://github.com/floating-ui/floating-ui |
| `@floating-ui/utils` | 0.2.12 | MIT | https://github.com/floating-ui/floating-ui |

### Preact (`preact`)

```
The MIT License (MIT)

Copyright (c) 2015-present Jason Miller

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### Preact Signals (`@preact/signals`, `@preact/signals-core`)

```
The MIT License (MIT)

Copyright (c) 2022-present Preact Team

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### Floating UI (`@floating-ui/dom`, `@floating-ui/core`, `@floating-ui/utils`)

```
MIT License

Copyright (c) 2021-present Floating UI contributors

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

## What is bundled

All of it is in `media/libav-vpe/`. Its details are in
[`media/libav-vpe/LICENSE-NOTE.md`](media/libav-vpe/LICENSE-NOTE.md), and the full licence
texts are in [`media/libav-vpe/LICENSE-full.txt`](media/libav-vpe/LICENSE-full.txt). The
same texts are also at the top of `libav-6.11.9.0.2-vpe.wasm.js`.

| Component | Version | Licence | Source |
|---|---|---|---|
| FFmpeg: libavutil, libavformat, libavcodec, libavfilter, libswscale, libswresample | 9.0.2 | LGPL 2.1 or later | https://ffmpeg.org/releases/ffmpeg-9.0.2.tar.xz |
| libav.js (JavaScript glue and loader) | 6.11.9 | 0BSD-style permissive (text below) | https://github.com/Yahweasel/libav.js (tag v6.11.9) |
| dav1d (AV1 decoder) | 1.5.4 | BSD 2-clause | https://code.videolan.org/videolan/dav1d |
| zlib | 1.3.2 | zlib licence | https://zlib.net |
| Emscripten runtime and musl libc | Emscripten 6.0.5 | MIT | https://github.com/emscripten-core/emscripten |
| emfiberthreads (pthread stand-in for the non-threaded build) | 1.3 | ISC-style permissive | https://github.com/Yahweasel/emfiberthreads |
| IJG jrevdct (inside FFmpeg, used by MJPEG and ProRes) | - | IJG licence | part of FFmpeg |
| FFmpeg Ogg demuxer (inside FFmpeg) | - | MIT-style, see `LICENSE-full.txt` | part of FFmpeg |

FFmpeg was configured without `--enable-gpl` and without `--enable-nonfree`. The build
contains no GPL or non-free parts: no x264, x265 or libvpx, and no opencore-amr. The
AMR, Opus, Vorbis, VP8 and VP9 decoders are FFmpeg's own LGPL ones. The build has no
encoders, no muxers and no command-line tools.

This software uses code of [FFmpeg](https://ffmpeg.org) licensed under the
[LGPLv2.1](https://www.gnu.org/licenses/old-licenses/lgpl-2.1.html), and its source can be
downloaded [here](https://ffmpeg.org/releases/ffmpeg-9.0.2.tar.xz).

This software is based in part on the work of the Independent JPEG Group.

### libav.js licence

```
Copyright (C) 2019-2025 Yahweasel

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY
SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION
OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN
CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
```

The texts for FFmpeg (LGPL 2.1), zlib, the Ogg demuxer, jrevdct, dav1d, and Emscripten
and musl are in `media/libav-vpe/LICENSE-full.txt`.

## LGPL: what it asks and how this extension meets it

FFmpeg's libraries are LGPL 2.1 or later. When we distribute them in compiled form, the
LGPL asks for the following.

| The LGPL asks | How it is met |
|---|---|
| Say that the library is used and under which licence | This file, `media/libav-vpe/LICENSE-NOTE.md`, and the README's Licence section |
| Ship the licence text | `media/libav-vpe/LICENSE-full.txt` and the header of `libav-6.11.9.0.2-vpe.wasm.js`, both in the package |
| Give access to the library's source code | Links above to the exact FFmpeg 9.0.2, dav1d and zlib releases. The libav.js 6.11.9 release tarball also carries all of them under `sources/` |
| Let users replace the library with a modified version | The decoder is a separate file set (`libav-6.11.9.0.2-vpe.js`, `.wasm.js`, `.wasm.wasm`), loaded at run time by file name and never linked into the extension's code. A rebuilt libav.js with the same API can replace those files in the installed extension folder |
| Give what is needed to rebuild it | The variant definition `media/libav-vpe/vpe-fragments.json` (the libav.js `configs/mkconfig.js vpe` input), plus the component list in `LICENSE-NOTE.md`. Build with libav.js 6.11.9 and Emscripten 6.0.5 |
| Don't restrict reverse engineering for debugging such changes | The MIT licence of the extension doesn't restrict it |

To swap in your own build: build libav.js 6.11.9 with the `vpe` variant (or your own
variant with at least the same demuxers and decoders), then put your
`libav-<version>-vpe.js`, `libav-<version>-vpe.wasm.js` and `libav-<version>-vpe.wasm.wasm`
into the extension's `media/libav-vpe/` folder in place of the bundled ones. The
extension picks up the first `libav-*-vpe.js` it finds there.

## Optional ffmpeg (not bundled)

The command **Video Preview: Set Up Optional ffmpeg** can download a native ffmpeg build,
but only when you run it and choose to:

- Windows and Linux: the LGPL builds (`lgpl-shared` on Windows, `lgpl` on Linux) from
  [BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds) (GitHub releases)
- macOS: builds from [ffmpeg.martin-riedl.de](https://ffmpeg.martin-riedl.de) (GPL)

Playback only decodes, and the decoders it needs are FFmpeg's own LGPL ones plus dav1d
(BSD), so the LGPL build decodes the same as the GPL one. These builds are not part of this
extension and are not shipped with it. You can also point the extension at any ffmpeg you
already have.
The extension runs them as separate programs, and they keep their own licences. Each
download is checked against the SHA-256 that its publisher lists.

## ffmpeg test clips (shipped)

`media/probe/*.mkv` are 0.2-1 s excerpts (no sound) of the short film **Meridian** (2016),
from Netflix Open Content (https://opencontent.netflix.com), licensed under the Creative
Commons Attribution 4.0 International licence (https://creativecommons.org/licenses/by/4.0/).
Credit: "Meridian", Netflix Open Content (opencontent.netflix.com), CC BY 4.0.
Changes: frames 15000-15118 of the UHD P3/PQ TIFF master, every second frame (29.97 fps),
tone-mapped from HDR to SDR BT.709, scaled to 1080p for the 1080p clips, shortened and
re-encoded with x264, x265, SVT-AV1, libvpx and FFmpeg's ProRes encoder by
`test/media/make_media.js --probe`. The licensor does not endorse this extension. The
excerpts keep their CC BY 4.0 licence; this extension's MIT licence does not apply to them.

## Setup guide pictures (shipped)

`media/walkthrough/player.jpg` and `settings-panel.jpg` are screenshots of the player showing a frame of
**Big Buck Bunny** (2008), (c) copyright 2008, Blender Foundation / www.bigbuckbunny.org, licensed under the
Creative Commons Attribution 3.0 licence (https://creativecommons.org/licenses/by/3.0/). Changes: one frame,
shown inside the player's controls and scaled down.

The test and benchmark clips in `test/media/` (not shipped) are excerpts of Tears of Steel,
Meridian, Sparks and Big Buck Bunny; sources, licences and changes are in
[`test/media/LICENSES.md`](test/media/LICENSES.md).

## Seti video icon

`media/icons/video-light.svg` and `video-dark.svg` are the "video" glyph of the Seti UI icon font
(https://github.com/jesseweed/seti-ui, MIT licence, Copyright (c) 2014 Jesse Weed), as shipped with VS Code's
built-in Seti file icon theme, converted to SVG with its light and dark colours. They give the formats Seti has
no video icon for the same icon. Seti UI's licence:

```
The MIT License (MIT)

Copyright (c) 2014 Jesse Weed

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Development tools (not shipped)

The extension has no runtime npm dependencies and ships no `node_modules`. Development and the UI
build (`npm run build:ui`, `npm run verify:fast`) use `devDependencies` declared in `package.json`
(`esbuild`, `typescript`, static-analysis tools, and the bundled webview UI libraries listed above).
The tests need ffmpeg on PATH for reference frames, and the real-VS-Code tests (`test/vscode/`)
download a portable VS Code; neither is shipped. CI and publishing use `@vscode/vsce` and `ovsx`
through `npx`, not as dependencies.
