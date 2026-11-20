'use strict';
// "Every format in the test media" on the engine in Node (layer 2): each file opens, its first picture is
// ffmpeg's first frame, a seek shows ffmpeg's frame there, and files with sound decode sound.
// The VS Code side of opening (the host's decoder choice, messages) stays in layer 3 (scenario playback).
const path = require('path');
const { open, checks, sleep } = require('./harness');

const assert = (c, m) => { if (!c) throw new Error(m); };

/**
 * files: [[file, { sound?: bool, pick?: picture index to seek to (default ~1/3 in, max 40; -1: no seek), timeout?: ms, known?: why }]]
 */
async function formats(title, files) {
  const c = checks(title);
  for (const [file, o = {}] of files) {
    await c.run(`open/${path.relative(path.join(__dirname, '..', 'media'), file).split(path.sep).join('/')}`, async () => {
      const P = await open(file, { timeout: o.timeout || 60000, waitRate: o.pick !== -1 });
      try {
        const slots = await P.slots();
        assert(slots.length > 1, `ffmpeg decoded ${slots.length} pictures`);
        await P.expectFrame(slots[0], 'first picture', o.timeout || 30000);
        if (o.pick !== -1) {
        const i = Math.min(slots.length - 1, o.pick !== undefined ? o.pick : Math.min(40, Math.floor(slots.length / 3)));
        P.seek((slots[i] + 0.5) / P.fps);
        await P.expectFrame(slots[i], `seek to picture ${i} (frame ${slots[i]})`, o.timeout || 30000);
        }
        if (o.sound) {
          assert(P.player.amode && P.player.amode !== 'none', `no sound stream picked (${P.player.amode})`);
          P.play();
          const heard = await P.until(() => P.player.audio.length > 0 || P.player.audioOut > 0 || P.player.scheduled > 0, 'sound', 20000);
          P.pause();
          assert(heard, 'no sound decoded within 20 s of playing');
        }
        const bad = P.logs.filter((l) => /\berror\b|failed/i.test(l));
        assert(!bad.length, `engine log: ${bad.slice(0, 2).join(' | ')}`);
      } finally { P.close(); }
      await sleep(50);
    }, o.known);
  }
  c.done();
}

module.exports = { formats, MEDIA: path.join(__dirname, '..', 'media') };
