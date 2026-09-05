# Morrow private starter package

Updated: 2026-09-05

## Target

Create one versioned **private local-preview source candidate** plus the already
required connector ZIP. This is not a publication, deployment, registry, or
Chrome Web Store release.

Use the existing `private-full` profile. Do not create another packager. It
stages only committed `HEAD` files, writes a stage manifest, checksums, SBOM,
receipt, and deterministic ZIP under `artifacts/candidates/private-full/`.
`scripts/lib/release-candidate.mjs:555-679` defines this path.
The profile includes every tracked path except package tests, script tests, and
`config/source-origin-ledger.json` (`config/release-profiles.json`).

The recipient needs both artifacts:

1. `artifacts/candidates/private-full/morrow-v1.0.0-rc.0-<platform>-<arch>-private-full.zip`
   for the complete private MCP source candidate.
2. `artifacts/connector/morrow-canvas-connector-v1.0.1.zip` and its receipt
   for the connector. This comes from the existing `pnpm package:connector`
   packager. The source candidate also contains `connector/extension` for the
   documented unpacked-extension path.

## Exact freeze and package order

Run these from the repository root after the current authorized product edits
are complete. Do not add `.agents/`, `.codex/`, `.gemini/`, `.morrow/`, or a
real `morrow.upstreams.json` to either commit.

```bash
if git ls-files | rg -q '(^|/)(morrow\.upstreams\.json|\.morrow/|\.codex/|\.gemini/|\.agents/)'; then
  echo 'prohibited local state is tracked'; exit 1
fi

git add <authorized-product-files>
git commit -m 'Freeze private starter candidate'

pnpm check
pnpm package:connector
pnpm package:connector:check

pnpm source-origin:generate
git add config/source-origin-ledger.json
git commit -m 'Refresh source origin ledger for private candidate'

pnpm package:private-full
node scripts/package-profile.mjs --profile private-full --scan
```

Run `pnpm check` after the last product behavior change. The canonical-URL
readback source passed all 180 tests and the isolated connector browser campaign.
The two connector package commands also passed for that source. Repeat these
checks if extension source changes; later website copy changes do not invalidate
the connector receipt.

The source-origin step is required. The private packager validates the ledger
against the candidate source and sets `candidateBuilt` only when the marker scan
and source-origin validation pass. `config/source-origin-ledger.json` is
excluded from the private payload, so its second local commit remains a valid
binding for the preceding product commit.

Do not run `pnpm package:rc`, `pnpm package:public-canvas`,
`pnpm source-rights:generate`, or `pnpm publication:build` for this target.
The source-rights manifest is not required for the `private-full` profile.
Those commands prepare or validate public-candidate material and do not improve
this private local preview.

## What the command proves

`pnpm package:private-full` produces a local candidate when:

- all intended product files are committed to `HEAD`;
- the source-origin ledger covers the included files;
- the private marker scan passes.

A clean worktree is **not** a mechanical requirement to emit the archive. The
packager reads `git ls-tree HEAD`, so uncommitted edits and untracked user state
are absent from the payload. A clean worktree is still the correct local freeze
state because it proves the delivered source is the inspected source.

The private candidate receipt remains `localEvidenceOnly`. Missing live-Canvas,
client-parity, zero-tolerance, clean-machine, and publication receipts can make
it non-promotable, but they do not prevent `candidateBuilt: true` for this
private package. Do not treat the receipt as a public-release claim.

## Inputs that the packager cannot create

- The final committed product source and a regenerated committed origin ledger.
- A deliberate exclusion of local user state. `.gitignore` covers
  `morrow.upstreams.json` and `.morrow/`; the preflight above protects the
  other local directories because `private-full` otherwise includes every
  tracked path.
- The normal connector reload and live Canvas test that the user is awaiting.
- The independent archive installation and selected-client configuration check.

The installed Codex client has completed a connected read of the exact sandbox
quiz. The remaining checks above still matter for a delivered-product claim.
They do not block generation of the private local-preview artifacts.

## Recipient preview path

After extracting the private source candidate, the documented local setup is:

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm run setup
pnpm morrow mcp install codex --scope project --upstreams "$PWD/morrow.upstreams.json"
```

The recipient restarts the selected client, then completes the normal Chrome
connector connection and Canvas-course connection. `pnpm run setup` creates the
local `morrow.upstreams.json`; it must never be part of the delivered payload.
See `README.md:224-277` for the supported client variants and connection flow.
