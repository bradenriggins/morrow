# Moodle lane: skill instruction layer

How the agent uses the Moodle session lane. This is the instruction
text the connector skill carries. The Python module enforces session
and transport checks; its write method does not enforce the approval
boundary described below.

## Browser-owned production course read candidate

For a school Moodle connection, use `python3 -m moodle.browser_read start
--base <school HTTPS Moodle URL>` from the installed tree. Show the educator
the helper sign-in page through the existing user-controlled VM helper access.
The educator enters their credentials on the school page, never in Muse chat.
Then run `python3 -m moodle.browser_read courses`. It returns only a pinned
Moodle user ID and course IDs/names. If the site does not expose the course-list
AJAX function, report that the read is unavailable on this deployment. Do not
use `login.py` with school credentials. Do not send a Moodle write or learner
data through this browser read path. A successful sign-in page alone is not
connection proof; require the course read. The source candidate still needs a
live Muse VM sign-in and readback before a production claim.

## Session bootstrap (Lane 2 pattern)

1. The educator signs in once through the school's page in the Muse VM
   browser. The form login in `login.py` proves the separate HTTPS lane
   with the provider's published sandbox credentials; it is not a
   production browser-session handoff.
2. The Python lane accepts an in-memory `requests.Session` and sesskey
   through `MoodleSession.from_bundle`. The release package does not
   include a command that transfers the VM browser session into that
   bundle. Do not export a school session cookie into a file, command,
   transcript, or chat to bridge this gap. Keep an existing working VM
   browser path in its browser-owned session. Code that already owns a
   live `MoodleSession` can call `moodle.keepalive.probe_session(sess)`
   for one read-only session check; a scheduled process cannot reload
   that session from JSON.
3. In the HTTPS lane, the sesskey is a per-session value of 10 or more
   characters that does not rotate; it goes in the `sesskey` query param of every
   `lib/ajax/service.php` call and in the `sesskey` field of every form
   POST. It is visible by design (it is readable from page content), but
   it is still never written to logs, transcripts, or chat.

## Dispatch rules

- AJAX first: `POST {base}/lib/ajax/service.php?sesskey=...&info=<fn>`
  with body `[{"index":0,"methodname":"<fn>","args":{...}}]`.
- If the envelope error is `servicenotavailable`, the function is not
  `allowed_from_ajax` on this deployment: use the form-path fallback.
  Precision note on who does what: the lane's `form_write` posts the
  caller-supplied fields plus the session sesskey to the form URL; it
  does NOT fetch the form or extract its hidden fields. Fetching the
  form and extracting hidden fields (including the form's own sesskey)
  is an agent-operator step (the wave-2 discovery scripts show the
  pattern), not something the lane does on its own. Never invent a
  third path.
- If a call returns a top-level `{"errorcode":"invalidrecordunknown"}`
  dict instead of the envelope list, the function is not registered on
  this deployment at all. Report it as not-available, never as a
  provider domain error.
- Result bounding: truncate payloads past the byte cap (head), keep
  receipts to identifying fields (id, name, subject), redact learner
  data before presenting anything.

## Write governance (no exceptions)

`MoodleSession.write` is a low-level HTTPS method. It does not check the
operation catalog, Plan/Edit mode, or an educator approval. Do not call it
for production course writes until it is behind those gates. A working VM
browser path must keep its own approval and provider readback checks.

1. Frozen plan first: op id (UUID), tool, exact args, before-state
   snapshot, expected after-state, frozen readback.
2. Dispatch checks the op id against the used-op set; a repeat is
   refused, never retried.
3. Run the frozen readback and assert the expected fields. The
   readback digest goes in the journal entry.
4. Journal every op (append-only JSONL): op id, tool, args digest,
   receipt, verification status. Never edit entries; supersede with
   new ones.
5. Undo availability is declared before dispatch. Where the provider
   offers no inverse, say so before dispatch, never after. For forum
   discussions on Moodle 5.2 the undo is the form-path delete of the
   discussion's first post.

## Expiry handling (the state machine, not an error message)

- DETECT: envelope `servicerequireslogin` (or the older
  `requireloginerror`/`sessionerror`), or a 30x to `/login` on page
  requests. `invalidsesskey` means refresh the sesskey from a live
  page and retry once; it is not expiry.
- HALT: stop dispatching writes immediately. Quarantine in-flight
  ops; never retry them blind against a dead session.
- NOTIFY: plain language; which connection, what is paused, nothing lost.
- RE-SIGN-IN: run the bootstrap again.
- VERIFIED RESUME: the principal after re-auth must match the stored
  principal (id + username). Replay quarantined ops only with fresh
  per-action approval.

## What this lane never does

- Never mint a persistent API token from the session
  (no session-to-token escalation, ever).
- Never exceed the educator's own account permissions.
- Never write cookie or sesskey values to disk, logs, or chat.
  The journal records shapes, statuses, lengths, and IDs only.
