# Private context (maintainers, local only)

Some knowledge must not be public: personal notes, the roadmap before it is decided, handover
between sessions, decisions that name people, environment details of a maintainer's machine,
unpublished marketing drafts. It lives in a **git-ignored `.private-context/` folder at the repo
root**, on the maintainer's machine only. It is never committed, pushed, packaged (`.vscodeignore`)
or copied into PRs, issues, CI logs or tracked docs.

Agents: if the folder exists, read `.private-context/README.md` first (see [AGENTS.md](../AGENTS.md)).
If it does not exist, work from the public docs; do not create it unless the maintainer asks.

Worktrees: a new worktree has no copy of the folder. Read it from the main checkout (the folder
that holds `.git/`), or copy it into the worktree (it is ignored there too).

## Suggested structure

```
.private-context/
  README.md        index: what is here, what is current, date of the last update
  handover.md      state at the end of the last session, next steps (latest section first)
  roadmap.md       priorities and why, undecided ideas
  decisions.md     decisions with names and dates
  environment.md   machines, OS, GPU, tool versions and paths; never credentials
  marketing/       listing and README drafts, GIF shot lists, copy
  research/        competitor notes, benchmarks, raw results
  archive/         older notes kept for history
```

Nothing here is required. Keep `README.md` short and honest about what is outdated.

## Template for `.private-context/README.md`

```markdown
# Private context index
Local only, git-ignored. Never copy into tracked files, commits, PRs, issues or logs.
Last updated: YYYY-MM-DD

| Path | What | Status (current / history) |
|---|---|---|
| handover.md | ... | current |

## Where current truth lives (public)
docs/PRODUCT.md, docs/TESTING.md, docs/RELEASING.md, AGENTS.md
```

## Rules

- **No secrets, ever**: no passwords, tokens, keys, recovery codes. Say where they are kept
  (password manager) instead. The folder is not encrypted and may be synced or backed up.
- Back it up like any local data; it is not in git history.
- When something becomes public knowledge (a decision, a design), move the public part into
  `docs/` or `docs/notes/` without names or paths and leave a pointer here.
