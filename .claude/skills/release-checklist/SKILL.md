---
name: release-checklist
description: Prepare (never publish) a Video Preview Enhanced release. Use when asked to get a version ready, check release readiness or draft release notes. Publishing is always the maintainer's decision.
---

# Prepare a release

Authority: `docs/RELEASING.md` (read it). This skill only prepares. Publishing is automatic: the
Publish workflow releases whenever `version` in `package.json` changes on `main`, so merging a version
bump is the release. **Never** merge or push a version bump to `main`, run the Publish workflow, push
tags, create releases or publish to any marketplace unless the maintainer says so explicitly in this
session. Prepare the bump on a branch / PR only.

## Steps

1. On `main`, everything merged and CI green (`gh run list --branch main --limit 3`).
2. Only if the maintainer explicitly named the version to release: bump `version` in `package.json` and the two `version` fields in `package-lock.json`; move the
   CHANGELOG **Unreleased** entries under `## <version> (<date>)` (the Publish workflow fails on a new
   version without that section). Bump and CHANGELOG go in one commit.
3. Tests: layers 1-3 (`run-tests` skill), and layer 4 against the last release's numbers
   (`node test/benchq.js node test/vscode/run.js`). Re-check every number and claim in `README.md`
   and `docs/performance.md` against the run; correct the claim, not the measurement.
4. Package: `npm ci && npm run package`. Expect no warnings and a size near 4.7 MB.
   `npx --yes @vscode/vsce@4.1.1 ls --tree` must include `LICENSE`, `THIRD_PARTY_NOTICES.md` and
   `media/libav-vpe/LICENSE-*`, and exclude tests, docs, `.claude/` and `.private-context/`.
5. Scan the tracked tree and the VSIX for personal data (home paths, e-mails) before anything leaves
   the machine. CI's personal-data check should already pass.
6. Draft release notes from the CHANGELOG section (plain, user-facing). Hand the maintainer: version,
   checklist results, the VSIX path and a reminder that merging the bump to `main` publishes.

## Pitfalls

- An internal release is a tag plus a **draft** GitHub Release; nothing goes to a marketplace.
- Publish runs on pushes to `main` that change `package.json` (no-op if tag `v<version>` exists),
  with Trusted Publishing; no token is stored. `workflow_dispatch` (with `dry_run`) is the fallback.
  Any `package.json` edit on `main` with a new version number releases it, so keep version bumps out
  of unrelated PRs.
