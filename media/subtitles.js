// @ts-check
// Subtitles: decoding, parsers (SRT, WebVTT, ASS/SSA), a cue index with binary
// search, and a DOM overlay renderer; picture subtitles (PGS/DVB/DVD bitmaps) at
// the end. No dependencies; also loads in Node for tests.
//
// A cue is { start, end, lines, an, pos, scale }:
//   lines: [[{ text, i, b, u, s, c }]]   runs of styled text per line (text only, never HTML)
//   an:    numpad alignment 1..9 (2 = bottom centre, the default)
//   pos:   null, or { x, y } as fractions of the video, anchored by `an`
//   scale: relative font size (ASS styles), 1 by default
'use strict';
(function (root) {
  // ---- Text decoding --------------------------------------------------------

  /** Bytes to text: UTF-8/UTF-16 BOMs, else UTF-8, falling back to windows-1252. */
  function decode(bytes) {
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return new TextDecoder('utf-8').decode(b.subarray(3));
    if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) return new TextDecoder('utf-16le').decode(b.subarray(2));
    if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) return new TextDecoder('utf-16be').decode(b.subarray(2));
    // UTF-16 without a BOM: mostly-ASCII text has a zero in every other byte.
    if (b.length >= 8) {
      let even = 0, odd = 0;
      const n = Math.min(b.length & ~1, 4096);
      for (let i = 0; i < n; i += 2) { if (b[i] === 0) even++; if (b[i + 1] === 0) odd++; }
      if (odd > n / 2 * 0.4 && even < n / 2 * 0.05) return new TextDecoder('utf-16le').decode(b);
      if (even > n / 2 * 0.4 && odd < n / 2 * 0.05) return new TextDecoder('utf-16be').decode(b);
    }
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(b);
    } catch {
      return new TextDecoder('windows-1252').decode(b);
    }
  }

  // ---- Helpers ----------------------------------------------------------------

  const TIME = /^\s*(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[.,:](\d+))?\s*$/;
  /** "01:02:03,456", "02:03.456" or "1:02:03.45" in seconds; NaN when malformed. */
  function parseTime(s) {
    const m = TIME.exec(s);
    if (!m) return NaN;
    return (Number(m[1] || 0) * 3600) + Number(m[2]) * 60 + Number(m[3]) + (m[4] ? Number(`0.${m[4]}`) : 0);
  }

  const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', lrm: '‎', rlm: '‏' };
  const unescape = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : all;
    }
    const v = ENTITIES[e.toLowerCase()];
    return v === undefined ? all : v;
  });

  /** Splits runs at newlines into lines; drops empty leading/trailing lines. */
  function toLines(runs) {
    const lines = [[]];
    for (const r of runs) {
      const parts = r.text.split('\n');
      parts.forEach((p, k) => {
        if (k > 0) lines.push([]);
        if (p) lines[lines.length - 1].push({ ...r, text: p });
      });
    }
    const blank = (l) => !l.some((r) => r.text.trim());
    while (lines.length && blank(lines[0])) lines.shift();
    while (lines.length && blank(lines[lines.length - 1])) lines.pop();
    return lines;
  }

  const cueText = (cue) => cue.lines.map((l) => l.map((r) => r.text).join('')).join('\n');

  // ---- SRT / WebVTT inline markup --------------------------------------------

  /**
   * <i> <b> <u> <s> <font color>, VTT <c> <v> <lang> <ruby> and timestamps, entities,
   * and {\anN} (common in SRT). Unknown tags are dropped, stray '<' kept.
   * @returns {{ runs: any[], an: number }}
   */
  function parseMarkup(text, an = 2) {
    const runs = [];
    const st = { i: false, b: false, u: false, s: false, c: '' };
    const colors = [];
    let skipRt = 0;
    const re = /<(\/?)([a-zA-Z][\w.-]*|\d+:[\d:.]+)([^<>]*)>|\{(\\[^{}]*)\}/g;
    let last = 0;
    let m;
    const push = (s) => { if (s && !skipRt) runs.push({ text: unescape(s), i: st.i, b: st.b, u: st.u, s: st.s, c: st.c }); };
    while ((m = re.exec(text))) {
      push(text.slice(last, m.index));
      last = re.lastIndex;
      if (m[4] !== undefined) {
        const a = /\\an([1-9])/.exec(m[4]);
        if (a) an = Number(a[1]);
        continue;
      }
      const close = m[1] === '/';
      const tag = m[2].split('.')[0].toLowerCase();
      if (tag === 'i' || tag === 'b' || tag === 'u' || tag === 's') st[tag] = !close;
      else if (tag === 'font') {
        if (close) { colors.pop(); st.c = colors[colors.length - 1] || ''; } else {
          const c = /color\s*=\s*["']?\s*(#?[0-9a-z]+)/i.exec(m[3]);
          let col = c ? c[1] : st.c;
          if (/^[0-9a-f]{6}$/i.test(col)) col = `#${col}`;
          colors.push(col);
          st.c = col;
        }
      } else if (tag === 'rt') skipRt = close ? 0 : 1;
    }
    push(text.slice(last));
    return { runs, an };
  }

  // ---- SRT ----------------------------------------------------------------------

  const ARROW = /-->/;
  function parseSrt(text) {
    const lines = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n');
    const timings = [];
    for (let i = 0; i < lines.length; i++) if (ARROW.test(lines[i])) timings.push(i);
    const cues = [];
    timings.forEach((ti, k) => {
      const [a, b] = lines[ti].split('-->');
      const start = parseTime(a);
      const end = parseTime((b || '').trim().split(/\s+/)[0]);
      if (!(end > start)) return;
      const stop = k + 1 < timings.length ? timings[k + 1] : lines.length;
      const body = lines.slice(ti + 1, stop);
      // The next cue's index line, then the blank separator.
      if (k + 1 < timings.length && body.length && /^\s*\d+\s*$/.test(body[body.length - 1])) body.pop();
      while (body.length && !body[body.length - 1].trim()) body.pop();
      const { runs, an } = parseMarkup(body.join('\n'));
      const out = toLines(runs);
      if (out.length) cues.push({ start, end, lines: out, an, pos: null, scale: 1 });
    });
    return cues;
  }

  // ---- WebVTT ----------------------------------------------------------------------

  function vttSettings(s, an) {
    const set = {};
    for (const kv of s.trim().split(/\s+/)) {
      const k = kv.indexOf(':');
      if (k > 0) set[kv.slice(0, k)] = kv.slice(k + 1);
    }
    let pos = null;
    let h = 1; // 0 left, 1 centre, 2 right
    const al = set.align;
    if (al === 'start' || al === 'left') h = 0;
    else if (al === 'end' || al === 'right') h = 2;
    let v = 0; // 0 bottom, 1 middle, 2 top
    const line = set.line ? set.line.split(',') : null;
    let y = null;
    if (line) {
      if (/%$/.test(line[0])) {
        y = parseFloat(line[0]) / 100;
        const la = line[1] || 'start';
        v = la === 'end' ? 0 : la === 'center' ? 1 : 2;
      } else {
        const n = parseFloat(line[0]);
        if (isFinite(n)) v = n >= 0 ? 2 : 0;
      }
    }
    let x = null;
    if (set.position) {
      const p = set.position.split(',');
      x = parseFloat(p[0]) / 100;
      const pa = p[1];
      if (pa === 'line-left') h = 0; else if (pa === 'line-right') h = 2; else if (pa === 'center') h = 1;
    }
    if (y !== null || x !== null) {
      if (!(x >= 0)) x = h === 0 ? 0.05 : h === 2 ? 0.95 : 0.5;
      if (!(y >= 0)) y = v === 2 ? 0.05 : v === 1 ? 0.5 : 0.95;
      pos = { x, y };
    }
    an = (v === 2 ? 7 : v === 1 ? 4 : 1) + h;
    return { an, pos };
  }

  function parseVtt(text) {
    const blocks = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split(/\n[ \t]*\n/);
    const cues = [];
    blocks.forEach((block, k) => {
      const lines = block.split('\n');
      while (lines.length && !lines[0].trim()) lines.shift();
      if (!lines.length) return;
      if (k === 0 && /^WEBVTT/.test(lines[0])) {
        // Header: the WEBVTT line and metadata; a cue can't follow without a blank line.
        return;
      }
      if (/^(NOTE|STYLE|REGION)(\s|$)/.test(lines[0])) return;
      let ti = ARROW.test(lines[0]) ? 0 : lines.length > 1 && ARROW.test(lines[1]) ? 1 : -1;
      if (ti < 0) return;
      const [a, rest] = lines[ti].split('-->');
      const restParts = (rest || '').trim().split(/\s+/);
      const start = parseTime(a);
      const end = parseTime(restParts[0]);
      if (!(end > start)) return;
      const { an, pos } = vttSettings(restParts.slice(1).join(' '), 2);
      const parsed = parseMarkup(lines.slice(ti + 1).join('\n'), an);
      const out = toLines(parsed.runs);
      if (out.length) cues.push({ start, end, lines: out, an: parsed.an, pos, scale: 1 });
    });
    return cues;
  }

  // ---- ASS / SSA ---------------------------------------------------------------------

  /** &HAABBGGRR& or decimal (SSA) to a CSS colour; '' when unparseable. */
  function assColor(s) {
    if (!s) return '';
    s = s.trim().replace(/&$/, '');
    let n;
    if (/^&H/i.test(s)) n = parseInt(s.slice(2), 16);
    else if (/^-?\d+$/.test(s)) n = Number(s) >>> 0;
    else return '';
    if (!isFinite(n)) return '';
    const r = n & 255, g = (n >>> 8) & 255, b = (n >>> 16) & 255;
    return `#${[r, g, b].map((x) => x.toString(16).padStart(2, '0')).join('')}`;
  }

  /** SSA v4 "Alignment" (1-3 bottom, +4 top, +8 middle) to numpad. */
  const legacyAn = (a) => {
    const h = ((a - 1) & 3);
    if (h > 2) return 2;
    return a >= 9 ? 4 + h : a >= 5 ? 7 + h : 1 + h;
  };

  /**
   * One ASS event's text with override tags. `style` gives the defaults.
   * Handles \i \b \u \s \c \1c \r \an \a \pos \move \p (drawings dropped), \N \n \h.
   */
  function parseAssText(text, style, ctx) {
    const base = { i: !!style.i, b: !!style.b, u: !!style.u, s: !!style.s, c: style.c || '' };
    let st = { ...base };
    let an = style.an || 2;
    let pos = null;
    let drawing = false;
    const runs = [];
    const re = /\{([^}]*)\}/g;
    let last = 0;
    let m;
    const push = (s) => {
      if (!s || drawing) return;
      s = s.replace(/\\N/g, '\n').replace(/\\n/g, ctx.wrapStyle === 2 ? '\n' : ' ').replace(/\\h/g, ' ');
      runs.push({ text: s, ...st });
    };
    while ((m = re.exec(text))) {
      push(text.slice(last, m.index));
      last = re.lastIndex;
      const block = m[1];
      if (block.indexOf('\\') < 0) continue; // a comment
      const tre = /\\(\d?[a-z]+)(\([^)]*\)|[^\\(]*)/gi;
      let t;
      while ((t = tre.exec(block))) {
        const name = t[1].toLowerCase();
        const arg = t[2].trim();
        const on = (v) => (v === '' ? null : Number(v) !== 0);
        switch (name) {
          case 'i': case 'u': case 's': { const v = on(arg); st[name] = v === null ? base[name] : v; break; }
          case 'b': { if (arg === '') st.b = base.b; else { const n = Number(arg); st.b = n === 1 || n >= 600; } break; }
          case 'c': case '1c': st.c = arg ? assColor(arg) || st.c : base.c; break;
          case 'r': {
            const s2 = arg && ctx.styles[arg.toLowerCase()] || style;
            st = { i: !!s2.i, b: !!s2.b, u: !!s2.u, s: !!s2.s, c: s2.c || '' };
            break;
          }
          case 'an': { const n = Number(arg); if (n >= 1 && n <= 9) an = n; break; }
          case 'a': { const n = Number(arg); if (n >= 1 && n <= 11) an = legacyAn(n); break; }
          case 'pos': case 'move': {
            const p = arg.replace(/[()]/g, '').split(',').map(Number);
            if (isFinite(p[0]) && isFinite(p[1])) pos = { x: p[0] / ctx.resX, y: p[1] / ctx.resY };
            break;
          }
          case 'p': drawing = Number(arg) > 0; break;
          default: break;
        }
      }
    }
    push(text.slice(last));
    return { lines: toLines(runs), an, pos };
  }

  function splitFields(line, n) {
    const out = [];
    let rest = line;
    for (let k = 0; k < n - 1; k++) {
      const i = rest.indexOf(',');
      if (i < 0) break;
      out.push(rest.slice(0, i));
      rest = rest.slice(i + 1);
    }
    out.push(rest);
    return out;
  }

  function parseAss(text) {
    const lines = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n');
    let section = '';
    let legacy = false;
    const info = {};
    let styleFormat = null;
    let eventFormat = null;
    const rawStyles = [];
    const events = [];
    for (const raw of lines) {
      const line = raw.trim();
      if (!line || line[0] === ';') continue;
      const sec = /^\[(.+)\]$/.exec(line);
      if (sec) { section = sec[1].toLowerCase(); if (section === 'v4 styles') legacy = true; continue; }
      const k = line.indexOf(':');
      if (k < 0) continue;
      const key = line.slice(0, k).trim().toLowerCase();
      const val = line.slice(k + 1).replace(/^\s/, '');
      if (section === 'script info') info[key] = val.trim();
      else if (section.indexOf('styles') >= 0) {
        if (key === 'format') styleFormat = val.split(',').map((s) => s.trim().toLowerCase());
        else if (key === 'style') rawStyles.push(val);
      } else if (section === 'events') {
        if (key === 'format') eventFormat = val.split(',').map((s) => s.trim().toLowerCase());
        else if (key === 'dialogue') events.push(val);
      }
    }
    if (/v4\.00$/i.test(info.scripttype || '') && !/\+/.test(info.scripttype)) legacy = true;
    let resX = Number(info.playresx) || 0;
    let resY = Number(info.playresy) || 0;
    if (!resX && !resY) { resX = 384; resY = 288; } else if (!resY) resY = resX === 1280 ? 1024 : resX * 3 / 4; else if (!resX) resX = resY === 1024 ? 1280 : resY * 4 / 3;
    const ctx = { resX, resY, wrapStyle: Number(info.wrapstyle) || 0, styles: {} };

    const sf = styleFormat || ['name', 'fontname', 'fontsize', 'primarycolour', 'secondarycolour', 'outlinecolour', 'backcolour', 'bold', 'italic', 'underline', 'strikeout', 'scalex', 'scaley', 'spacing', 'angle', 'borderstyle', 'outline', 'shadow', 'alignment', 'marginl', 'marginr', 'marginv', 'encoding'];
    for (const r of rawStyles) {
      const f = splitFields(r, sf.length);
      const get = (n) => { const i = sf.indexOf(n); return i >= 0 ? (f[i] || '').trim() : ''; };
      const flag = (n) => { const v = Number(get(n)); return v !== 0 && isFinite(v); };
      const al = Number(get('alignment')) || 2;
      const c = assColor(get('primarycolour'));
      ctx.styles[get('name').toLowerCase()] = {
        i: flag('italic'), b: flag('bold'), u: flag('underline'), s: flag('strikeout'),
        c: c === '#ffffff' ? '' : c, an: legacy ? legacyAn(al) : (al >= 1 && al <= 9 ? al : 2),
        size: Number(get('fontsize')) || 0,
      };
    }
    // Sizes relative to the dialogue style, so dialogue matches SRT size and signs keep their proportion.
    const def = ctx.styles.default || Object.values(ctx.styles)[0];
    const ref = def && def.size || 0;

    const ef = eventFormat || ['layer', 'start', 'end', 'style', 'name', 'marginl', 'marginr', 'marginv', 'effect', 'text'];
    const ti = ef.indexOf('text');
    const cues = [];
    for (const e of events) {
      const f = splitFields(e, ef.length);
      const get = (n) => { const i = ef.indexOf(n); return i >= 0 ? f[i] || '' : ''; };
      const start = parseTime(get('start'));
      const end = parseTime(get('end'));
      if (!(end > start)) continue;
      const style = ctx.styles[get('style').trim().replace(/^\*/, '').toLowerCase()] || def || {};
      const p = parseAssText(ti >= 0 ? f[ti] || '' : '', style, ctx);
      if (!p.lines.length) continue;
      const scale = ref && style.size ? Math.max(0.5, Math.min(2.5, style.size / ref)) : 1;
      cues.push({ start, end, lines: p.lines, an: p.an, pos: p.pos, scale, layer: Number(get('layer')) || 0 });
    }
    return cues;
  }

  /**
   * An embedded subtitle packet's text. libav gives ASS events as
   * "ReadOrder,Layer,Style,Name,MarginL,MarginR,MarginV,Effect,Text" (or a full
   * "Dialogue:" line); plain text tracks may carry SRT-style tags.
   */
  function embeddedCue(c) {
    const start = Number(c.start), end = Number(c.end);
    if (!(end > start)) return null;
    let lines, an = 2, pos = null;
    if (typeof c.ass === 'string' && c.ass) {
      let s = c.ass.replace(/\r?\n$/, '');
      let n = 9;
      if (/^Dialogue:\s*/i.test(s)) { s = s.replace(/^Dialogue:\s*/i, ''); n = 10; }
      const f = splitFields(s, n);
      const body = f.length === n ? f[n - 1] : s;
      const p = parseAssText(body, {}, { resX: 384, resY: 288, wrapStyle: 0, styles: {} });
      lines = p.lines; an = p.an;
      // Without the track's PlayRes, \pos coordinates can't be placed; keep the alignment.
      pos = null;
    } else {
      const parsed = parseMarkup(String(c.text || '').replace(/\r\n?/g, '\n').replace(/\\N/g, '\n'));
      lines = toLines(parsed.runs);
      an = parsed.an;
    }
    if (!lines.length) return null;
    return { start, end, lines, an, pos, scale: 1 };
  }

  /** Format from the file name, else from the content. */
  function detectFormat(text, name = '') {
    const ext = (/\.([a-z0-9]+)$/i.exec(name) || [])[1];
    const t = text.replace(/^﻿/, '').trimStart();
    if (/^WEBVTT/.test(t)) return 'vtt';
    if (/^\[Script Info\]/i.test(t) || /^\[(V4\+? Styles|Events)\]/im.test(t)) return 'ass';
    if (ext) { const e = ext.toLowerCase(); if (e === 'vtt') return 'vtt'; if (e === 'ass' || e === 'ssa') return 'ass'; }
    return 'srt';
  }

  /** Bytes or text to cues, sorted by start. */
  function parse(input, name = '') {
    const text = typeof input === 'string' ? input : decode(input);
    const format = detectFormat(text, name);
    const cues = format === 'vtt' ? parseVtt(text) : format === 'ass' ? parseAss(text) : parseSrt(text);
    cues.sort((a, b) => a.start - b.start || (a.layer || 0) - (b.layer || 0));
    return { format, cues };
  }

  // ---- Cue index -----------------------------------------------------------------------

  /** Cues sorted by start, with a running maximum of end times for overlap-safe lookups. */
  class CueIndex {
    constructor(cues = []) {
      this.cues = cues.slice().sort((a, b) => a.start - b.start);
      this.keys = new Set(this.cues.map(CueIndex.key));
      this.maxEnd = null;
    }

    static key(c) { return `${c.start.toFixed(3)}|${c.end.toFixed(3)}|${cueText(c)}`; }

    /** Adds a cue (embedded streams deliver them as the demuxer reaches them). False if known. */
    add(cue) {
      const k = CueIndex.key(cue);
      if (this.keys.has(k)) return false;
      this.keys.add(k);
      const i = this.upper(cue.start);
      this.cues.splice(i, 0, cue);
      this.maxEnd = null;
      return true;
    }

    /** First index whose start is > t. */
    upper(t) {
      let lo = 0, hi = this.cues.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (this.cues[mid].start <= t) lo = mid + 1; else hi = mid;
      }
      return lo;
    }

    /** Cues showing at t (start <= t < end), in start order. */
    at(t) {
      const c = this.cues;
      if (!c.length) return [];
      if (!this.maxEnd) {
        this.maxEnd = new Float64Array(c.length);
        let mx = -Infinity;
        for (let i = 0; i < c.length; i++) { mx = Math.max(mx, c[i].end); this.maxEnd[i] = mx; }
      }
      const out = [];
      for (let i = this.upper(t) - 1; i >= 0 && this.maxEnd[i] > t; i--) if (c[i].end > t) out.push(c[i]);
      return out.reverse();
    }

    get size() { return this.cues.length; }
  }

  // ---- Renderer --------------------------------------------------------------------------

  /**
   * Draws cues into `layer`, a fixed-position element the caller places over the
   * video's displayed rectangle. Rebuilds the DOM only when the shown cues change.
   */
  class SubtitleRenderer {
    constructor(layer) {
      this.layer = layer;
      this.sig = '';
      this.ids = new WeakMap();
      this.next = 1;
      const doc = layer.ownerDocument;
      this.regions = ['top', 'middle', 'bottom'].map((n) => {
        const d = doc.createElement('div');
        d.className = `subs-region ${n}`;
        layer.appendChild(d);
        return d;
      });
      this.abs = doc.createElement('div');
      this.abs.className = 'subs-abs';
      layer.appendChild(this.abs);
    }

    id(c) {
      let v = this.ids.get(c);
      if (!v) { v = this.next++; this.ids.set(c, v); }
      return v;
    }

    clear() { this.render([]); }

    /** @param {any[]} cues the cues to show now */
    render(cues) {
      const sig = cues.map((c) => this.id(c)).join(',');
      if (sig === this.sig) return;
      this.sig = sig;
      for (const r of this.regions) r.textContent = '';
      this.abs.textContent = '';
      const doc = this.layer.ownerDocument;
      for (const c of cues) {
        const el = doc.createElement('div');
        const h = (c.an - 1) % 3; // 0 left, 1 centre, 2 right
        el.className = `subs-cue h${h}`;
        if (c.scale && c.scale !== 1) el.style.fontSize = `${c.scale}em`;
        c.lines.forEach((line, k) => {
          if (k) el.appendChild(doc.createElement('br'));
          for (const r of line) {
            const s = doc.createElement('span');
            s.textContent = r.text;
            if (r.i) s.style.fontStyle = 'italic';
            if (r.b) s.style.fontWeight = '800';
            const deco = `${r.u ? 'underline ' : ''}${r.s ? 'line-through' : ''}`.trim();
            if (deco) s.style.textDecoration = deco;
            if (r.c) s.style.color = r.c;
            el.appendChild(s);
          }
        });
        if (c.pos) {
          const v = c.an >= 7 ? 0 : c.an >= 4 ? -50 : -100;
          el.classList.add('pos');
          el.style.left = `${c.pos.x * 100}%`;
          el.style.top = `${c.pos.y * 100}%`;
          el.style.transform = `translate(${-50 * h}%, ${v}%)`;
          this.abs.appendChild(el);
        } else {
          this.regions[c.an >= 7 ? 0 : c.an >= 4 ? 1 : 2].appendChild(el);
        }
      }
    }
  }

  // ---- Picture subtitles (PGS, DVB, DVD) ----------------------------------------------
  // A picture cue is { start, end, rects, frame: [w, h], span }: rects are
  // { x, y, w, h, bitmap (w*h palette indices), palette (Uint32Array, 0xAARRGGBB) }
  // in the subtitle canvas `frame`, which covers the whole video picture. end is
  // null when the stream gives none (PGS): the next picture (or an empty cue, which
  // has no rects) ends it.

  /** Palette bitmap to RGBA bytes (straight alpha, as ImageData wants). Indices past the palette are transparent. */
  function bitmapRgba(r) {
    const n = r.w * r.h;
    const out = new Uint8ClampedArray(n * 4);
    const pal = r.palette;
    const lut = new Uint32Array(256); // RGBA bytes as one little-endian word
    for (let i = 0; i < Math.min(256, pal.length); i++) {
      const v = pal[i];
      lut[i] = (((v >>> 24) & 0xff) << 24 | (v & 0xff) << 16 | ((v >>> 8) & 0xff) << 8 | ((v >>> 16) & 0xff)) >>> 0;
    }
    const words = new Uint32Array(out.buffer);
    const bm = r.bitmap;
    const little = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;
    if (little) {
      for (let i = 0; i < n; i++) words[i] = lut[bm[i]];
    } else {
      for (let i = 0; i < n; i++) {
        const v = lut[bm[i]];
        out[i * 4] = v & 0xff; out[i * 4 + 1] = (v >>> 8) & 0xff; out[i * 4 + 2] = (v >>> 16) & 0xff; out[i * 4 + 3] = v >>> 24;
      }
    }
    return out;
  }

  /** Where rect r goes, in percent of the video picture (the subtitle canvas is stretched over it). */
  function bitmapBox(r, frame) {
    const [fw, fh] = frame;
    return { left: (r.x / fw) * 100, top: (r.y / fh) * 100, width: (r.w / fw) * 100, height: (r.h / fh) * 100 };
  }

  const BITMAP_KEEP = 30; // seconds of past pictures kept
  const BITMAP_BYTES = 64 << 20; // and at most this many bitmap bytes

  /**
   * The picture cues of one subtitle track, for one span (a contiguous read: a
   * cue of a newer span drops everything before). The latest picture that started
   * is shown until its end or the next cue. Past pictures are dropped as time goes on.
   */
  class BitmapCueIndex {
    constructor() {
      this.cues = [];
      this.keys = new Set();
      this.span = -Infinity;
      this.gen = -Infinity;
      this.bytes = 0;
    }

    static key(c) { return `${c.start.toFixed(3)}|${c.rects.map((r) => `${r.x},${r.y},${r.w}x${r.h}`).join(';')}`; }

    reset() { this.cues = []; this.keys.clear(); this.bytes = 0; }

    /**
     * A cue, or a span marker ({ span, gen } without rects: a new read began).
     * False when it is old (an earlier span) or known.
     */
    add(c) {
      if (c.span < this.span) return false;
      if (c.span > this.span) { this.reset(); this.span = c.span; }
      if (typeof c.gen === 'number' && c.gen > this.gen) this.gen = c.gen;
      if (!c.rects || typeof c.start !== 'number' || !isFinite(c.start)) return false;
      const k = BitmapCueIndex.key(c);
      if (this.keys.has(k)) return false;
      this.keys.add(k);
      this.cues.splice(this.upper(c.start), 0, c);
      for (const r of c.rects) this.bytes += r.w * r.h;
      return true;
    }

    /** First index whose start is > t. */
    upper(t) {
      let lo = 0, hi = this.cues.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (this.cues[mid].start <= t) lo = mid + 1; else hi = mid;
      }
      return lo;
    }

    /** When cue i stops showing (Infinity: not known yet). */
    endOf(i) {
      const c = this.cues[i];
      const next = i + 1 < this.cues.length ? this.cues[i + 1].start : Infinity;
      return Math.min(c.end === null || c.end === undefined ? Infinity : c.end, next);
    }

    /** The picture showing at t: [] or [cue]. */
    at(t) {
      const i = this.upper(t) - 1;
      if (i < 0) return [];
      const c = this.cues[i];
      return c.rects.length && t < this.endOf(i) ? [c] : [];
    }

    /** Drops pictures that ended more than BITMAP_KEEP s before t, and the oldest ones over the byte budget. */
    prune(t) {
      let n = 0;
      let bytes = this.bytes;
      while (n < this.cues.length - 1 && (this.endOf(n) < t - BITMAP_KEEP || bytes > BITMAP_BYTES)) {
        for (const r of this.cues[n].rects) bytes -= r.w * r.h;
        n++;
      }
      if (!n) return;
      for (const c of this.cues.splice(0, n)) this.keys.delete(BitmapCueIndex.key(c));
      this.bytes = bytes;
    }

    get size() { return this.cues.length; }
  }

  /** Draws the shown picture into `box`, an element covering the video picture: one canvas per rect. */
  class BitmapRenderer {
    constructor(box) {
      this.box = box;
      this.cur = null;
    }

    clear() { this.render([]); }

    /** @param {any[]} cues [] or [picture cue] */
    render(cues) {
      const c = cues[0] || null;
      if (c === this.cur) return;
      this.cur = c;
      this.box.textContent = '';
      if (!c) return;
      const doc = this.box.ownerDocument;
      for (const r of c.rects) {
        const cv = doc.createElement('canvas');
        cv.width = r.w;
        cv.height = r.h;
        cv.className = 'subs-bitmap';
        const g = cv.getContext('2d');
        if (g) g.putImageData(new ImageData(bitmapRgba(r), r.w, r.h), 0, 0);
        const b = bitmapBox(r, c.frame);
        Object.assign(cv.style, { left: `${b.left}%`, top: `${b.top}%`, width: `${b.width}%`, height: `${b.height}%` });
        this.box.appendChild(cv);
      }
    }
  }

  const api = {
    decode, parse, parseSrt, parseVtt, parseAss, parseTime, detectFormat, embeddedCue, cueText, CueIndex, SubtitleRenderer,
    bitmapRgba, bitmapBox, BitmapCueIndex, BitmapRenderer,
  };
  root.Subtitles = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
