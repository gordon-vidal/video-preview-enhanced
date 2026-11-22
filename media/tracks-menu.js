/* global Subtitles */
// @ts-check
// Subtitle and audio track control for the player: the overlay placed over the
// video, sidecar / loaded / embedded subtitle sources, delay and size, the
// lists for the player's Subtitles and Audio track panels (media/controls.js), and the
// subtitle keys. Uses the engine's track API
// when it exists (player.tracks, selectAudio, selectSub, onSubCue).
'use strict';

/* exported createTracksUi */
// eslint-disable-next-line no-unused-vars
function createTracksUi(env) {
  const { vscode, stage, canvas, bar, layer, toast, getPlayer } = env;
  const changed = () => { if (env.onChange) env.onChange(); };
  const S = /** @type {any} */ (globalThis).Subtitles;
  const renderer = new S.SubtitleRenderer(layer);
  // Picture subtitles: a clipping box over the visible part of the video, holding a frame over the whole picture.
  const pic = document.createElement('div');
  pic.className = 'subs-pic';
  pic.hidden = true;
  const picFrame = document.createElement('div');
  picFrame.className = 'subs-frame';
  pic.appendChild(picFrame);
  layer.parentNode.insertBefore(pic, layer);
  const picRenderer = new S.BitmapRenderer(picFrame);
  const st = env.saved || {};

  let delay = Number(st.delay) || 0; // seconds; positive shows subtitles later
  let size = Number(st.size) || 1;
  /** 'off', 'f:<file URI>', 'e:<embedded id>', or null before anything is decided */
  let sel = typeof st.sel === 'string' ? st.sel : null;
  let chosen = sel !== null; // the user (or a saved choice) decided; automatic picks don't override it
  let lastOn = typeof st.lastOn === 'string' ? st.lastOn : null;
  let audioPref = st.audio === undefined ? null : st.audio;
  /** @type {Map<string, any>} key -> { key, name, lang, flags, exact, index } */
  const files = new Map();
  /** @type {Map<string, any>} embedded track id -> CueIndex, or BitmapCueIndex for picture tracks */
  const embedded = new Map();
  let tracks = null; // the last player.tracks()

  // ---- labels -------------------------------------------------------------------
  const ISO3 = {
    eng: 'en', ger: 'de', deu: 'de', fre: 'fr', fra: 'fr', spa: 'es', ita: 'it', por: 'pt', rus: 'ru', jpn: 'ja', chi: 'zh', zho: 'zh',
    kor: 'ko', dut: 'nl', nld: 'nl', swe: 'sv', nor: 'no', nob: 'nb', dan: 'da', fin: 'fi', pol: 'pl', cze: 'cs', ces: 'cs', hun: 'hu',
    tur: 'tr', ara: 'ar', heb: 'he', gre: 'el', ell: 'el', hin: 'hi', tha: 'th', vie: 'vi', ukr: 'uk', rum: 'ro', ron: 'ro', ind: 'id',
    may: 'ms', msa: 'ms', bul: 'bg', hrv: 'hr', srp: 'sr', slv: 'sl', slo: 'sk', slk: 'sk', est: 'et', lav: 'lv', lit: 'lt', per: 'fa',
    fas: 'fa', cat: 'ca', glg: 'gl', baq: 'eu', eus: 'eu', ice: 'is', isl: 'is', fil: 'fil', tam: 'ta', tel: 'te', ben: 'bn', urd: 'ur',
  };
  let names = null;
  try { names = new Intl.DisplayNames([navigator.language || 'en'], { type: 'language' }); } catch { names = null; }
  function langName(code) {
    if (!code || code === 'und') return '';
    const c = ISO3[String(code).toLowerCase()] || code;
    try { const n = names && names.of(c); return n && n !== c ? n[0].toUpperCase() + n.slice(1) : String(code); } catch { return String(code); }
  }
  const uiLang = (navigator.language || 'en').slice(0, 2).toLowerCase();
  const langMatches = (code) => !!code && (ISO3[String(code).toLowerCase()] || String(code).toLowerCase()).slice(0, 2) === uiLang;
  const FLAG_NAMES = { forced: 'forced', sdh: 'SDH', cc: 'CC', hi: 'SDH', default: '' };
  function fileLabel(f) {
    const flags = (f.flags || []).map((x) => FLAG_NAMES[x] !== undefined ? FLAG_NAMES[x] : x).filter(Boolean);
    // An HLS subtitle rendition: its NAME, then its LANGUAGE in words (when that says more) and "stream".
    if (f.stream) {
      const lang = langName(f.lang);
      const main = f.title || lang || 'Subtitles';
      return { main: `${main}${flags.length ? ` (${flags.join(', ')})` : ''}`, sub: [lang && lang !== main ? lang : '', 'stream'].filter(Boolean).join(' · ') };
    }
    const main = langName(f.lang) || (f.exact ? 'Subtitles' : '');
    return { main: main ? `${main}${flags.length ? ` (${flags.join(', ')})` : ''}` : f.name, sub: main ? f.name : '' };
  }
  const CH = { 1: 'mono', 2: 'stereo', 6: '5.1', 8: '7.1' };
  function trackLabel(t, n, kind) {
    const main = t.title || langName(t.lang) || `${kind} ${n + 1}`;
    const extra = [t.title && langName(t.lang), t.channels ? CH[t.channels] || `${t.channels} ch` : '', t.codec].filter(Boolean).join(' · ');
    return { main, sub: extra };
  }

  // ---- sources and selection --------------------------------------------------------
  const player = () => { const p = getPlayer(); return p && typeof p.tracks === 'function' ? p : null; };
  function refreshTracks() { const p = player(); if (p) { try { tracks = p.tracks(); } catch { /* not ready */ } } return tracks; }
  const embeddedId = (key) => key && key.startsWith('e:') ? key.slice(2) : null;
  const subTracks = () => (tracks && tracks.sub) || [];
  const textTracks = () => subTracks().filter((t) => t.kind !== 'bitmap');

  function describe(key) {
    if (!key || key === 'off') return 'off';
    if (key.startsWith('f:')) { const f = files.get(key); if (!f) return key.slice(2); const l = fileLabel(f); return l.sub ? `${l.main} · ${l.sub}` : l.main; }
    const i = subTracks().findIndex((t) => String(t.id) === embeddedId(key));
    return i < 0 ? 'embedded track' : trackLabel(subTracks()[i], i, 'Track').main;
  }

  /** Tell the engine which embedded track to demux (none when a file is shown). */
  function syncEngine() {
    const p = player();
    if (!p || !p.selectSub || !refreshTracks()) return;
    const want = embeddedId(sel);
    const wantId = want === null ? null : (subTracks().find((t) => String(t.id) === want) || { id: null }).id;
    if ((tracks.subId === undefined ? null : tracks.subId) !== wantId) {
      try { p.selectSub(wantId); tracks.subId = wantId; } catch (e) { env.log(`selectSub failed: ${e}`); }
    }
  }

  function select(key, user) {
    sel = key;
    if (user) chosen = true;
    if (key && key !== 'off') lastOn = key;
    syncEngine();
    renderer.clear();
    picRenderer.clear();
    changed();
  }

  /** Without a saved or user choice: a sidecar (exact name, then the UI language), else a default embedded track. */
  function autoChoose() {
    if (chosen) { syncEngine(); changed(); return; }
    // Not movie.part2.srt and the like: those may belong to another video (menu only).
    const list = [...files.values()].filter((f) => f.sidecar && f.auto);
    const score = (f) => (f.exact ? 4 : 0) + (langMatches(f.lang) ? 2 : 0) + ((f.flags || []).includes('forced') ? -3 : 0);
    list.sort((a, b) => score(b) - score(a));
    if (list.length) { select(list[0].key, false); return; }
    refreshTracks();
    if (tracks) {
      const cur = tracks.subId !== undefined && tracks.subId !== null ? subTracks().find((t) => t.id === tracks.subId) : null;
      const def = cur || textTracks().find((t) => t.default) || subTracks().find((t) => t.default);
      if (def) { select(`e:${def.id}`, false); return; }
    }
    if (sel === null) { syncEngine(); changed(); }
  }

  /** @param {boolean} user loaded just now by the user  @param {boolean} sidecar found next to the video */
  function addFile(f, user, sidecar) {
    let parsed;
    try { parsed = S.parse(f.data, f.name); } catch (e) { env.log(`subtitles ${f.name}: ${e && e.stack || e}`); toast(`Could not read ${f.name}`); return null; }
    if (!parsed.cues.length) { if (user) toast(`No subtitles found in ${f.name}`); return null; }
    // Keyed by the file's URI: two loaded files may share a name.
    const key = `f:${f.id || f.name}`;
    // A choice saved before files were keyed by URI names the file: carry it over.
    const old = `f:${f.name}`;
    if (key !== old) {
      if (sel === old) sel = key;
      if (lastOn === old) lastOn = key;
    }
    files.set(key, { key, name: f.name, lang: f.lang || '', flags: f.flags || [], exact: !!f.exact, auto: f.auto !== false, sidecar, index: new S.CueIndex(parsed.cues), title: typeof f.title === 'string' ? f.title.slice(0, 80) : '', stream: !!f.stream });
    env.log(`subtitles: ${f.name} (${parsed.format}, ${parsed.cues.length} cues)`);
    return key;
  }

  /** From the extension: sidecars found next to the video, or a file the user loaded. */
  function onSubs(m) {
    env.log(`subtitles: received ${(m.files || []).length} file(s)`);
    let pick = null;
    for (const f of m.files || []) {
      const k = addFile(f, !!m.select, !m.select && !m.restore);
      if (k && m.select && !pick) pick = k;
    }
    if (pick) { select(pick, true); toast(`Subtitles: ${describe(pick)}`); return; }
    autoChoose();
    changed();
  }

  /** Engine callback: the stream list is known. */
  function onTracks(eng) {
    const p = eng && typeof eng.tracks === 'function' ? eng : player();
    if (p) { try { tracks = p.tracks(); } catch { /* ignore */ } }
    if (p && tracks && audioPref !== null && tracks.audioId !== audioPref && (tracks.audio || []).some((a) => a.id === audioPref) && p.selectAudio) {
      p.selectAudio(audioPref).catch((e) => env.log(`selectAudio failed: ${e}`));
    }
    autoChoose();
    changed();
  }

  /** Engine callback: one cue of the embedded track being demuxed. */
  function onSubCue(c) {
    const id = c.track !== undefined ? String(c.track) : embeddedId(sel) || (tracks && tracks.subId !== null && tracks.subId !== undefined ? String(tracks.subId) : null);
    if (id === null) return;
    if (c.span !== undefined) {
      let idx = embedded.get(id);
      if (!(idx instanceof S.BitmapCueIndex)) { idx = new S.BitmapCueIndex(); embedded.set(id, idx); }
      idx.add(c);
      return;
    }
    const cue = S.embeddedCue(c);
    if (!cue) return;
    let idx = embedded.get(id);
    if (!idx) { idx = new S.CueIndex(); embedded.set(id, idx); }
    idx.add(cue);
  }

  /** Called whenever the page gets a player (also the image/MJPEG player). */
  function attach(p) {
    if (p && typeof p === 'object') p.onSubCue = onSubCue;
    tracks = null;
    autoChoose();
  }

  function currentIndex() {
    if (!sel || sel === 'off') return null;
    if (sel.startsWith('f:')) { const f = files.get(sel); return f ? f.index : null; }
    return embedded.get(embeddedId(sel) || '') || null;
  }

  // ---- overlay placement --------------------------------------------------------------
  let placed = '';
  function hide() { if (!layer.hidden) { layer.hidden = true; placed = ''; } }
  let picPlaced = '';
  function hidePic() { if (!pic.hidden) { pic.hidden = true; picPlaced = ''; } }

  /** The video's displayed rectangle (zoom and pan included: the canvas's transform moves its box), and the stage's. */
  function videoRect() {
    const iw = canvas.width, ih = canvas.height;
    const cr = canvas.getBoundingClientRect();
    if (canvas.hidden || !iw || !ih || !cr.width || !cr.height) return null;
    // object-fit: contain inside the element box.
    const k = Math.min(cr.width / iw, cr.height / ih);
    const w = iw * k, h = ih * k;
    return { x: cr.left + (cr.width - w) / 2, y: cr.top + (cr.height - h) / 2, w, h, sr: stage.getBoundingClientRect() };
  }

  /** Puts the layer over the video's displayed rectangle (fit, actual size, fullscreen, maxi). */
  function place() {
    const v = videoRect();
    if (!v) return false;
    const { x, y, w, h, sr } = v;
    // Actual size scrolls inside the stage: keep the text in the visible part.
    const left = Math.max(x, sr.left), right = Math.min(x + w, sr.right), top = Math.max(y, sr.top);
    let bottom = Math.min(y + h, sr.bottom);
    // In fullscreen and maxi the bar floats over the video; stay above it while it shows.
    if (!document.body.classList.contains('idle')) {
      const br = bar.getBoundingClientRect();
      if (br.height && br.top < bottom && br.bottom > top) bottom = Math.max(top, br.top);
    }
    if (right - left < 20 || bottom - top < 20) return false;
    const font = Math.max(11, Math.min(bottom - top, right - left) * 0.05 * size);
    const key = `${left.toFixed(0)},${top.toFixed(0)},${right.toFixed(0)},${bottom.toFixed(0)},${font.toFixed(1)}`;
    if (key !== placed) {
      placed = key;
      const s = layer.style;
      s.left = `${left}px`; s.top = `${top}px`; s.width = `${right - left}px`; s.height = `${bottom - top}px`;
      s.fontSize = `${font}px`;
    }
    return true;
  }

  /**
   * Picture subtitles stay where they are in the picture: the frame covers the whole
   * video (also when zoomed past the view), the box clips it to the stage.
   */
  function placePic() {
    const v = videoRect();
    if (!v) return false;
    const { x, y, w, h, sr } = v;
    const left = Math.max(x, sr.left), right = Math.min(x + w, sr.right);
    const top = Math.max(y, sr.top), bottom = Math.min(y + h, sr.bottom);
    if (right - left < 4 || bottom - top < 4) return false;
    const key = [left, top, right, bottom, x, y, w, h].map((n) => n.toFixed(1)).join(',');
    if (key !== picPlaced) {
      picPlaced = key;
      Object.assign(pic.style, { left: `${left}px`, top: `${top}px`, width: `${right - left}px`, height: `${bottom - top}px` });
      Object.assign(picFrame.style, { left: `${x - left}px`, top: `${y - top}px`, width: `${w}px`, height: `${h}px` });
    }
    return true;
  }

  /** Picture subtitles at the player's time. Nothing between a seek and the first answer of the worker after it. */
  function tickPic(p, idx) {
    hide();
    renderer.clear();
    const t = p.currentTime() - delay;
    idx.prune(t);
    const cues = typeof p.gen === 'number' && idx.gen < p.gen ? [] : idx.at(t);
    if (!cues.length) { hidePic(); picRenderer.clear(); return; }
    if (!placePic()) { hidePic(); return; }
    pic.hidden = false;
    picRenderer.render(cues);
  }

  /** Every frame, from the player's frame loop. */
  function tick() {
    const p = getPlayer();
    const idx = currentIndex();
    if (p && idx instanceof S.BitmapCueIndex) { tickPic(p, idx); return; }
    hidePic();
    picRenderer.clear();
    if (!p || !idx || !idx.size) { hide(); renderer.clear(); return; }
    const cues = idx.at(p.currentTime() - delay);
    if (!cues.length) { hide(); renderer.clear(); return; }
    if (!place()) { hide(); return; }
    layer.hidden = false;
    renderer.render(cues);
  }

  // ---- actions ----------------------------------------------------------------------------
  function sources() {
    return [...subTracks().map((t) => `e:${t.id}`), ...files.keys()];
  }
  function cycleSub() {
    refreshTracks();
    const list = [...sources(), 'off'];
    if (list.length === 1) { toast('No subtitles · Load a file in Settings › Subtitles'); return; }
    const i = list.indexOf(sel || 'off');
    const next = list[(i + 1) % list.length];
    select(next, true);
    toast(next === 'off' ? 'Subtitles off' : `Subtitles: ${describe(next)}`);
  }
  function toggleSubs() {
    refreshTracks();
    if (sel && sel !== 'off') { select('off', true); toast('Subtitles off'); return; }
    const all = sources();
    const next = lastOn && all.includes(lastOn) ? lastOn : all[0];
    if (!next) { toast('No subtitles · Load a file in Settings › Subtitles'); return; }
    select(next, true);
    toast(`Subtitles: ${describe(next)}`);
  }
  function setDelay(d) {
    delay = Math.round(d * 1000) / 1000;
    toast(`Subtitle delay ${delay > 0 ? '+' : ''}${Math.round(delay * 1000)} ms`);
    changed();
  }
  function setSize(s) {
    size = Math.max(0.5, Math.min(2.5, Math.round(s * 10) / 10));
    placed = '';
    toast(`Subtitle size ${Math.round(size * 100)}%`);
    changed();
  }
  function selectAudio(id) {
    const p = player();
    if (!p || !p.selectAudio) return;
    audioPref = id;
    const list = (tracks && tracks.audio) || [];
    const i = list.findIndex((a) => a.id === id);
    Promise.resolve(p.selectAudio(id)).then(() => {
      refreshTracks();
      toast(`Audio: ${i >= 0 ? trackLabel(list[i], i, 'Track').main : id}`);
      changed();
    }, (e) => { env.log(`selectAudio failed: ${e}`); toast('Could not switch the audio track'); });
  }
  function cycleAudio() {
    refreshTracks();
    const list = (tracks && tracks.audio) || [];
    if (list.length < 2) { toast(list.length ? 'Only one audio track' : 'No other audio tracks'); return; }
    const i = list.findIndex((a) => a.id === tracks.audioId);
    selectAudio(list[(i + 1) % list.length].id);
  }
  const loadFile = () => vscode.postMessage({ type: 'loadSubs' });

  /** For the Subtitles and Audio track panels (media/controls.js). */
  function panelData() {
    refreshTracks();
    const cur = sel || 'off';
    const subs = [
      ...subTracks().map((t, i) => ({ key: `e:${t.id}`, ...trackLabel(t, i, 'Track'), checked: cur === `e:${t.id}` })),
      ...[...files.values()].map((f) => ({ key: f.key, ...fileLabel(f), checked: cur === f.key })),
    ];
    const al = (tracks && tracks.audio) || [];
    const audio = al.length > 1 ? al.map((a, i) => ({ id: a.id, ...trackLabel(a, i, 'Track'), checked: a.id === tracks.audioId })) : [];
    return { sel: cur, on: cur !== 'off', subs, audio, delay, size, label: cur === 'off' ? 'Off' : describe(cur) };
  }
  /** Toggles subtitles when there are tracks, otherwise lets the caller open the Subtitles page. */
  function ccToggle() {
    refreshTracks();
    if (!sources().length) return false;
    toggleSubs();
    return true;
  }

  /** Player keys. True when handled. */
  function onKey(e) {
    switch (e.key) {
      case 'v': cycleSub(); return true;
      case 'V': if (e.shiftKey) toggleSubs(); else cycleSub(); return true;
      case 'g': case 'G': setDelay(delay - 0.05); return true;
      case 'h': case 'H': setDelay(delay + 0.05); return true;
      case '#': cycleAudio(); return true;
      case 'A': if (e.shiftKey) { cycleAudio(); return true; } return false;
      default: return false;
    }
  }

  /** For the webview state (restored after reloads). */
  function state() { return { sel: chosen ? sel : null, lastOn, delay, size, audio: audioPref }; }

  /** For the right-click menu: how many subtitle files / tracks and audio tracks there are to choose from. */
  function available() { return { subs: files.size + subTracks().length, audio: ((tracks && tracks.audio) || []).length }; }

  return {
    tick, onKey, onSubs, onTracks, attach, state, available, panelData, ccToggle, loadFile,
    select: (key) => { select(key, true); toast(key === 'off' ? 'Subtitles off' : `Subtitles: ${describe(key)}`); },
    selectAudio, delayBy: (d) => setDelay(d === null ? 0 : delay + d), sizeBy: (d) => setSize(d === null ? 1 : size + d),
  };
}
