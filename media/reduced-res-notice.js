'use strict';
(function (root) {
  function size(width, height) {
    return width > 0 && height > 0 ? `${width}×${height}` : '';
  }

  function reducedResNotice(video, stream, display) {
    const picture = (stream ? display : video) || {};
    const source = stream || video || {};
    const playbackSize = size(picture.width, picture.height);
    const originalSize = size(source.sourceWidth, source.sourceHeight);
    let text;
    if (stream) {
      const playback = playbackSize ? ` (${playbackSize})` : '';
      const original = originalSize ? ` ${originalSize}` : '';
      text = `Playing a Live transcode${playback} for smooth playback. 100% zoom shows the transcoded picture instead of the original${original} file.`;
    } else {
      const format = video?.pixFmt || '';
      const sourceDepth = Number(/(?:p|gray|gbrp|xyz)(9|10|12|14|16)(?:le|be)$/.exec(format)?.[1] ||
        /^(?:p[024]|y2|[xy]4)(10|12|16)(?:le|be)?$/.exec(format)?.[1]);
      const depth = ` (${video?.depth || 8}-bit)`;
      const playback = playbackSize ? `at ${playbackSize}${depth}` : `a reduced picture${depth}`;
      const original = originalSize ? ` ${originalSize}` : '';
      const originalDepth = sourceDepth > 8 ? ` (${sourceDepth}-bit)` : '';
      text = `Playing ${playback} for smooth playback. Pixel readings and saved frames use this reduced picture instead of the original${original}${originalDepth} file.`;
    }
    return {
      text,
      action: { label: 'Use full resolution (this tab)', id: 'fullRes',
        title: 'Reload this tab at full resolution (playback may be slower)' },
      settings: { label: 'Settings', id: stream ? 'transcodeSettings' : 'nativeResolutionSettings' },
      hide: { label: "Don't show again", id: 'hideReducedResNotice', close: true },
    };
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = reducedResNotice;
  else root.VpeReducedResNotice = reducedResNotice;
})(globalThis);
