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
   emails, login ids, SIS ids, contextual numeric ids, and identity
   URLs become stable course-local labels (`Student A1`,
   `Student A2`, ...). Labels persist in the educator-local source
   vault file, so the same student maps to the same label across
   runs and across processes, and journals stay correlatable without
   ever naming the student.

Anything the boundary cannot verify fails closed: the op is refused
rather than surfacing raw learner PII.

## Two halves of one boundary (ported doctrine)

This layer is pseudonymization on EGRESS. It is one half of the
boundary doctrine this connector borrows from the production
Meridian JS privacy boundary. The other half is PII
detection/spoof-gating on INGRESS: blocking raw student PII before
it reaches a model, rejecting fake "sanitized" stamps and forged
tokens, and refusing to spawn on unsafe payloads. The two halves
are complements, not duplicates: ingress keeps student PII out of
prompts and agent inputs, egress keeps it out of outputs, journals,
and receipts. An operation that defeats one half should still be
caught by the other.

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
   (`python3 privacy/source_privacy_selftest.py`: currently 69/69)
   and confirm the boundary fails closed on the hostile battery
   before any real course data flows through it.
2. De-identified review. Before acting on a de-identified
   receipt, the educator reviews the projected output to confirm
   labels are stable and no raw PII is visible. This is the
   "documented de-identification review" step: the journal records
   every op, and the review is against the journal plus the
   projected receipt.
3. Real-course use. Learner-data operations run de-identified by
   default. The explicit PII override (the `educator_pii_reveal`
   consent file, see below) exists for documented instructional
   purposes only; each use is journaled with the stated reason, and
   a stub reason fails closed.
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
  (deferred verify, undo) can resolve result references, and the
  envelope is deleted when the op completes.
- Never de-tokenizes for the agent. Vault label resolution exists
  for the educator's explicit, out-of-band audit only; no agent
  output path calls it.

## Default-on, explicit override

De-identification is ON by default for every learner-data read. The
only way to see raw student PII is an explicit educator override:
create the consent file `<tree-state-dir>/educator_pii_reveal` (a
regular file, mode 0600, not a symlink) carrying the documented
instructional purpose (minimum 12 characters, for example
"grading review with the course TA before posting final grades").
The reason is journaled verbatim with the op (`pii_reveal` on the
journal record, `revealed_by: "educator-consent-file"`) and stamped
on the returned receipt. A stub reason, a wrong mode, or a
nonregular file fails closed: the op is refused until the consent
file is removed (de-id back on) or given a real documented purpose.
The legacy environment variable `MORROW_REVEAL_STUDENT_PII_REASON`
is ignored: the environment is not a consent channel. The desktop
boundary has no such override; this one is a deliberate,
audited local extension for the educator's own VM.

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

- There is no automatic expiry. The educator owns deletion.

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
  `dispatch/test_learner_classification.py` fails when a live-proven
  row whose path names a people resource is not classified. Course
  content (pages, quizzes, assignments, modules) is deliberately not
  classified, because projecting it would rewrite names inside content
  an educator may save back. The consequence: a page body, or the
  `last_edited_by` field of a page read, can carry a person's name
  unprojected. Additions go through admission-policy review.
- Small cohorts: labels are stable across ops and restarts, so in a
  cohort of 1-3 anyone who knows the roster can re-identify students
  by elimination (matching scores or distinctive work to known
  students). Treat projected small-cohort output as re-identifiable
  by the data holder.
- Nicknames: aliases derive from roster fields only. A nickname the
  roster never mentions (for example "Bobby" for rostered "Robert J.
  Smith") survives redaction in free text.
- The roster is receipt-derived: the boundary redacts the
  identities the receipt carries. A learner the receipt never
  mentions (no record, no id, no name) cannot be redacted from
  free text.
- Bare numeric ids in arbitrary prose or CSV text are not always
  recognized. Contextual forms are redacted: `user_id=912345`,
  `/users/912345`, whole-string ids, structured identity fields,
  and numeric identity values. `/grades/912345` is not one of the
  boundary's contextual id URL patterns.
- Secret-shaped text (API keys, tokens, launch parameters) fails
  closed instead of being partially projected: the op is refused
  rather than leaking a redacted fragment.
- Opaque blobs (base64 segments that decode to non-printable
  bytes) are refused rather than passed through.
- The write-direction label resolver replaces only the first
  learner label in a single ordinary string (mirroring the
  desktop behavior).
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
- The synchronous executor path refuses learner-data operations
  outright (`LearnerDataGated`) instead of projecting them; only
  the governed browser-lane completion path surfaces de-identified
  learner data.
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
