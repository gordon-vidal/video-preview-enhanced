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
  const begin = videoStart + range.a - PROBE_MARGIN;
  const interval = `${begin > origin ? seconds(begin) : ''}%${seconds(videoStart + range.b + PROBE_MARGIN)}`;
  const frames = await videoFrames(tools, file, video.index, interval, signal);
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

async function makeClip(tools, file, output, source, options, signal) {
  const { exact, dropAudio, dropSubtitles } = options;
  const { video, audio, subtitles, origin, tick, frames, first, last, start, end } = source;
  const kept = [...(dropAudio ? [] : audio), ...(dropSubtitles ? [] : subtitles)];
  const firstCopied = exact ? first : frames.findLastIndex((f, i) => i <= first && f.key);
  if (firstCopied < 0) throw new Error('Could not find a preceding keyframe');
  const copyStart = frames[firstCopied].t;
  const duration = end - start;
  await run(tools.ffmpeg, copyArgs(file, output, {
    video: video.index, streams: kept.map((s) => s.index), start: start - origin,
    duration, exact,
    attachments: !exact && !dropSubtitles && source.format.includes('matroska') && path.extname(output) === '.mkv',
  }), signal);
  if (exact) await trimMovie(output, duration);
  const { streams } = await probe(tools, output, ['-show_streams'], signal);
  const codecs = (tracks) => tracks.map((s) => `${s.codec_type}:${s.codec_name}`).sort().join(',');
  const copied = streams.filter((s) => ['video', 'audio', 'subtitle'].includes(s.codec_type));
  if (codecs(copied) !== codecs([video, ...kept])) {
    throw new Error('The output did not retain all selected streams');
  }
  const outputVideo = copied.find((s) => s.codec_type === 'video').index;
  const out = await videoFrames(tools, output, outputVideo, null, signal);
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
    throw new Error('Decoded clip did not match the marked presentation interval');
  }
  const copiedEnd = frames[lastCopied].t;
  const originalHashes = await boundaryHashes(tools, file, video.index, source.begin - origin,
    [copyStart, copiedEnd], signal);
  const clipHashes = await boundaryHashes(tools, output, outputVideo, 0, [offset, out.at(-1).t], signal);
  if (originalHashes.length !== (out.length === 1 ? 1 : 2) || originalHashes.join(',') !== clipHashes.join(',')) {
    throw new Error('Decoded clip boundary pictures did not match the source');
  }
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
