'use strict';
// File icons (setting videoPreviewEnhanced.overrideFileIcons, default on): the extension adds
// "*.ext": "vpe-video" to the user's files.associations, and the language association must not change which
// editor opens a file: an .mkv still opens in the player.
const fs = require('fs');
const path = require('path');

const res = (name, problems, extra = {}) => ({ name, ok: !problems.length, problems, ...extra });
const stripJsonc = (s) => s.replace(/^﻿/, '').replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, '').replace(/,(\s*[}\]])/g, '$1');

module.exports = {
  name: 'file_icons',
  async run(vs, h) {
    const out = [];
    const file = 'h264_aac.mkv';
    let p = [];
    try {
      const from = await h.openClip(vs, path.join(h.MEDIA, 'containers', file));
      await vs.waitLog(new RegExp('\\[' + h.esc(file) + '\\] webview: first frame shown'), { from, timeout: 45000, what: `${file}: first frame (the player)` });
    } catch (e) { p.push(e.message); }
    out.push(res('mkv-opens-in-player', p));
    await h.closeClip(vs);
    p = [];
    try {
      const f = path.join(vs.user, 'User', 'settings.json');
      let a;
      for (let i = 0; i < 20; i++) {
        a = JSON.parse(stripJsonc(fs.readFileSync(f, 'utf8')))['files.associations'] || {};
        if (a['*.mkv']) break;
        await h.sleep(500);
      }
      for (const e of ['mkv', 'flv', 'm2ts']) if (a[`*.${e}`] !== 'vpe-video') p.push(`*.${e} -> ${a[`*.${e}`]}`);
      for (const e of ['ts', 'mts', 'avi', 'mov']) if (a[`*.${e}`] !== undefined) p.push(`*.${e} was touched`);
    } catch (e) { p.push(e.message); }
    out.push(res('associations-written', p));
    return out;
  },
};
