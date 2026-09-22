# Onboarding and reauth for the v1 helper lane

V1 (2026-09-22). No cookie values, no credential material, no PAT
required. The educator's only job in both flows is signing into Canvas
on the login helper page, which they do with their own hands in the
helper's private browser on their Muse's own computer. The agent never
sees the password.

## Fresh-educator onboarding

1. The agent asks for the educator's Canvas school URL (only if it
   cannot determine it safely), records it in the helper env, and
   starts the login helper. The educator opens the helper page and
   signs in exactly as they normally would, including Duo or push MFA.
2. On sign-in, the agent runs the verification batch: GET
   /api/v1/users/self through the helper Chromium. A user-profile JSON
   (id, name) is the setup-complete gate; the principal id and name are
   pinned into the lane state (`~/.morrow/browser_lane.json`, mode
   0600, metadata only). A login page means the sign-in did not stick;
   the agent asks once more, then stops and reports exactly what it
   found.
3. The first educator request after setup is a harmless read (for
   example, the educator's own profile or course list), so the educator
   sees the connection working before trusting it with anything bigger.

## Session expiry

Detection signals (either one):
- A batch reports the session dead (users/self showed a login page).
- A batch op returns 401 with {"status":"unauthenticated"}.

On detection the agent:
1. Activates the write halt (the same `~/.morrow/write_halt` file the
   executor checks; `reauth/state_machine.py` owns the halt, quarantine,
   and notify mechanics).
2. Quarantines in-flight ops. Nothing retries against a dead session.
3. Tells the educator, plainly: "Your Canvas sign-in expired. Nothing
   was lost. Please sign in again on the login helper page."
4. Waits for the educator to re-sign in through the helper page.
5. Verification batch: GET /api/v1/users/self. The principal id MUST
   match the pinned id in lane state; on mismatch, the halt stays and
   the situation escalates (possible account change), never
   auto-resumes.
6. On match: mark verified, lift the halt. Quarantined ops resume only
   with the educator's fresh approval; nothing auto-retries.

## Keepalive

Canvas sessions expire on inactivity (institution-configured, commonly
30 minutes to 4 hours). The remember-me cookie from "stay signed in"
typically stretches this to weeks. The helper's cookie-expiry watch
(`helper/cookie_expiry_selftest.py` covers the mechanism) warns within
7 days so the educator can re-sign in before the session actually dies.
If a check shows a login page, the agent runs the reauth flow above
instead of the work batch.
