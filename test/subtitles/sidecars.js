/*
 * Node tests for src/sidecars.js matching:  node test/subtitles/sidecars.js
 */
'use strict';
const { matchSidecars, tagsOf } = require('../../src/sidecars.js');

let failures = 0;
const eq = (a, b, msg) => {
  const ok = JSON.stringify(a) === JSON.stringify(b);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}${ok ? '' : `: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`}`);
  if (!ok) failures++;
};

const found = matchSidecars('My.Movie.2020.mkv', [
  { name: 'My.Movie.2020.mkv' },
  { name: 'My.Movie.2020.eng.forced.srt' },
  { name: 'My.Movie.2020.en.srt' },
  { name: 'my.movie.2020.SRT' },
  { name: 'My.Movie.2020.pt-BR.ass' },
  { name: 'My.Movie.2020.nfo' },
  { name: 'Other.Movie.srt' },
  { name: 'My.Movie.2020.extended.srt' },
  { name: 'My.Movie.2020.de.vtt', dir: 'Subs' },
  { name: 'Unrelated.srt', dir: 'Subs' },
  { name: '2_English.srt', dir: 'Subs/My.Movie.2020' },
  { name: '3_German.ssa', dir: 'Subs/My.Movie.2020' },
]);
eq(found.map((f) => f.rel), [
  'my.movie.2020.SRT', 'My.Movie.2020.en.srt', 'My.Movie.2020.eng.forced.srt', 'My.Movie.2020.extended.srt', 'My.Movie.2020.pt-BR.ass',
  'Subs/My.Movie.2020.de.vtt', 'Subs/My.Movie.2020/2_English.srt', 'Subs/My.Movie.2020/3_German.ssa',
], 'order: exact (case-insensitive), same folder, then Subs/');
eq(found[0].exact, true, 'exact name flagged');
eq(found.map((f) => f.lang), ['', 'en', 'eng', '', 'pt-BR', 'de', 'en', 'de'], 'languages');
eq(found[2].flags, ['forced'], 'forced flag');
eq(found.map((f) => f.auto), [true, true, true, false, true, true, true, true], 'auto-select: same name, language or flag suffixes only');
eq(matchSidecars('movie.mkv', [{ name: 'movie.part2.srt' }, { name: 'movie.en.srt' }]).map((f) => [f.name, f.auto]),
  [['movie.en.srt', true], ['movie.part2.srt', false]], 'movie.part2.srt is listed but not auto-selected');
eq(tagsOf(['eng', 'sdh']), { lang: 'eng', flags: ['sdh'] }, 'tags: eng.sdh');
eq(tagsOf(['forced']), { lang: '', flags: ['forced'] }, 'tags: forced only');
eq(matchSidecars('clip.mp4', [{ name: 'clip.mp4.srt' }, { name: 'clipper.srt' }, { name: 'clip.srt.bak' }]).map((f) => [f.name, f.lang]), [['clip.mp4.srt', '']], 'video.mp4.srt matches; no false matches');


// findSidecars: total byte cap, URIs as ids (fake vscode.workspace.fs).
(async () => {
  const { findSidecars, MAX_TOTAL } = require('../../src/sidecars.js');
  const join = (u, ...p) => ({ path: [u.path, ...p].join('/').replace(/\/[^/]+\/\.\.$/, ''), toString() { return `file://${this.path}`; } });
  const names = ['v.srt', 'v.en.srt', 'v.de.srt', 'v.fr.srt'];
  const read = [];
  const vscode = {
    FileType: { Directory: 2 },
    Uri: { joinPath: join },
    workspace: { fs: {
      readDirectory: async () => names.map((n) => [n, 1]),
      stat: async () => ({ size: 12 * 1024 * 1024 }),
      readFile: async (u) => { read.push(u.path); return new Uint8Array(4); },
    } },
  };
  const files = await findSidecars(vscode, { path: '/d/v.mkv', toString() { return 'file:///d/v.mkv'; } }, () => {});
  eq(files.length, Math.floor(MAX_TOTAL / (12 * 1024 * 1024)), 'total byte cap');
  eq(read.length, files.length, 'skipped files are not read');
  eq(files[0].id, 'file:///d/v.srt', 'id is the file URI');
  console.log(failures ? `\n${failures} failure(s)` : '\nall passed');
  process.exit(failures ? 1 : 0);
})();
