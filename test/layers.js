'use strict';
// Which test files make up layers 1 (unit) and 2 (engine); docs/TESTING.md has the strategy.
// Layer 3 is test/vscode/scenarios.js, layer 4 test/perf/run.js.
//
// An entry: { file, args?: [...], needs?: ['ffmpeg'], timeout?: ms, sources?: [...] }.
// `sources` (repo-relative files or folders) feeds --changed; without it the runner reads the
// test file for the src/ and media/ files it names. Paths are relative to the repo root.
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const rel = (...p) => path.join(...p).replace(/\\/g, '/');

// ---- layer 1: pure logic, seconds -------------------------------------------------------
const hostTests = fs.readdirSync(path.join(__dirname, 'host')).filter((f) => f.endsWith('_test.js')).sort();
const HOST_ARGS = {
  // Tests that check files given on the command line: the generated case clips.
  'avi_scan_test.js': ['test/media/cases/s_mjpeg.avi', 'test/media/cases/s_xvid.avi', 'test/media/containers/h264_aac.avi'],
  'wav_parts_test.js': ['test/media/cases/s_mjpeg.avi'],
};
const HOST_MEDIA = { 'avi_scan_test.js': ['s_mjpeg.avi', 's_xvid.avi'], 'wav_parts_test.js': ['s_mjpeg.avi'] };
// Time budgets above the default 60 s. remotestream encodes and decodes 200 s clips with ffmpeg: 26-36 s on
// the Linux runner, 53 s on the Windows one beside three other tests, so 60 s timed it out now and then.
const HOST_TIMEOUT = { 'remotestream_test.js': 180000 };

const unit = [
  ...hostTests.map((f) => ({ file: rel('test/host', f), args: HOST_ARGS[f], media: HOST_MEDIA[f], timeout: HOST_TIMEOUT[f] })),
  { file: 'test/engine/unit.js', sources: ['media/engine.js', 'media/pool.js', 'media/timestretch.js', 'media/membudget.js', 'media/decoder-worker.js'] },
  { file: 'test/inspect/inspect_test.js', sources: ['media/inspect.js'] },
  { file: 'test/subtitles/run.js', sources: ['media/subtitles.js'] },
  { file: 'test/subtitles/sidecars.js', sources: ['src/sidecars.js'] },
  { file: 'test/timestretch/run.js', sources: ['media/timestretch.js'] },
  { file: 'test/unit/abloop_test.js', sources: ['media/abloop.js', 'media/player.js'] },
  { file: 'test/unit/timefmt_test.js', sources: ['media/timefmt.js', 'media/player.js'] },
  { file: 'test/avi_test.js', args: ['test/media/cases/s_mjpeg.avi'], media: ['s_mjpeg.avi'], needs: ['ffmpeg'], sources: ['src/avi.js'] },
].filter((e) => fs.existsSync(path.join(ROOT, e.file)));

// ---- layer 2: the WebAssembly decoders in Node, about a minute ----------------------------
const ENGINE_SRC = ['media/engine.js', 'media/decoder-worker.js', 'media/pool.js', 'media/libav-vpe', 'media/membudget.js', 'media/timestretch.js', 'media/abloop.js', 'test/engine/harness.js', 'test/lib/frames.js'];
const engine = [
  // Frame-exact seeking and stepping (frames_*) and every format of the test media (formats_*) through
  // media/engine.js (the product's player), one file per clip set so they run in parallel.
  ...fs.readdirSync(path.join(__dirname, 'engine')).filter((f) => /^(frames|formats)_\w+\.js$/.test(f) && !/_lib\.js$/.test(f)).sort()
    .map((f) => ({ file: rel('test/engine', f), needs: ['ffmpeg'], timeout: 240000, sources: ENGINE_SRC })),
  { file: 'test/tracks/run.js', needs: ['ffmpeg'], timeout: 240000, sources: ['media/decoder-worker.js', 'media/pool.js', 'media/libav-vpe', 'test/tracks'] },
  { file: 'test/tracks/engine_smoke.js', needs: ['ffmpeg'], timeout: 120000, sources: [...ENGINE_SRC, 'test/tracks'] },
  { file: 'test/bitmapsubs/run.js', needs: ['ffmpeg'], sources: ['media/subtitles.js', 'media/decoder-worker.js', 'media/libav-vpe'] },
  { file: 'test/xray/index_test.js', needs: ['ffmpeg'], media: ['s_h264.mp4', 's_hevc.mp4', 's_vp9.webm', 's_mpeg2.mpg'], args: ['--check', '--order=both', 'test/media/cases/s_h264.mp4', 'test/media/cases/s_hevc.mp4', 'test/media/cases/s_vp9.webm', 'test/media/cases/s_mpeg2.mpg'], sources: ['media/xray-worker.js', 'media/libav-vpe'] },
  { file: 'test/pool/harness.js', needs: ['ffmpeg'], media: ['s_hevc.mp4'], args: ['--check', '--seek', 'test/media/cases/s_hevc.mp4', 'test/media/hevc_8_1080p.mp4'], timeout: 120000, sources: ['media/pool.js', 'media/decoder-worker.js', 'media/libav-vpe'] },
  { file: 'test/thumbs/service.js', needs: ['ffmpeg'], media: ['s_hevc.mp4'], args: ['test/media/cases/s_hevc.mp4'], sources: ['media/thumbs.js', 'media/thumbs-worker.js', 'media/libav-vpe'] },
].filter((e) => fs.existsSync(path.join(ROOT, e.file)));

module.exports = { unit, engine, ROOT };
