# Production Moodle connection: first read layer

This checkpoint adds a separate, tenant-pinned Moodle browser profile on the
Muse VM. The educator signs in on the Moodle or school SSO page shown by the
local helper. The connector reads the signed-in Moodle course list in that
browser's page context. Cookies and sesskey stay in Chromium. The result sent
to Muse contains only course IDs and course names. Canvas keeps its own
profile, helper, and operation path.

The release is not ready to claim Moodle writes, learner analytics, or a
single sign-in shared by Canvas and Moodle. The Moodle `requests.Session`
module remains a sandbox and low-level lane. This layer does not copy a
browser session into it.

## Failure cases to establish before implementation

- A missing or non-HTTPS Moodle address, credentials in the URL, or a sibling
  host must be rejected before browser navigation or page fetch.
- A Moodle helper must never use the Canvas profile, helper token, or port.
- An HTTP response, an off-origin redirect, a login page, a missing or invalid
  sesskey, and a Moodle AJAX error must not be reported as a course list.
- The course-list function must return no cookies, sesskey, learner names,
  learner counts, raw provider body, or arbitrary page text to Muse.
- An unknown response shape or oversized response must fail closed.
- A helper that merely displays a Moodle page must not report authenticated
  until a signed-in page and the course-list read both succeed.
- No Moodle write can pass through this layer, even with a manually supplied
  method or endpoint.
- A failed read must not change or restart the existing Canvas helper.

## Completion evidence

Run a browser-level fixture with a fresh scratch profile and a fake Moodle
origin. Prove sign-in, the permitted course read, and the failure cases above.
Exercise the helper HTTP routes separately. Inspect the signed-in fixture page
and resulting course-list output. Full helper startup, Muse VM access, and a
real school Moodle connection remain separate proof requirements. A real
connection needs educator sign-in, read-only principal/course readback, and a
site capability check before it can be called production-connected. Do not
test against a live LMS without that authorization.
