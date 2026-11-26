'use strict';
// Host decoders for the unified viewer's clips that are not a file read in blocks (src/unified-viewer.js
// deps.openSequence and deps.openUrlStream, docs/notes/player-ui-controller.md "Production wiring"):
//
// - an image sequence: the page's frame player (media/frame-player.js) asks for pictures ('frames'), each one goes
//   back as a 'frame' with the file's bytes;
// - a video URL (Open Video URL…, docs/notes/url-stream.md): native ffmpeg plays streams and anything the decoder rule
//   gives it; otherwise the page's built-in decoder reads blocks over HTTP (urlsource.HttpFile / HlsFile) by clip id.
//   Either way the page is told with a 'libav' message (its player restarts with that decoder) once the URL is known.
//
// Everything from src/extension.js (ffmpeg, the decoder rule, the proxy) is injected, so a Node test drives both.
const fs = require('fs');

// checkJs: start
/** The frame player's largest request: 121 frames ahead (the target included) and 4 behind. */
const MAX_FRAME_REQUEST = 125;
/** One block read over the network at most (as a file's, src/read-block.js). */
const MAX_BLOCK = 8 * 1024 * 1024;

/** @param {any} e */
const errText = (e) => (e && e.message) || String(e);

/**
 * @typedef {{ post(m: any): void, postRaw(m: any): void, log(m: string): void, onFail(err: any): void,
 *   hidden?: boolean, origin?: string | null, transport?: string }} SourceIo
 */

/**
 * What the page needs to know about an image sequence before it starts its frame player: frame count, rate,
 * duration and an estimated size (the average of the first 50 files).
 * @param {{ files: string[], dir: string, name: string }} seq @param {number} fps
 * @param {(f: string) => Promise<{ size: number }>} [stat]
 */
async function sequenceFacts(seq, fps, stat = (f) => fs.promises.stat(f)) {
  const rate = Number(fps) > 0 ? Number(fps) : 30;
  const sample = seq.files.slice(0, 50);
  const sizes = await Promise.all(sample.map((f) => stat(f).then((s) => s.size, () => 0)));
  const size = sample.length ? Math.round((sizes.reduce((a, b) => a + b, 0) / sample.length) * seq.files.length) : 0;
  return { fps: rate, frames: seq.files.length, duration: seq.files.length / rate, size };
}

/**
 * An image sequence's decoder: answers the frame player's 'frames' requests in order, one 'frame' per index (empty
 * when unreadable, or the player keeps it in flight forever).
 * @param {{ source?: any }} c  c.source: { files }
 * @param {SourceIo} io
 * @param {{ readFile?: (f: string) => Promise<Uint8Array> }} [o]
 */
function createSequenceDecoder(c, io, o = {}) {
  const files = c.source && Array.isArray(c.source.files) ? /** @type {string[]} */ (c.source.files) : [];
  const readFile = o.readFile || ((/** @type {string} */ f) => fs.promises.readFile(f));
  let disposed = false;
  let chain = Promise.resolve();
  return {
    /** @param {any} m */
    handle(m) {
      if (disposed || !m || m.type !== 'frames' || !Array.isArray(m.indices) || m.indices.length > MAX_FRAME_REQUEST) return undefined;
      /** @type {number[]} */
      const want = m.indices;
      // Every slot, holes too (every() skips a sparse array's holes).
      for (let k = 0; k < want.length; k++) if (!Number.isSafeInteger(want[k]) || want[k] < 0) return undefined;
      const run = async () => {
        for (const i of want) {
          if (disposed) return;
          let data = new Uint8Array(0);
          const f = files[i];
          if (f) {
            try {
              const b = await readFile(f);
              data = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
            } catch (e) { io.log(`frame ${i}: ${errText(e)}`); }
          }
          if (!disposed) io.postRaw({ type: 'frame', index: i, data });
        }
      };
      chain = chain.then(run, run);
      return chain;
    },
    dispose() { disposed = true; },
  };
}

/**
 * @typedef {object} UrlDeps
 * @property {any} urlsource  src/urlsource.js
 * @property {() => any} netOpts  { agentFor, proxyFor, maxHeight } (src/extension.js netOpts)
 * @property {() => Promise<any>} tools  native ffmpeg, or null (also when it may not run here)
 * @property {(t: any, input: any, signal: AbortSignal) => Promise<any>} probe  ffprobe of the URL
 * @property {(info: any, plan: any) => any} ffInput  what ffmpeg reads (src/ffmpeg.js inputArgs)
 * @property {(o: { t: any, pr: any, stream: boolean, forced?: boolean }) => any} decide  decide.decide() for a URL
 * @property {(o: { t: any, pr: any, d: any, input: any, io: SourceIo, onFail: (err: any) => void }) => any} openNative
 *   a NativeDecoder for the URL, already connected to io
 * @property {() => any} [view]  the last picture size, for HLS "Auto"
 * @property {() => boolean} [builtinOnly]  the decoder setting is 'builtin'
 * @property {() => string} [why]  why ffmpeg is not offered here (Restricted Mode, a remote window ...), or ''
 * @property {(plan: any, opts: any) => Promise<any>} [firstBytes]  an HLS stream's first bytes (its timeline's start)
 * @property {(plan: any) => string} [planText]  the log's words for an HLS plan (variants, renditions; src/framelink.js)
 * @property {string} [libavVariant]  the bundled decoder build's name, for the log
 */

/**
 * A video URL's decoder (see the file comment). The page's first messages (from its native placeholder player) are
 * dropped while the URL is inspected: the 'libav' message that follows restarts the page's player for the decoder
 * chosen, and that one asks again.
 * @param {{ label: string, source?: any }} c  c.source: { url }
 * @param {SourceIo} io
 * @param {UrlDeps} deps
 */
function createUrlDecoder(c, io, deps) {
  const U = deps.urlsource;
  const url = String(c.source && c.source.url || '');
  let disposed = false;
  /** @type {AbortController | null} */
  let abort = null;
  /** @type {any} */
  let inner = null;
  /** @type {any} */
  let net = null;
  /** @type {any} */
  let plan = null;
  /** @type {'auto' | number} */
  let pick = 'auto';
  let noNative = '';
  let live = false;
  let netFailed = false;
  /** @type {{ group: string, list: any[] } | null} */
  let hlsSubs = null;

  /** @param {string} text @param {number} [ms] */
  const toast = (text, ms) => io.postRaw(ms ? { type: 'toast', text, ms } : { type: 'toast', text });
  /** @param {string} text */
  const status = (text) => io.postRaw({ type: 'status', text });
  /** @param {any} e @param {string} [hint] @param {string | null} [action] */
  const fail = (e, hint, action) => {
    io.log(`error: ${errText(e)}`);
    io.postRaw({ type: 'error', message: errText(e), hint: hint || '', ...(action ? { action } : {}) });
  };

  function close() {
    if (abort) abort.abort();
    abort = null;
    if (inner) { inner.dispose(); inner = null; }
    if (net) { net.close(); net = null; }
  }

  /** The HLS quality menu for the page ('stream'): the variants, the pick and what plays. */
  function postStream() {
    if (!plan || !plan.master || plan.variants.length < 2 || live) { io.postRaw({ type: 'stream' }); return; }
    io.postRaw({
      type: 'stream',
      quality: {
        pick: plan.auto ? 'auto' : plan.index, current: plan.index,
        variants: plan.variants.map((/** @type {any} */ v, /** @type {number} */ id) => (
          { id, width: v.width, height: v.height, bandwidth: v.bandwidth, codecs: String(v.codecs || '').slice(0, 80) })),
      },
    });
  }

  /**
   * The HLS stream's WebVTT subtitle renditions, given to the page as loaded subtitle files; kept across quality
   * changes. `file`: the opened HlsFile (its first bytes give the timeline's start).
   * @param {AbortSignal} signal @param {any} file
   */
  async function sendHlsSubs(signal, file) {
    if (!plan || !plan.master || live || !plan.master.media.some((/** @type {any} */ m) => m.type === 'SUBTITLES' && m.url)) return;
    const opts = { ...deps.netOpts(), signal };
    try {
      const group = (plan.variant && plan.variant.subtitles) || '*';
      let subs = hlsSubs && hlsSubs.group === group ? hlsSubs.list : null;
      if (!subs) {
        let start = null;
        try {
          const head = file ? await file.read(0, 256 * 1024) : deps.firstBytes ? await deps.firstBytes(plan, opts) : null;
          if (head) start = U.streamStart(head);
        }
        catch (e) { io.log(`HLS subtitles: no start time (${errText(e)})`); }
        if (signal.aborted) return;
        subs = /** @type {any[]} */ (await U.hlsSubtitles(plan, opts, { start }));
        if (signal.aborted) return;
        hlsSubs = { group, list: subs };
      }
      const files = subs.filter((x) => !x.error).map((x) => ({
        id: x.id, name: `${x.name}.vtt`, title: x.name, lang: x.lang, stream: true, auto: !!x.default,
        flags: x.forced ? ['forced'] : [], data: new TextEncoder().encode(String(x.text)),
      }));
      if (files.length && !signal.aborted) io.postRaw({ type: 'subs', files, tracks: files });
    } catch (e) {
      if (!signal.aborted) io.log(`HLS subtitles: ${errText(e)}`);
    }
  }

  /** @param {any} t @param {any} pr @param {any} d @param {any} info @param {AbortSignal} signal */
  function startNative(t, pr, d, info, signal) {
    if (live) pr.duration = 0;
    inner = deps.openNative({
      t, pr, d, input: deps.ffInput(info, plan), io,
      onFail: (err) => {
        if (disposed || signal.aborted) return;
        // Not remembered (no file): this clip tries the built-in decoder.
        io.log(`native ffmpeg can't play this URL (${errText(err)}); trying the built-in decoder`);
        noNative = errText(err) || 'ffmpeg failed';
        open();
      },
    });
    postStream();
    const host = (() => { try { return new URL(url).host; } catch { return ''; } })();
    io.postRaw({ type: 'libav', meta: { size: 0, duration: 0, label: '', native: true, live: !!live, url: true, host } });
    sendHlsSubs(signal, null);
  }

  async function open() {
    close();
    const ctl = new AbortController();
    abort = ctl;
    const signal = ctl.signal;
    const stale = () => disposed || signal.aborted;
    const opts = { ...deps.netOpts(), signal };
    const red = U.redact(url);
    netFailed = false;
    let host = '';
    try { host = new URL(url).host; } catch { /* checked before */ }
    status(`Connecting to ${host}…`);
    let info;
    try { info = await U.inspect(url, opts); } catch (e) {
      if (!stale()) fail(e, `Could not open ${red}.`);
      return;
    }
    if (stale()) return;
    if (info.kind === 'html') {
      fail(new Error('This URL is a web page, not a video'), 'Use a direct link to a video file (.mp4, .webm, .mkv…) or an HLS (.m3u8) / DASH (.mpd) stream. Video sites such as YouTube are not supported.');
      return;
    }
    const stream = info.kind !== 'media';
    const t = noNative ? null : await deps.tools();
    if (stale()) return;
    try {
      if (info.kind === 'hls') {
        plan = await U.hlsOpen(info, opts, { pick, view: deps.view ? deps.view() : null, maxHeight: t ? 4320 : 1080 });
        live = !!plan.live;
      } else {
        plan = null;
        live = info.kind === 'dash' ? !!U.dashLive(info.text) : false;
      }
    } catch (e) {
      if (!stale()) fail(e, `Could not read the HLS playlist of ${red}.`);
      return;
    }
    if (stale()) return;
    io.log(`url ${red}: ${info.kind}${live ? ' (live)' : ''}${info.kind === 'media' ? `, ${Number.isFinite(info.size) ? `${info.size} bytes` : 'size unknown'}, ranges ${info.rangeOk ? 'yes' : 'no'}` : ''}${plan && deps.planText ? deps.planText(plan) : ''}`);
    if (plan && plan.drm) {
      fail(new U.Protected(plan.drm), 'DRM-protected video (SAMPLE-AES, FairPlay, Widevine, PlayReady) needs a licence and a content decryption module, which VS Code does not have; ffmpeg can\'t play it either. Streams encrypted with plain AES-128 play.');
      return;
    }
    let pr = null;
    let probeError = '';
    if (t) {
      status(`Reading ${stream ? 'the stream' : 'the video'} with ffmpeg…`);
      try { pr = await deps.probe(t, deps.ffInput(info, plan), signal); } catch (e) { probeError = errText(e); io.log(`ffprobe failed: ${probeError}`); }
      if (stale()) return;
      if (pr && !pr.video && !pr.audio) pr = null;
    }
    if (pr) {
      const d = deps.decide({ t, pr, stream });
      io.log(`decoder: ${d.use === 'native' ? `native ffmpeg (${d.method})` : 'built-in'}: ${stream ? `${info.kind} stream` : d.reason}`);
      if (d.use === 'native') { startNative(t, pr, d, info, signal); return; }
    }
    // The built-in decoder, reading over HTTP.
    try {
      if (info.kind === 'dash') throw new U.NeedsFfmpeg(live ? 'A live DASH stream' : 'A DASH stream');
      if (info.kind === 'hls') {
        // Chosen for native ffmpeg (no height cap) but played here: "Auto" again with the built-in decoder's cap.
        if (plan.auto && plan.variant && plan.variant.height > 1080) {
          plan = await U.hlsOpen(info, opts, { pick: 'auto', view: deps.view ? deps.view() : null, maxHeight: 1080 });
          if (stale()) return;
        }
        const hls = new U.HlsFile(plan, opts);
        try {
          await hls.open((/** @type {number} */ n, /** @type {number} */ all) => { if (!stale()) status(`Reading the HLS playlist… ${n} / ${all} segments`); });
          if (stale()) return;
          net = hls;
        } finally {
          if (net !== hls) hls.close();
        }
        const v = hls.variant;
        io.log(`HLS for the built-in decoder: ${hls.segments} ${hls.fmp4 ? 'fMP4' : 'MPEG-TS'} segments${hls.encrypted ? ' (AES-128, decrypted here)' : ''}, ${hls.size} bytes, ${Number(hls.duration || 0).toFixed(1)} s${v ? `, variant ${v.width}x${v.height} ${v.bandwidth} b/s` : ''}`);
      } else {
        net = new U.HttpFile(info, opts);
      }
    } catch (e) {
      if (stale()) return;
      const err = /** @type {any} */ (e);
      if (err.protected) { fail(err, 'DRM-protected video needs a licence and a content decryption module, which VS Code does not have.'); return; }
      // A file the built-in decoder can't read this way (no ranges, too large) still plays with ffmpeg.
      if (pr && t && !err.needsFfmpeg && !(deps.builtinOnly && deps.builtinOnly())) {
        io.log(`the built-in decoder can't read it (${errText(err)}); native ffmpeg instead`);
        startNative(t, pr, deps.decide({ t, pr, stream, forced: true }), info, signal);
        return;
      }
      failUrl(err, t, probeError);
      return;
    }
    if (stale()) return;
    io.log(`decoding with libav.js (${deps.libavVariant || 'vpe'}) over HTTP`);
    postStream();
    io.postRaw({ type: 'libav', meta: { size: net.size, duration: net.duration || 0, label: '', url: true, native: false, host: (() => { try { return new URL(url).host; } catch { return ''; } })() } });
    sendHlsSubs(signal, U.HlsFile && net instanceof U.HlsFile ? net : null);
  }

  /** The built-in decoder can't play this URL: say why, and offer ffmpeg where it would run. @param {any} e @param {any} t @param {string} probeError */
  function failUrl(e, t, probeError) {
    if (!e.needsFfmpeg) { fail(e); return; }
    let hint = '';
    let action = null;
    const why = deps.why ? deps.why() : '';
    // ffprobe's and native ffmpeg's own words may quote the URL (its path, a token in its query): they are in the
    // host log already (open, startNative); the page gets a fixed sentence.
    if (probeError) {
      hint = 'ffmpeg could not open it either. Details are in the Video Preview Enhanced output.';
    } else if (noNative) {
      hint = 'Native ffmpeg failed on it. Details are in the Video Preview Enhanced output.';
    } else if (why) hint = why;
    else if (!t) {
      hint = 'The built-in decoder plays direct video links (MP4, WebM, MKV…) and HLS VOD playlists (also AES-128 encrypted). Live HLS and DASH play with ffmpeg (one click, no admin rights).';
      action = 'setupFfmpeg';
    }
    io.log(errText(e));
    io.postRaw({ type: 'error', message: `${e.why} needs native ffmpeg`, hint, ...(action ? { action } : {}) });
  }

  open().catch((e) => { if (!disposed) fail(e); });

  return {
    /** @param {any} m */
    handle(m) { return inner ? inner.handle(m) : undefined; },
    /**
     * A block of the URL for the page's built-in decoder; null while none is open. An empty answer is a read error.
     * @param {number} pos @param {number} len @returns {Promise<Uint8Array | null>}
     */
    async readBlock(pos, len) {
      const n = net;
      if (!n || !Number.isSafeInteger(pos) || pos < 0 || !(len > 0)) return null;
      try {
        const buf = await n.read(pos, Math.min(len, MAX_BLOCK));
        return new Uint8Array(buf.buffer, buf.byteOffset, buf.length);
      } catch (e) {
        io.log(`read ${pos}+${len}: ${errText(e)}`);
        if (n === net && !netFailed) { netFailed = true; toast(`${c.label}: ${errText(e)}. Check the connection and open the URL again.`, 6000); }
        return new Uint8Array(0);
      }
    },
    /** The ⚙ panel's Quality page (HLS): 'auto' or a variant index; the page restarts from the same moment. @param {'auto' | number} p */
    setQuality(p) {
      if (!plan || !plan.master) return undefined;
      if (p !== 'auto' && !(Number.isInteger(p) && p >= 0 && p < plan.variants.length)) return undefined;
      if (p === (plan.auto ? 'auto' : plan.index)) return undefined;
      pick = p;
      const v = p === 'auto' ? null : plan.variants[p];
      io.log(`quality: ${v ? `${v.width}x${v.height} ${v.bandwidth} b/s` : 'auto'}, reloading`);
      return open();
    },
    /** @param {boolean} on */
    setHidden(on) { if (inner && typeof inner.setHidden === 'function') inner.setHidden(on); },
    lossy: () => !!(inner && typeof inner.lossy === 'function' && inner.lossy()),
    dispose() { disposed = true; close(); },
  };
}
// checkJs: end

module.exports = { createSequenceDecoder, createUrlDecoder, sequenceFacts, MAX_FRAME_REQUEST };
