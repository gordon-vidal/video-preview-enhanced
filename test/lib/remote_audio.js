'use strict';
// The same Opus decoder worker as the real webview, hosted in Node for sync checks.
const { Worker } = require('worker_threads');
const path = require('path');
let worker;
let ready;
let id = 0;
const pending = new Map();

async function decode(audio) {
  if (!worker) {
    worker = new Worker(path.resolve(__dirname, '../pool/worker-shim.js'), {
      workerData: { script: path.resolve(__dirname, '../../media/decoder-worker.js') },
    });
    ready = new Promise((resolve, reject) => {
      worker.on('error', reject);
      worker.on('message', (m) => {
        if (m.type === 'ready') resolve();
        const p = pending.get(m.id);
        if (!p) return;
        pending.delete(m.id);
        if (m.type === 'error') p.reject(new Error(m.message));
        else p.resolve(m.audio);
      });
    });
    const dir = path.resolve(__dirname, '../../media/libav-vpe');
    worker.postMessage({ type: 'init', loader: path.join(dir, 'libav-6.11.9.0.2-vpe.js'),
      toImport: path.join(dir, 'libav-6.11.9.0.2-vpe.wasm.js'),
      wasmurl: path.join(dir, 'libav-6.11.9.0.2-vpe.wasm.wasm'), variant: 'vpe' });
  }
  await ready;
  const request = ++id;
  return new Promise((resolve, reject) => {
    pending.set(request, { resolve, reject });
    worker.postMessage({ type: 'remoteAudio', id: request, audio });
  });
}

function pcm(audio) {
  return audio.map((a) => {
    if (a.kind !== 's16') return a;
    const b = Buffer.from(a.data);
    const planes = [new Float32Array(b.length / 4), new Float32Array(b.length / 4)];
    for (let i = 0; i < planes[0].length; i++) {
      planes[0][i] = b.readInt16LE(i * 4) / 32768;
      planes[1][i] = b.readInt16LE(i * 4 + 2) / 32768;
    }
    return { kind: 'pcm', t: a.t, sampleRate: a.sampleRate, planes };
  });
}

module.exports = { decode, pcm, close: () => worker && worker.terminate() };
