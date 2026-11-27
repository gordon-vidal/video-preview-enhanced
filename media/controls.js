// @ts-check
// The player's panels (docs/notes/ui-simple.md): the settings panel behind the cog (speed, loop,
// A-B loop, subtitles, audio track, copy frame, keyboard shortcuts, jump sizes, tools), the speed
// panel, the subtitles and audio-track pages, the file facts (i) and the keyboard shortcuts sheet (?).
// One panel at a time, anchored above the bar's right end; each bar button toggles its own page.
// The facts are plain words from what the player already knows (VpeControls.facts, also used by
// test/host/controls_test.js). Colours come from the VS Code theme (media/player.css).
'use strict';
/* exported VpeControls */
const VpeControls = (() => {
  const PIC = typeof VpePicture !== 'undefined' ? VpePicture : require('./picture');
  /** @param {HTMLElement} element @param {(text: string) => void} announce */
  function createToast(element, announce) {
    let timer = 0;
    /** @type {Animation | undefined} */
    let fade;
    const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
    const fadeMs = 120;
    return (text, ms = 1500) => {
      clearTimeout(timer);
      // An exit fade from the previous message must never hide its replacement.
      if (fade) {
        fade.onfinish = null;
        fade.cancel();
        fade = undefined;
      }
      announce(text);
      element.textContent = text;
      const wasHidden = element.hidden;
      element.hidden = false;
      if (wasHidden && !reducedMotion.matches) fade = element.animate({ opacity: [0, 1] }, fadeMs);
      timer = setTimeout(() => {
        if (reducedMotion.matches) element.hidden = true;
        else {
          const exit = element.animate({ opacity: [1, 0] }, { duration: fadeMs, fill: 'forwards' });
          fade = exit;
          exit.onfinish = () => { element.hidden = true; exit.cancel(); fade = undefined; };
        }
      }, ms);
    };
  }

  /** @param {HTMLElement} element @param {HTMLElement} stage */
  function createPlayFlash(element, stage) {
    /** @type {Animation | undefined} */
    let flash;
    return (/** @type {boolean} */ playing) => {
      // Use the visible stage bounds so scrolling a 100% picture cannot move the flash offscreen.
      const { left, top, width, height } = stage.getBoundingClientRect();
      element.style.left = `${left + width / 2}px`;
      element.style.top = `${top + height / 2}px`;
      element.classList.toggle('playing', playing);
      flash?.cancel();
      flash = element.animate({
        opacity: [1, 1, 0], scale: ['1', '1', 'var(--play-flash-scale)'], offset: [0, 0.15, 1],
      }, { duration: 420, easing: 'ease-out' });
    };
  }

  /**
   * @param {HTMLElement} band @param {HTMLElement} pinA @param {HTMLElement} pinB
   * @param {{hidden: boolean, left: number, width: number, aPct: number|null, bPct: number|null}} marks
   */
  function drawRangeMarks(band, pinA, pinB, marks) {
    const { hidden, left, width, aPct, bPct } = marks;
    band.hidden = hidden;
    band.classList.toggle('has-range', aPct !== null && bPct !== null);
    band.style.left = `${left}%`;
    band.style.width = `${Math.min(100 - left, width)}%`;
    pinA.hidden = aPct === null;
    pinB.hidden = bPct === null;
    if (aPct !== null) pinA.style.left = `${aPct}%`;
    if (bPct !== null) pinB.style.left = `${bPct}%`;
  }

  /** The A / B buttons beside the time: pressed while that end of the A-B range is set. */
  function drawRangeButtons(/** @type {HTMLElement} */ btnA, /** @type {HTMLElement} */ btnB, /** @type {{a: number|null, b: number|null}} */ ab) {
    btnA.setAttribute('aria-pressed', String(ab.a !== null));
    btnB.setAttribute('aria-pressed', String(ab.b !== null));
  }

  const SVG = (body, o = {}) => `<svg width="${o.size || 18}" height="${o.size || 18}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${o.sw || 1.6}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
  const ICON = {
    speed: SVG('<circle cx="12" cy="13" r="8"></circle><path d="M12 13l4-4M12 3v2"></path>'),
    loop: SVG('<path d="M17 2l3 3-3 3M3 11V9a4 4 0 0 1 4-4h13M7 22l-3-3 3-3M21 13v2a4 4 0 0 1-4 4H4"></path>'),
    subs: SVG('<rect x="3" y="5" width="18" height="14" rx="2"></rect><path d="M10.5 10h-2A1.5 1.5 0 0 0 7 11.5v1A1.5 1.5 0 0 0 8.5 14h2M17 10h-2a1.5 1.5 0 0 0-1.5 1.5v1A1.5 1.5 0 0 0 15 14h2"></path>'),
    audio: SVG('<path d="M4 9h4l5-4v14l-5-4H4z"></path><path d="M16.5 8.5a5 5 0 0 1 0 7"></path>'),
    camera: SVG('<rect x="3" y="7" width="18" height="13" rx="2"></rect><circle cx="12" cy="13.5" r="3.5"></circle><path d="M8 7l1.5-3h5L16 7"></path>'),
    keys: SVG('<rect x="2.5" y="6" width="19" height="12" rx="2"></rect><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"></path>'),
    chev: SVG('<path d="M9 6l6 6-6 6"></path>', { size: 16, sw: 1.8 }),
    back: SVG('<path d="M15 6l-6 6 6 6"></path>', { size: 16, sw: 1.8 }),
    close: SVG('<path d="M6 6l12 12M18 6L6 18"></path>', { size: 16, sw: 2 }),
    gear: SVG('<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"></path><circle cx="16" cy="6" r="2"></circle><circle cx="10" cy="12" r="2"></circle><circle cx="18" cy="18" r="2"></circle>'),
    external: SVG('<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"></path>', { size: 16, sw: 1.8 }),
    globe: SVG('<circle cx="12" cy="12" r="9"></circle><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"></path>'),
    inspect: SVG('<circle cx="11" cy="11" r="6.5"></circle><path d="M16 16l4.5 4.5M11 8v6M8 11h6"></path>'),
    picture: SVG('<rect x="3" y="5" width="18" height="14" rx="1.5"></rect><rect x="8" y="9" width="8" height="6" rx="0.8"></rect>'),
    quality: SVG('<rect x="3" y="5" width="18" height="14" rx="2"></rect><path d="M7 15v-3M11 15V9M15 15v-5M19 15V8" stroke-width="1.4"></path>'),
  };
  /**
   * The speed ladder: the presets in the speed panel and what the wheel over the speed button walks through
   * (Shift+wheel and Shift+< / > keep the fine steps of SPEED_STEP).
   */
  const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];
  /** The preset chips in the speed popover: the most used speeds, one row (maintainer, 2026-11-27). */
  const PANEL_SPEEDS = [0.5, 1, 1.5, 2];
  /** How long a peeked popover stays after the last peek, then how long it fades (create's peek). */
  const PEEK_MS = 1500, FADE_MS = 200;
  const SPEED_MIN = 0.25, SPEED_MAX = 4, SPEED_STEP = 0.05;
  /**
   * The next preset above (dir 1) or below (dir -1) a speed: a speed between two presets goes to the nearer one in
   * that direction; the ends stay where they are.
   */
  const presetRate = (r, dir) => {
    const v = Number(r);
    if (dir > 0) return SPEEDS.find((p) => p > v + 1e-6) ?? SPEEDS[SPEEDS.length - 1];
    for (let i = SPEEDS.length - 1; i >= 0; i--) if (SPEEDS[i] < v - 1e-6) return SPEEDS[i];
    return SPEEDS[0];
  };
  /** Jump sizes: one frame or seconds (settings videoPreviewEnhanced.jump.arrow / jump.shift / jump.ctrl). */
  const NAV = ['frame', 1, 5, 10, 30];
  const navName = (v) => (v === 'frame' ? '1 frame' : `${v} s`);
  /**
   * Step sizes of the buttons beside Play, picked with the small badge on them (this tab only, like the picture
   * size button): one frame, five frames, or seconds. Until a pick the setting stepButtons decides (stepSizeOf).
   */
  const STEP_SIZES = ['frame', 'frames5', 1, 5, 10];
  const stepName = (v) => (v === 'frame' ? '1 frame' : v === 'frames5' ? '5 frames' : `${v} s`);
  const stepBadge = (v) => (v === 'frame' ? '1f' : v === 'frames5' ? '5f' : `${v}s`);
  /** @param {{stepSize?: any, stepButtons?: string, jump: {ctrl: any}}} p */
  const stepSizeOf = (p) => (p.stepSize !== undefined && p.stepSize !== null ? p.stepSize : p.stepButtons === 'jump' ? p.jump.ctrl : 'frame');
  /** How many frames (n) or seconds (s) one press of a step button moves. */
  const stepAmount = (v) => (v === 'frame' ? { n: 1 } : v === 'frames5' ? { n: 5 } : { s: Number(v) });
  /** The badges on the two step buttons: the size, quiet at the default one frame (data-default, media/player.css). */
  function drawStepBadges(/** @type {HTMLElement[]} */ badges, v) {
    for (const b of badges) {
      if (!b) continue;
      b.textContent = stepBadge(v);
      b.dataset.default = v === 'frame' ? '1' : '0';
      b.title = `Step size: ${stepName(v)}. Click to change`;
      b.setAttribute('aria-label', `Step size: ${stepName(v)}`);
    }
  }
  /**
   * The volume slider folds behind Mute (media/player.css .vol-wrap); while it is dragged its wrapper keeps it open
   * (.dragging), so a drag that leaves the pair does not shut the slider under the pointer.
   */
  function holdVolumeOpen(/** @type {HTMLElement} */ input) {
    const wrap = input.closest('.vol-wrap');
    const win = input.ownerDocument.defaultView;
    if (!wrap || !win) return;
    const end = () => {
      wrap.classList.remove('dragging');
      win.removeEventListener('pointerup', end, true);
      win.removeEventListener('pointercancel', end, true);
    };
    input.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      wrap.classList.add('dragging');
      win.addEventListener('pointerup', end, true);
      win.addEventListener('pointercancel', end, true);
    });
  }
  /** Tooltips and labels of the buttons beside Play for the step size (stepSizeOf), else prefs.stepButtons. */
  const stepTips = (p) => {
    const ctrl = /Mac/i.test((typeof navigator !== 'undefined' && navigator.platform) || '') ? 'Cmd' : 'Ctrl';
    if (p.stepSize !== undefined && p.stepSize !== null && p.stepSize !== 'frame') {
      const what = stepName(p.stepSize);
      return {
        back: `Back ${what}  (size: badge above)`, fwd: `Forward ${what}  (size: badge above)`,
        backLabel: `Back ${what}`, fwdLabel: `Forward ${what}`,
      };
    }
    if (p.stepSize !== 'frame' && p.stepButtons === 'jump') {
      const n = p.jump.ctrl;
      const what = n === 'frame' ? 'one frame' : `${n} s`;
      return {
        back: `Back ${what}  (${ctrl}+←; size in settings)`, fwd: `Forward ${what}  (${ctrl}+→; size in settings)`,
        backLabel: `Back ${what}`, fwdLabel: `Forward ${what}`,
      };
    }
    return { back: 'Previous frame  ,', fwd: 'Next frame  .', backLabel: 'Previous frame', fwdLabel: 'Next frame' };
  };
  const speedText = (v) => `${+Number(v).toFixed(2)}×`;
  /**
   * Speeds the player offers: 0.25–4× in steps of 0.05, the range in which the sound keeps its pitch
   * (timestretch.js), so the sound never drops out because of the speed.
   */
  const clampRate = (r) => Math.min(SPEED_MAX, Math.max(SPEED_MIN, Math.round(Number(r) * 20) / 20));

  // ---- file facts in plain words ------------------------------------------------------------
  const VCODEC = {
    h264: 'H.264 (AVC)', hevc: 'HEVC (H.265)', av1: 'AV1', vp9: 'VP9', vp8: 'VP8', mpeg2video: 'MPEG-2', mpeg1video: 'MPEG-1',
    mpeg4: 'MPEG-4 Part 2', msmpeg4v3: 'MPEG-4 (DivX 3)', prores: 'Apple ProRes', dnxhd: 'Avid DNxHD / DNxHR', mjpeg: 'Motion JPEG',
    wmv1: 'Windows Media Video 7', wmv2: 'Windows Media Video 8', wmv3: 'Windows Media Video 9', vc1: 'VC-1', theora: 'Theora',
    ffv1: 'FFV1 (lossless)', h263: 'H.263', flv1: 'Sorenson Spark (FLV)', cfhd: 'GoPro CineForm', hap: 'HAP', png: 'PNG frames', rawvideo: 'uncompressed',
  };
  const ACODEC = {
    aac: 'AAC', mp3: 'MP3', mp2: 'MPEG audio layer 2', opus: 'Opus', vorbis: 'Vorbis', flac: 'FLAC (lossless)', alac: 'Apple Lossless',
    ac3: 'Dolby Digital (AC-3)', eac3: 'Dolby Digital Plus (E-AC-3)', truehd: 'Dolby TrueHD', dts: 'DTS', wmav2: 'Windows Media Audio',
    wmapro: 'Windows Media Audio Pro', pcm_s16le: 'PCM (uncompressed)', pcm_s24le: 'PCM 24-bit (uncompressed)', pcm_f32le: 'PCM float (uncompressed)', pcm_s16be: 'PCM (uncompressed)',
  };
  const plainV = (c) => VCODEC[c] || (c ? String(c).toUpperCase() : 'unknown');
  const plainA = (c) => ACODEC[c] || (/^pcm_/.test(c || '') ? 'PCM (uncompressed)' : c ? String(c).toUpperCase() : 'unknown');
  const CH = { 1: 'mono', 2: 'stereo', 3: '2.1', 6: '5.1 surround', 7: '6.1 surround', 8: '7.1 surround' };
  const rateText = (bps) => (bps >= 1e6 ? `about ${bps >= 1e7 ? Math.round(bps / 1e6) : (bps / 1e6).toFixed(1)} Mb/s` : `about ${Math.round(bps / 1e3)} kb/s`);
  const sizeText = (b) => (b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1e3))} KB`);
  function durText(t) {
    if (!(t > 0)) return '';
    const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = Math.round(t % 60);
    if (h) return `${h} h ${m} min`;
    if (m) return `${m} min${s ? ` ${s} s` : ''}`;
    return t < 10 ? `${+t.toFixed(1)} s` : `${s} s`;
  }
  function resLabel(w, h) {
    const big = Math.max(w, h * 16 / 9);
    if (big >= 7600) return '8K';
    if (big >= 3800) return '4K';
    if (big >= 2500) return '1440p';
    if (big >= 1900) return '1080p';
    if (big >= 1260) return '720p';
    if (big >= 840) return '480p';
    return '';
  }
  const fpsText = (f) => `${+Number(f).toFixed(Math.abs(f - Math.round(f)) < 0.005 ? 0 : 2)} frames per second`;

  // ---- HLS quality (variants of a master playlist) -------------------------------------------
  /** "1080p", else the bit rate when the playlist gives no picture size. */
  const variantName = (v) => (v.height ? `${v.height}p` : v.bandwidth ? rateText(v.bandwidth).replace(/^about /, '') : `Variant ${v.id + 1}`);
  /** The rows of the Quality page: Auto, then the variants from the largest picture (and rate) down; duplicates once. */
  function qualityRows(q) {
    const cur = q.variants.find((v) => v.id === q.current);
    const seen = new Set();
    const list = [...q.variants].sort((a, b) => (b.height || 0) - (a.height || 0) || b.bandwidth - a.bandwidth).filter((v) => {
      const k = `${v.width}x${v.height}@${v.bandwidth}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    const named = new Map();
    for (const v of list) named.set(variantName(v), (named.get(variantName(v)) || 0) + 1);
    return [
      { id: 'auto', label: 'Auto', sub: cur && q.pick === 'auto' ? variantName(cur) : '', checked: q.pick === 'auto' },
      ...list.map((v) => ({
        id: v.id, label: variantName(v),
        sub: [named.get(variantName(v)) > 1 || v.height ? rateText(v.bandwidth).replace(/^about /, '') : '', v.width && v.height ? `${v.width} × ${v.height}` : ''].filter(Boolean).join(' · '),
        checked: q.pick === v.id,
      })),
    ];
  }
  /** The ⚙ row's value: "Auto (720p)" or "720p". */
  function qualityLabel(q) {
    const cur = q.variants.find((v) => v.id === q.current);
    return q.pick === 'auto' ? `Auto${cur ? ` (${variantName(cur)})` : ''}` : cur ? variantName(cur) : '';
  }

  /**
   * The facts of the info panel.
   * @param {{ name: string, size?: number, duration?: number, width?: number, height?: number, fps?: number,
   *   info?: any, vmode?: string, amode?: string, native?: boolean, remoteStream?: boolean, frames?: boolean, tracks?: any, subFiles?: number,
   *   stream?: { host: string, live?: boolean, variant?: { width: number, height: number, bandwidth: number } | null } | null }} o
   * @returns {{ title: string, sub: string, rows: Array<[string, string]> }}
   */
  function facts(o) {
    const info = o.info || {};
    const v = info.video || null;
    const a = info.audio || null;
    const rows = [];
    const w = o.width || (v && (v.sourceWidth || v.width)) || 0;
    const h = o.height || (v && (v.sourceHeight || v.height)) || 0;
    if (w && h) {
      const rl = resLabel(w, h);
      rows.push(['Picture', `${w} × ${h}${rl ? ` (${rl})` : ''}${o.fps ? `, ${fpsText(o.fps)}` : ''}`]);
    }
    if (v) {
      const depth = v.depth || (/1[02]le|1[02]be|p010|p016/.test(v.pixFmt || '') ? (/12/.test(v.pixFmt) ? 12 : 10) : 8);
      const hdr = v.colorTrc === 16 ? 'HDR (PQ / HDR10)' : v.colorTrc === 18 ? 'HDR (HLG)' : 'standard range (SDR)';
      rows.push(['Quality', `${hdr}, ${depth}-bit colour`]);
      const total = o.size && o.duration ? (o.size * 8) / o.duration : 0;
      const br = v.bitRate > 0 ? rateText(v.bitRate) : total > 0 ? `${rateText(total)} (whole file)` : '';
      rows.push(['Video', `${plainV(v.codec)}${br ? `, ${br}` : ''}`]);
    } else if (!o.frames) rows.push(['Video', 'none (sound only)']);
    if (a) {
      const ch = a.sourceChannels || a.channels;
      const sr = a.sourceRate || a.sampleRate;
      rows.push(['Sound', [plainA(a.codec), ch ? CH[ch] || `${ch} channels` : '', sr ? `${+(sr / 1000).toFixed(1)} kHz` : '', a.bitRate > 0 ? rateText(a.bitRate) : ''].filter(Boolean).join(', ')]);
    } else if (!o.frames || o.hasSound === false) rows.push(['Sound', 'none']);
    const tr = o.tracks || {};
    const na = tr.audio !== undefined ? tr.audio : a ? 1 : 0;
    const ns = (tr.sub || 0) + (o.subFiles || 0);
    rows.push(['Tracks', `${na === 0 ? 'no sound' : na === 1 ? '1 audio' : `${na} audio`} · ${ns === 0 ? 'no subtitles' : ns === 1 ? '1 subtitle' : `${ns} subtitles`}`]);
    let by;
    if (info.transcode && info.transcode.label) {
      by = info.transcode.label;
      if (Number(info.transcode.locked) > 0) by += `, resolution fixed at ${Number(info.transcode.locked)}p for this video`;
    }
    else if (o.remoteStream) by = 'ffmpeg on the remote machine, sent as H.264 to your GPU';
    else if (o.native) by = info.method && info.method !== 'none' ? `your GPU (${info.method}), through ffmpeg` : 'ffmpeg, on the processor';
    else if (o.frames) by = 'the built-in image decoder';
    else if (o.vmode === 'webcodecs') by = 'your GPU (built into VS Code)';
    else if (o.vmode === 'soft') by = 'the built-in decoder (WebAssembly, on the processor)';
    else if (o.amode === 'webcodecs' || o.amode === 'soft') by = 'the built-in decoder';
    if (by) rows.push(['Played by', by]);
    // A URL: where it comes from and that it streams, instead of a file size (a live stream has no length).
    const st = o.stream;
    const sub = st ? [st.host, st.live ? 'live stream' : 'stream', st.live ? '' : durText(o.duration || 0)] : [o.size ? sizeText(o.size) : '', durText(o.duration || 0)];
    if (st && st.variant) rows.push(['Stream', `HLS variant ${st.variant.width && st.variant.height ? `${st.variant.width} × ${st.variant.height}, ` : ''}${rateText(st.variant.bandwidth)}`]);
    return { title: o.name || '', sub: sub.filter(Boolean).join(' · '), rows };
  }

  // ---- the keyboard shortcuts sheet ----------------------------------------------------------
  const ctrlName = /Mac/i.test((typeof navigator !== 'undefined' && navigator.platform) || '') ? 'Cmd' : 'Ctrl';
  function keyGroups(p) {
    if (p.compare) {
      // Compare (media/compare.js): one bar for all videos.
      return [
        { title: 'Playback', rows: [['Play / pause (all)', 'Space', 'K'], ['Click a video', 'Play / pause'], [`Speed −/+ ${SPEED_STEP}`, 'Shift+<', 'Shift+>'], ['Loop', 'R'], ['A–B range start / end', 'A', 'B']] },
        { title: 'Seek', rows: [[`Back / forward ${navName(p.jump.arrow)}`, '←', '→'], [`Back / forward ${navName(p.jump.shift)}`, 'Shift+←', 'Shift+→'], [`Back / forward ${navName(p.jump.ctrl)}`, `${ctrlName}+←`, `${ctrlName}+→`], ['Back / forward 10 s', 'J', 'L'], ['Start / end', 'Home', 'End']] },
        { title: 'Frames', rows: [['Previous / next frame (all videos)', ',', '.'], ['Copy view', `${ctrlName}+C`], ['Time / timecode / frames', 'click the time']] },
        { title: 'Sound', rows: [['Volume ±5 %', '↑', '↓'], ['Mute', 'M']] },
        { title: 'Compare', rows: [['Nudge the video under the pointer', '−', '+'], ['Swap sides (2 videos)', 'X'], ['Add videos by clicking them in the Explorer', 'Shift+D']] },
        { title: 'View and help', rows: [['Fullscreen', 'F'], ['Picture size (all videos)', 'Z'], ['Zoom (all videos)', `${ctrlName}+wheel`], ['About these videos', 'I'], ['This list', '?'], ['Close menus', 'Esc']] },
      ];
    }
    return [
      { title: 'Playback', rows: [['Play / pause', 'Space', 'K'], ['Click the picture', 'Play / pause'], [`Speed −/+ ${SPEED_STEP}`, 'Shift+<', 'Shift+>'], ['Loop', 'R'], ['A–B range start / end', 'A', 'B'], ['Clear the A–B range', 'Backspace']] },
      { title: 'Seek', rows: [[`Back / forward ${navName(p.jump.arrow)}`, '←', '→'], [`Back / forward ${navName(p.jump.shift)}`, 'Shift+←', 'Shift+→'], [`Back / forward ${navName(p.jump.ctrl)}`, `${ctrlName}+←`, `${ctrlName}+→`], ['Back / forward 10 s', 'J', 'L'], ['Start / end', 'Home', 'End'], ['Jump to 0–90 %', '0…9']] },
      { title: 'Frames', rows: [['Previous / next frame', ',', '.'], ['Copy frame', `${ctrlName}+C`], ['Save frame as PNG', 'S'], ['Copy timestamp', 'T'], ['Go to frame or time', `${ctrlName}+G`], ['Time / timecode / frames', 'click the time']] },
      { title: 'Sound', rows: [['Volume ±5 %', '↑', '↓'], ['Mute', 'M'], ['Next audio track', 'Shift+A']] },
      { title: 'View', rows: [['Fullscreen', 'F'], ['Subtitles on / off', 'C'], ['About this video', 'I'], ['Picture size: Fit, Fill, Stretch, 100 %', 'Z'], ['Zoom in / out', '+', '-'], ['Zoom at the pointer', `${ctrlName}+wheel`]] },
      { title: 'Tools', rows: [['Scopes', 'W'], ['Pixel inspector', 'X'], ['Codec X-ray', 'Shift+X'], ['Stats', 'Shift+I'], ['Previous / next keyframe', '{', '}']] },
      { title: 'Files and help', rows: [['Next / previous video in folder', 'Shift+N', 'Shift+P'], ['Compare with another video', 'D'], ['Compare with the next video clicked in the Explorer', 'Shift+D'], ['Compare by dropping a video here', 'Shift+drag'], ['This list', '?'], ['Close menus', 'Esc']] },
    ];
  }

  /**
   * The remote Live transcode chip (#remoteLiveBtn): shown only in remote windows while a video plays through
   * Live transcode, so a local window stays quiet. It names the picture height and bitrate cap, or the quality
   * ladder's direction while it changes, and opens the Live transcode page (Auto / Always / Off, max bitrate).
   * @param {{ remote?: boolean, active?: boolean, height?: number, transcode?: any }} o
   */
  function remoteChipState(o) {
    if (!o || !o.remote || !o.active) return { visible: false, text: '', title: '', ariaLabel: '', adapting: false };
    const tc = o.transcode || {};
    const dir = tc.adaptingDir === 'down' ? 'down' : tc.adaptingDir === 'up' ? 'up' : null;
    const h = Number(tc.h || o.height) || 0;
    const res = h > 0 ? `${h}p` : '';
    const kbps = Number(tc.maxKbps) || 0;
    const rate = kbps >= 1000 ? `${+(kbps / 1000).toFixed(1)} Mb/s` : kbps > 0 ? `${Math.round(kbps)} kb/s` : '';
    // A resolution fixed for this video (⚙ › Live transcode › Resolution): the ladder does not move it.
    const locked = Number(tc.locked) > 0;
    const lowered = !locked && tc.tier > 0;
    let text;
    let ariaLabel;
    if (dir && !locked) {
      text = `Live · Adapting ${dir === 'down' ? '↓' : '↑'}`;
      ariaLabel = `Live transcode adapting quality ${dir}. Open Live transcode settings`;
    } else {
      text = ['Live', res ? (lowered ? `${res} ↓` : res) : '', rate].filter(Boolean).join(' · ');
      ariaLabel = `Live transcode active${res ? `, ${res}` : ''}${lowered ? ' (adapted down)' : ''}${locked ? ' (fixed resolution)' : ''}${rate ? `, max ${rate}` : ''}. Open Live transcode settings`;
    }
    const fixed = locked ? `. Resolution fixed at ${Number(tc.locked)}p for this video` : '';
    const title = `${tc.label || 'Live transcode active'}${fixed}. Click to adjust resolution, mode or max bitrate`;
    return { visible: true, text, title, ariaLabel, adapting: !!((dir && !locked) || lowered) };
  }

  /** Live transcode heights a video can be fixed at (src/transcode_policy.js RESOLUTIONS). */
  const TRANSCODE_HEIGHTS = [2160, 1440, 1080, 720, 480, 360];
  /**
   * The Resolution chips of ⚙ › Live transcode: Auto, then the heights up to the source's (up to 1080p when it is not
   * known), and the current one even when it is above the source (a saved default), so the checked chip is shown.
   * @param {number} source the source video's height (0: unknown) @param {number} current 0 = Auto
   * @returns {{ h: number, label: string }[]}
   */
  function resolutionChoices(source, current) {
    const top = source > 0 ? source : 1080;
    const hs = TRANSCODE_HEIGHTS.filter((h) => h <= top || h === current);
    return [{ h: 0, label: 'Auto' }, ...hs.map((h) => ({ h, label: `${h}p` }))];
  }

  /**
   * @param {{
   *   panel: HTMLElement, sheet: HTMLElement, bar: HTMLElement,
   *   buttons: { cog: HTMLElement, info: HTMLElement, rate: HTMLElement, tracks: HTMLElement, keys: HTMLElement, remoteLive?: HTMLElement },
   *   get: () => any, act: Record<string, (...a: any[]) => void>,
   * }} env
   */
  function create(env) {
    const { panel, sheet, bar, buttons, onShow } = env;
    /** @type {null|'main'|'autoplay'|'speed'|'ab'|'inspect'|'picture'|'transcode'|'subs'|'audio'|'quality'|'info'|'step'} */
    let view = null;
    /** @type {HTMLElement|null} */
    let opener = null;
    /** @type {HTMLElement|null} */
    let sheetOpener = null;
    let speedDrag = null;

    const el = (tag, cls, text) => {
      const e = document.createElement(tag);
      if (cls) e.className = cls;
      if (text !== undefined) e.textContent = text;
      return e;
    };
    const kbd = (t) => el('kbd', '', t);
    const btn = (cls, label, onClick, o = {}) => {
      const b = el('button', cls);
      b.type = 'button';
      if (o.icon) b.insertAdjacentHTML('beforeend', o.icon);
      if (label !== null) b.appendChild(el('span', 'grow', label));
      if (o.value !== undefined) b.appendChild(el('span', 'val', o.value));
      if (o.kbd) { const k = kbd(o.kbd); k.setAttribute('aria-hidden', 'true'); b.appendChild(k); b.setAttribute('aria-keyshortcuts', o.kbd.replace('Ctrl', 'Control')); }
      if (o.chev) b.insertAdjacentHTML('beforeend', ICON.chev);
      if (o.aria) for (const [k, v] of Object.entries(o.aria)) b.setAttribute(k, v);
      b.dataset.nav = '1';
      b.addEventListener('click', (e) => { e.stopPropagation(); onClick(e); });
      return b;
    };
    /** A page's title row: back to `to` (the main page, or a compare page's parent). */
    const head = (title, to = 'main') => btn('row head', title, () => show(to), { icon: ICON.back, aria: { 'aria-label': `Back from ${title}` } });
    /**
     * Stepper: [name] − value + in one row of chips. With reset, the value is a chip that resets; without, plain text
     * (taking the middle when there is no name). down / up label the − / + buttons.
     * @param {{ name: string, value: string, minus: () => void, plus: () => void, reset?: () => void, showName?: boolean, down?: string, up?: string }} o
     */
    const stepper = (o) => {
      const r = el('div', 'jrow');
      r.setAttribute('role', 'group');
      r.setAttribute('aria-label', o.name);
      if (o.showName !== false) {
        const n = el('span', 'grow', o.name);
        n.setAttribute('aria-hidden', 'true');
        r.appendChild(n);
      }
      const v = o.reset ? btn('chip', o.value, () => { o.reset(); render(); }, { aria: { 'aria-label': `${o.name} ${o.value}, reset` } })
        : el('span', o.showName === false ? 'zval grow' : 'zval', o.value);
      r.append(btn('chip', '−', () => { o.minus(); render(); }, { aria: { 'aria-label': o.down || `${o.name} down` } }), v,
        btn('chip', '+', () => { o.plus(); render(); }, { aria: { 'aria-label': o.up || `${o.name} up` } }));
      return r;
    };
    const heading = (t) => { const h = el('div', 'phead', t); h.setAttribute('aria-hidden', 'true'); return h; };

    /**
     * The main page, in three groups: Playback (everyday controls), Tools (two sub-pages: A–B Range, with its
     * exports, and Inspection) and the footer links. The jump sizes live in VS Code's settings only.
     */
    function renderMain(s) {
      const f = document.createDocumentFragment();
      f.appendChild(heading('Playback'));
      if (s.autoplay) {
        // The player: Off / Play next in folder / Loop (setting onEnd; media/autoplay.js), the rail footer's choice too.
        f.appendChild(btn('row', 'Autoplay', () => show('autoplay'), { icon: ICON.loop, value: s.autoplay.label, chev: true, aria: { 'aria-label': `Autoplay, ${s.autoplay.label}` } }));
      } else {
        const loop = btn('row', 'Repeat video', () => { env.act.loop(); render(); }, { icon: ICON.loop, aria: { role: 'switch', 'aria-checked': String(!!s.loop) } });
        loop.appendChild(sw(!!s.loop));
        f.appendChild(loop);
      }
      f.appendChild(btn('row', 'Speed', () => show('speed'), { icon: ICON.speed, value: speedText(s.rate), chev: true }));
      if (s.compare) {
        // Compare (media/compare.js): the sound comes from one video, chosen in the Compare panel.
        f.appendChild(btn('row', 'Sound', () => show('cmp', buttons.cmp), { icon: ICON.audio, value: s.compare.soundLabel, chev: true }));
      } else {
        f.appendChild(btn('row', 'Subtitles', () => show('subs'), { icon: ICON.subs, value: s.subsLabel, chev: true }));
        f.appendChild(btn('row', 'Audio track', () => show('audio'), { icon: ICON.audio, value: s.audioLabel, chev: true }));
        // An HLS stream with several variants: the picture quality (the stream reopens at that variant).
        if (s.quality) f.appendChild(btn('row', 'Quality', () => show('quality'), { icon: ICON.quality, value: qualityLabel(s.quality), chev: true }));
      }
      if (s.picture) f.appendChild(btn('row', 'Picture size', () => show('picture'), { icon: ICON.picture, value: `${PIC.name(s.picture.mode)}${s.picture.pct !== null ? ` · ${s.picture.pct}%` : ''}`, chev: true, aria: { 'aria-label': `Picture size, ${PIC.name(s.picture.mode)}` } }));
      if (s.transcode) {
        const tm = s.transcode.mode || 'auto';
        const res = s.transcode.active && s.transcode.resolution > 0 ? ` · ${s.transcode.resolution}p` : '';
        const mbps = s.transcode.maxBitrateMbps > 0 ? ` · ${s.transcode.maxBitrateMbps} Mb/s` : '';
        const modeName = tm === 'auto' ? 'Auto' : tm === 'always' ? 'Always' : 'Off';
        f.appendChild(btn('row', 'Live transcode', () => show('transcode'), { icon: ICON.quality, value: `${modeName}${res}${mbps}`, chev: true, aria: { 'aria-label': `Live transcode, ${modeName}${res}${mbps}` } }));
      }
      // Tools that are neither inspection nor A–B (Compare): a row of their own.
      for (const t of (s.tools || []).filter((x) => !x.group)) {
        const b = btn('row', t.title || t.label, () => { if (!t.keepOpen) close(false); t.run(); }, { value: t.note, chev: !!t.keepOpen });
        if (t.ariaLabel) b.setAttribute('aria-label', t.ariaLabel);
        b.dataset.tool = t.label;
        f.appendChild(b);
      }
      f.appendChild(btn('row', s.compare ? 'Copy view' : 'Copy frame', () => { close(false); env.act.copyFrame(); }, { icon: ICON.camera, kbd: 'Ctrl+C' }));
      f.append(el('div', 'sep'), heading('Tools'));
      if (env.act.cycleAB) {
        const ab = btn('row', 'A–B Range', () => show('ab'), { value: s.abLabel, chev: true, aria: { 'aria-label': `A–B Range, ${s.abLabel}` } });
        ab.insertBefore(el('span', 'abicon', 'A-B'), ab.firstChild);
        /** @type {any} */ (ab.firstChild).setAttribute('aria-hidden', 'true');
        f.appendChild(ab);
      }
      const insp = inspectTools(s);
      // The name lists the tools this page offers (Compare has no pixel inspector: X swaps sides there).
      if (insp.length) f.appendChild(btn('row', 'Inspection', () => show('inspect'), { icon: ICON.inspect, value: insp.map((t) => t.key).join(' '), chev: true, aria: { 'aria-label': `Inspection: ${insp.map((t) => { const n = t.title || t.label; return n.charAt(0).toLowerCase() + n.slice(1); }).join(', ')}` } }));
      f.appendChild(el('div', 'sep'));
      // Plays an http(s) link or HLS / DASH stream in a new tab (docs/notes/url-stream.md); the URL is typed in VS Code's input box.
      if (env.act.openUrl) f.appendChild(btn('row', 'Open video URL…', () => { close(false); env.act.openUrl(); }, { icon: ICON.globe }));
      if (s.canExternal && env.act.external) f.appendChild(btn('row', 'Open in system player', () => { close(false); env.act.external(); }, { icon: ICON.external }));
      f.appendChild(btn('row', 'Keyboard shortcuts', () => openSheet(buttons.cog), { icon: ICON.keys, kbd: '?', aria: { 'aria-haspopup': 'dialog' } }));
      const xs = btn('row', 'Extension settings', () => { close(false); env.act.extSettings(); }, { icon: ICON.gear, aria: { 'aria-label': 'Extension settings (opens VS Code Settings)' } });
      xs.insertAdjacentHTML('beforeend', ICON.external);
      f.appendChild(xs);
      return f;
    }

    const inspectTools = (s) => (s.tools || []).filter((t) => t.group === 'inspect');

    /** A–B Range: the range itself and everything that uses it (exports), in one place. Keys A and B work anywhere. */
    function renderAB(s) {
      const f = document.createDocumentFragment();
      f.appendChild(head('A–B Range'));
      const ab = btn('row', 'Set A / B / clear', () => { env.act.cycleAB(); render(); }, { value: s.abLabel });
      ab.insertBefore(el('span', 'abicon', 'A-B'), ab.firstChild);
      /** @type {any} */ (ab.firstChild).setAttribute('aria-hidden', 'true');
      f.appendChild(ab);
      const items = (s.ab && s.ab.items) || [];
      if (items.length) f.appendChild(el('div', 'sep'));
      for (const it of items) {
        const b = btn('row', it.label, () => { close(false); it.run(); });
        if (it.ariaLabel) b.setAttribute('aria-label', it.ariaLabel);
        b.dataset.tool = it.label;
        f.appendChild(b);
      }
      const note = el('div', 'pnote');
      note.append('Keys ', kbd('A'), ' and ', kbd('B'), ' mark the start and end; the range loops and is what the exports use.');
      f.appendChild(note);
      return f;
    }

    /** Inspection: the pixel and codec tools, each with its key (they stay one key away). */
    function renderInspect(s) {
      const f = document.createDocumentFragment();
      f.appendChild(head('Inspection'));
      for (const t of inspectTools(s)) {
        const b = btn('row', t.title || t.label, () => { if (!t.keepOpen) close(false); t.run(); }, { kbd: t.key });
        b.dataset.tool = t.label;
        f.appendChild(b);
      }
      return f;
    }

    /**
     * The speed page (maintainer's pick "A2", 2026-11-27), from blocks: a stepper (− speed +), the slider (the volume
     * bar's look) and one row of preset chips. From the speed button it is a popover (POPOVERS); from ⚙ a page with a
     * title to go back. The keys are in the shortcut sheet, not here.
     */
    function renderSpeed(s) {
      const f = document.createDocumentFragment();
      if (!popover()) f.appendChild(head('Speed'));
      const top = stepper({ name: 'Speed', showName: false, value: speedText(s.rate), minus: () => env.act.stepRate(-1), plus: () => env.act.stepRate(1),
        down: `Slower by ${SPEED_STEP}`, up: `Faster by ${SPEED_STEP}` });
      const read = /** @type {HTMLElement} */ (top.querySelector('.zval'));
      const sl = el('div', 'slider');
      const input = /** @type {HTMLInputElement} */ (el('input', 'range'));
      input.type = 'range'; input.min = String(SPEED_MIN); input.max = String(SPEED_MAX); input.step = String(SPEED_STEP); input.value = String(s.rate);
      input.id = 'speedSlider';
      input.setAttribute('aria-label', 'Speed');
      input.setAttribute('aria-valuetext', speedText(s.rate));
      input.dataset.nav = '1';
      sl.appendChild(input);
      f.append(top, sl);
      // The most used speeds as one row of chips; 1× is the way back to normal.
      const box = el('div', 'jbox');
      const presets = el('div', 'jopts one-row');
      presets.setAttribute('role', 'group');
      presets.setAttribute('aria-label', 'Preset speeds');
      for (const v of PANEL_SPEEDS) {
        presets.appendChild(btn('chip', speedText(v), () => env.act.pickRate(v), { aria: { 'aria-pressed': String(Math.abs(v - s.rate) < 1e-6), 'aria-label': `Speed ${speedText(v)}` } }));
      }
      box.appendChild(presets);
      f.appendChild(box);
      // Apply the rate without rebuilding the panel while the slider owns the pointer; the wheel steps it, as on
      // the volume bar.
      speedDrag = VpeRangeDrag.bind(input);
      VpeRangeDrag.wheelStep(input, (dir) => { env.act.stepRate(dir); render(); });
      input.addEventListener('input', () => {
        const rate = clampRate(Number(input.value));
        env.act.setRate(rate);
        read.textContent = speedText(rate);
        input.setAttribute('aria-valuetext', read.textContent);
        for (const [i, b] of [...presets.children].entries()) {
          b.setAttribute('aria-pressed', String(Math.abs(PANEL_SPEEDS[i] - rate) < 1e-6));
        }
      });
      return f;
    }

    function renderPicture(s) {
      const f = document.createDocumentFragment();
      f.appendChild(head('Picture size'));
      const pc = s.picture;
      f.appendChild(radios('Picture size', PIC.MODES.map((m) => ({ label: PIC.name(m), sub: PIC.SHORT[m], checked: pc.mode === m, pick: () => env.act.setPicture(m) }))));
      f.appendChild(el('div', 'sep'));
      const r = stepper({ name: 'Zoom', value: pc.pct === null ? '—' : `${pc.pct}%`, minus: () => env.act.zoomPicture(-1), plus: () => env.act.zoomPicture(1), down: 'Zoom out', up: 'Zoom in' });
      r.appendChild(btn('chip', 'Reset', () => { env.act.resetPicture(); render(); }, { aria: { 'aria-label': 'Reset zoom' } }));
      f.appendChild(r);
      const note = el('div', 'pnote');
      note.append(kbd('Z'), ' cycles the sizes (zoomed in: back to Fit). Ctrl+wheel zooms, drag moves the picture', s.compare ? '. All videos follow together.' : '.');
      f.appendChild(note);
      return f;
    }

    /** Autoplay: what happens at the end of the video. "Play next in folder" only for a file in a folder. */
    function renderAutoplay(s) {
      const f = document.createDocumentFragment();
      f.appendChild(head('Autoplay'));
      const a = s.autoplay || { mode: 'off', next: false };
      const modes = [['off', 'Off', 'Stop on the last frame'], ...(a.next ? [['next', 'Play next in folder', 'Then stop at the last video']] : []), ['loop', 'Loop', 'Start over']];
      f.appendChild(radios('Autoplay', modes.map(([m, label, sub]) => ({ label, sub, checked: a.mode === m, pick: () => env.act.setAutoplay(m) }))));
      const note = el('div', 'pnote');
      note.append(kbd('R'), ' turns Loop on and off. An A–B range always repeats.');
      f.appendChild(note);
      return f;
    }

    /** The step size popover (badge on ◀| / |▶): the sizes; a pick applies to both buttons and closes it. */
    function renderStep(s) {
      const f = document.createDocumentFragment();
      const cur = s.stepSize;
      const sizes = STEP_SIZES.includes(cur) ? STEP_SIZES : [...STEP_SIZES, cur]; // e.g. 30 s from the setting
      const g = radios('Step size', sizes.map((v) => ({ label: stepName(v), checked: v === cur, pick: () => { env.act.stepSize(v); close(true); } })));
      f.appendChild(g);
      return f;
    }

    function radios(name, list) {
      const g = el('div', 'radios');
      g.setAttribute('role', 'radiogroup');
      g.setAttribute('aria-label', name);
      for (const it of list) {
        const b = btn('row radio', it.label, () => { it.pick(); render(); }, { value: it.sub || undefined, aria: { role: 'radio', 'aria-checked': String(!!it.checked) } });
        const mark = el('span', 'mark', it.checked ? '●' : '');
        mark.setAttribute('aria-hidden', 'true');
        b.insertBefore(mark, b.firstChild);
        g.appendChild(b);
      }
      return g;
    }

    function renderSubs(s) {
      const f = document.createDocumentFragment();
      f.appendChild(head('Subtitles'));
      const t = s.tracks;
      if (!t.subs.length) {
        f.appendChild(el('div', 'ptext', 'This file has no subtitle tracks, and there is no .srt, .vtt or .ass file with the same name next to it.'));
        f.appendChild(btn('primary', 'Load subtitle file…', () => { close(false); env.act.loadSubs(); }));
        return f;
      }
      f.appendChild(radios('Subtitles', [{ label: 'Off', checked: t.sel === 'off', pick: () => env.act.selectSub('off') },
        ...t.subs.map((x) => ({ label: x.main, sub: x.sub, checked: x.checked, pick: () => env.act.selectSub(x.key) }))]));
      f.appendChild(btn('row', 'Load subtitle file…', () => { close(false); env.act.loadSubs(); }));
      f.appendChild(el('div', 'sep'));
      f.appendChild(stepper({ name: 'Delay', value: `${t.delay > 0 ? '+' : ''}${Math.round(t.delay * 1000)} ms`, minus: () => env.act.subDelay(-0.05), plus: () => env.act.subDelay(0.05), reset: () => env.act.subDelay(null) }));
      f.appendChild(stepper({ name: 'Size', value: `${Math.round(t.size * 100)}%`, minus: () => env.act.subSize(-0.1), plus: () => env.act.subSize(0.1), reset: () => env.act.subSize(null) }));
      return f;
    }

    function renderAudio(s) {
      const f = document.createDocumentFragment();
      f.appendChild(head('Audio track'));
      const a = s.tracks.audio;
      if (!a.length) { f.appendChild(el('div', 'ptext', s.hasSound ? 'This file has one sound track.' : 'This file has no sound.')); return f; }
      f.appendChild(radios('Audio track', a.map((x) => ({ label: x.main, sub: x.sub, checked: x.checked, pick: () => env.act.selectAudio(x.id) }))));
      return f;
    }

    function renderQuality(s) {
      const f = document.createDocumentFragment();
      f.appendChild(head('Quality'));
      if (!s.quality) { f.appendChild(el('div', 'ptext', 'This video has one quality.')); return f; }
      f.appendChild(radios('Quality', qualityRows(s.quality).map((x) => ({ label: x.label, sub: x.sub, checked: x.checked, pick: () => { if (!x.checked) { close(false); env.act.setQuality(x.id); } } }))));
      const note = el('div', 'pnote', 'Auto picks the smallest picture that fills the player at the measured download rate, once when the stream opens.');
      f.appendChild(note);
      return f;
    }

    const TRANSCODE_RATES = [0, 2, 5, 10, 20, 40];
    function renderTranscode(s) {
      const f = document.createDocumentFragment();
      f.appendChild(head('Live transcode'));
      f.appendChild(el('div', 'pnote', 'Default for all videos on this machine. Switching can reload the current tab.'));
      const tc = s.transcode || { mode: 'auto', maxBitrateMbps: 0, active: false };
      f.appendChild(radios('Live transcode mode', [
        { label: 'Auto', sub: 'Switch automatically', checked: tc.mode === 'auto', pick: () => env.act.setTranscode('auto') },
        { label: 'Always', sub: 'Start transcoded', checked: tc.mode === 'always', pick: () => env.act.setTranscode('always') },
        { label: 'Off', sub: 'Never transcode', checked: tc.mode === 'off', pick: () => env.act.setTranscode('off') },
      ]));
      f.appendChild(el('div', 'sep'));
      // This video's resolution, while it plays through Live transcode (Compare sizes its tiles itself: no act).
      if (tc.active && env.act.setTranscodeResolution) {
        const cur = Number(tc.resolution) || 0;
        const rbox = el('div', 'jbox');
        const rtitle = el('div', 'jtitle', 'Resolution (this video)');
        rtitle.setAttribute('aria-hidden', 'true');
        const rg = el('div', 'jopts');
        rg.setAttribute('role', 'radiogroup');
        rg.setAttribute('aria-label', 'Resolution for this video');
        for (const o of resolutionChoices(Number(tc.sourceHeight) || 0, cur)) {
          rg.appendChild(btn('chip', o.label, () => { env.act.setTranscodeResolution(o.h); render(); }, {
            aria: { role: 'radio', 'aria-checked': String(cur === o.h) },
          }));
        }
        rbox.append(rtitle, rg);
        f.appendChild(rbox);
        const saved = Number(tc.defaultResolution) || 0;
        if (cur !== saved && env.act.saveTranscodeResolution) {
          const name = cur ? `${cur}p` : 'Auto';
          const row = el('div', 'ibtns');
          row.appendChild(btn('secondary', `Save ${name} as default`, () => { env.act.saveTranscodeResolution(cur); render(); }, {
            aria: { 'aria-label': `Save ${name} as the default Live transcode resolution for new videos` },
          }));
          const pad = el('div', 'jbox'); // (the panel's side padding)
          pad.appendChild(row);
          f.appendChild(pad);
        }
        f.appendChild(el('div', 'sep'));
      }
      const box = el('div', 'jbox');
      const title = el('div', 'jtitle', 'Max bitrate (best quality up to cap)');
      title.setAttribute('aria-hidden', 'true');
      const g = el('div', 'jopts');
      g.setAttribute('role', 'radiogroup');
      g.setAttribute('aria-label', 'Max bitrate');
      const rates = tc.maxBitrateMbps > 0 && !TRANSCODE_RATES.includes(tc.maxBitrateMbps)
        ? [...TRANSCODE_RATES, tc.maxBitrateMbps].sort((a, b) => a - b) : TRANSCODE_RATES;
      for (const r of rates) {
        const label = r === 0 ? 'Auto' : `${r} Mb/s`;
        g.appendChild(btn('chip', label, () => { env.act.setTranscodeMaxBitrate(r); render(); }, {
          aria: { role: 'radio', 'aria-checked': String(Number(tc.maxBitrateMbps || 0) === r) },
        }));
      }
      box.append(title, g);
      f.appendChild(box);
      if (env.act.setTranscodeSplitBitrate) {
        const split = !!tc.splitBitrate;
        const row = btn('row', 'Split bitrate', () => env.act.setTranscodeSplitBitrate(!split), {
          aria: { role: 'switch', 'aria-checked': String(split) },
        });
        row.appendChild(sw(split));
        f.appendChild(row);
      }
      const note = el('div', 'pnote', 'Copy Frame, Save Frame, Pixel Inspector and Scopes automatically fetch '
        + 'full-resolution source frames when available. The inspector and scopes fetch them while paused. '
        + '100% live zoom uses the playback picture.');
      f.appendChild(note);
      return f;
    }

    function renderInfo(s) {
      const f = document.createDocumentFragment();
      const d = s.facts;
      if (s.infoTabs) {
        // Compare: one tab per video (A, B, ...).
        const tabs = el('div', 'seg');
        tabs.setAttribute('role', 'tablist');
        s.infoTabs.keys.forEach((k, i) => tabs.appendChild(btn('', k, () => { s.infoTabs.pick(i); render(); }, { aria: { role: 'tab', 'aria-selected': String(i === s.infoTabs.sel), 'aria-pressed': String(i === s.infoTabs.sel), 'aria-label': `About ${k}` } })));
        f.appendChild(tabs);
      }
      const top = el('div', 'itop');
      top.append(el('div', 'iname', d.title), el('div', 'isub', d.sub));
      f.appendChild(top);
      const grid = el('dl', 'igrid');
      for (const [k, v] of d.rows) grid.append(el('dt', '', k), el('dd', '', v));
      f.appendChild(grid);
      const row = el('div', 'ibtns');
      row.append(btn('secondary', 'Copy details', () => env.act.copyInfo(d)));
      if (s.canUseOriginal && env.act.useOriginal) row.append(btn('secondary', 'Use original video', () => { close(false); env.act.useOriginal(); }));
      if (env.act.copyLink) row.append(btn('secondary', 'Copy link to this frame', () => { close(false); env.act.copyLink(); }, { aria: { 'aria-keyshortcuts': 'Shift+C' } }));
      f.appendChild(row);
      return f;
    }

    /**
     * Popovers: pages that sit right above the bar button that opened them, without a title row. Others open at the
     * bar's right end. view → the env.buttons keys that open it as a popover.
     */
    const POPOVERS = { step: ['stepPrev', 'stepNext'], speed: ['rate'] };
    const popover = () => !!opener && !!view && (POPOVERS[view] || []).some((k) => buttons[k] === opener);
    /**
     * Peek: a popover opened for a moment without taking focus (the wheel over the speed button). It fades out
     * PEEK_MS after the last peek; pointing into it, pressing in it or focusing it keeps it open, and a click on its
     * button then keeps it too (toggle). A page opened another way is left alone.
     */
    let peeking = false, peekTimer = 0, fading = false;
    const setFading = (on) => { fading = on; panel.className = panel.className.replace(/ fading/g, '') + (on ? ' fading' : ''); };
    function stopPeek() {
      peeking = false;
      if (peekTimer) window.clearTimeout(peekTimer);
      peekTimer = 0;
      if (fading) setFading(false);
    }
    function peek(v, from) {
      if (view === v && !peeking) return;
      if (view !== v) show(v, from, false);
      stopPeek();
      peeking = true;
      peekTimer = window.setTimeout(() => {
        setFading(true);
        peekTimer = window.setTimeout(() => { const was = peeking; stopPeek(); if (was) close(false); }, FADE_MS);
      }, PEEK_MS);
    }
    if (panel.addEventListener) for (const ev of ['pointerenter', 'pointerdown', 'focusin']) panel.addEventListener(ev, () => { if (peeking) stopPeek(); });
    const LABEL = { main: 'Player settings', autoplay: 'Autoplay', speed: 'Speed', ab: 'A–B Range', inspect: 'Inspection', picture: 'Picture size', transcode: 'Live transcode', subs: 'Subtitles', audio: 'Audio track', quality: 'Quality', info: 'About this video', step: 'Step size' };
    /**
     * Pages a page adds (compare's panel and its per-video page): { label, render(s, kit), parent?, button? }.
     * `button`: the bar button (env.buttons key) that shows it open; `parent`: where Esc goes.
     */
    const VIEWS = env.views || {};
    const sw = (on) => { const x = el('span', `switch${on ? ' on' : ''}`); x.appendChild(el('span', 'knob')); return x; };
    const kit = { el, btn, kbd, head, heading, sw, ICON, show: (v) => show(v), close: (r) => close(r), render: () => render() };
    function render() {
      if (!view) return;
      speedDrag?.stop();
      speedDrag = null;
      const s = env.get();
      const nav = [...panel.querySelectorAll('[data-nav]')];
      const fi = nav.indexOf(/** @type {any} */ (document.activeElement));
      panel.textContent = '';
      panel.className = `panel ${view}${popover() ? ' popover' : ''}${fading ? ' fading' : ''}`;
      const custom = VIEWS[view];
      panel.setAttribute('aria-label', custom ? (typeof custom.label === 'function' ? custom.label(s) : custom.label) : view === 'info' && s.infoTabs ? 'About these videos' : LABEL[view]);
      const body = custom ? custom.render(s, kit) : view === 'main' ? renderMain(s) : view === 'autoplay' ? renderAutoplay(s) : view === 'speed' ? renderSpeed(s) : view === 'ab' ? renderAB(s) : view === 'inspect' ? renderInspect(s) : view === 'picture' ? renderPicture(s) : view === 'transcode' ? renderTranscode(s) : view === 'subs' ? renderSubs(s) : view === 'audio' ? renderAudio(s) : view === 'quality' ? renderQuality(s) : view === 'step' ? renderStep(s) : renderInfo(s);
      panel.appendChild(body);
      const after = /** @type {HTMLElement[]} */ ([...panel.querySelectorAll('[data-nav]')]);
      if (fi >= 0 && after.length) after[Math.min(fi, after.length - 1)].focus();
      place();
      sync();
    }
    function place() {
      const r = bar.getBoundingClientRect();
      panel.style.bottom = `${Math.max(8, window.innerHeight - r.top + 8)}px`;
      panel.style.maxHeight = `${Math.max(120, r.top - 16)}px`;
      // A popover sits right above the button it was opened from; the other pages at the bar's right end.
      if (popover() && opener) {
        const o = opener.getBoundingClientRect();
        const w = panel.offsetWidth;
        panel.style.left = `${Math.round(Math.max(8, Math.min(window.innerWidth - w - 8, o.left + o.width / 2 - w / 2)))}px`;
        panel.style.right = 'auto';
        // Floating UI follows the button from here (the bar's bottom edge keeps the vertical position).
        if (engine() && !follow) follow = engine().positionAnchored(opener, panel, { placement: 'top', padding: 8, axis: 'x' });
      } else { unfollow(); panel.style.left = ''; panel.style.right = ''; }
    }
    /** The webview UI bundle's overlay engine (media/ui/floating.ts), when the page loaded it. */
    const engine = () => /** @type {any} */ (globalThis).VpeWebviewUi?.showTopLayer ? /** @type {any} */ (globalThis).VpeWebviewUi : null;
    /** Stops following the opener button (a popover only). */
    let follow = null;
    function unfollow() { if (follow) follow(); follow = null; }
    /** Bar buttons show which panel is open. */
    function sync() {
      const set = (b, on) => { if (b) { b.setAttribute('aria-expanded', String(on)); b.classList.toggle('open', on); } };
      const own = view && VIEWS[view] ? VIEWS[view].button : null;
      set(buttons.cog, view === 'main' || view === 'autoplay' || view === 'audio' || view === 'quality' || view === 'ab' || view === 'inspect' || view === 'picture' || (view === 'transcode' && opener !== buttons.remoteLive) || (view === 'subs' && opener !== buttons.tracks) || (view === 'speed' && opener !== buttons.rate));
      for (const [k, b] of Object.entries(buttons)) if (!['cog', 'info', 'rate', 'tracks', 'stepPrev', 'stepNext', 'remoteLive'].includes(k)) set(b, !!own && own === k);
      set(buttons.remoteLive, view === 'transcode' && opener === buttons.remoteLive);
      set(buttons.stepPrev, view === 'step' && opener === buttons.stepPrev);
      set(buttons.stepNext, view === 'step' && opener === buttons.stepNext);
      set(buttons.info, view === 'info');
      set(buttons.rate, view === 'speed' && opener === buttons.rate);
      set(buttons.tracks, view === 'subs' && opener === buttons.tracks);
    }
    /** Opens (or switches to) a page; focus moves into it unless `focus` is false (peek). */
    function show(v, from, focus = true) {
      if (from !== undefined) { opener = from; unfollow(); }
      if (onShow) onShow();
      closeSheet(false);
      view = v;
      panel.hidden = false;
      engine()?.showTopLayer(panel);
      render();
      const first = /** @type {HTMLElement|null} */ ((v === 'subs' || v === 'audio' || v === 'quality' || v === 'step' || v === 'autoplay' ? panel.querySelector('[aria-checked="true"]') : v === 'speed' && popover() ? panel.querySelector('#speedSlider') : null) || panel.querySelector('[data-nav]'));
      if (first && focus) first.focus();
    }
    /** A bar button: opens its page, or closes it when it is the page shown. */
    function toggle(v, from) {
      if (view === v && peeking) { stopPeek(); show(v, from); return; } // a click on a peeked popover keeps it
      if (view === v) { close(true); return; }
      show(v, from);
    }
    function close(refocus) {
      if (!view) return;
      stopPeek();
      const back = opener;
      view = null;
      speedDrag?.stop();
      speedDrag = null;
      unfollow();
      engine()?.hideTopLayer(panel);
      panel.hidden = true;
      panel.textContent = '';
      sync();
      if (refocus && back) back.focus();
    }
    function openSheet(from = view ? opener : document.activeElement) {
      if (onShow) onShow();
      close(false);
      sheetOpener = from instanceof HTMLElement && from !== document.body ? from : buttons.cog;
      sheet.textContent = '';
      const dlg = el('div', 'sheet');
      dlg.setAttribute('role', 'dialog');
      dlg.setAttribute('aria-modal', 'true');
      dlg.setAttribute('aria-label', 'Keyboard shortcuts');
      const top = el('div', 'stop');
      const hint = el('span', 'shint');
      hint.append('Press ', kbd('?'), ' any time');
      const x = btn('x', null, () => closeSheet(true), { icon: ICON.close, aria: { 'aria-label': 'Close' } });
      top.append(el('span', 'stitle', 'Keyboard shortcuts'), hint, x);
      dlg.appendChild(top);
      const grid = el('div', 'sgrid');
      for (const g of keyGroups(env.get())) {
        const col = el('div', 'sgroup');
        col.setAttribute('role', 'group');
        col.setAttribute('aria-label', g.title);
        const h = el('div', 'phead', g.title);
        h.setAttribute('aria-hidden', 'true');
        col.appendChild(h);
        for (const [what, k1, k2] of g.rows) {
          const r = el('div', 'srow');
          r.append(el('span', 'grow', what), kbd(k1));
          if (k2) r.appendChild(kbd(k2));
          col.appendChild(r);
        }
        grid.appendChild(col);
      }
      dlg.appendChild(grid);
      dlg.addEventListener('click', (e) => e.stopPropagation());
      sheet.appendChild(dlg);
      sheet.hidden = false;
      sync();
      x.focus();
    }
    function closeSheet(refocus) {
      if (sheet.hidden) return;
      sheet.hidden = true;
      sheet.textContent = '';
      sync();
      if (refocus) (sheetOpener?.isConnected ? sheetOpener : buttons.cog).focus();
      sheetOpener = null;
    }
    sheet.addEventListener('click', (e) => { e.stopPropagation(); closeSheet(true); });
    sheet.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape' || e.key === '?') { e.preventDefault(); closeSheet(true); }
      if (e.key === 'Tab') { e.preventDefault(); const x = sheet.querySelector('button'); if (x) /** @type {any} */ (x).focus(); }
    });
    panel.addEventListener('click', (e) => e.stopPropagation());
    panel.addEventListener('keydown', (e) => {
      const nav = /** @type {HTMLElement[]} */ ([...panel.querySelectorAll('[data-nav]')]);
      const i = nav.indexOf(/** @type {any} */ (document.activeElement));
      const onSlider = /** @type {any} */ (document.activeElement) && /** @type {any} */ (document.activeElement).type === 'range';
      let handled = true;
      switch (e.key) {
        case 'ArrowDown': if (onSlider) { handled = false; break; } nav[(i + 1) % nav.length].focus(); break;
        case 'ArrowUp': if (onSlider) { handled = false; break; } nav[(i - 1 + nav.length) % nav.length].focus(); break;
        case 'Home': if (onSlider) { handled = false; break; } nav[0].focus(); break;
        case 'End': if (onSlider) { handled = false; break; } nav[nav.length - 1].focus(); break;
        case 'Escape': {
          const parent = view && VIEWS[view] ? VIEWS[view].parent : null;
          if (parent) show(parent);
          else if (view !== 'main' && opener === buttons.cog) show('main');
          else close(true);
          break;
        }
        default: handled = false;
      }
      if (handled) e.preventDefault();
      // Navigation and activation stay in the panel (a focused button clicks itself on Enter / Space;
      // the speed slider keeps its arrows); other keys (letters, ?) reach the player.
      if (handled || e.key === 'Enter' || e.key === ' ' || (onSlider && /^Arrow|^Home$|^End$|^Page/.test(e.key))) e.stopPropagation();
    });
    window.addEventListener('resize', () => { if (view) place(); });

    // Click outside: a press anywhere but the open panel and the bar's panel buttons closes the panel (the
    // buttons toggle their own page). The control that was pressed still works (Mute, Seek, Play, ...). A press
    // in the picture area only dismisses: `consumeDismiss()` tells its click handler so it does not play / pause.
    let dismissedAtPress = false;
    document.addEventListener('pointerdown', (e) => {
      dismissedAtPress = false;
      if (!view) return;
      const t = /** @type {Node|null} */ (e.target);
      if (!t || panel.contains(t)) return;
      if (Object.values(buttons).some((b) => b && b.contains(t))) return;
      dismissedAtPress = !bar.contains(t);
      close(false);
    }, true);

    return {
      toggle, show, peek, close, render, openSheet, closeSheet,
      /** True once after a press outside the bar closed a panel: the click that follows was the dismissal. */
      consumeDismiss: () => { const d = dismissedAtPress; dismissedAtPress = false; return d; },
      toggleSheet: () => { if (sheet.hidden) openSheet(); else closeSheet(true); },
      view: () => view, sheetOpen: () => !sheet.hidden,
      anyOpen: () => !!view || !sheet.hidden,
      closeAll: (refocus) => { close(refocus); closeSheet(refocus); },
      /** Re-renders an open page when the player's state changes (tracks found, speed key…). */
      refresh: () => { if (view) render(); else sync(); },
    };
  }

  return {
    create, createToast, createPlayFlash, drawRangeMarks, drawRangeButtons, facts, keyGroups, qualityRows, qualityLabel,
    clampRate, presetRate, speedText, navName, stepTips, SPEEDS, PANEL_SPEEDS, SPEED_MIN, SPEED_MAX, SPEED_STEP, NAV,
    STEP_SIZES, stepName, stepBadge, stepSizeOf, stepAmount, drawStepBadges, holdVolumeOpen, remoteChipState, resolutionChoices,
  };
})();

if (typeof module !== 'undefined') module.exports = VpeControls;
