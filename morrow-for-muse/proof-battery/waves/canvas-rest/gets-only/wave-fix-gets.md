# WAVE FIX GETS: brief-defect reruns (course 89585)

GET-only live-proof battery through the browser task. Every step is a plain
GET navigation inside this browser's authenticated Canvas session. There are
NO writes in this brief: no relay page, no forms, no CSRF token, nothing is
created, modified, or deleted, so no cleanup is needed.

PURPOSE: rerun ops whose first attempt failed only because the brief rendered
a malformed URL or omitted required query parameters. These are brief defects,
not endpoint defects.

HARD RULES:
- Do not sign in. Do not enter any credentials. Do not fill any login form.
- Visit no site other than https://chcp.instructure.com.
- NEVER report cookie values, the CSRF token value, or any credential material.
- Work only with the API URLs below. Never click through the Canvas web UI;
  this is API work, not UI automation.
- Execute the operations in the exact order listed.

STEP 1, SESSION CHECK (always first):
Navigate to https://chcp.instructure.com/api/v1/users/self and read the JSON body.
Session is alive only if the JSON shows id 28206 and name "Braden Riggins".
If you see a login page, a login redirect, or an error instead: STOP the whole
brief immediately and report session_dead. Attempt nothing further.

STEPS 2..N, THE OPERATIONS (in order):
Pace yourself: about one op every few seconds. On HTTP 429, wait the
Retry-After seconds and retry that op once. If an op returns 4xx/5xx, record
the status and body verbatim and continue with the next op; a 4xx on a step
marked PROBE is a valid result, not a failure.

STEP 2:
  op_id: f-1
  catalog: C-272
  method: GET
  url: https://chcp.instructure.com/api/v1/courses/89585/module_item_sequence?asset_type=ModuleItem&asset_id=9274395
  action: navigate (GET), report the body
  note: first attempt omitted required query params (400 invalid asset_type). Module item 9274395 exists.

STEP 3:
  op_id: f-2
  catalog: C-202
  method: GET
  url: https://chcp.instructure.com/api/v1/courses/89585/folders/by_path?path=course%20files
  action: navigate (GET), report the body
  note: first attempt used path segments (404). Trying the ?path= query form.

STEP 4:
  op_id: f-3
  catalog: C-322
  method: GET
  url: https://chcp.instructure.com/api/v1/courses/89585/outcome_alignments?assignment_id=3636219
  action: navigate (GET), report the body
  note: first attempt omitted the required student_id/assignment_id scope. Assignment 3636219 exists.

STEP 5:
  op_id: f-4
  catalog: C-127
  method: GET
  url: https://chcp.instructure.com/api/v1/courses/89585/content_share_users?search_term=Student
  action: navigate (GET), report the body
  note: first attempt omitted required search_term (400 bad_request).

STEP 6:
  op_id: f-5
  catalog: C-180
  method: GET
  url: https://chcp.instructure.com/api/v1/courses/89585/external_tools/sessionless_launch?id=292087
  action: navigate (GET), report the body
  note: first attempt omitted the tool id (400 validation). Tool 292087 (Clover Learning) exists.

REPORT FORMAT (follow exactly):
First, one line per op in order:
  op_id | http_status | first_500_chars_of_body
(For skipped conditional steps: op_id | skipped | reason.)
Then a final section starting with the literal line RESULTS_JSON
followed by a JSON array, one object per op, in order:
  [{"op_id": "...", "status": 200, "body": "<JSON-escaped, max 2000 chars>"}, ...]
If the session check failed, the whole report is the single line: session_dead
