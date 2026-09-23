# Changelog

## 0.4.1 (2026-09-23)

Release: `morrow-muse-connector-0.4.1.zip` from the `muse/v0.4.1`
GitHub release. This release fixes what a final review of 0.4.0
found, including two privacy fixes.

In plain words:

Student privacy:

- Privacy fix: the name "reveal" is removed. In 0.4.0, when you asked
  to see a course's student names, Morrow gave every student's real
  name, email, and login in that course to the assistant, and so to
  the Muse model, for up to 30 minutes. Now nothing can turn the
  labels off, and the assistant never sees a real student name you did
  not type. To check who a label is, name the student you have in
  mind: the assistant looks that name up and tells you whether it is
  the same label.
- Privacy fix: student names in course content are hidden too. In
  0.4.0, a page, an assignment description, or a quiz question that
  named a student reached the assistant as written. Now the assistant
  sees the student's label there and in quiz titles, including the
  quiz titles in the answer to "who failed last week's quiz". To do
  that, Morrow first reads the course's student list, and if it
  cannot, it reads and changes nothing in the course. When the
  assistant saves the content back, Morrow puts the real text back in:
  a first name stays a first name, and an email stays an email.
- Privacy fix: when the assistant previewed a change to text that
  names students, the preview showed those students' real names,
  emails, and logins. Now the preview keeps each student's label, and
  Morrow puts the real text back only when it sends the change.
- A student whose name ends in Jr., Sr., II, III, or IV has the last
  name hidden when it is used alone. Morrow took the ending for the last
  name, so for "Martin Luther King Jr." the name "King" reached the
  assistant as written, and a "Jr." elsewhere in the course was hidden
  instead.
- Privacy fix: a link in course content to a student's grades, to an
  assignment submission, or to a profile showed the student's Canvas
  ID number. Now it shows the student's label, and Morrow puts the
  number back when it saves the content.
- Some names are still not hidden, and the consent page lists them: a
  name Canvas does not list for the student, such as a nickname; a
  course named for its student, such as an independent study; and a
  page's web address, which keeps the words of the page's title in
  small letters.
- The consent page says that on some Muse computers, the network that
  carries traffic out of the computer can read that traffic, including
  your Canvas sign-in and the course pages Morrow loads.
- Privacy fix: a course given by its SIS code (for example
  `sis_course_id:BIO101`) skipped the step that hides student names, so
  a page's names, emails, and logins reached the assistant. Morrow now
  refuses such a course before it reads anything, and the assistant
  asks for the course by name or by the number in its Canvas address.

Changes to your courses:

- Morrow never posts an announcement, even when asked: posting one
  notifies every student in the course. A request that would post one,
  or add a feed that posts them, is refused before anything is sent,
  and the assistant is told why in plain words.
- Discussion changes are refused until they are tested through the
  browser Morrow uses today; they were tested only through an older,
  retired route.
- Morrow does only tasks we have tested on a real Canvas course, with
  no exception. In 0.4.0, the assistant could offer to run a task we
  had not tested if you approved it, although the consent page said
  Morrow refuses such a task even if you ask. That option is gone.
- The approval you read before a change is in plain words: the
  course, the change, every value that will be sent, and whether
  Morrow can undo it. A course rename and a change to the dates of
  several assignments read as plain actions too.
- You can approve the same change again (rename a page, rename it
  back, rename it again). Each approval is still used once. After a
  sign-in expiry, the change is prepared again and you approve it
  again.
- Renaming a course or changing its late policy now names the course
  in the approval, checks the course before the change, and, for a
  rename, reads the course back after it.
- A course whose name mixes languages (for example "Русский язык
  (Russian Language I)" or "Statistics: μ and σ") can be changed. A
  name that mixes alphabets inside one word, the way a lookalike name
  does, is still refused.
- The assistant can change the dates of several assignments at once.
  After a change to several due date overrides, or to the dates of
  several assignments, Morrow reads back each item it changed. Canvas
  applies a change to the dates of several assignments in the
  background, so a date that has not moved yet is reported as
  unconfirmed, never as failed.
- Deleting a classic quiz is confirmed by the quiz leaving the
  course's quiz list, so a successful delete is no longer reported as
  failed. When the list is too long to read in full, the delete is
  reported as unconfirmed unless Canvas says the quiz is gone.
- Item Banks no longer refuse a school whose Canvas runs on its own
  web address (for example canvas.school.edu). This is tested with a
  stand-in for such a school, not yet on a live one.
- Morrow closes the Item Banks tabs it opens in the helper browser
  when it finishes.
- The assistant offers New Quiz creation again: it was tested and
  turned on for 0.4.0, but the assistant's instructions still said it
  was on hold. A task that is on hold is now described as the task you
  asked for, not as a New Quiz.
- "Last week's quiz" uses your time zone: your timezone setting, then
  the course's time zone, then your Canvas profile. If none is set,
  Morrow asks.
- A change is never sent twice. If the helper's Canvas tab moved to
  another page while Morrow was sending a change, Morrow sent it again,
  so Canvas could end up with two copies. Now Morrow reports the change
  as unconfirmed and does not send it again.
- A course page whose title starts with "Login" (for example "Login
  Help") can be read and changed. Morrow took it for Canvas's sign-in
  page, paused every change, and said your Canvas connection expired.
- The approval names what a change touches by its title, for example
  Delete the assignment "Week 3 Quiz", never only by its number.
  Morrow reads the page, assignment, module, quiz, discussion, or item
  bank first. If it cannot, nothing is prepared. If it was renamed
  before you approve, nothing is sent, and the assistant prepares the
  change again for you to approve. A title that names a student shows
  the student's label.
- Every change reads as what it does. Restoring a page to an earlier
  version says it replaces what the page says now; replacing the
  course's blackout dates says a date not on the list is deleted;
  adding a course to your favorites, marking a module item done, and
  reordering quiz questions say so.
- Dates in an approval are shown in your time zone (your timezone
  setting, else the course's time zone), for example "Wednesday,
  September 30, 2026 at 7:59 PM (America/New_York)". With neither set,
  they are shown in UTC and say so.

Settings and undo:

- Your mode and settings belong to your Canvas account. Morrow needed
  the assistant to name you with an id that nothing gave it, so "use
  edit mode" could fail, or stop applying in the next conversation.
  Now Morrow uses the Canvas account you signed in with. The assistant
  starts a new conversation id for each conversation, so "edit mode for
  this conversation" ends with that conversation.
- Turning on edit mode, or changing a setting, is confirmed once, in
  plain words: what changed and what it means for you.
- The deletion confirmations setting says what it does: deletions ask
  first. It never covered other kinds of changes.
- In Edit mode, a change the assistant showed you and you approved now
  runs. Morrow refused every one of them as already sent, and a
  deletion you said yes to was refused again while "always confirm
  deletions" was on. Your yes to the deletion you were shown is the
  confirmation.
- Three settings that promised things Morrow does not do are gone:
  batched approvals, bulk action confirmations, and cleanup of test
  objects.
- The docs no longer describe an undo command. This release has no
  automatic undo, and each approval says so. To reverse a change,
  Morrow prepares the reverse change as a new change you approve. If
  an undo is tried anyway, you are told that nothing was sent and
  nothing changed.

Messages:

- When Canvas refuses a value, you are told what Canvas said and that
  nothing changed.
- When Canvas says your account may not do something (for example a TA
  changing a setting only a teacher can change), cannot find an item
  (a renamed page, a deleted assignment), or refuses a request for
  another reason, you are told what Canvas said and that nothing
  changed. These got a message that said the change might have
  applied and promised an engineering follow-up.
- A failure Morrow cannot classify no longer promises a follow-up that
  never comes. It gives the support address instead.
- When changes are paused because your Canvas sign-in expired, you
  are told to sign in again on the helper page. This also happens when
  the sign-in expires just as Morrow starts work in a course. While
  changes are paused, a change you ask for is refused before Morrow
  contacts Canvas.
- When something fails, you are told what was tried in plain words
  ("changing a page in the course "Biology 101""), never an internal
  command name or id.
- When Morrow refuses a request's own input, you are told that nothing
  was sent.
- A change refused before it was sent no longer stays listed as
  unfinished.
- When you approve a change that is no longer waiting, nothing is sent,
  and you are told why: it was already sent with your earlier approval
  (the assistant reads the course before it prepares it again), or it
  was never sent (a prepared change waits one hour). It was reported as
  a failure Morrow could not explain.
- When changes are paused because another Canvas account signed in on
  the helper page, you are told to sign out there and sign back in with
  your own account. When they are paused because your sign-in expired
  while Morrow worked in the helper browser, you are told to sign in
  again. Before, both said that someone who looks after your setup
  paused changes and that you could not lift the pause.
- When Morrow stops a change before sending it (the helper page had no
  security token for changes, no account was confirmed as yours, the
  account check got no answer, or the helper browser or Item Banks
  could not be reached), you are told nothing was sent. Before, some of
  these said the change might have been applied.
- The notice about paused changes counts only changes that are still
  waiting for you, not earlier expired sign-ins, and it goes away once
  nothing waits.
- Messages about a problem use plain words and promise only what
  Morrow does. When Canvas refuses a change, you are told that nothing
  changed and that the assistant can prepare it again when you say so;
  Morrow never sends it again on its own. When a request needs student
  records and the package that hides student names is missing, the
  message names the command that installs it.

Installing and the docs:

- Installing on a Muse computer works, and so does running the
  installer again. A Muse computer has no scheduled-task service
  (cron), and the installer's checks mistook Morrow's own logs for
  release files. Logs now live in `~/.morrow/trees/<tree id>/`, never
  in the installed folder, and a fresh install records the folder's
  stable id.
- The failed-students question, sign-in recovery, and finding a
  student by name read your Canvas address and the helper's port from
  `helper/env`, where the installer asks you to put them.
- The installer warns when the `cryptography` package is missing.
  Without it, Morrow refuses everything that touches student data
  (working by name, the failed-students question, rosters, grades), so
  the warning names the one command that fixes it.
- The consent, setup, and disconnect pages use plain words. To sign
  out, open the helper page and use Canvas's own menu: Account, then
  Logout.
- The first-run checklist starts with your install; the test-only
  steps moved to the install test.
- The release no longer ships old code that nothing uses (the retired
  form relay) or internal review notes, and the docs no longer mention
  Moodle or ask for a Canvas token.
- The release no longer includes the developer tests. Run from an
  installed copy, they wrote to Morrow's own records, and Morrow then
  refused to make changes until the records were restored. The
  installer's own checks still ship, and they keep to a scratch folder.
- The troubleshooting guide names the Python version the installer
  needs: 3.11 or newer.
- The docs say so wherever they name a file the release leaves out,
  such as the proof records, the Moodle code, and the old sign-in
  capture script. Some named them as if they were in the installed
  folder, and the operations runbook sent the assistant to a defects
  file that does not exist.
- Morrow's commands run on a computer that has another Python package
  named `dispatch` (Homebrew's Python can have one). Approving a
  change stopped with "cannot import name 'executor' from 'dispatch'",
  because the command loaded that package before its own files. Every
  command now loads its own files first.
- Upgrading works as the install guide says. Its unpack commands, run a
  second time, moved the new release inside the installed folder, so
  nothing was upgraded and the installer refused the folder. The same
  commands now install and upgrade in place and keep your Canvas
  address, your sign-in, and the folder's id. The guide installs the
  student-data package as a step, names `unzip` as a prerequisite, and
  starts a helper the installer skipped by running the installer again,
  which checks your Canvas address first.
- The setup, consent, and disconnect pages, and the assistant's
  instructions, say how to get help: email hello@meetmorrow.app or see
  meetmorrow.app/support, with the Morrow for Muse version and the step
  that failed, and never with student information.
- The list of what this version does names "Show me my courses" and
  reading your own Canvas profile. Both were tested live, but the list
  called them untested, so the assistant could hesitate on the first
  thing you ask. It also counts 115 tested reads, not 113.
- The release zip includes the license (MIT) at the top of the
  folder, so anyone reviewing the zip has the license with it.
- A restored backup works. The backup left out the key that checks
  your approvals, settings, and Edit mode, so after a restore Morrow
  refused every change. It also left out your student labels, the
  Canvas account you signed in with, your settings, and your Edit
  mode. The backup now holds all of them.
- The example commands in the assistant's instructions and the install
  guide run as written. They put the Canvas address option after the
  command, where Morrow refused it, so every example read and change
  stopped before it started. The option now works in either place, and
  the examples leave it out: Morrow reads your Canvas address from
  `helper/env`.
- The documented `python3 dispatch/executor.py` runs even when the
  computer's Python has another package named `dispatch` (on a Mac,
  PyObjC ships one). Every executor command failed there.
- The shipped `transport/local_chromium_selftest.py` runs in the
  release: its allowlist check no longer opens a file the release
  leaves out.

Technical notes:

- The educator reveal is gone: `dispatch.admission.mint_pii_reveal`,
  `check_pii_reveal`, the executor's `--pii-reveal`, and the journal's
  reveal audit field are removed, and `project_learner_result` always
  projects.
- `privacy/course_content.py` projects every course-scoped result
  (and learner receipts after the boundary) through the course roster
  with reversible form markers, and `resolve_learner_labels` restores
  labels in a write's free text; `dispatch/executor.py`
  `_read_course_roster_first` reads the roster (users in every
  enrollment state, deleted enrollments) before a Chromium-lane course
  dispatch and fails closed (`CourseRosterUnavailable`). A session
  death there arms the write halt, quarantine, and re-sign-in notice,
  and the roster read steps aside for a write the write halt refuses.
  The roster read is fixture-proven, not yet live-proven through this
  lane.
- `dispatch/admission_policy.json` 1.4.0: `never_dispatch.request_flags`
  refuses `is_announcement` on any route; `canvas_create_external_feed_courses`
  is never-dispatch; C-139, C-141, C-167, and C-238 are evidence holds.
- The failure catalog gains `never-dispatch` and
  `course-roster-unavailable`; `new-quiz-create-evidence-hold` became
  the general `evidence-hold`.
- The privacy tests match a stored name or id as a whole word, so an
  HMAC, digest, key, or op id that happens to contain one no longer
  fails the suite (1 run in 55 before; 0 in 2000 after). The students
  find check does the same for the vault ciphertext.
- `scripts/install-suites.sh` holds the 23 install suites and runs each
  in its own scratch home with every live-state variable removed.
  install.sh step 9 runs it, and CI runs it on the carved release tree
  after the carve's secrets gate. The carve drops every `test_*.py`
  that is not an install suite.
- The carve's secrets gate passes again: a docstring in
  `transport/item_bank_sdk.py` no longer names a real tenant host.
- CI installs pytest from the hash-locked `requirements-test.txt`.
- The troubleshooting playbook names the Python 3.11 floor that
  install.sh enforces.
- `test_release_version.py` requires every current-version statement
  (`pack/version.txt`, `pack/pack.json`, SKILL.md, INSTALL.md, the
  install selftest stub, and this changelog) to name `VERSION`.
- `dispatch/executor.py` renders `--dry-run` from the label form of the
  request (the entry and params before label resolution, which the
  gates and the journal already use), and the report's note says labels
  are restored only when the change is sent.
- `config/identity.default_user_id()` gives `morrow mode`, `morrow
  settings`, `morrow query`, and the executor's write gate the user id
  when none is passed: `MORROW_USER_ID`, else the account pinned at
  first sign-in as `canvas:<account id>@<Canvas host>`. With neither,
  the settings commands change nothing and say to sign in, and writes
  need approval. `morrow query` takes `--conversation-id`. SKILL.md
  tells the agent to make a new conversation id for each conversation
  and never reuse one, and modes/README.md no longer says a harness
  supplies the ids.
- `transport/local_chromium.py` `api()` runs a change's page-context
  program again only when CDP says its world was gone before it ran
  ("Cannot find context with specified id"). Any other context loss
  raises `ApiCallMaybeSent`, which the Chromium session journals as an
  uncertain write. A read still retries once. Only a response path of
  `/login` or under `/login/` means a dead session.
- `ChromiumSession.load` reads `CANVAS_BASE` the way every other agent
  command does (`config/tree_config`: the environment, then the tree's
  `helper/env`) before the pinned account's lane state, so an executor
  command before the pin no longer says Canvas is not connected.
- `transport/chromium_session.py` `_decode_body` sends a JSON array of
  objects as JSON, so the bulk date update (C-37) runs on the Chromium
  lane, not only on the https lane. A body the lane cannot encode
  raises `WriteNotAttempted`, so its claim is released instead of being
  journaled as a write that may have applied.
- The failure catalog gains `canvas-not-permitted` (401
  "unauthorized", 403), `canvas-not-found` (404), and
  `canvas-refused-request` (any other standard 4xx), each only for a
  refusal the executor classified as fail-fast (it sets
  `operation_kind`). A 401 "unauthenticated" is never "not permitted".
  The translator reads Canvas's words from every 4xx body except the
  CSRF 422. The `unknown` fallback and the funnel's degraded message
  point to hello@meetmorrow.app instead of an engineering review.
  `failures/test_canvas_refusals.py` checks every standard 4xx status.
- `modes/state.py` journals `mode.write_admitted` and
  `mode.write_refused` with `for_op_id`, not `op_id`: the gate runs
  before the executor claims the op id, and an `op_id` field put the
  id in the journal's op-id index, so the claim refused every Edit-mode
  `approve-write` (and any retry after a mode refusal) with
  `DuplicateOpId`. `_approve_plan_write` passes the educator's reply as
  `destructive_confirmed` when the prepared request is destructive.
  SKILL.md documents `--destructive-confirmed` for edit-mode deletions.
  `dispatch/test_edit_mode_approve_write.py` covers both.
- `scripts/carve.py` ships the repository's `LICENSE` at the tree
  root (`REPO_FILES`), listed in `pack/carve-manifest.json` and in the
  zip; the carve fails when it is missing or untracked, or when
  `morrow-for-muse/LICENSE` would shadow it.
- `dispatch/state_backup.py` backs up and restores the approval signing
  keyring (`secrets/`), the source vault Morrow writes
  (`morrow_source_vault.json` with its `.key` and `.echo`, restored to
  the current vault path), the pinned account (`browser_lane.json`,
  `principal_pin.json`), `settings/`, and `modes/`. A signing key moved
  out with `MORROW_APPROVAL_SIGNING_KEY` stays out, and create says so.
  Restore makes missing state folders 0700, and a backed-up name may
  hold a colon (the user id) but never starts with a drive letter.
  `dispatch/test_state_backup_restore.py` seeds an install, backs it
  up, deletes the home, restores, and approves a change.
- `dispatch/executor.py` accepts `--canvas-base` before or after the
  subcommand (`build_parser`), and the error funnel skips the values of
  top-level options when it names the step. `dispatch/test_documented_commands.py`
  parses every executor command in the docs' code blocks and
  install.sh's operator check.
- The retired form-host server (`transport/form_host_server.py`, its
  selftest, and `transport/form-host/`) is deleted. Nothing used it and
  the release already left it out, but its selftest started servers it
  could not stop on macOS (it looked for them in /proc), so they kept
  running for hours after a test run.
- pytest runs every selftest script the install suites do not run (22
  scripts, `test_selftest_scripts.py`), each the way
  `scripts/install-suites.sh` runs a suite, and fails a script that
  leaves a process running. Nothing ran them before. The Chromium and
  keepalive selftests pass on macOS: a check that needs Linux's /proc
  uses a stand-in there, or is skipped when there is nothing to read.
- `reauth/state_machine.py` records a `cause` in the write halt file
  (`session_expired` or `account_mismatch`) and `halt_cause()` reads
  it; a halt file from 0.4.0 keeps its meaning through its reason text.
  `transport/chromium_session.py` records `session_expired` for a
  session death and `account_mismatch` for a different signed-in
  account. New failure mode `write-halt-account-mismatch`.
- Chromium-lane refusals before the page's fetch are `WriteNotAttempted`
  subclasses, so the claim is released and nothing is journaled as
  possibly applied: `CsrfWriteNotSent`, `PrincipalNotPinned`,
  `PrincipalMismatch`, `AccountCheckFailed`, `HelperNotReached`,
  `ItemBanksNotReached`, and `RequestNotSendable`. New failure modes
  `canvas-account-check-failed`, `helper-browser-not-reached`, and
  `item-banks-not-reached`. With the two prepared-write modes and the
  three Canvas refusal modes, less the 14 modes retired for lanes that
  do not ship, the catalog has 88 modes. An Item Banks
  page-program outcome other than the program's own is now
  `ItemBankSdkMaybeAttempted` (uncertain), never "not sent".
- `reauth/state_machine.py` `paused_ops()` (one entry per op, newest
  status quarantined or awaiting_approval) sets every notice count; a
  verified resume with nothing waiting removes `notify.txt`. SKILL.md
  tells the agent to run `reauth/state_machine.py notify` after resume.
- `dispatch/executor.py` refuses a request whose course is not a plain
  number (`InvalidCourseId`, mode `query-course-id-invalid`) before
  anything is sent, and `privacy/executor_wire.py` refuses content from
  a course not named by its number instead of passing it through.
- `plan-write` reads the object the write names (`_read_named_object`:
  the deepest member on the path the write readback re-reads, or the
  course of a favorite), labels its title through the course roster,
  and stores `object_slot` and `object_name` in the sealed approval
  target and a digest of the title in the plan; `approve-write` reads
  it again and refuses a changed title before the approval is used.
  `dispatch/approval_display.py` has its own words for action routes
  (`_ROUTE_WORDS`), plain nouns for every live-proven collection, and
  `render_educator_display(..., time_zone=)`.
- `dispatch/executor.py` puts the tree root on `sys.path` before its
  first tree import.

## 0.4.0 (2026-09-22)

Release: `morrow-muse-connector-0.4.0.zip` from the `muse/v0.4.0`
GitHub release. This release fixes every Critical and High defect
found in the adversarial audits after 0.3.0.

In plain words:

- Every write path goes through the mode gate (discovery, pack
  override, and undo included), and only live-proven operations run.
  (Correction, final sweep: 0.4.0 pins no undo entry, so it has no
  automatic undo; the undo command refuses every entry.)
- An approval binds the exact method, path, query, and body, and the
  vault token of each student label it names. Any non-empty educator
  reply approves. The typed `plan-write` and `approve-write` commands
  run the ceremony.
- The phrase parser is gone. The agent calls typed `mode`, `settings`,
  `query`, and `students` commands. Edit mode is one untimed grant,
  and turning it off means Plan everywhere. Conversation overrides
  last.
- Work with students by name: `morrow students find` asks the
  educator when a match is unsure, the model sees only labels, a write
  by label reaches the right student, and a name reveal is
  educator-only, for one course, short-lived, and never journaled in
  the clear.
  (Correction, 0.4.1: the reveal gave the course's real names to the
  assistant, and so to the Muse model. 0.4.1 removes it.)
- More learner data is labeled: ids inside URLs, SIS ids, bare user
  records, content editors, date details, smart search, and outcome
  alignments.
- Write verification has three honest outcomes: verified, failed (a
  proven wrong value), and uncertain (the readback could not confirm).
- The sign-in pin fails closed, and the Chromium lane refuses a Canvas
  account other than the pinned one. `disconnect` really disconnects.
  Keepalive supervision works without cron, and `stop` ends the whole
  loop.
- `install.sh` installs from a carved tree of this repository. The
  test suite never touches the real `~/.morrow`. The tree's packages
  are regular packages, so installed packages cannot shadow them.

The detailed notes below cover the work since 0.3.0.

### Privacy round 4: working by name, de-identified everywhere else (2026-09-22)

- Working by name (design chosen by the integrator): `morrow students
  find --course C "<name>"` (`learners/find.py`) resolves the name the
  educator typed to a course label; ambiguous or close-spelling
  matches list every candidate as a label with section, enrollment
  state, and last activity date, and are never auto-picked. A resolved
  name is echoed as "<typed name> (Student A3)" in that conversation
  only (`privacy/name_echo.py`, encrypted, ends with the conversation).
  Writes carry labels; the executor resolves them to real ids at the
  LMS boundary after the mode gate, only for the course the write
  targets, and relabels every journal record, result, and error.
- Live-proven people-bearing catalog rows now dispatch on the Chromium
  lane with the encrypted vault (receipts de-identified); they stay
  refused on the raw lane and without `cryptography`.
- The `educator_pii_reveal` consent file is retired (an agent could
  write it). The only reveal is a sealed educator record for one
  course, at most 30 minutes, journaled (`mint_pii_reveal`,
  `--pii-reveal`).
- Any URL path segment or query value equal to a rostered learner id
  is labeled (`/grades/<id>`, `/submissions/<id>`, `?student_id=`).
  `student_ids` arrays read back as labels. New labels follow a keyed
  order, not first-read (alphabetical) order.
- Page revisions with a teacher editor and assignment reads with an
  embedded submission project instead of failing closed.
- Write-verification failures carry only the projected detail to the
  agent, and failure journal records carry the projected receipt.
- Student-resolution errors no longer echo the educator's query; a
  fuzzy match is never auto-picked.
- Docs: SKILL.md teaches the by-name flow; FERPA_POLICY.md,
  privacy/README.md, knowledge/privacy-ferpa.md, SCOPE.md, and
  content/consent.md state plainly that names the educator types
  reach the Muse model and Morrow keeps every other identifier from
  the LMS out.

### Installer, carve, and packaging (Worker 4, 2026-09-21)

- `install.sh` rewritten (10 steps): integrity verification against
  `pack/carve-manifest.json`, version detection via `pack/version.txt`
  (0.3.0), timestamped tree backup outside the tree (excluding
  `helper/profile/`) on upgrade, stale-file removal with loud logging,
  failure rollback from backup, keepalive cron migration (exactly one
  entry for this tree, stale entries from other trees removed), secrets
  gate BEFORE helper launch, all 23 selftest suites, version/manifest
  record under effective `MORROW_HOME`. Reruns revalidate and reconcile
  state. `PYTHONDONTWRITEBYTECODE=1` and import probes from `/` prevent
  `__pycache__/` from tripping the secrets gate (W2-P0-14).
- `scripts/uninstall.sh` added: exact-PID signaling only (no pkill),
  cron removal verified mandatory (surviving entries resurrect the
  helper within 5 minutes), effective `MORROW_HOME` and
  `LOGIN_HELPER_PROFILE_DIR` honored, enumerated paths and freed ports
  verified.
- `pack/deny-list.txt` and `scripts/verify-no-secrets.sh` rewritten
  with NFKC normalization, invisible-character stripping, Greek/Cyrillic
  homoglyph folding, any-depth case-insensitive matching, Chromium-store
  variants, `.env*`/`*secret*`, JSON `canvas_session`/`remember_user_token`,
  and case-insensitive tenant extraction. Independent pinned policy at
  `~/workspace/carve-deny-list.txt`; carve refuses on mismatch.
- `pack/pack.json` entries emptied (14 unverifiable external pins
  removed); `pack/version.txt` added (0.3.0).
- `requirements-optional.txt` added (`cryptography==50.0.1`);
  `privacy/core.py` degrades gracefully without it (file-backed vault
  refuses with install instructions; in-memory vaults and redaction
  work normally).
- `carve-morrow-dist.py` rewritten: persistent staging, atomic
  publication, whole-line anchor enforcement, in-memory compile,
  all 8 suites run from staged dist with sandboxed HOME/MORROW_HOME,
  banner normalization, independent policy check, manifest generation.
- Documentation: `INSTALL.md` (10-step order, uninstall.sh, cron
  mandatory, 5-min reboot downtime, upgrade backup/migration/rollback,
  optional cryptography, empty pack entries), `SKILL.md`, `helper/README.md`,
  `helper/keepalive.sh` header (reboot downtime, mandatory cron removal).

### Journal integrity and claim authorization (W4-P0-1, W4-P0-2, W4-P2-6, 2026-09-21)
- Every journal record now carries a per-record HMAC (`rec_hmac`,
  HMAC-SHA256 over the canonical record body) keyed by a per-tree
  secret minted at `ops.secret` (0600, created atomically). The sidecar
  index is version 2 and HMAC-sealed (`index_hmac`); a forged or
  seal-stripped index is never trusted.
- All read paths verify the seal: edited, forged, or appended records
  raise `JournalIntegrityError` instead of being trusted. Deleted
  records are detected (journal shrinkage against the sealed index)
  and fail closed. A missing index alongside an existing journal, or a
  secret with no journal, also fails closed.
- Claim tokens are never written to the journal: pending-claim records
  store only `claim_token_hash` (SHA256). `recheck_claim`/`release_op_id`
  hash the presented raw token; a scraped hash cannot release a claim
  (refused as `DuplicateOpId`).
- Pre-HMAC journals fail closed on first open and point at the explicit
  upgrade step `python3 dispatch/executor.py journal-seal`, which adopts
  the current bytes as the trust anchor, seals records, hashes plaintext
  tokens, and rebuilds the index (it refuses to bless a record whose
  seal does not verify). `journal-repair` quarantines a torn tail and
  re-seals through the same adopt step. Both are CLI subcommands.
- The flock is documented as advisory only (a crash/race boundary, not
  a security boundary); the tamper boundary is the HMAC seal.
- New suite `dispatch/journal_integrity_selftest.py` (26 checks), wired
  into `install.sh` (now 9 suites).

### Form-relay lane removed (2026-09-21)

The first-party static relay page on meetmorrow.app/morrow/form-relay/
was taken down and its source deleted (transport/form_relay.py,
transport/form-relay/, transport/form_relay_selftest.py). Dead code: the
live write path runs in the helper Chromium's page context
(dispatch/executor.py chromium backend), so nothing called the relay
anymore. transport/batch.py now fails closed on every form write
(FormTransportUnavailable, unconditionally); the relay routing,
relay_url parameter, and _render_relay_brief are gone from batch.py and
transport/browser_backend.py. Proof-battery wave-1 renderer and briefs
marked retired; defect-log relay items annotated historical. All 22
source selftests pass (20 `*_selftest.py` files,
`transport/selftest.py`, and `helper/keepalive_selftest.sh`; count
re-verified 2026-09-21, all exit 0). Measured suite counts (2026-09-21):
keepalive 53 checks on the shipped copy (88 combined across both
variants); privacy/source_privacy 69/69; privacy/deidentif 30/30;
privacy/learner_vault 15/15; transport/item_bank_sdk 59;
transport/local_chromium 31; dispatch/executor_write_hardening 124
checks PASS.

### Item Bank lane hardening (2026-09-21)
  `transport/item_bank_sdk.py`: quiz-lti frame detection now requires a
  structural quiz-lti hostname label (optionally tenant-bound), HTTPS,
  and exact frame-origin binding of the captured banks.build token
  response; Item Banks tool resolution refuses duplicate matches and
  validates tool url/domain against the tenant domain family; launch
  JS builds the course URL with a JSON-encoded course id; bank/item ids
  are boundary-validated (non-empty, single path segment). Dead
  `_SDK_ITEM_IDS_RE`/`sdk_item_ids` removed. `transport/local_chromium.py`
  `capture_network_response` gained an optional `expected_origin` pin
  (W3-P2-17). `transport/chromium_session.py`: SDK lane status 0 and
  3xx never return as success (reads retry/fail fast, writes go
  UncertainWrite; W3-P2-19). `dispatch/executor.py` readback derivation
  now covers Item Bank bank/item create and member reads with nested
  `{"bank":{"id"}}` / `{"item":{"id"}}` payloads (W3-P2-22). Catalog
  gains IB-20 `canvas_item_bank_unshare_bank` (PATCH, live-proven;
  count 19 to 20). `proof-battery/item_bank_sdk_battery.py` (development
  worktree script, not shipped in the dist) records a
  terminal item GET after DELETE, correlated with the pre-delete GET
  (W3-P0-14). W3-P2-25 (`canvas_item_bank_get_item` unsupported entry)
  awaits the dedicated live battery result: still open.

### Item Bank smoke script and fan-out manifest removed (2026-09-21)
  `bin/smoke_bank_lifecycle.py` and
  `provision/manifests/morrow_read_item_bank_fan_out.json` deleted
  (W3-P2-21). The smoke script was the pre-SDK live lifecycle proof;
  the fan-out manifest had a proven live executor lane, but its
  frozen-plan form is superseded by the live Item Banks SDK lane
  (`transport/item_bank_sdk.py`), which derives quiz-lti frame origins,
  binds the banks.build token to the validated frame origin, and
  validates bank/item ids at the boundary. Current Item Bank lifecycle
  proof is `proof-battery/item_bank_sdk_battery.py` (development
  worktree script, not shipped in the dist; now with a
  terminal item GET readback after DELETE, W3-P0-14). References
  reconciled: `dispatch/integration_selftest.py` (hygiene list),
  `DEPLOY.md` (runnable example now `morrow_check_new_quiz`),
  `audit/desktop-parity-audit.md`,
  `audit/DESKTOP_TO_MUSE_MATRIX.md`, `INTEGRATION_NOTES.md`.

Documentation corrections from the 2026-09-21 adversarial gap audit
(a set of documentation findings from that audit's docs lane; the
finding numbers are not defined anywhere in this tree, so they are
recorded here in plain language only). No code changed.

- `SCOPE.md` rewritten to claim only what the batteries prove: New
  Quizzes narrowed to quiz-object create/update/delete through the
  Chromium lane (no publish, no question items, provider path only);
  Item Bank bank-level operations (create, rename, share, unshare,
  archive, list) confirmed IN for v1 after the 2026-09-21 operator
  correction and the 2026-09-21 Chromium write battery (IB-5 create,
  IB-16 rename, IB-17 share+unshare, IB-1 archive; SCOPE.md's earlier
  "dropped" wording was superseded); item-level CRUD stays out/roadmap
  per the catalog; course narrowed to read/update (create never
  tested, delete/conclude on evidence hold); pages except front-page
  management (C-333 failed live); discussion and classic-bank
  lifecycles removed (unproven); the 114 live-proven reads kept as a
  v1 claim with the self-contradicting footnote removed (ships in v1 =
  live-proven rows).
- `SKILL.md`: admission gate now documented as enforcing the
  live-proven catalog with an educator-signed `--allow-unproven`
  override; session-death note fixed (retry needs a freshly signed
  approval plus re-sign-in; multi-step partial-effect gap documented as
  latent); Blackboard stated as roadmap, not a ship criterion.
- `pack/pack.json`: governance section added documenting catalog
  enforcement, the `--allow-unproven` override, and the disambiguated
  op-id rules (consumed op ids are never reused; unjournaled op ids
  stay reusable).

## 0.3.0 (2026-09-21)

First distributable connector: Chromium-only Canvas core.

- Carved from the Morrow for Muse source tree as the standalone
  `morrow-muse-connector`: the live-proven Canvas Chromium lane, the
  governed dispatcher, the admission gate, the login helper, and the
  proof evidence. Nothing else ships.
- Chromium-only lane: the transport (`transport/local_chromium.py`,
  `transport/chromium_session.py`, `transport/egress.py`,
  `transport/proxy_forwarder.py`) and dispatch (`--backend chromium`)
  are pinned in `pack/pack.json`. The Chromium profile resolves inside
  the tree (`helper/profile/`); no fixed developer path remains.
- Egress probe carries no real tenant fallback; the helper refuses to
  start on the placeholder until the educator sets `CANVAS_BASE`.
- `SKILL.md`, `INSTALL.md` (zero tribal knowledge, clean uninstall),
  `SCOPE.md` (exact v1 declaration), and this changelog are new.
- `install.sh` is new: idempotent, stdlib + shell only, locates
  Chromium, probes egress, creates only the safe `~/.morrow` layout,
  installs one deduped keepalive cron entry, re-runs all selftests,
  runs the secrets gate, and never writes secrets.
- `pack/deny-list.txt` and `scripts/verify-no-secrets.sh` are new: the
  packaging secrets gate (private keys, live credential values, SPKI
  pin literals, proxy credentials, account-specific defaults,
  non-example tenant URLs, runtime state artifacts, retired-lane
  dependencies).
- Seven selftest suites ship and pass: Chromium session, egress,
  executor, admission, executor write hardening, v1 integration, and the
  offline login-helper suite. Learner-tokenization and provision-lane
  tests skip loudly; those lanes are out of v1.
- Content pages (`content/`) carry an explicit v1 packaging note:
  their original two-lane mechanics are superseded by the
  Chromium-only v1; `INSTALL.md` is authoritative.
- Proof evidence (`proof-battery/OPERATION_CATALOG.md`,
  `defects/DEFECTS.md`) is carried forward as clearly-marked example
  output, not defaults or credentials.

## 0.2.x (internal)

Pre-packaging development line. The live proof campaign (Item Banks,
New Quizzes, Moodle sandbox, dress-rehearsal battery) and the
adversarial defect log were built on this line. No public distribution.

## 0.1.x (internal)

Two-lane prototype (direct REST plus the since-retired form relay).
Superseded: the form relay is retired and excluded from this package.
