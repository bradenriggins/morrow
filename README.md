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
- SSH access through the `example-lms-vps` host alias
- The generated ExamplePlatform source catalog at the pinned donor revision

```bash
corepack enable
pnpm install
pnpm build
cp morrow.upstreams.example.json morrow.upstreams.json
export MORROW_MERIDIAN_CATALOG_PATH=/absolute/path/to/meridian.live.json
pnpm start
```

The default example is a hermetic, read-only catalog profile. It runs the frozen server only through `ssh -T example-lms-vps`. It checks the remote Git revision and tracked-clean state before launch. It then requires the generated 222-tool catalog truth. The gateway removes the 35 held MindTap and Connect tools and exposes 187 eligible tools.

`morrow.upstreams.meridian-private.example.json` shows the private runtime profile and the generic-to-ExamplePlatform environment mapping. Replace its generic example identifiers and remote state paths with one exact private profile. Do not place raw tokens in the file. Use a ExamplePlatform-owned session, credential, or socket path.

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
export MORROW_MERIDIAN_CATALOG_PATH=/absolute/path/to/meridian.live.json
pnpm start
```

Reload the unpacked Morrow legacy extension after installing the overlay. The gateway starts the internal bridge MCP, which listens only on `127.0.0.1` and authenticates the extension before accepting binding or tool messages.

A bridge write returns an approval-required task. Approve or deny it through the existing Morrow user surface. There is no model-callable bridge approval tool.

## Built-in inspection tools

Gateway tools:

- `morrow_health` reports gateway readiness, source revision, generated catalog truth, tool counts and digests, connection generation, and bounded reconnect state.
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

The public Morrow endpoint is a local stdio server. After `pnpm install` and `pnpm build`, the root script `pnpm start` runs `@morrow/mcp-server` (`node dist/index.js`). The client-config package declares the unified `morrow` command. The public endpoint serves both MCP SDK protocol eras through one stdio factory.

Start the process from the repository root. The gateway loads `morrow.upstreams.json` from the process working directory, or from `MORROW_UPSTREAMS_FILE` when that variable is set. A ExamplePlatform source cannot use `MORROW_MERIDIAN_SERVER_PATH` for local startup. Use the first-class `meridian-ssh` configuration.

Example upstream files that exist in this repository:

- `morrow.upstreams.example.json`
- `morrow.upstreams.meridian-private.example.json`
- `morrow.upstreams.with-legacy-bridge.example.json`

Named tools registered in this repository:

- Gateway: catalog, profile, operation, batch, health, and bounded result-page tools under the `morrow_*` namespace.
- Legacy bridge, when that upstream is enabled: `morrow_legacy_bridge_health`, `morrow_legacy_bindings`, `morrow_legacy_task_get`

The gateway also forwards tools imported from connected upstreams. A request cancelled before dispatch does not call the source. A request cancelled after dispatch is recorded as source-unknown and must not be replayed. Large results return a process-local result handle. Read it with `morrow_result_page` in bounded pages.

Generate each project configuration after the build. Project scope is the default. The configuration's only environment setting is the absolute `MORROW_UPSTREAMS_FILE` path. It does not copy Canvas credentials, donor tokens, bridge tokens, or session data.

```bash
pnpm morrow mcp install codex --scope project --upstreams "$PWD/morrow.upstreams.json"
pnpm morrow mcp install claude --scope project --upstreams "$PWD/morrow.upstreams.json"
pnpm morrow mcp install gemini --scope project --upstreams "$PWD/morrow.upstreams.json"
pnpm morrow doctor --json --upstreams "$PWD/morrow.upstreams.json"
pnpm morrow conformance --json --upstreams "$PWD/morrow.upstreams.json"
```

The commands install these project-scoped files:

- Codex: `.codex/config.toml`
- Claude Code: `.mcp.json`
- Gemini CLI: `.gemini/settings.json`

`morrow conformance --json` is a deterministic configuration harness. It proves matching command, arguments, working directory, and allowed environment names. It does not prove that the installed Codex, Claude Code, or Gemini CLI binary can connect. Run each real client separately before making that claim.

Set `MORROW_MERIDIAN_CATALOG_PATH` when the selected upstream file uses the ExamplePlatform SSH adapter. For the two-upstream example, also set the legacy bridge variables documented above.

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
