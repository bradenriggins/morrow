# ADR-002: Authenticated Chrome session connector

- Status: accepted
- Date: 2026-09-04
- Scope: Canvas authentication and provider transport

## Decision

Use one directly owned Manifest V3 Chrome extension. It connects to the local Morrow connector over an authenticated WebSocket bound to `127.0.0.1`.

The extension uses the Canvas session that the user already opened in Chrome. It sends regular Canvas requests through the signed-in top-level page. It sends New Quizzes Item Bank requests inside the authenticated New Quizzes frame.

## User interaction

1. The user starts Morrow through an MCP client.
2. The user selects **Connect Morrow** in the extension.
3. Morrow opens a local connection page bound to that request.
4. The user selects **Allow connection**.
5. The user opens an exact signed-in Canvas course.
6. The user selects **Connect Canvas course**.
7. Chrome asks for access to that Canvas site and any supported New Quizzes site open within the tab.

The extension popup shows the Morrow connection separately from the saved Canvas connection and its last check time. **Disconnect Morrow** removes pairing state, bindings, the course file access opt-in, and receipt replay state. It requests removal of optional HTTPS permissions and warns if Chrome cannot remove them.

## Authentication and binding

The loopback server:

- listens only on `127.0.0.1:32147`;
- accepts only `/morrow-bridge/v1`;
- never places its high-entropy pairing secret in a URL;
- requires explicit pairing through the local page;
- validates the extension ID, protocol version, runtime revision, and catalog digest;
- assigns a new generation after each authenticated connection;
- rejects stale, expired, mismatched, or cross-generation commands;
- binds every request to one runtime-verified Canvas account and origin.

One verification is a probe of the connected tab, which asks the page for its signed-in account. A change always probes again immediately before it is sent. A read may use a probe from the last two seconds, and one probe answers every read that arrives while it runs, so a batch of reads against one course site does not send one probe each. The extension drops what it kept as soon as that tab closes, moves to another address, or finishes a change.

The public binding contains a one-way principal fingerprint, Canvas origin, optional course ID, connection generation, and freshness time. It does not contain a cookie, token, password, email address, or Canvas user ID.

## Permissions

The extension has permanent access only to its loopback host. HTTPS access is optional. Chrome grants it only after the user connects the current Canvas tab.

The extension does not use:

- the Chrome cookies API;
- `<all_urls>` host permission;
- native messaging;
- Chrome DevTools Protocol;
- remote executable code;
- a content-side chat or approval interface.

## Request behavior

A read command names one exact catalog operation and binding. The extension validates both before it executes the generated request.

A write command must also carry a current outer approval grant and a unique effect receipt. The extension reserves the receipt before send. It then sends once and performs a connector-owned readback. A reused receipt is refused.

If the response is lost after send, the outcome is unknown. Morrow must inspect provider state. It cannot resend the request automatically.

## Item Bank boundary

The Item Bank bearer token exists only in the authenticated New Quizzes frame. The executor runs in the frame's main world so the extension does not copy the token into service-worker state. It validates the parent Canvas referrer and exact course. Returned objects are recursively stripped of token-like keys before they cross the extension boundary.

## Consequences

Every supported MCP client uses one Canvas authentication path. Canvas keeps its own access controls. Morrow does not require a Canvas OAuth developer key and does not ask the user to paste a long-lived access token.
