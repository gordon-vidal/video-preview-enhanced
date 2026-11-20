'use strict';

// Codec configuration records shared by ISO BMFF and Matroska.
function pixelFormat(chroma, depth) {
  return `yuv${chroma}p${depth === 8 ? '' : `${depth}le`}`;
}

function hevcFormat(b) {
  if (b.length < 23 || b[0] !== 1 || (b[16] & 3) !== 1 || (b[17] & 7) !== (b[18] & 7)) return null;
  const depth = 8 + (b[17] & 7);
  return [8, 10, 12].includes(depth) ? pixelFormat(420, depth) : null;
}

function av1Format(b) {
  // Main profile, no monochrome, with both 4:2:0 subsampling flags set.
  if (b.length < 4 || b[0] !== 0x81 || b[1] >> 5 || (b[2] & 0x3c) !== 0x0c) return null;
  return pixelFormat(420, b[2] & 0x40 ? 10 : 8);
}

function h264Format(b) {
  // The high-profile avcC extension follows the length-prefixed SPS and PPS lists.
  if (b.length < 7 || b[0] !== 1 || ![100, 110, 122].includes(b[1])) return null;
  let p = 6;
  for (const nals of [b[5] & 31, null]) {
    if (p >= b.length) return null;
    const count = nals ?? b[p++];
    if (!count) return null;
    for (let i = 0; i < count; i++) {
      if (p + 2 > b.length) return null;
      const size = b.readUInt16BE(p);
      if (!size) return null;
      p += 2 + size;
    }
  }
  if (p + 4 > b.length || (b[p] & 0xfc) !== 0xfc || (b[p + 1] & 0xf8) !== 0xf8 || b[p + 1] !== b[p + 2]) return null;
  const chroma = b[p] & 3;
  const depth = 8 + (b[p + 1] & 7);
  if (chroma === 1 && depth === 10) return 'yuv420p10le';
  if (chroma === 2 && (depth === 8 || depth === 10)) return pixelFormat(422, depth);
  return null;
}

function vp9Format(b) {
  // vpcC is a version 1 FullBox. Only 4:2:0 profiles are unambiguous here.
  if (b.length !== 12 || b.readUInt32BE(0) !== 0x01000000 || b.readUInt16BE(10) || ((b[6] >> 1) & 7) > 1) return null;
  const depth = b[6] >> 4;
  if (b[4] === 0 && depth === 8 || b[4] === 2 && (depth === 10 || depth === 12)) return pixelFormat(420, depth);
  return null;
}

module.exports = { hevcFormat, av1Format, h264Format, vp9Format, pixelFormat };
