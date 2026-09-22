> RETIRED 2026-09-21. This brief was rendered for the form lane (the
> first-party static relay page, taken down 2026-09-21). The lane and the
> page are gone; do not execute this brief against them. Kept as the
> historical record of the 2026-09-20/21 Wave 1 battery.

# WAVE 1A: Canvas assignments, create, reads, overrides (course 89585)

This is Wave 1 of the Canvas REST live-proof battery. You are proving
assignment operations C-34 through C-51 (the pending ones) through the
form lane. Every write uses a disposable object; the wave ends with
everything deleted.

ID CAPTURE (do this as you go; the paths below use these placeholders):
- After op w1a-create: record the new assignment's "id" as {A}, and its
  "assignment_group_id" as {G}. Substitute {A} and {G} into every later
  path that contains them, before executing that op.
- After op w1a-sections: record the FIRST section's "id" as {S}.
  Substitute {S} into later paths.
- After op w1a-create-override: record the new override's "id" as {O}.
  Substitute {O} into later paths.

Rules: never report cookie values, the CSRF token value, or credential
material. Disposable objects only: create nothing except the one
assignment and its overrides. If any op returns 4xx/5xx, record the
status and body verbatim and continue.

--- BEGIN RENDERED BATCH BRIEF ---
You are executing a batch of Canvas REST API calls inside this browser's authenticated Canvas session, using the Morrow form relay page. Read every rule before acting.

HARD RULES:
- Do not sign in. Do not enter any credentials. Do not fill any login form.
- Visit no site other than https://chcp.instructure.com and https://meetmorrow.app/morrow/form-relay.
- NEVER report cookie values, the CSRF token value, or any credential material. Use the token in the relay page only.
- Work only with the API URLs below. Never click through the Canvas web UI; this is API work, not UI automation.
- Execute the operations in the exact order listed.

BATCH wave1a-assignments: 14 operation(s).

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
  op_id: w1a-create
  method: POST (via the relay page)
  Navigate to https://meetmorrow.app/morrow/form-relay
  Fill the 'Op brief (JSON)' textarea with EXACTLY the JSON below, character-for-character:
  {"action": "https://chcp.instructure.com/api/v1/courses/89585/assignments", "csrf_field": "authenticity_token", "fields": {"assignment[name]": "Morrow Proof Assignment (delete me)"}, "method": "POST", "v": 1}
  Fill the 'CSRF token' field with the token harvested in Step 2.
  Click the 'Build & submit' button.
  The tab will navigate to the Canvas API response for this op; note the HTTP status and the response body.
  If the relay page shows an error instead of submitting, report the error text exactly and continue with the next op.

STEP 4:
  op_id: w1a-get
  method: GET
  url: https://chcp.instructure.com/api/v1/courses/89585/assignments/{A}
  action: navigate (GET), report the JSON body

STEP 5:
  op_id: w1a-list
  method: GET
  url: https://chcp.instructure.com/api/v1/courses/89585/assignments
  action: navigate (GET), report the JSON body

STEP 6:
  op_id: w1a-sections
  method: GET
  url: https://chcp.instructure.com/api/v1/courses/89585/sections
  action: navigate (GET), report the JSON body

STEP 7:
  op_id: w1a-bulk-dates
  method: PUT (via the relay page)
  Navigate to https://meetmorrow.app/morrow/form-relay
  Fill the 'Op brief (JSON)' textarea with EXACTLY the JSON below, character-for-character:
  {"action": "https://chcp.instructure.com/api/v1/courses/89585/assignments/bulk_update", "csrf_field": "authenticity_token", "fields": {"assignment_ids[]": ["{A}"]}, "method": "PUT", "v": 1}
  Fill the 'CSRF token' field with the token harvested in Step 2.
  Click the 'Build & submit' button.
  The tab will navigate to the Canvas API response for this op; note the HTTP status and the response body.
  If the relay page shows an error instead of submitting, report the error text exactly and continue with the next op.

STEP 8:
  op_id: w1a-for-user
  method: GET
  url: https://chcp.instructure.com/api/v1/users/28206/courses/89585/assignments
  action: navigate (GET), report the JSON body

STEP 9:
  op_id: w1a-group-me
  method: GET
  url: https://chcp.instructure.com/api/v1/courses/89585/assignments/{A}/users/28206/group_me
  action: navigate (GET), report the JSON body

STEP 10:
  op_id: w1a-in-group
  method: GET
  url: https://chcp.instructure.com/api/v1/courses/89585/assignment_groups/{G}/assignments
  action: navigate (GET), report the JSON body

STEP 11:
  op_id: w1a-create-override
  method: POST (via the relay page)
  Navigate to https://meetmorrow.app/morrow/form-relay
  Fill the 'Op brief (JSON)' textarea with EXACTLY the JSON below, character-for-character:
  {"action": "https://chcp.instructure.com/api/v1/courses/89585/assignments/{A}/overrides", "csrf_field": "authenticity_token", "fields": {"assignment_override[course_section_id]": "{S}", "assignment_override[title]": "Morrow Proof Override (delete me)"}, "method": "POST", "v": 1}
  Fill the 'CSRF token' field with the token harvested in Step 2.
  Click the 'Build & submit' button.
  The tab will navigate to the Canvas API response for this op; note the HTTP status and the response body.
  If the relay page shows an error instead of submitting, report the error text exactly and continue with the next op.

STEP 12:
  op_id: w1a-list-overrides
  method: GET
  url: https://chcp.instructure.com/api/v1/courses/89585/assignments/{A}/overrides
  action: navigate (GET), report the JSON body

STEP 13:
  op_id: w1a-get-override
  method: GET
  url: https://chcp.instructure.com/api/v1/courses/89585/assignments/{A}/overrides/{O}
  action: navigate (GET), report the JSON body

STEP 14:
  op_id: w1a-update-override
  method: PUT (via the relay page)
  Navigate to https://meetmorrow.app/morrow/form-relay
  Fill the 'Op brief (JSON)' textarea with EXACTLY the JSON below, character-for-character:
  {"action": "https://chcp.instructure.com/api/v1/courses/89585/assignments/{A}/overrides/{O}", "csrf_field": "authenticity_token", "fields": {"assignment_override[title]": "Morrow Proof Override (renamed)"}, "method": "PUT", "v": 1}
  Fill the 'CSRF token' field with the token harvested in Step 2.
  Click the 'Build & submit' button.
  The tab will navigate to the Canvas API response for this op; note the HTTP status and the response body.
  If the relay page shows an error instead of submitting, report the error text exactly and continue with the next op.

STEP 15:
  op_id: w1a-delete-override
  method: DELETE (via the relay page)
  Navigate to https://meetmorrow.app/morrow/form-relay
  Fill the 'Op brief (JSON)' textarea with EXACTLY the JSON below, character-for-character:
  {"action": "https://chcp.instructure.com/api/v1/courses/89585/assignments/{A}/overrides/{O}", "csrf_field": "authenticity_token", "fields": {}, "method": "DELETE", "v": 1}
  Fill the 'CSRF token' field with the token harvested in Step 2.
  Click the 'Build & submit' button.
  The tab will navigate to the Canvas API response for this op; note the HTTP status and the response body.
  If the relay page shows an error instead of submitting, report the error text exactly and continue with the next op.

STEP 16:
  op_id: w1a-verify-override-gone
  method: GET
  url: https://chcp.instructure.com/api/v1/courses/89585/assignments/{A}/overrides/{O}
  action: navigate (GET), report the JSON body

REPORT FORMAT (follow exactly):
First, one line per op in order:
  op_id | http_status | first_500_chars_of_body
Then a final section starting with the literal line RESULTS_JSON
followed by a JSON array, one object per op, in order:
  [{"op_id": "...", "status": 200, "body": "<JSON-escaped, max 2000 chars>"}, ...]
If the session check failed, the whole report is the single line: session_dead
If an op fails for any other reason, report it and continue with the next op.
