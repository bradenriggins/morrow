# Blackboard recovery contract

**Status: research only. NOT IMPLEMENTED.** This is the ported
research contract describing how a Blackboard browser path WOULD have
to be built. Nothing below exists in the Morrow for Muse package: no
Blackboard auth, no Blackboard lane, no Blackboard transport, no
Blackboard catalog rows, no Blackboard proof. SCOPE.md lists
Blackboard as an honestly-disclosed roadmap item, not a v1 ship
criterion. Do not offer Blackboard operations to the educator.

Historical source (not shipped in this package): `origin-morrow/docs/research/blackboard-recovery-contract.md`
(research only, updated 2026-09-07, superseded in part).

## What the research concluded

The viable browser path, if ever built, is Blackboard Learn's
documented REST integration path: a registered Morrow REST
application, installed by a Learn administrator with End User Access
enabled, followed by interactive three-legged OAuth (3LO) with PKCE.
The extension would own the short-lived token in Chrome; the local
server and the agent would receive no OAuth codes, tokens, cookies,
application keys, or secrets.

Hard prerequisites (all must be true before any implementation):
1. An authorized Blackboard test tenant where Morrow's REST
   application is installed (registered application ID, non-secret
   OAuth client key, End User Access enabled by a Learn
   administrator; no application secret disclosed to Morrow).
2. A non-System-Administrator integration user with least-privilege
   endpoint entitlements (Blackboard explicitly warns against
   System Administrator integration users).
3. The application registration accepts the registered redirect URI.
4. PKCE code exchange proven on the tenant. If the tenant requires
   a confidential-client secret at the exchange, Blackboard stays
   unavailable: a secret must never ship in a browser extension or
   enter an agent's configuration.

Controlling public sources: Learn REST integration setup and 3LO
(https://docs.blackboard.com/docs/blackboard/rest-apis/getting-started/rest-and-learn
and /3lo); entitlement mapping (getting-started-with-entitlements);
REST best practices and rate limits.

## What must never be built

- Accepting a saved delegated bearer token (the removed private
  preview) and making REST calls with it: conflicts with the
  signed-in-browser boundary; no token issuance or renewal exists.
- Copying browser cookies, scraping undocumented Ultra requests, or
  treating an open Learn tab as an API credential.
- Old bearer-token configurations and Basic OAuth fallbacks (those
  need the application key/secret pair; Blackboard says those must
  never be exposed).

## The narrowest viable first catalog (research proposal only)

Six read rows then one write, all re-validated against the test
tenant's current Learn Swagger before implementation:

1. `blackboard_list_my_courses` (one bounded membership page; every
   membership must name the bound account)
2. `blackboard_get_course` (confirm the exact selected course)
3. `blackboard_list_contents` (one top-level page, not recursive)
4. `blackboard_list_content_children` (direct children of one
   selected parent)
5. `blackboard_get_content` (fresh exact item read for readback)
6. `blackboard_update_document_title` (PATCH one verified document
   title; the first and only write candidate)

Excluded from the first catalog: document bodies, files,
assessments, tests, question banks, grades, users, recursive
traversal. The wrapper (`isBbPage=true`) is never edited; Ultra
document bodies are `resource/x-bb-document` children.

First live write contract: one title change on one disposable,
educator-authorized document, with frozen origin/principal/course/
content/catalog-digest/original-title, one `PATCH`, immediate exact
readback (`blackboard_get_content` matching id, course relationship,
handler, requested title, protected fields), and a native-screen
inspection with a redacted screenshot. If dispatch may have occurred
and readback is absent, mismatched, or ambiguous, the state is
`applied_or_unknown`: human inspection and a separately approved
correction, never a replay.

## Boundary notes that carry over if this is ever built

- Tokens are site-specific and expire; preserve rate-limit headers
  as bounded diagnostics, never as a reason to retry a write.
- A browser restart or token expiry requires the person to reconnect
  (no `offline` scope for first proof).
- Course IDs match `^_[0-9]+_[0-9]+$`; never derive one from an Ultra
  URL unless the API course read confirms it.
- Runtime verification is an API identity check (resolve OAuth UUID,
  require matching primary ID), not tab presence.

## What to tell the educator today

Blackboard is not supported. The research path exists and its
preconditions are documented, but there is no code, no auth, no
catalog, and no proof. If they need Blackboard work, it goes through
a different channel entirely, not this connector.
