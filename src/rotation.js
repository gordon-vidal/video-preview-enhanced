'use strict';
// Display rotation of MP4/MOV/3GP/M4V files (phone videos): the video track's tkhd matrix.
// Returns 0, 90, 180 or 270 (degrees clockwise to turn the decoded picture for display).

const fs = require('fs');

// Top-level boxes walked to find moov. Real files have a handful before it (ftyp, free, mdat);
// without a cap a file of tiny boxes kept this synchronous walk on the extension host thread for
// one read per 8 bytes (security review 2026-11-19 #4).
const MAX_TOP_BOXES = 1024;

/** Iterates boxes in buf[start, end): yields { type, start (payload), end }. */
function* boxes(buf, start, end) {
  let p = start;
  while (p + 8 <= end) {
    let size = buf.readUInt32BE(p);
    const type = buf.toString('latin1', p + 4, p + 8);
    let hdr = 8;
    if (size === 1) { if (p + 16 > end) break; size = Number(buf.readBigUInt64BE(p + 8)); hdr = 16; }
    else if (size === 0) size = end - p;
    if (size < hdr || p + size > end) break;
    yield { type, start: p + hdr, end: p + size };
    p += size;
  }
}

function topLevelBoxSize(h, remaining) {
  if (h.length < 8) return 0;
  let size = h.readUInt32BE(0);
  if (size === 1) {
    if (h.length < 16) return 0;
    size = Number(h.readBigUInt64BE(8));
    if (size < 16) return 0;
  }
  else if (size === 0) size = remaining;
  return size >= 8 && size <= remaining ? size : 0;
}

/** Bound speculative reads even when the box table or moov is large. */
async function readMoov(fd, fileSize, signal, maxBoxes = 32, maxBytes = 1024 * 1024) {
  const read = async (pos, len) => {
    signal?.throwIfAborted();
    const b = Buffer.alloc(len);
    let n = 0;
    while (n < len) {
      const { bytesRead } = await fd.read(b, n, len - n, pos + n);
      if (!bytesRead) break;
      n += bytesRead;
    }
    return b.subarray(0, n);
  };
  let p = 0;
  for (let n = 0; n < maxBoxes && p + 8 <= fileSize; n++) {
    const h = await read(p, 16);
    const size = topLevelBoxSize(h, fileSize - p);
    if (!size) return null;
    if (h.toString('latin1', 4, 8) === 'moov') {
      if (size > maxBytes) return null;
      const moov = await read(p, size);
      return moov.length === size ? moov : null;
    }
    p += size;
  }
  return null;
}

const rotationCache = new Map();
const ROTATION_CACHE_SIZE = 128;

async function rotationOf(file) {
  if (!/\.(mp4|m4v|mov|3gp|3g2)$/i.test(file)) return 0;
  try {
    const stat = await fs.promises.stat(file);
    if (!stat.isFile()) return 0;
    const stamp = `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}:${stat.ino}`;
    const cached = rotationCache.get(file);
    if (cached?.stamp === stamp) return await cached.result;
    const result = readRotation(file, stat.size);
    const entry = { stamp, result };
    rotationCache.delete(file);
    rotationCache.set(file, entry);
    if (rotationCache.size > ROTATION_CACHE_SIZE) rotationCache.delete(rotationCache.keys().next().value);
    try { return await result; } catch (e) {
      if (rotationCache.get(file) === entry) rotationCache.delete(file);
      throw e;
    }
  } catch { return 0; }
}

async function readRotation(file, size) {
  const fd = await fs.promises.open(file, 'r');
  try {
    const moov = await readMoov(fd, size, undefined, MAX_TOP_BOXES, 64 * 1024 * 1024);
    if (!moov) return 0;
    const header = moov.readUInt32BE(0) === 1 ? 16 : 8;
    for (const trak of boxes(moov, header, moov.length)) {
      if (trak.type !== 'trak') continue;
      let tkhd = null;
      let video = false;
      for (const b of boxes(moov, trak.start, trak.end)) {
        if (b.type === 'tkhd') tkhd = b;
        if (b.type === 'mdia') {
          for (const m of boxes(moov, b.start, b.end)) {
            if (m.type === 'hdlr' && moov.toString('latin1', m.start + 8, m.start + 12) === 'vide') video = true;
          }
        }
      }
      if (!video || !tkhd) continue;
      const v1 = moov[tkhd.start] === 1;
      const mat = tkhd.start + (v1 ? 52 : 40);
      if (mat + 16 > tkhd.end) return 0;
      const a = moov.readInt32BE(mat);
      const b = moov.readInt32BE(mat + 4);
      const deg = Math.round(Math.atan2(b, a) * 180 / Math.PI);
      return ((Math.round(deg / 90) * 90) % 360 + 360) % 360;
    }
  } finally {
    await fd.close();
  }
  return 0;
}

module.exports = { rotationOf, MAX_TOP_BOXES };
