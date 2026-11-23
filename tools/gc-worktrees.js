#!/usr/bin/env node
'use strict';
// Removes git worktrees and local branches that are already merged into a base ref (default refs/heads/main).
// Dry run unless --apply. Only ever uses the safe forms (`git worktree remove`, `git branch -d`): a worktree
// with changes, initialized submodules, a lock or a detached HEAD is reported and left alone, and nothing is
// force-deleted. Pure decision helpers (classify*, parse*) are checkJs-typed and testable without git.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// checkJs: start
/**
 * @typedef {{path: string, head: string, branch: string|null, detached: boolean, bare: boolean,
 *   locked: boolean, prunable: boolean, gitDir?: string|null, operation?: string}} Worktree
 * @typedef {{action: 'remove'|'skip', reason: string}} Decision
 * @typedef {{primary: string, cwd: string, cwdGitDir?: string|null, base: string, baseBranch: string|null,
 *   merged: (commit: string) => boolean, dirty: (wtPath: string) => boolean,
 *   hasSubmodule?: (wtPath: string) => boolean, exists: (wtPath: string) => boolean,
 *   platform?: string}} WorktreeCtx
 * @typedef {{base: string, baseBranch: string|null, merged: (commit: string) => boolean,
 *   keptBranches: Set<string>, safeDeleteBlocked?: (name: string, commit: string) => string|null}} BranchCtx
 * @typedef {{kind: string, label: string, error: string}} InspectionError
 * @typedef {{path: string, branch: string|null, head: string, action: 'remove'|'skip', reason: string}} PlannedWorktree
 * @typedef {{name: string, commit: string, action: 'remove'|'skip', reason: string}} PlannedBranch
 * @typedef {{primary: string, base: string, baseCommit: string, worktrees: PlannedWorktree[],
 *   branches: PlannedBranch[], errors: InspectionError[]}} Plan
 * @typedef {{kind: 'worktree'|'branch', label: string, ok: boolean, error?: string}} ApplyResult
 */

/**
 * Parses `git worktree list --porcelain` (both `-z` NUL-delimited and newline-delimited).
 * The first entry is always the primary worktree.
 * @param {string} text
 * @returns {Worktree[]}
 */
function parseWorktrees(text) {
  /** @type {string[][]} */
  const blocks = [];
  if (text.includes('\0')) {
    /** @type {string[]} */
    let cur = [];
    for (const token of text.split('\0')) {
      if (token === '') {
        if (cur.length) { blocks.push(cur); cur = []; }
      } else cur.push(token);
    }
    if (cur.length) blocks.push(cur);
  } else {
    for (const block of text.split(/\r?\n\r?\n/)) {
      const lines = block.split(/\r?\n/).filter(Boolean);
      if (lines.length) blocks.push(lines);
    }
  }
  /** @type {Worktree[]} */
  const list = [];
  for (const lines of blocks) {
    /** @type {Worktree|null} */
    let wt = null;
    for (const line of lines) {
      const sp = line.indexOf(' ');
      const key = sp < 0 ? line : line.slice(0, sp);
      if (key === 'worktree') {
        wt = { path: line.slice(sp + 1), head: '', branch: null, detached: false, bare: false, locked: false, prunable: false };
      } else if (!wt) continue;
      else if (key === 'HEAD') wt.head = line.slice(sp + 1);
      else if (key === 'branch') wt.branch = line.slice(sp + 1).replace(/^refs\/heads\//, '');
      else if (key === 'detached') wt.detached = true;
      else if (key === 'bare') wt.bare = true;
      else if (key === 'locked') wt.locked = true;
      else if (key === 'prunable') wt.prunable = true;
    }
    if (wt) list.push(wt);
  }
  return list;
}

/**
 * A path as comparable text: absolute, forward slashes, case-folded on Windows (git prints C:/x, node C:\x).
 * @param {string} p
 * @param {string} [platform]
 * @returns {string}
 */
function norm(p, platform = path.sep === '\\' ? 'win32' : 'linux') {
  const s = path.resolve(p).replace(/\\/g, '/').replace(/\/+$/, '');
  return platform === 'win32' ? s.toLowerCase() : s;
}

/**
 * Is `dir` the worktree root or inside it?
 * @param {string} dir
 * @param {string} root
 * @param {string} [platform]
 * @returns {boolean}
 */
function isInside(dir, root, platform) {
  const d = norm(dir, platform);
  const r = norm(root, platform);
  return d === r || d.startsWith(`${r}/`);
}

/**
 * Decides one worktree. Cheap, absolute protections come first so git calls run only for candidates.
 * @param {Worktree} wt
 * @param {WorktreeCtx} ctx
 * @returns {Decision}
 */
function classifyWorktree(wt, ctx) {
  const platform = ctx.platform;
  /** @type {(reason: string) => Decision} */
  const skip = (reason) => ({ action: 'skip', reason });
  if (norm(wt.path, platform) === norm(ctx.primary, platform)) return skip('primary worktree');
  if (wt.bare) return skip('bare repository');
  if ((ctx.cwdGitDir && wt.gitDir && norm(wt.gitDir, platform) === norm(ctx.cwdGitDir, platform))
    || isInside(ctx.cwd, wt.path, platform)) {
    return skip('active worktree (current directory)');
  }
  if (wt.branch && ctx.baseBranch && wt.branch === ctx.baseBranch) return skip('base branch');
  if (wt.locked) return skip('locked');
  if (wt.prunable || !ctx.exists(wt.path)) return skip('missing or prunable (run git worktree prune)');
  if (wt.detached || !wt.branch) return skip('detached HEAD');
  if (wt.operation) return skip(`Git operation in progress (${wt.operation})`);
  if (!ctx.merged(wt.head)) return skip(`not merged into ${ctx.base}`);
  if (ctx.hasSubmodule && ctx.hasSubmodule(wt.path)) return skip('contains initialized submodule');
  if (ctx.dirty(wt.path)) return skip('has staged, unstaged or untracked changes');
  return { action: 'remove', reason: `merged into ${ctx.base}` };
}

/**
 * Decides one local branch.
 * @param {string} name
 * @param {string} commit
 * @param {BranchCtx} ctx
 * @returns {Decision}
 */
function classifyBranch(name, commit, ctx) {
  /** @type {(reason: string) => Decision} */
  const skip = (reason) => ({ action: 'skip', reason });
  if (ctx.baseBranch && name === ctx.baseBranch) return skip('base branch');
  if (ctx.keptBranches.has(name)) return skip('checked out in a worktree that stays');
  if (!ctx.merged(commit)) return skip(`not merged into ${ctx.base}`);
  const blocked = ctx.safeDeleteBlocked ? ctx.safeDeleteBlocked(name, commit) : null;
  if (blocked) return skip(blocked);
  return { action: 'remove', reason: `merged into ${ctx.base}` };
}

/**
 * Parses CLI arguments.
 * @param {string[]} argv
 */
function parseArgs(argv) {
  const o = { apply: false, base: 'main', baseExplicit: false, json: false, help: false, error: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') o.apply = true;
    else if (a === '--json') o.json = true;
    else if (a === '--help' || a === '-h') o.help = true;
    else if (a === '--base') {
      o.base = argv[++i] || '';
      o.baseExplicit = true;
      if (!o.base || o.base.startsWith('-')) o.error = '--base needs a ref';
    } else o.error = `unknown argument: ${a}`;
  }
  return o;
}

const HELP = `Usage: node tools/gc-worktrees.js [--base <ref>] [--apply] [--json]

Removes worktrees and local branches already merged into <ref> (default: main).
Dry run unless --apply. Never touches the primary or the current worktree, the base
branch, or worktrees that are dirty, locked, detached, missing, have a Git operation
in progress or contain initialized submodules; never force-deletes.
`;

/**
 * Runs git in `cwd` and returns exact exit status and raw stdout/stderr without throwing on non-zero exit.
 * @param {string} cwd
 * @param {string[]} args
 * @returns {{status: number, stdout: string, stderr: string}}
 */
function gitRun(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.error) throw r.error;
  if (r.signal) throw new Error(`git ${args[0]} terminated by signal ${r.signal}`);
  if (typeof r.status !== 'number') throw new Error(`git ${args[0]} exited without status`);
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

/**
 * Runs git in `cwd`; returns trimmed stdout, or throws with git's message.
 * @param {string} cwd
 * @param {string[]} args
 * @returns {string}
 */
function git(cwd, args) {
  const r = gitRun(cwd, args);
  if (r.status !== 0) throw new Error((r.stderr || r.stdout || `git ${args[0]} exited ${r.status}`).trim());
  return r.stdout.trim();
}

/**
 * Resolves symlinks/junctions when the path exists; falls back to path.resolve otherwise.
 * @param {string} p
 * @returns {string}
 */
function realPath(p) {
  try {
    return typeof fs.realpathSync.native === 'function' ? fs.realpathSync.native(p) : fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * Canonical absolute git admin directory for a checkout (handles junctions, symlinks and case differences).
 * @param {string} dir
 * @returns {string}
 */
function gitDirOf(dir) {
  const raw = git(dir, ['rev-parse', '--git-dir']);
  return realPath(path.resolve(dir, raw));
}

/**
 * Returns true iff `commit` is an ancestor of `targetCommit`. Throws on git command errors (exit != 0 and != 1).
 * @param {string} cwd
 * @param {string} commit
 * @param {string} targetCommit
 * @returns {boolean}
 */
function isAncestor(cwd, commit, targetCommit) {
  const r = gitRun(cwd, ['merge-base', '--is-ancestor', commit, targetCommit]);
  if (r.status === 0) return true;
  if (r.status === 1) return false;
  throw new Error((r.stderr || r.stdout || `git merge-base exited ${r.status}`).trim());
}

/**
 * Resolves the base ref once in the invoking worktree so `--base HEAD` and ambiguous tags stay faithful.
 * @param {string} cwd
 * @param {string} base
 * @param {boolean} baseExplicit
 * @returns {{ref: string, commit: string, branch: string|null}}
 */
function resolveBase(cwd, base, baseExplicit) {
  /** @param {string} spec */
  const resolveCommit = (spec) => {
    const r = gitRun(cwd, ['rev-parse', '--verify', '--quiet', `${spec}^{commit}`]);
    return r.status === 0 ? r.stdout.trim() : null;
  };
  if (!baseExplicit) {
    const commit = resolveCommit('refs/heads/main');
    if (!commit) throw new Error('unknown base ref: main');
    return { ref: 'main', commit, branch: 'main' };
  }
  if (base === 'HEAD') {
    const commit = resolveCommit('HEAD');
    if (!commit) throw new Error('unknown base ref: HEAD');
    const sym = gitRun(cwd, ['symbolic-ref', '--quiet', 'HEAD']);
    const refName = sym.status === 0 ? sym.stdout.trim() : '';
    const branch = refName.startsWith('refs/heads/') ? refName.slice('refs/heads/'.length) : null;
    return { ref: 'HEAD', commit, branch };
  }
  if (base.startsWith('refs/heads/')) {
    const commit = resolveCommit(base);
    if (!commit) throw new Error(`unknown base ref: ${base}`);
    return { ref: base, commit, branch: base.slice('refs/heads/'.length) };
  }
  // Prefer a local branch over a same-named tag when both exist.
  const localCommit = resolveCommit(`refs/heads/${base}`);
  if (localCommit) return { ref: base, commit: localCommit, branch: base };
  const anyCommit = resolveCommit(base);
  if (anyCommit) {
    // Preserve local branch identity for shorthands like `heads/release` or `@{-1}`.
    const full = gitRun(cwd, ['rev-parse', '--symbolic-full-name', base]);
    const fullRef = full.status === 0 ? full.stdout.trim() : '';
    const branch = fullRef.startsWith('refs/heads/') ? fullRef.slice('refs/heads/'.length) : null;
    return { ref: base, commit: anyCommit, branch };
  }
  throw new Error(`unknown base ref: ${base}`);
}

/**
 * An attached worktree can be clean during an operation, such as `git bisect start --no-checkout`.
 * @param {string} gitDir
 */
function operationInProgress(gitDir) {
  const markers = [
    'BISECT_START', 'BISECT_LOG', 'BISECT_NAMES', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD',
    'rebase-merge', 'rebase-apply', 'sequencer',
  ];
  return markers.find((marker) => fs.lstatSync(path.join(gitDir, marker), { throwIfNoEntry: false }));
}

/**
 * Finds branches reserved by a rebase or bisect, including those omitted by `git worktree list`.
 * @param {string} gitDir
 */
function inProgressBranches(gitDir) {
  const heads = 'refs/heads/';
  const branches = new Set();
  for (const rel of ['rebase-merge/head-name', 'rebase-apply/head-name', 'rebase-merge/update-refs']) {
    const p = path.join(gitDir, rel);
    if (!fs.statSync(p, { throwIfNoEntry: false })) continue;
    // Git stores each update-refs entry as a refname followed by two object IDs on separate lines.
    for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
      if (line.startsWith(heads)) branches.add(line.slice(heads.length));
    }
  }
  const bisect = path.join(gitDir, 'BISECT_START');
  if (fs.statSync(bisect, { throwIfNoEntry: false })) {
    const raw = fs.readFileSync(bisect, 'utf8').trim();
    if (raw && !raw.startsWith('refs/')) branches.add(raw);
    if (raw.startsWith(heads)) branches.add(raw.slice(heads.length));
  }
  return branches;
}

/**
 * True when a worktree has any initialized submodule (gitlink with a `.git` file/dir inside it).
 * Ordinary `git worktree remove` refuses such worktrees without `--force`.
 * @param {string} wtPath
 * @returns {boolean}
 */
function hasInitializedSubmodule(wtPath) {
  const r = gitRun(wtPath, ['ls-files', '--stage', '-z']);
  if (r.status !== 0) throw new Error((r.stderr || `git ls-files exited ${r.status}`).trim());
  for (const entry of r.stdout.split('\0')) {
    if (!entry.startsWith('160000 ')) continue;
    const tab = entry.indexOf('\t');
    if (tab < 0) continue;
    const subPath = entry.slice(tab + 1);
    if (fs.existsSync(path.join(wtPath, subPath, '.git'))) return true;
  }
  return false;
}

/**
 * True when a worktree has staged, unstaged, untracked or submodule changes (ignoring submodule ignore rules).
 * @param {string} wtPath
 * @returns {boolean}
 */
function isDirtyWorktree(wtPath) {
  const r = gitRun(wtPath, ['status', '--porcelain', '--untracked-files=all', '--ignore-submodules=none']);
  if (r.status !== 0) throw new Error((r.stderr || `git status exited ${r.status}`).trim());
  return r.stdout.trim() !== '';
}

/**
 * Builds the plan: what would be removed, what is skipped (with the reason), and any inspection errors. Reads only.
 * @param {{cwd: string, base: string, baseExplicit?: boolean}} opts
 * @returns {Plan}
 */
function plan({ cwd, base, baseExplicit = base !== 'main' }) {
  const wtOut = gitRun(cwd, ['worktree', 'list', '--porcelain', '-z']);
  if (wtOut.status !== 0) throw new Error('not a git repository');
  const worktrees = parseWorktrees(wtOut.stdout);
  if (!worktrees.length) throw new Error('not a git repository');

  const baseInfo = resolveBase(cwd, base, baseExplicit);
  const primary = worktrees[0].path;
  const cwdReal = realPath(cwd);
  const cwdGitDir = gitDirOf(cwd);

  const primaryHeadRes = gitRun(primary, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
  const primaryHead = primaryHeadRes.status === 0 ? primaryHeadRes.stdout.trim() : null;

  /** @type {InspectionError[]} */
  const errors = [];
  /** @type {(commit: string) => boolean} */
  const merged = (commit) => isAncestor(primary, commit, baseInfo.commit);

  /** @type {WorktreeCtx} */
  const ctx = {
    primary,
    cwd: cwdReal,
    cwdGitDir,
    base: baseInfo.ref,
    baseBranch: baseInfo.branch,
    merged,
    dirty: isDirtyWorktree,
    hasSubmodule: hasInitializedSubmodule,
    exists: (p) => fs.existsSync(p),
  };

  /** @type {PlannedWorktree[]} */
  const plannedWorktrees = [];
  /** @type {Set<string>} */
  const keptBranches = new Set();

  for (const wt of worktrees) {
    const wtCopy = { ...wt, path: wt.path };
    /** @type {Decision} */
    let d;
    try {
      if (ctx.exists(wt.path)) {
        wtCopy.gitDir = gitDirOf(wt.path);
        wtCopy.operation = operationInProgress(wtCopy.gitDir);
        for (const branch of inProgressBranches(wtCopy.gitDir)) keptBranches.add(branch);
      }
      d = classifyWorktree(wtCopy, ctx);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push({ kind: 'worktree', label: wt.path, error: msg });
      d = { action: 'skip', reason: `inspection error: ${msg}` };
    }
    if (d.action === 'skip' && wt.branch) keptBranches.add(wt.branch);
    plannedWorktrees.push({ path: wt.path, branch: wt.branch, head: wt.head, ...d });
  }

  // Also scan registered worktree admin directories directly so locked/offline checkouts (e.g. on a
  // disconnected drive) still reserve their in-progress rebase head-name and update-refs branches.
  try {
    const commonRaw = git(primary, ['rev-parse', '--git-common-dir']);
    const commonDir = path.isAbsolute(commonRaw) ? commonRaw : path.resolve(primary, commonRaw);
    const adminRoot = path.join(commonDir, 'worktrees');
    if (fs.existsSync(adminRoot)) {
      for (const entry of fs.readdirSync(adminRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        for (const branch of inProgressBranches(path.join(adminRoot, entry.name))) keptBranches.add(branch);
      }
    }
  } catch { /* best-effort; accessible checkouts were already scanned above */ }

  // Use %(refname:strip=2) with tab delimiters so local branch names are exact even when a tag shares the name.
  const refsRaw = git(primary, ['for-each-ref', '--format=%(refname:strip=2)%09%(objectname)%09%(upstream)', 'refs/heads']);
  /** @type {PlannedBranch[]} */
  const plannedBranches = [];
  for (const line of refsRaw ? refsRaw.split(/\r?\n/) : []) {
    const [name, commit, upstreamRef = ''] = line.split('\t');
    /** @type {Decision} */
    let d;
    try {
      d = classifyBranch(name, commit, {
        base: baseInfo.ref,
        baseBranch: baseInfo.branch,
        merged,
        keptBranches,
        safeDeleteBlocked: (_name, tip) => {
          // Match git branch -d's check so dry-run doesn't advertise deletions that git branch -d will refuse.
          if (upstreamRef) {
            const up = gitRun(primary, ['rev-parse', '--verify', '--quiet', `${upstreamRef}^{commit}`]);
            if (up.status === 0) {
              if (!isAncestor(primary, tip, up.stdout.trim())) {
                return `not merged into upstream ${upstreamRef.replace(/^refs\/remotes\//, '')} (git branch -d would refuse)`;
              }
              return null;
            }
          }
          if (primaryHead && !isAncestor(primary, tip, primaryHead)) {
            return 'not merged into primary HEAD (git branch -d would refuse)';
          }
          return null;
        },
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push({ kind: 'branch', label: name, error: msg });
      d = { action: 'skip', reason: `inspection error: ${msg}` };
    }
    plannedBranches.push({ name, commit, ...d });
  }

  return { primary, base: baseInfo.ref, baseCommit: baseInfo.commit, worktrees: plannedWorktrees, branches: plannedBranches, errors };
}

/**
 * Applies a plan: revalidates each worktree/branch immediately before removal so concurrent edits are never lost.
 * Worktrees are removed first (a branch cannot be deleted while checked out), then branches.
 * @param {Plan} p
 * @returns {ApplyResult[]}
 */
function apply(p) {
  /** @type {ApplyResult[]} */
  const results = [];
  /** @type {Set<string>} */
  const failedWorktreeBranches = new Set();

  for (const w of p.worktrees) {
    if (w.action !== 'remove') continue;
    try {
      const curHead = git(w.path, ['rev-parse', '--verify', 'HEAD']);
      if (curHead !== w.head) throw new Error('worktree HEAD changed since planning');
      const sym = gitRun(w.path, ['symbolic-ref', '--quiet', 'HEAD']);
      const curBranch = sym.status === 0 ? sym.stdout.trim() : '';
      if (!w.branch || curBranch !== `refs/heads/${w.branch}`) {
        throw new Error('worktree branch changed or detached since planning');
      }
      if (hasInitializedSubmodule(w.path)) throw new Error('worktree now contains an initialized submodule');
      if (isDirtyWorktree(w.path)) throw new Error('worktree became dirty since planning');
      const operation = operationInProgress(gitDirOf(w.path));
      if (operation) throw new Error(`Git operation in progress (${operation})`);
      git(p.primary, ['worktree', 'remove', '--', w.path]);
      results.push({ kind: 'worktree', label: w.path, ok: true });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (w.branch) failedWorktreeBranches.add(w.branch);
      results.push({ kind: 'worktree', label: w.path, ok: false, error: msg });
    }
  }

  for (const b of p.branches) {
    if (b.action !== 'remove') continue;
    if (failedWorktreeBranches.has(b.name)) {
      results.push({ kind: 'branch', label: b.name, ok: false, error: 'worktree removal failed; branch kept' });
      continue;
    }
    try {
      const tip = gitRun(p.primary, ['rev-parse', '--verify', '--quiet', `refs/heads/${b.name}^{commit}`]);
      if (tip.status !== 0 || tip.stdout.trim() !== b.commit) {
        throw new Error('branch tip changed since planning');
      }
      if (!isAncestor(p.primary, b.commit, p.baseCommit)) {
        throw new Error(`branch is no longer merged into ${p.base}`);
      }
      git(p.primary, ['branch', '-d', '--', b.name]);
      results.push({ kind: 'branch', label: b.name, ok: true });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      results.push({ kind: 'branch', label: b.name, ok: false, error: msg });
    }
  }
  return results;
}

/**
 * Formats a plan (and optional apply results) for human-readable output.
 * @param {Plan} p
 * @param {ApplyResult[]|null} results
 * @returns {string}
 */
function format(p, results) {
  const lines = [`Base: ${p.base} (${p.baseCommit.slice(0, 7)})${results ? '' : ' (dry run; use --apply to remove)'}`];
  for (const w of p.worktrees) {
    lines.push(`worktree ${w.action === 'remove' ? 'REMOVE' : 'skip  '} ${w.path} [${w.branch || 'detached'}]: ${w.reason}`);
  }
  for (const b of p.branches) {
    lines.push(`branch   ${b.action === 'remove' ? 'DELETE' : 'skip  '} ${b.name}: ${b.reason}`);
  }
  for (const err of p.errors) lines.push(`ERROR    ${err.kind} ${err.label}: ${err.error}`);
  for (const r of results || []) lines.push(`${r.ok ? 'done  ' : 'FAILED'} ${r.kind} ${r.label}${r.ok ? '' : `: ${r.error}`}`);
  return lines.join('\n');
}

/**
 * CLI body; returns the exit code. io = { cwd, out(text), err(text) } so a test can run it.
 * @param {string[]} argv
 * @param {{cwd: string, out: (text: string) => void, err: (text: string) => void}} io
 * @returns {number}
 */
function main(argv, io) {
  const o = parseArgs(argv);
  if (o.error) { io.err(`${o.error}\n${HELP}`); return 2; }
  if (o.help) { io.out(HELP); return 0; }
  try {
    const p = plan({ cwd: io.cwd, base: o.base, baseExplicit: o.baseExplicit });
    const results = o.apply ? apply(p) : null;
    io.out(o.json ? JSON.stringify({ ...p, applied: !!results, results: results || [] }, null, 2) : format(p, results));
    const failed = p.errors.length > 0 || (!!results && results.some((r) => !r.ok));
    return failed ? 1 : 0;
  } catch (e) {
    io.err(`gc-worktrees: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
}
// checkJs: end

module.exports = { parseWorktrees, classifyWorktree, classifyBranch, parseArgs, isInside, isAncestor, plan, apply, main };

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2), {
    cwd: process.cwd(),
    out: (t) => console.log(t),
    err: (t) => console.error(t),
  });
}
