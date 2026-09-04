# Source origin

Donors are read-only. This repository does not merge their Git history.

The pinned commits below are the values recorded in `docs/sources/donor-manifest.json`. Do not invent other SHAs.

## Source rule

The donor repositories remain private reference systems. This repository accepts only new source, publication-cleared source, synthetic fixtures, and reviewed origin records. It does not accept private CHCP material, real course content, credentials, harvested publisher methods, or copied private deployment configuration.

That paragraph is the `README.md` source rule.

## Recorded donors

Schema: `morrow.donor-manifest.v1`. Created at `2026-09-03T00:00:00.000Z`.

### example-legacy

- Repository: `example-org/example-legacy-source`
- Pinned commit: `7275bfbc1c24dd6baff58f9435f1ce5a50fbb5d4`
- Role: Private donor for Canvas tools, planning, approval projections, verification, privacy, workflows, reports, and browser-backed execution.
- Default disposition: `behavior-reference-and-reviewed-export`

### example-attestation-repo (ExamplePlatform)

- Manifest id: `meridian`
- Repository: `example-owner/example-attestation-repo`
- Pinned commit: `7cc052cf2063e1f2492c0ac20aee41ee3a22a10f`
- Role: Private donor and initial internal MCP upstream for typed Canvas operations, scope binding, durable effects, batch recovery, and workspace state.
- Default disposition: `private-upstream-and-behavior-reference`

## Held providers

The manifest records `heldProviders` as `mindtap` and `connect`.

## Manifest rules

- No private repository history is merged into this repository.
- Every copied or adapted source file requires an origin record and rights review.
- Generated donor catalogs are build artifacts, not publication permission.
- Private institution data, paths, identities, credentials, and provider responses are prohibited.

## Related records

- `docs/sources/donor-manifest.json`
- `config/source-rights.manifest.json` starts empty on purpose. Public assembly stays blocked until an owner adds one reviewed, exact-digest record for every included file.
- `README.md`
