'use strict';
// ffmpeg's Ogg transport supplies the encoder delay and exact final sample count. Keep those
// on the host; the page receives independently decodable batches of raw Opus packets.
class OggOpus {
  constructor(onPacket) {
    this.onPacket = onPacket;
    this.rest = Buffer.alloc(0);
    this.parts = [];
    this.samples = 0;
    this.preSkip = 0;
  }

  push(data) {
    this.rest = Buffer.concat([this.rest, data]);
    while (this.rest.length >= 27) {
      const b = this.rest;
      if (b.toString('ascii', 0, 4) !== 'OggS' || b[4] !== 0) throw new Error('Invalid Ogg page');
      const count = b[26];
      if (b.length < 27 + count) return;
      const sizes = b.subarray(27, 27 + count);
      const length = 27 + count + sizes.reduce((n, x) => n + x, 0);
      if (b.length < length) return;
      let at = 27 + count;
      for (let i = 0; i < count; i++) {
        this.parts.push(b.subarray(at, at + sizes[i]));
        at += sizes[i];
        if (sizes[i] === 255) continue;
        const packet = Buffer.concat(this.parts);
        this.parts = [];
        if (packet.subarray(0, 8).toString() === 'OpusHead') {
          if (packet.length !== 19 || packet[9] !== 2 || packet[18] !== 0) throw new Error('Unsupported Opus header');
          this.preSkip = packet.readUInt16LE(10);
          this.head = new Uint8Array(packet);
          this.head[10] = this.head[11] = 0; // trimming is explicit, including after seeks
        } else if (packet.subarray(0, 8).toString() !== 'OpusTags') {
          if (!this.head || !packet.length) throw new Error('Opus packet before header');
          const toc = packet[0];
          const config = toc >> 3;
          const frame = config >= 16 ? 120 << (config & 3)
            : config >= 12 ? 480 << (config & 1) : [480, 960, 1920, 2880][config & 3];
          const frames = (toc & 3) === 0 ? 1 : (toc & 3) === 3 ? packet[1] & 63 : 2;
          const duration = frame * frames;
          if (!duration || duration > 5760) throw new Error('Invalid Opus duration');
          const s = this.samples - this.preSkip;
          this.samples += duration;
          // On the final page the granule trims encoder padding, even for a partial frame.
          const last = i === count - 1 && (b[5] & 4);
          const end = last ? Math.min(this.samples, Number(b.readBigUInt64LE(6))) : this.samples;
          this.onPacket({ s, n: Math.max(0, end - this.preSkip - s), b: packet });
        }
      }
      this.rest = Buffer.from(b.subarray(length));
    }
  }
}

module.exports = { OggOpus };
