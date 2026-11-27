'use strict';
// Layer 3 scenarios (test/vscode/scenarios.js): one VS Code instance each, grouped by user journey.
// A step runs one case from test/vscode/cases with that case's settings and environment, after the stored
// state was cleared and all editors closed. `only` / `skip` (regex on the case's result names) keep the
// results that belong here; the others moved to layer 2 (test/engine) or 4 (test/perf), see
// docs/notes/test-inventory.md. `sources` feeds --changed (test/vscode/scenario_map.js).
//
// Step: { case, only?, skip?, settings?, env?, ffmpeg?, keepState?, timeout? }

// The unified viewer (replaces the old player.js / compare.js pair and their host files).
const UNIFIED_MEDIA = ['media/player-unified.js', 'media/player-ui.js', 'media/player-ui-tiles.js', 'media/player-ui-input.js', 'media/player-ui-tools.js', 'media/player-ui-lifecycle.js', 'media/player-state.js'];
const UNIFIED_SRC = ['src/unified-viewer.js', 'src/unified-session.js', 'src/unified-html.js'];
const PLAYER = [...UNIFIED_MEDIA, 'media/debug-probe.js', 'media/controls.js', 'media/ctxmenu.js', 'media/range-drag.js', 'media/modes.js', 'media/timefmt.js', 'media/abloop.js', 'media/autoplay.js', 'media/frame-player.js', 'media/player.css', 'src/bar.js'];
const RAIL = ['media/folder-rail.js', 'media/folder-rail.css', 'src/folder-rail.js', 'src/folder-rail-html.js', ...UNIFIED_SRC];
const ENGINE_CORE = [
  'media/engine.js', 'media/codec-utils.js', 'media/decoder-boot.js', 'media/block-cache.js', 'media/packet-cache.js', 'media/gl-renderer.js',
];
const ENGINE = [...ENGINE_CORE, 'media/decoder-worker.js', 'media/pool.js', 'media/libav-vpe', 'media/membudget.js', 'media/timestretch.js', 'media/framestream.js', 'media/hdr.js'];
const HOST = ['src/extension.js', ...UNIFIED_SRC, 'src/decide.js', 'src/avi.js', 'src/rotation.js'];
const NATIVE = ['src/native.js', 'src/nativepts.js', 'src/frameserver.js', 'src/ffmpeg.js', 'src/probe.js', 'src/hwaccel.js', 'src/hardware.js', 'src/localff.js', 'src/thumbhost.js'];
const COMPARE = [
  ...UNIFIED_SRC, 'src/burst.js', 'src/comparepick.js', 'src/framelink.js',
  ...UNIFIED_MEDIA, 'media/compare-compositor.js', 'media/compare-metrics.js',
  'media/compare-debug.js', 'media/timefmt.js', 'media/compare.css', 'media/compare-grid.js', 'media/range-drag.js',
];

module.exports = [
  {
    name: 'open-formats',
    journey: 'A user without ffmpeg opens each kind of file: the right decoder (GPU for H.264 / VP8 in every container, WebAssembly for the rest), it plays, a paused seek lands',
    sources: [...HOST, ...ENGINE, ...UNIFIED_MEDIA, 'media/frame-player.js'],
    steps: [{ case: 'open-formats' }],
  },
  {
    name: 'playback',
    journey: 'GPU and WebAssembly playback, sound-only files, speed, next / previous file, rotation, resume, damaged and cut files, multichannel sound',
    sources: [...HOST, ...ENGINE, ...PLAYER],
    steps: [{ case: 'playback' }],
  },
  {
    name: 'autoplay-loop',
    journey: 'Autoplay and loop: a file starting at PTS 3600, sound longer than the picture, a sound-only loop, short loops replayed from memory',
    sources: [...ENGINE, ...PLAYER, 'src/extension.js'],
    steps: [{ case: 'playback_autoplay' }, { case: 'playback_loop' }, { case: 'short_loop' }],
  },
  {
    name: 'seeking',
    journey: 'Frame stepping, seeking, the ends of a file and the A-B loop on the GPU decoder, the frame player and the WebGL picture',
    sources: [...ENGINE, ...PLAYER, 'src/avi.js', 'src/extension.js', 'media/inspect.js'],
    steps: [{ case: 'seeking' }],
  },
  {
    name: 'inspect',
    journey: 'Go to frame / time, pixel inspector, zoom, stats, frame links, HDR tone mapping, seek-bar thumbnails, X-ray; VS Code keybindings that collide with the player keys',
    sources: ['media/inspect.js', 'media/hdr.js', 'media/xray.js', 'media/xray-worker.js', 'media/thumbs.js', 'media/thumbs-worker.js', ...PLAYER, ...ENGINE, 'src/extension.js'],
    steps: [{ case: 'inspect' }, { case: 'keyconflicts' }],
  },
  {
    name: 'scopes-export',
    journey: 'Waveform, parade, vectorscope and histogram; A-B frame export and Save Frame',
    sources: ['media/scopes.js', 'media/inspect.js', 'src/rangecmd.js', 'src/extension.js', 'src/avi.js', ...PLAYER, ...ENGINE],
    steps: [{ case: 'scopes_export' }],
  },
  {
    name: 'subtitles',
    journey: 'Picture subtitles (PGS, DVD, DVB) and embedded text subtitles with sound-track switching',
    sources: ['media/subtitles.js', 'media/tracks-menu.js', 'src/sidecars.js', ...PLAYER, ...ENGINE],
    steps: [{ case: 'subtitles' }],
  },
  {
    name: 'clip-export',
    journey: 'Lossless A–B clip export in the player and in an offset Compare with an ineligible tile',
    sources: ['src/clipexport.js', 'src/clipsource.js', 'src/nativepts.js', 'src/clipmovie.js', 'src/cliprange.js', 'src/rangecmd.js',
      ...PLAYER, ...COMPARE, ...HOST],
    steps: [{ case: 'clip_export' }, { case: 'clip_export_native' }],
  },
  {
    name: 'ui',
    journey: 'The bar and panels: accessibility, keys, panels, speed, time formats, jump sizes (panel and settings), About this video, the context menu',
    sources: [...PLAYER, 'media/ctxmenu.js', 'src/extension.js', 'media/scopes.js', 'media/inspect.js', 'package.json'],
    steps: [{ case: 'ui' }, { case: 'ui_jumps' }, { case: 'ui_jumps_settings' }, { case: 'ui_info' }, { case: 'ctxmenu' }],
  },
  {
    name: 'folder-rail',
    journey: 'The folder rail and the bar capsule: open docked, resize, browse up and back, the column menu, the edge tab, a right-click on |▶ swaps the tab with the rail state, Autoplay plays the next video once',
    sources: [...PLAYER, ...RAIL, 'src/extension.js', 'src/settings.js', 'media/compare.css'],
    steps: [{ case: 'folder-rail' }],
  },
  {
    name: 'picture-size',
    journey: 'Picture size: Fit / Fill / Stretch / 100 % from the bar button, Z, the settings page and Ctrl+wheel; a drag pans, a click still plays; compare follows together',
    sources: ['media/picture.js', 'media/inspect.js', ...PLAYER, ...COMPARE, 'src/bar.js', 'package.json'],
    steps: [{ case: 'picture_size' }, { case: 'picture_size_small' }],
  },
  {
    name: 'picture-size-native',
    journey: 'With ffmpeg: native frames grow for Fill and 100 % and wait for the next seek when back to Fit',
    sources: ['media/picture.js', 'media/inspect.js', ...ENGINE_CORE, ...NATIVE, ...UNIFIED_SRC],
    steps: [{ case: 'picture_size_native' }],
  },
  {
    name: 'compare',
    journey: 'Compare mode: entering and leaving, the bar, tiles, views, the Tools grid, PSNR / SSIM against ffmpeg',
    sources: [...COMPARE, ...PLAYER, 'media/scopes.js'],
    steps: [{ case: 'modes' }, { case: 'compare_ui' }, { case: 'compare_link' }, { case: 'compare_addmode' }, { case: 'compare_burst' }, { case: 'compare_metrics' }],
  },
  {
    name: 'multiview',
    journey: 'Play together: grids of 2-4, lockstep, offsets, the sync clock and sound, a short loop',
    sources: [...COMPARE, ...ENGINE],
    steps: [{ case: 'multiview' }, { case: 'multiview-reorder' }, { case: 'multiview-short-loop' }],
  },
  {
    name: 'multiview-transcode',
    journey: 'Compare streams two tiles, shares their bitrate cap, and switches one tile to its original video',
    sources: [...COMPARE, 'src/stream.js', 'src/stream-adapt.js', 'src/stream-buffer.js', 'src/transcode_policy.js', 'media/controls.js'],
    steps: [{ case: 'multiview-transcode' }],
  },
  {
    name: 'multiview-transcode-packets',
    journey: 'Compare on Live transcode: a paused seek and steps back into what played come from the packets each tile kept',
    sources: [...COMPARE, 'media/packet-cache.js', 'src/stream.js'],
    steps: [{ case: 'multiview-transcode-packets' }],
  },
  {
    name: 'multiview-native',
    journey: 'Play together with native ffmpeg: tile sizes, the frame server and its budget, resizing, the message fallback',
    sources: [...COMPARE, ...NATIVE, 'src/decide.js'],
    steps: [{ case: 'multiview-native' }, { case: 'multiview-native-fallback' }],
  },
  {
    name: 'multiview-large',
    journey: 'More than 4 videos: 9 then 16 tiles on the GPU and built-in decoders with one shared renderer; lockstep, offsets, clock, play, remove, add, close',
    sources: [...COMPARE, ...ENGINE],
    steps: [{ case: 'multiview-large' }],
  },
  {
    name: 'multiview-large-native',
    journey: '9 and 16 native ffmpeg tiles: frames at the cell size over WebSockets on one port, the shared budget, offsets, playing in step, a seek through a resize',
    sources: [...COMPARE, ...NATIVE, 'src/decide.js'],
    steps: [{ case: 'multiview-large-native' }],
  },
  {
    name: 'native',
    journey: 'With ffmpeg: native decoding plays, frames sized to the picture and grown on resize / zoom, the message fallback, About this video',
    sources: [...NATIVE, 'src/decide.js', 'src/extension.js', 'media/framestream.js', ...ENGINE_CORE, ...UNIFIED_MEDIA, 'media/frame-player.js'],
    steps: [
      { case: 'open-native' }, { case: 'native-transfer' }, { case: 'native-transfer-resize' }, { case: 'native-transfer-fallback' }, { case: 'ui_info_native' },
    ],
  },
  {
    name: 'invisible',
    journey: 'Work a user never notices: a hidden native tab stops ffmpeg, paused players read only about 1 s ahead, the frame loop rests while paused',
    sources: [...NATIVE, ...ENGINE_CORE, ...UNIFIED_MEDIA, 'media/membudget.js'],
    steps: [{ case: 'perf-invisible', skip: '^audio-rest$' }],
  },
  {
    name: 'restore',
    journey: 'A window reload restores the player tabs; a background tab doesn\'t decode until it is shown',
    sources: ['src/extension.js', ...NATIVE],
    steps: [{ case: 'perf-invisible', only: '^audio-rest$' }, { case: 'startup-restore' }],
  },
  {
    name: 'seek-preview',
    journey: 'The seek-bar picture: hover, drag, release on the exact frame (WebAssembly and native)',
    sources: ['media/thumbs.js', 'media/thumbs-worker.js', 'src/thumbhost.js', 'src/native.js', 'src/bar.js', ...PLAYER, ...ENGINE],
    steps: [{ case: 'seek_preview' }, { case: 'seek_preview_native' }],
  },
  {
    name: 'wheel-step',
    journey: 'Paused mouse-wheel frame steps on heavy 4K HEVC 10-bit: rapid and slow notches back and forward land on exactly the frame (built-in, native, native HDR output)',
    sources: [...UNIFIED_MEDIA, 'src/native.js', ...ENGINE],
    steps: [{ case: 'wheel_step' }, { case: 'wheel_step_native' }],
  },
  {
    name: 'hdr',
    journey: 'HDR output: the display probe, tone mapping on SDR, Dolby Vision, PQ / HLG on an HDR canvas (built-in and native 10-bit)',
    sources: ['media/hdr.js', ...ENGINE_CORE, 'src/native.js', 'src/probe.js', 'src/extension.js'],
    steps: [{ case: 'hdr_output' }, { case: 'hdr_output_forced' }, { case: 'hdr_output_forced_native' }],
  },
  {
    name: 'onboarding',
    journey: 'First video: the ffmpeg recommendation once (none with ffmpeg), the reminder for a slow 4K file, the decoder rule',
    sources: ['src/extension.js', 'src/decide.js', 'src/setup.js'],
    steps: [{ case: 'onboarding-ffmpeg' }, { case: 'onboarding' }],
  },
  {
    name: 'url',
    journey: 'Open Video URL: MP4, HLS (TS, fMP4, AES, qualities, subtitles), DRM and web pages refused, DASH and live need ffmpeg',
    sources: ['src/urlsource.js', 'src/proxy.js', 'src/extension.js', 'media/subtitles.js', ...PLAYER, ...ENGINE],
    steps: [{ case: 'url_stream' }],
  },
  {
    name: 'url-native',
    journey: 'Open Video URL with ffmpeg: HLS, DASH, live, HEVC MP4 natively; H.264 MP4 stays on the GPU',
    sources: ['src/urlsource.js', 'src/proxy.js', ...NATIVE, 'src/decide.js'],
    steps: [{ case: 'url_stream_native' }, { case: 'url_stream_native_mp4' }],
  },
  {
    name: 'remote-stream',
    journey: 'Remote windows: formats the GPU decoder can\'t play are re-encoded to H.264 by ffmpeg; seeks, scrubbing, the quality ladder, pixel tools',
    sources: ['src/remotestream.js', 'src/stream.js', 'src/stream-adapt.js', 'src/stream-buffer.js', 'src/remoteopus.js', 'src/remoteff.js', 'src/ffmpeg.js', 'src/decide.js', ...ENGINE_CORE, ...UNIFIED_MEDIA, 'media/frame-player.js'],
    steps: [{ case: 'remote_stream' }, { case: 'remote_stream_long' }, { case: 'remote_stream_size' }, { case: 'remote_stream_fallback' }],
  },
  {
    name: 'remote-stream-packets',
    journey: 'Remote windows on a slow link: a paused seek back to a place already seen, and steps back, decode from the packets the page kept',
    sources: ['media/packet-cache.js', 'src/stream.js', ...ENGINE_CORE, 'media/debug-probe.js'],
    steps: [{ case: 'remote_stream_packets' }],
  },
  {
    name: 'remote-stream-play-during-seek',
    journey: 'Play pressed while a paused seek is still loading (slow link, or the page packets): the bar keeps the target',
    sources: ['media/engine.js', 'media/player-unified.js', 'media/packet-cache.js', 'src/stream.js'],
    steps: [{ case: 'remote_stream_play_during_seek' }],
  },
  {
    name: 'remote-stream-hdr',
    journey: 'HDR over Live transcode: tone-mapped on the host (NVDEC in front on NVIDIA), a seek and a step land exactly',
    sources: ['src/stream.js', 'src/transcode_args.js', ...ENGINE_CORE],
    steps: [{ case: 'remote_stream_hdr' }],
  },
  {
    name: 'file-icons',
    journey: 'Explorer icons for the formats VS Code has none for, as Seti draws .mp4 / .avi (dark, light, zoom -1..2); .mkv still opens in the player',
    sources: ['src/extension.js', 'media/icons', 'package.json'],
    steps: [
      { case: 'file_icons' },
      ...['dark-100', 'light-100', 'dark-120', 'dark-m1', 'dark-z2'].map((t) => ({ case: `file_icons_pixels_${t}` })),
    ],
  },
];
