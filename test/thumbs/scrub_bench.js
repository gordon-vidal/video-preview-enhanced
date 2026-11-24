'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { decodeThumb } = require('../../src/thumbhost');

const root = path.resolve(__dirname, '../..');
const libdir = path.join(root, 'media/libav-vpe');
const libfiles = fs.readdirSync(libdir);
const libfile = (suffix) => path.join(libdir, libfiles.find((name) => name.endsWith(suffix)));
const ffmpeg = process.env.FFMPEG || 'ffmpeg';
const samples = 20;

function openWorker(file) {
  const input = fs.openSync(file, 'r');
  const size = fs.fstatSync(input).size;
  const w = new Worker(path.join(root, 'test/pool/worker-shim.js'), {
    workerData: { script: path.join(root, 'media/thumbs-worker.js') },
  });
  let receive;
  let reject;
  let id = 0;
  const wait = (send) => new Promise((resolve, fail) => {
    const timeout = setTimeout(() => reject(new Error('thumbnail worker timed out')), 15000);
    receive = (m) => { clearTimeout(timeout); resolve(m); };
    reject = (e) => { clearTimeout(timeout); fail(e); };
    w.postMessage(send);
  });
  w.on('error', (e) => reject(e));
  w.on('message', (m) => {
    if (m.type === 'ready') {
      w.postMessage({ type: 'open', size });
    } else if (m.type === 'read') {
      const data = new Uint8Array(Math.min(m.len, Math.max(0, size - m.pos)));
      const length = fs.readSync(input, data, 0, data.length, m.pos);
      w.postMessage({ type: 'block', pos: m.pos, data: data.subarray(0, length) }, [data.buffer]);
    } else if (m.type === 'opened' || m.type === 'thumb') {
      receive(m);
    } else if (m.type === 'error') {
      reject(new Error(m.message));
    }
  });
  return {
    ready: wait({
      type: 'init', loader: libfile('-vpe.js'), toImport: libfile('-vpe.wasm.js'),
      wasmurl: libfile('-vpe.wasm.wasm'), variant: 'vpe',
    }),
    async decode(t) {
      const result = await wait({ type: 'thumb', id: ++id, t, w: 160, h: 120 });
      assert.ok(result.data?.length, `WASM picture missing at ${t}`);
      // Measure a decode miss with a warm demuxer and decoder for every sample.
      w.postMessage({ type: 'forget', kt: result.kt });
      return result;
    },
    async close() {
      await w.terminate();
      fs.closeSync(input);
    },
  };
}

function percentiles(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  return [0.5, 0.95].map((p) => sorted[Math.ceil(p * sorted.length) - 1].toFixed(1)).join(' / ');
}

async function bench(name) {
  const file = path.join(root, 'test/media', name);
  assert.ok(fs.statSync(file).size > 1024, `Fetch the Git LFS clip ${name} before benchmarking`);
  const worker = openWorker(file);
  const wasm = [];
  const native = [];
  try {
    const info = await worker.ready;
    assert.ok(info.ok && info.duration > 0, info.why);
    await worker.decode(info.start);
    const callNative = (t) => decodeThumb({ ffmpeg }, file, { w: 3840, h: 2160 }, t, 160, 120);
    assert.ok(await callNative(0), 'native warm-up failed');
    // Visit evenly spaced targets in a permuted order, with the same targets on both backends.
    for (let i = 0; i < samples; i++) {
      const t = info.duration * (0.5 + (i * 7) % samples) / samples;
      let start = performance.now();
      await worker.decode(info.start + t);
      wasm.push(performance.now() - start);
      start = performance.now();
      assert.ok(await callNative(t), `native picture missing at ${t}`);
      native.push(performance.now() - start);
    }
  } finally {
    await worker.close();
  }
  console.log(`${name} (${samples} seeks): warm WASM ${percentiles(wasm)} ms, native ${percentiles(native)} ms (p50 / p95)`);
}

(async () => {
  for (const codec of ['hevc', 'av1']) await bench(`${codec}_10_2160p.mp4`);
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
