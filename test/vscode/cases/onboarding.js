'use strict';
// Decoder rule and onboarding in a real VS Code (docs/PRODUCT.md, "Decoder rule" and "Onboarding").
//   onboarding-ffmpeg: with ffmpeg, 8-bit H.264 stays on the editor's GPU decoder (WebCodecs) and
//                      HEVC goes to native ffmpeg; no first-open popup (ffmpeg was found).
//   onboarding:        without ffmpeg, the first-open popup once (the log line), then, after it
//                      is dismissed, the "falling behind" reminder for 4K HEVC 10-bit.
const path = require('path');

const res = (name, problems, extra = {}) => ({ name, ok: !problems.length, problems, ...extra });

/** Opens a clip and waits for its first frame; returns the log mark from before the open. */
async function show(vs, h, file, timeout = 45000) {
  const from = await h.openClip(vs, path.join(h.MEDIA, file));
  await vs.waitLog(new RegExp(`\\[${h.esc(file)}\\] webview: first frame shown`), { from, timeout, what: `${file}: first frame` });
  return from;
}

module.exports = [
  {
    name: 'onboarding-ffmpeg',
    ffmpeg: true,
    async run(vs, h) {
      const out = [];
      for (const [file, want, path_] of [
        ['h264_8_1080p.mp4', /decoder: built-in: 8-bit H\.264: the editor's GPU decoder \(WebCodecs\)/, 'webcodecs'],
        ['hevc_8_1080p.mp4', /decoder: native ffmpeg \(/, null],
      ]) {
        const p = [];
        let decision = null;
        try {
          const from = await show(vs, h, file);
          const line = await vs.waitLog(new RegExp(`\\[${h.esc(file)}\\] decoder: `), { from, timeout: 8000 }).catch(() => null);
          decision = line ? line.replace(/^.*?decoder: /, '') : null;
          if (!line || !want.test(line)) p.push(`decision: ${decision || 'none logged'}`);
          if (path_) {
            const st = await vs.waitLog(new RegExp(`\\[${h.esc(file)}\\] webview: streams: `), { from, timeout: 8000 }).catch(() => null);
            const m = st && /-> video (\w+)/.exec(st);
            if (!m || m[1] !== path_) p.push(`decoded by ${m ? m[1] : 'unknown'}, expected ${path_}`);
          }
        } catch (e) { p.push(e.message); }
        await h.closeClip(vs);
        out.push(res(`decision/${file}`, p, { decision }));
      }
      const asked = vs.lines.filter((l) => /onboarding: first video/.test(l));
      out.push(res('no-popup-with-ffmpeg', asked.length ? ['the first-open popup was shown although ffmpeg is there'] : []));
      return out;
    },
  },
  {
    name: 'onboarding',
    async run(vs, h) {
      const out = [];
      // First video: the popup, once.
      let p = [];
      try {
        const from = await h.openClip(vs, path.join(h.MEDIA, 'h264_aac_anim_1080p.mp4'));
        await vs.waitLog(/onboarding: first video, asking about ffmpeg/, { from, timeout: 30000, what: 'the first-open popup' });
        await vs.waitLog(/\[h264_aac_anim_1080p\.mp4\] webview: first frame shown/, { from, timeout: 45000 });
        await h.closeClip(vs);
        await show(vs, h, 'hevc_8_1080p.mp4');
        await h.sleep(1500);
        await h.closeClip(vs);
        const n = vs.lines.filter((l) => /onboarding: first video/.test(l)).length;
        if (n !== 1) p.push(`popup shown ${n} times, expected once`);
      } catch (e) { p.push(e.message); }
      out.push(res('popup-once', p));
      // Dismiss it (no one answers on the hidden desktop), then a 4K HEVC 10-bit clip falls behind.
      p = [];
      let hint = null;
      try {
        const m0 = vs.mark();
        vs.send({ command: 'notifications.clearAll' });
        await vs.waitLog(/onboarding: answer dismissed/, { from: m0, timeout: 10000, what: 'the popup dismissed' });
        const from = await show(vs, h, 'hevc_10_2160p.mp4');
        const line = await vs.waitLog(/\[hevc_10_2160p\.mp4\] built-in decoding at .*suggesting ffmpeg: /, { from, timeout: 30000, what: 'the reminder' });
        hint = line.replace(/^.*suggesting ffmpeg: /, '');
        if (!/^HEVC 10-bit 4K plays at about [\d.]+ of \d+ frames per second here\. Set up ffmpeg \(≈\d+ MB, no admin needed\): .*faster/.test(hint)) p.push(`wording: ${hint}`);
      } catch (e) { p.push(e.message); }
      await h.closeClip(vs).catch(() => {});
      out.push(res('reminder-4k-hevc10', p, { hint }));
      return out;
    },
  },
];
