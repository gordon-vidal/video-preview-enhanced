// @ts-check
'use strict';
(function () {
  // checkJs: start
  /**
   * @param {'every' | 'skip' | 'autoEvery' | 'fast' | 'setupFfmpeg'} variant
   * @param {boolean} [offerSetup]
   * @param {number} [downloadMB]
   */
  function slowNotice(variant, offerSetup = false, downloadMB = 80) {
    const setup = {
      label: 'Set up ffmpeg', id: 'setupFfmpeg', close: true,
      title: `Download optional ffmpeg for use with all videos (about ${downloadMB || 80} MB)`,
    };
    const controls = {
      settings: { label: 'Settings', id: variant === 'fast' ? 'fastPreviewSettings' : 'whenSlowSettings' },
      hide: { label: "Don't show again", id: 'hideSlowPlaybackNotice', close: true },
    };
    switch (variant) {
    case 'every':
      return {
        ...controls, whenSlow: 'skip',
        text: 'Playing slower than normal so every frame is shown. You can skip frames to keep real-time speed instead.',
        action: {
          label: 'Skip frames (all videos)', close: true,
          title: 'Skip frames to keep real-time speed; saved as your default in Settings',
        },
      };
    case 'skip':
      return {
        ...controls, whenSlow: 'every',
        text: 'Skipping frames to keep real-time speed with audio. You can show every frame instead, at slower playback.',
        action: {
          label: 'Show every frame (all videos)', close: true,
          title: 'Slow playback to show every frame; saved as your default in Settings',
        },
      };
    case 'autoEvery':
      return {
        ...controls,
        text: "Skipping frames couldn't keep up, so playback is slower to show every frame." +
          (offerSetup ? ' Optional ffmpeg can use your GPU for smoother playback.' : ''),
        action: offerSetup ? setup : null,
      };
    case 'fast':
      return {
        ...controls,
        text: 'Fast preview helps playback keep up. The picture may look rougher while playing. Paused and stepped frames stay exact.',
      };
    case 'setupFfmpeg':
      return {
        ...controls,
        text: 'Optional ffmpeg can use your GPU to play this video more smoothly.',
        action: setup,
      };
    }
  }

  const commonJs = /** @type {{ exports?: typeof slowNotice } | undefined} */ (
    // @ts-ignore The webview has no CommonJS globals.
    typeof module === 'undefined' ? undefined : module
  );
  if (commonJs) commonJs.exports = slowNotice;
  else /** @type {typeof globalThis & { VpeSlowNotice?: typeof slowNotice }} */ (globalThis).VpeSlowNotice = slowNotice;
  // checkJs: end
})();
