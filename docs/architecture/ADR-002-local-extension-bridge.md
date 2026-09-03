# ADR-002: Authenticated loopback bridge for Morrow legacy

- Status: accepted for the private convergence profile
- Date: 2026-09-03
- Scope: browser-dependent Morrow legacy execution

## Decision

Use a local WebSocket connection initiated by the existing Manifest V3 service worker to a server bound only to `127.0.0.1`.

The bridge is a transport adapter over existing donor behavior. It is not a second Canvas client and it owns no provider success state.

## Why WebSocket

The donor runtime lives in a Manifest V3 service worker and already requires Chrome 127 or newer. A WebSocket connection can receive local commands without polling and can exchange an application heartbeat inside the service-worker idle window.

Native messaging was not selected because the donor extension does not currently request the permission or ship a native-host installation path. Chrome DevTools Protocol was not selected because the donor uses it for isolated test harnesses rather than production authority.

## Authentication and binding

The server:

- binds only `127.0.0.1`;
- accepts only `/morrow-bridge/v1`;
- requires a high-entropy token in the first message, never in the URL;
- validates the Chrome extension origin when present;
- optionally restricts one or more exact extension ids;
- requires the pinned donor revision and source-catalog digest;
- assigns a new connection generation after every authenticated reconnect;
- rejects results from an older generation or a different operation id.

The extension sends only a bounded projection of runtime-verified Canvas source bindings.

## Read behavior

A read request must name an admitted, model-visible donor capability whose current capability row classifies it as non-writing. The extension resolves an exact live source and calls the current donor execution runtime.

## Write behavior

A write request must name an admitted capability whose current capability row classifies it as writing. The extension does not execute it. It creates one existing `stageChatTask` operation under the active persisted conversation and returns the task id and approval-required state.

There is no MCP tool that creates approval or invokes `runChatTaskAction`.

## Failure rule

The local server sends each command at most once. If the deadline expires or the connection closes after send, the result is unknown. The caller must inspect the task or provider state before making a new request.

## Consequences

- Browser-only capabilities can be used by external MCP clients without recreating their handlers.
- The legacy task executor remains the mutation authority.
- The donor checkout receives a reversible local overlay during convergence.
- A packed-extension and live-Canvas proof is still required before this profile is release-ready.
