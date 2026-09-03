# Weekend convergence implementation

## Current checkpoint

This branch establishes the gateway foundation and the catalog-reconciliation machinery. Morrow can connect to one or more internal stdio MCP upstreams, import typed tool lists, remove held MindTap and Connect tools, resolve exact-name collisions, register the merged tools through the official TypeScript SDK, and forward calls back to the source that owns them.

It also contains deterministic tools to export the 270-row current Canvas-facing catalog from `example-legacy`, capture the live catalog of configured MCP upstreams, and reconcile exact names and explicitly reviewed semantic aliases.

## What is implemented

- Clean pnpm and TypeScript workspace.
- Shared catalog and result contracts.
- Deterministic catalog merge with stable aliases and a catalog digest.
- MindTap and Connect prefix holds at catalog construction time.
- Official MCP stdio clients for internal upstreams.
- Official MCP stdio server for the public Morrow endpoint.
- `morrow_health` and a paginated, schema-digest-only `morrow_catalog` inspection tool.
- Upstream call forwarding with bounded source metadata.
- Raw upstream tool metadata and result metadata are dropped at the gateway boundary.
- Source configuration through a local ignored file or environment variables.
- Exact-revision Morrow legacy Canvas catalog exporter.
- Live upstream catalog capture without persisting commands, environment variables, or local paths.
- Deterministic reconciliation for exact-name compatibility, contract drift, explicit alias groups, source-only rows, and selected mappings.
- Unit tests for collision handling, provider holds, digest stability, result wrapping, metadata refusal, source-catalog integrity, reconciliation, and configuration expansion.
- A two-upstream process integration test that starts real fake MCP servers, lists tools, filters held providers, resolves a collision, forwards calls to both owners, checks source metadata, bounds catalog inspection output, and closes both child processes.

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

## Catalog sequence

```bash
MORROW_CAPTURE_SOURCE=meridian pnpm catalog:capture
MORROW_LEGACY_ROOT=/absolute/path/to/example-legacy pnpm catalog:legacy
pnpm catalog:reconcile -- \
  --source artifacts/catalogs/meridian.live.json \
  --source artifacts/catalogs/example-legacy.canvas.json \
  --aliases config/catalog-aliases.proposed.json
```

See `CATALOG-RECONCILIATION.md` for the artifact and decision rules.

## Next checkpoints

### Checkpoint B receipt

- Run the capture and export commands against the pinned donor checkouts.
- Review every initial alias and contract-drift row.
- Commit only the public-safe decision map, not the raw private catalog artifacts.

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
- forward raw upstream metadata;
- auto-select a contract-drift row;
- infer a semantic alias without an explicit reviewed rule;
- return an upstream error with unreviewed raw details;
- report a possibly applied write as successful without source-owned readback.
