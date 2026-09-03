# Morrow

Models reason. Morrow safely operates learning systems.

Morrow is a local, model-neutral LMS operations layer for MCP-compatible AI clients. It provides typed Canvas operations, bounded authority, reviewed plans, separate approval, durable effect records, fresh provider readback, multi-course execution, privacy controls, and evidence.

## Current implementation

The repository is beginning with a federation gateway because the capabilities already exist in two private donor systems:

- `morrow-legacy` contains the existing Morrow Canvas catalog, planners, approval projections, privacy controls, workflows, reports, and browser-backed operations.
- `chcp-team-agent-kit` contains Meridian's typed MCP surface, provider binding, durable effect broker, batch recovery, workspace state, and failure history.

The first branch connects Meridian as an internal stdio MCP upstream and exposes its permitted tools through a new official-SDK Morrow server. A deterministic exporter inventories the current Canvas-facing Morrow catalog for reconciliation. The gateway is then extended with one bounded Morrow execution bridge rather than recreating hundreds of working handlers.

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
- `morrow_catalog` searches the merged catalog and shows the exact upstream mapping, aliases, and held-tool count.

Every forwarded result receives bounded `io.morrow/gateway` metadata containing the public tool name, source id, source tool name, catalog digest, and upstream result digest.

## Morrow catalog export

```bash
export MORROW_LEGACY_ROOT=/absolute/path/to/morrow-legacy
pnpm catalog:legacy
```

The exporter refuses a donor checkout at the wrong commit or with tracked changes. Its output is written to `artifacts/catalogs/` and is not committed by default.

## Documentation

- [Weekend convergence implementation](docs/implementation/WEEKEND-CONVERGENCE.md)
- [ADR-001: Federated convergence](docs/architecture/ADR-001-federated-convergence.md)
- [Donor manifest](docs/sources/donor-manifest.json)

## Source rule

The donor repositories remain private reference systems. This repository accepts only new source, publication-cleared source, synthetic fixtures, and reviewed origin records. It does not accept private CHCP material, real course content, credentials, harvested publisher methods, or copied private deployment configuration.
