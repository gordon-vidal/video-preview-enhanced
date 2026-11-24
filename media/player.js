// @ts-check
'use strict';
/** @import { BlockReply } from '../tools/read-block-contract.js' */
(function () {
  const api = acquireVsCodeApi();
  const boot = Array.from(crypto.getRandomValues(new Uint32Array(4))).join('-');
  const vscode = {
    getState: () => api.getState(),
    setState: (state) => api.setState(state),
    postMessage: (message) => api.postMessage({ ...message, boot }),
  };
  const cfg = JSON.parse(/** @type {HTMLElement} */ (document.getElementById('cfg')).textContent || '{}');
  const $ = (/** @type {string} */ id) => /** @type {any} */ (document.getElementById(id));
  const stage = $('stage'), canvas = $('canvas');
  const overlay = $('overlay'), message = $('message'), hint = $('hint');
  const ui = {
    bar: $('bar'), play: $('play'), prev: $('prev'), next: $('next'), seek: $('seek'), buffered: $('buffered'), tip: $('tip'),
    time: $('time'), now: $('now'), dur: $('dur'), rate: $('rate'), mute: $('mute'), volume: $('volume'),
    infoBtn: $('infoBtn'), full: $('full'), cog: $('cog'), picBtn: $('picBtn'),
    panel: $('panel'), sheet: $('sheet'), toast: $('toast'), abMarks: $('abMarks'), tracks: $('tracks'),
    abA: $('abA'), abB: $('abB'), setABtn: $('setABtn'), setBBtn: $('setBBtn'),
    prevSize: $('prevSize'), nextSize: $('nextSize'), remoteLiveBtn: $('remoteLiveBtn'),
  };

  const log = (/** @type {any[]} */ ...a) => vscode.postMessage({ type: 'log', msg: a.map(String).join(' ') });
  window.addEventListener('error', (e) => log('error:', e.message, `${e.filename}:${e.lineno}`));
  window.addEventListener('unhandledrejection', (e) => log('unhandled rejection:', e.reason && e.reason.stack || e.reason));

  // Restored after a reload (file changed on disk, window reload), else inherited from persisted player prefs.
  // Every new tab starts muted (matching Chromium's per-webview autoplay policy); volume carries over.
  const saved = vscode.getState() || {};
  const initPrefs = cfg.prefs || {};
  /** @type {any} */
  let player = null;
  let pageClosed = false;
  let loop = saved.loop !== undefined ? saved.loop : !!cfg.loop;
  let muted = saved.muted !== undefined ? !!saved.muted : true;
  const rawVol = saved.volume !== undefined ? Number(saved.volume) : initPrefs.volume !== undefined ? Number(initPrefs.volume) : 1;
  let volume = Number.isFinite(rawVol) && rawVol >= 0 && rawVol <= 1 ? Math.round(rawVol * 100) / 100 : 1;
  let rate = VpeControls.clampRate(saved.rate || initPrefs.rate || 1);
  // Jump sizes of the arrow keys ('frame' or seconds): settings videoPreviewEnhanced.jump.* (VS Code's Settings only).
  const prefs = {
    jump: { arrow: 5, shift: 1, ctrl: 'frame', wheel: 'frame', wheelShift: 1, ...((cfg.prefs && cfg.prefs.jump) || {}) },
    stepButtons: (cfg.prefs && cfg.prefs.stepButtons) === 'jump' ? 'jump' : 'frame',
    // The step buttons' size picked with their badge (kept over a reload, shared by all tabs); null: the setting stepButtons.
    stepSize: VpeControls.STEP_SIZES.includes(saved.stepSize) ? saved.stepSize
      : VpeControls.STEP_SIZES.includes(initPrefs.stepSize) ? initPrefs.stepSize : null,
    transcode: (cfg.prefs && cfg.prefs.transcode) || 'auto',
    transcodeMaxBitrate: Number(cfg.prefs && cfg.prefs.transcodeMaxBitrate) || 0,
    // The default Live transcode resolution for new tabs (0 = Auto); this tab's own is tabResolution().
    transcodeResolution: Number(cfg.prefs && cfg.prefs.transcodeResolution) || 0,
  };
  /** @type {number | undefined} the resolution picked in this tab (⚙ › Live transcode), until the host confirms it */
  let pickedResolution;
  // Picture size for this tab (Fit, Fill, Stretch, 100 %): starts as the setting videoPreviewEnhanced.pictureSize; the button and Z change this tab only.
  const startPicture = VpePicture.parse(cfg.prefs && cfg.prefs.pictureSize);
  // The bar's time: 0 m:ss.mmm, 1 SMPTE timecode, 2 frame number (a click on it cycles).
  let timeMode = [0, 1, 2].includes(Number(saved.timeMode)) ? Number(saved.timeMode)
    : [0, 1, 2].includes(Number(initPrefs.timeMode)) ? Number(initPrefs.timeMode) : 0;

  const actionBtn = $('action');
  function showMessage(text, sub = '', action = null) {
    if (text && text !== message.textContent) announce(sub ? `${text} ${sub}` : text);
    message.textContent = text;
    hint.textContent = sub;
    overlay.hidden = !text;
    actionBtn.hidden = !action;
    if (action) {
      actionBtn.textContent = action.label;
      actionBtn.onclick = (e) => {
        e.stopPropagation();
        actionBtn.disabled = true;
        actionBtn.textContent = 'Downloading…';
        vscode.postMessage({ type: 'action', id: action.id });
      };
    }
  }
  function showNotice(n) {
    const notice = $('notice');
    const dismiss = () => {
      const back = notice.contains(document.activeElement);
      notice.hidden = true;
      if (n.dismiss) n.dismiss();
      if (back) ui.play.focus();
    };
    $('noticeText').textContent = n.text;
    announce(n.text);
    for (const [button, action] of [[$('noticeAction'), n.action], [$('noticeSettings'), n.settings], [$('noticeHide'), n.hide]]) {
      button.hidden = !action;
      button.title = action?.title || '';
      button.onclick = null;
      if (!action) continue;
      button.textContent = action.label;
      button.onclick = () => {
        if (action.run) action.run();
        else vscode.postMessage({ type: 'action', id: action.id });
        if (action.close) dismiss();
      };
    }
    notice.dataset.kind = n.kind || '';
    $('noticeClose').onclick = () => {
      n.onClose?.();
      dismiss();
    };
    notice.hidden = false;
  }
  $('notice').addEventListener('click', (e) => e.stopPropagation());
  /**
   * Pixel tools (inspector, scopes, 1:1 zoom, frame save/copy/export) on a video that native
   * ffmpeg scaled down or reduced to 8-bit: offer the built-in decoder's exact pixels, once per page.
   */
  let exactOffered = false;
  let reducedResDismissed = !!saved.reducedResDismissed;
  function exactTool(zoom = false) {
    const p = player;
    // Pixel tools can fetch one source frame. Actual-size zoom still uses the playback picture.
    if (cfg.hideReducedResNotice || reducedResDismissed || exactOffered || !p || !p.nativeLossy || (!zoom && VpeExact.available(p, cfg))) return;
    exactOffered = true;
    showNotice({
      ...VpeReducedResNotice(p.info?.video, p.info?.remoteStream, p.meta),
      dismiss: () => {
        reducedResDismissed = true;
        vscode.setState({ ...vscode.getState(), reducedResDismissed });
      },
    });
  }
  // Screen readers: toasts, messages and status changes go to one polite live region (#live).
  const live = $('live');
  let liveTimer = 0;
  function announce(text) {
    if (!live || !text) return;
    // Cleared first, so the same text twice is read twice.
    live.textContent = '';
    clearTimeout(liveTimer);
    liveTimer = setTimeout(() => { live.textContent = text; }, 50);
  }
  const toast = VpeControls.createToast(ui.toast, announce);
  const flashPlay = VpeControls.createPlayFlash($('playFlash'), stage);

  // Subtitles and audio/subtitle tracks (tracks-menu.js, subtitles.js).
  const subs = createTracksUi({
    vscode, stage, canvas, log, toast, bar: ui.bar, layer: $('subs'),
    getPlayer: () => player, saved: saved.subs, onChange: () => { updateCc(); if (controls) controls.refresh(); },
  });
  /** @type {any} */
  let controls = null;
  /** The CC button is present only when there is a track to toggle. */
  function updateCc() {
    const d = subs.panelData();
    const none = !d.subs.length;
    ui.tracks.hidden = none;
    ui.tracks.classList.toggle('on', d.on);
    const label = none ? 'Subtitles' : d.on ? `Subtitles on: ${d.label}` : 'Subtitles off';
    ui.tracks.setAttribute('aria-label', label);
    ui.tracks.title = `${label}  C`;
  }

  // Labels: media/timefmt.js.
  const { fmtTime, fmtClock, fmtTimecode, fmtSize, frameText } = /** @type {any} */ (self).VpeTime;

  // The frame player (MJPEG AVI, image sequences): media/frame-player.js.
  const FramePlayer = VpeFramePlayer.createFramePlayer({
    canvas, vscode, log, showMessage, setMute,
    getRate: () => rate, getLoop: () => loop, getMuted: () => muted, getVolume: () => volume,
  });

  // ---- Controls -----------------------------------------------------------

  let scrubbing = false;
  let lastUi = '';
  /** Writes the bar from the player's state; true when the time, frame or play state shown changed. */
  function updateUi() {
    if (!player) return false;
    const playing = player.isPlaying();
    const dur = player.meta.duration || 0;
    const step = scrubbing ? null : player.pendingStep?.();
    if (player.seekTarget == null) player.seekGoalFrame = null;
    const dragFrame = scrubbing ? Number(ui.seek.value) : player.seekGoalFrame ?? null;
    const f = dragFrame ?? (step ? player.frameAt(step.t) : player.currentFrame());
    const t = dragFrame !== null ? Math.min(dur || Infinity, dragFrame / (player.frameNumberRate?.() || player.fps || 30))
      : step ? Math.max(0, Math.min(dur || Infinity, player.rel(step.t))) : player.currentTime();
    if (!scrubbing) ui.seek.value = String(f);
    const key = `${f}|${t.toFixed(3)}|${playing}|${Math.round(dur * 1000)}|${timeMode}`;
    const changed = key !== lastUi;
    if (changed) {
      lastUi = key;
      // The same detail while playing and paused; a click cycles time / timecode / frame number.
      const fps = player.fps || (player.meta && player.meta.fps) || 0;
      const nFrames = player.n || (fps && dur ? Math.round(dur * fps) : 0);
      // A live stream (Open Video URL…) has no end: the time since it started playing, and LIVE; no format cycling.
      if (player.meta.live) { ui.now.textContent = fmtClock(t); ui.dur.textContent = '· LIVE'; }
      else if (timeMode === 1 && fps) { ui.now.textContent = fmtTimecode(f, fps); ui.dur.textContent = `/ ${fmtTimecode(nFrames, fps)}`; }
      else if (timeMode === 2) { ui.now.textContent = `frame ${f + 1}`; ui.dur.textContent = `/ ${nFrames || '?'}`; }
      else { ui.now.textContent = fmtClock(t); ui.dur.textContent = `/ ${fmtClock(dur)}`; }
      ui.time.setAttribute('aria-label', `Position ${fmtClock(t)}, frame ${f + 1}. Click to change the format.`);
      ui.play.classList.toggle('playing', playing);
      ui.play.setAttribute('aria-label', playing ? 'Pause' : 'Play');
      ui.play.title = `${playing ? 'Pause' : 'Play'}  Space`;
      // The slider's value is a frame index: screen readers read the time instead.
      ui.seek.setAttribute('aria-valuetext', `${fmtTime(t)} of ${fmtTime(dur)}, frame ${f + 1}`);
    }
    // Buffered (converted) ranges on the seek bar.
    if (dur > 0) {
      const ranges = player.bufferedRanges();
      const sig = ranges.map((r) => r.map((x) => x.toFixed(1)).join('-')).join(',');
      if (sig !== ui.buffered.dataset.sig) {
        ui.buffered.dataset.sig = sig;
        ui.buffered.style.background = ranges.length
          ? `linear-gradient(to right, ${ranges.map(([a, b]) => `transparent ${(a / dur) * 100}%, var(--buf) ${(a / dur) * 100}%, var(--buf) ${(b / dur) * 100}%, transparent ${(b / dur) * 100}%`).join(', ')})`
          : 'none';
      }
    }
    return changed;
  }

  // Decoder status numbers stay in the stats overlay. Show slow-playback notices once per page.
  let ffmpegState = null; // from the host: {installed, offer, mb}
  let slowNoticeDismissed = !!saved.slowNoticeDismissed;
  const warned = new Set();
  function updateStatus() {
    if (cfg.hideSlowPlaybackNotice || slowNoticeDismissed) return;
    const p = player;
    const variant = p?.status?.()?.slowNotice;
    if (!variant) return;
    const kind = variant === 'setupFfmpeg' ? variant : 'slow';
    if (warned.has(kind)) return;
    warned.add(kind);
    const notice = VpeSlowNotice(variant, !p.cfg?.native && ffmpegState?.offer, ffmpegState?.mb);
    const value = notice.whenSlow;
    showNotice({
      ...notice,
      kind: 'slowPlayback',
      action: value ? { ...notice.action, run: () => {
        if (player === p) p.setWhenSlow(value);
        vscode.postMessage({ type: 'whenSlow', value });
      } } : notice.action,
      onClose: () => {
        slowNoticeDismissed = true;
        vscode.setState({ ...vscode.getState(), slowNoticeDismissed });
      },
    });
  }

  let wake = null;
  let wakeWanted = false;
  function syncWakeLock(on) {
    if (on === wakeWanted || !navigator.wakeLock) return;
    wakeWanted = on;
    if (on) navigator.wakeLock.request('screen').then((w) => { if (wakeWanted) wake = w; else w.release(); }, () => {});
    else if (wake) { wake.release().catch(() => {}); wake = null; }
  }

  let lastSave = 0;
  let lastSaved = '';
  // Slider seeks: only the newest is kept, applied once the previous one has landed (native ffmpeg starts a process per seek).
  // The frame loop rests while nothing can change on its own: paused, the engine settled (no seek,
  // read or decode under way), no drag, no tool that draws by itself, and nothing changed for
  // REST_AFTER_MS. Input events, messages (host, workers) and decoder outputs wake it (wakeLoop);
  // a resting page leaves the renderer and GPU process idle instead of waking them on every refresh.
  const REST_AFTER_MS = 1000;
  let loopOn = true;
  let quietSince = null;
  const loopStats = { frames: 0, rests: 0 }; // test hook (state)
  /** @type {{ wake: () => void, dispose: () => void } | null} */
  let debugProbe = null;
  function wakeLoop() {
    quietSince = null;
    if (pageClosed || loopOn) return;
    loopOn = true;
    requestAnimationFrame(frameLoop);
  }
  for (const ev of ['message', 'pointerdown', 'pointermove', 'pointerup', 'wheel', 'keydown', 'keyup', 'input', 'change', 'click', 'focusin', 'resize', 'fullscreenchange', 'visibilitychange']) {
    window.addEventListener(ev, wakeLoop, { capture: true, passive: true });
  }
  // The right-click menu (media/ctxmenu.js) reads the player state when it opens: wake the loop so it is current.
  window.addEventListener('contextmenu', wakeLoop, true);
  /** Test hook (state): what keeps the loop from resting now, '' when nothing. */
  function loopBusy() {
    const p = player;
    if (!p) return 'no player';
    if (typeof p.settled !== 'function') return 'frame player';
    const e = !p.settled() ? `engine(${['playing', 'requesting', 'catchUp', 'skipping', 'firstShown', 'eof'].map((k) => `${k}=${!!p[k]}`).join(',')},seek=${p.seekTarget},q=${p.queue.length},vq=${p.vdec ? p.vdec.decodeQueueSize : '-'},aq=${p.adec ? p.adec.decodeQueueSize : '-'})` : '';
    return [e, scrubbing && 'scrubbing', seekDragger.dragging() && 'seek drag', volumeDragger.dragging() && 'volume drag',
      !insp.idle() && 'inspector', scopes.mode() && 'scopes', xray && xray.isShown() && 'xray'].filter(Boolean).join(' ');
  }
  /** Whether the loop may rest now (see REST_AFTER_MS). */
  function restful() {
    return !!player && typeof player.settled === 'function' && player.settled() && !player.isPlaying()
      && !scrubbing && !seekDragger.dragging() && !volumeDragger.dragging()
      && insp.idle() && !scopes.mode() && !(xray && xray.isShown()) && !exactNeeded();
  }
  function frameLoop(now) {
    if (pageClosed) return;
    loopStats.frames++;
    let changed = false;
    if (player) {
      player.tick(now);
      exactTick(now);
      insp.tick(now);
      scopes.tick(now);
      subs.tick();
      if (!scrubbing) { const to = ab.wrapTarget(player.currentTime(), player.isPlaying()); if (to !== null) player.seekTime(to); }
      changed = updateUi();
      if (xray) xray.chapterTicks();
      updateStatus();
      syncWakeLock(player.isPlaying());
      if (now - lastSave > 1000) {
        lastSave = now;
        // Only when something changed: a paused page wrote the same state and position every second.
        const state = { t: player.currentTime(), rate, volume, muted, loop, subs: subs.state(), timeMode,
          reducedResDismissed, slowNoticeDismissed, stepSize: prefs.stepSize, ...(switchPlay !== null ? { play: switchPlay } : {}) };
        const json = JSON.stringify([state, player.meta.duration || 0]);
        if (json !== lastSaved) {
          lastSaved = json;
          vscode.setState(state);
          vscode.postMessage({ type: 'pos', t: state.t, d: player.meta.duration || 0 });
        }
      }
    }
    if (changed || !restful()) quietSince = null;
    else if (quietSince === null) quietSince = now;
    else if (now - quietSince > REST_AFTER_MS) { loopOn = false; loopStats.rests++; if (debugProbe) debugProbe.wake(); return; }
    requestAnimationFrame(frameLoop);
    if (debugProbe) debugProbe.wake();
  }
  requestAnimationFrame(frameLoop);

  function disposePlayer() {
    seekDragger.stop();
    hideTip(true);
    const previous = player;
    player = null;
    previous?.dispose();
  }

  function begin(p, meta) {
    if (pageClosed) { p.dispose(); return; }
    if (player !== p) disposePlayer();
    player = p;
    p.ffmpeg = ffmpegState;
    subs.attach(p);
    ui.seek.max = String(Math.max(0, (p.n || 1) - 1));
    // Live streams play from the live edge; seeking is off (docs/notes/url-stream.md).
    ui.seek.disabled = !!(meta && meta.live);
    if (meta && meta.live) ui.seek.title = 'Live stream: seeking is not available';
    p.setRate(rate);
    updateMuteUi();
    p.setVolume(volume, muted);
    if (p.setLoop) p.setLoop(loop);
    const resume = saved.t > 0 ? saved.t : (cfg.resume || 0);
    // A frame link (vscode:// URI or #t= / #frame= fragment) wins over the resume position.
    const linked = !!cfg.goto && !saved.t;
    if (linked) insp.goToLink(cfg.goto);
    else if (resume > 0) {
      if (p.deferSeek) p.deferSeek(resume); else p.seekTime(resume);
      if (!saved.t) toast(`Resumed at ${fmtTime(resume)} (Home: start)`);
    }
    drawAB();
    updateCc();
    if (controls) controls.refresh();
    // A quality switch (HLS) reloads the page: it plays on when it was playing.
    const playOn = !!saved.play;
    saved.play = false;
    if ((cfg.autoplay || playOn) && !linked) p.play(); // a frame link opens paused on that frame
  }

  // A-B loop: A sets the start, B the end; pressing the same key again clears it (media/abloop.js).
  const ab = /** @type {any} */ (self).VpeAbLoop.create();
  function abChanged() {
    toast(ab.toast(fmtTime));
    drawAB();
    if (controls) controls.refresh();
  }
  function setAB(which) {
    if (!player) return;
    ab.set(which, shownTime(), player.currentFrame(), abTime(), synthTimes());
    abChanged();
  }
  function clearAB() { ab.clear(); abChanged(); }
  function copyTimestamp() { if (player) vscode.postMessage({ type: 'copyText', text: fmtTime(player.currentTime()) }); toast('Timestamp copied'); }
  const shownTime = () => player.shownT != null ? player.rel(player.shownT) : player.currentTime();
  // A clip uses the picture's timestamp even when the playback clock is between pictures.
  function abTime() {
    // Native ffmpeg reports the picture's own timestamp (engine.shownMarkTime); the other decoders' times are that already.
    const own = player.shownMarkTime ? player.shownMarkTime() : null;
    if (own !== null) return own;
    return shownTime();
  }
  function resetAB(which) {
    if (!player) return;
    ab.reset(which, shownTime(), player.currentFrame(), abTime(), synthTimes());
    abChanged();
  }
  /** The settings panel's A-B row: start, then end, then off. */
  // Live transcode, and native ffmpeg that could not report a picture's timestamp, label pictures by count rather than
  // by source timestamp: exact export must refuse marks set on them.
  function synthTimes() { return !!(player.shownFrame?.nativeTimestamp || player.remoteStream); }
  function cycleAB() { if (!player) return; ab.cycle(shownTime(), player.currentFrame(), abTime(), synthTimes()); abChanged(); }
  // An exact A-B clip needs the file's own picture times.
  function refuseSynthetic() {
    const transcode = !!(player && player.remoteStream);
    showNotice({
      text: transcode
        ? 'Live transcode re-times the picture, so A and B cannot be used for an exact clip. Switch to the original video and set A and B again.'
        : "This ffmpeg cannot report the picture's own times, so A and B cannot be used for an exact clip. Switch to the built-in decoder and set A and B again.",
      action: { label: transcode ? 'Use original video' : 'Switch to built-in decoder', id: 'fullRes', close: true },
    });
  }
  ui.setABtn.onclick = () => setAB('a');
  ui.setBBtn.onclick = () => setAB('b');
  // Dragging a pin on the seek bar moves that end to the nearest frame; the playhead stays where it is. The frame's
  // time (frame / frame rate) is both its A-B time and its presentation time, so the clip export cuts at that frame.
  for (const [which, pin] of [['a', ui.abA], ['b', ui.abB]]) {
    self.VpeAbLoop.bindPin(pin, which, {
      rect: () => ui.seek.getBoundingClientRect(),
      n: () => player ? player.n : 0,
      fps: () => player ? (player.frameNumberRate?.() || player.fps || 30) : 0,
      dur: () => player ? player.meta.duration || 0 : 0,
      move(w, snap, clientX) {
        if (!player) return;
        const dur = player.meta.duration || 0;
        const r = ui.seek.getBoundingClientRect();
        const pct = player.n > 1 ? snap.f / (player.n - 1) * 100 : dur ? snap.t / dur * 100 : 0;
        pin.style.left = `${pct}%`;
        ui.tip.textContent = `${w.toUpperCase()} ${fmtTime(snap.t)}${player.n ? ` · #${snap.f + 1}` : ''}`;
        ui.tip.style.left = `${Math.max(30, Math.min(r.width - 30, clientX - r.left))}px`;
        ui.tip.hidden = false;
      },
      commit(w, snap) {
        if (!player) return;
        ab.reset(w, snap.t, snap.f, snap.t, synthTimes());
        abChanged();
      },
      end() { hideTip(); drawAB(); },
    });
  }
  function abLabel() { return ab.label(fmtClock); }
  function drawAB() {
    VpeControls.drawRangeMarks(ui.abMarks, ui.abA, ui.abB, ab.marks(player && player.meta.duration));
    VpeControls.drawRangeButtons(ui.setABtn, ui.setBBtn, ab);
  }

  const togglePlay = () => {
    if (!player) return;
    if (player.isPlaying()) player.pause();
    else player.play();
    flashPlay(player.isPlaying());
  };
  function step(d) {
    if (!player) return;
    if (player.stepFrame) player.stepFrame(d);
    else { player.pause(); player.seekFrame(player.currentFrame() + d); }
    updateUi();
    wakeLoop();
  }
  const skip = (s) => { if (!player) return; player.seekTime(player.currentTime() + s); toast(`${s > 0 ? '+' : ''}${s} s`); };
  /** Arrow keys: one frame or seconds, from the jump-size settings. */
  const jump = (size, dir) => { if (size === 'frame') step(dir); else skip(dir * Number(size)); };
  function postPlaybackPrefs() {
    vscode.setState({ ...(vscode.getState() || {}), rate, volume, muted, timeMode, stepSize: prefs.stepSize });
    vscode.postMessage({ type: 'playbackPrefs', volume, rate, timeMode, stepSize: prefs.stepSize });
  }
  /** Another tab changed a shared playback preference (src/extension.js rememberPlaybackPrefs): follow it quietly. */
  function applyPlaybackPrefs(p) {
    if (!p) return;
    if (Number.isFinite(p.volume) && p.volume !== volume) {
      volume = p.volume;
      ui.volume.value = String(volume);
      updateMuteUi();
      if (player) player.setVolume(volume, muted);
    }
    if (Number.isFinite(p.rate) && p.rate !== rate) setRate(p.rate, false);
    if ([0, 1, 2].includes(p.timeMode) && p.timeMode !== timeMode) { timeMode = p.timeMode; lastUi = ''; updateUi(); }
    if (p.stepSize !== undefined && p.stepSize !== prefs.stepSize) {
      prefs.stepSize = p.stepSize;
      stepTips();
    }
    vscode.setState({ ...(vscode.getState() || {}), rate, volume, muted, timeMode, stepSize: prefs.stepSize });
    if (controls) controls.refresh();
  }
  // Speed: 0.25–4× in steps of 0.05 (VpeControls.clampRate), the range in which the sound keeps its pitch.
  function setRate(r, persist = true) {
    rate = VpeControls.clampRate(r);
    ui.rate.textContent = VpeControls.speedText(rate);
    ui.rate.setAttribute('aria-label', `Speed ${VpeControls.speedText(rate)}`);
    if (player) player.setRate(rate);
    if (persist) postPlaybackPrefs();
  }
  /** Sets the speed with a toast; at the ends of the range it says so. */
  function changeRate(r) {
    setRate(r);
    toast(`${VpeControls.speedText(rate)}${r > VpeControls.SPEED_MAX + 1e-9 ? ' (fastest)' : r < VpeControls.SPEED_MIN - 1e-9 ? ' (slowest)' : ''}`);
    if (controls) controls.refresh();
  }
  const bumpRate = (d) => changeRate(Math.round((rate + d * VpeControls.SPEED_STEP) * 100) / 100);
  function setTranscode(mode) {
    prefs.transcode = mode;
    vscode.postMessage({ type: 'transcodePref', mode });
    toast(`Live transcode: ${mode === 'auto' ? 'Auto' : mode === 'always' ? 'Always' : 'Off'}`);
  }
  function setTranscodeMaxBitrate(mbps) {
    prefs.transcodeMaxBitrate = Number(mbps) || 0;
    vscode.postMessage({ type: 'transcodePref', maxBitrateMbps: prefs.transcodeMaxBitrate });
    toast(prefs.transcodeMaxBitrate > 0 ? `Max bitrate: ${prefs.transcodeMaxBitrate} Mb/s` : 'Max bitrate: Auto');
  }
  /** This tab's Live transcode resolution (0 = Auto): as picked, else as the host's stream reports it, else the default. */
  function tabResolution() {
    if (pickedResolution !== undefined) return pickedResolution;
    const tc = player && player.info && player.info.transcode;
    return tc && tc.locked !== undefined ? Number(tc.locked) || 0 : prefs.transcodeResolution;
  }
  function setTranscodeResolution(h) {
    pickedResolution = Number(h) || 0;
    vscode.postMessage({ type: 'transcodeResolution', height: pickedResolution });
    toast(`Resolution: ${pickedResolution ? `${pickedResolution}p` : 'Auto'} for this video`);
  }
  function saveTranscodeResolution(h) {
    prefs.transcodeResolution = Number(h) || 0;
    vscode.postMessage({ type: 'transcodePref', resolution: prefs.transcodeResolution });
    toast(`Default resolution: ${prefs.transcodeResolution ? `${prefs.transcodeResolution}p` : 'Auto'}`);
  }
  const setLoop = (l) => { loop = l; if (player && player.setLoop) player.setLoop(l); if (controls) controls.refresh(); };
  const hasAudio = () => !player || (player instanceof FramePlayer ? !!player.audio : !player.info || !!player.info.audio);
  function updateMuteUi() {
    const noAudio = !hasAudio();
    ui.mute.disabled = noAudio;
    ui.volume.disabled = noAudio;
    if (ui.mute.parentElement) ui.mute.parentElement.classList.toggle('no-audio', noAudio);
    if (noAudio) {
      ui.mute.classList.toggle('muted', true);
      if (ui.mute.removeAttribute) ui.mute.removeAttribute('aria-pressed');
      ui.mute.setAttribute('aria-label', 'No audio track');
      ui.mute.title = 'No audio track';
      return;
    }
    ui.mute.classList.toggle('muted', muted || volume === 0);
    ui.mute.setAttribute('aria-pressed', String(muted));
    ui.mute.setAttribute('aria-label', muted ? 'Unmute' : 'Mute');
    ui.mute.title = muted ? 'Unmute  M' : 'Mute  M';
  }
  function setMute(m, byUser = true) {
    if (byUser && !hasAudio()) { toast('No audio track'); return; }
    muted = m;
    updateMuteUi();
    if (player) player.setVolume(volume, muted);
    vscode.setState({ ...(vscode.getState() || {}), rate, volume, muted, timeMode, stepSize: prefs.stepSize });
  }
  const setVolume = (v) => {
    volume = Math.max(0, Math.min(1, Math.round(v * 100) / 100));
    ui.volume.value = String(volume);
    if (volume > 0 && muted && hasAudio()) setMute(false);
    else {
      updateMuteUi();
      if (player) player.setVolume(volume, muted);
    }
    postPlaybackPrefs();
  };
  /** Z (and the Picture size button): the next picture size; zoomed in, back to Fit. 100 % shows the file's own pixels. */
  const cyclePicture = () => { insp.cycleMode(); if (insp.picture().mode === 'actual') exactTool(true); };
  /** The button shows the current size and names the next one. */
  function updatePicBtn() {
    const m = insp.picture().mode;
    const nx = VpePicture.next(m);
    ui.picBtn.dataset.mode = m;
    ui.picBtn.title = `Picture size: ${VpePicture.name(m)} (${VpePicture.WORDS[m]}). Click for ${VpePicture.name(nx)}  Z`;
    ui.picBtn.setAttribute('aria-label', `Picture size: ${VpePicture.name(m)}. Next: ${VpePicture.name(nx)}`);
  }
  /** The ⓘ panel (About this video): facts, decoder, Copy details, Copy link to this frame. */
  const toggleInfo = () => controls.toggle('info', ui.infoBtn);

  let fsBusy = false;
  let lastEscAt = 0;
  async function toggleFullscreen() {
    if (fsBusy) return;
    fsBusy = true;
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch (e) {
      // Some hosts don't allow fullscreen in webviews; toggle Zen Mode on the host (which syncs body.maxi).
      log(`fullscreen refused: ${e}`);
      vscode.postMessage({ type: 'focusMode' });
    } finally {
      fsBusy = false;
    }
  }
  // Picture-in-picture was removed (it did not work): git history has the button, the P key and togglePip.

  function grabFrame() {
    const src = player.snapshotSource();
    const w = src.width;
    const h = src.height;
    if (!w || !h) return null;
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    c.getContext('2d').drawImage(src, 0, 0, w, h);
    return new Promise((res) => c.toBlob(res, 'image/png'));
  }
  // ---- exact frames during Live transcode or lossy native playback (media/exactframe.js, src/exact_frame.js) ----
  const exact = VpeExact.create({
    page: cfg.page, post: (m) => vscode.postMessage(m), toast, log,
    onFail: (key, error) => toast(VpeExact.failureText(player, error), 4500),
  });
  const exactActive = () => VpeExact.available(player, cfg);
  /** The shown frame: seek generation, frame number and picture count. */
  const exactKey = () => `${player.gen}|${player.currentFrame()}|${player.shownCount || 0}`;
  /** The exact picture of the paused frame, for the inspector and scopes; null while playing, not fetched yet or failed. */
  const exactShown = () => (exactActive() && !player.isPlaying() ? exact.peek(exactKey()) : null);
  let exactSettle = { key: '', at: 0 };
  /** Whether the paused frame still needs its exact picture (an open inspector or scope asked for it). */
  const exactNeeded = () => exactActive() && !player.isPlaying() && player.seekTarget == null && (insp.inspecting() || !!scopes.mode())
    && !exact.peek(exactKey()) && !exact.failed(exactKey());
  /** From the frame loop: playing, forget it; paused with a tool open, fetch once the frame has been still for a moment. */
  function exactTick(now) {
    if (!exactActive()) return;
    if (player.isPlaying()) { exact.invalidate(); return; }
    if (!exactNeeded()) return;
    const key = exactKey();
    if (exactSettle.key !== key) { exactSettle = { key, at: now }; return; }
    if (now - exactSettle.at >= 150 && !exact.inflight(key)) exact.grab(key, VpeExact.shownTime(player), { notify: false }).then((r) => {
      if (cfg.debug && r && r.png) log(`exact frame ${r.w}x${r.h} for frame ${player.currentFrame() + 1}`); // test hook (layer 3)
      if (r) wakeLoop();
    });
  }
  /**
   * The PNG of the shown frame with its frame number, both taken before any await (stepping meanwhile must not
   * label this frame's pixels with another number). Use the host's exact frame when available, or the canvas when
   * it fails (the notice comes from onFail). null: nothing to save, or cancelled (resumed, stepped away).
   */
  async function frameBlob(what) {
    const frame = player.currentFrame();
    if (!exactActive()) { const blob = await grabFrame(); return blob ? { blob, frame } : null; }
    const key = exactKey();
    const r = await exact.grab(key, VpeExact.shownTime(player));
    if (r && r.png) return { blob: new Blob([r.png], { type: 'image/png' }), frame };
    if (!r || exactKey() !== key || player.isPlaying()) { toast(`${what} cancelled: the frame changed`, 2000); return null; }
    const blob = await grabFrame(); // the host could not give it: the canvas still shows this frame
    return blob ? { blob, frame } : null;
  }

  async function saveFrame() {
    if (!player) return;
    exactTool();
    player.pause();
    const got = await frameBlob('Save');
    if (!got) return;
    vscode.postMessage({ type: 'saveFrame', page: cfg.page, frame: got.frame, data: new Uint8Array(await got.blob.arrayBuffer()) });
  }
  async function copyFrame() {
    if (!player) return;
    exactTool();
    player.pause();
    try {
      const got = await frameBlob('Copy');
      if (!got) return;
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': got.blob })]);
      toast('Frame copied');
    } catch (e) {
      log(`clipboard refused: ${e}`);
      toast('Copy not allowed here; saving instead');
      saveFrame();
    }
  }

  // Zoom/pan, pixel inspector, go to, frame links, stats (inspect.js).
  // A zoom changes the picture's size like a resize does: native frames follow it (scheduleView below).
  const insp = VpeInspect.create({ vscode, stage, canvas, log, toast, getPlayer: () => player, fmtTime, cfg, getExact: () => exactShown(), exactCtx: (e) => exact.ctxOf(e), onZoom: () => scheduleView(), picture: startPicture, onPicture: () => { if (ui.picBtn) updatePicBtn(); if (controls) controls.refresh(); } });
  updatePicBtn();
  // Waveform, RGB parade, vectorscope, histogram (scopes.js; W cycles).
  const scopes = VpeScopes.create({
    stage, canvas, getPlayer: () => player, toast, log, getExact: () => exactShown(), returnFocus: () => ui.play.focus(),
  });
  if (/** @type {any} */ (window).__vpe) /** @type {any} */ (window).__vpe.scopes = scopes; // test harness hook

  // ---- A-B export: the host asks for the range, then for each frame (src/extension.js exportRange) ----
  function abRange() {
    if (!player) return null;
    return ab.exportRange(player.fps || (player.meta && player.meta.fps) || 0, player.n || 0);
  }
  function sendRange(type, promptInHost = false) {
    const range = type === 'clipRange' ? ab.presentationRange() : abRange();
    if (!range && !promptInHost) { toast('Set an A–B range first (A, B)'); return; }
    if (type === 'clipRange' && range && range.native) { refuseSynthetic(); return; }
    vscode.postMessage({ type, page: cfg.page, range });
  }
  /**
   * Shows frame k (0-based) paused; resolves with the index of the frame on the canvas once the
   * seek settles (VFR or gapped video can land on a neighbour: the host names files from it), or null.
   */
  const exportPage = new AbortController();

  function showFrame(k) {
    const p = player;
    p.pause();
    if (p instanceof FramePlayer) {
      if (p.shown !== k) p.seekFrame(k);
    } else if (p.currentFrame() === k && p.seekTarget === null && p.shownT !== null) return Promise.resolve(k);
    const before = p.shownCount || 0;
    if (!(p instanceof FramePlayer)) p.seekFrame(k);
    let t0 = performance.now();
    let last = t0;
    return new Promise((resolve) => {
      const { signal } = exportPage;
      let raf;
      const finish = (frame) => {
        cancelAnimationFrame(raf);
        signal.removeEventListener('abort', cancel);
        resolve(frame);
      };
      const cancel = () => finish(null);
      const check = () => {
        if (player !== p) { finish(null); return; }
        const now = performance.now();
        if (now - last > 1000) t0 += now - last; // hidden (no animation frames): that time does not count
        last = now;
        if (p instanceof FramePlayer) {
          if (p.shown === k) { finish(k); return; }
        } else if (p.seekTarget === null && p.shownT !== null && ((p.shownCount || 0) > before || now - t0 > 1000)) {
          finish(p.currentFrame());
          return;
        }
        if (now - t0 > 20000) { finish(null); return; }
        raf = requestAnimationFrame(check);
      };
      signal.addEventListener('abort', cancel, { once: true });
      raf = requestAnimationFrame(check);
    });
  }
  let exportChain = Promise.resolve();
  function exportGrab(id, k) {
    exportChain = exportChain.then(async () => {
      const { signal } = exportPage;
      if (signal.aborted) return;
      try {
        if (!player) throw new Error('no video');
        const shown = await showFrame(k);
        if (signal.aborted) return;
        if (shown === null) throw new Error(`frame ${k + 1} did not show`);
        const blob = await grabFrame();
        if (!blob) throw new Error('no picture');
        const data = new Uint8Array(await blob.arrayBuffer());
        if (!signal.aborted) vscode.postMessage({ type: 'exportFrame', page: cfg.page, id, frame: shown, data });
      } catch (e) {
        if (!signal.aborted) vscode.postMessage({
          type: 'exportFrame', page: cfg.page, id, frame: k, error: String(e && e.message || e),
        });
      }
    });
  }
  ui.play.onclick = togglePlay;
  // The buttons beside Play: the size picked with their badge, else one frame or the Ctrl+arrow jump (setting stepButtons).
  const stepButton = (dir) => {
    const a = VpeControls.stepAmount(VpeControls.stepSizeOf(prefs));
    if (a.n) step(dir * a.n); else skip(dir * a.s);
  };
  function stepTips() {
    const t = VpeControls.stepTips(prefs);
    ui.prev.title = t.back; ui.prev.setAttribute('aria-label', t.backLabel);
    ui.next.title = t.fwd; ui.next.setAttribute('aria-label', t.fwdLabel);
    VpeControls.drawStepBadges([ui.prevSize, ui.nextSize], VpeControls.stepSizeOf(prefs));
  }
  function setStepSize(v) {
    prefs.stepSize = v;
    stepTips();
    vscode.setState({ ...(vscode.getState() || {}), stepSize: v });
    postPlaybackPrefs();
    toast(`Step buttons: ${VpeControls.stepName(v)}`);
  }
  ui.prev.onclick = () => stepButton(-1);
  ui.next.onclick = () => stepButton(1);
  // The badge on a step button opens the size popover above it; the click never reaches the step button or the bar.
  for (const b of [ui.prevSize, ui.nextSize]) b.addEventListener('click', (e) => { e.stopPropagation(); if (controls) controls.toggle('step', b); });
  stepTips();
  ui.mute.onclick = () => setMute(!muted);
  ui.volume.addEventListener('input', () => { if (hasAudio()) setVolume(Number(ui.volume.value)); });
  ui.volume.addEventListener('wheel', (e) => { if (!hasAudio()) return; e.preventDefault(); setVolume(volume + (e.deltaY < 0 ? 0.05 : -0.05)); toast(`Volume ${Math.round(volume * 100)}%`); }, { passive: false });
  const seekDragger = VpeRangeDrag.bindSeek(ui.seek, {
    preview(frame) {
      if (!player) return;
      if (!scrubbing) {
        scrubbing = true;
        player.clearStepGoal?.();
        player.beginScrub?.();
      }
      updateUi();
      wakeLoop();
      const r = ui.seek.getBoundingClientRect();
      const max = Number(ui.seek.max) || 0;
      if (max > 0) showTip(r.left + (frame / max) * r.width);
    },
    finish() {
      if (scrubbing) player?.endScrub?.();
      scrubbing = false;
      hideTip(true);
      wakeLoop();
    },
    commit(frame) {
      if (!player) return;
      if (player.commitScrubFrame) player.commitScrubFrame(frame);
      else player.seekFrame(frame);
      player.seekGoalFrame = player.seekTarget == null ? null : frame;
      updateUi();
      wakeLoop();
    },
  });
  const volumeDragger = VpeRangeDrag.bind(ui.volume);
  VpeControls.holdVolumeOpen(ui.volume);
  ui.full.onclick = toggleFullscreen;
  ui.time.onclick = () => {
    // A live stream shows only the time since it started (no timecode or frame count to cycle to).
    if (player && player.meta && player.meta.live) { toast('Live stream'); return; }
    timeMode = (timeMode + 1) % 3; lastUi = ''; updateUi(); postPlaybackPrefs(); toast(['Time', 'Timecode', 'Frame number'][timeMode]); };
  // Hover tip: time and frame, with a keyframe thumbnail above it (engine.js thumbnail(), thumbs.js).
  const thumbBox = document.createElement('div');
  thumbBox.id = 'thumb';
  thumbBox.hidden = true;
  const thumbCv = document.createElement('canvas');
  thumbBox.appendChild(thumbCv);
  ui.tip.parentElement.appendChild(thumbBox);
  let thumbShown = false;
  // Dragging (mouse held on the bar): the tip and thumbnail follow the slider value, also off the bar.
  ui.seek.addEventListener('mousemove', (e) => { if (!seekDragger.dragging()) showTip(e.clientX); });
  function showTip(clientX) {
    // Until the frame count is known (slow 4K decoding), the tip shows the time from the duration.
    const dur = player ? player.meta.duration || 0 : 0;
    if (!player || !(player.n || dur)) return;
    const r = ui.seek.getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
    const f = Math.round(x * (player.n - 1));
    const t = player.n ? f / (player.fps || 30) : x * dur;
    const px = Math.max(0, Math.min(r.width, clientX - r.left));
    ui.tip.textContent = player.n ? `${fmtTime(t)} · #${f + 1}` : fmtTime(t);
    ui.tip.style.left = `${Math.max(30, Math.min(r.width - 30, px))}px`;
    ui.tip.hidden = false;
    const place = () => {
      const half = thumbBox.offsetWidth / 2 || 82;
      thumbBox.style.left = `${Math.max(half, Math.min(r.width - half, px))}px`;
    };
    // The last picture stays up until the one for this position arrives.
    const source = player;
    const asked = source.thumbnail && source.thumbnail(t, (/** @type {any} */ p) => {
      if (ui.tip.hidden || player !== source) return;
      ThumbService.draw(thumbCv, p);
      thumbBox.hidden = false;
      thumbShown = true;
      place();
    }, scrubbing);
    if (!asked) thumbBox.hidden = true;
    else if (thumbShown) place();
  }
  ui.seek.addEventListener('mouseleave', () => { if (!seekDragger.dragging()) hideTip(); });
  function hideTip(immediate = false) {
    ui.tip.hidden = true;
    thumbBox.hidden = true;
    thumbShown = false;
    if (player && player.thumbnailLeave) player.thumbnailLeave(immediate);
  }
  // A click on the picture closes an open panel or the shortcuts sheet; otherwise it plays / pauses.
  stage.addEventListener('click', () => { if (controls && (controls.consumeDismiss() || controls.anyOpen() || ctxMenu.consumeDismiss())) { controls.closeAll(false); return; } togglePlay(); });
  stage.addEventListener('dblclick', toggleFullscreen);
  // Wheel while paused: jump.wheel; Shift+wheel: jump.wheelShift. Chromium on Windows reports Shift+wheel as deltaX.
  stage.addEventListener('wheel', (e) => {
    if (insp.onWheel(e)) { e.preventDefault(); return; }
    if (!player || player.isPlaying()) return;
    e.preventDefault();
    const delta = e.deltaY || (e.shiftKey ? e.deltaX : 0);
    if (delta) jump(e.shiftKey ? prefs.jump.wheelShift : prefs.jump.wheel, delta > 0 ? 1 : -1);
  }, { passive: false });
  setRate(rate, false);
  ui.volume.value = String(volume);
  setMute(muted, false);

  // Controls hide after a moment in fullscreen.
  let hideTimer = 0;
  const poke = () => {
    document.body.classList.remove('idle');
    clearTimeout(hideTimer);
    if (document.fullscreenElement && player && player.isPlaying() && $('startCompareBackdrop').hidden) {
      hideTimer = setTimeout(() => document.body.classList.add('idle'), 2500);
    }
  };
  document.addEventListener('mousemove', poke);
  document.addEventListener('focusin', poke); // a keyboard user tabbing to the hidden bar
  document.addEventListener('fullscreenchange', poke);

  // Native ffmpeg sizes its frames to the picture area (src/native.js fitView): tell it when that
  // changes (panel resize, fullscreen, DPI, zoom), once the size has settled.
  let viewTimer = 0;
  function scheduleView() {
    wakeLoop(); // the bar, overlays and the zoom follow the new size in the frame loop
    clearTimeout(viewTimer);
    viewTimer = setTimeout(() => { if (player && player.nativeView) player.nativeView(insp.zoomedSize()); }, 400);
  }
  if (typeof ResizeObserver === 'function') new ResizeObserver(scheduleView).observe(stage);
  // A move to a screen with another scale changes the device pixels without resizing the stage.
  const watchDpr = () => {
    if (typeof matchMedia !== 'function') return;
    const mq = matchMedia(`(resolution: ${globalThis.devicePixelRatio || 1}dppx)`);
    const changed = () => {
      mq.removeEventListener('change', changed);
      watchDpr();
  if (startPicture !== 'fit') scheduleView(); // frames for a Fill / Stretch / 100 % tab
      scheduleView();
    };
    mq.addEventListener('change', changed);
  };
  watchDpr();

  // Background tabs keep their webview alive; don't let them play on unseen.
  let resumeOnShow = false;
  function setVisible(visible) {
    if (!player) return;
    if (!visible) { seekDragger.stop(); hideTip(true); }
    if (player.setHidden) player.setHidden(!visible);
    if (!visible) {
      resumeOnShow = resumeOnShow || player.isPlaying();
      if (player.isPlaying()) player.pause();
    } else if (resumeOnShow) {
      resumeOnShow = false;
      player.play();
    }
  }
  document.addEventListener('visibilitychange', () => setVisible(!document.hidden));

  // Keys follow common video-player conventions (YouTube-style).
  document.addEventListener('keydown', (e) => {
    // Typing in a field, a list box, or Space / Enter on a button reached with the keyboard: not player keys.
    if (VpeModes.ownsKey(e)) return;
    if (!e.ctrlKey && !e.metaKey && !e.altKey && /^[xXwWsS]$/.test(e.key)) exactTool();
    // AltGr (Ctrl+Alt on Windows) types { } [ ] # on many layouts: those are plain keys.
    const altGr = !!(e.getModifierState && e.getModifierState('AltGraph'));
    const mod = !altGr && (e.ctrlKey || e.metaKey) && !e.altKey;
    // Ctrl (Cmd) + Left / Right: the third jump size; Ctrl (Cmd) + C copies the frame.
    // VS Code's webview host forwards every keydown that reaches its window listener to the workbench, which
    // runs any matching keybinding as well (Ctrl+G is Go to Line there, Ctrl+C its copy). A Ctrl / Cmd key the
    // player used stops here, so only the player acts on it (docs/notes/ui-simple.md "Keys and VS Code").
    if (player && mod && !e.shiftKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) { e.preventDefault(); e.stopPropagation(); poke(); jump(prefs.jump.ctrl, e.key === 'ArrowLeft' ? -1 : 1); return; }
    if (player && mod && !e.shiftKey && (e.key === 'c' || e.key === 'C')) { e.preventDefault(); e.stopPropagation(); exactTool(); copyFrame(); return; }
    if (e.key === 'Escape' && controls && controls.anyOpen()) { e.preventDefault(); controls.closeAll(true); return; }
    if (e.key === 'Escape' && !$('notice').hidden) { e.preventDefault(); $('noticeClose').click(); return; }
    if (insp.onKey(e)) { e.preventDefault(); if (e.ctrlKey || e.metaKey) e.stopPropagation(); return; }
    if (e.key === 'Escape' && scopes.mode()) { e.preventDefault(); scopes.close(); return; }
    if (e.key === 'Escape' && !addHint.hidden) { e.preventDefault(); vscode.postMessage({ type: 'stopAddMode' }); return; }
    // VS Code exits Zen Mode on Esc Esc: keep the host's zenActive flag in sync when the user leaves that way.
    if (e.key === 'Escape' && !e.repeat && document.body.classList.contains('maxi')) {
      const now = Date.now();
      if (now - lastEscAt <= 1000) { lastEscAt = 0; vscode.postMessage({ type: 'focusModeExited' }); }
      else lastEscAt = now;
    }
    if (e.key === '?' && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); controls.toggleSheet(); return; }
    if (!player || e.metaKey || (!altGr && (e.ctrlKey || e.altKey))) return;
    poke();
    // Subtitle and audio-track keys: V, Shift+V, G, H, Shift+A, #.
    if (subs.onKey(e)) { e.preventDefault(); return; }
    let handled = true;
    switch (e.key) {
      case ' ': case 'k': case 'K': togglePlay(); break;
      case 'j': case 'J': skip(-10); break;
      case 'l': case 'L': skip(10); break;
      case 'ArrowLeft': jump(e.shiftKey ? prefs.jump.shift : prefs.jump.arrow, -1); break;
      case 'ArrowRight': jump(e.shiftKey ? prefs.jump.shift : prefs.jump.arrow, 1); break;
      case ',': step(-1); break;
      case '.': step(1); break;
      case '<': case '[': bumpRate(-1); break;
      case '>': case ']': bumpRate(1); break;
      case 'ArrowUp':
        if (!hasAudio()) { toast('No audio track'); break; }
        setVolume(volume + 0.05); toast(`Volume ${Math.round(volume * 100)}%`); break;
      case 'ArrowDown':
        if (!hasAudio()) { toast('No audio track'); break; }
        setVolume(volume - 0.05); toast(`Volume ${Math.round(volume * 100)}%`); break;
      case 'Home': player.seekFrame(0); break;
      case 'End': player.pause(); player.seekFrame(player.n - 1); break;
      case 'm': case 'M': setMute(!muted); break;
      case 'r': case 'R': setLoop(!loop); toast(loop ? 'Loop on' : 'Loop off'); break;
      case 'f': case 'F': if (!e.repeat) toggleFullscreen(); break;
      case 'N': if (e.shiftKey) vscode.postMessage({ type: 'neighbour', d: 1 }); else handled = false; break;
      case 'P': if (e.shiftKey) vscode.postMessage({ type: 'neighbour', d: -1 }); else handled = false; break;
      case 'a': case 'A': setAB('a'); break;
      case 'b': case 'B': setAB('b'); break;
      case 'Backspace': clearAB(); toast('A–B range cleared'); break;
      case 't': case 'T': copyTimestamp(); break;
      case 'z': case 'Z': if (e.shiftKey) handled = false; else cyclePicture(); break;
      case '+': case '=': insp.zoomStep(1); break;
      case '-': case '_': insp.zoomStep(-1); break;
      case 'i': case 'I': controls.toggle('info', ui.infoBtn); break;
      case 's': case 'S': saveFrame(); break;
      case 'c': case 'C': ccClick(); break;
      case 'w': case 'W': scopes.cycle(); break;
      case 'd': comparePick(); break;
      case 'D': if (e.shiftKey) addMode(); else comparePick(); break;
      default:
        if (/^[0-9]$/.test(e.key) && player.meta.duration) player.seekTime((Number(e.key) / 10) * player.meta.duration);
        else handled = false;
    }
    if (handled) e.preventDefault();
  });

  // ---- Decode engine (engine.js) --------------------------------------------
  const engine = createEngine({
    vscode, canvas, log, showMessage, toast, page: cfg.page, debug: !!cfg.debug,
    wake: () => wakeLoop(),
    getState: () => ({ rate, volume, muted, loop }),
    setMuteUi: (m) => { if (m !== muted) setMute(m, false); },
    onReady: (p) => { begin(p, p.meta); },
    onMeta: (p) => { ui.seek.max = String(Math.max(0, p.n - 1)); updateMuteUi(); updateRemoteChip(); if (controls) controls.refresh(); },
    onTracks: (p) => subs.onTracks(p),
  });

  // ---- xray: Codec X-ray strip, chapters, keyframe steps (media/xray.js) ----
  // eslint-disable-next-line no-undef
  const xray = typeof createXray === 'function' ? createXray({ cfg, ui, getPlayer: () => player, fmtTime, toast, log }) : null;
  // ---- end xray

  // ---- Tools and panels (media/controls.js) --------------------------------
  // The tools run through their keys, so each has one code path. One player layout: the tools are
  // always available (the old simple / advanced switch, videoPreviewEnhanced.advancedMode, is gone).
  const press = (key, mods = {}) => document.dispatchEvent(new KeyboardEvent('keydown', { key, ...mods }));
  const TOOLS = [
    // Compare needs a second file next to this one: not offered for a URL (Open Video URL…).
    ...(cfg.url ? [] : [{ label: 'Compare', key: 'Shift+D', run: () => addMode() }]),
    // The inspection group (⚙ › Inspection); `title` is what the row says, `label` the stable name.
    { label: 'Scopes', title: 'Scopes', key: 'W', group: 'inspect', run: () => { exactTool(); scopes.cycle(); } },
    { label: 'Inspector', title: 'Pixel inspector', key: 'X', group: 'inspect', run: () => { exactTool(); press('x'); } },
    { label: 'Stats', title: 'Stats', key: 'Shift+I', group: 'inspect', run: () => press('I', { shiftKey: true }) },
    { label: 'Codec X-ray', title: 'Codec X-ray', key: 'Shift+X', group: 'inspect', run: () => press('X', { shiftKey: true }) },
  ];
  // ⚙ › A–B Range: what uses the range (the range itself is set with A and B).
  const AB_ITEMS = [
    { label: 'Export frames A–B…', run: () => sendRange('exportRange') },
    ...(!cfg.url && !cfg.sequence ? [{ label: 'Export A–B Clip…', run: () => sendRange('clipRange') }] : []),
    ...(!cfg.url ? [{ label: 'Copy ffmpeg command for A–B', run: () => sendRange('ffmpegRange') }] : []), // cuts a file: not for URLs
  ];
  // Older names (test hooks and the earlier Tools menu) for the same tools.
  const MORE_TOOLS = {
    'Pixel inspector': () => runTool('Inspector'), 'Stats overlay': () => runTool('Stats'), 'Codec X-ray strip': () => runTool('Codec X-ray'),
    'Export A-B': () => sendRange('exportRange'),
    ...(!cfg.url && !cfg.sequence ? { 'Export A–B Clip…': () => sendRange('clipRange') } : {}),
    // A URL tab has no Compare tool: the host answers with a toast that says why.
    'Compare with…': () => compareWith(),
    Details: () => toggleInfo(), 'Zoom: fit / actual size': () => cyclePicture(), 'Export frames A–B…': () => sendRange('exportRange'),
    'Copy ffmpeg command for A–B': () => sendRange('ffmpegRange'), 'Go to frame or time…': () => press('g', { ctrlKey: true }),
  };
  /** Compare: VS Code's open dialog picks the other videos; compare then takes this tab's place, from here. */
  function compareWith() { vscode.postMessage({ type: 'compareWith', t: player ? player.currentTime() : 0 }); }
  /** Key D: a quick pick of other videos (same folder first); compare then takes this tab's place. */
  function comparePick() { vscode.postMessage({ type: 'comparePick', t: player ? player.currentTime() : 0 }); }
  /** Shift+D: the next video opened in VS Code (an Explorer click) is compared with this one (src/addmode.js). */
  function addMode() { vscode.postMessage({ type: 'addMode', t: player ? player.currentTime() : 0 }); }
  // The add mode's hint, while it is on (the host says so with 'addMode' messages).
  const addHint = document.createElement('div');
  addHint.id = 'addHint'; addHint.hidden = true; addHint.setAttribute('role', 'status');
  document.getElementById('stage').appendChild(addHint);
  function showAddMode(m) {
    addHint.hidden = !m.on;
    addHint.textContent = m.on ? 'Click a video in the Explorer to compare with this one · Esc to stop' : '';
    if (m.on) announce(addHint.textContent);
    log(`addMode ${m.on ? 'on' : 'off'}`);
  }
  // Videos dragged from the Explorer (VS Code hands them to the page only while Shift is held): compare with them.
  // Not for URLs (the host would refuse). Uses the URI lists VS Code puts on the drag (docs/notes/compare-ui.md).
  const dropHint = document.createElement('div');
  dropHint.id = 'dropHint'; dropHint.hidden = true; dropHint.setAttribute('aria-hidden', 'true');
  dropHint.textContent = 'Drop to compare';
  document.getElementById('stage').appendChild(dropHint);
  const droppable = (e) => !cfg.url && !cfg.sequence && e.dataTransfer && [...(e.dataTransfer.types || [])].some((t) => /uri-list|resourceurls|^Files$/.test(t));
  let dragDepth = 0;
  document.addEventListener('dragenter', (e) => { if (droppable(e)) { dragDepth++; dropHint.hidden = false; e.preventDefault(); } });
  document.addEventListener('dragover', (e) => { if (droppable(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
  document.addEventListener('dragleave', () => { if (dragDepth > 0 && --dragDepth === 0) dropHint.hidden = true; });
  document.addEventListener('drop', (e) => {
    dragDepth = 0; dropHint.hidden = true;
    if (!droppable(e)) return;
    e.preventDefault();
    const dt = e.dataTransfer;
    const uris = ['text/uri-list', 'application/vnd.code.uri-list', 'resourceurls'].map((k) => { try { return dt.getData(k); } catch { return ''; } }).filter(Boolean);
    if (!uris.length) { toast('Drag a video from the Explorer'); return; }
    vscode.postMessage({ type: 'compareDrop', uris, t: player ? player.currentTime() : 0 });
  });
  function runTool(label) {
    const t = TOOLS.find((x) => x.label === label);
    const fn = t ? t.run : MORE_TOOLS[label];
    if (!fn) return false;
    fn();
    return true;
  }
  function ccClick() {
    if (subs.ccToggle()) return;
    if (controls.view() === 'subs') controls.close(true);
    else controls.show('subs', ui.cog);
  }
  function infoFacts() {
    const p = player;
    const av = subs.available();
    const info = p && p.info ? p.info : {};
    const tr = p && typeof p.tracks === 'function' ? (() => { try { return p.tracks(); } catch { return null; } })() : null;
    const counts = info.trackCounts || (tr ? { audio: tr.audio.length || (info.audio ? 1 : 0) } : {});
    return VpeControls.facts({
      name: cfg.name, size: p && p.meta ? p.meta.size : 0, duration: p && p.meta ? p.meta.duration : 0,
      width: p && p.meta ? p.meta.width : 0, height: p && p.meta ? p.meta.height : 0, fps: p ? p.fps || (p.meta && p.meta.fps) : 0,
      info, vmode: p && p.vmode, amode: p && p.amode, native: !!(p && p.cfg && p.cfg.native), remoteStream: !!(p && p.remoteStream),
      frames: p instanceof FramePlayer, hasSound: !!(p && (p.audio || info.audio)),
      tracks: { audio: counts.audio, sub: av.subs },
      // A URL (Open Video URL…): its host and "stream" / "live stream" instead of a file size.
      stream: cfg.url ? { host: cfg.url.host || '', live: !!(p && p.meta && p.meta.live), variant: streamQ ? streamQ.variants.find((v) => v.id === streamQ.current) || null : null } : null,
    });
  }

  // ---- HLS quality (Open Video URL…, docs/notes/url-stream.md) ----
  // The host sends the master playlist's variants ('stream'); a pick reopens the stream at that variant
  // (the host reloads this page) from the same moment: the time and play state go into the saved state first.
  /** @type {null|{ pick: 'auto'|number, current: number, variants: Array<{ id: number, width: number, height: number, bandwidth: number, codecs: string }> }} */
  let streamQ = null;
  /** Playing when the quality was switched (kept in the saved state until the page reloads), else null. */
  let switchPlay = null;
  function setQuality(pick) {
    if (!streamQ || pick === streamQ.pick) return;
    if (player) {
      switchPlay = player.isPlaying();
      vscode.setState({ ...(vscode.getState() || {}), t: player.currentTime(), play: switchPlay, rate, volume, muted, loop, subs: subs.state(), timeMode });
      player.pause();
    }
    streamQ = { ...streamQ, pick };
    showMessage('Switching quality…');
    vscode.postMessage({ type: 'quality', pick });
  }
  /** The bar's remote Live transcode chip (remote windows only, while the stream plays; media/controls.js remoteChipState). */
  function updateRemoteChip() {
    const b = ui.remoteLiveBtn;
    if (!b) return;
    const p = player;
    const st = VpeControls.remoteChipState({
      remote: !!(cfg.engine && cfg.engine.remote),
      active: !!(p && p.remoteStream),
      transcode: p && p.info && p.info.transcode,
      height: p && p.info && p.info.video && p.info.video.height,
    });
    b.hidden = !st.visible;
    if (!st.visible) return;
    b.textContent = st.text;
    b.title = st.title;
    b.setAttribute('aria-label', st.ariaLabel);
    b.classList.toggle('adapting', st.adapting);
  }
  const pictureState = () => { const v = insp.picture(); return { mode: v.mode, pct: player && player.meta && player.meta.width ? insp.zoomPercent() : null, zoomed: v.zoom !== 1 }; };
  controls = VpeControls.create({
    panel: ui.panel, sheet: ui.sheet, bar: ui.bar, onShow: () => ctxMenu.close(false),
    buttons: { cog: ui.cog, info: ui.infoBtn, rate: ui.rate, tracks: ui.tracks, stepPrev: ui.prevSize, stepNext: ui.nextSize, remoteLive: ui.remoteLiveBtn },
    get: () => {
      const d = subs.panelData();
      return {
        rate, loop, jump: prefs.jump, stepButtons: prefs.stepButtons, stepSize: VpeControls.stepSizeOf(prefs), abLabel: abLabel(), picture: pictureState(), tools: TOOLS, ab: { items: AB_ITEMS },
        subsLabel: d.subs.length ? d.label : 'None in file',
        audioLabel: d.audio.length ? (d.audio.find((a) => a.checked) || d.audio[0]).main : (player && player.info && player.info.audio) || (player && player.audio) ? 'Only one' : 'None',
        hasSound: !!(player && ((player.info && player.info.audio) || player.audio)),
        tracks: d, facts: infoFacts(), canExternal: !!cfg.canOpenExternal,
        canUseOriginal: !!(player && player.remoteStream),
        transcode: !cfg.url && !(player instanceof FramePlayer) ? {
          mode: prefs.transcode, maxBitrateMbps: prefs.transcodeMaxBitrate, active: !!(player && player.remoteStream),
          resolution: tabResolution(), defaultResolution: prefs.transcodeResolution,
          sourceHeight: (player && player.info && player.info.remoteStream && player.info.remoteStream.sourceHeight) || 0,
        } : null,
        quality: streamQ,
      };
    },
    act: {
      stepSize: setStepSize,
      loop: () => { setLoop(!loop); toast(loop ? 'Loop on' : 'Loop off'); },
      cycleAB: () => cycleAB(),
      copyFrame: () => copyFrame(),
      setRate, pickRate: changeRate,
      stepRate: (d) => bumpRate(d),
      setTranscode: (m) => setTranscode(m),
      setTranscodeMaxBitrate: (r) => setTranscodeMaxBitrate(r),
      setTranscodeResolution: (h) => setTranscodeResolution(h),
      saveTranscodeResolution: (h) => saveTranscodeResolution(h),
      useOriginal: () => vscode.postMessage({ type: 'action', id: 'fullRes' }),
      setPicture: (m) => insp.setMode(m),
      zoomPicture: (d) => insp.zoomStep(d),
      resetPicture: () => insp.resetZoom(),
      selectSub: (key) => subs.select(key),
      selectAudio: (id) => subs.selectAudio(id),
      loadSubs: () => subs.loadFile(),
      subDelay: (d) => subs.delayBy(d),
      subSize: (d) => subs.sizeBy(d),
      copyInfo: (d) => { vscode.postMessage({ type: 'copyText', text: [d.title, d.sub, ...d.rows.map(([k, v]) => `${k}: ${v}`)].join('\n') }); toast('Details copied'); },
      copyLink: () => insp.copyLink(),
      external: () => vscode.postMessage({ type: 'external' }),
      extSettings: () => vscode.postMessage({ type: 'openSettings' }),
      // Only opens VS Code's input box: the URL is typed there, never sent from this page.
      openUrl: () => vscode.postMessage({ type: 'openUrl' }),
      setQuality: (pick) => setQuality(pick),
    },
  });
  ui.cog.onclick = (e) => { e.stopPropagation(); controls.toggle('main', ui.cog); };
  if (ui.remoteLiveBtn) ui.remoteLiveBtn.onclick = (e) => { e.stopPropagation(); controls.toggle('transcode', ui.remoteLiveBtn); };
  ui.infoBtn.onclick = (e) => { e.stopPropagation(); controls.toggle('info', ui.infoBtn); };
  ui.rate.onclick = (e) => { e.stopPropagation(); controls.toggle('speed', ui.rate); };
  ui.rate.addEventListener('wheel', (e) => { e.preventDefault(); bumpRate(e.deltaY < 0 ? 1 : -1); }, { passive: false });
  ui.tracks.onclick = (e) => { e.stopPropagation(); ccClick(); };
  ui.picBtn.onclick = (e) => { e.stopPropagation(); cyclePicture(); };

  const compareButton = $('startCompareBtn');
  const compareBackdrop = $('startCompareBackdrop');
  const compareDialog = $('startCompareDialog');
  const cancelCompare = $('cancelCompareBtn');
  const confirmCompare = $('confirmCompareBtn');
  let compareOpen = compareButton.dataset.open === '1'; // rendered by the host (src/bar.js), then 'compareOpen'
  function placeCompareDialog() {
    const r = compareButton.getBoundingClientRect();
    const left = r.left + r.width / 2 - compareDialog.offsetWidth / 2;
    compareDialog.style.left = `${Math.max(8, Math.min(left, innerWidth - compareDialog.offsetWidth - 8))}px`;
    compareDialog.style.bottom = `${innerHeight - ui.bar.getBoundingClientRect().top + 8}px`;
  }
  function closeCompareDialog() {
    if (compareBackdrop.hidden) return;
    compareBackdrop.hidden = true;
    compareButton.setAttribute('aria-expanded', 'false');
    compareButton.classList.remove('open');
    compareButton.focus();
    poke();
  }
  function setCompareOpen(open) {
    compareOpen = open;
    const label = open ? 'Add to Compare' : 'Compare';
    compareButton.title = label;
    compareButton.setAttribute('aria-label', label);
    if (open) {
      closeCompareDialog();
      compareButton.removeAttribute('aria-haspopup');
      compareButton.removeAttribute('aria-controls');
      compareButton.removeAttribute('aria-expanded');
    } else {
      compareButton.setAttribute('aria-haspopup', 'dialog');
      compareButton.setAttribute('aria-controls', 'startCompareDialog');
      compareButton.setAttribute('aria-expanded', String(!compareBackdrop.hidden));
    }
  }
  function requestComparison(confirmStart) {
    vscode.postMessage({ type: 'toolbarCompare', confirmStart, t: player ? player.currentTime() : 0 });
  }
  compareButton.onclick = (e) => {
    e.stopPropagation();
    if (compareOpen) { requestComparison(false); return; }
    controls.closeAll(false);
    compareBackdrop.hidden = false;
    compareButton.setAttribute('aria-expanded', 'true');
    compareButton.classList.add('open');
    placeCompareDialog();
    cancelCompare.focus();
  };
  cancelCompare.onclick = closeCompareDialog;
  confirmCompare.onclick = () => { closeCompareDialog(); requestComparison(true); };
  compareBackdrop.onclick = (e) => { if (e.target === compareBackdrop) closeCompareDialog(); };
  compareBackdrop.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') { e.preventDefault(); closeCompareDialog(); }
    if (e.key === 'Tab') {
      e.preventDefault();
      (document.activeElement === cancelCompare ? confirmCompare : cancelCompare).focus();
    }
  });
  window.addEventListener('resize', () => { if (!compareBackdrop.hidden) placeCompareDialog(); });
  setLoop(loop);
  updateCc();

  // ---- Right-click menu (media/ctxmenu.js, docs/notes/context-menu.md) ----
  // An HTML menu in the page: its items run through the same functions as the keys and buttons.
  const MENU_ACTIONS = {
    playPause: () => togglePlay(), loop: () => { setLoop(!loop); toast(loop ? 'Loop on' : 'Loop off'); },
    // From the menu "Set" always sets (at this moment); the A / B keys toggle.
    setA: () => resetAB('a'), setB: () => resetAB('b'), clearAB: () => clearAB(),
    copyFrame: () => copyFrame(), saveFrame: () => saveFrame(), copyTime: () => copyTimestamp(),
    startCompare: () => compareButton.click(), addToCompare: () => requestComparison(false),
    keys: () => controls.openSheet(ui.cog), cog: () => controls.show('main', ui.cog),
  };
  const ctxMenu = VpeCtxMenu.create({
    menu: $('ctxmenu'),
    getState: () => ({
      ready: !!player, playing: !!player && player.isPlaying(), loop, abSet: ab.isSet(),
      file: !cfg.url && !(player instanceof FramePlayer), compareOpen,
    }),
    beforeOpen: () => controls.closeAll(false),
    run: (action) => { if (MENU_ACTIONS[action]) MENU_ACTIONS[action](); },
  });

  // ---- Messages from the extension ----------------------------------------

  let pendingWav = null;
  window.addEventListener('pagehide', () => {
    if (pageClosed) return;
    pageClosed = true;
    if (debugProbe) { debugProbe.dispose(); debugProbe = null; }
    exportPage.abort();
    pendingWav = null;
    const gl = player?.gl?.gl;
    disposePlayer();
    engine.dropPreload();
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
  }, { once: true });
  window.addEventListener('message', (e) => {
    if (pageClosed) return;
    const m = e.data;
    if (m.boot !== undefined && m.boot !== boot) return;
    switch (m.type) {
      case 'wavPart': // MJPEG AVI sound, in parts before its 'frames' message
        (pendingWav = pendingWav || []).push(m.data);
        break;
      case 'frames':
        engine.dropPreload();
        begin(new FramePlayer(m.meta, m.wav || pendingWav), m.meta);
        pendingWav = null;
        showMessage('Loading…');
        break;
      case 'frame':
        if (player instanceof FramePlayer) player.onFrame(m.index, m.data);
        break;
      case 'libav': {
        if (self.vpeMarks && !self.vpeMarks.libavMsg) self.vpeMarks.libavMsg = Math.round(performance.timeOrigin + performance.now());
        try {
          // Opened again (reload while opening): the first player must not keep decoding or call begin().
          disposePlayer();
          if (m.meta && m.meta.native) engine.dropPreload();
          const p = new engine.LibavPlayer(m.meta, cfg.engine);
          player = p;
          updateMuteUi();
          subs.attach(p);
          showMessage('Opening…');
        } catch (err) {
          log(`decoder could not start: ${err && err.message || err}`);
          // The failed engine had already shown its (empty) canvas: a black or, in forced-colours themes, a white
          // box under the message. Hide it so the message reads on the stage in the theme's colours.
          canvas.hidden = true;
          showMessage('The decoder could not start.', String(err && err.message || err));
        }
        break;
      }
      // checkJs: start
      case /** @satisfies {BlockReply['type']} */ ('block'): {
        const reply = /** @type {BlockReply} */ (m);
        if (reply.page !== cfg.page) break;
        const receiver = /** @type {Partial<Pick<InstanceType<ReturnType<typeof createEngine>['LibavPlayer']>,
          'onBlock'>> | null} */ (player);
        if (receiver && receiver.onBlock) receiver.onBlock(reply.pos, reply.data, reply.error);
        break;
      }
      // checkJs: end
      case 'nd':
        if (player && player.onWorker) player.onWorker(m.m);
        break;
      case 'thumb': // native ffmpeg seek-bar thumbnail (engine.js hostThumb)
        if (player && player.onHostThumb) player.onHostThumb(m);
        break;
      case 'ndv':
        if (player && player.onNativeVideo) player.onNativeVideo(m);
        break;
      case 'nda':
        if (player && player.onNativeAudio) player.onNativeAudio(m);
        break;
      case 'benchStart':
        window.__bench = { t0: performance.now(), n: 0, bytes: 0, count: m.count };
        break;
      case 'bench': {
        const b = window.__bench;
        b.n++; b.bytes += m.data.byteLength;
        if (b.n === b.count) {
          const s = (performance.now() - b.t0) / 1000;
          log(`bench: ${b.n} messages, ${(b.bytes / 1e6).toFixed(0)} MB in ${s.toFixed(2)} s = ${(b.bytes / 1e6 / s).toFixed(0)} MB/s (${(b.n / s).toFixed(0)} msg/s)`);
        }
        break;
      }
      case 'benchFs': {
        // Test hook: localhost frame server throughput (src/frameserver.js, media/framestream.js).
        const b = { t0: performance.now(), n: 0, bytes: 0 };
        const fs = FrameStream.open({
          mode: m.mode, url: m.url,
          onOpen: () => { b.t0 = performance.now(); },
          onRecord: (head, data) => {
            if (head.kind === 2) {
              const s = (performance.now() - b.t0) / 1000;
              log(`benchFs: ${m.mode} ${b.n} frames, ${(b.bytes / 1e6).toFixed(0)} MB in ${s.toFixed(2)} s = ${(b.bytes / 1e6 / s).toFixed(0)} MB/s (${(b.n / s).toFixed(0)} frames/s)`);
              fs.close();
              return;
            }
            b.n++; b.bytes += data.byteLength;
          },
          onClose: (err) => log(`benchFs: ${m.mode} failed: ${err && err.message}`),
        });
        break;
      }
      case 'exactFrame': exact.onReply(m).then(wakeLoop, () => {}); break;
      case 'toast': toast(m.text, Math.min(10000, Number(m.ms)) || undefined); break;
      case 'hideSlowPlaybackNotice':
        cfg.hideSlowPlaybackNotice = true;
        if (!$('notice').hidden && $('notice').dataset.kind === 'slowPlayback') $('noticeClose').click();
        break;
      case 'hideReducedResNotice': cfg.hideReducedResNotice = true; break;
      case 'addMode': showAddMode(m); break;
      case 'compareOpen': setCompareOpen(!!m.open); break;
      case 'playbackPrefs': applyPlaybackPrefs(m.prefs); break;
      case 'focusMode': document.body.classList.toggle('maxi', !!m.active); break;
      // The user started the GPU test from the slow-playback offer: it waits for native playback to stop.
      case 'pauseForTest': if (player && player.isPlaying()) { player.pause(); toast('Paused while ffmpeg is tested', 3000); } break;
      case 'prefs': if (m.prefs && m.prefs.jump) { Object.assign(prefs.jump, m.prefs.jump); if (m.prefs.stepButtons) prefs.stepButtons = m.prefs.stepButtons === 'jump' ? 'jump' : 'frame'; if (m.prefs.transcode) prefs.transcode = m.prefs.transcode; if (m.prefs.transcodeMaxBitrate !== undefined) prefs.transcodeMaxBitrate = Number(m.prefs.transcodeMaxBitrate) || 0; if (m.prefs.transcodeResolution !== undefined) prefs.transcodeResolution = Number(m.prefs.transcodeResolution) || 0; stepTips(); controls.refresh(); } break;
      case 'ffmpegState': ffmpegState = { installed: !!m.installed, offer: !!m.offer, mb: Number(m.mb) || 0 }; if (player) player.ffmpeg = ffmpegState; break;
      case 'goto': insp.goToLink(m); break;
      case 'abQuery':
        sendRange(m.then === 'clip' ? 'clipRange' : m.then === 'ffmpeg' ? 'ffmpegRange' : 'exportRange', true);
        break;
      case 'exportGrab': if (m.page === cfg.page) exportGrab(m.id, m.frame); break;
      case 'exportEnd': break;
      case 'subs': try { subs.onSubs(m); } catch (err) { log(`subtitles failed: ${err && err.stack || err}`); } break;
      case 'stream': // HLS: the variants for the Quality page
        streamQ = m.quality && Array.isArray(m.quality.variants) ? m.quality : null;
        if (controls) controls.refresh();
        break;
      case 'visible':
        setVisible(m.visible);
        break;
      case 'error':
        engine.dropPreload();
        // The one action an error offers: the ffmpeg setup (a URL that needs ffmpeg).
        showMessage(m.message, m.hint, m.action === 'setupFfmpeg' ? { id: 'setupFfmpeg', label: 'Set up ffmpeg' } : null);
        break;
      case 'status': // opening a URL: what the host is doing (connecting, reading the playlist)
        if (!player && !overlay.hidden) showMessage(String(m.text || ''));
        break;
    }
  });

  const { columnLevels, targets75 } = VpeScopes;
  const { debugPixels, probe: probeHdr } = VpeHdr;
  // checkJs: start
  if (cfg.debug && globalThis.VpeDebugProbe) {
    debugProbe = globalThis.VpeDebugProbe.install({
      log,
      getPlayer: () => player,
      isLibavPlayer: (p) => p instanceof engine.LibavPlayer,
      stage,
      canvas,
      overlay,
      message,
      hint,
      actionBtn,
      dropHint,
      compareBackdrop,
      ui,
      controls,
      ctxMenu,
      insp,
      scopes: {
        mode: () => scopes.mode(),
        analysis: () => scopes.analysis(),
        perf: () => scopes.perf(),
        columnLevels,
        targets75,
      },
      hdr: {
        debugPixels,
        probe: probeHdr,
      },
      ab: {
        presentationRange: () => ab.presentationRange(),
      },
      frameText,
      step,
      setRate,
      runTool,
      getToolCount: () => TOOLS.length,
      getState: () => ({
        prefs,
        volume,
        muted,
        loop,
        streamQ,
        loopStats,
        loopBusy: loopBusy(),
        picturePct: pictureState().pct,
        seekDragging: seekDragger.dragging(),
        volumeDragging: volumeDragger.dragging(),
      }),
    });
  }
  // checkJs: end

  // Start-up timeline (engine.js logs it with the first frame when debugging).
  (self.vpeMarks || (self.vpeMarks = {})).ready = Math.round(performance.timeOrigin + performance.now());
  // The picture area in device pixels: the host's "Auto" quality for HLS picks a picture that covers it.
  const readyView = (() => { const r = stage.getBoundingClientRect(); const k = window.devicePixelRatio || 1; const w = Math.round(r.width * k), h = Math.round(r.height * k); return w >= 16 && h >= 16 ? { w, h } : null; })();
  vscode.postMessage({ type: 'ready', page: cfg.page, origin: window.location.origin, view: readyView });
  // The WebAssembly decoder loads while the host decides how to play the file (ffprobe etc.):
  // the GPU (WebCodecs) and WebAssembly paths both need it; native ffmpeg drops it.
  if (cfg.engine && cfg.engine.preload !== false) engine.preload({ ...cfg.engine, debug: !!cfg.debug });
})();
