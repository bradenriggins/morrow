# Versioning

Each Morrow product versions independently. There is no single repo version.

## Tag format

- Morrow Desktop: `desktop/vX.Y.Z` (for example `desktop/v1.0.5`)
- Morrow for Muse: `muse/vX.Y.Z` (for example `muse/v0.3.1`)

Tags are created from `main` after the product's CI suite is green. A change that touches only one product tags only that product.

## Release assets are fixed

A tag names one commit, and the assets on its GitHub release are built from that commit. Never replace an asset on a published release. Any later change under a product's directory, even a documentation fix, ships as a new version, because the release zip, its `SHA256SUMS`, and the website's download links all name the version.

## Cutting a product release

1. **Prepare the release in its pull request.** Set the new version and write its changelog section before the tag, so the tagged commit carries its own release notes. Date the section with the day you will tag it, and if the tag moves to a later day, correct the date before you tag. The newest Morrow Desktop section becomes the GitHub release notes that educators open from the download page, so it says in plain words what an educator will notice and keeps developer detail under a last `### Technical notes` subsection.
   - Morrow Desktop: `desktop/package.json`, `desktop/installer/package.json`, the current-version sentences in `desktop/README.md` and `desktop/LIMITATIONS.md`, and a new section in `desktop/CHANGELOG.md`.
   - Morrow for Muse: `morrow-for-muse/VERSION`, `morrow-for-muse/pack/version.txt`, `morrow-for-muse/pack/pack.json`, and a new section in `morrow-for-muse/CHANGELOG.md`. `git grep -n <old version> -- morrow-for-muse` finds the other files that name the version.
2. **Merge with the required `check` green.** For Morrow Desktop, also run the installer QA workflow on the merge commit and wait for it to pass: `gh workflow run desktop-release.yml --ref main`, then `gh run list --workflow desktop-release.yml --limit 1 --json databaseId,headSha` to find the run and its commit, and `gh run watch <run id> --exit-status`. It builds, installs, and starts the unsigned Windows and macOS builds on native runners. If a job fails or is cancelled, it keeps the receipts its checks wrote, and never the installer: `gh run download <run id> --pattern '*-failure-receipts-*'` fetches them. A Desktop tag needs a green `desktop-release.yml` run whose commit is the one you tag.
3. **Tag the merge commit and push the tag:** `git tag desktop/vX.Y.Z <commit>` and `git push origin desktop/vX.Y.Z`, or the same with `muse/vX.Y.Z`.
4. **Build, smoke-test, and publish the Morrow Desktop assets.** The installer QA run in step 2 tests builds that are then discarded, so smoke-test the exact files you publish. Check out the tag on each native computer, and in `desktop/` run `pnpm install --frozen-lockfile`, `pnpm --dir installer --ignore-workspace install --frozen-lockfile`, and `pnpm build`. In the commands below, `<tag commit>` is the full commit the tag names (`git rev-parse desktop/vX.Y.Z^{commit}`), and `<run id>` is a new 32-character lowercase hex value (`openssl rand -hex 16` on a Mac, `[guid]::NewGuid().ToString("N")` in PowerShell). Then:
   - On a Mac with Apple silicon: `node scripts/package-mcp-bundle.mjs --target darwin-arm64 --unsigned-release --output <mac folder>` writes `Morrow-X.Y.Z-mac-arm64.dmg`, `Morrow-X.Y.Z-mac-arm64.zip`, and `receipt.json` into a new absolute folder. Start the disk image you will publish: `node scripts/test/desktop-mac-smoke.mjs --disk-image <mac folder>/Morrow-X.Y.Z-mac-arm64.dmg --package-receipt <mac folder>/receipt.json --receipt <new absolute path>/smoke.json --source <tag commit> --run-id <run id>`. It mounts the disk image read-only and keeps everything Morrow writes in a temporary folder.
   - On Windows x64: `node scripts/package-mcp-bundle.mjs --target win32-x64 --unsigned-release --output <windows folder>` writes `Morrow-X.Y.Z-win-x64.exe` and `receipt.json` into a new absolute folder. Copy `receipt.json` to `package-receipt.json` in the same folder, then install, start, repair, and remove the installer you will publish: `node scripts/test/desktop-windows-smoke.mjs --installer <windows folder>\Morrow-X.Y.Z-win-x64.exe --package-receipt <windows folder>\package-receipt.json --install-dir <new absolute folder> --receipt <new absolute path>\smoke.json --source <tag commit> --run-id <run id>`. Run it in a Windows user account where Morrow is not installed, because it installs Morrow for that account and then removes it.
   - Each smoke test must finish with exit code 0. It refuses a package receipt that names another commit or a checkout with uncommitted changes, and a file whose SHA-256 differs from the one the receipt records. Publish nothing from a build whose smoke test failed.
   - From the repository root: `git archive --format=zip --prefix=Morrow-X.Y.Z-source/ -o Morrow-X.Y.Z-source.zip desktop/vX.Y.Z` writes the source archive.
   - Put the four files in one folder, and there run `shasum -a 256 Morrow-X.Y.Z-mac-arm64.dmg Morrow-X.Y.Z-mac-arm64.zip Morrow-X.Y.Z-win-x64.exe Morrow-X.Y.Z-source.zip > SHA256SUMS`.
   - Save the version's `desktop/CHANGELOG.md` section as the notes file. From the repository root, `awk -v v="X.Y.Z" 'index($0, "## " v " (") == 1 { keep = 1; next } /^## / { keep = 0 } keep' desktop/CHANGELOG.md > <notes file>` saves the whole section. Read the notes file through before you publish: `gh release create desktop/vX.Y.Z --verify-tag --title "Morrow Desktop X.Y.Z" --notes-file <notes file> --latest Morrow-X.Y.Z-mac-arm64.dmg Morrow-X.Y.Z-mac-arm64.zip Morrow-X.Y.Z-win-x64.exe Morrow-X.Y.Z-source.zip SHA256SUMS`.
5. **Build and publish the Morrow for Muse assets.** Check out the tag, and from the repository root run `python3 morrow-for-muse/scripts/carve.py --zip`. It carves the release tree, runs the secrets gate, and writes `dist/morrow-muse-connector-X.Y.Z.zip`. Then:
   - `(cd dist && shasum -a 256 morrow-muse-connector-X.Y.Z.zip > SHA256SUMS)`.
   - Save the version's `morrow-for-muse/CHANGELOG.md` section as the notes file: `awk -v v="X.Y.Z" 'index($0, "## " v " (") == 1 { keep = 1; next } /^## / { keep = 0 } keep' morrow-for-muse/CHANGELOG.md > <notes file>`. Read it through, then publish: `gh release create muse/vX.Y.Z --verify-tag --title "Morrow for Muse X.Y.Z" --notes-file <notes file> --latest=false dist/morrow-muse-connector-X.Y.Z.zip dist/SHA256SUMS`. A Muse release is never marked Latest, for the reason under Desktop updates below.
6. **Check what was published.** Download the release into an empty folder with `gh release download <tag> -D <folder>`, and in that folder run `shasum -a 256 -c SHA256SUMS`. Then check every release link the website names with `curl -sI <link>`: a download link must answer `HTTP/2 302`, and a release page link `HTTP/2 200`.

## Desktop updates

Morrow Desktop 1.0.5 is unsigned. An unsigned build has no update feed (`publish` is empty in `desktop/installer/electron-builder.config.cjs`), it never updates itself, and the app tells the educator to get newer versions from meetmorrow.app/download. A future signed Desktop release that turns updates on must also be published to `bradenriggins/morrow-downloads`, the feed `desktop/installer/shared/update-feed.cjs` names (see the [update contract](../desktop/installer/UPDATES.md)). This repository cannot be that feed: the updater reads the repository's Latest release and then fetches `latest-mac.yml` from it, which fails whenever the Latest release is a Muse release.

## CI path filters

`.github/workflows/ci.yml` runs the repository text gates on every change: no em dash in any tracked file, no retired phrase on any product-facing page, the platform facts in the root README and `docs/products.md`, the security policy and issue templates that keep security reports and student information out of public issues, and the path filters below for root files. It then detects which products changed:

- `desktop/**` changed: the desktop suite runs on Linux (`pnpm check`, browser harnesses, installer suites). Morrow Desktop ships for Windows and macOS, not Linux, so the installer suites also run on Windows (`windows-2022`) and on macOS on Apple silicon (`macos-14`), the runners `desktop-release.yml` packages on, together with every desktop test that Linux skips.
- `morrow-for-muse/**` changed: the Muse suite runs (`pytest`, then the install suites on a carved release tree).
- `.github/**` changed (workflow edits): every suite runs.
- A root file a product reads changed: that product's suites run. `.gitattributes` sets the bytes every checkout writes, so it runs both suites. `docs/versioning.md` runs the desktop suite, whose release workflow test reads these steps. `LICENSE`, which the Muse carve ships, and `.gitignore`, which keeps the Muse test scratch out of Git, run the Muse suite. `desktop/scripts/test/lib/ci-path-filters.mjs` lists every root file and the products that read it, and a repository gate fails when a root file is missing from that list or from its product's filter.
- None of these changed (the root README, `SECURITY.md`, `docs/products.md`): every product suite skips, and the required `check` reports success once the repository text gates pass.

A change spanning both products runs both suites.
