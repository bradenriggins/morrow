# Morrow proof harness

This harness proves Morrow against a live LMS and writes down exactly what it proved. It stays in
the repository as the regression gate: any change to the platform can be re-run through it.

## What "proven" means here

An operation is proven only when the effect was read back **from the LMS itself**, not from
Morrow's own answer. A change Canvas has no read for is recorded `BLOCKED` with that reason. It is
never counted as proven. An operation that cannot be run at all is classified with a reason before
anything executes, so an unprovable operation is a verdict rather than a silent skip.

## Sandbox discipline

Everything runs against one sandbox course, named in `connect.mjs` and proven by
`verify-sandbox.mjs` before any write. A write only ever addresses an object this harness created,
so nothing the course already held can be changed or removed. Every object the harness makes
carries its mark and is removed before the run reports.

## Running it

    node proof-harness/verify-sandbox.mjs     # prove the sandbox is the one this harness owns
    node proof-harness/build-manifest.mjs     # phase 0: inventory and classification
    node proof-harness/run-reads.mjs          # phase 1: every provable read
    node proof-harness/run-writes.mjs         # phase 1: every provable write, then cleanup
    node proof-harness/scenarios/run.mjs      # phase 2: educator scenarios
    node proof-harness/run-robustness.mjs     # phase 3: failure, idempotency, privacy
    node proof-harness/report.mjs             # phase 4: coverage report from the evidence

Run one at a time. They share one gateway and one browser connection, and running two at once
makes both slower and the results less trustworthy.

A change that needs approval is attended. Morrow accepts an approval only from a person's click on
the review page in Chrome, signed by the paired Morrow Bridge, and refuses a program that posts the
form itself. The harness opens each review in Chrome and waits for your decision, up to
`MORROW_PROOF_APPROVAL_WAIT_MS` (default 10 minutes). A review with no decision is recorded as
`approval_withheld`. Set `MORROW_PROOF_BROWSER` if Morrow Bridge is in another Chrome build.

## Files

| File | What it holds |
| --- | --- |
| `manifest.json` | Every MCP tool and catalog operation, classified before execution |
| `ledger.json` | One evidence row per operation: what ran, what the LMS answered, cleanup, verdict |
| `report.json`, `COVERAGE.md` | The coverage report, built from the manifest and ledger alone |
| `sandbox.json` | The ownership check for the course this harness writes to |
| `seed-pool.json` | Real ids read once from the sandbox, so reads address real objects |
