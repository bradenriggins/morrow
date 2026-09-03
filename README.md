# Morrow

Models reason. Morrow safely operates learning systems.

Morrow is a local, model-neutral LMS operations layer for MCP-compatible AI clients. It provides typed Canvas operations, bounded authority, reviewed plans, separate approval, durable effect records, fresh provider readback, multi-course execution, privacy controls, and evidence.

## Current implementation

The repository begins with a federation gateway because the capabilities already exist in two private donor systems:

- `morrow-legacy` contains the existing Morrow Canvas catalog, planners, approval projections, privacy controls, workflows, reports, and browser-backed operations.
- `chcp-team-agent-kit` contains Meridian's typed MCP surface, provider binding, durable effect broker, batch recovery, workspace state, and failure history.

The current branch connects Meridian and other configured MCP processes as internal stdio upstreams and exposes their permitted tools through a new official-SDK Morrow server. Deterministic commands export the current Morrow Canvas catalog, capture live upstream catalogs, and generate an exact compatibility and source-selection report. The gateway will then add one bounded Morrow execution bridge rather than recreating hundreds of working handlers.

## Provider boundary

Canvas is the initial provider. MindTap and Connect are removed from the merged catalog and remain outside supported claims pending written permission or formal developer terms.

## Quick start

Requirements:

- Node.js 22.12 or newer
- pnpm 10.6.1 through Corepack
- A local checkout of `chcp-team-agent-kit` at the pinned donor revision

```bash
corepack enable
pnpm install
pnpm build
cp morrow.upstreams.example.json morrow.upstreams.json
export MORROW_MERIDIAN_SERVER_PATH=/absolute/path/to/chcp-team-agent-kit/scripts/team/mcp/meridian_server.py
pnpm start
```

The local configuration file is ignored by Git. It may contain paths, but it must not contain provider credentials. Meridian continues to own its existing credential and provider authority during this convergence checkpoint.

## Built-in inspection tools

- `morrow_health` reports gateway readiness, source connection state, catalog counts, and the catalog digest.
- `morrow_catalog` searches a paginated projection of the merged catalog. It returns source mappings and schema digests rather than full schemas or raw upstream metadata.

Every forwarded result receives bounded `io.morrow/gateway` metadata containing the public tool name, source id, source tool name, catalog digest, and upstream result digest. Raw upstream `_meta` is discarded.

## Donor catalog workflow

```bash
MORROW_CAPTURE_SOURCE=meridian pnpm catalog:capture
MORROW_LEGACY_ROOT=/absolute/path/to/morrow-legacy pnpm catalog:legacy
pnpm catalog:reconcile -- \
  --source artifacts/catalogs/meridian.live.json \
  --source artifacts/catalogs/morrow-legacy.canvas.json \
  --aliases config/catalog-aliases.proposed.json
```

Generated donor catalogs and reconciliation output live under `artifacts/catalogs/` and are ignored by default. The donor export refuses the wrong commit or tracked changes. Contract drift cannot be auto-selected by source priority.

## Documentation

- [Weekend convergence implementation](docs/implementation/WEEKEND-CONVERGENCE.md)
- [Catalog capture and reconciliation](docs/implementation/CATALOG-RECONCILIATION.md)
- [ADR-001: Federated convergence](docs/architecture/ADR-001-federated-convergence.md)
- [Donor manifest](docs/sources/donor-manifest.json)

## Source rule

The donor repositories remain private reference systems. This repository accepts only new source, publication-cleared source, synthetic fixtures, and reviewed origin records. It does not accept private CHCP material, real course content, credentials, harvested publisher methods, or copied private deployment configuration.
