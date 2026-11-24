'use strict';
// node test/host/stream_transition_test.js: Live transcode size transitions (src/stream.js reSize / seek) without
// ffmpeg: a larger picture while playing switches in-band, repeated
// view messages ask the page for one seek only, and a pending shrink never forces ffmpeg to restart a step back.
const assert = require('assert');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const { EncodedStream } = require('../../src/stream');
const { AUDIO_RATE } = require('../../src/stream-buffer');

function make({ audio = false, allowOverlap = false } = {}) {
  const posted = [];
  const s = new EncodedStream({
    tools: {}, file: 'x.mkv', post: (m) => posted.push(m), log: () => {}, remote: false, maxHeight: 2160,
    encoder: 'libx264', cpuEncoder: 'libx264', allowOverlap,
    probed: { duration: 60, video: { index: 0, codec: 'hevc', width: 3840, height: 2160, fps: 30 }, audio: audio ? { index: 1 } : null },
  });
  s.fps = 30;
  let restarts = 0;
  s.restartVideo = () => { restarts++; };
  s.spawnNow = () => {}; // no ffmpeg here
  s.sizeVideo(); // open() does this: a picture size to change from
  return { s, posted, restarts: () => restarts };
}
const refreshes = (posted) => posted.filter((m) => m.type === 'refresh').length;
const fakeProc = () => ({ exitCode: null, signalCode: null, stdout: { isPaused: () => false, destroy() {} }, kill() {} });

const idr = Buffer.from([0, 0, 1, 9, 0xf0, 0, 0, 1, 0x67, 0x11, 0, 0, 1, 0x68, 0x11, 0, 0, 1, 0x65, 0x11]);
const inter = Buffer.from([0, 0, 1, 9, 0xf0, 0, 0, 1, 0x41, 0x22]);

function overlapStream() {
  const { s, posted } = make({ audio: true, allowOverlap: true });
  delete s.restartVideo;
  s.setView({ w: 960, h: 540 });
  s.sizeVideo();
  const children = [];
  const logs = [];
  s.log = (log) => logs.push(log);
  s.launch = (t) => {
    const proc = new EventEmitter();
    Object.assign(proc, { t, h: s.h, cap: s.activeCapKbps(), stdout: new PassThrough(), exitCode: null,
      signalCode: null, err: { text: '' }, kills: [] });
    proc.kill = (signal) => { proc.kills.push(signal); proc.signalCode = signal; };
    children.push(proc);
    return proc;
  };
  s.base = s.vBase = 2;
  s.aNext = 24000;
  s.spawnVideo();
  const old = s.proc;
  old.stdout.write(Buffer.concat([idr, ...Array(30).fill(inter)]));
  s.more({ gen: 0, videoUntil: 2.47 });
  assert.strictEqual(s.vNext, 15);
  return { s, posted, children, old, logs };
}

for (const change of ['grow', 'upgrade', 'cap']) {
  const { s, old, posted, children } = overlapStream();
  if (change === 'grow') s.setView({ w: 1920, h: 1080 }, true);
  if (change === 'upgrade') {
    s.tier = 1;
    s.link.onSample = () => {
      s.tier = 0;
      return { change: 'tier', down: false, detail: 'good link' };
    };
    s.adapt({ gen: 0 });
  }
  if (change === 'cap') {
    s.handle({ type: 'playback', playing: true });
    s.setMaxBitrateMbps(5);
  }
  const replacement = children[1];
  assert.strictEqual(replacement.t, 3.5);
  if (change === 'grow') assert.strictEqual(replacement.h, 1080);
  if (change === 'cap') assert.strictEqual(replacement.cap, 5000);
  assert.strictEqual(s.proc, old);
  assert.deepStrictEqual(old.kills, []);
  if (change === 'upgrade') old.stdout.write(Buffer.concat(Array(20).fill(inter)));
  replacement.stdout.write(idr);
  assert.strictEqual(s.proc, old, 'a partial access unit cannot trigger the handoff');
  replacement.stdout.write(inter);
  if (change !== 'upgrade') {
    assert.strictEqual(s.proc, old, 'ready replacement waits until old video reaches the boundary');
    s.more({ gen: 0 });
    assert.strictEqual(s.vNext, 30, 'old encoder continues to supply video');
    old.stdout.write(Buffer.concat(Array(20).fill(inter)));
  }
  assert.strictEqual(s.proc, replacement);
  assert.strictEqual(s.overlap, null);
  assert.deepStrictEqual(old.kills, ['SIGKILL']);
  old.emit('close', null, 'SIGKILL');
  assert.strictEqual(s.proc, replacement, 'retired encoder close cannot affect the replacement');
  replacement.stdout.write(inter);
  s.more({ gen: 0 });
  const packets = posted.filter((m) => m.type === 'batch').flatMap((m) => m.video);
  assert.strictEqual(packets.length, 47);
  packets.forEach((p, i) => assert.ok(Math.abs(p.t - (2 + i / 30)) < 1e-9, `frame ${i} is continuous`));
  assert.deepStrictEqual(Buffer.from(packets[45].data), idr);
  assert.strictEqual(s.aNext, 24000);
  assert.strictEqual(refreshes(posted), 0);
  s.dispose();
  assert.deepStrictEqual(replacement.kills, ['SIGKILL']);
}

for (const failure of ['exit', 'throw', 'late', 'missing headers']) {
  const { s, children, old, logs } = overlapStream();
  if (failure === 'throw') {
    const launch = s.launch;
    s.launch = (t) => { if (t === 3.5) throw new Error('spawn failed'); return launch(t); };
  }
  s.setView({ w: 1920, h: 1080 }, true);
  const replacement = children[1];
  if (failure === 'exit') {
    replacement.err.text = 'NVENC out of sessions';
    replacement.exitCode = 1;
    replacement.emit('close', 1, null);
    assert.ok(logs.some((log) => log.includes('NVENC out of sessions')));
  }
  if (failure === 'late') {
    old.stdout.write(Buffer.concat(Array(20).fill(inter)));
    s.more({ gen: 0 });
    s.more({ gen: 0 });
  }
  if (failure === 'missing headers') replacement.stdout.write(Buffer.concat([idr.subarray(0, 5), idr.subarray(-5), inter]));
  assert.deepStrictEqual(old.kills, ['SIGKILL']);
  assert.strictEqual(s.overlap, null);
  assert.strictEqual(s.proc.t, failure === 'late' ? 3.5 : 2.5);
  assert.strictEqual(s.proc.h, 1080);
  assert.strictEqual(s.aNext, 24000);
  assert.ok(logs.some((log) => log.includes('video overlap failed')));
  s.dispose();
}

{ // The audio track can outlast the video and make the reported duration too generous.
  const { s, old, children } = overlapStream();
  s.setView({ w: 1920, h: 1080 }, true);
  old.exitCode = 0;
  old.emit('close', 0, null);
  assert.strictEqual(s.videoEnded, true);
  assert.strictEqual(s.vAll.length, 31, 'all old pictures remain available at EOF');
  assert.deepStrictEqual(children[1].kills, ['SIGKILL']);
  assert.strictEqual(s.overlap, null);
  s.dispose();
}

{ // Astra review: if the old encoder reaches EOF with frames queued past spliceT before the replacement is ready, keep overlap pending and splice when it arrives.
  const { s, children, old } = overlapStream();
  s.setView({ w: 1920, h: 1080 }, true);
  const replacement = children[1];
  const spliceT = s.overlap.spliceT;
  // Old encoder produces frames past spliceT and exits cleanly before replacement outputs anything.
  const chunks = [];
  for (let i = 0; i < 40; i++) chunks.push(i === 0 ? idr : inter);
  old.stdout.write(Buffer.concat(chunks));
  old.emit('close', 0, null);
  assert.ok(s.overlap && s.overlap.proc === replacement, 'overlap stays pending when old encoder hit EOF past spliceT');
  assert.strictEqual(s.videoEnded, false, 'video is not marked ended while replacement is pending');
  assert.deepStrictEqual(replacement.kills, [], 'replacement was not cancelled');
  // Replacement now delivers its SPS/PPS + IDR access unit and splices cleanly at spliceT.
  replacement.stdout.write(Buffer.concat([idr, inter]));
  assert.strictEqual(s.overlap, null, 'overlap spliced cleanly once ready');
  assert.strictEqual(s.proc, replacement, 'replacement promoted to active proc');
  assert.ok(Math.abs(s.vBase - spliceT) < 1e-6, 'spliced at spliceT');
  s.dispose();
}

const cancelBy = {
  seek(s) { s.seek({ gen: 1, t: 2.4 }); },
  hide(s) { s.setHidden(true); },
  dispose(s) { s.dispose(); },
  kill(s) { s.kill(); },
  supersede(s) { s.setView({ w: 3840, h: 2160 }, true); },
  panic(s) {
    s.link.onSample = () => ({ change: 'tier', down: true, detail: 'slow link' });
    s.adapt({ gen: 0 });
  },
};
for (const [action, cancel] of Object.entries(cancelBy)) {
  const { s, children, old } = overlapStream();
  s.setView({ w: 1920, h: 1080 }, true);
  const replacement = children[1];
  replacement.stdout.write(Buffer.concat([idr, inter]));
  cancel(s);
  assert.deepStrictEqual(replacement.kills, ['SIGKILL'], action);
  replacement.emit('close', null, 'SIGKILL');
  assert.strictEqual(children.length, ['supersede', 'panic'].includes(action) ? 3 : 2, action);
  if (action === 'supersede') {
    assert.strictEqual(s.proc, old);
    assert.strictEqual(s.overlap.proc, children[2]);
  } else {
    assert.deepStrictEqual(old.kills, ['SIGKILL'], action);
    assert.strictEqual(s.overlap, null);
  }
  s.dispose();
  assert.ok(children.every((proc) => proc.kills.length === 1), action);
}

{ // Paused: one 'refresh' per growth, however many view messages follow for the same size.
  const { s, posted } = make();
  s.setView({ w: 960, h: 540 });
  s.sizeVideo();
  assert.strictEqual(s.h, 540);
  s.setView({ w: 1920, h: 1080 });
  assert.strictEqual(refreshes(posted), 1, 'growing asks the page for one seek');
  assert.strictEqual(s.h, 540, 'the size applies with that seek');
  assert.strictEqual(s.resizePending, true);
  s.setView({ w: 1900, h: 1070 });
  s.setView({ w: 1920, h: 1080 });
  s.setFit(true);
  assert.strictEqual(refreshes(posted), 1, 'jitter and repeated views queue no second seek');
  s.sizeVideo(); // the seek applies it
  assert.strictEqual(s.h, 1080);
  s.setView({ w: 960, h: 540 });
  s.setView({ w: 1920, h: 1080 });
  assert.strictEqual(refreshes(posted), 1, 'back to the applied size needs no seek');
  s.setView({ w: 3840, h: 2160 });
  assert.strictEqual(refreshes(posted), 2, 'a further growth asks again once the first is applied');
}

{ // Playing with ffmpeg running: in-band restart at the new size, no page seek.
  const { s, posted, restarts } = make({ audio: true });
  s.setView({ w: 960, h: 540 });
  s.sizeVideo();
  s.proc = fakeProc();
  s.setView({ w: 1920, h: 1080 }, true);
  assert.strictEqual(restarts(), 1, 'ffmpeg restarts at the first unsent frame');
  assert.strictEqual(refreshes(posted), 0, 'no page seek: the sound and the clock are not touched');
  assert.strictEqual(s.h, 1080);
  assert.strictEqual(s.resizePending, false);
  // The same size again changes nothing.
  s.setView({ w: 1920, h: 1080 }, true);
  assert.strictEqual(restarts(), 1);
  // Shrinking while playing waits for the next seek (no restart, no seek).
  s.setView({ w: 960, h: 540 }, true);
  assert.strictEqual(restarts(), 1);
  assert.strictEqual(refreshes(posted), 0);
  assert.strictEqual(s.resizePending, true);
  assert.strictEqual(s.h, 1080, 'the picture keeps its size until a restart');
}

{ // Playing but no ffmpeg running (deferred or hidden): falls back to the page seek.
  const { s, posted, restarts } = make();
  s.setView({ w: 960, h: 540 });
  s.sizeVideo();
  s.setView({ w: 1920, h: 1080 }, true);
  assert.strictEqual(restarts(), 0);
  assert.strictEqual(refreshes(posted), 1);
  const hidden = make();
  hidden.s.setView({ w: 960, h: 540 });
  hidden.s.sizeVideo();
  hidden.s.proc = fakeProc();
  hidden.s.hidden = true;
  hidden.s.setView({ w: 1920, h: 1080 }, true);
  assert.strictEqual(hidden.restarts(), 0, 'a hidden tab never starts ffmpeg');

  // Astra review: growth -> hide -> in-flight refresh seek with a prior spawn must NOT respawn ffmpeg while hidden.
  const hiddenSeek = make();
  let hiddenSpawns = 0;
  hiddenSeek.s.spawnNow = () => { hiddenSpawns++; hiddenSeek.s.hidden = false; };
  hiddenSeek.s.setView({ w: 960, h: 540 });
  hiddenSeek.s.sizeVideo();
  hiddenSeek.s.spawns = 1;
  hiddenSeek.s.proc = fakeProc();
  hiddenSeek.s.setView({ w: 1920, h: 1080 }, false); // paused growth posts refresh
  assert.strictEqual(refreshes(hiddenSeek.posted), 1);
  hiddenSeek.s.setHidden(true);
  assert.strictEqual(hiddenSeek.s.hidden, true);
  hiddenSeek.s.seek({ gen: 2, t: 1.5 }); // in-flight refresh seek arrives after hide
  assert.strictEqual(hiddenSpawns, 0, 'in-flight seek after hide does not spawn ffmpeg');
  assert.strictEqual(hiddenSeek.s.startTimer, null, 'in-flight seek after hide schedules no timer');
  assert.strictEqual(hiddenSeek.s.hidden, true, 'tab remains hidden');
  // Showing the tab and re-seeking spawns cleanly at the new size.
  hiddenSeek.s.setHidden(false);
  hiddenSeek.s.lastSeekAt = 0; // allow immediate spawn without waiting out SEEK_QUIET_MS
  hiddenSeek.s.seek({ gen: 3, t: 1.5 });
  assert.strictEqual(hiddenSpawns, 1, 'showing and seeking spawns ffmpeg');
  assert.strictEqual(hiddenSeek.s.h, 1080);
}

{ // Real restartVideo() on playing growth: advances vBase to first unsent frame and preserves audio cursor.
  const { s, posted } = make({ audio: true });
  delete s.restartVideo; // use the real EncodedStream.prototype.restartVideo
  let spawnedVideo = 0;
  s.spawnVideo = () => { spawnedVideo++; s.proc = fakeProc(); };
  s.setView({ w: 960, h: 540 });
  s.sizeVideo();
  s.proc = fakeProc();
  s.base = 2;
  s.vBase = 2;
  for (let i = 0; i < 30; i++) s.vAll.push({ kind: 'packet', t: 2 + i / 30, key: i === 0, idr: i === 0, data: new Uint8Array(4) });
  s.vNext = 15; // next unsent frame is at 2 + 15/30 = 2.5 s
  s.aNext = 24000;
  s.setView({ w: 1920, h: 1080 }, true);
  assert.strictEqual(spawnedVideo, 1, 'real restartVideo spawns video encoder');
  assert.strictEqual(refreshes(posted), 0, 'no page refresh seek');
  assert.strictEqual(s.h, 1080, 'new height applied');
  assert.ok(Math.abs(s.vBase - 2.5) < 1e-6, `vBase advanced to first unsent frame (got ${s.vBase})`);
  assert.strictEqual(s.aNext, 24000, 'audio cursor preserved across in-band video restart');
}

{ // A pending shrink applies at the next seek (matching docs/PRODUCT.md "shrinking waits for the next seek").
  const { s, posted } = make();
  s.setView({ w: 1920, h: 1080 });
  s.sizeVideo();
  s.proc = fakeProc();
  s.base = 10;
  s.vBase = 10;
  for (let i = 0; i < 60; i++) s.vAll.push({ kind: 'packet', t: 10 + i / 30, key: i % 30 === 0, idr: i % 30 === 0, data: new Uint8Array(4) });
  s.vNext = 40;
  s.gotOutput = true;
  s.setView({ w: 960, h: 540 });
  assert.strictEqual(s.resizePending, true);
  assert.strictEqual(s.h, 1080, 'shrinking holds current size until the next seek');
  s.seek({ gen: 1, t: 10.5 });
  const seeked = posted.filter((m) => m.type === 'seeked');
  assert.strictEqual(seeked.length, 1);
  assert.strictEqual(s.h, 540, 'the next seek applies the smaller size');
  assert.strictEqual(s.resizePending, false);
  clearTimeout(s.startTimer);
  s.kill();
}

{ // A growth pending still forces the restart (the page asked for a crisper picture).
  const { s } = make();
  s.setView({ w: 960, h: 540 });
  s.sizeVideo();
  s.proc = fakeProc();
  s.base = 10;
  s.vBase = 10;
  for (let i = 0; i < 60; i++) s.vAll.push({ kind: 'packet', t: 10 + i / 30, key: i % 30 === 0, idr: i % 30 === 0, data: new Uint8Array(4) });
  s.vNext = 40;
  s.gotOutput = true;
  s.setView({ w: 1920, h: 1080 });
  s.seek({ gen: 1, t: 10.5 });
  assert.strictEqual(s.h, 1080, 'the seek applied the larger size and restarted');
  clearTimeout(s.startTimer);
  s.kill();
}

{ // An uncapped remote link can fit much more than half a second of picture in the byte limit.
  const fps = 25;
  const logs = [];
  let videoEnd = 0;
  let audioEnd = 0;
  const s = new EncodedStream({
    tools: {}, file: 'x.mkv', log: (m) => logs.push(m), stats: true, encoder: 'libx264',
    audioEncoder: 'libopus',
    probed: { duration: 200, video: { index: 0, width: 640, height: 360, fps }, audio: { index: 1 } },
    post(batch) {
      if (batch.video.length) videoEnd = batch.video.at(-1).t + 1 / fps;
      for (const a of batch.audio) {
        assert.ok(Math.abs(a.t - audioEnd) < 1e-9, 'Opus is continuous');
        audioEnd = a.t + a.samples / a.sampleRate;
      }
    },
  });
  s.fps = fps;
  s.sizeVideo();
  s.audioProc = { stdout: { pause() {}, resume() {} } };
  const picture = new Uint8Array(8 * 1024);
  const opus = Buffer.from([0xf8]); // one 20 ms packet, payload unused by the host
  let frames = 0;
  let audioSample = 0;
  const realNow = Date.now;
  try {
    for (let i = 0; i < 150 * fps && videoEnd < 150; i++) {
      Date.now = () => Math.round(videoEnd * 1000);
      // Refill the video and audio pipes while the host has room for more data.
      while (frames < (videoEnd + 2) * fps) {
        const key = frames % (2 * fps) === 0;
        s.vAll.push({ kind: 'packet', t: frames++ / fps, key, idr: key, data: picture });
      }
      while (!s.audioPaused) {
        // Feed the parser's output directly so the test needs neither Ogg framing nor ffmpeg.
        s.ogg.onPacket({ s: audioSample, n: 960, b: opus });
        audioSample += 960;
        s.audioPaused = (s.aEnd - s.aNext) >= 4 * AUDIO_RATE;
      }
      s.more({ gen: 0, limit: 384 * 1024 });
      const lead = audioEnd - videoEnd;
      assert.ok(lead >= -0.5 - 1e-9 && lead <= 2 + 1e-9, `sound lead ${lead} s at ${videoEnd} s`);
    }
  } finally {
    Date.now = realNow;
  }
  assert.ok(videoEnd >= 150 && audioEnd >= 149.5, 'sent picture and sound through the soak');
  assert.ok(logs.length >= 50, 'sampled the host stats throughout playback');
  for (const log of logs) {
    const [, video, audio] = /sent to ([\d.]+) s video \/ ([\d.]+) s sound/.exec(log);
    const lead = Number(audio) - Number(video);
    assert.ok(lead >= -0.5 - 1e-9 && lead <= 2 + 1e-9, log);
  }
}

console.log('stream transition tests passed');
