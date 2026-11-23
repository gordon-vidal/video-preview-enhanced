// @ts-check
// Codec metadata, audio layouts and frame conversions shared by the decode paths.
'use strict';

(() => {
  // checkJs: start
  /** Matrix tags from libav's AVCOL_SPC or WebCodecs' VideoColorSpace. */
  function taggedMatrix(tag) {
    switch (tag) {
      case 1: case 'bt709': return 709;
      case 5: case 6: case 'bt470bg': case 'smpte170m': return 601;
      case 9: case 10: case 'bt2020-ncl': case 'bt2020-cl': return 2020;
      default: return 0;
    }
  }

  const hex2 = (n) => (n & 255).toString(16).padStart(2, '0');
  function h264Config(v) {
    const ex = v.extradata;
    if (ex && ex.length > 4 && ex[0] === 1) {
      return { codec: `avc1.${hex2(ex[1])}${hex2(ex[2])}${hex2(ex[3])}`, description: ex, codedWidth: v.width, codedHeight: v.height };
    }
    // Annex B stream (AVI, TS): no description; parameter sets travel in-band.
    const profile = v.profile > 0 ? v.profile : 100;
    const level = v.level > 0 ? v.level : 51;
    return { codec: `avc1.${hex2(profile)}00${hex2(level)}`, codedWidth: v.width, codedHeight: v.height };
  }
  /** " · HDR PQ" / " · HDR HLG" for the info overlay, with "(HDR output)" or "(HDR tone-mapped to SDR)" once decided. */
  const hdrLabel = (v, out, hdr = /** @type {any} */ (globalThis).VpeHdr) => {
    const k = v && v.colorTrc === 16 ? ' · HDR PQ' : v && v.colorTrc === 18 ? ' · HDR HLG' : '';
    const dv = v && v.dv && hdr ? hdr.dolbyVision(v.dv) : null;
    const d = dv ? ` · ${dv.label} (${dv.base} base layer)` : '';
    return k && out && hdr ? `${k} (${hdr.outputLabel(out.on)})${d}` : `${k}${d}`;
  };
  // AV_CH_* bits of a channel layout mask, in ffmpeg's channel order.
  const CH_FC = 0x4;
  const CH_LFE = 0x8;
  const WEBAUDIO_LAYOUTS = new Set([0x3, 0x4, 0x33, 0x603, 0x3f, 0x60f]); // stereo, mono, quad, quad(side), 5.1, 5.1(side)
  /**
   * WebAudio downmixes only mono, stereo, quad and 5.1 (by channel count, in that order); any other
   * layout (7.1, 6.1, 5.0, 2.1, ...) would keep just its first two channels, dropping the centre
   * (dialogue). Those are mixed to stereo here: centre and centre-back at -3 dB to both sides,
   * left/right surrounds at -3 dB to their side, LFE dropped (as WebAudio does for 5.1).
   */
  function toWebAudio(planes, mask) {
    const ch = planes.length;
    if (ch <= 2 || (mask ? WEBAUDIO_LAYOUTS.has(mask) : ch === 4 || ch === 6)) return planes;
    // Each channel's AV_CH bit, from the mask, else ffmpeg's default layout for this count.
    const bits = [];
    if (mask) for (let b = 0; b < 64 && bits.length < ch; b++) { if (b < 32 ? mask & (1 << b) : 0) bits.push(1 << b); }
    const defaults = [0x1, 0x2, CH_FC, CH_LFE, 0x200, 0x400, 0x10, 0x20]; // FL FR FC LFE SL SR BL BR
    while (bits.length < ch) bits.push(ch < 4 && bits.length === 2 ? CH_FC : defaults[bits.length] || 0);
    const LEFT = 0x1 | 0x10 | 0x40 | 0x200 | 0x1000 | 0x8000; // FL BL FLC SL TFL TBL
    const RIGHT = 0x2 | 0x20 | 0x80 | 0x400 | 0x4000 | 0x20000; // FR BR FRC SR TFR TBR
    const n = planes[0].length;
    const l = new Float32Array(n);
    const r = new Float32Array(n);
    const h = Math.SQRT1_2;
    planes.forEach((p, c) => {
      const b = bits[c];
      if (b === CH_LFE) return;
      const front = b === 0x1 || b === 0x2;
      const gl = b & LEFT ? (front ? 1 : h) : b & RIGHT ? 0 : h;
      const gr = b & RIGHT ? (front ? 1 : h) : b & LEFT ? 0 : h;
      for (let i = 0; i < n; i++) { l[i] += gl * p[i]; r[i] += gr * p[i]; }
    });
    return [l, r];
  }
  const AUDIO_CODECS = { mp3: 'mp3', flac: 'flac', vorbis: 'vorbis', opus: 'opus', aac: 'mp4a.40.2' };

  /** "0.31×", "1.2×", "<0.01×": decode speed for the pill, never Infinity or thousands. */
  const speedText = (r) => (!Number.isFinite(r) || r > 99 ? '>99×' : r >= 10 ? `${r.toFixed(0)}×` : r >= 0.995 ? `${r.toFixed(1)}×` : r >= 0.01 ? `${r.toFixed(2)}×` : '<0.01×');

  /** Rate from frame timestamps in seconds, or undefined when there is no measurable interval. */
  /** @param {readonly number[]} timestamps */
  function measureRate(timestamps) {
    const s = [...timestamps].sort((x, y) => x - y);
    // Median spacing finds the frame duration even with gaps (B-frames still in flight);
    // counting frames over the whole span then removes millisecond rounding (WebM 33/33/34 ms).
    const d = [];
    for (let i = 1; i < s.length; i++) if (s[i] - s[i - 1] > 1e-4) d.push(s[i] - s[i - 1]);
    d.sort((x, y) => x - y);
    const med = d[Math.floor(d.length / 2)];
    const span = s[s.length - 1] - s[0];
    if (med > 0 && span > 0) {
      // Frame periods per neighbour (1, more across a gap), summed: round(span / med) miscounts over 40
      // frames when ms rounding puts the median 2% off (60 fps MKV: 16/17/17 ms gave 58.46 fps).
      return d.reduce((k, x) => k + Math.max(1, Math.round(x / med)), 0) / span;
    }
  }

  function snapRate(fps) {
    const common = [24000 / 1001, 24, 25, 30000 / 1001, 30, 48, 50, 60000 / 1001, 60, 120];
    const near = common.reduce((best, c) => (Math.abs(c - fps) < Math.abs(best - fps) ? c : best), common[0]);
    return Math.abs(near - fps) / near < 0.005 ? near : Math.round(fps * 1000) / 1000;
  }

  /**
   * Copy padded NV12 planes into tightly packed I420 planes.
   * @param {Uint8Array} src
   * @param {{offset: number, stride: number}[]} lay
   * @param {number} w
   * @param {number} h
   */
  function nv12ToI420(src, lay, w, h) {
    const cw = (w + 1) >> 1;
    const ch = (h + 1) >> 1;
    const data = new Uint8Array(w * h + 2 * cw * ch);
    for (let y = 0; y < h; y++) {
      const row = lay[0].offset + y * lay[0].stride;
      data.set(src.subarray(row, row + w), y * w);
    }
    const u = w * h;
    const v = u + cw * ch;
    for (let y = 0; y < ch; y++) {
      const row = lay[1].offset + y * lay[1].stride;
      for (let x = 0; x < cw; x++) {
        data[u + y * cw + x] = src[row + 2 * x];
        data[v + y * cw + x] = src[row + 2 * x + 1];
      }
    }
    const layout = [{ offset: 0, stride: w }, { offset: u, stride: cw }, { offset: v, stride: cw }];
    return { data, layout };
  }

  const api = { taggedMatrix, h264Config, hdrLabel, toWebAudio, AUDIO_CODECS, speedText, measureRate, snapRate, nv12ToI420 };
  const commonJs = /** @type {{ exports?: typeof api } | undefined} */ (
    // @ts-ignore The webview has no CommonJS globals.
    typeof module === 'undefined' ? undefined : module
  );
  if (commonJs) commonJs.exports = api;
  else /** @type {typeof globalThis & { VpeCodecUtils?: typeof api }} */ (globalThis).VpeCodecUtils = api;
  // checkJs: end
})();
