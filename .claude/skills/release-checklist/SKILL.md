---
name: release-checklist
description: Prepare (never publish) a Video Preview Enhanced release. Use when asked to get a version ready, check release readiness or draft release notes. Publishing is always the maintainer's decision.
---

# Prepare a release

Authority: `docs/RELEASING.md` (read it). This skill only prepares. **Never** run the Publish
workflow, push tags, create public releases or publish to any marketplace unless the maintainer
says so explicitly in this session.

## Steps

1. On `main`, everything merged and CI green (`gh run list --branch main --limit 3`).
2. Bump `version` in `package.json` and the two `version` fields in `package-lock.json`; move the
   CHANGELOG **Unreleased** entries under `## <version> (<date>)` (the Publish workflow refuses a
   version without that heading).
3. Tests: layers 1-3 (`run-tests` skill), and layer 4 against the last release's numbers
   (`node test/benchq.js node test/vscode/run.js`). Re-check every number and claim in `README.md`
   and `docs/performance.md` against the run; correct the claim, not the measurement.
4. Package: `npm ci && npm run package`. Expect no warnings and a size near 4.7 MB.
   `npx --yes @vscode/vsce@4.1.1 ls --tree` must include `LICENSE`, `THIRD_PARTY_NOTICES.md` and
   `media/libav-vpe/LICENSE-*`, and exclude tests, docs, `.claude/` and `.private-context/`.
5. Scan the tracked tree and the VSIX for personal data (home paths, e-mails) before anything leaves
   the machine. CI's personal-data check should already pass.
6. Draft release notes from the CHANGELOG section (plain, user-facing). Hand the maintainer: version,
   checklist results, the VSIX path and the command to start the Publish workflow (do not run it).

## Pitfalls

- An internal release is a tag plus a **draft** GitHub Release; nothing goes to a marketplace.
- Publish runs by hand only (workflow_dispatch) with Trusted Publishing; no token is stored.
