'use strict';
// Layer 4 benches (test/perf/run.js). A VS Code bench is a scenario (test/vscode/scenario_list.js format)
// run in a fresh instance with the full measurements (no layer-3 relaxations: h.scenario unset);
// `env` is set in this process before the cases load (the opt-in benches export cases only then).
// A Node bench is a command that writes JSON ({json} in args is replaced by a temporary file path).

const vscode = [
  { name: 'compare-burst-startup', steps: [{ case: 'compare-burst-startup' }] },
  // Start-up per decoder path: cold, then warm opens; phases from the 'startup host' / 'webview: startup' lines.
  ...['startup-gpu', 'startup-wasm', 'startup-native', 'startup-av1-mp4', 'startup-h264-mp4', 'startup-prores-mov', 'startup-vp9-webm',
    'startup-vp9-mp4', 'startup-h264-mov', 'startup-hevc-mkv', 'startup-av1-mkv'].map((c) => ({ name: c, steps: [{ case: c }] })),
  // Memory of the extension host and webview while 4K HEVC 10-bit plays (also as an 8 GB machine).
  { name: 'memory', steps: [{ case: 'memory' }] },
  { name: 'memory-8gb', steps: [{ case: 'memory-8gb' }] },
  // Frame rates and open times of every test/media clip (GPU, WebAssembly, native), 5 s each.
  { name: 'play-fps', steps: [{ case: 'open-formats' }, { case: 'open-native' }] },
  { name: 'short-loop-fps', steps: [{ case: 'short_loop' }] },
  // Native frame sizes: fps and MB/s at 4K, and how fast frames grow on resize / zoom.
  { name: 'native-transfer', steps: [{ case: 'native-transfer' }, { case: 'native-transfer-resize' }] },
  // The invisible optimisations (docs/notes/perf-invisible.md): A/V drift after a rest; CPU and memory when idle.
  { name: 'perf-invisible', steps: [{ case: 'perf-invisible', only: '^audio-rest$' }] },
  { name: 'perf-invisible-bench', env: { VPE_PERF_BENCH: '1' }, steps: [{ case: 'perf-invisible-bench' }] },
  // CPU per process while 4K HEVC 10-bit plays natively, per ffmpeg method (docs/notes/cpu-4k.md).
  ...['default', 'cuda', 'd3d11va', 'auto'].map((v) => ({ name: `cpu-4k-${v}`, env: { VPE_CPU_BENCH: '1' }, steps: [{ case: `cpu-4k-${v}` }] })),
  // The background seek-bar preview pass (docs/notes/seek-preview.md): 4K HEVC and short 1080p H.264 playback with the
  // pass off and on; time and CPU to a full bar for 20 s / 5 min / 1 h, and the between pass on 20 s / 60 s H.264.
  ...['native', 'wasm'].map((p) => ({ name: `seek-pass-${p}`, env: { VPE_SEEK_PASS_BENCH: '1' }, steps: [{ case: `seek-pass-play-${p}` }, { case: `seek-pass-fill-${p}` }] })),
  { name: 'seek-pass-native-cpu', env: { VPE_SEEK_PASS_BENCH: '1' }, steps: [{ case: 'seek-pass-fill-native-cpu' }] },
  // H.264 through WebCodecs: the fill in the WASM worker and on the preview decoder; playback with the pass off and on.
  { name: 'seek-pass-webcodecs', env: { VPE_SEEK_PASS_BENCH: '1' }, steps: [{ case: 'seek-pass-play-webcodecs' }, { case: 'seek-pass-fill-webcodecs' }] },
  // Remote stream soak: lag and sound lead over 150 s.
  { name: 'remote-stream-soak', steps: [{ case: 'remote_stream_long' }] },
  // Host -> webview message throughput.
  { name: 'transfer-bench', env: { VPE_TRANSFER_BENCH: '1' }, steps: [{ case: 'transfer-bench' }] },
  // Memory again in fresh instances: the run-to-run spread of the memory numbers.
  { name: 'memory-again', env: { VPE_MEMORY_REPEAT: '1' }, steps: [{ case: 'memory-again' }] },
  { name: 'memory-8gb-again', env: { VPE_MEMORY_REPEAT: '1' }, steps: [{ case: 'memory-8gb-again' }] },
  // Native transfer on long real clips (a folder in VPE_TRANSFER_CLIPS, e.g. from test/media/fetch_sources.js):
  // only when that is set; each height and transport in a fresh instance.
  ...(process.env.VPE_TRANSFER_CLIPS ? ['0-auto', '0-message', '1080-auto', '1080-message'].map((v) => ({ name: `native-bench-${v}`, env: { VPE_TRANSFER_BENCH: '1' }, steps: [{ case: `native-bench-${v}` }] })) : []),
];

const node = [
  // Decode throughput of the player's routes (WebAssembly in Node, ffmpeg CPU / GPU) on test/media.
  { name: 'decode-routes', cmd: ['test/bench/run_bench.js', '--out={dir}', '--repeat=2'], out: 'results.json', timeout: 40 * 60e3 },
  // Seek-bar thumbnail worker: start, first thumbnail, hover thumbnails, memory.
  { name: 'thumbs', cmd: ['test/thumbs/bench.js', 'test/media/hevc_8_1080p.mp4', 'test/media/hevc_10_2160p.mp4', 'test/media/av1_10_1080p.mp4'], env: { JSON_OUT: '{json}' }, timeout: 10 * 60e3 },
  // The ffmpeg probe (method choice and its speeds) on the shipped clips.
  { name: 'ffmpeg-probe', cmd: ['test/perf/probe_run.js', '--json', '{json}'], timeout: 15 * 60e3 },
];

module.exports = { vscode, node };
