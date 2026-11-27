// @ts-check
'use strict';
// Frame player: JPEG/PNG frames decoded by the browser, on a canvas. Used for MJPEG AVI and image
// sequences. Frame accurate by construction. The page (media/player-unified.js) gives it the canvas, the host
// channel and the page's live settings (rate, loop, volume) through createFramePlayer's `deps`, so a Node
// test can drive the class with stubs (test/unit/frame_player_test.js).
(function () {
  // checkJs: start
  /**
   * @typedef {object} FramePlayerDeps
   * @property {any} canvas the page's #canvas
   * @property {{ postMessage: (m: any) => void }} vscode the host channel
   * @property {(...a: any[]) => void} log
   * @property {(text: string) => void} showMessage the overlay message ('' clears it)
   * @property {(muted: boolean, byUser?: boolean) => void} setMute
   * @property {() => number} getRate
   * @property {() => boolean} getLoop
   * @property {() => boolean} getMuted
   * @property {() => number} getVolume
   * @property {(player: any, info: { natural: boolean, ran: number }) => void} [onEnded] playback paused at the end (loop off)
   */

  /** @param {FramePlayerDeps} deps */
  function createFramePlayer(deps) {
    const { canvas, vscode, log, showMessage, setMute, getRate, getLoop, getMuted, getVolume } = deps;
    const onEnded = deps.onEnded || (() => {});

    class FramePlayer {
      /**
       * @param {{ frames: number, fps: number, width?: number, height?: number, duration?: number }} meta
       * @param {ArrayBuffer | Uint8Array | Array<ArrayBuffer | Uint8Array> | null | undefined} [wav]
       */
      constructor(meta, wav) {
        this.meta = meta;
        this.n = meta.frames;
        this.fps = meta.fps;
        this.duration = this.n / this.fps;
        this.t = 0;
        this.runFrom = 0;
        this.gen = 0;
        this.playing = false;
        this.last = 0;
        /** @type {Map<number, any>} */ this.bitmaps = new Map();
        /** @type {Set<number>} */ this.inflight = new Set();
        this.shown = -1;
        this.shownCount = 0;
        this.disposed = false;
        this.audioPending = false;
        this.ctx = canvas.getContext('2d');
        if (meta.width) { canvas.width = meta.width; canvas.height = meta.height; }
        canvas.hidden = false;
        /** @type {any} */ this.audio = null;
        // wav: one buffer, or the parts the host sent ahead in 'wavPart' messages.
        const wavParts = Array.isArray(wav) ? wav : wav ? [wav] : [];
        if (wavParts.some((b) => b.byteLength)) {
          this.audio = new Audio(URL.createObjectURL(new Blob(/** @type {any} */ (wavParts), { type: 'audio/wav' })));
          this.audio.preload = 'auto';
        }
        this.request(0);
      }

      frameAt(t) { return Math.max(0, Math.min(this.n - 1, Math.floor(t * this.fps + 1e-6))); }
      currentFrame() { return this.frameAt(this.t); }
      currentTime() { return this.t; }
      isPlaying() { return this.playing; }

      play() {
        if (this.frameAt(this.t) >= this.n - 1) { this.gen++; this.t = 0; }
        this.playing = true;
        this.runFrom = this.t; // Autoplay: how far playback ran before the end
        this.last = performance.now();
        this.syncAudio(true);
      }
      pause() {
        this.playing = false;
        if (this.audio) this.audio.pause();
      }
      beginScrub() {
        this.scrubbing = true;
        this.audio?.pause();
      }
      endScrub() {
        this.scrubbing = false;
        this.last = performance.now();
      }
      seekTime(t) { this.seekFrame(Math.floor(t * this.fps)); }
      seekFrame(i) {
        i = Math.max(0, Math.min(this.n - 1, i));
        this.gen++;
        this.t = (i + 0.5) / this.fps;
        this.runFrom = this.t;
        this.syncAudio(true);
      }
      setRate() { this.syncAudio(true); }
      setVolume() {
        if (!this.audio) return;
        this.audio.muted = getMuted();
        this.audio.volume = getVolume();
        if (this.playing) this.syncAudio(false);
      }
      setLoop() {}

      syncAudio(force) {
        const a = this.audio;
        if (!a) return;
        a.playbackRate = getRate();
        a.muted = getMuted();
        a.volume = getVolume();
        if (this.scrubbing || !this.playing || this.t >= a.duration) { if (!a.paused) a.pause(); return; }
        if (force || Math.abs(a.currentTime - this.t) > 0.12) a.currentTime = this.t;
        if (a.paused && !this.audioPending) {
          this.audioPending = true;
          a.play().catch((/** @type {any} */ e) => {
            // Autoplay with sound needs a user gesture; continue muted.
            if (!this.disposed && e && e.name === 'NotAllowedError' && !getMuted()) { setMute(true, false); this.syncAudio(true); }
          }).finally(() => { this.audioPending = false; });
        }
      }

      tick(now) {
        if (this.scrubbing) return;
        if (this.playing) {
          this.t += (Math.min(250, now - this.last) / 1000) * getRate();
          if (this.t >= this.duration) {
            if (getLoop()) { this.gen++; this.t %= this.duration; this.syncAudio(true); }
            else {
              const ran = this.duration - this.runFrom;
              this.t = (this.n - 0.5) / this.fps;
              this.pause();
              onEnded(this, { natural: ran >= 0.25, ran });
            }
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
              if (!this.meta.width) { this.meta.width = bmp.width; this.meta.height = bmp.height; }
            }
            this.ctx.drawImage(bmp, 0, 0);
            this.shown = target;
            this.shownCount++;
          }
        }
      }

      /** Asks the host for the frames to keep ahead of (and a few behind) the target; drops far ones. */
      request(target) {
        const loop = getLoop();
        const ahead = Math.max(6, Math.min(120, Math.ceil(this.fps * getRate() * 0.75) + 4));
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
        const loop = getLoop();
        for (const [i, bmp] of this.bitmaps) {
          let d = i - target;
          if (loop && d < -this.n / 2) d += this.n;
          if (d < -20 || d > ahead * 2) { bmp.close(); this.bitmaps.delete(i); }
        }
      }

      onFrame(index, data) {
        createImageBitmap(new Blob([data])).then((bmp) => {
          if (this.disposed) { bmp.close(); return; }
          this.inflight.delete(index);
          const old = this.bitmaps.get(index);
          if (old) old.close();
          this.bitmaps.set(index, bmp);
          if (this.shown < 0) showMessage('');
        }, (e) => {
          if (this.disposed) return;
          this.inflight.delete(index);
          log(`frame ${index} failed to decode: ${e}`);
          if (this.shown < 0) showMessage(`Frame ${index + 1} could not be decoded.`);
        });
      }

      dispose() {
        if (this.disposed) return;
        this.disposed = true;
        this.pause();
        const audio = this.audio;
        this.audio = null;
        if (audio) {
          URL.revokeObjectURL(audio.src);
          audio.removeAttribute('src');
          audio.load();
        }
        for (const bmp of this.bitmaps.values()) bmp.close();
        this.bitmaps.clear();
        this.inflight.clear();
      }

      snapshotSource() { return canvas; }
      bufferedRanges() { return []; }
    }

    return FramePlayer;
  }

  const api = { createFramePlayer };
  const commonJs = /** @type {{ exports?: typeof api } | undefined} */ (
    // @ts-ignore The webview has no CommonJS globals.
    typeof module === 'undefined' ? undefined : module
  );
  if (commonJs) commonJs.exports = api;
  else /** @type {typeof globalThis & { VpeFramePlayer?: typeof api }} */ (globalThis).VpeFramePlayer = api;
  // checkJs: end
})();
