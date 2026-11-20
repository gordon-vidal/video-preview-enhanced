'use strict';
// node test/host/sidecars_test.js: subtitle sidecar matching (tagsOf, matchSidecars) and
// findSidecars against a fake vscode.workspace.fs: folder layouts, size limits, unreadable
// files, odd names.
const assert = require('assert');
const { tagsOf, matchSidecars, findSidecars, MAX_BYTES, MAX_TOTAL } = require('../../src/sidecars');

// ---- tagsOf ---------------------------------------------------------------------
assert.deepStrictEqual(tagsOf([]), { lang: '', flags: [] });
assert.deepStrictEqual(tagsOf(['eng', 'forced']), { lang: 'eng', flags: ['forced'] });
assert.deepStrictEqual(tagsOf(['2_English']), { lang: 'en', flags: [] }, 'index prefix dropped, name mapped');
assert.deepStrictEqual(tagsOf(['12 German']), { lang: 'de', flags: [] });
assert.deepStrictEqual(tagsOf(['pt_BR']), { lang: 'pt-BR', flags: [] }, 'underscore region becomes a dash');
assert.deepStrictEqual(tagsOf(['en', 'de']), { lang: 'en', flags: [] }, 'first language wins');
assert.deepStrictEqual(tagsOf(['SDH', 'CC', 'FORCED']), { lang: '', flags: ['sdh', 'cc', 'forced'] }, 'flags are case-insensitive');
assert.deepStrictEqual(tagsOf(['extended']), { lang: '', flags: [] }, 'a word that is no language');
assert.deepStrictEqual(tagsOf(['', '3_', '___']), { lang: '', flags: [] }, 'empty parts and bare numbers');
assert.deepStrictEqual(tagsOf(['x', 'abcd']), { lang: '', flags: [] }, 'one letter / four letters are not codes');

// ---- matchSidecars --------------------------------------------------------------
const names = (r) => r.map((x) => x.rel);
let r = matchSidecars('Movie.mkv', [
  { name: 'movie.srt' }, { name: 'Movie.en.srt' }, { name: 'Movie.part2.srt' }, { name: 'Other.srt' },
  { name: 'Movie.txt' }, { name: 'Movie.forced.VTT' }, { name: 'MOVIE.ASS' }, { name: 'Moviesrt' },
]);
assert.deepStrictEqual(names(r).slice(0, 2).sort(), ['MOVIE.ASS', 'movie.srt']);
assert.strictEqual(r.length, 5);
assert.ok(r[0].exact && r[0].auto, 'same name: exact and auto');
assert.ok(r.find((x) => x.name === 'Movie.en.srt').auto);
assert.ok(!r.find((x) => x.name === 'Movie.part2.srt').auto, 'movie.part2.srt is menu-only (an unknown suffix)');
assert.strictEqual(r.find((x) => x.name === 'Other.srt'), undefined);

r = matchSidecars('Movie.mkv', [
  { name: '2_English.srt', dir: 'Subs/Movie' }, { name: '10_French.srt', dir: 'Subs/Movie' }, { name: '3_German.srt', dir: 'Subs/Movie' },
  { name: 'Movie.en.srt', dir: 'Subs' }, { name: 'Unrelated.srt', dir: 'Subs' }, { name: 'Movie.srt' },
]);
assert.deepStrictEqual(names(r), ['Movie.srt', 'Subs/Movie.en.srt', 'Subs/Movie/2_English.srt', 'Subs/Movie/3_German.srt', 'Subs/Movie/10_French.srt'],
  'same folder, then Subs, then the per-video folder in numeric order');
assert.ok(r[0].exact && !r[1].exact, 'only a same-folder file is exact');
assert.ok(r[2].auto, 'per-video folder files with a language are auto');
// An exact name inside Subs/ is not "exact" but still auto.
r = matchSidecars('a.mp4', [{ name: 'a.srt', dir: 'Subs' }]);
assert.ok(!r[0].exact && r[0].auto);
assert.deepStrictEqual(names(matchSidecars('a.b.c.mp4', [{ name: 'a.b.c.fr.srt' }])), ['a.b.c.fr.srt']);
assert.deepStrictEqual(names(matchSidecars('noext', [{ name: 'noext.srt' }])), ['noext.srt']);
assert.deepStrictEqual(matchSidecars('a.mp4', []), []);
r = matchSidecars('m.mp4', [{ name: 'forced.srt', dir: 'Subs/m' }, { name: 'whatever.srt', dir: 'Subs/m' }]);
assert.ok(r.find((x) => x.name === 'forced.srt').auto);
assert.ok(!r.find((x) => x.name === 'whatever.srt').auto);

// ---- findSidecars ---------------------------------------------------------------
const DIR = 2;
const FILE = 1;
function fake(tree, { sizes = {}, failRead = new Set() } = {}) {
  const uri = (p) => ({ path: p, toString: () => `file://${p}` });
  return {
    FileType: { Directory: DIR, File: FILE },
    Uri: { joinPath: (u, ...parts) => {
      const segs = u.path.split('/');
      for (const p of parts) { if (p === '..') segs.pop(); else segs.push(p); }
      return uri(segs.join('/'));
    } },
    workspace: { fs: {
      readDirectory: async (u) => { if (!tree[u.path]) throw new Error('ENOENT'); return tree[u.path]; },
      stat: async (u) => ({ size: sizes[u.path] ?? 10 }),
      readFile: async (u) => { if (failRead.has(u.path)) throw new Error('EACCES'); return Buffer.from(`data:${u.path}`); },
    } },
    uri,
  };
}
(async () => {
  const logs = [];
  const log = (m) => logs.push(m);
  const tree = {
    '/v': [['Movie.mkv', FILE], ['Movie.en.srt', FILE], ['Subs', DIR], ['subtitles', DIR], ['Extras', DIR], ['readme.txt', FILE]],
    '/v/Subs': [['Movie.de.srt', FILE], ['Movie', DIR], ['Other', DIR]],
    '/v/Subs/Movie': [['2_English.srt', FILE], ['nested', DIR]],
    '/v/subtitles': [],
  };
  let vs = fake(tree);
  let files = await findSidecars(vs, vs.uri('/v/Movie.mkv'), log);
  assert.deepStrictEqual(files.map((f) => f.name), ['Movie.en.srt', 'Subs/Movie.de.srt', 'Subs/Movie/2_English.srt']);
  assert.strictEqual(files[0].id, 'file:///v/Movie.en.srt');
  assert.ok(files[0].data instanceof Uint8Array && Buffer.from(files[0].data).toString() === 'data:/v/Movie.en.srt');
  assert.strictEqual(files[1].lang, 'de');

  // A folder that cannot be listed: no sidecars, no throw.
  vs = fake({});
  assert.deepStrictEqual(await findSidecars(vs, vs.uri('/gone/x.mp4'), log), []);

  // Size limits: one file too big, the total too big, an unreadable one.
  const t2 = { '/v': [['m.mp4', FILE], ['m.srt', FILE], ['m.en.srt', FILE], ['m.de.srt', FILE], ['m.fr.srt', FILE]] };
  vs = fake(t2, {
    sizes: { '/v/m.srt': MAX_BYTES + 1, '/v/m.de.srt': MAX_BYTES - 1, '/v/m.en.srt': MAX_BYTES - 1, '/v/m.fr.srt': 5 },
    failRead: new Set(['/v/m.fr.srt']),
  });
  logs.length = 0;
  files = await findSidecars(vs, vs.uri('/v/m.mp4'), log);
  assert.ok(!files.some((f) => f.name === 'm.srt'), 'a file over MAX_BYTES is skipped');
  assert.ok(logs.some((l) => /m\.srt skipped/.test(l)));
  assert.ok(logs.some((l) => /cannot read m\.fr\.srt: EACCES/.test(l)), 'unreadable file logged, others still read');
  assert.ok(logs.some((l) => /over \d+ bytes of subtitles/.test(l)), 'over the total budget');
  assert.deepStrictEqual(files.map((f) => f.name), ['m.de.srt']);

  // At most 40 candidates are read.
  const many = [['v.mp4', FILE]];
  for (let i = 0; i < 60; i++) many.push([`v.${i}.srt`, FILE]);
  vs = fake({ '/v': many });
  assert.strictEqual((await findSidecars(vs, vs.uri('/v/v.mp4'), log)).length, 40);
  console.log('sidecars: ok');
})().catch((e) => { console.error(e); process.exit(1); });
