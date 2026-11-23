'use strict';
// node test/host/gc_worktrees_test.js: tools/gc-worktrees.js. Pure decisions first, then real temporary git repos
// covering merged / unmerged / dirty / detached / submodule worktrees, tag-vs-branch ambiguity, --base HEAD from
// linked worktrees, primary-HEAD / upstream branch -d refusals, revalidation on concurrent changes, and dry-run/--apply.
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

  // NUL-delimited porcelain preserves newlines inside POSIX paths.
  const zWts = gc.parseWorktrees(
    'worktree /r\0HEAD aaa\0branch refs/heads/main\0\0worktree /r/line\nbreak\0HEAD bbb\0branch refs/heads/f\0\0'
  );
  assert.strictEqual(zWts.length, 2);
  assert.strictEqual(zWts[1].path, '/r/line\nbreak');

  assert.ok(gc.isInside('/r/w/sub', '/r/w', 'linux') && !gc.isInside('/r/wx', '/r/w', 'linux'));
  assert.ok(gc.isInside('C:\\R\\W', 'c:/r/w', 'win32'), 'Windows paths compare case-insensitively');

  const ctx = {
    primary: '/r', cwd: '/elsewhere', cwdGitDir: '/r/.git', base: 'main', baseBranch: 'main',
    merged: () => true, dirty: () => false, hasSubmodule: () => false, exists: () => true, platform: 'linux',
  };
  const wt = (o) => ({
    path: '/r-w', head: 'h', branch: 'feat', detached: false, bare: false, locked: false, prunable: false,
    gitDir: '/r/.git/worktrees/r-w', ...o,
  });
  const why = (o, c = {}) => gc.classifyWorktree(wt(o), { ...ctx, ...c });
  assert.deepStrictEqual(why({}), { action: 'remove', reason: 'merged into main' });
  assert.match(why({ path: '/r' }).reason, /primary/);
  assert.match(why({}, { cwd: '/r-w/deep' }).reason, /active/);
  // Matching canonical gitDir protects the active worktree even when path spellings differ (junctions/symlinks).
  assert.match(why({ gitDir: '/r/.git/worktrees/r-w' }, { cwd: '/junction/alias', cwdGitDir: '/r/.git/worktrees/r-w' }).reason, /active/);
  assert.match(why({ branch: 'main' }).reason, /base branch/);
  assert.match(why({ locked: true }).reason, /locked/);
  assert.match(why({ prunable: true }).reason, /prunable/);
  assert.match(why({}, { exists: () => false }).reason, /missing/);
  assert.match(why({ detached: true, branch: null }).reason, /detached/);
  assert.match(why({}, { merged: () => false }).reason, /not merged/);
  assert.match(why({}, { hasSubmodule: () => true }).reason, /submodule/);
  assert.match(why({}, { dirty: () => true }).reason, /changes/);
  // Dirty is never even asked for work that is not merged.
  let asked = false;
  why({}, { merged: () => false, dirty: () => { asked = true; return false; } });
  assert.strictEqual(asked, false);

  const bctx = { base: 'main', baseBranch: 'main', merged: () => true, keptBranches: new Set(['kept']) };
  assert.strictEqual(gc.classifyBranch('main', 'x', bctx).action, 'skip');
  assert.match(gc.classifyBranch('kept', 'x', bctx).reason, /stays/);
  assert.strictEqual(gc.classifyBranch('gone', 'x', bctx).action, 'remove');
  assert.strictEqual(gc.classifyBranch('solo', 'x', bctx).action, 'remove');
  assert.match(gc.classifyBranch('solo', 'x', { ...bctx, merged: () => false }).reason, /not merged/);
  assert.match(gc.classifyBranch('solo', 'x', { ...bctx, safeDeleteBlocked: () => 'not merged into upstream' }).reason, /upstream/);

  assert.deepStrictEqual(gc.parseArgs(['--apply', '--base', 'dev', '--json']), {
    apply: true, base: 'dev', baseExplicit: true, json: true, help: false, error: '',
  });
  assert.strictEqual(gc.parseArgs([]).baseExplicit, false);
  assert.ok(gc.parseArgs(['--base']).error && gc.parseArgs(['--nope']).error);
  // --help paired with an unknown flag must still fail with usage error (exit 2).
  const badHelp = run(process.cwd(), ['--help', '--unknown']);
  assert.strictEqual(badHelp.code, 2);
}

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function run(cwd, argv) {
  const io = { cwd, out: [], err: [] };
  const code = gc.main(argv, { cwd, out: (t) => io.out.push(t), err: (t) => io.err.push(t) });
  return { code, text: io.out.join('\n'), err: io.err.join('\n') };
}

function makeRepo(root, name = 'repo') {
  const repo = path.join(root, name);
  fs.mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'you@example.com');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'commit.gpgsign', 'false');
  return repo;
}

function commit(cwd, file, msg) {
  fs.writeFileSync(path.join(cwd, file), msg);
  git(cwd, 'add', file);
  git(cwd, 'commit', '-q', '-m', msg);
}

function real() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vpe-gcwt-'));
  try {
    const repo = makeRepo(root, 'repo');
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
    assert.deepStrictEqual(j.errors, []);
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
    const left = git(repo, 'for-each-ref', '--format=%(refname:strip=2)', 'refs/heads').split(/\r?\n/).sort();
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

function edgeCases() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vpe-gcwt-edge-'));
  try {
    const repo = makeRepo(root, 'repo');
    commit(repo, 'a.txt', 'a');

    // 1. Tag + branch collision: tag `topic`, merged branch `topic`, unmerged branch literally named `heads/topic`.
    git(repo, 'branch', 'topic', 'main');
    git(repo, 'tag', 'topic', 'main');
    git(repo, 'checkout', '-q', '-b', 'heads/topic');
    commit(repo, 'ht.txt', 'ht');
    git(repo, 'checkout', '-q', 'main');
    // Tag `main` pointing elsewhere must not hijack default refs/heads/main.
    git(repo, 'tag', 'main', 'heads/topic');

    const amb = run(repo, ['--apply', '--json']);
    assert.strictEqual(amb.code, 0, amb.err);
    const branchesAfterAmb = git(repo, 'for-each-ref', '--format=%(refname:strip=2)', 'refs/heads').split(/\r?\n/).sort();
    assert.deepStrictEqual(branchesAfterAmb, ['heads/topic', 'main'], 'deletes topic, preserves unmerged heads/topic');

    // 2. --base HEAD from a linked worktree resolves HEAD in the invoking worktree, not primary.
    // Primary is on `main` (commit B); linked worktree `w-base` is on `base-wt` (commit A).
    commit(repo, 'b.txt', 'b');
    const commitA = git(repo, 'rev-parse', 'HEAD~1');
    const mainTip = git(repo, 'rev-parse', 'refs/heads/main');
    git(repo, 'branch', 'at-b', mainTip); // merged into primary HEAD (B), NOT into commit A!
    git(repo, 'worktree', 'add', '-q', '-b', 'base-wt', path.join(root, 'w-base'), commitA);

    const fromLinked = run(path.join(root, 'w-base'), ['--base', 'HEAD', '--json']);
    assert.strictEqual(fromLinked.code, 0, fromLinked.err);
    const lj = JSON.parse(fromLinked.text);
    assert.strictEqual(lj.baseCommit, commitA);
    const atB = lj.branches.find((b) => b.name === 'at-b');
    assert.strictEqual(atB.action, 'skip', 'at-b is NOT an ancestor of linked worktree HEAD');
    assert.match(atB.reason, /not merged/);

    // 3. Dry-run predicts `git branch -d` refusal when primary HEAD does not contain a branch merged into --base.
    // Here primary is on `main` (B), while `heads/topic` is ahead of A on a side branch; create `side-child` at `heads/topic`.
    git(repo, 'branch', 'side-child', 'heads/topic');
    const predictRefuse = run(repo, ['--base', 'heads/topic', '--json']);
    assert.strictEqual(predictRefuse.code, 0, predictRefuse.err);
    const prj = JSON.parse(predictRefuse.text);
    const sc = prj.branches.find((b) => b.name === 'side-child');
    assert.strictEqual(sc.action, 'skip');
    assert.match(sc.reason, /primary HEAD/);

    // 4. Revalidation in apply(): if a planned branch advances or a worktree becomes dirty after plan(),
    // apply() refuses to delete them and returns partial failure (exit code 1 equivalent via results).
    git(repo, 'worktree', 'add', '-q', '-b', 'race-wt', path.join(root, 'w-race'), mainTip);
    git(repo, 'branch', 'race-br', mainTip);
    const p = gc.plan({ cwd: repo, base: 'main', baseExplicit: false });
    assert.strictEqual(p.worktrees.find((w) => w.branch === 'race-wt').action, 'remove');
    assert.strictEqual(p.branches.find((b) => b.name === 'race-br').action, 'remove');
    // Mutate after plan: dirty the worktree and advance the branch tip.
    fs.writeFileSync(path.join(root, 'w-race', 'late.txt'), 'unsaved');
    git(repo, 'branch', '-f', 'race-br', 'heads/topic');
    const res = gc.apply(p);
    assert.ok(res.some((r) => r.kind === 'worktree' && r.label.includes('w-race') && !r.ok), 'dirty worktree refused');
    assert.ok(res.some((r) => r.kind === 'branch' && r.label === 'race-wt' && !r.ok), 'branch kept when worktree removal failed');
    assert.ok(res.some((r) => r.kind === 'branch' && r.label === 'race-br' && !r.ok), 'advanced branch refused');
    assert.ok(fs.existsSync(path.join(root, 'w-race', 'late.txt')), 'late untracked file preserved');
    assert.strictEqual(git(repo, 'rev-parse', 'refs/heads/race-br'), git(repo, 'rev-parse', 'refs/heads/heads/topic'));

    // 5. isAncestor distinguishes exit 1 (false) from git command errors (throws).
    assert.strictEqual(gc.isAncestor(repo, commitA, mainTip), true);
    assert.strictEqual(gc.isAncestor(repo, mainTip, commitA), false);
    assert.throws(() => gc.isAncestor(repo, '0000000000000000000000000000000000000000', mainTip));

    // 6. --base heads/release preserves local branch identity so neither `release` nor its worktree is deleted.
    git(repo, 'worktree', 'add', '-q', '-b', 'release', path.join(root, 'w-release'), mainTip);
    const byHeads = run(repo, ['--base', 'heads/release', '--json']);
    assert.strictEqual(byHeads.code, 0, byHeads.err);
    const bhj = JSON.parse(byHeads.text);
    const relWt = bhj.worktrees.find((w) => w.branch === 'release');
    const relBr = bhj.branches.find((b) => b.name === 'release');
    assert.strictEqual(relWt.action, 'skip');
    assert.match(relWt.reason, /base branch/);
    assert.strictEqual(relBr.action, 'skip');
    assert.match(relBr.reason, /base branch/);

    // 7. An in-progress rebase protects its original branch and every queued branch update.
    git(repo, 'worktree', 'add', '-q', '-b', 'rebasing', path.join(root, 'w-rebase'), mainTip);
    const rebaseDir = path.join(root, 'w-rebase');
    const rebaseGitDir = path.resolve(rebaseDir, git(rebaseDir, 'rev-parse', '--git-dir'));
    git(rebaseDir, 'checkout', '-q', '--detach', mainTip);
    fs.mkdirSync(path.join(rebaseGitDir, 'rebase-merge'), { recursive: true });
    fs.writeFileSync(path.join(rebaseGitDir, 'rebase-merge', 'head-name'), 'refs/heads/rebasing\n');
    const queued = ['queued-one', 'topic/queued-two'];
    for (const branch of queued) git(repo, 'branch', branch, mainTip);
    fs.writeFileSync(path.join(rebaseGitDir, 'rebase-merge', 'update-refs'),
      queued.map((branch) => `refs/heads/${branch}\n${mainTip}\n${'0'.repeat(mainTip.length)}\n`).join(''));
    const rebPlan = gc.plan({ cwd: repo, base: 'main' });
    assert.deepStrictEqual(rebPlan.errors, []);
    for (const branch of ['rebasing', ...queued]) {
      assert.strictEqual(rebPlan.branches.find((b) => b.name === branch).action, 'skip', branch);
    }
    const applied = run(repo, ['--apply', '--json']);
    assert.strictEqual(applied.code, 0, applied.err || applied.text);
    for (const branch of ['rebasing', ...queued]) {
      assert.strictEqual(git(repo, 'rev-parse', `refs/heads/${branch}`), mainTip);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
}

function activeBisect() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vpe-gcwt-bisect-'));
  try {
    const repo = makeRepo(root);
    commit(repo, 'a.txt', 'a');
    const checkout = path.join(root, 'w-bisect');
    git(repo, 'worktree', 'add', '-q', '-b', 'bisecting', checkout);
    const before = gc.plan({ cwd: repo, base: 'main' });
    assert.strictEqual(before.worktrees.find((w) => w.branch === 'bisecting').action, 'remove');
    assert.strictEqual(before.branches.find((b) => b.name === 'bisecting').action, 'remove');

    git(checkout, 'bisect', 'start', '--no-checkout');
    assert.strictEqual(git(checkout, 'symbolic-ref', 'HEAD'), 'refs/heads/bisecting');
    assert.strictEqual(git(checkout, 'status', '--porcelain'), '');

    const during = gc.plan({ cwd: repo, base: 'main' });
    assert.deepStrictEqual(during.errors, []);
    const worktree = during.worktrees.find((w) => w.branch === 'bisecting');
    assert.strictEqual(worktree.action, 'skip');
    assert.match(worktree.reason, /BISECT_START/);
    assert.strictEqual(during.branches.find((b) => b.name === 'bisecting').action, 'skip');

    const results = gc.apply(before);
    assert.deepStrictEqual(results.map((r) => [r.kind, r.ok]), [['worktree', false], ['branch', false]]);
    assert.match(results[0].error, /BISECT_START/);
    assert.strictEqual(git(checkout, 'symbolic-ref', 'HEAD'), 'refs/heads/bisecting');
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
}

pure();
real();
edgeCases();
activeBisect();
console.log('gc-worktrees ok');
