'use strict';
// node test/run.js unit --grep transcode_resolution: a Live transcode resolution fixed for one video (⚙ › Live
// transcode › Resolution, src/stream.js setResolution), its bar chip and panel choices (media/controls.js) and the
// default for new tabs (videoPreviewEnhanced.transcodeResolution, src/settings.js), without ffmpeg or VS Code.
const assert = require('assert');
const { EncodedStream } = require('../../src/stream');
const { resolutionOf, RESOLUTIONS } = require('../../src/transcode_policy');
const controls = require('../../media/controls');
const pkg = require('../../package.json');

function make({ resolution = 0, height = 2160 } = {}) {
  const posted = [];
  const s = new EncodedStream({
    tools: {}, file: 'x.mkv', post: (m) => posted.push(m), log: () => {}, remote: true, maxHeight: 1080,
    encoder: 'libx264', cpuEncoder: 'libx264', allowOverlap: false, resolution,
    probed: { duration: 60, video: { index: 0, codec: 'hevc', width: height * 16 / 9, height, fps: 30 }, audio: null },
  });
  s.fps = 30;
  const calls = { restart: 0, transition: 0 };
  s.restartVideo = () => { calls.restart++; };
  s.transitionVideo = () => { calls.transition++; s.sizeVideo(); };
  s.spawnNow = () => {};
  s.setView({ w: 960, h: 540 });
  s.sizeVideo();
  return { s, posted, calls };
}
const last = (posted, type) => posted.filter((m) => m.type === type).pop();

// The stored value: one of the offered heights, else Auto.
assert.deepStrictEqual(RESOLUTIONS, [2160, 1440, 1080, 720, 480, 360]);
for (const [v, want] of [[720, 720], ['1080', 1080], [0, 0], [721, 0], [-1, 0], [undefined, 0], ['auto', 0]]) {
  assert.strictEqual(resolutionOf(v), want, `resolutionOf(${v})`);
}
const prop = pkg.contributes.configuration.properties['videoPreviewEnhanced.transcodeResolution'];
assert.ok(prop && prop.scope === 'machine' && prop.default === 0, 'the setting is machine-scoped, Auto by default');
assert.deepStrictEqual(prop.enum, [0, ...RESOLUTIONS], 'the setting offers the heights the stream accepts');

// Auto: sized to the view (540p for a 960x540 picture) and stepped down by the link ladder.
{
  const { s } = make();
  assert.strictEqual(s.h, 540);
  s.tier = 2;
  s.sizeVideo();
  assert.strictEqual(s.h, 540, 'the 720p tier does not raise a smaller view');
  s.setView({ w: 1920, h: 1080 });
  s.sizeVideo();
  assert.strictEqual(s.h, 720, 'the tier caps the view-fitted height');
  assert.strictEqual(s.transcodeInfo().locked, 0);
}

// Fixed at a height from the start (a saved default): that height whatever the view, maxHeight or the ladder.
{
  const { s } = make({ resolution: 1440 });
  assert.strictEqual(s.h, 1440, 'a fixed height beats the view size and maxHeight (1080)');
  s.tier = 3;
  s.sizeVideo();
  assert.strictEqual(s.h, 1440, 'and the link tier');
  const info = s.transcodeInfo();
  assert.strictEqual(info.locked, 1440);
  // The ladder is off while fixed: a bad link sample changes nothing.
  s.tier = 0;
  s.adapt({ gen: 0, kbps: 100, mediaRate: 0.2, buffer: 0, starved: true, behind: true });
  assert.strictEqual(s.tier, 0, 'the ladder stepped a fixed resolution down');
  // Never above the source.
  const small = make({ resolution: 2160, height: 1080 }).s;
  assert.strictEqual(small.h, 1080);
}

// Picked while paused: one page seek (refresh) restarts ffmpeg at the new size; the chip learns it is fixed.
{
  const { s, posted, calls } = make();
  s.tier = 2;
  s.playing = false;
  s.proc = { exitCode: null };
  s.setResolution(720);
  assert.strictEqual(s.lockHeight, 720);
  assert.strictEqual(s.tier, 0, 'fixing the resolution leaves the ladder');
  assert.strictEqual(posted.filter((m) => m.type === 'refresh').length, 1, 'paused: the page seeks to the same picture');
  assert.ok(s.resizePending, 'the seek starts ffmpeg at the new size');
  assert.strictEqual(calls.transition + calls.restart, 0, 'no restart before that seek');
  assert.strictEqual(last(posted, 'transcodeInfo').transcode.locked, 720);
  s.sizeVideo(); // what the seek does
  assert.strictEqual(s.h, 720);
  // The same again: nothing.
  const n = posted.length;
  s.setResolution(720);
  assert.strictEqual(posted.length, n);
  // Auto again: the view-fitted size and the ladder come back.
  s.setResolution(0);
  s.sizeVideo();
  assert.strictEqual(s.h, 540);
  assert.strictEqual(last(posted, 'transcodeInfo').transcode.locked, 0);
}

// Picked while playing: the in-band restart a quality step uses (sound and clock go on).
{
  const { s, posted, calls } = make();
  s.playing = true;
  s.proc = { exitCode: null };
  s.setResolution(1080);
  assert.strictEqual(calls.transition, 1);
  assert.strictEqual(s.h, 1080);
  assert.strictEqual(posted.filter((m) => m.type === 'refresh').length, 0);
  // Before ffmpeg ran (fps unknown): only the size to start at.
  const pre = make().s;
  pre.fps = 0;
  pre.setResolution(360);
  assert.strictEqual(pre.h, 360);
}

// The bar chip: a fixed resolution is no "adapted down" and says so to screen readers.
{
  const chip = controls.remoteChipState({ remote: true, active: true, transcode: { h: 720, maxKbps: 0, tier: 0, locked: 720, label: 'x' } });
  assert.strictEqual(chip.text, 'Live · 720p');
  assert.strictEqual(chip.adapting, false);
  assert.match(chip.ariaLabel, /720p \(fixed resolution\)/);
  assert.match(chip.title, /Resolution fixed at 720p for this video/);
  const auto = controls.remoteChipState({ remote: true, active: true, transcode: { h: 720, maxKbps: 3000, tier: 2 } });
  assert.strictEqual(auto.text, 'Live · 720p ↓ · 3 Mb/s');
  assert.doesNotMatch(auto.ariaLabel, /fixed/);
}

// ⓘ names a fixed resolution after the pipeline.
{
  const by = (transcode) => new Map(controls.facts({ name: 'a.mkv', remoteStream: true, info: { transcode } }).rows).get('Played by');
  assert.strictEqual(by({ label: 'Live transcode', locked: 480 }), 'Live transcode, resolution fixed at 480p for this video');
  assert.strictEqual(by({ label: 'Live transcode', locked: 0 }), 'Live transcode');
}

// The panel's chips: Auto, then the heights up to the source (1080p when unknown); a saved height stays visible.
{
  const hs = (src, cur) => controls.resolutionChoices(src, cur).map((o) => o.label);
  assert.deepStrictEqual(hs(2160, 0), ['Auto', '2160p', '1440p', '1080p', '720p', '480p', '360p']);
  assert.deepStrictEqual(hs(1080, 0), ['Auto', '1080p', '720p', '480p', '360p']);
  assert.deepStrictEqual(hs(0, 0), ['Auto', '1080p', '720p', '480p', '360p']);
  assert.deepStrictEqual(hs(576, 0), ['Auto', '480p', '360p']);
  assert.deepStrictEqual(hs(1080, 2160), ['Auto', '2160p', '1080p', '720p', '480p', '360p']);
  assert.strictEqual(controls.resolutionChoices(1080, 0)[0].h, 0);
}

console.log('transcode resolution tests passed');
