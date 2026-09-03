# Morrow

Models reason. Morrow safely operates learning systems.

Morrow is a local, model-neutral LMS operations layer for MCP-compatible AI clients. It provides typed Canvas operations, bounded authority, reviewed plans, separate approval, durable effect records, fresh provider readback, multi-course execution, privacy controls, and evidence.

Start with [WEEKEND-HANDOFF.md](WEEKEND-HANDOFF.md). Also see [ARCHITECTURE.md](ARCHITECTURE.md), [SOURCE-ORIGIN.md](SOURCE-ORIGIN.md), and [LIMITATIONS.md](LIMITATIONS.md).

## Current implementation

The repository begins with a federation gateway because the capabilities already exist in two private donor systems:

- `example-legacy` contains the existing Morrow Canvas catalog, planners, approval projections, privacy controls, workflows, reports, and browser-backed operations.
- `example-attestation-repo` contains ExamplePlatform's typed MCP surface, provider binding, durable effect broker, batch recovery, workspace state, and failure history.

The current branch connects ExamplePlatform and other configured MCP processes as internal stdio upstreams and exposes their permitted tools through a new official-SDK Morrow server. Deterministic commands export the current Morrow Canvas catalog, capture live upstream catalogs, and generate an exact compatibility and source-selection report.

Checkpoint C now adds the bounded Morrow legacy extension bridge. It presents the donor's exported Canvas catalog as an internal MCP server, connects to the existing browser service worker over an authenticated loopback WebSocket, executes admitted reads through the donor runtime, and converts every write request into an ordinary donor task awaiting separate approval. It does not recreate or bypass the existing handlers.

## Provider boundary

Canvas is the initial provider. MindTap and Connect are removed from the merged catalog and remain outside supported claims pending written permission or formal developer terms.

## Quick start with ExamplePlatform

Requirements:

- Node.js 22.12 or newer
- pnpm 10.6.1 through Corepack
- A local checkout of `example-attestation-repo` at the pinned donor revision

```bash
corepack enable
pnpm install
pnpm build
cp morrow.upstreams.example.json morrow.upstreams.json
export MORROW_MERIDIAN_SERVER_PATH=/absolute/path/to/example-attestation-repo/scripts/team/mcp/meridian_server.py
pnpm start
```

The local configuration file is ignored by Git. It may contain paths, but it must not contain provider credentials. ExamplePlatform continues to own its existing credential and provider authority during this convergence checkpoint.

## Add the Morrow legacy browser runtime

First export the donor catalog while the legacy checkout is clean:

```bash
MORROW_LEGACY_ROOT=/absolute/path/to/example-legacy pnpm catalog:legacy
```

Then create a pairing token, install the reversible extension overlay, and use the two-upstream example:

```bash
export MORROW_NEW_REPO_ROOT=$PWD
export MORROW_LEGACY_ROOT=/absolute/path/to/example-legacy
export MORROW_LEGACY_CATALOG_PATH=$PWD/artifacts/catalogs/example-legacy.canvas.json
export MORROW_LEGACY_BRIDGE_TOKEN="$(node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))")"
pnpm bridge:legacy:install
cp morrow.upstreams.with-legacy-bridge.example.json morrow.upstreams.json
export MORROW_MERIDIAN_SERVER_PATH=/absolute/path/to/example-attestation-repo/scripts/team/mcp/meridian_server.py
pnpm start
```

Reload the unpacked Morrow legacy extension after installing the overlay. The gateway starts the internal bridge MCP, which listens only on `127.0.0.1` and authenticates the extension before accepting binding or tool messages.

A bridge write returns an approval-required task. Approve or deny it through the existing Morrow user surface. There is no model-callable bridge approval tool.

## Built-in inspection tools

Gateway tools:

- `morrow_health` reports gateway readiness, source connection state, catalog counts, and the catalog digest.
- `morrow_catalog` searches a paginated projection of the merged catalog. It returns source mappings and schema digests rather than full schemas or raw upstream metadata.

Morrow legacy bridge tools:

- `morrow_legacy_bridge_health`
- `morrow_legacy_bindings`
- `morrow_legacy_task_get`

Every forwarded result receives bounded `io.morrow/gateway` metadata containing the public tool name, source id, source tool name, catalog digest, and upstream result digest. Raw upstream `_meta` is discarded.

## Donor catalog workflow

```bash
MORROW_CAPTURE_SOURCE=meridian pnpm catalog:capture
MORROW_LEGACY_ROOT=/absolute/path/to/example-legacy pnpm catalog:legacy
pnpm catalog:reconcile -- \
  --source artifacts/catalogs/meridian.live.json \
  --source artifacts/catalogs/example-legacy.canvas.json \
  --aliases config/catalog-aliases.proposed.json
```

Generated donor catalogs and reconciliation output live under `artifacts/catalogs/` and are ignored by default. The donor export refuses the wrong commit or tracked changes. Contract drift cannot be auto-selected by source priority.

## MCP client install

The public Morrow endpoint is a local stdio server. After `pnpm install` and `pnpm build`, the root script `pnpm start` runs `@morrow/mcp-server` (`node dist/index.js`). That package declares the bin `morrow-mcp`. `packages/mcp-server/src/server.ts` calls `serveStdio`.

Start the process from the repository root. The gateway loads `morrow.upstreams.json` from the process working directory, or from `MORROW_UPSTREAMS_FILE` when that variable is set. If that file is absent, set `MORROW_MERIDIAN_SERVER_PATH`. Optional `MORROW_PYTHON_COMMAND` defaults to `python3`.

Example upstream files that exist in this repository:

- `morrow.upstreams.example.json`
- `morrow.upstreams.with-legacy-bridge.example.json`

Named tools registered in this repository:

- Gateway: `morrow_health`, `morrow_catalog`
- Legacy bridge, when that upstream is enabled: `morrow_legacy_bridge_health`, `morrow_legacy_bindings`, `morrow_legacy_task_get`

The gateway also forwards tools imported from connected upstreams. Do not add tool names that are not registered in code.

A client config file path is not in this repository. The JSON below wraps the stdio command the server actually runs.

### Codex

Config file path not in repo; this is the stdio command the server actually runs.

```json
{
  "mcpServers": {
    "morrow": {
      "command": "pnpm",
      "args": ["start"],
      "env": {
        "MORROW_MERIDIAN_SERVER_PATH": "/absolute/path/to/example-attestation-repo/scripts/team/mcp/meridian_server.py"
      }
    }
  }
}
```

### Claude Code / Claude Desktop

Config file path not in repo; this is the stdio command the server actually runs.

```json
{
  "mcpServers": {
    "morrow": {
      "command": "pnpm",
      "args": ["start"],
      "env": {
        "MORROW_MERIDIAN_SERVER_PATH": "/absolute/path/to/example-attestation-repo/scripts/team/mcp/meridian_server.py"
      }
    }
  }
}
```

### Gemini CLI

Config file path not in repo; this is the stdio command the server actually runs.

```json
{
  "mcpServers": {
    "morrow": {
      "command": "pnpm",
      "args": ["start"],
      "env": {
        "MORROW_MERIDIAN_SERVER_PATH": "/absolute/path/to/example-attestation-repo/scripts/team/mcp/meridian_server.py"
      }
    }
  }
}
```

Equivalent bin after `pnpm build`, from the repository root:

```json
{
  "command": "pnpm",
  "args": ["exec", "morrow-mcp"],
  "env": {
    "MORROW_MERIDIAN_SERVER_PATH": "/absolute/path/to/example-attestation-repo/scripts/team/mcp/meridian_server.py"
  }
}
```

For the two-upstream example, copy `morrow.upstreams.with-legacy-bridge.example.json` to `morrow.upstreams.json` and add the environment variables already documented in the Quick start and bridge sections (`MORROW_NEW_REPO_ROOT`, `MORROW_LEGACY_CATALOG_PATH`, `MORROW_LEGACY_BRIDGE_TOKEN`).

## Documentation

Named root files:

- [Limitations](LIMITATIONS.md)
- [Source origin](SOURCE-ORIGIN.md)
- [Architecture](ARCHITECTURE.md)
- [Weekend handoff](WEEKEND-HANDOFF.md)

Implementation notes and ADRs:

- [Weekend convergence implementation](docs/implementation/EXAMPLE-WORKTREE.md)
- [Catalog capture and reconciliation](docs/implementation/CATALOG-RECONCILIATION.md)
- [Morrow legacy extension bridge](docs/implementation/MORROW-LEGACY-BRIDGE.md)
- [ADR-001: Federated convergence](docs/architecture/ADR-001-federated-convergence.md)
- [ADR-002: Authenticated legacy extension bridge](docs/architecture/ADR-002-local-extension-bridge.md)
- [Donor manifest](docs/sources/donor-manifest.json)

## Source rule

The donor repositories remain private reference systems. This repository accepts only new source, publication-cleared source, synthetic fixtures, and reviewed origin records. It does not accept private CHCP material, real course content, credentials, harvested publisher methods, or copied private deployment configuration.
