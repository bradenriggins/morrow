# WAVE 3 GETS: files + media_objects (course 89585)

GET-only live-proof battery through the browser task. Every step is a plain
GET navigation inside this browser's authenticated Canvas session. There are
NO writes in this brief: no relay page, no forms, no CSRF token, nothing is
created, modified, or deleted, so no cleanup is needed.

ID CAPTURE (do this as you go; later steps use these placeholders):
- After list folders: record the first folder's "id" as {F}.
- After list files: record the first file's "id" as {FI}.
- After list folders: record the first folder's "full_name" as {FP} (e.g. "course files").

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
  op_id: g3-1
  catalog: C-196
  method: GET
  url: https://chcp.instructure.com/api/v1/courses/89585/folders
  action: navigate (GET), report the body
  capture: first element's "id" as {F} and "full_name" as {FP}
STEP 3:
  op_id: g3-2
  catalog: C-197
  method: GET
  url: https://chcp.instructure.com/api/v1/courses/89585/files
  action: navigate (GET), report the body
  capture: first element's "id" as {FI}
STEP 4:
  op_id: g3-3
  catalog: C-194
  method: GET
  url: https://chcp.instructure.com/api/v1/courses/89585/files/quota
  action: navigate (GET), report the body
STEP 5:
  op_id: g3-4
  catalog: C-198
  method: GET
  url: https://chcp.instructure.com/api/v1/courses/89585/content_licenses
  action: navigate (GET), report the body
STEP 6:
  op_id: g3-5
  catalog: C-195
  method: GET
  url: https://chcp.instructure.com/api/v1/courses/89585/folders/media
  action: navigate (GET), report the body
STEP 7:
  op_id: g3-6
  catalog: C-258
  method: GET
  url: https://chcp.instructure.com/api/v1/courses/89585/media_attachments
  action: navigate (GET), report the body
STEP 8:
  op_id: g3-7
  catalog: C-259
  method: GET
  url: https://chcp.instructure.com/api/v1/courses/89585/media_objects
  action: navigate (GET), report the body
STEP 9:
  op_id: g3-8
  catalog: C-193
  method: GET
  url: https://chcp.instructure.com/api/v1/courses/89585/folders/{F}
  action: navigate (GET), report the body
  only if: {F} captured; otherwise report "skipped" with the reason and continue
STEP 10:
  op_id: g3-9
  catalog: C-192
  method: GET
  url: https://chcp.instructure.com/api/v1/courses/89585/files/{FI}
  action: navigate (GET), report the body
  only if: {FI} captured; otherwise report "skipped" with the reason and continue
STEP 11:
  op_id: g3-10
  catalog: C-199
  method: GET
  url: https://chcp.instructure.com/api/v1/courses/89585/files/{FI}/text
  action: navigate (GET), report the body
  only if: {FI} captured; otherwise report "skipped" with the reason and continue
  PROBE: record the status and body honestly; a 4xx here is a valid result
STEP 12:
  op_id: g3-11
  catalog: C-201
  method: GET
  url: https://chcp.instructure.com/api/v1/courses/89585/folders/by_path?path=/
  action: navigate (GET), report the body
  PROBE: record the status and body honestly; a 4xx here is a valid result
STEP 13:
  op_id: g3-12
  catalog: C-202
  method: GET
  url: https://chcp.instructure.com/api/v1/courses/89585/folders/by_path/{FP}  -- build this URL as https://chcp.instructure.com/api/v1/courses/89585/folders/by_path/ followed by {FP} with spaces encoded as %20 (e.g. full_name "course files" becomes "course%20files")
  action: navigate (GET), report the body
  only if: {FP} captured; otherwise report "skipped" with the reason and continue
  PROBE: record the status and body honestly; a 4xx here is a valid result
REPORT FORMAT (follow exactly):
First, one line per op in order:
  op_id | http_status | first_500_chars_of_body
(For skipped conditional steps: op_id | skipped | reason.)
Then a final section starting with the literal line RESULTS_JSON
followed by a JSON array, one object per op, in order:
  [{"op_id": "...", "status": 200, "body": "<JSON-escaped, max 2000 chars>"}, ...]
If the session check failed, the whole report is the single line: session_dead
