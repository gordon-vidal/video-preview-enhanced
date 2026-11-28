// @ts-check
'use strict';

(function () {
  // checkJs: start
  /**
   * Passive 60Hz continuity thresholds for active playback:
   * - BACKWARD_CLOCK_TOLERANCE_SEC (10 ms): allows floating-point and audio-clock re-anchor micro-jitter during normal
   *   playback while flagging real backward clock jumps within the same seek/loop generation.
   * - BACKWARD_BEHIND_TOLERANCE_SEC (300 ms): when decoding falls behind real time in "show every frame" mode
   *   (`p.behindUntil >= now`), `media/engine.js` re-anchors the timer clock back by up to 250 ms (`waitPic`) so the
   *   clock waits for the next picture instead of running ahead.
   * - FORWARD_CLOCK_TOLERANCE_SEC (500 ms): allowance above `(dtMs / 1000) * rate` for VSync-to-callback scheduling
   *   jitter and decode catch-up on busy or hidden-desktop runners before counting an unannounced forward jump.
   */
  const BACKWARD_CLOCK_TOLERANCE_SEC = 0.01;
  const BACKWARD_BEHIND_TOLERANCE_SEC = 0.3;
  const FORWARD_CLOCK_TOLERANCE_SEC = 0.5;

  const DEBUG_PROBES = new Set([
    'state', 'thumb', 'pixels', 'scopesDump', 'dom', 'gotoText', 'track',
    'click', 'a11y', 'scrub', 'hdrcaps', 'hdrpixels', 'telemetry', 'trace', 'capture', 'thumbPass', 'previewDecoder',
  ]);

  /**
   * @typedef {{
   *   active: boolean,
   *   samples: number,
   *   segments: number,
   *   activeMs: number,
   *   maxRafGapMs: number,
   *   framesAdvanced: number,
   *   frameGaps: number,
   *   droppedFrames: number,
   *   maxFrameGap: number,
   *   backwardFrames: number,
   *   backwardClockJumps: number,
   *   maxBackwardSec: number,
   *   unexpectedClockJumps: number,
   *   maxClockJumpSec: number,
   *   pageErrors: string[],
   * }} ContinuityTelemetry
   */

  /**
   * @typedef {{
   *   prefs: any,
   *   volume: number,
   *   muted: boolean,
   *   loop: boolean,
   *   onEnd?: string,
   *   rail?: any,
   *   streamQ: any,
   *   loopStats: { frames: number, rests: number },
   *   loopBusy: string,
   *   picturePct: number | null,
   *   seekDragging: boolean,
   *   volumeDragging: boolean,
   * }} PlayerUiSnapshot
   */

  /**
   * @typedef {{
   *   log: (...args: any[]) => void,
   *   getPlayer: () => any,
   *   isLibavPlayer?: (player: any) => boolean,
   *   stage: any,
   *   canvas: any,
   *   overlay: any,
   *   message: any,
   *   hint: any,
   *   actionBtn: any,
   *   dropHint: any,
   *   compareBackdrop: any,
   *   ui: Record<string, any>,
   *   controls: {
   *     view: () => string | null,
   *     sheetOpen: () => boolean,
   *     show: (view: string, anchor?: any) => void,
   *     closeAll: (restoreFocus?: boolean) => void,
   *   },
   *   ctxMenu: {
   *     open: (x: number, y: number, keyboard?: boolean) => void,
   *     close: (restoreFocus?: boolean) => void,
   *     snapshot: () => any,
   *   },
   *   insp: {
   *     picture: () => any,
   *     zoomedSize: () => any,
   *   },
   *   scopes: {
   *     mode: () => string | null,
   *     analysis: () => any,
   *     perf: () => any,
   *     columnLevels: (plane: any, col: number, scale: number) => any,
   *     targets75: (matrix: any) => Array<{ name: string, x: number, y: number }>,
   *   },
   *   hdr: {
   *     debugPixels: (player: any, pts: Array<[number, number]>) => Promise<any>,
   *     probe: () => Promise<any>,
   *   },
   *   ab: {
   *     presentationRange: () => any,
   *   },
   *   frameText: (frame: number, totalFrames: number) => string,
   *   step: (delta: number) => void,
   *   setRate: (rate: number) => void,
   *   runTool: (label: string) => boolean,
   *   getToolCount: () => number,
   *   getState: () => PlayerUiSnapshot,
   *   snapshotSource?: () => any,
   *   seek?: (t: number) => void,
   *   play?: () => void,
   *   pause?: () => void,
   *   win?: any,
   *   doc?: any,
   *   perf?: { now: () => number },
   *   raf?: (cb: (now: number) => void) => any,
   *   caf?: (id: any) => void,
   *   setIntervalFn?: (cb: () => void, ms: number) => any,
   *   clearIntervalFn?: (id: any) => void,
   *   setTimeoutFn?: (cb: () => void, ms: number) => any,
   *   clearTimeoutFn?: (id: any) => void,
   * }} DebugProbeDeps
   */

  /**
   * Test hook (debug only): WebCodecs support matrix in this webview, here and in a worker.
   * @param {any} win
   * @param {any} doc
   * @param {Set<() => void>} [activeCleanups]
   */
  async function wcProbe(win, doc, activeCleanups) {
    const C = {
      h264: ['avc1.640033', 3840, 2160], hevc8: ['hvc1.1.6.L153.B0', 3840, 2160], hevc10: ['hvc1.2.4.L153.B0', 3840, 2160],
      vp8: ['vp8', 1920, 1080], vp9: ['vp09.00.51.08', 3840, 2160], vp9_10: ['vp09.02.51.10', 3840, 2160],
      av1: ['av01.0.12M.08', 3840, 2160], av1_10: ['av01.0.12M.10', 3840, 2160],
    };
    // Sound: Y supported, - not, E the check threw (flac/vorbis are also asked with a description).
    const A = { aac: 'mp4a.40.2', opus: 'opus', mp3: 'mp3', flac: 'flac', vorbis: 'vorbis', pcm: 'pcm-s16' };
    async function run() {
      const VD = /** @type {any} */ (globalThis).VideoDecoder;
      const AD = /** @type {any} */ (globalThis).AudioDecoder;
      /** @type {Record<string, any>} */
      const out = { VideoDecoder: typeof VD, AudioDecoder: typeof AD };
      for (const [k, [codec, w, h]] of Object.entries(C)) {
        let s = '';
        for (const hw of ['prefer-hardware', 'no-preference', 'prefer-software']) {
          try { s += (await VD.isConfigSupported({ codec, codedWidth: w, codedHeight: h, hardwareAcceleration: hw })).supported ? 'Y' : '-'; } catch { s += 'E'; }
        }
        out[k] = s;
      }
      out.audio = {};
      for (const [k, codec] of Object.entries(A)) {
        let s = '';
        for (const desc of [null, new Uint8Array(64)]) {
          /** @type {Record<string, any>} */
          const c = { codec, sampleRate: 48000, numberOfChannels: 2 };
          if (desc) c.description = desc;
          try { s += (await AD.isConfigSupported(c)).supported ? 'Y' : '-'; } catch { s += 'E'; }
        }
        out.audio[k] = s;
      }
      return out;
    }
    const src = `const C=${JSON.stringify(C)};const A=${JSON.stringify(A)};${run.toString()}`;
    const page = await run();
    /** @type {any} */
    let worker = null;
    /** @type {string | null} */
    let url = null;
    const UrlApi = (win && win.URL) || URL;
    const WorkerCtor = (win && win.Worker) || Worker;
    const BlobCtor = (win && win.Blob) || Blob;
    try {
      url = UrlApi.createObjectURL(new BlobCtor([`${src};run().then((r)=>postMessage(r),(e)=>postMessage(String(e)));`], { type: 'text/javascript' }));
      worker = await new Promise((res) => {
        const w = new WorkerCtor(url);
        let settled = false;
        /** @param {any} val */
        const finish = (val) => {
          if (settled) return;
          settled = true;
          if (activeCleanups) activeCleanups.delete(cancel);
          try { w.terminate(); } catch { /* ignore */ }
          if (url) { try { UrlApi.revokeObjectURL(url); } catch { /* ignore */ } url = null; }
          res(val);
        };
        const cancel = () => finish('cancelled');
        if (activeCleanups) activeCleanups.add(cancel);
        w.onmessage = (/** @type {any} */ e) => finish(e.data);
        w.onerror = (/** @type {any} */ e) => finish(`worker error ${e && e.message || e}`);
      });
    } catch (e) {
      if (url) { try { UrlApi.revokeObjectURL(url); } catch { /* ignore */ } url = null; }
      worker = `no worker: ${e}`;
    }
    // <video>/MSE (not used by the player; shows what the webview's media stack has).
    const T = {
      h264: 'video/mp4; codecs="avc1.640028"', hevc: 'video/mp4; codecs="hvc1.1.6.L120.90"', av1: 'video/mp4; codecs="av01.0.08M.08"',
      vp8: 'video/webm; codecs="vp8"', vp9: 'video/webm; codecs="vp9"', aac: 'audio/mp4; codecs="mp4a.40.2"', opus: 'audio/webm; codecs="opus"',
      mp3: 'audio/mpeg', flac: 'audio/flac', vorbis: 'audio/ogg; codecs="vorbis"',
    };
    /** @type {Record<string, string>} */
    const media = {};
    const el = doc.createElement('video');
    const MS = /** @type {any} */ (win).MediaSource;
    for (const [k, t] of Object.entries(T)) {
      media[k] = `${el.canPlayType(t) || '-'}/${typeof MS !== 'undefined' && MS.isTypeSupported(t) ? 'mse' : '-'}`;
    }
    const nav = win.navigator || globalThis.navigator;
    return { ua: nav ? nav.userAgent : '', isolated: win.crossOriginIsolated, sab: typeof SharedArrayBuffer, page, worker, media };
  }

  /**
   * Installs the debug probe and passive 60Hz playback continuity telemetry collector.
   * @param {DebugProbeDeps} deps
   */
  function install(deps) {
    const win = deps.win || (typeof window !== 'undefined' ? window : globalThis);
    const doc = deps.doc || (typeof document !== 'undefined' ? document : null);
    const perf = deps.perf || (typeof performance !== 'undefined' ? performance : { now: () => Date.now() });
    const raf = deps.raf || (typeof win.requestAnimationFrame === 'function' ? win.requestAnimationFrame.bind(win) : (/** @type {(now: number) => void} */ cb) => setTimeout(() => cb(perf.now()), 16));
    const caf = deps.caf || (typeof win.cancelAnimationFrame === 'function' ? win.cancelAnimationFrame.bind(win) : (/** @type {any} */ id) => clearTimeout(id));
    const setIntervalFn = deps.setIntervalFn || setInterval;
    const clearIntervalFn = deps.clearIntervalFn || clearInterval;
    const setTimeoutFn = deps.setTimeoutFn || setTimeout;
    const clearTimeoutFn = deps.clearTimeoutFn || clearTimeout;
    const isLibav = deps.isLibavPlayer || ((/** @type {any} */ p) => !!(p && p.queue));
    const {
      log, getPlayer, stage, canvas, overlay, message, hint, actionBtn, dropHint,
      compareBackdrop, ui, controls, ctxMenu, insp, scopes, hdr, ab,
      frameText, step, setRate, runTool, getToolCount, getState,
    } = deps;
    /**
     * What `thumb` draws: a real canvas element. `canvas` may be a stand-in (the unified page passes a Proxy that
     * follows the clock tile), and Chromium's drawImage rejects anything but a real image source.
     */
    const snapshotSource = () => (deps.snapshotSource && deps.snapshotSource()) || canvas;

    let disposed = false;
    /** @type {any} */
    let rafId = null;
    const pendingTimers = new Set();
    /** @type {Set<() => void>} */
    const activeProbeCleanups = new Set();

    const state = {
      samples: 0,
      segments: 0,
      activeMs: 0,
      maxRafGapMs: 0,
      framesAdvanced: 0,
      frameGaps: 0,
      droppedFrames: 0,
      maxFrameGap: 0,
      backwardFrames: 0,
      backwardClockJumps: 0,
      maxBackwardSec: 0,
      unexpectedClockJumps: 0,
      maxClockJumpSec: 0,
      pageErrors: /** @type {string[]} */ ([]),
    };

    /** @type {{ player: any, gen: any, at: number, t: number, frame: number, shownCount: number, reanchorCount: number } | null} */
    let prev = null;
    /** @type {any} */
    let trackedPlayer = null;
    /** @type {any} */
    let trackedGen = undefined;
    let awaitingGenFrame = false;
    let genBaseShownCount = -1;

    function resetTelemetry() {
      state.samples = 0;
      state.segments = 0;
      state.activeMs = 0;
      state.maxRafGapMs = 0;
      state.framesAdvanced = 0;
      state.frameGaps = 0;
      state.droppedFrames = 0;
      state.maxFrameGap = 0;
      state.backwardFrames = 0;
      state.backwardClockJumps = 0;
      state.maxBackwardSec = 0;
      state.unexpectedClockJumps = 0;
      state.maxClockJumpSec = 0;
      state.pageErrors.length = 0;
      prev = null;
    }

    /** @returns {ContinuityTelemetry} */
    function snapshotTelemetry() {
      return {
        active: rafId !== null,
        samples: state.samples,
        segments: state.segments,
        activeMs: Math.round(state.activeMs * 100) / 100,
        maxRafGapMs: Math.round(state.maxRafGapMs * 100) / 100,
        framesAdvanced: state.framesAdvanced,
        frameGaps: state.frameGaps,
        droppedFrames: state.droppedFrames,
        maxFrameGap: state.maxFrameGap,
        backwardFrames: state.backwardFrames,
        backwardClockJumps: state.backwardClockJumps,
        maxBackwardSec: Math.round(state.maxBackwardSec * 1e6) / 1e6,
        unexpectedClockJumps: state.unexpectedClockJumps,
        maxClockJumpSec: Math.round(state.maxClockJumpSec * 1e6) / 1e6,
        pageErrors: [...state.pageErrors],
      };
    }

    /** @param {any} p */
    function syncPausedBaseline(p) {
      if (!p || p.isPlaying()) return;
      const hasPic = !!(p.firstShown || (typeof p.shown === 'number' && p.shown >= 0) || (!('firstShown' in p) && !('shown' in p)));
      const seeking = p.seekTarget !== undefined && p.seekTarget !== null;
      if (!hasPic || seeking) return;
      const sc = typeof p.shownCount === 'number' ? p.shownCount : -1;
      if (p !== trackedPlayer) {
        trackedPlayer = p;
        trackedGen = p.gen;
        genBaseShownCount = sc;
        awaitingGenFrame = false;
      } else if (p.gen === trackedGen) {
        genBaseShownCount = sc;
      } else if (sc !== genBaseShownCount) {
        trackedGen = p.gen;
        genBaseShownCount = sc;
        awaitingGenFrame = false;
      }
    }

    /** @param {number} now */
    function sampleTick(now) {
      rafId = null;
      if (disposed) return;
      const p = getPlayer();
      if (!p || !p.isPlaying()) {
        prev = null;
        syncPausedBaseline(p);
        return;
      }
      rafId = raf(sampleTick);
      const hasPicture = !!(p.firstShown || (typeof p.shown === 'number' && p.shown >= 0) || (!('firstShown' in p) && !('shown' in p)));
      const seeking = p.seekTarget !== undefined && p.seekTarget !== null;
      const shownCount = typeof p.shownCount === 'number' ? p.shownCount : -1;
      const isEngine = isLibav(p);
      if (p !== trackedPlayer) {
        trackedPlayer = p;
        trackedGen = p.gen;
        awaitingGenFrame = false;
        genBaseShownCount = shownCount;
        prev = null;
      } else if (p.gen !== trackedGen) {
        trackedGen = p.gen;
        // Both LibavPlayer (shownT) and FramePlayer (shown) hold the pre-seek picture until shownCount advances.
        awaitingGenFrame = shownCount >= 0 && shownCount === genBaseShownCount;
        genBaseShownCount = shownCount;
        prev = null;
      }
      if (awaitingGenFrame && shownCount !== genBaseShownCount) awaitingGenFrame = false;
      genBaseShownCount = shownCount;
      if (!hasPicture || seeking || awaitingGenFrame) {
        prev = null;
        return;
      }
      const t = Number(p.currentTime());
      // For FramePlayer, sample the actually drawn frame (`shown`) rather than clock-derived `currentFrame()`.
      const frame = !isEngine && typeof p.shown === 'number' ? p.shown : Number(p.currentFrame());
      const reanchorCount = typeof p.reanchorCount === 'number' ? p.reanchorCount : 0;
      if (!Number.isFinite(t) || !Number.isFinite(frame) || frame < 0) return;
      state.samples++;
      if (!prev) {
        state.segments++;
        prev = { player: p, gen: p.gen, at: now, t, frame, shownCount, reanchorCount };
        return;
      }
      const dtMs = Math.max(0, now - prev.at);
      state.activeMs += dtMs;
      if (dtMs > state.maxRafGapMs) state.maxRafGapMs = dtMs;
      const df = frame - prev.frame;
      if (df < 0) {
        state.backwardFrames++;
      } else if (df > 0) {
        state.framesAdvanced += df;
        if (df > 1) {
          state.frameGaps++;
          state.droppedFrames += df - 1;
          if (df - 1 > state.maxFrameGap) state.maxFrameGap = df - 1;
        }
      }
      const dt = t - prev.t;
      const reanchored = reanchorCount !== prev.reanchorCount;
      const backTol = reanchored ? BACKWARD_BEHIND_TOLERANCE_SEC : BACKWARD_CLOCK_TOLERANCE_SEC;
      if (dt < -1e-6 && -dt > state.maxBackwardSec) state.maxBackwardSec = -dt;
      if (dt < -backTol) state.backwardClockJumps++;
      const rate = Number(p.rate) > 0 ? Number(p.rate) : 1;
      const expectedMax = (dtMs / 1000) * rate + FORWARD_CLOCK_TOLERANCE_SEC;
      if (dt > state.maxClockJumpSec) state.maxClockJumpSec = dt;
      if (dt > expectedMax) state.unexpectedClockJumps++;
      prev = { player: p, gen: p.gen, at: now, t, frame, shownCount, reanchorCount };
    }

    function wake() {
      if (disposed) return;
      const p = getPlayer();
      if (!p || !p.isPlaying()) {
        syncPausedBaseline(p);
        return;
      }
      if (rafId === null) rafId = raf(sampleTick);
    }

    /** @param {string} msg */
    function noteError(msg) {
      if (disposed) return;
      state.pageErrors.push(String(msg));
    }

    /** @param {any} e */
    function onError(e) {
      noteError(`error: ${e && e.message || e} ${e && e.filename ? `${e.filename}:${e.lineno || 0}` : ''}`.trim());
    }

    /** @param {any} e */
    function onRejection(e) {
      const r = e && e.reason;
      noteError(`unhandled rejection: ${r && r.stack || r}`);
    }

    const byId = (/** @type {string} */ id) => (doc && doc.getElementById ? doc.getElementById(id) : null);
    const rect = (/** @type {any} */ e) => { const r = e.getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; };
    const getComputedStyleFn = (/** @type {any} */ el) => (typeof win.getComputedStyle === 'function' ? win.getComputedStyle(el) : typeof getComputedStyle === 'function' ? getComputedStyle(el) : { display: '', visibility: '', outlineStyle: '', outlineWidth: '' });

    /**
     * Test hook (debug only, test/vscode/lib.js): what the page shows, one JSON line per request
     * ("<action> {json}"), and synthetic input for what the debug keys cannot do (mouse, wheel, the
     * go-to box, menu items). Reads state and dispatches the same DOM events a user would; changes nothing else.
     * @param {any} m
     */
    function debugProbe(m) {
      try {
        const player = getPlayer();
        switch (m.action) {
        case 'telemetry': {
          const snap = snapshotTelemetry();
          if (m.reset) resetTelemetry();
          log(`telemetry ${JSON.stringify({ id: m.id, ...snap })}`);
          break;
        }
        case 'state': {
          const p = player;
          const uiState = getState();
          const sp = doc && doc.querySelector ? doc.querySelector('.subs-pic') : null;
          const vw = (() => {
            const r = canvas.getBoundingClientRect();
            const k = Math.min(r.width / canvas.width, r.height / canvas.height);
            return [r.left + (r.width - canvas.width * k) / 2, r.top + (r.height - canvas.height * k) / 2, canvas.width * k, canvas.height * k];
          })();
          const noticeEl = byId('notice');
          const noticeTextEl = byId('noticeText');
          const pxgridEl = byId('pxgrid');
          const pxreadEl = byId('pxread');
          const gotoEl = byId('goto');
          const statsEl = byId('stats');
          const subsEl = byId('subs');
          /** @type {Record<string, any>} */
          const s = {
            id: m.id,
            toast: ui.toast.hidden ? '' : ui.toast.textContent, toastRect: ui.toast.hidden ? null : rect(ui.toast),
            status: p && p.status ? ((p.status() || {}).text || '') : '',
            // The loading feedback (media/player-ui.js setLoading): tiles with a spinner, and the seek bar's pulse.
            loading: doc && doc.querySelectorAll ? doc.querySelectorAll('.cell.loading').length : 0,
            seekPulse: !!(ui.seek && ui.seek.parentElement && ui.seek.parentElement.classList.contains('seeking')),
            notice: !noticeEl || noticeEl.hidden ? '' : (noticeTextEl ? noticeTextEl.textContent : ''),
            message: overlay.hidden ? '' : message.textContent, hint: overlay.hidden ? '' : hint.textContent,
            action: overlay.hidden || actionBtn.hidden ? '' : actionBtn.textContent, seekDisabled: ui.seek.disabled,
            frameText: p ? frameText(p.currentFrame(), p.n) : '', timeText: (ui.time.textContent || '').replace(/\s+/g, ' ').trim(),
            panel: (() => {
              const pn = ui.panel;
              if (pn.hidden) return null;
              const text = (/** @type {any} */ e) => (e.textContent || '').replace(/\s+/g, ' ').trim();
              const slider = pn.querySelector ? pn.querySelector('#speedSlider') : null;
              return {
                view: controls.view(), label: pn.getAttribute('aria-label'), text: text(pn),
                rows: Array.from(pn.querySelectorAll('button')).map((/** @type {any} */ b) => ({ label: b.getAttribute('aria-label') || text(b), pressed: b.getAttribute('aria-pressed'), checked: b.getAttribute('aria-checked') })),
                facts: Array.from(pn.querySelectorAll('.igrid dt')).map((/** @type {any} */ dt) => [text(dt), text(dt.nextElementSibling)]),
                sliderRect: slider ? rect(slider) : null,
                slider: slider ? [slider.min, slider.max] : null,
              };
            })(),
            sheet: ui.sheet.hidden ? null : (ui.sheet.textContent || '').replace(/\s+/g, ' ').trim(),
            bar: { rate: ui.rate.textContent, rateReset: !!byId('rateReset') && !byId('rateReset').hidden, cc: ui.tracks.getAttribute('aria-label'), ccHidden: getComputedStyleFn(ui.tracks).display === 'none', cogExpanded: ui.cog.getAttribute('aria-expanded'), infoExpanded: ui.infoBtn.getAttribute('aria-expanded'), rateExpanded: ui.rate.getAttribute('aria-expanded'), ccExpanded: ui.tracks.getAttribute('aria-expanded') },
            prefs: uiState.prefs, volume: uiState.volume, drag: { seek: uiState.seekDragging, volume: uiState.volumeDragging }, volumeRect: rect(ui.volume),
            canvas: [canvas.width, canvas.height], canvasHidden: canvas.hidden, canvasRect: rect(canvas), video: vw,
            stageClass: stage.className, stageRect: rect(stage), picture: { ...insp.picture(), pct: uiState.picturePct, btnMode: ui.picBtn.dataset.mode, btnLabel: ui.picBtn.getAttribute('aria-label'), btnTitle: ui.picBtn.title, need: insp.zoomedSize() }, imageRendering: canvas.style.imageRendering,
            pxgrid: !!pxgridEl && !pxgridEl.hidden, pxread: pxgridEl && pxreadEl && !pxreadEl.hidden ? pxreadEl.innerText : (pxreadEl && !pxreadEl.hidden ? pxreadEl.innerText : ''),
            goto: !!gotoEl && !gotoEl.hidden, stats: statsEl && !statsEl.hidden ? statsEl.textContent : '',
            infoShown: controls.view() === 'info', abRange: ab.presentationRange(), abMarks: { hidden: ui.abMarks.hidden, left: ui.abMarks.style.left, width: ui.abMarks.style.width },
            subsText: subsEl && !subsEl.hidden ? subsEl.textContent : '', muted: ui.mute.classList.contains('on'),
            dpr: win.devicePixelRatio || globalThis.devicePixelRatio || 1, engine: !!(p && p.queue), loop: { ...uiState.loopStats, busy: uiState.loopBusy }, ctxMenu: ctxMenu.snapshot(), viewport: { w: doc && doc.documentElement ? doc.documentElement.clientWidth : 0, h: doc && doc.documentElement ? doc.documentElement.clientHeight : 0 }, playing: !!(p && p.isPlaying()),
            seekRect: rect(ui.seek), quality: uiState.streamQ, onEnd: uiState.onEnd, rail: uiState.rail || null,
            thumb: (() => { const b = byId('thumb'); const c = b && b.querySelector ? b.querySelector('canvas') : null; let sig = ''; if (c && c.width) { const u = c.toDataURL(); let x = 0; for (let i = 0; i < u.length; i += 7) x = (x * 31 + u.charCodeAt(i)) | 0; sig = `${u.length}:${x}`; } return { hidden: !b || b.hidden, w: c ? c.width : 0, sig, rect: b ? rect(b) : null }; })(),
            tip: { hidden: ui.tip.hidden, rect: rect(ui.tip) },
            strip: p && p.thumbStrip ? p.thumbStrip() : null, engineHidden: !!(p && p.hidden), seekValue: Number(ui.seek.value), seekMax: Number(ui.seek.max),
            tracksMenu: (() => { const pn = ui.panel; const on = !pn.hidden && (controls.view() === 'subs' || controls.view() === 'audio' || controls.view() === 'quality'); return { hidden: !on, items: on ? Array.from(pn.querySelectorAll('[role=radio], button.row:not(.head)')).map((/** @type {any} */ x) => `${x.getAttribute('aria-checked') === 'true' ? '*' : ''}${(x.querySelector('.grow') || x).textContent.trim()}`) : [] }; })(),
            xray: (() => { const x = byId('xray'); const lg = byId('xrayLegend'); const tp = byId('xrayTip'); const ch = byId('xrayChapters'); return { shown: !!x && !x.hidden, legend: lg ? lg.textContent : '', tip: tp && !tp.hidden ? tp.textContent : '', ticks: ch ? ch.children.length : -1 }; })(),
            telemetry: snapshotTelemetry(),
          };
          if (p) {
            Object.assign(s, {
              vmode: p.vmode, amode: p.amode, fps: p.fps, n: p.n, duration: p.meta && p.meta.duration, shownCount: p.shownCount || p.shown || 0, dropped: p.dropped || 0, late: p.late || 0, eof: p.eof,
              audioMaster: p.audioMaster ? p.audioMaster() : null, ac: p.ac ? p.ac.state : null, sources: p.sources && p.sources.size !== undefined ? p.sources.size : null,
              t: p.currentTime(), frame: p.currentFrame(), label: p.meta && p.meta.label, firstShown: !!p.firstShown, gen: p.gen, playing: p.isPlaying(), rate: p.rate,
              hdr: p.gl ? p.gl.hdr : null, audioChunks: Array.isArray(p.audio) ? p.audio.length : null, audioChannels: Array.isArray(p.audio) && p.audio.length ? p.audio[0].buf.numberOfChannels : null,
              audioSeconds: Array.isArray(p.audio) ? p.audio.reduce((/** @type {number} */ x, /** @type {any} */ a) => x + a.dur, 0) : null,
              drift: p.audioMaster && p.audioMaster() && p.shownT !== null ? p.now() - p.shownT : null,
              tracks: p.tracks ? p.tracks() : null,
              // Live transcode, paused: the last seek's first picture (ms) and the sharp frames (media/engine.js requestSharp).
              lastSeekMs: p.lastSeekMs !== undefined ? Math.round(p.lastSeekMs) : null,
              sharp: p.sharpStats ? { ...p.sharpStats, pending: !!p.sharp } : null,
              quick: p.quickStats ? { ...p.quickStats } : null,
              play: p.playStats || null,
              // A seek or step not landed yet (its target pending), and what the page's packet cache holds (Live transcode):
              // tests wait for these conditions instead of sleeping.
              seekPending: p.seekTarget !== null && p.seekTarget !== undefined,
              packets: p.packetCache ? { video: p.packetCache.spans(), sound: p.packetCache.soundSpans() } : null,
            });
            if (p.gl && p.gl.gl && p.gl.prog) { try { s.tf = p.gl.gl.getUniform(p.gl.prog, p.gl.uTf); } catch { /* not WebGL */ } }
          }
          s.subpic = sp && !sp.hidden ? Array.from(sp.querySelectorAll('canvas.subs-bitmap')).map((/** @type {any} */ e) => {
            const b = e.getBoundingClientRect();
            const d = e.getContext('2d').getImageData(e.width >> 1, e.height >> 1, 1, 1).data;
            return { box: [b.left, b.top, b.width, b.height], size: [e.width, e.height], mid: [...d] };
          }) : [];
          log(`state ${JSON.stringify(s)}`);
          break;
        }
        case 'thumb': {
          // The canvas as w x h luma, area-averaged in two steps (as ffmpeg's scale flags=area), base64.
          const w = m.w || 64, h = m.h || 36;
          const src = snapshotSource();
          if (!src || !src.width || !src.height) { log(`thumb ${JSON.stringify({ id: m.id, error: 'no picture' })}`); break; }
          const mid = doc.createElement('canvas'); mid.width = w * 4; mid.height = h * 4;
          const mc = mid.getContext('2d'); mc.imageSmoothingQuality = 'high'; mc.drawImage(src, 0, 0, mid.width, mid.height);
          const c = doc.createElement('canvas'); c.width = w; c.height = h;
          const cx = c.getContext('2d', { willReadFrequently: true }); cx.imageSmoothingQuality = 'high'; cx.drawImage(mid, 0, 0, w, h);
          const d = cx.getImageData(0, 0, w, h).data;
          let bin = '';
          for (let i = 0; i < w * h; i++) bin += String.fromCharCode(Math.round(0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2]));
          log(`thumb ${JSON.stringify({ id: m.id, frame: player ? player.currentFrame() : -1, w, h, y: btoa(bin) })}`);
          break;
        }
        case 'pixels': {
          const g = player && player.gl && player.gl.gl;
          if (!g) { log(`pixels ${JSON.stringify({ id: m.id, error: 'no WebGL canvas' })}`); break; }
          const H = g.drawingBufferHeight;
          const rgb = (m.pts || []).map((/** @type {[number, number]} */ [x, y]) => { const px = new Uint8Array(4); g.readPixels(x, H - 1 - y, 1, 1, g.RGBA, g.UNSIGNED_BYTE, px); return [px[0], px[1], px[2]]; });
          log(`pixels ${JSON.stringify({ id: m.id, rgb })}`);
          break;
        }
        case 'hdrpixels': hdr.debugPixels(player, m.pts || []).then((r) => log(`hdrpixels ${JSON.stringify({ id: m.id, ...r })}`), (e) => log(`hdrpixels ${JSON.stringify({ id: m.id, error: String(e) })}`)); break;
        case 'hdrcaps': hdr.probe().then((r) => log(`hdrcaps ${JSON.stringify({ id: m.id, ...r })}`), (e) => log(`hdrcaps ${JSON.stringify({ id: m.id, error: String(e) })}`)); break;
        case 'scopesDump': {
          const an = scopes.analysis();
          const scopesEl = byId('scopes');
          /** @type {Record<string, any>} */
          const out = { id: m.id, mode: scopes.mode() || 'off', hidden: scopesEl ? scopesEl.hidden : true, perf: scopes.perf() };
          if (an) {
            out.w = an.w; out.h = an.h; out.matrix = an.matrix;
            const cols = Array.from({ length: 8 }, (_, i) => Math.floor((i + 0.5) * an.w / 8));
            out.cols = cols;
            if (an.wave) { let n = 0; for (const v of an.wave) n += v; out.waveN = n; out.wave = cols.map((c) => scopes.columnLevels(an.wave, c, 0.5)); }
            if (an.parade) out.parade = [0, 1, 2].map((ch) => cols.map((c) => scopes.columnLevels(an.parade[ch], c, 0.5)));
            if (an.vec) {
              const near = (/** @type {number} */ x0, /** @type {number} */ y0, /** @type {number} */ rad) => { let n = 0; for (let y = Math.max(0, Math.floor(y0 - rad)); y <= Math.min(255, Math.ceil(y0 + rad)); y++) for (let x = Math.max(0, Math.floor(x0 - rad)); x <= Math.min(255, Math.ceil(x0 + rad)); x++) if (Math.hypot(x - x0, y - y0) <= rad) n += an.vec[y * 256 + x]; return n; };
              const total = an.w * an.h;
              out.vec = { targets: scopes.targets75(an.matrix).map((tg) => ({ name: tg.name, x: tg.x, y: tg.y, share: near(tg.x, tg.y, 6) / total })), centre: near(128, 128, 4) / total };
            }
          }
          log(`scopesDump ${JSON.stringify(out)}`);
          break;
        }
        case 'dom': { // a mouse / pointer / wheel event at client (x, y), or on the element with id `id`
          const target = m.target === 'document' ? doc : m.target ? byId(m.target) : doc.elementFromPoint(m.x, m.y);
          if (!target) { log(`dom ${JSON.stringify({ id: m.id, error: `no element at ${m.x},${m.y}` })}`); break; }
          const init = { bubbles: true, cancelable: true, clientX: m.x, clientY: m.y, button: m.button || 0, ctrlKey: !!m.ctrl, shiftKey: !!m.shift, deltaY: m.deltaY || 0, pointerId: 1, isPrimary: true };
          const Ctor = /^wheel/.test(m.ev) ? WheelEvent : /^pointer/.test(m.ev) ? PointerEvent : MouseEvent;
          target.dispatchEvent(new Ctor(m.ev, init));
          break;
        }
        case 'scrub': { // the slider dragged to `frac` (what the browser does while the mouse is held): input; end: pointerup
          const max = Number(ui.seek.max) || 0;
          ui.seek.value = String(Math.round(Math.max(0, Math.min(1, m.frac)) * max));
          ui.seek.dispatchEvent(new Event('input', { bubbles: true }));
          const value = Number(ui.seek.value);
          if (m.end) {
            const r = ui.seek.getBoundingClientRect();
            doc.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1, clientX: r.left + m.frac * r.width, clientY: m.off ? r.top - 100 : r.top + r.height / 2 }));
          }
          log(`scrub ${JSON.stringify({ id: m.id, value })}`);
          break;
        }
        case 'capture': { // seek-bar previews from shown frames on (default) or off, to compare playback with and without
          if (player) player.captureOff = !m.on;
          log(`capture ${JSON.stringify({ id: m.id, on: !!(player && !player.captureOff) })}`);
          break;
        }
        case 'thumbPass': { // the background seek-bar preview pass on (default) or off, to compare playback with and without
          if (player) player.thumbPassOff = !m.on;
          log(`thumbPass ${JSON.stringify({ id: m.id, on: !!(player && !player.thumbPassOff) })}`);
          break;
        }
        case 'previewDecoder': { // seek-bar preview sweeps on the WebCodecs preview decoder (default) or the software worker
          if (player) player.previewDecoderOff = !m.on;
          log(`previewDecoder ${JSON.stringify({ id: m.id, on: !!(player && !player.previewDecoderOff) })}`);
          break;
        }
        case 'gotoText': { // Ctrl+G, type, Enter
          doc.dispatchEvent(new KeyboardEvent('keydown', { key: 'g', ctrlKey: true }));
          const input = doc.querySelector('#goto input');
          if (!input) { log(`gotoText ${JSON.stringify({ id: m.id, error: 'no go-to box' })}`); break; }
          input.value = m.text;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
          break;
        }
        case 'track': {
          if (player && m.sub !== undefined && player.selectSub) Promise.resolve(player.selectSub(m.sub)).catch(() => {});
          if (player && m.audio !== undefined && player.selectAudio) Promise.resolve(player.selectAudio(m.audio)).catch(() => {});
          break;
        }
        case 'a11y': { // roles, names and states of the controls, the live region, focus (`focus`: a selector to focus first)
          if (m.focus) { const f = doc.querySelector(m.focus); if (f) f.focus(); }
          const uiState = getState();
          const ATTRS = ['role', 'aria-label', 'aria-pressed', 'aria-expanded', 'aria-haspopup', 'aria-checked', 'aria-valuetext', 'aria-keyshortcuts', 'tabindex'];
          const attrs = (/** @type {any} */ e) => (e ? Object.fromEntries(ATTRS.filter((a) => e.hasAttribute(a)).map((a) => [a, e.getAttribute(a)])) : null);
          const a = doc.activeElement;
          const menuInfo = (/** @type {any} */ mm) => ({
            hidden: mm.hidden, role: mm.getAttribute('role'), label: mm.getAttribute('aria-label'),
            items: Array.from(mm.querySelectorAll('button')).map((/** @type {any} */ b) => ({ role: b.getAttribute('role'), label: b.getAttribute('aria-label') || b.textContent.trim(), checked: b.getAttribute('aria-checked'), tabindex: b.getAttribute('tabindex') })),
            groups: Array.from(mm.querySelectorAll('[role=group]')).map((/** @type {any} */ g) => g.getAttribute('aria-label')),
            separators: mm.querySelectorAll('[role=separator]').length,
            // Children of a menu other than items, groups and separators (headings are aria-hidden).
            stray: Array.from(mm.querySelectorAll('*')).filter((/** @type {any} */ x) => !x.closest('[aria-hidden=true]') && x.parentElement && (x.parentElement === mm || x.parentElement.getAttribute('role') === 'group')
              && !/^(menuitem|menuitemradio|menuitemcheckbox|group|separator)$/.test(x.getAttribute('role') || '') && x.getAttribute('aria-hidden') !== 'true').map((/** @type {any} */ x) => x.className || x.tagName),
          });
          // Buttons on the page with no accessible name in words (a symbol such as ▶ is not one); empty ones are unused placeholders.
          const unnamed = Array.from(doc.querySelectorAll('button')).filter((/** @type {any} */ b) => (b.textContent || b.getAttribute('aria-label')) && !/[A-Za-z]/.test(b.getAttribute('aria-label') || b.textContent || '')).map((/** @type {any} */ b) => b.id || b.className || b.textContent);
          const cs = a && a !== doc.body ? getComputedStyleFn(a) : null;
          let fv = false; try { fv = !!a && a.matches(':focus-visible'); } catch { /* old engine */ }
          const ids = ['play', 'prev', 'next', 'seek', 'mute', 'volume', 'time', 'tracks', 'startCompareBtn', 'infoBtn', 'rate', 'cog', 'picBtn', 'full', 'noticeClose', 'canvas'];
          log(`a11y ${JSON.stringify({
            id: m.id,
            controls: Object.fromEntries(ids.map((k) => [k, attrs(byId(k))])),
            live: (() => { const l = byId('live'); return l ? { text: l.textContent, role: l.getAttribute('role'), polite: l.getAttribute('aria-live') } : null; })(),
            active: a ? (a.id || (a.dataset && a.dataset.tool) || a.getAttribute('aria-label') || (a.textContent || '').trim().slice(0, 40) || a.tagName) : '',
            activeRole: a ? a.getAttribute('role') || a.tagName.toLowerCase() : '',
            focusVisible: fv, outline: cs ? `${cs.outlineStyle} ${cs.outlineWidth}` : '',
            startCompare: { hidden: compareBackdrop.hidden },
            panel: Object.assign(menuInfo(ui.panel), { view: controls.view(), radios: Array.from(ui.panel.querySelectorAll('[role=radio], [role=switch]')).map((/** @type {any} */ b) => ({ role: b.getAttribute('role'), checked: b.getAttribute('aria-checked') })) }),
            sheet: { hidden: ui.sheet.hidden, dialog: (() => { const d = ui.sheet.querySelector ? ui.sheet.querySelector('[role=dialog]') : null; return d ? { label: d.getAttribute('aria-label'), modal: d.getAttribute('aria-modal'), groups: Array.from(d.querySelectorAll('[role=group]')).map((/** @type {any} */ g) => g.getAttribute('aria-label')) } : null; })() },
            unnamed, playing: player ? player.isPlaying() : null, muted: uiState.muted, loop: uiState.loop,
          })}`);
          break;
        }
        case 'trace': { // tests: `input` (any debug action), then what the UI and the picture show, each change, for `ms`
          // One line at the end: [ms since the input, seek bar value, time text, tiles loading, bar pulse, frame shown,
          // seek pending] at every animation frame where one of them changed, and the longest gap between frames
          // (a busy page answers input late whatever the UI does).
          const t0 = perf.now();
          /** @type {any[]} */
          const rows = [];
          let last = '';
          let prevAt = t0;
          let maxGap = 0;
          const sample = (again = true) => {
            const p = getPlayer();
            const now = perf.now();
            maxGap = Math.max(maxGap, now - prevAt);
            prevAt = now;
            const row = [Number(ui.seek.value), (ui.time.textContent || '').replace(/\s+/g, ' ').trim(),
              doc.querySelectorAll('.cell.loading').length, !!(ui.seek.parentElement && ui.seek.parentElement.classList.contains('seeking')),
              p ? p.currentFrame() : -1, !!(p && p.seekTarget !== undefined && p.seekTarget !== null)];
            const key = JSON.stringify(row);
            if (key !== last) { last = key; rows.push([Math.round(now - t0), ...row]); }
            if (!again) return;
            if (now - t0 < (m.ms || 3000)) raf(() => sample());
            else log(`trace ${JSON.stringify({ id: m.id, maxGapMs: Math.round(maxGap), rows })}`);
          };
          sample(false);
          // `inputs`: several, each `at` ms after the first (a key held, a drag); `frac` on a pointer event: that point of the bar.
          const fire = (/** @type {any} */ x) => {
            const r = ui.seek.getBoundingClientRect();
            const at = x.frac !== undefined ? { x: r.left + x.frac * r.width, y: r.top + r.height / 2, target: x.ev === 'pointerdown' ? 'seek' : 'document' } : {};
            onMessage({ data: { type: 'debug', name: m.name, ...x, ...at } });
          };
          for (const x of m.inputs || (m.input ? [m.input] : [])) { if (x.at) scheduleTimeout(() => fire(x), x.at); else fire(x); }
          sample(); // what the input changed before the next frame, then every frame
          break;
        }
        case 'click': { // the first element matching `sel` (whose text contains `text`, when given)
          const e = Array.from(doc.querySelectorAll(m.sel)).find((/** @type {any} */ x) => !m.text || (x.textContent || '').includes(m.text));
          log(`click ${JSON.stringify({ id: m.id, found: !!e, disabled: !!(e && e.disabled) })}`);
          if (e) e.click();
          break;
        }
        }
      } catch (e) { log(`${m.action} ${JSON.stringify({ id: m.id, error: String(e && e.stack || e) })}`); }
    }

    /** @param {() => void} fn @param {number} ms */
    function scheduleTimeout(fn, ms) {
      const id = setTimeoutFn(() => {
        pendingTimers.delete(id);
        if (!disposed) fn();
      }, ms);
      pendingTimers.add(id);
    }

    /** @param {any} e */
    function onMessage(e) {
      if (disposed) return;
      const m = e && e.data;
      if (!m || m.type !== 'debug') return;
      if (DEBUG_PROBES.has(m.action)) { debugProbe(m); return; } // also before a player exists (error messages)
      const player = getPlayer();
      if (!player) return;
      if (m.action === 'remoteStreamRate' && player.remoteStream) player.debugRemoteRate = m.bytesPerSecond;
      // Tests: the page's packet cache for paused seeks (media/packet-cache.js) off (mb 0) or at this size.
      if (m.action === 'packetCache' && player.remoteStream) {
        const PC = /** @type {any} */ (globalThis).VpePacketCache;
        if (m.mb !== undefined) player.packetCache = m.mb > 0 && PC ? PC.create({ cap: m.mb * 1e6 }) : null;
        // The sound kept with the packets used (play after a seek served from them) or not; it is kept either way.
        if (m.sound !== undefined) player.soundCacheOff = !m.sound;
      }
      // Tests: Live transcode's paused fast first picture (host) and sharp frame (page) on or off, for before/after.
      if (m.action === 'pausedSharp' && player.remoteStream) {
        if (m.sharp !== undefined) { player.sharpOff = !m.sharp; if (!m.sharp && player.cancelSharp) player.cancelSharp(); }
        if (m.fastFirst !== undefined) player.fastFirstHook = !!m.fastFirst; // sent with the next seek (host: on or off)
        // The quick first picture (src/stream.js startQuick): true for any encoder (instead of x264's small first keyframe),
        // false never, null as the link and encoder decide.
        if (m.quick !== undefined) player.quickHook = m.quick;
      }
      // Tests: Live transcode's kept-running decoder on the host (src/warm-decoder.js) off or on (with the next seek).
      if (m.action === 'warmDecoder' && player.remoteStream) player.warmHook = m.on === undefined ? undefined : !!m.on;
      // Tests: the last sharp frame's centre crop (media/engine.js sharpThumb), to tell which frame it is.
      if (m.action === 'sharpThumb') log(`sharpThumb ${JSON.stringify({ id: m.id, ...(player.sharpThumb || { error: 'no sharp frame yet' }) })}`);
      // A page with a controller over its decoders (the unified viewer) seeks / plays through it, so its state and
      // every decoder follow; a bare player is told directly.
      if (m.action === 'seek') { if (deps.seek) deps.seek(Number(m.t) || 0); else player.seekTime(m.t); wake(); }
      if (m.action === 'step') step(m.d);
      if (m.action === 'pause') { if (deps.pause) deps.pause(); else player.pause(); }
      // Tests: a picture area of this many CSS pixels (as a resized panel or fullscreen would give); 0 restores it.
      if (m.action === 'stageSize') { stage.style.flex = m.h ? 'none' : ''; stage.style.width = m.w ? `${m.w}px` : ''; stage.style.height = m.h ? `${m.h}px` : ''; }
      if (m.action === 'wheel') stage.dispatchEvent(new WheelEvent('wheel', { deltaY: Number(m.deltaY) || 0, ctrlKey: !!m.ctrl, clientX: stage.getBoundingClientRect().width / 2, clientY: stage.getBoundingClientRect().height / 2, bubbles: true, cancelable: true }));
      if (m.action === 'drop') { // tests: a drop carrying these URI lists, as VS Code would deliver (Shift held)
        const dt = new DataTransfer();
        for (const [k, v] of Object.entries(m.data || {})) dt.setData(k, v);
        doc.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true, cancelable: true }));
        log(`debug dropHint ${!dropHint.hidden}`);
        doc.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
      }
      if (m.action === 'key') (m.target ? doc.querySelector(m.target) : doc).dispatchEvent(new KeyboardEvent('keydown', { key: m.key, shiftKey: !!m.shift, ctrlKey: !!m.ctrl, bubbles: true }));
      if (m.action === 'ctxOpen') ctxMenu.open(m.x ?? 40, m.y ?? 40, !!m.keyboard);
      if (m.action === 'stageClick') { const o = { bubbles: true, cancelable: true, button: 0 }; stage.dispatchEvent(new PointerEvent('pointerdown', o)); stage.dispatchEvent(new PointerEvent('pointerup', o)); stage.dispatchEvent(new MouseEvent('click', o)); }
      if (m.action === 'ctxClose') ctxMenu.close(true);
      if (m.action === 'ctxPick') { const b = doc.querySelector(`#ctxmenu [data-id="${m.id}"]`); if (b) b.click(); else log(`ctxmenu item not found: ${m.id}`); }
      if (m.action === 'play') { if (deps.play) deps.play(); else player.play(); wake(); }
      if (m.action === 'rate') setRate(m.r);
      if (m.action === 'panel') { if (m.view) controls.show(m.view, m.view === 'info' ? ui.infoBtn : m.view === 'speed' ? ui.rate : ui.cog); else controls.closeAll(false); }
      if (m.action === 'tool') { if (m.open) controls.show('main', ui.cog); else if (!runTool(m.label)) log(`tool not found: ${m.label}`); }
      if (m.action === 'modesReport') {
        scheduleTimeout(() => {
          const p = getPlayer();
          if (!p) return;
          const vis = (/** @type {any} */ el) => !!el && el.offsetWidth > 0 && el.offsetHeight > 0 && getComputedStyleFn(el).visibility !== 'hidden';
          const sc = byId('scopes');
          const xr = byId('xray');
          log(`modes report panel=${controls.view() || 'none'} sheet=${controls.sheetOpen()} tools=${getToolCount()} ` +
            `bar=${['play', 'prev', 'next', 'seek', 'mute', 'volume', 'time', 'tracks', 'startCompareBtn', 'infoBtn', 'rate', 'cog', 'picBtn', 'full'].map((k) => `${k}:${vis(ui[k] || byId(k)) ? 1 : 0}`).join(',')} ` +
            `scopes=${scopes.mode() || 'off'} scopesVisible=${vis(sc)} info=${controls.view() === 'info'} xray=${vis(xr)} zoomed=${stage.classList.contains('zoom')} picture=${insp.picture().mode} ` +
            `frame=${p.currentFrame() + 1} t=${p.currentTime().toFixed(3)} playing=${p.isPlaying()}`);
        }, m.delay || 300);
      }
      if (m.action === 'wcprobe') {
        wcProbe(win, doc, activeProbeCleanups).then(
          (r) => { if (!disposed) log(`wcprobe ${JSON.stringify(r)}`); },
          (err) => { if (!disposed) log(`wcprobe failed: ${err}`); },
        );
      }
      if (m.action === 'report') {
        scheduleTimeout(() => {
          const p = getPlayer();
          if (!p) return;
          log(`report frame=${p.currentFrame() + 1} frames=${p.n || '-'} t=${p.currentTime().toFixed(3)} playing=${p.isPlaying()} rate=${p.rate} sources=${p.sources ? p.sources.size : '-'} master=${p.audioMaster ? p.audioMaster() : '-'} ac=${p.ac ? p.ac.state : '-'} amode=${p.amode}`);
        }, m.delay || 300);
      }
    }

    const nav = win.navigator || globalThis.navigator;
    log(`webview env: crossOriginIsolated=${win.crossOriginIsolated} SharedArrayBuffer=${typeof SharedArrayBuffer} cores=${nav ? nav.hardwareConcurrency : undefined}`);

    const statusTimer = setIntervalFn(() => {
      if (disposed) return;
      const player = getPlayer();
      if (!player) return;
      let s = `status frame=${player.currentFrame()} t=${player.currentTime().toFixed(2)} playing=${player.isPlaying()}`;
      if (isLibav(player)) {
        const q = player.queue;
        const shownNow = player.shownCount || 0;
        const fpsShown = ((shownNow - (player.__lastShown || 0)) / 2).toFixed(1);
        player.__lastShown = shownNow;
        // Native frames: received per second (and MB/s), CPU time of drawing one (upload + draw calls).
        const g = player.gl;
        if (player.cfg.native && g && !g.__timed) {
          g.__timed = { ms: 0, n: 0 };
          const draw = g.drawYuv.bind(g);
          g.drawYuv = (/** @type {any} */ f) => { const t0 = perf.now(); draw(f); g.__timed.ms += perf.now() - t0; g.__timed.n++; };
        }
        if (player.cfg.native && player.ndvStats) {
          // Native frames received (by message or from the frame server), per second over the 2 s.
          const d = player.ndvStats;
          const tm = g && g.__timed;
          s += ` ndv=${(d.n / 2).toFixed(1)}fps/${(d.bytes / 2e6).toFixed(0)}MB/s draw=${tm && tm.n ? (tm.ms / tm.n).toFixed(1) : '-'}ms`;
          player.ndvStats = { n: 0, bytes: 0 };
          if (tm) { tm.ms = 0; tm.n = 0; }
        }
        s += ` shownFps=${fpsShown} v=${player.vmode} a=${player.amode} fps=${player.fps} queued=${q.length}${q.length ? `(${player.rel(q[0].t).toFixed(2)}-${player.rel(q[q.length - 1].t).toFixed(2)})` : ''} audio=${player.audio.length} playingSources=${player.sources.size} eof=${player.eof} ac=${player.ac ? player.ac.state : '-'} clock=${player.audioMaster() ? 'audio' : 'timer'} drift=${player.audioMaster() && player.shownT !== null ? ((player.now() - player.shownT) * 1000).toFixed(0) + 'ms' : '-'} canvas=${canvas.width}x${canvas.height}`;
      } else {
        s += ` shown=${player.shown} cached=${player.bitmaps.size} canvas=${canvas.width}x${canvas.height}`;
      }
      log(s);
    }, 2000);

    if (win.addEventListener) {
      win.addEventListener('message', onMessage);
      win.addEventListener('error', onError);
      win.addEventListener('unhandledrejection', onRejection);
    }
    wake();

    function dispose() {
      if (disposed) return;
      disposed = true;
      if (rafId !== null) {
        caf(rafId);
        rafId = null;
      }
      clearIntervalFn(statusTimer);
      for (const id of pendingTimers) clearTimeoutFn(id);
      pendingTimers.clear();
      for (const cancel of Array.from(activeProbeCleanups)) cancel();
      activeProbeCleanups.clear();
      prev = null;
      if (win.removeEventListener) {
        win.removeEventListener('message', onMessage);
        win.removeEventListener('error', onError);
        win.removeEventListener('unhandledrejection', onRejection);
      }
    }

    return {
      wake,
      noteError,
      telemetry: snapshotTelemetry,
      resetTelemetry,
      dispose,
    };
  }

  const api = {
    install,
    DEBUG_PROBES,
    BACKWARD_CLOCK_TOLERANCE_SEC,
    BACKWARD_BEHIND_TOLERANCE_SEC,
    FORWARD_CLOCK_TOLERANCE_SEC,
  };

  const commonJs = /** @type {{ exports?: typeof api } | undefined} */ (
    // @ts-ignore The webview has no CommonJS globals.
    typeof module === 'undefined' ? undefined : module
  );
  if (commonJs) commonJs.exports = api;
  else /** @type {typeof globalThis & { VpeDebugProbe?: typeof api }} */ (globalThis).VpeDebugProbe = api;
  // checkJs: end
})();
