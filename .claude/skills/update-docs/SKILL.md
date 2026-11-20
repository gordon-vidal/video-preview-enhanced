---
name: update-docs
description: Update documentation for a change in Video Preview Enhanced while keeping README short (README is the Marketplace page). Use when behaviour, settings, formats, numbers or claims change.
---

# Update docs without bloating README

| Content | File |
|---|---|
| Marketplace and GitHub landing page (short, benefit-led, measured claims only) | `README.md` |
| Commands, settings, keys | `docs/commands-and-settings.md`, `docs/keys.md`; `package.json` `contributes` text must match |
| Formats and decoders | `docs/formats.md` |
| Numbers | `docs/performance.md` (measured, dated, with the machine) |
| Remote, URLs, privacy, ffmpeg, FAQ | `docs/remote.md`, `docs/urls.md`, `docs/privacy-and-security.md`, `docs/ffmpeg.md`, `docs/faq.md` |
| Product decisions | `docs/PRODUCT.md` (the maintainer's call; do not edit unprompted) |
| Design reasoning for a larger change | `docs/notes/<topic>.md` |
| What changed | `CHANGELOG.md` under **Unreleased** |

## Steps

1. Change the detailed page in `docs/` first. README gets at most a one-line change, and only when a
   headline feature or claim changes. Link to docs, never copy them into README.
2. `CHANGELOG.md`: one user-facing line under **Unreleased**.
3. Every number you write must come from a run you can cite (date, machine); otherwise leave it out.
4. Check relative links resolve (CI runs a markdown link check).
5. No personal data: no home paths, e-mails or private names (the public maintainer handle is fine).
6. UI text and setting descriptions: short and plain.

## Pitfalls

- README images are relative paths under `media/screenshots/` (they load from the repo once public).
- Do not describe unreleased behaviour as shipped.
