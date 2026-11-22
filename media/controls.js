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
    jumps: SVG('<path d="M4 12h16M8 8l-4 4 4 4M16 8l4 4-4 4"></path>'),
    picture: SVG('<rect x="3" y="5" width="18" height="14" rx="1.5"></rect><rect x="8" y="9" width="8" height="6" rx="0.8"></rect>'),
    quality: SVG('<rect x="3" y="5" width="18" height="14" rx="2"></rect><path d="M7 15v-3M11 15V9M15 15v-5M19 15V8" stroke-width="1.4"></path>'),
  };
  /** Preset labels on the speed slider's track. */
  const SPEEDS = [0.5, 1, 1.5, 2, 3, 4];
  const SPEED_MIN = 0.25, SPEED_MAX = 4, SPEED_STEP = 0.05;
  /** Jump sizes: one frame or seconds (settings videoPreviewEnhanced.jump.arrow / jump.shift / jump.ctrl). */
  const NAV = ['frame', 1, 5, 10, 30];
  const navName = (v) => (v === 'frame' ? '1 frame' : `${v} s`);
  /** Tooltips and labels of the buttons beside Play for prefs.stepButtons ('frame' | 'jump', then the Ctrl jump size). */
  const stepTips = (p) => {
    const ctrl = /Mac/i.test((typeof navigator !== 'undefined' && navigator.platform) || '') ? 'Cmd' : 'Ctrl';
    if (p.stepButtons === 'jump') {
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
    if (info.transcode && info.transcode.label) by = info.transcode.label;
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
      // Compare (media/compare.js): one bar for all videos; no subtitles, tools or A-B loop.
      return [
        { title: 'Playback', rows: [['Play / pause (all)', 'Space', 'K'], ['Click a video', 'Play / pause'], [`Speed −/+ ${SPEED_STEP}`, 'Shift+<', 'Shift+>'], ['Loop', 'R']] },
        { title: 'Seek', rows: [[`Back / forward ${navName(p.jump.arrow)}`, '←', '→'], [`Back / forward ${navName(p.jump.shift)}`, 'Shift+←', 'Shift+→'], [`Back / forward ${navName(p.jump.ctrl)}`, `${ctrlName}+←`, `${ctrlName}+→`], ['Back / forward 10 s', 'J', 'L'], ['Start / end', 'Home', 'End']] },
        { title: 'Frames', rows: [['Previous / next frame (all videos)', ',', '.'], ['Copy view', `${ctrlName}+C`], ['Time / timecode / frames', 'click the time']] },
        { title: 'Sound', rows: [['Volume ±5 %', '↑', '↓'], ['Mute', 'M']] },
        { title: 'Compare', rows: [['Nudge the video under the pointer', '−', '+'], ['Swap sides (2 videos)', 'X'], ['Add videos by clicking them in the Explorer', 'Shift+D']] },
        { title: 'View and help', rows: [['Fullscreen', 'F'], ['Picture size (all videos)', 'Z'], ['Zoom (all videos)', `${ctrlName}+wheel`], ['About these videos', 'I'], ['This list', '?'], ['Close menus', 'Esc']] },
      ];
    }
    return [
      { title: 'Playback', rows: [['Play / pause', 'Space', 'K'], ['Click the picture', 'Play / pause'], [`Speed −/+ ${SPEED_STEP}`, 'Shift+<', 'Shift+>'], ['Loop', 'R'], ['A-B loop start / end', 'A', 'B']] },
      { title: 'Seek', rows: [[`Back / forward ${navName(p.jump.arrow)}`, '←', '→'], [`Back / forward ${navName(p.jump.shift)}`, 'Shift+←', 'Shift+→'], [`Back / forward ${navName(p.jump.ctrl)}`, `${ctrlName}+←`, `${ctrlName}+→`], ['Back / forward 10 s', 'J', 'L'], ['Start / end', 'Home', 'End'], ['Jump to 0–90 %', '0…9']] },
      { title: 'Frames', rows: [['Previous / next frame', ',', '.'], ['Copy frame', `${ctrlName}+C`], ['Save frame as PNG', 'S'], ['Go to frame or time', `${ctrlName}+G`], ['Time / timecode / frames', 'click the time']] },
      { title: 'Sound', rows: [['Volume ±5 %', '↑', '↓'], ['Mute', 'M'], ['Next audio track', 'Shift+A']] },
      { title: 'View', rows: [['Fullscreen', 'F'], ['Subtitles on / off', 'C'], ['About this video', 'I'], ['Picture size: Fit, Fill, Stretch, 100 %', 'Z'], ['Zoom in / out', '+', '-'], ['Zoom at the pointer', `${ctrlName}+wheel`]] },
      { title: 'Tools', rows: [['Scopes', 'W'], ['Pixel inspector', 'X'], ['Codec X-ray', 'Shift+X'], ['Stats', 'Shift+I'], ['Previous / next keyframe', '{', '}']] },
      { title: 'Files and help', rows: [['Next / previous video in folder', 'Shift+N', 'Shift+P'], ['Compare with another video', 'D'], ['Compare with the next video clicked in the Explorer', 'Shift+D'], ['Compare by dropping a video here', 'Shift+drag'], ['This list', '?'], ['Close menus', 'Esc']] },
    ];
  }

  /**
   * @param {{
   *   panel: HTMLElement, sheet: HTMLElement, bar: HTMLElement,
   *   buttons: { cog: HTMLElement, info: HTMLElement, rate: HTMLElement, tracks: HTMLElement, keys: HTMLElement },
   *   get: () => any, act: Record<string, (...a: any[]) => void>,
   * }} env
   */
  function create(env) {
    const { panel, sheet, bar, buttons } = env;
    /** @type {null|'main'|'speed'|'jumps'|'picture'|'transcode'|'subs'|'audio'|'quality'|'info'} */
    let view = null;
    /** @type {HTMLElement|null} */
    let opener = null;
    /** @type {HTMLElement|null} */
    let sheetOpener = null;

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
    const heading = (t) => { const h = el('div', 'phead', t); h.setAttribute('aria-hidden', 'true'); return h; };

    function renderMain(s) {
      const f = document.createDocumentFragment();
      f.appendChild(btn('row', 'Speed', () => show('speed'), { icon: ICON.speed, value: speedText(s.rate), chev: true }));
      const loop = btn('row', 'Loop', () => { env.act.loop(); render(); }, { icon: ICON.loop, aria: { role: 'switch', 'aria-checked': String(!!s.loop) } });
      const sw = el('span', `switch${s.loop ? ' on' : ''}`);
      sw.appendChild(el('span', 'knob'));
      loop.appendChild(sw);
      f.appendChild(loop);
      if (env.act.cycleAB) {
        const ab = btn('row', 'A-B loop', () => { env.act.cycleAB(); render(); }, { value: s.abLabel });
        ab.insertBefore(el('span', 'abicon', 'A-B'), ab.firstChild);
        /** @type {any} */ (ab.firstChild).setAttribute('aria-hidden', 'true');
        f.appendChild(ab);
      }
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
        const tm = s.transcode.mode || 'ask';
        const mbps = s.transcode.maxBitrateMbps > 0 ? ` · ${s.transcode.maxBitrateMbps} Mb/s` : '';
        const modeName = tm === 'ask' ? 'Ask' : tm === 'auto' ? 'Auto' : tm === 'always' ? 'Always' : 'Off';
        f.appendChild(btn('row', 'Live transcode', () => show('transcode'), { icon: ICON.quality, value: `${modeName}${mbps}`, chev: true, aria: { 'aria-label': `Live transcode, ${modeName}${mbps}` } }));
      }
      f.appendChild(btn('row', s.compare ? 'Copy view' : 'Copy frame', () => { close(false); env.act.copyFrame(); }, { icon: ICON.camera, kbd: 'Ctrl+C' }));
      f.appendChild(btn('row', 'Keyboard shortcuts', () => openSheet(buttons.cog), { icon: ICON.keys, kbd: '?', aria: { 'aria-haspopup': 'dialog' } }));
      f.appendChild(btn('row', 'Jump sizes', () => show('jumps'), { icon: ICON.jumps, value: [s.jump.arrow, s.jump.shift, s.jump.ctrl].map(navName).join(' · '), chev: true }));
      f.append(el('div', 'sep'), heading('Tools'));
      const grid = el('div', 'tools');
      grid.setAttribute('role', 'group');
      grid.setAttribute('aria-label', 'Tools');
      for (const t of s.tools) {
        const b = btn(`tool${t.on ? ' on' : ''}`, null, () => { if (!t.keepOpen) close(false); t.run(); }, { aria: { 'aria-label': t.label, ...(t.key && !t.note ? { 'aria-keyshortcuts': t.key.replace('Ctrl', 'Control') } : {}) } });
        b.dataset.tool = t.label;
        const k = el('span', 'tkey', t.note || t.key || '·');
        k.setAttribute('aria-hidden', 'true');
        b.append(k, el('span', '', t.label));
        grid.appendChild(b);
      }
      f.appendChild(grid);
      f.appendChild(el('div', 'sep'));
      // Plays an http(s) link or HLS / DASH stream in a new tab (docs/notes/url-stream.md); the URL is typed in VS Code's input box.
      if (env.act.openUrl) f.appendChild(btn('row', 'Open video URL…', () => { close(false); env.act.openUrl(); }, { icon: ICON.globe }));
      const xs = btn('row', 'Extension settings', () => { close(false); env.act.extSettings(); }, { icon: ICON.gear, aria: { 'aria-label': 'Extension settings (opens VS Code Settings)' } });
      xs.insertAdjacentHTML('beforeend', ICON.external);
      f.appendChild(xs);
      return f;
    }

    function renderSpeed(s) {
      const f = document.createDocumentFragment();
      f.appendChild(head('Speed'));
      const top = el('div', 'speedTop');
      const read = el('div', 'readout', speedText(s.rate));
      const minus = btn('big', null, () => { env.act.stepRate(-1); render(); }, { aria: { 'aria-label': `Slower by ${SPEED_STEP}` } });
      const plus = btn('big', null, () => { env.act.stepRate(1); render(); }, { aria: { 'aria-label': `Faster by ${SPEED_STEP}` } });
      minus.textContent = '−';
      plus.textContent = '+';
      top.append(minus, read, plus);
      f.appendChild(top);
      const sl = el('div', 'slider');
      const input = /** @type {HTMLInputElement} */ (el('input'));
      input.type = 'range'; input.min = String(SPEED_MIN); input.max = String(SPEED_MAX); input.step = String(SPEED_STEP); input.value = String(s.rate);
      input.id = 'speedSlider';
      input.setAttribute('aria-label', 'Speed');
      input.setAttribute('aria-valuetext', speedText(s.rate));
      input.dataset.nav = '1';
      input.addEventListener('input', () => { env.act.setRate(Number(input.value)); read.textContent = speedText(env.get().rate); input.setAttribute('aria-valuetext', read.textContent); });
      input.addEventListener('change', () => render());
      // Presets as labels on the slider's track, each at its speed.
      const marks = el('div', 'marks');
      for (const v of SPEEDS) {
        const b = btn('mark', speedText(v), () => { env.act.setRate(v); render(); }, { aria: { 'aria-pressed': String(Math.abs(v - s.rate) < 1e-6), 'aria-label': `Speed ${speedText(v)}` } });
        b.style.left = `${((v - SPEED_MIN) / (SPEED_MAX - SPEED_MIN)) * 100}%`;
        marks.appendChild(b);
      }
      sl.append(input, marks);
      f.appendChild(sl);
      const note = el('div', 'pnote');
      note.append(`Steps of ${SPEED_STEP}×. Scroll on the speed button or `, kbd('Shift'), '+', kbd('<'), kbd('>'), '.');
      f.appendChild(note);
      return f;
    }

    function renderPicture(s) {
      const f = document.createDocumentFragment();
      f.appendChild(head('Picture size'));
      const pc = s.picture;
      f.appendChild(radios('Picture size', PIC.MODES.map((m) => ({ label: PIC.name(m), sub: PIC.SHORT[m], checked: pc.mode === m, pick: () => env.act.setPicture(m) }))));
      f.appendChild(el('div', 'sep'));
      const r = el('div', 'jrow');
      r.setAttribute('role', 'group');
      r.setAttribute('aria-label', 'Zoom');
      const n = el('span', 'grow', 'Zoom');
      n.setAttribute('aria-hidden', 'true');
      const val = pc.pct === null ? '—' : `${pc.pct}%`;
      r.append(n, btn('chip', '−', () => { env.act.zoomPicture(-1); render(); }, { aria: { 'aria-label': 'Zoom out' } }),
        el('span', 'zval', val),
        btn('chip', '+', () => { env.act.zoomPicture(1); render(); }, { aria: { 'aria-label': 'Zoom in' } }),
        btn('chip', 'Reset', () => { env.act.resetPicture(); render(); }, { aria: { 'aria-label': 'Reset zoom' } }));
      f.appendChild(r);
      const note = el('div', 'pnote');
      note.append(kbd('Z'), ' cycles the sizes (zoomed in: back to Fit). Ctrl+wheel zooms, drag moves the picture', s.compare ? '. All videos follow together.' : '.');
      f.appendChild(note);
      return f;
    }

    function renderJumps(s) {
      const f = document.createDocumentFragment();
      f.appendChild(head('Jump sizes'));
      const rows = [['arrow', '← →', 'Left and Right arrow'], ['shift', 'Shift + ← →', 'Shift with Left and Right arrow'], ['ctrl', `${ctrlName} + ← →`, `${ctrlName} with Left and Right arrow`]];
      for (const [key, title, spoken] of rows) {
        const box = el('div', 'jbox');
        const t = el('div', 'jtitle', title);
        t.setAttribute('aria-hidden', 'true');
        const g = el('div', 'jopts');
        g.setAttribute('role', 'radiogroup');
        g.setAttribute('aria-label', `${spoken} jump`);
        for (const v of NAV) g.appendChild(btn('chip', navName(v), () => { env.act.setJump(key, v); render(); }, { aria: { role: 'radio', 'aria-checked': String(s.jump[key] === v) } }));
        box.append(t, g);
        f.appendChild(box);
      }
      const sb = el('div', 'jbox');
      const sbt = el('div', 'jtitle', 'Buttons beside Play');
      sbt.setAttribute('aria-hidden', 'true');
      const sbg = el('div', 'jopts');
      sbg.setAttribute('role', 'radiogroup');
      sbg.setAttribute('aria-label', 'Buttons beside Play');
      for (const [v, label] of [['frame', '1 frame'], ['jump', `${ctrlName} jump`]]) sbg.appendChild(btn('chip', label, () => { env.act.setStepButtons(v); render(); }, { aria: { role: 'radio', 'aria-checked': String((s.stepButtons || 'frame') === v) } }));
      sb.append(sbt, sbg);
      f.appendChild(sb);
      const note = el('div', 'pnote');
      note.append(kbd(','), ' ', kbd('.'), ' always step one frame.');
      f.appendChild(note);
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
      const stepper = (name, value, minus, plus, reset) => {
        const r = el('div', 'jrow');
        r.setAttribute('role', 'group');
        r.setAttribute('aria-label', name);
        const n = el('span', 'grow', name);
        n.setAttribute('aria-hidden', 'true');
        const v = btn('chip', value, () => { reset(); render(); }, { aria: { 'aria-label': `${name} ${value}, reset` } });
        r.append(n, btn('chip', '−', () => { minus(); render(); }, { aria: { 'aria-label': `${name} down` } }), v, btn('chip', '+', () => { plus(); render(); }, { aria: { 'aria-label': `${name} up` } }));
        return r;
      };
      f.appendChild(stepper('Delay', `${t.delay > 0 ? '+' : ''}${Math.round(t.delay * 1000)} ms`, () => env.act.subDelay(-0.05), () => env.act.subDelay(0.05), () => env.act.subDelay(null)));
      f.appendChild(stepper('Size', `${Math.round(t.size * 100)}%`, () => env.act.subSize(-0.1), () => env.act.subSize(0.1), () => env.act.subSize(null)));
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
      const tc = s.transcode || { mode: 'ask', maxBitrateMbps: 0, active: false };
      f.appendChild(radios('Live transcode mode', [
        { label: 'Ask', sub: 'Prompt when needed', checked: tc.mode === 'ask', pick: () => env.act.setTranscode('ask') },
        { label: 'Auto', sub: 'Switch automatically', checked: tc.mode === 'auto', pick: () => env.act.setTranscode('auto') },
        { label: 'Always', sub: 'Start transcoded', checked: tc.mode === 'always', pick: () => env.act.setTranscode('always') },
        { label: 'Off', sub: 'Never transcode', checked: tc.mode === 'off', pick: () => env.act.setTranscode('off') },
      ]));
      f.appendChild(el('div', 'sep'));
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
      const note = el('div', 'pnote', 'Uses GPU decode and encode when available, CPU as last resort. Exact-pixel tools warn while active and offer Use original video.');
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
      if (env.act.moreInfo) row.append(btn('link', 'Full technical details', () => { close(false); env.act.moreInfo(); }));
      if (s.canExternal) row.appendChild(btn('link', 'Open in system player', () => { close(false); env.act.external(); }));
      f.appendChild(row);
      return f;
    }

    const LABEL = { main: 'Player settings', speed: 'Speed', jumps: 'Jump sizes', picture: 'Picture size', transcode: 'Live transcode', subs: 'Subtitles', audio: 'Audio track', quality: 'Quality', info: 'About this video' };
    /**
     * Pages a page adds (compare's panel and its per-video page): { label, render(s, kit), parent?, button? }.
     * `button`: the bar button (env.buttons key) that shows it open; `parent`: where Esc goes.
     */
    const VIEWS = env.views || {};
    const sw = (on) => { const x = el('span', `switch${on ? ' on' : ''}`); x.appendChild(el('span', 'knob')); return x; };
    const kit = { el, btn, kbd, head, heading, sw, ICON, show: (v) => show(v), close: (r) => close(r), render: () => render() };
    function render() {
      if (!view) return;
      const s = env.get();
      const nav = [...panel.querySelectorAll('[data-nav]')];
      const fi = nav.indexOf(/** @type {any} */ (document.activeElement));
      panel.textContent = '';
      panel.className = `panel ${view}`;
      const custom = VIEWS[view];
      panel.setAttribute('aria-label', custom ? (typeof custom.label === 'function' ? custom.label(s) : custom.label) : view === 'info' && s.infoTabs ? 'About these videos' : LABEL[view]);
      const body = custom ? custom.render(s, kit) : view === 'main' ? renderMain(s) : view === 'speed' ? renderSpeed(s) : view === 'jumps' ? renderJumps(s) : view === 'picture' ? renderPicture(s) : view === 'transcode' ? renderTranscode(s) : view === 'subs' ? renderSubs(s) : view === 'audio' ? renderAudio(s) : view === 'quality' ? renderQuality(s) : renderInfo(s);
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
    }
    /** Bar buttons show which panel is open. */
    function sync() {
      const set = (b, on) => { if (b) { b.setAttribute('aria-expanded', String(on)); b.classList.toggle('open', on); } };
      const own = view && VIEWS[view] ? VIEWS[view].button : null;
      set(buttons.cog, view === 'main' || view === 'audio' || view === 'quality' || view === 'jumps' || view === 'picture' || view === 'transcode' || (view === 'subs' && opener !== buttons.tracks) || (view === 'speed' && opener !== buttons.rate));
      for (const [k, b] of Object.entries(buttons)) if (!['cog', 'info', 'rate', 'tracks'].includes(k)) set(b, !!own && own === k);
      set(buttons.info, view === 'info');
      set(buttons.rate, view === 'speed' && opener === buttons.rate);
      set(buttons.tracks, view === 'subs' && opener === buttons.tracks);
    }
    /** Opens (or switches to) a page; focus moves into it. */
    function show(v, from) {
      if (from !== undefined) opener = from;
      closeSheet(false);
      view = v;
      panel.hidden = false;
      panel.textContent = '';
      render();
      const first = /** @type {HTMLElement|null} */ ((v === 'subs' || v === 'audio' || v === 'quality' ? panel.querySelector('[aria-checked="true"]') : null) || panel.querySelector('[data-nav]'));
      if (first) first.focus();
    }
    /** A bar button: opens its page, or closes it when it is the page shown. */
    function toggle(v, from) {
      // The cog closes whatever is open (like the mock-up); the other buttons close their own page.
      if (view === v || (from === buttons.cog && view)) { close(true); return; }
      show(v, from);
    }
    function close(refocus) {
      if (!view) return;
      const back = opener;
      view = null;
      panel.hidden = true;
      panel.textContent = '';
      sync();
      if (refocus && back) back.focus();
    }
    function openSheet(from = view ? opener : document.activeElement) {
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

    return {
      toggle, show, close, render, openSheet, closeSheet,
      toggleSheet: () => { if (sheet.hidden) openSheet(); else closeSheet(true); },
      view: () => view, sheetOpen: () => !sheet.hidden,
      anyOpen: () => !!view || !sheet.hidden,
      closeAll: (refocus) => { close(refocus); closeSheet(refocus); },
      /** Re-renders an open page when the player's state changes (tracks found, speed key…). */
      refresh: () => { if (view) render(); else sync(); },
    };
  }

  return { create, facts, keyGroups, qualityRows, qualityLabel, clampRate, speedText, navName, stepTips, SPEEDS, SPEED_MIN, SPEED_MAX, SPEED_STEP, NAV };
})();

if (typeof module !== 'undefined') module.exports = VpeControls;
