@AGENTS.md

## Claude Code

- Project skills are in `.claude/skills/` (`run-tests`, `reproduce-decode-bug`, `add-format`, `release-checklist`, `update-docs`); use them when the task matches.
- Personal notes of the maintainer are in `.private-context/` if present: read its `README.md`, never copy it into tracked files (see AGENTS.md). Your own auto-memory is private too; keep it out of commits and PRs.
- Work in a worktree (`git worktree add .claude/worktrees/<topic> -b <topic> main`) for anything non-trivial; do not push or merge unless asked.
