# Weekend convergence implementation

## Current checkpoint

This branch establishes Checkpoint A: a running Morrow MCP process that can connect to ExamplePlatform as an internal stdio upstream, import its typed tool list, remove held publisher tools, resolve name collisions, register the merged tools through the official TypeScript SDK, and forward calls back to the source that owns them.

It also adds a deterministic exporter for the current Canvas-facing catalog in `example-legacy`. The exporter runs against an exact donor commit, refuses tracked donor changes, verifies the expected tool count, and writes an origin-bound catalog artifact outside the committed source tree.

## What is implemented

- Clean pnpm and TypeScript workspace.
- Shared catalog and result contracts.
- Deterministic catalog merge with stable aliases and a catalog digest.
- MindTap and Connect prefix holds at catalog construction time.
- ExamplePlatform stdio MCP client using the official client package.
- Morrow stdio MCP server using the official server package.
- `morrow_health` and `morrow_catalog` inspection tools.
- Upstream call forwarding with bounded source metadata.
- Source configuration through a local ignored file or environment variables.
- Morrow legacy Canvas catalog exporter.
- Unit tests for collision handling, provider holds, digest stability, result wrapping, and configuration expansion.

## Local start sequence

```bash
corepack enable
pnpm install
pnpm build
cp morrow.upstreams.example.json morrow.upstreams.json
export MORROW_MERIDIAN_SERVER_PATH=/absolute/path/to/example-attestation-repo/scripts/team/mcp/meridian_server.py
pnpm start
```

The server writes protocol messages only to standard output. Operational messages use standard error.

## Catalog export

```bash
export MORROW_LEGACY_ROOT=/absolute/path/to/example-legacy
pnpm catalog:legacy
```

The generated file is `artifacts/catalogs/example-legacy.canvas.json`. It is ignored by Git because it is a donor-derived build artifact and must pass source review before any part is admitted to a release.

## Next checkpoints

### Checkpoint B: catalog reconciliation

- Export the current Morrow Canvas catalog.
- Save the live ExamplePlatform catalog from `tools/list`.
- Generate an exact same-name, alias, semantic-overlap, and source-only report.
- Establish the first mapping table for shared Canvas operations.

### Checkpoint C: Morrow execution bridge

- Add one local bridge contract for browser-dependent Morrow operations.
- Expose only tools whose authority, approval, and readback paths are already active.
- Keep the browser bridge below the catalog and above no provider route authority.

### Checkpoint D: unified operation truth

- Place gateway-level operations, batches, and source transitions behind one durable journal.
- Reuse the donor effect and batch behavior without allowing the gateway to report success independently.
- Add fault tests for process loss, ambiguous dispatch, partial batch completion, and restart.

### Checkpoint E: candidate assembly

- Install in Codex, Claude Code, Gemini CLI, and an MCP inspection client.
- Run the same read, planned write, approved write, readback, and multi-course scenarios through every client.
- Produce the source, capability, privacy, and release receipts for `1.0.0-rc.0`.

## Stop conditions

Stop the branch when any change would:

- copy private CHCP material into the new repository;
- publish MindTap or Connect methods;
- add a direct Canvas route to the gateway;
- let a tool bypass its owning authority or approval path;
- silently replace a duplicate tool;
- return an upstream error with unreviewed raw details;
- report a possibly applied write as successful without source-owned readback.
