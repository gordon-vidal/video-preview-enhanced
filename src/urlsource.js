'use strict';
// Network videos for "Video Preview: Open Video URL…" (docs/notes/url-stream.md).
//
// The URL always comes from the user: typed or pasted into VS Code's own input box (or picked from
// the recent list, which holds only URLs typed there). Never from a file's contents or a webview
// message. Only http: and https: are accepted; the URL is never passed to a shell.
//
// Without native ffmpeg the built-in decoder reads the video through the same block interface it
// uses for local files (Session.readBlock); the blocks come from here:
//   - HttpFile: a direct MP4/WebM/MKV/... file, read with HTTP range requests (Node http/https in
//     the extension host, so the webview's CSP and CORS don't apply). A server without range support
//     works for files up to MAX_WHOLE (downloaded in the background, reads wait for their bytes).
//   - HlsFile: an HLS VOD playlist (MPEG-TS or fMP4 segments, clear or AES-128) shown to the decoder
//     as one file: the segments one after the other (MPEG-TS concatenates; fMP4 = init segment +
//     fragments), AES-128 decrypted here. Live playlists and DASH need native ffmpeg (NeedsFfmpeg);
//     DRM (SAMPLE-AES, FairPlay, Widevine, PlayReady) plays nowhere (Protected).
// For HLS master playlists hlsOpen keeps the whole master (variants, EXT-X-MEDIA renditions, I-frame
// playlists) for the quality menu, and hlsSubtitles joins the WebVTT subtitle renditions for the page.
// With native ffmpeg the URL itself goes to ffmpeg (src/ffmpeg.js inputArgs: a network protocol
// whitelist only for URL inputs; files keep -protocol_whitelist file).

const http = require('http');
const https = require('https');
const crypto = require('crypto');

const MAX_URL = 4096;
const RECENT_KEY = 'videoPreviewEnhanced.recentUrls';
const MAX_RECENT = 10;
const HEAD_BYTES = 64 * 1024; // the first read: kind detection and the start of the file
const MAX_WHOLE = 512 * 1024 * 1024; // a server without range requests: download files up to this size
const MAX_PLAYLIST = 8 * 1024 * 1024;
const TIMEOUT_MS = 20000;
const MAX_REDIRECTS = 5;
const SIZE_CONCURRENCY = 8;

/** NeedsFfmpeg: the built-in decoder can't play this URL (live HLS, DASH, encryption); why: shown to the user. */
class NeedsFfmpeg extends Error {
  constructor(why) { super(`${why} needs native ffmpeg`); this.why = why; this.needsFfmpeg = true; }
}

/**
 * Checks a URL the user typed. Returns { url } (normalised) or { error } (a sentence for the input box).
 * http/https only, a host, no user:password@ (it would be logged and shown), no spaces or control characters.
 */
function checkUrl(text) {
  const s = String(text == null ? '' : text).trim();
  if (!s) return { error: 'Enter a URL that starts with https:// or http://' };
  if (s.length > MAX_URL) return { error: `The URL is longer than ${MAX_URL} characters` };
  // eslint-disable-next-line no-control-regex
  if (/[\s\u0000-\u001f\u007f]/.test(s)) return { error: 'The URL contains spaces or control characters' };
  let u;
  try { u = new URL(s); } catch { return { error: 'Not a valid URL (it should look like https://example.com/video.mp4)' }; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { error: `Only http:// and https:// URLs can be opened (not ${u.protocol.replace(/:$/, '')}:)` };
  if (!u.hostname) return { error: 'The URL has no host name' };
  if (u.username || u.password) return { error: 'URLs with a user name or password (user:pass@host) are not supported' };
  u.hash = '';
  return { url: u.href };
}

/** The URL for logs and the tab: no query string (signed URLs carry tokens there). */
function redact(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname}${u.search ? '?…' : ''}`;
  } catch { return '(bad URL)'; }
}

/** A short name for the tab: the last path segment (decoded), else the host. */
function displayName(url) {
  try {
    const u = new URL(url);
    const last = u.pathname.split('/').filter(Boolean).pop();
    let name = last ? decodeURIComponent(last) : u.host;
    if (name.length > 60) name = `${name.slice(0, 57)}…`;
    return name || u.host;
  } catch { return 'video'; }
}

/** Recent URLs (newest first, at most MAX_RECENT) in globalState. */
function recentUrls(state) {
  const list = state && state.get(RECENT_KEY);
  return Array.isArray(list) ? list.filter((x) => typeof x === 'string' && !checkUrl(x).error).slice(0, MAX_RECENT) : [];
}

function rememberUrl(state, url) {
  if (!state) return Promise.resolve();
  const list = [url, ...recentUrls(state).filter((x) => x !== url)].slice(0, MAX_RECENT);
  return state.update(RECENT_KEY, list);
}

// ---- HTTP ----------------------------------------------------------------

const agents = {
  'http:': new http.Agent({ keepAlive: true, maxSockets: 8 }),
  'https:': new https.Agent({ keepAlive: true, maxSockets: 8 }),
};

/** A sentence for a network error (what the player shows). */
function describeError(e, url) {
  let host = '';
  try { host = new URL(url).host; } catch { /* keep empty */ }
  const code = (e && e.code) || '';
  const msg = (e && e.message) || String(e);
  if (e && e.status) return msg;
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return `Can't find the server ${host} (no DNS entry or no network)`;
  if (code === 'ECONNREFUSED') return `${host} refused the connection`;
  if (code === 'ECONNRESET') return `${host} closed the connection`;
  if (code === 'ETIMEDOUT' || code === 'TIMEOUT') return `${host} did not answer within ${Math.round(TIMEOUT_MS / 1000)} s`;
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') return `${host} is unreachable`;
  if (/CERT|SSL|TLS|self.signed|UNABLE_TO_VERIFY/i.test(`${code} ${msg}`)) return `The TLS certificate of ${host} is not trusted (${code || msg})`;
  return msg;
}

function httpError(status, url) {
  const why = status === 404 ? 'not found' : status === 410 ? 'gone' : status === 401 || status === 403 ? 'access denied: the link may have expired or need a login'
    : status === 416 ? 'range not satisfiable' : status === 429 ? 'too many requests' : status >= 500 ? 'server error' : 'unexpected answer';
  const e = new Error(`${redact(url)}: ${why} (HTTP ${status})`);
  e.status = status;
  return e;
}

/**
 * One HTTP request, following up to MAX_REDIRECTS redirects to http/https (never https -> http).
 * Resolves { res, url } with the response stream unread (the caller reads or destroys it).
 * opts: { method, headers, timeoutMs, agentFor(url) (proxy.agentFactory), proxyFor(url) (http targets), signal }.
 */
function open(url, opts = {}, hops = 0) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch { reject(new Error('bad URL')); return; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') { reject(new Error(`redirected to a ${u.protocol} URL: refused`)); return; }
    const mod = u.protocol === 'https:' ? https : http;
    const timeoutMs = opts.timeoutMs || TIMEOUT_MS;
    const headers = { 'User-Agent': 'VideoPreviewEnhanced', Accept: '*/*', 'Accept-Encoding': 'identity', ...(opts.headers || {}) };
    let req;
    const proxied = u.protocol === 'http:' && opts.proxyFor ? opts.proxyFor(url) : null;
    if (proxied) {
      // A plain-http target through an http proxy: the absolute URL as the request path.
      const p = new URL(proxied);
      if (p.username || p.password) headers['Proxy-Authorization'] = `Basic ${Buffer.from(`${decodeURIComponent(p.username)}:${decodeURIComponent(p.password)}`).toString('base64')}`;
      req = http.request({ host: p.hostname, port: Number(p.port) || 80, method: opts.method || 'GET', path: url, headers: { ...headers, Host: u.host } });
    } else {
      const agent = (opts.agentFor && opts.agentFor(url)) || agents[u.protocol];
      req = mod.request(url, { method: opts.method || 'GET', headers, agent });
    }
    let done = false;
    const fail = (e) => { if (!done) { done = true; reject(e); } };
    req.setTimeout(timeoutMs, () => { const e = new Error('timeout'); e.code = 'TIMEOUT'; req.destroy(e); });
    if (opts.signal) {
      if (opts.signal.aborted) { req.destroy(); fail(new Error('aborted')); return; }
      opts.signal.addEventListener('abort', () => { req.destroy(); fail(new Error('aborted')); }, { once: true });
    }
    req.on('error', (e) => fail(new Error(describeError(e, url))));
    req.on('response', (res) => {
      if (done) { res.destroy(); return; }
      const st = res.statusCode;
      if (st >= 300 && st < 400 && st !== 304 && res.headers.location) {
        res.resume();
        done = true;
        if (hops >= MAX_REDIRECTS) { reject(new Error(`${redact(url)}: too many redirects`)); return; }
        let next;
        try { next = new URL(res.headers.location, url).href; } catch { reject(new Error('bad redirect')); return; }
        if (u.protocol === 'https:' && next.startsWith('http:')) { reject(new Error(`${redact(url)} redirected from https to http: refused`)); return; }
        open(next, opts, hops + 1).then(resolve, reject);
        return;
      }
      // Idle body: the same timeout between chunks.
      res.setTimeout(timeoutMs, () => { const e = new Error('timeout'); e.code = 'TIMEOUT'; res.destroy(e); });
      done = true;
      resolve({ res, url });
    });
    req.end();
  });
}

/** Reads a whole response body (at most max bytes). */
function readBody(res, max, url) {
  return new Promise((resolve, reject) => {
    const parts = [];
    let n = 0;
    res.on('data', (d) => {
      n += d.length;
      if (n > max) { res.destroy(); reject(new Error(`${redact(url)}: more than ${max} bytes`)); return; }
      parts.push(d);
    });
    res.on('end', () => resolve(Buffer.concat(parts, n)));
    res.on('error', (e) => reject(new Error(describeError(e, url))));
    res.on('close', () => { if (!res.complete) reject(new Error(`${redact(url)}: the connection closed early`)); else resolve(Buffer.concat(parts, n)); });
  });
}

/** GET with an optional byte range [start, end] (inclusive); resolves { status, headers, body, url }. */
async function fetchRange(url, start, end, opts = {}) {
  const headers = start === undefined ? {} : { Range: `bytes=${start}-${end === undefined ? '' : end}` };
  const { res, url: final } = await open(url, { ...opts, headers });
  const st = res.statusCode;
  if (st !== 200 && st !== 206) { res.resume(); throw httpError(st, final); }
  const max = end !== undefined && st === 206 ? end - start + 1 : (opts.maxBody || MAX_PLAYLIST);
  const body = await readBody(res, max, final);
  return { status: st, headers: res.headers, body, url: final };
}

/** Total size from "Content-Range: bytes a-b/total" (NaN when unknown). */
function totalOf(headers) {
  const m = /\/(\d+)\s*$/.exec(String(headers['content-range'] || ''));
  return m ? Number(m[1]) : NaN;
}

/** What the URL holds: 'hls', 'dash', 'html' (a web page) or 'media'. head: the first bytes. */
function kindOf(url, contentType, head) {
  const ct = String(contentType || '').toLowerCase();
  const text = head ? head.toString('latin1', 0, Math.min(head.length, 2048)).replace(/^﻿|^\xef\xbb\xbf/, '').trimStart() : '';
  if (text.startsWith('#EXTM3U') || /mpegurl/.test(ct)) return 'hls';
  if (/dash\+xml/.test(ct) || (/^<(\?xml|MPD)/i.test(text) && /<MPD[\s>]/.test(text))) return 'dash';
  if (/^<(!doctype html|html|head|body)/i.test(text) || /^text\/html/.test(ct)) return 'html';
  let p = '';
  try { p = new URL(url).pathname.toLowerCase(); } catch { /* none */ }
  if (/\.m3u8?$/.test(p) && /^(#|$)/.test(text)) return 'hls';
  if (/\.mpd$/.test(p) && text.startsWith('<')) return 'dash';
  return 'media';
}

/**
 * Looks at the URL once: { kind, url (after redirects), size, rangeOk, head, contentType, playlist? }.
 * For a playlist the whole text is read (and live / encryption detected by the callers).
 */
async function inspect(url, opts = {}) {
  const { res, url: final } = await open(url, { ...opts, headers: { Range: `bytes=0-${HEAD_BYTES - 1}` } });
  const st = res.statusCode;
  if (st !== 200 && st !== 206) { res.resume(); throw httpError(st, final); }
  const ct = res.headers['content-type'] || '';
  const len = Number(res.headers['content-length']);
  // Everything that arrives is collected; the first chunk tells playlists from media.
  const parts = [];
  let n = 0;
  let wake = null;
  let ended = false;
  let failed = null;
  res.on('data', (d) => { parts.push(d); n += d.length; if (n > MAX_PLAYLIST) { failed = new Error(`${redact(final)}: more than ${MAX_PLAYLIST} bytes`); res.destroy(); } if (wake) wake(); });
  res.on('end', () => { ended = true; if (wake) wake(); });
  res.on('error', (e) => { failed = failed || new Error(describeError(e, final)); if (wake) wake(); });
  res.on('close', () => { if (!ended && !failed) failed = new Error(`${redact(final)}: the connection closed early`); if (wake) wake(); });
  const until = async (ok) => { while (!ok() && !ended && !failed) await new Promise((r) => { wake = r; }); wake = null; };
  await until(() => n > 0);
  if (!n && failed) throw failed;
  const peekKind = kindOf(final, ct, Buffer.concat(parts, n));
  if (peekKind === 'hls' || peekKind === 'dash' || peekKind === 'html') {
    let body;
    if (st === 206 && !(totalOf(res.headers) <= HEAD_BYTES)) {
      res.destroy();
      body = (await fetchRange(final, undefined, undefined, opts)).body; // the whole playlist
    } else {
      await until(() => false);
      if (failed) throw failed;
      body = Buffer.concat(parts, n);
    }
    return { kind: peekKind, url: final, contentType: ct, text: body.toString('utf8'), head: body.subarray(0, HEAD_BYTES) };
  }
  if (st === 206) {
    await until(() => false);
    if (failed) throw failed;
    const head = Buffer.concat(parts, n);
    const size = totalOf(res.headers);
    return { kind: 'media', url: final, contentType: ct, size, rangeOk: Number.isFinite(size), head };
  }
  // 200: no range support. HttpFile downloads it again as a whole (small files) or refuses.
  res.destroy();
  return { kind: 'media', url: final, contentType: ct, size: Number.isFinite(len) && len >= 0 ? len : NaN, rangeOk: false, head: Buffer.alloc(0) };
}

/** A direct media file over HTTP, read in blocks. info: inspect()'s result. */
class HttpFile {
  constructor(info, opts = {}) {
    this.url = info.url;
    // Closing aborts every request this file has in flight (reads, the whole-file download).
    this.abort = new AbortController();
    this.opts = { ...opts, signal: this.abort.signal };
    this.size = info.size;
    this.rangeOk = info.rangeOk;
    this.head = info.head;
    this.whole = null;
    if (!info.rangeOk) {
      if (!(this.size > 0)) throw new Error('The server sends no file size and no range support: this URL needs native ffmpeg');
      if (this.size > MAX_WHOLE) throw new Error(`The server does not support range requests (needed for files over ${MAX_WHOLE >> 20} MB): set up ffmpeg to play it`);
    }
  }

  /** No range support: download the whole file in the background (reads wait for their bytes). */
  startWhole() {
    if (this.whole) return this.whole;
    const w = { buf: Buffer.alloc(this.size), got: 0, waits: [], error: this.closed ? closedError() : null };
    this.whole = w;
    const wake = () => { const ws = w.waits; w.waits = []; for (const f of ws) f(); };
    if (w.error) return w;
    open(this.url, this.opts).then(({ res }) => {
      if (res.statusCode !== 200) { res.resume(); throw httpError(res.statusCode, this.url); }
      res.on('data', (d) => { const n = Math.min(d.length, this.size - w.got); d.copy(w.buf, w.got, 0, n); w.got += n; wake(); });
      res.on('end', () => { if (w.got < this.size) w.error = new Error('the download ended early'); wake(); });
      res.on('error', (e) => { w.error = w.error || new Error(describeError(e, this.url)); wake(); });
      res.on('close', () => { if (!w.error && w.got < this.size) w.error = new Error('the download ended early'); wake(); });
      this.wholeRes = res;
      if (this.closed) res.destroy();
    }).catch((e) => { w.error = w.error || e; wake(); });
    return w;
  }

  async read(pos, len) {
    if (this.closed) throw closedError();
    if (pos >= this.size || len <= 0) return Buffer.alloc(0);
    const end = Math.min(this.size, pos + len);
    if (end <= this.head.length) return this.head.subarray(pos, end);
    if (!this.rangeOk) {
      const w = this.startWhole();
      while (w.got < end && !w.error) await new Promise((r) => w.waits.push(r));
      if (w.got < end) throw w.error;
      return w.buf.subarray(pos, end);
    }
    let last;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        if (this.closed) throw closedError();
        const r = await fetchRange(this.url, pos, end - 1, this.opts);
        if (r.status !== 206) throw new Error('the server stopped answering range requests');
        return r.body;
      } catch (e) { last = e; if (this.closed || (e.status && e.status < 500)) break; }
    }
    throw last;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.abort.abort();
    if (this.wholeRes) this.wholeRes.destroy();
    const w = this.whole;
    if (w) {
      // Readers waiting for bytes that will never come must settle now.
      if (!w.error && w.got < this.size) w.error = closedError();
      const ws = w.waits;
      w.waits = [];
      for (const f of ws) f();
    }
  }
}

function closedError() { const e = new Error('the file was closed'); e.code = 'CLOSED'; return e; }

// ---- HLS -----------------------------------------------------------------

function attrs(s) {
  const out = {};
  for (const m of String(s).matchAll(/([A-Z0-9-]+)=("[^"]*"|[^,]*)/g)) out[m[1]] = m[2].replace(/^"|"$/g, '');
  return out;
}

function byteRange(s, prevEnd) {
  const m = /^(\d+)(?:@(\d+))?$/.exec(String(s).trim());
  if (!m) return null;
  return { len: Number(m[1]), start: m[2] !== undefined ? Number(m[2]) : prevEnd };
}

/** "1920x1080" -> [1920, 1080] (zeros when missing). */
function resolution(s) {
  const m = /^(\d+)x(\d+)$/.exec(String(s || '').trim());
  return m ? [Number(m[1]), Number(m[2])] : [0, 0];
}

/**
 * An EXT-X-KEY / EXT-X-SESSION-KEY: { method, uri, iv, format } (null for METHOD=NONE). The URI is
 * resolved but not checked here (HlsFile.key only fetches http(s) keys); it is never logged or sent to the page.
 */
function keyOf(a, resolve) {
  const method = String(a.METHOD || 'NONE').toUpperCase();
  if (method === 'NONE') return null;
  let uri = '';
  try { uri = a.URI ? resolve(a.URI) : ''; } catch { uri = ''; }
  return { method, uri, iv: a.IV || null, format: a.KEYFORMAT || 'identity' };
}

/** AES-128 with a plain key file (KEYFORMAT identity): decrypted here. Everything else (SAMPLE-AES, FairPlay, Widevine, PlayReady) is DRM. */
function isPlainAes(k) {
  return !!k && k.method === 'AES-128' && (!k.format || k.format === 'identity');
}

/** What a DRM key is, in words for the message ("SAMPLE-AES", "FairPlay", ...). */
function drmName(k) {
  const f = String(k.format || '').toLowerCase();
  if (/streamingkeydelivery|fairplay/.test(f) || /^skd:/i.test(k.uri)) return 'FairPlay';
  if (/edef8ba9-79d6-4ace-a3c8-27dcd51d21ed|widevine/.test(f)) return 'Widevine';
  if (/9a04f079-9840-4286-ab92-e65be0885f95|playready/.test(f)) return 'PlayReady';
  return k.method;
}

/**
 * Parses an M3U8 playlist. base: its URL (relative URIs resolve against it).
 * Master: { master: true, variants: [{ url, bandwidth, avgBandwidth, width, height, codecs, frameRate, audio, subtitles }],
 *   media: [{ type, group, name, lang, default, autoselect, forced, url, channels, characteristics }] (EXT-X-MEDIA),
 *   iframes: [{ url, bandwidth, width, height, codecs }] (EXT-X-I-FRAME-STREAM-INF), sessionKeys: [key] }.
 * Media: { master: false, segments: [{ url, duration, range, key, seq }], map, endList, encrypted, drm, live, mediaSequence }.
 *   key: the EXT-X-KEY in effect ({ method, uri, iv, format } or null); seq: the media sequence number (the IV when the key has none).
 */
function parseM3u8(text, base) {
  const lines = String(text).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length || !lines[0].replace(/^﻿/, '').startsWith('#EXTM3U')) throw new Error('not an HLS playlist (#EXTM3U missing)');
  const resolve = (u) => new URL(u, base).href;
  const variants = [];
  const media = [];
  const iframes = [];
  const sessionKeys = [];
  const segments = [];
  let pendingVariant = null;
  let dur = 0;
  let range = null;
  let map = null;
  let key = null;
  let endList = false;
  let vod = false;
  let mediaSequence = 0;
  const keys = [];
  const lastEnd = new Map(); // resource URL -> end of its last byte range
  for (const l of lines) {
    if (l.startsWith('#EXT-X-STREAM-INF:')) { pendingVariant = attrs(l.slice(18)); continue; }
    if (l.startsWith('#EXT-X-I-FRAME-STREAM-INF:')) {
      const a = attrs(l.slice(26));
      const [w, h] = resolution(a.RESOLUTION);
      if (a.URI) iframes.push({ url: resolve(a.URI), bandwidth: Number(a.BANDWIDTH) || 0, width: w, height: h, codecs: a.CODECS || '' });
      continue;
    }
    if (l.startsWith('#EXT-X-MEDIA:')) {
      const a = attrs(l.slice(13));
      media.push({
        type: String(a.TYPE || '').toUpperCase(), group: a['GROUP-ID'] || '', name: a.NAME || '', lang: a.LANGUAGE || '',
        default: a.DEFAULT === 'YES', autoselect: a.AUTOSELECT === 'YES', forced: a.FORCED === 'YES',
        url: a.URI ? resolve(a.URI) : null, channels: a.CHANNELS || '', characteristics: a.CHARACTERISTICS || '',
      });
      continue;
    }
    if (l.startsWith('#EXT-X-SESSION-KEY:')) { const k = keyOf(attrs(l.slice(19)), resolve); if (k) sessionKeys.push(k); continue; }
    if (l.startsWith('#EXT-X-MEDIA-SEQUENCE:')) { mediaSequence = parseInt(l.slice(22), 10) || 0; continue; }
    if (l.startsWith('#EXTINF:')) { dur = parseFloat(l.slice(8)) || 0; continue; }
    if (l.startsWith('#EXT-X-BYTERANGE:')) { range = l.slice(17); continue; }
    if (l.startsWith('#EXT-X-KEY:')) { key = keyOf(attrs(l.slice(11)), resolve); if (key) keys.push(key); continue; }
    if (l.startsWith('#EXT-X-MAP:')) {
      const a = attrs(l.slice(11));
      if (a.URI) {
        const url = resolve(a.URI);
        map = { url, range: a.BYTERANGE ? byteRange(a.BYTERANGE, 0) : null, key };
      }
      continue;
    }
    if (l === '#EXT-X-ENDLIST') { endList = true; continue; }
    if (/^#EXT-X-PLAYLIST-TYPE:\s*VOD/.test(l)) { vod = true; continue; }
    if (l.startsWith('#')) continue;
    const url = resolve(l);
    if (pendingVariant) {
      const a = pendingVariant;
      const [w, h] = resolution(a.RESOLUTION);
      variants.push({
        url, bandwidth: Number(a.BANDWIDTH) || 0, avgBandwidth: Number(a['AVERAGE-BANDWIDTH']) || 0, width: w, height: h,
        codecs: a.CODECS || '', frameRate: Number(a['FRAME-RATE']) || 0, audio: a.AUDIO || '', subtitles: a.SUBTITLES || '',
      });
      pendingVariant = null;
      continue;
    }
    let r = null;
    if (range !== null) {
      r = byteRange(range, lastEnd.get(url) || 0);
      if (r) lastEnd.set(url, r.start + r.len);
    }
    segments.push({ url, duration: dur, range: r, key, seq: mediaSequence + segments.length });
    dur = 0;
    range = null;
  }
  if (variants.length) return { master: true, variants, media, iframes, sessionKeys, drm: drmOf(sessionKeys) };
  const used = [...keys, ...(map && map.key ? [map.key] : [])];
  return { master: false, segments, map, encrypted: used.length > 0, drm: drmOf(used), endList, live: !endList && !vod, mediaSequence };
}

/** '' when every key is plain AES-128 (or there are none), else the DRM's name. */
function drmOf(keys) {
  const k = keys.find((x) => !isPlainAes(x));
  return k ? drmName(k) : '';
}

/** Protected (DRM) content: no decoder in VS Code can play it. why: shown to the user. */
class Protected extends Error {
  constructor(name) {
    super(`This stream is protected (${name})`);
    this.why = `This stream is protected (${name})`;
    this.protected = true;
  }
}

/**
 * The variant to play.
 *   maxHeight: the decoder's cap (built-in decoder 1080; unknown heights count as fitting); when none fits, the smallest.
 *   throughput (b/s, measured): only variants whose BANDWIDTH is at most 80 % of it (else the lowest one).
 *   view ({ w, h } device pixels, the player's picture area): the smallest picture that covers the picture as shown
 *     (as native frames are sized to the picture); none covers it: the largest. Without a view: the highest bandwidth.
 */
function chooseVariant(variants, { maxHeight = 1080, throughput = 0, view = null } = {}) {
  if (!variants.length) return null;
  const byBw = (a, b) => (a.bandwidth || 0) - (b.bandwidth || 0);
  const fits = variants.filter((v) => !v.height || v.height <= maxHeight);
  let pool = fits.length ? fits : [[...variants].sort((a, b) => a.height - b.height || byBw(a, b))[0]];
  if (throughput > 0) {
    const fast = pool.filter((v) => !v.bandwidth || v.bandwidth <= 0.8 * throughput);
    pool = fast.length ? fast : [[...pool].sort(byBw)[0]];
  }
  const best = (list) => list.reduce((b, v) => (!b || (v.height || 0) > (b.height || 0) || ((v.height || 0) === (b.height || 0) && v.bandwidth > b.bandwidth) ? v : b), null);
  if (view && view.w > 0 && view.h > 0) {
    const shown = (v) => (v.width && v.height ? Math.min(view.h, (view.w * v.height) / v.width) : view.h);
    const covers = pool.filter((v) => v.height && v.height >= shown(v) * 0.95);
    if (covers.length) {
      const h = Math.min(...covers.map((v) => v.height));
      return covers.filter((v) => v.height === h).reduce((b, v) => (!b || v.bandwidth > b.bandwidth ? v : b), null);
    }
    return best(pool);
  }
  return pool.reduce((b, v) => (!b || v.bandwidth > b.bandwidth ? v : b), null);
}

/** The variant the built-in decoder plays without a view or throughput: the best one up to maxHeight, else the smallest. */
function pickVariant(variants, maxHeight = 1080) {
  return chooseVariant(variants, { maxHeight });
}

// Measured download rates per server (host:port), for "Auto": { bps, at }. Kept for 10 minutes.
const RATES = new Map();
const RATE_TTL_MS = 10 * 60 * 1000;
const MEASURE_BYTES = 1024 * 1024;
const MEASURE_MIN = 128 * 1024; // less says more about latency than about the rate

function hostOf(url) { try { return new URL(url).host; } catch { return ''; } }

/** A download of bytes in ms: remembered for the server (a running mean). */
function noteRate(url, bytes, ms) {
  if (!(bytes >= MEASURE_MIN) || !(ms > 0)) return 0;
  const bps = (bytes * 8 * 1000) / ms;
  const old = rateFor(url);
  RATES.set(hostOf(url), { bps: old ? (old + bps) / 2 : bps, at: Date.now() });
  return bps;
}

/** The server's measured rate in b/s, or 0 when not measured lately. */
function rateFor(url) {
  const r = RATES.get(hostOf(url));
  return r && Date.now() - r.at < RATE_TTL_MS ? r.bps : 0;
}

/** Times the download of the playlist's first segment (up to 1 MB): its rate in b/s, 0 when too small to tell. */
async function measureRate(pl, opts) {
  const s = pl.segments[0];
  if (!s) return 0;
  const start = s.range ? s.range.start : 0;
  const len = s.range ? Math.min(s.range.len, MEASURE_BYTES) : MEASURE_BYTES;
  const t0 = Date.now();
  const r = await fetchRange(s.url, start, start + len - 1, { ...opts, maxBody: 64 * 1024 * 1024 });
  return noteRate(s.url, Math.min(r.body.length, len), Math.max(1, Date.now() - t0));
}

/**
 * Reads an HLS stream's playlists and picks what to play. info: inspect()'s result for the URL.
 * pick: 'auto' or a variant index (the quality menu); view, maxHeight: see chooseVariant. For "Auto" with
 * several variants and no recent rate for the server, the first segment of the variant chosen by the picture
 * size is timed and a slower variant taken when needed (one choice at the start, no switching while playing).
 * Resolves { url, master (parsed or null), variants, index, variant, auto, throughput, playlist (the media
 * playlist parsed), playlistUrl, live, drm }.
 */
async function hlsOpen(info, opts = {}, { pick = 'auto', view = null, maxHeight = 1080 } = {}) {
  const top = parseM3u8(info.text, info.url);
  const plan = { url: info.url, master: null, variants: [], index: -1, variant: null, auto: true, throughput: 0, playlist: top, playlistUrl: info.url };
  if (top.master) {
    plan.master = top;
    plan.variants = top.variants;
    const fetchPl = async (v) => {
      const r = await fetchRange(v.url, undefined, undefined, opts);
      const p = parseM3u8(r.body.toString('utf8'), r.url);
      if (p.master) throw new Error('nested HLS master playlists are not supported');
      return { p, url: r.url };
    };
    let i;
    if (Number.isInteger(pick) && pick >= 0 && pick < top.variants.length) { i = pick; plan.auto = false; }
    else i = top.variants.indexOf(chooseVariant(top.variants, { maxHeight, view, throughput: rateFor(info.url) }));
    let got = await fetchPl(top.variants[i]);
    plan.throughput = rateFor(info.url);
    if (plan.auto && top.variants.length > 1 && !plan.throughput && !got.p.live && !got.p.drm) {
      try { plan.throughput = await measureRate(got.p, opts); } catch { plan.throughput = 0; }
      if (plan.throughput) {
        const j = top.variants.indexOf(chooseVariant(top.variants, { maxHeight, view, throughput: plan.throughput }));
        if (j !== i) { i = j; got = await fetchPl(top.variants[i]); }
      }
    }
    plan.index = i;
    plan.variant = top.variants[i];
    plan.playlist = got.p;
    plan.playlistUrl = got.url;
  }
  plan.live = !!plan.playlist.live;
  plan.drm = (plan.master && plan.master.drm) || plan.playlist.drm || '';
  return plan;
}

/** Runs fn over items, at most n at a time. */
async function pool(items, n, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; await fn(items[k], k); }
  });
  await Promise.all(workers);
}

/** The size of a whole resource: HEAD, else a 1-byte range request. */
async function sizeOf(url, opts) {
  try {
    const { res } = await open(url, { ...opts, method: 'HEAD' });
    res.resume();
    const n = Number(res.headers['content-length']);
    if (res.statusCode === 200 && n >= 0 && Number.isFinite(n)) return n;
    if (res.statusCode >= 400 && res.statusCode !== 405 && res.statusCode !== 501) throw httpError(res.statusCode, url);
  } catch (e) { if (e.status) throw e; }
  const r = await fetchRange(url, 0, 0, opts);
  const total = r.status === 206 ? totalOf(r.headers) : r.body.length;
  if (!Number.isFinite(total)) throw new Error(`${redact(url)}: unknown size`);
  return total;
}

/** The last n bytes of a resource and its size (Range: bytes=-n; a server without ranges sends it all). */
async function tailOf(url, n, opts) {
  const { res, url: final } = await open(url, { ...opts, headers: { Range: `bytes=-${n}` } });
  const st = res.statusCode;
  if (st !== 200 && st !== 206) { res.resume(); throw httpError(st, final); }
  const body = await readBody(res, st === 206 ? n : 512 * 1024 * 1024, final);
  const size = st === 206 ? totalOf(res.headers) : body.length;
  if (!Number.isFinite(size)) throw new Error(`${redact(final)}: unknown size`);
  return { size, tail: body.subarray(Math.max(0, body.length - n)) };
}

/** The 16-byte IV of an AES-128 segment: the key's IV attribute, else the media sequence number (big-endian). */
function ivOf(key, seq) {
  const iv = Buffer.alloc(16);
  if (key.iv) {
    const hex = String(key.iv).replace(/^0x/i, '');
    if (!/^[0-9a-f]{1,32}$/i.test(hex)) throw new Error('the HLS key has a malformed IV');
    Buffer.from(hex.padStart(32, '0'), 'hex').copy(iv);
    return iv;
  }
  const n = BigInt(seq >= 0 ? seq : 0);
  iv.writeBigUInt64BE(n >> 64n, 0);
  iv.writeBigUInt64BE(n & 0xffffffffffffffffn, 8);
  return iv;
}

/** AES-128-CBC without padding removal. */
function cbc(key, iv, data) {
  const d = crypto.createDecipheriv('aes-128-cbc', key, iv);
  d.setAutoPadding(false);
  return Buffer.concat([d.update(data), d.final()]);
}

/**
 * An HLS VOD playlist as one file: [init segment] + segments. plan: hlsOpen()'s result (or inspect()'s
 * result for the URL, opened with the defaults). Throws NeedsFfmpeg for live playlists and Protected for DRM.
 * AES-128 segments (EXT-X-KEY METHOD=AES-128, KEYFORMAT identity) are decrypted here: the key is fetched once
 * per key URI (http/https only, the same request rules as the URL) and kept in this object; it is never logged
 * nor sent to the page, which sees only the decrypted bytes. Each segment's plain size comes from its last two
 * cipher blocks (the PKCS#7 padding), so reads stay random access (one range read per piece, from the block before it).
 */
class HlsFile {
  constructor(plan, opts = {}) {
    this.plan = plan && plan.playlist ? plan : null;
    this.info = plan && plan.playlist ? null : plan;
    this.abort = new AbortController(); // close() cancels the requests still running
    this.opts = { ...opts, signal: this.abort.signal };
    this.parts = [];
    this.size = 0;
    this.keys = new Map(); // key URI -> Promise<Buffer> (never logged)
  }

  async open(onProgress) {
    if (!this.plan) this.plan = await hlsOpen(this.info, this.opts, { maxHeight: this.opts.maxHeight || 1080 });
    const plan = this.plan;
    const pl = plan.playlist;
    this.playlistUrl = plan.playlistUrl;
    this.variant = plan.variant;
    if (plan.drm) throw new Protected(plan.drm);
    if (pl.live) throw new NeedsFfmpeg('A live HLS stream');
    if (!pl.segments.length) throw new Error('the HLS playlist lists no segments');
    this.duration = pl.segments.reduce((n, s) => n + s.duration, 0);
    this.fmp4 = !!pl.map;
    this.encrypted = pl.encrypted;
    const part = (url, range, key, seq) => ({ url, start: range ? range.start : 0, len: range ? range.len : null, key: key || null, seq });
    const parts = [];
    if (pl.map) parts.push(part(pl.map.url, pl.map.range, pl.map.key, pl.segments[0].seq));
    for (const s of pl.segments) parts.push(part(s.url, s.range, s.key, s.seq));
    for (const p of parts) if (p.key) { this.key(p.key); p.iv = p.key.iv ? ivOf(p.key, 0) : ivOf(p.key, p.seq); }
    const unknown = parts.filter((p) => p.len === null || p.key);
    let done = 0;
    await pool(unknown, SIZE_CONCURRENCY, async (p) => {
      if (p.key) await this.plainSize(p);
      else p.len = await sizeOf(p.url, this.opts);
      done++;
      if (onProgress && (done % 10 === 0 || done === unknown.length)) onProgress(done, unknown.length);
    });
    let off = 0;
    for (const p of parts) { p.offset = off; off += p.key ? p.plain : p.len; }
    this.parts = parts;
    this.size = off;
    this.segments = pl.segments.length;
    return this;
  }

  /** The AES-128 key for a key tag (fetched once per URI). */
  key(k) {
    if (!this.keys.has(k.uri)) {
      const p = (async () => {
        if (!/^https?:\/\//i.test(k.uri)) throw new Error('the HLS key is not an http(s) URL: refused');
        const r = await fetchRange(k.uri, undefined, undefined, { ...this.opts, maxBody: 64 });
        if (r.body.length !== 16) throw new Error(`the HLS key is ${r.body.length} bytes, not 16`);
        return Buffer.from(r.body);
      })();
      p.catch(() => {});
      this.keys.set(k.uri, p);
    }
    return this.keys.get(k.uri);
  }

  /** An encrypted part's cipher length (p.len) and plain length (p.plain), from its last two blocks. */
  async plainSize(p) {
    let tail;
    if (p.len !== null) {
      const n = Math.min(32, p.len);
      const r = await fetchRange(p.url, p.start + p.len - n, p.start + p.len - 1, this.opts);
      tail = r.status === 200 ? r.body.subarray(p.start + p.len - n, p.start + p.len) : r.body;
    } else {
      const r = await tailOf(p.url, 32, this.opts);
      p.len = r.size;
      tail = r.tail;
    }
    if (!p.len || p.len % 16 || tail.length < 16) throw new Error(`${redact(p.url)}: not an AES-128 encrypted segment (${p.len} bytes)`);
    const key = await this.key(p.key);
    const iv = p.len > 16 ? tail.subarray(tail.length - 32, tail.length - 16) : p.iv;
    const last = cbc(key, iv, tail.subarray(tail.length - 16));
    const pad = last[15];
    if (pad < 1 || pad > 16) throw new Error(`${redact(p.url)}: could not be decrypted (wrong key?)`);
    p.plain = p.len - pad;
  }

  /** The part holding byte pos (binary search). */
  partAt(pos) {
    let lo = 0;
    let hi = this.parts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.parts[mid].offset <= pos) lo = mid; else hi = mid - 1;
    }
    return lo;
  }

  async read(pos, len) {
    if (pos >= this.size || len <= 0) return Buffer.alloc(0);
    const end = Math.min(this.size, pos + len);
    const pieces = [];
    for (let i = this.partAt(pos); i < this.parts.length && this.parts[i].offset < end; i++) {
      const p = this.parts[i];
      const size = p.key ? p.plain : p.len;
      const a = Math.max(pos, p.offset) - p.offset;
      const b = Math.min(end, p.offset + size) - p.offset; // exclusive
      if (b > a) pieces.push(p.key ? this.readCipher(p, a, b) : this.readPart(p, a, b));
    }
    return Buffer.concat(await Promise.all(pieces));
  }

  /** Bytes [a, b) of a part's resource (relative to the part), retried once. */
  async readPart(p, a, b) {
    let last;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const r = await fetchRange(p.url, p.start + a, p.start + b - 1, this.opts);
        // A server without ranges sends the whole segment: cut out the piece.
        if (r.status === 200) return r.body.subarray(p.start + a, p.start + b);
        return r.body;
      } catch (e) { last = e; if (e.status && e.status < 500) break; }
    }
    throw last;
  }

  /** Plain bytes [a, b) of an AES-128 part: the cipher blocks that hold them, plus the block before as the IV. */
  async readCipher(p, a, b) {
    const ba = Math.floor(a / 16) * 16;
    const bb = Math.min(p.len, Math.ceil(b / 16) * 16);
    const from = ba >= 16 ? ba - 16 : 0;
    const [raw, key] = await Promise.all([this.readPart(p, from, bb), this.key(p.key)]);
    const iv = ba >= 16 ? raw.subarray(0, 16) : p.iv;
    const plain = cbc(key, iv, ba >= 16 ? raw.subarray(16) : raw);
    return plain.subarray(a - ba, b - ba);
  }

  close() { this.closed = true; this.keys.clear(); this.abort.abort(); }
}

/** True when an HLS playlist (or, for a master playlist, its first variant) is live: no #EXT-X-ENDLIST, not VOD. */
async function hlsLive(info, opts = {}) {
  return (await hlsOpen(info, opts, { maxHeight: opts.maxHeight || 1080 })).live;
}

// ---- HLS subtitles (WebVTT renditions) ------------------------------------

const MAX_SUBS_BYTES = 20 * 1024 * 1024; // as subtitle files (src/sidecars.js)
const MAX_SUB_RENDITIONS = 16;

/**
 * Where a stream's timeline starts (s): the first PTS in an MPEG-TS start (the smallest of the first PES
 * headers), or an fMP4 start's first tfdt over the init segment's timescale. null when not found.
 */
function streamStart(buf) {
  if (!buf || buf.length < 188) return null;
  if (buf[0] === 0x47) {
    let min = null;
    let found = 0;
    for (let i = 0; i + 188 <= buf.length && found < 16; i += 188) {
      if (buf[i] !== 0x47 || !(buf[i + 1] & 0x40)) continue;
      const afc = (buf[i + 3] >> 4) & 3;
      let p = i + 4;
      if (afc === 2) continue;
      if (afc === 3) p += 1 + buf[i + 4];
      if (p + 14 > i + 188 || buf[p] !== 0 || buf[p + 1] !== 0 || buf[p + 2] !== 1) continue;
      const sid = buf[p + 3];
      if (sid < 0xc0 || sid > 0xef) continue;
      if (!(buf[p + 7] & 0x80)) continue;
      const b = buf.subarray(p + 9, p + 14);
      const pts = (b[0] >> 1 & 7) * 2 ** 30 + ((b[1] << 7) | (b[2] >> 1)) * 2 ** 15 + ((b[3] << 7) | (b[4] >> 1));
      const t = pts / 90000;
      min = min === null ? t : Math.min(min, t);
      found++;
    }
    return min;
  }
  const at = (tag) => buf.indexOf(Buffer.from(tag, 'latin1'));
  const mdhd = at('mdhd');
  const tfdt = at('tfdt');
  if (mdhd < 4 || tfdt < 4 || mdhd + 32 > buf.length || tfdt + 16 > buf.length) return null;
  const scale = buf[mdhd + 4] === 1 ? buf.readUInt32BE(mdhd + 24) : buf.readUInt32BE(mdhd + 16);
  const base = buf[tfdt + 4] === 1 ? Number(buf.readBigUInt64BE(tfdt + 8)) : buf.readUInt32BE(tfdt + 8);
  return scale > 0 ? base / scale : null;
}

const VTT_TIME = /(?:(\d+):)?(\d{2}):(\d{2})[.,](\d{3})/;
function vttSeconds(s) {
  const m = VTT_TIME.exec(s);
  return m ? Number(m[1] || 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000 : NaN;
}
function vttStamp(t) {
  const ms = Math.max(0, Math.round(t * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor(ms / 60000) % 60;
  const s = Math.floor(ms / 1000) % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`;
}

/**
 * WebVTT segments as one file, in player time. Each segment's X-TIMESTAMP-MAP (MPEGTS:<90 kHz>,LOCAL:<time>)
 * says where its cue times sit on the stream's timeline: player time = cue + MPEGTS / 90000 - LOCAL - start,
 * with start the stream's first timestamp (streamStart). Without a map, or when start is unknown, cue times are
 * taken as they are (time from the start of the playlist). Cues repeated across segments are kept once.
 */
function joinVtt(texts, start) {
  const out = ['WEBVTT', ''];
  const seen = new Set();
  for (const raw of texts) {
    const text = String(raw).replace(/^﻿/, '').replace(/\r\n?/g, '\n');
    let shift = 0;
    const map = /X-TIMESTAMP-MAP=([^\n]*)/.exec(text.split(/\n\s*\n/)[0] || '');
    if (map && start !== null && start !== undefined) {
      const mp = /MPEGTS:(\d+)/.exec(map[1]);
      const lo = /LOCAL:([0-9:.]+)/.exec(map[1]);
      if (mp) shift = Number(mp[1]) / 90000 - (lo ? vttSeconds(lo[1]) || 0 : 0) - start;
    }
    const blocks = text.split(/\n[ \t]*\n/);
    for (let k = 0; k < blocks.length; k++) {
      const lines = blocks[k].split('\n');
      while (lines.length && !lines[0].trim()) lines.shift();
      if (!lines.length || (k === 0 && /^WEBVTT/.test(lines[0]))) continue;
      if (/^(NOTE|STYLE|REGION)(\s|$)/.test(lines[0])) continue;
      const ti = lines.findIndex((l) => l.includes('-->'));
      if (ti < 0) continue;
      const [a, rest] = lines[ti].split('-->');
      const restParts = rest.trim().split(/\s+/);
      const s = vttSeconds(a) + shift;
      const e = vttSeconds(restParts[0]) + shift;
      if (!(e > s) || e <= 0) continue;
      const body = lines.slice(ti + 1).join('\n');
      const keyStr = `${s.toFixed(3)}|${e.toFixed(3)}|${body}`;
      if (seen.has(keyStr)) continue;
      seen.add(keyStr);
      out.push(`${vttStamp(s)} --> ${vttStamp(e)}${restParts.length > 1 ? ` ${restParts.slice(1).join(' ')}` : ''}`, body, '');
    }
  }
  return out.join('\n');
}

/**
 * The WebVTT subtitle renditions of the played variant (its SUBTITLES group; all of them when it names none),
 * each joined into one WebVTT text. start: streamStart of the variant (or null). Resolves
 * [{ id, name, lang, default, forced, autoselect, text } | { id, name, error }].
 */
async function hlsSubtitles(plan, opts = {}, { start = null } = {}) {
  if (!plan.master) return [];
  const group = plan.variant && plan.variant.subtitles;
  const list = [];
  for (const m of plan.master.media) {
    if (m.type !== 'SUBTITLES' || !m.url || (group && m.group !== group) || list.some((x) => x.url === m.url)) continue;
    list.push(m);
  }
  const out = [];
  for (const m of list.slice(0, MAX_SUB_RENDITIONS)) {
    const id = `hls:${m.group}:${m.lang}:${m.name}`;
    const name = m.name || m.lang || 'Subtitles';
    try {
      const r = await fetchRange(m.url, undefined, undefined, opts);
      const pl = parseM3u8(r.body.toString('utf8'), r.url);
      if (pl.master) throw new Error('a master playlist as a subtitle rendition');
      if (pl.encrypted) throw new Error('encrypted subtitles are not supported');
      const texts = new Array(pl.segments.length);
      let bytes = 0;
      await pool(pl.segments, SIZE_CONCURRENCY, async (s, i) => {
        const b = s.range ? await fetchRange(s.url, s.range.start, s.range.start + s.range.len - 1, opts) : await fetchRange(s.url, undefined, undefined, opts);
        const body = s.range && b.status === 200 ? b.body.subarray(s.range.start, s.range.start + s.range.len) : b.body;
        bytes += body.length;
        if (bytes > MAX_SUBS_BYTES) throw new Error('more than 20 MB of subtitles');
        texts[i] = body.toString('utf8');
      });
      out.push({ id, name, lang: m.lang, default: m.default, autoselect: m.autoselect, forced: m.forced, text: joinVtt(texts, start) });
    } catch (e) { out.push({ id, name, error: e.message }); }
  }
  return out;
}

/** True for a DASH manifest of type "dynamic" (live). */
function dashLive(text) {
  return /<MPD[^>]*\btype\s*=\s*["']dynamic["']/i.test(String(text));
}

module.exports = {
  checkUrl, redact, displayName, recentUrls, rememberUrl, RECENT_KEY, MAX_RECENT,
  open, fetchRange, inspect, kindOf, describeError, HttpFile, HlsFile, parseM3u8, pickVariant, chooseVariant, hlsOpen, hlsLive, dashLive,
  hlsSubtitles, joinVtt, streamStart, noteRate, rateFor, NeedsFfmpeg, Protected,
  HEAD_BYTES, MAX_WHOLE,
};
