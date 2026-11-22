# Native ffmpeg: the file's own picture times

Status: implemented (A–B exact clip export). Product behaviour: [features.md](../features.md).

## Problem

Native ffmpeg resampled the video to the probed frame rate (`-fps_mode cfr -r <fps>`), so the webview
could only label picture *i* as `base + i / fps`. For an exact A–B clip the host needs the file's own
timestamp of the picture on screen: on variable-frame-rate video, after an accurate seek that lands on
the following picture, or with a non-zero start time the slot label is not the source time. Exact export
therefore refused every mark set on native playback, which includes the HEVC, AV1 and ProRes files that
the built-in decoders play slowly or not at all.

## Decision

- ffmpeg passes pictures through (`-fps_mode passthrough`, `-copyts`) and prints each picture's `pts` on a
  side pipe (fd 4) with `metadata=mode=print:direct=1` at the end of the filter chain. `direct` matters: without it
  the lines arrive only when a 32 KB buffer fills. `showinfo` would need `-v info`, which buries real errors.
- The host (`src/nativepts.js`, `src/native.js`) pairs pictures with stamps (both in decode order, count-checked),
  converts ticks with the stream's time base (the printed `pts_time` has six significant digits and only guards
  against a changed time base) and makes the constant-rate slots itself: the first picture of a run takes slot 0,
  later ones the slot nearest their time, a picture on a filled slot is dropped, a gap holds the previous picture.
  This is what `cfr` did, so pacing, seeks and stepping in the webview are unchanged.
- The time of a picture relative to the first picture (`src`) goes to the webview in the frame header's former
  reserved word (microseconds from `t`; the header stays 40 bytes) or as `src` in the message fallback.
  The engine keeps it as `srcT`; `shownMarkTime()` gives it to A/B marks. Marks therefore carry source time
  while looping and stepping still use slots.
- The origin is the first picture of a run that starts at 0; until one has shown, the stream's `start_time`.
- No stamps (ffmpeg before 5.1, no time base in the probe, stamps out of step): the old `cfr` path, pictures
  flagged `nativeTimestamp`, and exact export refuses their marks.

## Live transcode

`EncodedStream` re-times pictures, so its marks stay ineligible. The refusal is early (a notice in the
player when A or B is set, again when the clip is asked for; a warning from the host for Compare) with a
one-click switch: **Use original video** (all transcoded tiles in Compare), or **Switch to built-in decoder**
for the old-ffmpeg case in the single player.

## Cost

Per picture: one 35-byte line on a pipe and two small queues; no extra copy of the picture. A held picture
is the same buffer list sent again. Audio is unchanged (`-copyts` does not alter the sample count).
