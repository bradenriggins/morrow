# Weekend handoff

The living checklist is [`docs/implementation/WEEKEND-CONVERGENCE.md`](docs/implementation/WEEKEND-CONVERGENCE.md). This file maps that note. If they differ, the implementation note wins.

## Current checkpoint

This branch establishes the gateway foundation, donor catalog reconciliation, and the first executable Morrow legacy browser bridge.

Morrow can connect to one or more internal stdio MCP upstreams, import typed tool lists, remove held MindTap and Connect tools, resolve exact-name collisions, register the merged tools through the official TypeScript SDK, and forward calls back to the source that owns them.

Checkpoint C adds an authenticated loopback WebSocket server and a reversible extension overlay. Read tools execute through the current donor runtime. Write tools are staged into the donor task store and remain blocked on the existing human approval surface.

## Checkpoint status

Copy the status from the living checklist. Do not advance a checkpoint here first.

### Checkpoint B: donor receipts

Implemented in code, awaiting execution against Braden's pinned local donor checkouts.

- Run the capture and export commands.
- Review every initial alias and contract-drift row.
- Commit only the public-safe decision map, not raw private catalog artifacts.

### Checkpoint C: Morrow execution bridge

Implemented behind a local overlay, awaiting packed-extension proof.

- The bridge is loopback-only and authenticated.
- Browser-dependent reads remain in the legacy runtime.
- Browser-dependent writes become ordinary staged tasks.
- The MCP caller cannot mint approval.
- Connection loss after send is unknown and is never auto-replayed.

See `docs/implementation/MORROW-LEGACY-BRIDGE.md` for installation and proof commands.

### Checkpoint D: unified operation truth

Next engineering checkpoint. Not done.

- Add a gateway operation record for every forwarded call without replacing source-owned effect truth.
- Persist source, catalog, request, bridge operation, staged-task, and upstream result digests.
- Add durable batch manifests that reference source-owned child operations.
- Recover gateway calls after process restart without replaying an ambiguous source command.
- Add fault tests for process loss, ambiguous bridge delivery, partial batch completion, and source reconnect.

### Checkpoint E: candidate assembly

Future. Not done.

- Install in Codex, Claude Code, Gemini CLI, and an MCP inspection client.
- Run the same read, planned write, approved write, readback, and multi-course scenarios through every client.
- Produce the source, capability, privacy, and release receipts for `1.0.0-rc.0`.

## Local start sequences

Meridian only:

```bash
corepack enable
pnpm install
pnpm build
cp morrow.upstreams.example.json morrow.upstreams.json
export MORROW_MERIDIAN_SERVER_PATH=/absolute/path/to/chcp-team-agent-kit/scripts/team/mcp/meridian_server.py
pnpm start
```

Meridian plus Morrow legacy:

```bash
MORROW_LEGACY_ROOT=/absolute/path/to/morrow-legacy pnpm catalog:legacy
export MORROW_NEW_REPO_ROOT=$PWD
export MORROW_LEGACY_ROOT=/absolute/path/to/morrow-legacy
export MORROW_LEGACY_CATALOG_PATH=$PWD/artifacts/catalogs/morrow-legacy.canvas.json
export MORROW_LEGACY_BRIDGE_TOKEN="$(node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))")"
pnpm bridge:legacy:install
cp morrow.upstreams.with-legacy-bridge.example.json morrow.upstreams.json
export MORROW_MERIDIAN_SERVER_PATH=/absolute/path/to/chcp-team-agent-kit/scripts/team/mcp/meridian_server.py
pnpm start
```

The public server writes protocol messages only to standard output. Operational messages use standard error.

## Catalog sequence

```bash
MORROW_CAPTURE_SOURCE=meridian pnpm catalog:capture
MORROW_LEGACY_ROOT=/absolute/path/to/morrow-legacy pnpm catalog:legacy
pnpm catalog:reconcile -- \
  --source artifacts/catalogs/meridian.live.json \
  --source artifacts/catalogs/morrow-legacy.canvas.json \
  --aliases config/catalog-aliases.proposed.json
```

See `docs/implementation/CATALOG-RECONCILIATION.md` for the artifact and decision rules.

## Stop conditions

Stop the branch when any change would:

- copy private CHCP material into the new repository
- publish MindTap or Connect methods
- add a direct Canvas route to the gateway
- let a tool bypass its owning authority or approval path
- silently replace a duplicate tool
- forward raw upstream metadata
- auto-select a contract-drift row
- infer a semantic alias without an explicit reviewed rule
- return an upstream error with unreviewed raw details
- expose the bridge pairing token through URLs, MCP output, logs, or committed source
- allow a non-loopback bridge listener
- let the MCP surface approve, resume, undo, or otherwise act on a donor task
- report a possibly applied write as successful without source-owned readback

## Related records

- `docs/implementation/WEEKEND-CONVERGENCE.md`
- `docs/implementation/MORROW-LEGACY-BRIDGE.md`
- `docs/implementation/CATALOG-RECONCILIATION.md`
