# Platform ask: script execution (or session-bound fetch) in browser tasks

Status: DRAFT, not filed. Needs Braden's go-ahead before filing via the Muse feedback channel.

## Who is asking

Connector developer building Morrow for Muse (LMS bridge: Canvas/Moodle), intended for submission to Meta. The no-PAT auth lane is the core requirement: many educators' institutions forbid minting Canvas API tokens, so the connector must act through the educator's authenticated browser session, with zero UI automation after login.

## What exists today

The browser task (managed browser) holds the educator's live Canvas session and executes a proven form lane: GET reads plus form-encoded writes (POST, PUT/DELETE via `_method` overrides) through a first-party static relay page, with the CSRF field harvested in-page and never reported. Canvas assignment/page/discussion/module lifecycles and a Moodle discussion lifecycle are live-proven through it. This is the right transport and it works for everything form-encoding can express.

## What is missing

A script-execution primitive in the browser task's page context (or, equivalently, a session-bound fetch primitive: the agent specifies method, URL, headers, and body; the platform executes the request inside the task's authenticated session and returns status/body, with secret values never transiting the agent).

Verified 2026-09-21 by direct probe: the browser task's toolset "explicitly prohibits executing JavaScript, issuing CDP commands, or using script execution of any kind."

## Why it is needed

Two whole Canvas product surfaces are unimplementable without it:

- **Item Banks** (Instructure quiz-api): every call needs an `Authorization` header carrying a short-lived tool token (`banks.build_token`, minted from the page's own sessionStorage after the Canvas Item Banks launch). Form-encoding cannot set headers; the task cannot read sessionStorage without script execution.
- **New Quizzes** (quiz-api): JSON bodies plus CSRF/token headers, same block.

The operations themselves are proven: full Item Bank and New Quiz lifecycles ran live on 2026-09-20 through a developer-rig Chrome driven over CDP. That rig cannot ship as a product (no compliant session-establishment path on the agent VM; the Secure Vault is write-only to the agent by design). So without this primitive, Morrow for Muse cannot offer Item Banks or New Quizzes at all, which fails its parity bar with the desktop product.

## Security shape we are asking for

Mirror the existing `credential_fill` guarantees: the agent declares the request shape (method, URL, headers, body) and any per-use approval; secret material (tokens, session values) is used in-page and never appears in plans, briefs, reports, or agent context; the agent receives only status codes, sanitized bodies, and shapes. No `eval`-of-agent-strings is required if the platform prefers a declarative fetch primitive; either satisfies the need.

## Related asks (already logged)

- Secure Vault fill targeting connector-managed Chromium (`vault-fill-for-connector-chromium.md`, draft). That ask covers the first-login problem for a connector-owned browser; this ask covers script/fetch execution inside the managed browser task. They are independent; either one unblocks a different lane.

## What we will do once it exists

Implement the `browser_json` and `token_json_headers` lanes through the managed browser task (per-operation token capture, single-use credential handles, exact readback verification, full cleanup), retire the local-Chromium rig, and run the Item Bank / New Quiz live batteries through the same transport the product ships.
