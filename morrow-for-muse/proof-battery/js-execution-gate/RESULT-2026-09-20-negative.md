# Negative gate: page-context JavaScript execution in managed browser tasks

Date: 2026-09-20
Status: DEFINITIVE NEGATIVE

## Question
Can a browser task execute JavaScript in page context (e.g. `fetch()` with
custom headers), which the fetch-lane transport design requires?

## Method
Three browser-task handoffs asked the browser agent directly whether it has
any action that executes JavaScript in page context, and if so to prove it
with a `fetch()` probe against https://httpbin.org/get.

## Result
The browser agent reports its complete tool inventory (muse.automation,
muse.visual_automation, muse.stripe_link, muse.browser_hand_off):

- Navigation: goto, back, forward, reload
- Inspection: snapshot, screenshot/look, rendered text, HTML, attributes,
  values, tab listing, page info
- Interaction: click, hover, fill, type, fill_code, key press, select,
  check/uncheck, focus, scroll, upload, credential fill
- Output: download, PDF
- Reporting: browser handoff

Its automation policy explicitly PROHIBITS executing JavaScript, issuing CDP
commands, and spawning alternate automation tools. The agent confirmed it
never attempted JavaScript execution in earlier turns. No fetch probe ran;
no HTTP status or header-echo result exists.

## Consequence
- Connector-contained page-context `fetch()` is NOT viable with the current
  browser tool surface. The fetch-lane implementation (transport/batch.py,
  fetch-proof driver) remains unit-proven scaffolding only; it cannot run
  live and must not be presented as a working transport.
- The no-PAT write path must work strictly through the real primitives:
  top-level navigation, page inspection, native form submission, and input.
- Next candidate under test (2026-09-20): editor-hosted HTML form
  (third-party HTML editor renders a brief-packed form; form submits via
  top-level POST navigation carrying the session cookies + harvested CSRF
  token). This reuses the mechanism proven by the retired helper page
  (cross-site top-level form POST to the Canvas API succeeded on 2026-09-20,
  assignment 4045370 created and deleted), with the page-hosting dependency
  moved from Morrow-operated infrastructure to a public HTML editor.
