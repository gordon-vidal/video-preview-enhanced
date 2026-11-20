# Release screenshots

Both PNGs in `media/screenshots/` show the current simple player in portable VS Code 1.147.0.
The hidden-desktop capture script disables breadcrumbs and opens a copy of each clip from its own
temporary folder so the release images show the clip names without local paths or user names.
The captures were trimmed at the outer window edges to keep the existing 1518×1009 dimensions
and saved as indexed PNGs under 500 KB each.

| Image | Footage |
| --- | --- |
| `mkv-gpu.png` | `test/media/containers/h264_aac.mkv`, the *Big Buck Bunny* H.264/AAC excerpt |
| `hevc-builtin.png` | `test/media/hevc_10_1080p.mp4` remuxed to MKV with `ffmpeg -i test/media/hevc_10_1080p.mp4 -map 0:v:0 -c copy hevc_10_1080p.mkv`, the *Tears of Steel* HEVC Main 10 excerpt |

Both excerpts are CC BY 3.0, Blender Foundation. See [test footage credits](../../test/media/LICENSES.md).

## Manual captures

The hidden-desktop script opens one file and captures the window after a delay. It has no input for opening menus, hovering, or launching other views. Use Dark Modern and narrow the sidebar for these shots.

- **Advanced tools menu.** Click **Advanced**, then open the **⋯ Tools** menu to show where the extra controls live.
- **Hover overlays.** Hover the seek bar for a thumbnail. In Advanced mode, turn on Codec X-ray with `Shift+X` and hover a frame bar to show its details. Enable the pixel inspector and point at the picture to show its readout.
- **Compare / multi-view.** In Advanced mode, use **Compare With…** to open another clip and show the shared transport and sync controls.
- **Scopes.** In Advanced mode, press `W` to show a scope over the picture. Press `W` again to cycle through waveform, RGB parade, vectorscope, and histogram.
