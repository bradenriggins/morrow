# Disconnecting Morrow: revocation in one minute

*Plain language, one page.*

Morrow has no API token and no stored password to delete. Your
connection to Canvas is the session cookie inside the helper Chromium
profile on your Muse's own computer. Revoking means ending that
session and, optionally, removing the helper's data entirely.

## Sign out inside the helper (ends this session)

Ask Muse to sign you out of Canvas on the helper page. That ends the
session Morrow uses right away. The helper keeps running, so you can
sign in again later without reinstalling.

What does NOT work: logging out of Canvas on your laptop or phone
does not reliably end the helper's own session, because Canvas
sessions are per-device. The helper has its own session cookie, and
your laptop's logout does not touch it.

## Full disconnect (Morrow can no longer reach Canvas)

Say "disconnect Morrow from Canvas". Muse runs `bin/morrow disconnect`
and tells you the result. It:

1. stops the helper and its browser,
2. removes the helper's restart schedule (otherwise it would start the
   signed-in helper again within five minutes),
3. deletes the helper's browser profile (`<tree>/helper/profile/`,
   where your Canvas sign-in lives), the record of which Canvas
   account is yours, and the temporary browser files,
4. checks that each of those is really gone before it says "done".

Your settings, the record of past actions, and the student-label key
stay, so reconnecting later picks up where you left off. To remove
everything, including those, ask for a full uninstall instead
(`scripts/uninstall.sh`, see INSTALL.md).

## What happens next

If you ask Morrow to do something in Canvas after revoking, it will
not be able to connect. You will see the plain-language "your
sign-in expired" notice and a guided path to reconnect. Reconnecting
means rerunning the installer (`bash install.sh`) and signing in again
on the helper page, and you can pick up where you left off.
