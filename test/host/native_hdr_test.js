'use strict';
// node test/host/native_hdr_test.js: native ffmpeg sends 10-bit frames for HDR output
// (docs/notes/hdr-output.md). With the page's 'open' carrying hdr, a PQ clip comes as
// yuv420p10le (2 bytes per sample, 'streams' says depth 10) at 1/sqrt(2) of the height cap, with
// the same samples ffmpeg itself gives; without hdr, and for SDR video, frames stay 8-bit as before.
// Real ffmpeg (PATH or VPE_FFMPEG); skipped without it.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const ff = require('../../src/ffmpeg');
const { NativeDecoder, isHdr } = require('../../src/native');
const hw = require('../../src/hwaccel');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

assert.strictEqual(isHdr({ colorTransfer: 'smpte2084' }), true);
assert.strictEqual(isHdr({ colorTransfer: 'arib-std-b67' }), true);
assert.strictEqual(isHdr({ colorTransfer: 'bt709' }), false);
assert.strictEqual(isHdr(null), false);
// The 8-bit chains are unchanged; 10-bit goes through the CPU scaler (QSV downloads P010 first).
assert.strictEqual(hw.videoFilter('none', 640, 360, ''), 'scale=640:360:flags=bilinear,format=yuv420p');
assert.strictEqual(hw.videoFilter('d3d11va', 640, 360, '', 10, 'yuv420p10le'), 'scale=640:360:flags=bilinear,format=yuv420p10le');
assert.strictEqual(hw.videoFilter('qsv', 640, 360, 'vpp_qsv', 10, 'yuv420p10le'), 'hwdownload,format=p010le,scale=640:360:flags=bilinear,format=yuv420p10le');

async function play(tools, file, open, maxHeight) {
  const posted = [];
  const raw = [];
  const nd = new NativeDecoder({
    tools, file, method: 'none', transport: 'message', maxHeight, messageMaxHeight: maxHeight,
    post: (m) => posted.push(m), postRaw: (m) => raw.push(m), log: () => {}, onFail: (e) => { throw new Error(e); },
  });
  await nd.handle(open);
  await nd.handle({ type: 'more', gen: 0 });
  for (let i = 0; i < 300 && !raw.some((m) => m.type === 'ndv'); i++) await wait(20);
  nd.dispose();
  const info = posted.find((m) => m.type === 'streams').info;
  return { info, frame: raw.find((m) => m.type === 'ndv') };
}

(async () => {
  const tools = await ff.locateTools(process.env.VPE_FFMPEG || '', '');
  if (!tools) { console.log('native hdr: skipped (no ffmpeg)'); return; }
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'vpe_nhdr_'));
  const make = (name, tags) => {
    const f = path.join(work, name);
    const r = spawnSync(tools.ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=30:d=1', '-vf', `setparams=${tags},format=yuv420p10le`, '-c:v', 'ffv1', f], { windowsHide: true });
    assert.strictEqual(r.status, 0, String(r.stderr));
    return f;
  };
  const pq = make('pq.mkv', 'color_trc=smpte2084:color_primaries=bt2020:colorspace=bt2020nc');
  const sdr = make('sdr.mkv', 'color_trc=bt709:color_primaries=bt709:colorspace=bt709');

  // HDR output asked for, PQ video: 10-bit, height cap 180 / sqrt(2) -> 126 (even).
  const a = await play(tools, pq, { type: 'open', hdr: true }, 180);
  assert.strictEqual(a.info.video.depth, 10, 'streams says depth 10');
  assert.strictEqual(a.info.video.colorTrc, 16);
  assert.strictEqual(a.frame.h, 126);
  assert.strictEqual(a.frame.w, 224);
  assert.strictEqual(a.frame.ys, 224 * 126 * 2, 'luma bytes');
  assert.strictEqual(a.frame.data.byteLength, 224 * 126 * 3, '2 bytes per sample, 4:2:0');
  // The samples ffmpeg gives for the same scale.
  const ref = spawnSync(tools.ffmpeg, ['-v', 'error', '-i', pq, '-frames:v', '1', '-vf', 'scale=224:126:flags=bilinear,format=yuv420p10le', '-f', 'rawvideo', '-'], { maxBuffer: 1e8, windowsHide: true }).stdout;
  assert.ok(Buffer.from(a.frame.data.buffer, a.frame.data.byteOffset, a.frame.data.byteLength).equals(ref), 'samples as ffmpeg gives them');
  const y16 = new Uint16Array(a.frame.data.buffer.slice(a.frame.data.byteOffset, a.frame.data.byteOffset + 2 * 224 * 126));
  assert.ok(Math.max(...y16) <= 1023 && Math.max(...y16) > 255, '10-bit values in 16-bit words');

  // Without hdr in 'open' (an SDR display, compare tiles): 8-bit as before.
  const b = await play(tools, pq, { type: 'open' }, 180);
  assert.strictEqual(b.info.video.depth, undefined);
  assert.strictEqual(b.frame.h, 180);
  assert.strictEqual(b.frame.data.byteLength, 320 * 180 * 1.5);
  // SDR video with hdr asked for: 8-bit as before.
  const c = await play(tools, sdr, { type: 'open', hdr: true }, 180);
  assert.strictEqual(c.info.video.depth, undefined);
  assert.strictEqual(c.frame.data.byteLength, 320 * 180 * 1.5);
  // Dolby Vision: ffprobe's configuration record reaches the page (test/zoo/make_dv.js on the HDR pattern).
  const pattern = path.join(__dirname, '..', 'media', 'cases', 'hdr', 'hevc10_pq.mp4');
  if (fs.existsSync(pattern)) {
    const { makeDv } = require('../zoo/make_dv');
    for (const [p, c] of [[8, 1], [5, 0]]) {
      const f = path.join(work, `dv${p}${c}.mp4`);
      makeDv(pattern, f, p, c);
      const pr = await ff.probe(tools, f);
      assert.deepStrictEqual(pr.video.dv, { profile: p, compat: c }, `DV ${p}.${c} probed`);
    }
    const plain = await ff.probe(tools, pattern);
    assert.strictEqual(plain.video.dv, null);
  } else console.log('native hdr: Dolby Vision probe skipped (no test/media/cases/hdr; run test/media/make_cases_media.js)');
  await wait(500); // the killed ffmpegs let go of the files
  try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* still held: the temp folder keeps it */ }
  console.log('native hdr: ok');
})().catch((e) => { console.error(e); process.exit(1); });
