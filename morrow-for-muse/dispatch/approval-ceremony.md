# Approval ceremony (v2)

Status: IMPLEMENTED (2026-09-21). The v2 gate mechanics (digest
binding, TTL, category, tenant scope, single-use, retired v1) are
implemented in `dispatch/admission.py`, along with the structural
trust fixes: tamper-sealed records (HMAC-SHA256, machine-held key),
ceremony-channel stamping (`educator-chat` vs `driver`), file-vs-
in-process provenance, 0600 persistence under the final op_id,
journal approval provenance on every write row, complete-phase
re-verification (`reverify_approval`) in both browser complete
functions, and identity-schedule token binding
(`_check_identity_schedule`). There is no display renderer: the
agent relays the educator's own citation of the identities, and
`sign_approval` seals it. The OLD `render_approval_display` was
removed 2026-09-21 (W3-P2-37) because it de-tokenized learner
identities via vault lookups with no educator consent ceremony; no
product code calls `vault.lookup()` (a selftest asserts this). Wave 6
added a NEW, different renderer, `dispatch/approval_display.py`
(W6-P1-A1 / W6-P1-H1): it renders the full approval payload (op,
category, target, issued/expiry, complete canonical params, undo
availability, identity schedule) WITHOUT any vault lookup. Params
carry tokens (lrn_...) by construction; the schedule's
`displayed_as` values are the educator's own citation words relayed
by the agent. A selftest asserts zero vault references in the new
renderer. Connector UX must show the educator this full display
BEFORE asking for authorization (see the module docstring and the
admission.py --help ceremony recipe).

## Non-goals

The ceremony does not replace educator judgment with cryptography,
and it does not authenticate the human. What code enforces is
listed under "What code proves"; the rest is procedural discipline
in the connector UX, auditable after the fact.

## Actors

- **Agent**: reasons and drafts on learner tokens (`lrn_...`). The
  agent process does receive the educator's own identity citation
  (it relays that citation into the signed record), so it is not
  true that the agent "never sees PII". What the agent never does
  is resolve a token to a name itself, print a name, or embed an
  identity in operation params, reasoning artifacts, receipts, or
  journals. Code validates the shape and order of the tokens in the
  signed identity schedule and seals the caller-supplied schedule;
  it cannot prove the cited display name is the actual learner
  mapped to that token. That binding is procedural: the educator
  cites identities from their own knowledge (their gradebook, their
  roster), and the connector UX must keep that citation honest.
- **Educator**: the only human in the loop. Names the identities an
  op touches, in their own words, when asked.
- **Gate**: `check_write_approval()` at dispatch; re-verification
  at complete. Admits or refuses; never renders identities.

There is no component that translates tokens back to display names.
The educator cites identities from their own knowledge (their
gradebook, their roster); the agent relays that citation into the
signed record. Nothing in this tree de-tokenizes.

## The ceremony, step by step

1. **Draft.** The agent builds the op: entry, canonical params. Any
   learner reference in params is a token. The agent also calls
   `mint_approval(entry, params, tenant_base, ttl,
   target_identity={course_id, course_name, term})`, which binds the
   op digest over (entry name, canonical params, tenant base,
   category, and the exact request: method, path, query, and body)
   and stamps the human-readable write target (tenant,
   course ID, course name, term when known) into the record's
   `target` block, under the tamper seal. The record is unsigned
   (`by=None`).
2. **Cite.** The agent tells the educator exactly what the op will
   do (op name, category, **tenant, course ID, and course name**,
   expiry) and asks them to name the learners it touches, in their
   own words. For a course write the citation MUST name the tenant,
   the course ID, and the course name: the educator is shown the
   human-readable target they are signing for, and dispatch later
   refuses when the provider's course name/term disagrees with it
   (W4-P0-11). The educator's reply is the citation. If params
   contain no tokens, there is no identity schedule and the ceremony
   is a plain action approval.
3. **Authorize.** The educator replies with explicit authorization
   for this exact action (their own words: a message, a spoken
   confirmation transcribed verbatim). Standing instructions,
   driver defaults, and inferred intent are not authorization.
4. **Sign.** The agent calls `sign_approval(record, authorization,
   channel=..., resolved_identities=[{token, displayed_as}, ...])`
   with the educator's verbatim reply and the relayed identity
   schedule. This sets `by="educator"`, records the citation, stamps
   the ceremony channel (`educator-chat` when the authorization was
   captured from the educator's own reply, `driver` for every other
   path), and tamper-seals the record with the machine-held HMAC
   key. When params carry learner tokens, the identity schedule needs
   its own citation: `identity_authorization`, the educator's own
   reply naming the identities, separate from the action
   authorization (W6-P2-A3). Both are sealed in the same record, so
   there is still one signing step. Any non-empty verbatim reply is a
   valid citation ("Yes" approves); what binds it to one action is
   the digest, not its length.
5. **Admit.** `check_write_approval()` enforces the v2 contract
   (seal, signature, a non-empty citation, digest match, category, tenant,
   expiry, single-use, identity-schedule match, and the W4-P0-11
   target cross-check: the record's `target` tenant/course_id must
   agree with this dispatch's tenant and params). On success it
   returns the journal audit block and the signed record; the
   dispatcher persists the record to `~/.morrow/approvals/<op_id>.json`
   (0600) under the final op_id and consumes the digest, in that
   order. Persist-before-consume makes every crash state recoverable:
   persisted-but-unconsumed re-admits cleanly on retry, and consumed
   implies persisted, so the complete phase can always re-verify an
   admitted write.
6. **Complete.** Re-verification (see below) before the receipt is
   journaled.

The journal also records the approval's provenance: `file` (read
from the approvals dir: the file ceremony) or `in_process` (an
explicit dict handed to dispatch: lower-trust, no file ceremony).

## Identity-schedule binding

`sign_approval` validates each `resolved_identities` item as
`{token, displayed_as}` with a token-shaped token and a non-empty
display name, then seals the schedule into the record. At dispatch,
`_check_identity_schedule` requires the scheduled tokens to equal
the tokens in the canonical params (`param_tokens`), in canonical
walk order: the educator approved precisely the identities the op
touches, no more, no fewer. A record without `resolved_identities`
(plain action approval, or a driver-channel proof) carries no
identity claim and is not checked. `resolution_authority` is
`"approval:<op_digest>"` when a schedule is present, else None:
resolution is authorized for that op digest only, never as a
standing permission. A new op mints a new ceremony, even for the
same learners.

## Re-verification at the complete phase

Implemented as `reverify_approval()` in `dispatch/admission.py`,
called by `complete_browser_request` and `complete_browser_verify`
before any receipt is journaled:

- Reload the approval record from `~/.morrow/approvals/<op_id>.json`.
  Refuse if missing (an op that was never admitted cannot complete).
- Verify the tamper seal. Refuse on any post-signing modification.
- Recompute the op digest from the entry, the pending envelope's
  canonical params, and the tenant base. Refuse on mismatch with the
  stored record: what completes must be exactly what was approved.
- Require the digest in the consumed set (proof the dispatch phase
  admitted it). Refuse otherwise.

This closes the gap where a report is ingested for an op whose
approval was never properly admitted.

## Concurrent consumption (fcntl locking)

`consume_approval()` serializes the check-then-record step with an
exclusive `fcntl` lock on `consumed.json.lock` (mode 0600): the lock
is taken, the consumed set is re-read while locked, an already-used
digest is refused as `ApprovalMismatch`, and the set is written back
atomically via `os.replace`. The lock file is created mode 0600 so
the single-use bookkeeping is as private as the approvals it guards.
Crash between persist and consume still fails closed: the signed
record is already on disk, so a retry re-admits the same approval,
re-persists under the same op_id, and consumes exactly once; the
journal's used-op-id set refuses any replayed report as a duplicate
rather than double-executing. Unix-only (`fcntl`); the
connector's Muse VM runtime is Linux, so this is the final mechanism.
Selftest 47 races eight processes at a single approval and asserts
exactly one winner.

## The retry caveat (acknowledged, kept)

Approval is burned post-claim, pre-write: after the target-identity
check, the before-state freshness check, and all local request
prevalidation pass, immediately before the first provider call
(W4 approval ordering). A refused target or stale before-state leaves
the approval unconsumed and reusable; the op_id claim is released.
If dispatch burns the approval and the write then fails retryably,
the retry re-runs under the SAME op_id against the saved brief: no
re-dispatch, no fresh approval needed. A fresh ceremony is required
only when the op is re-dispatched (fail-fast correction, changed
params), which is correct: changed params mean a changed digest,
which means the educator approved something else.

## What code proves (and what it does not)

Code enforces:
- unsigned, unsealed, tampered, expired, future-dated, wrong-tenant,
  wrong-op, wrong-category, mutated, replayed, or identity-mismatched
  approvals are refused;
- the citation is non-empty and journaled verbatim (any reply the
  educator gave, "Yes" included, bound to the op digest);
- the op digest binds the exact request (method, path, query, and
  body): a request changed after approval is refused at dispatch and
  at the complete phase;
- every write journal row carries the approval audit block
  (op_digest, by, channel, provenance, authorization citation,
  issued/expiry, category);
- the complete phase re-verifies the sealed record against the
  pending envelope before journaling;
- the signed identity schedule binds exactly the tokens the op
  touches, so what the educator cited is what is dispatched;
- no product code calls `vault.lookup()` (a selftest asserts zero
  call sites); the agent never de-tokenizes.

Code does not prove the citation string came from the educator's
mouth: `sign_approval` runs in the agent's process, so the seal binds
the record against tampering but does not authenticate the human.
The ceremony's integrity at that point rests on connector UX
discipline: ask the true question, pass the educator's verbatim
reply, never fabricate. The channel stamp (`educator-chat` vs
`driver`) and provenance (`file` vs `in_process`) make a fabricated
citation a detectable lie in audit (the cited words will not match
any educator message), not a prevented one. Proof drivers, which
have no educator present, must use channel `driver`, never claim
educator provenance.

## Implementation checklist

1. `sign_approval`: stamp `resolved_identities` +
   `resolution_authority` alongside `by`/`authorization`.
   (DONE: validated as [{token, displayed_as}] and sealed;
   `resolution_authority` is "approval:<op_digest>" when identities
   are cited, else None. The gate (`_check_identity_schedule`)
   refuses a dispatch whose learner tokens do not exactly match the
   signed schedule.)
2. Admission: persist the signed record to
   `~/.morrow/approvals/<op_id>.json` (0600) at consumption time.
   (DONE.)
3. Complete-phase re-verification in
   `transport/browser_backend.py` (both complete functions).
   (DONE as `reverify_approval`.)
4. Selftests:
   - agent surfaces keep tokens; journal rows from an
     identity-bearing op contain tokens, never displayed names;
     (DONE: learner-data write through the full ceremony;
     projected receipt journaled with learner labels, no display
     name.)
   - `vault.lookup` call-site allowlist (zero product callers);
     (DONE: `dispatch/admission_selftest.py` asserts no live
     `.lookup(` caller in product code.)
   - complete refuses when the approval record is missing or the
     digest mismatches; (DONE)
   - seal/tamper/provenance/channel/persist tests; (DONE)
   - identity-schedule mismatch refused at dispatch. (DONE)
5. Wire the agent-relayed citation into the connector's approval UX
   (ask, capture verbatim reply, relay the identity schedule).
   Product UX work. (OPEN: no connector UX exists yet in this tree.)
