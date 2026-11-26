'use strict';
// Compare's per-tile ⓘ details card (media/compare-grid.js statsCloseHtml / toggleStats, media/compare.js) and
// why a 5-video Compare over Remote-SSH can mix Live transcode and WebCodecs tiles (src/transcode_policy.js).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Grid = require('../../media/compare-grid');
const policy = require('../../src/transcode_policy');

const ROOT = path.resolve(__dirname, '..', '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

// ---- the card's × ----
{
  const html = Grid.statsCloseHtml(3, 'B', '×');
  assert.match(html, /^<button class="tile-stats-close" type="button"/);
  // It reuses the pill ⓘ's action and tile, so one click handler closes the card.
  assert.match(html, /data-act="info" data-i="3"/);
  assert.match(html, /aria-label="Close details for B"/);
  assert.match(html, /title="Close details"/);
  assert.match(html, />×<\/button>$/);
}
{
  const ids = new Set();
  assert.strictEqual(Grid.toggleStats(ids, 2), true, 'ⓘ opens the card');
  assert.deepStrictEqual([...ids], [2]);
  assert.strictEqual(Grid.toggleStats(ids, 4), true);
  assert.strictEqual(Grid.toggleStats(ids, 2), false, '× (same action) closes only that tile');
  assert.deepStrictEqual([...ids], [4]);
}
{
  const js = read('media/compare.js');
  // The card is rendered with the × first, and the click handler toggles through the shared helper.
  assert.match(js, /statsEl\.innerHTML = Grid\.statsCloseHtml\(i, tileLabel\(i\), ICONS\.close\)/);
  assert.match(js, /case 'info':[\s\S]{0,200}Grid\.toggleStats\(statsIds, i\)/);
  // A press on the × must not start a pan or tile drag.
  assert.match(js, /closest\('[^']*\.tile-stats-close[^']*'\)\) return;/);
  // The pill ⓘ still reports its state.
  assert.match(js, /data-act="info" data-i="\$\{i\}" aria-label="Toggle details for \$\{k\}" aria-pressed="\$\{showStats\}"/);
  const css = read('media/compare.css');
  // The card ignores the pointer; its × must take clicks.
  assert.match(css, /\.tile-stats \{[^}]*pointer-events: none/);
  assert.match(css, /\.tile-stats-close \{[^}]*position: absolute;[^}]*pointer-events: auto/);
}

// ---- 5 tiles over Remote-SSH, transcode Auto: each tile decides on its own clip ----
{
  const h264 = (height, mbps) => ({ codec: 'h264', pixFmt: 'yuv420p', width: Math.round(height * 16 / 9), height, bitRate: mbps * 1e6, fps: 30 });
  const clips = [
    { codec: 'hevc', pixFmt: 'yuv420p', width: 1920, height: 1080, bitRate: 8e6, fps: 30 }, // WebCodecs cannot play it
    h264(1080, 4), h264(720, 2), h264(1080, 5), h264(480, 1), // low-bitrate 8-bit H.264
  ];
  // compare.js chooseNative: the same cell height (stage / rows) for every tile.
  const viewHeight = 1000 / 2;
  const decide = (mode, v) => policy.shouldTranscodeOnOpen({ mode, remote: 'ssh-remote', video: v, compare: true, viewHeight });
  assert.deepStrictEqual(clips.map((v) => decide('auto', v).action), ['stream', 'skip', 'skip', 'skip', 'skip'],
    'Auto: only the clip WebCodecs cannot play (or a high-bitrate H.264) goes through Live transcode');
  assert.match(decide('auto', clips[1]).reason, /plays directly on WebCodecs/);
  // The same low-bitrate clips do qualify when they are heavy for the link or the cell.
  assert.strictEqual(decide('auto', h264(1080, 13)).action, 'stream', 'over 12 Mb/s');
  assert.strictEqual(decide('auto', h264(1080, 7)).action, 'stream', 'over 6 Mb/s and shown 1.3x smaller');
  // Over a remote link Always still means "files that qualify" (package.json enumDescriptions), unlike a local
  // Compare where Always streams every tile: pinned here so a change is a deliberate policy decision.
  assert.deepStrictEqual(clips.map((v) => decide('always', v).action), ['stream', 'skip', 'skip', 'skip', 'skip']);
  assert.strictEqual(policy.shouldTranscodeOnOpen({ mode: 'always', video: clips[1], compare: true }).action, 'stream');
  // The decision does not depend on the tile's position: the HEVC clip in tile 4 is the one that streams.
  assert.deepStrictEqual([...clips.slice(1), clips[0]].map((v) => decide('auto', v).action), ['skip', 'skip', 'skip', 'skip', 'stream']);
}

console.log('compare tile stats: ok');
