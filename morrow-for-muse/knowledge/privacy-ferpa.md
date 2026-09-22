# Privacy and FERPA: the de-id layer, indexed

This file indexes the privacy layer for agents. It does not
re-implement it. The v1 boundary lives under `privacy/`: the engine
is `privacy/core.py` (the learner-privacy engine, including the
AES-256-GCM-encrypted learner vault), the boundary is
`privacy/boundary.py` (the source privacy boundary; 69/69 selftests,
verified `python3 privacy/source_privacy_selftest.py`), and
the policy is `privacy/FERPA_POLICY.md`. The wired choke point is
`dispatch/executor.py` in `dispatch_entry`'s success path, delegating
to `privacy/executor_wire.py:project_learner_result`. Read the
source files, not this summary, for the mechanism.

**Legacy lane:** `privacy/learner_vault.py` is a legacy
tokenization lane kept in the source tree only; it is NOT wired into
the v1 read path and is NOT shipped in the distribution.

## What exists now: the source privacy boundary

The boundary is pseudonymization on egress, applied to Canvas API
results that touch learner data (users, enrollments, submissions,
gradebook, grades, analytics, AI conversations/experiences) before
they become agent-visible or journaled:

- Names, emails, login ids, SIS ids, contextual numeric ids, and
  identity URLs are replaced by stable course-local labels
  (`Student A1`, `Student A2`, ...), issued by the encrypted vault
  in `privacy/core.py`. The same student maps to the same label
  across runs and processes, so journal rows stay correlatable
  without ever naming the student.
- The vault file lives on the educator's VM only:
  `~/.morrow/morrow_source_vault.json` (0600). Labels stop resolving
  when the educator deletes the file; a fresh run mints a fresh
  vault. There is no automatic expiry; the educator owns deletion.
- The raw provider payload stays in a 0600 pending envelope only so
  internal machinery (deferred verify, undo) can resolve result
  references, and the envelope is deleted when the op completes.
- The educator's own profile (`/users/self`) is explicitly not
  learner data and is never de-identified, so principal
  confirmation keeps working.
- Anything the boundary cannot verify fails closed: the op is
  refused rather than surfacing raw learner PII. A consent file
  carrying a stub reason fails closed too; removing the file puts
  de-id back on.

## Honest limitations

- Small cohorts: labels are stable across ops and restarts, so in a
  cohort of 1-3 anyone who knows the roster can re-identify students
  by elimination. Treat projected small-cohort output as
  re-identifiable by the data holder.
- Nicknames: aliases derive from roster fields only. A nickname the
  roster never mentions survives redaction in free text.
- Unseen learners: free text (a group name, a collaboration title) is
  redacted for learners the receipt carries or the vault already
  labeled for that course. A name Morrow has never seen in that course
  stays raw until a roster read labels it.

## When de-id applies

Any operation whose path touches learner-bearing routes:
`/users/`, `/enrollments`, `/submissions`, `/gradebook`, `/grades`,
`/analytics`, `/ai_conversations`, `/ai_experiences`
(`/users/self` excepted). These rows carry the `[LEARNER-DATA]` flag
in the catalog and are refused (`LearnerDataGated`) when the projection
vault is not ready; through the browser lane they are admitted and their
receipts are projected.

## Current enforcement (do not work around it)

The synchronous executor projects learner receipts through the
boundary; it does not refuse them. Refusal (`LearnerDataGated` in
`dispatch/admission.py`) happens only when the projection vault is
not ready, on the raw lane, which has no projection point. Through
the browser lane, learner-data entries are admitted and their
receipts are projected in `dispatch_entry`'s success path before
anything is agent-visible or journaled.

Practical consequences for agents:
- Do not dispatch learner-data operations through the synchronous
  executor. The gate will refuse them; an educator-signed
  `--allow-unproven` cannot override the learner-data refusal (it is
  an absolute check, alongside never-dispatch, unsupported, and
  evidence-hold).
- Never paste learner names, emails, logins, or SIS ids into chat,
  logs, journal rows, or receipts. The journal carries shapes,
  statuses, lengths, digests, and IDs only. A learner name appearing
  in any agent-visible surface is a privacy defect: stop and report
  it.
- Never mint a persistent API token from a session, and never exceed
  the educator's own account permissions.

## Opt-out override rule

**Owned by the FERPA policy (`privacy/FERPA_POLICY.md`).**
The standing rule is: de-id applies by default to all
learner-bearing results, and the only override in the tree is an
explicit educator request: create the `<tree-state-dir>/educator_pii_reveal`
consent file (a regular file, mode 0600) carrying the documented
instructional purpose (minimum 12 characters). The reason is
journaled verbatim with the op and stamped on the returned receipt.
The legacy `MORROW_REVEAL_STUDENT_PII_REASON` environment variable is
ignored: the environment is not a consent channel. Consult
`privacy/FERPA_POLICY.md` for the operational opt-out rule; do not
invent one.

## Related reading

- `privacy/FERPA_POLICY.md` (the policy; plain language, not legal
  advice)
- `privacy/boundary.py` (the boundary contract; docstring first)
- `privacy/core.py` (the engine and the encrypted vault)
- `dispatch/admission.py` (`LearnerDataGated`; the refusal side of
  the gate)
