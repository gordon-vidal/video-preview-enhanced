'use strict';
// Native host only. Stage clips until the copied video has been checked and omissions confirmed.
const fs = require('fs/promises');
const path = require('path');
const ff = require('./ffmpeg');
const { trimMovie } = require('./clipmovie');
const { clipFileName } = require('./rangecmd');
const { containerFor, fallbackFor, streamsForClip, validRange, selectRange, copyArgs, seconds } = require('./cliprange');

const TIMEOUT = 600000;
const PROBE_MARGIN = 2; // Drain reordered pictures and find the next presentation timestamp after B.

async function run(cmd, args, signal) {
  signal?.throwIfAborted();
  const r = await ff.run(cmd, args, TIMEOUT, signal);
  signal?.throwIfAborted();
  if (r.code !== 0 || r.stderr.trim()) {
    throw new Error(r.stderr.trim().split(/\r?\n/).slice(0, 3).join(' ') || 'Native ffmpeg did not complete');
  }
  return r.stdout;
}

async function probe(tools, file, args, signal) {
  const json = await run(tools.ffprobe, ['-v', 'error', ...args, '-of', 'json', ...ff.inputArgs(file)], signal);
  return JSON.parse(json);
}

async function videoFrames(tools, file, index, interval, signal) {
  const args = ['-select_streams', String(index), '-show_frames',
    '-show_entries', 'frame=best_effort_timestamp_time,duration_time,pkt_duration_time,key_frame'];
  if (interval) args.push('-read_intervals', interval);
  const data = await probe(tools, file, args, signal);
  return (data.frames || []).map((f) => ({
    t: Number(f.best_effort_timestamp_time), duration: Number(f.duration_time ?? f.pkt_duration_time),
    key: f.key_frame === 1,
  })).filter((f) => Number.isFinite(f.t));
}

async function inspectSource(tools, file, range, signal) {
  if (!validRange(range)) throw new Error('Set an A-B loop first with A and B');
  if (range.native) {
    throw new Error('Exact clip export is unavailable for ranges marked or mapped with native playback. '
      + 'Switch to a built-in decoder and set A and B again.');
  }
  if (!path.isAbsolute(file) || /^[/\\]{2}/.test(file) || !(await fs.stat(file)).isFile()
      || await ff.isPlaylistFile(file)) {
    throw new Error('Clip export requires a regular video file on this host');
  }
  const { streams, format } = await probe(tools, file, ['-show_streams', '-show_format'], signal);
  const { video, audio, subtitles } = streamsForClip(streams);
  if (!video) throw new Error('There is no video stream to export');
  const [num, den] = video.time_base.split('/').map(Number);
  const tick = num / den;
  const origin = Number(format.start_time) || 0;
  const declaredStart = Number(video.start_time);
  const scanStart = Number.isFinite(declaredStart) ? declaredStart : origin;
  // Some demuxers expose an earlier stream start than the first picture (e.g. AVI with B-frames).
  const head = await videoFrames(tools, file, video.index,
    `%${seconds(scanStart + PROBE_MARGIN)}`, signal);
  const videoStart = head[0]?.t;
  if (!Number.isFinite(videoStart)) throw new Error('Could not find the first video timestamp');
  const videoEnd = Number(video.duration) > 0
    ? scanStart + Number(video.duration)
    : origin + (Number(format.duration) || Infinity);
  if (range.a < -tick / 2 || range.b + videoStart >= videoEnd) {
    throw new Error('the mapped range falls outside the video');
  }
  let begin = videoStart + range.a - PROBE_MARGIN;
  const stop = seconds(videoStart + range.b + PROBE_MARGIN);
  let frames;
  try {
    frames = await videoFrames(tools, file, video.index, `${begin > origin ? seconds(begin) : ''}%${stop}`, signal);
  } catch (e) {
    signal?.throwIfAborted();
    if (video.codec_name !== 'h264' || begin <= origin) throw e;
    // A seek into an open GOP can leave the probing decoder without its earlier references.
    begin = origin;
    frames = await videoFrames(tools, file, video.index, `%${stop}`, signal);
  }
  const selected = selectRange(range, frames, videoStart, tick, videoEnd);
  return { ...selected, frames, begin, origin, tick, video, audio, subtitles, format: format.format_name };
}

// Hash decoded boundary pictures as well as checking timestamps. On CFR material a shifted
// sequence can have the right count and spacing even when the demuxer has chosen the wrong GOP.
async function boundaryHashes(tools, file, index, seek, times, signal) {
  const unique = [...new Set(times)];
  const args = ['-v', 'error', '-xerror', '-nostdin', '-copyts', '-noaccurate_seek', '-noautorotate'];
  if (seek > 0) args.push('-ss', seconds(seek));
  args.push(...ff.inputArgs(file), '-map', `0:${index}`,
    '-vf', `select='${unique.map((t) => `lt(abs(t-(${seconds(t)})),0.000003)`).join('+')}'`,
    '-frames:v', String(unique.length), ...(tools.legacy ? ['-vsync', '0'] : ['-fps_mode', 'passthrough']),
    '-f', 'framemd5', '-');
  const md5 = await run(tools.ffmpeg, args, signal);
  return md5.split(/\r?\n/).filter((line) => /^\d+,/.test(line)).map((line) => line.split(',').at(-1).trim());
}

async function verifyTracks(tools, file, output, src, copied, start, duration, signal) {
  const inputText = src.filter((s) => s.codec_type === 'subtitle');
  const outputText = copied.filter((s) => s.codec_type === 'subtitle');
  async function cues(input, track) {
    const { packets = [] } = await probe(tools, input, ['-select_streams', String(track.index),
      '-show_packets', '-show_data_hash', 'sha256', '-show_entries', 'packet=pts_time,duration_time,size,flags,data_hash'], signal);
    // Empty mov_text samples clear a cue during gaps and are regenerated by the muxer.
    return packets.filter((p) => !p.flags.includes('D') && !(track.codec_name === 'mov_text' && Number(p.size) === 2))
      .map((p) => ({ start: Number(p.pts_time), end: Number(p.pts_time) + Number(p.duration_time), hash: p.data_hash }));
  }
  for (let i = 0; i < inputText.length; i++) {
    const expected = (await cues(file, inputText[i])).filter((cue) => cue.end > start && cue.start < start + duration)
      .map((cue) => ({ start: Math.max(0, cue.start - start), end: Math.min(duration, cue.end - start), hash: cue.hash }));
    const actual = await cues(output, outputText[i]);
    const tick = (stream) => {
      const [num, den] = stream.time_base.split('/').map(Number);
      return num / den;
    };
    const eps = Math.max(0.000002, tick(inputText[i]), tick(outputText[i]));
    if (actual.length !== expected.length || actual.some((cue, j) => cue.hash !== expected[j].hash
      || !(Math.abs(cue.start - expected[j].start) <= eps && Math.abs(cue.end - expected[j].end) <= eps))) {
      throw new Error('Copied subtitle cue timing did not match the marked interval');
    }
  }
  for (const stream of copied.filter((s) => s.codec_type === 'audio')) {
    const { frames = [] } = await probe(tools, output, ['-select_streams', String(stream.index), '-show_frames',
      '-show_entries', 'frame=best_effort_timestamp_time,nb_samples'], signal);
    const rate = Number(stream.sample_rate);
    const eps = 0.5 / rate + 0.000001;
    const trackEnd = Number(stream.start_time) + Number(stream.duration);
    let last = -Infinity;
    for (const frame of frames) {
      const t = Number(frame.best_effort_timestamp_time);
      const end = t + Number(frame.nb_samples) / rate;
      if (!(t >= -eps && end <= duration + eps)) {
        throw new Error('Decoded audio samples extend outside the marked interval');
      }
      last = Math.max(last, end);
    }
    if (Number.isFinite(trackEnd) && trackEnd > eps && !(Math.abs(last - trackEnd) <= eps)) {
      throw new Error('Decoded audio samples did not match the track duration');
    }
  }
}

class ClipVideoError extends Error {}

async function makeClip(tools, file, output, source, options, signal) {
  const start = source.start - source.origin;
  try {
    return await copyClip(tools, file, output, source, start, options, signal);
  } catch (e) {
    signal?.throwIfAborted();
    if (!options.exact || source.video.codec_name !== 'h264' || !(e instanceof ClipVideoError) || start <= 0) throw e;
  }
  const { frames, first, origin } = source;
  const key = frames.findLastIndex((f, i) => i <= first && f.key);
  const previous = frames.findLast((f, i) => i < key && f.key)?.t - origin;
  // A container keyframe can be an open-GOP recovery point. If the preceding keyframe
  // needs references too, retry from the beginning, where the source must be decodable.
  const seeks = previous > 0 ? [previous, 0] : [0];
  for (const seek of seeks) {
    signal?.throwIfAborted();
    await fs.rm(output, { force: true });
    try {
      return await copyClip(tools, file, output, source, seek, options, signal);
    } catch (e) {
      if (seek === 0 || !(e instanceof ClipVideoError)) throw e;
    }
  }
}

async function copyClip(tools, file, output, source, seek, options, signal) {
  const { exact, dropAudio, dropSubtitles } = options;
  const { video, audio, subtitles, origin, tick, frames, first, last, start, end } = source;
  const kept = [...(dropAudio ? [] : audio), ...(dropSubtitles ? [] : subtitles)];
  const firstCopied = exact ? first : frames.findLastIndex((f, i) => i <= first && f.key);
  if (firstCopied < 0) throw new Error('Could not find a preceding keyframe');
  const copyStart = frames[firstCopied].t;
  const duration = end - start;
  await run(tools.ffmpeg, copyArgs(file, output, {
    video: video.index, streams: kept.map((s) => s.index), start: start - origin, seek,
    duration, exact, audio: dropAudio ? [] : audio, subtitles: dropSubtitles ? [] : subtitles,
    attachments: !exact && !dropSubtitles && source.format.includes('matroska') && path.extname(output) === '.mkv',
  }), signal);
  if (exact) await trimMovie(output, duration, seek !== start - origin);
  const { streams } = await probe(tools, output, ['-show_streams'], signal);
  const codecs = (tracks) => tracks.map((s) => `${s.codec_type}:${s.codec_name}`).sort().join(',');
  const copied = streams.filter((s) => ['video', 'audio', 'subtitle'].includes(s.codec_type));
  if (codecs(copied) !== codecs([video, ...kept])) {
    throw new Error('The output did not retain all selected streams');
  }
  const outputVideo = copied.find((s) => s.codec_type === 'video').index;
  let out;
  try {
    out = await videoFrames(tools, output, outputVideo, null, signal);
  } catch (e) {
    throw new ClipVideoError(e.message, { cause: e });
  }
  const eps = Math.max(0.000005, tick + 0.000001);
  const offset = out[0]?.t;
  let lastCopied = firstCopied - 1;
  const timelineMatches = out.length > 0 && out.every((f, i) => {
    const t = f.t - offset + copyStart;
    lastCopied++;
    // A packet-order cut may omit pictures near B. Measure those gaps along with the last picture.
    if (!exact && i > 0) {
      while (lastCopied < frames.length && frames[lastCopied].t < t - eps) lastCopied++;
    }
    return Math.abs(t - frames[lastCopied]?.t) <= eps;
  });
  if (!timelineMatches || (exact && (Math.abs(offset) > 0.000005 || out.length !== last - first + 1))) {
    throw new ClipVideoError('Decoded clip did not match the marked presentation interval');
  }
  const copiedEnd = frames[lastCopied].t;
  const referenceSeek = seek === start - origin ? source.begin - origin : seek;
  const times = [copyStart, copiedEnd];
  let originalHashes;
  try {
    originalHashes = await boundaryHashes(tools, file, video.index, referenceSeek, times, signal);
  } catch (e) {
    signal?.throwIfAborted();
    if (video.codec_name !== 'h264' || referenceSeek <= 0) throw e;
    originalHashes = await boundaryHashes(tools, file, video.index, 0, times, signal);
  }
  let clipHashes;
  try {
    clipHashes = await boundaryHashes(tools, output, outputVideo, 0, [offset, out.at(-1).t], signal);
  } catch (e) {
    throw new ClipVideoError(e.message, { cause: e });
  }
  if (originalHashes.length !== (out.length === 1 ? 1 : 2) || originalHashes.join(',') !== clipHashes.join(',')) {
    throw new ClipVideoError('Decoded clip boundary pictures did not match the source');
  }
  if (exact) await verifyTracks(tools, file, output, kept, copied, start, duration, signal);
  return {
    startDelta: copyStart - start,
    endDelta: copiedEnd - frames[last].t,
    missing: lastCopied - firstCopied + 1 - out.length,
  };
}

function deviations(result, keyframe = false) {
  const fmt = (delta, bound) => Math.abs(delta) < 0.0005 ? `${bound} exact`
    : `${bound} ${Math.abs(delta).toFixed(3)} s ${delta < 0 ? 'early' : 'late'}`;
  return `${fmt(result.startDelta, 'start')}${keyframe && result.startDelta < 0 ? ' (keyframe)' : ''}, ${fmt(result.endDelta, 'end')}`
    + (result.missing ? `, ${result.missing} intervening frame(s) omitted` : '');
}

async function publish(from, to, signal) {
  signal.throwIfAborted();
  try {
    await fs.link(from, to);
  } catch (e) {
    signal.throwIfAborted();
    if (!['EPERM', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV'].includes(e.code)) throw e;
    // Node has no portable no-replace rename. A copy could expose incomplete data,
    // and an ordinary rename could overwrite a file created by another process.
    throw new Error('This folder does not support atomic clip publication. Choose a folder that supports hard links.');
  }
  if (signal.aborted) {
    await fs.unlink(to);
    signal.throwIfAborted();
  }
}

async function exportClips({ vscode, tools, jobs, compare, defaultUri, log, announce, testFolder, testConfirm }) {
  const folder = testFolder || (await vscode.window.showOpenDialog({
    defaultUri, canSelectFolders: true, canSelectFiles: false, openLabel: 'Export here',
  }))?.[0];
  if (!folder) return;
  if (!['file', 'vscode-remote'].includes(folder.scheme)
      || (folder.scheme === 'vscode-remote' && folder.authority !== defaultUri.authority)) {
    throw new Error('Choose an export folder on the video’s extension host');
  }
  const info = (message) => {
    log(message);
    announce(message);
    vscode.window.showInformationMessage(message);
  };
  await vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification, title: 'Export A–B video', cancellable: true,
  }, async (progress, token) => {
    const ctl = new AbortController();
    const sub = token.onCancellationRequested(() => ctl.abort());
    const signal = ctl.signal;
    let stage;
    const ready = [], skipped = [], written = [];
    const syncStarts = new Set();
    const confirm = async (title, detail, action) => {
      signal.throwIfAborted();
      log(`${title} ${detail}`);
      const answer = testConfirm ? action : await vscode.window.showWarningMessage(title, { modal: true, detail }, action);
      signal.throwIfAborted();
      return answer === action;
    };
    try {
      if (token.isCancellationRequested) ctl.abort();
      signal.throwIfAborted();
      stage = await fs.mkdtemp(path.join(folder.fsPath, '.vpe-clip-'));
      for (const job of jobs) {
        const { uri, range, letter } = job;
        const file = uri.fsPath;
        const basename = path.parse(file).name;
        const label = letter ? `${letter} · ${basename}` : basename;
        progress.report({ message: label });
        try {
          const src = await inspectSource(tools, file, range, signal);
          const ext = containerFor(file, src.format);
          const exact = { exact: true };
          const attempt = async (extension, options) => {
            const name = clipFileName(basename, extension, letter);
            const tmp = path.join(stage, name);
            try {
              const result = await makeClip(tools, file, tmp, src, options, signal);
              const alignment = deviations(src);
              const detail = deviations(result, !options.exact)
                + (compare && alignment !== 'start exact, end exact' ? `; sync rounding: ${alignment}` : '');
              return { tmp, name, detail, syncStart: Math.round(src.startDelta * 1000) };
            } catch (e) {
              await fs.rm(tmp, { force: true });
              throw e;
            }
          };
          try {
            ready.push(await attempt(ext, exact));
          } catch (e) {
            signal.throwIfAborted();
            if (compare) throw e;
            const tracks = [...src.audio, ...src.subtitles].map((s) =>
              `#${s.index} ${s.codec_type} (${s.codec_name})`).join(', ');
            const fallback = fallbackFor(file, src.format);
            const picks = [];
            if (src.audio.length) picks.push({ label: 'Drop audio', dropAudio: true, exact: true });
            if (src.subtitles.length) picks.push({ label: 'Drop subtitles', dropSubtitles: true, exact: true });
            if (src.audio.length && src.subtitles.length) {
              picks.push({ label: 'Drop audio and subtitles', dropAudio: true, dropSubtitles: true, exact: true });
            }
            if (fallback) picks.push({ label: `Try a keyframe cut (${fallback})`, exact: false });
            if (!picks.length) throw e;
            const choice = await vscode.window.showQuickPick(picks, {
              title: 'The exact stream copy could not be made', placeHolder: `${e.message} ${tracks}`,
            });
            signal.throwIfAborted();
            if (!choice) return;
            const clip = await attempt(choice.exact ? ext : fallback, choice);
            if (!choice.exact && !await confirm('Export this keyframe cut?', clip.detail, 'Export clip')) return;
            if (choice.dropAudio || choice.dropSubtitles) clip.detail += `; ${choice.label.toLowerCase()}`;
            ready.push(clip);
          }
        } catch (e) {
          signal.throwIfAborted();
          skipped.push(`${label}: ${e.message}`);
        }
      }
      if (compare && ready.length && skipped.length
          && !await confirm('Export only the eligible Compare tiles?', skipped.join('\n'), 'Export eligible clips')) return;
      for (const clip of ready) {
        signal.throwIfAborted();
        try {
          await publish(clip.tmp, path.join(folder.fsPath, clip.name), signal);
          written.push(`${clip.name}: ${clip.detail}`);
          syncStarts.add(clip.syncStart);
        } catch (e) {
          signal.throwIfAborted();
          skipped.push(`${clip.name}: ${e.code === 'EEXIST' ? 'a file with this name already exists' : e.message}`);
        }
      }
      signal.throwIfAborted();
      const sync = compare && syncStarts.size > 1 ? ['Time zero differs across clips because of source frame rounding.'] : [];
      info([`A–B export to ${folder.fsPath}`, ...written, ...sync, ...skipped.map((s) => `Skipped ${s}`)].join('\n'));
    } catch (e) {
      if (!signal.aborted) throw e;
      info(['A–B export cancelled', ...written].join('\n'));
    } finally {
      sub.dispose();
      if (stage) await fs.rm(stage, { recursive: true, force: true, maxRetries: 5 });
    }
  });
}

module.exports = { exportClips, inspectSource, makeClip, publish };
