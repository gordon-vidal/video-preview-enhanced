@AGENTS.md

## Claude Code

(This file exists because Claude Code reads `AGENTS.md` on its own only when there is no `CLAUDE.md`; the import above keeps one source of truth.)
Shared settings and the launch-guard hook are in `.claude/settings.json` (see AGENTS.md, Guard rails).

- Project skills are in `.claude/skills/` (`run-tests`, `reproduce-decode-bug`, `add-format`, `release-checklist`, `update-docs`); use them when the task matches.
- Personal notes of the maintainer are in `.private-context/` if present: read its `README.md`, never copy it into tracked files (see AGENTS.md). Your own auto-memory is private too; keep it out of commits and PRs.
- Work in a worktree (`git worktree add .claude/worktrees/<topic> -b <topic> main`) for anything non-trivial; do not push or merge unless asked.
