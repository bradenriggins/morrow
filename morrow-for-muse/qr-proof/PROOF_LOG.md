# QR proof test log

## Attempt 1: 2026-09-20 ~12:45-12:55 CDT: BLOCKED at mobile_verify

- Braden minted QR via takeover at chcp.instructure.com/profile/qr_mobile_login, sent screenshot.
- QR decoded (cv2, 2.2x upscale of tight crop): valid
  `https://sso.canvaslms.com/canvas/login?...&code=<one-time>&domain=chcp.instructure.com`
  (also contained per-app codes: code_android, code_ios_teacher, code_android_teacher,
  code_ios_parent, code_android_parent, code_ios_career).
- `GET https://sso.canvaslms.com/api/v1/mobile_verify.json?domain=chcp.instructure.com`
  -> `{"authorized": false, "result": 3}`.
- Same refusal for: canvas.instructure.com, cms.instructure.com, utah.instructure.com
  (proves it is not CHCP-specific), domain with https:// prefix, CanvasTeacher UA,
  GET with domain+code, POST (404, endpoint is GET-only), no-param request (500),
  and the institution-hosted copy at chcp.instructure.com/api/v1/mobile_verify.json
  (200, same refusal body).
- Exchange never ran: no client_id/client_secret, no tokens minted, nothing to revoke,
  zero Canvas state changed. The one-time code expired unused (~10 min window).
- Context: May 2026 ShinyHunters breach of Instructure; company hardened auth afterward
  (shut down Free-For-Teacher, etc.). Endpoint may now require app attestation or is
  otherwise restricted to genuine mobile clients. The public helper
  (chrischall/canvas-parent-mcp src/qr-login.ts) expects `authorized: true`, so it
  would hit the same wall today.
- Next tests: (1) find the exact APIVerifyClient request (params/headers) the real
  mobile app sends; (2) find the mobile client_id as a public constant in Instructure's
  open-source apps and try the token exchange directly, bypassing mobile_verify.
  No new QR needed until one of those pans out.

## Path 2 investigation result (2026-09-20 ~12:55 CDT): DEAD END BY DESIGN

No public Instructure mobile OAuth client_id exists in open source for any app
variant. Legacy flow fetched client_id/client_secret dynamically per domain from
mobile_verify.json (verified dead server-side 2026-09-20 for all domains tested).
Current flow (canvas-ios PR #3281, ~Mar 2025) is PKCE public clients: no secret,
app-specific IDs in Instructure's private secret repo, not shipped in public code.
Conclusion: there is no public constant to source and no direct exchange path that
bypasses mobile_verify. The captured QR code is unusable: broker credentials gone
and no PKCE code_verifier was ever held. Third-party QR helpers
(chrischall/canvas-parent-mcp) are documented as currently non-functional for the
same reason. No secrets encountered; no Canvas state touched.

## Path 1 investigation result (2026-09-20 ~12:57 CDT)

~43 public searches across instructure/canvas-ios, canvas-android, OpenAPI docs,
and independent reimplementations. Verified: GET
https://sso.canvaslms.com/api/v1/mobile_verify.json; QR URL the app parses is
https://sso.canvaslms.com/canvas/login?domain=...&code=...; endpoint migrated from
canvas.instructure.com to sso.canvaslms.com in canvas-ios PR #3923 (2026-03-05).
No public source shows the app sending anything beyond the `domain` query param:
the call is pre-authentication (no user token exists yet), Android deliberately
excluded mobile_verify calls from the auth interceptor (PR #285), and the OAuth
credentials are OUTPUTS of the call, not inputs. Conclusion: our 2026-09-20 test
requests were already app-equivalent, so `authorized:false, result:3` is a
server-side refusal, not a malformed request. The broker is retired or broken
post-migration/breach. Remaining thread: decode `result: 3` from the canvas-lms
controller source.

## FINAL VERDICT (2026-09-20 ~12:59 CDT): QR-bootstrap lane CLOSED

The canvas-lms controller source could not be retrieved from public indexes, but
the verdict no longer needs it. The decisive datum: Instructure's OWN flagship
domains (canvas.instructure.com, cms.instructure.com) return the identical
`{"authorized": false, "result": 3}` refusal as CHCP and Utah. That rules out a
per-domain gate (no mobile key enabled, etc.): the mobile_verify credential
broker is globally disabled or retired server-side, consistent with post-May-2026
breach auth hardening. Combined with path 1 (our requests were already
app-equivalent) and path 2 (no public client_id exists by design), the lane has
no remaining opening. The one decisive confirmation (proxy the genuine Canvas
app on a real device and observe its mobile_verify response) requires a device
Braden controls. No further QR attempts authorized; no new QR needed.
