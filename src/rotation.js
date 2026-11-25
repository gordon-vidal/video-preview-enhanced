'use strict';
// Display rotation of MP4/MOV/3GP/M4V files (phone videos): the video track's tkhd matrix.
// Returns 0, 90, 180 or 270 (degrees clockwise to turn the decoded picture for display).

const fs = require('fs');
const { hevcFormat, av1Format, h264Format, vp9Format } = require('./sniff-codecs');
const { looksLikePlaylist } = require('./ffmpeg');

// Top-level boxes walked to find moov. Real files have a handful before it (ftyp, free, mdat);
// without a cap a file of tiny boxes kept this synchronous walk on the extension host thread for
// one read per 8 bytes (security review 2026-11-19 #4).
const MAX_TOP_BOXES = 1024;

/** Iterates boxes in buf[start, end): yields { type, start (payload), end }. */
function* boxes(buf, start, end, strict = false) {
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
  if (strict && p !== end) throw new Error('truncated MP4 box');
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

function sampleFormat(entry, config) {
  switch (entry) {
    case 'hvc1':
    case 'hev1': return ['hevc', hevcFormat(config('hvcC'))];
    case 'av01': return ['av1', av1Format(config('av1C'))];
    case 'vp09': return ['vp9', vp9Format(config('vpcC'))];
    case 'avc1': return ['h264', h264Format(config('avcC'))];
    // Only the ProRes 422 profiles. The 4444 profiles can carry alpha too.
    case 'apco':
    case 'apcs':
    case 'apcn':
    case 'apch': return ['prores', 'yuv422p10le'];
    default: return [];
  }
}

// A constant decode delta can still hide uneven presentation times in ctts.
function constantPresentation(buf, ctts, count, delta) {
  if (!ctts) return true;
  const { start, end } = ctts;
  if (start + 8 > end || buf[start] > 1 || count > 32768) return false;
  const runs = buf.readUInt32BE(start + 4);
  if (start + 8 + runs * 8 !== end) return false;
  const seen = new Uint8Array(count);
  let sample = 0;
  let low = Infinity;
  let high = -Infinity;
  for (let p = start + 8; p < end; p += 8) {
    const run = buf.readUInt32BE(p);
    const offset = buf[start] ? buf.readInt32BE(p + 4) : buf.readUInt32BE(p + 4);
    if (!run || sample + run > count || offset % delta) return false;
    low = Math.min(low, sample + offset / delta);
    high = Math.max(high, sample + run - 1 + offset / delta);
    sample += run;
  }
  if (sample !== count || high - low + 1 !== count) return false;
  sample = 0;
  for (let p = start + 8; p < end; p += 8) {
    const run = buf.readUInt32BE(p);
    const offset = buf[start] ? buf.readInt32BE(p + 4) : buf.readUInt32BE(p + 4);
    let pts = sample + offset / delta - low;
    for (let i = 0; i < run; i++, pts++) {
      if (seen[pts]) return false;
      seen[pts] = 1;
    }
    sample += run;
  }
  return true;
}

/**
 * Enough metadata to start decoding a simple MP4/MOV while ffprobe runs. The guess
 * is used only to launch ffmpeg: the probe still decides what reaches the player.
 */
async function sniffNativeMp4(file, stat, signal) {
  if (!/\.(mp4|m4v|mov)$/i.test(file)) return null;
  let fd;
  try {
    fd = await fs.promises.open(file, 'r');
    signal?.throwIfAborted();
    const st = await fd.stat();
    if (st.size !== stat.size || st.mtimeMs !== stat.mtimeMs) return null;
    // A manifest posing as MP4 must not start ffmpeg before ffprobe's check (src/ffmpeg.js).
    const head = Buffer.alloc(4096);
    const { bytesRead } = await fd.read(head, 0, head.length, 0);
    if (looksLikePlaylist(head.subarray(0, bytesRead))) return null;
    const moov = await readMoov(fd, st.size, signal);
    if (!moov) return null;
    const children = (b) => [...boxes(moov, b.start, b.end, true)];
    const find = (b, type) => b && children(b).find((x) => x.type === type);
    const root = children({ start: 0, end: moov.length })[0];
    if (!root || root.type !== 'moov' || find(root, 'mvex')) return null; // the frame rate may live in later fragments
    const tracks = children(root).filter((b) => b.type === 'trak');
    if (!tracks.length || tracks.length > 2) return null;
    let video = null;
    let audio = null;
    for (const [index, trak] of tracks.entries()) {
      const mdia = find(trak, 'mdia');
      const h = find(mdia, 'hdlr');
      if (!h || h.start + 12 > h.end) return null;
      const kind = moov.toString('latin1', h.start + 8, h.start + 12);
      if (kind === 'soun' && !audio) { audio = { index }; continue; }
      if (kind !== 'vide' || video) return null;
      const stbl = find(find(mdia, 'minf'), 'stbl');
      const stsd = find(stbl, 'stsd');
      const stts = find(stbl, 'stts');
      const mdhd = find(mdia, 'mdhd');
      if (!stsd || stsd.start + 8 > stsd.end || moov.readUInt32BE(stsd.start + 4) !== 1 ||
          !stts || stts.start + 16 > stts.end || moov.readUInt32BE(stts.start + 4) !== 1 || !mdhd) return null;
      const entries = children({ start: stsd.start + 8, end: stsd.end });
      const [entry] = entries;
      if (entries.length !== 1 || entry.end !== stsd.end || entry.start + 78 > entry.end) return null;
      const config = (type) => {
        const box = find({ start: entry.start + 78, end: entry.end }, type);
        return box ? moov.subarray(box.start, box.end) : Buffer.alloc(0);
      };
      const [codec, pixFmt] = sampleFormat(entry.type, config);
      const scale = mdhd.start + (moov[mdhd.start] === 1 ? 20 : 12);
      if (!pixFmt || scale + 4 > mdhd.end || moov[mdhd.start] > 1 || stts.end !== stts.start + 16) return null;
      const count = moov.readUInt32BE(stts.start + 8);
      const delta = moov.readUInt32BE(stts.start + 12);
      const fps = moov.readUInt32BE(scale) / delta;
      const width = moov.readUInt16BE(entry.start + 24);
      const height = moov.readUInt16BE(entry.start + 26);
      if (!(fps > 0 && fps < 1000 && width >= 2 && height >= 2) || !count || width % 2 || height % 2 ||
          !constantPresentation(moov, find(stbl, 'ctts'), count, delta)) return null;
      video = { index, codec, width, height, fps, pixFmt };
    }
    return video ? { video, audio } : null;
  } catch { return null; } finally {
    if (fd) try { await fd.close(); } catch { /* ignore */ }
  }
}

module.exports = { rotationOf, sniffNativeMp4, MAX_TOP_BOXES };
