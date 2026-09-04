# Architecture

Morrow is one local operations layer between an MCP-compatible AI client and a signed-in Canvas session.

```text
ChatGPT/Codex, Claude, Gemini, or another MCP client
                         |
                         | stdio MCP
                         v
                  Morrow MCP server
       catalog | policy | journal | batches | privacy
                         |
                         | authenticated loopback WebSocket
                         v
              Morrow Canvas Connector
                         |
                         | signed-in Chrome session
                         v
      Canvas API and New Quizzes Item Bank services
```

The MCP client is replaceable. The browser session is replaceable. Morrow's operation IDs, approval rules, effect receipts, result envelope, batch records, and verification states stay stable.

## Component boundaries

### Morrow MCP

The root stdio server is the only MCP endpoint a client installs.

It owns:

- the generated, typed catalog;
- profile and source selection;
- canonical `morrow.result.v1` responses;
- privacy projection and learner tokenization;
- frozen write plans;
- a local approval server;
- the durable operation and effect journal;
- encrypted batch manifests and child state;
- result paging, diagnostics, and evidence.

It does not own Canvas credentials. It cannot create its own human approval.

### Canvas connector MCP

The root server starts the Canvas connector as an internal stdio child. This child owns the authenticated loopback server on `127.0.0.1:32147`.

It validates:

- the extension ID;
- the catalog digest;
- the connector revision;
- the pairing secret;
- the protocol version;
- request ID and operation ID;
- exact operation key;
- source binding;
- connection generation;
- command expiry;
- single-use outer effect receipt.

The child is an implementation detail of the Morrow MCP installation. Users do not configure it as a second client server.

### Chrome extension

The Manifest V3 extension initiates the loopback connection. It has no side panel and no chat interface.

The extension owns:

- local pairing;
- exact-site optional permission;
- current Canvas principal and course binding;
- session-generation changes;
- browser-session request transport;
- CSRF handling;
- Item Bank frame execution;
- provider readback immediately after writes;
- pairing and permission revocation.

The production manifest has no blanket Canvas host permission. It asks for one HTTPS origin when the user connects a tab. It does not use cookie APIs, remote code, native messaging, or Chrome DevTools Protocol.

## Catalog architecture

`scripts/generate-canvas-api-catalog.mjs` builds one deterministic catalog from the current official Canvas API definitions and Morrow's explicit signed-browser Item Bank contract. The same generated file is embedded in the MCP connector and the extension.

Each row contains:

- one stable tool name and operation key;
- method and path;
- exact path, query, and body parameter mapping;
- JSON Schema input contract;
- read or write classification;
- risk class;
- capability family;
- profile state;
- dispatch and readback owner;
- authority and privacy metadata.

Startup refuses a digest mismatch. The loopback handshake refuses an extension with a different digest. No runtime route is invented from model text.

## Read flow

1. The AI client calls one generated read tool.
2. Morrow validates the schema and selected profile.
3. The connector validates the exact current Canvas binding.
4. The extension executes the generated route in the signed-in session.
5. The gateway projects and bounds the response.
6. Morrow returns a canonical read result with source and catalog evidence.

A disconnect during a safe read can fail or reconnect. It never changes write replay rules.

## Write flow

1. The AI client calls one generated write tool with an exact `source_binding_id`.
2. Morrow freezes the public tool, provider route, arguments, target set, profile, account, principal, connection generation, catalog digest, risk, expiry, and readback comparator.
3. Morrow records the plan durably and returns an operation ID, plan digest, and local approval URL.
4. A person opens that URL. The page reads the durable plan directly and can approve once or cancel. MCP exposes no approval tool.
5. `morrow_operation_dispatch` recomputes current authority and refuses stale approval, binding, profile, catalog, account, principal, or target state.
6. The effect broker reserves one durable effect receipt before provider dispatch.
7. The connector consumes that receipt once and sends one browser-session request.
8. The connector performs the frozen fresh readback.
9. Morrow records `verified`, `unconfirmed`, `failed`, or `applied_or_unknown` from evidence. It never maps an HTTP success alone to verified success.

An uncertain send is not replayed. Reconciliation runs the readback only. Undo is a new planned and approved corrective operation.

## New Quizzes and Item Banks

Official New Quizzes operations use the documented `/quiz/v1` routes and request formats. New Quiz item create and update operations send complete JSON bodies so nested interaction and scoring structures remain intact.

Item Bank endpoints are available only inside authenticated New Quizzes frames. The extension executes these requests in the page's main world. It validates the Canvas referrer origin and course before use. It strips token-like fields from returned values. The frame token never crosses into extension storage, the loopback protocol, MCP output, logs, or client configuration.

All twelve Item Bank operations share the same schema, authority, approval, one-send, and readback rules as other Canvas operations.

## Batch flow

A batch freezes one exact child operation for each target. Write batches use one complete loopback approval page, but each child receives a separate grant and effect receipt. The scheduler applies bounded concurrency and rate policy. Child results settle independently.

Batch state is durable in SQLite. Arguments and manifests use authenticated encryption. Restart recovery returns interrupted writes to inspection or readback. It does not infer success and does not send them again.

## Trust boundaries

- **AI client:** may choose and call tools. MCP exposes no approval tool. A separate local page records approval, but it cannot prove human presence against local HTTP or browser automation.
- **Morrow MCP:** may plan and reserve effects; has no Canvas secret.
- **Approval page:** may approve only one exact, unexpired durable plan on loopback.
- **Extension:** may use only paired commands, admitted operations, current bindings, and unused receipts.
- **Chrome page:** owns the live Canvas and Item Bank secrets.
- **Canvas:** is authoritative for final provider state.

## Accepted decisions

- [ADR-001: Standalone Canvas operations layer](docs/architecture/ADR-001-federated-convergence.md)
- [ADR-002: Authenticated Chrome session connector](docs/architecture/ADR-002-local-extension-bridge.md)
