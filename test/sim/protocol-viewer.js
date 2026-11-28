'use strict';

const assert = require('node:assert/strict');
const { withHost } = require('./host');
const { createUnifiedViewer, sourceClip } = require('../../src/unified-viewer');
const { ExactFrameGrabber } = require('../../src/exact_frame');
const { createUrlDecoder } = require('../../src/unified-sources');
const { Uri, fakePanel, vscode, deps, context, cfgOf } = require('../host/unified-viewer-fixture');

async function viewerContract() {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  const png = Buffer.alloc(33);
  Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').copy(png);
  png.writeUInt32BE(1920, 16);
  png.writeUInt32BE(1080, 20);
  await withHost({
    script(proc) {
      const image = proc.args.includes('mjpeg') ? jpeg : proc.args.includes('png') ? png : null;
      if (image) {
        proc.output(1, image);
        proc.exit(2);
      }
    },
  }, async ({ page, processes, spawn, createNative }) => {
    const { panel, posts, handlers } = fakePanel();
    const exact = new ExactFrameGrabber({ spawn });
    const video = { index: 0, codec: 'hevc', width: 1920, height: 1080, fps: 25, pixFmt: 'yuv420p' };
    const decision = { tools: { ffmpeg: 'fake-ffmpeg', gpuFilters: new Set() }, method: 'none',
      maxHeight: 1080, messageMaxHeight: 720, probed: { video, audio: { index: 1, codec: 'aac' }, duration: 10 } };
    const clip = { id: 'native', label: 'Native', uri: Uri.file('native.mkv'), fsPath: 'native.mkv', size: 8,
      width: 1920, height: 1080, native: true, decision };
    const urlClip = sourceClip('url', 'https://media.example/clip.m3u8', { label: 'HLS' });
    const variants = [
      { width: 640, height: 360, bandwidth: 800_000, codecs: 'avc1.4d401f' },
      { width: 1280, height: 720, bandwidth: 2_000_000, codecs: 'avc1.64001f' },
    ];
    const callbacks = [];
    const viewer = createUnifiedViewer({ vscode, context, panel, clip, registry: null, deps: deps({
      createNative(opts) { callbacks.push(opts); return createNative(opts); },
      grabExactFrame: ({ clip: c, t, isCurrent }) => exact.grab({
        tools: decision.tools, file: c.fsPath, video, t, page: 1, isCurrent,
      }),
      openUrlStream: (c, io) => createUrlDecoder(c, io, {
        urlsource: {
          inspect: async () => ({ kind: 'hls' }),
          redact: (url) => url,
          hlsOpen: async () => ({ auto: true, index: 0, variants, master: { media: [] } }),
          HlsFile: class { size = 8; async open() {} close() {} },
        },
        netOpts: () => ({}), tools: async () => null,
      }),
    }) });
    try {
      viewer.show();
      const send = (message) => handlers.message({ page: cfgOf(panel.webview.html).page, clipId: clip.id, ...message });
      await send({ type: 'ready' });
      await viewer.session.addClip(urlClip);
      await send({ type: 'nd', clipId: urlClip.id, m: { type: 'open' } });
      await page.advance(0);
      await send({ type: 'tileSize', w: 320, h: 180 });
      await send({ type: 'nd', m: { type: 'open' } });
      const { width: w, height: h } = posts.find((m) => m.type === 'nd' && m.m.type === 'streams').m.info.video;
      await send({ type: 'nd', m: { type: 'seek', gen: 7, t: 2 } });
      await send({ type: 'nd', m: { type: 'more', gen: 7 } });
      const pixels = Buffer.alloc(w * h * 3 / 2, 42);
      const pcm = Buffer.alloc(32, 12);
      processes.at(-1).output(1, pcm, 3);
      processes.at(-1).output(3, pixels);
      await page.advance(100);
      const route = { key: clip.id, clipId: clip.id, page: 1 };
      assert.deepEqual(posts.find((m) => m.type === 'ndv'),
        { type: 'ndv', gen: 7, t: 2, w, h, ys: w * h, data: new Uint8Array(pixels), ...route });
      assert.deepEqual(posts.find((m) => m.type === 'nda'),
        { type: 'nda', gen: 7, t: 2, rate: 48000, n: 4, data: new Uint8Array(pcm), ...route });
      await send({ type: 'tileSize', w: 1280, h: 720 });
      assert.deepEqual(posts.find((m) => m.type === 'resize'), { type: 'resize', tiles: [clip.id], ...route });

      const thumb = send({ type: 'thumb', id: 14, t: 2, w: 32, h: 18 });
      await page.advance(10);
      await thumb;
      assert.deepEqual(posts.find((m) => m.type === 'thumb'),
        { type: 'thumb', id: 14, w: 32, h: 18, kt: null, rel: null, fmt: 'jpeg', data: new Uint8Array(jpeg), ...route });

      const grab = send({ type: 'grabExactFrame', reqId: 15, t: 2 });
      await page.advance(10);
      await grab;
      assert.deepEqual(posts.find((m) => m.type === 'exactFrame'),
        { type: 'exactFrame', reqId: 15, t: 2, w: 1920, h: 1080, matrix: 'bt709', png: new Uint8Array(png), ...route });
      assert.deepEqual(posts.find((m) => m.type === 'stream'), { type: 'stream', page: 1,
        clipId: urlClip.id, key: urlClip.id, quality: { pick: 'auto', current: 0,
          variants: variants.map((v, id) => ({ ...v, id })) } });

      await viewer.session.removeClip(clip.id);
      const after = posts.length;
      callbacks[0].postRaw({ type: 'ndv', gen: 7, data: Uint8Array.of(1) });
      assert.equal(posts.length, after, 'a removed decoder cannot send to the remaining tile');
    } finally {
      exact.dispose();
      handlers.dispose();
    }
  });
}

module.exports = { viewerContract };
