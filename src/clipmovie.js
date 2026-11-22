'use strict';
// Shorten FFmpeg's presentation edits without moving the media samples or their chunk offsets.
const fs = require('fs/promises');

function* boxes(buf, start = 0, end = buf.length) {
  while (start + 8 <= end) {
    const size = buf.readUInt32BE(start);
    const type = buf.toString('ascii', start + 4, start + 8);
    if (size < 8 || start + size > end) throw new Error('Invalid movie metadata');
    yield { type, start: start + 8, end: start + size };
    start += size;
  }
}

function child(buf, parent, type) {
  return [...boxes(buf, parent.start, parent.end)].find((box) => box.type === type);
}

function shortenMovie(buf, duration) {
  const movie = child(buf, { start: 0, end: buf.length }, 'mvhd');
  if (!movie) throw new Error('Missing movie header');
  const mv64 = buf[movie.start] === 1;
  const scaleAt = movie.start + (mv64 ? 20 : 12);
  const limit = Math.round(duration * buf.readUInt32BE(scaleAt));
  if (limit < 1) throw new Error('Invalid clip duration');
  const read = (at, wide) => wide ? Number(buf.readBigUInt64BE(at)) : buf.readUInt32BE(at);
  const write = (at, wide, value) => wide ? buf.writeBigUInt64BE(BigInt(value), at) : buf.writeUInt32BE(value, at);
  let longest = 0;
  for (const track of boxes(buf)) {
    if (track.type !== 'trak') continue;
    const header = child(buf, track, 'tkhd');
    const edts = child(buf, track, 'edts');
    const edit = edts && child(buf, edts, 'elst');
    if (!header) throw new Error('Missing track header');
    const wide = buf[header.start] === 1;
    const durAt = header.start + (wide ? 28 : 20);
    let length = read(durAt, wide);
    if (edit) {
      const edit64 = buf[edit.start] === 1;
      const stride = edit64 ? 20 : 12;
      const count = buf.readUInt32BE(edit.start + 4);
      if (edit.start + 8 + count * stride > edit.end) throw new Error('Invalid movie edit list');
      length = 0;
      for (let i = 0; i < count; i++) {
        const at = edit.start + 8 + i * stride;
        const segment = Math.min(limit - length, read(at, edit64));
        write(at, edit64, segment);
        length += segment;
      }
    } else if (length > limit) {
      throw new Error('Missing track edit list');
    }
    write(durAt, wide, length);
    longest = Math.max(longest, length);
  }
  write(scaleAt + 4, mv64, longest);
}

async function trimMovie(file, duration) {
  const fd = await fs.open(file, 'r+');
  try {
    const size = (await fd.stat()).size;
    const header = Buffer.alloc(16);
    for (let pos = 0; pos + 8 <= size;) {
      const { bytesRead } = await fd.read(header, 0, 16, pos);
      const n = header.readUInt32BE();
      const prefix = n === 1 ? 16 : 8;
      const length = n === 1 && bytesRead === 16 ? Number(header.readBigUInt64BE(8)) : n || size - pos;
      if (length < prefix || length > size - pos) break;
      if (header.toString('ascii', 4, 8) === 'moov') {
        const data = Buffer.alloc(length - prefix); // read only the index, even for a large clip
        const at = pos + prefix;
        if ((await fd.read(data, 0, data.length, at)).bytesRead !== data.length) break;
        shortenMovie(data, duration);
        if ((await fd.write(data, 0, data.length, at)).bytesWritten !== data.length) break;
        return;
      }
      pos += length;
    }
    throw new Error('Could not update the movie edit list');
  } finally {
    await fd.close();
  }
}

module.exports = { trimMovie };
