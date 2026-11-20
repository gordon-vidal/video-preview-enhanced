#!/usr/bin/env node
'use strict';
// The probe clips in media/probe/ (src/probe.js tests ffmpeg's GPU decoding with them) are
// short excerpts of real footage (Meridian, Netflix Open Content, CC BY 4.0; attribution in
// THIRD_PARTY_NOTICES.md). They are made together with the test media:
//
//   node test/media/fetch_sources.js <footage dir>
//   node test/media/make_media.js --src <footage dir> --masters --probe [--ffmpeg <exe>]
//
// This script forwards to that: node build/probe/make_probe_clips.js <footage dir> [ffmpeg]
const path = require('path');
const { spawnSync } = require('child_process');

if (!process.argv[2]) { console.error('usage: node build/probe/make_probe_clips.js <footage dir> [ffmpeg]'); process.exit(2); }
const args = [path.join(__dirname, '..', '..', 'test', 'media', 'make_media.js'), '--src', process.argv[2], '--masters', '--probe', '--only', 'mer|_(1080|2160)\\.mkv$'];
if (process.argv[3]) args.push('--ffmpeg', process.argv[3]);
process.exit(spawnSync(process.execPath, args, { stdio: 'inherit', windowsHide: true }).status ?? 1);
