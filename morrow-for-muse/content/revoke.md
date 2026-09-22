# Disconnecting Morrow: revocation in one minute

*Plain language, one page.*

Morrow has no API token and no stored password to delete. Your
connection to Canvas is the session cookie inside the helper Chromium
profile on your Muse's own computer. Revoking means ending that
session and, optionally, removing the helper's data entirely.

## Sign out inside the helper (ends the session)

Ask Muse to sign you out of Canvas inside the helper Chromium, or to
delete the helper profile's cookies (`<tree>/helper/profile/`).
Either ends the session Morrow uses, immediately.

What does NOT work: logging out of Canvas on your laptop or phone
does not reliably end the helper's own session, because Canvas
sessions are per-device. The helper has its own session cookie, and
your laptop's logout does not touch it.

## Full disconnect (clears the helper's data)

Ask Muse to remove the tree state directory
(`~/.morrow/trees/<this-tree>`). That also clears the helper profile
and the per-tree journal. Reconnecting means going through the short
setup again.

## What happens next

If you ask Morrow to do something in Canvas after revoking, it will
not be able to connect. You will see the plain-language "your
sign-in expired" notice and a guided path to reconnect. Reconnecting
means going through the short setup again, and you can pick up where
you left off.
