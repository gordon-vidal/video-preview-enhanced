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

/**
 * Compare's export jobs from the page's per-tile ranges ({ clipId, range } from media/player-ui-tools.js
 * compareClipRanges): one per session clip in display order, lettered A, B, ... like the tiles, each with the range
 * the page measured for that clip. A clip the page sent no valid range for gets no job; ids the session does not
 * show are ignored (the page names clips, never paths).
 * @param {Array<{ id: string, uri: any }>} clips the session's clips in display order
 * @param {unknown} ranges
 * @param {string[]} letters
 * @returns {Array<{ uri: any, letter: string, tile: number, range: { a: number, b: number, early: number, native?: boolean } }>}
 */
function compareClipJobs(clips, ranges, letters) {
  const list = Array.isArray(ranges) ? ranges : [];
  /** @type {Array<{ uri: any, letter: string, tile: number, range: { a: number, b: number, early: number, native?: boolean } }>} */
  const jobs = [];
  clips.forEach((c, tile) => {
    const e = list.find((x) => x && typeof x === 'object' && x.clipId === c.id);
    const r = e && e.range;
    if (!r || typeof r.a !== 'number' || typeof r.b !== 'number' || !Number.isFinite(r.a) || !Number.isFinite(r.b) || r.b < r.a) return;
    const early = typeof r.early === 'number' && Number.isFinite(r.early) && r.early >= 0 ? r.early : 0;
    jobs.push({ uri: c.uri, letter: letters[tile] || String(tile + 1), tile, range: { a: r.a, b: r.b, early, ...(r.native ? { native: true } : {}) } });
  });
  return jobs;
}

module.exports = { syntheticRefusal, compareClipJobs, LIVE_MESSAGE, NATIVE_MESSAGE };
