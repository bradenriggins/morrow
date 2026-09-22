# WAVE 10 GETS: tabs + external_tools + LTI + collaborations + conferences (course 89585)

GET-only live-proof battery through the browser task. Every step is a plain
GET navigation inside this browser's authenticated Canvas session. There are
NO writes in this brief: no relay page, no forms, no CSRF token, nothing is
created, modified, or deleted, so no cleanup is needed.

ID CAPTURE (do this as you go; later steps use these placeholders):
- After list external tools: record the first tool's "id" as {T} (may be none).
- After list LTI resource links: record the first link's "id" as {L} (may be none).

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
  op_id: g10-1
  catalog: C-433
  method: GET
  url: https://chcp.instructure.com/api/v1/courses/89585/tabs
  action: navigate (GET), report the body
STEP 3:
  op_id: g10-2
  catalog: C-183
  method: GET
  url: https://chcp.instructure.com/api/v1/courses/89585/external_tools
  action: navigate (GET), report the body
  capture: first element's "id" as {T} if any exist
STEP 4:
  op_id: g10-3
  catalog: C-181
  method: GET
  url: https://chcp.instructure.com/api/v1/courses/89585/external_tools/{T}
  action: navigate (GET), report the body
  only if: {T} captured; otherwise report "skipped" with the reason and continue
STEP 5:
  op_id: g10-4
  catalog: C-182
  method: GET
  url: https://chcp.instructure.com/api/v1/courses/89585/external_tools/visible_course_nav_tools
  action: navigate (GET), report the body
STEP 6:
  op_id: g10-5
  catalog: C-180
  method: GET
  url: https://chcp.instructure.com/api/v1/courses/89585/external_tools/sessionless_launch
  action: navigate (GET), report the body
  PROBE: record the status and body honestly; a 4xx here is a valid result
STEP 7:
  op_id: g10-6
  catalog: C-251
  method: GET
  url: https://chcp.instructure.com/api/v1/courses/89585/lti_apps/launch_definitions
  action: navigate (GET), report the body
STEP 8:
  op_id: g10-7
  catalog: C-255
  method: GET
  url: https://chcp.instructure.com/api/v1/courses/89585/lti_resource_links
  action: navigate (GET), report the body
  capture: first element's "id" as {L} if any exist
STEP 9:
  op_id: g10-8
  catalog: C-256
  method: GET
  url: https://chcp.instructure.com/api/v1/courses/89585/lti_resource_links/{L}
  action: navigate (GET), report the body
  only if: {L} captured; otherwise report "skipped" with the reason and continue
STEP 10:
  op_id: g10-9
  catalog: C-77
  method: GET
  url: https://chcp.instructure.com/api/v1/courses/89585/collaborations
  action: navigate (GET), report the body
STEP 11:
  op_id: g10-10
  catalog: C-78
  method: GET
  url: https://chcp.instructure.com/api/v1/courses/89585/potential_collaborators
  action: navigate (GET), report the body
STEP 12:
  op_id: g10-11
  catalog: C-79
  method: GET
  url: https://chcp.instructure.com/api/v1/courses/89585/conferences
  action: navigate (GET), report the body
REPORT FORMAT (follow exactly):
First, one line per op in order:
  op_id | http_status | first_500_chars_of_body
(For skipped conditional steps: op_id | skipped | reason.)
Then a final section starting with the literal line RESULTS_JSON
followed by a JSON array, one object per op, in order:
  [{"op_id": "...", "status": 200, "body": "<JSON-escaped, max 2000 chars>"}, ...]
If the session check failed, the whole report is the single line: session_dead
