# Versioning

Each Morrow product versions independently. There is no single repo version.

## Tag format

- Morrow Desktop: `desktop/vX.Y.Z` (for example `desktop/v1.0.5`)
- Morrow for Muse: `muse/vX.Y.Z` (for example `muse/v0.3.1`)

Tags are created from `main` after the product's local checks pass and release evidence is complete. A change that touches only one product tags only that product.

GitHub Actions are disabled for Morrow. Do not dispatch a workflow or treat a workflow status as a release gate. The workflow-specific Desktop steps below document the already-published `desktop/v1.0.5` release only. Future releases need local product checks and provider-specific release evidence. Desktop releases also need native smoke receipts for the exact assets before publication.

## Release assets are fixed

A tag names one commit, and the assets on its GitHub release are built from that commit. Never replace an asset on a published release. Any later change under a product's directory, even a documentation fix, ships as a new version, because the release zip, its `SHA256SUMS`, and the website's download links all name the version.

## Cutting a product release

1. **Prepare the release in its pull request.** Set the new version and write its changelog section before the tag, so the tagged commit carries its own release notes. Date the section with the day you will tag it, and if the tag moves to a later day, correct the date before you tag. The newest Morrow Desktop section becomes the GitHub release notes that educators open from the download page, so it says in plain words what an educator will notice and keeps developer detail under a last `### Technical notes` subsection.
   - Morrow Desktop: `desktop/package.json`, `desktop/installer/package.json`, the current-version sentences in `desktop/README.md` and `desktop/LIMITATIONS.md`, and a new section in `desktop/CHANGELOG.md`.
   - Morrow for Muse: `morrow-for-muse/VERSION`, `morrow-for-muse/pack/version.txt`, `morrow-for-muse/pack/pack.json`, and a new section in `morrow-for-muse/CHANGELOG.md`. `git grep -n <old version> -- morrow-for-muse` finds the other files that name the version.
2. **Merge after local checks pass.** Run the affected product's local check suite and confirm its release evidence matches the commit you will tag. The unsigned public-release installers for Morrow Desktop 1.0.5 were smoke-tested on native Windows and Apple silicon runners before GitHub Actions were disabled. Do not dispatch a workflow for a future release.
3. **Tag the merge commit and push the tag:** `git tag desktop/vX.Y.Z <commit>` and `git push origin desktop/vX.Y.Z`, or the same with `muse/vX.Y.Z`.
4. **Publish the Morrow Desktop assets smoke-tested for 1.0.5. (Historical workflow record; do not repeat.)** The 1.0.5 release used native-runner artifacts downloaded into empty folders:
   - `gh run download <run id> --name morrow-macos-desktop-<run id> --dir <mac artifact folder>`
   - `gh run download <run id> --name morrow-windows-desktop-<run id> --dir <windows artifact folder>`
   Copy `Morrow-X.Y.Z-mac-arm64.dmg`, `Morrow-X.Y.Z-mac-arm64.zip`, and `Morrow-X.Y.Z-win-x64.exe` from those folders into one new release folder. The run uploaded them only after the installers passed the native smoke tests; their package receipts bind them to the workflow's merge commit, which the Desktop tag must name. Do not rebuild or substitute files after the smoke tests.
   - From the repository root: `git archive --format=zip --prefix=Morrow-X.Y.Z-source/ -o Morrow-X.Y.Z-source.zip desktop/vX.Y.Z` writes the source archive.
   - Put the four files in one folder, and there run `shasum -a 256 Morrow-X.Y.Z-mac-arm64.dmg Morrow-X.Y.Z-mac-arm64.zip Morrow-X.Y.Z-win-x64.exe Morrow-X.Y.Z-source.zip > SHA256SUMS`.
   - Save the version's `desktop/CHANGELOG.md` section as the notes file. From the repository root, `awk -v v="X.Y.Z" 'index($0, "## " v " (") == 1 { keep = 1; next } /^## / { keep = 0 } keep' desktop/CHANGELOG.md > <notes file>` saves the whole section. Read the notes file through before you publish: `gh release create desktop/vX.Y.Z --verify-tag --title "Morrow Desktop X.Y.Z" --notes-file <notes file> --latest Morrow-X.Y.Z-mac-arm64.dmg Morrow-X.Y.Z-mac-arm64.zip Morrow-X.Y.Z-win-x64.exe Morrow-X.Y.Z-source.zip SHA256SUMS`.
5. **Build and publish the Morrow for Muse assets.** Check out the tag, and check that `git describe --tags --exact-match --match 'muse/v*'` prints `muse/vX.Y.Z`. Then from the repository root run `python3 morrow-for-muse/scripts/carve.py --zip`. It refuses to build while any file under `morrow-for-muse/` or `LICENSE` has a change that is not committed, so the zip holds exactly the tagged files. It carves the release tree, runs the secrets gate, records the commit in the zip's `pack/carve-manifest.json`, and writes `dist/morrow-muse-connector-X.Y.Z.zip`. Run the Muse local tests and install suites before publishing. Then:
   - `(cd dist && shasum -a 256 morrow-muse-connector-X.Y.Z.zip > SHA256SUMS)`.
   - Save the version's `morrow-for-muse/CHANGELOG.md` section as the notes file: `awk -v v="X.Y.Z" 'index($0, "## " v " (") == 1 { keep = 1; next } /^## / { keep = 0 } keep' morrow-for-muse/CHANGELOG.md > <notes file>`. Read it through, then publish: `gh release create muse/vX.Y.Z --verify-tag --title "Morrow for Muse X.Y.Z" --notes-file <notes file> --latest=false dist/morrow-muse-connector-X.Y.Z.zip dist/SHA256SUMS`. A Muse release is never marked Latest, for the reason under Desktop updates below.
6. **Check what was published.** Download the release into an empty folder with `gh release download <tag> -D <folder>`, and in that folder run `shasum -a 256 -c SHA256SUMS`. Then check every release link the website names with `curl -sI <link>`: a download link must answer `HTTP/2 302`, and a release page link `HTTP/2 200`.

## Desktop 1.0.7 Mac release preparation

Desktop 1.0.7 is prepared for macOS on Apple silicon only. Morrow Bridge 1.0.126 is sealed in the source. Until the new Mac package passes native smoke and is published, the Mac download remains Desktop 1.0.6. The Windows x64 download stays on published Desktop 1.0.5. There is no Windows 1.0.7 asset or native Windows 1.0.7 smoke receipt. Keep the website's Windows button on `Morrow-1.0.5-win-x64.exe` and label each platform with its published version.

After this release-source pull request reaches `main`, use a clean checkout of that exact commit. Run `pnpm install --frozen-lockfile` in `desktop/` and `desktop/installer/`, then run `pnpm check` from `desktop/`. Build and smoke the unsigned Mac files on Apple silicon from the repository root:

```sh
node desktop/scripts/package-mcp-bundle.mjs --target darwin-arm64 --unsigned-release --output <empty absolute package folder>
node desktop/scripts/test/desktop-mac-smoke.mjs --disk-image <package folder>/Morrow-1.0.7-mac-arm64.dmg --package-receipt <package folder>/receipt.json --receipt <absolute smoke receipt> --source <main commit> --run-id <32 lowercase hex>
```

The package receipt must record `source.head` as the commit to tag and `source.dirty` as `false`. The passing native smoke receipt must bind the same source commit, package receipt, disk image digest, and both Mac artifact digests. Keep the exact smoke-tested DMG and ZIP. A later source change requires new assets and another native smoke run.

Only after those checks pass, create `desktop/v1.0.7` at the tested commit. Make `Morrow-1.0.7-source.zip` with `git archive --format=zip --prefix=Morrow-1.0.7-source/ -o <release folder>/Morrow-1.0.7-source.zip desktop/v1.0.7`. Put it beside the two tested Mac files. In the release folder, run `shasum -a 256 Morrow-1.0.7-mac-arm64.dmg Morrow-1.0.7-mac-arm64.zip Morrow-1.0.7-source.zip > SHA256SUMS` and `shasum -a 256 -c SHA256SUMS`. Extract and read the 1.0.7 changelog section as the release notes. Publish only those four files with `gh release create desktop/v1.0.7 --verify-tag --title "Morrow Desktop 1.0.7 for Mac" --notes-file <notes file> --latest Morrow-1.0.7-mac-arm64.dmg Morrow-1.0.7-mac-arm64.zip Morrow-1.0.7-source.zip SHA256SUMS`.

Download the published release into an empty folder and check its `SHA256SUMS`. Then update and check only the website's Mac links for 1.0.7. Keep its Windows links on 1.0.5. These commands prepare the same unsigned distribution type as Desktop 1.0.6. A signed release needs separate signing and update-feed work.

## Desktop 1.0.6 Mac release (historical)

Desktop 1.0.6 was published for macOS on Apple silicon only. The Windows x64 download stayed on the published Desktop 1.0.5 installer. There is no Windows 1.0.6 asset, and the 1.0.5 Windows smoke receipt does not prove the 1.0.6 source on Windows. This section records the 1.0.6 commands and evidence requirements; use the 1.0.7 section above for the next release.

After the 1.0.6 changes reach `main`, use a clean checkout of the exact commit to tag. Run `pnpm install --frozen-lockfile` in `desktop/` and again in `desktop/installer/`, then run `pnpm check` from `desktop/`. Build the unsigned Mac files on Apple silicon from the repository root:

```sh
node desktop/scripts/package-mcp-bundle.mjs --target darwin-arm64 --unsigned-release --output <empty absolute package folder>
node desktop/scripts/test/desktop-mac-smoke.mjs --disk-image <package folder>/Morrow-1.0.6-mac-arm64.dmg --package-receipt <package folder>/receipt.json --receipt <absolute smoke receipt> --source <main commit> --run-id <32 lowercase hex>
```

The package receipt must record `source.head` as the commit to tag and `source.dirty` as `false`. The smoke receipt must pass and bind that same source commit, package receipt, disk image digest, and both Mac artifact digests. Keep the exact smoke-tested DMG and ZIP. If merging or tagging changes the commit, rebuild and repeat the smoke check.

Create `desktop/v1.0.6` at that commit only after these checks pass. From the repository root, make `Morrow-1.0.6-source.zip` with `git archive --format=zip --prefix=Morrow-1.0.6-source/ -o <release folder>/Morrow-1.0.6-source.zip desktop/v1.0.6`. Put it beside the two tested Mac files. In the release folder, run `shasum -a 256 Morrow-1.0.6-mac-arm64.dmg Morrow-1.0.6-mac-arm64.zip Morrow-1.0.6-source.zip > SHA256SUMS` and `shasum -a 256 -c SHA256SUMS`. Extract and read the 1.0.6 changelog section as the release notes. Publish only those four files with `gh release create desktop/v1.0.6 --verify-tag --title "Morrow Desktop 1.0.6 for Mac" --notes-file <notes file> --latest Morrow-1.0.6-mac-arm64.dmg Morrow-1.0.6-mac-arm64.zip Morrow-1.0.6-source.zip SHA256SUMS`.

Download the published release into an empty folder and check its `SHA256SUMS`. Then update and check the website's Mac links for 1.0.6 while keeping its Windows links on 1.0.5. A signed release needs separate signing and update-feed work; these commands make the same unsigned distribution type as Desktop 1.0.5.

## Desktop updates

Morrow Desktop 1.0.5 is unsigned. An unsigned build has no update feed (`publish` is empty in `desktop/installer/electron-builder.config.cjs`), it never updates itself, and the app tells the educator to get newer versions from meetmorrow.app/download. A future signed Desktop release that turns updates on must also be published to `bradenriggins/morrow-downloads`, the feed `desktop/installer/shared/update-feed.cjs` names (see the [update contract](../desktop/installer/UPDATES.md)). This repository cannot be that feed: the updater reads the repository's Latest release and then fetches `latest-mac.yml` from it, which fails whenever the Latest release is a Muse release.

## Inactive workflow files

The files in `.github/workflows/` remain in the repository as historical automation and test fixtures. GitHub Actions are disabled. These files do not run and must not be used for current checks or releases.
