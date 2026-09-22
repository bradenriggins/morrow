> RETIRED 2026-09-21. This brief was rendered for the form lane (the
> first-party static relay page, taken down 2026-09-21). The lane and the
> page are gone; do not execute this brief against them. Kept as the
> historical record of the 2026-09-20/21 Wave 1 battery.

# WAVE 1B: Canvas assignments, batch overrides, duplicate, full cleanup (course 89585)

PREREQUISITE: Wave 1A must have completed. Take {A} (assignment id) and
{S} (section id) from the Wave 1A report's RESULTS_JSON and substitute
them into every path below before executing.

This wave proves C-34 (batch create overrides), C-35 (batch retrieve),
C-36 (batch update), C-42 (duplicate assignment), and re-uses C-40/C-41
for cleanup. It ends with the assignment, its duplicate, and every
override DELETED, each verified gone with a 404 readback. Nothing may
remain.

ID CAPTURE:
- After op w1b-batch-create: record the new override's "id" as {B}.
- After op w1b-duplicate: record the duplicate assignment's "id" as {D}.
  Substitute into later paths before executing.

Rules: never report cookie values, the CSRF token value, or credential
material. If any op returns 4xx/5xx, record the status and body verbatim
and continue. The final state must be: assignment {A} gone (404),
duplicate {D} gone (404), overrides {B} gone (404).

--- BEGIN RENDERED BATCH BRIEF ---
You are executing a batch of Canvas REST API calls inside this browser's authenticated Canvas session, using the Morrow form relay page. Read every rule before acting.

HARD RULES:
- Do not sign in. Do not enter any credentials. Do not fill any login form.
- Visit no site other than https://chcp.instructure.com and https://meetmorrow.app/morrow/form-relay.
- NEVER report cookie values, the CSRF token value, or any credential material. Use the token in the relay page only.
- Work only with the API URLs below. Never click through the Canvas web UI; this is API work, not UI automation.
- Execute the operations in the exact order listed.

BATCH wave1b-assignments: 10 operation(s).

STEP 1, SESSION CHECK (always first):
Navigate to https://chcp.instructure.com/api/v1/users/self and read the JSON body.
Session is alive only if the JSON shows id 28206 and name "Braden Riggins".
If you see a login page, a login redirect, or an error instead: STOP the whole batch immediately and report session_dead. Attempt nothing further.

STEP 2, HARVEST THE CSRF TOKEN:
Stay on https://chcp.instructure.com. Read the _csrf_token cookie fresh from document.cookie in the page context of the current page, once per write, immediately before the relay submission. NEVER read a meta tag and NEVER use hidden form inputs as token sources.
Keep the value ready for the relay steps below. NEVER write it into your report, your notes, or any message.

STEPS 3..N, THE OPERATIONS (in order):
Pace yourself: about one op every few seconds. On HTTP 429, wait the Retry-After seconds and retry that op once.

STEP 3:
  op_id: w1b-batch-create
  method: POST (via the relay page)
  Navigate to https://meetmorrow.app/morrow/form-relay
  Fill the 'Op brief (JSON)' textarea with EXACTLY the JSON below, character-for-character:
  {"action": "https://chcp.instructure.com/api/v1/courses/89585/assignments/overrides", "csrf_field": "authenticity_token", "fields": {"assignment_override[assignment_id]": "{A}", "assignment_override[course_section_id]": "{S}", "assignment_override[title]": "Morrow Proof Batch Override (delete me)"}, "method": "POST", "v": 1}
  Fill the 'CSRF token' field with the token harvested in Step 2.
  Click the 'Build & submit' button.
  The tab will navigate to the Canvas API response for this op; note the HTTP status and the response body.
  If the relay page shows an error instead of submitting, report the error text exactly and continue with the next op.

STEP 4:
  op_id: w1b-batch-retrieve
  method: GET
  url: https://chcp.instructure.com/api/v1/courses/89585/assignments/overrides
  action: navigate (GET), report the JSON body

STEP 5:
  op_id: w1b-batch-update
  method: PUT (via the relay page)
  Navigate to https://meetmorrow.app/morrow/form-relay
  Fill the 'Op brief (JSON)' textarea with EXACTLY the JSON below, character-for-character:
  {"action": "https://chcp.instructure.com/api/v1/courses/89585/assignments/overrides", "csrf_field": "authenticity_token", "fields": {"assignment_overrides[][id]": "{B}", "assignment_overrides[][title]": "Morrow Proof Batch Override (renamed)"}, "method": "PUT", "v": 1}
  Fill the 'CSRF token' field with the token harvested in Step 2.
  Click the 'Build & submit' button.
  The tab will navigate to the Canvas API response for this op; note the HTTP status and the response body.
  If the relay page shows an error instead of submitting, report the error text exactly and continue with the next op.

STEP 6:
  op_id: w1b-delete-batch-override
  method: DELETE (via the relay page)
  Navigate to https://meetmorrow.app/morrow/form-relay
  Fill the 'Op brief (JSON)' textarea with EXACTLY the JSON below, character-for-character:
  {"action": "https://chcp.instructure.com/api/v1/courses/89585/assignments/{A}/overrides/{B}", "csrf_field": "authenticity_token", "fields": {}, "method": "DELETE", "v": 1}
  Fill the 'CSRF token' field with the token harvested in Step 2.
  Click the 'Build & submit' button.
  The tab will navigate to the Canvas API response for this op; note the HTTP status and the response body.
  If the relay page shows an error instead of submitting, report the error text exactly and continue with the next op.

STEP 7:
  op_id: w1b-verify-batch-gone
  method: GET
  url: https://chcp.instructure.com/api/v1/courses/89585/assignments/{A}/overrides/{B}
  action: navigate (GET), report the JSON body

STEP 8:
  op_id: w1b-duplicate
  method: POST (via the relay page)
  Navigate to https://meetmorrow.app/morrow/form-relay
  Fill the 'Op brief (JSON)' textarea with EXACTLY the JSON below, character-for-character:
  {"action": "https://chcp.instructure.com/api/v1/courses/89585/assignments/{A}/duplicate", "csrf_field": "authenticity_token", "fields": {}, "method": "POST", "v": 1}
  Fill the 'CSRF token' field with the token harvested in Step 2.
  Click the 'Build & submit' button.
  The tab will navigate to the Canvas API response for this op; note the HTTP status and the response body.
  If the relay page shows an error instead of submitting, report the error text exactly and continue with the next op.

STEP 9:
  op_id: w1b-delete-duplicate
  method: DELETE (via the relay page)
  Navigate to https://meetmorrow.app/morrow/form-relay
  Fill the 'Op brief (JSON)' textarea with EXACTLY the JSON below, character-for-character:
  {"action": "https://chcp.instructure.com/api/v1/courses/89585/assignments/{D}", "csrf_field": "authenticity_token", "fields": {}, "method": "DELETE", "v": 1}
  Fill the 'CSRF token' field with the token harvested in Step 2.
  Click the 'Build & submit' button.
  The tab will navigate to the Canvas API response for this op; note the HTTP status and the response body.
  If the relay page shows an error instead of submitting, report the error text exactly and continue with the next op.

STEP 10:
  op_id: w1b-verify-dup-gone
  method: GET
  url: https://chcp.instructure.com/api/v1/courses/89585/assignments/{D}
  action: navigate (GET), report the JSON body

STEP 11:
  op_id: w1b-delete-assignment
  method: DELETE (via the relay page)
  Navigate to https://meetmorrow.app/morrow/form-relay
  Fill the 'Op brief (JSON)' textarea with EXACTLY the JSON below, character-for-character:
  {"action": "https://chcp.instructure.com/api/v1/courses/89585/assignments/{A}", "csrf_field": "authenticity_token", "fields": {}, "method": "DELETE", "v": 1}
  Fill the 'CSRF token' field with the token harvested in Step 2.
  Click the 'Build & submit' button.
  The tab will navigate to the Canvas API response for this op; note the HTTP status and the response body.
  If the relay page shows an error instead of submitting, report the error text exactly and continue with the next op.

STEP 12:
  op_id: w1b-verify-gone
  method: GET
  url: https://chcp.instructure.com/api/v1/courses/89585/assignments/{A}
  action: navigate (GET), report the JSON body

REPORT FORMAT (follow exactly):
First, one line per op in order:
  op_id | http_status | first_500_chars_of_body
Then a final section starting with the literal line RESULTS_JSON
followed by a JSON array, one object per op, in order:
  [{"op_id": "...", "status": 200, "body": "<JSON-escaped, max 2000 chars>"}, ...]
If the session check failed, the whole report is the single line: session_dead
If an op fails for any other reason, report it and continue with the next op.
