#!/usr/bin/env node
// Track list, stream discard, audio switching, embedded subtitles and open-GOP seeks.
//
//   node test/tracks/run.js [media dir] [--only=name,...] [--log]   (default: test/media/tracks, made on demand)
//
// Needs the files from test/tracks/make_media.js in that directory (made when missing). Functional
// checks only; timings (discard, skip_frame) are in test/tracks/measure.js.
'use strict';
const path = require('path');
const fs = require('fs');
const { Session, hashFrame } = require('./driver');
const { cues: expectedCues } = require('./make_media');

const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith('--')) || require('./make_media').ensure();
const only = (args.find((a) => a.startsWith('--only=')) || '').slice(7).split(',').filter(Boolean);
const LOG = args.includes('--log');
const F = (n) => path.join(dir, n);

let failed = 0;
const check = (ok, what) => { if (!ok) failed++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}`); return ok; };

/** Pulls batches until pred(state) or eof; collects video times/hashes and audio items. */
async function pull(s, st, until) {
  for (;;) {
    const b = await s.more();
    for (const v of b.video) st.video.push(v.kind === 'yuv' ? [v.t, hashFrame(v)] : [v.t, v.key ? 'K' : 'p', v.idr]);
    for (const a of b.audio) st.audio.push(a);
    if (b.eof) { st.eof = true; return; }
    if (until && until(st)) return;
  }
}
const newState = () => ({ video: [], audio: [], eof: false });
const lastVT = (st) => { for (let i = st.video.length - 1; i >= 0; i--) if (st.video[i][0] !== null) return st.video[i][0]; return -1; };

/** Frequency of a PCM item from zero crossings. */
function freq(items) {
  let n = 0;
  let len = 0;
  let sr = 48000;
  for (const a of items) {
    if (a.kind !== 'pcm') continue;
    // The loudest channel (a mono tone upmixed to 5.1 sits in the centre).
    const e = (q) => q.reduce((n, x) => n + x * x, 0);
    const p = a.planes.reduce((best, q) => (e(q) > e(best) ? q : best));
    sr = a.sampleRate;
    for (let i = 1; i < p.length; i++) if ((p[i - 1] < 0) !== (p[i] < 0)) n++;
    len += p.length;
  }
  return len ? (n / 2) / (len / sr) : 0;
}

const tests = {
  async trackList() {
    const s = await new Session(F('tracks_multi.mkv'), { log: LOG }).open();
    const t = s.info.tracks;
    check(t && t.audio.length === 3 && t.sub.length === 2, `mkv: 3 audio + 2 subtitle tracks (${t && t.audio.length}/${t && t.sub.length})`);
    const [a0, a1, a2] = t.audio;
    check(a0.id === 1 && a0.codec === 'aac' && a0.lang === 'eng' && a0.title === 'English stereo' && a0.default === true, `audio 0 ${JSON.stringify({ ...a0, extradata: undefined })}`);
    check(a1.codec === 'ac3' && a1.lang === 'ger' && a1.channels === 6 && a1.default === false, `audio 1 ${a1.codec} ${a1.lang} ${a1.channels} ch`);
    check(a2.codec === 'opus' && a2.lang === 'jpn' && a2.title === '', `audio 2 ${a2.codec} ${a2.lang}`);
    const [s0, s1] = t.sub;
    check(s0.id === 4 && s0.codec === 'subrip' && s0.kind === 'text' && s0.default && !s0.forced, `sub 0 ${JSON.stringify(s0)}`);
    check(s1.codec === 'ass' && s1.forced && s1.title === 'Signs' && /PlayResX/.test(s1.header || ''), `sub 1 ${s1.codec} forced=${s1.forced} header ${s1.header ? s1.header.length : 0} chars`);
    check(s.info.audio && s.info.audio.codec === 'aac', 'plays the default audio track');
    s.close();
    const m = await new Session(F('tracks_multi.mp4')).open();
    const mt = m.info.tracks;
    check(mt.audio.length === 2 && mt.audio[1].lang === 'fre' && mt.sub.length === 1 && mt.sub[0].codec === 'mov_text' && mt.sub[0].kind === 'text', `mp4: ${mt.audio.map((a) => `${a.codec}/${a.lang}`).join(' ')} + ${mt.sub.map((x) => x.codec).join(' ')}`);
    m.close();
  },

  async discardWorks() {
    // With discard, the batches carry no packets of unselected streams; with keepStreams the worker still drops them.
    const s = await new Session(F('tracks_multi.mkv'), { log: LOG }).open();
    const st = newState();
    await pull(s, st);
    const ok = st.audio.every((a) => a.aid === 1);
    check(st.eof && ok && st.video.length === 1800, `plays to the end: ${st.video.length} video packets, ${st.audio.length} audio items, all from track 1: ${ok}`);
    s.close();
  },

  async audioSwitch() {
    for (const pool of [false, true]) {
      for (const audio of ['soft', 'webcodecs']) {
        const label = `${pool ? 'pool' : 'single'}, soft video, ${audio} audio`;
        // Reference: the picture from start to end without switching.
        const ref = await new Session(F('tracks_multi.mkv'), { video: 'soft', pool, workers: pool ? 3 : undefined }).open();
        const rs = newState();
        await pull(ref, rs, (x) => lastVT(x) >= 12);
        ref.close();
        const s = await new Session(F('tracks_multi.mkv'), { video: 'soft', audio, pool, workers: pool ? 3 : undefined, log: LOG }).open();
        const st = newState();
        await pull(s, st, (x) => lastVT(x) >= 5);
        const switchAt = 4.0; // the playhead is behind what was decoded
        const before = st.audio.length;
        s.send({ type: 'selectAudio', id: 2, mode: audio, t: switchAt });
        const r = await s.wait((m) => m.type === 'audioSelected');
        await pull(s, st, (x) => lastVT(x) >= 12);
        const after = st.audio.slice(before).filter((a) => a.aid === 2);
        const stale = st.audio.slice(before).filter((a) => a.aid !== 2).length;
        const first = after.length ? after[0].t : null;
        const v = st.video.filter((x) => x[0] <= 12);
        const rv = rs.video.filter((x) => x[0] <= 12);
        const same = v.length === rv.length && v.every((x, i) => x[0] === rv[i][0] && x[1] === rv[i][1]);
        check(r.audio === audio && r.rewound !== false, `${label}: switched (${JSON.stringify(r)})`);
        check(same, `${label}: picture unchanged by the switch (${v.length} vs ${rv.length} frames)`);
        check(first !== null && first <= switchAt + 0.05 && first > switchAt - 3, `${label}: new track from ${first && first.toFixed(3)} s (switch at ${switchAt}); ${stale} items of the old track after`);
        if (audio === 'soft') {
          const hz = freq(after);
          check(Math.abs(hz - 660) < 15, `${label}: new track plays 660 Hz (${hz.toFixed(0)})`);
        }
        s.close();
      }
    }
  },

  async seekThenSwitch() {
    // Review 3 #6: a switch right after a seek (nothing handed out yet) must not rewind to before the seek.
    const ref = await new Session(F('tracks_multi.mkv'), { video: 'soft' }).open();
    await ref.seek(20);
    const rs = newState();
    await pull(ref, rs, (x) => lastVT(x) >= 24);
    ref.close();
    const s = await new Session(F('tracks_multi.mkv'), { video: 'soft', audio: 'soft', log: LOG }).open();
    const st0 = newState();
    await pull(s, st0, (x) => lastVT(x) >= 5);
    await s.seek(20);
    s.send({ type: 'selectAudio', id: 2, mode: 'soft', t: 20 });
    const r = await s.wait((m) => m.type === 'audioSelected');
    const st = newState();
    await pull(s, st, (x) => lastVT(x) >= 24);
    s.close();
    const v = st.video.filter((x) => x[0] <= 24);
    const rv = rs.video.filter((x) => x[0] <= 24);
    const same = v.length === rv.length && v.every((x, i) => x[0] === rv[i][0] && x[1] === rv[i][1]);
    const a2 = st.audio.filter((a) => a.aid === 2);
    check(r.rewound !== false && same, `seek then switch: picture as after a plain seek (${v.length} vs ${rv.length} frames, from ${v.length ? v[0][0].toFixed(2) : '-'} s)`);
    check(a2.length && a2[0].t <= 20.05 && a2[0].t > 17, `seek then switch: new track from ${a2.length ? a2[0].t.toFixed(3) : '-'} s`);
  },

  async subtitles() {
    const want = expectedCues(60, 'EN');
    const s = await new Session(F('tracks_multi.mkv'), { log: LOG }).open();
    s.send({ type: 'selectSub', id: 4, t: 0 });
    const r = await s.wait((m) => m.type === 'subSelected');
    check(r.id === 4 && r.kind === 'text', `selectSub(4): ${JSON.stringify(r)}`);
    const st = newState();
    await pull(s, st, (x) => lastVT(x) >= 30);
    const got = s.subs.flatMap((m) => m.cues);
    const upTo = want.filter((c) => c[0] < 29);
    const match = upTo.every(([a, b, x]) => got.some((c) => Math.abs(c.start - a) < 0.01 && Math.abs(c.end - b) < 0.01 && c.text === x.replace('second line', '<i>second</i> line')));
    check(match, `srt cues 0..29 s: ${got.length} received, ${upTo.length} expected, text and times match`);
    // Seek into the long cue (36..44): it started before the keyframe the seek lands on.
    s.subs = [];
    await s.seek(41);
    const st2 = newState();
    await pull(s, st2, (x) => lastVT(x) >= 42);
    const long = s.subs.flatMap((m) => m.cues).find((c) => c.text === 'EN long cue 36');
    check(!!long && long.start === 36 && long.end === 44, `after seek to 41 s the long cue 36..44 is there (${long ? 'yes' : 'no'}; prescan ${s.logs.filter((l) => /subtitles: read/.test(l)).slice(-1)[0]})`);
    // Seek back into what was read: no prescan.
    const nPre = s.logs.filter((l) => /subtitles: read/.test(l)).length;
    await s.seek(20);
    const st20 = newState();
    await pull(s, st20, (x) => lastVT(x) >= 21);
    check(s.logs.filter((l) => /subtitles: read/.test(l)).length === nPre, 'seek back to 20 s: covered, no prescan');
    // Switch to the ASS track inside its long cue (16..24) while playing at ~21 s.
    s.subs = [];
    const st3 = newState();
    s.send({ type: 'selectSub', id: 5, t: 21 });
    await s.wait((m) => m.type === 'subSelected');
    await pull(s, st3, (x) => lastVT(x) >= 26);
    const ass = s.subs.filter((m) => m.id === 5).flatMap((m) => m.cues);
    const de = ass.find((c) => c.start === 16);
    check(!!de && de.text === 'DE long cue 16' && /^\d+,0,Default,,0,0,0,,\{\\i1\}DE long cue 16\{\\i0\}$/.test(de.ass), `ass cue after switch: ${de ? JSON.stringify(de) : 'missing'}`);
    const ass2 = ass.find((c) => c.start === 24);
    check(!!ass2 && ass2.text === 'DE cue 24\nsecond line', `ass \\N becomes a line break: ${ass2 && JSON.stringify(ass2.text)}`);
    // The picture continues without repeats or gaps (packets in decode order: compare as a set).
    const ts = [...st20.video, ...st3.video].map((x) => Math.round(x[0] * 30)).filter((t) => !Number.isNaN(t));
    const uniq = new Set(ts);
    const lo = Math.min(...ts);
    const hi = Math.max(...ts);
    check(uniq.size === ts.length && uniq.size === hi - lo + 1 && st3.video.length > 100, `picture continues across the sub switch: frames ${lo}..${hi}, ${ts.length - uniq.size} repeated, ${hi - lo + 1 - uniq.size} missing`);
    s.send({ type: 'selectSub', id: null });
    const off = await s.wait((m) => m.type === 'subSelected');
    check(off.id === -1, 'selectSub(null) turns subtitles off');
    // Review 3 #5: read on with subtitles off, turn them on again: the cues read past while off arrive.
    await pull(s, newState(), (x) => lastVT(x) >= 44);
    s.subs = [];
    s.send({ type: 'selectSub', id: 4, t: 31 });
    const on = await s.wait((m) => m.type === 'subSelected');
    await pull(s, newState(), (x) => lastVT(x) >= 46);
    const again = s.subs.filter((m) => m.id === 4).flatMap((m) => m.cues);
    const gap = want.filter((c) => c[0] > 31 && c[0] < 44);
    const back = gap.filter(([a]) => again.some((c) => Math.abs(c.start - a) < 0.01));
    check(on.rewound === true && gap.length > 0 && back.length === gap.length, `off and on again: rewound ${on.rewound}, ${back.length} of ${gap.length} cues of 31..44 s`);
    s.close();

    for (const [file, id, label, text] of [['tracks_multi.mp4', 3, 'mov_text', 'EN cue 4\nsecond line'], ['tracks_vtt.webm', 2, 'webvtt', 'VTT cue 4\nsecond line']]) {
      const m = await new Session(F(file), { log: LOG }).open();
      m.send({ type: 'selectSub', id, t: 0 });
      await m.wait((x) => x.type === 'subSelected');
      await pull(m, newState(), (x) => lastVT(x) >= 8);
      const c = m.subs.flatMap((x) => x.cues).find((x) => x.start === 4);
      check(!!c && c.text === text && Math.abs(c.end - 5.5) < 0.01, `${label}: ${c ? JSON.stringify(c) : 'no cue at 4 s'}`);
      m.close();
    }
  },

  async openGop() {
    // Every frame shown after a seek must be the frame a straight decode gives at that time.
    const files = ['opengop_hevc.mkv', 'opengop_hevc.mp4', 'opengop_h264.mkv', 'hevc8_aac.mp4', 'mpeg2_mp2.mpg', 'mpeg2_ac3.vob'];
    for (const f of files) {
      if (!fs.existsSync(F(f))) { console.log(`  skip ${f} (missing)`); continue; }
      for (const pool of [false, true]) {
        const ref = await new Session(F(f), { video: 'soft' }).open();
        const rs = newState();
        await pull(ref, rs);
        ref.close();
        const byT = new Map(rs.video.map((x) => [x[0], x[1]]));
        const s = await new Session(F(f), { video: 'soft', pool, workers: pool ? 3 : undefined, log: LOG }).open();
        let bad = 0;
        let shown = 0;
        const where = [];
        for (const [t, fast] of [[1.05, false], [2.5, true], [3.2, false], [6.01, false], [0.9, true], [7.7, false]]) {
          await s.seek(t, fast);
          const st = newState();
          await pull(s, st, (x) => x.video.length >= 40);
          // The engine shows the last frame before t and everything after (accurate), or all (fast).
          for (const [vt, h] of st.video) {
            if (vt === null) continue;
            shown++;
            if (byT.get(vt) !== h) { bad++; if (where.length < 4) where.push(`${t}${fast ? 'f' : ''}@${vt.toFixed(3)}`); }
          }
        }
        check(!bad, `${f} ${pool ? 'pool' : 'single'}: ${shown} frames after 6 seeks, ${bad} differ from a straight decode ${where.join(' ')}`);
        s.close();
      }
    }
    // WebCodecs H.264: key packets say whether they are IDRs (open GOP has recovery-point I-frames).
    const w = await new Session(F('opengop_h264.mkv'), { video: 'webcodecs' }).open();
    const st = newState();
    await pull(w, st);
    const keys = st.video.filter((x) => x[1] === 'K');
    check(keys.length >= 3 && keys[0][2] === true && keys.slice(1).some((k) => k[2] === false), `open-GOP H.264 keys: ${keys.map((k) => (k[2] ? 'IDR' : k[2] === false ? 'I' : '?')).join(' ')}`);
    w.close();
    const c = await new Session(F('h264_aac.mkv'), { video: 'webcodecs' }).open();
    const cs = newState();
    await pull(c, cs);
    const ck = cs.video.filter((x) => x[1] === 'K');
    check(ck.length && ck.every((k) => k[2] === true), `closed-GOP H.264 keys are IDRs (${ck.length})`);
    c.close();
    const ts = await new Session(F('h264_aac.m2ts'), { video: 'webcodecs' }).open();
    const tss = newState();
    await pull(ts, tss);
    const tk = tss.video.filter((x) => x[1] === 'K');
    check(tk.length && tk.every((k) => k[2] === true), `Annex B (TS) H.264 keys are IDRs (${tk.length})`);
    ts.close();
  },

  async nonRef() {
    // skip_frame=nonref drops frames; restoring brings them back.
    const s = await new Session(F('opengop_hevc.mkv'), { video: 'soft', log: LOG }).open();
    const a = newState();
    await pull(s, a, (x) => lastVT(x) >= 3);
    s.send({ type: 'skipNonRef', on: true });
    const b = newState();
    await pull(s, b, (x) => lastVT(x) >= 6);
    s.send({ type: 'skipNonRef', on: false });
    const c = newState();
    await pull(s, c);
    const rate = (st) => st.video.length / Math.max(1e-3, st.video[st.video.length - 1][0] - st.video[0][0]);
    check(rate(b) < rate(a) * 0.8 && rate(c) > rate(a) * 0.9, `frames per media second: ${rate(a).toFixed(1)} → nonref ${rate(b).toFixed(1)} → restored ${rate(c).toFixed(1)}`);
    check(!s.logs.some((l) => /skip_frame/.test(l)), 'skip_frame option accepted');
    s.close();
  },
};

(async () => {
  for (const [name, fn] of Object.entries(tests)) {
    if (only.length && !only.includes(name)) continue;
    console.log(name);
    try { await fn(); } catch (e) { failed++; console.log(`  FAIL ${e && e.stack || e}`); }
  }
  console.log(failed ? `${failed} FAILED` : 'all passed');
  process.exit(failed ? 1 : 0);
})();
