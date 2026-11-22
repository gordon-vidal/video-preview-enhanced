'use strict';
// Minimal RIFF/AVI reader: stream headers plus the offset and size of every
// video and audio chunk. Handles AVI 1.0, OpenDML (RIFF AVIX) and truncated
// files from crashed recorders. No decoding happens here.
//
// Only MJPEG files need the chunk list (each frame is shown as a JPEG); for
// every other codec the movi data is skipped after the headers. Header lists
// are read through 1 MB windows. Inside movi, where chunks are big and
// back to back, chunk headers go through a small window instead, so a scan
// costs about one small read per chunk rather than the whole file.

const fs = require('fs');

const fourcc = (b, o) => b.toString('latin1', o, o + 4);

async function readAt(fh, pos, len) {
  const buf = Buffer.alloc(len);
  const { bytesRead } = await fh.read(buf, 0, len, pos);
  return bytesRead === len ? buf : buf.subarray(0, bytesRead);
}

const WINDOW = 1 << 20;
const MOVI_WINDOW = 16 << 10;

/** read(pos, len): small reads served from a window of the file (shorter at EOF). */
function windowReader(fh, size = WINDOW, signal) {
  let base = 0;
  let buf = Buffer.alloc(0);
  return async (pos, len) => {
    signal?.throwIfAborted();
    if (pos < base || pos + len > base + buf.length) {
      buf = await readAt(fh, pos, Math.max(len, size));
      base = pos;
    }
    return buf.subarray(pos - base, pos - base + len);
  };
}

async function parseAvi(file, signal) {
  const fh = await fs.promises.open(file, 'r');
  try {
    signal?.throwIfAborted();
    const fileSize = (await fh.stat()).size;
    const head = await readAt(fh, 0, 12);
    if (head.length < 12 || fourcc(head, 0) !== 'RIFF' || fourcc(head, 8) !== 'AVI ') {
      throw new Error('not a RIFF AVI file');
    }
    const info = { fileSize, avih: null, streams: [] };
    const state = { cur: null, moviRead: windowReader(fh, MOVI_WINDOW, signal) };
    const read = windowReader(fh, WINDOW, signal);
    let pos = 0;
    while (pos + 12 <= fileSize) {
      const h = await read(pos, 12);
      if (h.length < 12 || fourcc(h, 0) !== 'RIFF') break;
      const len = h.readUInt32LE(4);
      const end = len === 0 ? fileSize : Math.min(fileSize, pos + 8 + len);
      await walk(read, pos + 12, end, info, state, false);
      if (len === 0) break;
      pos += 8 + len + (len & 1);
    }
    return finish(info);
  } finally {
    await fh.close();
  }
}

async function walk(read, start, end, info, state, inMovi) {
  let pos = start;
  while (pos + 8 <= end) {
    const h = await read(pos, 12);
    if (h.length < 8) break;
    const id = fourcc(h, 0);
    const declared = h.readUInt32LE(4);
    const dataStart = pos + 8;
    const truncated = dataStart + declared > end;
    const len = truncated ? Math.max(0, end - dataStart) : declared;

    if (id === 'LIST' && h.length >= 12) {
      const type = fourcc(h, 8);
      if (type === 'movi' && !mjpegVideo(info)) {
        // The headers (hdrl) come first: not MJPEG, so the chunk list isn't needed.
      } else if (type === 'movi' || type === 'rec ') {
        await walk(state.moviRead, dataStart + 4, dataStart + len, info, state, true);
      } else if (type === 'hdrl' || type === 'strl' || type === 'odml') {
        await walk(read, dataStart + 4, dataStart + len, info, state, false);
      }
    } else if (inMovi) {
      const m = /^(\d\d)(dc|db|wb)$/i.exec(id);
      if (m && !truncated) {
        const s = info.streams[parseInt(m[1], 10)];
        if (s) s.chunks.push({ offset: dataStart, size: declared });
      }
    } else if (id === 'avih' && len >= 40) {
      const b = await read(dataStart, 40);
      info.avih = {
        usPerFrame: b.readUInt32LE(0),
        totalFrames: b.readUInt32LE(16),
        width: b.readUInt32LE(32),
        height: b.readUInt32LE(36),
      };
    } else if (id === 'strh' && len >= 36) {
      const b = await read(dataStart, 36);
      state.cur = {
        type: fourcc(b, 0),
        handler: fourcc(b, 4),
        scale: b.readUInt32LE(20),
        rate: b.readUInt32LE(24),
        length: b.readUInt32LE(32),
        format: null,
        chunks: [],
      };
      info.streams.push(state.cur);
    } else if (id === 'strf' && state.cur) {
      const b = await read(dataStart, Math.min(len, 40));
      if (state.cur.type === 'vids' && b.length >= 20) {
        state.cur.format = {
          width: b.readInt32LE(4),
          height: Math.abs(b.readInt32LE(8)),
          compression: fourcc(b, 16),
        };
      } else if (state.cur.type === 'auds' && b.length >= 16) {
        state.cur.format = {
          tag: b.readUInt16LE(0),
          channels: b.readUInt16LE(2),
          sampleRate: b.readUInt32LE(4),
          byteRate: b.readUInt32LE(8),
          blockAlign: b.readUInt16LE(12),
          bits: b.readUInt16LE(14),
        };
      }
    }
    if (truncated) break;
    pos = dataStart + declared + (declared & 1);
  }
}

const MJPEG_FOURCCS = new Set(['MJPG', 'AVRN', 'AVDJ', 'DMB1', 'JPEG', 'MJLS']);

function mjpegVideo(info) {
  const v = info.streams.find((s) => s.type === 'vids');
  if (!v) return false;
  return MJPEG_FOURCCS.has((v.format ? v.format.compression : '').toUpperCase()) || MJPEG_FOURCCS.has(v.handler.toUpperCase());
}

function finish(info) {
  const video = info.streams.find((s) => s.type === 'vids') || null;
  const audio = info.streams.find((s) => s.type === 'auds') || null;
  let fps = 0;
  if (video && video.scale && video.rate) fps = video.rate / video.scale;
  else if (info.avih && info.avih.usPerFrame) fps = 1e6 / info.avih.usPerFrame;

  // Zero-size video chunks are "drop frames": repeat the previous image.
  const frames = [];
  if (video) {
    let last = null;
    for (const c of video.chunks) {
      if (c.size > 0) last = c;
      if (last) frames.push(last);
    }
  }
  const fmt = video && video.format;
  const compression = fmt ? fmt.compression : '';
  const handler = video ? video.handler : '';
  const isMjpeg =
    MJPEG_FOURCCS.has(compression.toUpperCase()) || MJPEG_FOURCCS.has(handler.toUpperCase());

  return {
    fileSize: info.fileSize,
    width: (fmt && fmt.width) || (info.avih && info.avih.width) || 0,
    height: (fmt && fmt.height) || (info.avih && info.avih.height) || 0,
    fps,
    compression,
    isMjpeg,
    frames,
    audio:
      audio && audio.format
        ? { ...audio.format, chunks: audio.chunks, pcm: audio.format.tag === 1 }
        : null,
  };
}

// --- JPEG helpers -----------------------------------------------------------

// Many camera MJPEG streams leave out the Huffman tables and rely on the
// standard ones (ITU T.81 Annex K.3). Browsers need them spelled out.
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const DC_L_BITS = [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0];
const DC_C_BITS = [0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0];
const DC_VALS = range(0, 11);
const AC_L_BITS = [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d];
const AC_L_VALS = [
  0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07,
  0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08, 0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0,
  0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28,
  0x29, 0x2a, ...range(0x34, 0x3a), ...range(0x43, 0x4a), ...range(0x53, 0x5a), ...range(0x63, 0x6a),
  ...range(0x73, 0x7a), ...range(0x83, 0x8a), ...range(0x92, 0x9a), ...range(0xa2, 0xaa),
  ...range(0xb2, 0xba), ...range(0xc2, 0xca), ...range(0xd2, 0xda), ...range(0xe1, 0xea),
  ...range(0xf1, 0xfa),
];
const AC_C_BITS = [0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 0x77];
const AC_C_VALS = [
  0x00, 0x01, 0x02, 0x03, 0x11, 0x04, 0x05, 0x21, 0x31, 0x06, 0x12, 0x41, 0x51, 0x07, 0x61, 0x71,
  0x13, 0x22, 0x32, 0x81, 0x08, 0x14, 0x42, 0x91, 0xa1, 0xb1, 0xc1, 0x09, 0x23, 0x33, 0x52, 0xf0,
  0x15, 0x62, 0x72, 0xd1, 0x0a, 0x16, 0x24, 0x34, 0xe1, 0x25, 0xf1, 0x17, 0x18, 0x19, 0x1a, 0x26,
  0x27, 0x28, 0x29, 0x2a, ...range(0x35, 0x3a), ...range(0x43, 0x4a), ...range(0x53, 0x5a),
  ...range(0x63, 0x6a), ...range(0x73, 0x7a), ...range(0x82, 0x8a), ...range(0x92, 0x9a),
  ...range(0xa2, 0xaa), ...range(0xb2, 0xba), ...range(0xc2, 0xca), ...range(0xd2, 0xda),
  ...range(0xe2, 0xea), ...range(0xf2, 0xfa),
];

function buildStandardDht() {
  const body = [];
  for (const [tc, bits, vals] of [
    [0x00, DC_L_BITS, DC_VALS],
    [0x10, AC_L_BITS, AC_L_VALS],
    [0x01, DC_C_BITS, DC_VALS],
    [0x11, AC_C_BITS, AC_C_VALS],
  ]) {
    body.push(tc, ...bits, ...vals);
  }
  const len = body.length + 2;
  return Buffer.from([0xff, 0xc4, len >> 8, len & 0xff, ...body]);
}
const STANDARD_DHT = buildStandardDht();

function hasHuffmanTables(buf) {
  let i = 2;
  while (i + 4 <= buf.length) {
    if (buf[i] !== 0xff) return true; // malformed; leave it to the decoder
    const marker = buf[i + 1];
    if (marker === 0xc4) return true;
    if (marker === 0xda) return false; // reached scan data without a DHT
    if (marker === 0xff) { i += 1; continue; } // fill byte
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return true;
}

/** Returns a browser-decodable JPEG for one MJPEG frame. */
function fixJpeg(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return buf;
  if (hasHuffmanTables(buf)) return buf;
  return Buffer.concat([buf.subarray(0, 2), STANDARD_DHT, buf.subarray(2)]);
}

function wavHeader(fmt, dataBytes) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'latin1');
  h.writeUInt32LE(36 + dataBytes, 4);
  h.write('WAVEfmt ', 8, 'latin1');
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(fmt.channels, 22);
  h.writeUInt32LE(fmt.sampleRate, 24);
  h.writeUInt32LE(fmt.byteRate, 28);
  h.writeUInt16LE(fmt.blockAlign, 32);
  h.writeUInt16LE(fmt.bits, 34);
  h.write('data', 36, 'latin1');
  h.writeUInt32LE(dataBytes, 40);
  return h;
}

/** Reads all PCM audio chunks into one WAV file in memory. */
async function readPcmAsWav(file, audio) {
  const total = audio.chunks.reduce((n, c) => n + c.size, 0);
  const out = Buffer.alloc(44 + total);
  wavHeader(audio, total).copy(out, 0);
  const fh = await fs.promises.open(file, 'r');
  try {
    let pos = 44;
    for (const c of audio.chunks) {
      await fh.read(out, pos, c.size, c.offset);
      pos += c.size;
    }
  } finally {
    await fh.close();
  }
  return out;
}

/**
 * The same WAV as readPcmAsWav, in parts of about partBytes (the header leads the
 * first part), so a long recording never sits in one buffer or one message.
 */
async function* pcmWavParts(file, audio, partBytes, signal) {
  partBytes = Math.max(partBytes, 64); // the 44-byte header must fit the first part
  const total = audio.chunks.reduce((n, c) => n + c.size, 0);
  const fh = await fs.promises.open(file, 'r');
  try {
    let part = Buffer.alloc(Math.min(partBytes, 44 + total));
    wavHeader(audio, total).copy(part, 0);
    let fill = 44;
    let left = total;
    for (const c of audio.chunks) {
      let done = 0;
      while (done < c.size) {
        signal?.throwIfAborted();
        if (fill === part.length) {
          yield part;
          part = Buffer.alloc(Math.min(partBytes, left));
          fill = 0;
        }
        const n = Math.min(c.size - done, part.length - fill);
        const { bytesRead } = await fh.read(part, fill, n, c.offset + done);
        if (bytesRead < n) part.fill(0, fill + bytesRead, fill + n); // truncated file: silence
        fill += n;
        done += n;
        left -= n;
      }
    }
    if (fill) yield part.subarray(0, fill);
  } finally {
    await fh.close();
  }
}

module.exports = { parseAvi, fixJpeg, readPcmAsWav, pcmWavParts, STANDARD_DHT, hasHuffmanTables };
