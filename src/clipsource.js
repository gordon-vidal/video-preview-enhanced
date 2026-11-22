'use strict';
// Early refusal of an exact A-B clip whose marks do not carry source timestamps (docs/notes/ab-clip-export.md).
// Live transcode re-times pictures, and a native ffmpeg that cannot report a picture's own time (an old
// build, or timestamps it did not trust) labels them by count. The page says so as soon as it is asked;
// this is the same check on the host, which also covers Compare, with a one-click way out where there is one.

const LIVE_MESSAGE = 'Video Preview: Live transcode re-times the picture, so A and B cannot be used for an exact clip. '
  + 'Switch to the original video and set A and B again.';
const NATIVE_MESSAGE = "Video Preview: this ffmpeg cannot report the picture's own times, so A and B cannot be used for an exact clip. "
  + 'Switch to the built-in decoder (setting videoPreviewEnhanced.decoder) and set A and B again.';

/**
 * jobs: [{ tile?, range }] as exportClips gets them; liveTiles: the tile numbers (0 for a single player) playing
 * through Live transcode. Null when some job can still be exported exactly (the rest are listed as ineligible
 * later); else { message, label, tiles }: label is the button (null when the host has no switch to offer), tiles
 * the Live transcode tiles to switch to the original video.
 */
function syntheticRefusal(jobs, liveTiles = [], compare = false) {
  const ranged = jobs.filter((j) => j.range);
  if (!ranged.length || !ranged.every((j) => j.range.native)) return null;
  const tiles = ranged.map((j) => j.tile ?? 0).filter((i) => liveTiles.includes(i));
  if (tiles.length) return { message: LIVE_MESSAGE, label: 'Use original video', tiles };
  return { message: NATIVE_MESSAGE, label: compare ? null : 'Switch to built-in decoder', tiles: [] };
}

module.exports = { syntheticRefusal, LIVE_MESSAGE, NATIVE_MESSAGE };
