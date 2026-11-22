// @ts-check
'use strict';
/** @import { BlockReply } from '../tools/read-block-contract.js' */
(function () {
  const vscode = acquireVsCodeApi();
  const cfg = JSON.parse(/** @type {HTMLElement} */ (document.getElementById('cfg')).textContent || '{}');
  const $ = (/** @type {string} */ id) => /** @type {any} */ (document.getElementById(id));
  const stage = $('stage'), canvas = $('canvas');
  const overlay = $('overlay'), message = $('message'), hint = $('hint');
  const ui = {
    bar: $('bar'), play: $('play'), prev: $('prev'), next: $('next'), seek: $('seek'), buffered: $('buffered'), tip: $('tip'),
    time: $('time'), now: $('now'), dur: $('dur'), rate: $('rate'), mute: $('mute'), volume: $('volume'),
    info: $('info'), infoBtn: $('infoBtn'), full: $('full'), cog: $('cog'), picBtn: $('picBtn'),
    panel: $('panel'), sheet: $('sheet'), toast: $('toast'), abMarks: $('abMarks'), tracks: $('tracks'),
  };

  const log = (/** @type {any[]} */ ...a) => vscode.postMessage({ type: 'log', msg: a.map(String).join(' ') });
  window.addEventListener('error', (e) => log('error:', e.message, `${e.filename}:${e.lineno}`));
  window.addEventListener('unhandledrejection', (e) => log('unhandled rejection:', e.reason && e.reason.stack || e.reason));

  // Restored after a reload (file changed on disk, window reload).
  const saved = vscode.getState() || {};
  /** @type {any} */
  let player = null;
  let loop = saved.loop !== undefined ? saved.loop : !!cfg.loop;
  let muted = !!saved.muted;
  let volume = saved.volume !== undefined ? saved.volume : 1;
  let rate = saved.rate || 1;
  // Jump sizes of the arrow keys ('frame' or seconds): settings videoPreviewEnhanced.jump.*, changed in the cog's Jump sizes page.
  const prefs = {
    jump: { arrow: 5, shift: 1, ctrl: 'frame', ...((cfg.prefs && cfg.prefs.jump) || {}) },
    stepButtons: (cfg.prefs && cfg.prefs.stepButtons) === 'jump' ? 'jump' : 'frame',
    transcode: (cfg.prefs && cfg.prefs.transcode) || 'ask',
    transcodeMaxBitrate: Number(cfg.prefs && cfg.prefs.transcodeMaxBitrate) || 0,
  };
  // Picture size for this tab (Fit, Fill, Stretch, 100 %): starts as the setting videoPreviewEnhanced.pictureSize; the button and Z change this tab only.
  const startPicture = VpePicture.parse(cfg.prefs && cfg.prefs.pictureSize);
  // The bar's time: 0 m:ss.mmm, 1 SMPTE timecode, 2 frame number (a click on it cycles).
  let timeMode = Number(saved.timeMode) || 0;

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
    $('noticeText').textContent = n.text;
    announce(n.text);
    const btn = $('noticeAction');
    btn.hidden = !n.action;
    if (n.action) {
      btn.textContent = n.action.label;
      btn.onclick = () => { if (n.action.run) n.action.run(); else vscode.postMessage({ type: 'action', id: n.action.id }); if (n.action.close) $('notice').hidden = true; };
    }
    $('noticeClose').onclick = () => {
      const back = $('notice').contains(document.activeElement);
      $('notice').hidden = true;
      if (back) ui.play.focus();
    };
    $('notice').hidden = false;
  }
  /**
   * Pixel tools (inspector, scopes, 1:1 zoom, frame save/copy/export) on a video that native
   * ffmpeg scaled down or reduced to 8-bit: offer the built-in decoder's exact pixels, once per page.
   */
  let exactOffered = false;
  function exactTool(zoom = false) {
    const p = player;
    // Live transcode hands the pixel tools one exact frame from the host (exactFrame below); only 1:1 zoom has none.
    if (exactOffered || !p || !p.nativeLossy || (p.remoteStream && !zoom)) return;
    exactOffered = true;
    const { width, height } = (p.remoteStream ? p.meta : p.info?.video) || {};
    showNotice({
      text: `${p.remoteStream ? 'Live transcode' : 'Native ffmpeg'} shows this video at ${width ? `${width}×${height}` : 'a reduced size'}, 8-bit 4:2:0: pixel values and saved frames are not the file's own.`,
      action: { label: 'Use full resolution', id: 'fullRes' },
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

  function setInfo(meta) {
    const fps = meta.fps ? `${Number(meta.fps).toFixed(3).replace(/\.?0+$/, '')} fps · ` : '';
    const dims = meta.width ? `${meta.width}×${meta.height} · ` : '';
    ui.info.textContent = `${cfg.name}\n${dims}${fps}${meta.frames ? `${meta.frames} frames · ` : ''}` +
      `${fmtTime(meta.duration)}${meta.size ? ` · ${fmtSize(meta.size)}` : ''}\n${meta.label || ''}`;
    insp.decorateInfo(ui.info);
  }

  // ---- Frame player: JPEG/PNG frames decoded by the browser, on a canvas ---
  // Used for MJPEG AVI and image sequences. Frame accurate by construction.

  class FramePlayer {
    constructor(meta, wav) {
      this.meta = meta;
      this.n = meta.frames;
      this.fps = meta.fps;
      this.duration = this.n / this.fps;
      this.t = 0;
      this.playing = false;
      this.last = 0;
      /** @type {Map<number, ImageBitmap>} */ this.bitmaps = new Map();
      /** @type {Set<number>} */ this.inflight = new Set();
      this.shown = -1;
      this.ctx = canvas.getContext('2d');
      if (meta.width) { canvas.width = meta.width; canvas.height = meta.height; }
      canvas.hidden = false;
      this.audio = null;
      // wav: one buffer, or the parts the host sent ahead in 'wavPart' messages.
      const wavParts = Array.isArray(wav) ? wav : wav ? [wav] : [];
      if (wavParts.some((b) => b.byteLength)) {
        this.audio = new Audio(URL.createObjectURL(new Blob(wavParts, { type: 'audio/wav' })));
        this.audio.preload = 'auto';
      }
      this.request(0);
    }

    frameAt(t) { return Math.max(0, Math.min(this.n - 1, Math.floor(t * this.fps + 1e-6))); }
    currentFrame() { return this.frameAt(this.t); }
    currentTime() { return this.t; }
    isPlaying() { return this.playing; }

    play() {
      if (this.frameAt(this.t) >= this.n - 1) this.t = 0;
      this.playing = true;
      this.last = performance.now();
      this.syncAudio(true);
    }
    pause() {
      this.playing = false;
      if (this.audio) this.audio.pause();
    }
    seekTime(t) { this.seekFrame(Math.floor(t * this.fps)); }
    seekFrame(i) {
      i = Math.max(0, Math.min(this.n - 1, i));
      this.t = (i + 0.5) / this.fps;
      this.syncAudio(true);
    }
    setRate() { this.syncAudio(true); }
    setVolume() { if (this.audio) { this.audio.muted = muted; this.audio.volume = volume; } }
    setLoop() {}

    syncAudio(force) {
      const a = this.audio;
      if (!a) return;
      a.playbackRate = rate;
      a.muted = muted;
      a.volume = volume;
      if (!this.playing || this.t >= a.duration) { if (!a.paused) a.pause(); return; }
      if (force || Math.abs(a.currentTime - this.t) > 0.12) a.currentTime = this.t;
      if (a.paused && !this.audioPending) {
        this.audioPending = true;
        a.play().catch((e) => {
          // Autoplay with sound needs a user gesture; continue muted.
          if (e && e.name === 'NotAllowedError' && !muted) { setMute(true); this.syncAudio(true); }
        }).finally(() => { this.audioPending = false; });
      }
    }

    tick(now) {
      if (this.playing) {
        this.t += (Math.min(250, now - this.last) / 1000) * rate;
        if (this.t >= this.duration) {
          if (loop) { this.t %= this.duration; this.syncAudio(true); }
          else { this.t = (this.n - 0.5) / this.fps; this.pause(); }
        }
        this.syncAudio(false);
      }
      this.last = now;
      const target = this.frameAt(this.t);
      this.request(target);
      if (target !== this.shown) {
        const bmp = this.bitmaps.get(target);
        if (bmp) {
          if (canvas.width !== bmp.width || canvas.height !== bmp.height) {
            canvas.width = bmp.width;
            canvas.height = bmp.height;
            if (!this.meta.width) { this.meta.width = bmp.width; this.meta.height = bmp.height; setInfo(this.meta); }
          }
          this.ctx.drawImage(bmp, 0, 0);
          this.shown = target;
        }
      }
    }

    request(target) {
      const ahead = Math.max(6, Math.min(120, Math.ceil(this.fps * rate * 0.75) + 4));
      const want = [];
      for (let k = 0; k <= ahead; k++) {
        let i = target + k;
        if (i >= this.n) { if (!loop) break; i -= this.n; }
        if (!this.bitmaps.has(i) && !this.inflight.has(i)) want.push(i);
      }
      // Keep a few frames behind for stepping backwards.
      for (let k = 1; k <= 4; k++) {
        const i = target - k;
        if (i >= 0 && !this.bitmaps.has(i) && !this.inflight.has(i)) want.push(i);
      }
      if (!want.length || this.inflight.size > ahead * 2) return;
      for (const i of want) this.inflight.add(i);
      vscode.postMessage({ type: 'frames', indices: want });
      this.evict(target, ahead);
    }

    evict(target, ahead) {
      if (this.bitmaps.size < ahead * 3 + 30) return;
      for (const [i, bmp] of this.bitmaps) {
        let d = i - target;
        if (loop && d < -this.n / 2) d += this.n;
        if (d < -20 || d > ahead * 2) { bmp.close(); this.bitmaps.delete(i); }
      }
    }

    onFrame(index, data) {
      createImageBitmap(new Blob([data])).then((bmp) => {
        this.inflight.delete(index);
        const old = this.bitmaps.get(index);
        if (old) old.close();
        this.bitmaps.set(index, bmp);
        if (this.shown < 0) showMessage('');
      }, (e) => {
        this.inflight.delete(index);
        log(`frame ${index} failed to decode: ${e}`);
        if (this.shown < 0) showMessage(`Frame ${index + 1} could not be decoded.`);
      });
    }

    snapshotSource() { return canvas; }
    bufferedRanges() { return []; }
  }

  // ---- Controls -----------------------------------------------------------

  let scrubbing = false;
  let lastUi = '';
  /** Writes the bar from the player's state; true when the time, frame or play state shown changed. */
  function updateUi() {
    if (!player) return false;
    const f = player.currentFrame();
    if (!scrubbing) ui.seek.value = String(f);
    const playing = player.isPlaying();
    const dur = player.meta.duration || 0;
    const t = player.currentTime();
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
      ui.seek.setAttribute('aria-valuetext', `${fmtTime(player.currentTime())} of ${fmtTime(dur)}, frame ${f + 1}`);
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

  // Decoder status (engine status()): no pill on the bar any more. A real problem (decoding falls behind)
  // shows the notice once per page, with its action; the rest ("Fully decoded", "2.0 s decoded ahead")
  // stays quiet (the stats overlay, Shift+I, has the numbers).
  let ffmpegState = null; // from the host: {installed, offer, mb}
  const warned = new Set();
  function updateStatus() {
    const st = player && player.status ? player.status() : null;
    if (!st || st.level !== 'warn') return;
    const kind = st.action || 'slow';
    if (warned.has(kind)) return;
    warned.add(kind);
    if (st.action === 'setupFfmpeg') { showNotice({ text: st.title.replace(/ Click to .*$/, ''), action: { label: 'Set up ffmpeg', id: 'setupFfmpeg', close: true } }); return; }
    const p = player;
    const every = /every frame|slowed down/.test(st.text);
    showNotice({
      text: st.title.replace(/ Click to .*$/, ''),
      action: p && p.toggleWhenSlow && !p.fast ? { label: every ? 'Skip frames instead' : 'Show every frame', close: true, run: () => vscode.postMessage({ type: 'whenSlow', value: p.toggleWhenSlow() }) } : null,
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
  let pendingSeekFrame = null;
  let lastSeekAt = 0;
  // The frame loop rests while nothing can change on its own: paused, the engine settled (no seek,
  // read or decode under way), no drag, no tool that draws by itself, and nothing changed for
  // REST_AFTER_MS. Input events, messages (host, workers) and decoder outputs wake it (wakeLoop);
  // a resting page leaves the renderer and GPU process idle instead of waking them on every refresh.
  const REST_AFTER_MS = 1000;
  let loopOn = true;
  let quietSince = null;
  const loopStats = { frames: 0, rests: 0 }; // test hook (state)
  function wakeLoop() {
    quietSince = null;
    if (loopOn) return;
    loopOn = true;
    requestAnimationFrame(frameLoop);
  }
  for (const ev of ['message', 'pointerdown', 'pointermove', 'pointerup', 'wheel', 'keydown', 'keyup', 'input', 'change', 'click', 'focusin', 'resize', 'fullscreenchange', 'visibilitychange']) {
    window.addEventListener(ev, wakeLoop, { capture: true, passive: true });
  }
  // The right-click menu reads data-vscode-context when it opens: bring it up to date first.
  window.addEventListener('contextmenu', () => { wakeLoop(); updateMenuContext(); }, true);
  /** Test hook (state): what keeps the loop from resting now, '' when nothing. */
  function loopBusy() {
    const p = player;
    if (!p) return 'no player';
    if (typeof p.settled !== 'function') return 'frame player';
    const e = !p.settled() ? `engine(${['playing', 'requesting', 'catchUp', 'skipping', 'firstShown', 'eof'].map((k) => `${k}=${!!p[k]}`).join(',')},seek=${p.seekTarget},q=${p.queue.length},vq=${p.vdec ? p.vdec.decodeQueueSize : '-'},aq=${p.adec ? p.adec.decodeQueueSize : '-'})` : '';
    return [e, scrubbing && 'scrubbing', pendingSeekFrame !== null && 'seek pending', seekDragger.dragging() && 'seek drag', volumeDragger.dragging() && 'volume drag',
      !insp.idle() && 'inspector', scopes.mode() && 'scopes', xray && xray.isShown() && 'xray'].filter(Boolean).join(' ');
  }
  /** Whether the loop may rest now (see REST_AFTER_MS). */
  function restful() {
    return !!player && typeof player.settled === 'function' && player.settled() && !player.isPlaying()
      && !scrubbing && pendingSeekFrame === null && !seekDragger.dragging() && !volumeDragger.dragging()
      && insp.idle() && !scopes.mode() && !(xray && xray.isShown()) && !exactNeeded();
  }
  function frameLoop(now) {
    loopStats.frames++;
    let changed = false;
    if (player) {
      // The remote stream restarts ffmpeg on the remote host per seek: wait for the last seek's frame
      // (up to 1.5 s, by how long the last one took) so each restart shows its frame instead of being cut off.
      const wait = player.remoteStream ? Math.min(1500, Math.max(250, 1.25 * (player.lastSeekMs || 0))) : 250;
      if (pendingSeekFrame !== null && (player.seekTarget === undefined || player.seekTarget === null || now - lastSeekAt > wait)) {
        player.seekFrame(pendingSeekFrame);
        pendingSeekFrame = null;
        lastSeekAt = now;
      }
      player.tick(now);
      exactTick(now);
      insp.tick(now);
      scopes.tick(now);
      subs.tick();
      { const to = ab.wrapTarget(player.currentTime(), player.isPlaying()); if (to !== null) player.seekTime(to); }
      changed = updateUi();
      if (xray) xray.chapterTicks();
      updateMenuContext();
      updateStatus();
      syncWakeLock(player.isPlaying());
      if (now - lastSave > 1000) {
        lastSave = now;
        // Only when something changed: a paused page wrote the same state and position every second.
        const state = { t: player.currentTime(), rate, volume, muted, loop, subs: subs.state(), timeMode, ...(switchPlay !== null ? { play: switchPlay } : {}) };
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
    else if (now - quietSince > REST_AFTER_MS) { loopOn = false; loopStats.rests++; return; }
    requestAnimationFrame(frameLoop);
  }
  requestAnimationFrame(frameLoop);

  function begin(p, meta) {
    player = p;
    p.ffmpeg = ffmpegState;
    subs.attach(p);
    setInfo(meta);
    ui.seek.max = String(Math.max(0, (p.n || 1) - 1));
    // Live streams play from the live edge; seeking is off (docs/notes/url-stream.md).
    ui.seek.disabled = !!(meta && meta.live);
    if (meta && meta.live) ui.seek.title = 'Live stream: seeking is not available';
    p.setRate(rate);
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
    ab.set(which, player.currentTime(), player.currentFrame());
    abChanged();
  }
  function clearAB() { ab.clear(); abChanged(); }
  /** The settings panel's A-B row: start, then end, then off. */
  function cycleAB() { if (!player) return; ab.cycle(player.currentTime(), player.currentFrame()); abChanged(); }
  function abLabel() { return ab.label(fmtClock); }
  function drawAB() {
    const m = ab.marks(player && player.meta.duration);
    ui.abMarks.hidden = m.hidden;
    if (m.hidden) return;
    ui.abMarks.style.left = `${m.left}%`;
    ui.abMarks.style.width = `${m.width}%`;
  }

  const togglePlay = () => { if (!player) return; player.isPlaying() ? player.pause() : player.play(); };
  const step = (d) => { if (!player) return; if (player.stepFrame) { player.stepFrame(d); return; } player.pause(); player.seekFrame(player.currentFrame() + d); };
  const skip = (s) => { if (!player) return; player.seekTime(player.currentTime() + s); toast(`${s > 0 ? '+' : ''}${s} s`); };
  /** Arrow keys: one frame or seconds, from the jump-size settings. */
  const jump = (size, dir) => { if (size === 'frame') step(dir); else skip(dir * Number(size)); };
  // Speed: 0.25–4× in steps of 0.05 (VpeControls.clampRate), the range in which the sound keeps its pitch.
  function setRate(r) {
    rate = VpeControls.clampRate(r);
    ui.rate.textContent = VpeControls.speedText(rate);
    ui.rate.setAttribute('aria-label', `Speed ${VpeControls.speedText(rate)}`);
    if (player) player.setRate(rate);
  }
  /** Sets the speed with a toast; at the ends of the range it says so. */
  function changeRate(r) {
    setRate(r);
    toast(`${VpeControls.speedText(rate)}${r > VpeControls.SPEED_MAX + 1e-9 ? ' (fastest)' : r < VpeControls.SPEED_MIN - 1e-9 ? ' (slowest)' : ''}`);
    if (controls) controls.refresh();
  }
  const bumpRate = (d) => changeRate(Math.round((rate + d * VpeControls.SPEED_STEP) * 100) / 100);
  function setJump(key, value) {
    prefs.jump[key] = value;
    stepTips();
    vscode.postMessage({ type: 'pref', key: `jump.${key}`, value });
    toast(`${key === 'arrow' ? '' : key === 'shift' ? 'Shift + ' : 'Ctrl + '}← → jump ${VpeControls.navName(value)}`);
  }
  function setStepButtons(value) {
    prefs.stepButtons = value;
    stepTips();
    vscode.postMessage({ type: 'pref', key: 'stepButtons', value });
    toast(value === 'jump' ? `Buttons beside Play jump ${VpeControls.navName(prefs.jump.ctrl)}` : 'Buttons beside Play step one frame');
  }
  function setTranscode(mode) {
    prefs.transcode = mode;
    vscode.postMessage({ type: 'transcodePref', mode });
    toast(`Live transcode: ${mode === 'ask' ? 'Ask' : mode === 'auto' ? 'Auto' : mode === 'always' ? 'Always' : 'Off'}`);
  }
  function setTranscodeMaxBitrate(mbps) {
    prefs.transcodeMaxBitrate = Number(mbps) || 0;
    vscode.postMessage({ type: 'transcodePref', maxBitrateMbps: prefs.transcodeMaxBitrate });
    toast(prefs.transcodeMaxBitrate > 0 ? `Max bitrate: ${prefs.transcodeMaxBitrate} Mb/s` : 'Max bitrate: Auto');
  }
  const setLoop = (l) => { loop = l; if (player && player.setLoop) player.setLoop(l); if (controls) controls.refresh(); };
  function setMute(m) {
    muted = m;
    ui.mute.classList.toggle('muted', m || volume === 0);
    ui.mute.setAttribute('aria-pressed', String(m));
    ui.mute.setAttribute('aria-label', m ? 'Unmute' : 'Mute');
    ui.mute.title = m ? 'Unmute  M' : 'Mute  M';
    if (player) player.setVolume(volume, muted);
  }
  const setVolume = (v) => {
    volume = Math.max(0, Math.min(1, Math.round(v * 100) / 100));
    ui.volume.value = String(volume);
    if (volume > 0 && muted) setMute(false); else setMute(muted);
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
  /** The technical details overlay (codec, pixel format, decoder; frame link, A-B export, X-ray): "Full technical details". */
  const toggleInfo = () => { ui.info.hidden = !ui.info.hidden; };

  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch (e) {
      // Some hosts don't allow fullscreen in webviews; maximize the editor instead.
      log(`fullscreen refused: ${e}`);
      document.body.classList.toggle('maxi');
      vscode.postMessage({ type: 'focusMode' });
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
  // ---- exact frames while Live transcode is active (media/exactframe.js, src/exact_frame.js) ----
  const exact = VpeExact.create({
    page: cfg.page, post: (m) => vscode.postMessage(m), toast, log,
    // Said once per failed frame (it is not asked for again): the tools carry on with the transcoded picture.
    onFail: (key, error) => toast(`Exact frame unavailable (${error}); showing live-transcode pixels`, 4500),
  });
  const exactActive = () => !!(player && player.remoteStream && !cfg.url);
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
    if (now - exactSettle.at >= 150 && !exact.inflight(key)) exact.grab(key, player.currentTime(), { notify: false }).then((r) => {
      if (cfg.debug && r && r.png) log(`exact frame ${r.w}x${r.h} for frame ${player.currentFrame() + 1}`); // test hook (layer 3)
      if (r) wakeLoop();
    });
  }
  /**
   * The PNG of the shown frame with its frame number, both taken before any await (stepping meanwhile must not
   * label this frame's pixels with another number). Live transcode: the host's exact frame, or the canvas when
   * it fails (the notice comes from onFail). null: nothing to save, or cancelled (resumed, stepped away).
   */
  async function frameBlob(what) {
    const frame = player.currentFrame();
    if (!exactActive()) { const blob = await grabFrame(); return blob ? { blob, frame } : null; }
    const key = exactKey();
    const r = await exact.grab(key, player.currentTime());
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
    vscode.postMessage({ type: 'saveFrame', frame: got.frame, data: new Uint8Array(await got.blob.arrayBuffer()) });
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
  const scopes = VpeScopes.create({ stage, canvas, getPlayer: () => player, toast, log, getExact: () => exactShown() });
  if (/** @type {any} */ (window).__vpe) /** @type {any} */ (window).__vpe.scopes = scopes; // test harness hook

  // ---- A-B export: the host asks for the range, then for each frame (src/extension.js exportRange) ----
  function abRange() {
    if (!player) return null;
    return ab.exportRange(player.fps || (player.meta && player.meta.fps) || 0, player.n || 0);
  }
  /**
   * Shows frame k (0-based) paused; resolves with the index of the frame on the canvas once the
   * seek settles (VFR or gapped video can land on a neighbour: the host names files from it), or null.
   */
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
      const check = () => {
        if (player !== p) { resolve(null); return; }
        const now = performance.now();
        if (now - last > 1000) t0 += now - last; // hidden (no animation frames): that time does not count
        last = now;
        if (p instanceof FramePlayer) { if (p.shown === k) { resolve(k); return; } } else if (p.seekTarget === null && p.shownT !== null && ((p.shownCount || 0) > before || now - t0 > 1000)) {
          resolve(p.currentFrame());
          return;
        }
        if (now - t0 > 20000) { resolve(null); return; }
        requestAnimationFrame(check);
      };
      requestAnimationFrame(check);
    });
  }
  let exportChain = Promise.resolve();
  function exportGrab(id, k) {
    exportChain = exportChain.then(async () => {
      try {
        if (!player) throw new Error('no video');
        const shown = await showFrame(k);
        if (shown === null) throw new Error(`frame ${k + 1} did not show`);
        const blob = await grabFrame();
        if (!blob) throw new Error('no picture');
        vscode.postMessage({ type: 'exportFrame', id, frame: shown, asked: k, data: new Uint8Array(await blob.arrayBuffer()) });
      } catch (e) {
        vscode.postMessage({ type: 'exportFrame', id, frame: k, error: String(e && e.message || e) });
      }
    });
  }
  // Two buttons in the details overlay (I), kept there when the details are rewritten.
  const exportBtns = document.createElement('span');
  exportBtns.className = 'exportBtns';
  const mkBtn = (text, then) => {
    const b = document.createElement('button');
    b.className = 'infoAction';
    b.textContent = text;
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      const range = abRange();
      if (!range) { toast('Set an A-B loop first (A, B)'); return; }
      vscode.postMessage({ type: then, range });
    });
    exportBtns.appendChild(b);
  };
  mkBtn('Export frames A–B…', 'exportRange');
  if (!cfg.url) mkBtn('Copy ffmpeg command for A–B', 'ffmpegRange'); // cuts a file: not for URLs
  const keepExportBtns = () => { if (exportBtns.parentElement !== ui.info) ui.info.append('\n', exportBtns); };
  new MutationObserver(keepExportBtns).observe(ui.info, { childList: true });
  keepExportBtns();

  ui.play.onclick = togglePlay;
  // The buttons beside Play: one frame, or the Ctrl+arrow jump size (setting stepButtons).
  const stepButton = (dir) => (prefs.stepButtons === 'jump' ? jump(prefs.jump.ctrl, dir) : step(dir));
  function stepTips() {
    const t = VpeControls.stepTips(prefs);
    ui.prev.title = t.back; ui.prev.setAttribute('aria-label', t.backLabel);
    ui.next.title = t.fwd; ui.next.setAttribute('aria-label', t.fwdLabel);
  }
  ui.prev.onclick = () => stepButton(-1);
  ui.next.onclick = () => stepButton(1);
  stepTips();
  ui.mute.onclick = () => setMute(!muted);
  ui.volume.addEventListener('input', () => setVolume(Number(ui.volume.value)));
  ui.volume.addEventListener('wheel', (e) => { e.preventDefault(); setVolume(volume + (e.deltaY < 0 ? 0.05 : -0.05)); toast(`Volume ${Math.round(volume * 100)}%`); }, { passive: false });
  const seekDragger = VpeRangeDrag.bind(ui.seek, (e) => {
    const r = ui.seek.getBoundingClientRect();
    if (e?.type !== 'pointerup' || e.clientX < r.left || e.clientX > r.right ||
      e.clientY < r.top - 4 || e.clientY > r.bottom + 4) hideTip();
  });
  const volumeDragger = VpeRangeDrag.bind(ui.volume);
  ui.full.onclick = toggleFullscreen;
  ui.time.onclick = () => {
    // A live stream shows only the time since it started (no timecode or frame count to cycle to).
    if (player && player.meta && player.meta.live) { toast('Live stream'); return; }
    timeMode = (timeMode + 1) % 3; lastUi = ''; updateUi(); toast(['Time', 'Timecode', 'Frame number'][timeMode]); };
  ui.seek.addEventListener('input', () => { scrubbing = true; pendingSeekFrame = Number(ui.seek.value); });
  ui.seek.addEventListener('change', () => {
    scrubbing = false;
    if (player && pendingSeekFrame !== null) { player.seekFrame(pendingSeekFrame); pendingSeekFrame = null; lastSeekAt = performance.now(); }
  });
  // Hover tip: time and frame, with a keyframe thumbnail above it (engine.js thumbnail(), thumbs.js).
  const thumbBox = document.createElement('div');
  thumbBox.id = 'thumb';
  thumbBox.hidden = true;
  const thumbCv = document.createElement('canvas');
  thumbBox.appendChild(thumbCv);
  ui.tip.parentElement.appendChild(thumbBox);
  let thumbShown = false;
  // Dragging (mouse held on the bar): the tip and thumbnail follow the slider value, also off the bar.
  ui.seek.addEventListener('input', () => {
    if (!seekDragger.dragging()) return; // keyboard on the focused slider: no tip
    const r = ui.seek.getBoundingClientRect();
    const max = Number(ui.seek.max) || 0;
    if (max > 0) showTip(r.left + (Number(ui.seek.value) / max) * r.width);
  });
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
    const asked = player.thumbnail && player.thumbnail(t, (/** @type {any} */ p) => {
      if (ui.tip.hidden) return;
      ThumbService.draw(thumbCv, p);
      thumbBox.hidden = false;
      thumbShown = true;
      place();
    });
    if (!asked) thumbBox.hidden = true;
    else if (thumbShown) place();
  }
  ui.seek.addEventListener('mouseleave', () => { if (!seekDragger.dragging()) hideTip(); });
  function hideTip() {
    ui.tip.hidden = true;
    thumbBox.hidden = true;
    thumbShown = false;
    if (player && player.thumbnailLeave) player.thumbnailLeave();
  }
  // A click on the picture closes an open panel or the shortcuts sheet; otherwise it plays / pauses.
  stage.addEventListener('click', () => { if (controls && controls.anyOpen()) { controls.closeAll(false); return; } togglePlay(); });
  stage.addEventListener('dblclick', toggleFullscreen);
  stage.addEventListener('wheel', (e) => { if (insp.onWheel(e)) { e.preventDefault(); return; } if (player && !player.isPlaying()) { e.preventDefault(); step(e.deltaY > 0 ? 1 : -1); } }, { passive: false });
  setRate(rate);
  ui.volume.value = String(volume);
  setMute(muted);

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
    if (insp.onKey(e)) { e.preventDefault(); if (e.ctrlKey || e.metaKey) e.stopPropagation(); return; }
    if (e.key === 'Escape' && controls && controls.anyOpen()) { e.preventDefault(); controls.closeAll(true); return; }
    if (e.key === 'Escape' && !addHint.hidden) { e.preventDefault(); vscode.postMessage({ type: 'stopAddMode' }); return; }
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
      case 'ArrowUp': setVolume(volume + 0.05); toast(`Volume ${Math.round(volume * 100)}%`); break;
      case 'ArrowDown': setVolume(volume - 0.05); toast(`Volume ${Math.round(volume * 100)}%`); break;
      case 'Home': player.seekFrame(0); break;
      case 'End': player.pause(); player.seekFrame(player.n - 1); break;
      case 'm': case 'M': setMute(!muted); break;
      case 'r': case 'R': setLoop(!loop); toast(loop ? 'Loop on' : 'Loop off'); break;
      case 'f': case 'F': toggleFullscreen(); break;
      case 'N': if (e.shiftKey) vscode.postMessage({ type: 'neighbour', d: 1 }); else handled = false; break;
      case 'P': if (e.shiftKey) vscode.postMessage({ type: 'neighbour', d: -1 }); else handled = false; break;
      case 'a': case 'A': setAB('a'); break;
      case 'b': case 'B': setAB('b'); break;
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
    setMuteUi: (m) => setMute(m),
    onReady: (p) => { begin(p, p.meta); },
    onMeta: (p) => { ui.seek.max = String(Math.max(0, p.n - 1)); setInfo(p.meta); if (controls) controls.refresh(); },
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
  const sendRange = (type) => {
    const range = abRange();
    if (!range) { toast('Set an A-B loop first (A, B)'); return; }
    vscode.postMessage({ type, range });
  };
  const TOOLS = [
    // Compare needs a second file next to this one: not offered for a URL (Open Video URL…).
    ...(cfg.url ? [] : [{ label: 'Compare', key: 'Shift+D', run: () => addMode() }]),
    { label: 'Scopes', key: 'W', run: () => { exactTool(); scopes.cycle(); } },
    { label: 'Inspector', key: 'X', run: () => { exactTool(); press('x'); } },
    { label: 'Stats', key: 'Shift+I', run: () => press('I', { shiftKey: true }) },
    { label: 'Codec X-ray', key: 'Shift+X', run: () => press('X', { shiftKey: true }) },
    { label: 'Export A-B', key: 'A, B', run: () => sendRange('exportRange') },
  ];
  // Older names (test hooks and the earlier Tools menu) for the same tools.
  const MORE_TOOLS = {
    'Pixel inspector': () => runTool('Inspector'), 'Stats overlay': () => runTool('Stats'), 'Codec X-ray strip': () => runTool('Codec X-ray'),
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
  const pictureState = () => { const v = insp.picture(); return { mode: v.mode, pct: player && player.meta && player.meta.width ? insp.zoomPercent() : null, zoomed: v.zoom !== 1 }; };
  controls = VpeControls.create({
    panel: ui.panel, sheet: ui.sheet, bar: ui.bar,
    buttons: { cog: ui.cog, info: ui.infoBtn, rate: ui.rate, tracks: ui.tracks },
    get: () => {
      const d = subs.panelData();
      return {
        rate, loop, jump: prefs.jump, stepButtons: prefs.stepButtons, abLabel: abLabel(), picture: pictureState(), tools: TOOLS,
        subsLabel: d.subs.length ? d.label : 'None in file',
        audioLabel: d.audio.length ? (d.audio.find((a) => a.checked) || d.audio[0]).main : (player && player.info && player.info.audio) || (player && player.audio) ? 'Only one' : 'None',
        hasSound: !!(player && ((player.info && player.info.audio) || player.audio)),
        tracks: d, facts: infoFacts(), canExternal: !!cfg.canOpenExternal,
        canUseOriginal: !!(player && player.remoteStream),
        transcode: !cfg.url && !(player instanceof FramePlayer) ? { mode: prefs.transcode, maxBitrateMbps: prefs.transcodeMaxBitrate, active: !!(player && player.remoteStream) } : null,
        quality: streamQ,
      };
    },
    act: {
      loop: () => { setLoop(!loop); toast(loop ? 'Loop on' : 'Loop off'); },
      cycleAB: () => cycleAB(),
      copyFrame: () => copyFrame(),
      setRate, pickRate: changeRate,
      stepRate: (d) => bumpRate(d),
      setJump: (k, v) => setJump(k, v),
      setStepButtons: (v) => setStepButtons(v),
      setTranscode: (m) => setTranscode(m),
      setTranscodeMaxBitrate: (r) => setTranscodeMaxBitrate(r),
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
      moreInfo: () => { ui.info.hidden = false; },
      external: () => vscode.postMessage({ type: 'external' }),
      extSettings: () => vscode.postMessage({ type: 'openSettings' }),
      // Only opens VS Code's input box: the URL is typed there, never sent from this page.
      openUrl: () => vscode.postMessage({ type: 'openUrl' }),
      setQuality: (pick) => setQuality(pick),
    },
  });
  ui.cog.onclick = (e) => { e.stopPropagation(); controls.toggle('main', ui.cog); };
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
    $('startCompareLabel').textContent = label;
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

  // ---- Right-click menu (package.json "webview/context", src/extension.js ctx commands) ----
  // VS Code shows its own menu from the data-vscode-context of the clicked element and its parents;
  // this one helper keeps that JSON current (when-clauses read vpe*), and 'menu' messages run the
  // chosen item through the same functions as the keys and buttons.
  let ctxJson = '';
  function updateMenuContext() {
    const av = subs.available();
    const o = {
      preventDefaultContextMenuItems: true, vpe: true, vpeReady: !!player,
      vpePlaying: !!player && player.isPlaying(), vpeLoop: loop, vpeMuted: muted,
      vpeFile: !cfg.url && !(player instanceof FramePlayer), vpeSubs: av.subs > 0, vpeAudio: av.audio > 1, vpeAB: ab.isRange(), vpeABSet: ab.isSet(),
    };
    const j = JSON.stringify(o);
    if (j !== ctxJson) { ctxJson = j; document.body.setAttribute('data-vscode-context', j); }
  }
  const MENU_ACTIONS = {
    playPause: () => togglePlay(), compareWith: () => compareWith(), loop: () => { setLoop(!loop); toast(loop ? 'Loop on' : 'Loop off'); }, mute: () => setMute(!muted),
    speed: (m) => { if (Number(m.value) > 0) { setRate(Number(m.value)); toast(`${rate}×`); } },
    copyFrame: () => copyFrame(), saveFrame: () => saveFrame(), copyLink: () => press('C', { shiftKey: true }),
    copyTime: () => { if (player) vscode.postMessage({ type: 'copyText', text: fmtTime(player.currentTime()) }); toast('Timestamp copied'); },
    subs: () => controls.show('subs', ui.tracks), audio: () => controls.show('audio', ui.cog),
    fullscreen: () => toggleFullscreen(),
    stepBack: () => stepButton(-1), stepFwd: () => stepButton(1), keys: () => controls.openSheet(ui.cog), cog: () => controls.show('main', ui.cog),
    xray: () => press('X', { shiftKey: true }),
    // From the menu "Set" always sets (at this moment); the A / B keys toggle.
    setA: () => { if (player) { ab.reset('a', player.currentTime(), player.currentFrame()); abChanged(); } }, setB: () => { if (player) { ab.reset('b', player.currentTime(), player.currentFrame()); abChanged(); } },
    clearAB: () => clearAB(),
    inspector: () => { exactTool(); press('x'); }, scopes: () => { exactTool(); scopes.cycle(); }, stats: () => press('I', { shiftKey: true }),
  };
  updateMenuContext();

  // ---- Messages from the extension ----------------------------------------

  let pendingWav = null;
  window.addEventListener('message', (e) => {
    const m = e.data;
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
          if (player && player.dispose) player.dispose();
          if (m.meta && m.meta.native) engine.dropPreload();
          const p = new engine.LibavPlayer(m.meta, cfg.engine);
          player = p;
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
      case 'addMode': showAddMode(m); break;
      case 'compareOpen': setCompareOpen(!!m.open); break;
      // The user started the GPU test from the slow-playback offer: it waits for native playback to stop.
      case 'pauseForTest': if (player && player.isPlaying()) { player.pause(); toast('Paused while ffmpeg is tested', 3000); } break;
      case 'prefs': if (m.prefs && m.prefs.jump) { Object.assign(prefs.jump, m.prefs.jump); if (m.prefs.stepButtons) prefs.stepButtons = m.prefs.stepButtons === 'jump' ? 'jump' : 'frame'; if (m.prefs.transcode) prefs.transcode = m.prefs.transcode; if (m.prefs.transcodeMaxBitrate !== undefined) prefs.transcodeMaxBitrate = Number(m.prefs.transcodeMaxBitrate) || 0; stepTips(); controls.refresh(); } break;
      case 'menu': if (MENU_ACTIONS[m.action]) { MENU_ACTIONS[m.action](m); updateMenuContext(); } break;
      case 'ffmpegState': ffmpegState = { installed: !!m.installed, offer: !!m.offer, mb: Number(m.mb) || 0 }; if (player) player.ffmpeg = ffmpegState; break;
      case 'goto': insp.goToLink(m); break;
      case 'abQuery': vscode.postMessage({ type: m.then === 'ffmpeg' ? 'ffmpegRange' : 'exportRange', range: abRange() }); break;
      case 'exportGrab': exportGrab(m.id, m.frame); break;
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

  if (cfg.debug) {
    log(`webview env: crossOriginIsolated=${self.crossOriginIsolated} SharedArrayBuffer=${typeof SharedArrayBuffer} cores=${navigator.hardwareConcurrency}`);
    setInterval(() => {
      if (!player) return;
      let s = `status frame=${player.currentFrame()} t=${player.currentTime().toFixed(2)} playing=${player.isPlaying()}`;
      if (player instanceof engine.LibavPlayer) {
        const q = player.queue;
        const shownNow = player.shownCount || 0;
        const fpsShown = ((shownNow - (player.__lastShown || 0)) / 2).toFixed(1);
        player.__lastShown = shownNow;
        // Native frames: received per second (and MB/s), CPU time of drawing one (upload + draw calls).
        const g = player.gl;
        if (player.cfg.native && g && !g.__timed) {
          g.__timed = { ms: 0, n: 0 };
          const draw = g.drawYuv.bind(g);
          g.drawYuv = (f) => { const t0 = performance.now(); draw(f); g.__timed.ms += performance.now() - t0; g.__timed.n++; };
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
    // Test hook: the extension host can drive the player through debug messages.
    window.addEventListener('message', (e) => {
      const m = e.data;
      if (m.type !== 'debug') return;
      if (DEBUG_PROBES.has(m.action)) { debugProbe(m); return; } // also before a player exists (error messages)
      if (!player) return;
      if (m.action === 'remoteStreamRate' && player.remoteStream) player.debugRemoteRate = m.bytesPerSecond;
      if (m.action === 'seek') player.seekTime(m.t);
      if (m.action === 'step') step(m.d);
      if (m.action === 'pause') player.pause();
      // Tests: a picture area of this many CSS pixels (as a resized panel or fullscreen would give); 0 restores it.
      if (m.action === 'stageSize') { stage.style.flex = m.h ? 'none' : ''; stage.style.width = m.w ? `${m.w}px` : ''; stage.style.height = m.h ? `${m.h}px` : ''; }
      if (m.action === 'wheel') stage.dispatchEvent(new WheelEvent('wheel', { deltaY: Number(m.deltaY) || 0, ctrlKey: !!m.ctrl, clientX: stage.getBoundingClientRect().width / 2, clientY: stage.getBoundingClientRect().height / 2, bubbles: true, cancelable: true }));
      if (m.action === 'drop') { // tests: a drop carrying these URI lists, as VS Code would deliver (Shift held)
        const dt = new DataTransfer();
        for (const [k, v] of Object.entries(m.data || {})) dt.setData(k, v);
        document.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true, cancelable: true }));
        log(`debug dropHint ${!dropHint.hidden}`);
        document.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
      }
      if (m.action === 'key') (m.target ? document.querySelector(m.target) : document).dispatchEvent(new KeyboardEvent('keydown', { key: m.key, shiftKey: !!m.shift, ctrlKey: !!m.ctrl, bubbles: true }));
      if (m.action === 'play') player.play();
      if (m.action === 'rate') setRate(m.r);
      if (m.action === 'panel') { if (m.view) controls.show(m.view, m.view === 'info' ? ui.infoBtn : m.view === 'speed' ? ui.rate : ui.cog); else controls.closeAll(false); }
      if (m.action === 'tool') { if (m.open) controls.show('main', ui.cog); else if (!runTool(m.label)) log(`tool not found: ${m.label}`); }
      if (m.action === 'modesReport') {
        setTimeout(() => {
          const vis = (el) => !!el && el.offsetWidth > 0 && el.offsetHeight > 0 && getComputedStyle(el).visibility !== 'hidden';
          const sc = document.getElementById('scopes');
          const xr = document.getElementById('xray');
          log(`modes report panel=${controls.view() || 'none'} sheet=${controls.sheetOpen()} tools=${TOOLS.length} ` +
            `bar=${['play', 'prev', 'next', 'seek', 'mute', 'volume', 'time', 'tracks', 'startCompareBtn', 'infoBtn', 'rate', 'cog', 'picBtn', 'full'].map((k) => `${k}:${vis(ui[k] || $(k)) ? 1 : 0}`).join(',')} ` +
            `scopes=${scopes.mode() || 'off'} scopesVisible=${vis(sc)} info=${vis(ui.info)} xray=${vis(xr)} zoomed=${stage.classList.contains('zoom')} picture=${insp.picture().mode} ` +
            `frame=${player.currentFrame() + 1} t=${player.currentTime().toFixed(3)} playing=${player.isPlaying()}`);
        }, m.delay || 300);
      }
      if (m.action === 'wcprobe') wcProbe().then((r) => log(`wcprobe ${JSON.stringify(r)}`), (e) => log(`wcprobe failed: ${e}`));
      if (m.action === 'report') setTimeout(() => log(`report frame=${player.currentFrame() + 1} frames=${player.n || '-'} t=${player.currentTime().toFixed(3)} playing=${player.isPlaying()} rate=${player.rate} sources=${player.sources ? player.sources.size : '-'} master=${player.audioMaster ? player.audioMaster() : "-"} ac=${player.ac ? player.ac.state : "-"} amode=${player.amode}`), m.delay || 300);
    });
  }

  const DEBUG_PROBES = new Set(['state', 'thumb', 'pixels', 'scopesDump', 'dom', 'gotoText', 'track', 'click', 'a11y', 'scrub', 'hdrcaps', 'hdrpixels']);
  /**
   * Test hook (debug only, test/vscode/lib.js): what the page shows, one JSON line per request
   * ("<action> {json}"), and synthetic input for what the debug keys cannot do (mouse, wheel, the
   * go-to box, menu items). Reads state and dispatches the same DOM events a user would; changes nothing else.
   */
  function debugProbe(m) {
    const byId = (id) => document.getElementById(id);
    const rect = (e) => { const r = e.getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; };
    try {
      switch (m.action) {
        case 'state': {
          const p = player;
          const sp = document.querySelector('.subs-pic');
          const vw = (() => { const r = canvas.getBoundingClientRect(); const k = Math.min(r.width / canvas.width, r.height / canvas.height); return [r.left + (r.width - canvas.width * k) / 2, r.top + (r.height - canvas.height * k) / 2, canvas.width * k, canvas.height * k]; })();
          const s = {
            id: m.id,
            toast: ui.toast.hidden ? '' : ui.toast.textContent, toastRect: ui.toast.hidden ? null : rect(ui.toast),
            status: p && p.status ? ((p.status() || {}).text || '') : '',
            notice: byId('notice').hidden ? '' : byId('noticeText').textContent,
            message: overlay.hidden ? '' : message.textContent, hint: overlay.hidden ? '' : hint.textContent,
            action: overlay.hidden || actionBtn.hidden ? '' : actionBtn.textContent, seekDisabled: ui.seek.disabled,
            frameText: p ? frameText(p.currentFrame(), p.n) : '', timeText: ui.time.textContent.replace(/\s+/g, ' ').trim(),
            panel: (() => {
              const pn = ui.panel;
              if (pn.hidden) return null;
              const text = (e) => (e.textContent || '').replace(/\s+/g, ' ').trim();
              return {
                view: controls.view(), label: pn.getAttribute('aria-label'), text: text(pn),
                rows: [...pn.querySelectorAll('button')].map((b) => ({ label: b.getAttribute('aria-label') || text(b), pressed: b.getAttribute('aria-pressed'), checked: b.getAttribute('aria-checked') })),
                facts: [...pn.querySelectorAll('.igrid dt')].map((dt) => [text(dt), text(/** @type {any} */ (dt.nextElementSibling))]),
                sliderRect: pn.querySelector('#speedSlider') ? rect(pn.querySelector('#speedSlider')) : null,
                slider: pn.querySelector('#speedSlider') ? [/** @type {any} */ (pn.querySelector('#speedSlider')).min, /** @type {any} */ (pn.querySelector('#speedSlider')).max] : null,
              };
            })(),
            sheet: ui.sheet.hidden ? null : (ui.sheet.textContent || '').replace(/\s+/g, ' ').trim(),
            bar: { rate: ui.rate.textContent, cc: ui.tracks.getAttribute('aria-label'), ccHidden: getComputedStyle(ui.tracks).display === 'none', cogExpanded: ui.cog.getAttribute('aria-expanded'), infoExpanded: ui.infoBtn.getAttribute('aria-expanded'), rateExpanded: ui.rate.getAttribute('aria-expanded'), ccExpanded: ui.tracks.getAttribute('aria-expanded') },
            prefs, volume, drag: { seek: seekDragger.dragging(), volume: volumeDragger.dragging() }, volumeRect: rect(ui.volume),
            canvas: [canvas.width, canvas.height], canvasHidden: canvas.hidden, canvasRect: rect(canvas), video: vw,
            stageClass: stage.className, stageRect: rect(stage), picture: { ...insp.picture(), pct: pictureState().pct, btnMode: ui.picBtn.dataset.mode, btnLabel: ui.picBtn.getAttribute('aria-label'), btnTitle: ui.picBtn.title, need: insp.zoomedSize() }, imageRendering: canvas.style.imageRendering,
            pxgrid: !!byId('pxgrid') && !byId('pxgrid').hidden, pxread: byId('pxread') && !byId('pxread').hidden ? byId('pxread').innerText : '',
            goto: !!byId('goto') && !byId('goto').hidden, stats: byId('stats') && !byId('stats').hidden ? byId('stats').textContent : '',
            infoShown: !ui.info.hidden, abMarks: { hidden: ui.abMarks.hidden, left: ui.abMarks.style.left, width: ui.abMarks.style.width },
            subsText: byId('subs') && !byId('subs').hidden ? byId('subs').textContent : '', muted: ui.mute.classList.contains('on'),
            dpr: globalThis.devicePixelRatio || 1, engine: !!(p && p.queue), loop: { ...loopStats, busy: loopBusy() }, vscodeContext: document.body.getAttribute('data-vscode-context') || '',
            seekRect: rect(ui.seek), quality: streamQ,
            thumb: (() => { const b = byId('thumb'); const c = b && b.querySelector('canvas'); let sig = ''; if (c && c.width) { const u = c.toDataURL(); let x = 0; for (let i = 0; i < u.length; i += 7) x = (x * 31 + u.charCodeAt(i)) | 0; sig = `${u.length}:${x}`; } return { hidden: !b || b.hidden, w: c ? c.width : 0, sig, rect: b ? rect(b) : null }; })(),
            tip: { hidden: ui.tip.hidden, rect: rect(ui.tip) },
            strip: p && p.thumbStrip ? p.thumbStrip() : null, seekValue: Number(ui.seek.value), seekMax: Number(ui.seek.max),
            tracksMenu: (() => { const m = ui.panel; const on = !m.hidden && (controls.view() === 'subs' || controls.view() === 'audio' || controls.view() === 'quality'); return { hidden: !on, items: on ? [...m.querySelectorAll('[role=radio], button.row:not(.head)')].map((x) => `${x.getAttribute('aria-checked') === 'true' ? '*' : ''}${(x.querySelector('.grow') || x).textContent.trim()}`) : [] }; })(),
            xray: (() => { const x = byId('xray'); const lg = byId('xrayLegend'); const tp = byId('xrayTip'); return { shown: !!x && !x.hidden, legend: lg ? lg.textContent : '', tip: tp && !tp.hidden ? tp.textContent : '', ticks: byId('xrayChapters') ? byId('xrayChapters').children.length : -1 }; })(),
          };
          if (p) {
            Object.assign(s, {
              vmode: p.vmode, amode: p.amode, fps: p.fps, n: p.n, duration: p.meta && p.meta.duration, shownCount: p.shownCount || p.shown || 0, eof: p.eof,
              audioMaster: p.audioMaster ? p.audioMaster() : null, ac: p.ac ? p.ac.state : null, sources: p.sources && p.sources.size !== undefined ? p.sources.size : null,
              t: p.currentTime(), frame: p.currentFrame(), label: p.meta && p.meta.label, firstShown: !!p.firstShown, gen: p.gen, playing: p.isPlaying(), rate: p.rate,
              hdr: p.gl ? p.gl.hdr : null, audioChunks: Array.isArray(p.audio) ? p.audio.length : null, audioChannels: Array.isArray(p.audio) && p.audio.length ? p.audio[0].buf.numberOfChannels : null,
              audioSeconds: Array.isArray(p.audio) ? p.audio.reduce((x, a) => x + a.dur, 0) : null,
              drift: p.audioMaster && p.audioMaster() && p.shownT !== null ? p.now() - p.shownT : null,
              tracks: p.tracks ? p.tracks() : null,
            });
            if (p.gl && p.gl.gl && p.gl.prog) { try { s.tf = p.gl.gl.getUniform(p.gl.prog, p.gl.uTf); } catch { /* not WebGL */ } }
          }
          s.subpic = sp && !sp.hidden ? [...sp.querySelectorAll('canvas.subs-bitmap')].map((e) => {
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
          if (!canvas.width || !canvas.height) { log(`thumb ${JSON.stringify({ id: m.id, error: 'no picture' })}`); break; }
          const mid = document.createElement('canvas'); mid.width = w * 4; mid.height = h * 4;
          const mc = mid.getContext('2d'); mc.imageSmoothingQuality = 'high'; mc.drawImage(canvas, 0, 0, mid.width, mid.height);
          const c = document.createElement('canvas'); c.width = w; c.height = h;
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
          const rgb = (m.pts || []).map(([x, y]) => { const px = new Uint8Array(4); g.readPixels(x, H - 1 - y, 1, 1, g.RGBA, g.UNSIGNED_BYTE, px); return [px[0], px[1], px[2]]; });
          log(`pixels ${JSON.stringify({ id: m.id, rgb })}`);
          break;
        }
        case 'hdrpixels': VpeHdr.debugPixels(player, m.pts || []).then((r) => log(`hdrpixels ${JSON.stringify({ id: m.id, ...r })}`), (e) => log(`hdrpixels ${JSON.stringify({ id: m.id, error: String(e) })}`)); break;
        case 'hdrcaps': VpeHdr.probe().then((r) => log(`hdrcaps ${JSON.stringify({ id: m.id, ...r })}`), (e) => log(`hdrcaps ${JSON.stringify({ id: m.id, error: String(e) })}`)); break;
        case 'scopesDump': {
          const an = scopes.analysis();
          const out = { id: m.id, mode: scopes.mode() || 'off', hidden: byId('scopes').hidden, perf: scopes.perf() };
          if (an) {
            out.w = an.w; out.h = an.h; out.matrix = an.matrix;
            const cols = Array.from({ length: 8 }, (_, i) => Math.floor((i + 0.5) * an.w / 8));
            out.cols = cols;
            if (an.wave) { let n = 0; for (const v of an.wave) n += v; out.waveN = n; out.wave = cols.map((c) => VpeScopes.columnLevels(an.wave, c, 0.5)); }
            if (an.parade) out.parade = [0, 1, 2].map((ch) => cols.map((c) => VpeScopes.columnLevels(an.parade[ch], c, 0.5)));
            if (an.vec) {
              const near = (x0, y0, rad) => { let n = 0; for (let y = Math.max(0, Math.floor(y0 - rad)); y <= Math.min(255, Math.ceil(y0 + rad)); y++) for (let x = Math.max(0, Math.floor(x0 - rad)); x <= Math.min(255, Math.ceil(x0 + rad)); x++) if (Math.hypot(x - x0, y - y0) <= rad) n += an.vec[y * 256 + x]; return n; };
              const total = an.w * an.h;
              out.vec = { targets: VpeScopes.targets75(an.matrix).map((tg) => ({ name: tg.name, x: tg.x, y: tg.y, share: near(tg.x, tg.y, 6) / total })), centre: near(128, 128, 4) / total };
            }
          }
          log(`scopesDump ${JSON.stringify(out)}`);
          break;
        }
        case 'dom': { // a mouse / pointer / wheel event at client (x, y), or on the element with id `id`
          const target = m.target === 'document' ? document : m.target ? byId(m.target) : document.elementFromPoint(m.x, m.y);
          if (!target) { log(`dom ${JSON.stringify({ id: m.id, error: `no element at ${m.x},${m.y}` })}`); break; }
          const init = { bubbles: true, cancelable: true, clientX: m.x, clientY: m.y, button: m.button || 0, ctrlKey: !!m.ctrl, deltaY: m.deltaY || 0, pointerId: 1, isPrimary: true };
          const Ctor = /^wheel/.test(m.ev) ? WheelEvent : /^pointer/.test(m.ev) ? PointerEvent : MouseEvent;
          target.dispatchEvent(new Ctor(m.ev, init));
          break;
        }
        case 'scrub': { // the slider dragged to `frac` (what the browser does while the mouse is held): input; end: change + pointerup
          const max = Number(ui.seek.max) || 0;
          ui.seek.value = String(Math.round(Math.max(0, Math.min(1, m.frac)) * max));
          ui.seek.dispatchEvent(new Event('input', { bubbles: true }));
          if (m.end) {
            ui.seek.dispatchEvent(new Event('change', { bubbles: true }));
            const r = ui.seek.getBoundingClientRect();
            document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1, clientX: r.left + m.frac * r.width, clientY: m.off ? r.top - 100 : r.top + r.height / 2 }));
          }
          log(`scrub ${JSON.stringify({ id: m.id, value: Number(ui.seek.value) })}`);
          break;
        }
        case 'gotoText': { // Ctrl+G, type, Enter
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'g', ctrlKey: true }));
          const input = document.querySelector('#goto input');
          if (!input) { log(`gotoText ${JSON.stringify({ id: m.id, error: 'no go-to box' })}`); break; }
          input.value = m.text;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
          break;
        }
        case 'track': {
          if (player && m.sub !== undefined && player.selectSub) player.selectSub(m.sub);
          if (player && m.audio !== undefined && player.selectAudio) player.selectAudio(m.audio);
          break;
        }
        case 'a11y': { // roles, names and states of the controls, the live region, focus (`focus`: a selector to focus first)
          if (m.focus) { const f = document.querySelector(m.focus); if (f) /** @type {any} */ (f).focus(); }
          const ATTRS = ['role', 'aria-label', 'aria-pressed', 'aria-expanded', 'aria-haspopup', 'aria-checked', 'aria-valuetext', 'aria-keyshortcuts', 'tabindex'];
          const attrs = (e) => (e ? Object.fromEntries(ATTRS.filter((a) => e.hasAttribute(a)).map((a) => [a, e.getAttribute(a)])) : null);
          const a = /** @type {any} */ (document.activeElement);
          const menuInfo = (mm) => ({
            hidden: mm.hidden, role: mm.getAttribute('role'), label: mm.getAttribute('aria-label'),
            items: [...mm.querySelectorAll('button')].map((b) => ({ role: b.getAttribute('role'), label: b.getAttribute('aria-label') || b.textContent.trim(), checked: b.getAttribute('aria-checked'), tabindex: b.getAttribute('tabindex') })),
            groups: [...mm.querySelectorAll('[role=group]')].map((g) => g.getAttribute('aria-label')),
            separators: mm.querySelectorAll('[role=separator]').length,
            // Children of a menu other than items, groups and separators (headings are aria-hidden).
            stray: [...mm.querySelectorAll('*')].filter((x) => !x.closest('[aria-hidden=true]') && x.parentElement && (x.parentElement === mm || x.parentElement.getAttribute('role') === 'group')
              && !/^(menuitem|menuitemradio|menuitemcheckbox|group|separator)$/.test(x.getAttribute('role') || '') && x.getAttribute('aria-hidden') !== 'true').map((x) => x.className || x.tagName),
          });
          // Buttons on the page with no accessible name in words (a symbol such as ▶ is not one); empty ones are unused placeholders.
          const unnamed = [...document.querySelectorAll('button')].filter((b) => (b.textContent || b.getAttribute('aria-label')) && !/[A-Za-z]/.test(b.getAttribute('aria-label') || b.textContent || '')).map((b) => b.id || b.className || b.textContent);
          const cs = a && a !== document.body ? getComputedStyle(a) : null;
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
            panel: Object.assign(menuInfo(ui.panel), { view: controls.view(), radios: [...ui.panel.querySelectorAll('[role=radio], [role=switch]')].map((b) => ({ role: b.getAttribute('role'), checked: b.getAttribute('aria-checked') })) }),
            sheet: { hidden: ui.sheet.hidden, dialog: (() => { const d = ui.sheet.querySelector('[role=dialog]'); return d ? { label: d.getAttribute('aria-label'), modal: d.getAttribute('aria-modal'), groups: [...d.querySelectorAll('[role=group]')].map((g) => g.getAttribute('aria-label')) } : null; })() },
            unnamed, playing: player ? player.isPlaying() : null, muted, loop,
          })}`);
          break;
        }
        case 'click': { // the first element matching `sel` (whose text contains `text`, when given)
          const e = [...document.querySelectorAll(m.sel)].find((x) => !m.text || (x.textContent || '').includes(m.text));
          log(`click ${JSON.stringify({ id: m.id, found: !!e, disabled: !!(e && e.disabled) })}`);
          if (e) e.click();
          break;
        }
      }
    } catch (e) { log(`${m.action} ${JSON.stringify({ id: m.id, error: String(e && e.stack || e) })}`); }
  }

  /** Test hook (debug only): WebCodecs support matrix in this webview, here and in a worker. */
  async function wcProbe() {
    const C = {
      h264: ['avc1.640033', 3840, 2160], hevc8: ['hvc1.1.6.L153.B0', 3840, 2160], hevc10: ['hvc1.2.4.L153.B0', 3840, 2160],
      vp8: ['vp8', 1920, 1080], vp9: ['vp09.00.51.08', 3840, 2160], vp9_10: ['vp09.02.51.10', 3840, 2160],
      av1: ['av01.0.12M.08', 3840, 2160], av1_10: ['av01.0.12M.10', 3840, 2160],
    };
    // Sound: Y supported, - not, E the check threw (flac/vorbis are also asked with a description).
    const A = { aac: 'mp4a.40.2', opus: 'opus', mp3: 'mp3', flac: 'flac', vorbis: 'vorbis', pcm: 'pcm-s16' };
    async function run() {
      const out = { VideoDecoder: typeof VideoDecoder, AudioDecoder: typeof AudioDecoder };
      for (const [k, [codec, w, h]] of Object.entries(C)) {
        let s = '';
        for (const hw of ['prefer-hardware', 'no-preference', 'prefer-software']) {
          try { s += (await VideoDecoder.isConfigSupported({ codec, codedWidth: w, codedHeight: h, hardwareAcceleration: /** @type {any} */ (hw) })).supported ? 'Y' : '-'; } catch (e) { s += 'E'; }
        }
        out[k] = s;
      }
      out.audio = {};
      for (const [k, codec] of Object.entries(A)) {
        let s = '';
        for (const desc of [null, new Uint8Array(64)]) {
          const c = { codec, sampleRate: 48000, numberOfChannels: 2 };
          if (desc) c.description = desc;
          try { s += (await AudioDecoder.isConfigSupported(c)).supported ? 'Y' : '-'; } catch (e) { s += 'E'; }
        }
        out.audio[k] = s;
      }
      return out;
    }
    const src = `const C=${JSON.stringify(C)};const A=${JSON.stringify(A)};${run.toString()}`;
    const page = await run();
    let worker = null;
    try {
      const url = URL.createObjectURL(new Blob([`${src};run().then((r)=>postMessage(r),(e)=>postMessage(String(e)));`], { type: 'text/javascript' }));
      worker = await new Promise((res) => { const w = new Worker(url); w.onmessage = (e) => { res(e.data); w.terminate(); }; w.onerror = (e) => res(`worker error ${e.message}`); });
    } catch (e) { worker = `no worker: ${e}`; }
    // <video>/MSE (not used by the player; shows what the webview's media stack has).
    const T = {
      h264: 'video/mp4; codecs="avc1.640028"', hevc: 'video/mp4; codecs="hvc1.1.6.L120.90"', av1: 'video/mp4; codecs="av01.0.08M.08"',
      vp8: 'video/webm; codecs="vp8"', vp9: 'video/webm; codecs="vp9"', aac: 'audio/mp4; codecs="mp4a.40.2"', opus: 'audio/webm; codecs="opus"',
      mp3: 'audio/mpeg', flac: 'audio/flac', vorbis: 'audio/ogg; codecs="vorbis"',
    };
    const media = {};
    const el = document.createElement('video');
    for (const [k, t] of Object.entries(T)) {
      media[k] = `${el.canPlayType(t) || '-'}/${typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported(t) ? 'mse' : '-'}`;
    }
    return { ua: navigator.userAgent, isolated: self.crossOriginIsolated, sab: typeof SharedArrayBuffer, page, worker, media };
  }

  // Start-up timeline (engine.js logs it with the first frame when debugging).
  (self.vpeMarks || (self.vpeMarks = {})).ready = Math.round(performance.timeOrigin + performance.now());
  // The picture area in device pixels: the host's "Auto" quality for HLS picks a picture that covers it.
  const readyView = (() => { const r = stage.getBoundingClientRect(); const k = window.devicePixelRatio || 1; const w = Math.round(r.width * k), h = Math.round(r.height * k); return w >= 16 && h >= 16 ? { w, h } : null; })();
  vscode.postMessage({ type: 'ready', origin: window.location.origin, view: readyView });
  // The WebAssembly decoder loads while the host decides how to play the file (ffprobe etc.):
  // the GPU (WebCodecs) and WebAssembly paths both need it; native ffmpeg drops it.
  if (cfg.engine && cfg.engine.preload !== false) engine.preload({ ...cfg.engine, debug: !!cfg.debug });
})();
