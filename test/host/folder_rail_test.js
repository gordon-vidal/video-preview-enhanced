'use strict';
// node test/host/folder_rail_test.js: the folder rail (src/folder-rail.js host controller, media/folder-rail.js
// helpers, src/folder-rail-html.js), Autoplay (media/autoplay.js, settings resolution) and the folder navigation of
// src/extension.js (tab swap with a handoff intent, an already open target, Autoplay's next video), with a fake
// file system and the mock vscode module. docs/notes/folder-rail.md has the design.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const R = require('../../src/folder-rail');
const RailPage = require('../../media/folder-rail');
const Autoplay = require('../../media/autoplay');
const { folderRailHtml } = require('../../src/folder-rail-html');
const { barHtml } = require('../../src/bar');
const { unifiedHtml } = require('../../src/unified-html');
const { load, webviewConfig } = require('./mock_vscode');

const P = path.posix;
const tick = () => new Promise((r) => setImmediate(r));
const settle = async (n = 20) => { for (let i = 0; i < n; i++) await tick(); };

/** A fake file system: tree { '/v': { 'a.mp4': 100, sub: {} } }; numbers are file sizes. Calls are deferred so a test can count concurrency. */
function fakeFs(tree, { links = {} } = {}) {
  const at = (p) => p.split('/').filter(Boolean).reduce((n, k) => (n && typeof n === 'object' ? n[k] : undefined), tree);
  const st = { readdir: 0, stat: 0, inStat: 0, maxInStat: 0, statOrder: [] };
  const dirent = (name, v, full) => ({
    name,
    isDirectory: () => typeof v === 'object',
    isFile: () => typeof v === 'number',
    isSymbolicLink: () => v === 'link',
    full,
  });
  const api = {
    st,
    hold: false, // stat calls wait for release() while set
    waiting: [],
    release() { const w = api.waiting; api.waiting = []; for (const f of w) f(); },
    async readdir(d) {
      st.readdir++;
      const n = at(d);
      if (!n || typeof n !== 'object') { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
      return Object.entries(n).map(([k, v]) => dirent(k, v, P.join(d, k)));
    },
    async stat(p) {
      st.stat++; st.inStat++; st.maxInStat = Math.max(st.maxInStat, st.inStat); st.statOrder.push(P.basename(p));
      try {
        if (api.hold) await new Promise((r) => api.waiting.push(r));
        await tick();
        const target = links[p] || p;
        const n = at(target);
        if (n === undefined) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
        return { size: typeof n === 'number' ? n : 0, mtimeMs: 1700000000000 + (typeof n === 'number' ? n : 0), isDirectory: () => typeof n === 'object', isFile: () => typeof n === 'number' };
      } finally { st.inStat--; }
    },
  };
  return api;
}

const TREE = {
  v: {
    'clip 10.mp4': 10, 'clip 2.mkv': 2, 'Clip 1.mov': 1, 'notes.md': 5, '.hidden.mp4': 3, 'B.avi': 7, 'b.avi': 8,
    sub: { 'x 2.mp4': 2, 'x 10.mp4': 10, 'x 1.webm': 1 }, 'Sub 10': {}, 'sub 9': {}, '.git': {},
    one: { 'only.mp4': 4 },
  },
};

function rail(fsys, o = {}) {
  const posted = [];
  const timers = [];
  const ctl = R.createFolderRail({
    fs: fsys, path: P, post: (m) => posted.push(m), cache: o.cache || R.createMetaCache(), authority: o.authority || '',
    probe: o.probe, current: o.current || (() => null), statPool: o.statPool, probePool: o.probePool,
    setTimer: (fn) => { timers.push(fn); return timers.length; }, clearTimer: () => {},
  });
  const flush = () => { const t = timers.splice(0); for (const f of t) f(); };
  return { ctl, posted, flush, lists: () => posted.filter((m) => m.op === 'list'), metas: () => posted.filter((m) => m.op === 'meta') };
}

(async () => {
  // ---- natural order with a deterministic tie-break ----
  {
    const names = ['clip 10.mp4', 'clip 2.mkv', 'Clip 1.mov', 'b.avi', 'B.avi', 'a 1', 'a 01'];
    const sorted = [...names].sort(R.naturalCompare);
    assert.deepStrictEqual(sorted.slice(0, 2).sort(), ['a 01', 'a 1'], 'numbers compare by value');
    assert.deepStrictEqual(sorted.slice(2), ['B.avi', 'b.avi', 'Clip 1.mov', 'clip 2.mkv', 'clip 10.mp4'], 'natural, case-insensitive; ties in code-unit order');
    // The same however readdir returned them.
    assert.deepStrictEqual([...names].reverse().sort(R.naturalCompare), sorted, 'order independent of the input');
  }

  // ---- a listing: .. first, folders, then files; hidden left out; kinds; root has no .. ----
  {
    const f = fakeFs(TREE);
    const { ctl, lists } = rail(f, { current: () => '/v/clip 2.mkv' });
    const msg = await ctl.browse('/v');
    assert.strictEqual(msg.gen, 1);
    const names = msg.entries.map((e) => e.name);
    assert.deepStrictEqual(names, ['..', 'one', 'sub', 'sub 9', 'Sub 10', 'B.avi', 'b.avi', 'Clip 1.mov', 'clip 2.mkv', 'clip 10.mp4', 'notes.md']);
    assert.deepStrictEqual(msg.entries.map((e) => e.kind), ['up', 'dir', 'dir', 'dir', 'dir', 'video', 'video', 'video', 'video', 'video', 'file']);
    assert.ok(!names.some((n) => n.startsWith('.') && n !== '..'), 'dot files and folders are hidden');
    assert.strictEqual(msg.crumb, 'v', 'header: the folder (no parent name under the root)');
    assert.strictEqual(msg.entries.find((e) => e.id === msg.current).name, 'clip 2.mkv', 'the playing file is marked');
    assert.ok(msg.entries.every((e) => !('path' in e)), 'no paths go to the page');
    assert.ok(msg.entries.every((e) => /^\d+\.\d+$/.test(e.id)), 'opaque ids');
    assert.strictEqual(lists().length, 1);
    const root = await ctl.browse('/');
    assert.ok(!root.entries.some((e) => e.kind === 'up'), 'no .. at the file system root');
    assert.strictEqual(root.root, true);
    const sub = await ctl.browse('/v/sub');
    assert.strictEqual(sub.crumb, 'v / sub');
    assert.deepStrictEqual(sub.entries.map((e) => e.name), ['..', 'x 1.webm', 'x 2.mp4', 'x 10.mp4']);
    // Up again: the folder walked out of is named so the page puts its cursor there.
    const up = await ctl.browse('/v');
    assert.strictEqual(up.entries.find((e) => e.id === up.from).name, 'sub');
    // A folder that cannot be read: an empty listing with a message.
    const bad = await ctl.browse('/nope');
    assert.deepStrictEqual(bad.entries, []);
    assert.match(bad.error, /cannot be read/);
  }

  // ---- symlinks: what they point to decides; a broken one is left out ----
  {
    const tree = { d: { 'l1': 'link', 'l2': 'link', 'l3': 'link', 'real.mp4': 1, folder: {} } };
    const f = fakeFs(tree, { links: { '/d/l1': '/d/folder', '/d/l2': '/d/real.mp4', '/d/l3': '/d/gone' } });
    const { ctl } = rail(f);
    const msg = await ctl.browse('/d');
    assert.deepStrictEqual(msg.entries.map((e) => `${e.kind}:${e.name}`), ['up:..', 'dir:folder', 'dir:l1', 'file:l2', 'video:real.mp4']);
  }

  // ---- stale generations and unknown ids are rejected ----
  {
    const { ctl } = rail(fakeFs(TREE));
    const a = await ctl.browse('/v');
    const id = a.entries[2].id;
    assert.ok(ctl.entry(a.gen, id), 'current id resolves');
    const b = await ctl.browse('/v/sub');
    assert.strictEqual(ctl.entry(a.gen, id), null, 'an id of an older listing is refused');
    assert.strictEqual(ctl.entry(b.gen, '/v/sub/x 1.webm'), null, 'a path is not an id');
    assert.strictEqual(ctl.entry(b.gen, 42), null);
    assert.strictEqual(ctl.entry(b.gen, b.entries[1].id).path, '/v/sub/x 1.webm');
  }

  // ---- browse folder is not the playback folder ----
  {
    const f = fakeFs(TREE);
    const { ctl } = rail(f, { current: () => '/v/clip 2.mkv' });
    await ctl.browse('/v/sub');
    assert.strictEqual(ctl.dir(), '/v/sub');
    const n = await R.neighbourOf(f, '/v/clip 2.mkv', 1, P);
    assert.deepStrictEqual(n, { index: 3, count: 5, target: '/v/clip 10.mp4' }, 'next is in the playing file\'s folder, whatever is browsed');
    const p = await R.neighbourOf(f, '/v/clip 2.mkv', -1, P);
    assert.strictEqual(p.target, '/v/Clip 1.mov');
    assert.deepStrictEqual(await R.neighbourOf(f, '/v/clip 10.mp4', 1, P), { index: 4, count: 5, target: null }, 'no wrap at the last video');
    assert.deepStrictEqual(await R.neighbourOf(f, '/v/B.avi', -1, P), { index: 0, count: 5, target: null }, 'none before the first');
    assert.strictEqual((await R.neighbourOf(f, '/v/one/only.mp4', 0, P)).count, 1, 'a folder of one video (no capsule)');
    assert.strictEqual((await R.neighbourOf(f, '/v/CLIP 2.MKV', 0, P)).index, 3, 'case of the uri differs from the disk');
    assert.strictEqual((await R.neighbourOf(f, '/v/notes.md', 1, P)).index, -1, 'not a video: not placed');
    // The rail listing did not change it and the browse folder is still the subfolder.
    assert.strictEqual(ctl.dir(), '/v/sub');
  }

  // ---- metadata: names first, then a pool of 4 stat calls, hovered > visible > rest, batched patches ----
  {
    const many = { big: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`f${i}.mp4`, i + 1])) };
    const f = fakeFs(many);
    f.hold = true;
    const { ctl, posted, flush, metas } = rail(f);
    const msg = await ctl.browse('/big');
    assert.strictEqual(posted.length, 1, 'the listing is posted before any stat answers');
    assert.strictEqual(f.st.stat, 4, 'stat pool of 4');
    const ids = msg.entries.filter((e) => e.kind === 'video').map((e) => e.id);
    const byName = (n) => msg.entries.find((e) => e.name === n).id;
    ctl.setVisible(msg.gen, [byName('f30.mp4'), byName('f31.mp4')]);
    ctl.setHover(msg.gen, byName('f39.mp4'));
    f.release(); await settle(3);
    // After the first four (list order), the hovered row, then the visible rows.
    assert.deepStrictEqual(f.st.statOrder.slice(4, 7), ['f39.mp4', 'f30.mp4', 'f31.mp4']);
    f.hold = false; f.release(); await settle(40); f.release(); await settle(40);
    assert.ok(f.st.maxInStat <= 4, `never more than 4 stat calls at once (${f.st.maxInStat})`);
    assert.strictEqual(metas().length, 0, 'patches wait for the batch timer');
    flush();
    const m = metas();
    assert.strictEqual(m.length, 1, 'one batched message');
    assert.strictEqual(m[0].patches.length, ids.length, 'every file');
    assert.ok(m[0].patches.every((x) => x.size > 0 && x.mtime > 0));
    assert.strictEqual(ctl.stats().probe, 0, 'no ffprobe without a probe function');
  }

  // ---- ffprobe: only hovered / visible videos, cached by size and date, the playing file seeded, never for others ----
  {
    const f = fakeFs(TREE);
    const probed = [];
    const probe = async (file) => { probed.push(P.basename(file)); return { duration: 12.5, width: 1920, height: 1080, codec: 'h264' }; };
    const cache = R.createMetaCache();
    const { ctl, flush, metas } = rail(f, { probe, cache, authority: 'ssh-remote+box', current: () => '/v/clip 2.mkv' });
    ctl.seed('/v/clip 2.mkv', { duration: 3, width: 640, height: 360, codec: 'hevc' });
    const msg = await ctl.browse('/v');
    await settle(40);
    assert.deepStrictEqual(probed, [], 'nothing probed until shown');
    const id = (n) => msg.entries.find((e) => e.name === n).id;
    ctl.setVisible(msg.gen, [id('clip 2.mkv'), id('clip 10.mp4'), id('notes.md'), id('sub')]);
    await settle(40);
    assert.deepStrictEqual(probed, ['clip 10.mp4'], 'the visible video only; the playing one is seeded; not files or folders');
    ctl.setHover(msg.gen, id('B.avi'));
    await settle(40);
    assert.deepStrictEqual(probed, ['clip 10.mp4', 'B.avi'], 'the hovered one');
    flush();
    const all = Object.assign({}, ...metas().flatMap((m) => m.patches).map((p) => ({ [p.id]: { ...p } })));
    assert.strictEqual(all[id('clip 10.mp4')].duration, 12.5);
    assert.strictEqual(all[id('clip 2.mkv')].duration, 3, 'seeded metadata reaches the row');
    assert.strictEqual(all[id('clip 10.mp4')].codec, 'h264');
    // Again: from the cache (same size and date), even in another tab's rail.
    const other = rail(f, { probe, cache, authority: 'ssh-remote+box' });
    const m2 = await other.ctl.browse('/v');
    other.ctl.setVisible(m2.gen, m2.entries.map((e) => e.id));
    await settle(60);
    assert.strictEqual(probed.filter((x) => x === 'clip 10.mp4').length, 1, 'cached across rails');
    // Another authority (another machine) does not share it.
    const third = rail(f, { probe, cache, authority: 'wsl+Ubuntu' });
    const m3 = await third.ctl.browse('/v');
    third.ctl.setVisible(m3.gen, [m3.entries.find((e) => e.name === 'clip 10.mp4').id]);
    await settle(40);
    assert.strictEqual(probed.filter((x) => x === 'clip 10.mp4').length, 2, 'the cache key has the authority');
    // The LRU is bounded.
    const small = R.createMetaCache(2);
    small.set('a', {}); small.set('b', {}); small.get('a'); small.set('c', {});
    assert.strictEqual(small.size, 2);
    assert.ok(small.get('a') && !small.get('b'), 'least recently used goes first');
  }

  // ---- cancellation: a folder change, close or hide stops queued and running work; late answers are dropped ----
  {
    const f = fakeFs(TREE);
    let aborted = 0;
    let release;
    const probe = (file, signal) => new Promise((resolve) => {
      signal.addEventListener('abort', () => aborted++);
      release = () => resolve({ duration: 99 });
    });
    const { ctl, flush, metas, posted } = rail(f, { probe });
    const a = await ctl.browse('/v');
    ctl.setVisible(a.gen, [a.entries.find((e) => e.name === 'clip 10.mp4').id]);
    await settle(40);
    assert.strictEqual(ctl.stats().probeBusy, 1, 'probing');
    f.hold = true;
    const b = await ctl.browse('/v/sub'); // folder change while the probe and stats run
    assert.strictEqual(aborted, 1, 'the running probe is aborted');
    release(); f.hold = false; f.release(); await settle(40);
    flush();
    assert.ok(metas().every((m) => m.gen === b.gen), 'no patch of the old listing reaches the page');
    assert.ok(!metas().some((m) => m.patches.some((p) => p.duration === 99)), 'the late probe answer is dropped');
    // Close / hide: queues emptied; resume asks again for what is unknown.
    ctl.cancel();
    assert.deepStrictEqual([ctl.stats().statWant, ctl.stats().probeWant], [0, 0]);
    const before = posted.length;
    ctl.resume();
    await settle(40);
    flush();
    assert.ok(posted.length >= before, 'resume is harmless');
    ctl.dispose();
    assert.strictEqual(await ctl.browse('/v'), null, 'a disposed rail lists nothing');
  }

  // ---- closing or hiding the rail while the folder is read: nothing is posted or queued; resume reads it again ----
  {
    const f = fakeFs(TREE);
    let readRelease;
    const realReaddir = f.readdir;
    f.readdir = (d, o) => new Promise((resolve) => { readRelease = () => resolve(realReaddir(d, o)); });
    const { ctl, posted, lists } = rail(f);
    const pending = ctl.browse('/v');
    await tick();
    ctl.cancel(); // the rail closes while readdir runs
    readRelease();
    assert.strictEqual(await pending, null, 'the listing read before the close is dropped');
    await settle(20);
    assert.strictEqual(posted.length, 0, 'nothing posted while closed');
    assert.strictEqual(f.st.stat, 0, 'no stat work started while closed');
    assert.ok(ctl.stats().suspended && ctl.stats().relist);
    f.readdir = realReaddir;
    await ctl.resume();
    assert.strictEqual(lists().length, 1, 'resume reads the folder again');
    assert.ok(!ctl.stats().suspended);
  }

  // ---- resume called BEFORE the cancelled readdir finishes still re-lists ----
  {
    const f = fakeFs(TREE);
    const realReaddir = f.readdir;
    let calls = 0;
    let firstRelease;
    f.readdir = (d, o) => {
      calls++;
      if (calls === 1) return new Promise((resolve) => { firstRelease = () => resolve(realReaddir(d, o)); });
      return realReaddir(d, o);
    };
    const { ctl, lists } = rail(f);
    const pending = ctl.browse('/v');
    await tick();
    ctl.cancel();
    assert.ok(ctl.stats().relist, 'interrupted listing recorded at cancel time');
    const resumed = ctl.resume();
    firstRelease();
    assert.strictEqual(await pending, null, 'stale first read dropped');
    await resumed;
    assert.strictEqual(calls, 2, 'resume started a fresh listing');
    assert.strictEqual(lists().length, 1, 'fresh listing posted');
  }

  // ---- a pending metadata patch at a close or hide is not lost: resume posts what is known ----
  {
    const f = fakeFs(TREE);
    const { ctl, metas, flush } = rail(f);
    const a = await ctl.browse('/v/sub');
    await settle(40); // the stats are done; their patch waits for the batch timer
    ctl.cancel(); // closed before the timer fired: the timer is cleared
    flush();
    assert.strictEqual(metas().length, 0, 'no patch posted while closed');
    await ctl.resume();
    const m = metas();
    assert.strictEqual(m.length, 1, 'resume republishes the known metadata');
    assert.strictEqual(m[0].gen, a.gen);
    assert.deepStrictEqual(m[0].patches.map((x) => x.size).sort((x, y) => x - y), [1, 2, 10], 'sizes recorded before the close');
  }

  // ---- symlinks in the playback folder: only links to regular files count as videos ----
  {
    const tree = { d: { 'a.mp4': 1, 'dirlink.mp4': 'link', 'broken.mp4': 'link', 'filelink.mkv': 'link', real: {} } };
    const f = fakeFs(tree, { links: { '/d/dirlink.mp4': '/d/real', '/d/broken.mp4': '/d/gone', '/d/filelink.mkv': '/d/a.mp4' } });
    const n = await R.neighbourOf(f, '/d/a.mp4', 1, P);
    assert.deepStrictEqual(n, { index: 0, count: 2, target: '/d/filelink.mkv' }, 'a link to a folder or a broken link is not a video');
    const { ctl } = rail(f);
    const msg = await ctl.browse('/d');
    assert.deepStrictEqual(msg.entries.map((e) => `${e.kind}:${e.name}`), ['up:..', 'dir:dirlink.mp4', 'dir:real', 'video:a.mp4', 'video:filelink.mkv']);
  }

  // ---- "Compare all videos in folder" preflight ----
  {
    assert.deepStrictEqual(R.planFolderCompare({ videoKeys: ['a', 'b', 'c'], compareKeys: null, max: 8 }), { action: 'open', keys: ['a', 'b', 'c'], skipped: 0 });
    assert.deepStrictEqual(R.planFolderCompare({ videoKeys: ['a'], compareKeys: null, max: 8 }), { action: 'few', keys: [], skipped: 0 }, 'one video: no Compare');
    assert.deepStrictEqual(R.planFolderCompare({ videoKeys: ['a', 'b', 'c'], compareKeys: null, max: 2 }), { action: 'open', keys: ['a', 'b'], skipped: 1 });
    assert.deepStrictEqual(R.planFolderCompare({ videoKeys: ['a', 'b'], compareKeys: ['a', 'x'], max: 8 }), { action: 'add', keys: ['b'], skipped: 0 }, 'no duplicates');
    assert.deepStrictEqual(R.planFolderCompare({ videoKeys: ['a', 'b'], compareKeys: ['x', 'y'], max: 2 }), { action: 'full', keys: [], skipped: 2 });
    assert.deepStrictEqual(R.planFolderCompare({ videoKeys: ['a'], compareKeys: ['a'], max: 8 }), { action: 'none', keys: [], skipped: 0 });
    assert.strictEqual(R.planFolderCompare({ videoKeys: [], compareKeys: ['a'], max: 8 }).action, 'few');
  }

  // ---- handoff intents: one per target, the editor group must match, they expire ----
  {
    let now = 1000;
    const h = R.createHandoffs({ now: () => now, ttlMs: 500 });
    h.register('file:///v/b.mp4', 1, { rail: { open: true } });
    assert.strictEqual(h.take('file:///v/b.mp4', 2), null, 'another editor group does not take it');
    assert.deepStrictEqual(h.take('file:///v/b.mp4', 1), { rail: { open: true } });
    assert.strictEqual(h.take('file:///v/b.mp4', 1), null, 'consumed once');
    h.register('file:///v/c.mp4', 1, { x: 1 });
    now += 501;
    assert.strictEqual(h.take('file:///v/c.mp4', 1), null, 'expired');
    h.register('file:///v/d.mp4', undefined, { y: 1 });
    assert.deepStrictEqual(h.take('file:///v/d.mp4', 3), { y: 1 }, 'no group known: any');
    // Two editor groups navigating to the same file keep their own intent; a drop removes only its registration.
    const t1 = h.register('file:///v/e.mp4', 1, { g: 1 });
    const t2 = h.register('file:///v/e.mp4', 2, { g: 2 });
    assert.notStrictEqual(t1.id, t2.id);
    h.drop(t1);
    assert.deepStrictEqual(h.take('file:///v/e.mp4', 2), { g: 2 }, 'group 2 keeps its intent after group 1 dropped');
    const t3 = h.register('file:///v/f.mp4', 1, { old: true });
    h.register('file:///v/f.mp4', 1, { fresh: true }); // a newer navigation to the same slot
    h.drop(t3);
    assert.deepStrictEqual(h.take('file:///v/f.mp4', 1), { fresh: true }, 'an old token does not drop the newer intent');
    assert.strictEqual(h.size(), 0);
  }

  // ---- Autoplay setting: onEnd wins; an explicitly set (deprecated) loop still applies; else off ----
  {
    const i = (o) => o; // an inspect() result
    assert.strictEqual(R.resolveOnEnd(undefined, undefined), 'off');
    assert.strictEqual(R.resolveOnEnd(i({ defaultValue: 'off' }), i({ defaultValue: true })), 'off', 'defaults: off (loop\'s default true is not a choice)');
    assert.strictEqual(R.resolveOnEnd(i({}), i({ globalValue: true })), 'loop', 'loop set true');
    assert.strictEqual(R.resolveOnEnd(i({}), i({ workspaceValue: false })), 'off', 'loop set false');
    assert.strictEqual(R.resolveOnEnd(i({ globalValue: 'next' }), i({ globalValue: true })), 'next', 'onEnd wins');
    assert.strictEqual(R.resolveOnEnd(i({ globalValue: 'next', workspaceValue: 'loop' }), i({})), 'loop', 'workspace over user');
    assert.strictEqual(R.resolveOnEnd(i({ globalValue: 'bogus' }), i({ globalValue: false })), 'off', 'an invalid onEnd falls back');
  }

  // ---- 1-click Compare preflight ----
  {
    assert.deepStrictEqual(R.planCompareRow({ compareKeys: null, playerKey: 'a', targetKey: 'b', max: 8 }), { action: 'open', keys: ['a', 'b'] });
    assert.strictEqual(R.planCompareRow({ compareKeys: null, playerKey: 'a', targetKey: 'a', max: 8 }).action, 'none');
    assert.deepStrictEqual(R.planCompareRow({ compareKeys: ['x'], playerKey: 'a', targetKey: 'b', max: 8 }), { action: 'add', keys: ['a', 'b'], skipped: 0 });
    assert.deepStrictEqual(R.planCompareRow({ compareKeys: ['a', 'x'], playerKey: 'a', targetKey: 'b', max: 8 }), { action: 'add', keys: ['b'], skipped: 0 }, 'no duplicate');
    assert.deepStrictEqual(R.planCompareRow({ compareKeys: ['x', 'y', 'z'], playerKey: 'a', targetKey: 'b', max: 4 }), { action: 'add', keys: ['a'], skipped: 1 }, 'capacity');
    assert.deepStrictEqual(R.planCompareRow({ compareKeys: ['x', 'y'], playerKey: 'a', targetKey: 'b', max: 2 }), { action: 'full', keys: [], skipped: 2 });
    assert.deepStrictEqual(R.planCompareRow({ compareKeys: ['a', 'b'], playerKey: 'a', targetKey: 'b', max: 8 }), { action: 'none', keys: [], skipped: 0 });
  }

  // ---- remembered look and the carried state are cleaned ----
  {
    assert.deepStrictEqual(R.sanitizeRailPrefs(null), { width: 218, column: 'duration', playable: true });
    assert.deepStrictEqual(R.sanitizeRailPrefs({ width: 999, column: 'size', playable: false }), { width: 360, column: 'size', playable: false });
    assert.deepStrictEqual(R.sanitizeRailPrefs({ width: 10, column: '<b>' }), { width: 176, column: 'duration', playable: true });
    assert.deepStrictEqual(R.sanitizeRailCarry({ open: 'yes', width: 250.4, filter: 'x'.repeat(300), onEnd: 'next' }), { open: false, width: 250, filter: 'x'.repeat(200), onEnd: 'next' });
    assert.strictEqual(R.sanitizeRailCarry({ onEnd: 'rm -rf' }).onEnd, undefined);
  }

  // ---- page helpers (media/folder-rail.js) ----
  {
    assert.strictEqual(RailPage.fmtDuration(75.2), '1:15');
    assert.strictEqual(RailPage.fmtDuration(3725), '1:02:05');
    assert.strictEqual(RailPage.fmtDuration(0), '—');
    assert.strictEqual(RailPage.fmtDuration(undefined), '—');
    assert.strictEqual(RailPage.fmtSize(2150), '2.1 KB');
    assert.strictEqual(RailPage.fmtSize(14.2 * 1024 * 1024), '14.2 MB');
    assert.strictEqual(RailPage.fmtSize(412 * 1024 * 1024), '412 MB');
    assert.strictEqual(RailPage.fmtSize(undefined), '—');
    const now = new Date(2026, 10, 24, 18, 0).getTime();
    assert.strictEqual(RailPage.fmtModified(new Date(2026, 10, 24, 14, 22).getTime(), now), '14:22');
    assert.strictEqual(RailPage.fmtModified(new Date(2026, 10, 22, 9, 0).getTime(), now), 'Nov 22');
    assert.strictEqual(RailPage.fmtModified(new Date(2024, 2, 5).getTime(), now), '2024-03-05');
    const es = [{ name: '..', kind: 'up' }, { name: 'sub', kind: 'dir' }, { name: 'A.mp4', kind: 'video' }, { name: 'a.srt', kind: 'file' }];
    assert.deepStrictEqual(RailPage.filterEntries(es, {}).map((e) => e.name), ['..', 'sub', 'A.mp4'], 'Playable formats: videos and folders');
    assert.deepStrictEqual(RailPage.filterEntries(es, { playable: false }).map((e) => e.name), ['..', 'sub', 'A.mp4', 'a.srt']);
    assert.deepStrictEqual(RailPage.filterEntries(es, { q: ' a.', playable: false }).map((e) => e.name), ['A.mp4', 'a.srt'], 'filter: case-insensitive, no .. while filtering');
    assert.strictEqual(RailPage.colText({ kind: 'video' }, { duration: 18 }, 'duration'), '0:18');
    assert.strictEqual(RailPage.colText({ kind: 'dir' }, { mtime: now }, 'size'), '');
    assert.strictEqual(RailPage.colText({ kind: 'file' }, {}, 'duration'), '');
    assert.strictEqual(RailPage.colText({ kind: 'video' }, {}, 'none'), '');
    assert.strictEqual(RailPage.posText(1, 5), '2/5');
    assert.strictEqual(RailPage.posText(-1, 5), '');
    assert.ok(RailPage.capsuleShown(0, 2) && !RailPage.capsuleShown(0, 1) && !RailPage.capsuleShown(-1, 4), 'capsule: 2+ videos and the file is one of them');
    assert.strictEqual(RailPage.clampWidth(100), 176);
    assert.strictEqual(RailPage.clampWidth('abc'), 218);
    const edge = { x: 990, right: 1000, open: false, buttons: 0, overScopes: false, panning: false, idle: false };
    assert.ok(RailPage.nearEdge(edge), 'near the right edge');
    assert.ok(!RailPage.nearEdge({ ...edge, x: 900 }), 'not in the middle');
    for (const k of ['open', 'overScopes', 'panning', 'idle']) assert.ok(!RailPage.nearEdge({ ...edge, [k]: true }), `not while ${k}`);
    assert.ok(!RailPage.nearEdge({ ...edge, buttons: 1 }), 'not during a drag');
  }

  // ---- Autoplay at the end (media/autoplay.js) ----
  {
    const at = (o) => Autoplay.atEnd({ mode: 'off', a: null, b: null, natural: true, ...o });
    assert.deepStrictEqual(at({}), { action: 'stop' });
    assert.deepStrictEqual(at({ mode: 'next' }), { action: 'next' });
    assert.deepStrictEqual(at({ mode: 'next', natural: false }), { action: 'stop' }, 'a seek to the end does not advance');
    assert.deepStrictEqual(at({ mode: 'next', hidden: true }), { action: 'stop' }, 'not while hidden');
    assert.deepStrictEqual(at({ mode: 'next', file: false }), { action: 'stop' }, 'a URL has no folder');
    assert.deepStrictEqual(at({ mode: 'next', a: 2 }), { action: 'ab', to: 2 }, 'an A–B range wins');
    assert.deepStrictEqual(at({ mode: 'loop', b: 5 }), { action: 'ab', to: 0 }, 'only B: back to the start');
    assert.strictEqual(Autoplay.toggleLoop('off'), 'loop');
    assert.strictEqual(Autoplay.toggleLoop('loop'), 'off');
    assert.strictEqual(Autoplay.toggleLoop('next'), 'loop', 'R from Play next in folder: Loop');
    assert.ok(Autoplay.engineLoops('loop', false) && !Autoplay.engineLoops('loop', true) && !Autoplay.engineLoops('next', false));
    assert.ok(Autoplay.natural({ playing: true, ran: 1 }) && !Autoplay.natural({ playing: true, ran: 0.1 }) && !Autoplay.natural({ playing: true, ran: 5, hidden: true }));
    assert.strictEqual(Autoplay.label('next'), 'Play next in folder');
    assert.strictEqual(Autoplay.parse('weird'), 'off');
  }

  // ---- markup: no file names in the static HTML; the capsule only for a file of a folder ----
  {
    const html = folderRailHtml();
    for (const id of ['rail', 'railEdge', 'railOpenTab', 'railFoldTab', 'railClose', 'railFilter', 'railPlayable', 'railColBtn', 'railList', 'railEndBtn', 'railPos', 'railColMenu', 'railEndMenu', 'railHover']) {
      assert.match(html, new RegExp(`id="${id}"`), id);
    }
    assert.doesNotMatch(html, /<input[^>]*type="checkbox"/, 'no raw checkbox');
    assert.doesNotMatch(html, /\.(mp4|mkv|mov)\b/, 'no file names');
    assert.doesNotMatch(html, /modePreview|Preview view/, 'no Preview mode in phase 1');
    assert.match(html, /stroke-width="1.6"/);
    assert.match(barHtml({ folder: true }), /<div id="folderCap"[^>]*hidden>[\s\S]*id="capPrev"[\s\S]*id="capCount"[\s\S]*id="capNext"[\s\S]*<\/div>\s*<button id="startCompareBtn"/, 'capsule right before Compare');
    assert.doesNotMatch(barHtml({}), /folderCap/, 'not for URLs and image sequences');
    const input = (folder) => ({ cspSource: 'c', uri: (...p) => p.join('/'), base: 'b', loader: 'l.js', nonce: 'n', cfg: {}, sequence: false, transport: 'message', debug: false, folder });
    const page = unifiedHtml(input(true));
    assert.match(page, /<div id="main">\s*<div id="stage"/, 'the stage sits in #main');
    assert.match(page, /<aside id="rail"/);
    assert.ok(page.indexOf('autoplay.js') < page.indexOf('player-ui.js') && page.indexOf('folder-rail.js') < page.indexOf('player-ui.js'));
    assert.doesNotMatch(unifiedHtml(input(false)), /<aside id="rail"/, 'no rail for URLs and sequences');
  }

  // ---- src/extension.js + src/unified-viewer.js: the rail of a viewer; folder navigation in place ----
  {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'vpe_rail_'));
    const dir = fs.mkdirSync(path.join(temp, 'media'), { recursive: true });
    for (const n of ['a 1.mp4', 'a 2.mkv', 'a 10.mov', 'readme.txt']) fs.writeFileSync(path.join(dir, n), Buffer.alloc(64));
    fs.mkdirSync(path.join(dir, 'more'));
    fs.writeFileSync(path.join(dir, 'more', 'deep.mp4'), Buffer.alloc(64));
    try {
      const h = load({ settings: { 'videoPreviewEnhanced.decoder': 'builtin' } });
      const opens = () => (h.vscode.executed || []).filter((x) => x[0] === 'vscode.openWith');
      const B = h.open(path.join(dir, 'a 2.mkv'));
      await B.send({ type: 'ready' });
      const cfgB = webviewConfig(B.panel.webview);
      assert.ok(cfgB.rail && cfgB.rail.layout === 'dock' && cfgB.rail.width === 218 && !cfgB.rail.open, 'rail closed, docked, 218 px');
      assert.match(B.panel.webview.html, /id="folderCap"/);
      assert.match(B.panel.webview.html, /<div id="main">\s*<div id="stage"/, 'the stage sits in #main');
      assert.match(B.panel.webview.html, /<aside id="rail"/);
      // The page's place in its folder for the bar's capsule, once ready.
      await B.until((ps) => ps.some((m) => m.type === 'rail' && m.op === 'pos'), 3000);
      assert.deepStrictEqual((({ index, count }) => [index, count])(B.posted.find((m) => m.op === 'pos')), [1, 3]);
      // The page opens the rail: the playback folder is listed with the playing file marked.
      await B.send({ type: 'rail', op: 'open' });
      const list = B.posted.find((m) => m.type === 'rail' && m.op === 'list');
      assert.deepStrictEqual(list.entries.map((e) => e.name), ['..', 'more', 'a 1.mp4', 'a 2.mkv', 'a 10.mov', 'readme.txt']);
      assert.strictEqual(list.entries.find((e) => e.id === list.current).name, 'a 2.mkv');
      // Into the subfolder: the browse folder changes, the playback folder does not.
      await B.send({ type: 'rail', op: 'browse', gen: list.gen, id: list.entries.find((e) => e.name === 'more').id });
      const sub = B.posted.filter((m) => m.op === 'list').pop();
      assert.deepStrictEqual(sub.entries.map((e) => e.name), ['..', 'deep.mp4']);
      await B.send({ type: 'rail', op: 'activate', gen: list.gen, id: list.entries[2].id });
      assert.strictEqual(opens().length, 0, 'an id of the old listing does nothing');
      await B.send({ type: 'rail', op: 'activate', gen: sub.gen, id: '/etc/passwd' });
      assert.strictEqual(opens().length, 0, 'a path from the page does nothing');
      // Shift+N: opens the next video of the playback folder in its own tab (tab swap) and closes the source tab.
      let bClosed = false;
      B.panel.onDidDispose(() => { bClosed = true; });
      await B.send({ type: 'neighbour', d: 1, rail: { open: true, width: 260, onEnd: 'next' } });
      assert.strictEqual(opens().length, 1);
      assert.strictEqual(path.basename(opens()[0][1].fsPath), 'a 10.mov', 'natural order: a 2 then a 10');
      assert.strictEqual(bClosed, true, 'source tab closed after tab swap');
      // The new tab takes the handoff (rail state & Autoplay) when VS Code opens it.
      const C = h.open(path.join(dir, 'a 10.mov'));
      await C.send({ type: 'ready' });
      const cfgC = webviewConfig(C.panel.webview);
      assert.deepStrictEqual(cfgC.railCarry, { open: true, width: 260, filter: '', onEnd: 'next' }, 'rail state carried over');
      // At the last video: it stays, and says so.
      await C.send({ type: 'neighbour', d: 1 });
      assert.strictEqual(opens().length, 1, 'a 10.mov is the last video: no advance');
      assert.ok(C.posted.some((m) => m.type === 'toast' && /Last video/.test(m.text)));
      // A row of the browsed folder opens via tab swap too (first test Compare folder on a fresh tab before closing).
      const toUriPath = (u) => (process.platform === 'win32' ? u.path.replace(/^\//, '') : u.path);
      h.vscode.workspace.fs.stat = async (u) => ({ type: fs.statSync(toUriPath(u)).isDirectory() ? 2 : 1 });
      h.vscode.workspace.fs.readDirectory = async (u) => fs.readdirSync(toUriPath(u), { withFileTypes: true }).map((d) => [d.name, d.isDirectory() ? 2 : 1]);
      await C.send({ type: 'rail', op: 'open' });
      const relisted = C.posted.filter((m) => m.op === 'list').pop();
      const up = relisted.entries.find((e) => e.name === '..');
      await C.send({ type: 'rail', op: 'browse', gen: relisted.gen, id: up.id });
      const top = C.posted.filter((m) => m.op === 'list').pop();
      const more = top.entries.find((e) => e.name === 'more');
      await C.send({ type: 'rail', op: 'compareFolder', gen: top.gen, id: top.entries.find((e) => e.name === 'a 1.mp4').id });
      await C.send({ type: 'rail', op: 'compareFolder', gen: top.gen - 1, id: more.id });
      await settle(10);
      assert.ok(!C.posted.some((m) => m.type === 'toast' && /fewer than 2|Compare/.test(m.text)), 'a video row or an old listing does nothing');
      await C.send({ type: 'rail', op: 'compareFolder', gen: top.gen, id: more.id });
      await C.until((ps) => ps.some((m) => m.type === 'toast' && /fewer than 2 videos/.test(m.text)), 3000);
      // Shift+P from a 10.mov opens a 2.mkv in its own tab.
      let cClosed = false;
      C.panel.onDidDispose(() => { cClosed = true; });
      await C.send({ type: 'neighbour', d: -1 });
      assert.strictEqual(path.basename(opens().pop()[1].fsPath), 'a 2.mkv', 'Shift+P: back');
      assert.strictEqual(cClosed, true, 'C closed after tab swap');
      h.dispose();
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  }

  // ---- the folder rail of a comparing viewer: the same controller; rows join this comparison ----
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vpe_rail_cmp_'));
    for (const n of ['a 1.mp4', 'a 2.mkv', 'a 3.webm', 'a 10.mov']) fs.writeFileSync(path.join(dir, n), Buffer.alloc(64));
    fs.mkdirSync(path.join(dir, 'more'));
    for (const n of ['deep 1.mp4', 'deep 2.mp4']) fs.writeFileSync(path.join(dir, 'more', n), Buffer.alloc(64));
    try {
      const h = load({ settings: { 'videoPreviewEnhanced.decoder': 'builtin', 'videoPreviewEnhanced.compare.maxVideos': 5 } });
      h.vscode.workspace.fs.stat = async (u) => ({ type: fs.statSync(u.fsPath).isDirectory() ? 2 : 1 });
      h.vscode.workspace.fs.readDirectory = async (u) => fs.readdirSync(u.fsPath, { withFileTypes: true }).map((d) => [d.name, d.isDirectory() ? 2 : 1]);
      const p = h.nextPanel();
      const files = ['a 1.mp4', 'a 2.mkv'].map((n) => h.vscode.Uri.file(path.join(dir, n)));
      const v = await h.vscode._commands['videoPreviewEnhanced.compare'](null, files);
      await p.send({ type: 'ready' });
      const names = () => v.session.clips.map((c) => c.label);
      assert.ok(p.cfg().rail && p.cfg().rail.layout === 'dock', 'a comparing viewer gets the rail, docked by default');
      assert.match(p.panel.webview.html, /<div id="main">\s*<div id="stage"[\s\S]*<aside id="rail"/, '#main holds the stage and the rail');
      const rail = (m) => p.send({ type: 'rail', ...m });
      const lists = () => p.posted.filter((m) => m.type === 'rail' && m.op === 'list');
      await rail({ op: 'open' });
      let list = lists().pop();
      assert.strictEqual(list.crumb.split(' / ').pop(), path.basename(dir), "the first video's folder");
      const id = (n, l = list) => l.entries.find((e) => e.name === n).id;
      assert.deepStrictEqual(list.members.sort(), [id('a 1.mp4'), id('a 2.mkv')].sort(), 'both compared videos are marked');
      assert.strictEqual(list.count, 2);
      assert.ok(!list.current, 'no single playing row in a comparison');
      // A video row joins the comparison (in the same page); clicking it again removes it.
      await rail({ op: 'activate', gen: list.gen, id: id('a 10.mov') });
      assert.deepStrictEqual(names(), ['a 1.mp4', 'a 2.mkv', 'a 10.mov']);
      // The marks follow: the added video is marked too.
      const marks = p.posted.filter((m) => m.type === 'rail' && m.op === 'members').pop();
      assert.ok(marks && marks.ids.includes(id('a 10.mov')) && marks.count === 3, 'members after an add');
      await rail({ op: 'activate', gen: list.gen, id: id('a 10.mov') });
      assert.deepStrictEqual(names(), ['a 1.mp4', 'a 2.mkv'], 'clicking a member again removes it');
      await rail({ op: 'activate', gen: list.gen, id: id('a 10.mov') });
      assert.deepStrictEqual(names(), ['a 1.mp4', 'a 2.mkv', 'a 10.mov']);
      // A folder row: its videos join (no duplicates), up to compare.maxVideos (5 here).
      await rail({ op: 'compareFolder', gen: list.gen, id: id('more') });
      await p.until(() => names().length === 5, 3000);
      assert.deepStrictEqual(names(), ['a 1.mp4', 'a 2.mkv', 'a 10.mov', 'deep 1.mp4', 'deep 2.mp4']);
      assert.ok(p.posted.some((m) => m.type === 'toast' && /^Added 2 from more to Compare/.test(m.text)));
      // Full: a toast, nothing added.
      await rail({ op: 'activate', gen: list.gen, id: id('a 3.webm') });
      assert.strictEqual(v.session.clips.length, 5);
      assert.ok(p.posted.some((m) => m.type === 'toast' && /Compare is full \(5 videos\)/.test(m.text)));
      // Stale ids and paths do nothing.
      await rail({ op: 'activate', gen: list.gen - 1, id: id('a 3.webm') });
      await rail({ op: 'activate', gen: list.gen, id: path.join(dir, 'a 3.webm') });
      assert.strictEqual(v.session.clips.length, 5);
      p.panel.dispose();
      h.dispose();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  console.log('folder rail: ok');
})().catch((e) => { console.error(e); process.exit(1); });
