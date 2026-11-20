// Adds subtitle decoding to a libav.js 6.11 source tree (vpe build).
// Usage: node patch_subs.js <tree>
'use strict';
const fs = require('fs');
const T = process.argv[2];
const MARK = 'vpe subtitle additions';

// 1. funcs.json: functions, meta, accessors in the avcodec section
const fj = `${T}/funcs.json`;
const funcs = JSON.parse(fs.readFileSync(fj, 'utf8'));
const ac = funcs.avcodec;
if (!ac.functions.some((f) => f[0] === 'ff_decode_subtitle_js')) {
  ac.functions.push(
    ['ff_subtitle_alloc', 'number', []],
    ['ff_subtitle_free', null, ['number']],
    ['ff_decode_subtitle_js', 'number', ['number', 'number', 'number']],
    ['avsubtitle_free', null, ['number']],
    ['AVCodecContext_subtitle_header', 'string', ['number']],
    ['AVCodecContext_subtitle_header_size', 'number', ['number']]
  );
  ac.meta.push('ff_decode_subtitle_multi');
  ac.accessors.push(
    ['AVSubtitle', ['format', 'start_display_time', 'end_display_time', 'num_rects', 'pts', 'ptshi',
      { name: 'rects', array: true }]],
    ['AVSubtitleRect', ['x', 'y', 'w', 'h', 'nb_colors', 'type', 'flags',
      { name: 'text', string: true }, { name: 'ass', string: true },
      { name: 'data', array: true }, { name: 'linesize', array: true }]]
  );
  fs.writeFileSync(fj, JSON.stringify(funcs, null, 4) + '\n');
}

// 2. C bindings
const bc = `${T}/src/b-avcodec.c`;
let c = fs.readFileSync(bc, 'utf8');
if (!c.includes(MARK)) {
  c += `
/* ${MARK}: AVSubtitle decoding */
#define B(type, field) A(AVSubtitle, type, field)
B(uint16_t, format)
B(uint32_t, start_display_time)
B(uint32_t, end_display_time)
B(unsigned, num_rects)
#undef B
AL(AVSubtitle, int64_t, pts)
AA(AVSubtitle, AVSubtitleRect *, rects)

#define B(type, field) A(AVSubtitleRect, type, field)
B(int, x)
B(int, y)
B(int, w)
B(int, h)
B(int, nb_colors)
B(enum AVSubtitleType, type)
B(int, flags)
#undef B
char *AVSubtitleRect_text(AVSubtitleRect *a) { return a->text; }
char *AVSubtitleRect_ass(AVSubtitleRect *a) { return a->ass; }
AA(AVSubtitleRect, uint8_t *, data)
AA(AVSubtitleRect, int, linesize)

char *AVCodecContext_subtitle_header(AVCodecContext *a) {
    return a->subtitle_header ? (char *) a->subtitle_header : "";
}
int AVCodecContext_subtitle_header_size(AVCodecContext *a) { return a->subtitle_header_size; }

AVSubtitle *ff_subtitle_alloc(void) { return av_mallocz(sizeof(AVSubtitle)); }
void ff_subtitle_free(AVSubtitle *s) { if (s) { avsubtitle_free(s); av_free(s); } }

/* Decode one packet. Returns <0 on error, 0 if no subtitle came out, 1 if sub
 * now holds a subtitle (the previous contents of sub are freed first). */
int ff_decode_subtitle_js(AVCodecContext *ctx, AVSubtitle *sub, AVPacket *pkt) {
    int got = 0, ret;
    avsubtitle_free(sub);
    ret = avcodec_decode_subtitle2(ctx, sub, &got, pkt);
    return ret < 0 ? ret : !!got;
}
`;
  fs.writeFileSync(bc, c);
}

// 3. JS meta function
const pj = `${T}/src/p-avcodec.in.js`;
let p = fs.readFileSync(pj, 'utf8');
if (!p.includes(MARK)) {
  p += `
/* ${MARK} */
/**
 * Decode subtitle packets. Returns one object per decoded subtitle:
 * {pts, ptshi, duration, durationhi, time_base_num, time_base_den (from the packet),
 *  format, start_display_time, end_display_time (ms, relative to pts),
 *  rects: [{type (1 bitmap, 2 text, 3 ass), x, y, w, h, flags, text, ass,
 *           bitmap?: Uint8Array (w*h palette indices), palette?: Uint32Array (nb_colors, 0xAARRGGBB)}]}
 * @param ctx  AVCodecContext (from ff_init_decoder)
 * @param pkt  AVPacket scratch packet
 * @param inPackets  Packets to decode
 * @param config  {ignoreErrors?: boolean}
 */
/* @types
 * ff_decode_subtitle_multi@sync(
 *     ctx: number, pkt: number, inPackets: (Packet | number)[],
 *     config?: {
 *         ignoreErrors?: boolean
 *     }
 * ): @promise@any[]@
 */
var ff_decode_subtitle_multi = Module.ff_decode_subtitle_multi = function(ctx, pkt, inPackets, config) {
    config = config || {};
    var out = [];
    var sub = ff_subtitle_alloc();
    try {
        inPackets.forEach(function(inPacket) {
            var ret = av_packet_make_writable(pkt);
            if (ret < 0)
                throw new Error("Failed to make packet writable: " + ff_error(ret));
            ff_copyin_packet(pkt, inPacket);
            var s = {
                pts: AVPacket_pts(pkt), ptshi: AVPacket_ptshi(pkt),
                duration: AVPacket_duration(pkt), durationhi: AVPacket_durationhi(pkt),
                time_base_num: AVPacket_time_base_num(pkt), time_base_den: AVPacket_time_base_den(pkt)
            };
            ret = ff_decode_subtitle_js(ctx, sub, pkt);
            av_packet_unref(pkt);
            if (ret < 0) {
                if (config.ignoreErrors) return;
                throw new Error("Error decoding subtitle: " + ff_error(ret));
            }
            if (!ret) return;
            s.format = AVSubtitle_format(sub);
            s.start_display_time = AVSubtitle_start_display_time(sub) >>> 0;
            s.end_display_time = AVSubtitle_end_display_time(sub) >>> 0;
            s.rects = [];
            var n = AVSubtitle_num_rects(sub) >>> 0;
            for (var i = 0; i < n; i++) {
                var r = AVSubtitle_rects_a(sub, i);
                var o = {
                    type: AVSubtitleRect_type(r),
                    x: AVSubtitleRect_x(r), y: AVSubtitleRect_y(r),
                    w: AVSubtitleRect_w(r), h: AVSubtitleRect_h(r),
                    flags: AVSubtitleRect_flags(r),
                    text: AVSubtitleRect_text(r) || null,
                    ass: AVSubtitleRect_ass(r) || null
                };
                var d0 = AVSubtitleRect_data_a(r, 0);
                if (o.type === 1 && d0 && o.w > 0 && o.h > 0) {
                    var ls = AVSubtitleRect_linesize_a(r, 0);
                    var bmp = new Uint8Array(o.w * o.h);
                    for (var y = 0; y < o.h; y++)
                        bmp.set(Module.HEAPU8.subarray(d0 + y * ls, d0 + y * ls + o.w), y * o.w);
                    o.bitmap = bmp;
                    var nc = AVSubtitleRect_nb_colors(r);
                    var d1 = AVSubtitleRect_data_a(r, 1);
                    o.palette = new Uint32Array(nc);
                    if (d1 && nc)
                        o.palette.set(new Uint32Array(Module.HEAPU8.buffer, d1, nc));
                }
                s.rects.push(o);
            }
            out.push(s);
        });
    } finally {
        ff_subtitle_free(sub);
    }
    return out;
};
`;
  fs.writeFileSync(pj, p);
}
console.log('patched subtitles into', T);
