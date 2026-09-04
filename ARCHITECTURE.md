# Architecture

This file is an index. The accepted decisions live in the ADRs. Do not flatten ExamplePlatform and Morrow legacy into one implementation.

Morrow starts as a federation gateway. It wraps existing donor runtimes. It does not rewrite their capability implementations.

Browser-dependent Morrow legacy execution enters through one bounded local bridge. That bridge is a transport adapter. It is not a second Canvas client.

## ADR-001: Federated convergence

Record: [`docs/architecture/ADR-001-federated-convergence.md`](docs/architecture/ADR-001-federated-convergence.md)

Status: accepted for the first implementation branch.

The new repository begins as an external MCP gateway over existing donor runtimes.

- The gateway wraps those runtimes with the official TypeScript MCP SDK.
- ExamplePlatform runs as an internal stdio MCP upstream through `ssh -T example-lms-vps`.
- The gateway attests the frozen remote Git revision and tracked-clean state before launch.
- The gateway requires the generated ExamplePlatform catalog count and digest before readiness.
- Held provider tools are removed at the gateway boundary.
- A new connection generation is issued after each successful reconnect.
- Only failed read calls may reconnect and replay. A write with an ambiguous result is never replayed.
- The existing Morrow capability catalog is exported from `example-legacy` through a deterministic donor-side inventory script.
- The public-facing catalog is generated from connected sources.
- A deterministic collision policy retains the higher-priority source name and assigns a stable source-prefixed alias to the other mapping.
- MindTap and Connect names are removed before publication or registration.
- The gateway never constructs Canvas routes.
- The gateway never claims provider success on its own.
- The upstream that owns a tool remains responsible for its current policy, dispatch, and readback behavior during convergence.
- Result metadata records the exact upstream and catalog digest without exposing commands, credentials, or private paths.
- A duplicate tool name is never silently dropped.

The first candidate is a federated system. It is not yet a standalone replacement for both donors. Source extraction can occur behind stable gateway contracts after the joined system is running.

## ADR-002: Authenticated local extension bridge

Record: [`docs/architecture/ADR-002-local-extension-bridge.md`](docs/architecture/ADR-002-local-extension-bridge.md)

Status: accepted for the private convergence profile.

Scope: browser-dependent Morrow legacy execution.

- The existing Manifest V3 service worker opens a local WebSocket to a server bound only to `127.0.0.1`.
- The bridge is a transport adapter over existing donor behavior.
- The bridge owns no provider success state.
- Reads go through the current donor execution runtime after the extension resolves one admitted live Canvas binding.
- Writes do not execute from the bridge command. The extension creates one existing `stageChatTask` under the active persisted conversation.
- There is no MCP tool that creates approval or invokes `runChatTaskAction`.
- Each command is sent at most once. A lost response after send is unknown. The caller must inspect the task or provider state before a new request.

A packed-extension and live-Canvas proof is still required before this profile is release-ready.

## Join words used by the ADRs

Use these words as the ADRs use them. Do not collapse the two donors.

| Word | Meaning in this repository |
|---|---|
| wrap | The gateway is an external MCP surface over existing donor runtimes. |
| import | The gateway imports typed tool lists from connected stdio upstreams. |
| generate | The public catalog is generated from connected sources. |
| delegate | The upstream that owns a tool remains responsible for policy, dispatch, and readback. |
| bridge | Browser-dependent Morrow legacy execution enters through one authenticated loopback adapter. |
| join | Later extraction occurs after the joined system is running, behind stable gateway contracts. |

## Related records

- `docs/architecture/ADR-001-federated-convergence.md`
- `docs/architecture/ADR-002-local-extension-bridge.md`
