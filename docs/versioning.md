# Versioning

Each Morrow product versions independently. There is no single repo version.

## Tag format

- Morrow Desktop: `desktop/vX.Y.Z` (for example `desktop/v1.0.5`)
- Morrow for Muse: `muse/vX.Y.Z` (for example `muse/v0.3.1`)

Tags are created from `main` after the product's CI suite is green. A change that touches only one product tags only that product.

## Cutting a product release

1. Merge the product's changes to `main` through a pull request. CI runs the product's suite by path filter, and the required `check` must pass.
2. Tag the merge commit: `git tag desktop/v1.0.5` or `git tag muse/v0.3.1`.
3. Push the tag: `git push origin desktop/v1.0.5`.
4. Record the release in the product's own changelog (`desktop/CHANGELOG.md` covers Desktop; `morrow-for-muse/CHANGELOG.md` covers Muse).

## CI path filters

`.github/workflows/ci.yml` detects which products changed:

- `desktop/**` changed: the desktop suite runs (`pnpm check`, browser harnesses, installer suites).
- `morrow-for-muse/**` changed: the muse suite runs (`pytest`).
- `.github/**` changed (workflow edits): both suites run.
- None of these changed (root docs, root README): both suites skip, and the required `check` still reports success.

A change spanning both products runs both suites.
