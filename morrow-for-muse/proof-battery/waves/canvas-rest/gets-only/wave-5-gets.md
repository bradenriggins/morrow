# WAVE 5 GETS: rubrics (course 89585)

GET-only live-proof battery through the browser task. Every step is a plain
GET navigation inside this browser's authenticated Canvas session. There are
NO writes in this brief: no relay page, no forms, no CSRF token, nothing is
created, modified, or deleted, so no cleanup is needed.

ID CAPTURE (do this as you go; later steps use these placeholders):
- After list rubrics: record the first rubric's "id" as {R} (may be none).

HARD RULES:
- Do not sign in. Do not enter any credentials. Do not fill any login form.
- Visit no site other than https://chcp.instructure.com.
- NEVER report cookie values, the CSRF token value, or any credential material.
- Work only with the API URLs below. Never click through the Canvas web UI;
  this is API work, not UI automation.
- Execute the operations in the exact order listed.
- Steps marked ANCHOR use an already-proven endpoint only to capture an ID
  for later steps. They are not proof claims; run them exactly as written.

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
  op_id: g5-1
  catalog: C-393
  method: GET
  url: https://chcp.instructure.com/api/v1/courses/89585/rubrics
  action: navigate (GET), report the body
  capture: first element's "id" as {R} if any exist
STEP 3:
  op_id: g5-2
  catalog: C-391
  method: GET
  url: https://chcp.instructure.com/api/v1/courses/89585/rubrics/{R}
  action: navigate (GET), report the body
  only if: {R} captured; otherwise report "skipped" with the reason and continue
STEP 4:
  op_id: g5-3
  catalog: C-390
  method: GET
  url: https://chcp.instructure.com/api/v1/courses/89585/rubrics/{R}/used_locations
  action: navigate (GET), report the body
  only if: {R} captured; otherwise report "skipped" with the reason and continue
REPORT FORMAT (follow exactly):
First, one line per op in order:
  op_id | http_status | first_500_chars_of_body
(For skipped conditional steps: op_id | skipped | reason.)
Then a final section starting with the literal line RESULTS_JSON
followed by a JSON array, one object per op, in order:
  [{"op_id": "...", "status": 200, "body": "<JSON-escaped, max 2000 chars>"}, ...]
If the session check failed, the whole report is the single line: session_dead
