'use strict';

const path = require('path');
const { inputArgs } = require('./ffmpeg');

const movInputs = new Set(['.mp4', '.mov', '.m4v']);
const fallbackMuxers = new Map([
  ['webm', '.webm'], ['avi', '.avi'], ['asf', '.wmv'],
  ['mxf', '.mxf'], ['mpegts', '.ts'], ['mpeg', '.mpg'], ['flv', '.flv'], ['ogg', '.ogv'],
]);

function containerFor(file, format) {
  const ext = path.extname(file).toLowerCase();
  const formats = format.split(',');
  if (formats.includes('mov') && movInputs.has(ext)) return ext === '.mov' ? '.mov' : '.mp4';
  return '.mp4';
}

function fallbackFor(file, format) {
  const ext = path.extname(file).toLowerCase();
  // The two demuxers share a format name, but the muxers accept different codecs.
  if (format.includes('matroska')) return ext === '.webm' ? '.webm' : '.mkv';
  return fallbackMuxers.get(format.split(',')[0]);
}

function streamsForClip(streams) {
  return {
    video: streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic),
    audio: streams.filter((s) => s.codec_type === 'audio'),
    subtitles: streams.filter((s) => s.codec_type === 'subtitle'),
  };
}

function validRange(r) {
  return r && Number.isFinite(r.a) && Number.isFinite(r.b) && r.a <= r.b
    && Number.isFinite(r.early) && r.early >= 0 && r.early <= 1;
}

// ffprobe gives source PTS; the player measures time from the first video presentation.
function selectRange(range, frames, videoStart, tick, videoEnd) {
  const { a, b, early } = range;
  if (a < -tick / 2 || b + videoStart >= videoEnd) {
    throw new Error('the mapped range falls outside the video');
  }
  // Include rounding of a source timestamp delivered through a microsecond webview clock.
  const eps = Math.max(0.000002, tick / 2);
  const target = (t) => frames.findLastIndex((f) => f.t <= videoStart + t + early + eps);
  const first = target(a), last = target(b);
  if (first < 0 || last < first) throw new Error('could not find the marked video frames');
  const start = frames[first].t;
  const tail = frames[last];
  const end = frames[last + 1]?.t ?? (tail.t + tail.duration);
  if (!(end > tail.t) || b + videoStart >= end + eps) {
    throw new Error('could not determine the end of the last marked frame');
  }
  return { first, last, start, end, startDelta: start - videoStart - a, endDelta: tail.t - videoStart - b };
}

const seconds = (value) => value.toFixed(6);

function copyArgs(file, output, { video, streams, start, seek = start, duration, exact, attachments, audio = [], subtitles = [] }) {
  const args = ['-v', 'error', '-xerror', '-nostdin', '-n'];
  // FFmpeg's input seek is relative to format start. Copy keeps the decode preroll.
  if (seek > 0) args.push('-ss', seconds(seek));
  if (exact && seek !== start) args.push('-itsoffset', seconds(seek - start));
  args.push(...inputArgs(file));
  if (exact && subtitles.length) {
    // Subtitle demux seeking can miss a cue that started before the video preroll.
    args.push('-itsoffset', seconds(-start), '-vn', '-an', ...inputArgs(file));
  }
  for (const index of [video, ...streams]) {
    args.push('-map', `${exact && subtitles.some((s) => s.index === index) ? 1 : 0}:${index}`);
  }
  if (attachments) args.push('-map', '0:t?');
  args.push('-map_chapters', '-1', '-c', 'copy', '-t', seconds(duration));
  if (exact) {
    if (subtitles.length) {
      const end = seconds(duration);
      // Clip before MOV muxing to keep the cue data and prevent an edit from moving later cues.
      args.push('-bsf:s', String.raw`noise=amount=0:drop=lte(pts+duration\,0)+gte(pts*tb\,${end}),`
        + String.raw`setts=pts=max(PTS\,0):dts=max(DTS\,0):duration=min(PTS+DURATION\,${end}/TB)-max(PTS\,0)`);
    }
    audio.forEach((track, i) => {
      if (/^pcm_(?:[su]\d+(?:le|be)?|f(?:32|64)(?:le|be))$/.test(track.codec_name)) {
        // MOV readers can decode an entire PCM packet across the edit boundary.
        // Keep the PCM encoding and cut the samples before muxing.
        args.push(`-c:a:${i}`, track.codec_name, `-filter:a:${i}`, `atrim=start=0:end=${seconds(duration)}`);
      }
    });
    args.push('-avoid_negative_ts', 'disabled', '-use_editlist', '1', '-movie_timescale', '1000000',
      '-movflags', '+faststart', '-write_tmcd', '0');
  } else args.push('-avoid_negative_ts', 'make_zero');
  return [...args, output];
}

module.exports = { containerFor, fallbackFor, streamsForClip, validRange, selectRange, copyArgs, seconds };
