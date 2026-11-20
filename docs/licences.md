# Licences

- **This extension:** MIT, see [LICENSE](../LICENSE).
- **Built-in decoder:** FFmpeg 9.0.2's libraries under the LGPL 2.1 or later, built with [libav.js](https://github.com/Yahweasel/libav.js), with dav1d (BSD 2-clause) and zlib. It is a separate WebAssembly file set in `media/libav-vpe/` that you can replace with your own build. Licences, sources and the build definition: [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) and [`media/libav-vpe/LICENSE-NOTE.md`](../media/libav-vpe/LICENSE-NOTE.md).
- **Optional ffmpeg builds** downloaded by setup are LGPL on Windows and Linux (BtbN's `lgpl` builds) and GPL on macOS. They are separate programs, never bundled.
- **Test clips** in `media/probe/` are short excerpts of the film *Meridian* ([CC BY 4.0](https://creativecommons.org/licenses/by/4.0/), from [Netflix Open Content](https://opencontent.netflix.com)), tone-mapped to SDR and re-encoded; details in [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).

This software uses code of [FFmpeg](https://ffmpeg.org) licensed under the [LGPLv2.1](https://www.gnu.org/licenses/old-licenses/lgpl-2.1.html), and its source can be downloaded [here](https://ffmpeg.org/releases/ffmpeg-9.0.2.tar.xz).
