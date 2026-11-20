'use strict';
// Subtitle files next to a video: video.srt, video.en.srt, video.eng.forced.srt,
// and the usual release layouts Subs/video.en.srt and Subs/video/2_English.srt.
// Matching is pure (testable); finding uses vscode.workspace.fs, so it reads
// wherever the file is (local, WSL, SSH, containers).

const SUB_EXT = /\.(srt|vtt|ass|ssa)$/i;
const MAX_BYTES = 20 * 1024 * 1024; // one file
const MAX_TOTAL = 32 * 1024 * 1024; // all sidecars of one video (each is sent to the webview)
const FLAGS = new Set(['forced', 'sdh', 'cc', 'hi', 'default', 'full', 'signs', 'songs']);
const LANG_NAMES = {
  english: 'en', german: 'de', deutsch: 'de', french: 'fr', francais: 'fr', spanish: 'es', espanol: 'es', italian: 'it',
  portuguese: 'pt', brazilian: 'pt-BR', russian: 'ru', japanese: 'ja', chinese: 'zh', korean: 'ko', dutch: 'nl', swedish: 'sv',
  norwegian: 'no', danish: 'da', finnish: 'fi', polish: 'pl', czech: 'cs', hungarian: 'hu', turkish: 'tr', arabic: 'ar',
  hebrew: 'he', greek: 'el', hindi: 'hi', thai: 'th', vietnamese: 'vi', ukrainian: 'uk', romanian: 'ro', indonesian: 'id',
};

/** Language and flags from name parts such as ['eng', 'forced'] or ['2_English']. */
function tagsOf(parts) {
  let lang = '';
  const flags = [];
  for (const raw of parts) {
    const keep = raw.replace(/^\d+[_ -]*/, '');
    const p = keep.toLowerCase();
    if (!p) continue;
    if (FLAGS.has(p)) { flags.push(p); continue; }
    if (lang) continue;
    if (LANG_NAMES[p]) lang = LANG_NAMES[p];
    else if (/^[a-z]{2,3}([-_][a-z0-9]{2,4})?$/i.test(p)) lang = keep.replace('_', '-');
  }
  return { lang, flags };
}

/**
 * @param {string} video the video's file name
 * @param {{ name: string, dir?: string }[]} entries subtitle candidates; dir '' (same folder),
 *   'Subs' (a subtitles folder) or 'Subs/<video name>' (a folder per video)
 * @returns {{ name: string, rel: string, lang: string, flags: string[], exact: boolean, auto: boolean }[]} best first.
 *   auto: may be shown without asking (the same name, or a language/flag suffix). Other
 *   suffixes (movie.part2.srt, movie.extended.srt) may belong to another video: menu only.
 */
function matchSidecars(video, entries) {
  const base = video.replace(/\.[^.]+$/, '').toLowerCase();
  const out = [];
  const tagged = (name, rel, parts) => {
    const t = tagsOf(parts);
    return { name, rel, ...t, exact: false, auto: !!t.lang || t.flags.length > 0 };
  };
  for (const e of entries) {
    if (!SUB_EXT.test(e.name)) continue;
    const stem = e.name.replace(SUB_EXT, '');
    const low = stem.toLowerCase();
    const dir = e.dir || '';
    const rel = dir ? `${dir}/${e.name}` : e.name;
    const perVideo = dir.includes('/');
    if (low === base) out.push({ name: e.name, rel, lang: '', flags: [], exact: !dir, auto: true });
    else if (low.startsWith(`${base}.`)) out.push(tagged(e.name, rel, stem.slice(base.length + 1).split('.')));
    else if (perVideo) out.push(tagged(e.name, rel, stem.split(/[.]/)));
  }
  const coll = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  // Same name first, then the same folder, then subtitle folders.
  const rank = (f) => (f.exact ? 0 : f.rel.includes('/') ? 2 : 1);
  return out.sort((a, b) => rank(a) - rank(b) || coll.compare(a.rel, b.rel));
}

/**
 * Reads the matching subtitle files for a video Uri: [{ id, name, lang, flags, exact, auto, data }]
 * (id: the file's URI). At most MAX_TOTAL bytes in all, best matches first.
 */
async function findSidecars(vscode, videoUri, log) {
  const fsx = vscode.workspace.fs;
  const dirUri = vscode.Uri.joinPath(videoUri, '..');
  const video = videoUri.path.split('/').pop();
  const base = video.replace(/\.[^.]+$/, '').toLowerCase();
  const list = async (uri) => { try { return await fsx.readDirectory(uri); } catch { return []; } };
  const entries = [];
  const DIR = vscode.FileType.Directory;
  for (const [name, type] of await list(dirUri)) {
    if (type & DIR) {
      if (!/^(subs|subtitles)$/i.test(name)) continue;
      for (const [n2, t2] of await list(vscode.Uri.joinPath(dirUri, name))) {
        if (t2 & DIR) {
          if (n2.toLowerCase() !== base) continue;
          for (const [n3, t3] of await list(vscode.Uri.joinPath(dirUri, name, n2))) if (!(t3 & DIR)) entries.push({ name: n3, dir: `${name}/${n2}` });
        } else entries.push({ name: n2, dir: name });
      }
    } else entries.push({ name });
  }
  const found = matchSidecars(video, entries).slice(0, 40);
  const files = [];
  let total = 0;
  for (const f of found) {
    const uri = vscode.Uri.joinPath(dirUri, ...f.rel.split('/'));
    try {
      const st = await fsx.stat(uri);
      if (st.size > MAX_BYTES) { log(`subtitles: ${f.rel} skipped (${st.size} bytes)`); continue; }
      if (total + st.size > MAX_TOTAL) { log(`subtitles: ${f.rel} skipped (over ${MAX_TOTAL} bytes of subtitles)`); continue; }
      total += st.size;
      files.push({ id: uri.toString(), name: f.rel, lang: f.lang, flags: f.flags, exact: f.exact, auto: f.auto, data: new Uint8Array(await fsx.readFile(uri)) });
    } catch (e) {
      log(`subtitles: cannot read ${f.rel}: ${e.message}`);
    }
  }
  return files;
}

module.exports = { matchSidecars, findSidecars, tagsOf, SUB_EXT, MAX_BYTES, MAX_TOTAL };
