# Blackboard browser recovery contract

Status: research only. Updated 7 September 2026, and superseded in part.

Morrow now reaches Blackboard through the official Anthology Learn REST API.
`packages/blackboard-learn-api` ships as an internal Gateway child, and
[BLACKBOARD-REST-SCOPE.md](../implementation/BLACKBOARD-REST-SCOPE.md) is the
route inventory, the held-operation list and the acceptance runbook for that
route. No live Blackboard tenant has been tested.

This document now describes one thing: the browser path, which is **not
implemented**. `connector/extension/src/blackboard-session.js` was removed from
the source tree and from the packaged Bridge file list on 6 September 2026, so
the Bridge carries no Blackboard module and no browser token exchange, and
connecting a Blackboard-looking tab returns an explicit refusal that names the
REST connection. Nothing in this document establishes a tenant, a signed-in
connection, an executable catalog, or a live result, and nothing in it describes
the shipped REST route.

## Decision

A browser path, if one is ever built, must use Blackboard Learn's documented
REST integration path through the existing Chrome bridge. It must not use an old
bearer-token configuration, copy browser cookies, scrape undocumented Ultra
requests, or treat an open Learn tab as an API credential.

The viable browser path is a registered Morrow REST application, installed by a
Learn administrator with **End User Access** enabled, followed by interactive
three-legged OAuth (3LO) with PKCE. The extension owns the short-lived token in
Chrome. The local MCP and the AI client receive neither OAuth codes, tokens,
cookies, application keys, nor secrets.

This direction fits the product's two-install boundary. It has a hard external
prerequisite: an authorized Blackboard test tenant where Morrow's REST
application is installed. Blackboard documents that REST applications must be
registered and installed in Learn, and that end-user access limits the
integration to the user's own permissions. [Learn REST integration setup](https://docs.blackboard.com/docs/blackboard/rest-apis/getting-started/rest-and-learn)
and [3LO](https://docs.blackboard.com/docs/blackboard/rest-apis/getting-started/3lo)
are the controlling public sources.

The browser-only route is conditional on a tenant proving the PKCE code exchange
with Morrow's registered redirect URI. Blackboard documents PKCE for 3LO, but
this project has not proved that exchange on a Blackboard tenant. If a tenant
requires a confidential-client secret at that exchange, Blackboard remains
unavailable: a secret must never ship in an extension or enter Morrow's MCP
configuration.

## Current evidence

The active bridge has no Blackboard transport:

- The extension loads only Canvas and Moodle catalogs in
  [`service-worker.js`](../../connector/extension/src/service-worker.js#L19).
- Its site-anchor check has only Moodle and Canvas branches in
  [`service-worker.js`](../../connector/extension/src/service-worker.js#L151).
- Connecting a Blackboard-looking path deliberately returns an unavailable
  message in [`service-worker.js`](../../connector/extension/src/service-worker.js#L1002).
- The bridge protocol can parse a `blackboard` binding and validates a Blackboard
  primary course ID in
  [`packages/bridge-protocol/src/index.ts`](../../packages/bridge-protocol/src/index.ts#L475).
  This is schema capacity, not a transport.
- The generated browser catalog holds no `blackboard_` operation. The Blackboard
  operations that ship are REST tools in
  [`packages/blackboard-learn-api`](../../packages/blackboard-learn-api), not
  browser tools, and they never pass through the extension. The product states
  the browser limit in [`README.md`](../../README.md),
  [`LIMITATIONS.md`](../../LIMITATIONS.md), and
  [`THREE-LMS-BRIDGE-PARITY.md`](../implementation/THREE-LMS-BRIDGE-PARITY.md).

The removed private preview is not a recovery path. It accepted a saved
delegated bearer token and made the documented REST calls from the local MCP.
That conflicts with the current signed-in Chrome boundary and has no token
issuance or renewal implementation. Its useful route and content-handler
research remain below as candidate API inputs only. They must be rechecked
against the test tenant's current Learn Swagger before implementation.

### Authorized target and session search

The checked local Morrow credential cache is mode `0600`; it has no Blackboard
marker or Blackboard-named key. `MORROW_LMS_CREDS_PATH` is not set, and the old
temporary credential file is absent. The extension-attached Chrome browser has
an active Canvas course and Morrow pairing pages, but no Blackboard tab. No
Blackboard origin, account, course, application ID, OAuth registration, or
authorized test session was found. No secret values were read or printed.

Blackboard publishes a developer LMS image for AWS, but it is not an already
authorized Morrow tenant. Creating it requires AWS provisioning and a Learn REST
application setup. It is out of scope for this read-only recovery task. See the
[Blackboard LMS server guidance](https://docs.blackboard.com/docs/blackboard/sandbox-envs/welcome).

## Connection contract

### Preconditions

All conditions below must be true before Morrow calls Blackboard available.

1. Morrow owns one registered REST Application, including its Application ID
   and non-secret OAuth client key. A Learn administrator has installed that
   exact Application ID on the exact test origin and enabled End User Access.
   The administrator does not create or disclose an application key/secret for
   Morrow.
2. The integration uses a non-System-Administrator integration user with only
   the endpoint entitlements needed for the first catalog. The test educator has
   access to one disposable course. Blackboard explicitly warns against a
   System Administrator integration user. [Integration setup guidance](https://docs.blackboard.com/docs/blackboard/rest-apis/getting-started/rest-and-learn)
   states this rule.
3. The Morrow application registration accepts the extension callback URI used
   in the live test. The test records the configured callback hostname and
   application ID fingerprint, but never an application secret, code, or token.
4. The extension has an explicit, user-granted optional host permission for the
   one canonical HTTPS origin. The existing manifest already uses optional HTTPS
   permissions in [`manifest.json`](../../connector/extension/manifest.json#L6).

### Interactive connection

`Connect Blackboard` is a bridge UI action. No MCP tool or assistant argument
can start it or expand its scope.

1. The extension receives a user-selected HTTPS Learn origin. It canonicalizes
   it to `new URL(url).origin`; paths, query strings, fragments, usernames, and
   redirects are not connection identities.
2. The extension creates a high-entropy `state`, a PKCE verifier and S256
   challenge, then starts Learn's documented 3LO authorization-code request at
   `GET {origin}/learn/api/public/v1/oauth2/authorizationcode`. It requests only
   `read` for initial connection. The registered redirect URI, application key,
   `response_type=code`, `state`, challenge, and challenge method are frozen for
   this attempt.
3. The person completes Learn sign-in and the Learn authorization screen. The
   extension accepts a callback only when the redirect URI and `state` match the
   saved one-time attempt. Cancellation, a missing code, a state mismatch, or a
   redirect to another origin creates no binding.
4. The extension exchanges the code at
   `POST {origin}/learn/api/public/v1/oauth2/token`, with the exact registered
   redirect URI and PKCE verifier. It uses `redirect: "error"`. It does not
   fall back to Basic OAuth, because Basic OAuth requires an application
   key/secret pair. Blackboard says those credentials and tokens must never be
   exposed. [Basic authentication](https://docs.blackboard.com/docs/blackboard/rest-apis/getting-started/basic-authentication)
   documents that boundary.
5. The access token and OAuth user UUID stay in a Blackboard-only private
   extension record, keyed by exact origin and Morrow application ID. The record
   must be in `chrome.storage.session` with access restricted to trusted
   extension contexts. It must not be copied into a page world, content script,
   popup response, bridge binding, log, approval page, local configuration, or
   MCP result. Do not request `offline` for the first proof. A browser restart
   or token expiry therefore requires the person to reconnect.
6. The extension verifies the claimed account before publishing a site anchor:
   resolve the OAuth UUID through `GET /learn/api/public/v1/users/uuid:{uuid}`
   and require a matching Blackboard primary ID; then require the authenticated
   `GET /learn/api/public/v1/users/me/courses?limit=1&fields=userId` response to
   name that same primary ID. Both reads are bounded and logged only as
   redacted evidence.

The 3LO documentation says the token acts as the logged-in person and documents
the `read`, `write`, `delete`, and `offline` scopes. It also says PKCE is
supported. [Blackboard 3LO documentation](https://docs.blackboard.com/docs/blackboard/rest-apis/getting-started/3lo)
is the authority for these steps.

### Published binding

After the account check, publish a redacted site anchor. It must contain:

| Field | Required value |
| --- | --- |
| `provider` | `blackboard` |
| `origin` | One canonical HTTPS Learn origin |
| `principalFingerprint` | SHA-256 of provider, origin, Blackboard primary user ID, and OAuth UUID |
| `sessionGeneration` | A new monotonically increasing generation for this principal and origin |
| `runtimeVerified` | `true` only after the account check in this connection attempt |
| `catalogDigest` | Digest of the exact Blackboard browser catalog loaded by the extension |

Keep the primary user ID and OAuth UUID only in private extension state. A
course binding adds one exact primary course ID, matching `^_[0-9]+_[0-9]+$`, and
a display name returned by the API. Do not derive a course ID from an Ultra URL
unless the API course read confirms the same ID. A Blackboard site connection
can stay valid after the course tab closes; runtime verification is an API
identity check, not a tab-presence check. This is the required provider-specific
change to the current tab-based `siteAnchorMatches` design.

## First browser catalog

Generate `connector/extension/generated/blackboard-browser-catalog.json` using
the same browser-catalog schema used for Moodle. Every row must carry the
provider, HTTP method, exact input schema, read/write flag, required OAuth
scope, endpoint entitlement from the tenant-matched Learn Swagger, review route,
and readback comparator. The public Learn API reference is selected by endpoint
and Learn version in the [Developer Portal](https://developer.blackboard.com/portal/displayApi/Learn).

The first six rows are deliberately narrow:

| Tool | Native route | Purpose and boundary |
| --- | --- | --- |
| `blackboard_list_my_courses` | `GET /learn/api/public/v1/users/me/courses?expand=course&offset={offset}&limit={limit}` | One bounded membership page. Every membership must name the bound account. |
| `blackboard_get_course` | `GET /learn/api/public/v3/courses/{courseId}?fields=id,courseId,name,ultraStatus,closedComplete` | Confirm the selected exact course and its change eligibility. |
| `blackboard_list_contents` | `GET /learn/api/public/v1/courses/{courseId}/contents?recursive=false&offset={offset}&limit={limit}` | One top-level content page only. |
| `blackboard_list_content_children` | `GET /learn/api/public/v1/courses/{courseId}/contents/{contentId}/children?recursive=false&skipUltraDocumentBodyAndKnowledgeChecks=false&includeInActivityTracking=false&offset={offset}&limit={limit}` | Read direct children of one selected parent. It is not recursive inventory. |
| `blackboard_get_content` | `GET /learn/api/public/v1/courses/{courseId}/contents/{contentId}?includeInActivityTracking=false` | Fresh exact item read for review and readback. |
| `blackboard_update_document_title` | `PATCH /learn/api/public/v1/courses/{courseId}/contents/{contentId}` with `{ "title": "…" }` | The first and only write candidate. It edits one verified document title. |

The route set comes from the retired adapter's versioned official Swagger input,
not live proof. Revalidate each endpoint, request parameter, return field, and
entitlement from the selected tenant's current Swagger before generating the
catalog. Blackboard's [content-handler reference](https://docs.blackboard.com/docs/blackboard/rest-apis/advanced/content-handler)
states that an Ultra document body is a `resource/x-bb-document` child of an
`isBbPage=true` `resource/x-bb-folder`. The first catalog therefore never edits
the wrapper. It also excludes document bodies, files, assessments, tests,
question banks, grades, users, and recursive traversal.

## First write and readback contract

The first live write is a title change to one disposable, instructor-authorized
document in the test course. It does not edit a body because Original HTML and
Ultra BbML need separate native contracts.

1. Read the exact course and document after course selection. Refuse if the
   course ID, content ID, course relationship, or content handler is missing or
   differs from the intended target. Refuse if the course is closed, if the item
   is an Ultra wrapper, or if the document is not
   `resource/x-bb-document`.
2. Freeze the exact origin, principal fingerprint, session generation, course
   ID, content ID, catalog digest, original title, protected fields, request
   `{title}`, and a fresh-read comparator. The review page names the site,
   account display label, course, document, old title, and new title. It never
   exposes private identifiers or tokens.
3. Require the normal Morrow human approval and reserve one durable effect
   receipt before dispatch. Revalidate account, token scope, course, document,
   handler, snapshot, catalog digest, and binding generation immediately before
   the request. A request receives `scope=write` only from a separate explicit
   bridge UI action and interactive 3LO consent; an assistant cannot enable it.
4. Send exactly one `PATCH`. The executor marks the operation as attempted just
   before `fetch`. It never performs an automatic retry, including after a
   timeout, network error, `429`, `5xx`, or a malformed response.
5. On a confirmed response, immediately make the exact `blackboard_get_content`
   read. Mark `verified` only when the ID, parent/course relationship, handler,
   requested title, and every recorded protected field match the frozen
   comparator. Ignore only server-generated modification metadata that the
   tenant read proves volatile.
6. Inspect the native Blackboard screen for the exact course and document after
   the API readback. Retain a redacted screenshot and readback receipt. This is
   evidence for this one title-change contract only.

If dispatch may have occurred and readback is absent, mismatched, or ambiguous,
the state is `applied_or_unknown`. It requires human inspection and a separately
approved correction. It is never replayed. This matches the current bridge's
single-use receipt and verification boundary in
[`service-worker.js`](../../connector/extension/src/service-worker.js#L705) and
[`service-worker.js`](../../connector/extension/src/service-worker.js#L831).

## Permission and unavailable states

The extension requests `read` at connection time. It requests `write` only when
the person explicitly enables the first write scope. Endpoint entitlements must
come from the tenant's current Learn Swagger and be mapped by the tenant admin to
the installed integration's least-privilege role. Blackboard documents that
endpoint entitlements must be matched to Learn privileges and that permissions
should be restricted to what the integration needs. See [entitlement mapping](https://docs.blackboard.com/docs/blackboard/rest-apis/getting-started/getting-started-with-entitlements)
and [REST integration administration](https://docs.blackboard.com/docs/blackboard/rest-apis/getting-started/rest-and-learn).

| Condition | Required Morrow result | Send rule |
| --- | --- | --- |
| No registered and installed Morrow REST application, no approved origin, or no allowed callback | `blackboard_connection_unavailable` with setup explanation | No API request or binding. |
| 3LO cancel, state mismatch, token exchange failure, no matching user, or expired session | `blackboard_sign_in_required` or `blackboard_connection_stale` | Clear pending attempt or stale private token; no binding. |
| `read` or `write` scope missing, `403`, or entitlement mismatch | `blackboard_permission_unavailable` | No write. Show the required catalog entitlement and target scope. |
| Course does not appear in membership / exact course read, or ID does not match | `blackboard_course_unavailable` | No binding or write. |
| Unsupported Learn version, route, content handler, wrapper, body format, or unlisted plugin content | `blackboard_operation_unavailable` | No guessed UI/API fallback. |
| Write attempt loses response or readback fails/mismatches | `applied_or_unknown` | Do not replay. Require inspection and a new correction operation. |
| Rate limit or provider maintenance before a write | `blackboard_temporarily_unavailable` | Keep the operation unsent only when no dispatch occurred; otherwise use `applied_or_unknown`. |

The Learn REST API documentation says tokens are site-specific, expire, and
REST calls have quotas. The executor must preserve the returned rate-limit
headers as bounded diagnostics, not as a reason to retry a write.
[Basic authentication](https://docs.blackboard.com/docs/blackboard/rest-apis/getting-started/basic-authentication)
and [REST best practices](https://docs.blackboard.com/docs/blackboard/rest-apis/rest-api-best-practices)
support these limits.

## Concrete next implementation boundary

Implement this browser slice only after an authorized tenant is ready. It would
be a second route beside the shipped REST integration, not a replacement for it,
and it exists to reach what the public Learn REST API cannot: discussions and
forums, and test and question authoring.

Do not reintroduce `packages/mcp-server/src/blackboard-api.ts` or its private
connection file. That instruction is about one removed file, the old saved
bearer-token client. It is not an instruction against
`packages/blackboard-learn-api`, which is the reviewed REST integration that
ships.

1. Restore `connector/extension/src/blackboard-session.js`, removed on
   6 September 2026. It owns 3LO PKCE, token confinement, exact-origin requests,
   account revalidation, safe API result projection, and the redacted `probe`,
   `discover_courses`, `check_course`, and `execute` modes. It contains no DOM-derived API route and
   no application secret.
2. Add `connector/extension/generated/blackboard-browser-catalog.json` and a
   checked generator/input that pins the selected tenant's current Swagger
   version and endpoint-entitlement evidence.
3. Extend [`service-worker.js`](../../connector/extension/src/service-worker.js#L19)
   to load and digest the Blackboard catalog, perform the explicit connection,
   use API identity revalidation for a Blackboard site anchor, support bounded
   Blackboard course discovery/selection, and route Blackboard operations to
   `blackboard-session.js`. Keep the existing Canvas and Moodle paths unchanged.
4. Extend [`packages/canvas-connector-mcp/src/browser-catalog.ts`](../../packages/canvas-connector-mcp/src/browser-catalog.ts#L1)
   and its runtime/server tests so a provider-specific browser catalog produces
   only generated Blackboard tools with exact binding requirements.
5. Add focused tests for origin changes, callback/state mismatch, PKCE exchange
   failure, token confinement, account mismatch, course mismatch, wrapper
   refusal, title-only request shape, one-use effect receipt, readback mismatch,
   rate limiting, and ambiguous send. Add a Chrome-for-Testing fixture only for
   local contracts. It must not be reported as a Blackboard tenant proof.

No browser source implementation is proposed until the external preconditions
are available. The REST route's own acceptance runbook is in
[BLACKBOARD-REST-SCOPE.md](../implementation/BLACKBOARD-REST-SCOPE.md); the run
described here is the browser one. The first live browser acceptance run needs the
installed test application, an authorized instructor account, one disposable
course and document, a documented entitlement list, one successful `read`
connection and all five read routes, then the single title
write/readback/screen-inspection sequence.
