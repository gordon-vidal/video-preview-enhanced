# Releasing

Two kinds of release. Only maintainers make them; a public release is the project owner's decision.

- **Internal release:** a tagged commit and a **draft** GitHub Release with the VSIX attached, for
  testing. Nothing goes to a marketplace.
- **Public release:** the **Publish** workflow (`.github/workflows/publish.yml`), started by hand.
  It publishes to the VS Marketplace through Trusted Publishing, optionally to Open VSX, and
  attaches the VSIX to the GitHub Release. It never runs on tags, so tagging an internal release
  publishes nothing.

## Prepare (both kinds)

1. On `main`, everything merged and CI green. Bump `version` in `package.json` (and the two
   `version` fields of `package-lock.json`) and move the CHANGELOG **Unreleased** entries under a
   `## <version> (<date>)` heading. The publish workflow refuses a version without that heading.
2. Tests: layers 1-3 of [TESTING.md](TESTING.md) locally, and layer 4 (performance) against the
   last release's numbers. Only real VS Code counts for the user-facing claims: re-check the numbers
   in `LISTING.md` and the README "Performance" table against the run.
3. Build the package. The Marketplace page is `LISTING.md`; the VSIX carries it as its readme:
   ```
   npm ci
   npm run package          # npx @vscode/vsce@<pinned> package --readme-path LISTING.md
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

1. Prepare as above, push `main`.
2. GitHub > **Actions** > **Publish** > **Run workflow** on `main`. Inputs: the version (must equal
   `package.json`), `publish` as confirmation, pre-release yes/no, Open VSX yes/no.
3. The workflow: checks the inputs, runs the Node tests, packages the VSIX once, publishes that VSIX
   to the Marketplace (`vsce publish --oidc --packagePath`), then to Open VSX (`ovsx publish`, if
   `OVSX_PAT` is set) and attaches it to the GitHub Release `v<version>` (an existing draft release is
   updated and published; otherwise one is created with the CHANGELOG section as notes).
4. Install from the Marketplace in a clean profile and check the page: icon, banner, images, links.
   Verification of a new publisher by Microsoft can take a day.

If the Marketplace step fails after the VSIX was built, re-run the failed jobs; the OIDC token
exchange is single use and the credential lasts 15 minutes, which is why packaging is a separate job.

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

See [screenshot notes](notes/screenshots.md) for the footage and the remaining manual captures.
