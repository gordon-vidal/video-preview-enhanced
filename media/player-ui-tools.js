// @ts-check
// The player's tool controllers as small DOM controllers, lifted out of media/player.js / media/compare.js so the
// real page and the mockup harness (tools/mockup/) can share them and a Node test (test/host/player_ui_tools_test.js)
// drives them on the strict fake DOM (test/host/fake-dom.js):
//
//   createNoticeController      the #notice banner (action / Settings / Don't show again / ×), reduced-resolution,
//                               slow-playback and A-B clip refusal variants, persisted dismissals, Esc, one banner at
//                               a time by priority with a pending queue (docs/notes/notifications.md)
//   shouldSuppressToast         drops a #toast that repeats the open banner or the bottom bar's Live chip
//   createInspectionController  Scopes (W), pixel inspector (X), stats overlay (Shift+I), Codec X-ray (Shift+X) with
//                               keyframe ({ }) and chapter (PageUp / PageDown) steps, Esc order
//   createSubtitleController    subtitle track, delay (G / H), size, the CC button, cue placement in the picture
//   createFrameExportController save / copy frame, copy timestamp / link, the A-B export protocol with the host
//
// Zero VS Code, zero decoder coupling: the DOM, the engine (an adapter over the decoders), the host (postMessage)
// and the widgets come in as arguments. Optional engine methods may be missing: the controllers then say so in a
// toast (or do nothing) instead of throwing.
'use strict';

(() => {
  // checkJs: start
  /** @typedef {{ postMessage: (m: any) => void }} Host */
  /** @typedef {(text: string, ms?: number) => void} Toast */
  /** @typedef {{ x: number, y: number, w: number, h: number }} Rect */
  /**
   * @typedef {object} NoticeButton
   * @property {string} label
   * @property {string} [id] host action id (onAction)
   * @property {string} [title]
   * @property {boolean} [close] closes the banner after the action
   * @property {() => void} [run] runs instead of onAction
   */
  /**
   * @typedef {object} Notice
   * @property {string} text
   * @property {string} [kind] also picks the priority (NOTICE_PRIORITY); unknown kinds rank as 'info'
   * @property {string} [key] dedupe key in the pending queue (default: kind)
   * @property {NoticeButton | null} [action]
   * @property {NoticeButton | null} [settings]
   * @property {NoticeButton | null} [hide]
   * @property {() => void} [dismiss] any close (the close button, Esc, a closing action)
   * @property {() => void} [onClose] the close button and Esc only
   */

  const noop = () => {};
  /** @param {any} e */
  const errText = (e) => String((e && e.message) || e);
  /** @param {any} fn @param {any} [fallback] */
  const attempt = (fn, fallback = null) => { try { return fn(); } catch { return fallback; } };

  // ---- 1. the notice banner -------------------------------------------------------------------------------------

  /** The ids inside #notice (src/player-html.js); missing ones are created so a bare container also works. */
  const NOTICE_PARTS = [['text', 'noticeText', 'span'], ['action', 'noticeAction', 'button'],
    ['settings', 'noticeSettings', 'button'], ['hide', 'noticeHide', 'button'], ['close', 'noticeClose', 'button']];
  /** Pointer events on the banner must not reach the stage (a click there toggles play). */
  const NOTICE_SWALLOW = ['click', 'dblclick', 'pointerdown', 'pointerup', 'mousedown', 'mouseup', 'wheel'];
  /**
   * One banner at a time: a notice the user must act on (an error, a refused A-B clip) beats the pixel-accuracy offer,
   * which beats the decoder's speed advice, which beats plain information. Higher preempts lower (the lower one waits
   * in the queue); lower waits behind higher; equal replaces (the replaced one waits).
   * @type {Readonly<Record<string, number>>}
   */
  const NOTICE_PRIORITY = Object.freeze({ error: 3, clipRefusal: 3, reducedRes: 2, slowPlayback: 1, info: 0 });
  /** @param {Notice | null | undefined} n */
  const priorityOf = (n) => (n && n.kind && NOTICE_PRIORITY[n.kind] !== undefined ? NOTICE_PRIORITY[n.kind] : 0);
  /** @param {Notice} n */
  const keyOf = (n) => n.key || n.kind || '';
  /** The state class on the banner's container while it shows: player.css moves #toast clear of it. */
  const NOTICE_OPEN_CLASS = 'notice-open';

  /**
   * @param {object} env
   * @param {any} env.doc
   * @param {any} [env.win]
   * @param {any} env.noticeEl
   * @param {any} [env.playBtnEl] gets the focus back when the banner closes with the focus in it
   * @param {any} [env.stageEl] gets the notice-open class while the banner shows (default: the banner's parent)
   * @param {(video: any, stream: any, display: any) => Notice} [env.reducedResHelper] media/reduced-res-notice.js
   * @param {(variant: any, offerSetup?: boolean, mb?: number) => any} [env.slowHelper] media/slow-notice.js
   * @param {(id: string, detail?: any) => void} [env.onAction] host actions ({ type: 'action', id } in production)
   * @param {(kind: string, dismissals: Record<string, boolean>) => void} [env.onDismiss] persist the dismissals
   * @param {(text: string) => void} [env.onAnnounce] the polite live region
   * @param {Record<string, boolean>} [env.dismissals] persisted state: { reducedRes, slowPlayback }
   */
  function createNoticeController(env) {
    const { doc, noticeEl, playBtnEl } = env;
    const stageEl = env.stageEl || noticeEl.parentElement || null;
    const onAction = env.onAction || noop;
    const onDismiss = env.onDismiss || noop;
    const onAnnounce = env.onAnnounce || noop;
    /** @type {Record<string, any>} */
    const parts = {};
    for (const [key, id, tag] of NOTICE_PARTS) {
      let el = noticeEl.querySelector(`#${id}`);
      if (!el) {
        el = doc.createElement(tag);
        el.id = id;
        if (key === 'close') { el.textContent = '×'; el.title = 'Dismiss'; el.setAttribute('aria-label', 'Dismiss'); }
        noticeEl.appendChild(el);
      }
      parts[key] = el;
    }
    /** @type {Record<string, boolean>} */
    let dismissals = { ...(env.dismissals || {}) };
    /** @type {Notice | null} */
    let current = null;
    let reducedOffered = false;
    /** Slow-playback notice kinds shown on this page ('slow' or 'setupFfmpeg'): each once. */
    const slowWarned = new Set();
    /** @type {Notice[]} notices waiting behind `current`, deduped by key */
    let pending = [];
    /** What plays now: Live transcode / remote streaming make the local decoder's speed advice irrelevant. */
    let context = { transcoded: false, streaming: false };
    /** @type {any} */
    let resizeObs = null;

    const swallow = (/** @type {any} */ e) => e.stopPropagation();
    for (const t of NOTICE_SWALLOW) noticeEl.addEventListener(t, swallow);

    /** The banner's bottom edge for player.css (#toast sits under it, even when the text wraps to two lines). */
    function measure() {
      if (!stageEl || !stageEl.style || noticeEl.hidden) return;
      const h = noticeEl.offsetHeight;
      if (typeof h === 'number' && h > 0) {
        stageEl.style.setProperty('--notice-bottom', `${(noticeEl.offsetTop || 0) + h}px`);
      }
    }
    /** @param {boolean} open */
    function setOpen(open) {
      noticeEl.hidden = !open;
      if (stageEl && stageEl.classList) stageEl.classList.toggle(NOTICE_OPEN_CLASS, open);
      if (open) {
        measure();
        const RO = env.win && env.win.ResizeObserver;
        if (RO && !resizeObs) { resizeObs = new RO(measure); resizeObs.observe(noticeEl); }
      } else {
        if (resizeObs) { resizeObs.disconnect(); resizeObs = null; }
        if (stageEl && stageEl.style) stageEl.style.removeProperty('--notice-bottom');
      }
    }

    /** @param {Notice} n */
    function enqueue(n) {
      pending = pending.filter((p) => keyOf(p) !== keyOf(n));
      pending.push(n);
    }
    /** A waiting notice that may no longer show: dismissed meanwhile, or slow advice during Live transcode. */
    function stale(/** @type {Notice} */ n) {
      if (n.kind && dismissals[n.kind]) return true;
      return n.kind === 'slowPlayback' && (context.transcoded || context.streaming);
    }
    /** The highest-priority waiting notice (first come first among equals), or null. */
    function takeNext() {
      pending = pending.filter((p) => !stale(p));
      if (!pending.length) return null;
      let best = 0;
      for (let i = 1; i < pending.length; i++) if (priorityOf(pending[i]) > priorityOf(pending[best])) best = i;
      return pending.splice(best, 1)[0];
    }

    /** @param {boolean} [refocus] always return the focus to Play (Esc) */
    function close(refocus = false) {
      if (!current) return;
      const n = current;
      const back = refocus || noticeEl.contains(doc.activeElement);
      current = null;
      setOpen(false);
      if (n.dismiss) n.dismiss();
      if (back && playBtnEl) playBtnEl.focus();
      const next = takeNext();
      if (next) display(next);
    }
    /** @param {boolean} [refocus] */
    function closeByUser(refocus = false) {
      const n = current;
      if (!n) return;
      if (n.onClose) n.onClose();
      close(refocus);
    }
    parts.close.onclick = () => closeByUser();

    /**
     * Offer a notice. A lower-priority one waits behind the open banner (never flashes over it); an equal or higher
     * one takes the banner and the replaced one waits (unless it has the same key: then it is simply updated).
     * @param {Notice} n
     * @returns {boolean} true when it shows now, false when it waits in the queue
     */
    function show(n) {
      if (current && keyOf(current) !== keyOf(n)) {
        if (priorityOf(n) < priorityOf(current)) { enqueue(n); return false; }
        enqueue(current);
      }
      pending = pending.filter((p) => keyOf(p) !== keyOf(n));
      display(n);
      return true;
    }

    /** @param {Notice} n */
    function display(n) {
      current = n;
      parts.text.textContent = n.text;
      onAnnounce(n.text);
      for (const key of ['action', 'settings', 'hide']) {
        const button = parts[key];
        /** @type {NoticeButton | null | undefined} */
        const a = /** @type {any} */ (n)[key];
        button.hidden = !a;
        button.title = (a && a.title) || '';
        button.onclick = null;
        if (!a) continue;
        button.textContent = a.label;
        button.onclick = () => {
          if (a.run) a.run();
          else if (a.id) onAction(a.id);
          if (a.close) close();
        };
      }
      noticeEl.dataset.kind = n.kind || '';
      setOpen(true);
    }

    /** @param {string} kind */
    function persist(kind) {
      if (dismissals[kind]) return;
      dismissals = { ...dismissals, [kind]: true };
      onDismiss(kind, { ...dismissals });
    }

    /**
     * Pixel tools on a picture that native ffmpeg scaled down or reduced to 8-bit, or that Live transcode re-encoded:
     * offer the exact pixels, once per page; any close of this banner is remembered.
     * @param {{ reason?: string, nativeLossy?: boolean, transcoded?: boolean, video?: any, stream?: any,
     *   display?: any }} o
     * @returns {boolean} offered (shown now, or waiting behind a higher-priority banner)
     */
    function maybeShowReducedRes(o) {
      if (dismissals.reducedRes || reducedOffered || !(o.nativeLossy || o.transcoded)) return false;
      const helper = env.reducedResHelper;
      /** @type {Notice} */
      const base = helper ? helper(o.video || {}, o.transcoded ? (o.stream || {}) : null, o.display || null) : {
        text: 'Playing a reduced picture for smooth playback.',
        action: { label: 'Use full resolution (this tab)', id: 'fullRes' },
        settings: { label: 'Settings', id: o.transcoded ? 'transcodeSettings' : 'nativeResolutionSettings' },
        hide: { label: "Don't show again", id: 'hideReducedResNotice', close: true },
      };
      reducedOffered = true;
      show({ ...base, kind: 'reducedRes', dismiss: () => persist('reducedRes') });
      return true;
    }

    /**
     * The decoder's slow-playback hint: each kind once per page; × remembers it for the page's state. Never during
     * Live transcode or remote streaming (per call or setContext): the bar's Live chip owns that state, and the
     * local decoder's advice (skip frames, set up ffmpeg) does not apply to it.
     * @param {string | { variant: string, offerSetup?: boolean, mb?: number, transcoded?: boolean,
     *   streaming?: boolean }} slowNotice
     * @returns {boolean} offered (shown now, or waiting behind a higher-priority banner)
     */
    function maybeShowSlowPlayback(slowNotice) {
      const o = typeof slowNotice === 'string' ? { variant: slowNotice } : slowNotice || /** @type {any} */ ({});
      if (!o.variant || dismissals.slowPlayback || !env.slowHelper) return false;
      if (o.transcoded || o.streaming || context.transcoded || context.streaming) return false;
      const kind = o.variant === 'setupFfmpeg' ? 'setupFfmpeg' : 'slow';
      if (slowWarned.has(kind)) return false;
      slowWarned.add(kind);
      const n = env.slowHelper(o.variant, !!o.offerSetup, o.mb);
      if (!n) return false;
      const value = n.whenSlow;
      show({
        ...n,
        kind: 'slowPlayback',
        action: value && n.action ? { ...n.action, run: () => onAction('whenSlow', { value }) } : n.action,
        onClose: () => persist('slowPlayback'),
      });
      return true;
    }

    /**
     * What plays now. Switching to Live transcode or streaming drops a shown or waiting slow-playback notice.
     * @param {{ transcoded?: boolean, streaming?: boolean }} c
     */
    function setContext(c) {
      context = { transcoded: !!(c && c.transcoded), streaming: !!(c && c.streaming) };
      if (!context.transcoded && !context.streaming) return;
      pending = pending.filter((p) => p.kind !== 'slowPlayback');
      if (current && current.kind === 'slowPlayback') close();
    }

    /**
     * An exact A-B clip needs the file's own picture times: Live transcode and some native ffmpeg do not have them.
     * @param {{ syntheticTimes?: boolean, transcoded?: boolean }} [o]
     */
    function showClipRefusal(o = {}) {
      const transcode = !!o.transcoded;
      return show({
        kind: 'clipRefusal',
        text: transcode
          ? 'Live transcode re-times the picture, so A and B cannot be used for an exact clip. ' +
            'Switch to the original video and set A and B again.'
          : "This ffmpeg cannot report the picture's own times, so A and B cannot be used for an exact clip. " +
            'Switch to the built-in decoder and set A and B again.',
        action: { label: transcode ? 'Use original video' : 'Switch to built-in decoder', id: 'fullRes', close: true },
      });
    }

    /** @param {any} e */
    function onKeyDown(e) {
      if (e.key !== 'Escape' || !current) return;
      e.preventDefault();
      e.stopPropagation();
      closeByUser(true);
    }
    doc.addEventListener('keydown', onKeyDown);

    return {
      show, maybeShowReducedRes, maybeShowSlowPlayback, showClipRefusal, setContext,
      /**
       * Withdraw `kind` (shown or waiting; the next waiting notice then shows), or with no kind clear everything.
       * @param {string} [kind]
       */
      hide(kind) {
        pending = kind ? pending.filter((p) => p.kind !== kind) : [];
        if (current && (!kind || current.kind === kind)) close();
      },
      /** Esc from the page's own key handler; true when it closed the banner. */
      handleEscape() { if (!current) return false; closeByUser(true); return true; },
      isOpen: () => !!current,
      kind: () => (current ? current.kind || '' : null),
      /** Kinds waiting behind the banner, in queue order. */
      pendingKinds: () => pending.map((p) => p.kind || ''),
      /**
       * shouldSuppressToast with this banner's state filled in.
       * @param {string} text
       * @param {{ liveChipVisible?: boolean }} [o]
       */
      shouldSuppressToast: (text, o = {}) => shouldSuppressToast(text, {
        ...o, noticeOpen: !!current, noticeText: current ? current.text : '',
      }),
      getDismissals: () => ({ ...dismissals }),
      /** @param {Record<string, boolean>} d */
      setDismissals(d) { dismissals = { ...(d || {}) }; },
      dispose() {
        doc.removeEventListener('keydown', onKeyDown);
        for (const t of NOTICE_SWALLOW) noticeEl.removeEventListener(t, swallow);
        if (resizeObs) { resizeObs.disconnect(); resizeObs = null; }
        pending = [];
      },
    };
  }

  /** Status toasts that only restate what the bottom bar's Live chip already shows. User confirmations stay. */
  const LIVE_STATUS_TOAST =
    /^(playing (a |as )?live transcode|live transcode (started|running|active|is on)|transcoding\b|streaming\b)/;
  /** @param {string} s */
  const squash = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').replace(/[.…!]+$/, '').trim();

  /**
   * True when a #toast would only repeat what is already on screen: the open #notice banner (the same words, or a
   * fragment of them) or the bar's Live chip (a Live transcode status line). Confirmations of a user action
   * ("Live transcode: auto", "Frame copied") never match. Empty text is always suppressed.
   * @param {string} text
   * @param {{ noticeOpen?: boolean, noticeText?: string, liveChipVisible?: boolean }} [o]
   */
  function shouldSuppressToast(text, o = {}) {
    const t = squash(text);
    if (!t) return true;
    if (o.liveChipVisible && LIVE_STATUS_TOAST.test(t)) return true;
    if (o.noticeOpen && o.noticeText) {
      const n = squash(o.noticeText);
      if (t === n || (t.length >= 12 && n.includes(t))) return true;
    }
    return false;
  }

  // ---- 2. inspection: scopes, pixel inspector, stats, Codec X-ray ---------------------------------------------------

  const SCOPE_MODES = ['waveform', 'parade', 'vector', 'histogram'];
  /** @type {Record<string, string>} */
  const SCOPE_NAMES = { waveform: 'Luma waveform', parade: 'RGB parade', vector: 'Vectorscope', histogram: 'Histogram' };
  const INSPECTOR_MODES = ['loupe', 'readout'];
  const STATS_MS = 250;

  /** True for keys typed into a text field (those are not shortcuts). @param {any} t */
  const typing = (t) => !!t && (t.localName === 'input' || t.localName === 'textarea' || t.isContentEditable === true);

  /**
   * @param {object} env
   * @param {any} env.doc
   * @param {any} env.win
   * @param {any} env.engine statsText(id), packetIndex(id), chapters(id), pixelAt(id, x, y): all optional
   * @param {Host} [env.host]
   * @param {{ scopes?: any, inspector?: any, stats?: any, xray?: any }} [env.widgets] scopes.setMode(mode | null),
   *   inspector.setMode(mode | null), stats: the overlay element, xray.show(packets) / hide(); all optional
   * @param {() => any} [env.getActiveClip] the clip id the tools read (compare: the focused tile)
   * @param {() => { frame: number, t: number }} [env.getFrame] the shown frame and its time (s)
   * @param {Toast} [env.onToast]
   * @param {(t: number) => void} [env.onSeek]
   * @param {(tool: string) => void} [env.onBeforeInspect] the reduced-resolution offer (exactTool)
   * @param {() => boolean} [env.isSingle] X belongs to the inspector only in the single player
   * @param {boolean} [env.listen] listen to keydown on `doc` (default true)
   */
  function createInspectionController(env) {
    const { doc, win, engine } = env;
    const widgets = env.widgets || {};
    const toast = env.onToast || noop;
    const onSeek = env.onSeek || noop;
    const before = env.onBeforeInspect || noop;
    const clip = env.getActiveClip || (() => 0);
    const frameNow = env.getFrame || (() => ({ frame: 0, t: 0 }));
    const isSingle = env.isSingle || (() => true);
    const has = (/** @type {string} */ name) => !!engine && typeof engine[name] === 'function';

    let scope = -1;
    let inspector = -1;
    let statsOn = false;
    /** @type {any} */
    let statsTimer = 0;
    let xrayOn = false;
    /** @type {any[] | null} */
    let packets = null;
    /** @type {Promise<any[] | null | undefined> | null} */
    let packetsLoading = null;
    /** The clip `packets` / `packetsLoading` belong to. */
    let packetsClip = /** @type {any} */ (null);
    /** Bumped on a clip change and on dispose: an index request that started before answers nobody. */
    let packetsReq = 0;
    let disposed = false;

    let statsEl = widgets.stats;
    if (!statsEl) {
      statsEl = doc.createElement('pre');
      statsEl.className = 'stats';
      statsEl.hidden = true;
      doc.body.appendChild(statsEl);
    }

    function setScope(/** @type {number} */ m) {
      scope = m;
      if (widgets.scopes && widgets.scopes.setMode) widgets.scopes.setMode(m < 0 ? null : SCOPE_MODES[m]);
    }
    function cycleScopes() {
      before('scopes');
      setScope(scope + 1 >= SCOPE_MODES.length ? -1 : scope + 1);
      toast(scope < 0 ? 'Scopes off' : SCOPE_NAMES[SCOPE_MODES[scope]]);
    }

    function setInspector(/** @type {number} */ m) {
      inspector = m;
      if (widgets.inspector && widgets.inspector.setMode) widgets.inspector.setMode(m < 0 ? null : INSPECTOR_MODES[m]);
    }
    function cycleInspector() {
      before('inspector');
      const next = inspector + 1 >= INSPECTOR_MODES.length ? -1 : inspector + 1;
      setInspector(next);
      toast(next === 0 ? 'Pixel inspector: click copies the value (X again: no loupe)'
        : next === 1 ? 'Pixel inspector without loupe' : 'Pixel inspector off');
    }
    /**
     * A click on the picture while the inspector is on copies the pixel under it. True when handled.
     * @param {number} x @param {number} y picture coordinates
     */
    function pickAt(x, y) {
      if (inspector < 0) return false;
      if (!has('pixelAt')) { toast('Pixel values are not available for this video'); return true; }
      /** @type {any} */
      const px = attempt(() => engine.pixelAt(clip(), x, y));
      const text = px && (typeof px === 'string' ? px : px.text);
      if (!text) { toast('No pixel here'); return true; }
      if (env.host) env.host.postMessage({ type: 'copyText', text });
      toast('Pixel value copied');
      return true;
    }

    function drawStats() {
      if (!statsOn) return;
      try { statsEl.textContent = String(engine.statsText(clip())); } catch (e) { statsEl.textContent = `stats: ${errText(e)}`; }
    }
    function stopStats() { if (statsTimer) win.clearInterval(statsTimer); statsTimer = 0; }
    /** @param {boolean} [on] */
    function toggleStats(on) {
      const want = on === undefined ? !statsOn : !!on;
      if (want && !has('statsText')) { toast('Stats are not available for this video'); return; }
      statsOn = want;
      statsEl.hidden = !statsOn;
      stopStats();
      if (statsOn) { drawStats(); statsTimer = win.setInterval(drawStats, STATS_MS); }
    }

    /** Forget the packet index and let no request in flight store or act on its answer. */
    function dropPackets() {
      packetsReq++;
      packets = null;
      packetsLoading = null;
      packetsClip = null;
    }
    /**
     * The packet index, read once per clip (the engine may answer with a promise). Resolves with `undefined` when the
     * answer came too late (the clip changed or the page went meanwhile): callers then do nothing.
     * @returns {Promise<any[] | null | undefined>}
     */
    function loadPackets() {
      const clipId = clip();
      // Compare can change the active tile without a refresh: another clip's index is not this one's.
      if (packetsClip !== clipId && (packets || packetsLoading)) dropPackets();
      if (packets) return Promise.resolve(packets);
      if (!has('packetIndex')) return Promise.resolve(null);
      if (!packetsLoading) {
        const req = packetsReq;
        /** True when this answer is still wanted; a request of the current generation for a clip no longer shown
         * also lets go of the slot, so a return to that clip asks again. */
        const current = () => {
          if (disposed || req !== packetsReq) return false;
          if (clip() === clipId) return true;
          packetsLoading = null;
          packetsClip = null;
          return false;
        };
        packetsClip = clipId;
        packetsLoading = Promise.resolve().then(() => engine.packetIndex(clipId)).then(
          (list) => {
            if (!current()) return undefined;
            packets = Array.isArray(list) ? list : null;
            packetsLoading = null;
            return packets;
          },
          () => {
            if (!current()) return undefined;
            packetsLoading = null;
            return null;
          });
      }
      return packetsLoading;
    }
    /** @param {boolean} [on] @returns {Promise<void>} */
    function toggleXray(on) {
      const want = on === undefined ? !xrayOn : !!on;
      if (want && !has('packetIndex')) {
        toast('Codec X-ray needs the built-in decoder engine (not used for this file)');
        return Promise.resolve();
      }
      xrayOn = want;
      toast(xrayOn ? 'Codec X-ray on (Shift+X)' : 'Codec X-ray off');
      if (!xrayOn) { if (widgets.xray && widgets.xray.hide) widgets.xray.hide(); return Promise.resolve(); }
      return loadPackets().then((list) => {
        if (list === undefined) return; // a late answer for another clip
        if (xrayOn && widgets.xray && widgets.xray.show) widgets.xray.show(list || []);
      });
    }
    /** { / }: the previous or next keyframe. @param {number} dir @returns {Promise<void>} */
    function stepKey(dir) {
      if (!has('packetIndex')) { toast('Keyframe steps need the built-in decoder engine'); return Promise.resolve(); }
      return loadPackets().then((list) => {
        if (list === undefined) return; // a late answer for another clip: never seek this one
        const keys = (list || []).filter((p) => p && p.key).map((p) => Number(p.t)).filter(Number.isFinite)
          .sort((a, b) => a - b);
        if (!keys.length) { toast('No keyframe index for this file'); return; }
        const cur = frameNow().t;
        const eps = 1e-6;
        const target = dir > 0 ? keys.find((t) => t > cur + eps) : [...keys].reverse().find((t) => t < cur - eps);
        if (target === undefined) { toast(dir > 0 ? 'No later keyframe' : 'No earlier keyframe'); return; }
        onSeek(target);
      });
    }
    /** PageUp / PageDown: the chapter start before or after the shown time (as media/xray.js). @param {number} dir */
    function stepChapter(dir) {
      /** @type {any[]} */
      const ch = has('chapters') ? attempt(() => engine.chapters(clip()), []) || [] : [];
      if (!ch.length) { toast('No chapters in this file'); return; }
      const cur = frameNow().t;
      let target = null;
      if (dir > 0) target = ch.find((c) => c.start > cur + 0.05);
      // Back to the start of this chapter, or to the previous one when near its start.
      else for (let i = ch.length - 1; i >= 0; i--) if (ch[i].start < cur - 1) { target = ch[i]; break; }
      if (!target) { if (dir < 0) { onSeek(0); toast('Start'); } else toast('Last chapter'); return; }
      onSeek(Math.max(0, target.start));
      const n = ch.indexOf(target) + 1;
      toast(target.title ? `Chapter ${n}: ${target.title}` : `Chapter ${n}`);
    }

    /** Esc: inspector, then scopes, then X-ray (the production order). True when something closed. */
    function handleEscape() {
      if (inspector >= 0) { setInspector(-1); toast('Pixel inspector off'); return true; }
      if (scope >= 0) { setScope(-1); toast('Scopes off'); return true; }
      if (xrayOn) { toggleXray(false); return true; }
      return false;
    }

    /** The tool keys. True when handled. @param {any} e */
    function handleKey(e) {
      const altGr = !!(e.getModifierState && e.getModifierState('AltGraph'));
      if (e.metaKey || (!altGr && (e.ctrlKey || e.altKey)) || typing(e.target)) return false;
      switch (e.key) {
        case 'Escape': return handleEscape();
        case 'w': case 'W': if (e.shiftKey) return false; cycleScopes(); return true;
        case 'x': if (e.shiftKey || !isSingle()) return false; cycleInspector(); return true;
        case 'X': if (e.shiftKey) { toggleXray(); return true; } if (!isSingle()) return false; cycleInspector(); return true;
        case 'I': if (!e.shiftKey) return false; toggleStats(); return true;
        case '{': stepKey(-1); return true;
        case '}': stepKey(1); return true;
        case 'PageUp': stepChapter(-1); return true;
        case 'PageDown': stepChapter(1); return true;
        default: return false;
      }
    }
    /** @param {any} e */
    function onKeyDown(e) { if (!e.defaultPrevented && handleKey(e)) e.preventDefault(); }
    const listen = env.listen !== false;
    if (listen) doc.addEventListener('keydown', onKeyDown);

    return {
      handleKey, handleEscape, cycleScopes, cycleInspector, toggleStats, toggleXray, stepKey, stepChapter, pickAt,
      /** A new clip or frame: the stats text now, the packet index again for another clip. @param {{ clipChanged?: boolean }} [o] */
      refresh(o = {}) {
        if (o.clipChanged) { dropPackets(); if (xrayOn) toggleXray(true); }
        drawStats();
        if (scope >= 0) setScope(scope);
      },
      isAnyOpen: () => scope >= 0 || inspector >= 0 || statsOn || xrayOn,
      getState: () => ({
        scopes: scope < 0 ? null : SCOPE_MODES[scope],
        inspector: inspector < 0 ? null : INSPECTOR_MODES[inspector],
        stats: statsOn, xray: xrayOn,
      }),
      dispose() {
        disposed = true;
        dropPackets();
        stopStats();
        if (listen) doc.removeEventListener('keydown', onKeyDown);
      },
    };
  }

  // ---- 3. subtitles --------------------------------------------------------------------------------------------

  const DELAY_STEP_MS = 50;
  const SIZE_MIN = 50;
  const SIZE_MAX = 250;
  const NO_SUBS = 'No subtitles · Load a file in Settings › Subtitles';

  /**
   * @param {object} env
   * @param {any} env.doc
   * @param {any} [env.win]
   * @param {any} env.subsEl the cue layer (#subs)
   * @param {any} env.engine cueAt(id, t, track) → string | { text } | null; selectSubtitle(id, track): optional
   * @param {Host} [env.host]
   * @param {() => any} [env.getClipId]
   * @param {() => number} [env.getTime] the shown time (s)
   * @param {() => Rect | null} [env.getPictureRect] the picture inside the stage (stage pixels)
   * @param {Toast} [env.onToast]
   * @param {(state: any) => void} [env.onUpdate] the CC button and panels redraw from getCcButtonState / getState
   * @param {(page: string) => void} [env.onOpenPage] CC with no track opens Settings › Subtitles
   * @param {{ track?: number, delayMs?: number, sizePct?: number }} [env.saved]
   */
  function createSubtitleController(env) {
    const { subsEl, engine } = env;
    const toast = env.onToast || noop;
    const onUpdate = env.onUpdate || noop;
    const clipId = env.getClipId || (() => 0);
    const time = env.getTime || (() => 0);
    const saved = env.saved || {};
    /** @type {{ name?: string, label?: string, lang?: string }[]} */
    let tracks = [];
    let track = -1;
    let lastOn = Number.isInteger(saved.track) && /** @type {number} */ (saved.track) >= 0 ? /** @type {number} */ (saved.track) : 0;
    let userOff = false;
    let delayMs = Number(saved.delayMs) || 0;
    let sizePct = clampSize(Number(saved.sizePct) || 100);
    let placed = '';

    /** @param {number} s */
    function clampSize(s) { return Math.max(SIZE_MIN, Math.min(SIZE_MAX, Math.round(s))); }
    /** @param {number} i */
    function nameOf(i) {
      const t = tracks[i];
      if (!t) return 'Off';
      return t.name || t.label || t.lang || `Track ${i + 1}`;
    }
    function changed() { render(); onUpdate(getState()); }
    /** @param {number} i @param {boolean} [user] */
    function select(i, user = true) {
      track = i >= 0 && i < tracks.length ? i : -1;
      if (track >= 0) lastOn = track;
      if (user) userOff = track < 0;
      if (engine && typeof engine.selectSubtitle === 'function') attempt(() => engine.selectSubtitle(clipId(), track));
      changed();
    }
    function nextTrack() {
      if (!tracks.length) { toast(NO_SUBS); return; }
      const next = track + 1 >= tracks.length ? -1 : track + 1;
      select(next);
      toast(next < 0 ? 'Subtitles off' : `Subtitles: ${nameOf(next)}`);
    }
    function toggle() {
      if (track >= 0) { select(-1); toast('Subtitles off'); return; }
      if (!tracks.length) { toast(NO_SUBS); return; }
      const next = lastOn < tracks.length ? lastOn : 0;
      select(next);
      toast(`Subtitles: ${nameOf(next)}`);
    }
    /** The CC button: toggles when there is a track, else opens Settings › Subtitles. @returns {'toggled' | 'page'} */
    function ccClick() {
      if (tracks.length) { toggle(); return 'toggled'; }
      if (env.onOpenPage) env.onOpenPage('subs');
      return 'page';
    }
    /** @param {number} ms */
    function setDelay(ms) {
      delayMs = Math.round(ms);
      toast(`Subtitle delay ${delayMs > 0 ? '+' : ''}${delayMs} ms`);
      changed();
    }
    /** @param {number} pct */
    function setSize(pct) {
      sizePct = clampSize(pct);
      placed = '';
      toast(`Subtitle size ${sizePct}%`);
      changed();
    }

    /** The host's answer with subtitle tracks: picks one unless the user turned subtitles off. @param {any} m */
    function onHostMessage(m) {
      if (!m || m.type !== 'subs') return false;
      const list = Array.isArray(m.tracks) ? m.tracks : [];
      const first = tracks.length;
      tracks = tracks.concat(list);
      if (list.length && (m.select || (track < 0 && !userOff))) {
        const pick = m.select ? first : Math.min(lastOn, tracks.length - 1);
        select(pick, false);
        toast(`Subtitles: ${nameOf(pick)}`);
      } else changed();
      return true;
    }

    /** Writes the cue of the shown time into the layer, at the bottom of the picture. */
    function render() {
      const hide = () => { if (!subsEl.hidden) subsEl.hidden = true; placed = ''; };
      if (track < 0 || !engine || typeof engine.cueAt !== 'function') { hide(); return; }
      /** @type {any} */
      const cue = attempt(() => engine.cueAt(clipId(), time() - delayMs / 1000, track));
      const text = cue && (typeof cue === 'string' ? cue : cue.text);
      const r = env.getPictureRect ? env.getPictureRect() : null;
      if (!text || !r || !(r.w > 0 && r.h > 0)) { hide(); return; }
      if (subsEl.textContent !== text) subsEl.textContent = text;
      const key = `${r.x}|${r.y}|${r.w}|${r.h}|${sizePct}`;
      if (key !== placed) {
        placed = key;
        const s = subsEl.style;
        // Inside the picture, never under the bar: the bottom 6% of the picture is the margin.
        s.left = `${Math.round(r.x)}px`;
        s.width = `${Math.round(r.w)}px`;
        s.bottom = '';
        s.top = `${Math.round(r.y + r.h * 0.94)}px`;
        s.transform = 'translateY(-100%)';
        s.whiteSpace = 'pre-line';
        s.fontSize = `${Math.round(Math.max(12, r.h * 0.05) * sizePct) / 100}px`;
      }
      subsEl.hidden = false;
    }

    /** The player keys. True when handled. @param {any} e */
    function handleKey(e) {
      if (e.metaKey || e.ctrlKey || e.altKey || typing(e.target)) return false;
      switch (e.key) {
        case 'v': nextTrack(); return true;
        case 'V': if (e.shiftKey) toggle(); else nextTrack(); return true;
        case 'c': toggle(); return true;
        case 'C': if (e.shiftKey) return false; toggle(); return true;
        case 'g': case 'G': setDelay(delayMs - DELAY_STEP_MS); return true;
        case 'h': case 'H': setDelay(delayMs + DELAY_STEP_MS); return true;
        default: return false;
      }
    }

    function getCcButtonState() {
      const none = !tracks.length;
      const on = track >= 0;
      const label = none ? 'Subtitles' : on ? `Subtitles on: ${nameOf(track)}` : 'Subtitles off';
      return { visible: !none, on, label, title: `${label}  C` };
    }
    function getState() {
      return { track, tracks: tracks.map((_t, i) => nameOf(i)), delayMs, sizePct, label: nameOf(track) };
    }

    return {
      ccClick, nextTrack, toggle, select: (/** @type {number} */ i) => select(i), handleKey, onHostMessage, render,
      /** @param {number} deltaMs */
      adjustDelay(deltaMs) { setDelay(delayMs + deltaMs); },
      /** @param {number} deltaPct */
      adjustSize(deltaPct) { setSize(sizePct + deltaPct); },
      resetDelay() { setDelay(0); },
      resetSize() { setSize(100); },
      getCcButtonState, getState,
      dispose() { subsEl.hidden = true; },
    };
  }

  // ---- 4. frame save / copy and the A-B export protocol --------------------------------------------------------

  const EXPORT_FRAME_TIMEOUT_MS = 20000;

  /** m:ss.mmm (h:mm:ss.mmm from an hour). @param {number} t seconds */
  function fmtStamp(t) {
    const ms = Math.max(0, Math.round((Number(t) || 0) * 1000));
    const h = Math.floor(ms / 3600000);
    const m = Math.floor(ms / 60000) % 60;
    const s = Math.floor(ms / 1000) % 60;
    const frac = String(ms % 1000).padStart(3, '0');
    const ss = String(s).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${ss}.${frac}` : `${m}:${ss}.${frac}`;
  }

  /**
   * @typedef {object} FrameContext
   * @property {any} [clipId]
   * @property {number} frame the shown frame, 0-based
   * @property {number} t its time (s)
   * @property {number} [fps]
   * @property {boolean} [transcoded] Live transcode pixels
   * @property {boolean} [compare] copies say "View"
   * @property {any} [page] the page id the host tags messages with
   */
  /**
   * @param {object} env
   * @param {any} [env.win] navigator.clipboard, ClipboardItem, Blob, setTimeout, AbortController
   * @param {any} env.engine snapshot(id) → Blob | Uint8Array | null; showFrame(id, k, { signal }) → frame | null
   * @param {Host} env.host
   * @param {(clipId?: any) => FrameContext | null} env.getContext
   * @param {Toast} [env.onToast]
   * @param {(clipId?: any) => void} [env.onPause]
   * @param {(what: string) => void} [env.onBeforeSnapshot] the reduced-resolution offer (exactTool)
   * @param {(kind: string) => any} [env.getRange] the A-B range for an export kind, or null
   * @param {(range: any) => void} [env.onRefuse] an exact clip refused (synthetic picture times)
   * @param {(text: string) => void} [env.log]
   */
  function createFrameExportController(env) {
    const win = env.win || {};
    const { engine, host } = env;
    const toast = env.onToast || noop;
    const pause = env.onPause || noop;
    const before = env.onBeforeSnapshot || noop;
    const log = env.log || noop;
    const G = /** @type {any} */ (globalThis);
    const BlobCtor = win.Blob || G.Blob;
    const AbortCtor = win.AbortController || G.AbortController;
    // Called as methods: a window's timers need their `this`.
    const timers = win.setTimeout ? win : G;
    const setT = (/** @type {() => void} */ fn, /** @type {number} */ ms) => timers.setTimeout(fn, ms);
    const clearT = (/** @type {any} */ id) => timers.clearTimeout(id);
    let exportAbort = new AbortCtor();
    let disposed = false;
    /** @type {Promise<void>} */
    let exportChain = Promise.resolve();

    /** @param {any} clipId */
    const ctxOf = (clipId) => env.getContext(clipId) || null;
    /** @param {any} ctx @param {any} m */
    const tag = (ctx, m) => (ctx && ctx.page !== undefined ? { ...m, page: ctx.page } : m);
    /** @param {any} x @returns {Promise<Uint8Array>} */
    async function bytesOf(x) {
      if (x instanceof Uint8Array) return x;
      if (x && typeof x.arrayBuffer === 'function') return new Uint8Array(await x.arrayBuffer());
      if (x instanceof ArrayBuffer) return new Uint8Array(x);
      throw new Error('no picture');
    }

    /**
     * The shown frame's PNG with its number, the number taken before any await (stepping meanwhile must not label
     * this frame's pixels with another number). null: nothing to grab, or the frame changed meanwhile.
     * @param {any} clipId @param {string} what
     */
    async function grab(clipId, what) {
      const ctx = ctxOf(clipId);
      if (!ctx) return null;
      if (!engine || typeof engine.snapshot !== 'function') { toast('Frames cannot be saved from this video'); return null; }
      const frame = ctx.frame;
      const pic = await engine.snapshot(ctx.clipId !== undefined ? ctx.clipId : clipId);
      if (!pic) return null;
      const now = ctxOf(clipId);
      if (!now || now.frame !== frame) { toast(`${what} cancelled: the frame changed`, 2000); return null; }
      return { frame, pic, ctx };
    }

    /** @param {any} [clipId] @returns {Promise<boolean>} */
    async function saveFrame(clipId) {
      before('save');
      pause(clipId);
      const got = await grab(clipId, 'Save');
      if (!got) return false;
      host.postMessage(tag(got.ctx, { type: 'saveFrame', frame: got.frame, data: await bytesOf(got.pic) }));
      return true;
    }
    /** @param {any} [clipId] @returns {Promise<boolean>} */
    async function copyFrame(clipId) {
      before('copy');
      pause(clipId);
      let got = null;
      try {
        got = await grab(clipId, 'Copy');
        if (!got) return false;
        const blob = BlobCtor && got.pic instanceof BlobCtor ? got.pic : new BlobCtor([await bytesOf(got.pic)], { type: 'image/png' });
        const clipboard = win.navigator && win.navigator.clipboard;
        if (!clipboard || typeof win.ClipboardItem !== 'function') throw new Error('no clipboard');
        await clipboard.write([new win.ClipboardItem({ 'image/png': blob })]);
        const what = got.ctx.compare ? 'View' : 'Frame';
        if (got.ctx.transcoded) toast(`${what} copied with transcoded pixels. For the original, see About.`, 4000);
        else toast(`${what} copied`);
        return true;
      } catch (e) {
        log(`clipboard refused: ${errText(e)}`);
        toast('Copy not allowed here; saving instead');
        return saveFrame(clipId);
      }
    }
    /** @param {any} [clipId] */
    function copyTimestamp(clipId) {
      const ctx = ctxOf(clipId);
      if (!ctx) return false;
      host.postMessage({ type: 'copyText', text: fmtStamp(ctx.t) });
      toast('Timestamp copied');
      return true;
    }
    /** A link to the frame: its 1-based number and the middle of the frame (it lands there before the rate is known). @param {any} [clipId] */
    function copyLink(clipId) {
      const ctx = ctxOf(clipId);
      if (!ctx) return false;
      const t = ctx.fps ? (ctx.frame + 0.5) / ctx.fps : ctx.t;
      host.postMessage(tag(ctx, { type: 'copyLink', frame: ctx.frame + 1, t: Math.round(t * 1e4) / 1e4 }));
      return true;
    }

    /**
     * ⚙ › A–B Range, or the host asking (abQuery): send the range for an export kind.
     * @param {'exportRange' | 'clipRange' | 'ffmpegRange'} kind
     * @param {boolean} [promptInHost] the host asked: an empty range goes back so it can say so itself
     */
    function exportAb(kind, promptInHost = false) {
      const range = env.getRange ? env.getRange(kind) : null;
      if (!range && !promptInHost) { toast('Set an A–B range first (A, B)'); return false; }
      if (kind === 'clipRange' && range && range.native) { if (env.onRefuse) env.onRefuse(range); return false; }
      host.postMessage(tag(ctxOf(undefined), { type: kind, range: range || null }));
      return true;
    }

    /**
     * Shows frame k paused; resolves with the frame on screen once it settles (VFR or gapped video can land on a
     * neighbour: the host names files from it), or null after 20 s, on cancel or dispose.
     * @param {any} clipId @param {number} k @param {AbortSignal} signal @returns {Promise<number | null>}
     */
    function showFrame(clipId, k, signal) {
      pause(clipId);
      if (!engine || typeof engine.showFrame !== 'function') return Promise.reject(new Error('cannot show frames'));
      return new Promise((resolve) => {
        let done = false;
        /** @param {number | null} f */
        const finish = (f) => {
          if (done) return;
          done = true;
          clearT(timer);
          signal.removeEventListener('abort', cancel);
          resolve(f);
        };
        const cancel = () => finish(null);
        const timer = setT(() => finish(null), EXPORT_FRAME_TIMEOUT_MS);
        signal.addEventListener('abort', cancel, { once: true });
        Promise.resolve().then(() => engine.showFrame(clipId, k, { signal })).then(
          (f) => finish(typeof f === 'number' ? f : null), () => finish(null));
      });
    }
    /** The host asks for frame k of an A-B export: one at a time, in order. @param {any} id @param {number} k */
    function exportGrab(id, k) {
      const signal = exportAbort.signal;
      const run = async () => {
        if (signal.aborted) return;
        const ctx = ctxOf(undefined);
        try {
          if (!ctx) throw new Error('no video');
          before('export');
          const shown = await showFrame(ctx.clipId, k, signal);
          if (signal.aborted) return;
          if (shown === null) throw new Error(`frame ${k + 1} did not show`);
          if (!engine || typeof engine.snapshot !== 'function') throw new Error('no picture');
          const pic = await engine.snapshot(ctx.clipId);
          if (!pic) throw new Error('no picture');
          const data = await bytesOf(pic);
          if (!signal.aborted) host.postMessage(tag(ctx, { type: 'exportFrame', id, frame: shown, data }));
        } catch (e) {
          if (!signal.aborted) host.postMessage(tag(ctx, { type: 'exportFrame', id, frame: k, error: errText(e) }));
        }
      };
      exportChain = exportChain.then(run, run);
      return exportChain;
    }
    /** Stop the export in progress: pending frames answer nothing (the host cancelled or the page is going). */
    function cancelExport() {
      exportAbort.abort();
      if (!disposed) exportAbort = new AbortCtor();
    }

    /** The host's export messages. True when handled. @param {any} m */
    function onHostMessage(m) {
      if (!m || disposed) return false;
      const ctx = ctxOf(undefined);
      const mine = !ctx || ctx.page === undefined || m.page === undefined || m.page === ctx.page;
      switch (m.type) {
        case 'abQuery':
          exportAb(m.then === 'clip' ? 'clipRange' : m.then === 'ffmpeg' ? 'ffmpegRange' : 'exportRange', true);
          return true;
        case 'exportGrab': if (mine) exportGrab(m.id, m.frame); return true;
        case 'exportEnd': return true;
        default: return false;
      }
    }

    return {
      saveFrame, copyFrame, copyTimestamp, copyLink, exportAb, exportGrab, cancelExport, onHostMessage,
      /** Resolves when the queued export frames are done (tests, page teardown). */
      idle: () => exportChain,
      dispose() { disposed = true; exportAbort.abort(); },
    };
  }

  const api = {
    SCOPE_MODES, SCOPE_NAMES, INSPECTOR_MODES, STATS_MS, DELAY_STEP_MS, EXPORT_FRAME_TIMEOUT_MS,
    NOTICE_PRIORITY, NOTICE_OPEN_CLASS,
    createNoticeController, shouldSuppressToast, createInspectionController, createSubtitleController,
    createFrameExportController, fmtStamp,
  };
  // checkJs: end

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else /** @type {any} */ (globalThis).VpePlayerUiTools = api;
})();
