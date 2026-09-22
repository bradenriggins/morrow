# WAVE 14 GETS: misc reads + learning_object_dates (course 89585)

GET-only live-proof battery through the browser task. Every step is a plain
GET navigation inside this browser's authenticated Canvas session. There are
NO writes in this brief: no relay page, no forms, no CSRF token, nothing is
created, modified, or deleted, so no cleanup is needed.

ID CAPTURE (do this as you go; later steps use these placeholders):
- After list blueprint subscriptions: record the first subscription's "id" as {BS} (may be none).
- After list blueprint imports: record the first migration's "id" as {BM} (may be none).
- Anchors capture: {A} first assignment id, {FI} first file id, {M} first module id,
  {P} first page url, {Q} first quiz id. Anchors are not proof claims.

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
  op_id: g14-1
  catalog: C-27
  method: GET
  url: https://chcp.instructure.com/api/v1/courses/89585/external_feeds
  action: navigate (GET), report the body
STEP 3:
  op_id: g14-2
  catalog: C-59
  method: GET
  url: https://chcp.instructure.com/api/v1/courses/89585/block_editor_templates
  action: navigate (GET), report the body
STEP 4:
  op_id: g14-3
  catalog: C-68
  method: GET
  url: https://chcp.instructure.com/api/v1/courses/89585/blueprint_subscriptions
  action: navigate (GET), report the body
  capture: first element's "id" as {BS} if any exist
STEP 5:
  op_id: g14-4
  catalog: C-66
  method: GET
  url: https://chcp.instructure.com/api/v1/courses/89585/blueprint_subscriptions/{BS}/migrations
  action: navigate (GET), report the body
  capture: first element's "id" as {BM} if any exist
  only if: {BS} captured; otherwise report "skipped" with the reason and continue
STEP 6:
  op_id: g14-5
  catalog: C-70
  method: GET
  url: https://chcp.instructure.com/api/v1/courses/89585/blueprint_subscriptions/{BS}/migrations/{BM}
  action: navigate (GET), report the body
  only if: {BS} and {BM} captured; otherwise report "skipped" with the reason and continue
STEP 7:
  op_id: g14-6
  catalog: C-73
  method: GET
  url: https://chcp.instructure.com/api/v1/courses/89585/brand_variables
  action: navigate (GET), report the body
STEP 8:
  op_id: g14-7
  catalog: C-94
  method: GET
  url: https://chcp.instructure.com/api/v1/courses/89585/csp_settings
  action: navigate (GET), report the body
STEP 9:
  op_id: g14-8
  catalog: C-187
  method: GET
  url: https://chcp.instructure.com/api/v1/courses/89585/features/enabled
  action: navigate (GET), report the body
STEP 10:
  op_id: g14-9
  catalog: C-188
  method: GET
  url: https://chcp.instructure.com/api/v1/courses/89585/features
  action: navigate (GET), report the body
STEP 11:
  op_id: g14-anchor-assignments
  catalog: assignments list (proven tonight as w1a-list; ID capture only, not a proof claim) (ANCHOR: already live-proven; ID capture only, not a proof claim)
  method: GET
  url: https://chcp.instructure.com/api/v1/courses/89585/assignments
  action: navigate (GET), report the body
  capture: first element's "id" as {A}
STEP 12:
  op_id: g14-10
  catalog: C-231
  method: GET
  url: https://chcp.instructure.com/api/v1/courses/89585/assignments/{A}/date_details
  action: navigate (GET), report the body
  only if: {A} captured; otherwise report "skipped" with the reason and continue
STEP 13:
  op_id: g14-anchor-files
  catalog: files list (C-197, also covered in wave 3; ID capture only here) (ANCHOR: already live-proven; ID capture only, not a proof claim)
  method: GET
  url: https://chcp.instructure.com/api/v1/courses/89585/files
  action: navigate (GET), report the body
  capture: first element's "id" as {FI}
STEP 14:
  op_id: g14-11
  catalog: C-233
  method: GET
  url: https://chcp.instructure.com/api/v1/courses/89585/files/{FI}/date_details
  action: navigate (GET), report the body
  only if: {FI} captured; otherwise report "skipped" with the reason and continue
STEP 15:
  op_id: g14-anchor-modules
  catalog: modules list (C-275, live-proven; ID capture only, not a proof claim) (ANCHOR: already live-proven; ID capture only, not a proof claim)
  method: GET
  url: https://chcp.instructure.com/api/v1/courses/89585/modules
  action: navigate (GET), report the body
  capture: first element's "id" as {M}
STEP 16:
  op_id: g14-12
  catalog: C-234
  method: GET
  url: https://chcp.instructure.com/api/v1/courses/89585/modules/{M}/date_details
  action: navigate (GET), report the body
  only if: {M} captured; otherwise report "skipped" with the reason and continue
STEP 17:
  op_id: g14-anchor-pages
  catalog: pages list (C-326, also covered in wave 2; ID capture only here) (ANCHOR: already live-proven; ID capture only, not a proof claim)
  method: GET
  url: https://chcp.instructure.com/api/v1/courses/89585/pages
  action: navigate (GET), report the body
  capture: first element's "url" as {P}
STEP 18:
  op_id: g14-13
  catalog: C-235
  method: GET
  url: https://chcp.instructure.com/api/v1/courses/89585/pages/{P}/date_details
  action: navigate (GET), report the body
  only if: {P} captured; otherwise report "skipped" with the reason and continue
STEP 19:
  op_id: g14-anchor-quizzes
  catalog: quizzes list (C-378, also covered in wave 4; ID capture only here) (ANCHOR: already live-proven; ID capture only, not a proof claim)
  method: GET
  url: https://chcp.instructure.com/api/v1/courses/89585/quizzes
  action: navigate (GET), report the body
  capture: first element's "id" as {Q}
STEP 20:
  op_id: g14-14
  catalog: C-236
  method: GET
  url: https://chcp.instructure.com/api/v1/courses/89585/quizzes/{Q}/date_details
  action: navigate (GET), report the body
  only if: {Q} captured; otherwise report "skipped" with the reason and continue
STEP 21:
  op_id: g14-15
  catalog: C-343
  method: GET
  url: https://chcp.instructure.com/api/v1/courses/89585/quizzes/assignment_overrides
  action: navigate (GET), report the body
STEP 22:
  op_id: g14-16
  catalog: C-344
  method: GET
  url: https://chcp.instructure.com/api/v1/courses/89585/new_quizzes/assignment_overrides
  action: navigate (GET), report the body
STEP 23:
  op_id: g14-17
  catalog: C-346
  method: GET
  url: https://chcp.instructure.com/api/v1/courses/89585/quizzes/{Q}/ip_filters
  action: navigate (GET), report the body
  only if: {Q} captured; otherwise report "skipped" with the reason and continue
STEP 24:
  op_id: g14-18
  catalog: C-402
  method: GET
  url: https://chcp.instructure.com/api/sis/courses/89585/assignments
  action: navigate (GET), report the body
  PROBE: record the status and body honestly; a 4xx here is a valid result
STEP 25:
  op_id: g14-19
  catalog: C-403
  method: GET
  url: https://chcp.instructure.com/api/v1/courses/89585/smartsearch?q=test
  action: navigate (GET), report the body
  PROBE: record the status and body honestly; a 4xx here is a valid result
REPORT FORMAT (follow exactly):
First, one line per op in order:
  op_id | http_status | first_500_chars_of_body
(For skipped conditional steps: op_id | skipped | reason.)
Then a final section starting with the literal line RESULTS_JSON
followed by a JSON array, one object per op, in order:
  [{"op_id": "...", "status": 200, "body": "<JSON-escaped, max 2000 chars>"}, ...]
If the session check failed, the whole report is the single line: session_dead
