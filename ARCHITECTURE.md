# Architecture

Morrow is one local operations layer between an MCP-compatible AI client and a course platform. Canvas and Moodle work through a signed-in Chrome session. Blackboard works through the official Anthology Learn REST API with a local credential and no browser, and no live Blackboard tenant has been tested. [LIMITATIONS.md](LIMITATIONS.md) holds the canonical platform sentence and the evidence for each platform.

```text
Morrow desktop app
  writes the client configuration, verifies the sealed MCP payload,
  delivers Morrow Bridge, writes the optional Blackboard tenant file
                         |
                         | sets up and repairs; not in the request path
                         v
ChatGPT/Codex, Claude, Gemini, or another MCP client
                         |
                         | stdio MCP
                         v
                  Morrow MCP server
       catalog | policy | journal | batches | privacy
                         |
        +----------------+------------------+
        |                                   |
        | internal stdio child              | internal stdio child
        v                                   v
  Browser connector MCP               Blackboard REST server
  Canvas and Moodle catalogs          one configured tenant, live-untested
        |                                   |
        | authenticated loopback            | HTTPS with a local
        | WebSocket on 127.0.0.1:32147      | integration credential
        v                                   v
  Morrow Bridge, Chrome MV3           Anthology Learn REST API
        |
        | signed-in Chrome session
        |
        +--> Canvas API and New Quizzes Item Bank frames
        |
        +--> Moodle course forms and AJAX endpoints
```

The MCP client is replaceable. The browser session is replaceable. Morrow's operation IDs, approval rules, effect receipts, result envelope, batch records, and verification states stay the same for every platform.

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

It does not own a platform credential. The signed-in Chrome session holds the Canvas and Moodle credentials, and the REST child holds the configured tenant credential. It cannot create its own human approval.

### Browser connector MCP

The root server starts the browser connector as an internal stdio child. This child owns the authenticated loopback server on `127.0.0.1:32147`, and it carries Canvas and Moodle over that one protocol.

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
- single-use outer effect receipt;
- an exact expected form digest on every Moodle write.

The child is an implementation detail of the Morrow MCP installation. Users do not configure it as a second client server.

### Chrome extension

The Manifest V3 extension, Morrow Bridge, initiates the loopback connection. It has no side panel and no chat interface.

The extension owns:

- local pairing;
- exact-site optional permission;
- the current Canvas or Moodle principal and course binding;
- session-generation changes;
- browser-session request transport;
- CSRF handling;
- Item Bank frame execution and Moodle page-world execution;
- provider readback immediately after writes;
- pairing and permission revocation.

The production manifest has no blanket host permission for any course platform. It asks for one HTTPS origin when the user connects a tab. It does not use cookie APIs, remote code, native messaging, or Chrome DevTools Protocol.

### Moodle browser executor

The extension runs `connector/extension/src/moodle-executor.js` in the main world of the top frame of the signed-in Moodle tab.

It reads the page's own Moodle configuration for the site root, the signed-in user, and the course. It refuses when the tab origin or path is not that site, and when the course in the page does not match the course in that configuration.

It uses Moodle's own server-rendered forms and AJAX endpoints. There is no Moodle API token and no second Moodle sign-in. A change loads the complete form, merges only the reviewed fields into it, and posts the complete form back through the page session.

Immediately before it sends, it loads the form again and refuses when:

- the form digest is not the digest the caller reviewed;
- the page session key changed;
- the form action or its submit control moved;
- a file manager on the form already holds a file.

It classifies the result from the response, not from the status alone. A redirect away from the form is a sent change. A returned validation form is a mismatch that saved nothing. A lost response, or a response that stays on the form, is unconfirmed. An unconfirmed Moodle write is never reported as verified.

It strips session keys, state keys, CSRF fields, tokens, and draft item IDs from every value it returns, and it redacts those parameters from URLs in returned text.

`connector/extension/src/moodle-gradebook-executor.js` is a separate module with a narrow surface. It reads the gradebook configuration of one course, and its only change is a rename of one grade category or one manual grade item. It reads no student name, no student grade, and no stored grade value, and it changes nothing except the one reviewed name.

### Blackboard REST client

The root server starts `packages/blackboard-learn-api` as a second internal stdio child, `blackboard-rest`. It starts it only in the `private-full` profile, and only when the local Blackboard configuration file exists. No live Blackboard tenant has been tested, so every statement in this section is proved against local mocked-HTTPS tests only.

No browser takes part in this route. The child reads one local configuration: one HTTPS tenant origin, one application key, one locally stored application secret, one integration account, and the course bindings derived from that exact tenant account and course. It requests an OAuth2 client-credentials token from that origin and sends every request with that token. Its tools are defined in that package's own operation registry, not in the generated Canvas catalog.

Morrow's client-facing Blackboard operations are this child's reads and the root server's plan tool. Each read answers under its own name when the tool surface is `full`, and under the same name through `morrow_capability_read` when the tool surface is `compact`, which is the one the desktop app configures. The plan tool reads the integration account, that account's course membership, the learner roster, the course, and the content item through the child, then freezes the exact patch, the effect scope, and the readback comparator for review. Planning sends no PATCH request.

The apply and verification routes are private. The child registers them only for the Gateway process that launched it, under a dispatch secret that Gateway creates for that one process. The apply route checks the signed one-use effect grant and the exact reviewed plan digest before any provider read, re-reads the item, and refuses when a frozen protected field changed after review.

Learner identities are redacted inside this child before any result leaves it. When it cannot read the whole course roster, cannot resolve one course membership to a person, or cannot remove every learner identity from a field, it returns nothing from that course and names that condition. A result from this child then passes two Morrow boundaries: the source-result projection and the MCP egress boundary. Neither one applies the Canvas and Moodle roster lookup to it. Morrow holds no course roster for this source and can register none, so a roster requirement at either boundary would refuse every Blackboard result instead of protecting one. A result from this child that still carried a learner identity is refused there. Morrow decides this from the source that answered and the capability Morrow invoked, not from the `source_binding_id` in the request, so a Canvas or Moodle call cannot reach the exemption by naming a Blackboard binding. Every other projection still applies to a Blackboard result: secret fields, identity value fields, sensitive text, and the record and byte limits. [LIMITATIONS.md](LIMITATIONS.md) holds the exact operation, refusal, and evidence limits for this route.

### Desktop app and installer

The Morrow desktop app is an Electron application in `installer/`. It sets Morrow up, repairs it, and updates it. It is not in the request path: no assistant request passes through it.

It owns:

- assistant detection, and the Morrow entry in the configuration of each assistant it set up: it writes that entry, writes it again for every configured assistant when the materials folder changes, and removes it on request, each time only while the file on disk still matches the file Morrow wrote;
- verification of the sealed MCP payload against its manifest of file digests, which with a gateway health answer is the only way the runtime reports `ready`;
- the app-owned Morrow Bridge folder that Chrome loads, its staged updates, and its rollback copies;
- the optional Blackboard tenant configuration and credential files, written with restricted permissions and confirmed by reading their digests back, for a Blackboard route with no live-tenant evidence;
- application updates from the one configured stable feed, which stay disabled outside a packaged stable build.

It does not restart or rewrite a running installation on its own. Repair and update need the local-owner maintenance lease first, and they stop when work is in flight or when Morrow cannot confirm that the installation is idle. A materials-folder change, an assistant removal, and the in-app data removal stop under that same condition.

## Catalog architecture

`scripts/generate-canvas-api-catalog.mjs` builds one deterministic catalog from the current official Canvas API definitions and Morrow's explicit signed-browser Item Bank contract. The same generated file is embedded in the MCP connector and the extension.

Two browser catalogs sit beside it, `connector/extension/generated/canvas-browser-catalog.json` and `connector/extension/generated/moodle-browser-catalog.json`. They hold the operations the extension runs inside the page.

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

Startup refuses a digest mismatch. The handshake digest chains the Canvas API catalog digest and both browser catalog digests, so the loopback refuses an extension that does not hold the same three files. No runtime route is invented from model text.

## Read flow

1. The AI client calls one generated read tool.
2. Morrow validates the schema and selected profile.
3. The connector validates the exact current course binding.
4. The extension executes the generated route in the signed-in session.
5. The gateway projects and bounds the response.
6. Morrow returns a canonical read result with source and catalog evidence.

A disconnect during a safe read can fail or reconnect. It never changes write replay rules.

A Blackboard read replaces steps 3 to 5: the Blackboard child checks the integration account and that account's course membership again, reads through the REST API, and redacts learner identities before the result leaves it. No live tenant has run that path.

## Write flow

1. The AI client calls one generated write tool with an exact `source_binding_id`.
2. Morrow freezes the public tool, provider route, arguments, target set, profile, account, principal, connection generation, catalog digest, risk, expiry, and readback comparator.
3. Morrow records the plan durably and returns an operation ID, plan digest, and local approval URL.
4. A person opens that URL. The page reads the durable plan directly and can approve once or cancel. MCP exposes no approval tool.
5. `morrow_operation_dispatch` recomputes current authority and refuses stale approval, binding, profile, catalog, account, principal, or target state.
6. The effect broker reserves one durable effect receipt before provider dispatch.
7. The dispatching child consumes that receipt once and sends one provider request.
8. That child performs the frozen fresh readback.
9. Morrow records `verified`, `unconfirmed`, `failed`, or `applied_or_unknown` from evidence. It never maps an HTTP success alone to verified success.

An uncertain send is not replayed. Reconciliation runs the readback only. An unresolved record holds its provider object until it is settled; the refusal names the operation that holds it. When Morrow retained no read comparator it cannot settle the record itself, so `morrow_operation_close_unresolved` lets a person close it after reading the item with Morrow: it requires that read's exact result digest and an explicit person confirmation, records `closed_by_person`, and sends nothing. Undo is a new planned and approved corrective operation.

## Transport limits

One Morrow dispatch is not one network request. Morrow reserves one effect and starts one explicit request, and it does not repeat a dispatched operation after an uncertain result. Chrome can still resend a POST when a reused connection fails before the response headers arrive, so the browser transport has no exactly-once guarantee. A local Chrome test observed two POSTs after one explicit request. The rest of the product is built on this limit: an uncertain result keeps its operation and its provider-object conflict lock, and Morrow settles it from a readback or from a person-confirmed close-out, never from a second send. For an unresolved Canvas create, the later check reads the parent collection and reports `duplicate_effect_suspected` when more than one record matches the requested fields inside the request's time window; it deletes nothing. See the [transport evidence and limits](docs/implementation/BROWSER-POST-TRANSPORT-LIMIT.md).

The Blackboard REST route sends one HTTPS request under one signed one-use grant, and Morrow does not send it again. A lost or unclassified response there is not proof that Blackboard saved nothing, so that record settles as `applied_or_unknown` and waits for a fresh read; no live Blackboard tenant has been tested.

## New Quizzes and Item Banks

Official New Quizzes operations use the documented `/quiz/v1` routes. Every New Quizzes create and update sends a JSON body so nested interaction, scoring, and settings structures remain intact. A `quiz_settings` change reads the quiz first, refuses a settings block that moved since the caller read it, sends the complete merged block, and reports the keys it carried over, so changing one setting cannot delete the rest.

Item Bank endpoints are available only inside authenticated New Quizzes frames. The extension executes these requests in the page's main world. It runs that executor only in frames served over HTTPS from the tenant Quizzes host, and the probe that selects the frame carries the operation and the course binding, never the item payload. It validates the Canvas referrer origin and course before use. It strips token-like fields from returned values. The frame token never crosses into extension storage, the loopback protocol, MCP output, logs, or client configuration.

The catalog defines seven Item Bank reads and nine owner-write shapes. The share read returns one observed page and always reports incomplete pagination. The quiz-entry read follows numbered pages to a required empty end page and fails closed at its page or row bound. All nine writes stop before provider I/O. Bank creation lacks a proved recoverable create-and-course-associate transaction. Existing-bank changes lack complete downstream reach. The selected-quiz bank draw lacks durable recovery after a browser worker or process interruption.

The fan-out reader reports entry counts, observed share rows, and quiz uses from selected connected courses. Current share rows use a private context UUID, which Morrow cannot map to a numeric Canvas course id from proved data. It therefore does not claim shared-course identities. The record is always incomplete and does not grant authority. All 16 private operations remain live-unverified because no Morrow-connected Canvas tenant has answered the Item Banks or builder routes through this release.

## Batch flow

A batch freezes one exact child operation for each target. Write batches use one complete loopback approval page, but each child receives a separate grant and effect receipt. The scheduler applies bounded concurrency and rate policy. Child results settle independently.

Batch state is durable in SQLite. Arguments and manifests use authenticated encryption. Restart recovery returns interrupted writes to inspection or readback. It does not infer success and does not send them again.

## Trust boundaries

- **AI client:** may choose and call tools. MCP exposes no approval tool. A separate local page records approval, but it cannot prove human presence against local HTTP or browser automation.
- **Morrow MCP:** may plan and reserve effects; has no platform credential.
- **Approval page:** may approve only one exact, unexpired durable plan on loopback.
- **Extension:** may use only paired commands, admitted operations, current bindings, and unused receipts.
- **Chrome page:** owns the live Canvas, Moodle, and Item Bank secrets.
- **Blackboard REST child:** owns the tenant credential and the private dispatch routes; sends one PATCH only under a signed one-use Gateway grant that matches the reviewed plan digest; has no live-tenant evidence.
- **Desktop app:** may write setup files and deliver the Bridge; holds no approval authority and passes no operation.
- **Canvas, Moodle, and Blackboard:** each is authoritative for its own final provider state.

## Accepted decisions

- [ADR-001: Standalone Canvas operations layer](docs/architecture/ADR-001-federated-convergence.md)
- [ADR-002: Authenticated Chrome session connector](docs/architecture/ADR-002-local-extension-bridge.md)
