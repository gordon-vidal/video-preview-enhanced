#!/usr/bin/env node
'use strict';
// Removes git worktrees and local branches that are already merged into a base branch (default main).
// Dry run unless --apply. Only ever uses the safe forms (`git worktree remove`, `git branch -d`): a worktree
// with changes, a lock or a detached HEAD is reported and left alone, and nothing is force-deleted.
// The decisions are pure functions (classify*) so a Node test can check them without git.

const path = require('node:path');
const { execFileSync } = require('node:child_process');

// checkJs: start
/**
 * @typedef {{path: string, head: string, branch: string|null, detached: boolean, bare: boolean,
 *   locked: boolean, prunable: boolean}} Worktree
 * @typedef {{action: 'remove'|'skip', reason: string}} Decision
 */

/** Parses `git worktree list --porcelain` (blocks separated by blank lines; the first is the primary). */
function parseWorktrees(text) {
  /** @type {Worktree[]} */
  const list = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    /** @type {Worktree|null} */
    let wt = null;
    for (const line of block.split(/\r?\n/)) {
      const sp = line.indexOf(' ');
      const key = sp < 0 ? line : line.slice(0, sp);
      if (key === 'worktree') wt = { path: line.slice(sp + 1), head: '', branch: null, detached: false, bare: false, locked: false, prunable: false };
      else if (!wt) continue;
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

/** A path as comparable text: absolute, forward slashes, case-folded on Windows (git prints C:/x, node C:\x). */
function norm(p, platform = path.sep === '\\' ?'win32' : 'linux') {
  const s = path.resolve(p).replace(/\\/g, '/').replace(/\/+$/, '');
  return platform === 'win32' ? s.toLowerCase() : s;
}

/** Is `dir` the worktree root or inside it? */
function isInside(dir, root, platform) {
  const d = norm(dir, platform);
  const r = norm(root, platform);
  return d === r || d.startsWith(`${r}/`);
}

/**
 * Decides one worktree. ctx: { primary, cwd, base, merged(commit) -> bool, dirty(path) -> bool, exists(path) -> bool,
 * platform? }. The order matters: the cheap, absolute protections come first, so the git calls run only for
 * candidates.
 * @returns {Decision}
 */
function classifyWorktree(wt, ctx) {
  const platform = ctx.platform;
  /** @type {(reason: string) => Decision} */
  const skip = (reason) => ({ action: 'skip', reason });
  if (norm(wt.path, platform) === norm(ctx.primary, platform)) return skip('primary worktree');
  if (wt.bare) return skip('bare repository');
  if (isInside(ctx.cwd, wt.path, platform)) return skip('active worktree (current directory)');
  if (wt.branch && wt.branch === ctx.base) return skip('base branch');
  if (wt.locked) return skip('locked');
  if (wt.prunable || !ctx.exists(wt.path)) return skip('missing or prunable (run git worktree prune)');
  if (wt.detached || !wt.branch) return skip('detached HEAD');
  if (!ctx.merged(wt.head)) return skip(`not merged into ${ctx.base}`);
  if (ctx.dirty(wt.path)) return skip('has staged, unstaged or untracked changes');
  return { action: 'remove', reason: `merged into ${ctx.base}` };
}

/**
 * Decides one local branch. ctx: { base, merged(commit) -> bool, checkedOut: Set<string> (branches of worktrees that
 * stay), removedWith: Set<string> (branches whose worktree is being removed) }. `commit` is the branch tip.
 * @returns {Decision}
 */
function classifyBranch(name, commit, ctx) {
  /** @type {(reason: string) => Decision} */
  const skip = (reason) => ({ action: 'skip', reason });
  if (name === ctx.base) return skip('base branch');
  if (ctx.checkedOut.has(name) && !ctx.removedWith.has(name)) return skip('checked out in a worktree that stays');
  if (!ctx.merged(commit)) return skip(`not merged into ${ctx.base}`);
  return { action: 'remove', reason: `merged into ${ctx.base}` };
}

/** @param {string[]} argv */
function parseArgs(argv) {
  const o = { apply: false, base: 'main', json: false, help: false, error: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') o.apply = true;
    else if (a === '--json') o.json = true;
    else if (a === '--help' || a === '-h') o.help = true;
    else if (a === '--base') {
      o.base = argv[++i] || '';
      if (!o.base || o.base.startsWith('-')) o.error = '--base needs a ref';
    } else o.error = `unknown argument: ${a}`;
  }
  return o;
}
// checkJs: end

const HELP = `Usage: node tools/gc-worktrees.js [--base <ref>] [--apply] [--json]

Removes worktrees and local branches already merged into <ref> (default: main).
Dry run unless --apply. Never touches the primary or the current worktree, the base
branch, or worktrees that are dirty, locked, detached or missing; never force-deletes.
`;

/** Runs git in `cwd`; returns trimmed stdout, or throws with git's message. */
function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function gitOk(cwd, args) {
  try { git(cwd, args); return true; } catch { return false; }
}

/** Builds the plan: what would be removed and what is skipped (with the reason). Reads only. */
function plan({ cwd, base }) {
  const fs = require('node:fs');
  if (!gitOk(cwd, ['rev-parse', '--verify', '--quiet', `${base}^{commit}`])) throw new Error(`unknown base ref: ${base}`);
  const worktrees = parseWorktrees(git(cwd, ['worktree', 'list', '--porcelain']));
  if (!worktrees.length) throw new Error('not a git repository');
  const primary = worktrees[0].path;
  const merged = (commit) => gitOk(primary, ['merge-base', '--is-ancestor', commit, base]);
  const ctx = {
    primary, cwd, base,
    merged,
    dirty: (p) => git(p, ['status', '--porcelain', '--untracked-files=all']) !== '',
    exists: (p) => fs.existsSync(p),
  };
  const baseBranch = base.replace(/^refs\/heads\//, '');
  const out = { base, worktrees: [], branches: [] };
  const removedWith = new Set();
  const checkedOut = new Set();
  for (const wt of worktrees) {
    if (wt.branch) checkedOut.add(wt.branch);
    let d;
    try { d = classifyWorktree(wt, { ...ctx, base: baseBranch }); } catch (e) { d = { action: 'skip', reason: `check failed: ${e.message}` }; }
    if (d.action === 'remove' && wt.branch) removedWith.add(wt.branch);
    out.worktrees.push({ path: wt.path, branch: wt.branch, ...d });
  }
  const refs = git(primary, ['for-each-ref', '--format=%(refname:short) %(objectname)', 'refs/heads']);
  for (const line of refs ? refs.split(/\r?\n/) : []) {
    const [name, commit] = line.split(' ');
    const d = classifyBranch(name, commit, { base: baseBranch, merged, checkedOut, removedWith });
    out.branches.push({ name, ...d });
  }
  return { primary, ...out };
}

/** Applies a plan: worktrees first (a branch can't be deleted while checked out), then branches. */
function apply(p) {
  const results = [];
  const run = (kind, label, args) => {
    try { git(p.primary, args); results.push({ kind, label, ok: true }); } catch (e) {
      results.push({ kind, label, ok: false, error: String(e.stderr || e.message).trim() });
    }
  };
  for (const w of p.worktrees) if (w.action === 'remove') run('worktree', w.path, ['worktree', 'remove', w.path]);
  for (const b of p.branches) if (b.action === 'remove') run('branch', b.name, ['branch', '-d', b.name]);
  return results;
}

function format(p, results) {
  const lines = [`Base: ${p.base}${results ? '' : ' (dry run; use --apply to remove)'}`];
  for (const w of p.worktrees) lines.push(`worktree ${w.action === 'remove' ? 'REMOVE' : 'skip  '} ${w.path} [${w.branch || 'detached'}]: ${w.reason}`);
  for (const b of p.branches) lines.push(`branch   ${b.action === 'remove' ? 'DELETE' : 'skip  '} ${b.name}: ${b.reason}`);
  for (const r of results || []) lines.push(`${r.ok ? 'done  ' : 'FAILED'} ${r.kind} ${r.label}${r.ok ? '' : `: ${r.error}`}`);
  return lines.join('\n');
}

/** CLI body; returns the exit code. io = { cwd, out(text), err(text) } so a test can run it. */
function main(argv, io) {
  const o = parseArgs(argv);
  if (o.help) { io.out(HELP); return 0; }
  if (o.error) { io.err(`${o.error}\n${HELP}`); return 2; }
  try {
    const p = plan({ cwd: io.cwd, base: o.base });
    const results = o.apply ? apply(p) : null;
    io.out(o.json ? JSON.stringify({ ...p, applied: !!results, results: results || [] }, null, 2) : format(p, results));
    return results && results.some((r) => !r.ok) ? 1 : 0;
  } catch (e) {
    io.err(`gc-worktrees: ${e.message}`);
    return 2;
  }
}

module.exports = { parseWorktrees, classifyWorktree, classifyBranch, parseArgs, isInside, plan, apply, main };

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2), {
    cwd: process.cwd(),
    out: (t) => console.log(t),
    err: (t) => console.error(t),
  });
}
