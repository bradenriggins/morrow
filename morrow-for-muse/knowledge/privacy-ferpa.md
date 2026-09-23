# Privacy and FERPA: the de-id layer, indexed

This file indexes the privacy layer for agents. It does not
re-implement it. The v1 boundary lives under `privacy/`: the engine
is `privacy/core.py` (the learner-privacy engine, including the
AES-256-GCM-encrypted learner vault), the boundary is
`privacy/boundary.py` (the source privacy boundary; 78/78 selftests
as of 2026-09-22, `python3 privacy/source_privacy_selftest.py`), and
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

- Names, emails, login ids, SIS ids, contextual numeric ids, and any
  URL path segment or query value equal to a learner's Canvas id are
  replaced by stable course-local labels
  (`Student A1`, `Student A2`, ...), issued by the encrypted vault
  in `privacy/core.py`. The same student maps to the same label
  across runs and processes, so journal rows stay correlatable
  without ever naming the student.
- The vault file lives on the educator's VM only:
  `~/.morrow/morrow_source_vault.json` (0600). Labels stop resolving
  when the educator deletes the file; a fresh run mints a fresh
  vault. There is no automatic expiry; the educator owns deletion.
- The raw provider payload stays in a 0600 pending envelope only so
  internal machinery (deferred verify) can resolve result
  references, and the envelope is deleted when the op completes.
- The educator's own profile (`/users/self`) is explicitly not
  learner data and is never de-identified, so principal
  confirmation keeps working.
- Anything the boundary cannot verify fails closed: the op is
  refused rather than surfacing raw learner PII.
- Morrow cannot intercept what the educator types to Muse: names the
  educator types reach the Muse model. Morrow keeps every other
  student identifier from the LMS out.

## Working by name

The educator names a student; the agent runs `morrow students find
--course C "<name as typed>"` (`learners/find.py`), confirms any
ambiguous or close-spelling match with the educator (never picks),
and writes by label. The executor resolves the label to the real
Canvas id at the LMS boundary, after the mode gate, only for the
course the write targets, and relabels everything the agent or the
journal sees. In that conversation, the named student shows as
"<name as typed> (Student A3)" (`privacy/name_echo.py`). Full flow:
SKILL.md "Working by name"; policy: `privacy/FERPA_POLICY.md`.

## Honest limitations

- Small cohorts: labels are stable across ops and restarts, so in a
  cohort of 1-3 anyone who knows the roster can re-identify students
  by elimination. Treat projected small-cohort output as
  re-identifiable by the data holder.
- Nicknames: aliases derive from roster fields only. A nickname the
  roster never mentions survives redaction in free text.
- Course content is labeled through the course roster, so a name the
  roster does not know (a nickname, someone never enrolled) is not.
- The failed-students answer shows the quiz's title as Canvas has it.

## When de-id applies

Any operation whose response carries people: the `[LEARNER-DATA]`
catalog rows plus the structural rule in
`dispatch/admission_policy.json` `learner_data` (`/users/`,
`/enrollments`, `/submissions`, `/gradebook`, `/grades`, `/analytics`,
overrides, date details, revisions, and more; `/users/self`
excepted).

Course content too: before the executor reads or changes anything in a
course on the Chromium lane, it reads the course's whole student roster
(every enrollment state, and deleted enrollments) and fails closed when
it cannot. Every course-scoped result (and every Item Bank result, with
the roster of the course the Item Banks launch is bound to) comes back
with each student's label and a marker naming the form it replaced:
`Student A3`, `Student A3 (first name)`, `(last name)`, `(name, last
name first)`, `(email)`, `(login)`, `(SIS id)`, `(user id)`, `(other
name)`; text that only reads like a label is marked `(as written)`.
Saved back, each marker returns the exact text it stood for
(`privacy/course_content.py`). Without `cryptography` the forms read as
`[hidden: student name]` and a write carrying one is refused.

## Current enforcement (do not work around it)

People-bearing operations dispatch only on the Chromium lane with the
encrypted learner vault (the optional `cryptography` package). There
the executor projects every receipt in `dispatch_entry`'s success path
before anything is agent-visible or journaled. Everywhere else (the
raw HTTPS lane, or no `cryptography`) they are refused
(`LearnerDataGated` in `dispatch/admission.py`), and an
educator-signed `--allow-unproven` cannot override that (it is an
absolute check, alongside never-dispatch, unsupported, and
evidence-hold). Only `live-proven` rows dispatch.

Practical consequences for agents:
- Never paste learner names, emails, logins, or SIS ids from the LMS
  into chat, logs, journal rows, or receipts. The only names you use
  are the ones the educator typed (shown as "<name> (Student A3)").
  A name the educator did not type appearing in any agent-visible
  surface is a privacy defect: stop and report it.
- Never mint a persistent API token from a session, and never exceed
  the educator's own account permissions.

## No reveal

**Owned by the FERPA policy (`privacy/FERPA_POLICY.md`).**
De-id applies to all learner-bearing results, always. Nothing reveals
real names to the agent: no record, flag, file, environment variable,
or setting. To tell the educator who a label is, ask which student they
have in mind and run `students find` with that name. Consult
`privacy/FERPA_POLICY.md`; do not invent another rule.

## Related reading

- `privacy/FERPA_POLICY.md` (the policy; plain language, not legal
  advice)
- `privacy/boundary.py` (the boundary contract; docstring first)
- `privacy/core.py` (the engine and the encrypted vault)
- `dispatch/admission.py` (`LearnerDataGated`, the refusal side of
  the gate)
- `learners/find.py` (`morrow students find`) and
  `privacy/name_echo.py` (working by name)
