@AGENTS.md

## Claude Code

(This file exists because Claude Code reads `AGENTS.md` on its own only when there is no `CLAUDE.md`; the import above keeps one source of truth.)
Shared settings and the launch-guard hook are in `.claude/settings.json` (see AGENTS.md, Guard rails).

- Project skills are in `.claude/skills/` (`run-tests`, `reproduce-decode-bug`, `add-format`, `release-checklist`, `update-docs`, `ui-notices`, `ui-mockup`, `show-me`, `arch-audit`); use them when the task matches.
- Personal notes of the maintainer are in `.private-context/` if present: read its `README.md`, never copy it into tracked files (see AGENTS.md). Your own auto-memory is private too; keep it out of commits and PRs.
- Always work in your own fresh worktree (in T3 Code: `t3_worktree_handoff` or `delegate_task` with `isolation: "worktree"`; standalone: `git worktree add .claude/worktrees/<topic> -b <topic> main`) — never edit feature branches in the root checkout or reuse another task's worktree; clean up the worktree and merged branch as soon as work lands.
