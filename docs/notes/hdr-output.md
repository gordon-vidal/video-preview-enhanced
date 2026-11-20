# HDR output on HDR displays

Until 0.6, HDR10 (PQ) and HLG video was always tone-mapped to SDR in the WebGL shader
(BT.2390, 203 nits as SDR white). MoviPlayer shows HDR10, HLG and Dolby Vision profile 8
as HDR "on supported displays". This note records what VS Code's webview offers for HDR
output, the design, and the tests.

## What VS Code 1.147 offers (measured)

Probed from the player page in the pinned portable VS Code 1.147.0 (Electron 43.8.9,
Chrome 150.0.7871.250) on Windows 10, RTX 4070, with the hidden-desktop runner
(`test/vscode/cases/hdr_output.js`, result `probe`; the probe is `VpeHdr.probe()` in
`media/hdr.js`, debug hook `hdrcaps`).

| Question | Answer on this machine |
|---|---|
| `matchMedia('(dynamic-range: high)')` | false (the hidden desktop; the desktop monitor is SDR too) |
| `(video-dynamic-range: high)` | false |
| `(color-gamut: …)` | srgb only |
| `screen.colorDepth` | 24 |
| `screen.highDynamicRangeHeadroom` / `screen.isHighDynamicRange` | not present |
| WebGPU in the webview (an iframe) | **yes**: `navigator.gpu`, adapter nvidia / lovelace (not the fallback adapter), device created. `document.featurePolicy.allowsFeature('webgpu')` says false, but that name isn't a policy feature in this Chromium: nothing blocks it. |
| `navigator.gpu.getPreferredCanvasFormat()` | `bgra8unorm` |
| WebGPU canvas `rgba16float` + `colorSpace: 'display-p3'` + `toneMapping: { mode: 'extended' }` | **accepted**; `getConfiguration()` returns all three (Chromium's CanvasHDR) |
| Adapter features of interest | `shader-f16`, `texture-formats-tier1`, `texture-formats-tier2`, `rg11b10ufloat-renderable` |
| WebGL 2 `drawingBufferStorage(RGBA16F)` | yes (`drawingBufferFormat` 0x881A) |
| WebGL 2 `drawingBufferColorSpace = 'display-p3'` | yes |
| WebGL 2 `drawingBufferToneMapping` | **no** (so a float16 WebGL canvas is still clamped to SDR on screen) |
| `HTMLCanvasElement.configureHighDynamicRange` | no |
| 2D canvas `{ colorSpace: 'display-p3', colorType: 'float16' }` | accepted |
| `crossOriginIsolated` | false (no SharedArrayBuffer, as known) |

So the only HDR output path in a VS Code webview is a **WebGPU canvas with extended tone
mapping**. WebGL alone cannot show values above SDR white.

The probe cannot tell whether HDR really reaches the screen: that needs an HDR display with
Windows "Use HDR" on, which this machine doesn't have. Chromium shows an extended-range
WebGPU canvas brighter than SDR white on such displays (Chrome 129+; this is the same
code), and only then does `(dynamic-range: high)` match. The player decides at run time.

## Design

- **When:** `videoPreviewEnhanced.hdrOutput` is `auto` (default) and `(dynamic-range: high)`
  matches and a WebGPU device with an extended-range `rgba16float` canvas works, and the video
  is PQ or HLG. Otherwise (setting `off`, SDR display, no WebGPU) the picture is tone-mapped
  as before. On an SDR display nothing new runs: the media query answers at once, WebGPU is
  never touched, the native 'open' message is the same, and the WebGL shader is the 0.6 source
  (`GLRenderer` only gained a `twin` hook that is null there).
  Compare / multi-view pages don't use HDR output (no setting passed).
- **How (`media/hdr.js`, `GLRenderer` in `media/engine.js`):**
  1. The player's WebGL canvas keeps drawing the tone-mapped SDR picture. The pixel
     inspector, scopes, thumbnails, frame export and the test hooks read it, unchanged.
  2. `VpeHdr.Output` (WebGPU) gets the same decoded picture from `GLRenderer.drawYuv`: the YUV
     planes are uploaded again (`r8uint` / `r16uint` textures, bilinear filtering by hand in the
     shader, like WebGL's LINEAR/CLAMP_TO_EDGE), converted to R'G'B' with the same matrix and
     levels (`yuvParams`, exact n-bit levels for 10-bit HDR), then in WGSL
     - PQ: ST 2084 EOTF to display nits;
     - HLG: BT.2100 inverse OETF and the OOTF of a 1000-nit display (gamma 1.2), so 75 %
       signal is 203 nits (BT.2408 reference white);
     - BT.2020 → Display P3 primaries (BT.709 → P3 for the rare BT.709-tagged HDR), in
       linear light;
     - divided by 203 nits, so reference white is 1.0 = the display's SDR white and 1000 nits
       is 4.93 (extended range; values below 0 stay for colours outside P3, as in scRGB);
     - encoded with the sRGB curve extended to the whole real line (both predefined canvas
       colour spaces use the sRGB transfer).
  3. The result is drawn into an `rgba16float` / `display-p3` / `toneMapping: extended` canvas
     laid exactly over the player's canvas (same box, zoom/pan followed, `pointer-events: none`,
     so input still reaches the canvas below). A failing WebGPU draw turns HDR output off for
     that player; the SDR picture underneath stays.
  - **Why not WebGL plus a copy:** the first design drew the HDR values with the WebGL shader
    into a float16 Display P3 drawing buffer and copied it to WebGPU with
    `copyExternalImageToTexture`. Measured in VS Code 1.147 (probe `glCopy`): a buffer cleared to
    (2.0, 0.5, −0.25) arrives as (1, 0.498, 0), i.e. clamped to 0..1 and quantised to 8 bits.
    (`readPixels(FLOAT)` on that default framebuffer returned zeros too.) So the conversion runs
    in WGSL and the planes are uploaded twice in HDR output (4K 10-bit: ~25 MB more per frame).
  No content-peak tone mapping is done in HDR output: the display (Windows' compositor)
  clips or maps what is above its own peak. The content peak (MaxCLL / mastering display)
  is still used for the SDR path.
- **Native ffmpeg:** when the page shows HDR, its 'open' says `hdr: true`; for PQ/HLG video
  ffmpeg then sends `yuv420p10le` (two bytes per sample, `streams` carries `depth: 10`) through
  the CPU scaler (the GPU 10→8-bit filters are skipped). To keep the bytes per frame of the
  8-bit budget, the height cap is divided by √2 (frame server 2160 → 1526, messages 1080 → 762).
  An ffmpeg started before the page (8-bit) is restarted at 10-bit.
- **Labels:** the info overlay shows "HDR PQ (HDR output)" or "HDR PQ (HDR tone-mapped to
  SDR)"; the stats overlay's HDR row says "HDR output (Display P3, 203 nits = SDR white)" or
  "HDR tone-mapped to SDR … (why)".

## Dolby Vision and HDR10+

- The DV configuration record (MP4 `dvcC`/`dvvC`, MKV block addition mapping) is read by both
  decoders: libav's coded side data 29 (`AV_PKT_DATA_DOVI_CONF`) in the built-in decoder, the
  ffprobe `side_data_list` "DOVI configuration record" for native ffmpeg.
- Profile 8.1 (base layer compatibility 1) plays as HDR10, 8.4 (4) as HLG, 8.2 (2) as SDR,
  profile 7 (6) as its HDR10 base layer. The RPU (dynamic reshaping metadata) is ignored, as
  in every player without Dolby's decoder. The label adds "Dolby Vision 8.1 (HDR10 base layer)".
- Profile 5 (and any record with compatibility 0) has no such base layer: its IPT-PQ-c2
  picture shows wrong colours without the RPU. The player shows "Dolby Vision profile 5 isn't
  supported." with an explanation instead of a picture.
- HDR10+ dynamic metadata (SEI / T.35) is ignored: HDR10+ video is PQ and plays as HDR10.
- Test files: `test/zoo/make_dv.js` adds a DV configuration box to an HEVC MP4 (no RPU), so
  detection and base-layer playback are tested without a Dolby encoder.

## Tests

- `node test/host/hdr_math_test.js`: PQ against ST 2084 / BT.2408 code values (100, 203, 1000
  nits; 203 nits = 10-bit code 573), round trips; HLG inverse OETF (0.5 → 1/12), 75 % = 203 nits
  and 100 % = 1000 nits on a 1000-nit display, OOTF keeps ratios; BT.2020 → BT.709 / P3 and
  BT.709 → P3 matrices derived from the chromaticities (to 2e-7); extended range (203 nits →
  1.0, 1000 nits → 1.9952, negatives kept); the WebGPU path's YUV levels (10-bit black, white,
  PQ grey, red); the auto/off/forced decision; Dolby Vision profile/compatibility mapping.
- `node test/host/native_hdr_test.js` (real ffmpeg): with `hdr` in 'open', PQ video comes as
  yuv420p10le at 1/√2 of the cap, byte-identical to ffmpeg's own scale; without it, or for SDR
  video, 8-bit as before; ffprobe's DV record for 8.1 and 5.
- `test/vscode/cases/hdr_output.js` (real VS Code 1.147, hidden desktop, SDR display):
  - `probe`: the table above.
  - `sdr`: the 4K PQ clip on this SDR display: "(HDR tone-mapped to SDR)", tone mapping in the
    WebGL shader (tf 1), no HDR canvas, log "the display is SDR". `case/inspect/hdr/*` (tone
    mapping vs ffmpeg's zscale reference) still pass with the same worst errors as on main
    (PQ 0, HLG 6, H.264 PQ 1 code): the SDR picture is unchanged.
  - `dv/dv81`, `dv/dv84`: Dolby Vision 8.1 / 8.4 pattern files play as HDR10 / HLG (labels
    "Dolby Vision 8.1 (HDR10 base layer)"); `dv/dv5`: the profile 5 message.
  - `hdr_output_forced*` (`VPE_HDR_FORCE=1`, test only): the HDR path on this SDR display, in
    the built-in decoder and with native ffmpeg (10-bit frames). The 24 patches of the PQ and
    HLG patterns (known nits, BT.709 and BT.2020 colours) read back from the output (the last
    picture drawn again into an rgba16float texture): worst 1.11 % of the patch's light (PQ, at
    magenta) and 0.76 % (HLG); grey ramp within 0.0055 of the encoded value (203 nits reads
    1.001, 1000 nits 1.998 for 1.9952, 5 nits 0.1702 for 0.1704); BT.2020 red outside P3 keeps
    its negative green (−0.2834). The page's canvas keeps the tone-mapped SDR picture; the stats
    overlay says "HDR output".
  - The 4K PQ and HLG clips in `test/media` play 3 s in HDR output without errors: 47 / 57
    frames presented in the built-in decoder (it decodes 4K HEVC 10-bit slower than real time),
    90 / 81 with native ffmpeg at 2712×1526 10-bit (about 27–30 fps).
  - Run: `node test/benchq.js node test/vscode/run.js --quick --grep "^case/(hdr_output|inspect)" --sub "^(hdr|probe|sdr|dv|pattern|play)"`: 19/19.

## Not done / open

- Not seen on a real HDR display (none here). What to check there: the picture is brighter
  than SDR white in highlights, the overlay sits exactly on the video when zooming and panning,
  and `(dynamic-range: high)` matches with "Use HDR" on.
- The decision is made per opened video: turning Windows HDR on or moving VS Code to another
  display needs the video reopened (a `matchMedia` change listener could switch live).
- HDR output uploads the planes twice (WebGL for the SDR canvas the tools read, WebGPU for the
  output). Not measured on an HDR machine; on this desktop 4K native HDR played ~27–30 fps at
  2712×1526.
- No display-peak tone mapping: values above the display's peak are left to Windows.
  `screen.highDynamicRangeHeadroom` is not exposed in this Chromium.
- WebCodecs HDR (H.264 PQ) still goes through the built-in decoder, as before.
- Compare / multi-view always tone-maps.
