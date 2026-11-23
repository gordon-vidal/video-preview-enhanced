#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const DEFAULT_OUT = path.join(__dirname, '.heavy');
const MIB = 1024 ** 2;
const DEFAULT_SIZE = 3072;
const X264 = ['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-threads', '2'];

function ff(args) {
  execFileSync(process.env.VPE_FFMPEG || 'ffmpeg', [
    '-hide_banner', '-nostdin', '-v', 'error', '-filter_threads', '1', ...args,
  ], { windowsHide: true, stdio: ['ignore', 'inherit', 'inherit'] });
}

function cached(out, name, make) {
  fs.mkdirSync(out, { recursive: true });
  const file = path.join(out, name);
  if (fs.existsSync(file)) return file;
  const work = fs.mkdtempSync(path.join(out, '.making-'));
  const temp = path.join(work, name);
  try {
    make(temp, work);
    try {
      fs.renameSync(temp, file);
    } catch (e) {
      // Windows may deny replacing a fixture already opened by another runner.
      if (!fs.existsSync(file)) throw e;
    }
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
  return file;
}

function makeStepping(out = DEFAULT_OUT) {
  const vfr = cached(out, 'vfr.mp4', (file) => ff([
    '-f', 'lavfi', '-i', 'testsrc2=s=192x108:r=60:d=9',
    // Preserve the 60 Hz source timestamps while dropping pictures in the first two seconds of each cycle.
    '-vf', String.raw`select=if(lt(mod(t\,3)\,1)\,not(mod(n\,4))\,if(lt(mod(t\,3)\,2)\,not(mod(n\,2))\,1))`,
    '-fps_mode', 'passthrough', ...X264, '-g', '60', file,
  ]));
  const longGop = cached(out, 'long-gop.mp4', (file) => ff([
    '-f', 'lavfi', '-i', 'testsrc2=s=192x108:r=24:d=21',
    ...X264, '-g', '240', '-sc_threshold', '0', file,
  ]));
  return { vfr, longGop };
}

function makeFaults(out, valid) {
  const data = fs.readFileSync(valid);
  const corrupt = Buffer.from(data);
  // Leave the MP4 signature intact but destroy the movie metadata.
  const moov = corrupt.indexOf('moov');
  if (moov < 0) throw new Error('Expected MP4 movie metadata');
  corrupt.fill(0xff, moov + 4);
  return Object.fromEntries(Object.entries({
    'corrupted.mp4': corrupt,
    'truncated.mp4': data.subarray(0, Math.floor(data.length / 2)),
    'zero-byte.mp4': Buffer.alloc(0),
    'garbage.mp4': Buffer.from('This is plain text with an MP4 extension.\n'),
  }).map(([name, bytes]) => [name, cached(out, name, (file) => fs.writeFileSync(file, bytes))]));
}

function makeTracks(out, video) {
  return cached(out, 'multi-track.mkv', (file, work) => {
    const srt = path.join(work, 'captions.srt');
    fs.writeFileSync(srt, '1\n00:00:01,000 --> 00:00:02,000\nSynthetic caption\n');
    ff(['-i', video, '-f', 'lavfi', '-i', 'sine=frequency=440:duration=9',
      '-f', 'lavfi', '-i', 'sine=frequency=660:duration=9', '-i', srt,
      '-map', '0:v:0', '-map', '1:a:0', '-map', '2:a:0', '-map', '3:s:0',
      '-c:v', 'copy', '-c:a', 'aac', '-c:s', 'srt', file]);
  });
}

function makeLarge(out = DEFAULT_OUT, sizeMb = DEFAULT_SIZE, quick = false) {
  if (!Number.isSafeInteger(sizeMb) || sizeMb < 1 || !Number.isSafeInteger(sizeMb * MIB)) {
    throw new Error('--size-mb must be a positive whole number of MiB');
  }
  return cached(out, `large-${sizeMb}mib${quick ? '-quick' : ''}.mp4`, (file, work) => {
    const seed = path.join(work, 'seed.mp4');
    // Quick mode targets ten minutes at 100 MiB. The full seed uses a higher rate to keep the
    // default multi-GiB fixture near movie length. CBR filler keeps the size independent of the picture.
    const rate = quick ? '1400k' : '8000k';
    ff(['-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=24:d=10',
      ...X264, '-g', '240', '-sc_threshold', '0', '-b:v', rate, '-minrate', rate, '-maxrate', rate,
      '-bufsize', rate, '-x264-params', 'nal-hrd=cbr', seed]);
    const repeats = Math.ceil(sizeMb * MIB / fs.statSync(seed).size);
    console.log(`Stream-copying ${repeats} repetitions for the ${sizeMb} MiB fixture`);
    ff(['-stream_loop', String(repeats - 1), '-i', seed, '-c', 'copy', file]);
    if (fs.statSync(file).size < sizeMb * MIB * 0.99) throw new Error('Large fixture fell short of its target');
  });
}

function main(args) {
  let out = DEFAULT_OUT;
  let sizeMb;
  let quick = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--quick') quick = true;
    else if (arg === '--out' && args[i + 1] && !args[i + 1].startsWith('--')) out = path.resolve(args[++i]);
    else if (arg === '--size-mb' && /^\d+$/.test(args[i + 1] || '')) sizeMb = Number(args[++i]);
    else throw new Error('Usage: make_heavy_media.js [--out <dir>] [--size-mb <MiB>] [--quick]');
  }
  const clips = makeStepping(out);
  const files = [...Object.values(clips), makeTracks(out, clips.vfr), ...Object.values(makeFaults(out, clips.longGop)),
    makeLarge(out, sizeMb ?? (quick ? 100 : DEFAULT_SIZE), quick)];
  for (const file of files) console.log(`${path.basename(file)}: ${fs.statSync(file).size} bytes`);
}

if (require.main === module) {
  try { main(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exitCode = 1; }
}
module.exports = { makeStepping, makeFaults, makeLarge };
