'use strict';
// node test/host/gc_worktrees_test.js: tools/gc-worktrees.js. Pure decisions first, then a real temporary repo
// with merged / unmerged / dirty / detached worktrees and standalone branches, dry run and --apply.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const gc = require('../../tools/gc-worktrees');

function pure() {
  const wts = gc.parseWorktrees([
    'worktree /r', 'HEAD aaa', 'branch refs/heads/main', '',
    'worktree /r-w', 'HEAD bbb', 'branch refs/heads/feat/x', 'locked reason here', '',
    'worktree /r-d', 'HEAD ccc', 'detached', 'prunable gitdir file points to non-existent location', '',
  ].join('\n'));
  assert.deepStrictEqual(wts.map((w) => [w.path, w.branch, w.locked, w.detached, w.prunable]), [
    ['/r', 'main', false, false, false], ['/r-w', 'feat/x', true, false, false], ['/r-d', null, false, true, true],
  ]);
  assert.ok(gc.isInside('/r/w/sub', '/r/w', 'linux') && !gc.isInside('/r/wx', '/r/w', 'linux'));
  assert.ok(gc.isInside('C:\\R\\W', 'c:/r/w', 'win32'), 'Windows paths compare case-insensitively');

  const ctx = { primary: '/r', cwd: '/elsewhere', base: 'main', merged: () => true, dirty: () => false, exists: () => true, platform: 'linux' };
  const wt = (o) => ({ path: '/r-w', head: 'h', branch: 'feat', detached: false, bare: false, locked: false, prunable: false, ...o });
  const why = (o, c = {}) => gc.classifyWorktree(wt(o), { ...ctx, ...c });
  assert.deepStrictEqual(why({}), { action: 'remove', reason: 'merged into main' });
  assert.match(why({ path: '/r' }).reason, /primary/);
  assert.match(why({}, { cwd: '/r-w/deep' }).reason, /active/);
  assert.match(why({ branch: 'main' }).reason, /base branch/);
  assert.match(why({ locked: true }).reason, /locked/);
  assert.match(why({ prunable: true }).reason, /prunable/);
  assert.match(why({}, { exists: () => false }).reason, /missing/);
  assert.match(why({ detached: true, branch: null }).reason, /detached/);
  assert.match(why({}, { merged: () => false }).reason, /not merged/);
  assert.match(why({}, { dirty: () => true }).reason, /changes/);
  // Dirty is never even asked for work that is not merged.
  let asked = false;
  why({}, { merged: () => false, dirty: () => { asked = true; return false; } });
  assert.strictEqual(asked, false);

  const bctx = { base: 'main', merged: () => true, checkedOut: new Set(['kept', 'gone']), removedWith: new Set(['gone']) };
  assert.strictEqual(gc.classifyBranch('main', 'x', bctx).action, 'skip');
  assert.match(gc.classifyBranch('kept', 'x', bctx).reason, /stays/);
  assert.strictEqual(gc.classifyBranch('gone', 'x', bctx).action, 'remove');
  assert.strictEqual(gc.classifyBranch('solo', 'x', bctx).action, 'remove');
  assert.match(gc.classifyBranch('solo', 'x', { ...bctx, merged: () => false }).reason, /not merged/);

  assert.deepStrictEqual(gc.parseArgs(['--apply', '--base', 'dev', '--json']), { apply: true, base: 'dev', json: true, help: false, error: '' });
  assert.ok(gc.parseArgs(['--base']).error && gc.parseArgs(['--nope']).error);
}

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function run(cwd, argv) {
  const io = { cwd, out: [], err: [] };
  const code = gc.main(argv, { cwd, out: (t) => io.out.push(t), err: (t) => io.err.push(t) });
  return { code, text: io.out.join('\n'), err: io.err.join('\n') };
}

function real() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vpe-gcwt-'));
  try {
    const repo = path.join(root, 'repo');
    fs.mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 'you@example.com');
    git(repo, 'config', 'user.name', 'Test');
    git(repo, 'config', 'commit.gpgsign', 'false');
    const commit = (cwd, file, msg) => { fs.writeFileSync(path.join(cwd, file), msg); git(cwd, 'add', file); git(cwd, 'commit', '-q', '-m', msg); };
    commit(repo, 'a.txt', 'a');
    const wtPath = (n) => path.join(root, n);
    // Merged worktree: its branch is an ancestor of main once main moves on.
    git(repo, 'worktree', 'add', '-q', '-b', 'merged', wtPath('w-merged'));
    commit(wtPath('w-merged'), 'm.txt', 'm');
    git(repo, 'merge', '-q', '--ff-only', 'merged');
    // Unmerged worktree.
    git(repo, 'worktree', 'add', '-q', '-b', 'unmerged', wtPath('w-unmerged'));
    commit(wtPath('w-unmerged'), 'u.txt', 'u');
    // Merged but dirty (untracked file).
    git(repo, 'worktree', 'add', '-q', '-b', 'dirty', wtPath('w-dirty'));
    fs.writeFileSync(path.join(wtPath('w-dirty'), 'scratch.txt'), 'x');
    // Merged commit, detached HEAD.
    git(repo, 'worktree', 'add', '-q', '--detach', wtPath('w-detached'), 'main');
    // Standalone branches.
    git(repo, 'branch', 'solo-merged', 'main');
    git(repo, 'branch', 'solo-unmerged', 'unmerged');

    const find = (r, kind, key, val) => JSON.parse(r.text)[kind].find((x) => x[key] === val);
    const dry = run(repo, ['--json']);
    assert.strictEqual(dry.code, 0, dry.err);
    const j = JSON.parse(dry.text);
    assert.strictEqual(j.applied, false);
    const wAction = (n) => j.worktrees.find((w) => w.path.replace(/\\/g, '/').endsWith(`/${n}`)).action;
    assert.deepStrictEqual(['w-merged', 'w-unmerged', 'w-dirty', 'w-detached'].map(wAction), ['remove', 'skip', 'skip', 'skip']);
    assert.strictEqual(j.worktrees[0].action, 'skip', 'primary');
    assert.match(j.worktrees[0].reason, /primary/);
    // The dirty worktree's branch is merged, but it stays checked out: it must not be planned for deletion.
    assert.deepStrictEqual(j.branches.map((b) => `${b.name}:${b.action}`).sort(), [
      'dirty:skip', 'main:skip', 'merged:remove', 'solo-merged:remove', 'solo-unmerged:skip', 'unmerged:skip',
    ]);
    assert.ok(fs.existsSync(wtPath('w-merged')), 'dry run removes nothing');
    assert.ok(git(repo, 'branch', '--list', 'merged'), 'dry run keeps branches');
    assert.ok(find(dry, 'worktrees', 'branch', 'dirty').reason.match(/changes/));

    assert.match(find(dry, 'branches', 'name', 'dirty').reason, /stays/);

    // Running from inside a candidate protects it.
    const inside = JSON.parse(run(wtPath('w-merged'), ['--json']).text);
    assert.match(inside.worktrees.find((w) => w.branch === 'merged').reason, /active/);

    const applied = run(repo, ['--apply', '--json']);
    assert.strictEqual(applied.code, 0, applied.err);
    assert.ok(!fs.existsSync(wtPath('w-merged')), 'merged worktree removed');
    for (const n of ['w-unmerged', 'w-dirty', 'w-detached']) assert.ok(fs.existsSync(wtPath(n)), `${n} kept`);
    const left = git(repo, 'branch', '--format=%(refname:short)').split(/\r?\n/).sort();
    assert.deepStrictEqual(left, ['dirty', 'main', 'solo-unmerged', 'unmerged']);
    assert.ok(fs.existsSync(path.join(wtPath('w-dirty'), 'scratch.txt')), 'untracked file untouched');

    // Idempotent, and a text dry run reads sensibly.
    const again = run(repo, []);
    assert.strictEqual(again.code, 0);
    assert.match(again.text, /dry run/);
    assert.strictEqual(run(repo, ['--base', 'no-such-ref']).code, 2);
    assert.strictEqual(run(repo, ['--help']).code, 0);
    assert.strictEqual(run(root, []).code, 2, 'outside a repository');
  } finally {
    // Git marks worktree files read-only on some systems; force only here, in the test's own temp dir.
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
}

pure();
real();
console.log('gc-worktrees ok');
