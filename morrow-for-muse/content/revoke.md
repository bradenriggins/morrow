# Disconnecting Morrow: revocation in one minute

*Plain language, one page.*

Morrow has no access token and no stored password to delete. Your
connection to Canvas is the sign-in kept by the helper's private
browser on your Muse computer. Revoking means ending that sign-in and,
if you want, removing the helper's data entirely.

## Sign out on the helper page (ends this sign-in)

Ask Muse to show you the helper page. On that page, use Canvas's own
menu: Account, then Logout. That ends the sign-in Morrow uses right
away. The helper keeps running, so you can sign in again later on the
same page without setting anything up again.

What does NOT work: signing out of Canvas on your laptop or phone does
not end the helper's own sign-in, because each device has its own
Canvas sign-in. Your laptop's logout does not touch the helper's.

## Full disconnect (Morrow can no longer reach Canvas)

Say "disconnect Morrow from Canvas". Muse tells you what will be
removed and asks you to confirm. After you say yes, Muse runs
`bin/morrow disconnect --yes` and tells you the result. It:

1. stops the helper and its browser,
2. removes the helper's restart schedule (otherwise it would start the
   signed-in helper again within five minutes),
3. deletes the helper's private browser (where your Canvas sign-in
   lives), the record of which Canvas account is yours, and the
   browser's temporary files,
4. checks that each of those is really gone before it says "done".

Your settings, the record of past actions, and the key that keeps
student labels the same stay, so reconnecting later picks up where you
left off. To remove everything, including those, ask Muse for a full
uninstall instead.

## What happens next

If you ask Morrow to do something in Canvas after revoking, it will
not be able to connect. You will see the plain-language "your sign-in
expired" notice and a guided path to reconnect. To reconnect, say
"Connect my Canvas account" and sign in again on the helper page; you
can pick up where you left off.

## Getting help

If a disconnect or uninstall does not finish, email
hello@meetmorrow.app or see meetmorrow.app/support, and include the
step where Muse stopped. Do not send student information: no student
names, records, or screenshots that show students, and no passwords.
