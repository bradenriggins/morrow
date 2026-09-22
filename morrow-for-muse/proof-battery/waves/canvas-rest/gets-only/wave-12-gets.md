# WAVE 12 GETS: courses (course 89585)

GET-only live-proof battery through the browser task. Every step is a plain
GET navigation inside this browser's authenticated Canvas session. There are
NO writes in this brief: no relay page, no forms, no CSRF token, nothing is
created, modified, or deleted, so no cleanup is needed.

ID CAPTURE (do this as you go; later steps use these placeholders):
- After the course anchor: record the "account_id" field as {ACCT}.
- After list users: record the first user's "id" as {U}.

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
  op_id: g12-1
  catalog: C-105
  method: GET
  url: https://chcp.instructure.com/api/v1/courses/89585/activity_stream
  action: navigate (GET), report the body
STEP 3:
  op_id: g12-2
  catalog: C-106
  method: GET
  url: https://chcp.instructure.com/api/v1/courses/89585/activity_stream/summary
  action: navigate (GET), report the body
STEP 4:
  op_id: g12-3
  catalog: C-107
  method: GET
  url: https://chcp.instructure.com/api/v1/courses/89585/todo
  action: navigate (GET), report the body
STEP 5:
  op_id: g12-4
  catalog: C-109
  method: GET
  url: https://chcp.instructure.com/api/v1/courses/89585/bulk_user_progress
  action: navigate (GET), report the body
STEP 6:
  op_id: g12-5
  catalog: C-111
  method: GET
  url: https://chcp.instructure.com/api/v1/courses/89585/settings
  action: navigate (GET), report the body
STEP 7:
  op_id: g12-6
  catalog: C-112
  method: GET
  url: https://chcp.instructure.com/api/v1/courses/89585/effective_due_dates
  action: navigate (GET), report the body
STEP 8:
  op_id: g12-anchor-course
  catalog: course show (already live-proven; ID capture only, not a proof claim) (ANCHOR: already live-proven; ID capture only, not a proof claim)
  method: GET
  url: https://chcp.instructure.com/api/v1/courses/89585
  action: navigate (GET), report the body
  capture: the "account_id" field as {ACCT}
STEP 9:
  op_id: g12-7
  catalog: C-113
  method: GET
  url: https://chcp.instructure.com/api/v1/accounts/{ACCT}/courses/89585
  action: navigate (GET), report the body
  only if: {ACCT} captured; otherwise report "skipped" with the reason and continue
STEP 10:
  op_id: g12-8
  catalog: C-120
  method: GET
  url: https://chcp.instructure.com/api/v1/courses/89585/users
  action: navigate (GET), report the body
  capture: first element's "id" as {U}
STEP 11:
  op_id: g12-9
  catalog: C-115
  method: GET
  url: https://chcp.instructure.com/api/v1/courses/89585/users/{U}
  action: navigate (GET), report the body
  only if: {U} captured; otherwise report "skipped" with the reason and continue
STEP 12:
  op_id: g12-10
  catalog: C-116
  method: GET
  url: https://chcp.instructure.com/api/v1/courses/89585/users/{U}/progress
  action: navigate (GET), report the body
  only if: {U} captured; otherwise report "skipped" with the reason and continue
STEP 13:
  op_id: g12-11
  catalog: C-117
  method: GET
  url: https://chcp.instructure.com/api/v1/courses/89585/recent_students
  action: navigate (GET), report the body
STEP 14:
  op_id: g12-12
  catalog: C-118
  method: GET
  url: https://chcp.instructure.com/api/v1/courses/89585/students
  action: navigate (GET), report the body
STEP 15:
  op_id: g12-13
  catalog: C-119
  method: GET
  url: https://chcp.instructure.com/api/v1/courses/89585/search_users
  action: navigate (GET), report the body
  PROBE: record the status and body honestly; a 4xx here is a valid result
STEP 16:
  op_id: g12-14
  catalog: C-121
  method: GET
  url: https://chcp.instructure.com/api/v1/courses/89585/permissions
  action: navigate (GET), report the body
STEP 17:
  op_id: g12-15
  catalog: C-126
  method: GET
  url: https://chcp.instructure.com/api/v1/courses/89585/student_view_student
  action: navigate (GET), report the body
STEP 18:
  op_id: g12-16
  catalog: C-127
  method: GET
  url: https://chcp.instructure.com/api/v1/courses/89585/content_share_users
  action: navigate (GET), report the body
REPORT FORMAT (follow exactly):
First, one line per op in order:
  op_id | http_status | first_500_chars_of_body
(For skipped conditional steps: op_id | skipped | reason.)
Then a final section starting with the literal line RESULTS_JSON
followed by a JSON array, one object per op, in order:
  [{"op_id": "...", "status": 200, "body": "<JSON-escaped, max 2000 chars>"}, ...]
If the session check failed, the whole report is the single line: session_dead
