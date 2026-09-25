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

## Desktop updates

Morrow Desktop 1.0.5 is unsigned. An unsigned build has no update feed (`publish` is empty in `desktop/installer/electron-builder.config.cjs`), it never updates itself, and the app tells the educator to get newer versions from meetmorrow.app/download. A future signed Desktop release that turns updates on must also be published to `bradenriggins/morrow-downloads`, the feed `desktop/installer/shared/update-feed.cjs` names (see the [update contract](../desktop/installer/UPDATES.md)). This repository cannot be that feed: the updater reads the repository's Latest release and then fetches `latest-mac.yml` from it, which fails whenever the Latest release is a Muse release.

## Inactive workflow files

The files in `.github/workflows/` remain in the repository as historical automation and test fixtures. GitHub Actions are disabled. These files do not run and must not be used for current checks or releases.
