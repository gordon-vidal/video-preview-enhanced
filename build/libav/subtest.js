#!/usr/bin/env node
// Subtitle decode test for the vpe build: node subtest.js <libav dir> <file>...
'use strict';
const fs = require('fs');
const path = require('path');
const dir = path.resolve(process.argv[2]);
const files = process.argv.slice(3);

(async () => {
  global.LibAV = { base: dir };
  require(path.join(dir, 'libav-vpe.js'));
  const libav = await LibAV.LibAV({ noworker: true, nothreads: true, base: dir, variant: 'vpe' });
  await libav.av_log_set_level(16);
  let fails = 0;
  for (const file of files) {
    const data = fs.readFileSync(file);
    const name = 'f_' + path.basename(file);
    await libav.writeFile(name, new Uint8Array(data));
    const [fmt, streams] = await libav.ff_init_demuxer_file(name);
    const ss = streams.find((s) => s.codec_type === libav.AVMEDIA_TYPE_SUBTITLE);
    if (!ss) { console.log(path.basename(file), 'NO SUBTITLE STREAM'); fails++; continue; }
    const codec = await libav.avcodec_get_name(ss.codec_id);
    const [, c, pkt, frame] = await libav.ff_init_decoder(ss.codec_id, { codecpar: ss.codecpar, time_base: [ss.time_base_num, ss.time_base_den] });
    const header = await libav.AVCodecContext_subtitle_header(c);
    const rpkt = await libav.av_packet_alloc();
    const subs = [];
    for (;;) {
      const [res, packets] = await libav.ff_read_frame_multi(fmt, rpkt, { limit: 1 << 20 });
      const sp = packets[ss.index] || [];
      if (sp.length) subs.push(...await libav.ff_decode_subtitle_multi(c, pkt, sp));
      if (res !== 0 && res !== -libav.EAGAIN) break;
    }
    const tb = ss.time_base_num / ss.time_base_den;
    console.log(`${path.basename(file)}: codec ${codec}, ${subs.length} subs, header ${header.length} chars`);
    for (const s of subs) {
      const t0 = libav.i64tof64(s.pts, s.ptshi) * tb + s.start_display_time / 1000;
      const t1 = s.end_display_time && s.end_display_time !== 0xffffffff
        ? libav.i64tof64(s.pts, s.ptshi) * tb + s.end_display_time / 1000
        : (libav.i64tof64(s.pts, s.ptshi) + libav.i64tof64(s.duration, s.durationhi)) * tb;
      for (const r of s.rects) console.log(`  ${t0.toFixed(2)}-${t1.toFixed(2)} type ${r.type} ${JSON.stringify(r.ass || r.text)}${r.bitmap ? ` bitmap ${r.w}x${r.h}` : ''}`);
    }
    if (subs.length !== 3) fails++;
    await libav.ff_free_decoder(c, pkt, frame).catch(() => {});
    await libav.avformat_close_input_js(fmt);
    await libav.unlink(name);
  }
  console.log(fails ? `SUBTEST FAIL ${fails}` : 'SUBTEST OK');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.log('EXC', e && e.stack || e); process.exit(1); });
