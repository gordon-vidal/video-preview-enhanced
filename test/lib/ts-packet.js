'use strict';

/** A TS packet; pes: { pts } starts a video PES. */
function tsPacket(pid, { pes = null, payload = 0x11, cc = 0, len = 0 } = {}) {
  const b = Buffer.alloc(188, payload);
  b[0] = 0x47; b[1] = (pes ? 0x40 : 0) | ((pid >> 8) & 31); b[2] = pid & 255; b[3] = 0x10 | cc;
  if (pes) {
    const p = Math.round(pes.pts * 90000);
    const hi = Math.floor(p / 2 ** 30) & 7;
    const lo = p % 2 ** 30;
    Buffer.from([0, 0, 1, 0xe0, (len >> 8) & 255, len & 255, 0x80, 0x80, 5,
      0x21 | (hi << 1), (lo >> 22) & 255, ((lo >> 14) & 254) | 1, (lo >> 7) & 255, ((lo << 1) & 254) | 1]).copy(b, 4);
  }
  return b;
}

module.exports = { tsPacket };
