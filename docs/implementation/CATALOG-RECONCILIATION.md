# Donor catalog capture and reconciliation

Checkpoint B converts both donor tool surfaces into deterministic source catalogs and produces a reviewable mapping report. It does not choose semantic aliases from names alone and it does not make an unexecutable donor catalog publicly callable.

## Artifact contract

Every source catalog uses `morrow.source-catalog.v1` and contains:

- source id, label, kind, repository, revision, and capture timestamp;
- a duplicate-free sorted tool list;
- input and optional output schemas;
- standard MCP annotations;
- a digest that excludes the capture timestamp so two identical captures compare equal.

Raw upstream `_meta` is not admitted to a source catalog.

## Capture Meridian

Configure `morrow.upstreams.json`, then run:

```bash
pnpm catalog:capture
```

To capture only Meridian:

```bash
MORROW_CAPTURE_SOURCE=meridian pnpm catalog:capture
```

The default output is `artifacts/catalogs/meridian.live.json`.

## Export Morrow legacy

```bash
MORROW_LEGACY_ROOT=/absolute/path/to/morrow-legacy pnpm catalog:legacy
```

The exporter requires the pinned donor commit by default, refuses tracked donor changes, and verifies the 270-row current Canvas-facing surface before writing `artifacts/catalogs/morrow-legacy.canvas.json`.

## Reconcile

```bash
pnpm catalog:reconcile -- \
  --source artifacts/catalogs/meridian.live.json \
  --source artifacts/catalogs/morrow-legacy.canvas.json \
  --aliases config/catalog-aliases.proposed.json \
  --output artifacts/catalogs/reconciliation.json
```

The report separates:

- exact-name compatible contracts;
- exact-name contract drift;
- explicit cross-name alias groups;
- source-only tools;
- selected mappings that can be automated;
- unresolved rows that require a human source and behavior decision.

An exact-name or alias row with different input or output contracts receives `contract_drift`, `selected: null`, and `reviewRequired: true`. Source priority cannot override contract drift.

## Proposed aliases

`config/catalog-aliases.proposed.json` contains the first five repository-supported naming hypotheses for pages and modules. They are proposals, not accepted mappings. Reconciliation fails if any referenced tool is absent, and a proposed mapping remains unresolved when the schemas differ.

## Publication rule

Catalog artifacts are ignored build outputs. They prove what a donor exposed at a revision. They do not grant permission to copy source, descriptions, private policy, fixtures, or provider methods into a public release.
