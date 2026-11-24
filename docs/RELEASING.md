# Releasing

Two kinds of release. Only maintainers make them; a public release is the project owner's decision.

- **Public release (automatic):** bumping `version` in `package.json` on `main` releases it. The
  **Publish** workflow (`.github/workflows/publish.yml`) runs on every push to `main` that changes
  `package.json`; if tag `v<version>` does not exist yet, it tests, packages, publishes to the VS
  Marketplace through Trusted Publishing, optionally to Open VSX, then creates the tag and the
  GitHub Release (CHANGELOG section as notes, VSIX attached). Merging a version bump **is** the
  decision to publish. A push that leaves the version unchanged finds the tag and does nothing.
- **Internal release:** a tagged commit and a **draft** GitHub Release with the VSIX attached, for
  testing. Nothing goes to a marketplace. Never bump `version` on `main` for it.

## Prepare (both kinds)

1. On `main`, everything merged and CI green. Bump `version` in `package.json` (and the two
   `version` fields of `package-lock.json`) and move the CHANGELOG **Unreleased** entries under a
   `## <version> (<date>)` heading. The publish workflow fails on a new version without that section.
   Do the bump and the CHANGELOG section in **one commit / pull request**: merging it to `main` is
   the release.
2. Tests: layers 1-3 of [TESTING.md](TESTING.md) locally, and layer 4 (performance) against the
   last release's numbers. Only real VS Code counts for the user-facing claims: re-check the numbers
   in the README and `docs/performance.md` against the run.
3. Build the package. The Marketplace page is `README.md`; the VSIX carries it as its readme:
   ```
   npm ci
   npm run package          # npx @vscode/vsce@<pinned> package
   ```
   Expect no warnings (repository, licence, icon and publisher are set). `npx @vscode/vsce ls --tree`
   shows what ships; it should stay near 4.7 MB (the WebAssembly decoder is 7.9 MB uncompressed).
   Tests, `docs/`, screenshots, icon sources and repository-only files are excluded by
   `.vscodeignore`; `LICENSE`, `THIRD_PARTY_NOTICES.md` and `media/libav-vpe/LICENSE-*` must ship.
4. Install the VSIX in a clean VS Code profile and play one file of each decoder path
   (`code --install-extension video-preview-enhanced-<version>.vsix`).

## Internal release

```
git tag v<version>
gh release create v<version> --draft --title "v<version>" --notes-file <notes.md> video-preview-enhanced-<version>.vsix
```

Push the tag only when you want it on GitHub (a draft release can also create it: `--target main`).

## Public release

### One-time setup

- **VS Marketplace publisher** `gordon-vidal` (<https://marketplace.visualstudio.com/manage>), with a
  **Trusted Publishing** policy: repository owner `gordon-vidal`, repository `video-preview-enhanced`,
  workflow `publish.yml`, no environment. See the
  [official guide](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#publish-with-github-actions-and-trusted-publishing).
  No personal access token is stored anywhere. While the repository is private, the policy must be
  used (a successful run of the workflow) within 48 hours of creating it, or it has to be created again;
  the first successful token exchange activates it for good.
- **Open VSX (optional):** log in at <https://open-vsx.org> with GitHub, accept the Publisher
  Agreement, create an access token, create the namespace once
  (`npx ovsx create-namespace gordon-vidal -p <token>`) and ask for it to be verified (claim it in
  the namespace-ownership issue on `EclipseFdn/open-vsx.org`; unverified publishers rank lower).
  Store the token as the repository secret `OVSX_PAT`. Without it, the Open VSX job is skipped.
  (ovsx also supports trusted publishing; switching to it would remove this secret.)
- **Public repository:** vsce rewrites relative image and link paths in the listing against
  `repository`, so the screenshots on the Marketplace page only show once the repository is public.
- Check that the display name `Video Preview Enhanced` is still unique on the Marketplace.
  `docs/notes/marketplace-seo.md` has the name, description and keyword reasoning.

### Steps

1. Prepare as above (tests, package, clean-profile check) on a branch; bump `version` and add the
   CHANGELOG section in the same commit; open a PR.
2. Merge to `main`. The Publish workflow starts by itself (Actions > Publish).
3. The workflow: **check** reads `version` and looks for tag `v<version>` (exists: stops with a
   notice; missing: continues, and fails if CHANGELOG has no section for it); **package** runs the
   same checks as CI (syntax, hygiene, host and Node tests; LFS test videos fetched) and builds the
   VSIX once; **marketplace** publishes that VSIX (`vsce publish --oidc --packagePath`); **open-vsx**
   publishes it too if `OVSX_PAT` is set; **github-release** then creates the tag `v<version>` on the
   merged commit and the release `v<version>` with the CHANGELOG section as notes and the VSIX attached
   (an existing draft release for the tag is updated and published instead). If the Marketplace
   publish fails, no tag or release is created; fix the cause and re-run the failed jobs, or run the
   workflow by hand. Runs are serialised (`concurrency: publish`) and only run from `main`.
4. Install from the Marketplace in a clean profile and check the page: icon, banner, images, links.
   Verification of a new publisher by Microsoft can take a day.

**Manual fallback:** Actions > **Publish** > **Run workflow** on `main` runs the same flow for the
current `package.json` version (inputs: pre-release yes/no, Open VSX yes/no, `dry_run`). A dry run
checks, tests and packages only: nothing is published, no tag or release is made. Pre-releases are
only made this way; an automatic run is always a normal release.

If the Marketplace step fails after the VSIX was built, re-run the failed jobs; the OIDC token
exchange is single use and the credential lasts 15 minutes, which is why packaging is a separate job.
An Open VSX failure does not block the tag and release; publish to Open VSX by hand
(`npx ovsx publish <vsix> -p <token>`) in that case.

## Screenshots

`node test/vscode/get_code.js` once, then
`node test/benchq.js node test/vscode/screenshot.js media/screenshots/<name>.png <video file> --wait 25`.
It starts the pinned portable VS Code on a hidden desktop, opens the file through the CLI after the
window is up (a file on the first command line of a fresh profile can race the extension's
activation and open in the text editor), grabs the window with `PrintWindow` and removes everything.
Limits: the title bar reads "[Extension Development Host]"; no mouse hover or key presses (so no
overlays that need a hover), so the Codec X-ray, scopes and compare views are not captured. Capture
those by hand in a visible window (Dark Modern, sidebar narrowed, under 1280 px wide for GIFs, under
about 5 MB). Footage must be openly licensed; add the credit to the page (the current shots use
*Big Buck Bunny* and *Tears of Steel*, CC BY 3.0).

For a matching Dark Modern, Light Modern and High Contrast pack, run
`node tools/theme-screenshots.js <out-dir> [video-file]` (default: the generated
`test/media/cases/long_20s.mp4` fixture). It captures `dark.png`, `light.png` and
`high-contrast.png` sequentially on the hidden desktop through the same screenshot runner
and queue. Existing files with these names are replaced. Use `--plan` to print the paths
and themes without starting VS Code or creating files.

See [screenshot notes](notes/screenshots.md) for the footage and the remaining manual captures.
