'use strict';
// node test/host/security_test.js: security fixes (manifests, moov walk, A-B range, shell quoting).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ff = require('../../src/ffmpeg');
const r = require('../../src/rangecmd');
const { rotationOf, MAX_TOP_BOXES } = require('../../src/rotation');

(async () => {
  // #1 text manifests are not media: DASH (XML), HLS, ffconcat, with BOM or leading white space.
  const b = (s) => Buffer.from(s, 'latin1');
  for (const s of ['<?xml version="1.0"?><MPD>', '<MPD xmlns="urn:mpeg:dash:schema:mpd:2011">', '#EXTM3U\n#EXT-X-VERSION:3', 'ffconcat version 1.0\nfile a.mp4',
    '\xef\xbb\xbf<MPD>', '  \r\n\t<MPD>', '<!-- x --><MPD>', '\n\n\n']) {
    assert.ok(ff.looksLikePlaylist(b(s)), JSON.stringify(s));
  }
  // Real containers pass, also an MP4 box whose size starts with '<' (0x3c) or '#' (0x23).
  const box = (size0, type) => Buffer.concat([Buffer.from([size0, 0, 0, 0x20]), b(type), Buffer.alloc(24)]);
  for (const h of [box(0x0a, 'mdat'), box(0x20, 'moov'), box(0, 'ftyp'), box(0x3c, 'ftyp'), box(0x23, 'mdat'), box(0x3c, 'free'), Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x01]), b('RIFF....AVI '), Buffer.alloc(0)]) {
    assert.ok(!ff.looksLikePlaylist(h), h.toString('hex', 0, 8));
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vpe-sec-'));
  try {
    const mpd = path.join(dir, 'clip.mp4');
    fs.writeFileSync(mpd, '<?xml version="1.0"?>\n<MPD><Period><AdaptationSet><Representation><BaseURL>file:///etc/passwd</BaseURL></Representation></AdaptationSet></Period></MPD>\n');
    assert.strictEqual(await ff.isPlaylistFile(mpd), true);
    // ffprobe is never started for it (the tools here do not exist).
    await assert.rejects(ff.probe({ ffprobe: path.join(dir, 'no-such-ffprobe') }, mpd), /playlist or manifest/);
    assert.strictEqual(await ff.isPlaylistFile(path.join(dir, 'missing.mp4')), false);

    // #4 a file of tiny top-level boxes ends the moov search after MAX_TOP_BOXES reads.
    const tiny = path.join(dir, 'tiny.mp4');
    const one = Buffer.concat([Buffer.from([0, 0, 0, 8]), b('free')]);
    fs.writeFileSync(tiny, Buffer.concat([Buffer.concat([Buffer.from([0, 0, 0, 8]), b('ftyp')]), Buffer.alloc(0), ...Array(MAX_TOP_BOXES * 4).fill(one)]));
    const t0 = Date.now();
    assert.strictEqual(await rotationOf(tiny), 0);
    assert.ok(Date.now() - t0 < 5000);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // #2 A-B range from the page: whole, non-negative frame numbers only.
  for (const bad of [{ fa: '0', fb: 1, fps: 25 }, { fa: 0, fb: '1;calc', fps: 25 }, { fa: -1, fb: 3, fps: 25 }, { fa: 0.5, fb: 3, fps: 25 }, { fa: 0, fb: NaN, fps: 25 }, { fa: 0, fb: 1, fps: '25' + ' x' }]) {
    assert.ok(r.rangeProblem(bad), JSON.stringify(bad));
  }
  assert.strictEqual(r.rangeProblem({ fa: 0, fb: 1, fps: 25 }), null);

  // #3 shell quoting: pwsh / fish anywhere, PowerShell's typographic quotes doubled.
  assert.strictEqual(r.shellKind('linux', '/usr/bin/pwsh'), 'powershell');
  assert.strictEqual(r.shellKind('darwin', '/opt/homebrew/bin/fish'), 'fish');
  assert.strictEqual(r.shellKind('win32', 'C:\\tools\\fish.exe'), 'fish');
  assert.strictEqual(r.shellKind('linux', '/bin/bash'), 'posix');
  assert.strictEqual(r.quote('a\u2019; calc; \u2018b', 'win32', 'powershell.exe'), "'a\u2019\u2019; calc; \u2018\u2018b'");
  assert.strictEqual(r.quote("it's \\ x", 'linux', '/usr/bin/fish'), "'it\\'s \\\\ x'");
  assert.strictEqual(r.quote("it's", 'linux', '/usr/bin/pwsh'), "'it''s'");
  console.log('security fixes: manifests refused, moov walk capped, A-B range and shell quoting checked');
})().catch((e) => { console.error(e); process.exit(1); });
