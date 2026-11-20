// Runs media/decoder-worker.js in a Node worker thread as if it were a browser Worker.
'use strict';
const { parentPort, workerData } = require('worker_threads');
const vm = require('vm');
const fs = require('fs');
globalThis.self = globalThis;
globalThis.postMessage = (m, transfer) => parentPort.postMessage(m, transfer || []);
globalThis.importScripts = (f) => require(f);
parentPort.on('message', (d) => { if (globalThis.onmessage) globalThis.onmessage({ data: d }); });
console.error = () => {}; // libav's log chatter
console.warn = () => {};
vm.runInThisContext(fs.readFileSync(workerData.script, 'utf8'), { filename: workerData.script });
