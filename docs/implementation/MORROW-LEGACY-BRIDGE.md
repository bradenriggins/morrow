# Morrow legacy extension bridge

Status: development-only. This is the development adaptation path for the donor Morrow browser extension. It is not part of the Morrow 1.0 product.

- No public release profile contains it. `config/release-profiles.json` leaves `packages/legacy-bridge-mcp/` out of `public-canvas`, and `scripts/test/publication-policy.test.mjs` fails if a public profile ever selects it.
- No shipped Morrow configuration starts it. The only gateway configuration that names the `example-legacy` upstream is `morrow.upstreams.with-legacy-bridge.example.json`, which is a development example and says so.
- It cannot run without an external `example-legacy` donor checkout at revision `7275bfbc1c24dd6baff58f9435f1ce5a50fbb5d4`. A released copy does not have that checkout.
- The `private-full` source projection and the private desktop payload still carry the built package, because both copy every workspace package. Neither one starts it.

Everything below is development setup in this repository. No instructor step depends on it.

Checkpoint C connects the new MCP gateway to the existing Morrow browser runtime without copying or replacing its Canvas implementation.

## What this checkpoint does

The bridge has three layers:

1. `@morrow/bridge-protocol` defines the authenticated request, response, binding, heartbeat, and failure envelopes.
2. `@morrow/bridge-loopback` owns one WebSocket listener bound only to `127.0.0.1`.
3. `@morrow/legacy-bridge-mcp` presents the exported Morrow legacy catalog as an internal MCP server and forwards each call through the loopback bridge.

A local overlay installed into the frozen donor extension opens the WebSocket from its service worker and routes commands through the donor's existing runtime.

## Authority rule

The bridge is not a second executor.

- Read-only tools may run through the donor `executeTool` path after the extension resolves one runtime-verified Canvas source binding.
- A write tool never runs from the bridge command. The extension converts it into an ordinary `stageChatTask` record associated with the active Morrow conversation.
- The MCP server has no approval, confirmation, resume, undo, or bypass tool.
- Approval remains in the existing Morrow user surface. The donor task executor still owns pre-dispatch revalidation, pre-state capture, provider effect state, readback, partial outcomes, and recovery.
- `morrow_legacy_task_get` is inspection-only.

If a bridge response is lost after a command was sent, the server records the result as unknown and does not resend automatically.

## Build the source catalog first

The overlay binds itself to one exact donor revision and one exact source-catalog digest.

```bash
pnpm build
MORROW_LEGACY_ROOT=/absolute/path/to/example-legacy node scripts/export-example-legacy-catalog.mjs
```

The expected artifact is:

```text
artifacts/catalogs/example-legacy.canvas.json
```

Run this before installing the overlay because the exporter requires a clean donor checkout.

## Generate a pairing token

Generate a local token and keep it out of Git:

```bash
export MORROW_LEGACY_BRIDGE_TOKEN="$(node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))")"
```

The token is carried only in the first WebSocket message. It is not placed in the URL, catalog, MCP metadata, logs, or generated evidence.

## Install the donor overlay

```bash
export MORROW_LEGACY_ROOT=/absolute/path/to/example-legacy
export MORROW_LEGACY_CATALOG_PATH=$PWD/artifacts/catalogs/example-legacy.canvas.json
export MORROW_LEGACY_BRIDGE_TOKEN
node scripts/install-example-legacy-bridge.mjs
```

The installer:

- verifies the donor checkout is at `7275bfbc1c24dd6baff58f9435f1ce5a50fbb5d4`;
- refuses unrelated tracked changes;
- verifies the source catalog belongs to the same revision;
- adds a marked import and installer call to `extension/background.js`;
- copies the four bridge modules into the extension directory;
- writes a mode-`0600` local configuration module;
- adds the generated bridge modules to the donor checkout's local `.git/info/exclude`.

The tracked `background.js` patch is intentional and reversible. Remove it with:

```bash
MORROW_LEGACY_ROOT=/absolute/path/to/example-legacy node scripts/remove-example-legacy-bridge.mjs
```

## Start the internal bridge MCP

```bash
export MORROW_LEGACY_CATALOG_PATH=$PWD/artifacts/catalogs/example-legacy.canvas.json
export MORROW_LEGACY_EXPECTED_REVISION=7275bfbc1c24dd6baff58f9435f1ce5a50fbb5d4
export MORROW_LEGACY_BRIDGE_TOKEN
pnpm --filter @morrow/legacy-bridge-mcp start
```

It listens on:

```text
ws://127.0.0.1:32145/morrow-bridge/v1
```

The port may be changed with `MORROW_LEGACY_BRIDGE_PORT`. The server never binds a non-loopback interface.

For a packed or stable extension id, set:

```bash
export MORROW_LEGACY_ALLOWED_EXTENSION_IDS=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
```

When the allowlist is present, the WebSocket `Origin`, the hello envelope, and the configured extension id must agree.

## Add the bridge to the federation gateway

Copy `morrow.upstreams.with-legacy-bridge.example.json` to `morrow.upstreams.json` and provide these environment variables:

```bash
export MORROW_MERIDIAN_CATALOG_PATH=/absolute/path/to/meridian.live.json
export MORROW_LEGACY_CATALOG_PATH=$PWD/artifacts/catalogs/example-legacy.canvas.json
export MORROW_LEGACY_BRIDGE_TOKEN
pnpm start
```

ExamplePlatform remains the preferred source for exact-name collisions in the example. Morrow legacy retains its unique tool names and receives deterministic aliases when both donors advertise the same public name.

## Extension behavior

The donor adapter sends only a bounded binding projection:

- opaque source binding id;
- provider id;
- exact course id when known;
- course label when known;
- canonical Canvas origin when known;
- runtime-verification state and last-seen time.

For an incoming tool call, the adapter requires either:

- `_morrow.source_binding_id` naming one live binding;
- one unambiguous live binding for the requested `course_id`; or
- exactly one runtime-verified Canvas binding in the extension.

An ambiguous or missing binding fails before donor execution.

Writes also require an active, persisted Morrow conversation so the staged task appears in the existing approval surface and retains the selected source authority. The MCP caller cannot supply a different conversation id.

## Native bridge tools

`@morrow/legacy-bridge-mcp` adds three inspection tools:

- `morrow_legacy_bridge_health`
- `morrow_legacy_bindings`
- `morrow_legacy_task_get`

It deliberately does not add a task-action tool.

## Failure truth

| Condition | Reported state | Automatic resend |
|---|---|---|
| Extension not connected | `bridge_unavailable` | No |
| Command rejected before execution | typed bridge problem | No |
| Deadline or disconnect after send | `bridge_outcome_unknown` | No |
| Write accepted by extension | staged task with `approval_required` | Not applicable |
| Provider mutation | Still owned by donor task executor after separate approval | Not applicable |

## Current limits

- The bridge has automated protocol, authentication, collision, and fake-extension proof. It has not yet been exercised against Braden's live packed Morrow extension.
- The overlay targets the pinned donor revision. A new donor revision requires re-exporting the catalog and reviewing the patch anchors.
- Browser-session capabilities remain dependent on the existing extension and its live Canvas bindings.
- MindTap and Connect never enter the source catalog used by this bridge.
