'use strict';
// Finds numbered image sequences: frame_0001.png, frame_0002.png, ...

const fs = require('fs');
const path = require('path');

const IMAGE_EXT = /\.(png|jpe?g|webp|bmp|gif|avif)$/i;
const NUMBERED = /^(.*?)(\d+)(\.[^.]+)$/;

function groupKey(name) {
  const m = NUMBERED.exec(name);
  return m ? `${m[1]}\u0000${m[3].toLowerCase()}` : null;
}

/**
 * @param {string} target a folder, or one image inside a sequence
 * @returns {Promise<{dir: string, name: string, files: string[]}|null>}
 */
async function findSequence(target) {
  const st = await fs.promises.stat(target);
  const dir = st.isDirectory() ? target : path.dirname(target);
  const names = (await fs.promises.readdir(dir)).filter((n) => IMAGE_EXT.test(n));
  const groups = new Map();
  for (const n of names) {
    const k = groupKey(n);
    if (!k) continue;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(n);
  }
  let pick = null;
  if (st.isDirectory()) {
    for (const g of groups.values()) if (!pick || g.length > pick.length) pick = g;
  } else {
    pick = groups.get(groupKey(path.basename(target))) || null;
  }
  if (!pick || pick.length < 2) return null;
  const num = (n) => Number(NUMBERED.exec(n)[2]);
  pick.sort((a, b) => num(a) - num(b));
  const m = NUMBERED.exec(pick[0]);
  const digits = m[2].length;
  return {
    dir,
    name: `${m[1]}${'#'.repeat(digits)}${m[3]}`,
    files: pick.map((n) => path.join(dir, n)),
  };
}

module.exports = { findSequence, IMAGE_EXT };
