# FERPA-shaped usage policy: student data in Morrow for Muse

This document is the plain-language policy for the student
de-identification layer (`privacy/`). It is written for the educator
operating the connector and for anyone auditing what the connector
does with student records. It is guidance, not legal advice: the
educator's institution owns FERPA compliance, and this document
describes the technical controls the connector provides toward it.

## What the connector touches

When a dispatched operation reads learner-bearing Canvas data (users,
enrollments, submissions, gradebook, grades, analytics, AI
conversations/experiences), the response passes through the source
privacy boundary (`privacy/boundary.py`, a faithful port of the
desktop Morrow `SourceMcpPrivacyBoundary`) before it becomes
agent-visible or journaled. The wired choke point is
`dispatch/executor.py` in `dispatch_entry`'s success path, delegating
to `privacy/executor_wire.py:project_learner_result`; the success-path
verification detail is projected through the same boundary first, so
the journal never carries learner names in mismatch narratives
either.

For each learner-data read the connector:

1. Builds a verified binding from the exact tenant origin
   (scheme + host, no default ports), the course id taken from the
   entry's URLs, the pinned principal, the lane's session generation,
   and a deterministic catalog digest. A learner-data entry with no
   course id in its URLs, or no exact http(s) tenant origin, is
   refused outright rather than projected half-scoped.
2. Harvests the receipt's learner records (user dicts, nested `user`
   objects, enrollment/submission rows carrying a `user_id`) into a
   roster and registers the complete roster before any redaction
   runs. Records with an id but no name are registered under a
   synthesized label so the id still tokenizes; the synthesized name
   can never leak real PII.
3. Checks the binding again after the provider result is in hand, so
   a lane that reconnected mid-operation fails closed instead of
   projecting under a stale scope.
4. Refuses legacy donor tokens (`Student_X...` shapes from older
   builds): they carry no identity proof in this vault and are never
   projected.
5. Redacts the receipt through the exact-scope roster. Names,
   emails, login ids, SIS ids, contextual numeric ids, and any URL
   path segment or query value equal to a rostered learner's Canvas
   id (`/users/<id>`, `/grades/<id>`, `/submissions/<id>`,
   `?student_id=<id>`, whatever the route is called) become stable
   course-local labels (`Student A1`, `Student A2`, ...). A person-id
   array (`student_ids`) becomes the learners' labels. Labels persist
   in the educator-local source vault file, so the same student maps
   to the same label across runs and across processes, and journals
   stay correlatable without ever naming the student. New labels in
   one batch are issued in a keyed-hash order inside the course, so a
   label number carries no alphabetical or roster rank.

Anything the boundary cannot verify fails closed: the op is refused
rather than surfacing raw learner PII.

## Course content

Course content (a page body, an assignment or quiz description, a quiz
question, a module, group, or file name) can name a student too. Before
a Chromium-lane dispatch reads or changes anything in a course, the
executor reads the course's whole student roster through the same
signed-in session: every enrollment state, plus the students whose
enrollment was deleted, whose names can still be in older content
(`dispatch/executor.py` `_read_course_roster_first`). The roster is
held in memory for that dispatch only; it is never journaled or shown.
If the read fails, nothing in the course is read or changed
(`CourseRosterUnavailable`).

Every course-scoped result then passes through that roster
(`privacy/course_content.py`, called from `project_learner_result`):
each form of a student's name becomes the student's label plus a marker
naming the form it replaced (`Student A3` for the full name; `(first
name)`, `(last name)`, `(name, last name first)`, `(email)`, `(login)`,
`(SIS id)`, `(user id)`, `(other name)` for the rest), and text that
already reads like a label is marked `(as written)`. A student gets a
label in the vault only when their name appears in what the agent sees.
Learner-data receipts get the same roster pass after the boundary, so a
classmate named only in a post's text is labeled too. Item Bank results
use the roster of the course the Item Banks launch is bound to.

The projection is exact in reverse, because course content is what an
educator edits and saves back. When a write's free text carries labels,
the executor puts back the text each marker names (a label with no
marker becomes the full name): "Jane" stays "Jane", an email stays the
email, and a word that only looked like a name ("Brown v. Board" in a
course with a student named Brown) is restored as written. A label the
course never issued is refused before anything is sent, and in plan
mode each label is bound to its vault token as a learner-id label is.
Without the encrypted vault there are no labels: the roster's forms are
hidden one way (`[hidden: student name]`), and a write whose text still
carries one is refused.

The failed-students answer (`query/chain.py`) reads the course outside
the executor and does the same: it reads the course roster before any
quiz, labels every quiz title it shows (the answer, the progress lines,
and the "which quiz" list), and stops when the roster cannot be read. A
synthetic run hides the names one way and never touches the vault.

## Working by name

The educator can work with a student by name, and the data stays
de-identified everywhere else:

1. The educator names a student. The agent runs the typed tool
   `bin/morrow students find --course C "<name as typed>"`
   (`learners/find.py`). It reads the course roster through the login
   helper and answers with labels only: one label for an exact or
   unambiguous match; every candidate, with non-identifying details
   the educator can confirm (section name, enrollment state, last
   activity date), for an ambiguous match or a close spelling. A
   close spelling is never picked automatically. No other student's
   name, and no email, login, SIS id, or Canvas id, is ever in the
   answer, and a no-match answer does not repeat the query.
2. Name echo. A student the educator named, once resolved, is
   recorded as educator-introduced for that conversation
   (`privacy/name_echo.py`: encrypted under a key derived from the
   vault key, never plaintext, journaled as label and conversation
   only). In that conversation, outputs show that label as
   "<name as the educator typed it> (Student A3)". The model already
   has that name, because the educator typed it. Other conversations
   and other courses see the bare label. The record ends when the
   conversation ends (`settings.store.end_conversation`), after 24
   hours at most, and with every vault purge.
3. Writes by label. The agent puts the label (or the echoed form)
   where a write takes a student. After the mode gate, the executor
   resolves the label to the real Canvas id at the LMS boundary, only
   in the vault scope of the course the write targets: a label that
   course never issued is refused, and an echoed name that does not
   match the educator's record in this conversation is refused.
   Canvas receives the real id; the journal, the result, and any
   error keep the label.

## What Morrow can and cannot protect (egress only)

This layer is pseudonymization on EGRESS: it controls what comes
back from the LMS before the model or the journal sees it. The
doctrine it borrows from the production Meridian JS privacy boundary
has a second half, PII detection on INGRESS (blocking raw student
PII in what a person types before it reaches a model). Morrow for
Muse has no ingress half: Morrow cannot intercept the educator's
messages to Muse. Names the educator types reach the Muse model,
because the educator typed them. Morrow keeps every other student
identifier from the LMS (every name the educator did not type, every
email, login id, SIS id, and Canvas id) out of what the model and the
journal see.

The single most important lesson from the ingress layer's production
history (audits 2026-05-11 through 2026-05-28) is STRONG-context
gating: aggressive keyword detection caused real false positives on
routine course content. Messages about MindTap/Cengage chapters
fired the name heuristic on phrases like "Word Parts in Action";
bare "students?" fired on "lock students out" and "all students
see this"; STRONG keywords in one paragraph bled across paragraph
breaks to condemn quiz content in another; answer choices like
"B. Disinfect the completed cast" were killed by a curriculum verb
("completed"). The ingress layer answered with a three-tier
design: broad detection patterns, STRONG patterns (possessive,
record-word follow-on, roster/gradebook/SIS/FERPA language, same
paragraph as the name), and OPERATION patterns for the high-impact
decision of switching modes. Routine course content passes cleanly
because it never carries a STRONG signal.

The egress half answers the same lesson structurally rather than
with keyword tiers: redaction here is roster-driven, never
keyword-driven. The harvester only admits a record that carries an
unambiguous identity field (email, login_id, sis_user_id,
sortable_name, short_name, or a user-ish key). A Canvas module
`{id, name, position, items_count}` or a course
`{id, name, course_code}` is never relabeled, no matter what words
its title contains. The pinned selftests assert both directions:
student identifiers on any surface are caught, and routine course
copy ("lock students out", "each student gets three attempts",
quiz answer choices, Title-Case curriculum phrases) passes through
byte-identical.

The spoof-gating lesson is ported as fail-closed label trust: a
`Student A<n>` label the vault never issued (for example
"Student A99" arriving in a receipt) is refused, never passed
through as if it were a real pseudonym. Legacy donor tokens
(`Student_X...` shapes) are refused for the same reason.

## Deployment gate ladder (adapted)

The source doctrine gates rollout in four steps: synthetic demo,
de-identified demo, pilot, production. Adapted for the
educator-operated Muse connector (single educator, their own VM,
their own Canvas session; there is no separate staging tenant):

1. Synthetic verification. Run the privacy selftests
   (`python3 privacy/source_privacy_selftest.py`: 78/78 as of
   2026-09-22)
   and confirm the boundary fails closed on the hostile battery
   before any real course data flows through it.
2. De-identified review. Before acting on a de-identified
   receipt, the educator reviews the projected output to confirm
   labels are stable and no raw PII is visible. This is the
   "documented de-identification review" step: the journal records
   every op, and the review is against the journal plus the
   projected receipt.
3. Real-course use. Learner-data operations always run
   de-identified; nothing turns that off (see below).
4. No enterprise rollout. This connector is a per-educator tool.
   Institutional rollout (shared VMs, other staff, production
   student systems) requires the institution's own FERPA/privacy
   review, security review, and incident/audit/retention process,
   none of which this document provides or claims.

This document is guidance, not legal advice, and none of the
institutional signoffs above have been performed or claimed here.

## What the connector never does

- Never exfiltrates student data. All Canvas calls run inside the
  educator's own Chromium session on their own VM; the connector
  makes no third-party network calls with learner content.
- Never ships the identity material in the package. The source
  vault (`<MORROW_HOME>/morrow_source_vault.json`, 0600; default `~/.morrow`) lives only on
  the educator's VM. `pack/deny-list.txt` denies
  `morrow_source_vault*` (plus the legacy `privacy_salt*` and
  `privacy_map*` and the existing `secrets*`, `*.key`, `*token*`
  patterns), and `scripts/verify-no-secrets.sh` enforces the
  deny-list against any tree before distribution.
- Never puts raw student PII in the journal or the agent-visible
  receipt for learner-data reads. The raw provider payload stays in
  the pending envelope (a 0600 file) only so internal machinery
  (deferred verify) can resolve result references, and the
  envelope is deleted when the op completes.
- Never de-tokenizes for the agent. The executor resolves a label to
  a real Canvas id only at the LMS boundary of a write (so Canvas
  receives the id), for the course the write targets; the resolved
  id is relabeled in every journal record, result, and error before
  anyone sees it. No agent output path returns a real identity.

## Always on, no reveal

De-identification is ON for every learner-data read, and nothing turns
it off: no record, no executor flag, no file, no environment variable,
no setting. The model sees course-scoped labels, and a name only when
the educator typed it (the name echo). Real names appear only on
Morrow's own local surfaces for the educator; Morrow for Muse has no
local surface that lists a roster, so the educator works by name: they
name a student, and `bin/morrow students find` returns that student's
label. The sealed educator reveal record that earlier releases offered
was removed in the final sweep of 2026-09-22: it handed every real name
in a course read to the agent, and so to the model. The old `<tree-state-dir>` consent file and the
environment variable `MORROW_REVEAL_STUDENT_PII_REASON` reveal nothing
either (an agent can write a file and set its own environment). The
desktop boundary has no reveal at all, and neither does this one.

## Retention and deletion

- Labels are deterministic per course scope, so they persist as
  long as the source vault file exists. They stop resolving when
  the educator deletes the file.
- Residue inventory (every identity-bearing file each deletion
  operation removes, so nothing is left undocumented):

  | Operation | Removes | Keeps / leaves behind |
  |---|---|---|
  | Delete `<MORROW_HOME>/morrow_source_vault.json` (default `~/.morrow`; wired vault, the live read path) | the vault file and its sibling `.key`; previously issued labels can never resolve again (a later run generates a fresh vault) | the transient lock `morrow_source_vault.json.lock` (0600, empty; safe to delete by hand). NOTE: deleting the file by hand does NOT purge browser transient state (next row); use `purge_tenant`/`purge_all` (below) or the uninstall script for the complete deletion |
  | Shipped per-tenant purge (`privacy/executor_wire.py: purge_tenant`) | every vault record whose scope belongs to that tenant (atomic rewrite; issued labels for that tenant stop resolving) AND all browser transient state: `<MORROW_HOME>/browser-pending/` envelopes (they hold raw provider payloads, un-scopable) and `<MORROW_HOME>/browser-briefs/` | other tenants' vault records; the vault key; the Chromium profile (its stores mix tenants, so a per-tenant profile purge is not feasible; use the profile wipe below or uninstall) |
  | Shipped full purge (`privacy/executor_wire.py: purge_all`) | the vault file + `.key`, all browser transient state (envelopes, briefs), and the Chromium profile's learner-data-carrying stores (selective mode: History, Top Sites, Visited Links, Sessions, Cache, Code Cache, Service Worker, Local Storage, Session Storage, IndexedDB, Storage, Crash Reports) | session cookies (`Cookies`, `Login Data`) and profile settings (`Preferences`, `Web Data`) so the educator stays signed in; the empty transient lock file. `purge_all(full_profile=True)` removes the whole profile instead (the educator signs in again). Refuses loudly if Chromium is running against the profile (stop the helper first) |
  | Legacy `python3 -m privacy.pseudonym purge --tenant` / `python3 -m privacy.learner_vault purge --tenant` (source-only, not shipped) | that tenant's legacy map records (atomic rewrite) AND all browser transient state (envelopes, briefs) | legacy salt/secret; other tenants; the Chromium profile (same per-tenant infeasibility as above) |
  | Legacy `python3 -m privacy.pseudonym wipe` / `python3 -m privacy.learner_vault wipe` (source-only, not shipped) | the legacy salt/secret and whole map, all browser transient state, and the profile's learner-data-carrying stores (same selective list as `purge_all`) | session cookies and profile settings (same rationale); `wipe --full` removes the whole profile instead |

- Full wipe (uninstall path): the uninstall script removes
  `~/.morrow/morrow_source_vault.json` and its `.key` (including a
  vault path supplied by `MORROW_SOURCE_VAULT_PATH`), the browser
  transient state (`browser-pending/`, `browser-briefs/`, purged first
  through the package's own `purge_transient_state()`), and the WHOLE
  Chromium profile (`helper/profile`). There is no central copy of any
  learner data anywhere else, so there is nothing remote to wipe.
  W4-P2-12 caveat: bytes already held open by other processes (a
  long-lived agent python with the vault or journal open) cannot be
  revoked by unlinking; the script's final report says so and advises
  closing agent sessions first. The "verified gone" checks cover the
  filesystem, not other processes' memory.

The legacy modules (`privacy/learner_vault.py`, `privacy/pseudonym.py`)
are source-only: they are excluded from the carved distribution and do
not ship. Their purge/wipe commands (`python3 -m privacy.pseudonym
purge|wipe`, `python3 -m privacy.learner_vault purge|wipe`) are not
available in the carved package and only ever covered their own legacy
state, never the wired vault. Do not document or present them as
shipped deletion commands; the shipped deletion procedure is deleting
the wired vault file above.

- Labels have no automatic expiry; the educator owns deletion. The
  name-echo records (`<vault>.echo`) expire with their conversation
  and after 24 hours at most, and every purge path above removes them
  too (per tenant, per course, or the whole file).

- Shipped CLI entry points (W4-P2-10): `python3 -m privacy.executor_wire
  purge --tenant <base>` (per-tenant), `python3 -m privacy.executor_wire
  purge-course --tenant <base> --course-id <id>` (per-course on one
  tenant), `python3 -m privacy.executor_wire purge-all [--full]` (vault
  file + `.key`, all browser transient state, and the Chromium profile's
  learner-data-carrying stores; `--full` removes the whole profile). Every
  command also purges all browser transient state.

## Known limitations (honest scope)

- Learner-data detection is URL based (`dispatch/admission_policy.json`,
  `learner_data` section): whole path segments that name a people
  resource (`url_segments`, `url_segment_suffixes`), then the
  `url_substrings` net, plus the catalog `[LEARNER-DATA]` flag.
  A source repository test, `dispatch/test_learner_classification.py`
  (not in the release), fails when a live-proven row whose path names a
  people resource is not classified. Course
  content (pages, quizzes, assignments, modules) is not learner data;
  it passes through the course roster instead (see "Course content"),
  and is restored exactly when saved back. Person fields on content (a
  page's `last_edited_by`, any `created_by`/`updated_by`/`editor`) are
  replaced field by field: a learner the vault already labeled in that
  course gets their label, anyone else becomes "a Canvas user Morrow
  has not labeled". Course search (`smartsearch`) is learner data, and
  its result text also passes through the course roster. Additions go
  through admission-policy review.
- Small cohorts: labels are stable across ops and restarts, so in a
  cohort of 1-3 anyone who knows the roster can re-identify students
  by elimination (matching scores or distinctive work to known
  students). Treat projected small-cohort output as re-identifiable
  by the data holder.
- Nicknames: aliases derive from roster fields only. A nickname the
  roster never mentions (for example "Bobby" for rostered "Robert J.
  Smith") survives redaction in free text.
- The course roster bounds what can be labeled: on the Chromium
  lane every current student and every student whose enrollment was
  deleted is known, so any of them named in free text is labeled.
  Someone who was never a student in the course (a teacher, a guest)
  is not. Off that lane (the rig lane), projection knows only the
  receipt's people and the students the vault labeled before. An ad
  hoc override title (an override that lists student ids) is always
  replaced by its student count ("1 student"), because its students
  may appear nowhere else.
- A word that matches a student's first or last name is labeled even
  when it means something else ("Brown v. Board" in a course with a
  student named Brown reads `Student A4 (last name) v. Board`). It is
  restored exactly when saved back.
- A first or last name alone is labeled only when it is capitalized
  (a lowercase one is often an ordinary word); the full name, email,
  and login are labeled in any case. So a page's web address (`url`,
  `html_url`, the slug Canvas makes from the title in lowercase) can
  carry a student's name. Morrow needs the address to find the page.
- A course's own name is shown as Canvas has it wherever Morrow names
  the course (the course list, the approval display, operation labels
  in messages), so a course named for a student (an independent study)
  shows that name. The course list spans courses and has no single
  roster to label it with.
- Bare numeric ids in arbitrary prose or CSV text are not always
  recognized. Contextual forms are redacted: `user_id=912345`, any
  URL path segment or query value equal to a rostered learner id
  (except the segment right after `/courses/` or `/accounts/`, which
  is the course or account by Canvas URL grammar), whole-string ids,
  structured identity fields, and numeric identity values.
- Secret-shaped text (API keys, tokens, launch parameters) fails
  closed instead of being partially projected: the op is refused
  rather than leaking a redacted fragment.
- Opaque blobs (base64 segments that decode to non-printable
  bytes) are refused rather than passed through.
- The executor's write-direction resolver
  (`executor_wire.resolve_learner_labels`) turns a label into a real
  id only where a learner id belongs (a whole value under a person-id
  key or a person route's path parameter, a label or the echoed
  "<name> (label)" form). A label in free text (a page body, a title)
  becomes the text its marker names (see "Course content"), never the
  id.
- Initial-last names ("M. Jackson") are not redacted: the alias
  set covers full-name, given-name, and reversed ("Jackson,
  Mary") forms only. A production ingress layer would block on
  the education-record fact; this egress half currently does not.
- "canvas id <id>" is not a contextual id pattern; `/users/<id>`,
  `user_id=<id>`, whole-string ids, structured identity fields,
  and numeric identity values are.
- Bare dates of birth (a 1900-2099 date near a DOB indicator) are
  not detected; the roster name beside the date is redacted but
  the date itself survives.
- A file object's `display_name` field is dropped (faithful to the
  desktop boundary, which lists `displayname` as an identity value
  field); the filename and other fields pass through. The Meridian
  ingress layer preserves file display names instead.
- The educator's own profile (`/users/self`) is explicitly not
  learner data and is never de-identified, so principal
  confirmation keeps working.
- Learner-data operations dispatch only where a projection point
  exists: the Chromium lane with the encrypted vault. The raw HTTPS
  lane, and any lane without the `cryptography` package, refuses them
  (`LearnerDataGated`). Undo of a learner-bearing manifest entry is
  still refused on every lane.
- Two students with the same display name in one course: a roster
  read whose records carry no SIS id or other identity field names
  both by the same alias, and the boundary refuses that read rather
  than guessing; `students find` still labels them separately (it
  labels from the vault, not by rendering text).
- Platform TLS inspection (W4-P1-4): on VMs where
  `/etc/ssl/certs/hatch-egress-ca.pem` exists (or
  `MORROW_EGRESS_CA_PEM` points at a PEM), the platform egress proxy
  terminates and re-encrypts outbound TLS, and the connector launches
  Chromium with `--ignore-certificate-errors-spki-list=<pin>` derived
  from that CA (`base64(sha256(SubjectPublicKeyInfo))`, computed at
  launch, never hardcoded). On such VMs the proxy operator can read
  TLS plaintext, including Canvas session cookies, pages, and API
  payloads. Installing here means consenting to that inspection; the
  connector cannot prevent it.
- Loopback CONNECT relay (W4-P2-9): `transport/proxy_forwarder.py`
  listens on `127.0.0.1` and accepts unauthenticated CONNECT
  requests, injecting the upstream `Proxy-Authorization` credential.
  Any same-user local process can use the relay and therefore the
  upstream proxy credential; the loopback binding is the design
  boundary, not authentication. Local-process compromise as your
  user equals proxy-credential use.
